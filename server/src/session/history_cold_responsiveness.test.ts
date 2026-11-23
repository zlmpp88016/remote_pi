import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { historyDbPath } from "./history_index.js";
import { HistoryService, type HistoryServiceOptions } from "./history_service.js";
import { createInlineHistoryPort, type HistoryWorkerPort, type HistoryWorkerPortFactory } from "./history_worker_client.js";
import { makeHistoryFixture, userMessage, writeTranscript, type HistoryFixture } from "../../test/history_fixtures.js";

const DAEMON = "aaaa1111";
let fixture: HistoryFixture;
beforeEach(() => {
  fixture = makeHistoryFixture("rp94-cold-list-");
  writeTranscript(fixture.bucket, { id: "s1", cwd: fixture.cwd, messages: [userMessage("u1", "cold first content")] });
});
afterEach(() => fixture.cleanup());
const list = (id: string) => ({ type: "history_list" as const, id, daemon_id: DAEMON });
const read = (id: string) => ({ type: "history_read" as const, id, daemon_id: DAEMON, session_id: "s1" });

function service(workerPortFactory: HistoryWorkerPortFactory, options: Partial<HistoryServiceOptions> = {}) {
  return new HistoryService({
    resolveWorkspace: id => id === DAEMON ? { daemon_id: id, cwd: fixture.cwd, name: "cold" } : null,
    agentRoot: fixture.root, remoteHome: `${fixture.root}/remote-home`,
    reconcileIntervalMs: 0, workerPortFactory, ...options,
  });
}

function controlledWriter(failImmediately = false) {
  let port: HistoryWorkerPort;
  let advances = 0;
  let held: unknown = null;
  let holdNext = true;
  const handlers = new Set<(value: unknown) => void>();
  const factory: HistoryWorkerPortFactory = role => {
    const inline = createInlineHistoryPort();
    if (role !== "writer") return inline;
    port = inline;
    return {
      ...inline,
      on(event, handler) {
        if (event === "message") handlers.add(handler as (value: unknown) => void);
        return inline.on(event as "message", handler as (value: unknown) => void);
      },
      postMessage(message) {
        if ((message as { kind?: string }).kind === "advance") {
          advances++;
          if (holdNext) {
            holdNext = false;
            if (failImmediately) {
              for (const handler of handlers) handler({ id: (message as { id: number }).id, ok: false, error: { code: "internal" } });
            } else held = message;
            return;
          }
        }
        inline.postMessage(message);
      },
    };
  };
  return {
    factory,
    advances: () => advances,
    holdNext: () => { holdNext = true; },
    release(failure = false) {
      if (held === null) return;
      const message = held;
      held = null;
      if (failure) {
        for (const handler of handlers) handler({ id: (message as { id: number }).id, ok: false, error: { code: "internal" } });
      } else port!.postMessage(message);
    },
  };
}

