#!/usr/bin/env node
/**
 * Verify SESSION OWNERSHIP on the web surface: after clicking a session row, the
 * transcript actually on screen must belong to the session that was clicked — and
 * two adjacent switches must not render identical content.
 *
 * ── WHAT THIS GUARDS, STATED HONESTLY ─────────────────────────────────────
 *
 * Clicking a row in the web dock issues `session_read` — a server-side READ-ONLY
 * transcript read (clients/web/src/client/connect-client.tsx `handleSessionRead`;
 * see also session-list.tsx's "no per-row switch control" comment). It is NOT
 * `session_switch`, which is the mobile client's route and the route the
 * cross-talk bug was reported on. Therefore:
 *
 *   This probe guards READ-ONLY OWNERSHIP on web. It does NOT reproduce the
 *   mobile `session_switch` cross-talk route, and a green run here must never be
 *   cited as evidence about that route.
 *
 * It is still worth its cost. The wrong-transcript failure mode — a reply for
 * session X rendering under session Y, or a viewer that re-opens with the
 * previous session's content — is reachable on this surface too, and this probe
 * is built to CATCH it rather than to describe it.
 *
 * ── HOW OWNERSHIP IS DECIDED (no eyeballing anywhere) ─────────────────────
 *
 * Every signal below is read from the live DOM or from the page's own wire
 * traffic; none is inferred from what the script asked for. All are recorded per
 * iteration, and ownership PASSES only when every applicable one holds:
 *
 *   O1 banner      the mounted viewer's OWN chip element reads exactly
 *                  `read-only`. That identifies the SessionViewer surface, as
 *                  opposed to the live transcript.
 *   O2 resume      a `Resume here` control exists in the viewer header, i.e. the
 *                  viewer is showing a session that is NOT the live one, so
 *                  "read" really is a read.
 *   O3 request     a `session_read` request left the page whose `session_id` has
 *                  the clicked row's short id. The short id comes from the row's
 *                  OWN age line (`01a1b6e5 · 6 天前`).
 *   O4 correlation a `session_read_ok` arrived whose `in_reply_to` is one of
 *                  those request ids AND whose `session_id` equals that
 *                  request's `session_id` EXACTLY (full uuid, not a prefix).
 *                  This ties the reply the client actually applied to the row
 *                  that was actually clicked.
 *   O5 structure   the number of rendered transcript rows equals the number of
 *                  `events` in that reply. Skipped (reported as skipped, never
 *                  as a pass) when the host marked the read `truncated` — a
 *                  windowed reply still renders one row per event, but saying so
 *                  is the host's claim, not this probe's, so it is not counted.
 *   O6 content     every `user_input` text in that reply (whitespace-normalised,
 *                  >= 8 chars) appears in the rendered transcript. The host is
 *                  the authority on what session N contains; the DOM has to
 *                  agree with it character for character.
 *   O6b index      HOST-INDEX MATCHING, exactly: the latest `session_list_ok`
 *                  frame carries the host's own `preview` (its first user
 *                  message) for every session in the workspace — the host's
 *                  answer to "what is in session N".
 *                    O6b  the clicked session's preview must appear in the
 *                         rendered text — POSITIVE direction: the host produced
 *                         that text for this id, and the DOM has to agree. Not
 *                         applicable when the host answered with a WINDOW
 *                         (`truncated`/`has_older`), because the preview is the
 *                         session's FIRST message and a tail window does not
 *                         contain it. Measured here: session `01a19924` answers
 *                         27 events with `truncated: true` and its first message
 *                         is nowhere in that window, so asserting it would fail a
 *                         correct read.
 *                    O6c  no DISCRIMINATING foreign preview may appear on screen
 *                         unless this reply's own text explains it. A transcript
 *                         that quotes a sibling prompt is legitimate (measured:
 *                         the `/mofrl` session contains the pelican-HTML prompt
 *                         pasted into it, which is also another session's first
 *                         message), so "foreign text on screen" only counts as
 *                         cross-talk when the target's own reply does not contain
 *                         it.
 *                  A preview is usable as a foreign probe only when it is (a) at
 *                  least 40 chars, (b) neither a substring of nor a superstring of
 *                  the target's preview, and (c) sharing no 32-char prefix with it —
 *                  which excludes the near-duplicate prompt families this workspace
 *                  is full of and would otherwise fire falsely.
 *   O7 dock mark   two halves, because each covers the other's blind spot:
 *                    O7   the dock's `_rowViewing_` marker names the clicked
 *                         session's SHORT ID. This is the identity check, and it
 *                         is also the one that still applies when a re-list
 *                         re-sorts the dock mid-iteration.
 *                    O7b  that marker sits on the SAME ROW INDEX that was clicked,
 *                         and the row at that index still carries the target's
 *                         short id (otherwise the list moved and the index half
 *                         is reported as not-applicable rather than failed).
 *                  The index half alone would be wrong because a re-sort moves
 *                  rows; the id half alone would be ambiguous because short ids
 *                  are NOT unique — this workspace really contains two rows
 *                  sharing `01a1917d` and two sharing `01a18e73` (different full
 *                  uuids, same first 8 hex chars). Together they pin both.
 *   O8 title       the viewer's own title equals the clicked row's label. Both
 *                  sides render `sessionLabel()`, so it must match — required but
 *                  NOT sufficient alone, because labels repeat (measured: most
 *                  rows in this workspace share one first-message label).
 *
 * A wrong-session render cannot satisfy O3+O4+O5+O6+O6b+O7 simultaneously: the
 * full session id has to travel from the clicked row through the request, the
 * reply, the rendered row count and the rendered text, and back out through the
 * dock's marker — while the host's own per-session previews have to agree.
 *
 * ── CONTENT DIFFERENCE, REPORTED SEPARATELY FROM OWNERSHIP ────────────────
 *
 * Adjacent iterations are compared by digest, and the verdict is a SEPARATE line
 * so a reviewer can see which assertion failed:
 *
 *   D1 the whitespace-normalised transcript digest of iteration i differs from
 *      iteration i-1.
 *   D2 the digest of the FIRST transcript row differs as well — reported as a
 *      SIGNAL (see the third subtlety below), not as a gate.
 *   D3 no bleed: iteration i's rendered text contains no `user_input` text that
 *      is unique to iteration i-1's reply.
 *
 * Three subtleties that would otherwise make this either flaky or dishonest:
 *
 *   - Two sessions can legitimately hold the same conversation (this workspace
 *     really does contain several identical "automation acceptance probe"
 *     sessions). So the host's reply PAYLOAD is hashed too. Identical renders
 *     over byte-identical payloads are `identical-source` — a coincidence in the
 *     host's own data, recorded with a note and never folded into a D1 pass. If
 *     the renders are identical while the payloads DIFFER, that is a FAIL: the
 *     client painted the same pixels for two different sources, which is the
 *     defect this probe exists for.
 *   - Two sessions opened by the SAME prompt have the same first row while the
 *     rest of the transcript differs (measured here: two "automation acceptance
 *     probe" sessions whose unresolved opening message is identical). D2 is
 *     therefore reported as a SIGNAL, not a gate: failing on it would report the
 *     host's data as a client defect. D1 alone decides.
 *   - An explicit `--sessions` list may repeat an id. Two clicks on the SAME row
 *     must render the same content; that pair is recorded as `repeat` and is not
 *     a difference failure.
 *
 * ── DETECTION IS TESTED, NOT ASSUMED ──────────────────────────────────────
 *
 * A probe that only ever sees correct behaviour proves nothing about its own
 * power to notice incorrect behaviour. So the failure this script exists to catch
 * was INJECTED, on the real lane: CDP `Fetch.requestPaused` was enabled on
 * `POST /api/frame`, and the outbound `session_read` frame's nested base64 body
 * was rewritten to carry a DIFFERENT session id before it left the page. The wire
 * then genuinely asked the host about session B while row A was the one clicked.
 * (Script: `scripts/_e2e-evidence/fault-injection-session-read.mjs`, gitignored.)
 *
 * Two measured outcomes (2026-11-14, public lane):
 *
 *   - injected id = the FULL uuid of another session: the viewer rendered THAT
 *     session — title and `_rowViewing_` mark both belonged to the other row, and
 *     the single `session_read_ok` carried the other session's id. Under this
 *     script's rules that iteration fails O3 (no request carrying the clicked
 *     row's short id), O4 (no reply tied to such a request), O7 (the mark names
 *     the wrong session) and O8 (title mismatch).
 *   - injected id = a short/incomplete id: the host refused with `action_error`
 *     and the viewer stayed in its loading state, which fails O4 and R2.
 *
 * Either way the ownership verdict is a check with a demonstrated failure mode,
 * not a claim that the shipped product misbehaves.
 *
 * ── HOW "THE READ-ONLY VIEW WAS ACTUALLY LEFT" IS PROVEN ──────────────────
 *
 * A baseline run reported that closing the viewer "did not demonstrably return to
 * the list". The root cause was measured here, on the real lane, and it is why
 * this probe is shaped the way it is:
 *
 *   `clearViewer()` clears `viewingId`/`viewedEvents` but does NOT clear
 *   `sessionReadReqRef`. A `session_read_ok` that lands AFTER the close still
 *   passes the dispatcher's correlation check and calls `openViewer(...)`, which
 *   re-mounts the viewer. Measured end to end: click → close press at +462 ms →
 *   list restored at +718 ms → the viewer RE-OPENED by itself at +1042 ms with
 *   the full 11-event transcript, and stayed open. A 6 s sleep then samples an
 *   open viewer — exactly the "the close didn't work" the baseline saw. The close
 *   did work; a late reply undid it. That is a real defect behind a measurement
 *   pitfall, so this probe asserts the DEPARTURE instead of sampling it.
 *
 * The sequence, per iteration:
 *
 *   1. wait for a TERMINAL transcript: viewer mounted, transcript box present,
 *      not `Reading this session…`, at least one rendered row.
 *   2. wait for QUIET: QUIET_MS with no new `session_read_ok`, so the reply that
 *      would re-open the viewer has already landed. The outcome is recorded as
 *      `quiet` in the results file — a timeout is data, not a silent skip.
 *   3. RE-SAMPLE the settled state (that is the state the verdict describes) and
 *      press the close button — a real CDP mouse press, the same input the row
 *      click used.
 *   4. require the LEFT state within DEPART_DEADLINE_MS: no close button, no
 *      `_transcript_` box, no `_rowViewing_` marker, the sessions list present
 *      with rows, and the composer back in the DOM.
 *   5. HOLD that left state for HOLD_MS, sampling every POLL_MS. A re-open inside
 *      the hold is a FAIL that records when it happened. Without the hold, one
 *      lucky sample could report "left" while the viewer was coming back.
 *
 * HOLD_MS is derived from the lane rather than picked: 5 s ≈ 2.7 × the public p95
 * RTT (1.82 s), which bounds how long a straggling reply can still apply.
 *
 * ── THE PREFETCH TRAP, AND WHY THE POINTER IS PARKED ──────────────────────
 *
 * Hovering a row arms a 120 ms debounced PREFETCH (`PREFETCH_DELAY_MS`), which
 * issues a second `session_read` for that row and stores the reply in a cache
 * that a later CLICK consumes without any wire traffic. Left alone, that would do
 * two bad things to this probe: it doubles the wire evidence per switch, and a
 * repeated click on the same row would render from the cache with no request to
 * correlate (O3/O4 unverifiable).
 *
 * So the pointer is parked at (4,4) before every press and moved back there
 * immediately after it. `onMouseLeave` then cancels the debounce before it fires,
 * which keeps the cache cold and the wire evidence at exactly one read per
 * switch. That is a measurement-hygiene measure, not an assertion change; and if
 * a rotation still hits a cache-served read (an explicitly repeated id), O3/O4
 * are reported as NOT APPLICABLE with that reason instead of being faked,
 * hard-failed, or quietly dropped.
 *
 * ── LANES ─────────────────────────────────────────────────────────────────
 *
 * The ORIGIN decides the lane, and the origin actually in effect is printed for
 * EVERY iteration from the page itself (`location.origin` at that moment), never
 * from a constant:
 *
 *   public   the frpc endpoint (default http://ht.wwszxc.tax:41533 → local
 *            :3001). This is the lane the acceptance requires, and the default.
 *            Nothing is ever killed or started here — this script does not import
 *            `node:child_process` at all.
 *   control  a loopback origin, permitted ONLY with `--allow-loopback` (or
 *            OWN_ALLOW_LOOPBACK=1), and labelled CONTROL in the banner, in every
 *            table row, and in the results file. It exists to separate a product
 *            defect from a tunnel defect, never to make a run pass.
 *
 * Any other host is REFUSED (exit 2). Without that, a shell-history
 * `APP_ORIGIN=http://localhost:3010` would run a different lane while the report
 * still claimed the frpc path.
 *
 * ── BUDGETS (measured on this lane, 2026-11-14) ───────────────────────────
 *
 *   public RTT                   median 0.8-1.1 s, p95 1.82 s
 *   SPA pair (same-origin)       ~3.0 s   bootstrap → 已连接主机
 *   shell (sidebar + dock)       ~6.3-6.9 s from tab open
 *   session rows visible         ~9.4-9.9 s from tab open
 *   session_read → terminal      0.53 s - 2.62 s over 9 measured reads
 *   close → list restored        0.28 s - 0.30 s (a React commit, no round trip)
 *   late reply that re-opens     ~1.04 s after an early close
 *
 *   BOOT_DEADLINE_MS    60 000  ~10 sequential round trips at p95 on top of the
 *                               confirmed shell; only a dead tunnel exhausts it.
 *   LIST_DEADLINE_MS    40 000  the panel's own retry budget (8 × 2.5 s) plus the
 *                               landing attempt and one round trip.
 *   SWITCH_DEADLINE_MS  25 000  ~20× the slowest observed read (1.24 s worst in
 *                               the 20× probe; 2.62 s here for a 12 KB
 *                               transcript). Still an unambiguous FAIL for a
 *                               viewer that never settles.
 *   QUIET_MS               400  one in-flight reply settling after the terminal
 *                               render. A settle window, not a budget.
 *   QUIET_DEADLINE_MS    8 000  ~4.4× p95 RTT: enough for a straggling reply to
 *                               arrive, short enough that a silent lane is
 *                               reported instead of waited out.
 *   DEPART_DEADLINE_MS  10 000  ~33× the 0.30 s measured departures, which are
 *                               pure state changes on a live page. A viewer that
 *                               never leaves is a hang, not a slow lane.
 *   HOLD_MS              5 000  ≈2.7× p95 RTT (see above).
 *   POLL_MS                250  sampling resolution, not a deadline. Deliberately
 *                               8× finer than 2 s: terminals land at 0.5-2.6 s, so
 *                               a 2 s sampler could only report quantised values
 *                               and would miss the 1.04 s re-open entirely.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/verify-session-ownership.mjs [N] [options]
 *
 *     N                    number of switches (default 20). With --sessions, N is
 *                          ignored: the given list IS the rotation.
 *     --sessions=a,b,c     explicit session ids (short prefixes or full ids), in
 *                          order. Each must exist in the current listing.
 *     --list               print the session rows this probe would rotate
 *                          through, then exit (no clicks)
 *     --allow-loopback     allow a loopback origin, labelled CONTROL
 *     --keep-tab           leave this run's own tab open for inspection
 *     --help
 *
 *   env:
 *     APP_ORIGIN           page origin (default http://ht.wwszxc.tax:41533)
 *     CDP_PORT             Chrome CDP port (default 9444)
 *     OWN_ITERATIONS       default N (20)
 *     OWN_SESSIONS         explicit ids, comma separated (same as --sessions)
 *     OWN_WORKSPACE        substring of a workspace button title to select
 *                          (default `remote_pi`, else the first RUNNING one)
 *     OWN_ALLOW_LOOPBACK   1 = --allow-loopback
 *     OWN_KEEP_TAB         1 = --keep-tab
 *     OWN_RESULT           results JSON path
 *                          (default scripts/_e2e-evidence/session-ownership-<lane>.json)
 *
 *   exit: 0 every assertion passed · 1 at least one assertion FAILED ·
 *         2 the run could not be set up (arguments, lane, CDP, pairing, no rows)
 *
 * ── DRIVER REUSE AND THE ONE THING IT CANNOT DO ───────────────────────────
 *
 * `_cdp.mjs` is the house driver: `evaluate` / `sleep` / `shot` / `EVIDENCE` are
 * imported and used as-is, and the `CDP_PORT` convention is kept (default 9444
 * here, because that is the browser this lane runs in; the driver's own default
 * is 9333).
 *
 * Its `attach()` is NOT used, for one specific reason: it selects the page whose
 * URL contains `APP_ORIGIN`'s host. This Chrome profile keeps a tab open on the
 * SAME origin (measured: target 1D127A2D on .../remote-pi/connect), so which page
 * `attach()` returns depends on target ordering — measured to be a new tab first
 * today, but that is not a contract. If it ever returned the user's tab, this
 * script would navigate and click inside it, which the task forbids. So this
 * probe opens its own tab with `PUT /json/new` and attaches BY TARGET ID; that id
 * is the only thing it ever navigates, clicks or closes.
 *
 * The row click and the close press are real `Input.dispatchMouseEvent`
 * press/release pairs at the element's centre — the same input a person produces,
 * not `.click()` on a DOM node.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────
 *
 *   - Opens its OWN tab and pins it by target id; never attaches to, navigates,
 *     or closes a tab the user already had.
 *   - Closes only the tab it created (unless --keep-tab).
 *   - Never imports `node:child_process`: it cannot spawn or kill anything.
 *   - Never clicks Start / Restart / Stop / Resume: reading is the only product
 *     action it performs.
 *   - Never prints or stores a pairing credential. A pairing is expected to
 *     already exist (loading the SPA from the public origin auto-pairs via the
 *     same-origin /api/bootstrap); if it does not, the run stops with
 *     instructions and no token.
 *   - The results file contains digests, short ids, counts and booleans only: no
 *     transcript text and no message content.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVIDENCE, evaluate, shot, sleep } from "./_cdp.mjs";
import { decodeFrame } from "./_wire.mjs";

/** The public lane this acceptance is about. A default, not a variable. */
const PUBLIC_ORIGIN = "http://ht.wwszxc.tax:41533";

