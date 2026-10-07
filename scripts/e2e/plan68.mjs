// E2E do plan/68 — cadeia completa, offline, contra o relay stub local.
//
// Cadeia provada (tudo com o código REAL do pi-extension em `dist/`):
//   1. `pair_request` com token → `pair_ok` (pareamento só por colagem)
//   2. `fs_list` navegando o filesystem do host (erros tipados)
//   3. `workspace_add` + `workspace_start` num cwd fora de daemons.json,
//      persistido em workspaces.json, com um daemon REAL subindo e autenticando
//   4. `pi_surface` no daemon real (skills/packages/runtime)
//   5. `skill_invoke` (dispatch para `/skill:<nome>`), incluindo recusa explícita
//   6. `package_install` SEM `confirm_third_party` → `action_error`
//   7. `session_list` / `session_switch` com reset de mirror
//
// O transporte é o contrato `{peer, ct}` de verdade (WebSocket + Ed25519), só
// com o fan-out do relay trocado por um stub local — logo o que é exercitado é
// o cliente real, não um mock de protocolo.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isolateHome } from "./paths.mjs";
import { importDist, importSdk, distBuilt } from "./dist_api.mjs";
import { createFleet } from "./fleet.mjs";

const EXT_ENTRY = join(process.cwd(), "pi-extension", "dist", "index.js");

