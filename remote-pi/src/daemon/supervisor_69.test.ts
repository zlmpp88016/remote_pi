import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { EventEmitter } from "node:events";
import type { ControlReply, ControlRequest } from "./control_protocol.js";
import type { FleetOps } from "./host_control.js";
import type { ServerMessage, WorkspaceState } from "../protocol/types.js";

/**
 * Plan/69 W2 — the supervisor pushes `workspace_state` on every child
 * lifecycle transition (exit / restart / start / stop), mirroring the
 * ChildSlot verbatim: real state, real last_error, real restart counter —
 * never fabricated.
 *
 * The HostBridge runs for real against a fake relay, so the assertions are
 * on the actual wire lines the app would receive (host room, fan-out to
 * every allow-listed peer).
 *
 * `spawn` is mocked with a fake ChildProcess the test drives explicitly
 * (kill + exit events), which makes every transition deterministic on every
 * platform — no dependence on how fast a real `pi` binary dies.
 */

const _tmpHome = mkdtempSync(join(tmpdir(), "pi-sv69-"));
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => _tmpHome,
    // Windows named pipes are user-scoped and path-independent
    // (`\\\\.\\pipe\\remote-pi-supervisor-<user>`): give THIS file its own
    // namespace so its supervisor never collides with the live one in
    // supervisor.test.ts when vitest runs files in parallel workers.
    userInfo: () => ({ ...orig.userInfo(), username: "pi-sv69" }),
  };
});

/** Fake spawned process: the test kills it and fires its exit by hand. */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: vi.fn() };
  readonly kill = vi.fn();
}

const spawnedChildren: FakeChild[] = [];
/** Fake children that already fired their exit event (so afterEach does not
 *  double-exit them). */
const exitedChildren = new Set<FakeChild>();

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawnedChildren.push(child);
      return child as never;
    }),
  };
});

// Dynamic imports (after the mocks above) so the mocked `node:os` /
// `node:child_process` are in place before the module graph loads.
const { Supervisor, getSupervisorSockPath } = await import("./supervisor.js");
const { HostBridge } = await import("./host_bridge.js");
const storage = await import("../pairing/storage.js");
const { encodeRequest, parseReply } = await import("./control_protocol.js");

const APP_PEER = "app-peer-1";

class FakeRelay extends EventEmitter {
  readonly outbound: string[] = [];
  async connect(): Promise<void> { /* immediate */ }
  send(line: string): void { this.outbound.push(line); }
  close(): void { /* no-op */ }
}

/** In-memory keyring so the bridge's identity minting is hermetic. */
class InMemoryBackend {
  private store = new Map<string, string>();
  async read(): Promise<string | undefined> { return this.store.get("k"); }
  async write(_s: string, _a: string, value: string): Promise<void> { this.store.set("k", value); }
  async delete(): Promise<boolean> { return this.store.delete("k"); }
}

let testHome: string;
let supervisor: Supervisor | null = null;
let relay: FakeRelay;

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

/** Asks the supervisor currently bound at the active REMOTE_PI_HOME. */
async function ask<R = ControlReply<unknown>>(req: ControlRequest): Promise<R> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: getSupervisorSockPath() });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.destroy();
        try { resolve(parseReply(buf.slice(0, nl)) as R); }
        catch (e) { reject(e); }
      }
    });
    sock.on("error", reject);
    sock.write(encodeRequest(req));
  });
}

interface StatePush {
  cwd: string;
  state: WorkspaceState;
  last_error: string | null;
  restarts: number;
}

/** Decodes every `workspace_state` push the given relay has fanned out. */
function statePushes(rel: FakeRelay): StatePush[] {
  return rel.outbound
    .map((line) => {
      const outer = JSON.parse(line) as { ct: string };
      return JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ServerMessage;
    })
    .filter((m): m is Extract<ServerMessage, { type: "workspace_state" }> => m.type === "workspace_state")
    .map((m) => ({ cwd: m.cwd, state: m.state, last_error: m.last_error, restarts: m.restarts }));
}

