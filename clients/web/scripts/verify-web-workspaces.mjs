/**
 * Wave 3 verification — workspace lifecycle (`workspace_restart` / `workspace_add`
 * / `workspace_state`) over the REAL web transport.
 *
 * Two instruments, both driving real production code (Node 22 runs the TS):
 *   • `RemotePiWebClient` over a FAKE FORMAL WIRE (the same FakeSocket +
 *     encodeCt/decodeOuter contract the transport suite uses): outbound request
 *     shapes, reply binding through the shared pending registry, the strict
 *     `workspace_state` push guard, the dedicated push sink and the
 *     chat-path separation;
 *   • `RemotePiAdapter` over a typed FAKE transport (the documented injection
 *     seam): snapshot projection, exact-cwd allow-list, coalesced catalog
 *     invalidation, flow/close/dispose fencing and listener release.
 *
 * No relay, no daemon, no filesystem, no fake backend proof.
 *
 * Run: node scripts/verify-web-workspaces.mjs
 */

import { RemotePiWebClient, TransportError } from "../src/lib/remote-pi/client.ts";
import {
  ActionRejectedError,
  HOST_WEB_ROOM_ID,
  WORKSPACE_RESTART_ERROR_FALLBACK,
  WORKSPACE_RESTART_ERROR_MESSAGES,
  WORKSPACE_STATES,
  WorkspaceRestartRejectedError,
  decodeCt,
  encodeCt,
  isActionOk,
  isWorkspaceRestartErrorCode,
  isWorkspaceStatePush,
} from "../src/lib/remote-pi/protocol.ts";
import { RemotePiAdapter, AdapterStateError } from "../src/lib/remote-pi/adapter.ts";

const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const OTHER_EPK = Buffer.alloc(32, 9).toString("base64");
const RELAY_URL = "https://relay.test/ws/";
const HOST_ROOM = "host";
const TOKEN = "pair-token-SECRET";
const RAW_SECRET = "/RAW/HOST/SECRET";
const TIME = { openMs: 300, challengeMs: 250, authGraceMs: 20, requestMs: 300, signerMs: 800 };
/** Mirrors adapter.ts CATALOG_INVALIDATE_MS (not exported). */
const INVALIDATE_MS = 250;
const PAST_WINDOW_MS = INVALIDATE_MS + 250;
const SHORT_RETRY = { maxRetries: 2, baseDelayMs: 8, maxDelayMs: 20 };

let failures = 0;
const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(String(err)));