/* --------------------------------------------------------------- budgets -- */

const BOOT_DEADLINE_MS = 60_000;
const LIST_DEADLINE_MS = 40_000;
const SWITCH_DEADLINE_MS = 25_000;
const QUIET_MS = 400;
const QUIET_DEADLINE_MS = 8_000;
const DEPART_DEADLINE_MS = 10_000;
const HOLD_MS = 5_000;
const POLL_MS = 250;

/** Host-index discriminator thresholds (see O6b). */
const PREVIEW_MIN_CHARS = 40;
const PREVIEW_PREFIX_GUARD = 32;

/* ------------------------------------------------------------------- cli -- */

const USAGE = `usage: node scripts/verify-session-ownership.mjs [N] [options]

  N                   switch the visible session N times (default 20)
  --sessions=a,b,c    explicit session ids (short prefixes or full ids), in order
                      (with this flag the given list IS the rotation; N is ignored)
  --list              list the session rows that would be rotated, then exit
  --allow-loopback    allow a loopback origin; the whole run is labelled CONTROL
  --keep-tab          leave this run's own browser tab open
  --help              this text

env:
  APP_ORIGIN          page origin (default ${PUBLIC_ORIGIN})
  CDP_PORT            Chrome CDP port (default 9444)
  OWN_ITERATIONS      default N
  OWN_SESSIONS        explicit ids, comma separated
  OWN_WORKSPACE       substring of a workspace button title to select
  OWN_ALLOW_LOOPBACK  1 = --allow-loopback
  OWN_KEEP_TAB        1 = --keep-tab
  OWN_RESULT          results JSON path

exit: 0 all assertions passed · 1 an assertion failed · 2 could not be set up

This probe asserts READ-ONLY ownership on the web surface (session_read). It does
NOT exercise the mobile session_switch route.`;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const bad = argv.find(
    (a) =>
      a !== "--list" &&
      a !== "--allow-loopback" &&
      a !== "--keep-tab" &&
      !/^\d+$/.test(a) &&
      !a.startsWith("--sessions="),
  );
  if (bad !== undefined) {
    console.error(`unknown argument ${JSON.stringify(bad)}\n\n${USAGE}`);
    process.exit(2);
  }
  const sessionsArg = argv.find((a) => a.startsWith("--sessions="));
  const explicit = (sessionsArg?.slice("--sessions=".length) ?? process.env.OWN_SESSIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const iterRaw = argv.find((a) => /^\d+$/.test(a)) ?? process.env.OWN_ITERATIONS ?? "20";
  const iterations = Number(iterRaw);
  if (explicit.length === 0 && (!Number.isInteger(iterations) || iterations < 1)) {
    console.error(`N must be a positive integer (got ${JSON.stringify(iterRaw)})`);
    process.exit(2);
  }
  return {
    iterations,
    explicit,
    listOnly: argv.includes("--list"),
    allowLoopback: argv.includes("--allow-loopback") || process.env.OWN_ALLOW_LOOPBACK === "1",
    keepTab: argv.includes("--keep-tab") || process.env.OWN_KEEP_TAB === "1",
  };
}

