#!/usr/bin/env node
// Spike D0 (Plano 69, W2, todo #4): uma conexão WS do app sustenta
// SIMULTANEAMENTE o room `host` + rooms de workspace?
//
// Pergunta fechada, respondida por evidência executável:
//   (A) multiplex confirmado  → W2 segue primário
//   (B) falhou                → ativa plano B `host_forward`/`host_message`
//
// Método: relay stub local que reproduz o contrato REAL do relay
// (`relay/src/handlers/peer.rs` + `relay/src/peers/registry.rs`) e clientes
// que reproduzem o comportamento REAL dos dois lados:
//   - app-like  → app/lib/data/transport/ws_transport.dart
//                 (hello room_id='main'; demux de entrada por sender room;
//                  setActiveRoom troca o room de saída SEM reconectar)
//   - host      → pi-extension/src/daemon/host_bridge.ts
//                 (conecta no room 'host'; _reply carimba room: HOST_ROOM_ID)
//   - pi        → pi-extension/src/transport/peer_channel.ts
//                 (responde {peer, ct} SEM room — produção atual)
//
// Uso: node scripts/spike-room-multiplex.mjs
// Saída: PASS/FAIL por experimento + decisão A/B. Exit 1 se algo falhar.

import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { createServer } from "node:http";
import { requireFromPiExtension } from "./e2e/paths.mjs";

const { WebSocket, WebSocketServer } = requireFromPiExtension("ws");

const HOST_ROOM_ID = "host";
const WS_ROOM = "kX9fT2mQwE7r"; // room de workspace (formato roomIdFor: 12 chars b64url)
const TIMEOUT_MS = 4000;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (pk) => pk.slice(-8);

// ─── Relay stub — contrato fiel ao relay Rust ────────────────────────────────
//
// Fidelidades relevantes para o spike (todas lidas do código de produto):
//   1. hello carrega UM room_id (default "main"); o registry é chaveado por
//      (peer_id, room_id) — peer.rs: registry.register(peer_id, room_meta, tx).
//   2. Envelope de entrada {peer, room, ct}: o relay REESCREVE com o peer_id e
//      o room_id do REMETENTE e entrega só nas conexões de (dest.peer,
//      dest.room) — peer.rs: `rewritten` + registry.forward(..).
//   3. Sem match de destino: drop com warn "dest (peer, room) not found" —
//      mesmo caminho que faz o e2e-pairing caso 2 silenciar.
//   4. Skip-sender por conn_id (multi-device do mesmo owner, plano 23).
//   5. Control frames {type}: subscribe_rooms / rooms_check — o catálogo de
//      rooms é por PEER, não por room (rooms_of agrega todos os rooms do peer).

class SpikeRelay {
  constructor() {
    this.server = null;
    this.wss = null;
    /** (peer, room) → Set<conn> — mesma forma do PeerRegistry.senders. */
    this.senders = new Map();
    /** Log cru de toda decisão de roteamento, para o relatório. */
    this.wire = [];
    this.nextConn = 1;
  }

