/**
 * Plan 86 P3 — the history query controller: one in-flight task per identity,
 * typed failures, real pagination, and the guards that keep a late reply from
 * landing in the wrong place.
 *
 * WHY THIS IS A CLASS AND NOT A HOOK
 *
 * The rules are stateful and they ARE the feature: join an in-flight read
 * instead of issuing a second one, promote a prefetch when the pointer becomes a
 * click, release on leave, discard a reply a write barrier or a reconnect made
 * obsolete, and keep paging contiguous. React has nothing to do with any of
 * that, and a hook would bury it under render ordering. The container mirrors
 * this object's immutable snapshots into `useState`; the rules themselves are
 * plain TypeScript and are tested without a DOM.
 *
 * THE THREE GUARDS, STATED PLAINLY
 *
 *  1. REQUEST ID: a reply is applied only to the request it answers. An unknown
 *     id (a duplicate, a reply after a timeout) is counted and dropped.
 *  2. SCOPE: a reply naming another workspace/session is never applied, even if
 *     the id matches.
 *  3. EPOCH: the SSE transport bumps a write epoch the moment a write is queued.
 *     A read launched before that epoch describes pre-write state, so its reply
 *     is discarded and the read is re-issued AFTER the write settles — never
 *     applied over newer content.
 *
 * IDENTITY IS `event_id`
 *
 * Paging merges by the host's stable `event_id`, never by array index or
 * timestamp. A repeated item does not duplicate or move, and a tool-call parent
 * that arrives with a later page merges where it already sits.
 */

import { historyProbeMark } from "./history-probe.ts";
import {
  HistoryBodyAssembler,
  bodyRefIdentity,
  emptyMetrics,
  failureOfErrorFrame,
  historyBodyRequest,
  historyListRequest,
  historyReadRequest,
  isHistoryReplyType,
  mergeHistoryPages,
  parseHistoryReply,
  replyMatchesScope,
  sanitizeMetrics,
  type HistoryBodyRef,
  type HistoryFailure,
  type HistoryItem,
  type HistoryMetricsSample,
  type HistoryReadOk,
  type HistoryScope,
} from "./history.ts";
import {
  historyPageKey,
  historyScopeKey,
  historySessionKey,
  type HistoryCache,
  type HistoryListCache,
  type HistoryPage,
} from "./history-cache.ts";

/** Foreground = the user is waiting. Prefetch = the pointer crossed a row. */
export type HistoryPriority = "foreground" | "prefetch";

const PRIORITY_RANK: Readonly<Record<HistoryPriority, number>> = {
  foreground: 0,
  prefetch: 1,
};

/** One timer seam, injected by tests so ordering is deterministic. */
export interface HistoryClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: HistoryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Everything the controller needs from the transport. No wire leaks upward. */
export interface HistoryPorts {
  sendList: (request: ReturnType<typeof historyListRequest>, priority: HistoryPriority) => void;
  sendRead: (request: ReturnType<typeof historyReadRequest>, priority: HistoryPriority) => void;
  sendBody: (request: ReturnType<typeof historyBodyRequest>, priority: HistoryPriority) => void;
  makeId: () => string;
  /** Promote a QUEUED read after a click (no-op when it already went out). */
  reprioritize?: (requestId: string, priority: HistoryPriority) => void;
  /** Scalar-only sample sink. */
  metrics?: (sample: HistoryMetricsSample) => void;
}

export interface HistoryQueryOptions {
  cache: HistoryCache;
  listCache: HistoryListCache;
  ports: HistoryPorts;
  clock?: HistoryClock;
  /** A read that never answers is released here (ms). */
  readTimeoutMs?: number;
  bodyTimeoutMs?: number;
  /** Page sizes. Clamped again by the request builders. */
  readLimit?: number;
}

// ── Public view state ────────────────────────────────────────────────────────

export interface HistoryView {
  /** Workspace scope key (`host ⨯ daemon_id`). */
  scope: string;
  session_id: string;
  /** Oldest first, contiguous, de-duplicated by `event_id`. */
  items: readonly HistoryItem[];
  /** Cursor for the next OLDER page, exactly as the host issued it. */
  older_cursor: string | null;
  has_older: boolean;
  snapshot: string;
  revision: string;
  projection: number;
  /** First page in flight AND nothing painted yet. */
  loading: boolean;
  /** Painted from cache; a live reply has not confirmed it. */
  stale: boolean;
  /** Older page in flight. */
  loadingOlder: boolean;
  /** Typed failure of the last attempt, or null. */
  failure: HistoryFailure | null;
  /** At least one visible item is PARTIAL (host `truncated: true`). */
  partial: boolean;
  /** Host is still building its index; ONE retry is scheduled. */
  building: boolean;
  /** Monotonic version, so a consumer can detect a real change cheaply. */
  version: number;
  /** Zero-based page positions counted from the newest head. */
  page_start: number;
  page_end: number;
  resident_pages: number;
  has_newer: boolean;
  loadingNewer: boolean;
  /** Changes only after requested content has applied. */
  content_version: number;
}

type ChangeListener = (scopeKey: string, sessionId: string) => void;

interface Subscriber {
  priority: HistoryPriority;
}

interface PendingRead {
  id: string;
  host: string;
  daemonId: string;
  scopeKey: string;
  sessionKey: string;
  sessionId: string;
  mode: "head" | "refresh" | "older";
  priority: HistoryPriority;
  cursor: string;
  /** Epoch observed when the request was minted. */
  epoch: number;
  /** Epoch observed when it was actually sent (they differ only if queued). */
  sentEpoch: number;
  startedAt: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A barrier invalidated this read before it answered. */
  discardApply: boolean;
  /** Re-issued once after a barrier clear. */
  reissued: boolean;
  /** Cached revision a `refresh` is validating. */
  ifRevision: string | null;
  /**
   * The SNAPSHOT this read is BOUND to — the opaque page-sequence boundary.
   *
   * Two-mode contract (86 integration correction of the P3 wording):
   *
   *  • `older` (and every body chunk) is CARRYING a sequence: it sends back the
   *    snapshot it was loaded with, verbatim, together with that generation's
   *    cursor. The snapshot is never replaced by a newer revision, because
   *    splicing two generations would mix two versions of the same entry; the
   *    host answers `stale` when the generation moved, which is the ONLY safe
   *    answer.
   *  • `head`/`refresh` are DISCOVERING the newest sequence: they send NO
   *    snapshot and NO cursor (`""` here), only `if_revision`. A pinned
   *    snapshot would make the host answer from the OLD high-water and compare
   *    `if_revision` against the CURRENT revision — an appended turn would stay
   *    hidden AND the cached old head would be stamped current (`not_modified`).
   *    A changed head therefore REPLACES the whole loaded page sequence; the
   *    previous sequence's pages are dropped, never spliced onto the new head.
   */
  snapshot: string;
  pageIndex: number;
  replayTarget: number | null;
  direction: "older" | "newer";
}

