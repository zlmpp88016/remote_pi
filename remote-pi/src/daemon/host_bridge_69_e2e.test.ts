import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { EventEmitter } from "node:events";

/**
 * Plan/69 W2 — the host_forward/host_message proxy END-TO-END against a
 * relay stub that reproduces the REAL relay contract (the same one
 * scripts/spike-room-multiplex.mjs validated):
 *
 *   1. `hello` carries ONE room_id; the registry is keyed by (peer, room).
 *   2. An outer envelope {peer, room, ct} is REWRITTEN with the sender's
 *      peer_id + room_id and delivered only to connections registered at
 *      (dest.peer, dest.room) — relay/src/handlers/peer.rs.
 *   3. No destination match → drop. Skip-sender by connection.
 *
 * Every component here is the production one: the real `HostBridge` over a
 * real `RelayClient`, and the real `PlainPeerChannel` in host-first mode as
 * the daemon child. Only the relay is a stub.
 */

const _tmpHome = mkdtempSync(join(tmpdir(), "pi-hostbr69e2e-"));
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => _tmpHome };
});

const { HostBridge } = await import("./host_bridge.js");
const { RelayClient } = await import("../transport/relay_client.js");
const { PlainPeerChannel } = await import("../transport/peer_channel.js");
const storage = await import("../pairing/storage.js");
import type { ClientMessage, ServerMessage } from "../protocol/types.js";

const HOST_ROOM = "host";
const CHILD_ROOM = "kX9fT2mQwE7r"; // 12-char b64url — roomIdFor format

// ── Relay stub (faithful to the real relay's routing contract) ────────────────

interface StubConn {
  id: number;
  ws: WebSocket;
  roomId: string;
  pubkey: string;
  authed: boolean;
}

class RelayStub {
  readonly url: string;
  private readonly server: ReturnType<typeof createServer>;
  private readonly wss: WebSocketServer;
  /** (pubkey, room) → Set<conn> — the real PeerRegistry shape. */
  private readonly senders = new Map<string, Set<StubConn>>();
  private nextConn = 1;

  private constructor(server: ReturnType<typeof createServer>, wss: WebSocketServer, port: number) {
    this.server = server;
    this.wss = wss;
    this.url = `ws://127.0.0.1:${port}`;
    wss.on("connection", (ws) => this._onConnection(ws));
  }

  static async listen(): Promise<RelayStub> {
    const server = createServer((_req, res) => res.writeHead(404).end());
    const wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return new RelayStub(server, wss, port);
  }

  async close(): Promise<void> {
    for (const set of this.senders.values()) for (const c of set) c.ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private _onConnection(ws: WebSocket): void {
    const conn: StubConn = { id: this.nextConn++, ws, roomId: "main", pubkey: "", authed: false };
    let nonce: Buffer | null = null;

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg["type"] === "hello") {
        conn.roomId = (msg["room_id"] as string) || "main";
        conn.pubkey = msg["pubkey"] as string;
        nonce = randomBytes(32);
        ws.send(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }));
        return;
      }
      if (msg["type"] === "auth") {
        let ok = false;
        try {
          const der = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(conn.pubkey, "base64"),
          ]);
          ok = verify(
            null,
            nonce!,
            createPublicKey({ key: der, format: "der", type: "spki" }),
            Buffer.from(msg["sig"] as string, "base64"),
          );
        } catch { ok = false; }
        if (!ok) { ws.close(); return; }
        conn.authed = true;
        const key = `${conn.pubkey}|${conn.roomId}`;
        if (!this.senders.has(key)) this.senders.set(key, new Set());
        this.senders.get(key)!.add(conn);
        return;
      }
      if (!conn.authed) return;

      // Outer envelope {peer, room, ct}: rewrite with the SENDER identity.
      const destPeer = msg["peer"] as string | undefined;
      if (!destPeer || !msg["ct"]) return;
      const destRoom = (msg["room"] as string) ?? "main";
      const rewritten = { peer: conn.pubkey, room: conn.roomId, ct: msg["ct"] };
      const line = JSON.stringify(rewritten);
      const set = this.senders.get(`${destPeer}|${destRoom}`);
      if (!set) return; // drop — same as the real relay
      for (const other of set) {
        if (other.id === conn.id) continue; // skip-sender
        if (other.ws.readyState === WebSocket.OPEN) other.ws.send(line);
      }
    });

    ws.on("close", () => {
      if (conn.pubkey) this.senders.get(`${conn.pubkey}|${conn.roomId}`)?.delete(conn);
    });
  }
}

