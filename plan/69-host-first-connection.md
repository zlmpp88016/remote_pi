# Plano 69 — Conexão host-first (modelo SSH): daemon residente é a porta da frente

Status: APROVADO pelo usuário (2026-10-08) — executar sem nova consulta.

## Instruções do usuário (fechadas nesta conversa)

| # | Instrução |
|---|---|
| U1 | Conexão canônica é o **host** (daemon residente). app, web e pc conectam no **host**, nunca num processo Pi |
| U2 | Pareamento **sem Pi rodando**: app informa **endereço + código de pareamento** e conecta. O código é **predefinido no host** |
| U3 | O daemon de validação é **residente** (tipo sshd) — instalado como serviço do SO, sobrevive a Pi morrer |
| U4 | Pi morto/crashado **não pode** derrubar a conexão: host segue online, workspace mostra estado, restart pelo app |
| U5 | Capacidades do host: navegar filesystem, iniciar Pi em path arbitrário, operar Pi (chat/sessões) |
| U6 | Web e pc entram no escopo **agora** (eram "próximos planos" do plano 68) |
| U7 | Aceite = cadeia completa **sem Pi pré-existente**; não perguntar de novo |

## Contexto

O usuário rejeitou o modelo atual: parear exige um Pi rodando (`/remote-pi pair`),
e o chat do app vive no room do processo Pi — quando o Pi cai, a experiência
acaba. A exigência é o modelo SSH: um daemon **sempre ligado** na máquina alvo
valida pareamento e serve **browse de filesystem + start de Pi em qualquer
diretório + operação do Pi**.

Boa notícia: o esqueleto já existe no código. Este plano **não reescreve** —
ele reposiciona o que existe (supervisor + HostBridge passam a ser a porta da
frente) e fecha as 4 lacunas reais.

## Já existe no código (não refazer)

| Peça | Evidência |
|---|---|
| Supervisor residente, spawna `pi --mode rpc`, auto-restart com backoff, install como serviço (systemd/launchd/Task Scheduler + VBS launcher) | `pi-extension/src/daemon/supervisor.ts`, `src/daemon/install.ts` (planos 26/40) |
| HostBridge: conexão relay always-on no room `host`, com a Pi-key da máquina | `pi-extension/src/daemon/host_bridge.ts:1-8` (plano 67 D1) |
| Control plane do host: `workspace_list/start/stop`, `fs_list`, `workspace_add/remove`, `ping` | `src/daemon/host_control.ts`, `src/daemon/fs_nav.ts` (planos 67/68) |
| App: hierarquia máquina→workspace→sessão→chat, mirror cache, `session_list/switch` com `locked` | plano 67 D2/D3, plano 68 |
| Pareamento por colagem — a URI `remotepi://pair?…` **é** o código (payload congelado) | plano 68 W1, `src/pairing/qr.ts:88-104` |
| CLI `remote-pi` + client do UDS de controle (`~/.pi/remote/supervisor.sock`) | `package.json:8-11`, `src/daemon/client.ts` (plano 26) |

## Lacunas reais (evidência)

1. **Pareamento exige Pi.** `QRSession` é "one instance per Pi process"
   (`src/pairing/qr.ts:20-22`); `pair_request` é validado dentro do processo Pi
   (`src/index.ts:1965`). O `HostBridge` **não trata `pair_request`** e ainda
   descarta peer desconhecido na allow-list (`src/daemon/host_bridge.ts:103`) —
   um dispositivo novo nunca conseguiria parear pelo room `host` hoje.
2. **Chat ligado ao room do Pi.** App troca de room com `switchRoom(roomId)`
   (`app/lib/data/transport/connection_manager.dart:238`); o Pi morre → o room
   morre → sem push de estado, sem restart, conexão da máquina sem dono.
3. **Pc sem cliente pelo protocolo do host.** Cockpit conecta por SSH/caminho
   próprio (plano 58); não existe modo "host Remote Pi" reaproveitando
   `room=host`. App sem target windows (adiado no plano 68).
4. **Web inviável hoje.** Relay Rust sem allowlist de `Origin`
   (`relay/src/` não trata Origin), sem Ed25519 em browser, sem cliente web.

## Contratos

### Pareamento (payload congelado — regra do plano 68)

