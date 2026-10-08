import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// Same hermetic-home pattern as host_bridge_69.test.ts: stub `homedir`
// BEFORE the module graph loads so identity/pairing writes land in a temp
// dir instead of the developer's real ~/.pi/remote.
const _tmpHome = mkdtempSync(join(tmpdir(), "pi-hostbr69p-"));
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => _tmpHome };
});

const { HostBridge } = await import("./host_bridge.js");
const storage = await import("../pairing/storage.js");
import type { FleetEntry, FleetOps } from "./host_control.js";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";

/**
 * Plan/69 W2 — the host_forward/host_message proxy (spike decision B) and
 * the lifecycle/handshake surface, exercised against a fake relay that
 * records every outbound line.
 *
 * Wire contract under test (validated against the real relay in
 * scripts/spike-room-multiplex.mjs — the relay rewrites each delivered
 * envelope with the SENDER's peer+room):
 *
 *   app ─host_forward(room=child, ct)─▶ host re-emits {peer: OWN, room: child, ct}
 *   child ─{peer: OWN, room: "host", ct}─▶ relay rewrites → host sees
 *        {peer: OWN, room: child} → wraps host_message{room, ct} → fans out
 */

const CHILD_ROOM = "kX9fT2mQwE7r"; // 12-char b64url — roomIdFor format
const APP_A = "app-peer-a";
const APP_B = "app-peer-b";

class FakeRelay extends EventEmitter {
  readonly outbound: string[] = [];
  async connect(): Promise<void> { /* immediate */ }
  send(line: string): void { this.outbound.push(line); }
  close(): void { /* no-op */ }
}

/** In-memory keyring so identity minting is hermetic on every platform. */
class InMemoryBackend {
  private store = new Map<string, string>();
  async read(): Promise<string | undefined> { return this.store.get("k"); }
  async write(_s: string, _a: string, value: string): Promise<void> { this.store.set("k", value); }
  async delete(): Promise<boolean> { return this.store.delete("k"); }
}

let savedHome: string | undefined;
/** The machine's own Pi-key (base64) — what the bridge relays under. */
let ownPubkey: string;

beforeEach(async () => {
  savedHome = process.env["REMOTE_PI_HOME"];
  process.env["REMOTE_PI_HOME"] = _tmpHome;
  storage._setKeyStoreBackendForTest(new InMemoryBackend() as never);
  // Same store the bridge reads in _connect → the same key.
  const kp = await storage.getOrCreateEd25519Keypair();
  ownPubkey = Buffer.from(kp.publicKey).toString("base64");
});

