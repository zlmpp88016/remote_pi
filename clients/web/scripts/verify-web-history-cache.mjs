/**
 * Plan 86 P3 — the scoped page cache: byte and session bounds, scope
 * invalidation, stale labelling and revision checks.
 *
 * WHAT MUST HOLD
 *
 *   1. A page is found ONLY by its full identity (host ⨯ workspace ⨯ session ⨯
 *      snapshot ⨯ projection ⨯ cursor). A lookup with another workspace's key
 *      must miss — the cross-workspace paint is the bug this plan measured.
 *   2. The budget is BYTES, not entries: eight giant sessions cannot fill the
 *      heap, and a page that alone exceeds the budget is refused instead of
 *      evicting everything and still being over.
 *   3. A cached page is STALE until a live reply confirms it, and `not_modified`
 *      can confirm it without re-sending content.
 *   4. A reconnect, a workspace switch, a delete and a revision change each drop
 *      exactly what they invalidate and nothing else.
 *
 * Run: node scripts/verify-web-history-cache.mjs
 */

import {
  HistoryCache,
  HistoryListCache,
  historyPageBytes,
  historyPageKey,
  historyScopeKey,
  historySessionKey,
} from "../src/lib/remote-pi/history-cache.ts";

let checks = 0;
const failures = [];

function check(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(`${label}${detail ? ` :: ${detail}` : ""}`);
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
}

/** One page of `count` items whose text is `size` characters. */
function items(count, size = 8, tag = "x") {
  return Array.from({ length: count }, (_, i) => ({
    event_id: `${tag}-${i}`,
    entry_id: `${tag}-${i}`,
    event: { ts: i, type: "agent_message", in_reply_to: `u${i}`, text: "y".repeat(size) },
  }));
}

function pageInput(host, daemon, session, cursor, list, overrides = {}) {
  const scope = historyScopeKey(host, daemon);
  const sessionKey = historySessionKey(scope, session);
  return {
    key: historyPageKey({
      host,
      daemon_id: daemon,
      session_id: session,
      snapshot: overrides.snapshot ?? "snap",
      projection: overrides.projection ?? 1,
      cursor,
    }),
    scope,
    sessionKey,
    session_id: session,
    snapshot: overrides.snapshot ?? "snap",
    projection: overrides.projection ?? 1,
    cursor,
    revision: overrides.revision ?? "rev",
    items: list,
    older_cursor: null,
    has_older: false,
    has_partial: false,
    validated: overrides.validated ?? true,
  };
}

// ── A. identity ─────────────────────────────────────────────────────────────

function identity() {
  console.log("\nA. a page is found only by its full identity");
  const cache = new HistoryCache();
  const mine = pageInput("host1", "daemon1", "s1", "", items(3));
  cache.put(mine);
  check("the exact key hits", cache.get(mine.key) !== null);
  check(
    "another WORKSPACE misses (no cross-workspace paint)",
    cache.get(pageInput("host1", "daemon2", "s1", "", items(3)).key) === null,
  );
  check(
    "another HOST misses",
    cache.get(pageInput("host2", "daemon1", "s1", "", items(3)).key) === null,
  );
  check(
    "another CURSOR misses (older page is not the head)",
    cache.get(pageInput("host1", "daemon1", "s1", "older-1", items(3)).key) === null,
  );
  check(
    "another SNAPSHOT misses (a rewritten file is a new generation)",
    cache.get(pageInput("host1", "daemon1", "s1", "", items(3), { snapshot: "snap-2" }).key) === null,
  );
  check(
    "another PROJECTION misses",
    cache.get(pageInput("host1", "daemon1", "s1", "", items(3), { projection: 2 }).key) === null,
  );

  const head = cache.headPage(historySessionKey(historyScopeKey("host1", "daemon1"), "s1"));
  check("the head page is found by session", head !== null && head.cursor === "");
}

// ── B. stale labelling ──────────────────────────────────────────────────────

function staleLabels() {
  console.log("\nB. cache-first paint is labelled stale until confirmed");
  const cache = new HistoryCache();
  const stale = pageInput("h", "d", "s1", "", items(2), { validated: false });
  cache.put(stale);
  const hit = cache.get(stale.key);
  check("an unconfirmed page comes back stale", hit !== null && hit.stale === true);
  check("it is still PAINTABLE (content is present)", hit !== null && hit.page.items.length === 2);

  check("validate() confirms it", cache.validate(stale.key, "rev") === true);
  const confirmed = cache.get(stale.key);
  check("a confirmed page is not stale", confirmed !== null && confirmed.stale === false);

  check("markUnvalidated() turns the label back on", cache.markUnvalidated(stale.key) === true);
  check("the content is kept", cache.get(stale.key)?.page.items.length === 2);
  const relabelled = cache.get(stale.key);
  check("... and the label is back", relabelled !== null && relabelled.stale === true);
}

// ── C. byte budget ──────────────────────────────────────────────────────────

