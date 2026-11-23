import { expect, test, vi } from "vitest";
import type { ReaderReadPayload } from "./history_worker.js";
import { HistoryWorkerClient, type HistoryWorkerPort } from "./history_worker_client.js";

const read = (session_id: string): ReaderReadPayload => ({
  kind: "read", remote_home: null, bucket: "fixture", session_id, limit: 1,
  before: null, high_water: null, generation: null, trusted: null,
});

function reader(terminate: HistoryWorkerPort["terminate"] = () => {}) {
  const sent: (ReaderReadPayload & { id: number })[] = [];
  const listeners = new Map<string, (value: unknown) => void>();
  const port: HistoryWorkerPort = {
    mode: "threads",
    on(event, handler) { listeners.set(event, handler as (value: unknown) => void); },
    postMessage(value) { sent.push(value as (typeof sent)[number]); },
    terminate: vi.fn(terminate),
  };
  return {
    port, sent,
    reply(id: number, value: unknown) { listeners.get("message")?.({ id, ok: true, value }); },
    exit() { listeners.get("exit")?.(1); },
  };
}

test("a later session read queues behind an outstanding read, then advances", async () => {
  const worker = reader();
  const client = new HistoryWorkerClient({ portFactory: () => worker.port });
  try {
    const a = client.request(read("A"));
    const b = client.request(read("B"));
    expect(worker.sent.map(r => r.session_id)).toEqual(["A"]);
    expect(client.queueLength()).toBe(2);
    worker.reply(worker.sent[0]!.id, "A");
    expect(worker.sent.map(r => r.session_id)).toEqual(["A", "B"]);
    worker.reply(worker.sent[1]!.id, "B");
    expect((await a).value).toBe("A");
    expect((await b).value).toBe("B");
    expect(client.queueLength()).toBe(0);
  } finally { await client.dispose(); }
});