// ── App client (raw WS, anchored on room `host` like the real app) ────────────

class AppClient {
  readonly pubB64: string;
  private readonly ws: WebSocket;
  private readonly kp: ReturnType<typeof generateKeyPairSync>;
  readonly inbox: Array<{ peer: string; room?: string; inner: ServerMessage }> = [];

  private constructor(ws: WebSocket, kp: ReturnType<typeof generateKeyPairSync>, pubB64: string) {
    this.ws = ws;
    this.kp = kp;
    this.pubB64 = pubB64;
  }

  static async connect(url: string): Promise<AppClient> {
    const kp = generateKeyPairSync("ed25519");
    const der = kp.publicKey.export({ format: "der", type: "spki" });
    const pubB64 = der.subarray(der.length - 32).toString("base64");
    const ws = new WebSocket(url);
    const app = new AppClient(ws, kp, pubB64);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({
      type: "hello", pubkey: pubB64, room_id: HOST_ROOM,
      room_meta: { name: "app", cwd: "/app", model: "app" },
    }));
    const challenge = await new Promise<Record<string, string>>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    const sig = sign(null, Buffer.from(challenge["nonce"]!, "base64"), kp.privateKey);
    ws.send(JSON.stringify({ type: "auth", sig: sig.toString("base64") }));
    ws.on("message", (raw) => app._onLine(raw.toString()));
    await new Promise((r) => setTimeout(r, 80));
    return app;
  }

  private _onLine(line: string): void {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line); } catch { return; }
    if (!frame["peer"] || !frame["ct"]) return;
    this.inbox.push({
      peer: frame["peer"] as string,
      room: frame["room"] as string | undefined,
      inner: JSON.parse(Buffer.from(frame["ct"] as string, "base64").toString("utf8")) as ServerMessage,
    });
  }

  /** Sends a raw outer envelope from the app's connection. */
  sendOuter(peer: string, room: string, ct: string): void {
    this.ws.send(JSON.stringify({ peer, room, ct }));
  }

  async close(): Promise<void> {
    this.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

class InMemoryBackend {
  private store = new Map<string, string>();
  async read(): Promise<string | undefined> { return this.store.get("k"); }
  async write(_s: string, _a: string, value: string): Promise<void> { this.store.set("k", value); }
  async delete(): Promise<boolean> { return this.store.delete("k"); }
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fleetStub() {
  return {
    list: () => [],
    ensure: (cwd: string) => ({ ok: true as const, id: "stub", cwd, name: "ws" }),
    start: () => ({ ok: true as const, started: true }),
    stop: async () => ({ ok: true as const, stopped: true }),
    addWorkspace: (cwd: string) => ({ ok: true as const, cwd, added: true }),
    removeWorkspace: (cwd: string) => ({ ok: true as const, cwd, removed: true }),
  };
}

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
    await sleep(25);
  }
}

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env["REMOTE_PI_HOME"];
  process.env["REMOTE_PI_HOME"] = _tmpHome;
  storage._setKeyStoreBackendForTest(new InMemoryBackend() as never);
});

