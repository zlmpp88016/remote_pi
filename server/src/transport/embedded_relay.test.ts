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

  /*
   * Room catalog. These frames used to be ignored outright on the theory that
   * room browsing "only matters across multiple machines". That was wrong: the
   * room carries `cwd`, and the app's workspace dock returns early without it.
   * The failure mode was silent — the client simply never learned any room.
   */
  test("subscribe_rooms is answered with the LIVE catalog, including cwd", async () => {
    const kp = generateEd25519Keypair();
    const peer = Buffer.from(kp.publicKey).toString("base64");
    const liveRoom = {
      room_id: "roomabcdef12",
      started_at: 1_700_000_000_000,
      name: "proj",
      cwd: "/work/proj",
    };
    // Registered but NOT running: the supervisor's fleet catalog lists every
    // workspace, so reporting it as live is what made the app send
    // `session_sync` into a route with no daemon behind it during a respawn.
    const deadRoom = {
      room_id: "roomdeadbeef",
      started_at: 1_700_000_000_000,
      name: "other",
      cwd: "/work/other",
    };
    relay = await startEmbeddedRelay({
      roomCatalog: () => ({ peer, rooms: [liveRoom, deadRoom] }),
    });

    // The daemon the catalog describes: authenticated at (peer, liveRoom).
    const daemon = new RelayClient(relay.url, kp);
    await daemon.connect({ roomId: liveRoom.room_id });

    const client = new RelayClient(relay.url, kp);
    const seen: Array<Record<string, unknown>> = [];
    client.on("message", (line) => seen.push(JSON.parse(line) as Record<string, unknown>));
    await client.connect();
    client.sendControl({ type: "subscribe_rooms", peers: [peer] });

    await waitFor(() => seen.some((m) => m["type"] === "rooms"));

    const snapshot = seen.find((m) => m["type"] === "rooms");
    expect(snapshot?.["peer"]).toBe(peer);
    // The live room is reported with its cwd; the one nobody is listening on
    // is omitted, so `isRoomLive` on the client tracks the routing table.
    expect(snapshot?.["rooms"]).toEqual([liveRoom]);

    // Exactly ONE reply: a snapshot plus per-room announces made the client
    // rebuild its tile list N+1 times per subscribe, which stormed the UI.
    expect(seen.filter((m) => m["type"] === "rooms")).toHaveLength(1);
    expect(seen.filter((m) => m["type"] === "room_announced")).toHaveLength(0);

    daemon.close();
    client.close();
  });

  test("a room's respawn is pushed to watchers as room_ended then room_announced", async () => {
    // THE regression this relay existed without: `rooms` was pull-only, so a
    // client could never learn that a daemon had come back. A `session_switch`
    // exits the child and the supervisor respawns it ~30 s later; every sync
    // sent in that gap was dropped, and the app sat empty forever.
    const hostKp = generateEd25519Keypair();
    const appKp = generateEd25519Keypair();
    const hostPeer = Buffer.from(hostKp.publicKey).toString("base64");
    const room = "roomabcdef12";
    relay = await startEmbeddedRelay({
      roomCatalog: () => ({
        peer: hostPeer,
        rooms: [{ room_id: room, started_at: 1, name: "proj", cwd: "/work/proj" }],
      }),
    });

    const app = new RelayClient(relay.url, appKp);
    const seen: Array<Record<string, unknown>> = [];
    app.on("message", (line) => seen.push(JSON.parse(line) as Record<string, unknown>));
    await app.connect();
    app.sendControl({ type: "subscribe_rooms", peers: [hostPeer] });
    await waitFor(() => seen.some((m) => m["type"] === "rooms"));

    const daemon = new RelayClient(relay.url, hostKp);
    await daemon.connect({ roomId: room, roomMeta: { name: "proj", cwd: "/work/proj" } });
    await waitFor(() => seen.some((m) => m["type"] === "room_announced"));
    const announced = seen.find((m) => m["type"] === "room_announced");
    expect(announced?.["peer"]).toBe(hostPeer);
    expect(announced?.["room_id"]).toBe(room);
    expect(announced?.["cwd"]).toBe("/work/proj");
    expect(typeof announced?.["started_at"]).toBe("number");

    // The switch: the child exits, so its socket closes.
    daemon.close();
    await waitFor(() => seen.some((m) => m["type"] === "room_ended"));
    const ended = seen.find((m) => m["type"] === "room_ended");
    expect(ended?.["peer"]).toBe(hostPeer);
    expect(ended?.["room_id"]).toBe(room);

    // The supervisor's respawn authenticates a NEW connection on the same room.
    const respawned = new RelayClient(relay.url, hostKp);
    await respawned.connect({ roomId: room, roomMeta: { name: "proj", cwd: "/work/proj" } });
    await waitFor(() => seen.filter((m) => m["type"] === "room_announced").length === 2);

    // And a pull now agrees with the pushes: the room is live again.
    app.sendControl({ type: "rooms_check", peers: [hostPeer] });
    await waitFor(() => seen.filter((m) => m["type"] === "rooms").length === 2);
    const snapshots = seen.filter((m) => m["type"] === "rooms");
    expect((snapshots[1]?.["rooms"] as unknown[]).length).toBe(1);

    respawned.close();
    app.close();
  });

  test("rooms_check answers too (the app sends both frames)", async () => {
    const kp = generateEd25519Keypair();
    relay = await startEmbeddedRelay({
      roomCatalog: () => ({ peer: "hostpeer", rooms: [{ room_id: "r1", started_at: 1 }] }),
    });

    const client = new RelayClient(relay.url, kp);
    const seen: Array<Record<string, unknown>> = [];
    client.on("message", (line) => seen.push(JSON.parse(line) as Record<string, unknown>));
    await client.connect();
    client.sendControl({ type: "rooms_check", peers: [] });

    await waitFor(() => seen.some((m) => m["type"] === "rooms"));
    expect(seen.some((m) => m["type"] === "rooms")).toBe(true);
  });

  test("without a catalog the answer is an empty snapshot, never silence", async () => {
    // A bare relay has nothing to describe, but it must still ANSWER — a client
    // that gets no reply cannot distinguish "no rooms" from "relay is broken".
    const kp = generateEd25519Keypair();
    relay = await startEmbeddedRelay();

    const client = new RelayClient(relay.url, kp);
    const seen: Array<Record<string, unknown>> = [];
    client.on("message", (line) => seen.push(JSON.parse(line) as Record<string, unknown>));
    await client.connect();
    client.sendControl({ type: "subscribe_rooms", peers: [] });

    await waitFor(() => seen.some((m) => m["type"] === "rooms"));
    const snapshot = seen.find((m) => m["type"] === "rooms");
    expect(snapshot?.["rooms"]).toEqual([]);
  });

  test("subscribe_presence marks the asking peer online", async () => {
    const kp = generateEd25519Keypair();
    relay = await startEmbeddedRelay();

    const client = new RelayClient(relay.url, kp);
    const seen: Array<Record<string, unknown>> = [];
    client.on("message", (line) => seen.push(JSON.parse(line) as Record<string, unknown>));
    await client.connect();
    const peer = Buffer.from(kp.publicKey).toString("base64");
    client.sendControl({ type: "subscribe_presence", peers: [peer] });

    await waitFor(() => seen.some((m) => m["type"] === "peer_online"));
    expect(seen.find((m) => m["type"] === "peer_online")?.["peer"]).toBe(peer);
  });
});

/** Polls until [predicate] holds, so a local async round trip needs no fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
