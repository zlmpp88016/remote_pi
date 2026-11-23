/**
 * Plan 86 P3 — the query controller's state machine.
 *
 * THIS IS THE GATE THE PHASE ASKS FOR BEFORE THE FEATURE IS ENABLED. Every rule
 * here is a user-visible failure it prevents:
 *
 *   • ONE CLICK, AT MOST ONE IDENTICAL QUERY. A pointer that crossed a row starts
 *     a prefetch; the click must JOIN it, not issue a second one (measured on the
 *     live lane: 3/5 mouse-then-click pairs sent the same `session_read` twice).
 *   • LEAVE RELEASES. A hover that is never released would hold the session's only
 *     in-flight slot and make a later click wait 30 s for a request nobody wants.
 *   • A TIMEOUT IS A TYPED TERMINAL. The viewer must stop spinning and say so.
 *   • A WRITE EPOCH INVALIDATES OLD READS. A reply launched before a write must not
 *     be applied over post-write content; it is re-issued after the barrier clears.
 *   • PAGING IS BY STABLE IDENTITY. An overlapping older page must not duplicate a
 *     turn, and the host's cursor is used verbatim.
 *   • `not_modified` IS A SUCCESS. It confirms the cached page without content.
 *
 * Everything runs against a FAKE CLOCK and a FAKE transport, so ordering is
 * deterministic and no relay, host or browser is involved.
 *
 * Run: node scripts/verify-web-history-query.mjs
 */

import { HistoryCache, HistoryListCache } from "../src/lib/remote-pi/history-cache.ts";
import { HistoryListController } from "../src/lib/remote-pi/history-list.ts";
import { HistoryQueryController } from "../src/lib/remote-pi/history-query.ts";

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

/** Deterministic clock: every timer is queued and fired explicitly. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Advance time, firing due timers in order. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (next === null || timer.at < next.timer.at) next = { id, timer };
        }
        if (next === null) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

const SCOPE = { host: "host-1", daemon_id: "daemon-1" };
const itemsOf = (tag, count = 2) =>
  Array.from({ length: count }, (_, i) => ({
    event_id: `${tag}-${i}`,
    entry_id: `${tag}-${i}`,
    event: { ts: i + 1, type: "user_input", id: `u-${tag}-${i}`, text: `${tag} ${i}` },
  }));

function readOk(id, sessionId, list, extra = {}) {
  return {
    type: "history_read_ok",
    in_reply_to: id,
    daemon_id: SCOPE.daemon_id,
    session_id: sessionId,
    snapshot: extra.snapshot ?? "snap-1",
    revision: extra.revision ?? "rev-1",
    projection: 1,
    session: { id: sessionId, name: null, mtime: 1, preview: null },
    items: list,
    older_cursor: extra.older_cursor ?? null,
    has_older: extra.has_older ?? false,
  };
}

/** Controller over a fake transport that records every request. */
function harness(options = {}) {
  const clock = fakeClock();
  const sent = [];
  let seq = 0;
  const metrics = [];
  const cache = new HistoryCache(options.cacheOptions);
  const listCache = new HistoryListCache();
  const controller = new HistoryQueryController({
    cache,
    listCache,
    clock,
    readTimeoutMs: options.readTimeoutMs ?? 30_000,
    ports: {
      sendList: () => {},
      sendRead: (request, priority) => {
        sent.push({ request, priority, at: clock.now() });
      },
      sendBody: (request) => {
        sent.push({ request, priority: "foreground", at: clock.now(), body: true });
      },
      makeId: () => {
        seq += 1;
        return `req-${seq}`;
      },
      reprioritize: (requestId, priority) => {
        sent.push({ reprioritize: requestId, priority, at: clock.now() });
      },
      metrics: (sample) => metrics.push(sample),
    },
  });
  const reads = () => sent.filter((entry) => entry.request?.type === "history_read");
  return { controller, clock, sent, reads, metrics, cache };
}

// ── A. single-flight: hover + click = ONE request ───────────────────────────

function hoverThenClick() {
  console.log("\nA. a click JOINS the hover's request (no second query)");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "hover", priority: "prefetch" });
  check("the hover sent exactly one read", h.reads().length === 1, String(h.reads().length));
  check("it went out as a PREFETCH", h.reads()[0].priority === "prefetch");

  const joined = h.controller.promote(SCOPE, "s1", "viewer");
  check("the click found the in-flight read (promote returns true)", joined === true);
  check("... and minted NO second request", h.reads().length === 1, String(h.reads().length));
  check(
    "the promotion was reported to the transport (queued frame moves up)",
    h.sent.some((entry) => entry.reprioritize === "req-1" && entry.priority === "foreground"),
  );

  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  check("open() with the viewer's token also joins", h.reads().length === 1);

  h.controller.onFrame(readOk("req-1", "s1", itemsOf("a")));
  const view = h.controller.view(SCOPE, "s1");
  check("the joined reply paints the transcript", view !== null && view.items.length === 2);
  check("it is not stale (a live reply confirmed it)", view.stale === false);
  check("no failure is recorded", view.failure === null);
}

// ── B. leave releases the slot ──────────────────────────────────────────────

function leaveReleases() {
  console.log("\nB. leaving releases the single-flight slot");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "hover", priority: "prefetch" });
  check("the hover is in flight", h.reads().length === 1);
  h.controller.leave(SCOPE, "s1", "hover");
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  check(
    "a later click issues its OWN read instead of waiting 30 s",
    h.reads().length === 2,
    String(h.reads().length),
  );
  // The abandoned reply must not resurrect a viewer that moved on.
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("old")));
  check("the abandoned reply paints nothing", h.controller.view(SCOPE, "s1")?.items.length !== 2);
  h.controller.onFrame(readOk("req-2", "s1", itemsOf("new")));
  check("the current request paints", h.controller.view(SCOPE, "s1")?.items.length === 2);
}

function discardedReadDoesNotOutliveInterest() {
  console.log("B2. a barrier-discarded read is not replayed after its viewer leaves");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onBarrier(1, false);
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("pre-write")));
  h.controller.leave(SCOPE, "s1", "viewer");
  h.controller.onBarrier(1, true);
  check("clearing the barrier does not resurrect the departed session", h.reads().length === 1);
  check("no hidden view or rows are recreated", h.controller.diagnostics().viewItems === 0);
  const scopeRelease = harness();
  scopeRelease.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  scopeRelease.controller.onBarrier(1, false);
  scopeRelease.controller.onFrame(readOk("req-1", "s1", itemsOf("pre-write")));
  scopeRelease.controller.releaseScope(SCOPE);
  scopeRelease.controller.onBarrier(1, true);
  check("scope release also removes discarded replays", scopeRelease.reads().length === 1 && scopeRelease.controller.view(SCOPE, "s1") === null);
}

