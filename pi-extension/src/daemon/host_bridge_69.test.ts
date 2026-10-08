import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// Same pattern as pairing/storage.test.ts: stub `homedir` BEFORE the module
// graph loads, so `addPeer` (src/pairing/storage.ts) writes peers.json inside
// a temp dir instead of the developer's real ~/.pi/remote.
const _tmpHome = mkdtempSync(join(tmpdir(), "pi-hostbr69-"));
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => _tmpHome };
});

const { HostBridge } = await import("./host_bridge.js");
const { HostPairingSession } = await import("../pairing/host_pairing.js");
const storage = await import("../pairing/storage.js");
import { hostname } from "node:os";
import type { FleetOps } from "./host_control.js";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";

/**
 * Plan/69 W1 — daemon-side pairing on the host room.
 *
 * The supervisor (zero Pi processes) answers `pair_request` from an UNKNOWN
 * peer — the one allow-list carve-out. Everything else from an unknown peer
 * stays dropped. Token validation, `addPeer` persistence and the typed
 * `pair_ok`/`pair_error` flow all run for real here.
 */

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

/** Sends `inner` through the fake relay exactly as the relay would deliver it. */
function deliver(relay: FakeRelay, peer: string, inner: ClientMessage): void {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  relay.emit("message", JSON.stringify({ peer, room: "host", ct }));
}

/** Polls until the bridge pushed its Nth outbound line (its pair handler is
 *  async, so replies land after the synchronous dispatch returns). */
async function waitForReply(relay: FakeRelay, nth: number, timeoutMs = 2000): Promise<ServerMessage> {
  const started = Date.now();
  while (relay.outbound.length < nth && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const line = relay.outbound[nth - 1];
  if (!line) throw new Error(`no outbound reply #${nth}`);
  const outer = JSON.parse(line) as { ct: string };
  return JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ServerMessage;
}

/** Waits for the NEXT reply after the ones already recorded. */
function nextReply(relay: FakeRelay): Promise<ServerMessage> {
  return waitForReply(relay, relay.outbound.length + 1);
}

/** Asserts the bridge stayed silent (dropped) for `waitMs`. */
async function expectSilence(relay: FakeRelay, waitMs = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, waitMs));
  expect(relay.outbound).toHaveLength(0);
}

function fleetStub(): FleetOps {
  return {
    list: () => [],
    ensure: (cwd) => ({ ok: true, id: "stub", cwd, name: "ws" }),
    start: () => ({ ok: true, started: true }),
    stop: async () => ({ ok: true, stopped: true }),
    addWorkspace: (cwd) => ({ ok: true, cwd, added: true }),
    removeWorkspace: (cwd) => ({ ok: true, cwd, removed: true }),
  };
}

async function bootBridge(
  listPeersFn?: () => Promise<Array<{ remote_epk: string }>>,
): Promise<{ bridge: HostBridge; relay: FakeRelay; pairing: HostPairingSession }> {
  const relay = new FakeRelay();
  const pairing = new HostPairingSession();
  const bridge = new HostBridge({
    fleet: fleetStub(),
    relayFactory: () => relay as never,
    pairing,
    ...(listPeersFn ? { listPeersFn } : {}),
  });
  await bridge.start();
  return { bridge, relay, pairing };
}