interface BodyRequest {
  id: string;
  identity: string;
  daemonId: string;
  sessionId: string;
  snapshot: string;
  ref: string;
  assembler: HistoryBodyAssembler;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Array<(value: BodyResult) => void>;
}

export type BodyResult =
  | { ok: true; representation: "text_utf8" | "json_utf8" | "binary"; text: string | null; bytes: Uint8Array | null }
  | HistoryFailure;

export const HISTORY_RESIDENT_MAX_PAGES = 4;
export const HISTORY_CHECKPOINT_MAX_ENTRIES = 32;

interface ReadingWindow {
  /** Only resident keys, never an archive of content or page identities. */
  indices: Map<string, number>;
  /** Bounded cursor-only replay points; page 1 is the pinned replay origin. */
  checkpoints: Map<number, string>;
}

const SEP = "\u0000";

function decodeScope(scopeKey: string): { host: string; daemon_id: string } {
  const at = scopeKey.indexOf(SEP);
  if (at < 0) return { host: scopeKey, daemon_id: "" };
  return { host: scopeKey.slice(0, at), daemon_id: scopeKey.slice(at + 1) };
}

/**
 * One controller per connection generation.
 *
 * `scope` is `{host, daemon_id}`; a controller may serve several workspaces and
 * keeps them apart by cache key. Creating a new controller is the client's reset
 * (reconnect, unpair).
 */
export class HistoryQueryController {
  private readonly cache: HistoryCache;
  private readonly listCache: HistoryListCache;
  private readonly ports: HistoryPorts;
  private readonly clock: HistoryClock;
  private readonly readTimeoutMs: number;
  private readonly bodyTimeoutMs: number;
  private readonly readLimit: number;

  private readonly pendingById = new Map<string, PendingRead>();
  private readonly pendingBySession = new Map<string, PendingRead>();
  private readonly bodies = new Map<string, BodyRequest>();
  private readonly bodyByIdentity = new Map<string, BodyRequest>();
  private readonly bodyFailures = new Map<string, HistoryFailure>();

  /** Painted state per session key. */
  private readonly views = new Map<string, HistoryView>();
  /** Page keys per session: head first, then older pages in load order. */
  private readonly pageKeys = new Map<string, string[]>();
  private readonly windows = new Map<string, ReadingWindow>();
  private readonly composedPages = new Map<string, readonly HistoryPage[]>();
  /** Interest per session: subscriber token → priority. */
  private readonly subscribers = new Map<string, Map<string, Subscriber>>();
  /** One `building` retry timer per session. */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Ordered-reopen budget per session (`stale`).
   *
   * A rewritten/replaced session generation invalidates its snapshot. The client
   * must reopen DELIBERATELY rather than splice two generations — but exactly
   * ONCE, so a host that keeps answering `stale` surfaces a typed failure instead
   * of driving a request loop. Reset by the next successful head page.
   */
  private readonly staleReopens = new Map<string, number>();

  private readonly listeners = new Set<ChangeListener>();
  /** Latest write epoch reported by the transport. */
  private epoch = 0;
  /** Non-null while a write is in flight: reads wait for its settlement. */
  private barrierEpoch: number | null = null;
  /**
   * Reads whose reply arrived from a PRE-write epoch.
   *
   * They are not applied and they are no longer "pending" (the request is
   * settled), but the reader still needs its content — so the barrier CLEAR
   * re-issues each one exactly once, in arrival order.
   */
  private readonly discarded: Array<{
    scope: HistoryScope;
    sessionId: string;
    mode: "head" | "refresh" | "older";
    cursor: string;
    ifRevision: string | null;
    snapshot: string;
    pageIndex: number;
    replayTarget: number | null;
    direction: "older" | "newer";
  }> = [];
  private readonly buildingRetries = new Set<string>();

  constructor(options: HistoryQueryOptions) {
    this.cache = options.cache;
    this.listCache = options.listCache;
    this.ports = options.ports;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.readTimeoutMs = options.readTimeoutMs ?? 30_000;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? 60_000;
    this.readLimit = options.readLimit ?? 50;
  }

  // ── subscriptions ────────────────────────────────────────────────────────

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The current immutable snapshot for one session, or null when untouched. */
  view(scope: HistoryScope, sessionId: string): HistoryView | null {
    return this.views.get(sessionKeyOf(scope, sessionId)) ?? null;
  }

  /** True while a read for this session is in flight (any mode). */
  inFlight(scope: HistoryScope, sessionId: string): boolean {
    return this.pendingBySession.has(sessionKeyOf(scope, sessionId));
  }

  // ── open / promote / leave ───────────────────────────────────────────────

  /**
   * Open a session for reading.
   *
   * `subscriber` is a stable token (the viewer's mount id); re-opening with the
   * same token is idempotent, which is what makes hover → focus → click ONE task.
   *
   * Order of preference:
   *   1. join an in-flight read for this session (promoting it when asked);
   *   2. paint the cached head page immediately, then validate it ONLY if it was
   *      not already confirmed since the last invalidation;
   *   3. issue exactly one read.
   */
  open(
    scope: HistoryScope,
    sessionId: string,
    options: { subscriber: string; priority: HistoryPriority },
  ): void {
    const sessionKey = sessionKeyOf(scope, sessionId);
    this.sweepOwnership();
    if (!this.subscribers.has(sessionKey)) this.buildingRetries.delete(sessionKey);
    this.interestFor(sessionKey).set(options.subscriber, { priority: options.priority });

    const pending = this.pendingBySession.get(sessionKey);
    if (pending !== undefined) {
      this.promotePending(pending, options.priority);
      this.emit(scopeKeyOf(scope), sessionId);
      return;
    }

    const cached = this.cache.headPage(sessionKey);
    if (cached !== null && (this.pageKeys.get(sessionKey)?.length ?? 0) === 0) {
      this.adopt(cached);
      this.recompose(scopeKeyOf(scope), sessionId, { loading: false });
      if (cached.validated) return;
      // Cache-first paint is STALE-LABELLED; exactly one conditional read
      // confirms it (`if_revision`), and `not_modified` costs no content.
      // REVALIDATION ASKS FOR THE NEWEST HEAD: no snapshot, no cursor. Sending
      // the cached snapshot would pin the host to the cached high-water, so a
      // turn appended since would be invisible while `if_revision` was compared
      // against the CURRENT revision and answered `not_modified` — the cached
      // old head would be relabelled current.
      this.startRead(scope, sessionId, {
        mode: "refresh",
        priority: options.priority,
        cursor: "",
        ifRevision: cached.revision,
        snapshot: "",
      });
      return;
    }

    if ((this.pageKeys.get(sessionKey)?.length ?? 0) > 0) {
      // Already painted in this generation: no request at all.
      if (this.views.get(sessionKey)?.stale === true) {
        // Same contract as the cache-first paint: an unconfirmed generation is
        // revalidated against the NEWEST head (`if_revision` only), so a write
        // that landed while the reader was away publishes its new head instead
        // of confirming the stale one.
        this.startRead(scope, sessionId, {
          mode: "refresh",
          priority: options.priority,
          cursor: "",
          ifRevision: this.views.get(sessionKey)?.revision ?? null,
          snapshot: "",
        });
      }
      return;
    }

    this.startRead(scope, sessionId, {
      mode: "head",
      priority: options.priority,
      cursor: "",
      ifRevision: null,
      snapshot: "",
    });
  }