function rapidReopenOwnership() {
  console.log("B3. A-close-B and A-B-A isolate replies and deadlines");
  const h = harness({ readTimeoutMs: 1000 });
  h.controller.open(SCOPE, "A", { subscriber: "viewer", priority: "foreground" });
  h.clock.advance(500);
  h.controller.leave(SCOPE, "A", "viewer");
  h.controller.open(SCOPE, "B", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(readOk("req-1", "A", itemsOf("late-A")));
  check("closed A's late reply neither resurrects A nor fills B", h.controller.view(SCOPE, "A") === null && h.controller.view(SCOPE, "B")?.items.length === 0);
  h.clock.advance(500);
  check("A's old deadline cannot terminate B", h.controller.view(SCOPE, "B")?.loading === true);
  h.controller.onFrame(readOk("req-2", "B", itemsOf("B")));
  h.clock.advance(1000);
  check("B success remains terminal after both old deadlines", h.controller.view(SCOPE, "B")?.items[0]?.event_id === "B-0" && h.controller.view(SCOPE, "B")?.failure === null);
  h.controller.leave(SCOPE, "B", "viewer");

  const again = harness();
  again.controller.open(SCOPE, "A", { subscriber: "viewer", priority: "foreground" });
  again.controller.leave(SCOPE, "A", "viewer");
  again.controller.open(SCOPE, "B", { subscriber: "viewer", priority: "foreground" });
  again.controller.leave(SCOPE, "B", "viewer");
  again.controller.open(SCOPE, "A", { subscriber: "viewer", priority: "foreground" });
  again.controller.onFrame(readOk("req-1", "A", itemsOf("old-A")));
  again.controller.onFrame(readOk("req-2", "B", itemsOf("old-B")));
  check("A-B-A is fenced by request id, not repeated session id", again.controller.view(SCOPE, "A")?.loading === true && again.controller.view(SCOPE, "B") === null);
  again.controller.onFrame(readOk("req-3", "A", itemsOf("new-A")));
  check("only the new A reply paints", again.controller.view(SCOPE, "A")?.items[0]?.event_id === "new-A-0");
}

// ── C. timeout is a typed terminal ──────────────────────────────────────────

function timeoutIsTyped() {
  console.log("\nC. a lost reply ends in a typed failure, not a permanent spinner");
  const h = harness({ readTimeoutMs: 1_000 });
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.clock.advance(999);
  check("still loading just before the deadline", h.controller.view(SCOPE, "s1")?.loading === true);
  h.clock.advance(1);
  const view = h.controller.view(SCOPE, "s1");
  check("the deadline clears the spinner", view?.loading === false);
  check("the failure is typed `timeout`", view?.failure?.code === "timeout", view?.failure?.code);
  check("a late reply is NOT applied", (h.controller.onFrame(readOk("req-1", "s1", itemsOf("late"))), h.controller.view(SCOPE, "s1")?.items.length === 0));
  check("the late reply was counted, not silently dropped", h.metrics.some((m) => m.op === "read_late_or_unknown"));
}

// ── D. write epoch ──────────────────────────────────────────────────────────

function writeEpoch() {
  console.log("\nD. a write epoch discards pre-write reads and re-issues them");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onBarrier(1, false);
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("pre-write")));
  check("the pre-write reply was NOT applied", h.controller.view(SCOPE, "s1")?.items.length === 0);
  check("the discard is recorded as its own metric", h.metrics.some((m) => m.op === "read_discarded_epoch"));
  check("the barrier closed the read path (no immediate re-issue)", h.reads().length === 1);

  h.controller.onBarrier(1, true);
  check("clearing the barrier re-issues the read once", h.reads().length === 2, String(h.reads().length));
  h.controller.onFrame(readOk("req-2", "s1", itemsOf("post-write")));
  check("the post-write reply is applied", h.controller.view(SCOPE, "s1")?.items.length === 2);
  check(
    "the applied content is the POST-write page",
    h.controller.view(SCOPE, "s1")?.items[0].event.text.startsWith("post-write"),
  );
  h.controller.onBarrier(1, true);
  check("a second clear does not re-issue again", h.reads().length === 2);
}

// ── E. cache-first paint and conditional validation ─────────────────────────

function cacheFirst() {
  console.log("\nE. cache-first paint, conditional validation, not_modified");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("a")));
  h.controller.leave(SCOPE, "s1", "viewer");
  const readsAfterFirst = h.reads().length;

  // A NEW controller over the same cache = a remount/reopen.
  const clock = fakeClock();
  let seq = 100;
  const sent = [];
  const controller = new HistoryQueryController({
    cache: h.cache,
    listCache: new HistoryListCache(),
    clock,
    ports: {
      sendList: () => {},
      sendRead: (request, priority) => sent.push({ request, priority }),
      sendBody: () => {},
      makeId: () => `req-${(seq += 1)}`,
      metrics: () => {},
    },
  });
  controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const painted = controller.view(SCOPE, "s1");
  check("a previously CONFIRMED page paints with NO request", sent.length === 0, String(sent.length));
  check("... and is not labelled stale", painted?.stale === false);
  check("... with its content already present", painted?.items.length === 2);
  check("the first controller sent exactly one read", readsAfterFirst === 1);

  // A barrier marks cached pages unconfirmed: the next open validates conditionally.
  controller.onBarrier(1, false);
  controller.onBarrier(1, true);
  controller.leave(SCOPE, "s1", "viewer");
  controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  check("an unconfirmed page paints immediately", (controller.view(SCOPE, "s1")?.items.length ?? 0) === 2);
  check("... labelled stale", controller.view(SCOPE, "s1")?.stale === true);
  check("... and ONE conditional read validates it", sent.length === 1, String(sent.length));
  check(
    "the conditional read carries if_revision",
    sent[0].request.if_revision === "rev-1",
    JSON.stringify(sent[0].request),
  );

  controller.onFrame({
    type: "history_error",
    in_reply_to: sent[0].request.id,
    code: "not_modified",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: "rev-1",
    snapshot: null,
    retry_after_ms: null,
  });
  const confirmed = controller.view(SCOPE, "s1");
  check("not_modified clears the stale label", confirmed?.stale === false);
  check("not_modified is NOT a failure", confirmed?.failure === null, confirmed?.failure?.code);
  check("not_modified keeps the content", confirmed?.items.length === 2);
}

// ── F. paging ───────────────────────────────────────────────────────────────

function paging() {
  console.log("\nF. older pages use the host cursor and merge by event_id");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(
    readOk("req-1", "s1", itemsOf("page1", 2), { older_cursor: "cursor-1", has_older: true }),
  );
  check("the first page is painted", h.controller.view(SCOPE, "s1")?.items.length === 2);
  check("has_older is the host's statement", h.controller.view(SCOPE, "s1")?.has_older === true);

  h.controller.loadOlder(SCOPE, "s1");
  h.controller.loadOlder(SCOPE, "s1");
  check("pressing twice joins the first request", h.reads().length === 2, String(h.reads().length));
  check(
    "the cursor is sent back VERBATIM",
    h.reads()[1].request.before === "cursor-1",
    JSON.stringify(h.reads()[1].request),
  );
  check("the older page is marked loading", h.controller.view(SCOPE, "s1")?.loadingOlder === true);

  // The older page REPEATS page1-0 (overlap) and adds page0-* rows.
  h.controller.onFrame(
    readOk("req-2", "s1", [...itemsOf("page0", 2), ...itemsOf("page1", 1)], {
      older_cursor: "cursor-0",
      has_older: false,
    }),
  );
  const view = h.controller.view(SCOPE, "s1");
  check("the pages did not duplicate the overlapping item", view.items.length === 4, String(view.items.length));
  check(
    "order is oldest-first across pages",
    view.items.map((item) => item.event_id).join(",") === "page0-0,page0-1,page1-0,page1-1",
    view.items.map((item) => item.event_id).join(","),
  );
  check("the next cursor is the OLDEST page's", view.older_cursor === "cursor-0");
  check("has_older follows the oldest page", view.has_older === false);
  check("loadingOlder is cleared", view.loadingOlder === false);
}