afterEach(() => {
  storage._setKeyStoreBackendForTest(null);
  if (savedHome === undefined) delete process.env["REMOTE_PI_HOME"];
  else process.env["REMOTE_PI_HOME"] = savedHome;
  try { rmSync(join(_tmpHome, ".pi", "remote"), { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("plan/69 — host_forward/host_message proxy end-to-end (real relay contract)", () => {
  test("host_forward → child (hostFirst) → host_message, full loop over real WS", async () => {
    const relay = await RelayStub.listen();
    let bridge: HostBridge | null = null;
    let childRelay: RelayClient | null = null;
    let app: AppClient | null = null;
    try {
      // ── The app: anchored on room `host`, paired (in the allow-list). ──
      // Connected FIRST so the bridge can snapshot it in its allow-list at
      // connect time (production flow: the app pairs, then traffic flows).
      app = await AppClient.connect(relay.url);

      // ── The host: the real HostBridge over a real RelayClient. ──
      bridge = new HostBridge({
        fleet: fleetStub(),
        relayFactory: (_url, keypair) => new RelayClient(relay.url, keypair),
        listPeersFn: async () => [{ remote_epk: app!.pubB64 }],
      });
      await bridge.start();
      // The bridge minted the machine identity — the SAME key the child uses.
      const hostKp = await storage.getOrCreateEd25519Keypair();
      const hostPubB64 = Buffer.from(hostKp.publicKey).toString("base64");

      // ── The child: a daemon Pi on the workspace room, host-first mode. ──
      childRelay = new RelayClient(relay.url, hostKp);
      await childRelay.connect({
        roomId: CHILD_ROOM,
        roomMeta: { name: "ws", cwd: "/tmp/ws", model: "spike-pi" },
      });
      const pongs: ServerMessage[] = [];
      const childChannel = new PlainPeerChannel(
        childRelay,
        hostPubB64, // remotePeerId = own key: accepts host-proxied envelopes
        CHILD_ROOM,
        (msg: ClientMessage) => {
          if (msg.type === "ping") {
            pongs.push({ type: "pong", in_reply_to: msg.id });
            childChannel.send({ type: "pong", in_reply_to: msg.id });
          }
        },
        undefined,
        { ownPubkey: hostPubB64 }, // host-first: outbound → {peer: own, room: "host"}
      );

      // ── The app: anchored on room `host`, paired (allow-listed). ──
      // (already connected above)

      // 1) app → host_forward → child receives the inner ping.
      const pingId = "e2e-ping-1";
      app.sendOuter(hostPubB64, HOST_ROOM, b64({
        type: "host_forward", id: "fwd-1", room: CHILD_ROOM, ct: b64({ type: "ping", id: pingId }),
      }));
      await waitFor(() => pongs.length > 0 ? pongs[0] : undefined, "pong do filho");

      // 2) child → host_message → app receives it on the host room.
      const wrapped = await waitFor(
        () => app!.inbox.find((m) => m.inner.type === "host_message"),
        "host_message no app",
      );
      expect(wrapped.room).toBe(HOST_ROOM);
      expect(wrapped.peer).toBe(hostPubB64);
      if (wrapped.inner.type !== "host_message") throw new Error("wrong type");
      expect(wrapped.inner.room).toBe(CHILD_ROOM);
      const inner = JSON.parse(Buffer.from(wrapped.inner.ct, "base64").toString("utf8")) as ServerMessage;
      expect(inner).toEqual({ type: "pong", in_reply_to: pingId });

      // 3) a second round through the same connections stays intact.
      const ping2 = "e2e-ping-2";
      app.sendOuter(hostPubB64, HOST_ROOM, b64({
        type: "host_forward", id: "fwd-2", room: CHILD_ROOM, ct: b64({ type: "ping", id: ping2 }),
      }));
      const wrapped2 = await waitFor(
        () => app!.inbox.filter((m) => m.inner.type === "host_message").length >= 2
          ? app!.inbox.filter((m) => m.inner.type === "host_message")[1]
          : undefined,
        "segundo host_message",
      );
      const inner2 = JSON.parse(
        Buffer.from((wrapped2.inner as { ct: string }).ct, "base64").toString("utf8"),
      ) as ServerMessage;
      expect(inner2).toEqual({ type: "pong", in_reply_to: ping2 });
    } finally {
      await app?.close();
      childRelay?.close();
      await bridge?.stop();
      await relay.close();
    }
  });
});