const CLI = parseArgs(process.argv.slice(2));

const trimSlash = (u) => u.replace(/\/+$/, "");
const ORIGIN = trimSlash(process.env.APP_ORIGIN ?? PUBLIC_ORIGIN);
const CDP_PORT = process.env.CDP_PORT ?? "9444";
const CDP = `http://127.0.0.1:${CDP_PORT}`;

/* ------------------------------------------------------------ lane guard -- */

const isLoopbackHost = (hostname) => {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "::0" || h === "0.0.0.0" || /^127\./.test(h);
};

let originUrl;
try {
  originUrl = new URL(ORIGIN);
} catch {
  console.error(`APP_ORIGIN is not a URL: ${JSON.stringify(ORIGIN)}`);
  process.exit(2);
}

const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const IS_PUBLIC_LANE = originUrl.host === PUBLIC_HOST;
const IS_LOOPBACK = isLoopbackHost(originUrl.hostname);

if (!IS_PUBLIC_LANE && !IS_LOOPBACK) {
  console.error(
    `refusing to run: ${ORIGIN} is neither the public endpoint (${PUBLIC_ORIGIN}) nor a\n` +
      `  loopback control lane. The lane is part of what this probe claims, so it will\n` +
      `  not run against a third origin.`,
  );
  process.exit(2);
}
if (!IS_PUBLIC_LANE && !CLI.allowLoopback) {
  console.error(
    `refusing to run: ${ORIGIN} is a loopback CONTROL lane, not the public lane the\n` +
      `  acceptance requires. Re-run with --allow-loopback (or OWN_ALLOW_LOOPBACK=1);\n` +
      `  the output is then labelled CONTROL everywhere.`,
  );
  process.exit(2);
}
const LANE = IS_PUBLIC_LANE ? "public" : "control";

const RESULT_PATH =
  process.env.OWN_RESULT ?? join(EVIDENCE, `session-ownership-${LANE}${CLI.listOnly ? "-list" : ""}.json`);

/* --------------------------------------------------------------- classes -- */

class SetupError extends Error {}

/* ------------------------------------------------------------ dom probes -- */

const SIDEBAR = `[...document.querySelectorAll('aside')].find(a=>/工作区/.test(a.getAttribute('aria-label')||''))`;
/** Expanded dock only: the collapsed rail (`停靠栏（已折叠）`) has no rows. */
const DOCK = `[...document.querySelectorAll('aside')].find(a=>/^停靠栏/.test(a.getAttribute('aria-label')||''))`;
const SESSIONS_SECTION = `document.querySelector('section[aria-label="会话"]')`;

/**
 * The viewer's structural handle: the close button's aria-label.
 *
 * Everything else is read from its OWN element rather than from a regex over a
 * joined string — `textContent` concatenates without separators, so a `\b`-style
 * test on the header's text reports the chip as missing on a viewer that plainly
 * shows it.
 */
const VIEWER_HEAD = `(() => {
  const close = document.querySelector('button[aria-label*="关闭只读会话视图"]');
  return close ? close.parentElement : null;
})()`;

/**
 * The transcript box: a div carrying a CSS-module class that STARTS WITH
 * `_transcript_`.
 *
 * PREFIX, not substring: `_transcriptColumn_`, `_transcriptArea_`,
 * `_transcriptScroll_` and `_transcriptInner_` all contain the substring and
 * would match a loose selector. Exactly one element in this build carries the
 * bare `_transcript_` class, and it exists only while the viewer is mounted.
 */
const T_BOX = `(() => {
  for (const el of document.querySelectorAll('div[class]')) {
    for (const c of (el.classList || [])) if (c.startsWith('_transcript_')) return el;
  }
  return null;
})()`;

/**
 * CHEAP polling sample: no transcript text crosses the CDP boundary, only
 * digests computed in the page. A 12 KB transcript hashes in microseconds;
 * serialising it 100 times per iteration would not.
 */
const LIGHT = `(() => {
  const head = ${VIEWER_HEAD};
  const box = ${T_BOX};
  const sec = ${SESSIONS_SECTION};
  const lis = sec ? [...sec.querySelectorAll('li')] : [];
  let viewedIndex = -1;
  let viewedSid = null;
  for (let i = 0; i < lis.length; i += 1) {
    if (lis[i].querySelector('[class*="_rowViewing_"]') !== null) {
      const age = lis[i].querySelector('[class*="_age_"]');
      const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || '').trim());
      viewedIndex = i;
      viewedSid = m ? m[1] : null;
      break;
    }
  }
  const text = box ? (box.textContent || '') : '';
  let full = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { full ^= text.charCodeAt(i); full = Math.imul(full, 0x01000193) >>> 0; }
  /* The viewer renders exactly one child per event; empty/notice states are <p>. */
  const rows = box ? [...box.children].filter((e) => e.tagName !== 'P') : [];
  const firstText = rows.length > 0 ? (rows[0].textContent || '') : '';
  let first = 0x811c9dc5;
  for (let i = 0; i < firstText.length; i += 1) { first ^= firstText.charCodeAt(i); first = Math.imul(first, 0x01000193) >>> 0; }
  const chip = head ? head.querySelector('[class*="_chip_"]') : null;
  const titleEl = head ? head.querySelector('[class*="_title_"]') : null;
  const resume = head ? [...head.querySelectorAll('button')].find((b) => /resume here|Resuming/i.test(b.textContent || '')) : null;
  const status = box ? box.querySelector('[role="status"]') : null;
  return {
    origin: location.origin,
    viewer: head !== null,
    chip: chip ? (chip.textContent || '').trim() : null,
    title: titleEl ? (titleEl.textContent || '').trim() : null,
    resume: resume !== null,
    box: box !== null,
    loading: /Reading this session/.test(text),
    rows: rows.length,
    len: text.length,
    fullDigest: (full >>> 0).toString(16),
    firstDigest: (first >>> 0).toString(16),
    notice: status ? (status.textContent || '').trim().slice(0, 60) : null,
    viewedIndex,
    viewedSid,
    listRows: lis.length,
    composer: !!document.querySelector('textarea'),
  };
})()`;

/** One detailed snapshot per iteration, after the settled state. */
const FULL = `(() => {
  const box = ${T_BOX};
  const text = box ? (box.textContent || '') : '';
  return { norm: text.replace(/\\s+/g, '') };
})()`;

/**
 * Resolve the row to click AND its viewport coordinates in ONE DOM snapshot.
 *
 * Resolved by the enumerated INDEX when the row at that index still carries the
 * target's short id AND label; otherwise re-resolved among the rows that do.
 * Doing both in one evaluate removes the window in which a re-list could swap the
 * rows under a stale coordinate.
 */