// ── G. building retries once ────────────────────────────────────────────────

function building() {
  console.log("\nG. `building` retries ONCE and never shows an empty catalog");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame({
    type: "history_error",
    in_reply_to: "req-1",
    code: "building",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: null,
    snapshot: null,
    retry_after_ms: 25,
  });
  const view = h.controller.view(SCOPE, "s1");
  check("building is a STATE, not a failure", view?.failure === null);
  check("... and the viewer is told", view?.building === true);
  check("no immediate re-request (the retry is scheduled)", h.reads().length === 1);
  h.clock.advance(25);
  check("one retry was issued after the suggested delay", h.reads().length === 2, String(h.reads().length));
  h.controller.onFrame(readOk("req-2", "s1", itemsOf("ready")));
  check("the retry settles into content", h.controller.view(SCOPE, "s1")?.building === false);
  check("... with items", h.controller.view(SCOPE, "s1")?.items.length === 2);
  const repeated = harness();
  repeated.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const buildingReply = id => ({ type: "history_error", in_reply_to: id, code: "building",
    daemon_id: SCOPE.daemon_id, session_id: "s1", revision: null, snapshot: null, retry_after_ms: 25 });
  repeated.controller.onFrame(buildingReply("req-1"));
  repeated.clock.advance(25);
  repeated.controller.onFrame(buildingReply("req-2"));
  repeated.clock.advance(1000);
  check("repeated building does not schedule an unbounded second retry", repeated.reads().length === 2 && repeated.clock.pending() === 0);
  check("retry exhaustion is exposed as a typed terminal", repeated.controller.view(SCOPE, "s1")?.failure?.code === "building" && repeated.controller.view(SCOPE, "s1")?.loading === false);
  repeated.controller.leave(SCOPE, "s1", "viewer");
  repeated.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  repeated.controller.onFrame({ type: "history_error", in_reply_to: "req-3", code: "building",
    daemon_id: SCOPE.daemon_id, session_id: "s1", revision: null, snapshot: null, retry_after_ms: 25 });
  repeated.clock.advance(25);
  check("an explicit later reopen gets a fresh single-retry allowance", repeated.reads().length === 4);
  repeated.controller.leave(SCOPE, "s1", "viewer");
}

// ── G2. snapshot preservation and generation-safe paging ───────────────────

function snapshotPreservation() {
  console.log("\nG2. the client always preserves the snapshot and never splices generations");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(
    readOk("req-1", "s1", itemsOf("page1", 2), { older_cursor: "cursor-1", has_older: true }),
  );
  check("the open page publishes its snapshot", h.controller.view(SCOPE, "s1")?.snapshot === "snap-1");
  check("the open page publishes its revision", h.controller.view(SCOPE, "s1")?.revision === "rev-1");

  h.controller.loadOlder(SCOPE, "s1");
  const older = h.reads()[1].request;
  check("the older read carries the OPAQUE cursor verbatim", older.before === "cursor-1", JSON.stringify(older));
  check(
    "the older read carries the SAME snapshot (never the newest revision)",
    older.snapshot === "snap-1",
    JSON.stringify(older),
  );
  check("the older read does NOT carry a revision substitute", older.if_revision === undefined);

  // A page from ANOTHER generation must not be spliced in.
  h.controller.onFrame({
    ...readOk("req-2", "s1", [...itemsOf("page0", 2), ...itemsOf("page1", 1)], {
      older_cursor: "cursor-0",
      has_older: false,
    }),
    snapshot: "snap-2",
  });
  check("a cross-generation older page paints NOTHING", h.controller.view(SCOPE, "s1")?.items.length === 0);
  check("... and triggers exactly one deliberate reopen", h.reads().length === 3, String(h.reads().length));
  const reopen = h.reads()[2].request;
  check("the reopen is a fresh head read (no cursor, no snapshot)", reopen.before === undefined && reopen.snapshot === undefined, JSON.stringify(reopen));

  // The reopened head page settles the view; its older pages keep ITS snapshot.
  h.controller.onFrame(readOk("req-3", "s1", itemsOf("fresh", 2), { older_cursor: "cursor-fresh", has_older: true }));
  check("the reopened page is painted", h.controller.view(SCOPE, "s1")?.items.length === 2);
  check("its snapshot becomes the new generation", h.controller.view(SCOPE, "s1")?.snapshot === "snap-1");
  h.controller.loadOlder(SCOPE, "s1");
  check(
    "the next older page carries the CURRENT generation snapshot",
    h.reads()[3].request.snapshot === "snap-1",
    JSON.stringify(h.reads()[3].request),
  );
}

function staleReopensOnce() {
  console.log("\nG3. stale is an ordered reopen — exactly once per generation");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("old", 2), { older_cursor: "c1", has_older: true }));
  h.controller.loadOlder(SCOPE, "s1");
  h.controller.onFrame({
    type: "history_error",
    in_reply_to: "req-2",
    code: "stale",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: null,
    snapshot: "snap-2",
    retry_after_ms: null,
  });
  check("a stale page is dropped (no splice with the old generation)", (h.controller.view(SCOPE, "s1")?.items.length ?? 0) === 0);
  check("one deliberate reopen was issued", h.reads().length === 3, String(h.reads().length));
  check("the reopen is recorded as its own metric", h.metrics.some((m) => m.op === "read_stale_reopen"));

  h.controller.onFrame({
    type: "history_error",
    in_reply_to: "req-3",
    code: "stale",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: null,
    snapshot: null,
    retry_after_ms: null,
  });
  check("a SECOND stale does NOT loop", h.reads().length === 3, String(h.reads().length));
  check("... and surfaces the typed failure", h.controller.view(SCOPE, "s1")?.failure?.code === "stale");
  check("... with the observed truth in the metrics", h.metrics.some((m) => m.op === "read_stale_reopen_exhausted"));

  // A successful head page resets the budget for the NEXT generation.
  const fresh = harness();
  fresh.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  fresh.controller.onFrame({
    type: "history_error",
    in_reply_to: "req-1",
    code: "stale",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: null,
    snapshot: null,
    retry_after_ms: null,
  });
  fresh.controller.onFrame(readOk("req-2", "s1", itemsOf("ok", 2), { older_cursor: "c9", has_older: true }));
  fresh.controller.loadOlder(SCOPE, "s1");
  fresh.controller.onFrame({
    type: "history_error",
    in_reply_to: "req-3",
    code: "stale",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: null,
    snapshot: null,
    retry_after_ms: null,
  });
  check(
    "after a successful page, a later stale reopens again (budget reset)",
    fresh.reads().length === 4,
    String(fresh.reads().length),
  );
}

// ── G4. HEAD revalidation must ask for the NEWEST head ─────────────────────