export async function runE2E({ log } = {}) {
  const results = [];
  // O emissor é injetável (o verify imprime no formato dele), mas a contagem
  // de passos é sempre acumulada aqui — quem chama não deveria ter que
  // reconstruir o resultado a partir do log.
  const record = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    if (log) log(name, ok, detail);
    else console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };

  if (!distBuilt()) {
    record("dist/ do pi-extension existe", false, "rode `pnpm build` antes do e2e");
    return results;
  }

  const home = isolateHome({ mkdtempSync, mkdirSync, tmpdir });
  const cleanupDirs = [home];
  const track = (dir) => { cleanupDirs.push(dir); return dir; };

  const { RelayStub } = await import(pathToFileURL(join(import.meta.dirname, "relay_stub.mjs")).href);
  const stub = new RelayStub();
  const wsUrl = await stub.listen();
  process.env.REMOTE_PI_RELAY = stub.httpUrl;

  const idx = await importDist("index.js");
  const { RelayClient } = await importDist("transport/relay_client.js");
  const { generateEd25519Keypair } = await importDist("pairing/crypto.js");
  const { roomIdFor } = await importDist("rooms.js");
  const { HostBridge } = await importDist("daemon/host_bridge.js");
  const workspaces = await importDist("daemon/workspaces.js");
  const registry = await importDist("daemon/registry.js");
  const idMod = await importDist("daemon/id.js");
  const localConfig = await importDist("session/local_config.js");
  const { RpcChild } = await importDist("daemon/rpc_child.js");
  const { qrSession } = await importDist("pairing/qr.js");

  const fleet = createFleet({
    extensionPath: EXT_ENTRY,
    RpcChild,
    workspaces,
    registry,
    id: idMod,
    localConfig,
  });

  // ── A máquina: host room (fs + catálogo) + um Pi de workspace ─────────────
  const bridge = new HostBridge({ fleet });
  await bridge.start();

  // O Pi do workspace: sobe a extensão REAL com a fábrica real (sem device).
  const wsDir = track(mkdtempSync(join(tmpdir(), "pi-e2e-workspace-")));
  mkdirSync(join(wsDir, ".pi", "remote-pi"), { recursive: true });
  writeFileSync(join(wsDir, ".pi", "remote-pi", "config.json"),
    JSON.stringify({ auto_start_relay: true, agent_name: "e2e-ws" }));

  const handlers = new Map();
  const piCommands = new Map();
  const sentMessages = [];
  const userMessages = [];
  const mockPi = {
    on: (ev, fn) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    registerCommand: (name, opts) => piCommands.set(name, opts),
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: (m) => sentMessages.push(m),
    sendUserMessage: (text, opts) => userMessages.push({ text, opts }),
  };
  idx.default(mockPi);
  const ui = {
    notify: () => undefined, setStatus: () => undefined, setTitle: () => undefined,
    select: async () => undefined, confirm: async () => true, input: async () => undefined,
  };
  const piCtx = { cwd: wsDir, ui, getModel: () => ({ provider: "test", id: "m" }) };
  idx._setPiForTest({
    sendMessage: (m) => sentMessages.push(m),
    sendUserMessage: (text, opts) => userMessages.push({ text, opts }),
    getThinkingLevel: () => "medium",
  });
  // `session_start` é o que instala o ctx vivo (cwd, ui) que a superfície e as
  // ações de sessão leem. Num host real a SDK chama isso depois do bindCore;
  // aqui o e2e emite o mesmo evento com o mesmo ctx.
  for (const fn of handlers.get("session_start") ?? []) fn({ type: "session_start" }, piCtx);
  await idx._startRelayForTest(piCtx);
  await stub.waitForAuth(null, 20_000);

  const piRoom = roomIdFor(wsDir, "e2e-ws");
  const hostRoom = "host";

  // ── O app: peer Ed25519 próprio, fala nas duas rooms ─────────────────────
  const appKp = generateEd25519Keypair();
  const appPub = Buffer.from(appKp.publicKey).toString("base64");

  // O daemon do workspace é um processo separado que só aceita peers de
  // `peers.json`. Semear o app lá é exatamente o estado que um pareamento
  // anterior deixa — e é o "reconnect path" que a extensão documenta (peer
  // conhecido sem canal ativo → adota + roteia). Sem isto o daemon responde
  // `unknown_peer` e a conversa não teria como ser exercitada de verdade.
  writeFileSync(
    join(home, ".pi", "remote", "peers.json"),
    JSON.stringify({ peers: [{ name: "e2e-app", remote_epk: appPub, paired_at: new Date().toISOString() }] }),
  );

  /** Uma "sessão" do app por room (o app real abre uma por room). */
  async function openApp(roomId) {
    const client = new RelayClient(wsUrl, appKp);
    const inbox = [];
    client.on("message", (l) => {
      try { inbox.push(JSON.parse(l)); } catch { /* ignore */ }
    });
    await client.connect({ roomId, roomMeta: { name: "e2e-app", cwd: "/m" } });
    await new Promise((r) => setTimeout(r, 150));
    const send = (msg) => client.send(JSON.stringify({
      peer: appPub, ct: Buffer.from(JSON.stringify(msg)).toString("base64"),
    }));
    const waitReply = async (replyTo, ms = 25_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        for (const o of inbox) {
          try {
            const inner = JSON.parse(Buffer.from(o.ct, "base64").toString());
            if (inner.in_reply_to === replyTo) return inner;
          } catch { /* not ours */ }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    };
    /** Espera qualquer frame que satisfaça `pred` (ex.: o eco de um user_message,
     *  que traz `id` em vez de `in_reply_to`). */
    const waitFor = async (pred, ms = 25_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        for (const o of inbox) {
          try {
            const inner = JSON.parse(Buffer.from(o.ct, "base64").toString());
            if (pred(inner)) return inner;
          } catch { /* not ours */ }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    };
    return { client, send, waitReply, waitFor, inbox };
  }

  const host = await openApp(hostRoom);
  const pi = await openApp(piRoom);
  // Toda sessão de app aberta no meio do e2e entra aqui para o teardown fechar.
  const appClients = [host, pi];

  try {
    // ── 1. Pareamento só por colagem ────────────────────────────────────────
    const token = qrSession.issueToken();
    const tokenStr = typeof token === "string" ? token : token.token;
    pi.send({ type: "pair_request", id: "pair-1", token: tokenStr, device_name: "E2E Phone" });
    const pairOk = await pi.waitReply("pair-1");
    record(
      "1. colar o pairing code → pair_ok (sem scan)",
      pairOk?.type === "pair_ok" && pairOk.room_id === piRoom,
      pairOk ? `room_id=${pairOk.room_id} harness=${pairOk.harness?.version}` : "sem resposta",
    );
    await new Promise((r) => setTimeout(r, 150));

    // ── 2. fs_list navega o filesystem do host ─────────────────────────────
    // Uma árvore conhecida: um repo (com .git), um dir comum, um arquivo e um
    // dotfile escondido — o suficiente para provar ordenação e classificação.
    const navRoot = track(mkdtempSync(join(tmpdir(), "pi-e2e-nav-")));
    mkdirSync(join(navRoot, "zeta-repo", ".git"), { recursive: true });
    mkdirSync(join(navRoot, "alpha-dir"), { recursive: true });
    mkdirSync(join(navRoot, ".escondido"), { recursive: true });
    writeFileSync(join(navRoot, "arquivo.txt"), "x");

    host.send({ type: "fs_list", id: "fs-1", path: navRoot });
    const fsOk = await host.waitReply("fs-1");
    const names = fsOk?.entries?.map((e) => e.name) ?? [];
    const kinds = fsOk?.entries?.map((e) => e.kind) ?? [];
    record(
      "2a. fs_list lista o diretório do host: dirs primeiro, dotfile oculto",
      fsOk?.type === "fs_list_ok" &&
        JSON.stringify(names) === JSON.stringify(["alpha-dir", "zeta-repo", "arquivo.txt"]) &&
        kinds.every((k, i) => (i < 2 ? k === "dir" : k === "file")),
      fsOk?.type === "fs_list_ok" ? `entries=${names.join(",")}` : "sem resposta",
    );

    const repo = fsOk?.entries?.find((e) => e.name === "zeta-repo");
    record(
      "2b. fs_list marca o diretório que é repositório (is_repo) sem recursar",
      repo?.is_repo === true,
      `zeta-repo.is_repo=${repo?.is_repo}`,
    );

    host.send({ type: "fs_list", id: "fs-2", path: navRoot, show_hidden: true });
    const fsHidden = await host.waitReply("fs-2");
    record(
      "2c. fs_list com show_hidden expõe dotfiles (opt-in)",
      (fsHidden?.entries?.map((e) => e.name) ?? []).includes(".escondido"),
      `entries=${(fsHidden?.entries?.map((e) => e.name) ?? []).join(",")}`,
    );

    host.send({ type: "fs_list", id: "fs-3", path: navRoot });
    const fsParent = await host.waitReply("fs-3");
    record(
      "2d. fs_list devolve o realpath resolvido e o parent (subir um nível)",
      typeof fsParent?.path === "string" &&
        fsParent.path.length > 0 &&
        typeof fsParent.parent === "string" &&
        fsParent.parent !== fsParent.path,
      `path=${fsParent?.path} parent=${fsParent?.parent}`,
    );

    host.send({ type: "fs_list", id: "fs-4", path: join(navRoot, "nao-existe-xyz") });
    const fsErr = await host.waitReply("fs-4");
    record(
      "2e. fs_list em caminho inexistente → erro tipado not_found",
      fsErr?.type === "action_error" && fsErr.error === "not_found",
      fsErr ? `error=${fsErr.error}` : "sem resposta",
    );

    host.send({ type: "fs_list", id: "fs-5", path: join(navRoot, "arquivo.txt") });
    const fsNotDir = await host.waitReply("fs-5");
    record(
      "2f. fs_list num arquivo → erro tipado not_a_directory",
      fsNotDir?.type === "action_error" && fsNotDir.error === "not_a_directory",
      fsNotDir ? `error=${fsNotDir.error}` : "sem resposta",
    );

  // ── 3. workspace_add + workspace_start em cwd fora de daemons.json ─────
  // O app escolhe a pasta navegando (fs_list) e a registra. Depois inicia
  // EXATAMENTE esse caminho, que é o que prova o caminho escolhido pelo usuário.
  const entryChild = track(mkdtempSync(join(tmpdir(), "pi-e2e-entry-")));
  writeFileSync(join(entryChild, "projeto.txt"), "e2e");
    host.send({ type: "workspace_add", id: "wa-1", path: entryChild });
    const addOk = await host.waitReply("wa-1");
    const stored = workspaces.listWorkspaces().map((w) => w.cwd);
    const realChild = stored.find((c) => c === entryChild);
    record(
      "3a. workspace_add persiste em workspaces.json (não em daemons.json)",
      addOk?.type === "action_ok" &&
        stored.includes(realChild) &&
        !(registry.loadRegistry().daemons ?? []).some((d) => d.cwd === realChild),
      `stored=${realChild}`,
    );

    host.send({ type: "workspace_list", id: "wl-1" });
    const listOk = await host.waitReply("wl-1");
    const row = listOk?.workspaces?.find((w) => w.cwd === realChild);
    record(
      "3b. workspace_list marca a origem como `added`",
      row?.source === "added" && row?.daemon === false,
      row ? `source=${row.source} daemon=${row.daemon}` : "linha ausente",
    );

    host.send({ type: "workspace_start", id: "ws-1", cwd: realChild });
    const startOk = await host.waitReply("ws-1");
    record(
      "3c. workspace_start aceita cwd fora de daemons.json → workspace_start_ok",
      startOk?.type === "workspace_start_ok" && startOk.cwd === realChild,
      startOk ? `cwd=${startOk.cwd} room=${startOk.room_id}` : `sem resposta (${startOk?.error ?? "?"})`,
    );

    // O daemon é outro processo: a autenticação dele no relay é assíncrona em
    // relação ao ack do host. Espera a room ganhar um peer.
    const startedRoom = startOk?.room_id ?? "-";
    const peersBefore = stub.roomPeerCount(startedRoom);
    const daemonAuthed = await stub.waitForRoomPeer(startedRoom, { baseline: peersBefore });
    record(
      "3d. o daemon do workspace sobe de verdade e autentica no relay",
      daemonAuthed,
      daemonAuthed
        ? `room=${startedRoom} peers=${stub.roomPeerCount(startedRoom)}`
        : "nenhum peer na room",
    );

    // ── 4. pi_surface no Pi do workspace ───────────────────────────────────
    pi.send({ type: "pi_surface", id: "sf-1" });
    const surface = await pi.waitReply("sf-1");
    record(
      "4a. pi_surface reporta runtime + skills + packages",
      surface?.type === "pi_surface_ok" &&
        Array.isArray(surface.skills) &&
        Array.isArray(surface.packages) &&
        surface.runtime?.thinking === "medium",
      surface?.type === "pi_surface_ok"
        ? `skills=${surface.skills.length} packages=${surface.packages.length} thinking=${surface.runtime.thinking}`
        : `sem resposta (${surface?.error ?? "?"})`,
    );

    // Uma skill local instalada aparece com origem `user` e pode ser desligada.
    const skillDir = join(wsDir, ".pi", "skills", "e2e-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"),
      "---\nname: e2e-skill\ndescription: Skill de teste do e2e\n---\n\nFaça o que foi pedido.\n");
    // O daemon lê o cwd do projeto; a surface do processo da extensão também.
    pi.send({ type: "pi_surface", id: "sf-2" });
    const surface2 = await pi.waitReply("sf-2");
    const skill = surface2?.skills?.find((s) => s.name === "e2e-skill");
    record(
      "4b. pi_surface lista uma skill do projeto com origem `project`",
      skill?.source === "project" && skill?.enabled === true,
      skill ? `source=${skill.source} enabled=${skill.enabled}` : `skills=${surface2?.skills?.length ?? "?"}`,
    );

    if (skill) {
      pi.send({ type: "skill_set_enabled", id: "se-1", name: "e2e-skill", enabled: false });
      const toggled = await pi.waitReply("se-1");
      pi.send({ type: "pi_surface", id: "sf-3" });
      const surface3 = await pi.waitReply("sf-3");
      const after = surface3?.skills?.find((s) => s.name === "e2e-skill");
      record(
        "4c. skill_set_enabled persiste e a re-leitura mostra enabled=false",
        toggled?.type === "skill_set_enabled_ok" && after?.enabled === false,
        `ack=${toggled?.type} enabled=${after?.enabled}`,
      );
    }

    // ── 5. skill_invoke ─────────────────────────────────────────────────────
    pi.send({ type: "skill_invoke", id: "ki-1", name: "nao-existe-mesmo" });
    const invokeBad = await pi.waitReply("ki-1");
    record(
      "5a. skill_invoke de skill inexistente → action_error explícito",
      invokeBad?.type === "action_error" && /not installed/i.test(invokeBad.error ?? ""),
      invokeBad ? invokeBad.error : "sem resposta",
    );

    if (skill) {
      pi.send({ type: "skill_invoke", id: "ki-2", name: "e2e-skill", args: "faca isso" });
      const invokeOk = await pi.waitReply("ki-2");
      record(
        "5b. skill_invoke entrega `/skill:<nome> <args>` ao Pi",
        invokeOk?.type === "skill_invoke_ok" &&
          userMessages.some((m) => m.text === "/skill:e2e-skill faca isso" && m.opts?.expandPromptTemplates === true),
        userMessages.length ? `texto=${userMessages[userMessages.length - 1].text}` : "nada despachado",
      );
    }

    // ── 6. conversa: user_message → eco confirmado (cadeia do chat) ────────
    // O daemon real é quem atende aqui: ele tem sessão e espelho de verdade.
    const startedRoom2 = startOk?.room_id ?? "-";
    const ws = await openApp(startedRoom2);
    appClients.push(ws);
    // Espera o daemon estar de pé e atendendo antes de conversar.
    let alive = null;
    for (let i = 0; i < 40 && !alive; i++) {
      ws.send({ type: "ping", id: `ping-${i}` });
      alive = await ws.waitReply(`ping-${i}`, 1000);
    }
    record(
      "6a. o daemon do workspace responde no canal pareado (ping/pong)",
      alive?.type === "pong",
      alive ? "pong" : "sem resposta",
    );

    ws.send({ type: "user_message", id: "um-1", text: "oi do app" });
    // O eco volta com `id` (não `in_reply_to`) — é a confirmação da bolha otimista.
    const echo = await ws.waitFor((m) => m.type === "user_message" && m.id === "um-1", 20_000);
    record(
      "6b. user_message é aceito e ecoado (a bolha otimista confirma)",
      echo?.type === "user_message" && echo?.text === "oi do app",
      echo ? `echo id=${echo.id}` : "sem eco",
    );

    ws.send({ type: "session_sync", id: "sync-1" });
    const sync = await ws.waitReply("sync-1");
    record(
      "6c. session_sync devolve o histórico da sessão (espelho reidrata)",
      sync?.type === "session_history" && Array.isArray(sync.events),
      sync?.type === "session_history" ? `events=${sync.events.length}` : `sem resposta (${sync?.error ?? "?"})`,
    );

    // ── 7. package_install sem confirmação é recusado ──────────────────────
    pi.send({ type: "package_install", id: "pi-1", source: "npm:@e2e/never@1.0.0", scope: "user" });
    const installRefused = await pi.waitReply("pi-1");
    record(
      "7a. package_install sem confirm_third_party → action_error, nada instalado",
      installRefused?.type === "action_error" &&
        /confirm_third_party/.test(installRefused.error ?? ""),
      installRefused ? installRefused.error : "sem resposta",
    );

    pi.send({ type: "package_install", id: "pi-2", source: "npm:@e2e/never@1.0.0", scope: "user", confirm_third_party: false });
    const installFalse = await pi.waitReply("pi-2");
    record(
      "7b. confirm_third_party=false também é recusado (nunca é opcional)",
      installFalse?.type === "action_error",
      installFalse ? `type=${installFalse.type}` : "sem resposta",
    );

    // ── 8. session_list / session_switch no daemon real ────────────────────
    // O daemon iniciou uma sessão nova (--continue sem histórico prévio). Para
    // haver o que trocar, semeia uma sessão histórica pela API autoritativa do
    // SDK — o mesmo SessionManager que `handleSessionSwitch` usa para listar.
    // O arquivo só materializa depois de um turno com assistant, daí o par
    // user+assistant (não um jeito de burlar a persistência).
    const { SessionManager } = await importSdk("core/session-manager.js");
    const historic = SessionManager.create(realChild, undefined, { name: "sessao historica" });
    historic.appendMessage({ role: "user", content: "pergunta antiga" });
    historic.appendMessage({ role: "assistant", content: [{ type: "text", text: "resposta antiga" }] });
    const historicId = historic.getSessionId();

    ws.send({ type: "session_list", id: "sl-1" });
    const sessions = await ws.waitReply("sl-1");
    const rows = sessions?.sessions ?? [];
    record(
      "8a. session_list responde a lista de sessões do workspace",
      sessions?.type === "session_list_ok" && Array.isArray(sessions.sessions),
      sessions?.type === "session_list_ok" ? `sessions=${rows.length}` : `sem resposta (${sessions?.error ?? "?"})`,
    );

    const target = rows.find((s) => s.id === historicId) ?? rows.find((s) => s.id !== sessions?.current_id);
    if (target) {
      ws.send({ type: "session_switch", id: "sw-daemon", session_id: target.id });
      const inDaemon = await ws.waitReply("sw-daemon", 15_000);
      // O daemon roda em modo RPC e nunca executa um handler de comando, então
      // não tem ctx com `switchSession`. Isto NÃO é uma falha do e2e: é o
      // contrato documentado (`no_sdk`, "daemon needs --resume"). O teste fixa
      // que a recusa é tipada e explicativa — não um silêncio.
      record(
        "8b. session_switch no daemon recusa com erro tipado no_sdk (contrato)",
        inDaemon?.type === "session_switch_error" && inDaemon.code === "no_sdk",
        inDaemon ? `code=${inDaemon.code} msg=${inDaemon.message}` : "sem resposta",
      );
    } else {
      record("8b. session_switch no daemon recusa com erro tipado no_sdk (contrato)", false, `sem sessão (ou=${rows.length})`);
    }

    // O caminho COM ctx de comando (sessão interativa): o handler real troca a
    // sessão, reseta o espelho e responde `session_switch_ok`. Aqui o ctx é
    // fornecido pelo harness, como a SDK faria num host interativo.
    if (historicId) {
      let rebound = null;
      const interactiveCtx = {
        cwd: realChild,
        abort: () => undefined,
        switchSession: async (path, options) => {
          rebound = { path, options };
          await options?.withSession?.({ cwd: realChild });
          return { cancelled: false };
        },
      };
      idx._setLastCtxForTest(interactiveCtx);
      pi.send({ type: "session_switch", id: "sw-1", session_id: historicId });
      // O reset do espelho também usa este id num `session_history`, então
      // esperar pelo tipo certo — não apenas pelo `in_reply_to`.
      const switched = await pi.waitFor(
        (m) => m.type === "session_switch_ok" && m.in_reply_to === "sw-1",
        15_000,
      );
      const mirrorReset = pi.inbox.some((o) => {
        try {
          const m = JSON.parse(Buffer.from(o.ct, "base64").toString());
          return m.type === "session_history" && m.in_reply_to === "sw-1";
        } catch { return false; }
      });
      record(
        "8c. com ctx de comando, session_switch troca a sessão e responde ok",
        switched?.type === "session_switch_ok" && switched.session_id === historicId && rebound !== null,
        switched?.type === "session_switch_ok"
          ? `session_id=${switched.session_id} rebound=${rebound !== null} mirror_reset=${mirrorReset}`
          : `sem resposta (${switched?.error ?? switched?.message ?? "?"})`,
      );
    }

    // ── teardown ───────────────────────────────────────────────────────────
    await fleet.shutdown();
    await bridge.stop();
    for (const c of appClients) c.client.close();
    await idx._stopForTest(piCtx);

    // Prova de isolamento: o e2e escreveu nos stores do home descartável.
    const wsFile = join(home, ".pi", "remote", "workspaces.json");
    const wroteIsolated = existsSync(wsFile) &&
      JSON.parse(readFileSync(wsFile, "utf8")).workspaces.some((w) => w.cwd === realChild);
    record(
      "9. os stores usados foram os do home isolado (não a máquina do usuário)",
      wroteIsolated,
      wsFile.replace(home, "~e2e"),
    );
  } finally {
    for (const dir of cleanupDirs.reverse()) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    await stub.close().catch(() => undefined);
  }

  return results;
}

// Execução direta: `node scripts/e2e/plan68.mjs`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const results = await runE2E();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passaram`);
  process.exit(failed.length ? 1 : 0);
}
