import { describe, expect, it } from "vitest";
import { collectRuntimeStatus, comparableRuntimeStatus, type RuntimeStatusSources } from "./runtime_status.js";

const FIXED_DATE = new Date("2026-09-29T10:00:00.000Z");
const now = () => FIXED_DATE;

function sources(overrides: Partial<RuntimeStatusSources> = {}): RuntimeStatusSources {
  return { now, ...overrides };
}

function assistantEntry(usage: Record<string, unknown>) {
  return { type: "message", id: "a1", message: { role: "assistant" }, usage };
}

describe("collectRuntimeStatus — model", () => {
  it("reads provider/id and normalises snake_case window fields", () => {
    const status = collectRuntimeStatus(sources({
      model: { provider: "anthropic", id: "claude-sonnet-4-5", context_window: 200000, max_tokens: 8192, reasoning: true },
    }));
    expect(status.model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
    });
  });

  it("returns null when the provider or id is missing", () => {
    expect(collectRuntimeStatus(sources({ model: { provider: "anthropic" } })).model).toBeNull();
    expect(collectRuntimeStatus(sources({ model: undefined })).model).toBeNull();
  });

  it("falls back to ctx.model when no model is passed explicitly", () => {
    const status = collectRuntimeStatus(sources({ ctx: { model: { provider: "openai", id: "gpt-5" } } }));
    expect(status.model).toEqual({ provider: "openai", id: "gpt-5" });
  });
});

describe("collectRuntimeStatus — thinking level", () => {
  it("accepts a known level", () => {
    const status = collectRuntimeStatus(sources({ pi: { getThinkingLevel: () => "high" } }));
    expect(status.thinkingLevel).toBe("high");
  });

  it("rejects an unknown level", () => {
    const status = collectRuntimeStatus(sources({ pi: { getThinkingLevel: () => "extreme" } }));
    expect(status.thinkingLevel).toBeNull();
  });

  it("survives a throwing getter", () => {
    const status = collectRuntimeStatus(sources({
      pi: { getThinkingLevel: () => { throw new Error("stale ctx"); } },
    }));
    expect(status.thinkingLevel).toBeNull();
  });
});

describe("collectRuntimeStatus — usage", () => {
  it("is zeroed with no entries", () => {
    const { usage } = collectRuntimeStatus(sources());
    expect(usage.input).toBe(0);
    expect(usage.cost.total).toBe(0);
  });

  it("sums across assistant entries and ignores non-assistant ones", () => {
    const status = collectRuntimeStatus(sources({
      ctx: {
        sessionManager: {
          getEntries: () => [
            assistantEntry({ input: 10, output: 5, cost: { input: 0.1, output: 0.05, total: 0.15 } }),
            { type: "message", id: "u1", message: { role: "user" } },
            assistantEntry({ input: 20, output: 10, cacheRead: 100, cacheWrite: 50, cost: { input: 0.2, output: 0.1, total: 0.3 } }),
          ],
        },
      },
    }));
    expect(status.usage.input).toBe(30);
    expect(status.usage.output).toBe(15);
    expect(status.usage.cacheRead).toBe(100);
    expect(status.usage.cacheWrite).toBe(50);
    expect(status.usage.cost.total).toBeCloseTo(0.45);
  });

  it("normalises snake_case cache fields", () => {
    const status = collectRuntimeStatus(sources({
      ctx: { sessionManager: { getEntries: () => [assistantEntry({ cache_read: 7, cache_write: 3 })] } },
    }));
    expect(status.usage.cacheRead).toBe(7);
    expect(status.usage.cacheWrite).toBe(3);
  });

  it("derives cost.total when the provider omits it", () => {
    const status = collectRuntimeStatus(sources({
      ctx: {
        sessionManager: {
          getEntries: () => [assistantEntry({ cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.01 } })],
        },
      },
    }));
    expect(status.usage.cost.total).toBeCloseTo(0.36);
  });

  it("survives a throwing getEntries", () => {
    const status = collectRuntimeStatus(sources({
      ctx: { sessionManager: { getEntries: () => { throw new Error("stale ctx"); } } },
    }));
    expect(status.usage.input).toBe(0);
  });
});

describe("collectRuntimeStatus — context", () => {
  it("reads tokens, window and percent", () => {
    const status = collectRuntimeStatus(sources({
      ctx: { getContextUsage: () => ({ tokens: 65000, contextWindow: 200000, percent: 32.5 }) },
    }));
    expect(status.context).toEqual({ tokens: 65000, contextWindow: 200000, percent: 32.5 });
  });

  it("allows null tokens and percent right after compaction", () => {
    const status = collectRuntimeStatus(sources({
      ctx: { getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }) },
    }));
    expect(status.context).toEqual({ tokens: null, contextWindow: 200000, percent: null });
  });

  it("is null when no context usage is available", () => {
    expect(collectRuntimeStatus(sources({ ctx: {} })).context).toBeNull();
    expect(collectRuntimeStatus(sources({ ctx: { getContextUsage: () => undefined } })).context).toBeNull();
  });

  it("survives a throwing getContextUsage", () => {
    const status = collectRuntimeStatus(sources({
      ctx: { getContextUsage: () => { throw new Error("stale ctx"); } },
    }));
    expect(status.context).toBeNull();
  });

  it("normalises a snake_case context window", () => {
    const status = collectRuntimeStatus(sources({
      ctx: { getContextUsage: () => ({ tokens: 10, context_window: 1000, percentage: 1 }) },
    }));
    expect(status.context).toEqual({ tokens: 10, contextWindow: 1000, percent: 1 });
  });
});

describe("comparableRuntimeStatus", () => {
  it("ignores updatedAt so an unchanged snapshot compares equal", () => {
    const base: RuntimeStatusSources = { model: { provider: "anthropic", id: "m" } };
    const first = collectRuntimeStatus({ ...base, now: () => new Date("2026-09-29T10:00:00.000Z") });
    const second = collectRuntimeStatus({ ...base, now: () => new Date("2026-09-29T10:00:05.000Z") });
    expect(first.updatedAt).not.toBe(second.updatedAt);
    expect(comparableRuntimeStatus(first)).toBe(comparableRuntimeStatus(second));
  });

  it("differs when a meaningful field changes", () => {
    const one = collectRuntimeStatus(sources({ pi: { getThinkingLevel: () => "low" } }));
    const two = collectRuntimeStatus(sources({ pi: { getThinkingLevel: () => "high" } }));
    expect(comparableRuntimeStatus(one)).not.toBe(comparableRuntimeStatus(two));
  });
});