/**
 * THE REGRESSION THIS PHASE EXISTS FOR.
 *
 * A cached/unconfirmed page is revalidated with `if_revision` ONLY. If the read
 * also carried the cached `snapshot`, the host would serve the page from that
 * FIXED high-water (the appended turn stays invisible) and then compare
 * `if_revision` against the CURRENT revision — `not_modified` — so the client
declared its old head current. That is a stale transcript presented as latest.
 */
function headRevalidationAsksForNewest() {
  console.log("\nG4. cache revalidation asks for the NEWEST head (if_revision only, no snapshot)");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(
    readOk("req-1", "s1", itemsOf("a", 2), {
      snapshot: "snap-1",
      revision: "rev-1",
      older_cursor: "c1",
      has_older: true,
    }),
  );
  // A write lands while the reader is away: nothing cached is confirmed.
  h.controller.onBarrier(1, false);
  h.controller.onBarrier(1, true);
  h.controller.leave(SCOPE, "s1", "viewer");

  // A NEW controller over the same cache = remount / explicit reopen/refresh.
  const sent = [];
  let seq = 500;
  const clock = fakeClock();
  const controller = new HistoryQueryController({
    cache: h.cache,
    listCache: new HistoryListCache(),
    clock,
    ports: {
      sendList: () => {},
      sendRead: (request, priority) => sent.push({ request, priority }),
      sendBody: () => {},
      makeId: () => `req-${(seq += 1)}`,
      metrics: () => {},
    },
  });
  controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  check("the cached head paints immediately (stale-labelled)", controller.view(SCOPE, "s1")?.stale === true);
  check("... with ONE conditional read", sent.length === 1, String(sent.length));
  const revalidate = sent[0].request;
  check(
    "the revalidation carries if_revision",
    revalidate.if_revision === "rev-1",
    JSON.stringify(revalidate),
  );
  check(
    "the revalidation does NOT pin a snapshot (the newest head is asked for)",
    revalidate.snapshot === undefined,
    JSON.stringify(revalidate),
  );
  check(
    "the revalidation does NOT carry a before cursor (it is a head read)",
    revalidate.before === undefined,
    JSON.stringify(revalidate),
  );

  // A turn was appended since: the host answers with the NEW head sequence.
  controller.onFrame(
    readOk(sent[0].request.id, "s1", [...itemsOf("a", 2), ...itemsOf("appended", 1)], {
      snapshot: "snap-2",
      revision: "rev-2",
      older_cursor: "c2",
      has_older: true,
    }),
  );
  const changed = controller.view(SCOPE, "s1");
  check("the appended turn is VISIBLE after revalidation", changed?.items.length === 3, String(changed?.items.length));
  check(
    "... and it is the newest item",
    changed?.items[2]?.event_id === "appended-0",
    changed?.items.map((item) => item.event_id).join(","),
  );
  check("the view adopts the NEW snapshot", changed?.snapshot === "snap-2", changed?.snapshot);
  check("the view adopts the NEW revision", changed?.revision === "rev-2", changed?.revision);
  check("the new sequence's cursor is published", changed?.older_cursor === "c2", changed?.older_cursor);
  check("the page is confirmed, not stale", changed?.stale === false);

  // UNCHANGED head: the same conditional read is answered `not_modified`.
  controller.onBarrier(2, false);
  controller.onBarrier(2, true);
  controller.leave(SCOPE, "s1", "viewer");
  controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  check("an unconfirmed generation revalidates with ONE read", sent.length === 2, String(sent.length));
  const again = sent[1].request;
  check("it carries the CURRENT revision", again.if_revision === "rev-2", JSON.stringify(again));
  check("... and still no snapshot", again.snapshot === undefined, JSON.stringify(again));
  controller.onFrame({
    type: "history_error",
    in_reply_to: again.id,
    code: "not_modified",
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    revision: "rev-2",
    snapshot: null,
    retry_after_ms: null,
  });
  const unchanged = controller.view(SCOPE, "s1");
  check("not_modified clears the stale label", unchanged?.stale === false);
  check("not_modified is not a failure", unchanged?.failure === null, unchanged?.failure?.code);
  check("not_modified keeps the content", unchanged?.items.length === 3, String(unchanged?.items.length));
  check("not_modified keeps the snapshot", unchanged?.snapshot === "snap-2", unchanged?.snapshot);
}

// ── G4b. modelled host: the request SHAPE decides whether an append is seen ──

/**
 * A faithful miniature of the host's `history_read` contract
 * (server/src/session/history_service.ts `read()`), driven by the requests the
 * client ACTUALLY sends:
 *
 *  • `if_revision` is compared against the CURRENT row revision, `not_modified`
 *    is answered before a page is built;
 *  • a supplied `snapshot` PINS the page boundary (the fixed high-water), so the
 *    reply carries the OLD page — while the `revision` it reports is the
 *    CURRENT row revision;
 *  • no snapshot ⇒ the newest page, boundary = the current water.
 *
 * So a pinned revalidation hides an appended turn AND stamps the old head with
 * the current revision, which is precisely the defect this phase corrects.
 */
function modelledHostReplay() {
  console.log("\nG4b. modelled host: only an UNPINNED revalidation reveals an appended turn");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const rows = itemsOf("a", 2);
  h.controller.onFrame(
    readOk("req-1", "s1", rows, { snapshot: "snap-1", revision: "rev-1", older_cursor: "c1", has_older: true }),
  );
  // The reader goes away and the host appends a turn: rev-1 → rev-2, new water.
  h.controller.onBarrier(1, false);
  h.controller.onBarrier(1, true);
  h.controller.leave(SCOPE, "s1", "viewer");
  const appended = itemsOf("appended", 1);
  const current = [...rows, ...appended];

  const answerLatest = () => {
    const request = h.reads().at(-1).request;
    if (request.if_revision !== undefined && request.if_revision === "rev-2") {
      h.controller.onFrame({
        type: "history_error",
        in_reply_to: request.id,
        code: "not_modified",
        daemon_id: SCOPE.daemon_id,
        session_id: "s1",
        revision: "rev-2",
        snapshot: null,
        retry_after_ms: null,
      });
      return "not_modified";
    }
    const pinned = request.snapshot !== undefined;
    h.controller.onFrame(
      readOk(request.id, "s1", pinned ? rows : current, {
        snapshot: pinned ? request.snapshot : "snap-2",
        revision: "rev-2",
        older_cursor: pinned ? "c1" : "c2",
        has_older: true,
      }),
    );
    return pinned ? "pinned-old-page" : "newest-page";
  };

  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const firstAnswer = answerLatest();
  const afterAppend = h.controller.view(SCOPE, "s1");
  check(
    "the host served the NEWEST page (not the pinned old one)",
    firstAnswer === "newest-page",
    firstAnswer,
  );
  check("the appended turn reaches the reader", afterAppend?.items.length === 3, String(afterAppend?.items.length));
  check("the reader is on the new sequence", afterAppend?.snapshot === "snap-2", afterAppend?.snapshot);
  check("the old head was not relabelled current in place", afterAppend?.revision === "rev-2", afterAppend?.revision);

  // A SECOND reopen now proves the real revision: the host answers not_modified
  // honestly, and the reader stays on the appended content.
  h.controller.onBarrier(2, false);
  h.controller.onBarrier(2, true);
  h.controller.leave(SCOPE, "s1", "viewer");
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const secondAnswer = answerLatest();
  const settled = h.controller.view(SCOPE, "s1");
  check("the follow-up validation is `not_modified`", secondAnswer === "not_modified", secondAnswer);
  check("not_modified leaves the append visible", settled?.items.length === 3, String(settled?.items.length));
  check("not_modified is not a failure", settled?.failure === null, settled?.failure?.code);
}