  async listen() {
    this.server = createServer((_req, res) => res.writeHead(404).end());
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => this._onConnection(ws));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `ws://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  async close() {
    for (const set of this.senders.values()) for (const c of set) c.ws.close();
    await new Promise((resolve) => this.wss?.close(resolve));
    await new Promise((resolve) => this.server?.close(resolve));
  }

  _onConnection(ws) {
    const conn = { id: this.nextConn++, ws, roomId: null, pubkey: null, authed: false };
    let nonce = null;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "hello") {
        conn.roomId = msg.room_id || "main"; // peer.rs: unwrap_or("main")
        conn.pubkey = msg.pubkey;
        nonce = randomBytes(32);
        ws.send(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }));
        return;
      }
      if (msg.type === "auth") {
        let ok = false;
        try {
          const der = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(conn.pubkey, "base64"),
          ]);
          ok = verify(null, nonce, createPublicKey({ key: der, format: "der", type: "spki" }),
            Buffer.from(msg.sig, "base64"));
        } catch { ok = false; }
        if (!ok) { ws.send(JSON.stringify({ type: "error", code: "auth_failed" })); ws.close(); return; }
        conn.authed = true;
        const key = `${conn.pubkey}|${conn.roomId}`;
        if (!this.senders.has(key)) this.senders.set(key, new Set());
        this.senders.get(key).add(conn);
        this.wire.push({ ev: "register", peer: short(conn.pubkey), room: conn.roomId, conn: conn.id });
        return;
      }
      if (!conn.authed) return;

      // ── control frames (top-level "type") ──
      if (typeof msg.type === "string") {
        if (msg.type === "subscribe_rooms") {
          this.wire.push({ ev: "subscribe_rooms", from: short(conn.pubkey), peers: msg.peers?.length ?? 0 });
          return; // relay não dá ack explícito
        }
        if (msg.type === "rooms_check") {
          for (const target of msg.peers ?? []) {
            const rooms = this.roomsOf(target).map((r) => ({ room_id: r.room_id, name: r.name }));
            ws.send(JSON.stringify({ type: "rooms", peer: target, rooms }));
          }
          this.wire.push({ ev: "rooms_check", from: short(conn.pubkey), targets: msg.peers?.length ?? 0 });
          return;
        }
        this.wire.push({ ev: "unknown_control", type: msg.type });
        return;
      }

      // ── outer envelope {peer, room, ct} ──
      if (!msg.peer || !msg.ct) return;
      const destPeer = msg.peer;
      const destRoom = msg.room ?? "main"; // outer.rs: #[serde(default="main")]
      // Reescreve: destinatário vê o peer_id e o room_id do REMETENTE.
      const rewritten = { peer: conn.pubkey, room: conn.roomId, ct: msg.ct };
      const line = JSON.stringify(rewritten);
      const set = this.senders.get(`${destPeer}|${destRoom}`);
      let delivered = 0;
      if (set) {
        for (const other of set) {
          if (other.id === conn.id) continue; // skip-sender
          if (other.ws.readyState === WebSocket.OPEN) { other.ws.send(line); delivered++; }
        }
      }
      this.wire.push({
        ev: delivered > 0 ? "route" : "drop",
        from: `${short(conn.pubkey)}@${conn.roomId}`,
        dest: `${short(destPeer)}@${destRoom}`,
        delivered,
        note: delivered === 0 ? "dest (peer, room) not found, dropping" : undefined,
      });
    });

    ws.on("close", () => {
      if (conn.roomId) this.senders.get(`${conn.pubkey}|${conn.roomId}`)?.delete(conn);
      this.wire.push({ ev: "unregister", peer: short(conn.pubkey ?? "?"), room: conn.roomId, conn: conn.id });
    });
  }

  /** rooms_of: todos os rooms vivos de um peer (registry.rs). */
  roomsOf(peerId) {
    const out = [];
    for (const [key, set] of this.senders) {
      const [p, room] = key.split("|");
      if (p === peerId && set.size > 0) out.push({ room_id: room, name: room === HOST_ROOM_ID ? "host" : room });
    }
    return out;
  }
}

// ─── Cliente app-like — fiel a ws_transport.dart ─────────────────────────────
//
// Fidelidades: hello room_id='main' (app é client, não tem cwd); envio carrega
// {peer, room: _activeRoom, ct}; DEMUX de entrada — envelope com
// senderRoom != _activeRoom é DESCARTADO (ws_transport.dart:101, "Plan-18
// follow-up — DEMUX inbound by sender room"); control frames passam livres.

class AppLikeClient {
  constructor(relayUrl, keypair, { helloRoom = "main" } = {}) {
    this.relayUrl = relayUrl;
    this.kp = keypair;
    this.pubB64 = rawPubB64(keypair);
    this.helloRoom = helloRoom;
    this.activeRoom = "main"; // _activeRoom default
    this.inbox = [];          // payloads aceitos pelo demux
    this.dropped = [];        // payloads descartados pelo demux
    this.control = [];        // control frames
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.relayUrl);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    const challenge = new Promise((resolve, reject) => {
      this.ws.once("message", (raw) => {
        try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
      });
    });
    this.ws.send(JSON.stringify({ type: "hello", pubkey: this.pubB64, room_id: this.helloRoom }));
    const ch = await challenge;
    const sig = sign(null, Buffer.from(ch.nonce, "base64"), this.kp.privateKey);
    this.ws.send(JSON.stringify({ type: "auth", sig: sig.toString("base64") }));
    this.ws.on("message", (raw) => this._onLine(raw.toString()));
    this.ws.on("close", () => { this.closed = true; });
    await sleep(80); // relay não manda "ok" — roteamento começa após o auth
  }

  _onLine(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.peer && frame.ct) {
      const senderRoom = frame.room ?? null;
      // ── DEMUX idêntico ao do app (ws_transport.dart:101) ──
      if (senderRoom !== null && senderRoom !== this.activeRoom) {
        this.dropped.push({ sender: short(frame.peer), senderRoom, ct: frame.ct });
        return;
      }
      this.inbox.push({ sender: short(frame.peer), senderRoom, inner: unb64(frame.ct) });
      return;
    }
    if (frame.type) this.control.push(frame);
  }

  /** switchRoom do ConnectionManager: troca o room de saída SEM reconectar. */
  setActiveRoom(room) { this.activeRoom = room; }

  /** WsTransport.send: envelope carrega o _activeRoom. */
  send(peerPubB64, inner) {
    this.ws.send(JSON.stringify({ peer: peerPubB64, room: this.activeRoom, ct: b64(inner) }));
  }

  sendControl(frame) { this.ws.send(JSON.stringify(frame)); }

  async close() { this.closed = true; this.ws.close(); await sleep(50); }
}

// ─── Host daemon — fiel a host_bridge.ts ─────────────────────────────────────
//
// Fidelidades: conecta no room 'host'; _reply carimba room: HOST_ROOM_ID
// (host_bridge.ts:145 — é ISSO que o relay usa como destino); responde
// host_hello/ping. Modo proxy (experimento 4): implementa o desenho do plano B
// — host_forward re-emite para o room do filho com a MESMA Pi-key; respostas
// do filho voltam endereçadas à própria Pi-key no room 'host' e são reembrulhadas
// como host_message.

class HostDaemon {
  constructor(relayUrl, keypair, { proxy = false } = {}) {
    this.relayUrl = relayUrl;
    this.kp = keypair;
    this.pubB64 = rawPubB64(keypair);
    this.proxy = proxy;
    this.inbox = [];
    this.appPeer = null;
  }

  async connect() {
    this.ws = new WebSocket(this.relayUrl);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    const challenge = new Promise((resolve, reject) => {
      this.ws.once("message", (raw) => {
        try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
      });
    });
    this.ws.send(JSON.stringify({
      type: "hello", pubkey: this.pubB64, room_id: HOST_ROOM_ID,
      room_meta: { name: "host", cwd: "/home/u", model: "spike-host" },
    }));
    const ch = await challenge;
    const sig = sign(null, Buffer.from(ch.nonce, "base64"), this.kp.privateKey);
    this.ws.send(JSON.stringify({ type: "auth", sig: sig.toString("base64") }));
    this.ws.on("message", (raw) => this._onLine(raw.toString()));
    await sleep(80);
  }

  _onLine(line) {
    let outer;
    try { outer = JSON.parse(line); } catch { return; }
    if (!outer.ct || !outer.peer) return;

    // Resposta de filho chegando pelo host: o relay entrega no conn
    // (pi_pk,'host') o envelope do filho reescrito como {peer: pi_pk,
    // room: <room do filho>} — peer == própria Pi-key e room != 'host'.
    if (this.proxy && outer.peer === this.pubB64 && outer.room !== HOST_ROOM_ID) {
      const childRoom = outer.room;
      const childCt = outer.ct;
      // Reembrulha como host_message e devolve ao app no room 'host'.
      this._reply(this.appPeer, { type: "host_message", room: childRoom, ct: childCt });
      return;
    }

    let inner;
    try { inner = unb64(outer.ct); } catch { return; }
    this.inbox.push({ from: short(outer.peer), inner });
    switch (inner.type) {
      case "host_hello":
        this._reply(outer.peer, { type: "host_hello_ok", in_reply_to: inner.id,
          daemon: { version: "spike", hostname: "spike-host", platform: "linux" },
          capabilities: ["host_pairing", "workspace_state", "fs_nav"] });
        break;
      case "ping":
        this._reply(outer.peer, { type: "pong", in_reply_to: inner.id });
        break;
      case "host_forward":
        if (this.proxy) {
          this.appPeer = outer.peer; // para rotear a resposta de volta
          // Plano B: re-emite para o room do filho usando a MESMA Pi-key.
          // O relay entrega em (pi_pk, room_do_filho) — o conn do filho.
          this.ws.send(JSON.stringify({ peer: this.pubB64, room: inner.room, ct: inner.ct }));
        }
        break;
      default:
        break;
    }
  }

  /** host_bridge.ts:_reply — produção carimba room: HOST_ROOM_ID. */
  _reply(peer, payload) {
    this.ws.send(JSON.stringify({ peer, room: HOST_ROOM_ID, ct: b64(payload) }));
  }

  async close() { this.ws.close(); await sleep(50); }
}

// ─── Pi de workspace — fiel a peer_channel.ts ────────────────────────────────
//
// Fidelidades: conecta no room do workspace; no modo legado responde
// {peer, ct} SEM room (peer_channel.ts send — produção atual; o relay
// defaulta o destino para "main"). No modo host-first, responde endereçando
// a PRÓPRIA Pi-key no room 'host' — a resposta volta pelo host.

class WorkspacePi {
  constructor(relayUrl, keypair, { hostFirst = false } = {}) {
    this.relayUrl = relayUrl;
    this.kp = keypair;
    this.pubB64 = rawPubB64(keypair);
    this.hostFirst = hostFirst;
    this.inbox = [];
  }

  async connect() {
    this.ws = new WebSocket(this.relayUrl);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    const challenge = new Promise((resolve, reject) => {
      this.ws.once("message", (raw) => {
        try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
      });
    });
    this.ws.send(JSON.stringify({
      type: "hello", pubkey: this.pubB64, room_id: WS_ROOM,
      room_meta: { name: "ws", cwd: "/home/u/ws", model: "spike-pi" },
    }));
    const ch = await challenge;
    const sig = sign(null, Buffer.from(ch.nonce, "base64"), this.kp.privateKey);
    this.ws.send(JSON.stringify({ type: "auth", sig: sig.toString("base64") }));
    this.ws.on("message", (raw) => this._onLine(raw.toString()));
    await sleep(80);
  }

  _onLine(line) {
    let outer;
    try { outer = JSON.parse(line); } catch { return; }
    if (!outer.ct || !outer.peer) return;
    let inner;
    try { inner = unb64(outer.ct); } catch { return; }
    this.inbox.push({ from: short(outer.peer), via: outer.room, inner });
    if (inner.type !== "ping") return;
    const pong = b64({ type: "pong", in_reply_to: inner.id, room_id: WS_ROOM });
    if (this.hostFirst) {
      // Resposta volta PELO HOST: endereça a própria Pi-key no room 'host'.
      // (host e filho dividem a Pi-key; rooms distintos.)
      this.ws.send(JSON.stringify({ peer: this.pubB64, room: HOST_ROOM_ID, ct: pong }));
    } else {
      // Produção atual (peer_channel.ts): sem room → relay defaulta 'main'.
      this.ws.send(JSON.stringify({ peer: outer.peer, ct: pong }));
    }
  }

  async close() { this.ws.close(); await sleep(50); }
}

// ─── util ────────────────────────────────────────────────────────────────────

function rawPubB64(kp) {
  const der = kp.publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
}

async function waitFor(fn, what, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
    await sleep(25);
  }
}

// ─── experimentos ─────────────────────────────────────────────────────────────

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "\n      └─ " + detail : ""}`);
}

