// Relay stub local — implementa o contrato {peer, ct} do relay real, sem rede.
//
// Por que existe: o e2e do plan/68 não pode depender do relay de produção
// (flaky, e exige internet). O relay real é um fan-out por room_id: cada peer
// autentica com Ed25519 (hello → challenge → auth) e as linhas `{peer, ct}`
// são entregues aos OUTROS peers da mesma room. Este stub reproduz só isso —
// o suficiente para o HostBridge e o daemon reais falarem por ele.

import { createServer } from "node:http";
import { randomBytes, createPublicKey, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { requireFromPiExtension } from "./paths.mjs";

// `ws` só resolve de dentro do pi-extension (o harness vive na raiz).
const { WebSocketServer } = requireFromPiExtension("ws");

/** Reconstroi a chave pública Ed25519 crua (32B) a partir do base64 do hello. */
function ed25519FromRaw(rawB64) {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${raw.length}`);
  // Prefixo DER de SPKI para Ed25519 — deixa o crypto.createPublicKey aceitar.
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export class RelayStub extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.wss = null;
    /** room_id → Set<PeerConn> */
    this.rooms = new Map();
    /** Todo frame `{peer, ct}` roteado, para o teste inspecionar. */
    this.routed = [];
    /** Quantas conexões já autenticaram. */
    this.authCount = 0;
  }

  async listen() {
    this.server = createServer((_req, res) => res.writeHead(404).end());
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => this._onConnection(ws));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.url = `ws://127.0.0.1:${port}`;
    return this.url;
  }

  /** URL em forma canônica http(s) — é o que `REMOTE_PI_RELAY` espera. */
  get httpUrl() {
    return this.url.replace(/^ws/, "http");
  }

  async close() {
    for (const set of this.rooms.values()) for (const p of set) p.ws.close();
    await new Promise((resolve) => this.wss?.close(resolve));
    await new Promise((resolve) => this.server?.close(resolve));
  }

  _onConnection(ws) {
    const peer = { ws, roomId: null, pubkey: null, authed: false };
    let nonce = null;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "hello") {
        // Sem room_id o relay real usa "main".
        peer.roomId = msg.room_id || "main";
        peer.pubkey = msg.pubkey;
        nonce = randomBytes(32);
        ws.send(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }));
        return;
      }

      if (msg.type === "auth") {
        let ok = false;
        try {
          const key = ed25519FromRaw(peer.pubkey);
          ok = verify(null, nonce, key, Buffer.from(msg.sig, "base64"));
        } catch { ok = false; }
        if (!ok) {
          ws.send(JSON.stringify({ type: "error", code: "auth_failed" }));
          ws.close();
          return;
        }
        peer.authed = true;
        this.authCount++;
        let set = this.rooms.get(peer.roomId);
        if (!set) { set = new Set(); this.rooms.set(peer.roomId, set); }
        set.add(peer);
        this.emit("authed", peer);
        return;
      }

      if (!peer.authed) return;
      // Roteamento normal: {peer, ct} vai para os OUTROS peers da mesma room.
      if (!msg.ct || !msg.peer) return;
      this.routed.push(msg);
      this.emit("routed", msg);
      const set = this.rooms.get(peer.roomId);
      if (!set) return;
      const line = JSON.stringify(msg);
      for (const other of set) {
        if (other === peer) continue;
        if (other.ws.readyState === other.ws.OPEN) other.ws.send(line);
      }
    });

    ws.on("close", () => {
      if (peer.roomId) this.rooms.get(peer.roomId)?.delete(peer);
      this.emit("disconnected", peer);
    });
  }

  /** Espera uma conexão autenticada cujo pubkey bate (ou qualquer uma). */
  waitForAuth(pubkeyB64 = null, timeoutMs = 10_000) {
    const match = (p) => !pubkeyB64 || p.pubkey === pubkeyB64;
    for (const set of this.rooms.values()) {
      for (const p of set) if (match(p)) return Promise.resolve(p);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("authed", onAuth);
        reject(new Error("relay stub: timeout esperando auth"));
      }, timeoutMs);
      const onAuth = (p) => {
        if (!match(p)) return;
        clearTimeout(timer);
        this.off("authed", onAuth);
        resolve(p);
      };
      this.on("authed", onAuth);
    });
  }

  /**
   * Espera a room passar a ter peers (ou um a mais que `baseline`). Usado pelo
   * e2e depois de `workspace_start`: o daemon é um processo separado, então a
   * autenticação dele é assíncrona em relação ao ack do host_control.
   */
  async waitForRoomPeer(roomId, { baseline = 0, timeoutMs = 45_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((this.rooms.get(roomId)?.size ?? 0) > baseline) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Quantos peers autenticados existem hoje nessa room. */
  roomPeerCount(roomId) {
    return this.rooms.get(roomId)?.size ?? 0;
  }
}