// ── G5. a changed head REPLACES the whole loaded page sequence ──────────────

function changedHeadReplacesSequence() {
  console.log("\nG5. a changed head replaces EVERY loaded page (no older-page splice)");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(
    readOk("req-1", "s1", itemsOf("page1", 2), {
      snapshot: "snap-1",
      revision: "rev-1",
      older_cursor: "c1",
      has_older: true,
    }),
  );
  h.controller.loadOlder(SCOPE, "s1");
  check(
    "the older read of the loaded sequence keeps ITS snapshot+cursor",
    h.reads()[1].request.snapshot === "snap-1" && h.reads()[1].request.before === "c1",
    JSON.stringify(h.reads()[1].request),
  );
  h.controller.onFrame(
    readOk("req-2", "s1", [...itemsOf("page0", 2), ...itemsOf("page1", 1)], {
      snapshot: "snap-1",
      revision: "rev-1",
      older_cursor: "c0",
      has_older: false,
    }),
  );
  check("two pages are loaded", h.controller.view(SCOPE, "s1")?.items.length === 4, String(h.controller.view(SCOPE, "s1")?.items.length));
  check("two pages are cached", h.cache.size === 2, String(h.cache.size));

  // A write moves the generation under the reader.
  h.controller.onBarrier(3, false);
  h.controller.onBarrier(3, true);
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const refresh = h.reads()[2].request;
  check("the revalidation asks for the newest head", refresh.snapshot === undefined && refresh.before === undefined, JSON.stringify(refresh));
  check("... while still proving the cached revision", refresh.if_revision === "rev-1", JSON.stringify(refresh));

  h.controller.onFrame(
    readOk("req-3", "s1", itemsOf("newhead", 2), {
      snapshot: "snap-2",
      revision: "rev-2",
      older_cursor: "c-new",
      has_older: true,
    }),
  );
  const replaced = h.controller.view(SCOPE, "s1");
  check(
    "the previous sequence's pages are GONE (no splice under the new head)",
    replaced?.items.length === 2,
    replaced?.items.map((item) => item.event_id).join(","),
  );
  check(
    "... the view holds only the new head's rows",
    replaced?.items.every((item) => item.event_id.startsWith("newhead")),
    replaced?.items.map((item) => item.event_id).join(","),
  );
  check("the page sequence restarts at the new cursor", replaced?.older_cursor === "c-new", replaced?.older_cursor);
  check("the new snapshot is published", replaced?.snapshot === "snap-2", replaced?.snapshot);
  check("the page list is replaced WHOLE in the cache", h.cache.size === 1, String(h.cache.size));

  // Paging now continues inside the NEW sequence.
  h.controller.loadOlder(SCOPE, "s1");
  const older = h.reads()[3].request;
  check(
    "the next older page is pinned to the NEW snapshot and ITS cursor",
    older.snapshot === "snap-2" && older.before === "c-new",
    JSON.stringify(older),
  );
}

// ── G6. write-epoch reissues keep the right mode semantics ──────────────────

function reissueModeSemantics() {
  console.log("\nG6. barrier reissues keep head/discover vs older/carry semantics");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(
    readOk("req-1", "s1", itemsOf("page1", 2), {
      snapshot: "snap-1",
      revision: "rev-1",
      older_cursor: "c1",
      has_older: true,
    }),
  );

  // An OLDER read crosses a write barrier: its reissue must CARRY the sequence.
  h.controller.onBarrier(1, false);
  h.controller.loadOlder(SCOPE, "s1");
  h.controller.onFrame(readOk("req-2", "s1", itemsOf("page0", 2), { snapshot: "snap-1", revision: "rev-1", older_cursor: "c0", has_older: false }));
  check("the pre-write older page is NOT applied", h.controller.view(SCOPE, "s1")?.items.length === 2);
  h.controller.onBarrier(1, true);
  const olderReissue = h.reads()[2].request;
  check(
    "the older reissue keeps the ORIGINAL snapshot and cursor",
    olderReissue.snapshot === "snap-1" && olderReissue.before === "c1",
    JSON.stringify(olderReissue),
  );
  check("the older reissue carries no revision substitute", olderReissue.if_revision === undefined, JSON.stringify(olderReissue));
  h.controller.onFrame(readOk("req-3", "s1", itemsOf("page0", 2), { snapshot: "snap-1", revision: "rev-1", older_cursor: "c0", has_older: false }));
  check("the reissued older page merges", h.controller.view(SCOPE, "s1")?.items.length === 4, String(h.controller.view(SCOPE, "s1")?.items.length));

  // A REFRESH crossing a barrier reissues as a HEAD discovery, never pinned.
  h.controller.onBarrier(2, false);
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const refresh = h.reads()[3].request;
  check("the refresh discovery is unpinned", refresh.snapshot === undefined && refresh.before === undefined, JSON.stringify(refresh));
  h.controller.onFrame(readOk("req-4", "s1", itemsOf("newer", 2), { snapshot: "snap-2", revision: "rev-2" }));
  check("the pre-write refresh reply is NOT applied", h.controller.view(SCOPE, "s1")?.items.length === 4);
  h.controller.onBarrier(2, true);
  const refreshReissue = h.reads()[4].request;
  check(
    "the refresh reissue keeps ONLY if_revision (re-proves, never pins)",
    refreshReissue.if_revision === "rev-1" && refreshReissue.snapshot === undefined && refreshReissue.before === undefined,
    JSON.stringify(refreshReissue),
  );
}

// ── G7. body keeps the opaque snapshot it was opened with ───────────────────

async function bodySnapshotBoundary() {
  console.log("\nG7. a body chunk is bound to the snapshot it was opened at");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("a")));
  const ref = {
    ref: "ref-9",
    field: "text",
    representation: "text_utf8",
    mime: null,
    total_bytes: 3,
    preview: null,
    preview_truncated: true,
  };
  const pending = h.controller.loadBody(SCOPE, "s1", { snapshot: "snap-1", ref, mode: "full" });
  const request = h.sent.find((entry) => entry.body === true)?.request;
  check("the body request carries the snapshot VERBATIM", request?.snapshot === "snap-1", JSON.stringify(request));

  const enc = (s) => Buffer.from(new TextEncoder().encode(s)).toString("base64");
  h.controller.onFrame({
    type: "history_body_ok",
    in_reply_to: request.id,
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    snapshot: "snap-2",
    body_ref: "ref-9",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 0,
    next_offset_bytes: 3,
    total_bytes: 3,
    data: enc("abc"),
  });
  const foreign = await pending;
  check(
    "a chunk from ANOTHER snapshot is a typed stale, never spliced",
    foreign.ok === false && foreign.code === "stale",
    JSON.stringify(foreign),
  );

  const retry = h.controller.loadBody(SCOPE, "s1", { snapshot: "snap-1", ref, mode: "full" });
  const request2 = h.sent.filter((entry) => entry.body === true).at(-1).request;
  h.controller.onFrame({
    type: "history_body_ok",
    in_reply_to: request2.id,
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    snapshot: "snap-1",
    body_ref: "ref-9",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 0,
    next_offset_bytes: 3,
    total_bytes: 3,
    data: enc("abc"),
  });
  const ok = await retry;
  check("the matching snapshot assembles the body", ok.ok === true && ok.text === "abc", JSON.stringify(ok));
}

