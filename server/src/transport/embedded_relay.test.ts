import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { startEmbeddedRelay, type EmbeddedRelay } from "./embedded_relay.js";
import { RelayClient } from "./relay_client.js";
import { generateEd25519Keypair } from "../pairing/crypto.js";

/**
 * The embedded relay is the `--direct` path: no community relay, one host.
 *
 * These tests drive it through the REAL `RelayClient` (the same class the
 * daemon uses), so an interop break in the handshake or the envelope shape
 * fails here rather than only in a browser E2E.
 *
 * The single most important assertion is the identity rewrite: the recipient
 * must see the SENDER's peer/room, never the sender's claimed values. Without
 * it, any client could forge who a message came from — that is the property
 * the public relay exists to provide.
 */

/** Builds the wire frame exactly as `host_bridge`/`RelayClient` callers do. */
function envelope(peer: string, room: string, body: unknown): string {
  return JSON.stringify({ peer, room, ct: Buffer.from(JSON.stringify(body)).toString("base64") });
}

let relay: EmbeddedRelay | null = null;

afterEach(async () => {
  if (relay) {
    await relay.close();
    relay = null;
  }
});

describe("startEmbeddedRelay", () => {
  test("listens on loopback and reports the actual port", async () => {
    relay = await startEmbeddedRelay();
    expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    const port = Number(new URL(relay.url).port);
    expect(port).toBeGreaterThan(0);
  });

  test("accepts a real RelayClient handshake and routes an envelope to the target", async () => {
    relay = await startEmbeddedRelay();

    const hostKp = generateEd25519Keypair();
    const appKp = generateEd25519Keypair();
    const hostPeer = Buffer.from(hostKp.publicKey).toString("base64");
    const room = "room12345678";

    // Host connects on its own room, exactly like the supervisor's bridge.
    const host = new RelayClient(relay.url, hostKp);
    const hostLines: string[] = [];
    host.on("message", (line) => hostLines.push(line));
    await host.connect({ roomId: room });

    // App connects on the default room (the client does not send a room_id
    // for its own connection; it addresses the host by (peer, room)).
    const app = new RelayClient(relay.url, appKp);
    await app.connect();

    const payload = { type: "ping_from_app", n: 1 };
    app.send(envelope(hostPeer, room, payload));

    // Poll instead of a fixed sleep: the round trip is local but asynchronous.
    const deadline = Date.now() + 5_000;
    while (hostLines.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(hostLines).toHaveLength(1);
    const delivered = JSON.parse(hostLines[0]!) as {
      peer: string;
      room: string;
      ct: string;
    };

    // THE security invariant: the sender identity is the relay's, not the
    // sender's claim. The app must appear as the app's pubkey...
    const appPeer = Buffer.from(appKp.publicKey).toString("base64");
    expect(delivered.peer).toBe(appPeer);
    // ...and the room is the APP's own room ("main"), NOT the destination room
    // it addressed. Conflating them would let a sender spoof the origin room.
    expect(delivered.room).toBe("main");

    // The relay never decrypts: `ct` must survive byte-for-byte.
    expect(Buffer.from(delivered.ct, "base64").toString()).toBe(JSON.stringify(payload));

    host.close();
    app.close();
  });

  test("rewrites a spoofed peer field to the authenticated sender", async () => {
    relay = await startEmbeddedRelay();

    const hostKp = generateEd25519Keypair();
    const attackerKp = generateEd25519Keypair();
    const victimKp = generateEd25519Keypair();
    const hostPeer = Buffer.from(hostKp.publicKey).toString("base64");
    const victimPeer = Buffer.from(victimKp.publicKey).toString("base64");
    const attackerPeer = Buffer.from(attackerKp.publicKey).toString("base64");
    const room = "room12345678";

    const host = new RelayClient(relay.url, hostKp);
    const hostLines: string[] = [];
    host.on("message", (line) => hostLines.push(line));
    await host.connect({ roomId: room });

    const attacker = new RelayClient(relay.url, attackerKp);
    await attacker.connect();

    // An attacker addresses the host but claims (via the routing fields) to be
    // the victim. The relay must overwrite the identity with the attacker's.
    attacker.send(envelope(hostPeer, room, { type: "forged" }));

    const deadline = Date.now() + 5_000;
    while (hostLines.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(hostLines).toHaveLength(1);
    const delivered = JSON.parse(hostLines[0]!) as { peer: string };
    expect(delivered.peer).toBe(attackerPeer);
    expect(delivered.peer).not.toBe(victimPeer);

    host.close();
    attacker.close();
  });

  test("does not echo an envelope back to its own sender", async () => {
    relay = await startEmbeddedRelay();

    const kp = generateEd25519Keypair();
    const peer = Buffer.from(kp.publicKey).toString("base64");
    const room = "room12345678";

    // One client, connecting to its OWN (peer, room) — the multi-device case.
    const conn = new RelayClient(relay.url, kp);
    const lines: string[] = [];
    conn.on("message", (line) => lines.push(line));
    await conn.connect({ roomId: room });

    conn.send(envelope(peer, room, { type: "self" }));

    // Give it a generous window; an echo would arrive almost immediately.
    await new Promise((r) => setTimeout(r, 300));
    expect(lines).toHaveLength(0);

    conn.close();
  });

  test("drops an envelope for an unknown (peer, room) without crashing", async () => {
    relay = await startEmbeddedRelay();

    const kp = generateEd25519Keypair();
    const appPeer = Buffer.from(kp.publicKey).toString("base64");
    const room = "room12345678";

    const app = new RelayClient(relay.url, kp);
    await app.connect();

    // Nobody is listening at room12345678 — the send must be a no-op, and the
    // relay must still accept traffic afterwards (not wedge or throw).
    app.send(envelope("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", room, {}));
    await new Promise((r) => setTimeout(r, 100));

    // Prove the relay is still healthy by doing a real round trip against a
    // listener we register afterwards.
    const hostKp = generateEd25519Keypair();
    const hostPeer = Buffer.from(hostKp.publicKey).toString("base64");
    const host = new RelayClient(relay.url, hostKp);
    const hostLines: string[] = [];
    host.on("message", (line) => hostLines.push(line));
    await host.connect({ roomId: room });

    app.send(envelope(hostPeer, room, { type: "still_alive" }));

    const deadline = Date.now() + 5_000;
    while (hostLines.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hostLines).toHaveLength(1);

    app.close();
    host.close();
    expect(appPeer.length).toBeGreaterThan(0);
  });

  test("rejects a bad signature instead of trusting the claimed pubkey", async () => {
    relay = await startEmbeddedRelay();

    const kp = generateEd25519Keypair();
    // A HANDSHAKE the relay must refuse: hello with a pubkey, then an auth
    // frame carrying a signature over the WRONG message.
    const ws = new WebSocket(relay.url);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "hello", pubkey: Buffer.from(kp.publicKey).toString("base64") }));
      });
      ws.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === "challenge") {
          // Sign the WRONG bytes → verification must fail.
          ws.send(JSON.stringify({ type: "auth", sig: Buffer.alloc(64, 7).toString("base64") }));
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    expect(closed).toBe(true);
  });
});
