// E2E do plan/69 — cadeia host-first com ZERO Pi pré-existente.
//
// Cadeia provada (tudo com o código REAL do pi-extension em `dist/`):
//   1. supervisor vivo + room `host` online com ZERO processos Pi
//   2. pareamento pelo room `host` com o token persistente do daemon
//      → pair_ok + peer persistido em peers.json   (nada de Pi rodando!)
//   3. rotação invalida o token velho → pair_error
//   4. token efêmero expira → pair_error
//   5. fs_list navegando o filesystem do host ( + erro tipado )
//   6. workspace_add + workspace_start em cwd arbitrário (filho real sobe)
//   7. kill do Pi → push workspace_state=crashed + conexão da máquina
//      sobrevive + restart por 1 toque (sem double-spawn)
//   8. restart é idempotente: 2º toque não respawna
//   9. chat via proxy: host_forward → host_message (decisão B do spike)
//
// Diferente do plan68 (que usava um fleet mínimo), aqui rodamos o
// SUPERVISOR de verdade — é o produto do plano. O transporte é o relay stub
// em modo FIEL (roteia por (peer,room) de destino e reescreve o envelope com
// peer+room do remetente — semântica do relay real, relay/src/handlers/peer.rs).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isolateHome } from "./paths.mjs";
import { importDist, distBuilt } from "./dist_api.mjs";

