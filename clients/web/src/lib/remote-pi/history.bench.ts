/**
 * Plan 86 P3 — the client-side measurement seam P0 already knows how to run.
 *
 * WHY THIS FILE EXISTS
 *
 * `server/scripts/bench-history-performance.mjs` has an explicit
 * `--target/--target-export` seam so a later phase can plug in a module instead
 * of the harness inventing a stub. This module is the P3 half of that seam: it
 * drives the REAL client modules (guards, cache, query controller, windowing) and
 * emits samples in the SAME scalar vocabulary P0 defined:
 *
 *   op, requestId, queue_ms, wire_ms, query_ms, read_bytes, parsed_entries,
 *   cache_hit, apply_ms, first_content_ms, long_task_ms
 *
 * HONESTY RULES (inherited from P0)
 *
 *   - A span this module cannot measure is `null`, never 0.
 *   - `query_ms` is the HOST's number and is not measurable here: it stays null.
 *   - `long_task_ms` needs a browser Long Tasks observer; Node has none, so it
 *     stays null. The browser-side long-task number is a separate, later
 *     measurement, not something this file can claim.
 *   - `first_content_ms` here means "content available in the client store",
 *     measured from `open()` to a non-empty item list. It EXCLUDES React paint.
 *     Reporting it as a painted frame would be a lie, so the op name says
 *     `client_cache_first_content`.
 *
 * HOW TO RUN IT (from the repository root):
 *
 *   node server/scripts/bench-history-performance.mjs --mode smoke \
 *     --target clients/web/src/lib/remote-pi/history.bench.ts \
 *     --target-export runHistoryClientBench
 *
 * The harness resolves `--target` against its own cwd, so the relative path above
 * is correct when launched from the root. It never imports `server/dist`.
 */

import {
  historyBodyRequest,
  historyListRequest,
  historyReadRequest,
  parseHistoryReply,
  sanitizeMetrics,
} from "./history.ts";
import { HistoryCache, HistoryListCache, historySessionKey, historyScopeKey } from "./history-cache.ts";
import { HistoryQueryController } from "./history-query.ts";
import { computeWindow, DEFAULT_MAX_RENDERED } from "../../components/remote-pi/sessions/virtual-window.ts";

/** The harness context, structurally (no import of the harness itself). */
export interface HistoryBenchContext {
  performance?: { now(): number };
  emit?: (sample: unknown) => void;
}

const SCOPE = { host: "bench-host", daemon_id: "bench-daemon" };
const SESSION = "bench-session";

