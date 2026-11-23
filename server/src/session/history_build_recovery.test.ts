import { afterEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryIndexWriter, HistoryIndexReader } from "./history_index.js";
import { HistoryWorkerClient, type HistoryWorkerPort } from "./history_worker_client.js";

const scratch: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controlledPort() {
  const handlers = new Map<string, Array<(value: unknown) => void>>();
  const port: HistoryWorkerPort = {
    mode: "threads",
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as (value: unknown) => void);
      handlers.set(event, list);
    },
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  return { port, emit(event: string, value: unknown) {
    for (const handler of handlers.get(event) ?? []) handler(value);
  } };
}

describe("large cold build recovery", () => {
  test("a timed-out worker's late exit/error cannot kill its replacement", async () => {
    vi.useFakeTimers();
    const old = controlledPort();
    const fresh = controlledPort();
    const ports = [old.port, fresh.port];
    const client = new HistoryWorkerClient({ portFactory: () => ports.shift()!, timeoutMs: 30_000 });
    try {
      const expired = expect(client.request({ kind: "dispose" })).rejects.toMatchObject({ code: "worker_timeout" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expired;
      const recovered = client.request({ kind: "dispose" }).then(
        value => ({ value }), error => ({ error }),
      );
      old.emit("exit", 1);
      old.emit("error", new Error("late failure"));
      old.emit("message", { id: 2, ok: true, value: "stale" });
      fresh.emit("message", { id: 2, ok: true, value: "ready" });
      expect(await recovered).toMatchObject({ value: { value: "ready" } });
      expect(fresh.port.terminate).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  });

  test("seed predecessor seeks the timestamp key and preserves ties, order and append semantics", () => {
    const root = mkdtempSync(join(tmpdir(), "rp87-seed-regression-"));
    scratch.push(root);
    const file = join(root, "index.sqlite");
    const writer = new HistoryIndexWriter(file);
    const reader = new HistoryIndexReader(file);
    expect(writer.open()).toEqual({ ok: true });
    try {
      // Deliberately insert out of chronological order, including a timestamp tie.
      const rows = [
        ["z", "03", "assistant"], ["c", "02", "assistant"],
        ["a", "01", "assistant"], ["b", "02", "user"],
        ["d", "02", "user"], ["e", "02", "assistant"],
      ];
      writer.transaction(() => {
        for (const [id, timestamp, role] of rows) writer.insertEntry({
          workspace: "w", session_id: "s", generation: "g", entry_id: id,
          parent_id: null, timestamp, role, event_count: 1, seed_user_id: null,
          line_start: 0, line_end: 1, projections: "[]",
        });
        writer.recomputeSeeds("w", "s", "g");
      });
      expect(reader.open()).toBe(true);
      for (const [id, seed] of [["a", null], ["b", null], ["c", "b"], ["d", "b"], ["e", "d"], ["z", "d"]]) {
        expect(reader.entry("w", "s", "g", id!)?.seed_user_id).toBe(seed);
      }
      writer.transaction(() => {
        writer.insertEntry({ workspace: "w", session_id: "s", generation: "g", entry_id: "new",
          parent_id: null, timestamp: "04", role: "assistant", event_count: 1,
          seed_user_id: null, line_start: 2, line_end: 3, projections: "[]" });
        writer.recomputeSeedsFor("w", "s", "g", ["new"]);
      });
      expect(reader.entry("w", "s", "g", "new")?.seed_user_id).toBe("d");
      // Check the SQL actually prepared by both production methods, not a copy
      // of the desired query. A prefix-only seek scans later rows per entry.
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const source = [writer.recomputeSeeds.toString(), writer.recomputeSeedsFor.toString()];
        for (const method of source) {
          const sql = method.match(/UPDATE entries SET seed_user_id = \([\s\S]*?WHERE workspace = \? AND session_id = \? AND generation = \?(?: AND entry_id = \?)?/u)?.[0];
          expect(sql).toBeDefined();
          const args = sql!.includes("AND entry_id = ?") ? ["w", "s", "g", "new"] : ["w", "s", "g"];
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
          expect(plan.map(row => row["detail"]).join("\n")).toMatch(/SEARCH prev .*timestamp<\?/u);
        }
      } finally { db.close(); }
    } finally {
      reader.close();
      writer.close();
    }
  });
});