async function within<T>(pending: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
  } finally { clearTimeout(timer!); }
}
async function ready(svc: HistoryService) {
  for (let i = 0; i < 100; i++) {
    const result = await svc.list(list(`ready-${i}`));
    if (result.reply.type === "history_list_ok" && result.reply.index_state === "ready") return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("cold workspace never became ready");
}

// Holding the actual first writer request makes this a responsiveness proof;
// the one-second watchdog is a deadlock guard, not the performance gate.
describe("cold history builds yield the foreground request", () => {
  test.each(["empty", "partial"])("a %s SQLite schema stays transient until the writer finishes initialization", async schema => {
    const file = historyDbPath(fixture.root + "/remote-home");
    mkdirSync(dirname(file), { recursive: true });
    const initializing = new DatabaseSync(file);
    initializing.exec("PRAGMA journal_mode = WAL;");
    if (schema === "partial") initializing.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    initializing.close();
    const worker = controlledWriter();
    const svc = service(worker.factory);
    const pending = Promise.all([svc.list(list("opening-list")), svc.read(read("opening-read"))]);
    try {
      const replies = await within(pending);
      expect(replies?.map(result => result.reply)).toMatchObject([
        { type: "history_list_ok", index_state: "building" }, { type: "history_error", code: "building" },
      ]);
      expect(worker.advances()).toBe(1);
      worker.release();
      expect((await ready(svc)).reply).toMatchObject({ sessions: [{ id: "s1" }] });
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("a list returns building before its initial writer step completes", async () => {
    const worker = controlledWriter();
    const svc = service(worker.factory);
    const pending = svc.list(list("cold"));
    try {
      const result = await within(pending);
      expect(result?.reply).toMatchObject({ type: "history_list_ok", index_state: "building", sessions: [], retry_after_ms: 25 });
      expect(worker.advances()).toBe(1);
      expect(result?.metrics.cold_build_bytes).toBeNull();
      const before = JSON.stringify(result?.metrics);
      worker.release();
      const built = await ready(svc);
      expect(built.reply).toMatchObject({ sessions: [{ id: "s1" }] });
      expect(JSON.stringify(result?.metrics)).toBe(before);
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("concurrent cold lists share the initial build, including retries while it is held", async () => {
    const worker = controlledWriter();
    const svc = service(worker.factory);
    const pending = Promise.all([svc.list(list("a")), svc.list(list("b"))]);
    try {
      const replies = await within(pending);
      expect(replies?.map(result => result.reply)).toMatchObject([
        { type: "history_list_ok", index_state: "building" }, { type: "history_list_ok", index_state: "building" },
      ]);
      if (replies !== null) expect((await svc.list(list("retry"))).reply).toMatchObject({ index_state: "building" });
      expect(worker.advances()).toBe(1);
      worker.release();
      await ready(svc);
      expect(worker.advances()).toBe(1);
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("cold reads and lists share the same deferred writer step", async () => {
    const worker = controlledWriter();
    const svc = service(worker.factory);
    const pending = Promise.all([svc.read(read("read")), svc.list(list("list"))]);
    try {
      const replies = await within(pending);
      expect(replies?.map(result => result.reply)).toMatchObject([
        { type: "history_error", code: "building" }, { type: "history_list_ok", index_state: "building" },
      ]);
      expect(worker.advances()).toBe(1);
      worker.release();
      await ready(svc);
      expect((await svc.read(read("ready"))).reply).toMatchObject({ type: "history_read_ok", items: [{ event_id: "u1" }] });
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("a deferred worker refusal is surfaced once and the next request recovers", async () => {
    const worker = controlledWriter();
    const svc = service(worker.factory);
    const pending = svc.list(list("cold"));
    try {
      expect((await within(pending))?.reply).toMatchObject({ index_state: "building" });
      worker.release(true);
      await new Promise(resolve => setImmediate(resolve));
      expect((await svc.list(list("failure"))).reply).toMatchObject({ type: "history_error", code: "internal" });
      expect((await ready(svc)).reply).toMatchObject({ sessions: [{ id: "s1" }] });
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("an immediate refusal is consumed by its foreground request without replay", async () => {
    const worker = controlledWriter(true);
    const svc = service(worker.factory);
    const pending = svc.list(list("cold"));
    try {
      expect((await pending).reply).toMatchObject({ type: "history_error", code: "internal" });
      expect((await svc.list(list("retry"))).reply).toMatchObject({ type: "history_list_ok", index_state: "ready" });
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("a continuation refusal is surfaced to a reader and does not loop silently", async () => {
    writeTranscript(fixture.bucket, { id: "s2", cwd: fixture.cwd, messages: [userMessage("u2", "second")] });
    const worker = controlledWriter();
    const svc = service(worker.factory, { maxFilesPerScan: 1 });
    const pending = svc.list(list("cold"));
    try {
      expect((await within(pending))?.reply).toMatchObject({ index_state: "building" });
      worker.holdNext();
      worker.release();
      await new Promise(resolve => setImmediate(resolve));
      expect(worker.advances()).toBe(2);
      expect((await svc.list(list("still-building"))).reply).toMatchObject({ index_state: "building" });
      expect(worker.advances()).toBe(2);
      worker.release(true);
      await new Promise(resolve => setImmediate(resolve));
      expect((await svc.read(read("failure"))).reply).toMatchObject({ type: "history_error", code: "internal" });
      expect((await ready(svc)).reply).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ id: "s1" }), expect.objectContaining({ id: "s2" })]) });
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("disposal during a continuation delay prevents another writer request", async () => {
    writeTranscript(fixture.bucket, { id: "s2", cwd: fixture.cwd, messages: [userMessage("u2", "second")] });
    const worker = controlledWriter();
    const svc = service(worker.factory, { maxFilesPerScan: 1, buildKickMs: 100 });
    const pending = svc.list(list("cold"));
    try {
      expect((await within(pending))?.reply).toMatchObject({ index_state: "building" });
      worker.release();
      await new Promise(resolve => setImmediate(resolve));
      await svc.dispose();
      await new Promise(resolve => setTimeout(resolve, 130));
      expect(worker.advances()).toBe(1);
    } finally { worker.release(); await pending; await svc.dispose(); }
  });

  test("a small inline build may finish before the yield and retains its metrics", async () => {
    const svc = service(() => createInlineHistoryPort());
    try {
      const result = await svc.list(list("inline"));
      expect(result.reply).toMatchObject({ type: "history_list_ok", index_state: "ready", sessions: [{ id: "s1" }] });
      expect(result.metrics.cold_build_bytes).toBeGreaterThan(0);
    } finally { await svc.dispose(); }
  });

  test("disposal while the initial step is pending cannot start a continuation", async () => {
    writeTranscript(fixture.bucket, { id: "s2", cwd: fixture.cwd, messages: [userMessage("u2", "second")] });
    const worker = controlledWriter();
    const svc = service(worker.factory, { maxFilesPerScan: 1 });
    const pending = svc.list(list("cold"));
    try {
      expect((await within(pending))?.reply).toMatchObject({ index_state: "building" });
      const disposing = svc.dispose();
      worker.release();
      await disposing;
      await new Promise(resolve => setImmediate(resolve));
      expect(worker.advances()).toBe(1);
    } finally { worker.release(); await pending; await svc.dispose(); }
  });
});
