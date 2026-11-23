/**
 * Plan 86 P3 — the workspace session LIST on the host-native path.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TRANSCRIPT CONTROLLER
 *
 * The list and a transcript have different lifetimes and different failure
 * meanings: a list is invalidated by a revision change or a new session, a
 * transcript by a snapshot/rewrite. Sharing one request slot meant a slow
 * transcript could block the sidebar, and sharing one cache budget meant a giant
 * transcript could evict the rows the sidebar was painting from.
 *
 * WHAT IT ADDS OVER `session_list`
 *
 * `session_list` is proxied to the workspace Pi, so it cannot answer while that
 * Pi is stopped, starting or respawning — measured 416–542 ms of pure queueing
 * behind an unrelated POST, and nothing at all when the Pi is down. The host
 * answers `history_list` from its own index with zero Pi processes, keyed by
 * `daemon_id`, so the sidebar no longer depends on a running agent.
 *
 * The `current` block is the host's INDEPENDENT runtime snapshot. It is rendered
 * honestly: `session_id: null` / `ready: null` / `source: "unknown"` means the
 * host has no runtime authority for this workspace, and the UI must show no LIVE
 * badge rather than guessing from the newest file on disk.
 */

import { historyProbeMark } from "./history-probe.ts";
import {
  emptyMetrics,
  failureOfErrorFrame,
  historyListRequest,
  isHistoryReplyType,
  parseHistoryReply,
  type HistoryCurrent,
  type HistoryFailure,
  type HistoryIndexState,
  type HistoryListOk,
  type HistoryMetricsSample,
  type HistoryScope,
  type HistorySessionRow,
} from "./history.ts";
import { historyScopeKey, type HistoryListCache } from "./history-cache.ts";

export type ListPriority = "foreground" | "prefetch";

export interface HistoryListView {
  scope: string;
  rows: readonly HistorySessionRow[];
  revision: string | null;
  index_state: HistoryIndexState;
  current: HistoryCurrent | null;
  next_cursor: string | null;
  has_more: boolean;
  loading: boolean;
  loadingMore: boolean;
  /** Painted from cache; a live reply has not confirmed it yet. */
  stale: boolean;
  failure: HistoryFailure | null;
  retry_after_ms: number | null;
  version: number;
  page_start: number;
  page_end: number;
}

export interface HistoryListClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface HistoryListPorts {
  sendList: (request: ReturnType<typeof historyListRequest>, priority: ListPriority) => void;
  makeId: () => string;
  metrics?: (sample: HistoryMetricsSample) => void;
}

export interface HistoryListOptions {
  cache: HistoryListCache;
  ports: HistoryListPorts;
  clock?: HistoryListClock;
  listTimeoutMs?: number;
  limit?: number;
}

interface PendingList {
  id: string;
  scopeKey: string;
  scope: HistoryScope;
  cursor: string;
  mode: "first" | "more" | "refresh";
  priority: ListPriority;
  startedAt: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Revision this refresh is validating (conditional read). */
  ifRevision: string | null;
}

const SYSTEM_CLOCK: HistoryListClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const BUILDING_RETRY_BUDGET_MS = 30_000;
const BUILDING_RETRY_BASE_MS = 25;
const BUILDING_RETRY_MAX_DELAY_MS = 1_000;
const BUILDING_RETRY_MAX_ATTEMPTS = 64;

interface BuildingRetryState {
  startedAt: number;
  attempts: number;
}

/** One controller per connection generation (see HistoryQueryController). */
export class HistoryListController {
  private readonly cache: HistoryListCache;
  private readonly ports: HistoryListPorts;
  private readonly clock: HistoryListClock;
  private readonly listTimeoutMs: number;
  private readonly limit: number;

  private readonly pending = new Map<string, PendingList>();
  private readonly views = new Map<string, HistoryListView>();
  private readonly residentCursors = new Map<string, string[]>();
  private readonly listeners = new Set<(scopeKey: string) => void>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly buildingRetries = new Map<string, BuildingRetryState>();

  constructor(options: HistoryListOptions) {
    this.cache = options.cache;
    this.ports = options.ports;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.listTimeoutMs = options.listTimeoutMs ?? 8_000;
    this.limit = options.limit ?? 50;
  }

