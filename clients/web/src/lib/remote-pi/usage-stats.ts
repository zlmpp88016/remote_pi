/**
 * Usage and speed accounting for the transcript.
 *
 * Everything here is DERIVED, never invented: the numbers come from the host's
 * per-assistant-message `usage` (which mirrors the SDK's `Usage`:
 * `input/output/cacheRead/cacheWrite/reasoning/totalTokens`) plus the event
 * timestamps. A field the host did not send stays absent rather than becoming a
 * zero that would render as a confident "0 tok/s".
 *
 * The shape deliberately mirrors DeepSeek Harness' composer stats
 * (`packages/client/ui-chat/src/client/chat/StatsPills.tsx`): turns/steps plus a
 * decode-speed reading, and a token total plus a cache-hit share.
 */
import type { WireSessionEvent, WireUsage } from "./protocol";

/** One assistant step's timing, used to separate decode time from wall time. */
interface StepTiming {
  /** When the user message that opened the turn arrived. */
  turnStartTs: number | null;
  /** Timestamp of this assistant message. */
  ts: number;
}

export interface UsageTotals {
  /** Assistant messages, i.e. model round-trips. */
  steps: number;
  /** User turns that produced at least one assistant step. */
  turns: number;
  /** Summed `output_tokens` across steps that reported usage. */
  outputTokens: number;
  /** Summed prompt-side tokens billed on a miss (`input_tokens`). */
  inputTokens: number;
  /** Summed prompt tokens served from cache. */
  cacheReadTokens: number;
  /** Summed prompt tokens written into cache. */
  cacheWriteTokens: number;
  /** Summed reasoning tokens (a subset of `output_tokens`). */
  reasoningTokens: number;
  /**
   * Wall time attributable to decoding, i.e. summed gaps between an assistant
   * message and the step that preceded it. `null` when nothing was timed, so a
   * caller renders nothing instead of an infinite speed.
   */
  decodeMs: number | null;
  /** Output tokens on the steps that contributed to `decodeMs`. */
  decodeTokens: number;
  /** Steps that carried a usable timing gap. */
  timedSteps: number;
}

/**
 * Fold the transcript's events into display totals.
 *
 * @param events - host transcript events in arrival order.
 * @returns totals plus derived speed and cache-hit readings.
 */
export function deriveUsageTotals(events: readonly WireSessionEvent[]): UsageTotals {
  let steps = 0;
  let turns = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let decodeMs: number | null = null;
  let decodeTokens = 0;
  let timedSteps = 0;

  /** Timestamp of the previous event, used as the start of a decode window. */
  let previousTs: number | null = null;
  /** Whether the current turn already counted toward `turns`. */
  let turnCounted = false;
  /** Whether the previous event was a user message that can open a decode window. */
  let previousWasUser = false;
  /** Whether the previous event was an assistant message. */
  let previousWasAssistant = false;

  for (const event of events) {
    if (event.type === "user_input") {
      /*
       * A turn is counted when its first assistant step arrives, not here: a user
       * message that produced no reply is not a completed round-trip, and counting
       * it would make "N 轮" disagree with the steps beneath it.
       */
      previousTs = event.ts;
      previousWasUser = true;
      previousWasAssistant = false;
      turnCounted = false;
      continue;
    }

    if (event.type === "agent_message") {
      steps += 1;
      if (!turnCounted) {
        turns += 1;
        turnCounted = true;
      }
      const usage = event.usage;
      if (usage !== undefined) {
        outputTokens += usage.output_tokens ?? 0;
        inputTokens += usage.input_tokens ?? 0;
        cacheReadTokens += usage.cache_read_tokens ?? 0;
        cacheWriteTokens += usage.cache_write_tokens ?? 0;
        reasoningTokens += usage.reasoning_tokens ?? 0;
      }
      /*
       * Decode time = this message's arrival minus the previous event's.
       *
       * Only meaningful right after a user message or another assistant step: a
       * gap that spans a tool execution is mostly tool wall time, not decoding,
       * and folding it in would understate the speed. Such a gap is skipped and
       * `timedSteps` stays honest about how much of the turn was measured.
       */
      if (previousTs !== null && (previousWasUser || previousWasAssistant) && event.ts > previousTs) {
        const gap = event.ts - previousTs;
        decodeMs = (decodeMs ?? 0) + gap;
        decodeTokens += usage?.output_tokens ?? 0;
        timedSteps += 1;
      }
      previousTs = event.ts;
      previousWasUser = false;
      previousWasAssistant = true;
      continue;    }

    // Tool and compaction events move the clock without being decode time.
    previousTs = event.ts;
    previousWasUser = false;
    previousWasAssistant = false;
  }

  return {
    steps,
    turns,
    outputTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    decodeMs,
    decodeTokens,
    timedSteps,
  };
}

