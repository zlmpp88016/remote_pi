/**
 * Plan 01 (Wave 2) — runtime status snapshot.
 *
 * Ported from `zerray/pi-remote-control`'s `src/runtime-status.ts`. That project
 * ships model, thinking level, cumulative usage/cost and context-window
 * occupancy to the client so the phone can show what the desktop shows.
 *
 * We already publish model and thinking level over the relay's `room_meta`, but
 * usage was only present on history events and never rendered, and cost and
 * context occupancy were absent entirely. This module collects all of it from
 * the live extension context.
 *
 * Everything here is defensive: `ctx` surfaces differ across SDK versions and a
 * stale context (captured before a session replacement) throws on property
 * access. A status snapshot is cosmetic — it must never take down the agent, so
 * every read is guarded and degrades to null/zero.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RuntimeStatus {
  model: {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  } | null;
  thinkingLevel: ThinkingLevel | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  updatedAt: string;
}

export interface RuntimeStatusSources {
  /** The current model, as exposed on `ctx.model`. */
  model?: unknown;
  /** Extension API carrying `getThinkingLevel()`. */
  pi?: unknown;
  /** Context carrying `getContextUsage()` and `sessionManager`. */
  ctx?: unknown;
  now?: () => Date;
}

export function collectRuntimeStatus(sources: RuntimeStatusSources): RuntimeStatus {
  const ctx = asRecord(sources.ctx);
  return {
    model: collectModel(sources.model ?? ctx.model),
    thinkingLevel: collectThinkingLevel(sources.pi),
    usage: collectUsage(readSessionEntries(ctx)),
    context: collectContextUsage(callMethod(ctx, "getContextUsage")),
    updatedAt: (sources.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * A comparable form of the snapshot with `updatedAt` removed, so callers can
 * skip publishing an unchanged status on every event.
 */
export function comparableRuntimeStatus(status: RuntimeStatus): string {
  const { updatedAt: _updatedAt, ...rest } = status;
  return JSON.stringify(rest);
}

function collectModel(value: unknown): RuntimeStatus["model"] {
  const model = asRecord(value);
  const provider = readString(model.provider);
  const id = readString(model.id) ?? readString(model.model);
  if (!provider || !id) return null;
  return withoutUndefined({
    provider,
    id,
    name: readString(model.name),
    contextWindow: readNumber(model.contextWindow) ?? readNumber(model.context_window),
    maxTokens: readNumber(model.maxTokens) ?? readNumber(model.max_tokens),
    reasoning: readBoolean(model.reasoning),
  });
}

function collectThinkingLevel(pi: unknown): ThinkingLevel | null {
  const level = callMethod(asRecord(pi), "getThinkingLevel");
  return typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level)
    ? (level as ThinkingLevel)
    : null;
}

/**
 * Cumulative usage across the session, summed from assistant entries.
 *
 * The live context exposes no running total, so it is derived by folding the
 * persisted entries — which also means the number survives a reconnect.
 */
function collectUsage(entries: readonly unknown[]): RuntimeStatus["usage"] {
  const usage: RuntimeStatus["usage"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  for (const entry of entries) {
    const record = asRecord(entry);
    const message = asRecord(record.message);
    if (message.role !== "assistant" && record.role !== "assistant") continue;
    const entryUsage = asRecord(record.usage ?? message.usage);

    usage.input += readNumber(entryUsage.input) ?? 0;
    usage.output += readNumber(entryUsage.output) ?? 0;
    usage.cacheRead += readNumber(entryUsage.cacheRead) ?? readNumber(entryUsage.cache_read) ?? 0;
    usage.cacheWrite += readNumber(entryUsage.cacheWrite) ?? readNumber(entryUsage.cache_write) ?? 0;

    const cost = asRecord(entryUsage.cost);
    usage.cost.input += readNumber(cost.input) ?? 0;
    usage.cost.output += readNumber(cost.output) ?? 0;
    usage.cost.cacheRead += readNumber(cost.cacheRead) ?? readNumber(cost.cache_read) ?? 0;
    usage.cost.cacheWrite += readNumber(cost.cacheWrite) ?? readNumber(cost.cache_write) ?? 0;
    usage.cost.total += readNumber(cost.total) ?? 0;
  }

  // Some providers report component costs but no total; derive it rather than
  // publish a zero alongside non-zero components.
  usage.cost.total = usage.cost.total || usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

function collectContextUsage(value: unknown): RuntimeStatus["context"] {
  const usage = asRecord(value);
  const contextWindow = readNumber(usage.contextWindow) ?? readNumber(usage.context_window)
    ?? readNumber(usage.maxTokens) ?? readNumber(usage.max_tokens);
  if (contextWindow === undefined) return null;
  const tokens = readNumber(usage.tokens) ?? readNumber(usage.currentTokens) ?? readNumber(usage.current_tokens);
  const percent = readNumber(usage.percent) ?? readNumber(usage.percentage);
  return {
    tokens: tokens ?? null,
    contextWindow,
    percent: percent ?? null,
  };
}

function readSessionEntries(ctx: Record<string, unknown>): readonly unknown[] {
  const sessionManager = asRecord(ctx.sessionManager);
  const entries = callMethod(sessionManager, "getEntries");
  return Array.isArray(entries) ? entries : [];
}

/** Invoke a method defensively: stale contexts throw, and this must not. */
function callMethod(record: Record<string, unknown>, key: string): unknown {
  const value = record[key];
  if (typeof value !== "function") return undefined;
  try {
    return (value as () => unknown).call(record);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
