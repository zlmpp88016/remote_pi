/**
 * Local relay stub for plan 69 W4 web-client verification — zero dependencies.
 *
 * Implements ONLY what PROTOCOL.md already defines (no new contracts):
 *   • WS handshake: hello {pubkey} → challenge {nonce} → auth {sig}
 *     (Ed25519 over the raw nonce — relay/src/auth/challenge.rs)
 *   • Opaque outer envelope routing {peer, room, ct}, with the relay-side
 *     rewrite of peer/room to the sender's authenticated identity
 *     (relay/src/handlers/peer.rs)
 *   • Origin allowlist enforcement (plan 69 W4 relay prerequisite — the piece
 *     the Rust relay still lacks): exact match against a comma-separated
 *     allowlist. Empty allowlist = allow all, which documents the relay's
 *     CURRENT behavior (browsers unusable). A missing Origin header is
 *     rejected when the allowlist is non-empty (browsers always send Origin
 *     on WS upgrades).
 *   • Subprotocol echo: the negotiated Sec-WebSocket-Protocol is echoed in
 *     the 101 response (plan 69 W4 relay prerequisite).
 *
 * The stub also simulates the host side (pi-supervisord + a workspace Pi) with
 * the plan-69 decision-B PROXY semantics (PROTOCOL.md "Proxy
 * host_forward/host_message"): the client anchors ONLY on room "host" and
 * sends host_forward{room, ct}; the host re-emits {peer: <machine key>, room:
 * <childRoom>, ct} on its own connection; the child answers addressed to its
 * OWN Pi-key on room "host"; the host detects that relay rewrite, wraps it as
 * host_message{room, ct} and fans it out on the host room. pair_request /
 * host_hello / workspace_list / fs_list / workspace_start stay on room
 * "host" — message-for-message as PROTOCOL.md documents.
 *
 * Run standalone for manual poking:
 *   node scripts/relay-stub.mjs [port]     (RELAY_ORIGIN_ALLOWLIST=a,b)
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SUBPROTOCOL = "remote-pi.1";
const HOST_ROOM = "host";
const HOME = os.homedir();

/** 12-byte Ed25519 SPKI DER prefix; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function spkiKeyFromRaw(rawB64) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawB64, "base64")]),
    format: "der",
    type: "spki",
  });
}

// ── WS server plumbing (RFC 6455, zero deps) ────────────────────────────────

function acceptKey(secWebSocketKey) {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

/** Encodes a server frame (unmasked). opcode: 1 text, 8 close, 9 ping, 10 pong. */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/** Incremental client-frame parser (client frames are masked). */
class FrameParser {
  #buffer = Buffer.alloc(0);

  constructor(onFrame) {
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const opcode = this.#buffer[0] & 0x0f;
      const masked = (this.#buffer[1] & 0x80) !== 0;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < offset + 2) return;
        length = this.#buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.#buffer.length < offset + 8) return;
        length = Number(this.#buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskLength = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskLength + length) return;
      let payload = this.#buffer.subarray(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.#buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      this.#buffer = this.#buffer.subarray(offset + maskLength + length);
      this.onFrame(opcode, payload);
    }
  }
}

// ── relay core ──────────────────────────────────────────────────────────────

/** One peer connection: identity + handshake state + socket. */
class Conn {
  peerId = null;
  room = "main";
  nonce = null;
  authed = false;

  constructor(socket) {
    this.socket = socket;
  }
}

class RelayStub {
  /** @type {Map<number, Conn>} */
  #conns = new Map();
  #nextConnId = 1;
  #originAllowlist;
  #rejections = [];

  constructor({ originAllowlist = [] } = {}) {
    this.#originAllowlist = originAllowlist.map((o) => o.trim()).filter(Boolean);
  }