// ── H. scope guards ─────────────────────────────────────────────────────────

function scopeGuards() {
  console.log("\nH. a reply for the wrong session/workspace is refused");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const wrongSession = readOk("req-1", "s2", itemsOf("x"));
  h.controller.onFrame(wrongSession);
  check("a wrong session_id is a typed malformed reply", h.controller.view(SCOPE, "s1")?.failure?.code === "malformed");
  check("... and paints nothing", h.controller.view(SCOPE, "s1")?.items.length === 0);

  const h2 = harness();
  h2.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h2.controller.onFrame({ ...readOk("req-1", "s1", itemsOf("x")), daemon_id: "daemon-2" });
  check("a reply from another workspace is refused", h2.controller.view(SCOPE, "s1")?.items.length === 0);
}

// ── I. body single-flight ───────────────────────────────────────────────────

async function bodySingleFlight() {
  console.log("\nI. one body expand is one request, and chunks flow by offset");
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(readOk("req-1", "s1", itemsOf("a")));
  const ref = {
    ref: "ref-1",
    field: "text",
    representation: "text_utf8",
    mime: null,
    total_bytes: 6,
    preview: "abc",
    preview_truncated: true,
  };
  const first = h.controller.loadBody(SCOPE, "s1", { snapshot: "snap-1", ref, mode: "full" });
  const second = h.controller.loadBody(SCOPE, "s1", { snapshot: "snap-1", ref, mode: "full" });
  const bodies = h.sent.filter((entry) => entry.body === true);
  check("the second expand JOINED the first (one POST)", bodies.length === 1, String(bodies.length));

  const bodyId = bodies[0].request.id;
  const enc = (s) => Buffer.from(new TextEncoder().encode(s)).toString("base64");
  h.controller.onFrame({
    type: "history_body_ok",
    in_reply_to: bodyId,
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    snapshot: "snap-1",
    body_ref: "ref-1",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 0,
    next_offset_bytes: 3,
    total_bytes: 6,
    data: enc("abc"),
  });
  const afterFirstChunk = h.sent.filter((entry) => entry.body === true);
  check("the next chunk was requested at the exact offset", afterFirstChunk.length === 2 && afterFirstChunk[1].request.offset_bytes === 3);
  h.controller.onFrame({
    type: "history_body_ok",
    in_reply_to: bodyId,
    daemon_id: SCOPE.daemon_id,
    session_id: "s1",
    snapshot: "snap-1",
    body_ref: "ref-1",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 3,
    next_offset_bytes: 6,
    total_bytes: 6,
    data: enc("def"),
  });
  const [a, b] = await Promise.all([first, second]);
  check("both callers got the assembled text", a.ok === true && a.text === "abcdef", JSON.stringify(a));
  check("the joined caller got the same result", b.ok === true && b.text === "abcdef");

  const tooLarge = h.controller.loadBody(SCOPE, "s1", {
    snapshot: "snap-1",
    ref: { ...ref, ref: "ref-2", preview: null },
    mode: "preview",
  });
  const refusedPreview = await tooLarge;
  check("a preview with no wire preview is typed unsupported", refusedPreview.ok === false && refusedPreview.code === "unsupported");
}


// Hook feed order: query FIRST, list SECOND. Shared errors route by ownership.
function replyRouting() {
  console.log("R. mixed list/read replies keep their controller owner");
  const h = harness();
  const sent = [];
  const list = new HistoryListController({
    cache: new HistoryListCache(), clock: h.clock,
    ports: { makeId: () => "list-1", sendList: (request) => sent.push(request) },
  });
  const feed = (frame) => h.controller.onFrame(frame) || list.onFrame(frame);
  list.open(SCOPE);
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  const frame = {
    type: "history_list_ok", in_reply_to: sent[0].id, daemon_id: SCOPE.daemon_id,
    revision: "list-rev", index_state: "ready",
    current: { session_id: null, ready: null, state: null, source: "unknown" },
    sessions: [{ id: "s1", name: "First", mtime: 1, preview: null }],
    next_cursor: null, has_more: false, retry_after_ms: null,
  };
  check("query passes list_ok to list controller", h.controller.onFrame(frame) === false);
  check("ordered hook feed paints the list", feed(frame) && list.view(SCOPE)?.rows.length === 1);
  check("query passes unknown list reply", h.controller.onFrame({ ...frame, in_reply_to: "late-list" }) === false);
  check("query passes malformed list reply", h.controller.onFrame({ type: "history_list_ok" }) === false);
  check("query claims unknown read", h.controller.onFrame(readOk("late-read", "s1", [])) === true);
  check("query claims unknown malformed body", h.controller.onFrame({ type: "history_body_ok", in_reply_to: "late-body" }) === true);
  check("query passes unowned ambiguous error", h.controller.onFrame({ type: "history_error", in_reply_to: "list-1" }) === false);
  check("query passes error without owner id", h.controller.onFrame({ type: "history_error" }) === false);
  list.refresh(SCOPE);
  check("list receives owned malformed error", feed({ type: "history_error", in_reply_to: "list-1" }) && list.view(SCOPE)?.failure?.code === "malformed");
  check("read receives owned malformed error", feed({ type: "history_error", in_reply_to: "req-1" }) && h.controller.view(SCOPE, "s1")?.failure?.code === "malformed");
  check("unowned ambiguous error remains unclaimed", feed({ type: "history_error", in_reply_to: "nobody" }) === false);
  list.invalidateAll(); h.controller.invalidateAll();
}

replyRouting();