const RESOLVE = (sid, label, preferIndex) => `(() => {
  const sec = ${SESSIONS_SECTION};
  if (!sec) return { err: 'no sessions section' };
  const lis = [...sec.querySelectorAll('li')];
  const wantId = ${JSON.stringify(sid)};
  const wantLabel = ${JSON.stringify(label)};
  const cands = [];
  for (let i = 0; i < lis.length; i += 1) {
    const b = lis[i].querySelector('button[aria-label^="Read session "]');
    if (b === null) continue;
    const age = lis[i].querySelector('[class*="_age_"]');
    const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || '').trim());
    if (m === null || m[1] !== wantId) continue;
    if (b.getAttribute('aria-label').replace(/^Read session /, '') !== wantLabel) continue;
    cands.push(i);
  }
  if (cands.length === 0) return { err: 'row vanished (short id + label no longer in the list)' };
  const preferred = ${Number(preferIndex)};
  const index = cands.includes(preferred) ? preferred : cands[0];
  const btn = lis[index].querySelector('button[aria-label^="Read session "]');
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { err: 'row is not on screen' };
  return { index, candidates: cands.length, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

/** Short id of the row at `index`, for detecting a re-sorted dock mid-iteration. */
const SID_AT = (index) => `(() => {
  const sec = ${SESSIONS_SECTION};
  if (!sec) return null;
  const li = [...sec.querySelectorAll('li')][${Number(index)}];
  if (!li) return null;
  const age = li.querySelector('[class*="_age_"]');
  const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || '').trim());
  return m ? m[1] : null;
})()`;

const CLOSE = `document.querySelector('button[aria-label*="关闭只读会话视图"]')`;

/* --------------------------------------------------------------- helpers -- */

const PARK = { x: 4, y: 4 };

const shortId = (id) => String(id ?? "").split("-")[0];
const normText = (t) => String(t ?? "").replace(/\s+/g, "");
const payloadDigest = (events) =>
  createHash("sha256").update(JSON.stringify(events ?? null)).digest("hex").slice(0, 16);

const leftState = (s) =>
  s !== null &&
  s.viewer === false &&
  s.box === false &&
  s.viewedIndex === -1 &&
  s.listRows > 0 &&
  s.composer === true;

function printTable(header, rows, widths) {
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log("  " + line(header));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log("  " + line(r));
}

function stat(xs) {
  if (xs.length === 0) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  return `min ${s[0]} · median ${s[Math.floor(s.length / 2)]} · max ${s[s.length - 1]}`;
}

/* ------------------------------------------------------------------- cdp -- */

/**
 * Open this run's OWN tab and attach to it BY TARGET ID.
 *
 * Both transports are recorded because which one the lane uses is a property of
 * the deployment, not a choice this probe makes: the direct same-origin path
 * speaks SSE (`/api/events` + `POST /api/frame`), a relay path speaks WebSocket.
 * `decodeFrame` peels the relay envelope for either.
 */
async function attachOwnTab(url) {
  let res;
  try {
    res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  } catch (err) {
    throw new SetupError(
      `CDP is not reachable at ${CDP} (${String(err).slice(0, 120)}); ` +
        `is Chrome running with --remote-debugging-port=${CDP_PORT}?`,
    );
  }
  if (!res.ok) {
    throw new SetupError(
      `could not open a CDP tab (HTTP ${res.status}) via ${CDP}/json/new; ` +
        `is Chrome running with --remote-debugging-port=${CDP_PORT}?`,
    );
  }
  const target = await res.json();
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    sock.addEventListener("open", ok, { once: true });
    sock.addEventListener("error", () => no(new SetupError("the CDP websocket did not open")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const inbound = [];
  const outbound = [];
  /** HTTP status per /api/frame request id, so a dropped frame is auditable. */
  const frameStatus = new Map();
  const frameUrlById = new Map();
  sock.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: ok, reject: no } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) no(new Error(m.error.message));
      else ok(m.result);
      return;
    }
    if (m.method === "Network.eventSourceMessageReceived") {
      const msg = decodeFrame(m.params.data);
      if (msg !== null) inbound.push({ at: Date.now(), msg });
    } else if (m.method === "Network.webSocketFrameReceived") {
      const msg = decodeFrame(m.params.payloadData);
      if (msg !== null) inbound.push({ at: Date.now(), msg });
    } else if (m.method === "Network.requestWillBeSent") {
      const url = m.params.request?.url ?? "";
      if (url.includes("/api/frame")) {
        frameUrlById.set(m.params.requestId, url);
        const msg = decodeFrame(m.params.request.postData ?? "");
        if (msg !== null) outbound.push({ at: Date.now(), msg, requestId: m.params.requestId });
      }
    } else if (m.method === "Network.responseReceived") {
      if (frameUrlById.has(m.params.requestId)) {
        frameStatus.set(m.params.requestId, m.params.response?.status ?? -1);
      }
    } else if (m.method === "Network.loadingFailed") {
      if (frameUrlById.has(m.params.requestId)) {
        frameStatus.set(m.params.requestId, m.params.errorText ?? "failed");
      }
    } else if (m.method === "Network.webSocketFrameSent") {
      const msg = decodeFrame(m.params.payloadData);
      if (msg !== null) outbound.push({ at: Date.now(), msg, requestId: null });
    }
  });
  const send = (method, params = {}) =>
    new Promise((ok, no) => {
      const id = nextId++;
      pending.set(id, { resolve: ok, reject: no });
      sock.send(JSON.stringify({ id, method, params }));
    });

  console.log(`  [TAB] opened own tab ${target.id} (${url})`);
  return { targetId: target.id, sock, send, inbound, outbound, frameStatus };
}

/* ------------------------------------------------------------------ boot -- */

/**
 * Boot to the state the probe needs: paired → app shell → a RUNNING workspace
 * selected → Sessions panel open with rows.
 *
 * The connect page is used first because the same-origin `/api/bootstrap` pairing
 * path runs there and reports `已连接主机`, which gives pairing an observable
 * moment. Without it, an unpaired lane looks like "the shell never mounted".
 */
async function boot(send) {
  await send("Runtime.enable");
  await send("Network.enable"); // before any traffic: SSE/WS frames are not replayed
  await send("Page.enable");
  /*
   * Bring THIS tab to the front. A background tab still runs its JS, so the
   * assertions would hold either way, but the failure screenshots would capture
   * whatever the user had in front instead of the state being reported.
   */
  try {
    await send("Page.bringToFront");
  } catch {
    /* not fatal: only affects screenshots */
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1700,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const t0 = Date.now();
  let paired = false;
  while (Date.now() - t0 < BOOT_DEADLINE_MS) {
    await sleep(1000);
    /* `document.body` is briefly null on a fresh target; guard so the first
       sample cannot throw instead of reporting "not paired yet". */
    const body = await evaluate(send, "(document.body && document.body.textContent) || ''");
    if (typeof body === "string" && /已连接主机/.test(body)) {
      paired = true;
      break;
    }
  }
  if (!paired) {
    throw new SetupError(
      `never paired on ${ORIGIN} within ${BOOT_DEADLINE_MS}ms (no 已连接主机 on the connect page).\n` +
        `  This probe does NOT create a pairing. If this browser profile is not paired to\n` +
        `  ${ORIGIN}, obtain a URI with \`cd server && node dist/index.js pair\` and complete\n` +
        `  the normal pairing flow (the textarea takes the FULL remotepi://pair?... string;\n` +
        `  the separate address field OVERRIDES its r= and must stay EMPTY).\n` +
        `  The token is a credential: nothing about it is printed by this script.`,
    );
  }
  console.log(`  [BOOT] paired in ${Date.now() - t0}ms`);

  await send("Page.navigate", { url: `${ORIGIN}/` });
  while (Date.now() - t0 < BOOT_DEADLINE_MS) {
    await sleep(500);
    if (await evaluate(send, `Boolean(${SIDEBAR} && ${DOCK})`)) break;
  }
  if (!(await evaluate(send, `Boolean(${SIDEBAR} && ${DOCK})`))) {
    throw new SetupError(`app shell (sidebar + dock) never mounted on ${ORIGIN} within ${BOOT_DEADLINE_MS}ms`);
  }
  console.log(`  [BOOT] shell in ${Date.now() - t0}ms`);

  const dockLabel = await evaluate(
    send,
    `(() => { const d = ${DOCK}; return d ? (d.getAttribute('aria-label') || '') : null; })()`,
  );
  if (dockLabel !== "停靠栏") {
    await evaluate(
      send,
      `(() => { const d = ${DOCK}; if (!d) return false; const b = d.querySelector('button'); if (b) b.click(); return true; })()`,
    );
    await sleep(900);
  }

  const want = process.env.OWN_WORKSPACE ?? "remote_pi";
  const picked = await evaluate(
    send,
    `(() => {
      const side = ${SIDEBAR};
      if (!side) return 'no sidebar';
      const running = [...side.querySelectorAll('button')]
        .filter((b) => (b.getAttribute('title') || '').includes(' · 运行中'));
      if (running.length === 0) return 'no running workspace';
      const pref = running.find((b) => (b.getAttribute('title') || '').includes(${JSON.stringify(want)})) ?? running[0];
      pref.click();
      return (pref.getAttribute('title') || '').split(String.fromCharCode(10))[0].slice(0, 80);
    })()`,
  );
  if (typeof picked !== "string" || /^no /.test(picked)) {
    throw new SetupError(
      `${picked}: no RUNNING workspace on ${ORIGIN}. This probe never starts one — starting a\n` +
        `  workspace is a state change on the user's host.`,
    );
  }
  console.log(`  [BOOT] workspace: ${picked}`);

  const liveDeadline = Date.now() + BOOT_DEADLINE_MS;
  let live = false;
  while (Date.now() < liveDeadline) {
    await sleep(1000);
    live =
      (await evaluate(
        send,
        `(() => {
          const side = ${SIDEBAR};
          if (!side) return false;
          const b = [...side.querySelectorAll('button')]
            .find((x) => (x.getAttribute('title') || '').includes(${JSON.stringify(picked.slice(0, 40))}));
          return b ? /· 运行中/.test(b.getAttribute('title') || '') : false;
        })()`,
      )) === true;
    if (live) break;
  }
  if (!live) throw new SetupError(`the workspace ${JSON.stringify(picked)} never reported 运行中`);

  const opened = await evaluate(
    send,
    `(() => {
      const d = ${DOCK};
      if (!d) return 'no dock';
      const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '会话');
      if (!b) return 'no sessions tab';
      b.click();
      return 'opened';
    })()`,
  );
  if (opened !== "opened") throw new SetupError(`sessions panel: ${opened}`);

  const listDeadline = Date.now() + LIST_DEADLINE_MS;
  let rows = -1;
  let lastText = "";
  while (Date.now() < listDeadline) {
    await sleep(POLL_MS * 2);
    const probe = await evaluate(
      send,
      `(() => {
        const s = ${SESSIONS_SECTION};
        return { rows: s ? s.querySelectorAll('li').length : -1, text: s ? (s.textContent || '').slice(0, 300) : '' };
      })()`,
    );
    rows = probe?.rows ?? -1;
    lastText = probe?.text ?? "";
    if (rows > 0) break;
  }
  if (rows <= 0) {
    throw new SetupError(
      `the sessions panel never listed a row within ${LIST_DEADLINE_MS}ms ` +
        `(panel text: ${JSON.stringify(lastText.slice(0, 200))})`,
    );
  }
  console.log(`  [BOOT] ${rows} session rows in ${Date.now() - t0}ms`);
}

