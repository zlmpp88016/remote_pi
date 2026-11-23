/**
 * Plan 86 P1 — HostBridge dispatch for `history_*` (real temp files, fake relay).
 *
 * Proves the host-room contract end to end without a relay or a Pi:
 *   - `workspace_history_v1` is advertised;
 *   - the existing unknown-peer allow-list still denies the new family;
 *   - list/read/body answer from the derived session bucket while the workspace
 *     Pi is stopped/starting/restarting, and the fleet's start/stop are never
 *     called (zero spawn);
 *   - replies are typed for malformed requests, unknown workspaces, bad
 *     cursors, and never contain a host path.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBridge } from "./host_bridge.js";
import type { FleetEntry, FleetOps, FleetRuntimeSnapshot } from "./host_control.js";
import { createInlineHistoryPort } from "../session/history_worker_client.js";
import {
  assistantMessage,
  makeHistoryFixture,
  textBlock,
  toolCallBlock,
  userMessage,
  writeTranscript,
  type HistoryFixture,
} from "../../test/history_fixtures.js";
import type { ClientMessage, ServerMessage, WorkspaceState } from "../protocol/types.js";

const DAEMON = "aaaa1111";
const UNKNOWN_DAEMON = "ffff9999";
const PEER = "peer-1";
const STRANGER = "peer-stranger";

class FakeRelay extends EventEmitter {
  readonly outbound: string[] = [];
  async connect(): Promise<void> {
    /* immediate */
  }
  send(line: string): void {
    this.outbound.push(line);
  }
  close(): void {
    /* no-op */
  }
}

interface FleetHarness {
  ops: FleetOps;
  calls: string[];
  setRuntime(snapshot: FleetRuntimeSnapshot): void;
}

function makeFleet(cwd: string): FleetHarness {
  const calls: string[] = [];
  let runtime: FleetRuntimeSnapshot = { state: "stopped", session_id: null, ready: false };
  const entry: FleetEntry = { id: DAEMON, cwd, name: "ws", live: false, source: "added" };
  const forbidden = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`history must not ${name}`);
  };
  const ops: FleetOps = {
    list: () => [entry],
    ensure: forbidden("ensure") as FleetOps["ensure"],
    start: forbidden("start") as FleetOps["start"],
    stop: (async () => {
      calls.push("stop");
      throw new Error("history must not stop");
    }) as FleetOps["stop"],
    addWorkspace: forbidden("addWorkspace") as FleetOps["addWorkspace"],
    removeWorkspace: forbidden("removeWorkspace") as FleetOps["removeWorkspace"],
    runtime: (id) => (id === DAEMON ? runtime : null),
  };
  return {
    ops,
    calls,
    setRuntime: (snapshot) => {
      runtime = snapshot;
    },
  };
}

let fixture: HistoryFixture;
let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  fixture = makeHistoryFixture();
  home = mkdtempSync(join(tmpdir(), "rp86-bridge-home-"));
  savedHome = process.env["REMOTE_PI_HOME"];
  process.env["REMOTE_PI_HOME"] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["REMOTE_PI_HOME"];
  else process.env["REMOTE_PI_HOME"] = savedHome;
  fixture.cleanup();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function deliver(relay: FakeRelay, peer: string, inner: ClientMessage): void {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  relay.emit("message", JSON.stringify({ peer, room: "host", ct }));
}

function replyAt(relay: FakeRelay, index: number): ServerMessage {
  const line = relay.outbound[index];
  if (line === undefined) throw new Error(`no outbound reply at ${index}`);
  const outer = JSON.parse(line) as { ct: string };
  return JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ServerMessage;
}

function lastReply(relay: FakeRelay): ServerMessage {
  return replyAt(relay, relay.outbound.length - 1);
}

async function bootBridge(
  fleet: FleetHarness,
  options: { allowListed?: boolean; history?: Record<string, unknown> } = {},
): Promise<{ bridge: HostBridge; relay: FakeRelay; terminated: () => number }> {
  const relay = new FakeRelay();
  let terminated = 0;
  const portFactory = () => {
    const port = createInlineHistoryPort();
    return {
      ...port,
      terminate: async () => {
        terminated += 1;
        await port.terminate();
        return 0;
      },
    };
  };
  const bridge = new HostBridge({
    fleet: fleet.ops,
    relayFactory: () => relay as never,
    ...(options.allowListed === false ? {} : { listPeersFn: async () => [{ remote_epk: PEER }] }),
    history: {
      agentRoot: fixture.root,
      workerPortFactory: portFactory,
      ...options.history,
    },
  });
  await bridge.start();
  return { bridge, relay, terminated: () => terminated };
}

async function waitForReply(
  relay: FakeRelay,
  fromIndex: number,
  predicate: (reply: ServerMessage) => boolean,
  timeoutMs = 3000,
): Promise<ServerMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let index = fromIndex; index < relay.outbound.length; index += 1) {
      const reply = replyAt(relay, index);
      if (predicate(reply)) return reply;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for a matching reply");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function standardSession() {
  return writeTranscript(fixture.bucket, {
    id: "s1",
    cwd: fixture.cwd,
    name: "project",
    messages: [
      userMessage("u1", "hello"),
      assistantMessage("a1", [textBlock("hi"), toolCallBlock("tc1", "read", { padding: "p".repeat(9000) })]),
      { id: "r1", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "done" }] } },
    ],
  });
}