`remotepi://pair?t=…&epk=…&n=…[&rm=…][&r=…]` continua **byte a byte igual**.
O que muda: **quem emite e quem consome**.

- Emissor passa a ser o **daemon** (`remote-pi pair` sem Pi nenhum): `rm=host`,
  `r=` relay resolvido do host. Token **persistente** (código predefinido, U2),
  rotacionável por `remote-pi pair --rotate`; modo efêmero de 60s continua
  disponível via `--ephemeral` para quem quer (decisão antiga preservada como
  opção, não como padrão).
- Consumidor: `HostBridge` trata `pair_request` no room `host` — com **carve-out
  na allow-list** para peer desconhecido só quando `inner.type == "pair_request"`
  (mesma semântica que `src/index.ts:1985-1986` já tem no Pi). `addPeer` →
  `pair_ok`/`pair_error` pelo mesmo sender.
- App: tela de pareamento = **campo endereço** (relay; auto-preenche de `r`)
  + **campo código** (cola da URI). Sem câmera, sem scan (68 W1 mantido).

### Mensagens novas (W1–W2)

```jsonc
{ "type": "host_hello", "id": "…" }
{ "type": "host_hello_ok", "in_reply_to": "…",
  "daemon": { "version": "…", "hostname": "…", "platform": "…" },
  "capabilities": ["host_pairing", "workspace_state", "fs_nav"] }
{ "type": "workspace_restart", "id": "…", "cwd": "…" }
{ "type": "workspace_state", "cwd": "…", "state": "running|starting|crashed|stopped",
  "last_error": "…|null", "restarts": 0 }
```

`workspace_state` é **push** do host (não request/response): emitido quando o
supervisor detecta exit de child, restart, start ou stop. Regra: o host
nunca fabrica estado — espelha `ChildSlot`.

### O que NÃO muda

- Envelope do relay `{peer, room, ct}`; `ct` = base64 do JSON (plano 03/06).
- Room por workspace continua existindo (relay já multiplica rooms por
  conexão); o app continua podendo falar no room do workspace. O que muda é o
  **dono da conexão da máquina**: presença/live da máquina = room `host`; Pi
  morto não remove o host.
- `peers.json`, revoke por dispositivo, safety number, pareamento persistente
  (pair-once, reconnect-forever) — intocados.

## Waves

### W0 — Reconciliação + contrato (zero código de feature)

- `plan/00-decisions.md`: **riscar "Sem daemon no MVP"** com data + razão
  (exigência do usuário, evidência: dor real de uso) e registrar: conexão
  host-first; pareamento daemon-side; código persistente padrão; web+pc no
  escopo. Notas de reabertura em `plan/26`, `plan/67`, `plan/68`.
- `PROTOCOL.md`: `host_hello`, `workspace_state`, `workspace_restart`,
  `pair_request` no room `host` (request/response/erro).
- **Aceite:** documentos coerentes; zero diff de feature.

### W1 — Pareamento sem Pi (daemon-side)

**Onde:** `pi-extension/src/daemon/host_bridge.ts`, `src/daemon/host_control.ts`
(novo `pairing.ts`), `src/daemon/supervisor.ts` (liga pairing ao HostBridge),
`src/daemon/control_protocol.ts` (ops `pair_show`/`pair_rotate`), CLI em
`src/index.ts` (modo sem Pi: fala com o supervisor pelo UDS), app
(`lib/pairing/`, `lib/ui/pairing/`).

- `QRSession` do host: token persistente emitido pelo supervisor; `--rotate`
  invalida; `--ephemeral` mantém TTL curto. Persistido em
  `~/.pi/remote/pairing.json` (sobrevive a reboot do daemon).
- `HostBridge`: handler `pair_request` (valida token, `addPeer`, `pair_ok`/
  `pair_error` tipado) + carve-out de allow-list só para `pair_request`.
- CLI: `remote-pi pair` funciona com **zero Pi**: imprime a URI (rm=host)
  falando com o supervisor via UDS; `--rotate`, `--ephemeral`.
- App: endereço + código; `relay_mismatch` continua existindo (68).
- Compat: URI emitida por Pi antigo continua pareando pelo caminho Pi
  (handler do Pi intacto).