  /**
   * Promote an open/prefetching session to foreground.
   *
   * Returns true when a request was already in flight and got promoted — the
   * case that MUST NOT mint a second request.
   */
  promote(scope: HistoryScope, sessionId: string, subscriber: string): boolean {
    const sessionKey = sessionKeyOf(scope, sessionId);
    this.interestFor(sessionKey).set(subscriber, { priority: "foreground" });
    const pending = this.pendingBySession.get(sessionKey);
    if (pending === undefined) return false;
    this.promotePending(pending, "foreground");
    return true;
  }

  /**
   * Release one subscriber's interest.
   *
   * When the LAST subscriber leaves, the read leaves the single-flight slot: its
   * reply may still fill the cache (bounded), but it can no longer notify a
   * viewer that is gone, and a fresh click issues its own read instead of waiting
   * 30 s for a request nobody wants.
   */
  leave(scope: HistoryScope, sessionId: string, subscriber: string): void {
    const sessionKey = sessionKeyOf(scope, sessionId);
    const interests = this.subscribers.get(sessionKey);
    if (interests === undefined) return;
    interests.delete(subscriber);
    if (interests.size > 0) return;
    this.subscribers.delete(sessionKey);
    for (let index = this.discarded.length - 1; index >= 0; index--) {
      const entry = this.discarded[index]!;
      if (sessionKeyOf(entry.scope, entry.sessionId) === sessionKey) this.discarded.splice(index, 1);
    }
    const pending = this.pendingBySession.get(sessionKey);
    if (pending !== undefined) this.detachPending(pending);
    const retry = this.retryTimers.get(sessionKey);
    if (retry !== undefined) this.clock.clearTimeout(retry);
    this.retryTimers.delete(sessionKey);
    this.buildingRetries.delete(sessionKey);
    this.staleReopens.delete(sessionKey);
    for (const key of this.bodyFailures.keys()) if (key.startsWith(`${sessionKey}${SEP}`)) this.bodyFailures.delete(key);
    for (const body of [...this.bodies.values()]) if (body.identity.startsWith(`${sessionKey}${SEP}`)) this.finishBody(body, { ok: false, code: "transport", detail: "viewer closed" });
    this.releaseView(sessionKey);
  }

  /** Release every interest of one workspace (switch/reset). */
  releaseScope(scope: HistoryScope): void {
    const prefix = `${scopeKeyOf(scope)}${SEP}`;
    for (let index = this.discarded.length - 1; index >= 0; index--) {
      const entry = this.discarded[index]!;
      if (sessionKeyOf(entry.scope, entry.sessionId).startsWith(prefix)) this.discarded.splice(index, 1);
    }
    for (const [sessionKey, pending] of [...this.pendingBySession]) {
      if (sessionKey.startsWith(prefix)) this.detachPending(pending);
    }
    for (const sessionKey of [...this.subscribers.keys()]) {
      if (sessionKey.startsWith(prefix)) { this.subscribers.delete(sessionKey); this.releaseView(sessionKey); }
    }
    for (const [sessionKey, timer] of [...this.retryTimers]) {
      if (!sessionKey.startsWith(prefix)) continue;
      this.clock.clearTimeout(timer);
      this.retryTimers.delete(sessionKey);
    }
    for (const sessionKey of this.buildingRetries) if (sessionKey.startsWith(prefix)) this.buildingRetries.delete(sessionKey);
  }

  // ── paging ───────────────────────────────────────────────────────────────

  /**
   * Load the next older page.
   *
   * Guarded by the single-flight slot: pressing "load older" twice joins the
   * first request. `has_older` is the host's statement, copied — never inferred
   * from the number of items received.
   */
  loadOlder(scope: HistoryScope, sessionId: string): void {
    const sessionKey = sessionKeyOf(scope, sessionId);
    if (this.pendingBySession.has(sessionKey)) return;
    const view = this.views.get(sessionKey);
    if (view === undefined || !view.has_older || view.older_cursor === null) return;
    this.startRead(scope, sessionId, {
      mode: "older",
      priority: "foreground",
      cursor: view.older_cursor,
      ifRevision: null,
      // The SAME snapshot the open page belongs to — never the newest revision.
      snapshot: view.snapshot,
    });
  }

  /** Move newer using real older cursors. Missing checkpoints replay from the
   * pinned page-1 boundary; intermediate reply content is immediately released. */
  loadNewer(scope: HistoryScope, sessionId: string): void {
    const sessionKey = sessionKeyOf(scope, sessionId);
    if (this.pendingBySession.has(sessionKey)) return;
    const view = this.views.get(sessionKey);
    if (view === undefined || !view.has_newer) return;
    const target = Math.max(0, view.page_start - 1);
    if (target === 0) { this.showHead(scope, sessionId); return; }
    const window = this.windows.get(sessionKey);
    let index = 1;
    let cursor = window?.checkpoints.get(1);
    for (const [at, token] of window?.checkpoints ?? []) {
      if (at <= target && at >= index) { index = at; cursor = token; }
    }
    if (cursor === undefined) { this.showHead(scope, sessionId); return; }
    this.startRead(scope, sessionId, {
      mode: "older", priority: "foreground", cursor, snapshot: view.snapshot,
      ifRevision: null, pageIndex: index, replayTarget: target, direction: "newer",
    });
  }

  /** Explicit newest discovery: HEAD never carries an old snapshot/cursor. */
  showHead(scope: HistoryScope, sessionId: string): void {
    if (this.pendingBySession.has(sessionKeyOf(scope, sessionId))) return;
    this.startRead(scope, sessionId, {
      mode: "head", priority: "foreground", cursor: "", snapshot: "", ifRevision: null,
      direction: "newer",
    });
  }

  /** Scalar ownership counters; UTF-8 byte accounting is separate from heap. */
  diagnostics(): Record<string, number> {
    let residentPages = 0, viewItems = 0, checkpoints = 0, checkpointChars = 0;
    for (const keys of this.pageKeys.values()) residentPages += keys.length;
    for (const view of this.views.values()) viewItems += view.items.length;
    for (const window of this.windows.values()) {
      checkpoints += window.checkpoints.size;
      for (const cursor of window.checkpoints.values()) checkpointChars += cursor.length;
    }
    return { cacheBytes: this.cache.bytes, cachePages: this.cache.size,
      cacheSessions: this.cache.sessionCount, viewSessions: this.views.size,
      residentPages, viewItems, checkpoints, checkpointChars, pendingReads: this.pendingById.size };
  }