describe("plan 86 P1 — HostBridge history capability and dispatch", () => {
  test("host_hello advertises workspace_history_v1", async () => {
    const fleet = makeFleet(fixture.cwd);
    const { bridge, relay } = await bootBridge(fleet);
    try {
      deliver(relay, PEER, { type: "host_hello", id: "h1" });
      const reply = lastReply(relay);
      expect(reply.type).toBe("host_hello_ok");
      if (reply.type !== "host_hello_ok") return;
      expect(reply.capabilities).toContain("workspace_history_v1");
    } finally {
      await bridge.stop();
    }
  });

  test("an unpaired/unknown peer is still denied the new family", async () => {
    standardSession();
    const fleet = makeFleet(fixture.cwd);
    const { bridge, relay } = await bootBridge(fleet);
    try {
      deliver(relay, STRANGER, { type: "history_list", id: "q1", daemon_id: DAEMON });
      expect(relay.outbound).toHaveLength(0);
      expect(fleet.calls).toEqual([]);
    } finally {
      await bridge.stop();
    }
  });

  test("list/read/body over the host room, with zero spawn in every lifecycle state", async () => {
    standardSession();
    const fleet = makeFleet(fixture.cwd);
    const { bridge, relay } = await bootBridge(fleet, { history: { bodyEagerMaxBytes: 0 } });
    try {
      for (const [index, state] of (["stopped", "starting", "running", "crashed"] as WorkspaceState[]).entries()) {
        fleet.setRuntime({ state, session_id: null, ready: state === "stopped" ? false : null });
        deliver(relay, PEER, { type: "history_list", id: `L-${index}`, daemon_id: DAEMON });
        const listed = await waitForReply(relay, index, (reply) => reply.type === "history_list_ok" || reply.type === "history_error");
        expect(listed.type).toBe("history_list_ok");
        if (listed.type !== "history_list_ok") continue;
        expect(listed.sessions.map((session) => session.id)).toEqual(["s1"]);
        expect(listed.current).toMatchObject({ state, source: "runtime" });
        expect(JSON.stringify(listed)).not.toContain(fixture.bucket);
        expect(JSON.stringify(listed)).not.toContain(fixture.cwd);
      }

      deliver(relay, PEER, { type: "history_read", id: "R1", daemon_id: DAEMON, session_id: "s1" });
      const read = await waitForReply(relay, 4, (reply) => reply.type === "history_read_ok");
      if (read.type !== "history_read_ok") throw new Error("no read");
      expect(read.items.map((item) => item.event_id)).toEqual(["u1", "a1#0", "a1#1", "r1"]);
      expect(JSON.stringify(read)).not.toContain(fixture.bucket);

      const toolRequest = read.items.find((item) => item.event_id === "a1#1")!;
      const ref = toolRequest.body_refs?.[0];
      expect(ref).toBeDefined();

      deliver(relay, PEER, {
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: "s1",
        snapshot: read.snapshot,
        body_ref: ref!.ref,
        offset_bytes: 0,
      });
      const building = await waitForReply(relay, 5, (reply) => reply.type === "history_error" && reply.code === "building");
      expect(building.type).toBe("history_error");

      deliver(relay, PEER, {
        type: "history_body",
        id: "B2",
        daemon_id: DAEMON,
        session_id: "s1",
        snapshot: read.snapshot,
        body_ref: ref!.ref,
        offset_bytes: 0,
      });
      const body = await waitForReply(relay, 6, (reply) => reply.type === "history_body_ok");
      if (body.type !== "history_body_ok") throw new Error("no body");
      expect(JSON.parse(Buffer.from(body.data, "base64").toString("utf8"))).toEqual({
        padding: "p".repeat(9000),
      });
      expect(body.total_bytes).toBe(ref!.total_bytes);

      // Zero spawn: the history path never asked the fleet to start/stop/ensure.
      expect(fleet.calls).toEqual([]);
    } finally {
      await bridge.stop();
    }
  });

  test("typed errors: unknown workspace, malformed request, bad cursor", async () => {
    standardSession();
    const fleet = makeFleet(fixture.cwd);
    const { bridge, relay } = await bootBridge(fleet);
    try {
      deliver(relay, PEER, { type: "history_list", id: "E1", daemon_id: UNKNOWN_DAEMON });
      const unknown = await waitForReply(
        relay,
        0,
        (reply) => reply.type === "history_error" && reply.in_reply_to === "E1",
      );
      expect(unknown).toMatchObject({ type: "history_error", code: "not_found", in_reply_to: "E1" });
      expect(unknown.type === "history_error" ? unknown.daemon_id : null).toBe(UNKNOWN_DAEMON);

      deliver(relay, PEER, { type: "history_list", id: "E2" } as unknown as ClientMessage);
      const malformed = await waitForReply(
        relay,
        1,
        (reply) => reply.type === "history_error" && reply.in_reply_to === "E2",
      );
      expect(malformed).toMatchObject({ type: "history_error", code: "invalid_request", in_reply_to: "E2" });

      deliver(relay, PEER, {
        type: "history_read",
        id: "E3",
        daemon_id: DAEMON,
        session_id: "s1",
        before: "not-a-cursor",
      } as ClientMessage);
      const badCursor = await waitForReply(
        relay,
        2,
        (reply) => reply.type === "history_error" && reply.in_reply_to === "E3",
      );
      expect(badCursor).toMatchObject({ type: "history_error", code: "invalid_cursor" });

      expect(fleet.calls).toEqual([]);
    } finally {
      await bridge.stop();
    }
  });

  test("stopping the bridge disposes the owned workers", async () => {
    standardSession();
    const fleet = makeFleet(fixture.cwd);
    const { bridge, relay, terminated } = await bootBridge(fleet);
    deliver(relay, PEER, { type: "history_list", id: "L1", daemon_id: DAEMON });
    await waitForReply(relay, 0, (reply) => reply.type === "history_list_ok");
    expect(terminated()).toBe(0);
    await bridge.stop();
    // Plan 86 P2 owns two roles (writer + read-only reader); both terminate.
    expect(terminated()).toBeGreaterThanOrEqual(1);
  });
});