test("a timed-out A cannot fail still-current, undispatched B or corrupt its reply", async () => {
  vi.useFakeTimers();
  let retire!: (value: number) => void;
  const old = reader(() => new Promise(resolve => { retire = resolve; }));
  const fresh = reader();
  const factory = vi.fn().mockReturnValueOnce(old.port).mockReturnValueOnce(fresh.port);
  const client = new HistoryWorkerClient({ portFactory: factory, now: Date.now });
  try {
    const a = expect(client.request(read("A"))).rejects.toMatchObject({ code: "worker_timeout" });
    await vi.advanceTimersByTimeAsync(500);
    const b = client.request(read("B"));
    await vi.advanceTimersByTimeAsync(29_500);
    await a;
    expect(old.port.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(client.queueLength()).toBe(1);
    old.reply(1, "A late");
    old.exit();
    expect(factory).toHaveBeenCalledOnce();
    retire(0);
    await Promise.resolve();
    expect(fresh.sent).toMatchObject([{ id: 2, session_id: "B" }]);
    old.reply(2, "wrong reader");
    fresh.reply(2, "B");
    expect(await b).toEqual({ value: "B", queue_ms: 29_500 });
    expect(client.queueLength()).toBe(0);
  } finally { retire?.(0); await client.dispose(); vi.useRealTimers(); }
});

test("B's existing budget includes queue time, without killing A or dispatching expired B", async () => {
  vi.useFakeTimers();
  let retire!: (value: number) => void;
  const old = reader(() => new Promise(resolve => { retire = resolve; }));
  const fresh = reader();
  const factory = vi.fn().mockReturnValueOnce(old.port).mockReturnValueOnce(fresh.port);
  const client = new HistoryWorkerClient({ portFactory: factory, now: Date.now });
  try {
    const a = expect(client.request(read("A"))).rejects.toMatchObject({ code: "worker_timeout" });
    await vi.advanceTimersByTimeAsync(700);
    const b = expect(client.request(read("B"))).rejects.toMatchObject({ code: "worker_timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([a, b]);
    expect(old.port.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(client.queueLength()).toBe(0);
    const c = client.request(read("C"));
    expect(fresh.sent).toHaveLength(0);
    retire(0);
    await Promise.resolve();
    expect(fresh.sent).toMatchObject([{ id: 3, session_id: "C" }]);
    fresh.reply(3, "C");
    expect((await c).value).toBe("C");
  } finally { retire?.(0); await client.dispose(); vi.useRealTimers(); }
});

test("dispatch does not start a fresh full timer after a reader queues", async () => {
  vi.useFakeTimers();
  const worker = reader();
  const client = new HistoryWorkerClient({ portFactory: () => worker.port, now: Date.now });
  try {
    const a = client.request(read("A"));
    await vi.advanceTimersByTimeAsync(100);
    const b = expect(client.request(read("B"))).rejects.toMatchObject({ code: "worker_timeout" });
    await vi.advanceTimersByTimeAsync(29_800);
    worker.reply(1, "A");
    expect((await a).value).toBe("A");
    expect(worker.sent.map(r => r.session_id)).toEqual(["A", "B"]);
    await vi.advanceTimersByTimeAsync(200);
    await b;
    expect(worker.port.terminate).toHaveBeenCalledOnce();
  } finally { await client.dispose(); vi.useRealTimers(); }
});

test("a late reply ahead of its overdue timer is rejected without killing the reader", async () => {
  let now = 0;
  const worker = reader();
  const client = new HistoryWorkerClient({ portFactory: () => worker.port, now: () => now });
  try {
    const a = expect(client.request(read("A"))).rejects.toMatchObject({ code: "worker_timeout" });
    now = 500;
    const b = client.request(read("B"));
    now = 30_000; // Only the monotonic clock moved; the timer has not fired.
    worker.reply(1, "A late");
    worker.reply(2, "B");
    await a;
    expect(await b).toEqual({ value: "B", queue_ms: 29_500 });
    expect(worker.port.terminate).not.toHaveBeenCalled();
  } finally { await client.dispose(); }
});

test("disposing while a reader is retiring rejects queued work without reviving it", async () => {
  let finish!: (value: number) => void;
  const old = reader(() => new Promise(resolve => { finish = resolve; }));
  const factory = vi.fn().mockReturnValue(old.port);
  const client = new HistoryWorkerClient({ portFactory: factory });
  try {
    const a = expect(client.request(read("A"))).rejects.toMatchObject({ code: "worker_failed" });
    const b = expect(client.request(read("B"))).rejects.toMatchObject({ code: "worker_disposed" });
    old.exit();
    let disposed = false;
    const done = client.dispose().then(() => { disposed = true; });
    await Promise.all([a, b]);
    expect(disposed).toBe(false);
    finish(0);
    await done;
    expect(factory).toHaveBeenCalledOnce();
    expect(client.queueLength()).toBe(0);
    await expect(client.request(read("C"))).rejects.toMatchObject({ code: "worker_disposed" });
  } finally { finish?.(0); await client.dispose(); }
});

test("a failed termination does not create a second reader on unproven exit", async () => {
  const old = reader(() => Promise.reject(new Error("terminate failed")));
  const factory = vi.fn().mockReturnValue(old.port);
  const client = new HistoryWorkerClient({ portFactory: factory });
  try {
    const a = expect(client.request(read("A"))).rejects.toMatchObject({ code: "worker_failed" });
    const b = expect(client.request(read("B"))).rejects.toMatchObject({ code: "worker_failed" });
    old.exit();
    await Promise.all([a, b]);
    await expect(client.request(read("C"))).rejects.toMatchObject({ code: "worker_failed" });
    expect(factory).toHaveBeenCalledOnce();
    expect(client.queueLength()).toBe(0);
  } finally { await client.dispose(); }
});

test("a writer failure rejects queued operations and never overlaps its replacement", async () => {
  let finish!: (value: number) => void;
  const old = reader(() => new Promise(resolve => { finish = resolve; }));
  const fresh = reader();
  const factory = vi.fn().mockReturnValueOnce(old.port).mockReturnValueOnce(fresh.port);
  const client = new HistoryWorkerClient({ role: "writer", portFactory: factory });
  try {
    const a = expect(client.request({ kind: "dispose" })).rejects.toMatchObject({ code: "worker_failed" });
    const b = expect(client.request({ kind: "dispose" })).rejects.toMatchObject({ code: "worker_failed" });
    old.exit();
    await Promise.all([a, b]);
    await expect(client.request({ kind: "dispose" })).rejects.toMatchObject({ code: "worker_failed" });
    expect(old.sent).toHaveLength(1);
    expect(factory).toHaveBeenCalledOnce();
    expect(client.queueLength()).toBe(0);
    finish(0);
    await Promise.resolve();
    const next = client.request({ kind: "dispose" });
    expect(fresh.sent).toHaveLength(1);
    fresh.reply(3, "fresh writer");
    expect((await next).value).toBe("fresh writer");
  } finally { finish?.(0); await client.dispose(); }
});

test("concurrent client shutdown callers share active and already-retiring worker fences", async () => {
  for (const alreadyRetiring of [false, true]) {
    let finish!: (code: number) => void;
    const old = reader(() => new Promise(resolve => { finish = resolve; }));
    const client = new HistoryWorkerClient({ portFactory: () => old.port });
    try {
      const request = expect(client.request(read("A"))).rejects.toMatchObject({
        code: alreadyRetiring ? "worker_failed" : "worker_disposed",
      });
      if (alreadyRetiring) old.exit();
      const first = client.dispose();
      const second = client.dispose();
      expect(second).toBe(first);
      let ended = false;
      void second.then(() => { ended = true; });
      await request;
      expect(ended).toBe(false);
      expect(old.port.terminate).toHaveBeenCalledOnce();
      finish(0);
      await Promise.all([first, second]);
      expect(ended).toBe(true);
      expect(client.dispose()).toBe(first);
    } finally { finish?.(0); await client.dispose(); }
  }
});
