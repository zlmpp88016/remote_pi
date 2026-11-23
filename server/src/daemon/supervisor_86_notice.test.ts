/**
 * Plan 86 P2 correction (R1/R2) — the ACTUAL child→host authority path.
 *
 * This drives the real `RpcChild` (a fake ChildProcess supplies its stderr pipe),
 * the real `Supervisor._onWriterNotice` handler, the real
 * `WriterAuthorityRegistry`, and the real `FleetRuntimeSnapshot` the history
 * service reads. NOTHING injects a trust predicate: the only thing that makes an
 * append incremental is the notice the child itself wrote, exactly as in
 * production.
 *
 * Everything else is isolated: a temp `REMOTE_PI_HOME`, a temp cwd, and no `pi`
 * process (the fake child never execs anything, never binds the supervisor UDS).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHistoryNotice, HISTORY_NOTICE_VERSION } from "../session/history_notice.js";

const _tmpHome = mkdtempSync(join(tmpdir(), "pi-sv86-"));

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => _tmpHome,
    // Windows named pipes are user-scoped: give this file its own namespace so it
    // never collides with the live supervisor or another test file.
    userInfo: () => ({ ...orig.userInfo(), username: "pi-sv86" }),
  };
});

class FakeChild extends EventEmitter {
  readonly pid = 5150;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: vi.fn() };
  readonly kill = vi.fn();
}

const spawned: FakeChild[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as never;
    }),
  };
});

const { Supervisor, _writerAuthorityForTest, _childrenForTest, _fleetOpsForTest } = await import(
  "./supervisor.js"
);

let cwd = "";
let supervisor: Supervisor | null = null;

beforeEach(() => {
  spawned.length = 0;
  cwd = mkdtempSync(join(tmpdir(), "pi-sv86-ws-"));
});

afterEach(async () => {
  /*
   * A crash test leaves a pending backoff timer. Clear it BEFORE the exit so the
   * timer cannot respawn a child into a torn-down slot (and so the file leaves
   * no live timers behind), then exit every fake the way the OS would.
   */
  for (const slot of supervisor === null ? [] : _childrenForTest(supervisor).values()) {
    if (slot.restartTimer !== null) {
      clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
    }
  }
  for (const child of spawned) {
    if (child.listenerCount("exit") > 0) child.emit("exit", { code: 0, signal: null, isCrash: false });
  }
  supervisor = null;
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    /* best-effort */
  }
});

function notice(overrides: Record<string, unknown> = {}): string {
  return formatHistoryNotice({
    v: HISTORY_NOTICE_VERSION,
    kind: "session",
    incarnation: 1,
    seq: 1,
    session_id: "s-live",
    file: join(cwd, "sessions", "abc.jsonl"),
    stamp: { ino: 11, birthtime_ms: 22, size: 4096, mtime_ms: 33, ctime_ms: 44 },
    pid: 5150,
    at: 1_700_000_000_000,
    ...overrides,
  } as never);
}

/**
 * Boot ONE supervised slot without binding the UDS: `_spawnEntry` is the exact
 * production path that attaches the `notice` listener and captures `noticePid`.
 */
function boot(): { supervisor: Supervisor; id: string; child: FakeChild } {
  const s = new Supervisor({ extensionPath: "/nowhere/dist/index.js", skipHost: true });
  const id = "aaaa1111";
  (s as unknown as { _spawnEntry(id: string, cwd: string, name?: string): void })._spawnEntry(id, cwd, "ws");
  supervisor = s;
  const slot = _childrenForTest(s).get(id)!;
  return { supervisor: s, id, child: slot.child as unknown as FakeChild };
}