async function experiment1(relay) {
  console.log("\n=== E1 — camada do RELAY: conn do app em 'main' recebe tráfego do room 'host'? ===");
  const appKp = generateKeyPairSync("ed25519");
  const hostKp = generateKeyPairSync("ed25519");
  const app = new AppLikeClient(relay.url, appKp); // hello room_id='main' (produção)
  await app.connect();
  const host = new HostDaemon(relay.url, hostKp);
  await host.connect();

  // Host responde exatamente como host_bridge.ts:_reply — room: HOST_ROOM_ID.
  const hostHelloId = "e1-" + Date.now();
  host.ws.send(JSON.stringify({
    peer: app.pubB64, room: HOST_ROOM_ID,
    ct: b64({ type: "host_hello_ok", in_reply_to: hostHelloId,
      daemon: { version: "spike", hostname: "h", platform: "linux" }, capabilities: [] }),
  }));
  await sleep(400);

  const relayDrops = relay.wire.filter((w) => w.ev === "drop" &&
    w.dest === `${short(app.pubB64)}@${HOST_ROOM_ID}`);
  const got = app.inbox.length + app.control.length;
  record(
    "E1. host responde em (app,'host') → relay NÃO entrega na conn 'main' do app",
    got === 0 && relayDrops.length === 1,
    `app recebeu ${got} frame(s); relay: ${JSON.stringify(relayDrops[0] ?? "nenhum drop")}`,
  );
  await app.close();
  await host.close();
}

