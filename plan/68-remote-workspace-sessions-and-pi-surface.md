# Plano 68 — 主机 → 工作空间 → Pi 运行面 → 会话（配对改粘贴、去扫码）

**Status: APROVADO pelo usuário (2026-10-08)** — executar sem nova consulta.

> **Reaberto 2026-10-08 (plano 69)**: os "Próximos planos" (Windows e Web) **entram no escopo agora**. O pareamento por colagem permanece (payload congelado), mas o emissor pode ser o daemon (`remote-pi pair` sem Pi, `rm=host`) e o cliente web/pc passa a ser cidadão de primeira classe. Ver plano 69.

## Instruções do usuário (fechadas nesta conversa)

| # | Instrução |
|---|---|
| U1 | Windows e Web **não** entram agora (registrados em "Próximos planos", não perdidos) |
| U2 | Remover o scan de QR; **somente colar o endereço de pareamento** |
| U3 | Plugins (Pi package) e o app cliente **ficam** — só o scan sai |
| U4 | Todo o resto começa já |
| U5 | **Aceite = cadeia completa passando**, sem perguntar de novo |

## Já existe (não refazer)

`plan/67` entregou: hierarquia máquina→workspace→AgentSession→chat; `room=host`
(`workspace_list`/`workspace_start`); `session_list`/`session_switch` com `locked`;
UI `app/lib/ui/workspaces/` e `app/lib/ui/sessions/`; chat completo (stream, fila,
steer, cancel, imagem, voz, `ask_user`); mirror cache + `session_sync`.

Evidência: `pi-extension/src/protocol/types.ts:205-239`,
`app/lib/protocol/protocol.dart:902-905,1262-1266`, `app/test/ui/workspaces/`.

## Lacunas reais

1. Escolher **qualquer** cwd — hoje só cwd presente em `daemons.json`; `plan/67` lista
   "workspace não registrado" como não-objetivo explícito → **reabertura registrada em W0**.
2. **Superfície Pi (skill/package)** — zero mensagens no protocolo
   (`grep -i skill pi-extension/src/protocol/types.ts` → vazio).
3. **Scan de QR** — `pi-extension/src/pairing/qr.ts` (`qrcode-terminal`),
   `app/lib/ui/pairing/pairing_page.dart` e
   `app/lib/ui/onboarding/widgets/pair_step.dart` (`mobile_scanner`).
   *(Resolvido em W1: dependências removidas, pareamento só por colagem.)*

## Contratos

### Envelope e payload (inalterado)

`remotepi://pair?t=…&epk=…&n=…[&rm=…][&r=…]` — **byte a byte igual**. Remover o
scan muda apenas como o usuário obtém a string, nunca o formato. Comparação de
relay permanece normalizada (`relayUrlsMatch`, `relay_config.dart:135`).

### Mensagens novas (W2)

```jsonc
{ "type": "fs_list", "id": "…", "path": "…", "show_hidden": false }
{ "type": "fs_list_ok", "in_reply_to": "…", "path": "…", "parent": "…|null",
  "entries": [ { "name": "…", "kind": "dir|file", "is_repo": true } ] }
{ "type": "workspace_add", "id": "…", "path": "…" }
{ "type": "workspace_remove", "id": "…", "path": "…" }
```

`workspace_start` passa a aceitar `path` fora de `daemons.json` → persiste em
`~/.pi/remote/workspaces.json` e sobe o daemon. Erros tipados:
`not_a_directory` / `permission_denied` / `not_found` / `spawn_failed`.

### Mensagens novas (W3)

```jsonc
{ "type": "pi_surface", "id": "…" }
{ "type": "pi_surface_ok", "in_reply_to": "…",
  "runtime": { "running": true, "model": "…", "thinking": "…" },
  "skills":   [ { "name": "…", "description": "…", "source": "user|project|package",
                  "path": "…", "enabled": true, "disable_model_invocation": false } ],
  "packages": [ { "source": "npm:@x/y@1", "scope": "user|project",
                  "resources": ["extensions","skills","prompts","themes"] } ] }
{ "type": "skill_invoke", "id": "…", "name": "…", "args": "…" }
{ "type": "skill_set_enabled", "id": "…", "name": "…", "enabled": false }
{ "type": "package_install", "id": "…", "source": "npm:@x/y@1", "scope": "user|project",
  "confirm_third_party": true }
{ "type": "package_remove", "id": "…", "source": "…" }
{ "type": "package_update", "id": "…" }
```