  /** Origins whose upgrade was rejected — asserted by the test. */
  get rejections() {
    return [...this.#rejections];
  }

  originAllowed(origin) {
    if (this.#originAllowlist.length === 0) return true; // current relay behavior
    if (!origin) return false; // browsers always send Origin on WS upgrades
    return this.#originAllowlist.includes(origin);
  }

  handleUpgrade(req, socket) {
    const origin = req.headers.origin;
    if (!this.originAllowed(origin)) {
      this.#rejections.push(origin ?? null);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || !key) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const negotiated = offered.includes(SUBPROTOCOL) ? SUBPROTOCOL : offered[0];
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    ];
    if (negotiated) headers.push(`Sec-WebSocket-Protocol: ${negotiated}`);
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);

    const conn = new Conn(socket);
    const connId = this.#nextConnId++;
    this.#conns.set(connId, conn);

    const parser = new FrameParser((opcode, payload) => {
      if (opcode === 8) {
        socket.end(encodeFrame(8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 9) {
        socket.write(encodeFrame(10, payload));
        return;
      }
      if (opcode !== 1) return;
      const text = payload.toString("utf8");
      if (!conn.authed) {
        this.#handleAuth(conn, text, socket);
        return;
      }
      this.#route(connId, conn, text);
    });

    socket.on("data", (chunk) => parser.push(chunk));
    const drop = () => {
      this.#conns.delete(connId);
      socket.destroy();
    };
    socket.on("error", drop);
    socket.on("close", drop);
  }

  /** hello → challenge → auth, mirroring relay/src/handlers/peer.rs. */
  #handleAuth(conn, text, socket) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.#closeConn(conn, socket);
    }
    if (msg?.type === "hello" && typeof msg.pubkey === "string") {
      const raw = Buffer.from(msg.pubkey, "base64");
      if (raw.length !== 32) return this.#closeConn(conn, socket);
      conn.peerId = raw.toString("base64"); // canonical std base64 identity
      conn.room = typeof msg.room_id === "string" && msg.room_id ? msg.room_id : "main";
      conn.nonce = randomBytes(32);
      socket.write(
        encodeFrame(1, Buffer.from(JSON.stringify({ type: "challenge", nonce: conn.nonce.toString("base64") }))),
      );
      return;
    }
    if (msg?.type === "auth" && typeof msg.sig === "string" && conn.nonce) {
      const signature = Buffer.from(msg.sig, "base64");
      const ok =
        signature.length === 64 &&
        cryptoVerify(null, conn.nonce, spkiKeyFromRaw(conn.peerId), signature);
      conn.authed = ok;
      if (!ok) this.#closeConn(conn, socket);
      return;
    }
    this.#closeConn(conn, socket);
  }

  #closeConn(conn, socket) {
    conn.authed = false;
    socket.end(encodeFrame(8, Buffer.alloc(0)));
  }

  /** Outer envelope routing with the relay-side identity rewrite. */
  #route(fromConnId, from, text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return; // invalid json, dropping (like the real relay)
    }
    if (frame && typeof frame.type === "string") {
      return; // control frames are out of this stub's contract
    }
    if (!frame || typeof frame.peer !== "string" || typeof frame.ct !== "string") return;
    const destRoom = typeof frame.room === "string" && frame.room ? frame.room : "main";
    const line = encodeFrame(
      1,
      Buffer.from(JSON.stringify({ peer: from.peerId, room: from.room, ct: frame.ct })),
    );
    for (const [connId, conn] of this.#conns) {
      if (connId === fromConnId) continue; // skip-sender, like the real relay
      if (conn.peerId === frame.peer && conn.room === destRoom) {
        conn.socket.write(line);
      }
    }
  }
}

// ── host (pi-supervisord + workspace Pi) simulator ───────────────────────────

/** Opens one WS connection as the host identity and completes the handshake. */
async function connectAsHost({ relayUrl, hostEpk, privateKey, room, origin }) {
  const socket = new WebSocket(relayUrl, { headers: { Origin: origin } });
  const conn = {
    room,
    onMessage: null,
    /** Reply to a peer in a given room (host_bridge.ts:_reply stamps room "host"). */
    replyTo: (peer, replyRoom, inner) => {
      socket.send(
        JSON.stringify({
          peer,
          room: replyRoom,
          ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
        }),
      );
    },
    /** host_forward re-emit (plan 69 decision B): same machine key, child
     *  room — the relay delivers on the child's conn (pi-key, childRoom). */
    forwardToChildRoom: (childRoom, ct) => {
      socket.send(JSON.stringify({ peer: hostEpk, room: childRoom, ct }));
    },
    /** Child reply in daemon mode: the child addresses its OWN Pi-key on room
     *  "host", so the reply routes back through the host conn. */
    replyViaHost: (inner) => {
      socket.send(
        JSON.stringify({
          peer: hostEpk,
          room: HOST_ROOM,
          ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
        }),
      );
    },
    close: () => socket.close(),
  };
  await new Promise((resolvePromise, reject) => {
    let nonce = null;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", pubkey: hostEpk, room_id: room }));
    });
    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === "challenge") {
        nonce = Buffer.from(msg.nonce, "base64");
        const signature = cryptoSign(null, nonce, privateKey);
        socket.send(JSON.stringify({ type: "auth", sig: signature.toString("base64") }));
        resolvePromise();
        return;
      }
      try {
        const outer = JSON.parse(String(event.data));
        const inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
        // `outer` is the envelope AS DELIVERED (relay rewrite applied): the
        // host conn needs it raw to tell a child reply ({peer: own key, room:
        // childRoom}) from a client request before decoding `inner`.
        conn.onMessage?.({ fromPeer: outer.peer, fromRoom: outer.room, outer, inner });
      } catch {
        /* relay control frame or malformed — not ours */
      }
    });
    socket.addEventListener("error", () => reject(new Error(`host stub: falha no WS (room ${room})`)));
  });
  return conn;
}