/**
 * Tokens per second over the measured decode window.
 *
 * @param totals - folded totals.
 * @returns speed rounded for display-ready math, or `null` when nothing was timed.
 */
export function decodeTokensPerSecond(totals: UsageTotals): number | null {
  if (totals.decodeMs === null || totals.decodeMs <= 0) return null;
  if (totals.decodeTokens <= 0) return null;
  return (totals.decodeTokens * 1000) / totals.decodeMs;
}

/**
 * Prompt-side tokens that were actually billed: every bucket that occupies the
 * prompt, i.e. what the cache-hit share is a share OF.
 *
 * @param totals - folded totals.
 * @returns denominator for the cache-hit reading, or 0 when nothing was billed.
 */
export function promptTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/**
 * Total tokens attributed to this session: every prompt-side bucket plus output.
 *
 * @param totals - folded totals.
 * @returns display total, or 0 when nothing was billed.
 */
export function totalTokens(totals: UsageTotals): number {
  return promptTokens(totals) + totals.outputTokens;
}

/**
 * Compact token count: `517` / `12.2K` / `517K` / `1.2M`.
 *
 * Mirrors DSH's `formatTokens` so the two read the same at a glance.
 *
 * @param value - non-negative token count.
 * @returns display string.
 */
export function formatTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/**
 * Speed reading: one decimal below 10, whole numbers above.
 *
 * @param tps - tokens per second.
 * @returns display string.
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String((Math.round(clamped * 10) / 10).toString());
}

/**
 * Cache-hit share without ever rounding a partial hit to 100%.
 *
 * A session that read 37_376 of 37_754 prompt tokens hit 99.0%, and DSH refuses
 * to print "100%" there because that would claim a perfect cache. This keeps the
 * same promise with a simpler implementation: round normally, but when the
 * rounded value would be 100 while tokens were still missed, extend precision
 * just enough to stay under it.
 *
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param promptTotal - total prompt tokens.
 * @returns whole-percent text, or `null` when there was no prompt input.
 */
export function formatCacheHitPercent(cacheReadTokens: number, promptTotal: number): string | null {
  if (promptTotal <= 0) return null;
  const missed = promptTotal - cacheReadTokens;
  if (missed <= 0) return "100";
  const exact = (cacheReadTokens / promptTotal) * 100;
  const rounded = Math.round(exact);
  if (rounded < 100) return String(rounded);
  // A partial hit that would display as 100: show the leading 9s instead.
  const text = exact.toFixed(4);
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed;
}

/**
 * Turn duration for the per-turn divider label.
 *
 * @param ms - elapsed milliseconds.
 * @returns compact display string, e.g. `10秒` / `1分20秒`.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

/**
 * Local wall-clock `YYYY-MM-DD HH:mm:ss` for a message timestamp.
 *
 * Full date AND time, not just `HH:mm`. A bare clock is ambiguous the moment a
 * transcript spans more than one day: two turns twelve hours apart both rendered as
 * `09:14`, and a resumed session showed yesterday's messages as if they had just
 * arrived. The seconds matter too, because turns can complete within the same
 * minute and the ordering is otherwise invisible.
 *
 * Built from the local-time getters (not `toISOString`) so the value matches the
 * user's clock rather than UTC.
 *
 * @param ts - epoch milliseconds.
 * @returns e.g. `2026-10-27 09:14:33`.
 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${time}`;
}

/** Re-exported so callers do not need a second import for the usage shape. */
export type { WireUsage } from "./protocol";
