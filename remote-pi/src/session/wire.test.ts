import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "./runtime_status.js";
import type { TreeEntry, TreeSnapshot } from "./tree.js";
import { toRuntimeStatusWire, toTreeSnapshotWire } from "./wire.js";
import { decodeServer } from "../protocol/codec.js";

/**
 * `wire.ts` is the only place camelCase becomes snake_case. A typo there is
 * invisible to every other test — the collector tests assert on the internal
 * shape and the codec tests only check the `type` field — so these tests pin the
 * exact wire keys, including the `undefined`-must-be-omitted rule.
 *
 * The fixture cases go one step further: they run the produced object through
 * the same `decodeServer` the app's contract relies on, so a key that drifts out
 * of the shared fixtures fails here instead of on a device.
 */

const fixtureDir = fileURLToPath(
  new URL("../../../.orchestration/contracts/fixtures", import.meta.url),
);

function fixture(file: string): unknown[] {
  return readFileSync(`${fixtureDir}/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const status: RuntimeStatus = {
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 200000,
    reasoning: true,
  },
  thinkingLevel: "high",
  usage: {
    input: 18500,
    output: 2400,
    cacheRead: 12000,
    cacheWrite: 800,
    cost: { input: 0.0555, output: 0.036, cacheRead: 0.0036, cacheWrite: 0.003, total: 0.0981 },
  },
  context: { tokens: 19800, contextWindow: 200000, percent: 9.9 },
  updatedAt: "2026-09-29T10:05:00.000Z",
};

const entry: TreeEntry = {
  id: "u1",
  parentId: null,
  type: "message",
  role: "user",
  title: "user",
  preview: "explique o reducer",
  timestamp: "2026-09-29T10:00:00.000Z",
  isCurrentLeaf: false,
  isOnActiveBranch: true,
  isForkable: true,
  navigationBehavior: "edit_prompt",
};

describe("toRuntimeStatusWire", () => {
  it("uses snake_case keys for every nested field", () => {
    const wire = toRuntimeStatusWire(status) as unknown as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(
      ["context", "model", "thinking_level", "updated_at", "usage"].sort(),
    );
    expect(wire.thinking_level).toBe("high");
    expect(wire.updated_at).toBe("2026-09-29T10:05:00.000Z");

    const model = wire.model as Record<string, unknown>;
    expect(model.context_window).toBe(200000);
    expect(model).not.toHaveProperty("contextWindow");

    const usage = wire.usage as Record<string, unknown>;
    expect(usage.cache_read).toBe(12000);
    expect(usage.cache_write).toBe(800);
    expect(usage).not.toHaveProperty("cacheRead");

    const cost = usage.cost as Record<string, unknown>;
    expect(cost.cache_read).toBeCloseTo(0.0036, 9);
    expect(cost.total).toBeCloseTo(0.0981, 9);

    const context = wire.context as Record<string, unknown>;
    expect(context.context_window).toBe(200000);
  });

  it("passes null through for absent model/context instead of inventing a value", () => {
    const wire = toRuntimeStatusWire({
      model: null,
      thinkingLevel: null,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      context: null,
      updatedAt: "2026-09-29T10:05:30.000Z",
    });
    expect(wire.model).toBeNull();
    expect(wire.thinking_level).toBeNull();
    expect(wire.context).toBeNull();
  });

  it("omits undefined optional model fields rather than emitting them", () => {
    const wire = toRuntimeStatusWire({
      ...status,
      model: { provider: "anthropic", id: "bare" },
    });
    const model = wire.model as Record<string, unknown>;
    expect(model).toEqual({ provider: "anthropic", id: "bare" });
    expect("name" in model).toBe(false);
    expect("context_window" in model).toBe(false);
    expect("reasoning" in model).toBe(false);
  });

  it("decodes through the shared server codec without error", () => {
    const decoded = decodeServer(
      JSON.stringify({ type: "runtime_status", status: toRuntimeStatusWire(status) }),
    );
    expect(decoded.type).toBe("runtime_status");
  });

  it("matches the committed runtime_status fixture key set", () => {
    const [expected] = fixture("runtime_status.jsonl") as Array<{ status: Record<string, unknown> }>;
    const actual = JSON.parse(JSON.stringify(toRuntimeStatusWire(status))) as Record<string, unknown>;
    // Compare key sets structurally so a renamed/dropped key fails here.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected!.status).sort());
    const expModel = expected!.status.model as Record<string, unknown>;
    const actModel = actual.model as Record<string, unknown>;
    expect(Object.keys(actModel).sort()).toEqual(Object.keys(expModel).sort());
  });
});

describe("toTreeSnapshotWire", () => {
  const snapshot: TreeSnapshot = {
    snapshotVersion: "treev_a",
    branchVersion: "branchv_b",
    leafId: "a2",
    entries: [entry],
    defaultFilter: "default",
    filters: ["default", "user", "assistant", "tools"],
  };

  it("uses snake_case keys and maps entries", () => {
    const wire = toTreeSnapshotWire(snapshot) as unknown as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(
      ["branch_version", "default_filter", "entries", "filters", "leaf_id", "snapshot_version"].sort(),
    );
    expect(wire.leaf_id).toBe("a2");
    expect(wire.default_filter).toBe("default");
    expect(wire.filters).toEqual(["default", "user", "assistant", "tools"]);

    const [wireEntry] = wire.entries as Array<Record<string, unknown>>;
    expect(wireEntry!.parent_id).toBeNull();
    expect(wireEntry!.is_current_leaf).toBe(false);
    expect(wireEntry!.is_on_active_branch).toBe(true);
    expect(wireEntry!.is_forkable).toBe(true);
    expect(wireEntry!.navigation_behavior).toBe("edit_prompt");
    expect(wireEntry).not.toHaveProperty("parentId");
    expect(wireEntry).not.toHaveProperty("isForkable");
  });

  it("omits undefined optional entry fields", () => {
    const wire = toTreeSnapshotWire({ ...snapshot, entries: [entry] });
    const [wireEntry] = wire.entries as Array<Record<string, unknown>>;
    expect("custom_type" in wireEntry!).toBe(false);
    expect("tool_name" in wireEntry!).toBe(false);
  });

  it("copies the filters array so a caller cannot mutate the snapshot", () => {
    const wire = toTreeSnapshotWire(snapshot);
    wire.filters.push("injected");
    expect(snapshot.filters).toEqual(["default", "user", "assistant", "tools"]);
  });

  it("decodes through the shared server codec without error", () => {
    const decoded = decodeServer(
      JSON.stringify({ type: "tree_snapshot_ok", in_reply_to: "r1", snapshot: toTreeSnapshotWire(snapshot) }),
    );
    expect(decoded.type).toBe("tree_snapshot_ok");
  });

  it("matches the committed tree fixture key sets", () => {
    const [expected] = fixture("tree_snapshot.jsonl") as Array<{
      snapshot: { entries: Array<Record<string, unknown>> } & Record<string, unknown>;
    }>;
    const actual = JSON.parse(JSON.stringify(toTreeSnapshotWire(snapshot))) as Record<string, unknown>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected!.snapshot).sort());
    const actEntry = (actual.entries as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(actEntry).sort()).toEqual(Object.keys(expected!.snapshot.entries[0]!).sort());
  });
});