/** Enumerate rows: dock index, short id, label, live flag. */
async function listRows(send) {
  const raw = await evaluate(
    send,
    `(() => {
      const s = ${SESSIONS_SECTION};
      if (!s) return null;
      return [...s.querySelectorAll('li')].map((li, index) => {
        const b = li.querySelector('button[aria-label^="Read session "]');
        const age = li.querySelector('[class*="_age_"]');
        const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || '').trim());
        return {
          index,
          shortId: m ? m[1] : null,
          label: b ? b.getAttribute('aria-label').replace(/^Read session /, '') : null,
          live: [...li.querySelectorAll('span')].some((sp) => (sp.textContent || '').trim() === 'live'),
        };
      });
    })()`,
  );
  return Array.isArray(raw) ? raw.filter((r) => r.shortId !== null && r.label !== null) : [];
}

/**
 * Choose the rotation.
 *
 * Distinct NON-LIVE rows, in dock order (the host already sorts newest-first).
 * The live row is excluded: reading it renders the viewer with a `live` badge and
 * no `Resume here`, so O2 could not apply and the "read-only" claim would go
 * untested. An explicit list is honoured as-is — an explicitly requested live row
 * is reported as a failed O2, never silently swapped out.
 *
 * Identity is the ROW INDEX, not the short id: short ids collide in real
 * workspaces (measured here: two rows share `01a1917d`, two share `01a18e73`).
 */
function chooseTargets(rows, count, explicit, notes) {
  if (explicit.length > 0) {
    return explicit.map((want, position) => {
      const hits = rows.filter((r) => r.shortId === want || (want.length > 8 && r.shortId === shortId(want)));
      if (hits.length === 0) throw new SetupError(`--sessions entry ${JSON.stringify(want)} is not in the current listing`);
      if (hits.length > 1) {
        notes.push(
          `--sessions entry ${JSON.stringify(want)} matches ${hits.length} rows (short ids are not unique); ` +
            `row ${hits[0].index} was used.`,
        );
      }
      return { ...hits[0], requested: want, position };
    });
  }
  const pool = rows.filter((r) => r.live !== true);
  if (pool.length === 0) throw new SetupError("no non-live session row to read");
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ ...pool[i % pool.length], position: i });
  if (count > pool.length) {
    notes.push(
      `N=${count} exceeds the ${pool.length} distinct non-live row(s) in this workspace, so the rotation ` +
        `wraps and ${count - pool.length} iteration(s) repeat a row. Ownership is still asserted on every ` +
        `iteration; adjacent-content-difference is reported per pair.`,
    );
  }
  return out;
}

/* ----------------------------------------------------- host session index -- */

/**
 * The host's own per-session index, read from its `session_list_ok` frame.
 *
 * `preview` is the host's first user message for that session id
 * (`listWorkspaceSessions` → `s.firstMessage.slice(0, 200)`), i.e. the host's
 * answer to "what is in session N". That is what makes it usable as an ownership
 * authority independent of the read reply: a transcript containing session A's
 * preview while the click asked for session B is showing A's content, whatever
 * the reply correlation says.
 */
function hostIndex(frames) {
  const lists = frames.filter((x) => x.msg.type === "session_list_ok");
  if (lists.length === 0) return null;
  const latest = lists[lists.length - 1].msg;
  if (!Array.isArray(latest.sessions)) return null;
  return {
    at: lists[lists.length - 1].at,
    sessions: latest.sessions
      .filter((s) => typeof s?.id === "string")
      .map((s) => ({
        shortId: shortId(s.id),
        preview: normText(typeof s.preview === "string" ? s.preview : ""),
        live: s.live === true,
      })),
  };
}

/**
 * Previews that can DISCRIMINATE the target session from every other one.
 *
 * A preview is usable as a negative probe only when it cannot be confused with
 * the target's own first message: long enough to be specific, neither a substring
 * of the target's preview nor a superstring of it, and sharing no long prefix
 * with it. The last rule exists because this workspace is full of near-duplicate
 * prompt families ("创建一个HTML…" sent a dozen times); without it the check would
 * fire on legitimate transcripts that quote a sibling prompt.
 */
function discriminators(index, targetShortId) {
  if (index === null) return { own: null, foreign: [], available: 0 };
  const target = index.sessions.find((s) => s.shortId === targetShortId);
  const own = target !== undefined && target.preview.length >= 8 ? target.preview : null;
  const foreign = [];
  for (const s of index.sessions) {
    if (s.shortId === targetShortId) continue;
    if (s.preview.length < PREVIEW_MIN_CHARS) continue;
    if (own !== null && (own.includes(s.preview) || s.preview.includes(own))) continue;
    if (own !== null && own.slice(0, PREVIEW_PREFIX_GUARD) === s.preview.slice(0, PREVIEW_PREFIX_GUARD)) continue;
    foreign.push(s);
  }
  return { own, foreign, available: index.sessions.length };
}

/* ----------------------------------------------------------- one switch -- */