afterEach(() => {
  storage._setKeyStoreBackendForTest(null);
  if (savedHome === undefined) delete process.env["REMOTE_PI_HOME"];
  else process.env["REMOTE_PI_HOME"] = savedHome;
  try { rmSync(join(_tmpHome, ".pi", "remote"), { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Delivers `inner` to the bridge exactly as the relay would: outer envelope
 *  on the host room, rewritten with the sender's peer. */
function deliver(relay: FakeRelay, peer: string, inner: ClientMessage, room = "host"): void {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  relay.emit("message", JSON.stringify({ peer, room, ct }));
}

/** Delivers a raw outer envelope (own-key child replies have no inner type
 *  the host needs to parse — `ct` rides opaquely). */
function deliverOuter(relay: FakeRelay, outer: { peer: string; room?: string; ct: string }): void {
  relay.emit("message", JSON.stringify(outer));
}

interface DecodedOutbound {
  peer: string;
  room?: string;
  inner: ServerMessage;
  raw: string;
}

function decodeOutbound(line: string): DecodedOutbound {
  const outer = JSON.parse(line) as { peer: string; room?: string; ct: string };
  return {
    peer: outer.peer,
    room: outer.room,
    inner: JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ServerMessage,
    raw: line,
  };
}

function outbound(relay: FakeRelay): DecodedOutbound[] {
  return relay.outbound.map(decodeOutbound);
}

/** A fleet whose single row's liveness the test controls; `start` records. */
function fleetStub(opts: { live: boolean; started?: string[]; entry?: Partial<FleetEntry> }): FleetOps {
  const entry: FleetEntry = {
    id: "daemon-1",
    cwd: "/tmp/ws",
    name: "ws",
    live: opts.live,
    source: "daemon",
    ...opts.entry,
  };
  return {
    list: () => [entry],
    ensure: (cwd) => ({ ok: true, id: entry.id, cwd, name: entry.name }),
    start: (id) => {
      opts.started?.push(id);
      return { ok: true, started: true };
    },
    stop: async () => ({ ok: true, stopped: true }),
    addWorkspace: (cwd) => ({ ok: true, cwd, added: true }),
    removeWorkspace: (cwd) => ({ ok: true, cwd, removed: true }),
  };
}

async function bootBridge(
  fleet: FleetOps,
  listPeersFn?: () => Promise<Array<{ remote_epk: string }>>,
): Promise<{ bridge: HostBridge; relay: FakeRelay }> {
  const relay = new FakeRelay();
  const bridge = new HostBridge({
    fleet,
    relayFactory: () => relay as never,
    ...(listPeersFn ? { listPeersFn } : {}),
  });
  await bridge.start();
  return { bridge, relay };
}

describe("plan/69 — HostBridge host_forward proxy (spike decision B)", () => {
  test("host_forward re-emits {peer: own epk, room: childRoom, ct} on the host connection", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
      { remote_epk: APP_B },
    ]);
    try {
      const innerCt = Buffer.from(JSON.stringify({ type: "ping", id: "p1" })).toString("base64");
      deliver(relay, APP_A, { type: "host_forward", id: "fwd-1", room: CHILD_ROOM, ct: innerCt });

      expect(relay.outbound).toHaveLength(1);
      const line = JSON.parse(relay.outbound[0]!) as { peer: string; room?: string; ct: string };
      // Same Pi-key, child room, ct passed through opaquely — the relay
      // routes (own, childRoom) to the child's connection.
      expect(line.peer).toBe(ownPubkey);
      expect(line.room).toBe(CHILD_ROOM);
      expect(line.ct).toBe(innerCt);
    } finally {
      await bridge.stop();
    }
  });

  test("host_forward from an unknown peer is dropped by the allow-list", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
    ]);
    try {
      const innerCt = Buffer.from(JSON.stringify({ type: "ping", id: "p1" })).toString("base64");
      deliver(relay, "stranger", { type: "host_forward", id: "fwd-x", room: CHILD_ROOM, ct: innerCt });
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.outbound).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });

  test("own-key inbound → host_message fan-out to ALL allow-listed peers", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
      { remote_epk: APP_B },
    ]);
    try {
      // The relay rewrote the child's reply with the sender identity:
      // {peer: own pubkey, room: childRoom}. Note the own key is NOT in the
      // allow-list — the detection runs before that check.
      const childCt = Buffer.from(JSON.stringify({ type: "pong", in_reply_to: "p1" })).toString("base64");
      deliverOuter(relay, { peer: ownPubkey, room: CHILD_ROOM, ct: childCt });

      expect(relay.outbound).toHaveLength(2);
      const frames = outbound(relay);
      expect(frames.map((f) => f.peer).sort()).toEqual([APP_A, APP_B].sort());
      for (const f of frames) {
        expect(f.room).toBe("host");
        expect(f.inner).toEqual({ type: "host_message", room: CHILD_ROOM, ct: childCt });
      }
    } finally {
      await bridge.stop();
    }
  });

  test("own-key inbound on the host room is ignored (no self-loop)", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
    ]);
    try {
      const ct = Buffer.from(JSON.stringify({ type: "pong", in_reply_to: "p1" })).toString("base64");
      deliverOuter(relay, { peer: ownPubkey, room: "host", ct });
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.outbound).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });

  test("host_message fan-out with an empty allow-list reaches nobody", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => []);
    try {
      const ct = Buffer.from(JSON.stringify({ type: "pong" })).toString("base64");
      deliverOuter(relay, { peer: ownPubkey, room: CHILD_ROOM, ct });
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.outbound).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });
});

describe("plan/69 — HostBridge host_hello", () => {
  test("host_hello → host_hello_ok with real hostname/platform/version + capabilities", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
    ]);
    try {
      deliver(relay, APP_A, { type: "host_hello", id: "h1" });
      expect(relay.outbound).toHaveLength(1);
      const reply = decodeOutbound(relay.outbound[0]!).inner;
      expect(reply.type).toBe("host_hello_ok");
      if (reply.type !== "host_hello_ok") throw new Error("wrong type");
      expect(reply.in_reply_to).toBe("h1");
      expect(reply.daemon.hostname).toBe(hostname());
      expect(reply.daemon.platform).toBe(process.platform);
      // Version is read from the shipped package.json — never fabricated.
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version?: string };
      expect(reply.daemon.version).toBe(pkg.version ?? null);
      expect(reply.capabilities).toEqual(
        expect.arrayContaining(["host_pairing", "workspace_state", "host_forward", "fs_nav"]),
      );
    } finally {
      await bridge.stop();
    }
  });
});

