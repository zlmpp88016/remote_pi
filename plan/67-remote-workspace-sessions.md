# Plano 67 — Remote workspace + session control

**Status: EM EXECUÇÃO** (aberto 2026-09-28).

Objetivo: o app deixa de ser “1 pairing = 1 Pi session” e passa a **controlar o Pi na máquina alvo**: conectar (QR / relay) escolhe a **máquina**, depois o **workspace** (cwd), depois uma **sessão histórica** daquele cwd.

Análise precedente: Session `20260928-analyze-app-session-history` (`ART-d15426153e51477ef5ac`). Viewing do transcript atual já existe; **seleção de AgentSession** exige reabrir `plan/00-decisions.md` (feito neste plano) + protocolo + pi-extension.

## Contexto

Hoje:

- QR / `pair_ok` amarram o app ao **room** do processo Pi que gerou o QR (`roomId = f(cwd, name)`).
- Home lista tiles `(peer, room)` live/cached — **não** lista AgentSessions do Pi.
- Protocolo App→Pi: `session_sync` / `session_new` / `session_compact`. Sem list/switch.
- Daemon (`plan/26`) já registra cwd em `~/.pi/remote/daemons.json` e spawna `pi --mode rpc --continue` (sempre a sessão **mais recente** daquele cwd).
- Sem um processo no relay, o app não fala com a máquina. “Remote control” exige um **host sempre ligado** (supervisor) ou um Pi aberto naquele cwd.

## Modelo (fechado 2026-09-28, conversa explícita)

```
Máquina (Pi-key / pairing persistente)
  └── Workspace (cwd → room)
        └── AgentSession (id do SessionManager do Pi)
              └── Chat (session_sync / mirror já existentes)
```

| # | Decisão | Valor |
|---|---|---|
| D-nav | Hierarquia | Máquina → workspace → sessão → chat |
| D-pair | QR / reconnect | Pairing é **máquina**. `rm` no QR é **workspace default**, não identidade do peer |
| D-catalog | Lista de workspaces | **Só** daemons registrados ∪ rooms live. Sem scan de disco / git-root |
| D-lock | Sessão ocupada no TUI | **locked** — app **não** rouba. Erro tipado; opção só-leitura fica fora deste plano |
| D-switch | Troca de sessão | Reseta o mirror como `session_new` (`session_started_at` novo + `session_sync`) |
| D-host | Controle da máquina | Supervisor anuncia room reservado **`host`** no mesmo Pi-key |
| D-offline | Workspace sem processo | Só dá start se estiver em `daemons.json`. Cache Hive **não** é catálogo |

Defaults acima fecham as duas perguntas em aberto da análise (catálogo offline + ocupação). Reabrir exige evidência, não silêncio.

## Não-objetivos

- Reescrever o data layer Flutter (`plan/31` SSOT fica).
- Usar Hive / tiles offline como lista de sessões do Pi.
- Tratar `roomId` como id de AgentSession.
- Scan de projetos na máquina.
- Steal de sessão do TUI desktop.
- E2E / contas / mudança no relay além de um room_id opaco extra (`host`).
- Agrupar tiles por cwd no sentido do plano 41 (já é 1 tile por agente).

## Fases

### D0 — Probe do SDK + decisões de API

**Onde:** `pi-extension/` (devDependency já pinada `@earendil-works/pi-coding-agent ^0.79.10`).

**Passos:**

1. `pnpm install` em `pi-extension/` se `node_modules` estiver ausente.
2. Inspecionar tipos públicos: `ExtensionCommandContextActions.switchSession`, listagem de sessões por cwd, erros de lock (`SessionLockedError` ou equivalente).
3. Registrar em “Resultados D0” neste arquivo: API existe? assinatura? fallback `--resume <id>` no spawn do daemon?

**Aceite:** tabela D0 preenchida com file:line do pacote instalado (não achismo). Escolha explícita: in-process `switchSession` **ou** restart `--resume`.

### D1 — Host control plane (`room=host`)

**Onde:** `pi-extension/src/daemon/` + ligação ao relay já usada pelo mesh_node.