async function oneIteration(ctx, target, n, prev) {
  const { send, inbound, outbound, frameStatus, hostIdx, clickedBefore, notes } = ctx;
  const rec = {
    n,
    lane: LANE,
    target: { index: target.index, shortId: target.shortId, label: target.label, live: target.live === true },
    clickedIndex: null,
    rowIndexDrift: null,
    origin: null,
    ms: { terminal: null, left: null },
    shown: { index: null, shortId: null },
    requests: { count: 0, fullIds: [], forTargetRow: 0, forOtherSessions: 0 },
    reply: {
      requestFullId: null,
      replyFullId: null,
      inReplyTo: null,
      events: null,
      truncated: null,
      eos: null,
      payloadDigest: null,
      otherReplies: 0,
      otherShortIds: [],
    },
    rendered: { rows: null, len: null, fullDigest: null, firstDigest: null, title: null, chip: null, resume: null },
    content: {
      userTexts: 0,
      missing: 0,
      missingLens: [],
      indexAvailable: 0,
      ownPreview: null,
      foreignCandidates: 0,
      foreignOnScreen: 0,
      sampleForeign: [],
    },
    checks: {},
    failed: [],
    quiet: null,
    hold: { clean: null, reOpenedAt: null, heldFor: null },
    own: "pending",
    diff: "n/a",
    diffNote: null,
    detail: null,
  };
  const failed = rec.failed;

  const requestsBefore = outbound.length;
  const inboundBefore = inbound.length;

  /* Park the pointer off every row (see "THE PREFETCH TRAP"). */
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: PARK.x, y: PARK.y, button: "none" });
  await sleep(80);

  const t0 = Date.now();
  const resolved = await evaluate(send, RESOLVE(target.shortId, target.label, target.index));
  if (resolved === null || typeof resolved !== "object" || resolved.err !== undefined) {
    rec.own = "fail";
    failed.push("R1-row-present");
    rec.detail = `the target row could not be resolved: ${resolved?.err ?? "unknown"}`;
    return rec;
  }
  rec.clickedIndex = resolved.index;
  if (resolved.index !== target.index) {
    /* Informational: a re-list can re-sort the dock between enumeration and
       click, and re-resolving by short id + label is the correct response. */
    rec.rowIndexDrift = { from: target.index, to: resolved.index };
    notes.push(
      `#${n}: the dock re-sorted between enumeration and click (row ${target.index} → ${resolved.index}); ` +
        `the row was re-resolved by short id + label and the click followed it.`,
    );
  }

  /* A real CDP mouse press/release at the row's centre. */
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: resolved.x, y: resolved.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: resolved.x, y: resolved.y, button: "left", clickCount: 1 });
  /*
   * Leave the row IMMEDIATELY, before the 120 ms prefetch debounce fires.
   *
   * `onMouseLeave` cancels the pending prefetch, so this iteration issues exactly
   * one `session_read` and the client's prefetch cache stays cold — otherwise a
   * later click on the same row would render with no request to correlate.
   */
  await sleep(50);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: PARK.x, y: PARK.y, button: "none" });

  /* ---- 1. wait for a terminal transcript ------------------------------- */
  let light = null;
  let terminalAt = null;
  let foreignMark = null;
  while (Date.now() - t0 < SWITCH_DEADLINE_MS) {
    await sleep(POLL_MS);
    light = await evaluate(send, LIGHT);
    if (light === null) continue;
    /*
     * A mark on a row that is neither the target NOR the previous iteration's
     * target is live evidence that the dock is pointing at a third session.
     * Excluding the previous target matters: if the previous iteration failed to
     * leave the viewer, its mark is legitimately still there when this iteration
     * starts, and that failure is already reported by L2/L3 — it must not be
     * re-labelled as cross-talk here.
     */
    if (
      foreignMark === null &&
      light.viewer &&
      light.viewedSid !== null &&
      light.viewedSid !== target.shortId &&
      light.viewedSid !== ctx.prevShortId
    ) {
      foreignMark = { at: Date.now() - t0, index: light.viewedIndex, shortId: light.viewedSid };
    }
    if (light.viewer && light.box && !light.loading) {
      terminalAt = Date.now() - t0;
      break;
    }
  }
  rec.ms.terminal = terminalAt;
  rec.origin = light?.origin ?? null;

  if (terminalAt === null) {
    rec.own = "fail";
    failed.push("R2-terminal-transcript");
    /*
     * Separate the two causes, because they mean different things. A viewer that
     * never finished because NO reply ever arrived is a host/transport stall
     * (`handleSessionRead`'s own timeout is CHAT_TIMEOUT_MS = 600 s, so the UI
     * would have stayed `Reading this session…` for ten minutes). A viewer that
     * received a reply but kept loading is a client rendering defect. The
     * results file carries both counts so the distinction is auditable.
     */
    const repliesSoFar = inbound.slice(inboundBefore).filter((x) => x.msg.type === "session_read_ok").length;
    const requestsSoFar = outbound.slice(requestsBefore).filter((x) => x.msg.type === "session_read").length;
    /*
     * What did the transport do with the frame? `POST /api/frame` returns 204 on
     * acceptance; 409/404 means the server no longer knows this SSE stream id (the
     * client tears the transport down on exactly those two, see sse-transport.ts),
     * and a 5xx means it took the frame and failed. Without this the run can only
     * say "no reply arrived", which is not actionable.
     */
    const postStatuses = outbound
      .slice(requestsBefore)
      .filter((x) => x.msg.type === "session_read")
      .map((x) => ({ sid: shortId(x.msg.session_id), status: x.requestId === null ? "ws" : (frameStatus.get(x.requestId) ?? "unknown") }));
    rec.wireAtDeadline = { requests: requestsSoFar, replies: repliesSoFar, postStatuses };
    rec.detail =
      `the viewer never reached a terminal transcript within ${SWITCH_DEADLINE_MS}ms ` +
      `(${requestsSoFar} session_read request(s), ${repliesSoFar} reply(ies) on the wire` +
      `, POST status ${JSON.stringify(postStatuses.map((p) => p.status))}` +
      `; render = ${light?.len ?? 0} chars` +
      (light?.notice ? `; notice=${JSON.stringify(light.notice)}` : "") + ")";
  }

  /* ---- 2. settle: no reply may still be in flight ---------------------- */
  {
    const deadline = Date.now() + QUIET_DEADLINE_MS;
    let lastCount = -1;
    let stableSince = null;
    rec.quiet = false;
    while (Date.now() < deadline) {
      const replies = inbound.slice(inboundBefore).filter((x) => x.msg.type === "session_read_ok").length;
      if (replies !== lastCount) {
        lastCount = replies;
        stableSince = Date.now();
      } else if (replies >= 1 && Date.now() - (stableSince ?? Date.now()) >= QUIET_MS) {
        rec.quiet = true;
        break;
      }
      await sleep(POLL_MS / 2);
    }
  }

  /* ---- 3. the SETTLED state is what the verdict describes -------------- */
  if (terminalAt !== null) {
    const settled = await evaluate(send, LIGHT);
    if (settled !== null) light = settled;
  }
  const full = terminalAt === null ? null : await evaluate(send, FULL);
  rec.shown = { index: light?.viewedIndex ?? null, shortId: light?.viewedSid ?? null };
  /*
   * Did the LIST move under us?
   *
   * The dock re-lists on its own schedule, and a re-list can re-sort rows. If it
   * did, the index comparison in O7 would fail for a reason that has nothing to
   * do with ownership, so the index half of O7 is reported as not-applicable in
   * that case. The identity half (which session the mark names) is unaffected.
   */
  const sidAtClickedIndex = terminalAt === null ? null : await evaluate(send, SID_AT(resolved.index));
  const listStable = sidAtClickedIndex === target.shortId;
  rec.dock = { markedIndex: light?.viewedIndex ?? null, clickedIndex: resolved.index, listStable };

  const requests = outbound.slice(requestsBefore).filter((x) => x.msg.type === "session_read");
  const replies = inbound.slice(inboundBefore).filter((x) => x.msg.type === "session_read_ok");
  const rowRequests = requests.filter((x) => shortId(x.msg.session_id) === target.shortId);
  const otherRequests = requests.filter((x) => shortId(x.msg.session_id) !== target.shortId);

  /* O4: a reply addressed to the EXACT session id of one of this row's requests. */
  const tied = replies.find((x) =>
    rowRequests.some((r) => r.msg.id === x.msg.in_reply_to && r.msg.session_id === x.msg.session_id),
  );
  const reply = tied?.msg ?? null;
  const otherReplies = replies.filter((x) => shortId(x.msg.session_id) !== target.shortId);

  rec.requests = {
    count: requests.length,
    fullIds: requests.map((x) => x.msg.session_id),
    forTargetRow: rowRequests.length,
    forOtherSessions: otherRequests.length,
  };
  rec.reply = {
    requestFullId: rowRequests[0]?.msg.session_id ?? null,
    replyFullId: reply?.session_id ?? null,
    inReplyTo: reply?.in_reply_to ?? null,
    events: reply?.events?.length ?? null,
    truncated: reply?.truncated ?? null,
    eos: reply?.eos ?? null,
    payloadDigest: reply === null ? null : payloadDigest(reply.events),
    otherReplies: otherReplies.length,
    otherShortIds: otherReplies.map((x) => shortId(x.msg.session_id)),
  };
  rec.rendered = {
    rows: light?.rows ?? null,
    len: light?.len ?? null,
    fullDigest: light?.fullDigest ?? null,
    firstDigest: light?.firstDigest ?? null,
    title: light?.title ?? null,
    chip: light?.chip ?? null,
    resume: light?.resume ?? null,
  };

  const userTexts =
    reply === null
      ? []
      : [
          ...new Set(
            (reply.events ?? [])
              .filter((e) => e.type === "user_input")
              .map((e) => normText(e.text))
              .filter((t) => t.length >= 8),
          ),
        ];
  const renderedNorm = full?.norm ?? "";
  const missing = userTexts.filter((t) => !renderedNorm.includes(t));

  /*
   * O6b: host-index matching.
   *
   * POSITIVE half — the host says session N's first user message is X, so the DOM
   * must show X. That direction cannot be faked by pasting: the host produced X
   * for this id, and the render has to contain it.
   *
   * NEGATIVE half — a foreign session's preview on screen is only evidence of
   * cross-talk when the TARGET's own transcript does not explain it. A transcript
   * that quotes a sibling prompt is legitimate and measured here: the `/mofrl`
   * session contains the pelican-HTML prompt pasted into it, and that prompt is
   * also another session's first message. So a foreign preview counts only if it
   * appears on screen AND is absent from this reply's own text — that is the
   * difference between "the client showed the wrong session" and "the user pasted
   * the same text into two sessions".
   */
  const replyNorm = reply === null
    ? ""
    : normText((reply.events ?? [])
        .map((e) => (typeof e.text === "string" ? e.text : ""))
        .join("\n"));
  const host = discriminators(hostIdx, target.shortId);
  /*
   * O6b's positive half needs the session's FIRST message to be inside the
   * rendered window, and the host can legitimately answer with a WINDOW instead:
   * `session_read` is issued with `limit: 50` (connect-client.tsx
   * SESSION_READ_LIMIT) and the host sets `truncated`/`has_older` when older
   * content exists. Measured on this lane: session `01a19924` answers 27 events
   * with `truncated: true`, and those 27 are the TAIL of the conversation — its
   * first message ("automation acceptance probe", which is what the host reports
   * as `preview`) is simply not in the window. Asserting the preview there would
   * fail a correct read, so the positive half is reported as NOT APPLICABLE for a
   * truncated window and ownership falls to O3/O4/O5/O6/O6c/O7, which all still
   * apply and all still use the wire's own full session id.
   */
  const windowIsWhole = reply === null ? null : reply.truncated !== true && reply.has_older !== true;
  const previewApplicable = host.own !== null && windowIsWhole !== false;
  const ownPreviewOk = previewApplicable ? renderedNorm.includes(host.own) : null;
  const foreignOnScreen = host.foreign.filter((s) => renderedNorm.includes(s.preview));
  const foreignUnexplained = foreignOnScreen.filter(
    (s) => !replyNorm.includes(s.preview) && !replyNorm.includes(s.preview.slice(0, PREVIEW_MIN_CHARS)),
  );
  rec.content = {
    userTexts: userTexts.length,
    missing: missing.length,
    /* Counts, never text: the results file must not carry the user's messages. */
    missingLens: missing.slice(0, 3).map((t) => t.length),
    indexAvailable: host.available,
    previewApplicable,
    windowIsWhole,
    ownPreview: ownPreviewOk,
    foreignCandidates: host.foreign.length,
    foreignOnScreen: foreignOnScreen.length,
    foreignUnexplained: foreignUnexplained.length,
    sampleForeign: foreignUnexplained.slice(0, 3).map((s) => s.shortId),
  };

  /* ---- 4. the ownership verdict --------------------------------------- */
  /*
   * A cache-served read has no request to correlate: the client answered the
   * click from its prefetch cache. That is only possible for a row clicked
   * earlier in this run (the cache is keyed by session id and consumed on use),
   * so for a FIRST click a missing request is a hard failure, and for a repeat
   * click O3/O4 are reported as not-applicable with the reason instead of being
   * faked. Everything else still has to hold, so the render is still checked
   * against the row, the host index and the reply's own content contract.
   */
  const repeatClick = clickedBefore.has(target.index);
  const servedFromCache = rowRequests.length === 0 && reply === null && repeatClick;
  const correlation = servedFromCache ? null : rowRequests.length > 0 && reply !== null;

  const checks = {
    "O1-banner-read-only": light?.chip === "read-only",
    "O2-resume-here-present": light?.resume === true,
    "O3-read-request-for-row": servedFromCache ? null : rowRequests.length > 0,
    "O4-reply-tied-to-exact-id": servedFromCache ? null : reply !== null,
    "O5-row-count-matches-reply":
      reply === null || reply.truncated === true ? null : (light?.rows ?? -1) === (reply.events?.length ?? -2),
    "O6-user-texts-rendered": userTexts.length === 0 ? null : missing.length === 0,
    "O6b-host-index-preview-present": ownPreviewOk,
    "O6c-no-unexplained-foreign-content": host.foreign.length === 0 ? null : foreignUnexplained.length === 0,
    "O7-mark-names-clicked-session": light?.viewedSid === target.shortId,
    "O7b-mark-index-is-clicked-row": listStable ? light?.viewedIndex === resolved.index : null,
    "O8-viewer-title-matches-row": light?.title === target.label,
    "O9-no-read-for-another-session": servedFromCache ? null : otherRequests.length === 0,
  };
  rec.checks = checks;
  if (servedFromCache) {
    rec.cacheServed = true;
    notes.push(
      `#${n}: the click rendered from the client's PREFETCH CACHE (row ${resolved.index} was clicked earlier in ` +
        `this run), so there is no session_read request to correlate. O3/O4/O9 are reported as not-applicable ` +
        `for this iteration; row identity, host-index match and the reply-content contract still decide it.`,
    );
  }
  for (const [name, value] of Object.entries(checks)) if (value === false) failed.push(name);
  if (foreignMark !== null) {
    /*
     * Not a duplicate of O7: that one samples the SETTLED state, while this one
     * caught the mark WHILE polling. A viewer that briefly mounts with another
     * session's mark and then settles on the right one is still a wrong-session
     * render, and a settled-only check would miss it.
     */
    failed.push("R3-no-stray-session-mark-while-loading");
    rec.foreignMark = foreignMark;
  }
  if (correlation === false && !servedFromCache && terminalAt !== null) {
    rec.detail = reply === null
      ? "the rendered transcript has no session_read_ok tied to this row's request on the wire"
      : "no session_read left the page for the clicked row";
  }

  /* ---- 5. leave the read-only view and PROVE it stayed left ----------- */
  const tClose = Date.now();
  const closeBox = await evaluate(
    send,
    `(() => {
      const el = ${CLOSE};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (closeBox === null) {
    failed.push("L1-close-button-present");
    rec.detail =
      "no close button to press: the read-only view cannot be left, so every later switch would be measured over a stale viewer";
  } else {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: closeBox.x, y: closeBox.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: closeBox.x, y: closeBox.y, button: "left", clickCount: 1 });
  }

  let leftAt = null;
  let leftSample = null;
  while (closeBox !== null && Date.now() - tClose < DEPART_DEADLINE_MS) {
    await sleep(POLL_MS);
    leftSample = await evaluate(send, LIGHT);
    if (leftState(leftSample)) {
      leftAt = Date.now() - tClose;
      break;
    }
  }
  rec.ms.left = leftAt;
  if (closeBox !== null && leftAt === null) {
    failed.push("L2-viewer-left");
    rec.detail =
      `the read-only view was still mounted ${DEPART_DEADLINE_MS}ms after the close press ` +
      `(viewer=${leftSample?.viewer} box=${leftSample?.box} viewedIndex=${leftSample?.viewedIndex} ` +
      `listRows=${leftSample?.listRows} composer=${leftSample?.composer})`;
  }

  /* Hold: a late reply must not silently re-open what was just closed. */
  if (closeBox !== null) {
    let reOpenedAt = null;
    const holdStart = Date.now();
    while (Date.now() - holdStart < HOLD_MS) {
      await sleep(POLL_MS);
      const s = await evaluate(send, LIGHT);
      if (s !== null && (s.viewer === true || s.box === true || s.viewedIndex !== -1)) {
        reOpenedAt = Date.now() - holdStart;
        leftSample = s;
        break;
      }
    }
    rec.hold = { clean: reOpenedAt === null, reOpenedAt, heldFor: Date.now() - holdStart };
    if (reOpenedAt !== null) {
      failed.push("L3-stayed-left");
      rec.detail =
        `the read-only view RE-OPENED ${reOpenedAt}ms into the ${HOLD_MS}ms hold after the close ` +
        `(viewer=${leftSample?.viewer} box=${leftSample?.box} viewedIndex=${leftSample?.viewedIndex}): ` +
        `a late session_read_ok undid the close`;
    }
  }

  rec.own = terminalAt === null ? "fail" : failed.length === 0 ? "pass" : "fail";

  /* ---- 6. adjacent content difference --------------------------------- */
  if (prev === null) {
    rec.diff = "n/a";
    rec.diffNote = "first iteration: nothing to compare against";
  } else if (terminalAt === null || prev.ms.terminal === null) {
    /* A loading placeholder is not content: comparing it would manufacture a
       "pass" out of a failed iteration, so the pair is explicitly not compared. */
    rec.diff = "n/a";
    rec.diffNote =
      terminalAt === null
        ? "this iteration never rendered a transcript, so there is nothing to compare"
        : `#${prev.n} never rendered a transcript, so there is nothing to compare`;
  } else if (rec.rendered.fullDigest === null || prev.rendered.fullDigest === null) {
    rec.diff = "n/a";
    rec.diffNote = "one of the two iterations rendered no transcript";
  } else {
    const sameRender = rec.rendered.fullDigest === prev.rendered.fullDigest;
    const sameFirst = rec.rendered.firstDigest === prev.rendered.firstDigest;
    const sameSource =
      rec.reply.payloadDigest !== null &&
      prev.reply.payloadDigest !== null &&
      rec.reply.payloadDigest === prev.reply.payloadDigest;
    const sameRow = rec.target.index === prev.target.index;
    /*
     * Bleed needs a current reply to compare against. With none (a cache-served
     * repeat click) every previous user text would trivially look "bled", so the
     * check is skipped and the render digest comparison decides.
     */
    const bleedFromPrev =
      userTexts.length === 0
        ? 0
        : prev.userTexts.filter((t) => renderedNorm.includes(t) && !userTexts.includes(t)).length;
    rec.diffDetail = { sameRender, sameFirst, sameSource, sameRow, bleedFromPrev };

    if (bleedFromPrev > 0) {
      /* The strongest possible cross-talk evidence: the previous session's own
         text is on screen while this session's reply does not contain it. */
      rec.diff = "fail";
      rec.diffNote =
        `${bleedFromPrev} user text(s) unique to #${prev.n} are on screen while this reply's own texts are not`;
    } else if (!sameRender) {
      /*
       * D1 holds: the two renders differ. D2 (first row differs) is reported as
       * a SIGNAL, not as a gate — two sessions legitimately opened by the same
       * prompt have the same first row, and failing on that would report a data
       * coincidence as a client defect.
       */
      rec.diff = "pass";
      rec.diffNote =
        `render differs from #${prev.n} (${prev.rendered.fullDigest} → ${rec.rendered.fullDigest})` +
        (sameFirst ? `; first row coincides (same opening prompt), rest differs` : "");
    } else if (sameRow) {
      /* The probe was asked to click this same row again (a repeat in an
         explicit --sessions list). Identical output is the CORRECT result here. */
      rec.diff = "repeat";
      rec.diffNote = `same row as #${prev.n} clicked twice on request; identical render is expected`;
    } else if (sameSource) {
      /*
       * Identical pixels over identical source data. The host's own replies hash
       * the same, so the client rendered correctly and nothing could have
       * distinguished the two sessions. Recorded, never counted as a D1 pass.
       */
      rec.diff = "identical-source";
      rec.diffNote =
        `identical to #${prev.n} in BOTH the render and the host reply payload (${rec.reply.payloadDigest}): ` +
        `these two sessions hold the same conversation, so no client could distinguish them`;
    } else {
      rec.diff = "fail";
      rec.diffNote =
        `identical render to #${prev.n} (${rec.rendered.fullDigest}) while the host replies DIFFER ` +
        `(${prev.reply.payloadDigest} vs ${rec.reply.payloadDigest}): the client painted the same ` +
        `content for two different sources`;
    }
  }

  if (rec.detail === null && rec.own === "fail") {
    rec.detail = rec.diff === "fail" ? rec.diffNote : `failed checks: ${failed.join(", ")}`;
  }
  /* Carried forward for the next comparison; stripped before the results file. */
  rec.userTexts = userTexts;
  return rec;
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  console.log(
    [
      `lane: ${LANE}${LANE === "control" ? "  (CONTROL — loopback origin; NOT the public acceptance lane)" : ""}`,
      `origin: ${ORIGIN}  ·  cdp: ${CDP}  ·  switches: ${CLI.explicit.length > 0 ? CLI.explicit.length : CLI.iterations}${CLI.listOnly ? " (list only)" : ""}`,
      `budgets: boot ${BOOT_DEADLINE_MS}ms · list ${LIST_DEADLINE_MS}ms · switch ${SWITCH_DEADLINE_MS}ms ·` +
        ` quiet ${QUIET_MS}ms (<=${QUIET_DEADLINE_MS}ms) · depart ${DEPART_DEADLINE_MS}ms · hold ${HOLD_MS}ms · poll ${POLL_MS}ms`,
      `scope: asserts READ-ONLY ownership (session_read). It does NOT exercise the mobile session_switch route.`,
      `results: ${RESULT_PATH}`,
    ].join("\n"),
  );
  console.log("");

  const notes = [];
  const results = [];
  let conn = null;

  try {
    conn = await attachOwnTab(`${ORIGIN}/remote-pi/connect`);
    const { send, inbound, outbound, frameStatus } = conn;

    await boot(send);

    const rows = await listRows(send);
    if (rows.length === 0) throw new SetupError("the sessions panel rendered no row with an age line");

    if (CLI.listOnly) {
      const dupes = [...new Set(rows.map((r) => r.shortId))].filter(
        (id) => rows.filter((r) => r.shortId === id).length > 1,
      );
      console.log(`\n  ${rows.length} session rows (index  short-id  live  label)`);
      for (const r of rows) {
        console.log(`  ${String(r.index).padStart(5)}  ${r.shortId}  ${r.live ? "live" : "    "}  ${r.label.slice(0, 72)}`);
      }
      if (dupes.length > 0) {
        console.log(
          `\n  NOTE: short ids are not unique in this workspace (${dupes.join(", ")}). Rows are identified by\n` +
            `  INDEX here, and ownership compares full uuids from the wire.`,
        );
      }
      console.log(`\nlist only: ${rows.length} rows, nothing was clicked.`);
      return 0;
    }

    const targets = chooseTargets(rows, CLI.iterations, CLI.explicit, notes);
    console.log(
      `\nrotating ${targets.length} switch(es) over ${new Set(targets.map((t) => t.index)).size} distinct row(s)\n`,
    );

    const ctx = { send, inbound, outbound, frameStatus, hostIdx: null, clickedBefore: new Set(), notes, prevShortId: null };
    let prev = null;
    for (let i = 0; i < targets.length; i += 1) {
      ctx.hostIdx = hostIndex(inbound);
      const rec = await oneIteration(ctx, targets[i], i + 1, prev);
      results.push(rec);
      prev = rec;
      ctx.clickedBefore.add(rec.clickedIndex ?? targets[i].index);
      ctx.prevShortId = rec.target.shortId;

      console.log(
        `  #${String(rec.n).padStart(2)}  row ${String(rec.target.index).padStart(2)} ${rec.target.shortId}  ` +
          `origin=${rec.origin ?? "-"}  shown=${rec.shown.shortId ?? "-"}@${rec.shown.index ?? "-"}  ` +
          `reqs=${rec.requests.forTargetRow}  rows=${rec.rendered.rows ?? "-"}/${rec.reply.events ?? "-"}  ` +
          `digest=${rec.rendered.fullDigest ?? "-"}  ${String(rec.ms.terminal ?? "-").padStart(5)}ms  ` +
          `own=${rec.own}  diff=${rec.diff}${rec.diffNote ? `  (${rec.diffNote})` : ""}`,
      );
      if (rec.own !== "pass" || rec.diff === "fail") {
        if (rec.detail !== null) console.log(`        detail: ${rec.detail}`);
        console.log(`        failed: ${JSON.stringify(rec.failed)}`);
        try {
          await shot(send, `session-ownership-FAIL-i${String(rec.n).padStart(2, "0")}-${rec.target.shortId}`);
        } catch {
          /* a screenshot failure must not mask the assertion result */
        }
      }
    }

    /* ---- summary ------------------------------------------------------- */
    const ownPass = results.filter((r) => r.own === "pass").length;
    const diffApplicable = results.filter((r) => r.diff !== "n/a" && r.diff !== "pending");
    const diffPass = results.filter((r) => r.diff === "pass").length;
    const diffSame = results.filter((r) => r.diff === "identical-source").length;
    const diffRepeat = results.filter((r) => r.diff === "repeat").length;
    const diffFail = results.filter((r) => r.diff === "fail").length;
    const diffNa = results.filter((r) => r.diff === "n/a").length;
    const firstRowCoincided = results.filter((r) => r.diffDetail?.sameFirst === true && r.diff === "pass").length;
    const origins = [...new Set(results.map((r) => r.origin).filter((o) => o !== null))];
    const originMismatch = origins.length !== 1 || origins[0] !== originUrl.origin;
    const notApplicable = [];
    for (const r of results) {
      for (const [k, v] of Object.entries(r.checks)) if (v === null) notApplicable.push(`${k}(#${r.n})`);
    }

    console.log("\nper-iteration evidence");
    printTable(
      ["#", "row", "target", "origin", "shown", "reqs", "rows/reply", "digest", "first", "terminal", "left", "hold", "own", "diff"],
      results.map((r) => [
        r.n,
        r.target.index,
        r.target.shortId,
        (r.origin ?? "-").replace(/^https?:\/\//, ""),
        `${r.shown.shortId ?? "-"}@${r.shown.index ?? "-"}`,
        r.requests.forTargetRow,
        `${r.rendered.rows ?? "-"}/${r.reply.events ?? "-"}`,
        r.rendered.fullDigest ?? "-",
        r.rendered.firstDigest ?? "-",
        `${r.ms.terminal ?? "-"}ms`,
        `${r.ms.left ?? "-"}ms`,
        r.hold.clean ? "clean" : `RE-OPENED@${r.hold.reOpenedAt}ms`,
        r.own,
        r.diff,
      ]),
      [3, 4, 9, 22, 10, 5, 10, 9, 9, 9, 7, 16, 5, 16],
    );

    console.log("\nassertions — reported separately on purpose");
    console.log(`  A. ownership (transcript belongs to the clicked row): ${ownPass}/${results.length} PASS`);
    console.log(
      `  B. content difference (adjacent iterations differ):   ${diffPass}/${diffApplicable.length} PASS` +
        (diffSame > 0 ? ` · ${diffSame} identical-source` : "") +
        (diffRepeat > 0 ? ` · ${diffRepeat} repeat` : "") +
        (diffFail > 0 ? ` · ${diffFail} FAIL` : "") +
        (diffNa > 0 ? ` · ${diffNa} n/a` : ""),
    );
    if (firstRowCoincided > 0) {
      console.log(
        `    of those, ${firstRowCoincided} pair(s) share their FIRST row (same opening prompt) while the rest of ` +
          `the transcript differs — reported as a signal, not a failure`,
      );
    }
    console.log(`  time to a terminal transcript:    ${stat(results.map((r) => r.ms.terminal).filter((v) => typeof v === "number"))} ms`);
    console.log(`  time to leave the read-only view: ${stat(results.map((r) => r.ms.left).filter((v) => typeof v === "number"))} ms`);
    console.log(
      `  origins observed on the page: ${origins.join(" | ") || "NONE"}` +
        (originMismatch ? "  ✗ MISMATCH vs the requested origin" : "  ✓ matches the requested origin on every iteration"),
    );
    if (notApplicable.length > 0) {
      console.log(`  checks not applicable (never counted as pass): ${notApplicable.join(", ")}`);
    }
    console.log(
      `\n  note: this asserts the web READ-ONLY path (session_read). It does NOT exercise the\n` +
        `        mobile session_switch cross-talk route and must not be cited for it.`,
    );
    if (diffSame > 0) {
      notes.push(
        `${diffSame} adjacent pair(s) rendered identical content because the HOST returned the same reply ` +
          `payload for both of them; recorded as identical-source, not as a client defect.`,
      );
    }
    if (diffRepeat > 0) {
      notes.push(
        `${diffRepeat} adjacent pair(s) clicked the SAME row twice on request (an explicit --sessions list ` +
          `repeats an id), so identical content is the correct result there.`,
      );
    }
    for (const nt of notes) console.log(`  note: ${nt}`);

    const exitCode = ownPass === results.length && diffFail === 0 && !originMismatch ? 0 : 1;

    writeFileSync(
      RESULT_PATH,
      JSON.stringify(
        {
          lane: LANE,
          origin: ORIGIN,
          cdp: CDP,
          observedOrigins: origins,
          iterations: results.length,
          distinctRows: new Set(results.map((r) => r.target.index)).size,
          budgets: {
            boot: BOOT_DEADLINE_MS,
            list: LIST_DEADLINE_MS,
            switch: SWITCH_DEADLINE_MS,
            quiet: QUIET_MS,
            quietDeadline: QUIET_DEADLINE_MS,
            depart: DEPART_DEADLINE_MS,
            hold: HOLD_MS,
            poll: POLL_MS,
          },
          assertions: {
            ownership: { passed: ownPass, total: results.length },
            contentDifference: {
              passed: diffPass,
              applicable: diffApplicable.length,
              identicalSource: diffSame,
              repeat: diffRepeat,
              failed: diffFail,
              notApplicable: diffNa,
              firstRowCoincided,
            },
            originMatchedRequest: !originMismatch,
            notApplicableChecks: notApplicable,
          },
          scope:
            "read-only ownership on the web surface (session_read); does NOT cover the mobile session_switch route",
          notes,
          /*
           * Digests, ids, counts and booleans only. Specifically NOT written:
           * the session label (it is the session's first user message), the
           * viewer title (same string), any transcript text, any `user_input`
           * text, and anything derived from a pairing credential. Labels are
           * printed to stdout for review and reduced to their LENGTH here.
           */
          results: results.map(({ userTexts, target, rendered, ...rest }) => {
            void userTexts;
            return {
              ...rest,
              target: {
                index: target.index,
                shortId: target.shortId,
                live: target.live,
                labelLen: target.label.length,
              },
              rendered: {
                rows: rendered.rows,
                len: rendered.len,
                fullDigest: rendered.fullDigest,
                firstDigest: rendered.firstDigest,
                chip: rendered.chip,
                resume: rendered.resume,
                titleLen: typeof rendered.title === "string" ? rendered.title.length : null,
              },
            };
          }),
        },
        null,
        2,
      ),
    );
    console.log(`\nresults: ${RESULT_PATH}`);
    console.log(exitCode === 0 ? "\nRESULT: PASS" : "\nRESULT: FAIL");
    return exitCode;
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`\nsetup failed: ${err.message}`);
    } else {
      console.error(`\nprobe crashed: ${err?.stack ?? err}`);
    }
    return 2;
  } finally {
    if (conn !== null) {
      if (!CLI.keepTab) {
        try {
          await fetch(`${CDP}/json/close/${conn.targetId}`);
          console.log(`  [TAB] closed own tab ${conn.targetId}`);
        } catch {
          /* the tab is already gone */
        }
      } else {
        console.log(`  [TAB] kept own tab ${conn.targetId} (--keep-tab)`);
      }
      try {
        conn.sock.close();
      } catch {
        /* already closed */
      }
    }
  }
}

const code = await main();
process.exit(code);
