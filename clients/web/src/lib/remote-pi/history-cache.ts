/**
 * Plan 86 P3 — scoped, byte-bounded page cache for workspace history.
 *
 * WHY THE KEY IS THIS LONG
 *
 * The cache bug this module prevents is the one the plan measured: reading one
 * workspace's transcript, switching to another, and seeing the FIRST workspace's
 * rows. A session id is not an identity — the same id lives in every workspace
 * bucket, and a rewritten session file keeps its id while its content becomes a
 * different generation. So a page is keyed by
 * `host ⨯ daemon_id ⨯ session_id ⨯ snapshot ⨯ projection ⨯ cursor`, plus the
 * revision that came with it for validation. Nothing is looked up by a prefix of
 * that tuple.
 *
 * BYTES ARE COUNTED IN UTF-8, NOT ENTRIES
 *
 * "8 sessions" alone does not bound memory: eight giant sessions still fill the
 * heap. The budget is therefore the ACTUAL UTF-8 size of the stored items, the
 * same quantity that crossed the wire after base64 decoding. Byte pressure evicts
 * individual pages; the session ceiling evicts the least recently used session.
 *
 * STALE IS A LABEL, NOT A LIE
 *
 * A cached page paints immediately and carries `validated: false` until a live
 * reply confirms its revision. The UI shows that as a labelled stale paint, so
 * old content is never passed off as current — and `not_modified` is what turns
 * the label off without a re-render of anything.
 */

import type { HistoryItem, HistorySessionRow } from "./history.ts";

/** Client transcript budget: Plan 86 §4.3 (8 MiB, at most 8 sessions). */
export const HISTORY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const HISTORY_CACHE_MAX_SESSIONS = 8;
export const HISTORY_CACHE_MAX_PAGES = 64;
/** List rows are tiny; this only bounds a pathological workspace. */
export const HISTORY_LIST_CACHE_MAX_BYTES = 512 * 1024;
export const HISTORY_LIST_CACHE_MAX_WORKSPACES = 8;
export const HISTORY_LIST_CACHE_MAX_PAGES = 32;

/** Identity of one transcript page. Tokens stay opaque strings. */
export interface HistoryPageKey {
  host: string;
  daemon_id: string;
  session_id: string;
  /** Opaque snapshot the page was read at; `""` before the first page. */
  snapshot: string;
  projection: number;
  /** Opaque older cursor that produced this page; `""` for the newest page. */
  cursor: string;
}

export interface HistoryPage {
  key: string;
  scope: string;
  sessionKey: string;
  session_id: string;
  snapshot: string;
  projection: number;
  cursor: string;
  /** Content revision the host reported for this page. */
  revision: string;
  items: readonly HistoryItem[];
  older_cursor: string | null;
  has_older: boolean;
  /** True when the host marked any item as partial (`truncated`). */
  has_partial: boolean;
  /** False = cache-first paint that a live reply has not confirmed yet. */
  validated: boolean;
  /** Actual UTF-8 size of `items`, the quantity the budget counts. */
  bytes: number;
  touched: number;
}

export interface HistoryCacheHit {
  page: HistoryPage;
  /** True when the entry came back stale-labelled (needs a conditional re-read). */
  stale: boolean;
}

const SEP = "\u0000";

/** Scope identity: one host peer, one workspace (daemon id). */
export function historyScopeKey(host: string, daemonId: string): string {
  return `${host}${SEP}${daemonId}`;
}

/** Session identity inside a scope. */
export function historySessionKey(scope: string, sessionId: string): string {
  return `${scope}${SEP}${sessionId}`;
}

/** Full page identity. Every component is required to be stable/opaque. */
export function historyPageKey(key: HistoryPageKey): string {
  return [
    key.host,
    key.daemon_id,
    key.session_id,
    key.snapshot,
    String(key.projection),
    key.cursor,
  ].join(SEP);
}

/**
 * Actual UTF-8 bytes of a page's items.
 *
 * Serializing once is the honest way to measure what is retained: previews,
 * tool arguments, usage numbers and ids all count. It runs on insert (once per
 * page), never on read.
 */
export function historyPageBytes(items: readonly HistoryItem[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).length;
}

export interface HistoryCacheOptions {
  maxBytes?: number;
  maxSessions?: number;
  maxPages?: number;
  now?: () => number;
}

/**
 * LRU page cache with a byte ceiling and a session ceiling.
 *
 * Both ceilings are enforced TOGETHER: whichever binds first wins, so "8
 * sessions" cannot be used to justify unbounded bytes and vice versa.
 */
export class HistoryCache {
  private readonly entries = new Map<string, HistoryPage>();
  private readonly maxBytes: number;
  private readonly maxSessions: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private totalBytes = 0;
  /** Bumped on every whole-cache invalidation, so a caller can detect it. */
  private generation = 0;

