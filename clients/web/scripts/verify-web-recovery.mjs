/**
 * Wave 2 recovery verification for `src/lib/remote-pi/adapter.ts` (plan 69 W4).
 *
 * Two instruments, both driving the REAL adapter code (Node 22 runs the TS):
 *   • a typed FAKE transport (the documented injection seam) for the
 *     lifecycle, sequence, storage and retry-budget matrix;
 *   • the REAL `RemotePiWebClient` over the predecessor's relay stub, with a
 *     recording WebSocket, for the end-to-end proof: full flow
 *     `pair → host_hello → workspace_list → connected`, an unexpected drop
 *     followed by a reconnect with a NEW ephemeral key and NO replayed chat,
 *     `restore()` re-pairing from the stored five-field record, and a finite
 *     backoff that ends at `retry_exhausted` when the relay is gone.
 *
 * Run: node scripts/verify-web-recovery.mjs
 */

import { RemotePiAdapter, AdapterStateError } from "../src/lib/remote-pi/adapter.ts";
import {
  PairRejectedError,
  decodeCt,
  parsePairUri,
} from "../src/lib/remote-pi/protocol.ts";
import { SessionPersistenceError, SESSION_STORAGE_KEY } from "../src/lib/remote-pi/persistence.ts";
import { TransportError } from "../src/lib/remote-pi/client.ts";
import { startRelayStub } from "./relay-stub.mjs";

const HOST_ROOM = "host";
const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "pair-token-SECRET";
const ALLOWED_ORIGIN = "https://web.remote-pi.example";
const SHORT_RETRY = { maxRetries: 2, baseDelayMs: 8, maxDelayMs: 20 };
/** Stored record that shares the SAME identity as `target()` on this adapter —
 *  host epk, room, RELAY (the adapter default, exactly what a re-pasted code
 *  would select) and token — differing ONLY by `name`. The name is display
 *  metadata, so this is NOT an unrelated pairing: an explicit pair of
 *  `target()` refused by the host must clear THIS record. */
const SAME_IDENTITY_RECORD = storedRecord({ name: "guardado", relayUrl: "ws://relay.test" });
/** Stored record with a DIFFERENT synthetic token AND host epk: genuinely
 *  unrelated, never touched by an explicit pair of `target()`. */
const UNRELATED_RECORD = storedRecord({
  name: "guardado",
  token: `${TOKEN}-outro`,
  hostEpk: Buffer.alloc(32, 9).toString("base64"),
});
/** Host epk de OUTRA identidade (Y), usada para simular um segundo adapter
 *  gravando no MESMO storage depois que este adapter já tem X em cache. */
const OTHER_EPK = Buffer.alloc(32, 11).toString("base64");
/** Y: o registro que outro contexto grava DEPOIS de X. Uma recusa de X nunca
 *  pode apagá-lo — é a observável do bug de cache velho. */
const REPLACEMENT_RECORD = storedRecord({
  name: "substituto",
  token: `${TOKEN}-y`,
  hostEpk: OTHER_EPK,
  relayUrl: "ws://relay.test",
});

let failures = 0;
const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(String(err)));

function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => sleep(0);
async function until(fn, ms = 3_000) {
  const started = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - started > ms) return false;
    await sleep(5);
  }
}
function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Keeps a rejected adapter call from becoming an unhandled rejection while
 *  still returning it for assertions. */
function rejection(promise) {
  return promise.then(
    () => null,
    (err) => err,
  );
}

/** In-memory `StorageLike` with failure switches and call counters. */
function memStore(initial = null) {
  const record = { raw: initial, get: 0, set: 0, remove: 0, failGet: false, failSet: false, failRemove: false, beforeGet: null };
  const store = {
    getItem() {
      record.get += 1;
      if (record.failGet) throw new Error("storage get boom");
      // Optional hook: lets a test land a REPLACEMENT between two reads.
      record.beforeGet?.();
      return record.raw;
    },
    setItem(_key, value) {
      record.set += 1;
      if (record.failSet) throw new Error("storage set boom");
      record.raw = value;
    },
    removeItem() {
      record.remove += 1;
      if (record.failRemove) throw new Error("storage remove boom");
      record.raw = null;
    },
  };
  return { store, record };
}

/** Serialized five-field record for the store. */
function storedRecord(overrides = {}) {
  return JSON.stringify({
    relayUrl: "ws://127.0.0.1:9999",
    hostEpk: HOST_EPK,
    name: "host",
    roomId: HOST_ROOM,
    token: TOKEN,
    ...overrides,
  });
}

/** Name of the record currently on disk, or `null` (absent/corrupt) — so a
 *  missing record fails an assertion with a label instead of throwing. */
function storedName(store) {
  const raw = store.getItem(SESSION_STORAGE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw).name;
  } catch {
    return null;
  }
}

/** Typed fake transport (the adapter's own documented seam). */
class FakeTransport {
  constructor(url, list) {
    this.url = url;
    this.calls = [];
    this.closed = false;
    this.connected = false;
    this.backend = "webcrypto";
    this.helloVersion = "fake-1";
    this.pairCode = null;
    this.failPairCode = null;
    this.failConnect = null;
    this.failHello = null;
    this.hold = null;
    this.holdList = null;
    this.holdFs = null;
    this.holdStart = null;
    this.notifyOnClose = false;
    this.helloExtra = null;
    this.diagnostics = [];
    this.workspaces = [];
    this.fsResult = { type: "fs_list_ok", path: "/x", parent: null, entries: [] };
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    this.diagnosticListeners = new Set();
    list.push(this);
  }

  async connect() {
    this.calls.push("connect");
    if (this.hold) await this.hold.promise;
    if (this.failConnect) throw this.failConnect;
    this.connected = true;
  }

  async pair(target) {
    this.calls.push("pair");
    this.pairTarget = target;
    if (this.pairCode) throw new PairRejectedError(this.pairCode);
    if (this.failPairCode) throw new PairRejectedError(this.failPairCode);
    return { type: "pair_ok", session_name: "host", session_started_at: 1, room_id: HOST_ROOM };
  }

  async helloHost(epk, room) {
    this.calls.push("helloHost");
    this.helloArgs = [epk, room];
    if (this.failHello) throw this.failHello;
    return {
      type: "host_hello_ok",
      daemon: { version: this.helloVersion, hostname: "fake-pi", platform: "linux" },
      capabilities: ["fs_nav"],
      ...(this.helloExtra ?? {}),
    };
  }

  async listWorkspaces(epk, room) {
    this.calls.push("listWorkspaces");
    this.listArgs = [epk, room];
    if (this.holdList) await this.holdList.promise;
    if (this.failList) throw this.failList;
    return { type: "workspace_list_ok", workspaces: this.workspaces.map((w) => ({ ...w })) };
  }

  async fsList(epk, path, options) {
    this.calls.push("fsList");
    this.fsArgs = [epk, path, options];
    if (this.holdFs) await this.holdFs.promise;
    return this.fsResult;
  }

  async startWorkspace(epk, cwd, room) {
    this.calls.push("startWorkspace");
    this.startArgs = [epk, cwd, room];
    if (this.holdStart) await this.holdStart.promise;
    return { type: "workspace_start_ok", cwd, room_id: "room-1", daemon_id: "d1" };
  }

  sendChat(epk, room, text) {
    this.calls.push("sendChat");
    this.chatArgs = [epk, room, text];
    return "mid-1";
  }

  onServerMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** OPTIONAL member of the structural seam (the real client has it). */
  onDiagnostic(listener) {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  close() {
    this.closed = true;
    if (this.notifyOnClose) this.drop();
  }

  /** Live subscription counts — proof that the adapter RELEASED its handles. */
  listenerCounts() {
    return {
      messages: this.messageListeners.size,
      closes: this.closeListeners.size,
      diagnostics: this.diagnosticListeners.size,
    };
  }

  // ── test hooks ─────────────────────────────────────────────────────────
  /** Unexpected relay drop of a LIVE connection. */
  drop() {
    this.connected = false;
    for (const listener of [...this.closeListeners]) listener("relay_dropped");
  }

  push(msg, room = HOST_ROOM) {
    for (const listener of [...this.messageListeners]) listener(msg, room);
  }

  diagnose(code) {
    for (const listener of [...this.diagnosticListeners]) listener(code);
  }
}

/** Fresh fake-transport factory + the transports it created, in order. */
function fakeWire(configure) {
  const list = [];
  const factory = (url) => {
    const transport = new FakeTransport(url, list);
    configure?.(transport, list.length - 1);
    return transport;
  };
  return { list, factory };
}

const adapters = [];
function track(adapter) {
  adapters.push(adapter);
  return adapter;
}
function disposeAll() {
  for (const adapter of adapters) {
    try {
      adapter.dispose();
    } catch {
      /* already disposed */
    }
  }
  adapters.length = 0;
}
function newAdapter(options) {
  return track(new RemotePiAdapter({ relayUrl: "ws://relay.test", storage: null, ...options }));
}
const target = (over = {}) => ({ token: TOKEN, hostEpk: HOST_EPK, name: "host", roomId: HOST_ROOM, ...over });

// ── 1. the fake-wire lifecycle matrix ───────────────────────────────────────

async function scenarioPairFlow() {
  console.log("\n== 1. pair(): fluxo, snapshot e persistência ==");
  const { store, record } = memStore();
  const wire = fakeWire();
  const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
  const phases = [];
  const off = adapter.subscribe((snapshot) => phases.push(snapshot.phase));
  check("subscribe entrega um snapshot imediato", phases.length === 1 && phases[0] === "idle", phases.join(","));

  const snapshot = await adapter.pair(target());
  const transport = wire.list[0];
  check(
    "ordem do fluxo: connect → pair → host_hello → workspace_list",
    transport.calls.join(",") === "connect,pair,helloHost,listWorkspaces",
    transport.calls.join(","),
  );
  check(
    "fases relay_authenticating → pairing → host_authenticating → connected",
    phases.slice(0, 5).join(",") === "idle,relay_authenticating,pairing,host_authenticating,connected",
    phases.join(","),
  );
  check("snapshot connected com host/workspaces/backend", snapshot.phase === "connected" && snapshot.host !== null && snapshot.backend === "webcrypto" && Array.isArray(snapshot.workspaces));
  check("geração/attempt visíveis", snapshot.generation === 1 && snapshot.attempt === 1, `gen=${snapshot.generation} attempt=${snapshot.attempt}`);
  check("paired = name + relay (sem token)", snapshot.paired?.name === "host" && snapshot.paired?.relayUrl === "ws://relay.test" && JSON.stringify(snapshot.paired).includes(TOKEN) === false);
  check("snapshot NÃO contém o token (JSON)", !JSON.stringify(snapshot).includes(TOKEN));
  check("pair_request foi para a room HOST", transport.pairTarget.roomId === HOST_ROOM && transport.helloArgs[1] === HOST_ROOM && transport.listArgs[1] === HOST_ROOM);
  check("gravou o registro de 5 campos SÓ no fim do fluxo", record.set === 1 && JSON.parse(store.getItem(SESSION_STORAGE_KEY)).token === TOKEN);
  check("relay inicial salvo normalizado (sem barra final)", JSON.parse(store.getItem(SESSION_STORAGE_KEY)).relayUrl === "ws://relay.test");

  // host room apenas: um alvo com outra room é recusado, sem socket.
  let roomRefused = null;
  try {
    await adapter.pair(target({ roomId: "outra" }));
  } catch (err) {
    roomRefused = err;
  }
  check("alvo fora da room HOST recusado (unsupported_room)", roomRefused instanceof PairRejectedError && roomRefused.code === "unsupported_room");
  let blankRefused = null;
  try {
    await adapter.pair(target({ token: "   " }));
  } catch (err) {
    blankRefused = err;
  }
  check("token em branco recusado pelo schema estrito", blankRefused instanceof SessionPersistenceError && blankRefused.code === "invalid_record");
  check("nenhum socket novo para os alvos inválidos", wire.list.length === 1);

  // subscribe/onServerMessage: unsubscribe para de notificar.
  off();
  const seen = [];
  const offMessages = adapter.onServerMessage((msg, room) => seen.push({ msg, room }));
  transport.push({ type: "agent_chunk", in_reply_to: "x", delta: "oi" }, "room-1");
  check("onServerMessage encaminha a push com a room", seen.length === 1 && seen[0].room === "room-1" && seen[0].msg.type === "agent_chunk");
  check("push de child NÃO altera a fase", adapter.getSnapshot().phase === "connected");
  offMessages();
  transport.push({ type: "agent_chunk" }, "room-1");
  check("unsubscribe de onServerMessage para o encaminhamento", seen.length === 1);
  adapter.dispose();
}

async function scenarioRestoreAndStorage() {
  console.log("\n== 2. restore(): sem entrada, corrompido, indisponível, falha de leitura ==");
  // sem entrada → idle, sem socket, sem falso sucesso.
  const empty = memStore(null);
  const wireA = fakeWire();
  const a = newAdapter({ storage: empty.store, transportFactory: wireA.factory, retry: SHORT_RETRY });
  const emptySnapshot = await a.restore();
  check("sem entrada → permanece idle", emptySnapshot.phase === "idle" && emptySnapshot.paired === null && emptySnapshot.warning === null);
  check("sem entrada → nenhum connect", wireA.list.length === 0);
  a.dispose();

  // registro corrompido → removido + warning fixo.
  const corrupt = memStore('{"relayUrl":"ws://r","hostEpk":"nope","name":"n","roomId":"host","token":"t"}');
  const wireB = fakeWire();
  const b = newAdapter({ storage: corrupt.store, transportFactory: wireB.factory, retry: SHORT_RETRY });
  const corruptSnapshot = await b.restore();
  check("registro corrompido → idle + warning invalid_record", corruptSnapshot.phase === "idle" && corruptSnapshot.warning?.code === "session_invalid", JSON.stringify(corruptSnapshot.warning));
  check("registro corrompido removido do storage", corrupt.record.remove === 1 && corrupt.store.getItem(SESSION_STORAGE_KEY) === null);
  check("warning tem texto fixo (sem eco)", corruptSnapshot.warning?.message === "The saved session is invalid and was discarded.");
  b.dispose();

  // falha de leitura → warning + idle (nunca sucesso falso).
  const broken = memStore(storedRecord());
  broken.record.failGet = true;
  const wireC = fakeWire();
  const c = newAdapter({ storage: broken.store, transportFactory: wireC.factory, retry: SHORT_RETRY });
  const brokenSnapshot = await c.restore();
  check("falha de leitura → warning storage_read_failed + idle", brokenSnapshot.phase === "idle" && brokenSnapshot.warning?.code === "session_unreadable");
  check("falha de leitura → nenhum socket", wireC.list.length === 0);
  c.dispose();

  // Storage indisponivel de verdade (getItem lança) → warning, sem exceção.
  const brokenAccess = memStore(storedRecord());
  brokenAccess.record.failGet = true;
  const wireD = fakeWire();
  const d = newAdapter({ storage: brokenAccess.store, transportFactory: wireD.factory, retry: SHORT_RETRY });
  const noBrowser = await d.restore();
  check(
    "storage que lança no acesso → warning storage_read_failed + idle",
    noBrowser.phase === "idle" && noBrowser.warning?.code === "session_unreadable" && wireD.list.length === 0,
    JSON.stringify(noBrowser.warning),
  );
  d.dispose();

  // Sem browser storage (undefined) e sem localStorage global → null, sem aviso.
  const wireD2 = fakeWire();
  const d2 = newAdapter({ storage: undefined, transportFactory: wireD2.factory, retry: SHORT_RETRY });
  const noStorage = await d2.restore();
  check("sem storage de navegador → idle, sem aviso e sem socket", noStorage.phase === "idle" && noStorage.warning === null && wireD2.list.length === 0);
  d2.dispose();

  // restore feliz: pareia de novo (pair PRIMEIRO) a partir do registro.
  const good = memStore(storedRecord({ relayUrl: "ws://stored.relay" }));
  wireD.list.length = 0;
  const wireE = fakeWire();
  const e = newAdapter({ storage: good.store, transportFactory: wireE.factory, retry: SHORT_RETRY });
  const restored = await e.restore();
  const rt = wireE.list[0];
  check(
    "restore pareia de novo: connect → pair → hello → list",
    rt.calls.join(",") === "connect,pair,helloHost,listWorkspaces" && rt.url === "ws://stored.relay",
    `${rt.calls.join(",")} url=${rt.url}`,
  );
  check("restore → connected com o registro salvo (sem reescrever)", restored.phase === "connected" && good.record.set === 0 && restored.paired?.relayUrl === "ws://stored.relay");
  check("restore usa o token do registro no pair_request", rt.pairTarget.token === TOKEN && rt.pairTarget.hostEpk === HOST_EPK);
  e.dispose();
}

async function scenarioWarningsAndTypedMethods() {
  console.log("\n== 3. gravação falha, storage nulo, métodos tipados ==");
  const failing = memStore();
  failing.record.failSet = true;
  const wire = fakeWire();
  const adapter = newAdapter({ storage: failing.store, transportFactory: wire.factory, retry: SHORT_RETRY });
  const snapshot = await adapter.pair(target());
  check("falha de escrita → conexão continua connected", snapshot.phase === "connected");
  check("falha de escrita → warning fixo storage_write_failed", snapshot.warning?.code === "session_unsaved" && !snapshot.warning.message.includes(TOKEN));

  const removed = memStore();
  removed.record.failRemove = true;
  const wireNull = fakeWire();
  const adapterNull = newAdapter({ storage: null, transportFactory: wireNull.factory, retry: SHORT_RETRY });
  const nullSnapshot = await adapterNull.pair(target());
  check("storage nulo → connected + warning storage_unavailable (não afirma salvo)", nullSnapshot.phase === "connected" && nullSnapshot.warning?.code === "session_unavailable");

  // métodos tipados exigem conexão viva.
  const idle = newAdapter({ storage: null, transportFactory: fakeWire().factory, retry: SHORT_RETRY });
  const idleRefused = await rejection(idle.pair(target({ token: "" })));
  check("alvo inválido não chega a conectar (schema estrito)", idleRefused !== null && idle.getSnapshot().phase === "idle");
  const methodRefused = await rejection(idle.fsList("/tmp"));
  check("método tipado fora de connected → AdapterStateError not_connected", methodRefused instanceof AdapterStateError && methodRefused.code === "not_connected");

  const workspaces = await adapter.refreshWorkspaces();
  check("refreshWorkspaces usa o epk vinculado e a room HOST", wire.list[0].listArgs[0] === HOST_EPK && wire.list[0].listArgs[1] === HOST_ROOM && Array.isArray(workspaces));
  const fs = await adapter.fsList("/tmp", { showHidden: true });
  check("fsList repassa path/showHidden na room HOST", fs.type === "fs_list_ok" && wire.list[0].fsArgs[1] === "/tmp" && wire.list[0].fsArgs[2].showHidden === true && wire.list[0].fsArgs[2].roomId === HOST_ROOM);
  const started = await adapter.startWorkspace("/proj");
  check("startWorkspace usa o epk do host", started.type === "workspace_start_ok" && wire.list[0].startArgs[0] === HOST_EPK);
  const chatId = adapter.sendChat("room-1", "olá");
  check("sendChat usa o epk do host e a room pedida", chatId === "mid-1" && wire.list[0].chatArgs[0] === HOST_EPK && wire.list[0].chatArgs[1] === "room-1");

  adapter.close();
  let closedRefused = null;
  try {
    adapter.sendChat("room-1", "depois do close");
  } catch (err) {
    closedRefused = err;
  }
  check("cliente antigo não executa comandos depois do close", closedRefused instanceof AdapterStateError && closedRefused.code === "closed");
  adapter.dispose();
}

async function scenarioTokenRejections() {
  console.log("\n== 4. token recusado / erro interno / falhas de handshake ==");
  for (const code of ["token_unknown", "token_expired", "token_consumed"]) {
    const { store, record } = memStore(storedRecord());
    const wire = fakeWire((transport) => {
      transport.pairCode = code;
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target());
    await sleep(40); // mais que o orçamento de retry: nada pode reconectar
    check(`pair_error ${code} → reauth_required com diagnóstico fixo`, snapshot.phase === "reauth_required" && snapshot.diagnostic?.code === "pair_rejected", snapshot.diagnostic?.code);
    check(`pair_error ${code} → credencial e catálogo limpos`, snapshot.paired === null && snapshot.host === null);
    check(
      `pair_error ${code} → pair EXPLÍCITO não apaga o registro intocado`,
      record.remove === 0 && storedName(store) === "host",
      `remove=${record.remove} stored=${storedName(store)}`,
    );
    check(`pair_error ${code} → sem retry automático`, wire.list.length === 1);
    adapter.dispose();
  }

  // internal_error: terminal, sem retry, registro preservado.
  const internal = memStore(storedRecord());
  const wireInternal = fakeWire((transport) => {
    transport.pairCode = "internal_error";
  });
  const adapterInternal = newAdapter({ storage: internal.store, transportFactory: wireInternal.factory, retry: SHORT_RETRY });
  const internalSnapshot = await adapterInternal.pair(target());
  await sleep(40);
  check("pair_error internal_error → fase error terminal", internalSnapshot.phase === "error" && internalSnapshot.diagnostic?.code === "pair_rejected");
  check("internal_error não apaga o registro nem reconecta", internal.store.getItem(SESSION_STORAGE_KEY) !== null && wireInternal.list.length === 1);
  check(
    "internal_error é ausência de sucesso → NÃO publica 'Stored pairing'",
    internalSnapshot.paired === null && internalSnapshot.host === null,
    JSON.stringify(internalSnapshot.paired),
  );
  adapterInternal.dispose();

  // falha de handshake / host: diagnóstico fixo, sem retry.
  const cases = [
    [new TransportError("connect_failed"), "relay_unreachable"],
    [new TransportError("auth_rejected"), "relay_auth_failed"],
    [new TransportError("connect_timeout"), "relay_unreachable"],
  ];
  for (const [err, expected] of cases) {
    const wire = fakeWire((transport) => {
      transport.failConnect = err;
    });
    const adapter = newAdapter({ storage: null, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target());
    check(`falha de handshake ${err.code} → ${expected} sem retry`, snapshot.phase === "error" && snapshot.diagnostic?.code === expected && wire.list.length === 1, snapshot.diagnostic?.code);
    adapter.dispose();
  }

  const wireHost = fakeWire((transport) => {
    transport.failHello = new TransportError("request_timeout");
  });
  const adapterHost = newAdapter({ storage: null, transportFactory: wireHost.factory, retry: SHORT_RETRY });
  const hostSnapshot = await adapterHost.pair(target());
  check("falha do host_hello → host_timeout terminal", hostSnapshot.phase === "error" && hostSnapshot.diagnostic?.code === "host_timeout");
  adapterHost.dispose();

  const wireAction = fakeWire((transport) => {
    transport.failList = new SessionPersistenceError("invalid_record");
  });
  const adapterAction = newAdapter({ storage: null, transportFactory: wireAction.factory, retry: SHORT_RETRY });
  const actionSnapshot = await adapterAction.pair(target());
  check("falha desconhecida na catalogação → unexpected sem vazar texto", actionSnapshot.phase === "error" && actionSnapshot.diagnostic?.code === "unexpected");
  check(
    "falha na catalogação → fase error sem publicar pairing",
    actionSnapshot.paired === null && actionSnapshot.host === null && actionSnapshot.workspaces === null,
    JSON.stringify(actionSnapshot.paired),
  );
  adapterAction.dispose();
}

/**
 * F2 (correction gate 1) — the launcher advertises a STORED pairing, so a
 * pairing that only was ATTEMPTED must never be published as stored: connect /
 * host / catalog failures used to leave the summary set from `startGeneration`,
 * showing a stored pairing while an explicit pair had written nothing. The
 * other side of the same rule: a restore/retry re-establishes an identity that
 * IS on disk, so its failure must PRESERVE both the summary and the record, and
 * only a refused identity (`token_*`) may clear disk. */
async function scenarioPairFailurePublication() {
  console.log("\n== 4b. falha de pair: 'Stored pairing' só quando é real ==");
  const REAL = storedRecord({ name: "guardado", relayUrl: "ws://127.0.0.1:9999" });

  // 1. Falha de CONNECT num pair explícito: nada é publicado, nada é tocado.
  {
    const { store, record } = memStore(REAL);
    const wire = fakeWire((transport) => {
      transport.failConnect = new TransportError("connect_failed");
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target({ name: "novo" }));
    check(
      "connect falho → fase error terminal",
      snapshot.phase === "error" && snapshot.diagnostic?.code === "relay_unreachable",
      snapshot.diagnostic?.code,
    );
    check(
      "connect falho num pair explícito → NÃO anuncia 'Stored pairing' do alvo",
      snapshot.paired === null,
      JSON.stringify(snapshot.paired),
    );
    check(
      "connect falho → registro real intacto (nenhuma escrita, nenhuma remoção)",
      record.set === 0 && record.remove === 0 && storedName(store) === "guardado",
      `set=${record.set} remove=${record.remove} stored=${storedName(store)}`,
    );
    adapter.dispose();
  }

  // 2. Falha de HOST hello / catálogo num pair explícito: mesma regra.
  for (const [label, configure, expected] of [
    ["host_hello", (transport) => { transport.failHello = new TransportError("request_timeout"); }, "host_timeout"],
    ["workspace_list", (transport) => { transport.failList = new Error("list boom"); }, "unexpected"],
  ]) {
    const { store, record } = memStore(REAL);
    const wire = fakeWire(configure);
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target({ name: "novo" }));
    check(
      `falha de ${label} → ${expected} terminal sem publicar pairing`,
      snapshot.phase === "error" && snapshot.diagnostic?.code === expected && snapshot.paired === null,
      `${snapshot.phase}/${snapshot.diagnostic?.code}/${JSON.stringify(snapshot.paired)}`,
    );
    check(
      `falha de ${label} → registro real intacto`,
      record.set === 0 && record.remove === 0 && storedName(store) === "guardado",
      `stored=${storedName(store)}`,
    );
    adapter.dispose();
  }

  // 3. Pair bem-sucedido continua publicando E gravando (o caso feliz não mudou).
  {
    const { store, record } = memStore(REAL);
    const wire = fakeWire();
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target({ name: "confirmado" }));
    check(
      "pair bem-sucedido publica o summary e grava o registro",
      snapshot.phase === "connected" && snapshot.paired?.name === "confirmado" && record.set === 1 && storedName(store) === "confirmado",
      `${snapshot.paired?.name}/set=${record.set}`,
    );
    check("pair bem-sucedido não tem aviso de persistência", snapshot.warning === null);
    adapter.dispose();
  }

  // 4. Escrita falha: a conexão fica viva e o summary publicado vem com o
  //    aviso fixo — o oposto de um falso "salvo".
  {
    const failing = memStore(null);
    failing.record.failSet = true;
    const wire = fakeWire();
    const adapter = newAdapter({ storage: failing.store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target({ name: "nao-salvo" }));
    check(
      "escrita falha → connected + warning unsaved (nunca um falso salvo)",
      snapshot.phase === "connected" && snapshot.warning?.code === "session_unsaved" && snapshot.paired?.name === "nao-salvo",
      `${snapshot.warning?.code}/${snapshot.paired?.name}`,
    );
    adapter.dispose();
  }

  // 5. RESTORE que falha: a identidade ESTÁ no disco, então ela continua
  //    anunciada junto com o registro — nunca um estado "sem pairing" falso.
  {
    const { store, record } = memStore(REAL);
    const wire = fakeWire((transport) => {
      transport.failConnect = new TransportError("connect_failed");
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.restore();
    check(
      "restore que falha no connect mantém o summary REAL do disco",
      snapshot.phase === "error" && snapshot.paired?.name === "guardado" && snapshot.paired?.relayUrl === "ws://127.0.0.1:9999",
      `${snapshot.phase}/${JSON.stringify(snapshot.paired)}`,
    );
    check(
      "restore falho não apaga nem reescreve o registro",
      record.set === 0 && record.remove === 0 && store.getItem(SESSION_STORAGE_KEY) !== null,
      `set=${record.set} remove=${record.remove}`,
    );
    adapter.dispose();
  }

  // 6. Orçamento de retry esgotado: o pairing vivo continua real (summary +
  //    registro), só a conexão terminou.
  {
    const { store, record } = memStore(null);
    const offline = { value: false };
    const wire = fakeWire((transport) => {
      if (offline.value) transport.failConnect = new TransportError("connect_failed");
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    await adapter.pair(target({ name: "vivo" }));
    check("pair inicial gravou o registro", record.set === 1);
    offline.value = true;
    wire.list[0].drop();
    const exhausted = await until(() => adapter.getSnapshot().phase === "error", 2_000);
    const snapshot = adapter.getSnapshot();
    check(
      "retry esgotado mantém o summary e o registro do pairing real",
      exhausted && snapshot.diagnostic?.code === "retry_exhausted" && snapshot.paired?.name === "vivo" && record.remove === 0 && storedName(store) === "vivo",
      `${snapshot.diagnostic?.code}/${snapshot.paired?.name}/remove=${record.remove}`,
    );
    adapter.dispose();
  }

  // 7. O caminho destrutivo continua existindo, mas só para uma identidade
  //    RECUSADA que este fluxo restabelecia do disco (restore), com auto-cura
  //    para o registro que um pair explícito recusado deixou para trás.
  {
    const { store, record } = memStore(REAL);
    const wire = fakeWire((transport) => {
      transport.pairCode = "token_unknown";
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.restore();
    check(
      "restore recusado (token) limpa o registro MORTO e o summary",
      snapshot.phase === "reauth_required" && snapshot.paired === null && record.remove === 1 && store.getItem(SESSION_STORAGE_KEY) === null,
      `${snapshot.phase}/remove=${record.remove}`,
    );
    adapter.dispose();
  }
  {
    const { store, record } = memStore(REAL);
    const wire = fakeWire((transport) => {
      transport.pairCode = "token_unknown";
    });
    const explicit = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const refused = await explicit.pair(target({ name: "colado" }));
    check(
      "pair explícito recusado → registro intocado preservado",
      refused.phase === "reauth_required" && refused.paired === null && record.remove === 0 && storedName(store) === "guardado",
      `phase=${refused.phase} remove=${record.remove} stored=${storedName(store)}`,
    );
    // Auto-cura: o próximo restore recusa o mesmo token e então o remove.
    const healer = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const healed = await healer.restore();
    check(
      "registro morto é removido no próximo restore (auto-cura)",
      healed.phase === "reauth_required" && store.getItem(SESSION_STORAGE_KEY) === null && record.remove === 1,
      `phase=${healed.phase} remove=${record.remove}`,
    );
    explicit.dispose();
    healer.dispose();
  }

  // 8. Retry que re-pareia durante o backoff e encontra o token MORTO: como em
  //    restore, esse registro É o do próprio fluxo (não um registro alheio),
  //    então ele é removido e nada fica "stored" enquanto não houver novo pair.
  {
    const { store, record } = memStore(null);
    const refuse = { value: false };
    const wire = fakeWire((transport) => {
      if (refuse.value) transport.pairCode = "token_expired";
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    await adapter.pair(target({ name: "cai" }));
    check("retry: o registro do pr\u00f3prio fluxo foi gravado", record.set === 1 && storedName(store) === "cai");
    refuse.value = true;
    wire.list[0].drop();
    const dead = await until(() => adapter.getSnapshot().phase === "reauth_required", 2_000);
    check(
      "retry com token morto \u2192 reauth_required e registro MORTO removido",
      dead && adapter.getSnapshot().paired === null && adapter.getSnapshot().storedPairing === null && record.remove === 1 && store.getItem(SESSION_STORAGE_KEY) === null,
      `phase=${adapter.getSnapshot().phase} remove=${record.remove}`,
    );
    adapter.dispose();
  }
}

/**
 * F2 residual (correction gate 2) — the launcher reads `storedPairing`, a
 * STORAGE claim, while `paired` stays the live runtime identity. The two are
 * only both present when a load or a CONFIRMED save backs the live pairing: an
 * initial explicit pair whose write failed stays live-only, and the retry that
 * follows a drop re-establishes a LIVE credential without inventing a stored
 * one. The refused-identity branch compares the FULL identity (hostEpk + room +
 * relay + token, name display-only) against the record storage holds RIGHT NOW
 * — freshly re-read and validated, never the in-memory cache, which is stale
 * once another context replaced the record — so
 * a same-identity paste of a dead record clears it while a genuinely unrelated
 * refusal preserves both disk and cache.
 */
async function scenarioStoredPairingTruthfulness() {
  console.log("\n== 4c. storedPairing: só o que o disco confirma ==");

  // 1. pair inicial SEM gravar + drop/reconexão: o retry NÃO inventa um
  //    'Stored pairing'. `paired` continua sendo a identidade viva.
  {
    const failing = memStore(null);
    failing.record.failSet = true;
    const wire = fakeWire();
    const adapter = newAdapter({ storage: failing.store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target({ name: "nao-salvo" }));
    check(
      "pair sem gravar → live `paired` mas NENHUM storedPairing",
      snapshot.phase === "connected" && snapshot.paired?.name === "nao-salvo" && snapshot.storedPairing === null && snapshot.warning?.code === "session_unsaved",
      `${JSON.stringify(snapshot.paired)}/${JSON.stringify(snapshot.storedPairing)}/${snapshot.warning?.code}`,
    );
    wire.list[0].drop();
    const back = await until(() => adapter.getSnapshot().phase === "connected", 2_000);
    const afterRetry = adapter.getSnapshot();
    check(
      "drop + retry de uma pair não gravada → storedPairing CONTINUA null",
      back && wire.list.length === 2 && afterRetry.storedPairing === null && afterRetry.paired?.name === "nao-salvo",
      `back=${back} transports=${wire.list.length} stored=${JSON.stringify(afterRetry.storedPairing)}`,
    );
    check("retry de uma pair não gravada NÃO tenta nova gravação", failing.record.set === 1 && failing.store.getItem(SESSION_STORAGE_KEY) === null, `set=${failing.record.set}`);
    check("nenhum token no snapshot durante o retry não-gravado", JSON.stringify(afterRetry).includes(TOKEN) === false);
    adapter.dispose();
  }

  // 2. um save CONFIRMADO publica o storedPairing — e o retry o mantém.
  {
    const { store, record } = memStore(null);
    const wire = fakeWire();
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const saved = await adapter.pair(target({ name: "salvo" }));
    check(
      "save confirmado → storedPairing publicado",
      saved.phase === "connected" && record.set === 1 && saved.storedPairing?.name === "salvo" && saved.storedPairing?.relayUrl === "ws://relay.test",
      `${JSON.stringify(saved.storedPairing)}/set=${record.set}`,
    );
    wire.list[0].drop();
    const back = await until(() => adapter.getSnapshot().phase === "connected", 2_000);
    const afterRetry = adapter.getSnapshot();
    check(
      "retry de uma pair GRAVADA mantém o storedPairing (sem reescrever)",
      back && afterRetry.storedPairing?.name === "salvo" && record.set === 1 && storedName(store) === "salvo",
      `${back}/${JSON.stringify(afterRetry.storedPairing)}/set=${record.set}`,
    );
    adapter.dispose();
  }

  // 3. restore que FALHA preserva o storedPairing (o registro ESTÁ no disco),
  //    e o dispose limpa o cache em memória enquanto o disco permanece.
  {
    const { store, record } = memStore(SAME_IDENTITY_RECORD);
    const wire = fakeWire((transport) => {
      transport.failConnect = new TransportError("connect_failed");
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.restore();
    check(
      "restore que falha PRESERVA storedPairing + record",
      snapshot.phase === "error" && snapshot.storedPairing?.name === "guardado" && snapshot.paired?.name === "guardado" && record.remove === 0 && record.set === 0,
      `${snapshot.phase}/${JSON.stringify(snapshot.storedPairing)}/remove=${record.remove}`,
    );
    adapter.dispose();
    check("dispose limpa o cache em memória e preserva o disco", adapter.getSnapshot().storedPairing === null && store.getItem(SESSION_STORAGE_KEY) !== null);
    const wire2 = fakeWire();
    const next = newAdapter({ storage: store, transportFactory: wire2.factory, retry: SHORT_RETRY });
    const restored = await next.restore();
    check("novo adapter restaura do disco (cache em memória não é estado)", restored.storedPairing?.name === "guardado" && restored.phase === "connected");
    next.dispose();
  }

  // 4. identidade DIFERENTE (outro token + outro hostEpk, MESMO nome): a
  //    recusa explícita preserva o disco E o storedPairing carregado do disco —
  //    não é o registro do próprio fluxo. O mount carrega o registro com um
  //    `restore()` bem-sucedido; só então o pair explícito é recusado.
  {
    const { store, record } = memStore(UNRELATED_RECORD);
    const refuse = { value: false };
    const wire = fakeWire((transport) => {
      if (refuse.value) transport.pairCode = "token_unknown";
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const restored = await adapter.restore();
    check(
      "restore carrega o storedPairing do disco antes do pair estranho",
      restored.phase === "connected" && restored.storedPairing?.name === "guardado",
      `${restored.phase}/${JSON.stringify(restored.storedPairing)}`,
    );
    refuse.value = true;
    const refused = await adapter.pair(target({ name: "guardado" })); // MESMO nome, outra identidade
    check(
      "recusa de identidade DIFERENTE (token+epk, mesmo nome) → storedPairing e disco preservados",
      refused.phase === "reauth_required" && refused.storedPairing?.name === "guardado" && refused.storedPairing?.relayUrl === "ws://127.0.0.1:9999" && record.remove === 0 && storedName(store) === "guardado",
      `${refused.phase}/${JSON.stringify(refused.storedPairing)}/remove=${record.remove}`,
    );
    // A cerca de gate 1 para a identidade VIVA permanece: só um pair explícito
    // PUBLICADO ou uma recusa que é o próprio registro a mexem. `paired` aqui
    // continua a identidade viva anterior — usar `storedPairing` é o que impede
    // a launcher de anunciar isso como "Stored pairing".
    check(
      "identidade viva anterior intacta na recusa (fence de gate 1)",
      refused.paired?.relayUrl === "ws://127.0.0.1:9999" && refused.paired?.name === "guardado",
      JSON.stringify(refused.paired),
    );
    adapter.dispose();
  }

  // 4b. nome diferente NÃO torna a identidade estranha: mesmo hostEpk/room/
  //     relay/token = o registro é o do próprio fluxo → removido.

  {
    const { store, record } = memStore(SAME_IDENTITY_RECORD); // name "guardado", token = TOKEN, relay = default
    const wire = fakeWire((transport) => {
      transport.pairCode = "token_expired";
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const refused = await adapter.pair(target({ name: "colado" }));
    check(
      "recusa da MESMA identidade (só o nome muda) → record morre e storedPairing limpa",
      refused.phase === "reauth_required" && refused.storedPairing === null && record.remove === 1 && store.getItem(SESSION_STORAGE_KEY) === null,
      `${refused.phase}/remove=${record.remove}/stored=${JSON.stringify(refused.storedPairing)}`,
    );
    adapter.dispose();
  }

  // 4c. recusa da MESMA identidade com a remoção falhando: aviso fixo
  //     session_not_cleared, mas o cache em memória já está limpo.
  {
    const broken = memStore(SAME_IDENTITY_RECORD);
    broken.record.failRemove = true;
    const wire = fakeWire((transport) => {
      transport.pairCode = "token_consumed";
    });
    const adapter = newAdapter({ storage: broken.store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const refused = await adapter.pair(target({ name: "colado" }));
    check(
      "remoção falha → warning fixo session_not_cleared e summary em memória limpo",
      refused.phase === "reauth_required" && refused.storedPairing === null && refused.warning?.code === "session_not_cleared" && broken.store.getItem(SESSION_STORAGE_KEY) !== null,
      `${refused.phase}/${refused.warning?.code}/${JSON.stringify(refused.storedPairing)}`,
    );
    adapter.dispose();
  }

  // 4d. O cache em memória NÃO é o disco: um adapter que validou X (restore
  //     bem-sucedido, cache X) e depois encontra Y gravado no MESMO storage por
  //     outro contexto. Recusar X é recusar uma identidade que o disco JÁ NÃO
  //     guarda — Y fica byte-idêntico e o summary passa a Y.
  {
    const { store, record } = memStore(SAME_IDENTITY_RECORD);
    const refuse = { value: false };
    const wireA = fakeWire((transport) => {
      if (refuse.value) transport.pairCode = "token_expired";
    });
    const adapterA = newAdapter({ storage: store, transportFactory: wireA.factory, retry: SHORT_RETRY });
    const restored = await adapterA.restore();
    check(
      "A valida X do disco e cacheia X antes do pair estranho",
      restored.phase === "connected" && restored.storedPairing?.name === "guardado" && store.getItem(SESSION_STORAGE_KEY) !== null,
      `${restored.phase}/${JSON.stringify(restored.storedPairing)}`,
    );
    // B: outro adapter, MESMO storage — grava Y (identidade diferente).
    const wireB = fakeWire();
    const adapterB = newAdapter({ storage: store, transportFactory: wireB.factory, retry: SHORT_RETRY });
    const written = await adapterB.pair(target({ name: "substituto", token: `${TOKEN}-y`, hostEpk: OTHER_EPK }));
    const yRaw = store.getItem(SESSION_STORAGE_KEY);
    check(
      "B grava Y no MESMO storage (identidade diferente de X)",
      written.phase === "connected" && yRaw !== null && JSON.parse(yRaw).name === "substituto" && yRaw !== SAME_IDENTITY_RECORD,
      `${written.phase}/${JSON.parse(yRaw ?? "null")?.name}`,
    );
    // A recusa X (token_expired) com o cache ainda em X.
    refuse.value = true;
    const refusedA = await adapterA.pair(target({ name: "colado" }));
    check(
      "recusa de X com Y no disco → Y sobrevive byte-idêntico (nenhuma remoção)",
      refusedA.phase === "reauth_required" && record.remove === 0 && store.getItem(SESSION_STORAGE_KEY) === yRaw,
      `${refusedA.phase}/remove=${record.remove}/sameBytes=${store.getItem(SESSION_STORAGE_KEY) === yRaw}`,
    );
    check(
      "recusa de X → summary em memória atualizado para Y (disco é a fonte)",
      refusedA.storedPairing?.name === "substituto" && refusedA.storedPairing?.relayUrl === "ws://relay.test",
      JSON.stringify(refusedA.storedPairing),
    );
    check("nenhum token no snapshot da recusa de X", JSON.stringify(refusedA).includes(TOKEN) === false);
    adapterA.dispose();
    adapterB.dispose();
  }

  // 4e. Falha de LEITURA do storage durante a classificação: nada é comparado
  //     e NADA é apagado — sem leitura confiável não existe decisão destrutiva.
  {
    const { store, record } = memStore(SAME_IDENTITY_RECORD);
    const refuse = { value: false };
    const wire = fakeWire((transport) => {
      if (refuse.value) transport.pairCode = "token_expired";
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const restored = await adapter.restore();
    check("4e: A valida X antes de o storage ficar ilegível", restored.phase === "connected" && restored.storedPairing?.name === "guardado");
    const warningBefore = adapter.getSnapshot().warning;
    refuse.value = true;
    record.failGet = true;
    const refused = await adapter.pair(target({ name: "colado" }));
    check(
      "leitura falha → nenhuma remoção e registro intacto",
      refused.phase === "reauth_required" && record.remove === 0 && record.raw === SAME_IDENTITY_RECORD,
      `${refused.phase}/remove=${record.remove}`,
    );
    check(
      "leitura falha → warning pré-existente preservado (nenhum aviso novo inventado)",
      JSON.stringify(refused.warning) === JSON.stringify(warningBefore ?? null),
      `${refused.warning?.code}`,
    );
    adapter.dispose();
  }

  // 4f. Mutação INJETADA entre as duas leituras (substituição por outro
  //     contexto entre a classificação e a remoção): o registro que substituiu
  //     o recusado NÃO é removido. Não é CAS entre processos — só estreita a
  //     janela do localStorage sem transação.
  {
    const { store, record } = memStore(SAME_IDENTITY_RECORD);
    const wire = fakeWire((transport) => {
      transport.pairCode = "token_consumed";
    });
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    let reads = 0;
    record.beforeGet = () => {
      reads += 1;
      // A 1a leitura (classificação) precisa ver X; qualquer leitura seguinte
      // encontra o disco já substituído por Y — a janela entre classificar e
      // remover, onde outro contexto grava.
      if (reads > 1 && record.raw === SAME_IDENTITY_RECORD) record.raw = REPLACEMENT_RECORD;
    };
    const refused = await adapter.pair(target({ name: "colado" }));
    check(
      "substituição entre as duas leituras → o substituto sobrevive",
      refused.phase === "reauth_required" && record.remove === 0 && store.getItem(SESSION_STORAGE_KEY) === REPLACEMENT_RECORD,
      `${refused.phase}/remove=${record.remove}/reads=${reads}`,
    );
    check(
      "substituição entre as leituras → summary em memória vira o substituto",
      refused.storedPairing?.name === "substituto",
      JSON.stringify(refused.storedPairing),
    );
    record.beforeGet = null;
    adapter.dispose();
  }

  // 5. durabilidade: um pair novo bem-sucedido SUBSTITUI o summary antigo.
  {
    const { store, record } = memStore(UNRELATED_RECORD);
    const wire = fakeWire();
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    const snapshot = await adapter.pair(target({ name: "substituto" }));
    check(
      "pair bem-sucedido substitui o storedPairing antigo",
      snapshot.storedPairing?.name === "substituto" && snapshot.paired?.name === "substituto" && record.set === 1 && storedName(store) === "substituto",
      `${JSON.stringify(snapshot.storedPairing)}/set=${record.set}`,
    );
    adapter.dispose();
  }

  // 6. close limpa o storedPairing junto com o vivo.
  {
    const { store } = memStore(SAME_IDENTITY_RECORD);
    const wire = fakeWire();
    const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
    await adapter.pair(target({ name: "vivo" }));
    adapter.close();
    const closed = adapter.getSnapshot();
    check(
      "close limpa storedPairing e o disco",
      closed.phase === "closed" && closed.storedPairing === null && closed.paired === null && store.getItem(SESSION_STORAGE_KEY) === null,
      `${closed.phase}/${JSON.stringify(closed.storedPairing)}`,
    );
    adapter.dispose();
  }

  // 8. os fixtures de substituição desta seção são de fato de outra
  //    identidade (proveniência das asserções 4d/4f).
  check(
    "fixtures de substituição: Y difere de X em token e hostEpk",
    JSON.parse(REPLACEMENT_RECORD).token !== TOKEN && JSON.parse(REPLACEMENT_RECORD).hostEpk === OTHER_EPK && OTHER_EPK !== HOST_EPK,
    `${JSON.parse(REPLACEMENT_RECORD).hostEpk === OTHER_EPK}`,
  );
  // 7. os fixtures são de fato distintos (proveniência das asserções acima).
  check(
    "fixtures F2: mesma identidade (só o nome muda) vs. identidade estranha",
    JSON.parse(SAME_IDENTITY_RECORD).token === TOKEN && JSON.parse(SAME_IDENTITY_RECORD).hostEpk === HOST_EPK && JSON.parse(SAME_IDENTITY_RECORD).relayUrl === "ws://relay.test" && JSON.parse(UNRELATED_RECORD).hostEpk !== JSON.parse(SAME_IDENTITY_RECORD).hostEpk && JSON.parse(UNRELATED_RECORD).token !== TOKEN,
    `${JSON.parse(UNRELATED_RECORD).hostEpk === HOST_EPK}`,
  );
}

async function scenarioDropRetry() {
  console.log("\n== 5. drop inesperado: backoff finito, fluxo novo, orçamento ==");
  const { store, record } = memStore();
  // Every transport created AFTER the flag flips fails its handshake.
  const offline = { value: false };
  const wire = fakeWire((transport) => {
    if (offline.value) transport.failConnect = new TransportError("connect_failed");
  });
  const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
  await adapter.pair(target());
  check("conexão inicial gravou uma vez", record.set === 1);

  // Child push (host_message proxy) não derruba nem reconecta.
  const seen = [];
  const off = adapter.onServerMessage((msg, room) => seen.push({ msg, room }));
  wire.list[0].push({ type: "agent_chunk", delta: "x" }, "room-1");
  check("push de child não altera a fase nem reconecta", adapter.getSnapshot().phase === "connected" && wire.list.length === 1 && seen.length === 1);
  off();

  // A listener registered BEFORE the drop must keep receiving after the retry.
  const stable = [];
  const offStable = adapter.onServerMessage((_msg, room) => stable.push(room));
  wire.list[0].drop();
  check("drop logo vira reconnecting (attempt visível)", adapter.getSnapshot().phase === "reconnecting" && adapter.getSnapshot().attempt === 2, `phase=${adapter.getSnapshot().phase} attempt=${adapter.getSnapshot().attempt}`);
  const reconnected = await until(() => adapter.getSnapshot().phase === "connected", 2_000);
  check("retry reconectou", reconnected);
  check("retry fez o FLUXO COMPLETO de novo", wire.list.length === 2 && wire.list[1].calls.join(",") === "connect,pair,helloHost,listWorkspaces", wire.list[1]?.calls.join(","));
  check("retry NÃO reescreveu o storage", record.set === 1);
  check("retry não repetiu chat/RPC (sem replay)", wire.list[1].calls.includes("sendChat") === false);
  wire.list[1].push({ type: "agent_chunk", delta: "depois" }, "room-9");
  check("onServerMessage sobrevive à reconexão (forward estável)", stable.includes("room-9"), stable.join(","));
  offStable();

  // Orçamento reiniciado no sucesso: um 2º drop volta a reconectar.
  wire.list[1].drop();
  const reconnectedAgain = await until(() => adapter.getSnapshot().phase === "connected", 2_000);
  check("sucesso reinicia o orçamento (2º drop reconecta)", reconnectedAgain && wire.list.length === 3);

  // Exaustão: cada tentativa falha no handshake.
  offline.value = true;
  wire.list[2].drop();
  const exhausted = await until(() => adapter.getSnapshot().phase === "error", 2_000);
  check("orçamento esgotado → fase error", exhausted);
  check("diagnóstico fixo retry_exhausted", adapter.getSnapshot().diagnostic?.code === "retry_exhausted");
  check("tentativas limitadas a maxRetries (1 conectado + 3 drops/retries)", wire.list.length === 1 + 1 + 1 + 2, `transports=${wire.list.length}`);
  adapter.dispose();
}

async function scenarioSupersedeAndClose() {
  console.log("\n== 6. nova pair / close durante await / dispose ==");
  // Nova pair supersede o fluxo antigo.
  const { store, record } = memStore();
  const held = gate();
  const wire = fakeWire((transport, index) => {
    if (index === 0) {
      transport.hold = held; // apenas o PRIMEIRO fluxo trava
      transport.helloVersion = "antigo-1";
    }
  });
  const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
  const first = wire.factory;
  wire.factory = (url) => {
    const t = new FakeTransport(url, wire.list);
    if (wire.list.length === 1) t.hold = held;
    return t;
  };
  void first;
  const slowPair = adapter.pair(target({ name: "antigo" }));
  await tick();
  check("fluxo antigo em relay_authenticating", adapter.getSnapshot().phase === "relay_authenticating" && wire.list.length === 1);
  const fast = await adapter.pair(target({ name: "novo" }));
  check("nova pair conecta (supersede a antiga)", fast.phase === "connected" && fast.paired?.name === "novo" && wire.list.length === 2);
  check("geração avança por fluxo (guard separado do sequence)", fast.generation === 2, `gen=${fast.generation}`);
  check("socket antigo foi fechado", wire.list[0].closed === true);
  held.resolve();
  await tick();
  await tick();
  check("continuação tardia do fluxo antigo não publica", adapter.getSnapshot().phase === "connected" && adapter.getSnapshot().paired?.name === "novo");
  check("geração não muda por continuação tardia", adapter.getSnapshot().generation === 2);
  check("host/workspaces do fluxo antigo não sobrescrevem o novo", adapter.getSnapshot().host?.daemon.version === "fake-1");
  check("nem grava: só a pair nova escreveu", record.set === 1 && JSON.parse(store.getItem(SESSION_STORAGE_KEY)).name === "novo");
  await slowPair;

  // close durante o await: nada abre, nada grava, nada reconecta.
  const held2 = gate();
  const wire2 = fakeWire((transport) => {
    transport.hold = held2;
  });
  const adapter2 = newAdapter({ storage: store, transportFactory: wire2.factory, retry: SHORT_RETRY });
  const pendingPair = adapter2.pair(target());
  await tick();
  const writesBefore = record.set;
  adapter2.close();
  check("close durante o await → closing→closed", adapter2.getSnapshot().phase === "closed");
  held2.resolve();
  await pendingPair;
  await sleep(40);
  check("close durante o await: sem socket novo", wire2.list.length === 1 && wire2.list[0].closed === true);
  check("close durante o await: sem escrita tardia", record.set === writesBefore);

  // dispose durante o pair em voo: nenhuma abertura/escrita tardia.
  const held3 = gate();
  const wire2b = fakeWire((transport) => {
    transport.hold = held3;
  });
  const adapter2b = newAdapter({ storage: store, transportFactory: wire2b.factory, retry: SHORT_RETRY });
  const pendingPair2 = adapter2b.pair(target({ name: "descartado" }));
  await tick();
  const writesBefore2 = record.set;
  adapter2b.dispose();
  held3.resolve();
  await pendingPair2;
  await sleep(40);
  check("dispose durante o pair: sem escrita tardia nem socket vivo", record.set === writesBefore2 && wire2b.list.length === 1 && wire2b.list[0].closed === true);

  // close durante o delay do backoff: nenhum reconnect.
  const wire3 = fakeWire();
  const adapter3 = newAdapter({ storage: null, transportFactory: wire3.factory, retry: { maxRetries: 3, baseDelayMs: 60, maxDelayMs: 60 } });
  await adapter3.pair(target());
  wire3.list[0].drop();
  check("backoff em curso (reconnecting)", adapter3.getSnapshot().phase === "reconnecting");
  adapter3.close();
  await sleep(150);
  check("close no delay cancela o retry (nenhum socket novo)", wire3.list.length === 1 && adapter3.getSnapshot().phase === "closed");

  // dispose durante o delay do backoff: também cancela.
  const wire3b = fakeWire();
  const adapter3b = newAdapter({ storage: null, transportFactory: wire3b.factory, retry: { maxRetries: 3, baseDelayMs: 60, maxDelayMs: 60 } });
  await adapter3b.pair(target());
  wire3b.list[0].drop();
  adapter3b.dispose();
  await sleep(150);
  check("dispose no delay cancela o retry (nenhum socket novo)", wire3b.list.length === 1 && adapter3b.getSnapshot().phase === "closed");
  const closedAgain = await rejection(adapter3.pair(target()));
  check("close é terminal para novas pairs", closedAgain instanceof AdapterStateError && closedAgain.code === "closed");

  // close limpa o store; falha de remoção vira warning fixo.
  const rmFail = memStore(storedRecord());
  rmFail.record.failRemove = true;
  const wire4 = fakeWire();
  const adapter4 = newAdapter({ storage: rmFail.store, transportFactory: wire4.factory, retry: SHORT_RETRY });
  adapter4.close();
  check("close com falha de remoção → warning storage_remove_failed", adapter4.getSnapshot().phase === "closed" && adapter4.getSnapshot().warning?.code === "session_not_cleared");

  // dispose preserva o registro de 5 campos e para as notificações.
  const preserve = memStore();
  const wire5 = fakeWire();
  const adapter5 = newAdapter({ storage: preserve.store, transportFactory: wire5.factory, retry: SHORT_RETRY });
  await adapter5.pair(target());
  const notifications = [];
  const off5 = adapter5.subscribe((s) => notifications.push(s.phase));
  const countBefore = notifications.length;
  adapter5.dispose();
  check("dispose → terminal para a instância", adapter5.getSnapshot().phase === "closed" && wire5.list[0].closed === true);
  const disposedRefused = await rejection(adapter5.restore());
  check("dispose → chamadas recusadas com disposed", disposedRefused instanceof AdapterStateError && disposedRefused.code === "disposed");
  off5();
  check("dispose não notifica mais listeners", notifications.length === countBefore);
  check("dispose preserva o pairing gravado (5 campos intactos)", preserve.record.remove === 0 && JSON.parse(preserve.store.getItem(SESSION_STORAGE_KEY)).name === "host");

  // e um adapter novo restaura o que sobreviveu ao dispose.
  const wire6 = fakeWire();
  const adapter6 = newAdapter({ storage: preserve.store, transportFactory: wire6.factory, retry: SHORT_RETRY });
  const restored = await adapter6.restore();
  check("adapter novo (ReactStrictMode) restaura o registro preservado", restored.phase === "connected" && wire6.list[0].calls.join(",") === "connect,pair,helloHost,listWorkspaces");
  adapter6.dispose();

  adapter.dispose();
  adapter2.dispose();
  adapter2b.dispose();
  adapter3.dispose();
  adapter3b.dispose();
  adapter4.dispose();
  adapter5.dispose();
}

// ── 6b. the confirmed controller boundaries (Wave 2 #7) ───────────────────────

/** A catalog entry carrying an untrusted extra key — proves the projection
 *  drops it (the snapshot is field-by-field, never a spread). */
const CANARY_ENTRY = (over = {}) => ({
  cwd: "/w",
  daemon_id: "d1",
  room_id: "host",
  name: "w",
  live: true,
  daemon: true,
  source: "daemon",
  privateKey: TOKEN,
  ...over,
});

async function scenarioNewPairWhileConnected() {
  console.log("\n== 7b. nova pair com conexão viva, projeção e supersede = " .trim());

  // 1. Uma pair nova em cima de `connected` abre uma SEQUÊNCIA nova na hora.
  const { store } = memStore();
  const held = gate();
  const wire = fakeWire((transport, index) => {
    if (index === 1) transport.hold = held; // a SEGUNDA pair (perdedora) trava
  });
  const adapter = newAdapter({ storage: store, transportFactory: wire.factory, retry: SHORT_RETRY });
  await adapter.pair(target({ name: "primeiro" }));
  check("1a. conectado como 'primeiro'", adapter.getSnapshot().phase === "connected" && adapter.getSnapshot().generation === 1);

  const phases = [];
  const off = adapter.subscribe((s) => phases.push(s.phase));
  const repair = adapter.pair(target({ name: "segundo" }));
  await tick();
  check(
    "1b. pair em cima de connected → relay_authenticating imediato (nova sequência)",
    adapter.getSnapshot().phase === "relay_authenticating",
    adapter.getSnapshot().phase,
  );
  check("1c. generation++ e attempt fresco (1), não herda o orçamento", adapter.getSnapshot().generation === 2 && adapter.getSnapshot().attempt === 1, `gen=${adapter.getSnapshot().generation} attempt=${adapter.getSnapshot().attempt}`);
  check("1d. snapshot NÃO aponta host antigo (host=null)", adapter.getSnapshot().host === null && adapter.getSnapshot().workspaces === null);

  // Durante a nova pair, os métodos de Wave 3 recusam (not_connected).
  const during = await rejection(adapter.refreshWorkspaces());
  const duringChat = (() => {
    try {
      adapter.sendChat("room-1", "x");
      return null;
    } catch (err) {
      return err;
    }
  })();
  check("1e. durante a nova pair as operações são not_connected", during instanceof AdapterStateError && during.code === "not_connected" && duringChat?.code === "not_connected", `${during?.code}/${duringChat?.code}`);

  // Supersede: uma 3ª pair toma o lugar antes de a 2ª terminar.
  const third = adapter.pair(target({ name: "terceiro" }));
  const thirdSnapshot = await third;
  check("1f. 3ª pair abre nova sequência (gen 3) e conecta", thirdSnapshot.phase === "connected" && thirdSnapshot.paired?.name === "terceiro" && adapter.getSnapshot().generation === 3, `gen=${adapter.getSnapshot().generation}`);
  held.resolve();
  const secondSnapshot = await repair;
  await tick();
  check(
    "1g. a pair superseded devolve o snapshot ATUAL, sem republicar a fase velha",
    secondSnapshot.phase === "connected" && secondSnapshot.paired?.name === "terceiro" && adapter.getSnapshot().phase === "connected" && adapter.getSnapshot().paired?.name === "terceiro",
    `${secondSnapshot.phase}/${secondSnapshot.paired?.name}`,
  );
  check("1h. socket da sequência perdedora fechado; vencedor vivo", wire.list[1].closed === true && wire.list[2].closed === false, `secondClosed=${wire.list[1].closed}`);
  check("1i. nenhuma fase 'segundo' publicada depois do supersede", phases.includes("connected") && JSON.stringify(adapter.getSnapshot().paired).includes("segundo") === false);
  off();
  phases.length = 0;
  adapter.dispose();

  // 2. Projeção de campos: canary de host/token NÃO aparece no snapshot.
  const wire2 = fakeWire((transport) => {
    transport.helloExtra = { token: TOKEN, privateKey: TOKEN };
    transport.workspaces = [CANARY_ENTRY()];
  });
  const adapter2 = newAdapter({ storage: null, transportFactory: wire2.factory, retry: SHORT_RETRY });
  await adapter2.pair(target());
  const projected = adapter2.getSnapshot();
  check(
    "2a. host hello projetado (3 chaves), canary `token`/`privateKey` não vaza",
    Object.keys(projected.host).sort().join(",") === "capabilities,daemon,type" && projected.host.token === undefined && projected.host.privateKey === undefined && JSON.stringify(projected).includes(TOKEN) === false,
    Object.keys(projected.host).join(","),
  );
  check("2b. daemon/capabilities deep-copied (não compartilha referência)", projected.host.daemon !== adapter2.getSnapshot().host.daemon);
  check(
    "2c. workspace entry projetada sem `privateKey`",
    Object.keys(projected.workspaces[0]).sort().join(",") === "cwd,daemon,daemon_id,live,name,room_id,source" && projected.workspaces[0].privateKey === undefined && !JSON.stringify(projected).includes(TOKEN),
    Object.keys(projected.workspaces[0]).join(","),
  );
  // Mutar o snapshot não muda o estado interno.
  projected.workspaces[0].name = "MUTADO";
  projected.host.capabilities.push("MUTADO");
  projected.paired.name = "MUTADO";
  const after = adapter2.getSnapshot();
  check(
    "2d. mutação externa do snapshot não altera o interno",
    after.workspaces[0].name === "w" && after.host.capabilities.join(",") === "fs_nav" && after.paired.name !== "MUTADO",
    `${after.workspaces[0].name}/${after.host.capabilities.join(",")}`,
  );
  adapter2.dispose();

  // 3. Supersede das operações Wave 3 (refresh/fs/start) + notificação tardia.
  const heldList = gate();
  const wire3 = fakeWire((transport, index) => {
    if (index === 0) transport.workspaces = [CANARY_ENTRY({ name: "stale", cwd: "/stale" })];
    else transport.workspaces = [CANARY_ENTRY({ name: "novo", cwd: "/novo" })];
  });
  const adapter3 = newAdapter({ storage: null, transportFactory: wire3.factory, retry: SHORT_RETRY });
  await adapter3.pair(target());
  // Só o refresh subsequente trava: o fluxo inicial já terminou.
  wire3.list[0].holdList = heldList;
  const staleRefresh = rejection(adapter3.refreshWorkspaces());
  await tick();
  await adapter3.pair(target({ name: "novo" }));
  heldList.resolve();
  await tick();
  const staleErr = await staleRefresh;
  check("3a. refresh superseded recusado com AdapterStateError('superseded')", staleErr instanceof AdapterStateError && staleErr.code === "superseded", staleErr?.code);
  check("3b. catálogo antigo '/stale' NÃO sobrescreve o novo catalog", adapter3.getSnapshot().workspaces.every((w) => w.cwd !== "/stale"), JSON.stringify(adapter3.getSnapshot().workspaces.map((w) => w.cwd)));
  await tick();
  await tick();
  check("3c. após a resolução tardia o catálogo continua o novo", adapter3.getSnapshot().workspaces.every((w) => w.name !== "stale"), JSON.stringify(adapter3.getSnapshot().workspaces.map((w) => w.name)));
  adapter3.dispose();

  // fs/start superseded pelo drop (não mais connected).
  const heldFs = gate();
  const heldStart = gate();
  const wire4 = fakeWire();
  const adapter4 = newAdapter({ storage: null, transportFactory: wire4.factory, retry: SHORT_RETRY });
  await adapter4.pair(target());
  wire4.list[0].holdFs = heldFs;
  wire4.list[0].holdStart = heldStart;
  const pendingFs = rejection(adapter4.fsList("/tmp"));
  const pendingStart = rejection(adapter4.startWorkspace("/w"));
  await tick();
  wire4.list[0].drop();
  heldFs.resolve();
  const fsErr = await pendingFs;
  heldStart.resolve();
  const startErr = await pendingStart;
  check("3d. fsList/startWorkspace após drop → superseded (não devolvem dado velho)", fsErr instanceof AdapterStateError && fsErr.code === "superseded" && startErr instanceof AdapterStateError && startErr.code === "superseded", `${fsErr?.code}/${startErr?.code}`);
  adapter4.dispose();
}

async function scenarioUnsubscribeAndFlowOwnership() {
  console.log("\n== 7c. unsubscribe, retry ownership e notify-close = " .trim());

  // 4. attachTransport registra; closeTransport libera tudo ANTES do close.
  const wire = fakeWire();
  const adapter = newAdapter({ storage: null, transportFactory: wire.factory, retry: SHORT_RETRY });
  await adapter.pair(target());
  const transportA = wire.list[0];
  check("4a. transporte vivo com exatamente 1 assinatura de cada tipo", JSON.stringify(transportA.listenerCounts()) === JSON.stringify({ messages: 1, closes: 1, diagnostics: 1 }), JSON.stringify(transportA.listenerCounts()));
  const codes = [];
  const offDiag = adapter.onDiagnostic((code) => codes.push(code));
  transportA.diagnose("malformed_frame");
  check("4b. onDiagnostic encaminha o código fixo (sem payload)", codes.join(",") === "malformed_frame", codes.join(","));
  offDiag();
  transportA.diagnose("late_reply");
  check("4c. unsubscribe do onDiagnostic para o encaminhamento", codes.join(",") === "malformed_frame");

  // nova pair: handles do transporte ANTIGO voltam a zero.
  await adapter.pair(target({ name: "novo" }));
  check("4d. closeTransport libera as assinaturas do transporte antigo (counts 0)", JSON.stringify(transportA.listenerCounts()) === JSON.stringify({ messages: 0, closes: 0, diagnostics: 0 }), JSON.stringify(transportA.listenerCounts()));
  check("4e. transporte antigo foi fechado", transportA.closed === true);
  adapter.dispose();
  check("4f. dispose também libera o transporte atual", JSON.stringify(wire.list[1].listenerCounts()) === JSON.stringify({ messages: 0, closes: 0, diagnostics: 0 }));

  // 5. Retry ownership: uma pair nova no meio do backoff substitui o loop antigo.
  const backoff = { maxRetries: 3, baseDelayMs: 120, maxDelayMs: 120 };
  const wire5 = fakeWire();
  const adapter5 = newAdapter({ storage: null, transportFactory: wire5.factory, retry: backoff });
  await adapter5.pair(target({ name: "antigo" }));
  wire5.list[0].drop();
  check("5a. loop de retry em backoff (reconnecting)", adapter5.getSnapshot().phase === "reconnecting");
  await adapter5.pair(target({ name: "novo" }));
  const socketsAfterNewPair = wire5.list.length;
  await sleep(260);
  check("5b. loop antigo não reabre socket nem consome o novo orçamento", wire5.list.length === socketsAfterNewPair && adapter5.getSnapshot().phase === "connected", `transports=${wire5.list.length} phase=${adapter5.getSnapshot().phase}`);
  check("5c. generation do novo fluxo intacta (nenhum retry fantasma além dele)", adapter5.getSnapshot().generation === 2, `gen=${adapter5.getSnapshot().generation}`);
  adapter5.dispose();

  // 5d. Título concluído: notify-close durante close() não pode gravar depois.
  const { store, record } = memStore();
  const wire6 = fakeWire((transport) => {
    transport.notifyOnClose = true; // client.close() dispara onClose
  });
  const adapter6 = newAdapter({ storage: store, transportFactory: wire6.factory, retry: backoff });
  await adapter6.pair(target());
  const writesBefore = record.set;
  adapter6.close();
  await sleep(200);
  check("5d. close (com onClose recessivo) não escreve no store nem reconecta", record.set === writesBefore && adapter6.getSnapshot().phase === "closed" && wire6.list.length === 1, `set=${record.set} transports=${wire6.list.length}`);

  // 5e. restore() de um adapter sem relay + relay via URI.
  const emptyRelay = new RemotePiAdapter({ relayUrl: "", storage: null, transportFactory: fakeWire().factory, retry: SHORT_RETRY });
  track(emptyRelay);
  check("5e. constructor sem relay → idle, sem IO (nenhum socket)", emptyRelay.getSnapshot().phase === "idle");
  const noRelay = await rejection(emptyRelay.pair(target({ relayUrl: undefined })));
  check("5f. pair sem override, sem r=, sem default → erro fixo relay_unselected", noRelay instanceof AdapterStateError && noRelay.code === "relay_unselected", noRelay?.code);
  const wireUri = fakeWire();
  const uriAdapter = new RemotePiAdapter({ relayUrl: "", storage: null, transportFactory: wireUri.factory, retry: SHORT_RETRY });
  track(uriAdapter);
  const viaUri = await uriAdapter.pair(target({ relayUrl: "ws://do-uri.test" }));
  check("5g. r= do URI escolhe o relay quando o adapter não tem default", viaUri.phase === "connected" && uriAdapter.getSnapshot().paired?.relayUrl === "ws://do-uri.test" && wireUri.list[0].url === "ws://do-uri.test", uriAdapter.getSnapshot().paired?.relayUrl);
  const wireOverride = fakeWire();
  const overrideAdapter = new RemotePiAdapter({ relayUrl: "ws://default.test", storage: null, transportFactory: wireOverride.factory, retry: SHORT_RETRY });
  track(overrideAdapter);
  const viaOverride = await overrideAdapter.pair(target({ relayUrl: "ws://do-uri.test" }), "ws://override.test");
  check("5h. override > r= > default", viaOverride.phase === "connected" && wireOverride.list[0].url === "ws://override.test", wireOverride.list[0].url);
  check("5i. relay inválido recusado com erro fixo (sem hardcode de host)", (() => {
    try {
      new RemotePiAdapter({ relayUrl: "http://user:pw@host.test" });
      return false;
    } catch (err) {
      return err instanceof PairRejectedError && err.code === "unsafe_relay_url";
    }
  })());
  const emptyStored = memStore(null);
  const wireRestore = fakeWire();
  const restoreAdapter = newAdapter({ storage: emptyStored.store, transportFactory: wireRestore.factory, retry: SHORT_RETRY });
  const restoreEmpty = await restoreAdapter.restore();
  check("5j. restore sem registro → idle, sem socket", restoreEmpty.phase === "idle" && wireRestore.list.length === 0);
  const storedRelay = memStore(storedRecord({ relayUrl: "ws://stored.relay" }));
  const wireRestore2 = fakeWire();
  const restoreAdapter2 = newAdapter({ storage: storedRelay.store, transportFactory: wireRestore2.factory, retry: SHORT_RETRY });
  const restoredRelay = await restoreAdapter2.restore();
  check("5k. restore usa o stored.relay (não o default do adapter)", restoredRelay.phase === "connected" && wireRestore2.list[0].url === "ws://stored.relay", wireRestore2.list[0].url);

  // 5l. failed handshake → um único caminho de catch (token → reauth, sem continuação).
  const wireFail = fakeWire((transport) => {
    transport.failPairCode = "token_expired";
  });
  const failAdapter = newAdapter({ storage: null, transportFactory: wireFail.factory, retry: SHORT_RETRY });
  const failed = await failAdapter.pair(target());
  await sleep(60);
  check("5l. token expirado → reauth_required, um socket, sem continuação", failed.phase === "reauth_required" && wireFail.list.length === 1 && failAdapter.getSnapshot().generation === 1);
  failAdapter.dispose();
  adapter6.dispose();
}

async function scenarioGate() {
  console.log("\n== 7. gate desabilitado ==");
  const wire = fakeWire();
  const adapter = newAdapter({ enabled: false, storage: null, transportFactory: wire.factory });
  check("enabled=false → fase disabled", adapter.getSnapshot().phase === "disabled");
  const pairRefused = await rejection(adapter.pair(target()));
  const restoreRefused = await rejection(adapter.restore());
  check("gate não pode ser burlado (pair/restore recusados)", pairRefused?.code === "disabled" && restoreRefused?.code === "disabled" && wire.list.length === 0);
  adapter.dispose();
}

// ── 2. real client + relay stub (socket de gravação) ────────────────────────

/** Real WebSocket with recorded outbound frames and a test handle. */
class RecordingSocket {
  constructor(url) {
    this.inner = new WebSocket(url);
    this.sent = [];
  }
  addEventListener(type, listener) {
    this.inner.addEventListener(type, listener);
  }
  removeEventListener(type, listener) {
    this.inner.removeEventListener(type, listener);
  }
  send(data) {
    try {
      this.sent.push(JSON.parse(data));
    } catch {
      this.sent.push({ raw: String(data) });
    }
    this.inner.send(data);
  }
  close() {
    this.inner.close();
  }
  get protocol() {
    return this.inner.protocol;
  }
  /** Kill the connection underneath the client = unexpected relay drop. */
  kill() {
    this.inner.close();
  }
  hellos() {
    return this.sent.filter((frame) => frame.type === "hello").map((frame) => frame.pubkey);
  }
  inners() {
    return this.sent.filter((frame) => typeof frame.ct === "string").map((frame) => decodeCt(frame.ct));
  }
}

/** A socket that never opens: it errors right after the listeners are armed,
 *  so the real client fails the handshake (`connect_failed`) without a relay. */
class DeadSocket {
  constructor() {
    this.handlers = { open: [], message: [], close: [], error: [] };
    queueMicrotask(() => {
      for (const listener of [...this.handlers.error]) listener({});
    });
  }
  addEventListener(type, listener) {
    this.handlers[type].push(listener);
  }
  removeEventListener(type, listener) {
    this.handlers[type] = this.handlers[type].filter((entry) => entry !== listener);
  }
  send() {}
  close() {}
  get protocol() {
    return "";
  }
}

async function scenarioRealRelay() {
  console.log("\n== 8. relay real: fluxo completo, drop com chave nova, restore ==");
  const stub = await startRelayStub({ originAllowlist: [ALLOWED_ORIGIN], token: TOKEN });
  let adapter1 = null;
  let adapter2 = null;
  // Recording sockets hold OPEN WebSockets: a failed assertion must not leave
  // the process alive, so the handles are closed in the finally block.
  const sockets = [];
  const offlineSocket = { value: false };
  let deadSockets = 0;
  try {
    const socketFactory = (url) => {
      if (offlineSocket.value) {
        deadSockets += 1;
        return new DeadSocket();
      }
      const socket = new RecordingSocket(url);
      sockets.push(socket);
      return socket;
    };
    const { store, record } = memStore();
    const retry = { maxRetries: 1, baseDelayMs: 5, maxDelayMs: 10 };
    const options = {
      storage: store,
      webSocketFactory: socketFactory,
      retry,
      deviceName: "verify-web-recovery",
    };
    adapter1 = track(new RemotePiAdapter({ relayUrl: stub.relayUrl, ...options }));

    const pairUri =
      `remotepi://pair?t=${stub.token}` +
      `&epk=${Buffer.from(stub.hostEpk, "base64").toString("base64url")}` +
      `&n=host&rm=host&r=${stub.relayUrl}`;
    const targetFromUri = parsePairUri(pairUri);
    const phases = [];
    adapter1.subscribe((snapshot) => phases.push(snapshot.phase));

    const snapshot = await adapter1.pair(targetFromUri);
    check("fluxo completo contra o relay: connected", snapshot.phase === "connected" && snapshot.host?.capabilities.includes("fs_nav"), `daemon=${snapshot.host?.daemon.version}`);
    check("ordem de fases no relay real", phases.slice(0, 5).join(",") === "idle,relay_authenticating,pairing,host_authenticating,connected", phases.join(","));
    check("snapshot com workspaces (catálogo do host)", Array.isArray(snapshot.workspaces) && snapshot.workspaces.length === 0);
    check("gravou o registro real", record.set === 1 && JSON.parse(store.getItem(SESSION_STORAGE_KEY)).hostEpk === stub.hostEpk);
    const inners1 = sockets[0].inners();
    check(
      "frames do fluxo: pair_request antes de host_hello e workspace_list",
      inners1[0]?.type === "pair_request" && inners1[1]?.type === "host_hello" && inners1[2]?.type === "workspace_list",
      inners1.map((m) => m.type).join(","),
    );
    check("chave efêmera presente (hello pubkey)", sockets[0].hellos().length === 1 && sockets[0].hellos()[0].length === 44);

    // Chat pelo host, com push de child: não derruba a conexão.
    const started = await adapter1.startWorkspace(process.cwd());
    const pushes = [];
    const offPush = adapter1.onServerMessage((msg, room) => pushes.push({ type: msg.type, room }));
    const done = until(() => pushes.some((p) => p.type === "agent_done"), 4_000);
    adapter1.sendChat(started.room_id, "olá do adapter");
    check("push de child chega pelo onServerMessage com a room do workspace", await done && pushes.every((p) => p.room === started.room_id), JSON.stringify(pushes.map((p) => p.type)));
    check("chat com child push NÃO derruba a conexão", adapter1.getSnapshot().phase === "connected" && sockets.length === 1);
    offPush();

    // Drop real → reconexão com chave NOVA e fluxo completo, sem replay.
    const pubkey1 = sockets[0].hellos()[0];
    sockets[0].kill();
    const left = await until(() => adapter1.getSnapshot().phase !== "connected", 4_000);
    const back = await until(() => adapter1.getSnapshot().phase === "connected", 4_000);
    check("drop inesperado saiu de connected", left);
    check("drop inesperado → reconectou", back && adapter1.getSnapshot().attempt >= 2, `attempt=${adapter1.getSnapshot().attempt}`);
    check("reconexão criou socket NOVO com chave efêmera NOVA", sockets.length >= 2 && sockets[1].hellos()[0] !== pubkey1);
    const inners2 = sockets[1].inners();
    check(
      "reconexão repetiu o fluxo completo",
      inners2[0]?.type === "pair_request" && inners2[1]?.type === "host_hello" && inners2[2]?.type === "workspace_list",
      inners2.map((m) => m.type).join(","),
    );
    check("sem replay de chat/RPC nas reconexões", sockets.slice(1).every((s) => s.sent.every((f) => typeof f.type !== "string" || f.type !== "host_forward")) && sockets.slice(1).every((s) => !s.inners().some((m) => m.type === "user_message")));
    check("reconexão não reescreveu o storage", record.set === 1);

    // 2º drop: orçamento reiniciado no sucesso anterior.
    const countBefore = sockets.length;
    sockets[countBefore - 1].kill();
    const leftAgain = await until(() => adapter1.getSnapshot().phase !== "connected", 4_000);
    const backAgain = await until(() => adapter1.getSnapshot().phase === "connected", 4_000);
    check("2o drop saiu de connected", leftAgain);
    check("2º drop reconecta (orçamento reiniciado)", backAgain && sockets.length === countBefore + 1);

    // dispose preserva o registro; restore re-pareia (nunca reusa a chave).
    const pubkeyLast = sockets[sockets.length - 1].hellos()[0];
    adapter1.dispose();
    check("dispose no relay real preserva o registro", record.remove === 0 && store.getItem(SESSION_STORAGE_KEY) !== null);
    adapter2 = track(new RemotePiAdapter({ relayUrl: stub.relayUrl, ...options }));
    const restored = await adapter2.restore();
    const restoreSocket = sockets[sockets.length - 1];
    check("restore contra o relay real conecta", restored.phase === "connected");
    check("restore NÃO reusa a chave anterior (re-pareia)", restoreSocket.hellos()[0] !== pubkeyLast && restoreSocket.inners()[0]?.type === "pair_request");
    check("restore não regrava o registro", record.set === 1);

    // Exaustão: toda tentativa nova morre no handshake, com o relay ainda no ar.
    offlineSocket.value = true;
    const realSocketsBefore = sockets.length;
    sockets[sockets.length - 1].kill();
    const leftOffline = await until(() => adapter2.getSnapshot().phase !== "connected", 4_000);
    const exhausted = await until(() => adapter2.getSnapshot().phase === "error", 6_000);
    check("relay inacessível → saiu de connected e esgotou o orçamento", leftOffline && exhausted, adapter2.getSnapshot().phase);
    check("diagnóstico fixo retry_exhausted (relay real)", adapter2.getSnapshot().diagnostic?.code === "retry_exhausted", adapter2.getSnapshot().diagnostic?.code);
    const dead = deadSockets;
    await sleep(80);
    check("tentativas limitadas ao orçamento (maxRetries=1)", deadSockets === dead && dead === 1);
    check("nenhum socket real novo depois do orçamento", sockets.length === realSocketsBefore, `sockets=${sockets.length}`);
  } finally {
    adapter1?.dispose();
    adapter2?.dispose();
    for (const socket of sockets) {
      try {
        socket.inner.close();
      } catch {
        /* already gone */
      }
    }
    void stub.close().catch(() => undefined);
  }
}

async function main() {
  console.log("verify-web-recovery — adapter Wave 2 (fake wire + relay real)");
  await scenarioPairFlow();
  await scenarioRestoreAndStorage();
  await scenarioWarningsAndTypedMethods();
  await scenarioTokenRejections();
  await scenarioPairFailurePublication();
  await scenarioStoredPairingTruthfulness();
  await scenarioDropRetry();
  await scenarioSupersedeAndClose();
  await scenarioNewPairWhileConnected();
  await scenarioUnsubscribeAndFlowOwnership();
  await scenarioGate();
  await scenarioRealRelay();
  disposeAll();
  await sleep(30);
  check("nenhuma promise rejeitada sem handler", unhandled.length === 0, unhandled.join(" | "));
  console.log(failures === 0 ? "\nverify-web-recovery: ALL PASS\n" : `\nverify-web-recovery: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  await main();
} finally {
  disposeAll();
}