**Comportamento:**

- `pi-supervisord` (já spawna daemons) também abre **uma** conexão WS no Pi-key da máquina com `room_id = "host"` (string reservada; relay já trata room como opaco).
- Mensagens App→host (ct JSON, mesmo envelope):

```jsonc
{ "type": "workspace_list", "id": "<uuid>" }
{ "type": "workspace_start", "id": "<uuid>", "cwd": "<realpath>" }  // ou "daemon_id"
{ "type": "workspace_stop",  "id": "<uuid>", "cwd": "<realpath>" }
```

- Resposta:

```jsonc
{ "type": "workspace_list_ok", "in_reply_to": "...", "workspaces": [
  { "cwd": "...", "daemon_id": "a1b2c3d4", "room_id": "...", "name": "...", "live": true, "daemon": true }
]}
{ "type": "workspace_start_ok", "in_reply_to": "...", "cwd": "...", "room_id": "...", "daemon_id": "..." }
{ "type": "action_error", "in_reply_to": "...", "action": "workspace_start", "error": "not_registered" | "..." }
```

`workspace_list` = união `listDaemons()` ∪ rooms live conhecidas pelo supervisor (filhos rpc). `workspace_start` de cwd **não** registrado → `not_registered` (não cria daemon implícito neste plano; operador usa `remote-pi create` como hoje).

**Aceite:** com supervisor up e zero TUI, o app (ou um cliente de teste) recebe `workspace_list_ok` e `workspace_start` faz o child aparecer como `room_announced` no room derivado.

### D2 — `session_list` / `session_switch` no workspace Pi

**Onde:** `pi-extension/src/protocol/types.ts`, handlers, `PROTOCOL.md`; eco no `app/lib/protocol/protocol.dart`.

App→Pi (room do workspace, **não** host):

```jsonc
{ "type": "session_list", "id": "<uuid>" }
{ "type": "session_switch", "id": "<uuid>", "session_id": "<pi-session-id>" }
```

Pi→App:

```jsonc
{ "type": "session_list_ok", "in_reply_to": "...", "current_id": "...", "sessions": [
  { "id": "...", "name": "...", "mtime": 0, "live": true }
]}
{ "type": "session_switch_ok", "in_reply_to": "...", "session_id": "...", "session_started_at": 0 }
{ "type": "session_switch_error", "in_reply_to": "...", "code": "locked" | "unknown" | "no_sdk", "message": "..." }
```

`session_switch_ok` **obrigatório** disparar o mesmo reset de `session_new`: limpar `_messageBuffer`, novo `_sessionStartedAt`, fan-out `session_history` vazio / mirror. App não pode misturar Hive da sessão anterior.

Implementação (escolhida no D0):

- Preferência: `ctx.switchSession(id)` in-process.
- Fallback: daemon `exit` + supervisor respawn `pi --mode rpc --resume <id>` (estender `rpcSpawnArgs`; hoje só `--continue`).

**Aceite:** vitest cobre parse + handler happy path + `locked` + reset do buffer. Dois session_id do mesmo cwd não vazam eventos no buffer.

### D3 — App: máquina → workspace → sessão

**Onde:** `app/` apenas. Data layer SSOT permanece; muda navegação e o que `activate()` recebe.

1. Home = lista de **máquinas** (peers), não um tile por room como destino final do chat.
2. Drill-in: workspaces (`workspace_list` se host live; senão rooms já anunciadas).
3. Drill-in: `session_list` → tap `session_switch` → só então `/chat`.
4. `Preferences.selectedRoom` vira `(epk, roomId, sessionId)`.
5. QR `rm` pré-seleciona workspace; pairing continua 1 entry por máquina.
6. Viewer read-only de cache **não** chama `SyncService.activate` / `requestSync` (constraint da análise).

**Aceite:** `flutter test` nos viewmodels/routing novos; regressão Home/chat existentes verde no pacote tocado. Sem `session_sync` ao abrir um histórico só-leitura.

### D4 — UX `locked` + verificação