  constructor(options: HistoryCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? HISTORY_CACHE_MAX_BYTES;
    this.maxSessions = Math.max(1, options.maxSessions ?? HISTORY_CACHE_MAX_SESSIONS);
    this.maxPages = Math.max(1, options.maxPages ?? HISTORY_CACHE_MAX_PAGES);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get sessionCount(): number {
    const sessions = new Set<string>();
    for (const entry of this.entries.values()) sessions.add(entry.sessionKey);
    return sessions.size;
  }

  get invalidationGeneration(): number {
    return this.generation;
  }

  /** Look a page up, refreshing its recency. Never mutates content. */
  get(key: string): HistoryCacheHit | null {
    const page = this.entries.get(key);
    if (page === undefined) return null;
    page.touched = this.now();
    return { page, stale: !page.validated };
  }

  /**
   * Store (or replace) one page.
   *
   * A page larger than the WHOLE budget is refused instead of evicting
   * everything else and still being over budget: the caller re-reads it, which
   * is correct because a single reply is capped at 256 KiB on the wire anyway.
   */
  put(page: Omit<HistoryPage, "key" | "scope" | "sessionKey" | "bytes" | "touched"> & {
    key: string;
    scope: string;
    sessionKey: string;
  }): HistoryPage | null {
    const bytes = historyPageBytes(page.items);
    if (bytes > this.maxBytes) return null;
    const previous = this.entries.get(page.key);
    if (previous !== undefined) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(page.key);
    }
    const entry: HistoryPage = { ...page, bytes, touched: this.now() };
    this.entries.set(entry.key, entry);
    this.totalBytes += bytes;
    this.evict();
    return this.entries.get(entry.key) ?? null;
  }

  /**
   * The newest HEAD page of one session (`cursor === ""`), or null.
   *
   * A head page is found by SESSION, not by a fully-specified key: the snapshot is
   * opaque and a caller asking "what is cached for this session?" cannot know it
   * before the first reply. The most recently touched head page wins, which is
   * the one the previous open painted.
   */
  headPage(sessionKey: string): HistoryPage | null {
    let best: HistoryPage | null = null;
    for (const page of this.entries.values()) {
      if (page.sessionKey !== sessionKey) continue;
      if (page.cursor !== "") continue;
      if (best === null || page.touched > best.touched) best = page;
    }
    return best;
  }

  /** Drop one page by key (a superseded revision). */
  drop(key: string): boolean {
    const page = this.entries.get(key);
    if (page === undefined) return false;
    this.entries.delete(key);
    this.totalBytes -= page.bytes;
    return true;
  }

  /** Turn `validated` off without dropping content (write barrier/reconnect). */
  markUnvalidated(key: string): boolean {
    const page = this.entries.get(key);
    if (page === undefined) return false;
    page.validated = false;
    return true;
  }

  /** Mark a cached page as confirmed by a live reply (revision matched). */
  validate(key: string, revision: string): boolean {
    const page = this.entries.get(key);
    if (page === undefined) return false;
    page.revision = revision;
    page.validated = true;
    page.touched = this.now();
    return true;
  }

  /** Drop every page of one workspace/host. Used on switch, reset, delete. */
  invalidateScope(scope: string): number {
    return this.dropWhere((page) => page.scope === scope);
  }

  /** Drop every page of one host. Used on reconnect. */
  invalidateHost(host: string): number {
    const scopePrefix = `${host}${SEP}`;
    return this.dropWhere((page) => page.scope.startsWith(scopePrefix));
  }

  /** Drop every page of one session (a deleted or switched-away session). */
  invalidateSession(scope: string, sessionId: string): number {
    const sessionKey = historySessionKey(scope, sessionId);
    return this.dropWhere((page) => page.sessionKey === sessionKey);
  }

  /**
   * Keep only pages belonging to `revision` for one session.
   *
   * Called when a read answers with a DIFFERENT revision than the cached page:
   * the old page describes content that no longer exists, so it is dropped
   * rather than patched.
   */
  invalidateRevision(scope: string, sessionId: string, revision: string): number {
    const sessionKey = historySessionKey(scope, sessionId);
    return this.dropWhere(
      (page) => page.sessionKey === sessionKey && page.revision !== revision,
    );
  }

  /** Drop pages whose snapshot is not `snapshot` (a rewritten file). */
  invalidateSnapshot(scope: string, sessionId: string, snapshot: string): number {
    const sessionKey = historySessionKey(scope, sessionId);
    return this.dropWhere(
      (page) => page.sessionKey === sessionKey && page.snapshot !== snapshot,
    );
  }

  /** Whole-cache reset (a new pairing, a generation change, a manual refresh). */
  clear(): number {
    const dropped = this.entries.size;
    this.entries.clear();
    this.totalBytes = 0;
    this.generation += 1;
    return dropped;
  }

  /** Every cached page of one session, newest-page first. */
  pagesFor(scope: string, sessionId: string): HistoryPage[] {
    const sessionKey = historySessionKey(scope, sessionId);
    return [...this.entries.values()]
      .filter((page) => page.sessionKey === sessionKey)
      .sort((a, b) => b.touched - a.touched);
  }