class HostStub {
  #relayUrl;
  #token;
  #origin;
  #keyPair;
  #workspaces = [];
  #piRooms = new Map();
  /** Every WS connection this stub opened (host + child rooms) — closed on stop. */
  #conns = [];
  /** Peers seen on the host room — the host_message fan-out audience
   *  ("todos os peers allow-listados", PROTOCOL.md decision B). */
  #clientPeers = new Set();

  constructor({ relayUrl, token, origin }) {
    this.#relayUrl = relayUrl;
    this.#token = token;
    this.#origin = origin;
  }

  async start() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hostEpk = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    this.#keyPair = { hostEpk, privateKey };

    const hostConn = await connectAsHost({
      relayUrl: this.#relayUrl,
      hostEpk,
      privateKey,
      room: HOST_ROOM,
      origin: this.#origin,
    });
    this.#conns.push(hostConn);
    hostConn.onMessage = ({ fromPeer, fromRoom, outer, inner }) => {
      // Child reply arriving through the host (plan 69 decision B): the relay
      // rewrites the child's envelope as {peer: <machine Pi-key>, room:
      // <childRoom>} — peer == our OWN key and room != "host". Wrap it as
      // host_message and fan out on the host room.
      if (outer.peer === this.#keyPair.hostEpk && outer.room !== HOST_ROOM) {
        const wrapped = { type: "host_message", room: outer.room, ct: outer.ct };
        for (const peer of this.#clientPeers) hostConn.replyTo(peer, HOST_ROOM, wrapped);
        return;
      }
      this.#clientPeers.add(fromPeer);
      const reply = (message) => hostConn.replyTo(fromPeer, fromRoom, message);
      switch (inner.type) {
        case "pair_request":
          if (inner.token === this.#token) {
            reply({
              type: "pair_ok",
              in_reply_to: inner.id,
              session_name: "host",
              session_started_at: Date.now(),
              room_id: HOST_ROOM,
              hostname: os.hostname(),
            });
          } else {
            reply({
              type: "pair_error",
              in_reply_to: inner.id,
              code: "token_unknown",
              message: "Token was not issued by this host.",
            });
          }
          return;
        case "host_hello":
          reply({
            type: "host_hello_ok",
            in_reply_to: inner.id,
            daemon: {
              version: "stub-daemon-0.1.0",
              hostname: os.hostname(),
              platform: process.platform,
            },
            capabilities: ["host_pairing", "workspace_state", "fs_nav"],
          });
          return;
        case "workspace_list":
          reply({
            type: "workspace_list_ok",
            in_reply_to: inner.id,
            workspaces: this.#workspaces.map((ws) => ({ ...ws })),
          });
          return;
        case "fs_list":
          void this.#handleFsList(inner, reply);
          return;
        case "workspace_start":
          void this.#handleWorkspaceStart(inner, reply);
          return;
        case "host_forward":
          // Proxy re-emit: same machine key, child room — the relay delivers
          // on the child's conn. No ack: the child's replies come back as
          // host_message (see the branch above).
          hostConn.forwardToChildRoom(String(inner.room ?? ""), String(inner.ct ?? ""));
          return;
        default:
          reply({
            type: "action_error",
            in_reply_to: inner.id,
            action: String(inner.type),
            error: "unsupported_type",
          });
      }
    };
    return hostEpk;
  }

  /** Closes every connection this stub opened (host + child rooms). */
  async close() {
    for (const conn of this.#conns) conn.close();
    this.#conns = [];
    await new Promise((resolveClose) => setTimeout(resolveClose, 100));
  }

  /** fs_list with the PROTOCOL.md error table (not_found / not_a_directory /
   *  permission_denied) surfaced as `action_error`. */
  async #handleFsList(inner, reply) {
    const target = resolvePathInput(String(inner.path ?? "~"));
    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const code =
        err.code === "ENOENT"
          ? "not_found"
          : err.code === "ENOTDIR"
            ? "not_a_directory"
            : err.code === "EACCES"
              ? "permission_denied"
              : "internal_error";
      reply({ type: "action_error", in_reply_to: inner.id, action: "fs_list", error: code });
      return;
    }
    const showHidden = inner.show_hidden === true;
    const entries = [];
    for (const dirent of dirents) {
      if (!showHidden && dirent.name.startsWith(".")) continue;
      entries.push({
        name: dirent.name,
        kind: dirent.isDirectory() ? "dir" : "file",
        is_repo: dirent.isDirectory() && existsSync(resolvePath(target, dirent.name, ".git")),
      });
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    reply({
      type: "fs_list_ok",
      in_reply_to: inner.id,
      path: target,
      parent: parentOf(target),
      entries,
    });
  }