async function experiment2(relay) {
  console.log("\n=== E2 — camada do APP: demux de entrada sustenta 2 rooms na mesma conn? ===");
  const appKp = generateKeyPairSync("ed25519");
  const hostKp = generateKeyPairSync("ed25519");
  const piKp = generateKeyPairSync("ed25519");
  const app = new AppLikeClient(relay.url, appKp);
  await app.connect();
  const host = new HostDaemon(relay.url, hostKp);
  await host.connect();
  const pi = new WorkspacePi(relay.url, piKp);
  await pi.connect();

  // 1) Host usa o desvio (app,'main'): relay entrega na conn 'main' do app,
  //    mas o demux do app descarta: senderRoom='host' != activeRoom='main'.
  const id1 = "e2a-" + Date.now();
  host.ws.send(JSON.stringify({ peer: app.pubB64, room: "main",
    ct: b64({ type: "host_hello_ok", in_reply_to: id1 }) }));
  await sleep(250);
  const droppedWhileMain = app.dropped.filter((d) => d.senderRoom === HOST_ROOM_ID).length;
  record(
    "E2a. envelope do host (sender_room=host) chega mas o DEMUX do app descarta",
    droppedWhileMain === 1 && app.inbox.length === 0,
    `dropped=${droppedWhileMain} inbox=${app.inbox.length}`,
  );

  // 2) switchRoom('ws-1') — SEM reconectar (ConnectionManager.switchRoom).
  const wsBefore = app.ws;
  app.setActiveRoom(WS_ROOM);
  const stillSameConn = app.ws === wsBefore && !app.closed;

  // 3) Pi do workspace responde (sem room → 'main'): entregue e aceito.
  const pingId = "e2b-" + Date.now();
  app.send(pi.pubB64, { type: "ping", id: pingId });
  const piPong = await waitFor(() => app.inbox.find((m) => m.inner.in_reply_to === pingId),
    "pong do Pi de workspace").catch(() => null);
  record(
    "E2b. após switchRoom(ws) na MESMA conn: tráfego do workspace é entregue",
    !!piPong && stillSameConn,
    `pong=${piPong ? "ok" : "ausente"} mesma_conn=${stillSameConn}`,
  );

  // 4) Host manda de novo (desvio 'main'): agora o demux descarta porque
  //    senderRoom='host' != activeRoom='ws'. Os dois rooms NÃO coexistem.
  const id2 = "e2c-" + Date.now();
  host.ws.send(JSON.stringify({ peer: app.pubB64, room: "main",
    ct: b64({ type: "host_hello_ok", in_reply_to: id2 }) }));
  await sleep(250);
  const droppedWhileWs = app.dropped.filter((d) => d.senderRoom === HOST_ROOM_ID).length;
  record(
    "E2c. com activeRoom=ws: envelope do host é DESCARTADO pelo demux (rooms não coexistem)",
    droppedWhileWs === 2 && app.inbox.filter((m) => m.inner.in_reply_to === id2).length === 0,
    `dropped_total=${droppedWhileWs} inbox_host=${app.inbox.filter((m) => m.senderRoom === HOST_ROOM_ID).length}`,
  );
  await app.close();
  await host.close();
  await pi.close();
}