  // ── write barrier ────────────────────────────────────────────────────────

  /**
   * The transport reports a write was QUEUED (`cleared: false`) or settled.
   *
   * Begin: every read in flight was launched against pre-write content, so its
   * reply must not be applied. Pages lose `validated` (they stay paintable,
   * labelled stale) and pending reads are marked for a single re-issue.
   * Clear: those reads are re-issued once, at foreground priority.
   */
  onBarrier(epoch: number, cleared: boolean): void {
    if (cleared) {
      if (this.barrierEpoch === null) return;
      this.barrierEpoch = null;
      // Reads still in flight never answered yet: re-issue them from their own
      // parameters (a discard was already recorded at reply time).
      for (const pending of [...this.pendingById.values()]) {
        if (!pending.discardApply || pending.reissued) continue;
        pending.reissued = true;
        this.detachPending(pending);
        this.startRead(decodeScope(pending.scopeKey), pending.sessionId, {
          mode: pending.mode === "older" ? "older" : "refresh",
          priority: "foreground",
          cursor: pending.cursor,
          ifRevision: pending.ifRevision,
          snapshot: pending.snapshot,
          pageIndex: pending.pageIndex, replayTarget: pending.replayTarget, direction: pending.direction,
        });
      }
      // Reads whose (pre-write) reply already arrived: re-issue them now.
      const lost = this.discarded.splice(0);
      for (const entry of lost) {
        const sessionKey = sessionKeyOf(entry.scope, entry.sessionId);
        if (this.pendingBySession.has(sessionKey) || !this.subscribers.has(sessionKey)) continue;
        this.startRead(entry.scope, entry.sessionId, {
          mode: entry.mode === "older" ? "older" : entry.mode === "refresh" ? "refresh" : "head",
          priority: "foreground",
          cursor: entry.cursor,
          ifRevision: entry.ifRevision,
          snapshot: entry.snapshot,
          pageIndex: entry.pageIndex, replayTarget: entry.replayTarget, direction: entry.direction,
        });
      }
      return;
    }
    this.epoch = Math.max(this.epoch, epoch);
    this.barrierEpoch = epoch;
    for (const pending of this.pendingById.values()) pending.discardApply = true;
    for (const [sessionKey, view] of [...this.views]) {
      this.views.set(sessionKey, { ...view, stale: true });
    }
    for (const keys of this.pageKeys.values()) {
      for (const key of keys) this.cache.markUnvalidated(key);
    }
  }

  /** Highest epoch this controller has observed. */
  get writeEpoch(): number {
    return this.epoch;
  }

  /** Reconnect / new generation: nothing cached is attributable to it. */
  invalidateAll(): void {
    for (const pending of [...this.pendingById.values()]) this.detachPending(pending);
    for (const body of [...this.bodies.values()]) this.finishBody(body, { ok: false, code: "transport", detail: "reconnected" });
    for (const timer of this.retryTimers.values()) this.clock.clearTimeout(timer);
    this.retryTimers.clear();
    this.discarded.length = 0;
    this.buildingRetries.clear();
    this.staleReopens.clear();
    this.views.clear();
    this.pageKeys.clear();
    this.windows.clear();
    this.composedPages.clear();
    this.subscribers.clear();
    this.bodyFailures.clear();
    this.cache.clear();
    this.listCache.clear();
    this.barrierEpoch = null;
    this.epoch = 0;
  }

  /** One workspace was deleted/switched away: drop its pages and interests. */
  invalidateScope(scope: HistoryScope): void {
    const scopeKey = scopeKeyOf(scope);
    this.releaseScope(scope);
    this.cache.invalidateScope(scopeKey);
    this.listCache.invalidateScope(scopeKey);
    const prefix = `${scopeKey}${SEP}`;
    for (const key of [...this.views.keys()]) if (key.startsWith(prefix)) this.views.delete(key);
    for (const key of [...this.pageKeys.keys()]) if (key.startsWith(prefix)) this.releaseView(key);
    for (const [key] of [...this.bodyFailures]) if (key.startsWith(prefix)) this.bodyFailures.delete(key);
    this.notifyScope(scopeKey);
  }

  /** A session was deleted, replaced or resumed: its transcript is gone. */
  invalidateSession(scope: HistoryScope, sessionId: string): void {
    const sessionKey = sessionKeyOf(scope, sessionId);
    const pending = this.pendingBySession.get(sessionKey);
    if (pending !== undefined) this.detachPending(pending);
    this.cache.invalidateSession(scopeKeyOf(scope), sessionId);
    this.buildingRetries.delete(sessionKey);
    this.releaseView(sessionKey);
    this.subscribers.delete(sessionKey);
    this.emit(scopeKeyOf(scope), sessionId);
  }

  // ── reply routing ────────────────────────────────────────────────────────

