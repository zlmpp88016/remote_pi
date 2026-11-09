import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Supervisor, decideFireAction, getSupervisorSockPath } from "./supervisor.js";
import * as storage from "../pairing/storage.js";
import { addDaemon } from "./registry.js";
import { readCronLog } from "./cron_log.js";
import {
  encodeRequest,
  parseReply,
  type ControlReply,
  type ControlRequest,
} from "./control_protocol.js";

/**
 * Supervisor integration tests. We spin up a real `Supervisor` against a
 * scratch `REMOTE_PI_HOME`, connect to its UDS, send requests, and
 * inspect replies.
 *
 * `extensionPath` points at a non-existent path so the children's spawn
 * fails fast — sufficient to exercise the supervisor's request/reply
 * surface without actually booting Pi. We test child lifecycle proper
 * in `rpc_child.test.ts` separately (where applicable).
 */

let testHome: string;
let supervisor: Supervisor | null = null;

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

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "pi-sv-"));
  process.env["REMOTE_PI_HOME"] = testHome;
  /*
   * A scratch home isolates the state FILES but not the IPC ADDRESS: on Windows
   * the supervisor pipe is `remote-pi-supervisor-<user>`, machine-global, so
   * these tests could only ever run on a box with no dev supervisor up —
   * `SupervisorAlreadyRunningError` otherwise. `REMOTE_PI_INSTANCE` folds a name
   * into the pipe, which is what makes the suite runnable beside a live one.
   */
  process.env["REMOTE_PI_INSTANCE"] = `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  supervisor = new Supervisor({
    skipHost: true,
    // Point at a non-existent extension. The supervisor will try to
    // spawn `<piBin> --mode rpc -e <path>` and the child exits immediately —
    // fine for testing the control surface (we assert on op replies, not on
    // the child's exit code).
    extensionPath: "/no/such/extension.js",
    // Cross-platform stub: `process.execPath` (node) exists on every OS, so
    // spawn never ENOENTs (a POSIX-only path like `/usr/bin/true` failed on
    // Windows CI). Node rejects the `--mode` arg and exits non-zero right away,
    // which is harmless here — the spawning tests only check `started/restarted`
    // booleans, returned synchronously at spawn time.
    piBin: process.execPath,
  });
  await supervisor.start();
});

afterEach(async () => {
  if (supervisor) {
    await supervisor.stop();
    supervisor = null;
  }
  delete process.env["REMOTE_PI_HOME"];
  delete process.env["REMOTE_PI_INSTANCE"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("Supervisor — control UDS surface", () => {
  test("list returns empty daemons array when registry is empty", async () => {
    const r = await ask({ op: "list" });
    expect(r).toMatchObject({ ok: true, data: { daemons: [] } });
  });

  test("register adds an entry and returns the derived id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-sv-cwd-"));
    const r = await ask({ op: "register", cwd: tmp }) as ControlReply<{ id: string; cwd: string }>;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data!.id).toMatch(/^[0-9a-f]{8}$/);
      expect(r.data!.cwd.length).toBeGreaterThan(0);
    }
  });

  test("register twice rejects with `already registered`", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-sv-dup-"));
    await ask({ op: "register", cwd: tmp });
    const r = await ask({ op: "register", cwd: tmp });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/already registered/i);
  });

  test("start spawns a single registered daemon by id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-sv-start-"));
    const reg = await ask({ op: "register", cwd: tmp }) as ControlReply<{ id: string }>;
    expect(reg.ok).toBe(true);
    const id = reg.ok ? reg.data!.id : "";
    const r = await ask({ op: "start", id }) as ControlReply<{ id: string; started: boolean }>;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data!.id).toBe(id);
      expect(r.data!.started).toBe(true);
    }
  });

  test("start of unknown id returns ok:false", async () => {
    const r = await ask({ op: "start", id: "ffffffff" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/no daemon/i);
  });

  test("stop of unknown id returns ok:false", async () => {
    const r = await ask({ op: "stop", id: "ffffffff" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/no daemon/i);
  });

  test("restart of unknown id returns ok:false", async () => {
    const r = await ask({ op: "restart", id: "ffffffff" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/no daemon/i);
  });

  test("stop of a registered-but-not-running daemon → ok:true, stopped:false", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-sv-stop-"));
    const reg = await ask({ op: "register", cwd: tmp }) as ControlReply<{ id: string }>;
    const id = reg.ok ? reg.data!.id : "";
    const r = await ask({ op: "stop", id }) as ControlReply<{ id: string; stopped: boolean }>;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data!.id).toBe(id);
      expect(r.data!.stopped).toBe(false);
    }
  });

  test("restart spawns a single registered daemon by id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-sv-restart-"));
    const reg = await ask({ op: "register", cwd: tmp }) as ControlReply<{ id: string }>;
    const id = reg.ok ? reg.data!.id : "";
    const r = await ask({ op: "restart", id }) as ControlReply<{ id: string; restarted: boolean }>;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data!.id).toBe(id);
      expect(r.data!.restarted).toBe(true);
    }
  });

  test("send to unknown daemon returns ok:false with clear error", async () => {
    const r = await ask({ op: "send", id: "ffffffff", text: "hi" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/not running/i);
  });

  test("unregister of unknown id returns removed:false (not an error)", async () => {
    const r = await ask({ op: "unregister", id: "ffffffff" });
    // Unregister is idempotent at the supervisor — it always returns ok:true
    // with `removed: false` when nothing matched, so a CLI script can
    // call it repeatedly without failing.
    expect(r).toMatchObject({ ok: true, data: { removed: false } });
  });

  test("malformed request returns ok:false with parser error", async () => {
    const reply = await new Promise<ControlReply<unknown>>((resolve, reject) => {
      const sock = createConnection({ path: getSupervisorSockPath() });
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl >= 0) { sock.destroy(); try { resolve(parseReply(buf.slice(0, nl))); } catch (e) { reject(e); } }
      });
      sock.on("error", reject);
      sock.write("{not-json}\n");
    });
    expect(reply).toMatchObject({ ok: false });
    if (!reply.ok) expect(reply.error).toMatch(/malformed/i);
  });

  test("unknown op returns ok:false", async () => {
    // Bypass the typed encoder so we can send an op the type system
    // doesn't know about.
    const reply = await new Promise<ControlReply<unknown>>((resolve, reject) => {
      const sock = createConnection({ path: getSupervisorSockPath() });
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl >= 0) { sock.destroy(); try { resolve(parseReply(buf.slice(0, nl))); } catch (e) { reject(e); } }
      });
      sock.on("error", reject);
      sock.write('{"op":"frobnicate"}\n');
    });
    expect(reply).toMatchObject({ ok: false });
    if (!reply.ok) expect(reply.error).toMatch(/unknown op/i);
  });

  test("list reflects a daemon added directly via registry (not just register op)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-sv-direct-"));
    addDaemon(tmp);
    const r = await ask({ op: "list" }) as ControlReply<{ daemons: Array<{ cwd: string; state: string }> }>;
    expect(r.ok).toBe(true);
    if (r.ok) {
      const found = r.data!.daemons.find((d) => d.cwd.endsWith(tmp.split("/").pop()!));
      expect(found).toBeDefined();
      // State is "stopped" — the children were spawned at supervisor.start()
      // before our addDaemon call, so this entry isn't in the children map.
      expect(found?.state).toBe("stopped");
    }
  });
});

describe("decideFireAction (cron — 4 ramos)", () => {
  test("running + idle → send", () => {
    expect(decideFireAction({ running: true, busy: false, wake: false, skipIfBusy: true })).toBe("send");
  });
  test("running + busy + skip_if_busy → skip_busy", () => {
    expect(decideFireAction({ running: true, busy: true, wake: false, skipIfBusy: true })).toBe("skip_busy");
  });
  test("running + busy + no skip_if_busy → send", () => {
    expect(decideFireAction({ running: true, busy: true, wake: false, skipIfBusy: false })).toBe("send");
  });
  test("down + no wake → skip_down", () => {
    expect(decideFireAction({ running: false, busy: false, wake: false, skipIfBusy: true })).toBe("skip_down");
  });
  test("down + wake → wake_and_send", () => {
    expect(decideFireAction({ running: false, busy: false, wake: true, skipIfBusy: true })).toBe("wake_and_send");
  });
});

describe("Supervisor — cron ops", () => {
  async function registerDaemon(): Promise<string> {
    const tmp = mkdtempSync(join(tmpdir(), "pi-cron-d-"));
    const r = await ask({ op: "register", cwd: tmp }) as ControlReply<{ id: string }>;
    return r.ok ? r.data!.id : "";
  }

  test("cron_add validates: invalid expr + <60s rejected, valid accepted", async () => {
    const daemon_id = await registerDaemon();
    const bad = await ask({ op: "cron_add", daemon_id, schedule: "nope", prompt: "p" });
    expect(bad.ok).toBe(false);
    const tooFreq = await ask({ op: "cron_add", daemon_id, schedule: "* * * * * *", prompt: "p" });
    expect(tooFreq).toMatchObject({ ok: false });
    if (!tooFreq.ok) expect(tooFreq.error).toMatch(/60s|too frequent/i);
    const good = await ask({ op: "cron_add", daemon_id, schedule: "0 9 * * *", prompt: "p" }) as ControlReply<{ job: { id: string } }>;
    expect(good.ok).toBe(true);
    expect(good.ok && good.data!.job.id).toMatch(/^j_/);
  });

  test("cron list/enable/remove round-trip", async () => {
    const daemon_id = await registerDaemon();
    const add = await ask({ op: "cron_add", daemon_id, schedule: "0 9 * * *", prompt: "p" }) as ControlReply<{ job: { id: string } }>;
    const jobId = add.ok ? add.data!.job.id : "";

    const list = await ask({ op: "cron_list" }) as ControlReply<{ jobs: Array<{ id: string; next_run?: string | null }> }>;
    expect(list.ok && list.data!.jobs.some((j) => j.id === jobId && !!j.next_run)).toBe(true);

    const dis = await ask({ op: "cron_enable", job_id: jobId, enabled: false }) as ControlReply<{ updated: boolean }>;
    expect(dis.ok && dis.data!.updated).toBe(true);

    const rm = await ask({ op: "cron_remove", job_id: jobId }) as ControlReply<{ removed: boolean }>;
    expect(rm.ok && rm.data!.removed).toBe(true);
    const list2 = await ask({ op: "cron_list" }) as ControlReply<{ jobs: unknown[] }>;
    expect(list2.ok && list2.data!.jobs.length).toBe(0);
  });

  test("cron_run on a down daemon → skipped_down, recorded + logged", async () => {
    const daemon_id = await registerDaemon(); // registered, not started → not running
    const add = await ask({ op: "cron_add", daemon_id, schedule: "0 9 * * *", prompt: "ping" }) as ControlReply<{ job: { id: string } }>;
    const jobId = add.ok ? add.data!.job.id : "";

    const run = await ask({ op: "cron_run", job_id: jobId }) as ControlReply<{ result: string }>;
    expect(run.ok && run.data!.result).toBe("skipped_down");

    // logged to cron.jsonl
    const log = readCronLog({ jobId });
    expect(log.at(-1)).toMatchObject({ result: "skipped_down", fired: false });

    // last_status reflected in cron list
    const list = await ask({ op: "cron_list" }) as ControlReply<{ jobs: Array<{ id: string; last_status?: string }> }>;
    const job = list.ok ? list.data!.jobs.find((j) => j.id === jobId) : undefined;
    expect(job?.last_status).toBe("skipped_down");
  });

  test("cron_run on an unknown job → ok:false", async () => {
    const r = await ask({ op: "cron_run", job_id: "j_unknown" });
    expect(r).toMatchObject({ ok: false });
  });
});

// ── plan/68 — host-room workspace catalog ─────────────────────────────────────

describe("Supervisor — host-room catalog (plan/68)", () => {
  test("catalog = registered daemons ∪ added workspaces, with provenance", async () => {
    const { _catalogEntriesForTest } = await import("./supervisor.js");
    const { addWorkspace } = await import("./workspaces.js");

    const registered = mkdtempSync(join(tmpdir(), "pi-cat-reg-"));
    const added = mkdtempSync(join(tmpdir(), "pi-cat-add-"));
    addDaemon(registered);
    addWorkspace(added);

    const rows = _catalogEntriesForTest(supervisor!);
    const reg = rows.find((r) => r.cwd === registered);
    const add = rows.find((r) => r.cwd === added);
    expect(reg?.source).toBe("daemon");
    expect(add?.source).toBe("added");
    expect(add?.live).toBe(false); // never started yet

    rmSync(registered, { recursive: true, force: true });
    rmSync(added, { recursive: true, force: true });
  });

  test("a cwd in both daemons.json and workspaces.json appears once, as daemon", async () => {
    const { _catalogEntriesForTest } = await import("./supervisor.js");
    const { addWorkspace } = await import("./workspaces.js");

    const dir = mkdtempSync(join(tmpdir(), "pi-cat-dup-"));
    addDaemon(dir);
    addWorkspace(dir); // same normalized realpath

    const rows = _catalogEntriesForTest(supervisor!);
    const matches = rows.filter((r) => r.cwd === dir);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.source).toBe("daemon");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Supervisor — workspace_start on an unregistered cwd (plan/68)", () => {
  test("ensure persists into workspaces.json (not daemons.json)", async () => {
    const { _fleetOpsForTest } = await import("./supervisor.js");

    const dir = mkdtempSync(join(tmpdir(), "pi-startws-"));
    const ops = _fleetOpsForTest(supervisor!);
    const ensured = ops.ensure(dir);
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error("ensure failed");

    // Persisted as an added workspace, NOT a supervised daemon. (We do not
    // call `start` here: it spawns a real child whose cwd lock would hold this
    // directory. The start path is covered by host_control_68 with a fake
    // fleet, and end-to-end by host_bridge_68.)
    const { listWorkspaces } = await import("./workspaces.js");
    expect(listWorkspaces().map((w) => w.cwd)).toContain(ensured.cwd);
    const daemons = await ask({ op: "list" }) as ControlReply<{ daemons: unknown[] }>;
    expect(daemons.ok && daemons.data!.daemons).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Supervisor — pairing ops (plan/69)", () => {
  // Hermetic identity: an in-memory keyring backend, so pair_show's
  // getOrCreateEd25519Keypair() never touches the machine's real keyring or
  // ~/.pi/remote/identity.json (a real paired-peers file would otherwise
  // make a CI host fail with PairedIdentityMissingError).
  beforeEach(() => {
    storage._setKeyStoreBackendForTest({
      read: async () => undefined,
      write: async () => undefined,
      delete: async () => false,
    } as never);
  });
  afterEach(() => {
    storage._setKeyStoreBackendForTest(null);
  });

  test("pair_show issues a persistent code; pair_rotate invalidates it", async () => {
    const r1 = await ask({ op: "pair_show" }) as ControlReply<{
      uri: string; token: string; expires_at: number | null; persistent: boolean; room_id: string;
    }>;
    expect(r1.ok).toBe(true);
    const d1 = r1.data!;
    expect(d1.persistent).toBe(true);
    expect(d1.expires_at).toBeNull();
    expect(d1.room_id).toBe("host");
    expect(d1.uri.startsWith("remotepi://pair?")).toBe(true);

    const params = new URLSearchParams(d1.uri.slice("remotepi://pair?".length));
    expect(params.get("t")).toBe(d1.token);
    expect(params.get("rm")).toBe("host");
    expect(params.get("epk")).toBeTruthy();
    expect(params.get("n")).toBe(hostname());
    expect(params.get("r")).toBeTruthy();

    // Persistent codes are stable across calls — this is the "predefined on
    // the host" contract (the code survives supervisor restarts).
    const r2 = await ask({ op: "pair_show" }) as ControlReply<{ token: string }>;
    expect(r2.data!.token).toBe(d1.token);

    // --rotate mints a new token; the old one is gone from the store.
    const r3 = await ask({ op: "pair_rotate" }) as ControlReply<{ token: string }>;
    expect(r3.data!.token).not.toBe(d1.token);
    const r4 = await ask({ op: "pair_show" }) as ControlReply<{ token: string }>;
    expect(r4.data!.token).toBe(r3.data!.token);
  });

  test("pair_show --ephemeral issues a fresh short-TTL token each call", async () => {
    const r = await ask({ op: "pair_show", ephemeral: true }) as ControlReply<{
      token: string; persistent: boolean; expires_at: number | null; uri: string;
    }>;
    expect(r.data!.persistent).toBe(false);
    expect(typeof r.data!.expires_at).toBe("number");
    expect(r.data!.expires_at!).toBeGreaterThan(Date.now());
    expect(r.data!.uri).toContain(`t=${encodeURIComponent(r.data!.token)}`);

    const r2 = await ask({ op: "pair_show", ephemeral: true }) as ControlReply<{ token: string }>;
    expect(r2.data!.token).not.toBe(r.data!.token);
  });
});

/*
 * One Pi process per workspace.
 *
 * The rule itself has existed for a while and is already enforced twice: the
 * daemon id is `sha256(canonicalCwd)[:8]` (so one folder cannot register two
 * agents — this was a real bug, fixed by switching to `realpathSync.native`),
 * and `acquireCwdLock` refuses a second live agent for the same (cwd, name)
 * with a kernel-level UDS bind.
 *
 * What was missing is the REASON reaching the user. The child refused and
 * exited 0, which the supervisor reads as "stopped cleanly": no `last_error`,
 * no explanation, and a daemon that simply would not run. Worse, any naive
 * retry would be pointless — the lock is still held.
 */
describe("Supervisor — one Pi process per workspace", () => {
  test("a lock-held exit records the reason and does NOT auto-restart", async () => {
    const cwd = join(testHome, "ws-lock");
    mkdirSync(cwd, { recursive: true });
    const reg = await ask({ op: "register", cwd }) as ControlReply<{ id: string }>;
    const id = reg.data!.id;
    // `register` only writes the registry; a slot (and its child) exists once
    // something asks the supervisor to START it.
    await ask({ op: "start", id });

    const children = (supervisor as unknown as {
      children: Map<string, {
        lastError: string | null;
        restartAttempt: number;
        child: { state: string; spawn: () => void; noteRestart: () => void };
        restartTimer: unknown;
      }>;
    }).children;
    const slot = children.get(id);
    expect(slot).toBeDefined();

    let spawnedAgain = 0;
    const originalSpawn = slot!.child.spawn;
    slot!.child.spawn = () => { spawnedAgain += 1; };

    (supervisor as unknown as {
      _onChildExit: (id: string, evt: { code: number | null; signal: null; isCrash: boolean }) => void;
    })._onChildExit(id, { code: 44 /* EXIT_DAEMON_LOCK_HELD */, signal: null, isCrash: false });

    // The reason must survive where the app can read it.
    expect(slot!.lastError).toContain("already owns this folder");
    // And it must not spin: a retry would hit the same held lock forever.
    expect(spawnedAgain).toBe(0);
    expect(slot!.restartTimer).toBeNull();
    expect(slot!.restartAttempt).toBe(0);

    slot!.child.spawn = originalSpawn;
  });

  test("the same cwd cannot be registered twice — one folder, one agent", async () => {
    const cwd = join(testHome, "ws-dup");
    mkdirSync(cwd, { recursive: true });
    const a = await ask({ op: "register", cwd }) as ControlReply<{ id: string }>;
    expect(a.ok).toBe(true);

    // A second registration for the SAME folder is refused outright, not
    // silently deduped: one cwd means one daemon id, so a duplicate entry could
    // only ever have produced a second Pi process for one directory (a real bug
    // before `canonicalCwd` was used).
    const b = await ask({ op: "register", cwd }) as ControlReply<{ id: string }>;
    expect(b.ok).toBe(false);
    expect(b.error).toContain("already registered");
    expect(b.data).toBeUndefined();

    const listed = await ask({ op: "list" }) as ControlReply<{
      daemons: Array<{ id: string }>;
    }>;
    expect(listed.data!.daemons.filter((d) => d.id === a.data!.id)).toHaveLength(1);
  });
});