Regras: `skill_invoke` repassa args como user request (`/skill:<nome> <args>`);
`package_install` sem `confirm_third_party: true` → `action_error`; `pi_surface_ok`
nunca fabrica valor — campo indisponível vem `null` com motivo; sem shell livre
(vocabulário fechado, mesmo racional de `plan/28`).

## Estado do ambiente (verificado)

| Item | Estado |
|---|---|
| Flutter / Dart | ✅ `D:/flutter` — Flutter 3.44.4, Dart 3.12.2 (`scripts/screenshots.sh:43` já procura lá) |
| Node | ✅ v22.19.0 |
| pnpm | ⚠️ global quebrado → usar `npx -y pnpm@10` |
| cargo / docker | ❌ ausentes → relay fica fora (não é escopo) |
| `flutter pub get` em `app/` | ✅ feito |
| Baseline `flutter test` | ⚠️ **616 pass / 3 fail** (não é verde) |
| Working tree | ⚠️ sujo com WIP de terceiros sobre `qr.ts`/`index.ts`/`pairing_viewmodel.dart` (fix do relay self-hosted `r=`) — **preservar** |

### Baseline vermelho — diagnóstico já feito

| Teste | Causa | Ação |
|---|---|---|
| `connection_manager_test.dart` "RoomAnnounced…" | `roomsStream` é broadcast **sem replay**: o listener assina depois do 1º emit e só o último snapshot chega → `Expected: non-empty, Actual: []`. Determinístico; não está em arquivo modificado | Corrigir no harness: drenar o emit (debounce) em vez de assumir replay. Se a investigação mostrar que é bug de produto, corrigir o produto — não o teste |
| `speech_service_test.dart` "darwin scale on macOS test host" | Asserção assume host macOS; estamos no Windows | Tornar condicional à plataforma do host |
| `sync_service_test.dart` "relay working=false…" | Passa isolado → concorrência entre arquivos de teste | Estabilizar; nunca aceitar como "flaky conhecido" |

## Fases

### W0 — Reconciliação + contrato
`plan/00-decisions.md` (riscar "catálogo = só daemons registrados", registrar a nova
regra com data e marcação explícita de reabertura), `plan/67` (nota de reabertura),
`PROTOCOL.md` (todas as mensagens acima com request/response/erro).
**Aceite:** documentos coerentes; zero código de feature.

### W1 — Pareamento por colagem (remoção do scan)
- Extensão: fora `qrcode-terminal`, `renderQRAscii`, `displayQR`, rotação de QR e o
  ramo ASCII de `/remote-pi pair`; fica a URI copiável.
- App: fora `mobile_scanner` e a UI de câmera em `pairing_page.dart` e
  `onboarding/widgets/pair_step.dart`; a colagem vira o caminho único.
- Renomear `QR*` → `Pairing*` onde fizer sentido, **sem tocar no payload**.
- Permissão de câmera **permanece** (`image_picker` usa para anexo) — comentar o porquê.

**Aceite:** nenhuma referência a `mobile_scanner`/`qrcode-terminal` no repo;
teste de regressão prova que o parser aceita o payload de sempre; testes existentes verdes.

### W2 — Plano de controle v2: filesystem + workspace arbitrário
Extensão (`fs_list`, `workspace_add/remove`, `workspace_start` em cwd novo,
`workspaces.json`) + App (navegar diretórios do host, entrada manual de caminho,
lista de workspaces com os adicionados).
**Aceite:** vitest cobre parse + happy path + erro tipado de cada mensagem; um cwd
fora de `daemons.json` sobe Pi e reaparece na lista após reconexão; o cliente nunca
lê caminho local.

### W3 — Superfície Pi: skill + plugin
`pi_surface`, `skill_invoke`, `skill_set_enabled`, `package_install/remove/update`
e a UI correspondente.
**Aceite:** `pi_surface_ok` bate com `pi list`; `skill_invoke` aparece no fluxo de
chat; instalação sem confirmação é recusada; instalar/remover reflete em `pi list`.