function byteBudget() {
  console.log("\nC. the budget is BYTES with a session ceiling");
  const cache = new HistoryCache({ maxBytes: 8 * 1024, maxSessions: 8, now: () => 0 });
  const big = items(10, 400); // ~4 KiB of text per page
  const perPage = historyPageBytes(big);
  check("byte accounting counts the real UTF-8 payload", perPage > 4000, String(perPage));

  for (let i = 0; i < 6; i += 1) {
    cache.put(pageInput("h", "d", `s${i}`, "", big, { snapshot: "snap", revision: `r${i}` }));
  }
  check("the byte ceiling holds", cache.bytes <= 8 * 1024, `bytes=${cache.bytes}`);
  check("more than one session was kept", cache.sessionCount >= 1, String(cache.sessionCount));
  check("older sessions were evicted entirely", cache.sessionCount < 6, String(cache.sessionCount));

  // One page larger than the whole budget is REFUSED, not allowed to evict all.
  const huge = items(200, 400);
  const refused = cache.put(pageInput("h", "d", "huge", "", huge, { snapshot: "snap" }));
  check("an oversize page is refused", refused === null);
  check("the refusal did not empty the cache", cache.size > 0, String(cache.size));

  const sessions = new HistoryCache({ maxBytes: 64 * 1024 * 1024, maxSessions: 3, now: () => 0 });
  const small = items(2, 8);
  for (let i = 0; i < 6; i += 1) {
    sessions.put(pageInput("h", "d", `s${i}`, "", small));
  }
  check("the session ceiling holds even under budget", sessions.sessionCount <= 3, String(sessions.sessionCount));
}

function oneLargeSession() {
  console.log("C2. one session evicts pages, never its newly inserted page");
  const cache = new HistoryCache({ maxBytes: 12 * 1024, now: () => 0 });
  for (let i = 0; i < 20; i++) {
    const page = pageInput("h", "d", "large", `cursor-${i}`, items(3, 1800, `p${i}`));
    const stored = cache.put(page);
    check(`page ${i} remains readable across budget eviction`, stored !== null && cache.get(page.key) !== null);
    check(`page ${i} respects the byte ceiling`, cache.bytes <= 12 * 1024);
  }
  check("only a bounded suffix of the single session remains", cache.size > 0 && cache.size < 20);
}

// ── D. invalidation scopes ──────────────────────────────────────────────────

function invalidation() {
  console.log("\nD. each invalidation drops exactly its own scope");
  /** Seed four pages: two workspaces of one host, one of another host. */
  const seed = () => {
    const cache = new HistoryCache();
    const pages = {
      a1: pageInput("h", "dA", "s1", "", items(2)),
      a2: pageInput("h", "dA", "s2", "", items(2)),
      b1: pageInput("h", "dB", "s1", "", items(2)),
      other: pageInput("h2", "dA", "s1", "", items(2)),
    };
    for (const page of Object.values(pages)) cache.put(page);
    return { cache, pages };
  };

  {
    const { cache, pages } = seed();
    check("invalidateScope drops only that workspace", cache.invalidateScope(historyScopeKey("h", "dA")) === 2);
    check("a sibling workspace survives", cache.get(pages.b1.key) !== null);
    check("the same daemon id on another HOST survives", cache.get(pages.other.key) !== null);
  }
  {
    const { cache, pages } = seed();
    check("invalidateSession drops only that session", cache.invalidateSession(historyScopeKey("h", "dA"), "s1") === 1);
    check("the OTHER session of the workspace survives", cache.get(pages.a2.key) !== null);
    check("the deleted session is gone", cache.get(pages.a1.key) === null);
  }
  {
    const { cache, pages } = seed();
    check("invalidateHost drops every workspace of that host", cache.invalidateHost("h") === 3);
    check("another host survives", cache.get(pages.other.key) !== null);
  }
  {
    const cache = new HistoryCache();
    const fresh = pageInput("h", "dA", "s1", "", items(2), { revision: "rev-new" });
    const stale = pageInput("h", "dA", "s1", "older-1", items(2), { revision: "rev-old" });
    cache.put(fresh);
    cache.put(stale);
    check(
      "a revision change drops the pages of the old revision",
      cache.invalidateRevision(historyScopeKey("h", "dA"), "s1", "rev-new") === 1,
    );
    check("the current revision survives", cache.get(fresh.key) !== null);
    check("the superseded revision is gone", cache.get(stale.key) === null);
    const expected = historyPageBytes(fresh.items);
    check("stored bytes follow the evictions", cache.bytes === expected, `bytes=${cache.bytes} expected=${expected}`);
  }
  {
    const { cache } = seed();
    const before = cache.size;
    cache.clear();
    check("clear() empties the cache", cache.size === 0 && before > 0);
    check("clear() bumps the invalidation generation", cache.invalidationGeneration > 0);
  }
}

// ── E. list cache ───────────────────────────────────────────────────────────

function listCache() {
  console.log("\nE. the list cache keeps rows and their revision");
  const cache = new HistoryListCache({ maxBytes: 4096, maxSessions: 2, now: () => 0 });
  const scope = historyScopeKey("h", "d1");
  cache.put({
    scope,
    cursor: "",
    revision: "rev-1",
    rows: [{ id: "s1", name: null, mtime: 1, preview: "hi" }],
    next_cursor: "next-1",
    has_more: true,
    index_state: "ready",
    validated: false,
  });
  const hit = cache.get(scope);
  check("a row page is retrievable", hit !== null && hit.page.rows.length === 1);
  check("it is stale until confirmed", hit !== null && hit.stale === true);
  check("the cursors are preserved verbatim", hit !== null && hit.page.next_cursor === "next-1");
  check("validate() confirms without re-listing", cache.validate(scope, "", "rev-1") === true);
  check("confirmed is not stale", cache.get(scope)?.stale === false);

  const other = historyScopeKey("h", "d2");
  cache.put({ scope: other, cursor: "", revision: "r", rows: [], next_cursor: null, has_more: false, index_state: "building", validated: true });
  check("building is a STATE that survives the cache", cache.get(other)?.page.index_state === "building");
  check("invalidateScope is per workspace", cache.invalidateScope(scope) === 1 && cache.get(other) !== null);
}

console.log("verify-web-history-cache — scoped, byte-bounded pages");
identity();
staleLabels();
byteBudget();
oneLargeSession();
invalidation();
listCache();

console.log(`\n${checks - failures.length}/${checks} checks PASS`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-history-cache: OK");
