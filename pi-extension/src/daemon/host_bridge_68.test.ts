import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { HostBridge } from "./host_bridge.js";
import { addWorkspace, listWorkspaces, removeWorkspace } from "./workspaces.js";
import { daemonIdForCwd } from "./id.js";
import type { FleetEntry, FleetOps } from "./host_control.js";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";

/**
 * Plan/68 — dispatch test for the host room. Exercises the base64 `{peer, ct}`
 * transport the relay uses, proving the new `fs_list` / `workspace_add` /
 * `workspace_remove` messages reach their handlers and that replies come back
 * on the same wire shape (a fake relay records what was sent).
 */

class FakeRelay extends EventEmitter {
  readonly outbound: string[] = [];
  async connect(): Promise<void> { /* immediate */ }
  send(line: string): void { this.outbound.push(line); }
  close(): void { /* no-op */ }
}

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pi-hostbr-"));
  process.env["REMOTE_PI_HOME"] = testHome;
});

afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Sends `inner` through the fake relay exactly as the relay would deliver it. */
function deliver(relay: FakeRelay, peer: string, inner: ClientMessage): void {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  relay.emit("message", JSON.stringify({ peer, room: "host", ct }));
}

function lastReply(relay: FakeRelay): ServerMessage {
  const line = relay.outbound[relay.outbound.length - 1];
  if (!line) throw new Error("no outbound reply");
  const outer = JSON.parse(line) as { ct: string };
  return JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ServerMessage;
}

/** A fleet whose `added` rows mirror the real workspaces.json. */
function fleetStub(started: string[] = []): FleetOps {
  return {
    list: (): FleetEntry[] =>
      listWorkspaces().map((w) => ({
        id: daemonIdForCwd(w.cwd),
        cwd: w.cwd,
        name: w.name,
        live: false,
        source: "added" as const,
      })),
    ensure: (cwd) => {
      const { cwd: resolved } = addWorkspace(cwd);
      return { ok: true, id: daemonIdForCwd(resolved), cwd: resolved, name: "ws" };
    },
    start: (id) => { started.push(id); return { ok: true, started: true }; },
    stop: async () => ({ ok: true, stopped: true }),
    addWorkspace: (cwd) => {
      try {
        const { cwd: resolved, added } = addWorkspace(cwd);
        return { ok: true, cwd: resolved, added };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    removeWorkspace: (cwd) => {
      const { cwd: resolved, removed } = removeWorkspace(cwd);
      return { ok: true, cwd: resolved, removed };
    },
  };
}

async function bootBridge(
  fleet: FleetOps,
  relayFactoryPeers?: () => Promise<Array<{ remote_epk: string }>>,
): Promise<{ bridge: HostBridge; relay: FakeRelay }> {
  const relay = new FakeRelay();
  const opts: ConstructorParameters<typeof HostBridge>[0] = {
    fleet,
    relayFactory: () => relay as never,
  };
  if (relayFactoryPeers) opts.listPeersFn = relayFactoryPeers;
  const bridge = new HostBridge(opts);
  await bridge.start();
  return { bridge, relay };
}

describe("plan/68 — HostBridge dispatch", () => {
  // The host room only accepts peers in the persisted allow-list. The test
  // seeds no peers, and the bridge allows all when the list is empty.
  test("fs_list reaches the handler and replies fs_list_ok", async () => {
    const { bridge, relay } = await bootBridge(fleetStub());
    try {
      const dir = mkdtempSync(join(tmpdir(), "pi-hostfs-"));
      deliver(relay, "peer-1", { type: "fs_list", id: "q1", path: dir });
      const reply = lastReply(relay);
      expect(reply.type).toBe("fs_list_ok");
      if (reply.type !== "fs_list_ok") throw new Error("wrong type");
      expect(reply.in_reply_to).toBe("q1");
      rmSync(dir, { recursive: true, force: true });
    } finally {
      await bridge.stop();
    }
  });

  test("workspace_add / workspace_list / workspace_remove round-trip", async () => {
    const { bridge, relay } = await bootBridge(fleetStub());
    try {
      const dir = mkdtempSync(join(tmpdir(), "pi-hostws-"));
      deliver(relay, "peer-1", { type: "workspace_add", id: "a1", path: dir });
      expect(lastReply(relay)).toEqual({ type: "action_ok", in_reply_to: "a1", action: "workspace_add" });

      deliver(relay, "peer-1", { type: "workspace_list", id: "l1" });
      const list = lastReply(relay);
      expect(list.type).toBe("workspace_list_ok");
      if (list.type !== "workspace_list_ok") throw new Error("wrong type");
      const realCwd = listWorkspaces()[0]!.cwd;
      expect(list.workspaces.some((w) => w.cwd === realCwd && w.source === "added")).toBe(true);

      deliver(relay, "peer-1", { type: "workspace_remove", id: "r1", path: dir });
      expect(lastReply(relay)).toEqual({ type: "action_ok", in_reply_to: "r1", action: "workspace_remove" });
      rmSync(dir, { recursive: true, force: true });
    } finally {
      await bridge.stop();
    }
  });

  test("an unregistered peer is denied when an allow-list exists", async () => {
    const { bridge, relay } = await bootBridge(fleetStub(), async () => [{ remote_epk: "known-peer" }]);
    try {
      const dir = mkdtempSync(join(tmpdir(), "pi-hostdeny-"));
      deliver(relay, "stranger", { type: "workspace_add", id: "d1", path: dir });
      expect(relay.outbound).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      await bridge.stop();
    }
  });
});