  subscribe(listener: (scopeKey: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(scope: HistoryScope): HistoryListView | null {
    return this.views.get(historyScopeKey(scope.host, scope.daemon_id)) ?? null;
  }

  diagnostics(): Record<string, number> {
    return { cacheBytes: this.cache.bytes, cachePages: this.cache.size, viewScopes: this.views.size,
      viewRows: [...this.views.values()].reduce((n, view) => n + view.rows.length, 0),
      residentPages: [...this.residentCursors.values()].reduce((n, keys) => n + keys.length, 0) };
  }

  /** View projection has no ownership after the workspace leaves the screen. */
  releaseScope(scope: HistoryScope): void {
    const key = historyScopeKey(scope.host, scope.daemon_id);
    const pending = this.pending.get(key);
    if (pending) this.detach(pending);
    this.resetBuildingRetry(key);
    this.views.delete(key);
    this.residentCursors.delete(key);
  }

  /**
   * Open a workspace's list.
   *
   * Cache-first: a cached page paints immediately (labelled stale unless a live
   * reply already confirmed it), and only an unvalidated page pays for one
   * conditional `history_list` (`if_revision`).
   */
  open(scope: HistoryScope, options: { priority?: ListPriority } = {}): void {
    const scopeKey = historyScopeKey(scope.host, scope.daemon_id);
    if (this.pending.has(scopeKey)) return;
    const cached = this.cache.get(scopeKey, "");
    if (cached !== null && this.views.get(scopeKey) === undefined) {
      this.residentCursors.set(scopeKey, [""]);
      this.paint(scopeKey, cached.page.rows, {
        page_start: 0, page_end: 0,
        revision: cached.page.revision,
        index_state: cached.page.index_state,
        current: null,
        next_cursor: cached.page.next_cursor,
        has_more: cached.page.has_more,
        stale: !cached.page.validated || cached.page.index_state === "building",
        loading: false,
        loadingMore: false,
        failure: null,
        retry_after_ms: null,
      });
      if (cached.page.validated && cached.page.index_state !== "building") return;
      this.send(scope, { mode: "refresh", cursor: "",
        ifRevision: cached.page.index_state === "building" ? null : cached.page.revision,
        priority: options.priority ?? "foreground" });
      return;
    }
    if (this.views.get(scopeKey) !== undefined) return;
    this.send(scope, { mode: "first", cursor: "", ifRevision: null, priority: options.priority ?? "foreground" });
  }

  /** Force a fresh first page (refresh button, a session create/switch). */
  refresh(scope: HistoryScope, options: { priority?: ListPriority } = {}): void {
    const scopeKey = historyScopeKey(scope.host, scope.daemon_id);
    const inFlight = this.pending.get(scopeKey);
    if (inFlight !== undefined) this.detach(inFlight);
    this.paint(scopeKey, this.views.get(scopeKey)?.rows ?? [], {
      loading: true,
      loadingMore: false,
      failure: null,
      retry_after_ms: null,
    });
    this.send(scope, {
      mode: "refresh",
      cursor: "",
      ifRevision: null,
      priority: options.priority ?? "foreground",
    });
  }

  /** Append the next page (a "load older sessions" control). */
  loadMore(scope: HistoryScope): void {
    const scopeKey = historyScopeKey(scope.host, scope.daemon_id);
    if (this.pending.has(scopeKey)) return;
    const view = this.views.get(scopeKey);
    if (view === undefined || !view.has_more || view.next_cursor === null) return;
    this.send(scope, { mode: "more", cursor: view.next_cursor, ifRevision: null, priority: "foreground" });
  }

  /** Route one inbound frame. Returns true when it belonged to this controller. */
  onFrame(msg: unknown): boolean {
    if (typeof msg !== "object" || msg === null) return false;
    const type = (msg as { type?: unknown }).type;
    if (!isHistoryReplyType(type)) return false;
    const incomingId = requestIdOf(msg);
    if (incomingId !== null && this.pendingById(incomingId)) historyProbeMark("list", "received", incomingId);
    const parsed = parseHistoryReply(msg);
    const id = parsed.ok ? parsed.value.in_reply_to : requestIdOf(msg);
    if (id === null) return true;
    const pending = this.pendingById(id);
    /*
     * CLAIM RULE: a `history_list_ok` is only ever produced by a list request, so
     * it is ours even when the id is unknown (a late answer). A `history_error`
     * is shared with the transcript controller, so it is claimed ONLY when this
     * controller owns the id.
     */
    if (pending === undefined) {
      if (type === "history_error") return false;
      this.metrics({ ...emptyMetrics("list_late_or_unknown", id), cache_hit: false });
      return true;
    }
    if (!parsed.ok) {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: parsed.detail });
      return true;
    }
    const reply = parsed.value;
    if (reply.type === "history_error") {
      this.settleFailure(pending, failureOfErrorFrame(reply));
      return true;
    }
    if (reply.type !== "history_list_ok") {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: "non-list reply for list id" });
      return true;
    }
    if (reply.daemon_id !== pending.scope.daemon_id) {
      this.settleFailure(pending, { ok: false, code: "malformed", detail: "reply scope mismatch" });
      return true;
    }
    historyProbeMark("list", "decoded", pending.id, reply.sessions.length);
    this.settleList(pending, reply);
    return true;
  }

  invalidateAll(): void {
    for (const pending of [...this.pending.values()]) this.detach(pending);
    for (const timer of this.retryTimers.values()) this.clock.clearTimeout(timer);
    this.retryTimers.clear();
    this.buildingRetries.clear();
    this.views.clear();
    this.residentCursors.clear();
    this.cache.clear();
  }

  invalidateScope(scope: HistoryScope): void {
    const scopeKey = historyScopeKey(scope.host, scope.daemon_id);
    this.resetBuildingRetry(scopeKey);
    const pending = this.pending.get(scopeKey);
    if (pending !== undefined) this.detach(pending);
    this.cache.invalidateScope(scopeKey);
    this.views.delete(scopeKey);
    this.residentCursors.delete(scopeKey);
    this.emit(scopeKey);
  }

  /** Drop ONE row locally (a confirmed deletion), without a re-list. */
  dropRow(scope: HistoryScope, sessionId: string): void {
    const scopeKey = historyScopeKey(scope.host, scope.daemon_id);
    const view = this.views.get(scopeKey);
    if (view === undefined) return;
    const rows = view.rows.filter((row) => row.id !== sessionId);
    if (rows.length === view.rows.length) return;
    this.cache.invalidateScope(scopeKey);
    this.paint(scopeKey, rows, { stale: true });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private send(
    scope: HistoryScope,
    options: { mode: PendingList["mode"]; cursor: string; ifRevision: string | null; priority: ListPriority; buildingRetry?: boolean },
  ): void {
    const scopeKey = historyScopeKey(scope.host, scope.daemon_id);
    if (options.buildingRetry !== true) this.resetBuildingRetry(scopeKey);
    const id = this.ports.makeId();
    const now = this.clock.now();
    const pending: PendingList = {
      id,
      scopeKey,
      scope,
      cursor: options.cursor,
      mode: options.mode,
      priority: options.priority,
      startedAt: now,
      sentAt: now,
      timer: null,
      ifRevision: options.ifRevision,
    };
    this.pending.set(scopeKey, pending);
    this.paint(scopeKey, this.views.get(scopeKey)?.rows ?? [], {
      loading: options.mode !== "more",
      loadingMore: options.mode === "more",
      failure: null,
      retry_after_ms: null,
    });
    pending.timer = this.clock.setTimeout(() => {
      if (this.pending.get(scopeKey) !== pending) return;
      this.settleFailure(pending, { ok: false, code: "timeout", detail: "list timed out" });
    }, this.listTimeoutMs);
    historyProbeMark("list", "request", id);
    this.ports.sendList(
      historyListRequest(id, scope.daemon_id, {
        limit: this.limit,
        before: options.cursor === "" ? null : options.cursor,
        ifRevision: options.ifRevision,
      }),
      options.priority,
    );
    pending.sentAt = this.clock.now();
  }

  private settleFailure(pending: PendingList, failure: HistoryFailure): void {
    if (this.pending.get(pending.scopeKey) !== pending) return;
    this.detach(pending);
    const retriable = failure.code === "building";
    const view = this.views.get(pending.scopeKey);
    this.paint(pending.scopeKey, view?.rows ?? [], {
      loading: false,
      loadingMore: false,
      failure: retriable ? null : failure,
      index_state: retriable ? "building" : (view?.index_state ?? "unavailable"),
      retry_after_ms: failure.retry_after_ms ?? null,
    });
    if (retriable) this.scheduleBuildingRetry(pending.scope, failure.retry_after_ms);
    else this.resetBuildingRetry(pending.scopeKey);
    this.metrics({
      ...emptyMetrics(`list_${failure.code}`, pending.id),
      wire_ms: Math.max(0, this.clock.now() - pending.sentAt),
      cache_hit: false,
    });
  }

  private settleList(pending: PendingList, reply: HistoryListOk): void {
    if (this.pending.get(pending.scopeKey) !== pending) return;
    this.detach(pending);
    const applyStarted = this.clock.now();
    const previous = this.views.get(pending.scopeKey);
    // Store only this reply's rows. Caching cumulative lists would duplicate
    // all earlier content once per page and bypass the list budget in views.
    const stored = this.cache.put({
      scope: pending.scopeKey, cursor: pending.cursor, revision: reply.revision,
      rows: reply.sessions, next_cursor: reply.next_cursor, has_more: reply.has_more,
      index_state: reply.index_state, validated: reply.index_state !== "building",
    });
    if (stored === null) {
      this.resetBuildingRetry(pending.scopeKey);
      this.paint(pending.scopeKey, previous?.rows ?? [], { loading: false, loadingMore: false,
        failure: { ok: false, code: "unsupported", detail: "list page exceeds resident cache budget" } });
      return;
    }
    let cursors = pending.mode === "more" ? [...(this.residentCursors.get(pending.scopeKey) ?? []), pending.cursor] : [pending.cursor];
    cursors = [...new Set(cursors)].slice(-4).filter(cursor => this.cache.get(pending.scopeKey, cursor) !== null);
    this.residentCursors.set(pending.scopeKey, cursors);
    const rows = appendRows([], cursors.flatMap(cursor => this.cache.get(pending.scopeKey, cursor)?.page.rows ?? []));
    // Eviction releases derived owners of OTHER workspace lists as well.
    for (const [scope, keys] of this.residentCursors) {
      if (scope === pending.scopeKey) continue;
      const kept = keys.filter(cursor => this.cache.get(scope, cursor) !== null);
      if (kept.length === keys.length) continue;
      if (kept.length === 0) { this.views.delete(scope); this.residentCursors.delete(scope); }
      else {
        this.residentCursors.set(scope, kept);
        this.paint(scope, appendRows([], kept.flatMap(cursor => this.cache.get(scope, cursor)?.page.rows ?? [])), {});
      }
    }
    const end = pending.mode === "more" ? (previous?.page_end ?? 0) + 1 : 0;
    this.paint(pending.scopeKey, rows, {
      page_start: Math.max(0, end - cursors.length + 1), page_end: end,
      revision: reply.revision,
      index_state: reply.index_state,
      current: reply.current,
      next_cursor: reply.next_cursor,
      has_more: reply.has_more,
      loading: false,
      loadingMore: false,
      stale: false,
      failure: null,
      retry_after_ms: reply.retry_after_ms,
    });
    historyProbeMark("list", "applied", pending.id, reply.sessions.length);
    historyProbeMark("list", "full-page", pending.id, reply.sessions.length);
    this.metrics({
      ...emptyMetrics(pending.mode === "more" ? "list_more" : pending.mode === "refresh" ? "list_refresh" : "list", pending.id),
      wire_ms: Math.max(0, this.clock.now() - pending.sentAt),
      queue_ms: Math.max(0, pending.sentAt - pending.startedAt),
      read_bytes: new TextEncoder().encode(JSON.stringify(reply.sessions)).length,
      parsed_entries: reply.sessions.length,
      cache_hit: false,
      apply_ms: Math.max(0, this.clock.now() - applyStarted),
    });
    // A successful envelope may still be an intermediate index state. It must
    // not freeze an empty/partial list as a validated terminal page.
    if (reply.index_state === "building") this.scheduleBuildingRetry(pending.scope, reply.retry_after_ms);
    else this.resetBuildingRetry(pending.scopeKey);
  }

  private resetBuildingRetry(scopeKey: string): void {
    const timer = this.retryTimers.get(scopeKey);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.retryTimers.delete(scopeKey);
    this.buildingRetries.delete(scopeKey);
  }

  private scheduleBuildingRetry(scope: HistoryScope, retryAfterMs: number | null | undefined): void {
    const key = historyScopeKey(scope.host, scope.daemon_id);
    if (!this.views.has(key) || this.pending.has(key) || this.retryTimers.has(key)) return;
    const now = this.clock.now();
    const state = this.buildingRetries.get(key) ?? { startedAt: now, attempts: 0 };
    this.buildingRetries.set(key, state);
    const elapsed = Math.max(0, now - state.startedAt);
    if (elapsed >= BUILDING_RETRY_BUDGET_MS || state.attempts >= BUILDING_RETRY_MAX_ATTEMPTS) {
      this.finishBuildingRetry(key);
      return;
    }
    const backoff = Math.min(BUILDING_RETRY_MAX_DELAY_MS,
      BUILDING_RETRY_BASE_MS * (2 ** Math.min(state.attempts, 6)));
    const delay = Math.max(retryAfterMs ?? BUILDING_RETRY_BASE_MS, backoff);
    const remaining = BUILDING_RETRY_BUDGET_MS - elapsed;
    state.attempts++;
    const timer = this.clock.setTimeout(() => {
      if (this.retryTimers.get(key) !== timer) return;
      this.retryTimers.delete(key);
      // A refresh, scope release or invalidation may retire the scheduled work.
      if (!this.views.has(key) || this.pending.has(key)) return;
      if (this.clock.now() - state.startedAt >= BUILDING_RETRY_BUDGET_MS) {
        this.finishBuildingRetry(key);
        return;
      }
      this.send(scope, { mode: "first", cursor: "", ifRevision: null, priority: "foreground", buildingRetry: true });
    }, Math.min(delay, remaining));
    this.retryTimers.set(key, timer);
  }

  private finishBuildingRetry(scopeKey: string): void {
    this.resetBuildingRetry(scopeKey);
    const view = this.views.get(scopeKey);
    if (view === undefined) return;
    this.paint(scopeKey, view.rows, {
      loading: false,
      loadingMore: false,
      failure: { ok: false, code: "timeout", detail: "history list remained building" },
      retry_after_ms: null,
    });
  }

  private paint(
    scopeKey: string,
    rows: readonly HistorySessionRow[],
    patch: Partial<Omit<HistoryListView, "scope" | "rows" | "version">>,
  ): void {
    const previous = this.views.get(scopeKey);
    const view: HistoryListView = {
      scope: scopeKey,
      rows,
      revision: patch.revision ?? previous?.revision ?? null,
      index_state: patch.index_state ?? previous?.index_state ?? "ready",
      current: patch.current ?? previous?.current ?? null,
      next_cursor: patch.next_cursor !== undefined ? patch.next_cursor : previous?.next_cursor ?? null,
      has_more: patch.has_more ?? previous?.has_more ?? false,
      loading: patch.loading ?? previous?.loading ?? false,
      loadingMore: patch.loadingMore ?? previous?.loadingMore ?? false,
      stale: patch.stale ?? previous?.stale ?? false,
      failure: patch.failure !== undefined ? patch.failure : (previous?.failure ?? null),
      retry_after_ms: patch.retry_after_ms !== undefined ? patch.retry_after_ms : (previous?.retry_after_ms ?? null),
      version: (previous?.version ?? 0) + 1,
      page_start: patch.page_start ?? previous?.page_start ?? 0,
      page_end: patch.page_end ?? previous?.page_end ?? 0,
    };
    this.views.set(scopeKey, view);
    this.emit(scopeKey);
  }

  private pendingById(id: string): PendingList | undefined {
    for (const pending of this.pending.values()) if (pending.id === id) return pending;
    return undefined;
  }

  private detach(pending: PendingList): void {
    if (pending.timer !== null) {
      this.clock.clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (this.pending.get(pending.scopeKey) === pending) this.pending.delete(pending.scopeKey);
  }

  private metrics(sample: HistoryMetricsSample): void {
    this.ports.metrics?.(sample);
  }

  private emit(scopeKey: string): void {
    for (const listener of [...this.listeners]) listener(scopeKey);
  }
}

/** Append rows, skipping ids already present (stable identity, never index). */
function appendRows(
  existing: readonly HistorySessionRow[],
  incoming: readonly HistorySessionRow[],
): HistorySessionRow[] {
  const seen = new Set(existing.map((row) => row.id));
  const out = [...existing];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function requestIdOf(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const value = (msg as { in_reply_to?: unknown }).in_reply_to;
  return typeof value === "string" && value !== "" ? value : null;
}