const EXT_ENTRY = join(process.cwd(), "pi-extension", "dist", "index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const unb64 = (ct) => JSON.parse(Buffer.from(ct, "base64").toString("utf8"));

export async function runE2E({ log } = {}) {
  const results = [];
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
  const stub = new RelayStub({ faithful: true });
  const wsUrl = await stub.listen();
  process.env.REMOTE_PI_RELAY = stub.httpUrl;

  const { RelayClient } = await importDist("transport/relay_client.js");
  const { generateEd25519Keypair } = await importDist("pairing/crypto.js");
  const { getOrCreateEd25519Keypair } = await importDist("pairing/storage.js");
  const { hostPairing } = await importDist("pairing/host_pairing.js");
  const { Supervisor } = await importDist("daemon/supervisor.js");
  const workspaces = await importDist("daemon/workspaces.js");
  const registry = await importDist("daemon/registry.js");
  const id = await importDist("daemon/id.js");
  const { roomIdFor } = await importDist("rooms.js");

  // A máquina: SÓ o supervisor. Nenhum Pi — é a hipótese inteira do plano 69.
  // `pairing` é injetado para o harness dirigir issue/rotate na MESMA store
  // que o HostBridge valida (o supervisor passa opts.pairing adiante).
  const hostKeypair = await getOrCreateEd25519Keypair();
  const hostPub = Buffer.from(hostKeypair.publicKey).toString("base64");
  const supervisor = new Supervisor({ extensionPath: EXT_ENTRY, pairing: hostPairing });
  await supervisor.start(); // bind UDS (home isolado) + 0 daemons + bridge no room host
  await stub.waitForAuth(hostPub, 20_000);

  // O app: peer Ed25519 próprio, UMA conexão, ancorada no room `host`.
  const appKp = generateEd25519Keypair();
  const appPub = Buffer.from(appKp.publicKey).toString("base64");
  const client = new RelayClient(wsUrl, appKp);
  const inbox = [];
  client.on("message", (line) => {
    try { inbox.push(JSON.parse(line)); } catch { /* ignore */ }
  });
  await client.connect({ roomId: "host", roomMeta: { name: "e2e-app", cwd: "/m" } });
  await sleep(150);
  const send = (msg) =>
    client.send(JSON.stringify({ peer: hostPub, room: "host", ct: b64(msg) }));
  const decodeInbox = () =>
    inbox.map((o) => { try { return unb64(o.ct); } catch { return null; } }).filter(Boolean);
  const waitReply = async (replyTo, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = decodeInbox().find((m) => m.in_reply_to === replyTo);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };
  const waitFor = async (pred, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = decodeInbox().find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };

  const wsDir = track(mkdtempSync(join(tmpdir(), "pi-e2e-ws-")));
  mkdirSync(join(wsDir, ".pi", "remote-pi"), { recursive: true });
  writeFileSync(
    join(wsDir, ".pi", "remote-pi", "config.json"),
    JSON.stringify({ auto_start_relay: true, agent_name: "e2e-ws" }),
  );

  try {
    // ── 1. Host online com ZERO Pi ──────────────────────────────────────────
    const noDaemons = (registry.loadRegistry().daemons ?? []).length === 0;
    const noWorkspaces = workspaces.listWorkspaces().length === 0;
    const zeroPi =
      noDaemons &&
      noWorkspaces &&
      !stub.rooms.has(roomIdFor(wsDir, "e2e-ws")) &&
      stub.roomPeerCount("host") === 2; // bridge do supervisor + app
    record(
      "1. room host online com ZERO processos Pi",
      zeroPi,
      `peers no host=${stub.roomPeerCount("host")} daemons=${noDaemons ? 0 : "?"} workspaces=${noWorkspaces ? 0 : "?"}`,
    );

    // ── 2. Pareamento pelo host (token persistente, zero Pi) ─────────────────
    const issued = await hostPairing.issue();
    send({ type: "pair_request", id: "pair-host-1", token: issued.token, device_name: "E2E Phone" });
    const pairOk = await waitReply("pair-host-1");
    let peersOnDisk = [];
    try {
      peersOnDisk = JSON.parse(readFileSync(join(home, ".pi", "remote", "peers.json"), "utf8")).peers ?? [];
    } catch { /* ausente = falha asserida abaixo */ }
    record(
      "2. pair_request no room host → pair_ok (zero Pi rodando)",
      pairOk?.type === "pair_ok" && peersOnDisk.some((p) => p.remote_epk === appPub),
      pairOk ? `room=${pairOk.room_id ?? "host"} peer persistido=${peersOnDisk.some((p) => p.remote_epk === appPub)}` : "sem resposta",
    );

    // ── 3. Rotação invalida o token velho ───────────────────────────────────
    await hostPairing.issue(); // rotate: o token deixa de valer
    send({ type: "pair_request", id: "pair-host-2", token: issued.token, device_name: "E2E Phone 2" });
    const rotated = await waitReply("pair-host-2");
    record(
      "3. token rotacionado → pair_error (código velho não pareia)",
      rotated?.type === "pair_error",
      rotated ? `code=${rotated.code ?? rotated.error ?? "?"}` : "sem resposta",
    );

    // ── 4. Token efêmero expira ─────────────────────────────────────────────
    const eph = await hostPairing.issue({ ephemeral: true, ttlMs: 400 });
    await sleep(600);
    send({ type: "pair_request", id: "pair-host-3", token: eph.token, device_name: "E2E Phone 3" });
    const expired = await waitReply("pair-host-3");
    record(
      "4. token efêmero expirado → pair_error",
      expired?.type === "pair_error",
      expired ? `code=${expired.code ?? expired.error ?? "?"}` : "sem resposta",
    );

    // ── 5. fs_list no host ──────────────────────────────────────────────────
    send({ type: "fs_list", id: "fs-1", path: home, show_hidden: true });
    const fsOk = await waitReply("fs-1");
    send({ type: "fs_list", id: "fs-2", path: join(home, "nao-existe") });
    const fsErr = await waitReply("fs-2");
    record(
      "5. fs_list navega o filesystem do host",
      fsOk?.type === "fs_list_ok" && Array.isArray(fsOk.entries) && fsOk.entries.some((e) => e.name === ".pi"),
      fsOk ? `entries=${fsOk.entries.length}` : "sem resposta",
    );
    record(
      "5b. fs_list caminho inexistente → action_error not_found",
      fsErr?.type === "action_error" && fsErr.error === "not_found",
      fsErr ? `error=${fsErr.error}` : "sem resposta",
    );

    // ── 6. workspace_add + workspace_start em cwd arbitrário ────────────────
    send({ type: "workspace_add", id: "ws-add-1", path: wsDir });
    const addOk = await waitReply("ws-add-1");
    send({ type: "workspace_start", id: "ws-start-1", cwd: wsDir });
    const startOk = await waitReply("ws-start-1");
    // O nome do child é `defaultAgentName(cwd)` = basename — o supervisor
    // NÃO lê o agent_name do config.json no catalog de workspaces adicionados.
    const childRoom = roomIdFor(wsDir, basename(wsDir));
    const childUp = await stub.waitForRoomPeer(childRoom, { baseline: 0, timeoutMs: 45_000 });
    let persisted = false;
    try {
      const stored = JSON.parse(readFileSync(join(home, ".pi", "remote", "workspaces.json"), "utf8"));
      persisted = (stored.workspaces ?? []).some((w) => w.cwd === wsDir);
    } catch { /* ausente = falha asserida abaixo */ }
    const roomsSeen = [...stub.rooms.keys()].join(",");
    record(
      "6. workspace_add + workspace_start em cwd fora de daemons.json",
      addOk?.type === "action_ok" && addOk.action === "workspace_add" &&
        startOk?.type === "workspace_start_ok" &&
        childUp &&
        persisted,
      `add=${addOk?.type ?? "-"} start=${startOk?.type ?? "-"} child autenticado=${childUp} persistido=${persisted} rooms=[${roomsSeen}]`,
    );

    // ── 7. Ciclo de vida: morte do Pi ≠ morte da conexão ────────────────────
    // PID via campo privado do supervisor (em JS compilado é acessível; o
    // harness precisa do OS pid para matar o processo de verdade).
    const childId = id.daemonIdForCwd(wsDir);
    const pid = supervisor.children.get(childId)?.child.pid;
    if (typeof pid !== "number") {
      record("7. kill do Pi → push crashed + restart por 1 toque", false, "pid do child não encontrado");
    } else {
      let killErr = "";
      try {
        process.kill(pid, "SIGKILL"); // crash de verdade (sinal, não stop limpo)
      } catch (e) {
        killErr = String(e);
      }
      const crashedPush = await waitFor(
        (m) => m.type === "workspace_state" && m.cwd === wsDir && m.state === "crashed",
        15_000,
      );
      // A conexão da máquina sobrevive: o host ainda responde DEPOIS da morte.
      send({ type: "host_hello", id: "hello-after-crash" });
      const helloOk = await waitReply("hello-after-crash");
      // Recuperação por 1 toque (pode cair antes ou depois do backoff de 1s —
      // os dois encadeamentos têm de convergir para 1 filho só).
      send({ type: "workspace_restart", id: "ws-restart-1", cwd: wsDir });
      const restartOk = await waitReply("ws-restart-1");
      const runningPush = await waitFor(
        (m) => m.type === "workspace_state" && m.cwd === wsDir && m.state === "running",
        20_000,
      );
      const childBack = await stub.waitForRoomPeer(childRoom, { baseline: 0, timeoutMs: 30_000 });
      await sleep(2_500); // poeira baixar: double-spawn apareceria como 2º peer
      const peersAfter = stub.roomPeerCount(childRoom);
      record(
        "7. kill do Pi → push crashed + conexão sobrevive + restart por 1 toque",
        crashedPush?.type === "workspace_state" &&
          crashedPush.state === "crashed" &&
          crashedPush.last_error !== null &&
          helloOk?.type === "host_hello_ok" &&
          restartOk?.type === "workspace_restart_ok" &&
          restartOk.cwd === wsDir &&
          runningPush?.type === "workspace_state" &&
          childBack &&
          peersAfter === 1,
        `last_error="${crashedPush?.last_error ?? "-"}" hello=${helloOk?.type ?? "-"} restart=${restartOk?.type ?? "-"} peers=${peersAfter}${killErr ? ` killErr=${killErr}` : ""}`,
      );

      // ── 8. Restart idempotente: 2º toque não respawna ─────────────────────
      const pidBefore = supervisor.children.get(childId)?.child.pid;
      send({ type: "workspace_restart", id: "ws-restart-2", cwd: wsDir });
      const restart2 = await waitReply("ws-restart-2");
      const pidAfter = supervisor.children.get(childId)?.child.pid;
      record(
        "8. restart idempotente (workspace running → ok sem respawn)",
        restart2?.type === "workspace_restart_ok" && pidAfter === pidBefore && typeof pidAfter === "number",
        `pid ${pidBefore} → ${pidAfter}`,
      );
    }

    // ── 9. Chat via proxy (host_forward → host_message, decisão B) ──────────
    send({
      type: "host_forward",
      id: "fwd-1",
      room: childRoom,
      ct: b64({ type: "user_message", id: "um-69", text: "olá do e2e p69" }),
    });
    const wrapped = await waitFor(
      (m) => m.type === "host_message" && m.room === childRoom,
      20_000,
    );
    let inner = null;
    if (wrapped) { try { inner = unb64(wrapped.ct); } catch { /* asserido abaixo */ } }
    // Nenhum frame de chat despachado SEM o wrap host_message chega ao app.
    const unwrappedChat = decodeInbox().some(
      (m) => (m.type === "user_message" || m.type === "agent_chunk" || m.type === "agent_done"),
    );
    record(
      "9. chat via proxy: host_forward → host_message{room: childRoom}",
      wrapped?.type === "host_message" &&
        wrapped.room === childRoom &&
        inner?.type === "user_message" &&
        inner.id === "um-69" &&
        inner.text === "olá do e2e p69" &&
        !unwrappedChat,
      `inner=${inner?.type ?? "-"}#${inner?.id ?? "-"} unwrapped=${unwrappedChat}`,
    );
  } finally {
    try { await supervisor.stop(); } catch { /* noop */ }
    try { client.close(); } catch { /* noop */ }
    try { await stub.close(); } catch { /* noop */ }
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  }

  return results;
}

// Execução direta: `node scripts/e2e/plan69.mjs`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const results = await runE2E();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passaram`);
  process.exit(failed.length ? 1 : 0);
}