describe("plan/69 — HostBridge workspace_restart (idempotent)", () => {
  test("already-running workspace → ok WITHOUT respawn", async () => {
    const started: string[] = [];
    const { bridge, relay } = await bootBridge(fleetStub({ live: true, started }), async () => [
      { remote_epk: APP_A },
    ]);
    try {
      deliver(relay, APP_A, { type: "workspace_restart", id: "r1", cwd: "/tmp/ws" });
      await vi.waitFor(() => expect(relay.outbound).toHaveLength(1));
      const reply = decodeOutbound(relay.outbound[0]!).inner;
      expect(reply).toEqual({
        type: "workspace_restart_ok",
        in_reply_to: "r1",
        cwd: "/tmp/ws",
        daemon_id: "daemon-1",
      });
      expect(started).toEqual([]); // idempotent — no respawn
    } finally {
      await bridge.stop();
    }
  });

  test("stopped workspace → started again, restarts counter untouched", async () => {
    const started: string[] = [];
    const { bridge, relay } = await bootBridge(fleetStub({ live: false, started }), async () => [
      { remote_epk: APP_A },
    ]);
    try {
      deliver(relay, APP_A, { type: "workspace_restart", id: "r2", cwd: "/tmp/ws" });
      await vi.waitFor(() => expect(relay.outbound).toHaveLength(1));
      const reply = decodeOutbound(relay.outbound[0]!).inner;
      expect(reply).toEqual({
        type: "workspace_restart_ok",
        in_reply_to: "r2",
        cwd: "/tmp/ws",
        daemon_id: "daemon-1",
      });
      expect(started).toEqual(["daemon-1"]);
    } finally {
      await bridge.stop();
    }
  });

  test("unknown cwd → typed not_found error", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
    ]);
    try {
      deliver(relay, APP_A, { type: "workspace_restart", id: "r3", cwd: "/nope" });
      await vi.waitFor(() => expect(relay.outbound).toHaveLength(1));
      const reply = decodeOutbound(relay.outbound[0]!).inner;
      expect(reply).toEqual({
        type: "workspace_restart_error",
        in_reply_to: "r3",
        code: "not_found",
        message: expect.stringContaining("/nope"),
      });
    } finally {
      await bridge.stop();
    }
  });

  test("spawn failure → typed spawn_failed error with the real reason", async () => {
    const fleet = fleetStub({ live: false });
    fleet.start = () => ({ ok: false, error: "spawn pi ENOENT" });
    const { bridge, relay } = await bootBridge(fleet, async () => [{ remote_epk: APP_A }]);
    try {
      deliver(relay, APP_A, { type: "workspace_restart", id: "r4", cwd: "/tmp/ws" });
      await vi.waitFor(() => expect(relay.outbound).toHaveLength(1));
      const reply = decodeOutbound(relay.outbound[0]!).inner;
      expect(reply).toEqual({
        type: "workspace_restart_error",
        in_reply_to: "r4",
        code: "spawn_failed",
        message: "spawn pi ENOENT",
      });
    } finally {
      await bridge.stop();
    }
  });
});

describe("plan/69 — HostBridge workspace_state push", () => {
  test("pushWorkspaceState fans the slot mirror out to every allow-listed peer", async () => {
    const { bridge, relay } = await bootBridge(fleetStub({ live: false }), async () => [
      { remote_epk: APP_A },
      { remote_epk: APP_B },
    ]);
    try {
      bridge.pushWorkspaceState({
        cwd: "/tmp/ws",
        state: "crashed",
        last_error: "exited with code 1",
        restarts: 2,
      });
      expect(relay.outbound).toHaveLength(2);
      for (const f of outbound(relay)) {
        expect(f.room).toBe("host");
        expect(f.inner).toEqual({
          type: "workspace_state",
          cwd: "/tmp/ws",
          state: "crashed",
          last_error: "exited with code 1",
          restarts: 2,
        });
      }
    } finally {
      await bridge.stop();
    }
  });
});