- **Aceite:** com zero processos Pi, `remote-pi pair` imprime URI; app cola →
  `pair_ok`; peer aparece em `peers.json`; `--rotate` invalida o código velho;
  token efêmero expira; vitest cobre parse + happy path + token
  inválido/expirado/rotacionado + carve-out de allow-list; `tsc --noEmit` verde.

### W2 — Conexão host-primary + ciclo de vida do Pi

**Onde:** `pi-extension/src/daemon/supervisor.ts` (push de estado),
`src/daemon/host_bridge.ts`, `src/protocol/types.ts`, app
(`connection_manager`, `ui/workspaces/`).

- App: presença/online da máquina = room `host` (`host_hello` no boot,
  reconnect do host independente de workspace). Chat continua no room do
  workspace (multiplex existente), mas **a queda do room do Pi não derruba a
  conexão da máquina**.
- Host: push `workspace_state` em exit/restart/start/stop; `workspace_restart`
  (start idempotente) e `workspace_stop` acessíveis do app.
- App UI: card do workspace mostra estado (`crashed` com `last_error`, botão
  Reiniciar); sessão histórica continua legível via mirror cache quando o Pi
  está morto.
- **Spike D0 (fechar antes de codar):** confirmar contra o relay stub que uma
  conexão app consegue sustentar room `host` + rooms de workspace
  simultaneamente (evidência: `_liveRoomIds` em `connection_manager.dart:140`).
  Se o multiplex não sustentar, plano B: proxy `host_forward`/`host_message`
  (host re-emite para o room do child pela mesma Pi-key) — decisão registrada
  no plano antes da W2 fechar.
- **Aceite:** matar o child do Pi (`kill`) → app recebe `workspace_state:
  crashed` e a **conexão da máquina permanece online**; um toque em Reiniciar
  sobe o Pi e o chat volta; `host_hello_ok` bate com versão/hostname reais;
  vitest + teste de viewmodel no app.

### W3 — Pc (Cockpit + app windows)

**Onde:** `cockpit/` (novo modo de conexão host Remote Pi), `app/` (target
windows — pendência do plano 68).

- Cockpit: conexão por pareamento host (cola URI) reutilizando o protocolo do
  room `host` — paridade de workspaces/fs/chat. Sem câmera no windows (colagem
  é o caminho, 68 U2).
- App windows: target + camada de capacidades (sem câmera → colagem; STT
  opcional). Reaproveita W1–W2 sem retrabalho.
- **Aceite:** Cockpit pareia com um host por colagem, lista workspaces, navega
  fs, inicia Pi e conversa; `flutter test`/analyze verdes no pacote tocado.

### W4 — Web

**Onde:** `relay/` (Rust), cliente web (proposta: rota em `site/` atrás de
flag, UI mínima).

- Relay: allowlist de `Origin` configurável + eco do subprotocolo WS
  (pré-requisitos registrados no plano 68).
- Browser: Ed25519 com detecção de capacidade + fallback wasm.
- Cliente mínimo: parear (endereço+código) → navegar fs → iniciar Pi → chat.
- **Aceite:** cliente web pareia e conversa contra relay stub com Origin
  allowlist ativa; origem fora da lista é rejeitada; paridade de mensagens com
  o app (mesmo `PROTOCOL.md`).

### W5 — Harness de verificação + cadeia completa

- `scripts/verify-p69.mjs` (um runner, cross-platform, descobre `D:/flutter`
  como `scripts/screenshots.sh` já faz; relay stub local Node com contrato
  `{peer, ct}`; variante contra relay real quando alcançável).
- E2E de cadeia: **install/foreground do supervisor → pareamento com zero Pi →
  navegar fs → start de Pi em cwd arbitrário → chat → matar o Pi → host segue
  online + `workspace_state=crashed` → restart → chat de novo**.
- **Aceite:** os 3 comandos de aceite verdes do zero; causa raiz de cada falha
  corrigida (nunca mascarada por skip/timeout).

## Comandos de aceite (declarados no Goal)

1. `node scripts/verify-p69.mjs unit` — vitest `pi-extension` + `tsc --noEmit` + `flutter test`/`analyze` do app
2. `node scripts/verify-p69.mjs e2e` — cadeia completa com zero Pi pré-existente (relay stub)
3. `node scripts/verify-p69.mjs visual` — screenshots das telas novas (pareamento endereço+código, workspace com estado/restart)

## Definition of Done