  private dropWhere(predicate: (page: HistoryPage) => boolean): number {
    let dropped = 0;
    for (const [key, page] of [...this.entries]) {
      if (!predicate(page)) continue;
      this.entries.delete(key);
      this.totalBytes -= page.bytes;
      dropped += 1;
    }
    return dropped;
  }

  /** Session pressure drops a session; byte/page pressure drops individual LRU
   * pages. Map insertion order breaks ties (including coarse/fake clocks), so
   * the page just inserted survives whenever it fits the budget itself. */
  private evict(): void {
    while (this.sessionCount > this.maxSessions) {
      const victim = this.oldestSessionVictim();
      if (victim === null) break;
      for (const key of victim) this.drop(key);
    }
    while (this.totalBytes > this.maxBytes || this.size > this.maxPages) {
      let victim: HistoryPage | undefined;
      for (const page of this.entries.values()) {
        if (victim === undefined || page.touched < victim.touched) victim = page;
      }
      if (victim === undefined) break;
      this.drop(victim.key);
    }
  }

  /** All keys of the least-recently-used session, or null when empty. */
  private oldestSessionVictim(): string[] | null {
    let oldestSession: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const page of this.entries.values()) {
      if (page.touched < oldestAt) {
        oldestAt = page.touched;
        oldestSession = page.sessionKey;
      }
    }
    if (oldestSession === null) return null;
    return [...this.entries.values()]
      .filter((page) => page.sessionKey === oldestSession)
      .map((page) => page.key);
  }
}

// ── Session-list cache ───────────────────────────────────────────────────────

export interface HistoryListPage {
  scope: string;
  /** Opaque cursor that produced this page; `""` for the first page. */
  cursor: string;
  revision: string | null;
  rows: readonly HistorySessionRow[];
  next_cursor: string | null;
  has_more: boolean;
  index_state: "ready" | "building" | "unavailable";
  /** False = painted from cache, not yet confirmed by a live listing. */
  validated: boolean;
  bytes: number;
  touched: number;
}

/**
 * Session-list page cache.
 *
 * Kept separate from the transcript cache because the two have different
 * lifetimes: a list is invalidated by a revision change or a session create, a
 * transcript by a snapshot/rewrite. One budget shared between them meant a giant
 * transcript could evict the list the sidebar was painting from.
 */
export class HistoryListCache {
  private readonly entries = new Map<string, HistoryListPage>();
  private readonly maxBytes: number;
  private readonly maxScopes: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: HistoryCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? HISTORY_LIST_CACHE_MAX_BYTES;
    this.maxScopes = options.maxSessions ?? HISTORY_LIST_CACHE_MAX_WORKSPACES;
    this.maxPages = Math.max(1, options.maxPages ?? HISTORY_LIST_CACHE_MAX_PAGES);
    this.now = options.now ?? Date.now;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  private static key(scope: string, cursor: string): string {
    return `${scope}${SEP}${cursor}`;
  }

  get(scope: string, cursor = ""): { page: HistoryListPage; stale: boolean } | null {
    const page = this.entries.get(HistoryListCache.key(scope, cursor));
    if (page === undefined) return null;
    page.touched = this.now();
    return { page, stale: !page.validated };
  }

  put(
    page: Omit<HistoryListPage, "bytes" | "touched">,
  ): HistoryListPage | null {
    const bytes = new TextEncoder().encode(JSON.stringify(page.rows)).length;
    if (bytes > this.maxBytes) return null;
    const key = HistoryListCache.key(page.scope, page.cursor);
    const previous = this.entries.get(key);
    if (previous !== undefined) { this.totalBytes -= previous.bytes; this.entries.delete(key); }
    const entry: HistoryListPage = { ...page, bytes, touched: this.now() };
    this.entries.set(key, entry);
    this.totalBytes += bytes;
    this.evict();
    return this.entries.get(key) ?? null;
  }

  validate(scope: string, cursor: string, revision: string | null): boolean {
    const page = this.entries.get(HistoryListCache.key(scope, cursor));
    if (page === undefined) return false;
    page.revision = revision;
    page.validated = true;
    page.touched = this.now();
    return true;
  }

  invalidateScope(scope: string): number {
    let dropped = 0;
    for (const [key, page] of [...this.entries]) {
      if (page.scope !== scope) continue;
      this.entries.delete(key);
      this.totalBytes -= page.bytes;
      dropped += 1;
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes || this.scopes() > this.maxScopes || this.size > this.maxPages) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, page] of this.entries) {
        if (page.touched < oldestAt) {
          oldestAt = page.touched;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      const page = this.entries.get(oldestKey);
      if (page !== undefined) this.totalBytes -= page.bytes;
      this.entries.delete(oldestKey);
    }
  }

  private scopes(): number {
    const scopes = new Set<string>();
    for (const page of this.entries.values()) scopes.add(page.scope);
    return scopes.size;
  }
}