function nowOf(ctx: HistoryBenchContext): number {
  const perf = ctx.performance;
  if (perf !== undefined && typeof perf.now === "function") return perf.now();
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** One valid `history_read_ok` with `count` items of `text` bytes each. */
function readFrame(count: number, textSize: number) {
  return {
    type: "history_read_ok",
    in_reply_to: "bench-read-1",
    daemon_id: SCOPE.daemon_id,
    session_id: SESSION,
    snapshot: "bench-snapshot",
    revision: "bench-revision",
    projection: 1,
    session: { id: SESSION, name: "bench", mtime: 1_700_000_000_000, preview: "bench" },
    items: Array.from({ length: count }, (_, i) => ({
      event_id: `e${i}`,
      entry_id: `e${i}`,
      event: { ts: i + 1, type: "agent_message", in_reply_to: `u${i}`, text: "x".repeat(textSize) },
    })),
    older_cursor: null,
    has_older: false,
  };
}

/**
 * Run the P3 client benchmark.
 *
 * @param ctx - the P0 harness context (scalar `emit`, `performance`, scratch).
 * @returns the collected samples, also emitted through `ctx.emit` when present.
 */
export async function runHistoryClientBench(
  ctx: HistoryBenchContext,
): Promise<{ samples?: unknown[] }> {
  const samples: unknown[] = [];
  const emit = (sample: unknown): void => {
    samples.push(sample);
    ctx.emit?.(sample);
  };
  const clock = {
    now: () => nowOf(ctx),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };

  // ── 1. guard + parse cost of one page ────────────────────────────────────
  {
    const frame = readFrame(50, 2_048);
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
    const started = nowOf(ctx);
    const parsed = parseHistoryReply(frame);
    const elapsed = nowOf(ctx) - started;
    if (parsed.ok && parsed.value.type === "history_read_ok") {
      emit(
        sanitizeMetrics({
          op: "client_read_parse",
          requestId: "bench-read-1",
          queue_ms: null,
          wire_ms: elapsed,
          query_ms: null,
          read_bytes: bytes,
          parsed_entries: parsed.value.items.length,
          cache_hit: false,
          apply_ms: null,
          first_content_ms: null,
          long_task_ms: null,
        }),
      );
    }
  }

  // ── 2. cache hit → content available ─────────────────────────────────────
  {
    const cache = new HistoryCache();
    const listCache = new HistoryListCache();
    const sent: string[] = [];
    const controller = new HistoryQueryController({
      cache,
      listCache,
      clock,
      ports: {
        sendList: () => {},
        sendRead: (request) => sent.push(request.id),
        sendBody: (request) => sent.push(request.id),
        makeId: () => `bench-${sent.length + 1}`,
      },
    });
    // Prime exactly as a completed first read would.
    controller.open(SCOPE, SESSION, { subscriber: "warm", priority: "foreground" });
    const firstRequest = sent[0];
    controller.onFrame({ ...readFrame(30, 512), in_reply_to: firstRequest });
    controller.leave(SCOPE, SESSION, "warm");

    const iterations = 20;
    const timings: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = nowOf(ctx);
      controller.open(SCOPE, SESSION, { subscriber: "click", priority: "foreground" });
      const view = controller.view(SCOPE, SESSION);
      const elapsed = nowOf(ctx) - started;
      if (view !== null && view.items.length > 0) timings.push(elapsed);
      controller.leave(SCOPE, SESSION, "click");
    }
    timings.sort((a, b) => a - b);
    const median = timings.length === 0 ? null : timings[Math.floor(timings.length / 2)];
    emit(
      sanitizeMetrics({
        op: "client_cache_first_content",
        requestId: null,
        queue_ms: null,
        wire_ms: null,
        query_ms: null,
        read_bytes: 0,
        parsed_entries: 30,
        cache_hit: true,
        apply_ms: median,
        first_content_ms: median,
        long_task_ms: null,
      }),
    );
    // The repeat count travels in `counts`, which the harness permits.
    samples[samples.length - 1] = {
      ...(samples[samples.length - 1] ?? {}),
      counts: { iterations, samples: timings.length, posts_during_click: sent.length - 1 },
    };
  }

  // ── 3. hover → click coalescing ──────────────────────────────────────────
  {
    const cache = new HistoryCache();
    const listCache = new HistoryListCache();
    const sent: string[] = [];
    let seq = 0;
    const controller = new HistoryQueryController({
      cache,
      listCache,
      clock,
      ports: {
        sendList: () => {},
        sendRead: (request) => sent.push(request.id),
        sendBody: (request) => sent.push(request.id),
        makeId: () => {
          seq += 1;
          return `coalesce-${seq}`;
        },
      },
    });
    controller.open(SCOPE, "coalesce-session", { subscriber: "hover", priority: "prefetch" });
    controller.promote(SCOPE, "coalesce-session", "click");
    controller.open(SCOPE, "coalesce-session", { subscriber: "click", priority: "foreground" });
    emit({
      ...sanitizeMetrics({
        op: "client_query_coalesce",
        requestId: null,
        queue_ms: null,
        wire_ms: null,
        query_ms: null,
        read_bytes: null,
        parsed_entries: null,
        cache_hit: false,
        apply_ms: null,
        first_content_ms: null,
        long_task_ms: null,
      }),
      counts: { posts: sent.length, clicks: 1, hovers: 1 },
    });
  }

  // ── 4. 100-page window bound ─────────────────────────────────────────────
  {
    const rows = 5_000;
    const heights = new Array(rows).fill(80);
    let maxRendered = 0;
    for (let page = 0; page < 100; page += 1) {
      const window = computeWindow({
        heights,
        scrollTop: page * 50 * 80 + 400,
        viewportHeight: 800,
      });
      maxRendered = Math.max(maxRendered, window.rendered);
    }
    emit({
      ...sanitizeMetrics({
        op: "client_window_100_pages",
        requestId: null,
        queue_ms: null,
        wire_ms: null,
        query_ms: null,
        read_bytes: null,
        parsed_entries: rows,
        cache_hit: null,
        apply_ms: null,
        first_content_ms: null,
        long_task_ms: null,
      }),
      counts: { rows, pages: 100, max_rendered: maxRendered, cap: DEFAULT_MAX_RENDERED },
    });
  }

  // ── 5. body chunking cost ────────────────────────────────────────────────
  {
    const requests = {
      list: historyListRequest("bench-list", SCOPE.daemon_id, { limit: 50 }),
      read: historyReadRequest("bench-read", SCOPE.daemon_id, SESSION, { limit: 30 }),
      body: historyBodyRequest("bench-body", SCOPE.daemon_id, SESSION, "snap", "ref", 0),
    };
    emit({
      ...sanitizeMetrics({
        op: "client_request_builders",
        requestId: null,
        queue_ms: null,
        wire_ms: null,
        query_ms: null,
        read_bytes: null,
        parsed_entries: Object.keys(requests).length,
        cache_hit: null,
        apply_ms: null,
        first_content_ms: null,
        long_task_ms: null,
      }),
      counts: { requests: Object.keys(requests).length },
    });
  }

  // Cache identity helpers are part of the contract the bench relies on; a
  // regression that changed them would make the numbers incomparable.
  emit({
    ...sanitizeMetrics({
      op: "client_cache_identity",
      requestId: null,
      queue_ms: null,
      wire_ms: null,
      query_ms: null,
      read_bytes: null,
      parsed_entries: null,
      cache_hit: null,
      apply_ms: null,
      first_content_ms: null,
      long_task_ms: null,
    }),
    counts: {
      scope_key_length: historyScopeKey(SCOPE.host, SCOPE.daemon_id).length,
      session_key_length: historySessionKey(historyScopeKey(SCOPE.host, SCOPE.daemon_id), SESSION).length,
    },
  });

  /*
   * The harness ALSO collects whatever  received, so returning the
   * array here would double every sample. Return it only when the harness did not
   * give us an emit sink (a plain script driving this module directly).
   */
  return ctx.emit === undefined ? { samples } : {};
}