async function experiment3(relay) {
  console.log("\n=== E3 — plano de CONTROLE: catálogo de rooms multiplexa na conn única? ===");
  const appKp = generateKeyPairSync("ed25519");
  const piKp = generateKeyPairSync("ed25519"); // host e filho dividem a Pi-key (produção)
  const app = new AppLikeClient(relay.url, appKp);
  await app.connect();
  const host = new HostDaemon(relay.url, piKp);
  await host.connect();
  const pi = new WorkspacePi(relay.url, piKp);
  await pi.connect();

  // ConnectionManager._replaySubscriptions: subscribe_rooms + rooms_check.
  app.sendControl({ type: "subscribe_rooms", peers: [host.pubB64] });
  app.sendControl({ type: "rooms_check", peers: [host.pubB64] });
  const snap = await waitFor(() => app.control.find((c) => c.type === "rooms" &&
    c.peer === host.pubB64), "rooms snapshot do host");
  const roomIds = snap.rooms.map((r) => r.room_id).sort();
  record(
    "E3. subscribe_rooms/rooms_check devolve host + workspace na MESMA conn",
    roomIds.includes(HOST_ROOM_ID) && roomIds.includes(WS_ROOM) && !app.closed,
    `rooms=${JSON.stringify(roomIds)} (conn única, sem 2º WS)`,
  );
  await app.close();
  await host.close();
  await pi.close();
}