- `session_switch_error.code == locked`: snackbar / dialog, **não** tenta steal, **não** mata o TUI.
- Host down: máquina online só se algum room (incl. `host`) estiver announced; workspace start indisponível sem host.
- DoD abaixo.

## Estrutura esperada (arquivos)

| Área | Arquivos |
|---|---|
| Decisão | `plan/00-decisions.md` (riscar MVP 1:1; nova hierarquia) |
| Protocolo | `pi-extension/src/protocol/types.ts`, `app/lib/protocol/protocol.dart`, `PROTOCOL.md` |
| Host | `pi-extension/src/daemon/supervisor.ts`, novo módulo host-room / control messages |
| Sessão | `pi-extension/src/index.ts` dispatch, `src/actions/handlers.ts`, testes `*.test.ts` |
| Spawn | `pi-extension/src/daemon/rpc_child.ts` (`--resume`) |
| App UI | `app/lib/ui/home/*`, novo workspace/session list, routing, preferences |
| Chat | só o bind `(epk, roomId, sessionId)` + reset no `session_switch_ok` |

## Resultados D0

*(preencher na execução)*

| Pergunta | Resultado | Evidência |
|---|---|---|
| `switchSession` público no 0.79.10? | **Sim.** `ExtensionCommandContext.switchSession(sessionPath, { withSession? }) => Promise<{cancelled}>`. Também no RPC: `RpcCommand.type: "switch_session"` + `sessionPath`. | tarball `@earendil-works/pi-coding-agent@0.79.10` `dist/core/extensions/types.d.ts:275-280`, `dist/modes/rpc/rpc-types.d.ts:97-98` |
| Listar sessões do cwd? | **Sim.** `SessionManager.list(cwd) => Promise<SessionInfo[]>` com `{path, id, cwd, name?, modified, firstMessage}`. Default dir `~/.pi/agent/sessions/<encoded-cwd>/`. | `dist/core/session-manager.d.ts:121-134`, `:318-324` |
| Erro quando TUI segura a sessão? | **Não há `SessionLockedError` neste SDK.** Cancelamento é o hook `session_before_switch` (`reason: "new" \| "resume"`) → `switchSession` resolve `{cancelled: true}`. Mapeamos `cancelled` → wire `locked`. Dois processos no mesmo cwd já são barrados pelo cwd-lock do remote-pi, não pelo SDK. | `types.d.ts:412-416`; `pi-extension/src/session/cwd_lock.ts` |
| Caminho escolhido | **Híbrido.** TUI / ctx de comando: `ctx.switchSession(path)` in-process (id do `session_list` resolve via `SessionManager.list`). Daemon sem command ctx: `session_switch_error.code=no_sdk` até D1 estender `rpcSpawnArgs` com `--resume <id>`. | D2 handlers; D1 spawn |

## Definition of Done

- [x] `plan/00-decisions.md` risca pairing=1 sessão e hierarquia plana; registra máquina→workspace→sessão (2026-09-28)
- [x] D0 tabela preenchida com SDK instalado (tarball 0.79.10)
- [x] `workspace_list` / `workspace_start` no room `host` (supervisor HostBridge; tests use `skipHost`)
- [x] `session_list` / `session_switch` no Pi do workspace; mirror reset no switch
- [x] App: Home tile → `/sessions` picker → `/chat` (session_switch first)
- [x] `locked` não rouba TUI (`session_before_switch` cancelled → wire locked)
- [x] Testes focados: `pi-extension` vitest 806 passed / 3 skipped + `tsc --noEmit`; `app` `flutter test test/protocol/actions_protocol_test.dart` 19 passed (session_list / session_switch / locked)
- [x] `PROTOCOL.md` documenta as mensagens novas
- [x] Catálogo de workspace = daemons registrados (sem scan); live rooms still come from existing `room_announced`

## Próximos planos

- Steal / take-over de sessão (só se o SDK expuser e o usuário pedir).
- Workspace não registrado (criar daemon pelo app) — deliberadamente fora.
- Indicador de truncamento do mirror (`plan/16` D1) — independente.