  /**
   * Route one inbound frame.
   *
   * Returns true when the frame belonged to this controller (even when it was
   * discarded), so the container can keep it away from the legacy dispatcher.
   */
  onFrame(msg: unknown): boolean {
    if (typeof msg !== "object" || msg === null) return false;
    const type = (msg as { type?: unknown }).type;
    if (!isHistoryReplyType(type) || type === "history_list_ok") return false;
    const incomingId = requestIdOf(msg);
    if (incomingId !== null && this.pendingById.has(incomingId)) historyProbeMark("read", "received", incomingId);
    const parsed = parseHistoryReply(msg);
    const id = parsed.ok ? parsed.value.in_reply_to : requestIdOf(msg);
    if (id === null) return type !== "history_error";

    const body = this.bodies.get(id);
    if (body !== undefined) {
      this.settleBody(body, parsed);
      return true;
    }
    const pending = this.pendingById.get(id);
    /*
     * CLAIM RULE: a `history_read_ok` / `history_body_ok` is only ever produced by
     * a read or a body request, so it is ours even when the id is unknown (a late
     * answer). A `history_error` is ambiguous — the list controller answers the
     * same frame kind — so it is claimed ONLY when this controller owns the id.
     */
    if (pending === undefined) {
      if (type === "history_error") return false;
      // Unknown/duplicate/late: counted, never applied.
      this.metrics({ ...emptyMetrics("read_late_or_unknown", id), cache_hit: false });
      return true;
    }
    if (!parsed.ok) {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: parsed.detail });
      return true;
    }
    const reply = parsed.value;
    if (reply.type === "history_error") {
      /*
       * `not_modified` is a SUCCESS for a conditional read: it proves the cached
       * page is still current. It must NOT surface as a failure, and it must not
       * re-render content — only the stale label comes off.
       */
      if (reply.code === "not_modified") {
        this.settleNotModified(pending, reply.revision);
        return true;
      }
      this.settleFailure(pending, failureOfErrorFrame(reply));
      return true;
    }
    if (reply.type !== "history_read_ok") {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: "non-read reply for read id" });
      return true;
    }
    const scope = { host: pending.host, daemon_id: reply.daemon_id };
    if (!replyMatchesScope(reply, scope) || reply.daemon_id !== pending.daemonId) {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: "reply scope mismatch" });
      return true;
    }
    if (reply.session_id !== pending.sessionId) {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: "reply session mismatch" });
      return true;
    }
    historyProbeMark("read", "decoded", pending.id, reply.items.length, pending.replayTarget !== null && pending.pageIndex < pending.replayTarget);
    this.settleRead(pending, reply);
    return true;
  }

  // ── body ─────────────────────────────────────────────────────────────────

  /**
   * Materialize one `body_ref`.
   *
   * The caller decides preview vs full: `preview` returns the bounded preview the
   * wire item already carries (no request at all), `full` walks the 64 KiB
   * chunks. `body_too_large` is a typed failure, never a truncated success.
   */
  loadBody(
    scope: HistoryScope,
    sessionId: string,
    input: { snapshot: string; ref: HistoryBodyRef; mode: "preview" | "full" },
  ): Promise<BodyResult> {
    if (input.mode === "preview") {
      if (input.ref.preview === null) {
        return Promise.resolve({ ok: false, code: "unsupported", detail: "no wire preview for this ref" });
      }
      return Promise.resolve({ ok: true, representation: input.ref.representation, text: input.ref.preview, bytes: null });
    }
    const identity = `${sessionKeyOf(scope, sessionId)}${SEP}${bodyRefIdentity(input.ref)}`;
    const existing = this.bodyByIdentity.get(identity);
    if (existing !== undefined) return this.awaitBody(existing);

    const id = this.ports.makeId();
    const body: BodyRequest = {
      id,
      identity,
      daemonId: scope.daemon_id,
      sessionId,
      snapshot: input.snapshot,
      ref: input.ref.ref,
      assembler: new HistoryBodyAssembler({
        representation: input.ref.representation,
        mime: input.ref.mime,
        totalBytes: input.ref.total_bytes,
      }),
      timer: null,
      waiters: [],
    };
    this.bodies.set(id, body);
    this.bodyByIdentity.set(identity, body);
    body.timer = this.clock.setTimeout(() => {
      this.finishBody(body, { ok: false, code: "timeout", detail: "body chunk timed out" });
    }, this.bodyTimeoutMs);
    this.ports.sendBody(
      historyBodyRequest(id, scope.daemon_id, sessionId, input.snapshot, input.ref.ref, 0),
      "foreground",
    );
    return this.awaitBody(body);
  }

  /** Last typed body failure for one ref, for the UI to render. */
  bodyFailure(scope: HistoryScope, sessionId: string, ref: HistoryBodyRef): HistoryFailure | null {
    return this.bodyFailures.get(`${sessionKeyOf(scope, sessionId)}${SEP}${bodyRefIdentity(ref)}`) ?? null;
  }

  // ── internals: reads ─────────────────────────────────────────────────────

  private startRead(
    scope: HistoryScope,
    sessionId: string,
    options: {
      mode: "head" | "refresh" | "older";
      priority: HistoryPriority;
      cursor: string;
      ifRevision: string | null;
      /**
       * Opaque snapshot this read is bound to.
       *
       * `""` for `head` and every `refresh`: they must discover the NEWEST
       * sequence, so neither a snapshot nor a `before` cursor goes out. Only
       * `older` (and body chunks) carry a snapshot, because only they continue
       * an already-loaded sequence.
       */
      snapshot: string;
      pageIndex?: number;
      replayTarget?: number | null;
      direction?: "older" | "newer";
    },
  ): void {
    const sessionKey = sessionKeyOf(scope, sessionId);
    if (this.pendingBySession.has(sessionKey)) return;
    const scopeKey = scopeKeyOf(scope);
    const id = this.ports.makeId();
    const now = this.clock.now();
    // A programmatic read (a scheduled retry) has no subscriber: give it its own
    // token so `leave` from an unrelated viewer cannot orphan it.
    if ((this.subscribers.get(sessionKey)?.size ?? 0) === 0) {
      this.interestFor(sessionKey).set("controller", { priority: options.priority });
    }
    const pending: PendingRead = {
      id,
      host: scope.host,
      daemonId: scope.daemon_id,
      scopeKey,
      sessionKey,
      sessionId,
      mode: options.mode,
      priority: options.priority,
      cursor: options.cursor,
      epoch: this.epoch,
      sentEpoch: this.epoch,
      startedAt: now,
      sentAt: now,
      timer: null,
      discardApply: this.barrierEpoch !== null,
      reissued: false,
      ifRevision: options.ifRevision,
      snapshot: options.snapshot,
      pageIndex: options.pageIndex ?? (options.mode === "older" ? (this.views.get(sessionKey)?.page_end ?? 0) + 1 : 0),
      replayTarget: options.replayTarget ?? null,
      direction: options.direction ?? "older",
    };
    this.pendingById.set(id, pending);
    this.pendingBySession.set(sessionKey, pending);
    this.recompose(scopeKey, sessionId, {
      loading: (this.views.get(sessionKey)?.items.length ?? 0) === 0 && options.mode !== "older",
      loadingOlder: options.mode === "older" && pending.direction === "older",
      loadingNewer: pending.direction === "newer",
      failure: null,
    });

    this.emit(scopeKey, sessionId);
    pending.timer = this.clock.setTimeout(() => {
      if (this.pendingById.get(id) !== pending) return;
      this.settleFailure(pending, { ok: false, code: "timeout", detail: "read timed out" });
    }, this.readTimeoutMs);

    historyProbeMark("read", "request", id, 0, pending.replayTarget !== null && pending.pageIndex < pending.replayTarget);
    this.ports.sendRead(
      historyReadRequest(id, scope.daemon_id, sessionId, {
        limit: this.readLimit,
        before: options.cursor === "" ? null : options.cursor,
        // HEAD/REFRESH send no snapshot: the host derives the boundary from the
        // CURRENT row water, which is what makes an appended turn visible. An
        // OLDER page sends back the snapshot it began at (never a newer
        // revision), so the host serves it from the SAME generation or answers
        // `stale` and the client reopens deliberately.
        snapshot: options.snapshot === "" ? null : options.snapshot,
        ifRevision: options.ifRevision,
      }),
      pending.priority,
    );
    pending.sentAt = this.clock.now();
    pending.sentEpoch = this.epoch;
  }

  /**
   * The host confirmed the cached revision.
   *
   * The page is marked validated, the stale label is dropped and NOTHING else
   * changes — that is the whole point of a conditional read: zero content bytes,
   * zero re-render of the transcript.
   */
  private settleNotModified(pending: PendingRead, revision: string | null): void {
    const receivedAt = this.clock.now();
    if (!this.pendingById.has(pending.id)) return;
    this.detachPending(pending);
    const keys = this.pageKeys.get(pending.sessionKey) ?? [];
    for (const key of keys) this.cache.validate(key, revision ?? this.cache.get(key)?.page.revision ?? "");
    this.recompose(pending.scopeKey, pending.sessionId, {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      failure: null,
      building: false,
    });
    this.emit(pending.scopeKey, pending.sessionId);
    this.metrics({
      ...emptyMetrics("read_not_modified", pending.id),
      wire_ms: Math.max(0, receivedAt - pending.sentAt),
      queue_ms: Math.max(0, pending.sentAt - pending.startedAt),
      read_bytes: 0,
      parsed_entries: 0,
      cache_hit: true,
      apply_ms: 0,
    });
  }

  private settleFailure(pending: PendingRead, failure: HistoryFailure): void {
    const receivedAt = this.clock.now();
    if (!this.pendingById.has(pending.id)) return;
    this.detachPending(pending);
    const retriable = failure.code === "building" && !this.buildingRetries.has(pending.sessionKey);
    if (failure.code === "stale") {
      // The generation this page belongs to no longer exists. Drop everything
      // cached for the session and reopen ONCE from a fresh head read; never
      // splice the old pages into the new generation.
      this.reopenAfterStale(pending);
      return;
    }
    this.recompose(pending.scopeKey, pending.sessionId, {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      building: failure.code === "building" && retriable,
      failure: retriable ? null : failure,
    });
    if (retriable) this.scheduleBuildingRetry(pending);
    this.metrics({
      ...emptyMetrics(`read_${failure.code}`, pending.id),
      wire_ms: Math.max(0, receivedAt - pending.sentAt),
      queue_ms: Math.max(0, pending.sentAt - pending.startedAt),
      cache_hit: false,
    });
    this.emit(pending.scopeKey, pending.sessionId);
  }

  private settleRead(pending: PendingRead, reply: HistoryReadOk): void {
    const receivedAt = this.clock.now();
    if (!this.pendingById.has(pending.id)) return;
    this.detachPending(pending);

    if (pending.discardApply || pending.epoch !== this.epoch || pending.sentEpoch !== this.epoch) {
      // A write was queued after this read was launched: its content predates
      // the write, so it is not applied. The barrier clear re-issues it — and it
      // is RECORDED here, because the pending entry dies with this reply.
      if (!pending.reissued) {
        this.discarded.push({
          scope: { host: pending.host, daemon_id: pending.daemonId },
          sessionId: pending.sessionId,
          mode: pending.mode,
          cursor: pending.cursor,
          ifRevision: pending.ifRevision,
          snapshot: pending.snapshot,
          pageIndex: pending.pageIndex, replayTarget: pending.replayTarget, direction: pending.direction,
        });
        pending.reissued = true;
      }
      this.recompose(pending.scopeKey, pending.sessionId, { loading: false, loadingOlder: false });
      this.metrics({
        ...emptyMetrics("read_discarded_epoch", pending.id),
        wire_ms: Math.max(0, receivedAt - pending.sentAt),
        cache_hit: false,
      });
      this.emit(pending.scopeKey, pending.sessionId);
      return;
    }

    /*
     * GENERATION FENCE for paged reads.
     *
     * The opaque cursor is bound to a snapshot server-side, so a mismatch means the
     * session was rewritten/replaced between the open page and this older page.
     * Merging them would splice two generations; the only safe move is the same
     * deliberate reopen a `stale` error triggers.
     */
    if (pending.mode === "older" && pending.snapshot !== "" && reply.snapshot !== pending.snapshot) {
      this.reopenAfterStale(pending);
      return;
    }

    if (pending.replayTarget !== null && pending.pageIndex < pending.replayTarget) {
      if (reply.has_older && reply.older_cursor !== null) {
        this.remember(pending.sessionKey, pending.pageIndex + 1, reply.older_cursor);
        this.startRead({ host: pending.host, daemon_id: pending.daemonId }, pending.sessionId, {
          mode: "older", priority: "foreground", cursor: reply.older_cursor,
          snapshot: pending.snapshot, ifRevision: null, pageIndex: pending.pageIndex + 1,
          replayTarget: pending.replayTarget, direction: "newer",
        });
      } else {
        this.recompose(pending.scopeKey, pending.sessionId, { loadingOlder: false, loadingNewer: false,
          failure: { ok: false, code: "stale", detail: "checkpoint no longer reaches requested page" } });
        this.emit(pending.scopeKey, pending.sessionId);
      }
      return;
    }

    const applyStarted = this.clock.now();
    const pageKey = historyPageKey({
      host: pending.host,
      daemon_id: pending.daemonId,
      session_id: pending.sessionId,
      snapshot: reply.snapshot,
      projection: reply.projection,
      cursor: pending.cursor,
    });
    if (pending.mode === "refresh") {
      // The conditional read answered with content: anything cached under a
      // different revision for this session describes text that no longer exists.
      this.cache.invalidateRevision(pending.scopeKey, pending.sessionId, reply.revision);
      const keys = this.pageKeys.get(pending.sessionKey) ?? [];
      for (const key of keys) {
        if (key !== pageKey && key.endsWith(`${SEP}${pending.cursor}`)) {
          this.cache.drop(key);
          this.pageKeys.set(
            pending.sessionKey,
            (this.pageKeys.get(pending.sessionKey) ?? []).filter((entry) => entry !== key),
          );
        }
      }
    }

    const stored = this.cache.put({
      key: pageKey,
      scope: pending.scopeKey,
      sessionKey: pending.sessionKey,
      session_id: pending.sessionId,
      snapshot: reply.snapshot,
      projection: reply.projection,
      cursor: pending.cursor,
      revision: reply.revision,
      items: reply.items,
      older_cursor: reply.older_cursor,
      has_older: reply.has_older,
      has_partial: reply.items.some((item) => item.truncated === true),
      validated: true,
    });

    if (stored === null) {
      this.recompose(pending.scopeKey, pending.sessionId, { loading: false, loadingOlder: false, loadingNewer: false,
        failure: { ok: false, code: "unsupported", detail: "page exceeds resident cache budget" } });
      this.emit(pending.scopeKey, pending.sessionId);
      return;
    }
    if (pending.mode !== "older") {
      this.cache.invalidateSnapshot(pending.scopeKey, pending.sessionId, reply.snapshot);
      this.windows.delete(pending.sessionKey);
      this.pageKeys.set(pending.sessionKey, []);
    } else if (pending.direction === "newer") {
      // A newer-page visit replaces the window so its requested content is
      // immediately visible. Page positions disclose the change; no gap or
      // hidden content archive is presented as one scrollable transcript.
      this.pageKeys.set(pending.sessionKey, []);
      this.windowFor(pending.sessionKey).indices.clear();
    }
    this.adopt(stored, pending.pageIndex, pending.direction);
    if (pending.mode !== "older") this.buildingRetries.delete(pending.sessionKey);
    if (reply.older_cursor !== null) this.remember(pending.sessionKey, pending.pageIndex + 1, reply.older_cursor);
    this.sweepOwnership(pending.sessionKey);
    /*
     * An OLDER page is appended to the generation the reader opened; it must not
     * redefine that generation. Only a head/refresh reply may publish the view's
     * snapshot/revision.
     */
    this.recompose(pending.scopeKey, pending.sessionId, {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      failure: null,
      building: false,
      ...(pending.mode === "older"
        ? {}
        : { snapshot: reply.snapshot, revision: reply.revision, projection: reply.projection }),
      content_version: (this.views.get(pending.sessionKey)?.content_version ?? 0) + 1,
    });
    historyProbeMark("read", "applied", pending.id, reply.items.length);
    historyProbeMark("read", "full-page", pending.id, reply.items.length);
    if (pending.mode !== "older") {
      // A successful head/refresh page proves the generation is readable again.
      this.staleReopens.delete(pending.sessionKey);
    }
    this.metrics({
      ...emptyMetrics(pending.mode === "older" ? "read_older" : pending.mode === "refresh" ? "read_refresh" : "read", pending.id),
      wire_ms: Math.max(0, receivedAt - pending.sentAt),
      queue_ms: Math.max(0, pending.sentAt - pending.startedAt),
      read_bytes: stored.bytes,
      parsed_entries: reply.items.length,
      cache_hit: false,
      apply_ms: Math.max(0, this.clock.now() - applyStarted),
      first_content_ms: Math.max(0, this.clock.now() - pending.startedAt),
    });
    this.emit(pending.scopeKey, pending.sessionId);
  }

  /**
   * Reopen a session after `stale` (or after a page from another generation).
   *
   * ONE deliberate reopen per generation: the cached pages are dropped whole (a
   * cumulative item list built from two generations is exactly the splice the plan
   * forbids), a fresh head read goes out, and a SECOND stale in a row becomes the
   * typed failure the surface renders — never an unbounded retry.
   */
  private reopenAfterStale(pending: PendingRead): void {
    const used = this.staleReopens.get(pending.sessionKey) ?? 0;
    this.cache.invalidateSession(pending.scopeKey, pending.sessionId);
    this.pageKeys.delete(pending.sessionKey);
    this.releaseView(pending.sessionKey);
    if (used >= 1) {
      this.staleReopens.delete(pending.sessionKey);
      this.recompose(pending.scopeKey, pending.sessionId, {
        loading: false,
        loadingOlder: false,
      loadingNewer: false,
        failure: { ok: false, code: "stale", detail: "stale after one deliberate reopen" },
      });
      this.metrics({ ...emptyMetrics("read_stale_reopen_exhausted", pending.id), cache_hit: false });
      this.emit(pending.scopeKey, pending.sessionId);
      return;
    }
    this.staleReopens.set(pending.sessionKey, used + 1);
    this.metrics({ ...emptyMetrics("read_stale_reopen", pending.id), cache_hit: false });
    if (this.pendingBySession.has(pending.sessionKey)) return;
    this.startRead({ host: pending.host, daemon_id: pending.daemonId }, pending.sessionId, {
      mode: "head",
      priority: "foreground",
      cursor: "",
      ifRevision: null,
      snapshot: "",
    });
  }

  /** `building`: ONE retry of the same request, never a busy loop. */
  private scheduleBuildingRetry(pending: PendingRead): void {
    const sessionKey = pending.sessionKey;
    if (this.retryTimers.has(sessionKey) || this.buildingRetries.has(sessionKey)) return;
    this.buildingRetries.add(sessionKey);
    const timer = this.clock.setTimeout(() => {
      this.retryTimers.delete(sessionKey);
      if (!this.subscribers.has(sessionKey)) return;
      if (this.pendingBySession.has(sessionKey)) return;
      this.startRead({ host: pending.host, daemon_id: pending.daemonId }, pending.sessionId, {
        mode: "head",
        priority: "foreground",
        cursor: "",
        ifRevision: null,
        snapshot: "",
      });
    }, 25);
    this.retryTimers.set(sessionKey, timer);
  }

  private promotePending(pending: PendingRead, priority: HistoryPriority): void {
    if (PRIORITY_RANK[priority] >= PRIORITY_RANK[pending.priority]) return;
    pending.priority = priority;
    // If the frame is still QUEUED in the transport lane, it moves ahead of any
    // prefetch. If it already went out, this is a no-op — and that is fine: the
    // click still joined the SAME request instead of minting a second one.
    this.ports.reprioritize?.(pending.id, priority);
  }

  private detachPending(pending: PendingRead): void {
    if (pending.timer !== null) {
      this.clock.clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.pendingById.delete(pending.id);
    if (this.pendingBySession.get(pending.sessionKey) === pending) {
      this.pendingBySession.delete(pending.sessionKey);
    }
  }

  private windowFor(sessionKey: string): ReadingWindow {
    let window = this.windows.get(sessionKey);
    if (window === undefined) {
      window = { indices: new Map(), checkpoints: new Map() };
      this.windows.set(sessionKey, window);
    }
    return window;
  }

  private remember(sessionKey: string, index: number, cursor: string): void {
    const points = this.windowFor(sessionKey).checkpoints;
    points.delete(index);
    points.set(index, cursor);
    while (points.size > HISTORY_CHECKPOINT_MAX_ENTRIES) {
      const victim = [...points.keys()].find(at => at !== 1);
      if (victim === undefined) break;
      points.delete(victim);
    }
  }

  private adopt(page: HistoryPage, index = 0, direction: "older" | "newer" = "older"): void {
    const window = this.windowFor(page.sessionKey);
    window.indices.set(page.key, index);
    let keys = this.pageKeys.get(page.sessionKey) ?? [];
    if (!keys.includes(page.key)) keys = [...keys, page.key];
    keys.sort((a, b) => (window.indices.get(a) ?? 0) - (window.indices.get(b) ?? 0));
    while (keys.length > HISTORY_RESIDENT_MAX_PAGES) {
      const victim = direction === "older" ? keys.shift()! : keys.pop()!;
      window.indices.delete(victim);
    }
    this.pageKeys.set(page.sessionKey, keys);
    if (page.cursor !== "") this.remember(page.sessionKey, index, page.cursor);
    if (page.older_cursor !== null) this.remember(page.sessionKey, index + 1, page.older_cursor);
  }

  private releaseView(sessionKey: string): void {
    this.views.delete(sessionKey);
    this.pageKeys.delete(sessionKey);
    this.windows.delete(sessionKey);
    this.composedPages.delete(sessionKey);
  }

  /** Propagate cache eviction to every derived owner. */
  private sweepOwnership(current?: string): void {
    for (const [sessionKey, keys] of this.pageKeys) {
      const resident = keys.filter(key => this.cache.get(key) !== null);
      if (resident.length === keys.length) continue;
      this.pageKeys.set(sessionKey, resident);
      const indices = this.windows.get(sessionKey)?.indices;
      for (const key of keys) if (!resident.includes(key)) indices?.delete(key);
      if (sessionKey === current) continue;
      if (resident.length === 0 && !this.pendingBySession.has(sessionKey)) this.releaseView(sessionKey);
      else {
        const view = this.views.get(sessionKey);
        if (view) this.recompose(view.scope, view.session_id, {});
      }
    }
  }

  /**
   * Rebuild the view from the cached pages.
   *
   * The page list is head-first; rendering is oldest-first, so it is walked in
   * reverse and merged by `event_id`. `older_cursor`/`has_older` come from the
   * OLDEST loaded page — the one that owns the next cursor.
   */
  private recompose(
    scopeKey: string,
    sessionId: string,
    patch: Partial<Pick<HistoryView, "loading" | "loadingOlder" | "loadingNewer" | "content_version" | "failure" | "building" | "snapshot" | "revision" | "projection">>,
  ): void {
    const sessionKey = `${scopeKey}${SEP}${sessionId}`;
    const previous = this.views.get(sessionKey);
    const keys = this.pageKeys.get(sessionKey) ?? [];
    const pages = keys
      .map((key) => this.cache.get(key)?.page ?? null)
      .filter((page): page is HistoryPage => page !== null);
    const composed = this.composedPages.get(sessionKey);
    const unchanged = previous !== undefined && composed?.length === pages.length && pages.every((page, at) => composed[at] === page);
    const items = unchanged ? previous.items : mergeHistoryPages([...pages].reverse().map(page => page.items));
    this.composedPages.set(sessionKey, pages);
    const oldest = pages[pages.length - 1] ?? null;
    const head = pages[0] ?? null;
    const view: HistoryView = {
      scope: scopeKey,
      session_id: sessionId,
      items,
      older_cursor: oldest?.older_cursor ?? null,
      has_older: oldest?.has_older ?? false,
      snapshot: patch.snapshot ?? head?.snapshot ?? previous?.snapshot ?? "",
      revision: patch.revision ?? head?.revision ?? previous?.revision ?? "",
      projection: patch.projection ?? head?.projection ?? previous?.projection ?? 0,
      loading: patch.loading ?? previous?.loading ?? false,
      stale: pages.length === 0 ? false : pages.some((page) => !page.validated),
      loadingOlder: patch.loadingOlder ?? previous?.loadingOlder ?? false,
      failure: patch.failure !== undefined ? patch.failure : (previous?.failure ?? null),
      partial: unchanged ? previous.partial : items.some((item) => item.truncated === true),
      building: patch.building ?? previous?.building ?? false,
      version: (previous?.version ?? 0) + 1,
      page_start: this.windows.get(sessionKey)?.indices.get(keys[0] ?? "") ?? 0,
      page_end: this.windows.get(sessionKey)?.indices.get(keys.at(-1) ?? "") ?? 0,
      resident_pages: pages.length,
      has_newer: (this.windows.get(sessionKey)?.indices.get(keys[0] ?? "") ?? 0) > 0,
      loadingNewer: patch.loadingNewer ?? previous?.loadingNewer ?? false,
      content_version: patch.content_version ?? previous?.content_version ?? 0,
    };
    this.views.set(sessionKey, view);
  }

  // ── internals: body plumbing ──────────────────────────────────────────────

  private awaitBody(body: BodyRequest): Promise<BodyResult> {
    return new Promise<BodyResult>((resolve) => {
      body.waiters.push(resolve);
    });
  }

  private settleBody(body: BodyRequest, parsed: ReturnType<typeof parseHistoryReply>): void {
    if (!parsed.ok) {
      this.finishBody(body, { ok: false, code: "malformed", detail: parsed.detail });
      return;
    }
    const reply = parsed.value;
    if (reply.type === "history_error") {
      this.finishBody(body, failureOfErrorFrame(reply));
      return;
    }
    if (reply.type !== "history_body_ok") {
      this.finishBody(body, { ok: false, code: "malformed", detail: "non-body reply for body id" });
      return;
    }
    if (reply.body_ref !== body.ref || reply.snapshot !== body.snapshot) {
      this.finishBody(body, { ok: false, code: "stale", detail: "body reply belongs to another snapshot" });
      return;
    }
    if (!body.assembler.push(reply)) {
      this.finishBody(body, { ok: false, code: "malformed", detail: "body chunk did not continue" });
      return;
    }
    if (!body.assembler.done) {
      if (body.timer !== null) this.clock.clearTimeout(body.timer);
      body.timer = this.clock.setTimeout(() => {
        this.finishBody(body, { ok: false, code: "timeout", detail: "body chunk timed out" });
      }, this.bodyTimeoutMs);
      this.ports.sendBody(
        historyBodyRequest(body.id, body.daemonId, body.sessionId, body.snapshot, body.ref, body.assembler.offset),
        "foreground",
      );
      return;
    }
    const representation = body.assembler.representation;
    this.finishBody(body, {
      ok: true,
      representation,
      text: representation === "binary" ? null : body.assembler.textValue(),
      bytes: representation === "binary" ? body.assembler.binaryValue() : null,
    });
  }

  private finishBody(body: BodyRequest, result: BodyResult): void {
    if (body.timer !== null) this.clock.clearTimeout(body.timer);
    body.timer = null;
    this.bodies.delete(body.id);
    this.bodyByIdentity.delete(body.identity);
    if (!result.ok) {
      this.bodyFailures.set(`${body.identity}`, result);
    } else {
      this.bodyFailures.delete(body.identity);
    }
    const waiters = body.waiters.splice(0);
    for (const resolve of waiters) resolve(result);
  }

  // ── internals: metrics/notify ─────────────────────────────────────────────

  private metrics(sample: HistoryMetricsSample): void {
    this.ports.metrics?.(sanitizeMetrics(sample));
  }

  private emit(scopeKey: string, sessionId: string): void {
    for (const listener of [...this.listeners]) listener(scopeKey, sessionId);
  }

  private notifyScope(scopeKey: string): void {
    for (const sessionKey of [...this.views.keys()]) {
      if (!sessionKey.startsWith(`${scopeKey}${SEP}`)) continue;
      this.emit(scopeKey, sessionKey.slice(scopeKey.length + 1));
    }
  }

  private interestFor(sessionKey: string): Map<string, Subscriber> {
    let map = this.subscribers.get(sessionKey);
    if (map === undefined) {
      map = new Map();
      this.subscribers.set(sessionKey, map);
    }
    return map;
  }
}

function scopeKeyOf(scope: HistoryScope): string {
  return historyScopeKey(scope.host, scope.daemon_id);
}

function sessionKeyOf(scope: HistoryScope, sessionId: string): string {
  return historySessionKey(scopeKeyOf(scope), sessionId);
}

function requestIdOf(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const value = (msg as { in_reply_to?: unknown }).in_reply_to;
  return typeof value === "string" && value !== "" ? value : null;
}