### W4 — Harness de verificação (comandos de aceite)
Novo `scripts/verify-p68.mjs` (um runner só, cross-platform, spawna flutter/pnpm com
o cwd certo; descobre `D:/flutter` como `screenshots.sh` já faz) + reforço do E2E de
cadeia completa (relay stub local em Node com o contrato `{peer, ct}` para rodar sem
cargo/rede; variante contra relay real quando alcançável) + extensão do harness de
screenshots às telas novas.
**Aceite:** os três comandos abaixo rodam verdes do zero.

### W5 — Cadeia completa verde (gate do Goal)
Colar pareamento → escolher workspace navegando → subir Pi → ver skills/plugins →
conversar → trocar session histórica → reconciliar. Mais a correção do baseline
vermelho. Loop de correção até verde.
**Aceite:** os três comandos de aceite verdes, com a causa raiz de cada falha
corrigida (nunca suprimida por skip/timeout).

## Comandos de aceite (declarados no Goal)

1. `node scripts/verify-p68.mjs unit`
2. `node scripts/verify-p68.mjs e2e`
3. `node scripts/verify-p68.mjs visual`

Cobrem: `pi-extension` vitest + `tsc --noEmit`; `app` `flutter test` + `flutter analyze`
(zero issues, baseline vermelho corrigido); cadeia host↔cliente ponta a ponta; render
visual das telas novas em PNG.

## Definition of Done

- [x] `00-decisions.md` registra a reabertura do non-goal de workspace
- [x] `PROTOCOL.md` documenta `fs_list`, `workspace_add/remove`, `pi_surface`, `skill_invoke`, `skill_set_enabled`, `package_*`
- [x] Repo sem `mobile_scanner` / `qrcode-terminal`; payload `remotepi://pair?…` inalterado (teste de regressão)
- [x] `workspace_start` sobe Pi em cwd fora de `daemons.json`; `workspaces.json` persiste e sobrevive à reconexão
- [x] `fs_list` lista diretórios do host com erros tipados; cliente nunca acessa caminho local
- [x] `pi_surface` lista skills (user/project/package) e packages com escopo; `skill_invoke` força o skill com args
- [x] `package_install` exige `confirm_third_party`; scope user/project correto
- [x] `app` `flutter analyze` zero issues; `flutter test` verde (baseline vermelho corrigido, não mascarado)
- [x] 3 comandos de aceite verdes; E2E de cadeia completa registra comando e resultado
- [x] Screenshots das telas novas gerados como evidência

## Riscos

| Risco | Mitigação |
|---|---|
| cwd arbitrário = execução de código em qualquer pasta da máquina | `plan/58` J já assume full-trust pós-pareamento; manter revogação visível e confirmação no 1º start de cada diretório |
| `package_install` executa código de terceiros | `confirm_third_party` obrigatório + UI mostrando a origem |
| WIP de terceiros no working tree sobrepõe `qr.ts`/`index.ts`/`pairing_viewmodel.dart` | preservar e integrar, nunca reverter |
| Baseline vermelho mascarar regressão nova | W5 corrige o baseline **antes** do gate final |
| E2E depender de rede/cargo | relay stub local em Node como caminho primário; relay real como variante |

## Próximos planos (não perdidos)

- **Windows**: `app/` ganha target `windows` + camada de capacidades (sem câmera →
  colagem; STT opcional). Reusa W1–W3 sem retrabalho.
- **Web**: pré-requisito é relay com `wss://` + allowlist de `Origin` + eco do
  subprotocolo WS; Ed25519 no browser com detecção de capacidade + fallback wasm.
- Steal/take-over de sessão do TUI e retorno do E2E (Noise) — seguem fora, independentes.

## Resultado de conhecimento (pós-execução)

Ao final, avaliar staging de candidato só se houver lição reusável: provável
**pitfall** (broadcast `Stream` sem replay engana o teste de rooms) e/ou
**restrição prescritiva** (pareamento só por colagem ⇒ o URI é o único vetor, então
o formato do payload é contrato público congelado). Se nada atingir a barra,
registrar explicitamente zero candidatos.