async function experiment4(relay) {
  console.log("\n=== E4 — plano B (referência): proxy host_forward/host_message ponta a ponta ===");
  const appKp = generateKeyPairSync("ed25519");
  const piKp = generateKeyPairSync("ed25519"); // host e filho dividem a Pi-key (produção)
  const app = new AppLikeClient(relay.url, appKp, { helloRoom: HOST_ROOM_ID });
  app.activeRoom = HOST_ROOM_ID;
  await app.connect();
  const host = new HostDaemon(relay.url, piKp, { proxy: true });
  await host.connect();
  const pi = new WorkspacePi(relay.url, piKp, { hostFirst: true });
  await pi.connect();

  // 1) host_hello → host_hello_ok direto no room 'host'.
  const helloId = "e4a-" + Date.now();
  app.send(host.pubB64, { type: "host_hello", id: helloId });
  const helloOk = await waitFor(() => app.inbox.find((m) => m.inner.type === "host_hello_ok"),
    "host_hello_ok");
  record(
    "E4a. host_hello → host_hello_ok na conn única (room 'host')",
    helloOk.inner.in_reply_to === helloId && !app.closed,
    `daemon=${JSON.stringify(helloOk.inner.daemon)}`,
  );

  // 2) host_forward: app → host → re-emite ao room do filho (mesma Pi-key).
  const pingId = "e4b-" + Date.now();
  app.send(host.pubB64, { type: "host_forward", id: "fwd-" + pingId, room: WS_ROOM,
    ct: b64({ type: "ping", id: pingId }) });
  const piGot = await waitFor(() => pi.inbox.find((m) => m.inner.type === "ping" && m.inner.id === pingId),
    "ping do Pi via proxy");
  const wrapped = await waitFor(() => app.inbox.find((m) => m.inner.type === "host_message" &&
    m.inner.room === WS_ROOM && unb64(m.inner.ct).in_reply_to === pingId),
    "host_message com pong do filho");
  record(
    "E4b. host_forward → host re-emite (pi_pk,ws) → filho responde via host → host_message",
    !!piGot && !!wrapped && !app.closed && app.dropped.length === 0,
    `filho_recebeu=${!!piGot} app_recebeu_host_message=${!!wrapped} drops_no_app=${app.dropped.length}`,
  );

  // 3) A sessão continua viva: segundo round pela mesma conn.
  const ping2 = "e4c-" + Date.now();
  app.send(host.pubB64, { type: "host_forward", id: "fwd-" + ping2, room: WS_ROOM,
    ct: b64({ type: "ping", id: ping2 }) });
  const wrapped2 = await waitFor(() => app.inbox.find((m) => m.inner.type === "host_message" &&
    unb64(m.inner.ct).in_reply_to === ping2), "segundo host_message");
  record(
    "E4c. segundo round pelo mesmo proxy — conexão permanece íntegra",
    !!wrapped2 && !app.closed,
    `app_inbox=${app.inbox.length} app_dropped=${app.dropped.length} conn_fechada=${app.closed}`,
  );
  await app.close();
  await host.close();
  await pi.close();
}

