/**
 * TRANSPORT-ONLY verification of the minimal web client (plan 69 W4, wave 2)
 * against a FAKE FORMAL WIRE — no relay, no daemon, no filesystem.
 *
 * The code under test is the real `src/lib/remote-pi/client.ts` (Node 22 runs
 * the TypeScript directly) with only the socket factory and the handshake
 * timeouts injected. The fake host speaks the SAME formal envelope as the
 * relay/daemon: `encodeCt`/`encodeOuter` from `src/lib/remote-pi/protocol.ts`
 * on the way in, `decodeOuterChecked` inside the client on the way out. No new
 * wire is exercised here.
 *
 * Covered (one generation, cleanup, and reply-binding guarantees):
 *   open/hello/auth happy path · challenge timeout · close-after-auth ·
 *   close during signer creation and during sign (no late open/send) ·
 *   wrong peer · wrong outer room · proxy child room with the SAME
 *   in_reply_to as a live host RPC · wrong reply kind · late reply ·
 *   duplicate reply · unmatched reply · valid push · identical chunks kept ·
 *   malformed frame/envelope/ct/proxy · action_error action+code allow-list ·
 *   child-room allow-list · host rebind refusal · concurrent connect ·
 *   close with pending requests · unexpected relay drop.
 *
 * Run: node scripts/verify-web-transport.mjs
 */

import { RemotePiWebClient, WEB_CLIENT_SUBPROTOCOL } from "../src/lib/remote-pi/client.ts";
import {
  ActionRejectedError,
  ProtocolFrameError,
  decodeCt,
  encodeCt,
  normalizeRelayUrl,
} from "../src/lib/remote-pi/protocol.ts";
import { createEd25519Signer } from "../src/lib/remote-pi/ed25519.ts";

const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const OTHER_EPK = Buffer.alloc(32, 9).toString("base64");
const RELAY_URL = "https://relay.test/ws/";

let failures = 0;
const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(String(err)));

function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settledWithin(promise, ms = 40) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return done;
}

async function until(fn, ms = 500) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("until: timeout");
    await sleep(5);
  }
}