  async #handleWorkspaceStart(inner, reply) {
    const cwd = resolvePathInput(String(inner.cwd ?? ""));
    const existing = this.#workspaces.find((ws) => ws.cwd === cwd);
    if (existing) {
      reply({
        type: "workspace_start_ok",
        in_reply_to: inner.id,
        cwd,
        room_id: existing.room_id,
        daemon_id: existing.daemon_id,
      });
      return;
    }
    const daemonId = randomBytes(4).toString("hex");
    const roomId = createHash("sha256").update(cwd).digest("base64url").slice(0, 12);
    this.#workspaces.push({
      cwd,
      daemon_id: daemonId,
      room_id: roomId,
      name: basename(cwd),
      live: true,
      daemon: false,
      source: "added",
    });
    // The Pi room conn must be registered BEFORE workspace_start_ok: the chat
    // that follows is proxied immediately, and the relay drops an envelope
    // whose destination (pi-key, childRoom) has no conn yet.
    await this.#startPiRoom(roomId);
    reply({
      type: "workspace_start_ok",
      in_reply_to: inner.id,
      cwd,
      room_id: roomId,
      daemon_id: daemonId,
    });
  }

  /** A workspace room connection (the Pi process) — echo + agent stream,
   *  exactly the channels every connected owner sees. Daemon-mode replies
   *  address the child's OWN Pi-key on room "host" so they route back through
   *  the host, which wraps them as host_message (plan 69 decision B). */
  async #startPiRoom(roomId) {
    const conn = await connectAsHost({
      relayUrl: this.#relayUrl,
      hostEpk: this.#keyPair.hostEpk,
      privateKey: this.#keyPair.privateKey,
      room: roomId,
      origin: this.#origin,
    });
    this.#piRooms.set(roomId, conn);
    this.#conns.push(conn);
    conn.onMessage = ({ inner }) => {
      if (inner.type !== "user_message") return;
      conn.replyViaHost({ type: "user_message", id: inner.id, text: inner.text });
      conn.replyViaHost({
        type: "agent_chunk",
        in_reply_to: inner.id,
        delta: `[stub Pi · sala ${roomId}] `,
      });
      conn.replyViaHost({
        type: "agent_chunk",
        in_reply_to: inner.id,
        delta: String(inner.text ?? ""),
      });
      conn.replyViaHost({
        type: "agent_done",
        in_reply_to: inner.id,
        usage: { input_tokens: 1, output_tokens: 2 },
      });
    };
  }
}

function resolvePathInput(input) {
  if (input === "~" || input.startsWith("~/")) {
    return resolvePath(HOME, input.slice(2));
  }
  return isAbsolute(input) ? resolvePath(input) : resolvePath(HOME, input);
}

function parentOf(path) {
  const parent = resolvePath(path, "..");
  return parent === path ? null : parent;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Starts the stub relay + host simulator.
 * @returns {{ port: number, relayUrl: string, hostEpk: string, token: string,
 *            rejections: () => (string|null)[], close: () => Promise<void> }}
 */
export async function startRelayStub({
  port = 0,
  originAllowlist = [],
  token = "stub-pairing-token",
  hostOrigin = "https://web.remote-pi.example",
} = {}) {
  const relay = new RelayStub({ originAllowlist });
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => relay.handleUpgrade(req, socket));
  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  const actualPort = server.address().port;
  const relayUrl = `ws://127.0.0.1:${actualPort}`;

  const host = new HostStub({ relayUrl, token, origin: hostOrigin });
  const hostEpk = await host.start();

  return {
    port: actualPort,
    relayUrl,
    hostEpk,
    token,
    rejections: () => relay.rejections,
    close: async () => {
      await host.close();
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

// Allow `node scripts/relay-stub.mjs [port]` for manual use.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const port = Number(process.argv[2] ?? 8787);
  const allowlist = (process.env.RELAY_ORIGIN_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  startRelayStub({ port, originAllowlist: allowlist }).then((stub) => {
    const epkUrl = Buffer.from(stub.hostEpk, "base64").toString("base64url");
    console.log(`[relay-stub] relay     ${stub.relayUrl}`);
    console.log(`[relay-stub] hostEpk   ${stub.hostEpk}`);
    console.log(`[relay-stub] token     ${stub.token}`);
    console.log(`[relay-stub] allowlist ${JSON.stringify(allowlist)} (vazio = comportamento atual do relay)`);
    console.log(
      `[relay-stub] pair URI  remotepi://pair?t=${stub.token}&epk=${epkUrl}&n=host&rm=host&r=${stub.relayUrl}`,
    );
  });
}