function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}
function note(text) {
  console.log(`  [NOTE] ${text}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => sleep(0);
function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function settledWithin(promise, ms = 40) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return done;
}
async function rejected(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}
/** Every string a caller could render off an exception. */
function dumpOf(err) {
  return [err?.message, err?.name, err?.code, err?.action, err?.safeMessage,
    JSON.stringify({ ...err }), String(err?.stack).split("\n")[0]].join("|");
}

// ── fake formal wire (same surface the transport suite uses) ───────────────

class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.sent = [];
    this.closed = false;
  }
  addEventListener(type, listener) { this.handlers[type].push(listener); }
  removeEventListener(type, listener) { this.handlers[type] = this.handlers[type].filter((l) => l !== listener); }
  totalListeners() { return Object.values(this.handlers).reduce((n, list) => n + list.length, 0); }
  send(data) { const frame = JSON.parse(data); this.sent.push(frame); this.onSend?.(frame); }
  close() { if (this.closed) return; this.closed = true; this.emit("close", {}); }
  emit(type, event) { for (const listener of [...this.handlers[type]]) listener(event); }
  open() { this.emit("open", {}); }
  deliver(frame) {
    if (this.closed) return;
    this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  outers() { return this.sent.filter((frame) => typeof frame.ct === "string").map((frame) => decodeCt(frame.ct)); }
  lastInner() { const all = this.outers(); return all.length === 0 ? null : all[all.length - 1]; }
}

class Wire {
  constructor(options = {}) {
    this.hostEpk = options.hostEpk ?? HOST_EPK;
    this.nonce = Buffer.alloc(32, 3).toString("base64");
    this.sockets = [];
  }
  factory = (url, protocols) => {
    const socket = new FakeSocket(url, protocols);
    this.sockets.push(socket);
    socket.onSend = (frame) => this.onFrame(socket, frame);
    queueMicrotask(() => socket.open());
    return socket;
  };
  onFrame(socket, frame) {
    const inner = typeof frame.ct === "string" ? decodeCt(frame.ct) : frame;
    if (inner.type === "hello") socket.deliver({ type: "challenge", nonce: this.nonce });
  }
  get socket() { return this.sockets[this.sockets.length - 1]; }
  /** Delivers one formal envelope to the client. */
  deliver(inner, { peer = null, room = HOST_ROOM } = {}) {
    this.socket.deliver({ peer: peer ?? this.hostEpk, room, ct: encodeCt(inner) });
  }
}

const clients = [];
function track(client) { clients.push(client); return client; }
function closeAll() {
  for (const client of clients) {
    try { client.close(); } catch { /* already closed */ }
  }
  clients.length = 0;
}
function newClient(wire, options = {}) {
  return track(new RemotePiWebClient({
    relayUrl: RELAY_URL,
    webSocketFactory: wire.factory,
    deviceName: "verify-web-workspaces",
    timeouts: { ...TIME, ...(options.timeouts ?? {}) },
  }));
}
async function connectedClient(wire) {
  const client = newClient(wire);
  await client.connect();
  return client;
}

const fsListOk = (id, path = "/tmp") => ({ type: "fs_list_ok", in_reply_to: id, path, parent: null, entries: [] });
const wsListOk = (id, rooms) => ({
  type: "workspace_list_ok",
  in_reply_to: id,
  workspaces: rooms.map((room) => ({
    cwd: `/proj/${room}`, daemon_id: "daemon-1", room_id: room, name: room,
    live: true, daemon: false, source: "added",
  })),
});
const statePush = (over = {}) => ({
  type: "workspace_state",
  cwd: "/proj/alpha",
  state: "running",
  last_error: null,
  restarts: 0,
  ...over,
});

// ── 1. restartWorkspace: outbound shape + settle via the pending registry ──
async function scenarioRestartRequest() {
  console.log("\n== 1. client.restartWorkspace ==");
  const wire = new Wire();
  const client = await connectedClient(wire);
  const diags = [];
  const sinks = [];
  const chats = [];
  client.onDiagnostic((code) => diags.push(code));
  client.onWorkspaceState((push) => sinks.push(push));
  client.onServerMessage((msg) => chats.push(msg));

  const pending = client.restartWorkspace(wire.hostEpk, "/proj/alpha");
  const sent = wire.socket.lastInner();
  check("workspace_restart sai na room \"host\" com {id, cwd} exatos",
    sent?.type === "workspace_restart" && sent.cwd === "/proj/alpha" && typeof sent.id === "string" &&
    Object.keys(sent).sort().join(",") === "cwd,id,type",
    JSON.stringify(sent));
  const restartId = sent.id;

  // A valid PUSH must not settle the RPC; only workspace_restart_ok does.
  wire.deliver(statePush({ cwd: "/proj/alpha", state: "starting" }));
  await tick();
  check("push workspace_state NÃO assenta a RPC de restart", (await settledWithin(pending)) === false);
  check("push válido chega ao sink dedicado (1)", sinks.length === 1 && sinks[0].state === "starting");
  check("push válido NÃO chega ao encaminhamento de chat (onServerMessage)", chats.length === 0);

  // Wrong correlation id: not settled, classified as unknown reply.
  wire.deliver({ type: "workspace_restart_ok", in_reply_to: "id-de-outra-request", cwd: "/proj/alpha", daemon_id: "d1" });
  await tick();
  check("workspace_restart_ok com correlação errada não assenta (unknown_reply)",
    diags.includes("unknown_reply") && (await settledWithin(pending)) === false, diags.join(","));

  // Wrong KIND with the right id: refused, still pending.
  wire.deliver({ type: "action_ok", in_reply_to: restartId, action: "workspace_restart" });
  await tick();
  check("action_ok com o id certo é tipo errado (wrong_response_kind) e não assenta",
    diags.includes("wrong_response_kind") && (await settledWithin(pending)) === false);

  // Correlated push (same id) is not a push: it must not settle restart either.
  wire.deliver(statePush({ in_reply_to: restartId }));
  await tick();
  check("workspace_state com in_reply_to da RPC é recusado como push e não a assenta",
    sinks.length === 1 && (await settledWithin(pending)) === false, `sinks=${sinks.length}`);

  wire.deliver({ type: "workspace_restart_ok", in_reply_to: restartId, cwd: "/proj/alpha", daemon_id: "d1" });
  const ok = await pending;
  check("workspace_restart_ok correto assenta a RPC", ok.type === "workspace_restart_ok" && ok.cwd === "/proj/alpha");
  check("o ok NÃO traz room_id (caller precisa relistar)", !("room_id" in ok), Object.keys(ok).join(","));
  check("nenhuma RPC pendente sobrou", wire.socket.totalListeners() === 2);
  client.close();
}

// ── 2. restartWorkspace: typed rejection, no raw host text ────────────────
async function scenarioRestartErrors() {
  console.log("\n== 2. client.restartWorkspace — rejeição tipada ==");
  const wire = new Wire();
  const client = await connectedClient(wire);

  for (const [code, expected] of [["not_found", WORKSPACE_RESTART_ERROR_MESSAGES.not_found], ["spawn_failed", WORKSPACE_RESTART_ERROR_MESSAGES.spawn_failed]]) {
    const pending = client.restartWorkspace(wire.hostEpk, "/proj/alpha");
    const id = wire.socket.lastInner().id;
    wire.deliver({ type: "workspace_restart_error", in_reply_to: id, code, message: `raw ${RAW_SECRET} ${code}` });
    const err = await rejected(pending);
    check(`restart_error ${code} → WorkspaceRestartRejectedError tipado`,
      err instanceof WorkspaceRestartRejectedError && err.code === code && err.safeMessage === expected, err?.code);
    check(`restart_error ${code} não vaza o message do host`,
      !dumpOf(err).includes(RAW_SECRET) && !dumpOf(err).includes("raw "), dumpOf(err).slice(0, 60));
  }

  const unknownPending = client.restartWorkspace(wire.hostEpk, "/proj/alpha");
  const unknownId = wire.socket.lastInner().id;
  wire.deliver({ type: "workspace_restart_error", in_reply_to: unknownId, code: "boom", message: RAW_SECRET });
  const unknownErr = await rejected(unknownPending);
  check("code fora da allow-list → code \"unknown\" + texto fixo",
    unknownErr instanceof WorkspaceRestartRejectedError && unknownErr.code === "unknown" &&
    unknownErr.safeMessage === WORKSPACE_RESTART_ERROR_FALLBACK, unknownErr?.code);
  check("code desconhecido não vaza o message cru", !dumpOf(unknownErr).includes(RAW_SECRET));

  // action_error is NOT the restart's error kind.
  const wrongKind = client.restartWorkspace(wire.hostEpk, "/proj/alpha");
  const wrongId = wire.socket.lastInner().id;
  wire.deliver({ type: "action_error", in_reply_to: wrongId, action: "workspace_restart", error: "not_found" });
  check("action_error não assenta restart (o erro declarado é workspace_restart_error)",
    (await settledWithin(wrongKind)) === false);
  wire.deliver({ type: "workspace_restart_error", in_reply_to: wrongId, code: "not_found", message: "m" });
  check("o erro correto ainda assenta a mesma RPC", (await rejected(wrongKind)) instanceof WorkspaceRestartRejectedError);
  client.close();
}

// ── 3. addWorkspace: action_ok binding + action_error allow-list ──────────
async function scenarioAddWorkspace() {
  console.log("\n== 3. client.addWorkspace ==");
  const wire = new Wire();
  const client = await connectedClient(wire);
  const diags = [];
  client.onDiagnostic((code) => diags.push(code));

  const pending = client.addWorkspace(wire.hostEpk, "/home/u/new");
  const sent = wire.socket.lastInner();
  check("workspace_add sai na room \"host\" com {id, path} e sem cwd inventado",
    sent?.type === "workspace_add" && sent.path === "/home/u/new" && typeof sent.id === "string" &&
    Object.keys(sent).sort().join(",") === "id,path,type", JSON.stringify(sent));
  const id = sent.id;

  // `action_ok` is accepted BY KIND, but an ok naming ANOTHER action is
  // refused WITHOUT settling (symmetric with the wrong-action `action_error`
  // below): the request keeps waiting for its own valid reply.
  wire.deliver({ type: "action_ok", in_reply_to: id, action: "workspace_remove" });
  await tick();
  check("action_ok de OUTRA action não assenta (wrong_action_error) e segue pendente",
    diags.includes("wrong_action_error") && (await settledWithin(pending)) === false,
    diags.join(","));

  wire.deliver({ type: "action_ok", in_reply_to: id, action: "workspace_add" });
  check("a resposta válida ainda assenta a MESMA RPC de add", (await pending) === undefined);

  const okPending = client.addWorkspace(wire.hostEpk, "/home/u/new");
  wire.deliver({ type: "action_ok", in_reply_to: wire.socket.lastInner().id, action: "workspace_add" });
  check("action_ok{workspace_add} resolve o add com void", (await okPending) === undefined);

  // action_error naming another action: refused, not settled.
  const wrongAction = client.addWorkspace(wire.hostEpk, "/home/u/new");
  const wrongId = wire.socket.lastInner().id;
  wire.deliver({ type: "action_error", in_reply_to: wrongId, action: "fs_list", error: "not_found" });
  await tick();
  check("action_error de action errada não assenta (wrong_action_error)",
    diags.includes("wrong_action_error") && (await settledWithin(wrongAction)) === false);

  // action_error for workspace_add: typed rejection, raw text dropped.
  wire.deliver({ type: "action_error", in_reply_to: wrongId, action: "workspace_add", error: "not_a_directory" });
  const err = await rejected(wrongAction);
  check("action_error{workspace_add} → ActionRejectedError tipado",
    err instanceof ActionRejectedError && err.action === "workspace_add" && err.code === "not_a_directory", err?.code);

  // A hostile `action` value is refused by the action binding BEFORE any
  // exception exists (it never settles), so the hostile string cannot even
  // reach `ActionRejectedError`.
  const hostileAction = client.addWorkspace(wire.hostEpk, "/home/u/new");
  const hostileActionId = wire.socket.lastInner().id;
  wire.deliver({ type: "action_error", in_reply_to: hostileActionId, action: "/etc/passwd", error: RAW_SECRET });
  await tick();
  check("action_error com `action` hostil não assenta (wrong_action_error) e não vira exceção",
    diags.includes("wrong_action_error") && (await settledWithin(hostileAction)) === false);

  // A hostile `error` string on the RIGHT action DOES produce the typed
  // exception: only the fixed label survives.
  const hostileError = client.addWorkspace(wire.hostEpk, "/home/u/new");
  const hostileErrorId = wire.socket.lastInner().id;
  wire.deliver({ type: "action_error", in_reply_to: hostileErrorId, action: "workspace_add", error: RAW_SECRET });
  const hostileErr = await rejected(hostileError);
  check("error hostil cai no rótulo fixo (code unknown, nada cru no dump)",
    hostileErr instanceof ActionRejectedError && hostileErr.action === "workspace_add" && hostileErr.code === "unknown" &&
    !dumpOf(hostileErr).includes(RAW_SECRET), dumpOf(hostileErr).slice(0, 60));

  // isActionOk / isWorkspaceRestartErrorCode: direct guard reads.
  check("isActionOk exige action string e isWorkspaceRestartErrorCode é fechado",
    isActionOk({ type: "action_ok", action: "workspace_add" }) === true &&
    isActionOk({ type: "action_ok", action: 7 }) === false &&
    isWorkspaceRestartErrorCode("not_found") === true && isWorkspaceRestartErrorCode("boom") === false);
  client.close();
}

// ── 4. push never settles a live RPC + host-room-only routing ─────────────
async function scenarioPushNeverSettles() {
  console.log("\n== 4. push vs RPC viva (fs_list) ==");
  const wire = new Wire();
  const client = await connectedClient(wire);
  const sink = [];
  const chats = [];
  const diags = [];
  client.onWorkspaceState((push) => sink.push(push));
  client.onServerMessage((msg, room) => chats.push({ msg, room }));
  client.onDiagnostic((code) => diags.push(code));

  const list = client.listWorkspaces(wire.hostEpk);
  wire.deliver(wsListOk(wire.socket.lastInner().id, ["room-alpha"]));
  await list;

  const pending = client.fsList(wire.hostEpk, "/tmp");
  const id = wire.socket.lastInner().id;

  // 3-push burst while the fs_list is live: none may settle it.
  wire.deliver(statePush({ cwd: "/proj/alpha", state: "crashed", last_error: RAW_SECRET, restarts: 3 }));
  wire.deliver(statePush({ cwd: "/proj/alpha", state: "starting", last_error: null, restarts: 4 }));
  wire.deliver(statePush({ cwd: "/proj/alpha", state: "running", last_error: null, restarts: 5 }));
  await tick();
  check("3 pushes válidos não assentam a RPC viva", (await settledWithin(pending)) === false);
  check("os 3 pushes chegam ao sink dedicado e a nenhum listener de chat",
    sink.length === 3 && chats.length === 0, `sink=${sink.length} chat=${chats.length}`);
  check("só os 5 campos documentados cruzam para o sink",
    Object.keys(sink[0]).sort().join(",") === "cwd,last_error,restarts,state,type", Object.keys(sink[0]).join(","));

  // A proxied child frame claiming workspace_state stays CHILD traffic.
  wire.deliver({ type: "host_message", room: "room-alpha", ct: encodeCt(statePush({ cwd: "/proj/alpha", state: "stopped" })) });
  await tick();
  check("workspace_state dentro de host_message vai para o chat na room filha (não para o sink)",
    sink.length === 3 && chats.length === 1 && chats[0].room === "room-alpha" && chats[0].msg.type === "workspace_state");

  // Wrong peer / wrong room: neither settles nor reaches the sink.
  wire.deliver(statePush(), { peer: OTHER_EPK });
  wire.deliver(statePush(), { room: "workspace-x" });
  await tick();
  check("push de outro peer/room não entra (unexpected_peer/unexpected_room)",
    sink.length === 3 && diags.includes("unexpected_peer") && diags.includes("unexpected_room"), diags.join(","));

  wire.deliver(fsListOk(id, "/tmp/real"));
  check("a resposta real do host assenta a RPC", (await pending).path === "/tmp/real");

  // A SECOND subscriber must not double-count the primary sink.
  const extra = [];
  const off = client.onWorkspaceState((push) => extra.push(push));
  wire.deliver(statePush({ state: "stopped" }));
  await tick();
  check("sink adicional recebe enquanto inscrito (sink primário cresce 1)",
    extra.length === 1 && sink.length === 4, `extra=${extra.length} sink=${sink.length}`);
  off();
  wire.deliver(statePush({ state: "stopped" }));
  await tick();
  check("unsubscribe do sink dedicado interrompe entrega",
    extra.length === 1 && sink.length === 5, `extra=${extra.length} sink=${sink.length}`);
  client.close();
}

// ── 5. strict push guard (direct + end-to-end) ────────────────────────────
async function scenarioPushGuard() {
  console.log("\n== 5. guarda estrita do workspace_state ==");
  const base = { type: "workspace_state", cwd: "/proj/alpha", state: "running", last_error: null, restarts: 0 };
  const cases = [
    ["válido", base, true],
    ["extra key tolerada (nunca projetada)", { ...base, room_id: "r", daemon_id: "d" }, true],
    ["last_error string", { ...base, last_error: RAW_SECRET }, true],
    ["id ausente mas in_reply_to presente", { ...base, in_reply_to: "x" }, false],
    ["id presente (string)", { ...base, id: "x" }, false],
    ["id presente (number)", { ...base, id: 7 }, false],
    ["id presente (null)", { ...base, id: null }, false],
    ["in_reply_to presente (number)", { ...base, in_reply_to: 3 }, false],
    ["state fora do enum", { ...base, state: "paused" }, false],
    ["state não-string", { ...base, state: 1 }, false],
    ["restarts negativo", { ...base, restarts: -1 }, false],
    ["restarts fracionário", { ...base, restarts: 1.5 }, false],
    ["restarts string", { ...base, restarts: "2" }, false],
    ["restarts NaN", { ...base, restarts: NaN }, false],
    ["last_error número", { ...base, last_error: 5 }, false],
    ["cwd vazio", { ...base, cwd: "" }, false],
    ["cwd não-string", { ...base, cwd: 42 }, false],
    ["cwd ausente", { type: "workspace_state", state: "running", last_error: null, restarts: 0 }, false],
    ["restarts ausente", { type: "workspace_state", cwd: "/a", state: "running", last_error: null }, false],
    ["não-objeto", "workspace_state", false],
    ["array", [base], false],
    ["tipo errado", { ...base, type: "workspace_states" }, false],
  ];
  const guardMisses = cases.filter(([, value, expected]) => isWorkspaceStatePush(value) !== expected)
    .map(([label]) => label);
  check(`matriz da guarda (${cases.length} casos) bate exatamente`, guardMisses.length === 0, guardMisses.join(","));
  check("WORKSPACE_STATES é o enum fechado documentado", WORKSPACE_STATES.join(",") === "running,starting,crashed,stopped");

  // Routing table: what happens to each frame AFTER the guard refuses it. ANY
  // frame the push guard refuses — malformed OR carrying `id`/`in_reply_to` —
  // is diagnosed `malformed_workspace_state` and DROPPED: it never settles an
  // RPC (even with a matching `in_reply_to`) and never reaches the chat path
  // (even with a string `id`).
  const wire = new Wire();
  const client = await connectedClient(wire);
  const sink = [];
  const chats = [];
  const diags = [];
  client.onWorkspaceState((push) => sink.push(push));
  client.onServerMessage((msg) => chats.push(msg));
  client.onDiagnostic((code) => diags.push(code));
  client.sendChat(wire.hostEpk, "room-warm", "bind"); // bind the host peer

  const routing = [
    ["válido", base, "sink"],
    ["extra key (nunca projetada)", { ...base, room_id: "r", daemon_id: "d" }, "sink"],
    ["last_error string", { ...base, last_error: RAW_SECRET }, "sink"],
    ["in_reply_to string → malformed (drop, nunca assenta)", { ...base, in_reply_to: "x" }, "malformed_workspace_state"],
    ["id string → malformed (drop, nunca vira chat)", { ...base, id: "x" }, "malformed_workspace_state"],
    ["id number → malformed", { ...base, id: 7 }, "malformed_workspace_state"],
    ["id null → malformed", { ...base, id: null }, "malformed_workspace_state"],
    ["in_reply_to number → recusado ANTES, no decode do envelope (malformed_ct)", { ...base, in_reply_to: 3 }, "malformed_ct"],
    ["state fora do enum", { ...base, state: "paused" }, "malformed_workspace_state"],
    ["state não-string", { ...base, state: 1 }, "malformed_workspace_state"],
    ["restarts negativo", { ...base, restarts: -1 }, "malformed_workspace_state"],
    ["restarts fracionário", { ...base, restarts: 1.5 }, "malformed_workspace_state"],
    ["restarts string", { ...base, restarts: "2" }, "malformed_workspace_state"],
    ["restarts NaN", { ...base, restarts: NaN }, "malformed_workspace_state"],
    ["last_error número", { ...base, last_error: 5 }, "malformed_workspace_state"],
    ["cwd vazio", { ...base, cwd: "" }, "malformed_workspace_state"],
    ["cwd não-string", { ...base, cwd: 42 }, "malformed_workspace_state"],
    ["cwd ausente", { type: "workspace_state", state: "running", last_error: null, restarts: 0 }, "malformed_workspace_state"],
    ["restarts ausente", { type: "workspace_state", cwd: "/a", state: "running", last_error: null }, "malformed_workspace_state"],
    ["array não é frame", [base], "malformed_ct"],
    ["string não é frame", "workspace_state", "malformed_ct"],
  ];
  const mismatches = [];
  for (const [label, value, expect] of routing) {
    const s0 = sink.length;
    const c0 = chats.length;
    const d0 = diags.length;
    wire.deliver(value);
    await tick();
    const codes = diags.slice(d0);
    const got = sink.length > s0 ? "sink" : codes.length > 0 ? codes[codes.length - 1] : chats.length > c0 ? "chat" : "none";
    if (got !== expect) mismatches.push(`${label}: got=${got} want=${expect}`);
  }
  check(`tabela de roteamento (${routing.length} casos) bate exatamente`, mismatches.length === 0, mismatches.join(" | "));
  check("só os 3 pushes válidos entram no sink dedicado", sink.length === 3, `sink=${sink.length}`);
  check("NENHUM frame de workspace_state vaza para o chat (nem o `id`-string)",
    chats.length === 0, `${chats.length} chat frame(s)`);

  // A correlated push must ALSO not settle the live RPC it names.
  const liveList = client.listWorkspaces(wire.hostEpk);
  const liveId = wire.socket.lastInner().id;
  wire.deliver({ ...base, in_reply_to: liveId });
  wire.deliver({ ...base, id: liveId });
  await tick();
  check("workspace_state correlacionado com a RPC viva NÃO a assenta",
    (await settledWithin(liveList)) === false);
  wire.deliver(wsListOk(liveId, ["room-alpha"]));
  check("a reply válida ainda assenta a RPC", (await liveList).type === "workspace_list_ok");
  note("fronteira fechada: push inválido/correlacionado = malformed_workspace_state + drop (client.ts:999-1006)");
  client.close();
}

// ── 6. adapter: push → snapshot projection (deep copy, no raw text) ───────
class FakeTransport {
  constructor(url, list) {
    this.url = url;
    this.calls = [];
    this.closed = false;
    this.connected = false;
    this.backend = "webcrypto";
    this.workspaces = [];
    this.fsResult = { type: "fs_list_ok", path: "/x", parent: null, entries: [] };
    this.messageListeners = new Set();
    this.stateListeners = new Set();
    this.closeListeners = new Set();
    this.diagnosticListeners = new Set();
    this.omitStateSink = false;
    this.holdList = null;
    this.listHooks = [];
    this.failList = null;
    this.addResult = null;
    this.restartHold = null;
    list.push(this);
  }
  async connect() { this.calls.push("connect"); this.connected = true; }
  async pair() { this.calls.push("pair"); return { type: "pair_ok", session_name: "host", session_started_at: 1, room_id: HOST_ROOM }; }
  async helloHost() {
    this.calls.push("helloHost");
    return { type: "host_hello_ok", daemon: { version: "fake-1", hostname: "fake-pi", platform: "linux" }, capabilities: ["fs_nav"] };
  }
  async listWorkspaces() {
    this.calls.push("listWorkspaces");
    // Per-call hook: lets a test hold ONE list reply (and decide its rows)
    // while a later list in the SAME flow resolves first.
    const hook = this.listHooks.shift();
    if (hook) {
      await hook.promise;
      if (hook.rows) this.workspaces = hook.rows;
    }
    if (this.holdList) await this.holdList.promise;
    if (this.failList) throw this.failList;
    return { type: "workspace_list_ok", workspaces: this.workspaces.map((w) => ({ ...w })) };
  }
  async fsList(epk, path, options) { this.calls.push("fsList"); this.fsArgs = [epk, path, options]; return this.fsResult; }
  async startWorkspace() { this.calls.push("startWorkspace"); return { type: "workspace_start_ok", cwd: "/proj/alpha", room_id: "room-1", daemon_id: "d1" }; }
  async restartWorkspace(epk, cwd, room) {
    this.calls.push("restartWorkspace");
    this.restartArgs = [epk, cwd, room];
    if (this.restartHold) await this.restartHold.promise;
    return { type: "workspace_restart_ok", cwd, daemon_id: "d1" };
  }
  async addWorkspace(epk, path, room) {
    this.calls.push("addWorkspace");
    this.addArgs = [epk, path, room];
    if (this.addResult) this.workspaces = this.addResult;
  }
  onServerMessage(listener) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onWorkspaceState(listener) { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onClose(listener) { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  onDiagnostic(listener) { this.diagnosticListeners.add(listener); return () => this.diagnosticListeners.delete(listener); }
  sendChat() { this.calls.push("sendChat"); return "mid-1"; }
  close() { this.closed = true; }
  listenerCounts() {
    return { messages: this.messageListeners.size, states: this.stateListeners.size, closes: this.closeListeners.size };
  }
  // test hooks
  emitState(push) { for (const l of [...this.stateListeners]) l(push); }
  emitMessage(msg, room = HOST_ROOM) { for (const l of [...this.messageListeners]) l(msg, room); }
  listCount() { return this.calls.filter((c) => c === "listWorkspaces").length; }
}

function fakeWire(configure) {
  const list = [];
  const factory = (url) => { const t = new FakeTransport(url, list); configure?.(t, list.length - 1); return t; };
  return { list, factory };
}

/** Faithful to the real flow: the host's catalog is already known to the
 *  transport when `workspace_list` answers, so `pair()` installs it. */
function fakeWireFor(rows = [], configure) {
  const list = [];
  const factory = (url) => {
    const t = new FakeTransport(url, list);
    t.workspaces = rows.map((r) => ({ ...r }));
    configure?.(t, list.length - 1);
    return t;
  };
  return { list, factory };
}

const adapters = [];
function trackAdapter(adapter) { adapters.push(adapter); return adapter; }
function disposeAllAdapters() {
  for (const adapter of adapters) { try { adapter.dispose(); } catch { /* already */ } }
  adapters.length = 0;
}
function newAdapter(options) {
  return trackAdapter(new RemotePiAdapter({ relayUrl: "ws://relay.test", storage: null, retry: SHORT_RETRY, ...options }));
}
const target = (over = {}) => ({ token: TOKEN, hostEpk: HOST_EPK, name: "host", roomId: HOST_ROOM, ...over });
const row = (cwd, over = {}) => ({ cwd, daemon_id: "d1", room_id: `room-${cwd.split("/").pop()}`, name: cwd.split("/").pop(), live: false, daemon: false, source: "added", ...over });

async function pairAdapter(wire, adapter) {
  return adapter.pair(target());
}

// ── 7. adapter: push → snapshot (deep copy, exact-cwd allow-list) ─────────
async function scenarioAdapterProjection() {
  console.log("\n== 7. adapter — projeção do push ==");
  const wire = fakeWireFor([row("/proj/alpha"), row("/proj/beta")]);
  const adapter = newAdapter({ transportFactory: wire.factory });
  const snapshot0 = await pairAdapter(wire, adapter);
  const transport = wire.list[0];
  check("catalog inicial: workspaceStates null (sem crash fictício)", snapshot0.workspaceStates === null);
  check("live do catálogo é o do LIST, não inventado", snapshot0.workspaces.every((w) => w.live === false));

  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "running", last_error: null, restarts: 2 });
  const snapshot1 = adapter.getSnapshot();
  const entry = snapshot1.workspaceStates?.["/proj/alpha"];
  check("push de cwd conhecido projeta {state, live, hasError, restarts}",
    entry?.state === "running" && entry.live === true && entry.hasError === false && entry.restarts === 2);
  check("projeção tem EXATAMENTE os 4 campos públicos", Object.keys(entry ?? {}).sort().join(",") === "hasError,live,restarts,state", Object.keys(entry ?? {}).join(","));
  check("push NÃO altera a fase da conexão nem fecha o socket",
    snapshot1.phase === "connected" && transport.closed === false);

  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "crashed", last_error: RAW_SECRET, restarts: 3 });
  const snapshot2 = adapter.getSnapshot();
  check("last_error cru vira boolean hasError e o texto NÃO aparece no snapshot",
    snapshot2.workspaceStates["/proj/alpha"].hasError === true &&
    snapshot2.workspaceStates["/proj/alpha"].live === false &&
    !JSON.stringify(snapshot2).includes(RAW_SECRET));
  check("state \"crashed\" é preservado (live=false não apaga a distinção)",
    snapshot2.workspaceStates["/proj/alpha"].state === "crashed");

  // deep copy: mutating the returned object must not reach adapter state.
  snapshot2.workspaceStates["/proj/alpha"].live = true;
  const snapshot3 = adapter.getSnapshot();
  check("snapshot é cópia profunda (mutação do caller não volta)",
    snapshot3.workspaceStates["/proj/alpha"].live === false &&
    snapshot3.workspaceStates !== snapshot2.workspaceStates);

  // byte-exact cwd: near matches are a DIFFERENT workspace.
  transport.emitState({ type: "workspace_state", cwd: "/proj/Alpha", state: "running", last_error: null, restarts: 0 });
  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha/", state: "running", last_error: null, restarts: 0 });
  const snapshot4 = adapter.getSnapshot();
  check("cwd é comparado byte a byte (case/trailing slash não fazem match)",
    Object.keys(snapshot4.workspaceStates).sort().join(",") === "/proj/alpha",
    Object.keys(snapshot4.workspaceStates).join(","));

  // malformed push through the MESSAGE channel is not consumed (chat path).
  const chats = [];
  adapter.onServerMessage((msg) => chats.push(msg));
  transport.emitMessage({ type: "workspace_state", cwd: "/proj/beta", state: "paused", last_error: null, restarts: 0 });
  check("push malformado cai no caminho de chat (não é consumido pela única guarda)",
    chats.length === 1 && adapter.getSnapshot().workspaceStates["/proj/beta"] === undefined);
  transport.emitMessage({ type: "workspace_state", cwd: "/proj/beta", state: "running", last_error: null, restarts: 1 });
  check("push VÁLIDO pelo canal de mensagem é consumido e não chega ao chat",
    chats.length === 1 && adapter.getSnapshot().workspaceStates["/proj/beta"]?.live === true);

  // REGRESSION: a PROXIED CHILD-room frame claiming `workspace_state` for a
  // KNOWN cwd is never consumed — child traffic can never mutate host state.
  transport.workspaces = [row("/proj/alpha"), row("/proj/beta"), row("/proj/gamma")];
  await adapter.refreshWorkspaces();
  transport.emitMessage({ type: "workspace_state", cwd: "/proj/gamma", state: "crashed", last_error: RAW_SECRET, restarts: 7 }, "room-gamma");
  check("host_message de room FILHA com workspace_state válido não muta o mapa do host",
    adapter.getSnapshot().workspaceStates?.["/proj/gamma"] === undefined &&
    !JSON.stringify(adapter.getSnapshot()).includes(RAW_SECRET), JSON.stringify(adapter.getSnapshot().workspaceStates));

  // REGRESSION: the dedicated sink seam re-validates too — a correlated or
  // malformed frame pushed there is dropped, never merged.
  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "crashed", last_error: RAW_SECRET, restarts: 42, in_reply_to: "x" });
  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "paused", last_error: null, restarts: 43 });
  check("sink dedicado descarta push correlacionado/malformado (mapa intacto)",
    adapter.getSnapshot().workspaceStates["/proj/alpha"].restarts === 3 &&
    !JSON.stringify(adapter.getSnapshot()).includes(RAW_SECRET),
    JSON.stringify(adapter.getSnapshot().workspaceStates["/proj/alpha"]));
  adapter.dispose();
}

// ── 8. adapter: unknown cwd, coalesced bounded refresh, prune ─────────────
async function scenarioAdapterInvalidation() {
  console.log("\n== 8. adapter — cwd desconhecido, relist coalescido e poda ==");
  const wire = fakeWireFor([row("/proj/alpha"), row("/proj/beta")]);
  const adapter = newAdapter({ transportFactory: wire.factory });
  await pairAdapter(wire, adapter);
  const transport = wire.list[0];
  const before = transport.listCount();

  transport.emitState({ type: "workspace_state", cwd: "/proj/ghost", state: "running", last_error: null, restarts: 0 });
  check("cwd desconhecido NÃO inventa linha no mapa", adapter.getSnapshot().workspaceStates?.["/proj/ghost"] === undefined);
  check("cwd desconhecido não cria linha no catálogo", adapter.getSnapshot().workspaces.every((w) => w.cwd !== "/proj/ghost"));

  transport.emitState({ type: "workspace_state", cwd: "/proj/ghost", state: "running", last_error: null, restarts: 1 });
  transport.emitState({ type: "workspace_state", cwd: "/proj/ghost", state: "starting", last_error: null, restarts: 2 });
  check("burst não relista imediatamente (janela coalescida)", transport.listCount() === before);
  await sleep(PAST_WINDOW_MS);
  check("3 pushes na mesma janela → exatamente 1 relist (sem loop de polling)",
    transport.listCount() === before + 1, `list=${transport.listCount() - before}`);

  // prune: the list is the authority on membership.
  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "running", last_error: null, restarts: 1 });
  transport.workspaces = [row("/proj/beta")];
  await adapter.refreshWorkspaces();
  check("setCatalog poda estados de linhas que sumiram do host",
    adapter.getSnapshot().workspaceStates?.["/proj/alpha"] === undefined &&
    adapter.getSnapshot().workspaces.length === 1);

  // a push during an in-flight list survives.
  transport.workspaces = [row("/proj/alpha"), row("/proj/beta")];
  await adapter.refreshWorkspaces();
  const held = gate();
  transport.holdList = held;
  const inflight = adapter.refreshWorkspaces();
  await tick();
  transport.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "running", last_error: null, restarts: 9 });
  transport.holdList = null;
  held.resolve();
  await inflight;
  check("push durante um list em voo sobrevive (list só troca membership)",
    adapter.getSnapshot().workspaceStates?.["/proj/alpha"]?.restarts === 9 &&
    adapter.getSnapshot().workspaces.length === 2);

  // REGRESSION: two overlapping refreshes in the SAME flow. The NEWER one
  // resolves first; the OLDER completion must not overwrite it.
  transport.workspaces = [row("/proj/alpha")];
  await adapter.refreshWorkspaces();
  const olderGate = gate();
  const newer = [row("/proj/newer")];
  transport.listHooks = [{ promise: olderGate.promise, rows: [row("/proj/older")] }];
  const older = adapter.refreshWorkspaces();
  await tick();
  transport.workspaces = newer;
  await adapter.refreshWorkspaces();
  check("refresh mais NOVO na mesma flow instala o catálogo novo",
    adapter.getSnapshot().workspaces.map((w) => w.cwd).join(",") === "/proj/newer",
    adapter.getSnapshot().workspaces.map((w) => w.cwd).join(","));
  const inflightList = transport.listCount();
  olderGate.resolve();
  const olderErr = await rejected(older);
  check("refresh mais ANTIGO na mesma flow é recusado com superseded",
    olderErr instanceof AdapterStateError && olderErr.code === "superseded", olderErr?.code ?? "resolved");
  check("a conclusão antiga NÃO sobrescreve o catálogo mais novo",
    adapter.getSnapshot().workspaces.map((w) => w.cwd).join(",") === "/proj/newer" &&
    transport.listCount() === inflightList,
    adapter.getSnapshot().workspaces.map((w) => w.cwd).join(","));

  // REGRESSION: an explicit refresh cancels the scheduled coalesced
  // invalidation (no redundant timer request after it).
  transport.emitState({ type: "workspace_state", cwd: "/proj/ghost", state: "running", last_error: null, restarts: 0 });
  const afterPush = transport.listCount();
  await adapter.refreshWorkspaces();
  check("refresh explícito relista UMA vez e cancela a invalidação agendada",
    transport.listCount() === afterPush + 1, `list=${transport.listCount() - afterPush}`);
  await sleep(PAST_WINDOW_MS);
  check("o timer cancelado NÃO dispara um segundo relist redundante",
    transport.listCount() === afterPush + 1, `list=${transport.listCount() - afterPush}`);
  adapter.dispose();
}

// ── 9. adapter: stale flows, close/dispose fencing, listener release ──────
async function scenarioAdapterFencing() {
  console.log("\n== 9. adapter — flows obsoletos, close/dispose e liberação ==");
  const wire = fakeWireFor([row("/proj/alpha")]);
  const adapter = newAdapter({ transportFactory: wire.factory });
  await pairAdapter(wire, adapter);
  const first = wire.list[0];
  const counts0 = first.listenerCounts();
  check("adapter registra os 3 canais no transporte ativo",
    counts0.messages === 1 && counts0.states === 1 && counts0.closes === 1, JSON.stringify(counts0));
  adapter.dispose();

  // a new pair supersedes the old flow: its push and its timer are inert.
  const wire2 = fakeWireFor([row("/proj/alpha")]);
  const adapter2 = newAdapter({ transportFactory: wire2.factory });
  await pairAdapter(wire2, adapter2);
  const before = wire2.list[0].listCount();
  first.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "crashed", last_error: RAW_SECRET, restarts: 5 });
  await sleep(PAST_WINDOW_MS);
  check("push de transporte superseded é inerte (nem estado nem relist)",
    adapter2.getSnapshot().workspaceStates === null && wire2.list[0].listCount() === before,
    `list=${wire2.list[0].listCount() - before}`);

  // close() cancels the armed timer and releases the listeners.
  const wire3 = fakeWireFor([row("/proj/alpha")]);
  const adapter3 = newAdapter({ transportFactory: wire3.factory });
  await pairAdapter(wire3, adapter3);
  const t3 = wire3.list[0];
  adapter3.close();
  check("close() libera os listeners do transporte",
    t3.listenerCounts().states === 0 && t3.listenerCounts().messages === 0 && t3.closed === true,
    JSON.stringify(t3.listenerCounts()));
  check("close() limpa workspaceStates/catálogo do snapshot",
    adapter3.getSnapshot().workspaceStates === null && adapter3.getSnapshot().workspaces === null);
  const listAfterClose = t3.listCount();
  t3.emitState({ type: "workspace_state", cwd: "/proj/alpha", state: "running", last_error: null, restarts: 0 });
  await sleep(PAST_WINDOW_MS);
  check("push após close não relista (timer cancelado + listeners soltos)",
    t3.listCount() === listAfterClose);

  // dispose() also cancels a pending invalidation.
  const wire4 = fakeWireFor([row("/proj/alpha")]);
  const adapter4 = newAdapter({ transportFactory: wire4.factory });
  await pairAdapter(wire4, adapter4);
  const t4 = wire4.list[0];
  const list4 = t4.listCount();
  t4.emitState({ type: "workspace_state", cwd: "/proj/ghost", state: "running", last_error: null, restarts: 0 });
  adapter4.dispose();
  await sleep(PAST_WINDOW_MS);
  check("dispose() cancela a invalidação armada", t4.listCount() === list4, `list=${t4.listCount() - list4}`);
  check("dispose() libera os listeners do transporte", t4.listenerCounts().states === 0 && t4.listenerCounts().messages === 0);

  const closedRestart = await rejected(adapter3.restartWorkspace("/proj/alpha"));
  const closedAdd = await rejected(adapter3.addWorkspace("/proj/alpha"));
  const closedList = await rejected(adapter3.refreshWorkspaces());
  check("close é terminal para as chamadas Wave 3",
    closedRestart instanceof AdapterStateError && closedRestart.code === "closed" &&
    closedAdd instanceof AdapterStateError && closedAdd.code === "closed" &&
    closedList instanceof AdapterStateError && closedList.code === "closed");

  // a reply landing after the flow was superseded is refused (`superseded`).
  const wire5 = fakeWireFor([row("/proj/alpha")]);
  const adapter5 = newAdapter({ transportFactory: wire5.factory });
  await pairAdapter(wire5, adapter5);
  const held5 = gate();
  wire5.list[0].restartHold = held5;
  const pendingRestart = adapter5.restartWorkspace("/proj/alpha");
  await tick();
  adapter5.close();
  held5.resolve();
  const supersededErr = await rejected(pendingRestart);
  check("restart cuja resposta chega após o close falha com superseded (nunca resolve)",
    supersededErr instanceof AdapterStateError && supersededErr.code === "superseded", supersededErr?.code);

  // superseded by a NEWER pair (same adapter) instead of close.
  const wire6 = fakeWireFor([row("/proj/alpha")]);
  const adapter6 = newAdapter({ transportFactory: wire6.factory });
  await pairAdapter(wire6, adapter6);
  const held6 = gate();
  wire6.list[0].restartHold = held6;
  const pendingRestart6 = adapter6.restartWorkspace("/proj/alpha");
  await tick();
  wire6.list[0].restartHold = null;
  await adapter6.pair(target());
  held6.resolve();
  const superseded6 = await rejected(pendingRestart6);
  check("restart cuja resposta chega após um novo pair falha com superseded",
    superseded6 instanceof AdapterStateError && superseded6.code === "superseded", superseded6?.code);
  adapter6.dispose();
}

// ── 10. adapter: Wave 3 calls bound to host + flow ────────────────────────
async function scenarioAdapterCalls() {
  console.log("\n== 10. adapter — restartWorkspace/addWorkspace ==");
  const wire = fakeWireFor([row("/proj/alpha")]);
  const adapter = newAdapter({ transportFactory: wire.factory });
  await pairAdapter(wire, adapter);
  const transport = wire.list[0];

  const ok = await adapter.restartWorkspace("/proj/alpha");
  check("restartWorkspace usa a room HOST e o epk do host",
    ok.type === "workspace_restart_ok" && transport.restartArgs[0] === HOST_EPK &&
    transport.restartArgs[1] === "/proj/alpha" && transport.restartArgs[2] === HOST_WEB_ROOM_ID,
    (transport.restartArgs ?? []).join(","));
  check("o ok do restart não traz room_id", !("room_id" in ok));

  const listBefore = transport.listCount();
  await adapter.addWorkspace("/home/u/new");
  check("addWorkspace usa a room HOST e não toca no catálogo local",
    transport.addArgs[0] === HOST_EPK && transport.addArgs[1] === "/home/u/new" &&
    transport.addArgs[2] === HOST_WEB_ROOM_ID &&
    adapter.getSnapshot().workspaces.length === 1, (transport.addArgs ?? []).join(","));
  check("addWorkspace não relista na hora (só arma a invalidação)", transport.listCount() === listBefore);
  await sleep(PAST_WINDOW_MS);
  check("addWorkspace relista UMA vez para aprender o cwd canônico",
    transport.listCount() === listBefore + 1, `list=${transport.listCount() - listBefore}`);

  // canonical identity: the host's row (not the requested path) wins.
  transport.workspaces = [row("/proj/alpha"), row("/home/u/new")];
  await adapter.addWorkspace("/home/u/new/../new");
  transport.workspaces = [row("/proj/alpha"), row("/home/u/new")];
  await sleep(PAST_WINDOW_MS);
  check("catálogo é a única fonte do cwd canônico (nunca derivado do path pedido)",
    adapter.getSnapshot().workspaces.map((w) => w.cwd).join(",") === "/proj/alpha,/home/u/new",
    adapter.getSnapshot().workspaces.map((w) => w.cwd).join(","));
  note("identidade real (realpath/symlink/trailing slash) do host NÃO foi exercitada — sem backend real");

  // non-live refusal: restart without a connection.
  const idle = newAdapter({ transportFactory: fakeWire().factory });
  const notConnected = await rejected(idle.restartWorkspace("/proj/alpha"));
  check("restartWorkspace sem conexão → not_connected (sem socket)",
    notConnected instanceof AdapterStateError && notConnected.code === "not_connected", notConnected?.code);
  const notConnectedAdd = await rejected(idle.addWorkspace("/proj/alpha"));
  check("addWorkspace sem conexão → not_connected",
    notConnectedAdd instanceof AdapterStateError && notConnectedAdd.code === "not_connected");
  idle.dispose();

  // fs default-hidden remains the existing contract (regression guard).
  await adapter.fsList("/tmp");
  check("fsList mantém showHidden=false por padrão na room HOST",
    transport.fsArgs[2].showHidden === false && transport.fsArgs[2].roomId === HOST_WEB_ROOM_ID);
  adapter.dispose();
}

// ── 11. transport-level errors surface unchanged ──────────────────────────
async function scenarioTransportErrors() {
  console.log("\n== 11. erros de transporte (regressão) ==");
  const wire = fakeWireFor([row("/proj/alpha")]);
  const adapter = newAdapter({ transportFactory: wire.factory });
  await pairAdapter(wire, adapter);
  const transport = wire.list[0];
  transport.failList = new TransportError("request_timeout");
  const err = await rejected(adapter.refreshWorkspaces());
  check("falha de list continua tipada (request_timeout), não vira superseded",
    err instanceof TransportError && err.code === "request_timeout", err?.code);
  transport.failList = null;

  // a stale flow's FAILURE must not surface as the current flow's error.
  const wire2 = fakeWireFor([row("/proj/alpha")]);
  const adapter2 = newAdapter({ transportFactory: wire2.factory });
  await pairAdapter(wire2, adapter2);
  const held = gate();
  wire2.list[0].holdList = held;
  wire2.list[0].failList = new TransportError("connection_lost");
  const pending = adapter2.refreshWorkspaces();
  await tick();
  adapter2.close();
  wire2.list[0].holdList = null;
  held.resolve();
  const staleErr = await rejected(pending);
  check("erro de um flow obsoleto NÃO vaza como erro da conexão atual",
    staleErr instanceof AdapterStateError && staleErr.code === "superseded", staleErr?.code);
  adapter2.dispose();
  adapter.dispose();
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("verify-web-workspaces — Wave 3 (restart/add/state)");
  await scenarioRestartRequest();
  await scenarioRestartErrors();
  await scenarioAddWorkspace();
  await scenarioPushNeverSettles();
  await scenarioPushGuard();
  await scenarioAdapterProjection();
  await scenarioAdapterInvalidation();
  await scenarioAdapterFencing();
  await scenarioAdapterCalls();
  await scenarioTransportErrors();
  closeAll();
  disposeAllAdapters();
  await sleep(40);
  check("nenhuma promise rejeitada sem handler", unhandled.length === 0, unhandled.join(" | "));
  console.log(failures === 0 ? "\nverify-web-workspaces: ALL PASS\n" : `\nverify-web-workspaces: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  await main();
} finally {
  closeAll();
  disposeAllAdapters();
}