/** Waits until `predicate` holds over the pushes seen so far. */
async function waitForPush(
  rel: FakeRelay,
  predicate: (pushes: StatePush[]) => boolean,
  what: string,
  timeoutMs = 8000,
): Promise<StatePush[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pushes = statePushes(rel);
    if (predicate(pushes)) return pushes;
    if (Date.now() > deadline) throw new Error(`timeout esperando push: ${what} (vi ${JSON.stringify(pushes)})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Registers a scratch cwd, starts it, and waits for the first `running` push. */
async function startDaemon(tag: string): Promise<{ id: string; cwd: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `pi-sv69-${tag}-`));
  const reg = await ask({ op: "register", cwd: dir }) as ControlReply<{ id: string; cwd: string }>;
  const id = reg.ok ? reg.data!.id : "";
  const cwd = reg.ok ? reg.data!.cwd : dir;
  await ask({ op: "start", id });
  await waitForPush(relay, (p) => p.length >= 1, "push de start");
  return { id, cwd, dir };
}

/** Fires the fake child's exit the way the OS would after a kill. */
function exitChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void {
  exitedChildren.add(child);
  child.emit("exit", code, signal);
}

/** Cleanly exits every still-alive fake child so `Supervisor.stop()` (which
 *  awaits each child's exit) never hangs in afterEach. */
function exitAllChildren(): void {
  for (const child of spawnedChildren) {
    if (exitedChildren.has(child)) continue;
    exitChild(child, 0, null);
  }
}

/** Drives an in-flight stop/restart: waits for the SIGTERM, then exits. */
async function finishStop(child: FakeChild): Promise<void> {
  await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
  exitChild(child, null, "SIGTERM");
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "pi-sv69-home-"));
  process.env["REMOTE_PI_HOME"] = testHome;
  storage._setKeyStoreBackendForTest(new InMemoryBackend() as never);
  spawnedChildren.length = 0;
  relay = new FakeRelay();
  const bridge = new HostBridge({
    fleet: fleetStub(),
    relayFactory: () => relay as never,
    listPeersFn: async () => [{ remote_epk: APP_PEER }],
  });
  supervisor = new Supervisor({
    skipHost: false,
    host: bridge,
    extensionPath: "/no/such/extension.js",
    piBin: process.execPath,
  });
  await supervisor.start();
});

afterEach(async () => {
  exitAllChildren();
  if (supervisor) {
    await supervisor.stop();
    supervisor = null;
  }
  storage._setKeyStoreBackendForTest(null);
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(join(_tmpHome, ".pi", "remote"), { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("Supervisor — workspace_state push (plan/69)", () => {
  test("start pushes running{last_error: null, restarts: 0}", async () => {
    const { cwd, dir } = await startDaemon("start");
    expect(statePushes(relay)[0]).toEqual({ cwd, state: "running", last_error: null, restarts: 0 });
    expect(spawnedChildren).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("deliberate stop pushes stopped{last_error: null} — a signal death is not a crash", async () => {
    const { id, cwd, dir } = await startDaemon("stop");
    const stopPromise = ask({ op: "stop", id });
    await finishStop(spawnedChildren[0]!);
    const reply = await stopPromise;
    expect(reply.ok).toBe(true);

    const stopped = (await waitForPush(relay, (p) => p.some((s) => s.state === "stopped"), "stop"))
      .find((s) => s.state === "stopped")!;
    expect(stopped).toEqual({ cwd, state: "stopped", last_error: null, restarts: 0 });

    rmSync(dir, { recursive: true, force: true });
  });

  test("restart of a running daemon pushes stopped → running on one wire", async () => {
    const { id, cwd, dir } = await startDaemon("restart");
    const restartPromise = ask({ op: "restart", id });
    await finishStop(spawnedChildren[0]!);
    const reply = await restartPromise;
    expect(reply.ok).toBe(true);

    const pushes = await waitForPush(
      relay,
      (p) => p.filter((s) => s.state === "running").length >= 2,
      "restart running",
    );
    // stop transition first, then the fresh spawn — same fan-out wire.
    expect(pushes.at(-2)).toEqual({ cwd, state: "stopped", last_error: null, restarts: 0 });
    expect(pushes.at(-1)).toMatchObject({ cwd, state: "running", last_error: null });
    expect(spawnedChildren).toHaveLength(2);

    rmSync(dir, { recursive: true, force: true });
  });

  test("crash pushes crashed with the real last_error; backoff + fresh-session restarts bump the counter", async () => {
    const { cwd, dir } = await startDaemon("crash");

    // 1) unexpected non-zero exit → crashed + the real reason.
    exitChild(spawnedChildren[0]!, 1, null);
    const crashed = (await waitForPush(relay, (p) => p.some((s) => s.state === "crashed"), "crash"))
      .find((s) => s.state === "crashed")!;
    expect(crashed).toEqual({ cwd, state: "crashed", last_error: "exited with code 1", restarts: 0 });

    // 2) backoff respawn (first delay is 1s) → running, restarts bumped.
    const respawned = (await waitForPush(
      relay,
      (p) => p.some((s) => s.state === "running" && s.restarts >= 1),
      "backoff respawn",
    )).find((s) => s.state === "running" && s.restarts >= 1)!;
    expect(respawned.cwd).toBe(cwd);
    expect(respawned.last_error).toBeNull(); // fresh spawn — no current error
    expect(respawned.restarts).toBe(1);
    expect(spawnedChildren).toHaveLength(2);

    // 3) app-triggered `/new` (private exit code 42) → immediate recycle,
    //    counter keeps climbing, no backoff burned.
    exitChild(spawnedChildren[1]!, 42, null);
    const recycled = (await waitForPush(
      relay,
      (p) => p.filter((s) => s.state === "running").length >= 3,
      "fresh-session recycle",
    )).filter((s) => s.state === "running")[2]!;
    expect(recycled.cwd).toBe(cwd);
    expect(recycled.restarts).toBe(2);
    expect(recycled.last_error).toBeNull();
    expect(spawnedChildren).toHaveLength(3);

    rmSync(dir, { recursive: true, force: true });
  });

  test("spawn failure surfaces the real error in last_error", async () => {
    const { cwd, dir } = await startDaemon("spawnfail");
    // RpcChild's spawn-error path: state crashed + exit{isCrash, error}.
    spawnedChildren[0]!.emit("error", new Error("spawn pi ENOENT"));
    const crashed = (await waitForPush(relay, (p) => p.some((s) => s.state === "crashed"), "spawn fail"))
      .find((s) => s.state === "crashed")!;
    expect(crashed.cwd).toBe(cwd);
    expect(crashed.last_error).toBe("Error: spawn pi ENOENT");

    rmSync(dir, { recursive: true, force: true });
  });
});