describe("plan/69 — HostBridge pair_request (daemon-side pairing)", () => {
  test("happy path: unknown peer + valid token → pair_ok + peer in peers.json", async () => {
    // A non-empty allow-list so the carve-out is genuinely exercised: the
    // phone is NOT in it and only gets in via pair_request.
    const { bridge, relay, pairing } = await bootBridge(async () => [{ remote_epk: "known-peer" }]);
    try {
      const rec = await pairing.issue();
      deliver(relay, "phone-peer", {
        type: "pair_request",
        id: "req-1",
        token: rec.token,
        device_name: "Test Phone",
      });
      const reply = await waitForReply(relay, 1);
      expect(reply).toEqual({
        type: "pair_ok",
        in_reply_to: "req-1",
        session_name: hostname(),
        session_started_at: expect.any(Number),
        room_id: "host",
        hostname: hostname(),
      });

      const peers = await storage.listPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0]).toMatchObject({ name: "Test Phone", remote_epk: "phone-peer" });
      expect(typeof peers[0]!.paired_at).toBe("string");
    } finally {
      await bridge.stop();
    }
  });

  test("the freshly paired peer passes the allow-list for non-pair traffic", async () => {
    const { bridge, relay, pairing } = await bootBridge(async () => [{ remote_epk: "known-peer" }]);
    try {
      const rec = await pairing.issue();
      deliver(relay, "phone-peer", {
        type: "pair_request",
        id: "req-1",
        token: rec.token,
        device_name: "Test Phone",
      });
      await waitForReply(relay, 1);

      // Without the post-pair allow-list refresh this would be dropped.
      // (workspace_list replies synchronously, so capture the count first.)
      const before = relay.outbound.length;
      deliver(relay, "phone-peer", { type: "workspace_list", id: "l1" });
      const reply = await waitForReply(relay, before + 1);
      expect(reply.type).toBe("workspace_list_ok");
      if (reply.type !== "workspace_list_ok") throw new Error("wrong type");
      expect(reply.in_reply_to).toBe("l1");
    } finally {
      await bridge.stop();
    }
  });

  test("allow-list carve-out: ONLY pair_request from an unknown peer is admitted", async () => {
    const { bridge, relay, pairing } = await bootBridge(async () => [{ remote_epk: "known-peer" }]);
    try {
      // A non-pair inner from an unknown peer is still dropped, silently.
      deliver(relay, "stranger", { type: "workspace_list", id: "x1" });
      await expectSilence(relay);

      // …while the pair_request from the same unknown peer is processed.
      const rec = await pairing.issue();
      deliver(relay, "stranger", {
        type: "pair_request",
        id: "req-2",
        token: rec.token,
        device_name: "Stranger Phone",
      });
      const reply = await waitForReply(relay, 1);
      expect(reply.type).toBe("pair_ok");
    } finally {
      await bridge.stop();
    }
  });

  test("invalid token → pair_error{token_unknown}", async () => {
    const { bridge, relay, pairing } = await bootBridge();
    try {
      await pairing.issue();
      deliver(relay, "phone-peer", {
        type: "pair_request",
        id: "req-1",
        token: "not-issued-by-this-host",
        device_name: "Phone",
      });
      const reply = await waitForReply(relay, 1);
      expect(reply).toEqual({
        type: "pair_error",
        in_reply_to: "req-1",
        code: "token_unknown",
        message: "Token was not issued by this host.",
      });
      expect(await storage.listPeers()).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });

  test("expired ephemeral token → pair_error{token_expired}", async () => {
    const { bridge, relay, pairing } = await bootBridge();
    try {
      const rec = await pairing.issue({ ephemeral: true, ttlMs: 1 });
      await new Promise((r) => setTimeout(r, 25));
      deliver(relay, "phone-peer", {
        type: "pair_request",
        id: "req-1",
        token: rec.token,
        device_name: "Phone",
      });
      const reply = await waitForReply(relay, 1);
      expect(reply).toEqual({
        type: "pair_error",
        in_reply_to: "req-1",
        code: "token_expired",
        message: "Ephemeral token expired. Generate a new code with `remote-pi pair`.",
      });
      expect(await storage.listPeers()).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });

  test("consumed ephemeral token → pair_error{token_consumed}", async () => {
    const { bridge, relay, pairing } = await bootBridge();
    try {
      const rec = await pairing.issue({ ephemeral: true });
      deliver(relay, "phone-a", {
        type: "pair_request",
        id: "req-a",
        token: rec.token,
        device_name: "Phone A",
      });
      expect((await waitForReply(relay, 1)).type).toBe("pair_ok");

      deliver(relay, "phone-b", {
        type: "pair_request",
        id: "req-b",
        token: rec.token,
        device_name: "Phone B",
      });
      const reply = await nextReply(relay);
      expect(reply).toEqual({
        type: "pair_error",
        in_reply_to: "req-b",
        code: "token_consumed",
        message: "Token already consumed by another pair_request.",
      });
      const peers = await storage.listPeers();
      expect(peers.map((p) => p.remote_epk)).toEqual(["phone-a"]);
    } finally {
      await bridge.stop();
    }
  });

  test("rotated token → pair_error{token_unknown} on the old code", async () => {
    const { bridge, relay, pairing } = await bootBridge();
    try {
      const old = await pairing.issue();
      const fresh = await pairing.issue(); // --rotate
      deliver(relay, "phone-peer", {
        type: "pair_request",
        id: "req-old",
        token: old.token,
        device_name: "Phone",
      });
      const reply = await waitForReply(relay, 1);
      expect(reply).toMatchObject({ type: "pair_error", code: "token_unknown" });

      // The rotated-in code still pairs.
      deliver(relay, "phone-peer", {
        type: "pair_request",
        id: "req-new",
        token: fresh.token,
        device_name: "Phone",
      });
      const ok = await nextReply(relay);
      expect(ok).toMatchObject({ type: "pair_ok", in_reply_to: "req-new" });
      expect(await storage.listPeers()).toHaveLength(1);
    } finally {
      await bridge.stop();
    }
  });

  test("an already-paired peer re-pasting the persistent code re-pairs idempotently", async () => {
    const { bridge, relay, pairing } = await bootBridge();
    try {
      const rec = await pairing.issue();
      for (const id of ["req-1", "req-2"]) {
        deliver(relay, "phone-peer", {
          type: "pair_request",
          id,
          token: rec.token,
          device_name: "Test Phone",
        });
        const reply = await nextReply(relay);
        expect(reply).toMatchObject({ type: "pair_ok", in_reply_to: id });
      }
      // Idempotent re-pair: one storage row, not two.
      expect(await storage.listPeers()).toHaveLength(1);
    } finally {
      await bridge.stop();
    }
  });
});