/** A WebSocket double with the browser surface the client uses. */
class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.sent = [];
    this.closed = false;
    this.closeCount = 0;
  }
  addEventListener(type, listener) { this.handlers[type].push(listener); }
  removeEventListener(type, listener) { this.handlers[type] = this.handlers[type].filter((l) => l !== listener); }
  totalListeners() { return Object.values(this.handlers).reduce((n, list) => n + list.length, 0); }
  send(data) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    this.onSend?.(frame);
  }
  close() {
    this.closeCount += 1;
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
  emit(type, event) { for (const listener of [...this.handlers[type]]) listener(event); }
  open() { this.emit("open", {}); }
  deliver(frame) {
    if (this.closed) return;
    this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  /** Inner messages the client SENT (outer envelopes only). */
  outers() { return this.sent.filter((frame) => typeof frame.ct === "string").map((frame) => decodeCt(frame.ct)); }
}

/** Fake host: dials a socket, answers `hello` with a challenge, records. */
class Wire {
  constructor(options = {}) {
    this.hostEpk = options.hostEpk ?? HOST_EPK;
    this.nonce = options.nonce ?? Buffer.alloc(32, 3).toString("base64");
    this.openOnDial = options.openOnDial ?? true;
    this.challengeOnHello = options.challengeOnHello ?? true;
    this.closeOnAuth = options.closeOnAuth ?? false;
    this.sockets = [];
    this.handler = null;
  }
  factory = (url, protocols) => {
    const socket = new FakeSocket(url, protocols);
    this.sockets.push(socket);
    socket.onSend = (frame) => this.onFrame(socket, frame);
    if (this.openOnDial) queueMicrotask(() => socket.open());
    return socket;
  };
  onFrame(socket, frame) {
    const inner = typeof frame.ct === "string" ? decodeCt(frame.ct) : frame;
    if (inner.type === "hello" && this.challengeOnHello) {
      socket.deliver({ type: "challenge", nonce: this.nonce });
    }
    if (inner.type === "auth" && this.closeOnAuth) socket.close();
    this.handler?.(socket, inner);
  }
  get socket() { return this.sockets[this.sockets.length - 1]; }
  /** Delivers one formal envelope to the client. */
  deliver(inner, { peer = null, room = "host" } = {}) {
    this.socket.deliver({ peer: peer ?? this.hostEpk, room, ct: encodeCt(inner) });
  }
  deliverRaw(text) { this.socket.deliver(text); }
}

const clients = [];
function track(client) { clients.push(client); return client; }
function closeAll() {
  for (const client of clients) {
    try { client.close(); } catch { /* already closed */ }
  }
  clients.length = 0;
}

const TIME = { openMs: 300, challengeMs: 250, authGraceMs: 40, requestMs: 250, signerMs: 800 };

function newClient(wire, options = {}) {
  return track(new RemotePiWebClient({
    relayUrl: options.relayUrl ?? RELAY_URL,
    webSocketFactory: wire.factory,
    deviceName: "verify-web-transport",
    timeouts: { ...TIME, ...(options.timeouts ?? {}) },
    ...(options.signerFactory ? { signerFactory: options.signerFactory } : {}),
    ...(options.forceBackend ? { forceBackend: options.forceBackend } : {}),
  }));
}

async function connected(wire, options = {}) {
  const client = newClient(wire, options);
  await client.connect();
  return client;
}

function pairTarget(wire) {
  return { token: "pair-token", hostEpk: wire.hostEpk, name: "host", roomId: "host" };
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

/** Rejects a promise and returns the error (or null when it resolved). */
async function rejected(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** Every string a caller could render off an exception — used to prove that
 *  no wire-supplied value survives on it. */
function dumpOf(err) {
  return [err?.message, err?.name, err?.code, err?.action, err?.safeMessage, JSON.stringify({ ...err }), String(err?.stack).split("\n")[0]].join("|");
}

/** The client peer id, or null when the ephemeral key was released. */
function peerIdOrNull(client) {
  try {
    return client.peerId;
  } catch {
    return null;
  }
}

// ── 1. handshake: hello → challenge → auth, all bounded and tracked ─────────
async function scenarioHandshake() {
  console.log("\n== 1. handshake (hello → challenge → auth) ==");
  const wire = new Wire();
  const client = await connected(wire);
  const socket = wire.socket;
  const hello = socket.sent[0];
  const auth = socket.sent[1];

  check("connect resolve com peer Ed25519 (44 chars base64)", client.connected && client.peerId.length === 44, client.peerId.slice(0, 8) + "…");
  check("hello na room \"host\" com a pubkey do signer", hello.type === "hello" && hello.room_id === "host" && hello.pubkey === client.peerId);
  check("auth = {type, sig} sem id e sem alg", auth.type === "auth" && typeof auth.sig === "string" && !("id" in auth) && Object.keys(auth).length === 2, Object.keys(auth).join(","));
  check("nenhum Sec-WebSocket-Protocol pedido (edge CF engole o echo)", Array.isArray(socket.protocols) && socket.protocols.length === 0, WEB_CLIENT_SUBPROTOCOL);
  check("relayUrl https→wss + barra final removida (normalizeRelayUrl)", client.relayPeerUrl === "wss://relay.test/ws" && normalizeRelayUrl(RELAY_URL) === "wss://relay.test/ws", client.relayPeerUrl);
  check("peer do host ainda NÃO vinculado antes da 1ª operação", client.boundHostPeer === null);
  check("só os 2 listeners pós-handshake ficam no socket (message/close)", socket.totalListeners() === 2, `listeners=${socket.totalListeners()}`);
  client.close();
}

// ── 2. challenge timeout: bounded wait + full cleanup ──────────────────────
async function scenarioChallengeTimeout() {
  console.log("\n== 2. challenge timeout ==");
  const wire = new Wire({ challengeOnHello: false });
  const client = newClient(wire, { timeouts: { challengeMs: 120 } });
  const err = await rejected(client.connect());
  check("connect rejeitado com code challenge_timeout", err?.code === "challenge_timeout", err?.code);
  check("socket fechado e SEM listeners depois da falha", wire.socket.closed === true && wire.socket.totalListeners() === 0, `listeners=${wire.socket.totalListeners()}`);
  check("chave efêmera liberada após rejeição do handshake", peerIdOrNull(client) === null);
  client.close();

  // A malformed `challenge` frame is untrusted input: `null`, a primitive or
  // a non-string `nonce` must be declined INSIDE the socket callback (a bare
  // `parsed.type` on `null` would throw from the listener) and the handshake
  // must keep waiting for a well-formed one.
  const wire2 = new Wire();
  const client2 = newClient(wire2, { timeouts: { challengeMs: 200 } });
  const pending2 = client2.connect();
  await until(() => wire2.sockets.length === 1 && wire2.socket.sent.length >= 1);
  wire2.socket.deliver("null");
  wire2.socket.deliver("42");
  wire2.socket.deliver(JSON.stringify({ type: "challenge", nonce: null }));
  await tick();
  wire2.socket.deliver({ type: "challenge", nonce: wire2.nonce });
  const afterJunk = await rejected(pending2);
  check("challenge null/primitivo/nonce não-string é declinado sem throw do callback", afterJunk === null, afterJunk?.message);
  check("challenge válido depois do lixo resolve o connect", client2.connected === true);
  client2.close();

  // ... and a wire that only ever sends junk still fails with a BOUNDED error
  // (an ignored frame must not leave the handshake hanging forever).
  const wire3 = new Wire({ challengeOnHello: false });
  const client3 = newClient(wire3, { timeouts: { challengeMs: 120 } });
  const pending3 = client3.connect();
  await until(() => wire3.sockets.length === 1 && wire3.socket.sent.length >= 1);
  wire3.socket.deliver("null");
  wire3.socket.deliver(JSON.stringify({ type: "challenge", nonce: 7 }));
  const junkErr = await rejected(pending3);
  check("só lixo de challenge → erro limitado challenge_timeout", junkErr?.code === "challenge_timeout", junkErr?.code);
  check("handshake com lixo ainda limpa socket e chave", wire3.socket.totalListeners() === 0 && peerIdOrNull(client3) === null);
  client3.close();

  // An `error` event (not a close) while the handshake is in flight is a
  // failed connect too — it must be handled by the SAME armed gate, in a step
  // that only tracks message/close (the pre-fix gap swallowed it).
  const wire4 = new Wire();
  const client4 = newClient(wire4);
  const pending4 = client4.connect();
  await until(() => wire4.sockets.length === 1 && wire4.socket.sent.length >= 1);
  wire4.socket.emit("error", {});
  const errorErr = await rejected(pending4);
  check("error do socket durante o handshake → connect_failed", errorErr?.code === "connect_failed", errorErr?.code);
  check("error do socket durante o handshake limpa listeners e chave", wire4.socket.totalListeners() === 0 && peerIdOrNull(client4) === null);
  client4.close();
}

// ── 3. relay closes right after auth (bad signature) ───────────────────────
async function scenarioAuthClose() {
  console.log("\n== 3. close logo após auth ==");
  const wire = new Wire({ closeOnAuth: true });
  const client = newClient(wire, { timeouts: { authGraceMs: 150 } });
  const err = await rejected(client.connect());
  check("connect rejeitado com code auth_rejected", err?.code === "auth_rejected", err?.code);
  check("cliente não fica connected e libera o signer", client.connected === false && peerIdOrNull(client) === null);
  client.close();
}

// ── 4. close() during signer creation: no late open ────────────────────────
async function scenarioCloseDuringSigner() {
  console.log("\n== 4. close durante a criação do signer ==");
  const wire = new Wire();
  let releaseSigner = null;
  const signerGate = new Promise((resolve) => { releaseSigner = resolve; });
  const client = newClient(wire, {
    signerFactory: async () => {
      const real = await createEd25519Signer("webcrypto");
      await signerGate;
      return real;
    },
  });
  const pendingConnect = client.connect();
  client.close();
  const err = await rejected(pendingConnect);
  check("connect rejeitado com code closed", err?.code === "closed", err?.code);
  releaseSigner();
  await sleep(60);
  check("nenhum socket foi aberto depois do close (late open impedido)", wire.sockets.length === 0, `sockets=${wire.sockets.length}`);
  client.close(); // idempotente
  const terminal = await rejected(client.connect());
  check("close é idempotente e terminal", terminal?.code === "closed", terminal?.code);
}

// ── 5. close() during sign(): old callback is inert ────────────────────────
async function scenarioCloseDuringSign() {
  console.log("\n== 5. close durante o sign ==");
  const wire = new Wire();
  let releaseSign = null;
  const signGate = new Promise((resolve) => { releaseSign = resolve; });
  let signCalled = false;
  const real = await createEd25519Signer("webcrypto");
  const client = newClient(wire, {
    signerFactory: async () => ({
      publicKeyRaw: real.publicKeyRaw,
      publicKeyBase64: real.publicKeyBase64,
      backend: real.backend,
      sign: async () => {
        signCalled = true;
        return signGate;
      },
    }),
  });
  const pendingConnect = client.connect();
  await until(() => signCalled);
  const sentBefore = wire.socket.sent.length;
  client.close();
  const err = await rejected(pendingConnect);
  check("connect rejeitado com code closed durante o sign", err?.code === "closed", err?.code);
  releaseSign(new Uint8Array(64));
  await sleep(60);
  check("nenhum frame de auth enviado depois do close (generation stale)", wire.socket.sent.length === sentBefore && wire.socket.closed === true, `sent=${wire.socket.sent.length}/${sentBefore}`);

  // The OTHER close path: the PEER (not the caller) closes the socket while
  // the signer is signing. Client-side `close()` was already covered; here
  // the handshake itself must fail WITHOUT caller help — before the signature
  // arrives — because a real WebSocket silently discards `send` after a
  // close, so a later resolve would report a dead socket as connected.
  const wire2 = new Wire();
  let releaseSign2 = null;
  const signGate2 = new Promise((resolve) => { releaseSign2 = resolve; });
  let signCalled2 = false;
  const client2 = newClient(wire2, {
    signerFactory: async () => ({
      publicKeyRaw: real.publicKeyRaw,
      publicKeyBase64: real.publicKeyBase64,
      backend: real.backend,
      sign: async () => {
        signCalled2 = true;
        return signGate2;
      },
    }),
  });
  const pendingConnect2 = client2.connect();
  await until(() => signCalled2);
  const socket2 = wire2.socket;
  let settled2 = false;
  pendingConnect2.then(() => { settled2 = true; }, () => { settled2 = true; });
  const closeHandlers = socket2.handlers.close.length;
  socket2.close();
  await tick();
  check("handler de falha do handshake fica armado durante o sign (gap coberto)", closeHandlers >= 1, `close=${closeHandlers}`);
  check("close do peer durante o sign rejeita ANTES do signer responder", settled2 === true);
  const peerCloseErr = await rejected(pendingConnect2);
  check("close do peer durante o sign → connect_failed", peerCloseErr?.code === "connect_failed", peerCloseErr?.code);
  releaseSign2(new Uint8Array(64));
  await sleep(60);
  check("nenhum auth enviado no socket já fechado pelo peer", !socket2.sent.some((frame) => frame.type === "auth"), socket2.sent.map((frame) => frame.type).join(","));
  check("handshake falho pelo peer solta socket (0 listeners) e chave efêmera", socket2.totalListeners() === 0 && peerIdOrNull(client2) === null, `listeners=${socket2.totalListeners()}`);
  check("connect não resolve tarde depois da falha do peer", client2.connected === false);
  client2.close();
}

// ── 6. wrong peer / wrong outer room ───────────────────────────────────────
async function scenarioPeerAndRoom() {
  console.log("\n== 6. peer/room do envelope ==");
  const wire = new Wire();
  const client = await connected(wire);
  const diags = [];
  const pushes = [];
  client.onDiagnostic((code) => diags.push(code));
  client.onServerMessage((msg) => pushes.push(msg));

  const pending = client.fsList(wire.hostEpk, "/tmp");
  const id = wire.socket.outers()[0].id;
  wire.deliver(fsListOk(id), { peer: OTHER_EPK });
  wire.deliver(fsListOk(id), { room: "workspace-x" });
  await tick();
  check("envelope de outro peer → unexpected_peer", diags.includes("unexpected_peer"), diags.join(","));
  check("envelope em room fora de \"host\" → unexpected_room", diags.includes("unexpected_room"), diags.join(","));
  check("a RPC continua pendente (nem peer nem room estranhos respondem)", (await settledWithin(pending)) === false);
  wire.deliver(fsListOk(id));
  check("resposta legítima do host resolve a RPC", (await pending).path === "/tmp");
  check("nada foi entregue aos listeners por engano", pushes.length === 0);
  client.close();
}

// ── 7. proxy child room + same in_reply_to never settles a host RPC ────────
async function scenarioProxyChildRoom() {
  console.log("\n== 7. host_message (child room) ==");
  const wire = new Wire();
  const client = await connected(wire);
  const diags = [];
  const pushes = [];
  client.onDiagnostic((code) => diags.push(code));
  client.onServerMessage((msg, room) => pushes.push({ msg, room }));

  const list = client.listWorkspaces(wire.hostEpk);
  wire.deliver(wsListOk(wire.socket.outers()[0].id, ["room-alpha"]));
  const listed = await list;
  check("workspace_list_ok resolve e aprende a child room", listed.workspaces[0].room_id === "room-alpha");

  const pending = client.fsList(wire.hostEpk, "/tmp");
  const id = wire.socket.outers()[1].id;
  wire.deliver({ type: "host_message", room: "room-alpha", ct: encodeCt(fsListOk(id, "/hijack")) });
  await tick();
  check("child room com o MESMO in_reply_to NÃO resolve a RPC do host", (await settledWithin(pending)) === false);
  check("payload do proxy chega ao listener na room filha", pushes.some((p) => p.room === "room-alpha" && p.msg.path === "/hijack"));
  check("room \"host\" dentro do proxy é recusada", (() => { wire.deliver({ type: "host_message", room: "host", ct: encodeCt(fsListOk(id)) }); return diags.includes("unknown_child_room"); })());
  check("child room arbitrária é recusada", (() => { wire.deliver({ type: "host_message", room: "evil-room", ct: encodeCt(fsListOk(id)) }); return diags.filter((d) => d === "unknown_child_room").length >= 2; })());
  check("proxy aninhado é recusado", (() => {
    wire.deliver({ type: "host_message", room: "room-alpha", ct: encodeCt({ type: "host_message", room: "room-alpha", ct: "x" }) });
    return diags.includes("malformed_proxy");
  })());
  wire.deliver(fsListOk(id));
  check("resposta direta do host (mesma RPC) resolve", (await pending).path === "/tmp");
  client.close();
}

// ── 8. reply-kind binding: wrong kind / late / duplicate / unmatched ───────
async function scenarioReplyBinding() {
  console.log("\n== 8. binding do reply ==");
  const wire = new Wire();
  const client = await connected(wire);
  const diags = [];
  const pushes = [];
  client.onDiagnostic((code) => diags.push(code));
  client.onServerMessage((msg) => pushes.push(msg));

  // 8a. wrong kind.
  const pending = client.fsList(wire.hostEpk, "/tmp");
  const id = wire.socket.outers()[0].id;
  wire.deliver(wsListOk(id, []));
  await tick();
  check("reply de tipo errado → wrong_response_kind e RPC segue pendente", diags.includes("wrong_response_kind") && (await settledWithin(pending)) === false);
  wire.deliver(fsListOk(id));
  check("o reply correto (mesmo id) resolve", (await pending).path === "/tmp");

  // 8b. duplicate.
  const list = client.listWorkspaces(wire.hostEpk);
  const listId = wire.socket.outers()[1].id;
  wire.deliver(wsListOk(listId, ["room-a"]));
  await list;
  wire.deliver(wsListOk(listId, ["room-a"]));
  await tick();
  check("reply repetido → duplicate_reply (não vira push)", diags.includes("duplicate_reply") && pushes.length === 0, diags.join(","));

  // 8c. unmatched reply.
  wire.deliver(fsListOk("id-nunca-registrado"));
  await tick();
  check("reply sem RPC correspondente → unknown_reply e NÃO é push", diags.includes("unknown_reply") && pushes.length === 0);

  // 8d. late reply after timeout.
  const timingOut = client.fsList(wire.hostEpk, "/late", { roomId: "host" });
  const lateId = wire.socket.outers()[wire.socket.outers().length - 1].id;
  const timeoutErr = await rejected(timingOut);
  check("RPC sem resposta → request_timeout", timeoutErr?.code === "request_timeout", timeoutErr?.code);
  wire.deliver(fsListOk(lateId));
  await tick();
  check("reply depois do timeout → late_reply e NÃO é push", diags.includes("late_reply") && pushes.length === 0);

  // 8e. a real push (no in_reply_to) does reach the listeners.
  wire.deliver({ type: "workspace_event", event: "started" });
  await tick();
  check("push não correlacionado chega ao listener (room \"host\")", pushes.length === 1 && pushes[0].type === "workspace_event", JSON.stringify(pushes[0] ?? null));

  // 8f. identical chunks are NOT deduped (no event seq) and keep their room.
  const list2 = client.listWorkspaces(wire.hostEpk);
  wire.deliver(wsListOk(wire.socket.outers()[wire.socket.outers().length - 1].id, ["room-beta"]));
  await list2;
  const chunk = { type: "agent_chunk", in_reply_to: "turn-desconhecido", delta: "mesmo" };
  wire.deliver({ type: "host_message", room: "room-beta", ct: encodeCt(chunk) });
  wire.deliver({ type: "host_message", room: "room-beta", ct: encodeCt(chunk) });
  await tick();
  const chunks = pushes.filter((m) => m.type === "agent_chunk");
  check("chunk de turno desconhecido é encaminhado room-scoped (não dropado)", chunks.length === 2 && pushes.some((m) => m.type === "agent_chunk" && m.delta === "mesmo"), `chunks=${chunks.length}`);

  client.close();
}

// ── 9. malformed frames → fixed diagnostics, never a crash ────────────────
async function scenarioMalformed() {
  console.log("\n== 9. frames malformados ==");
  const wire = new Wire();
  const client = await connected(wire);
  const diags = [];
  const pushes = [];
  client.onDiagnostic((code) => diags.push(code));
  client.onServerMessage((msg) => pushes.push(msg));
  // Bind the host first (the hostile batch below must be judged by the
  // session it claims to belong to, not by the unbound state).
  client.sendChat(wire.hostEpk, "room-warm", "oi");
  const count = (code) => diags.filter((d) => d === code).length;
  const before = () => ({ frame: count("malformed_frame"), env: count("malformed_envelope"), ct: count("malformed_ct") });

  const start = before();
  wire.deliverRaw("nao é json");
  wire.deliverRaw(JSON.stringify({ peer: wire.hostEpk, ct: encodeCt({ type: "x" }) })); // 2 chaves
  wire.deliverRaw(JSON.stringify({ peer: wire.hostEpk, room: "host", ct: "!!!nao-base64!!!" }));
  wire.deliverRaw(JSON.stringify({ peer: wire.hostEpk, room: "host", ct: encodeCt(null) }));
  wire.deliverRaw(JSON.stringify({ peer: wire.hostEpk, room: "host", ct: encodeCt("texto") }));
  wire.deliverRaw(JSON.stringify({ peer: wire.hostEpk, room: "host", ct: encodeCt({ type: 5 }) }));
  await tick();
  check("texto inválido → malformed_frame", count("malformed_frame") === start.frame + 1);
  check("envelope sem as 3 chaves → malformed_envelope", count("malformed_envelope") === start.env + 1);
  check("ct não-base64 / null / string / type errado → malformed_ct", count("malformed_ct") === start.ct + 4, `ct=${count("malformed_ct") - start.ct}`);

  wire.deliver({ type: "fs_list_ok", in_reply_to: null, path: "/", parent: null, entries: [] });
  check("in_reply_to null (não-string) é recusado antes de qualquer match", count("malformed_ct") === start.ct + 5);
  wire.deliver({ type: "host_message", in_reply_to: "x" });
  check("host_message sem room/ct → malformed_proxy", count("malformed_proxy") === 1, diags.join(","));
  check("nenhum frame malformado virou push", pushes.length === 0);

  // The client is still fully usable after the hostile batch.
  const ok = client.fsList(wire.hostEpk, "/ainda-vivo");
  wire.deliver(fsListOk(wire.socket.outers().slice(-1)[0].id, "/ainda-vivo"));
  check("transporte segue operante depois dos frames hostis", (await ok).path === "/ainda-vivo");
  client.close();
}

// ── 10. action_error: action binding + fixed safe text ────────────────────
async function scenarioActionErrors() {
  console.log("\n== 10. action_error ==");
  const wire = new Wire();
  const client = await connected(wire);
  const diags = [];
  client.onDiagnostic((code) => diags.push(code));

  const pending = client.fsList(wire.hostEpk, "/etc");
  const id = wire.socket.outers()[0].id;
  wire.deliver({ type: "action_error", in_reply_to: id, action: "workspace_start", error: "/etc/passwd" });
  await tick();
  check("action_error de OUTRA action não responde o fs_list (wrong_action_error)", diags.includes("wrong_action_error") && (await settledWithin(pending)) === false);
  wire.deliver({ type: "action_error", in_reply_to: id, action: "fs_list" });
  await tick();
  check("action_error sem `error` string → malformed_reply", diags.includes("malformed_reply") && (await settledWithin(pending)) === false);
  wire.deliver({ type: "action_error", in_reply_to: id, action: "fs_list", error: "/etc/passwd" });
  const err = await rejected(pending);
  check("action_error válido → ActionRejectedError", err instanceof ActionRejectedError && err.code === "unknown");
  check("`error` desconhecido NÃO fica retido no code da exceção (fallback fixo)", err.code === "unknown" && !dumpOf(err).includes("/etc/passwd"), err.code);
  check("ação allow-listed preservada (fs_list)", err.action === "fs_list", err.action);
  check("texto do erro é FIXO (não vaza o `error` do host)", !String(err.message).includes("/etc/passwd") && err.safeMessage === "The host rejected this action.", err.message);

  const known = client.fsList(wire.hostEpk, "/nao-existe");
  wire.deliver({ type: "action_error", in_reply_to: wire.socket.outers()[1].id, action: "fs_list", error: "not_found" });
  const notFound = await rejected(known);
  check("code allow-listed → mensagem fixa do code", notFound instanceof ActionRejectedError && notFound.code === "not_found" && notFound.message === "fs_list rejected: Path not found.", notFound?.message);

  // The host also controls `action` when the request declares no expected
  // action (host_hello): a hostile action name must not reach the exception
  // through the message or any other property.
  const helloPending = client.helloHost(wire.hostEpk);
  wire.deliver({ type: "action_error", in_reply_to: wire.socket.outers().slice(-1)[0].id, action: "TOKEN-CANARY", error: "TOKEN-CANARY" });
  const hostile = await rejected(helloPending);
  check("action hostil → rótulo genérico, token não vaza na exceção", hostile instanceof ActionRejectedError && hostile.action === "action" && !dumpOf(hostile).includes("TOKEN-CANARY"), hostile?.message);
  check("mensagem do action_error hostil é genérica", hostile?.message === "action rejected: The host rejected this action.", hostile?.message);
  client.close();
}

// ── 11. pair: reply validation, pair_error mapping, runtime guards ────────
async function scenarioPair() {
  console.log("\n== 11. pair_request ==");
  const wire = new Wire();
  const client = await connected(wire);
  const target = pairTarget(wire);

  const first = client.pair(target);
  wire.deliver({ type: "pair_error", in_reply_to: wire.socket.outers()[0].id, code: "token_expired", message: "token=segredo /etc/passwd" });
  const pairErr = await rejected(first);
  check("pair_error → PairRejectedError com code tipado", pairErr?.code === "token_expired", pairErr?.code);
  check("mensagem do pair_error não reflete texto do host", !String(pairErr.message).includes("segredo") && !String(pairErr.message).includes("/etc/passwd"), pairErr?.message);

  const second = client.pair(target);
  wire.deliver({ type: "pair_ok", in_reply_to: wire.socket.outers()[1].id, session_name: "host", room_id: "host" });
  const guardErr = await rejected(second);
  check("pair_ok sem session_started_at é validado em runtime (não cast)", guardErr instanceof ProtocolFrameError && guardErr.code === "unexpected_reply");

  const third = client.pair(target);
  wire.deliver({ type: "pair_ok", in_reply_to: wire.socket.outers()[2].id, session_name: "host", session_started_at: 1_700_000_000, room_id: "host", hostname: "pi" });
  const ok = await third;
  check("pair_ok válido resolve com room_id", ok.type === "pair_ok" && ok.room_id === "host" && ok.session_name === "host");

  const diags = [];
  client.onDiagnostic((code) => diags.push(code));
  const list = client.listWorkspaces(wire.hostEpk);
  wire.deliver({ type: "workspace_list_ok", in_reply_to: wire.socket.outers()[3].id, workspaces: [{ cwd: "/x", daemon_id: "d", room_id: "r", name: "x", live: "true", daemon: true, source: "added" }] });
  const closeAllGood = await rejected(list);
  check("workspace entry com live não-booleano é recusada (guards de runtime)", closeAllGood instanceof ProtocolFrameError, String(closeAllGood));
  client.close();
}

// ── 12. host binding: rebind + sendChat room allow-list ───────────────────
async function scenarioHostBinding() {
  console.log("\n== 12. binding do host ==");
  const wire = new Wire();
  const client = await connected(wire);

  // The FIRST host operation binds the peer this client will ever trust.
  const hello = client.helloHost(wire.hostEpk, "host");
  wire.deliver({ type: "host_hello_ok", in_reply_to: wire.socket.outers()[0].id, daemon: { version: "1", hostname: "pi", platform: "linux" }, capabilities: ["fs_nav"] });
  await hello;
  check("a 1ª operação vincula o peer do host", client.boundHostPeer === wire.hostEpk);

  const before = wire.socket.sent.length;
  const rebind = await rejected(client.helloHost(OTHER_EPK, "host"));
  check("2º host recusado (host_rebind_refused)", rebind?.code === "host_rebind_refused", rebind?.code);
  check("nenhum frame foi enviado para o outro host", wire.socket.sent.length === before);
  check("o host vinculado continua o mesmo", client.boundHostPeer === wire.hostEpk);

  const messageId = client.sendChat(wire.hostEpk, "room-chat", "olá");
  const forward = wire.socket.outers()[1];
  const inner = decodeCt(forward.ct);
  check("sendChat usa host_forward{room, ct} com o id interno", forward.type === "host_forward" && forward.room === "room-chat" && inner.id === messageId && inner.type === "user_message", forward.type);
  const pushes = [];
  client.onServerMessage((msg, room) => pushes.push({ msg, room }));
  wire.deliver({ type: "host_message", room: "room-chat", ct: encodeCt({ type: "user_message", id: messageId, text: "olá" }) });
  await tick();
  check("echo do chat volta pelo proxy com a room do workspace", pushes.length === 1 && pushes[0].room === "room-chat" && pushes[0].msg.id === messageId);
  client.close();
}

// ── 13. close with pending + unexpected relay drop ───────────────────────
async function scenarioCloseAndDrop() {
  console.log("\n== 13. close com pendências e drop inesperado ==");
  const wire = new Wire();
  const client = await connected(wire);
  const pending = client.fsList(wire.hostEpk, "/tmp");
  await tick();
  client.close();
  const err = await rejected(pending);
  check("close rejeita RPC pendente com code closed", err?.code === "closed", err?.code);
  check("close detachou todos os listeners do socket", wire.socket.totalListeners() === 0, `listeners=${wire.socket.totalListeners()}`);
  const afterClose = await rejected(client.pair(pairTarget(wire)));
  check("close fechou o socket e liberou a chave", wire.socket.closed === true && client.connected === false && afterClose?.code === "closed", afterClose?.code);

  // A second, independent connection for the DROP path.
  const wire2 = new Wire();
  const client2 = await connected(wire2);
  const closes = [];
  client2.onClose((code) => closes.push(code));
  const pending2 = client2.fsList(wire2.hostEpk, "/tmp");
  await tick();
  wire2.socket.close();
  const dropErr = await rejected(pending2);
  check("drop do relay rejeita pendências com connection_lost", dropErr?.code === "connection_lost", dropErr?.code);
  check("drop inesperado notifica o adapter (relay_dropped)", closes.length === 1 && closes[0] === "relay_dropped", closes.join(","));
  check("estado pós-drop: não connected e listeners antigos removidos", client2.connected === false && wire2.socket.totalListeners() === 0);
  wire2.socket.deliver({ type: "fs_list_ok", path: "/late", parent: null, entries: [] });
  check("drop não é terminal: a RPC volta a exigir connect (not_connected)", (await rejected(client2.fsList(wire2.hostEpk, "/tmp")))?.code === "not_connected");
  client2.close();
}

// ── 14. concurrent connect + close()-only notification rules ──────────────
async function scenarioConcurrentConnect() {
  console.log("\n== 14. connect concorrente ==");
  const wire = new Wire({ openOnDial: false });
  const client = newClient(wire);
  const closes = [];
  client.onClose((code) => closes.push(code));
  const first = client.connect();
  const second = await rejected(client.connect());
  check("2º connect concorrente recusado (connecting)", second?.code === "connecting", second?.code);
  await until(() => wire.sockets.length === 1);
  wire.socket.open();
  await first;
  check("o 1º connect conclui normalmente", client.connected === true);
  client.close();
  await sleep(20);
  check("close() explícito NÃO notifica onClose (só drop inesperado)", closes.length === 0, closes.join(","));
  const afterClose = await rejected(client.connect());
  check("close é terminal para novos connects", afterClose?.code === "closed", afterClose?.code);
}

// ── 15. the pure-ts backend still drives the same transport ──────────────
async function scenarioFallbackBackend() {
  console.log("\n== 15. backend pure-ts no mesmo transporte ==");
  const wire = new Wire();
  const client = await connected(wire, { forceBackend: "pure-ts" });
  check("handshake ok com pure-ts (signer reaproveitado, sem wire novo)", client.backend === "pure-ts" && client.peerId.length === 44);
  client.close();
}

async function main() {
  console.log("verify-web-transport — fake formal wire (sem relay, sem daemon)");
  await scenarioHandshake();
  await scenarioChallengeTimeout();
  await scenarioAuthClose();
  await scenarioCloseDuringSigner();
  await scenarioCloseDuringSign();
  await scenarioPeerAndRoom();
  await scenarioProxyChildRoom();
  await scenarioReplyBinding();
  await scenarioMalformed();
  await scenarioActionErrors();
  await scenarioPair();
  await scenarioHostBinding();
  await scenarioCloseAndDrop();
  await scenarioConcurrentConnect();
  await scenarioFallbackBackend();
  closeAll();
  await sleep(30);
  check("nenhuma promise rejeitada sem handler", unhandled.length === 0, unhandled.join(" | "));
  console.log(failures === 0 ? "\nverify-web-transport: ALL PASS\n" : `\nverify-web-transport: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  await main();
} finally {
  closeAll();
}