function residentNavigation() {
  console.log("R2. bounded resident pages, real cursor refetch and status identity");
  const h = harness();
  const largeItems = (n) => itemsOf(`page${n}`, 50).map((item) => ({ ...item, event: { ...item.event, text: item.event.text + "x".repeat(2800) } }));
  const answer = (index) => {
    const req = h.reads().at(-1).request;
    check(`page ${index} uses its real opaque cursor`, index === 0 ? req.before === undefined : req.before === `cursor-${index}`);
    if (index > 0) check(`page ${index} stays snapshot pinned`, req.snapshot === "snap-1");
    h.controller.onFrame(readOk(req.id, "large", largeItems(index), { older_cursor: `cursor-${index + 1}`, has_older: true }));
  };
  h.controller.open(SCOPE, "large", { subscriber: "viewer", priority: "foreground" });
  answer(0);
  let bytesRead = 0;
  for (let i = 1; i <= 100; i++) {
    const previousItems = h.controller.view(SCOPE, "large").items;
    h.controller.loadOlder(SCOPE, "large");
    check(`page ${i} loading reuses items identity`, h.controller.view(SCOPE, "large").items === previousItems);
    answer(i);
    bytesRead += JSON.stringify(largeItems(i)).length;
    const stats = h.controller.diagnostics();
    check(`page ${i} ownership is bounded`, stats.residentPages <= 4 && stats.viewItems <= 200 && stats.checkpoints <= 32 && stats.cacheBytes <= 8 * 1024 * 1024 && stats.cachePages <= 64);
  }
  check("the actual cumulative page content exceeds 8MiB", bytesRead > 8 * 1024 * 1024);
  const current = h.controller.view(SCOPE, "large");
  check("the window explains its position and newer navigation", current.page_start > 0 && current.has_newer && current.page_end === 100);
  for (let step = 0; step < 28; step++) {
    h.controller.loadNewer(SCOPE, "large");
    let guard = 0;
    while (h.controller.inFlight(SCOPE, "large") && guard++ < 105) {
      const req = h.reads().at(-1).request;
      const index = req.before === undefined ? 0 : Number(req.before.slice(7));
      answer(index);
    }
    check("bounded checkpoint replay settles", guard < 105);
  }
  h.controller.showHead(SCOPE, "large");
  const req = h.reads().at(-1).request;
  check("Newest deliberately discovers head without snapshot or cursor", req.before === undefined && req.snapshot === undefined);
  answer(0);
  check("old content can be revisited after eviction", h.controller.view(SCOPE, "large").items.some(item => item.event_id === "page0-0"));
  h.controller.leave(SCOPE, "large", "viewer");
  check("leave releases all derived view ownership", h.controller.diagnostics().viewItems === 0 && h.controller.diagnostics().checkpoints === 0);
  for (let i = 0; i < 9; i++) {
    const id = `session${i}`;
    h.controller.open(SCOPE, id, { subscriber: "viewer", priority: "foreground" });
    h.controller.onFrame(readOk(h.reads().at(-1).request.id, id, itemsOf(id)));
    h.controller.leave(SCOPE, id, "viewer");
  }
  check("ninth session cannot retain hidden views", h.cache.sessionCount <= 8 && h.controller.diagnostics().viewItems === 0);
}

function replayGenerationAndRefusal() {
  const h = harness();
  h.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  h.controller.onFrame(readOk(h.reads().at(-1).request.id, "s1", itemsOf("head"), { older_cursor: "c1", has_older: true }));
  for (let n = 1; n <= 40; n++) {
    h.controller.loadOlder(SCOPE, "s1");
    h.controller.onFrame(readOk(h.reads().at(-1).request.id, "s1", itemsOf(`page${n}`), { older_cursor: `c${n+1}`, has_older: true }));
  }
  let replay;
  for (let navigation = 0; navigation < 40; navigation++) {
    h.controller.loadNewer(SCOPE, "s1");
    const req = h.reads().at(-1).request;
    if (req.before === "c1") { replay = req; break; }
    const n = Number(req.before.slice(1));
    h.controller.onFrame(readOk(req.id, "s1", itemsOf(`page${n}`), { older_cursor: `c${n+1}`, has_older: true }));
  }
  check("aged checkpoint replay starts at pinned page 1", replay?.before === "c1" && replay?.snapshot === "snap-1");
  h.controller.onFrame({ type: "history_error", in_reply_to: replay.id, code: "stale",
    daemon_id: SCOPE.daemon_id, session_id: "s1", revision: null, snapshot: null, retry_after_ms: null });
  const head = h.reads().at(-1).request;
  check("stale during replay reopens an unpinned head", head.before === undefined && head.snapshot === undefined);
  check("stale releases all old checkpoint/view content", h.controller.view(SCOPE, "s1").items.length === 0 && h.controller.diagnostics().checkpoints === 0);
  const tiny = harness({ cacheOptions: { maxBytes: 32 } });
  tiny.controller.open(SCOPE, "s1", { subscriber: "viewer", priority: "foreground" });
  tiny.controller.onFrame(readOk("req-1", "s1", itemsOf("oversize")));
  check("cache refusal becomes a typed terminal, never a false empty success", tiny.controller.view(SCOPE, "s1").failure?.code === "unsupported" && !tiny.controller.view(SCOPE, "s1").loading);
}

function boundedListOwnership() {
  const cache = new HistoryListCache();
  const sent = [];
  const list = new HistoryListController({ cache, clock: fakeClock(), ports: {
    makeId: () => `list-${sent.length}`, sendList: req => sent.push(req),
  } });
  const rows = p => Array.from({ length: 50 }, (_, i) => ({ id: `session-${p}-${i}`, name: `P87_${p}_${i}`, mtime: i, preview: "x".repeat(100) }));
  list.open(SCOPE);
  for (let page = 0; page < 30; page++) {
    if (page) list.loadMore(SCOPE);
    list.onFrame({ type: "history_list_ok", in_reply_to: sent.at(-1).id, daemon_id: SCOPE.daemon_id,
      sessions: rows(page), revision: "list-rev", index_state: "ready",
      current: { session_id: null, ready: null, state: null, source: "unknown" },
      next_cursor: `list-cursor-${page+1}`, has_more: true, retry_after_ms: null });
    const stats = list.diagnostics();
    check("list resident rows/pages stay bounded", stats.viewRows <= 200 && stats.residentPages <= 4 && stats.cacheBytes <= 512 * 1024);
  }
  check("cached page is a reply, not a cumulative archive", cache.get("host-1 daemon-1", "list-cursor-29").page.rows.length === 50);
  check("list explains a paged window", list.view(SCOPE).page_start > 0 && list.view(SCOPE).page_end === 29);
  list.releaseScope(SCOPE);
  check("list release drops every view row", list.diagnostics().viewRows === 0);
}