async function experiment5(relay) {
  console.log("\n=== E5 — controle: DUAS conns (mesma Pi-key) recebem os dois rooms ===");
  const appKp = generateKeyPairSync("ed25519");
  const piKp = generateKeyPairSync("ed25519"); // host e filho dividem a Pi-key (produção)
  // Duas conns do MESMO owner (plano 23 permite N conns por (peer, room));
  // cada conn registrada em um room diferente.
  const appMain = new AppLikeClient(relay.url, appKp, { helloRoom: "main" });
  await appMain.connect();
  const appHost = new AppLikeClient(relay.url, appKp, { helloRoom: HOST_ROOM_ID });
  appHost.activeRoom = HOST_ROOM_ID;
  await appHost.connect();
  const host = new HostDaemon(relay.url, piKp);
  await host.connect();
  const pi = new WorkspacePi(relay.url, piKp);
  await pi.connect();

  host.ws.send(JSON.stringify({ peer: rawPubB64(appKp), room: HOST_ROOM_ID,
    ct: b64({ type: "host_hello_ok", in_reply_to: "e5-host" }) }));
  const pingId = "e5-" + Date.now();
  appMain.activeRoom = WS_ROOM;
  appMain.send(pi.pubB64, { type: "ping", id: pingId });
  const hostOk = await waitFor(() => appHost.inbox.find((m) => m.inner.type === "host_hello_ok"),
    "host_hello_ok na conn 'host'");
  const piPong = await waitFor(() => appMain.inbox.find((m) => m.inner.in_reply_to === pingId),
    "pong na conn 'main'");
  record(
    "E5. com 2 conns os dois rooms entregam (relay são; o limite é a conn ÚNICA)",
    !!hostOk && !!piPong,
    `conn_host=${!!hostOk} conn_main=${!!piPong}`,
  );
  await appMain.close();
  await appHost.close();
  await host.close();
  await pi.close();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("spike-room-multiplex — Plano 69 W2 / todo #4");
  console.log(`node=${process.version}  host_room="${HOST_ROOM_ID}"  ws_room="${WS_ROOM}"`);
  const relay = new SpikeRelay();
  await relay.listen();
  console.log(`relay stub em ${relay.url} (contrato {peer, room, ct}; 1 room por conn)`);
  try {
    await experiment1(relay);
    await experiment2(relay);
    await experiment3(relay);
    await experiment4(relay);
    await experiment5(relay);
  } finally {
    await relay.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "─".repeat(64));
  // Decisão B quando: (E1) o relay não entrega tráfego do room 'host' na conn
  // 'main' do app; (E2a/E2c) o demux do app não sustenta os dois rooms na mesma
  // conn; (E4b/E4c) o proxy host_forward/host_message funciona ponta a ponta.
  const ok = (prefix) => results.some((r) => r.name.startsWith(prefix) && r.ok);
  const decisaoB = ok("E1.") && ok("E2a.") && ok("E2c.") && ok("E4b.") && ok("E4c.");
  console.log(decisaoB
    ? "DECISÃO: B — uma conexão NÃO sustenta host + workspace simultaneamente.\n" +
      "          Ativar plano B: proxy host_forward/host_message (app ancorado no room 'host')."
    : "DECISÃO: inconclusiva — revisar experimentos acima.");
  console.log(`${results.length - failed.length}/${results.length} passaram`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("spike crashed:", e); process.exit(2); });