- [x] `00-decisions.md` registra reabertura de "Sem daemon no MVP" + modelo host-first (com data/razão)
- [x] `PROTOCOL.md` documenta `host_hello`, `workspace_state`, `workspace_restart`, `pair_request` no room `host` (+ proxy `host_forward`/`host_message`, decisão B)
- [x] `remote-pi pair` emite URI (rm=host) com zero Pi rodando; `--rotate`/`--ephemeral` funcionam — vitest 1001 passed + tsc limpo (todo #2)
- [x] `pair_request` de device desconhecido aceito no room `host`; `pair_ok` persiste peer — carve-out coberto por teste (todo #2)
- [x] Payload `remotepi://pair?…` inalterado (teste de regressão); URI emitida por Pi antigo ainda pareia — handler do Pi intacto (todo #2)
- [x] App pareia por endereço+código sem scan; máquina online = room `host` — tela de pareamento com 70 testes + analyze limpo (todo #3); cliente ancora só no room `host` com `host_hello`/presença host-primary (todo #6, 752 testes)
- [x] Kill do child Pi → `workspace_state=crashed` push + conexão da máquina intacta + restart por 1 toque — e2e passo 7 (SIGKILL real, push antes da decisão de restart, `host_hello` responde depois, `workspace_restart_ok`, 1 peer só)
- [x] Cockpit conecta por pareamento host (workspaces/fs/chat) ; app windows target pareia por colagem — cockpit: analyze zero issues + 32/32 nos 3 arquivos novos (cadeia pair→hello→auth Ed25519→list→fs→add/start→chat) (todo #7); app windows: colagem verificada com suite 752 green (todo #8)
- [x] Relay com Origin allowlist; cliente web pareia e conversa contra stub — allowlist de Origin + echo de subprotocolo implementados e cobertos por testes em `relay/` (todo #9); `cargo test` em WSL Debian (toolchain instaldo nesta sessão): **126 passed / 0 failed** (67 lib + 3 integration + 16 mesh + 6 origin + 9 pi_forward + 8 presence + 17 rooms); cliente web verificado: verify-web-client 21/21 + verify-ed25519 29/29 ALL PASS (todo #10)
- [x] 3 comandos de aceite verdes; E2E registra comando e resultado — `node scripts/verify-p69.mjs unit` 4/4 (tsc + vitest + app analyze + 752 testes), `e2e` 2/2 (cadeia 10/10 zero Pi), `visual` 2/2 (18 PNGs incl. telas novas)

## Riscos

| Risco | Mitigação |
|---|---|
| Código de pareamento persistente = credencial total até rotacionar | Padrão persistente é instrução do usuário (U2); `--rotate` invalida; revoke por dispositivo intacto; UI do host avisa; `--ephemeral` disponível |
| carve-out de allow-list virar buraco | Exceção só para `inner.type=="pair_request"` com token válido; resto do host segue fechado; teste de regressão dedicado |
| W2 spike mostrar que o app não sustenta 2 rooms por conexão | Plano B (`host_forward`) já desenhado; decisão registrada antes de fechar W2 |
| cwd arbitrário = execução de código em qualquer pasta | `plan/58-J` full-trust pós-pareamento já assumido; confirmação no 1º start de cada diretório (68) |
| WIP de terceiros no working tree | Preservar e integrar, nunca reverter (regra do 68) |
| Web/Cockpit expandirem escopo | W3/W4 entregam paridade mínima (parear→fs→start→chat); features extras ficam em planos filhos |

## Próximos planos (não perdidos)

- **LAN direto sem relay**: daemon escuta porta local + endereço = host (modelo ssh puro; hoje o endereço é o relay — decisão fechada de relay stateless/self-hostável permanece).
- **Alias de código curto** (ex.: `RP-XXXX-XXXX`) sobre a URI congelada — aditivo, sem quebrar contrato.
- Volta do E2E (Noise) e steal/take-over de sessão do TUI — seguem fora, independentes.

## Resultado de conhecimento (pós-execução)

Avaliar staging só se houver lição reusável: provável **pitfall** (allow-list de
peer desconhecido silenciosamente derruba pareamento de dispositivo novo) e/ou
**restrição prescritiva** (a URI de pareamento é contrato público congelado —
emissor muda, payload nunca). Se nada atingir a barra, zero candidatos.