function transientListBuilding() {
  console.log('HBL. successful building lists retry without becoming a cached terminal');
  const create = () => {
    const clock = fakeClock(), cache = new HistoryListCache(), sent = [];
    const list = new HistoryListController({ cache, clock, ports: {
      makeId: () => 'building-list-' + sent.length,
      sendList: request => sent.push(request),
    } });
    const answer = (state, rows = [], delay = 40) => list.onFrame({
      type: 'history_list_ok', in_reply_to: sent.at(-1).id, daemon_id: SCOPE.daemon_id,
      revision: state === 'building' ? 'building-revision' : 'ready-revision', index_state: state,
      sessions: rows, current: { session_id: null, ready: null, state: null, source: 'unknown' },
      next_cursor: null, has_more: false, retry_after_ms: state === 'building' ? delay : null,
    });
    const buildingError = delay => list.onFrame({
      type: 'history_error', in_reply_to: sent.at(-1).id, code: 'building',
      daemon_id: SCOPE.daemon_id, session_id: null, revision: null, snapshot: null,
      retry_after_ms: delay,
    });
    return { clock, cache, sent, list, answer, buildingError };
  };
  const key = SCOPE.host + '\0' + SCOPE.daemon_id;
  const row = { id: 'cold-session', name: 'Cold session', mtime: 1, preview: null };
  const h = create();
  h.list.open(SCOPE);h.answer('building');
  check('HBL building success remains an honest transient state', h.list.view(SCOPE)?.index_state === 'building' && h.list.view(SCOPE)?.failure === null);
  check('HBL building success is not a validated cache terminal', h.cache.get(key)?.page.validated === false);
  check('HBL exactly one building retry timer exists', h.clock.pending() === 1);
  h.clock.advance(39);
  check('HBL server retry delay is honored', h.sent.length === 1);
  h.clock.advance(1);
  check('HBL building success automatically retries', h.sent.length === 2);
  check('HBL automatic retry requests an unconditional first page', h.sent.length === 2 && h.sent[1].if_revision === undefined && h.sent[1].cursor === undefined);
  h.answer('ready', [row]);
  check('HBL ready result replaces transient emptiness', h.list.view(SCOPE)?.rows[0]?.id === row.id && h.list.view(SCOPE)?.index_state === 'ready');
  check('HBL ready result validates the cache', h.cache.get(key)?.page.validated === true);
  check('HBL ready result leaves no retry or timeout timer', h.clock.pending() === 0);
  check('HBL ready result clears the transient retry hint', h.list.view(SCOPE)?.retry_after_ms === null);
  h.list.releaseScope(SCOPE);const readyCount = h.sent.length;h.list.open(SCOPE);
  check('HBL completed cached reopen does not refetch', h.sent.length === readyCount && h.list.view(SCOPE)?.rows[0]?.id === row.id);
  h.list.invalidateAll();

  const legacy = create();legacy.cache.put({ scope:key,cursor:'',revision:'old-building',rows:[],
    next_cursor:null,has_more:false,index_state:'building',validated:true });legacy.list.open(SCOPE);
  check('HBL even an older validated building cache is not terminal', legacy.sent.length === 1);
  check('HBL older building cache reopens without a conditional revision', legacy.sent[0]?.if_revision === undefined);
  check('HBL older building cache is honestly labelled stale', legacy.list.view(SCOPE)?.stale === true);
  legacy.list.invalidateAll();

  const released = create();released.list.open(SCOPE);released.answer('building', [row]);
  check('HBL partial building rows may remain visible', released.list.view(SCOPE)?.rows[0]?.id === row.id);
  released.list.releaseScope(SCOPE);released.clock.advance(100);
  check('HBL leaving cancels building work without resurrecting the view', released.sent.length === 1 && released.list.view(SCOPE) === null);
  released.list.open(SCOPE);
  check('HBL reopened building cache is revalidated immediately', released.sent.length === 2);
  check('HBL reopened building cache cannot pin its transient revision', released.sent.length === 2 && released.sent[1].if_revision === undefined);
  released.list.invalidateAll();

  const manual = create();manual.list.open(SCOPE);manual.answer('building');manual.list.refresh(SCOPE);
  const manualId = manual.sent.at(-1).id;manual.clock.advance(40);
  check('HBL explicit refresh cancels an obsolete successful-building retry', manual.sent.length === 2 && manual.sent.at(-1).id === manualId);
  manual.answer('ready', [row]);manual.clock.advance(40);
  check('HBL obsolete retry cannot replace a ready result', manual.sent.length === 2 && manual.list.view(SCOPE)?.index_state === 'ready');
  manual.list.invalidateAll();

  for (const action of ['refresh', 'invalidateScope', 'releaseScope', 'invalidateAll']) {
    const pending = create();pending.list.open(SCOPE);
    pending.list.onFrame({type:'history_error',in_reply_to:pending.sent[0].id,code:'building',
      daemon_id:SCOPE.daemon_id,session_id:null,revision:null,snapshot:null,retry_after_ms:40});
    if (action === 'invalidateAll') pending.list.invalidateAll();else pending.list[action](SCOPE);
    pending.clock.advance(40);
    check('HBL ' + action + ' retires an older error-building retry', pending.sent.length === (action === 'refresh' ? 2 : 1));
    if (action !== 'refresh') check('HBL ' + action + ' does not recreate a released scope', pending.list.view(SCOPE) === null);
    pending.list.invalidateAll();
  }

  const slow = create();slow.list.open(SCOPE);slow.answer('building', [row], 25);
  const backoff = [25, 50, 100, 200, 400, 800, ...Array(28).fill(1_000)];
  for (const [i, delay] of backoff.entries()) {
    slow.clock.advance(delay - 1);
    check(`HBL backoff ${i + 1} never fires early`, slow.sent.length === i + 1);
    slow.clock.advance(1);
    check(`HBL backoff ${i + 1} sends once`, slow.sent.length === i + 2);
    if (i % 2 === 0) slow.buildingError(0);
    else slow.answer('building', [row], null);
  }
  slow.clock.advance(425);
  check('HBL both envelopes exhaust the same 30s retry window', slow.sent.length === 35 && slow.clock.pending() === 0);
  check('HBL exhaustion preserves partial rows and leaves a typed terminal rather than a false empty',
    slow.list.view(SCOPE)?.failure?.code === 'timeout' && slow.list.view(SCOPE)?.index_state === 'building' &&
    slow.list.view(SCOPE)?.rows[0]?.id === row.id && slow.list.view(SCOPE)?.loading === false &&
    slow.list.view(SCOPE)?.retry_after_ms === null);
  slow.clock.advance(30_000);
  check('HBL terminal does not continue polling', slow.sent.length === 35);
  slow.list.refresh(SCOPE);slow.buildingError(25);slow.clock.advance(25);
  check('HBL manual refresh starts a new backoff window', slow.sent.length === 37);
  slow.answer('ready', [row]);
  check('HBL ready closes the new retry window', slow.clock.pending() === 0 && slow.list.view(SCOPE)?.failure === null);

  const hinted = create();hinted.list.open(SCOPE);hinted.buildingError(1_500);
  hinted.clock.advance(1_499);
  check('HBL backoff never shortens a longer host hint', hinted.sent.length === 1);
  hinted.clock.advance(1);hinted.buildingError(Number.MAX_SAFE_INTEGER);
  hinted.clock.advance(28_499);
  check('HBL oversized hint cannot overflow the timer into a retry', hinted.sent.length === 2 && hinted.clock.pending() === 1);
  hinted.clock.advance(1);
  check('HBL oversized hint stops at the retry deadline', hinted.sent.length === 2 && hinted.clock.pending() === 0 &&
    hinted.list.view(SCOPE)?.failure?.code === 'timeout');

  const late = create();late.list.open(SCOPE);late.answer('building', [], 29_999);
  late.clock.advance(29_999);late.clock.advance(50);late.buildingError(25);
  check('HBL a building reply after the retry deadline never re-arms', late.sent.length === 2 &&
    late.list.view(SCOPE)?.failure?.code === 'timeout' && late.clock.pending() === 0);
}

console.log("verify-web-history-query — one task per identity, typed endings");
transientListBuilding();
residentNavigation();
boundedListOwnership();
replayGenerationAndRefusal();
hoverThenClick();
leaveReleases();
discardedReadDoesNotOutliveInterest();
rapidReopenOwnership();
timeoutIsTyped();
writeEpoch();
cacheFirst();
paging();
building();
snapshotPreservation();
staleReopensOnce();
headRevalidationAsksForNewest();
modelledHostReplay();
changedHeadReplacesSequence();
reissueModeSemantics();
scopeGuards();
await bodySingleFlight();
await bodySnapshotBoundary();

console.log(`\n${checks - failures.length}/${checks} checks PASS`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-history-query: OK");