describe("86-P2-R1 — the real child notice drives the real authority", () => {
  test("a session notice publishes identity; an append updates it; a revoke drops it", () => {
    const { supervisor: s, id, child } = boot();
    const before = _writerAuthorityForTest(s, id);
    expect(before).toMatchObject({ session_id: null, file: null, append_trusted: false, incarnation: 0 });

    // The child writes the line to its stderr — the exact production transport.
    child._ingestStderrForTest(notice());
    const published = _writerAuthorityForTest(s, id);
    expect(published).toMatchObject({
      session_id: "s-live",
      incarnation: 1,
      seq: 1,
      pid: 5150,
    });
    // ATTRIBUTION, NOT OWNERSHIP: no receipt on this SDK may authorize an append.
    expect(published.append_trusted).toBe(false);
    expect(published.file).toBe(join(cwd, "sessions", "abc.jsonl"));

    // The runtime snapshot the history API reads reflects it verbatim.
    const runtime = _fleetOpsForTest(s).runtime!(id)!;
    expect(runtime).toMatchObject({
      state: "running",
      session_id: "s-live",
      session_file: join(cwd, "sessions", "abc.jsonl"),
      /*
       * 86-P2-R1/R2 FAIL-CLOSED: identity is attributed, authority is NOT granted.
       * No receipt on SDK 0.79.10 can prove exclusive ownership of a byte range.
       */
      append_authority: false,
    });
    // READINESS IS STILL UNKNOWN: this process cannot attest it.
    expect(runtime.ready).toBeNull();
    // And the ownership check answers per FILE, not per id.
    expect(_fleetOpsForTest(s).writerOwns!(id, join(cwd, "sessions", "abc.jsonl"))).toBe(true);
    expect(_fleetOpsForTest(s).writerOwns!(id, join(cwd, "sessions", "other.jsonl"))).toBe(false);

    // An append notice advances the sequence and the accounting.
    child._ingestStderrForTest(
      notice({
        kind: "append",
        seq: 2,
        span: {
          before: { ino: 11, birthtime_ms: 22, size: 4096, mtime_ms: 33, ctime_ms: 44 },
          after: { ino: 11, birthtime_ms: 22, size: 8192, mtime_ms: 35, ctime_ms: 46 },
        },
      }),
    );
    expect(_writerAuthorityForTest(s, id)).toMatchObject({
      seq: 2,
      // The claimed range is kept for diagnostics, and grants nothing.
      span: { before: { size: 4096 }, after: { size: 8192 } },
    });
    expect(_writerAuthorityForTest(s, id).append_trusted).toBe(false);

    // A REVOKE (session switch/new) drops the attribution while keeping ids honest.
    child._ingestStderrForTest(notice({ kind: "revoke", seq: 3 }));
    const revoked = _writerAuthorityForTest(s, id);
    expect(revoked.file).toBeNull();
    expect(revoked.session_id).toBeNull();
  });

  test("a replay and a lower incarnation are refused, and a respawn reopens authority", () => {
    const { supervisor: s, id, child } = boot();
    child._ingestStderrForTest(notice({ seq: 4 }));
    expect(_writerAuthorityForTest(s, id).seq).toBe(4);

    // A replayed line does nothing.
    child._ingestStderrForTest(notice({ seq: 4 }));
    expect(_writerAuthorityForTest(s, id).seq).toBe(4);
    // An older incarnation can never overwrite the current one.
    child._ingestStderrForTest(notice({ seq: 1, kind: "revoke" }));
    expect(_writerAuthorityForTest(s, id).session_id).toBe("s-live");

    // A genuine respawn: the supervisor revokes, the new child republishes.
    const slot = _childrenForTest(s).get(id)!;
    // EXIT_DAEMON_SWITCH_SESSION → a deliberate recycle, no backoff. The event is
    // the OBJECT RpcChild emits, not raw argv.
    child.emit("exit", { code: 43, signal: null, isCrash: true });
    expect(_writerAuthorityForTest(s, id).session_id).toBeNull();
    expect(slot.noticePid).toBeGreaterThan(0);
    const replacement = slot.child as unknown as FakeChild;
    replacement._ingestStderrForTest(notice({ incarnation: 2, seq: 1, session_id: "s-live-2" }));
    expect(_writerAuthorityForTest(s, id)).toMatchObject({
      incarnation: 2,
      session_id: "s-live-2",
    });
    // The old incarnation cannot come back.
    replacement._ingestStderrForTest(notice({ incarnation: 1, seq: 99, session_id: "s-live" }));
    expect(_writerAuthorityForTest(s, id)).toMatchObject({ incarnation: 2, session_id: "s-live-2" });
  });

  test("an ordinary stderr line is forwarded and never becomes a notice", () => {
    const { id, child } = boot();
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      child._ingestStderrForTest("ordinary pi log line\n");
      expect(written.join("")).toContain("ordinary pi log line");
      expect(_writerAuthorityForTest(supervisor!, id).session_id).toBeNull();

      // A notice line is CONSUMED (machine data) and not forwarded as log noise.
      written.length = 0;
      child._ingestStderrForTest(notice());
      expect(written.join("")).toBe("");
      expect(_writerAuthorityForTest(supervisor!, id).session_id).toBe("s-live");
    } finally {
      spy.mockRestore();
    }
  });

  test("a notice split across two stderr chunks is assembled exactly once", () => {
    const { supervisor: s, id, child } = boot();
    const line = notice();
    const cut = Math.floor(line.length / 2);
    child._ingestStderrForTest(line.slice(0, cut));
    // A half line must never be parsed as a (wrong) notice.
    expect(_writerAuthorityForTest(s, id).session_id).toBeNull();
    child._ingestStderrForTest(line.slice(cut));
    expect(_writerAuthorityForTest(s, id)).toMatchObject({ session_id: "s-live", seq: 1 });
  });

  test("a notice from a foreign pid is refused", () => {
    const { supervisor: s, id, child } = boot();
    child._ingestStderrForTest(notice({ pid: 999 }));
    expect(_writerAuthorityForTest(s, id).session_id).toBeNull();
    expect(_fleetOpsForTest(s).runtime!(id)!.append_authority).toBe(false);
  });
});
