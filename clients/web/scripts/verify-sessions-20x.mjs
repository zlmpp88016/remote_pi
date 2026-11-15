/**
 * Does the Sessions panel actually load? — 20 iterations.
 *
 * Each iteration is the full user path, from nothing:
 *   1. make the lane ready (LOCAL: restart the daemon · PUBLIC: never touch it)
 *   2. reload the page (no cached sessions in memory)
 *   3. select a RUNNING workspace
 *   4. open the Sessions tab and time how long until it reaches a terminal
 *      state: a row list, or an error notice
 *   5. PUBLIC only: click one row and require the READ-ONLY viewer to reach a
 *      terminal transcript state that still belongs to the row that was clicked
 *
 * Anything still saying "Asking the host for this workspace's sessions…" at the
 * deadline is a FAILURE, and that is the exact bug being chased.
 *
 * ── LANES ──────────────────────────────────────────────────────────────────
 *
 * The ORIGIN — not a flag — decides the lane:
 *
 *   loopback host   → LOCAL lane, exactly as before. The script owns the daemon
 *                     on RP_PORT and restarts it every iteration so every run
 *                     reproduces a cold start.
 *
 *   anything else   → PUBLIC lane (e.g. the frpc endpoint
 *                     `http://ht.wwszxc.tax:41533` → local 127.0.0.1:3001). That
 *                     daemon is supervisor-managed and belongs to the user, so
 *                     this script MUST NOT kill, stop or start anything. The
 *                     guarantee is structural, not a convention:
 *                       1. `node:child_process` is imported LAZILY, inside the
 *                          local-only helpers. On the public lane it is never
 *                          imported, so the process holds no API that could
 *                          spawn or kill anything.
 *                       2. Those helpers are additionally guarded: they throw if
 *                          called while the script does not own the daemon.
 *                       3. `RP_MANAGE_DAEMON=1` on a non-loopback origin is
 *                          REFUSED at startup (exit 2) — the lane cannot be
 *                          talked into destroying its own host.
 *                     The per-iteration "step 1" becomes a read-only HTTP probe
 *                     of the origin, so a dead tunnel fails loudly instead of
 *                     being papered over by a restart.
 *
 * The public lane also runs on its OWN browser tab (opened through CDP), so it
 * never navigates away a tab the user already had open.
 *
 * ── WHAT THE PUBLIC LANE DOES *NOT* CLAIM ─────────────────────────────────
 *
 * Clicking a row on the web surface issues `session_read` — a server-side
 * READ-ONLY transcript read that does not switch the live session (see
 * clients/web/src/client/connect-client.tsx handleSessionRead, and
 * session-list.tsx's "no per-row switch control" comment). So the assertion
 * added here is: read-only banner present, terminal transcript reached, viewer
 * title still the clicked row's label, and the LIVE marker unmoved. This is NOT
 * a reproduction of the mobile session_switch cross-talk — that path is not
 * reachable from this surface and is out of scope for this script.
 *
 * Usage: node scripts/verify-sessions-20x.mjs [iterations] [--dry-run] [--help]
 *
 * Env:
 *   RP_ORIGIN        page + API origin      (default http://127.0.0.1:$RP_PORT)
 *   RP_CDP           Chrome CDP base URL    (default http://127.0.0.1:9444)
 *   RP_PORT          local daemon port      (default 4124)
 *   RP_MANAGE_DAEMON auto | 1 | 0           (default auto: manage iff loopback)
 *   RP_RESULT        results JSON path      (default /tmp/sessions-20x[-public].json)
 *   RP_DRY_RUN       1 = same as --dry-run
 *
 * Defaults are the historical values, so `node scripts/verify-sessions-20x.mjs`
 * (a.k.a. `npm run verify:sessions`) behaves exactly as it always did.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* Derived from this file, not hardcoded: `SERVER` is only used as the cwd of the
   LOCAL lane's supervisord spawn, and a hardcoded absolute path would silently
   point at a stale checkout if the worktree moved. scripts/ → web/ → clients/ → repo. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SERVER = join(REPO, "server");

/* ------------------------------------------------------------------ lane -- */

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes("--dry-run") || process.env.RP_DRY_RUN === "1";
const HELP = ARGV.includes("--help") || ARGV.includes("-h");

const USAGE = `usage: node scripts/verify-sessions-20x.mjs [iterations] [--dry-run] [--help]

  iterations   positive integer (default 20)
  --dry-run    print the resolved lane/origin/CDP/deadlines and probe both
               endpoints once, then exit WITHOUT touching anything (no tab is
               opened, nothing is killed or started, no results file is written)

env:
  RP_ORIGIN         page + API origin (default http://127.0.0.1:$RP_PORT)
  RP_CDP            Chrome CDP base URL (default http://127.0.0.1:9444)
  RP_PORT           local daemon port (default 4124)
  RP_MANAGE_DAEMON  auto|1|0 (default auto: manage iff RP_ORIGIN is loopback)
  RP_RESULT         results JSON path (default /tmp/sessions-20x{,-public}.json)
  RP_DRY_RUN        1 = same as --dry-run

lanes:
  loopback RP_ORIGIN      LOCAL  — may kill/start the daemon on RP_PORT
  non-loopback RP_ORIGIN  PUBLIC — read-only: never kills, never starts, never
                                   imports node:child_process`;

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}

/*
 * Strict argv.
 *
 * An unrecognised token used to be IGNORED, which meant `verify-sessions-20x
 * abc` silently fell back to "20 iterations" — and on the LOCAL lane that means
 * 20 daemon kill/restart cycles nobody asked for. A typo must stop the run, not
 * arm it.
 */
const badArg = ARGV.find((a) => a !== "--dry-run" && a !== "--help" && a !== "-h" && !/^\d+$/.test(a));
if (badArg !== undefined) {
  console.error(`unknown argument ${JSON.stringify(badArg)}\n\n${USAGE}`);
  process.exit(2);
}
const ITER_ARG = ARGV.find((a) => /^\d+$/.test(a));
const ITERATIONS = Number(ITER_ARG ?? 20);
if (!Number.isInteger(ITERATIONS) || ITERATIONS < 1) {
  console.error(`iterations must be a positive integer (got ${JSON.stringify(ITER_ARG)})\n\n${USAGE}`);
  process.exit(2);
}

const trimSlash = (url) => url.replace(/\/+$/, "");

function parseUrl(raw, what) {
  try {
    return new URL(raw);
  } catch {
    console.error(`${what} is not a URL: ${JSON.stringify(raw)}`);
    process.exit(2);
  }
}

const PORT = Number(process.env.RP_PORT ?? 4124);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`RP_PORT is not a port number: ${JSON.stringify(process.env.RP_PORT)}`);
  process.exit(2);
}
const ORIGIN = trimSlash(process.env.RP_ORIGIN ?? `http://127.0.0.1:${PORT}`);
const CDP = trimSlash(process.env.RP_CDP ?? "http://127.0.0.1:9444");
const ORIGIN_URL = parseUrl(ORIGIN, "RP_ORIGIN");
parseUrl(CDP, "RP_CDP");

/**
 * Is this host the machine we are running on?
 *
 * Only these spellings mean "local". Everything else — including a LAN name, a
 * tunnel hostname, or the machine's own public IP — is treated as a REMOTE
 * daemon we do not own, which is the safe direction to be wrong in.
 */
function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "ip6-localhost" ||
    h === "0.0.0.0" ||
    /^127\./.test(h)
  );
}

const LOOPBACK = isLoopbackHost(ORIGIN_URL.hostname);
const LANE = LOOPBACK ? "local" : "public";

const MANAGE_MODE = String(process.env.RP_MANAGE_DAEMON ?? "auto").toLowerCase();
if (!["auto", "1", "0", "true", "false", "on", "off", "yes", "no"].includes(MANAGE_MODE)) {
  console.error(
    `RP_MANAGE_DAEMON must be auto|1|0 (got ${JSON.stringify(process.env.RP_MANAGE_DAEMON)})`,
  );
  process.exit(2);
}
const FORCE_MANAGE = ["1", "true", "on", "yes"].includes(MANAGE_MODE);
const FORCE_READONLY = ["0", "false", "off", "no"].includes(MANAGE_MODE);

/*
 * The public lane can never be asked to manage a daemon.
 *
 * This is the one configuration that would be genuinely dangerous: `kill` the
 * listener of a supervisor-managed daemon and start a second one on top of it.
 * Refusing loudly at startup means a reviewer cannot reach the destructive path
 * even by setting the wrong env var in a shell history.
 */
if (FORCE_MANAGE && !LOOPBACK) {
  console.error(
    `refusing to run: RP_MANAGE_DAEMON=1 requires a loopback origin, but RP_ORIGIN is ${ORIGIN}.\n` +
      `  The daemon behind ${ORIGIN_URL.host} is supervisor-managed; killing or restarting it from a\n` +
      `  verification script would take the user's host down. Unset RP_MANAGE_DAEMON to run this\n` +
      `  lane read-only.`,
  );
  process.exit(2);
}
const MANAGES_DAEMON = LOOPBACK && !FORCE_READONLY;

/*
 * On the LOCAL lane the port we KILL and the port we PROBE must be the same.
 *
 * They are two separate knobs (RP_PORT for `netstat`/`taskkill`, RP_ORIGIN for
 * the browser and the readiness fetch). Left free to disagree, a shell history
 * with RP_ORIGIN=http://127.0.0.1:3010 would kill whatever holds 4124 and then
 * wait on a listener it just killed — a destructive typo, so it is refused.
 */
if (MANAGES_DAEMON) {
  const originPort = Number(ORIGIN_URL.port || (ORIGIN_URL.protocol === "https:" ? 443 : 80));
  if (originPort !== PORT) {
    console.error(
      `refusing to run: RP_ORIGIN is ${ORIGIN} but RP_PORT is ${PORT}.\n` +
        `  The LOCAL lane would kill the :${PORT} listener and then probe :${originPort}.\n` +
        `  Set RP_PORT=${originPort}, or unset RP_ORIGIN to use the port-derived default.`,
    );
    process.exit(2);
  }
}

/* ------------------------------------------------------------- deadlines -- */

/*
 * Every number below is derived from a measurement, and the public ones are
 * derived from the PUBLIC lane's measurements rather than copied from the local
 * lane. Reusing local timings here would either hide a real hang (too long) or
 * report the funnel itself as a product defect (too short).
 *
 * Measured on this host (2026-11-14, frpc ht.wwszxc.tax:41533 → 127.0.0.1:3001):
 *   - public RTT         median 0.8-1.1s, p95 1.82s   (baseline probes, 6 samples)
 *   - local RTT          ~3ms
 *   - Pi cold boot       13.7s
 *   - GET / over frpc    1.6-3.0s for the 1941-byte SPA shell (5 samples)
 *   - GET /assets/*.js   2.5-4.0s for the 617KB bundle
 *   - session_read       ~0.8s terminal (10/10 smoke), 0.4-1.3s range across runs
 *   - sessions list      0.40-0.42s to rows on this lane (46 rows)
 */

/** LOCAL: a cold start imports the SDK. Unchanged — the public lane never starts one. */
const START_TIMEOUT_MS = 60_000;

/**
 * How long the lane may take to become READY.
 *
 * LOCAL: the cold-start budget above.
 * PUBLIC: nothing is started, so this only bounds a dead tunnel. The shell
 * answered in 2.56s cold; 45s is ~17x that, which a congested frpc link can eat,
 * and beyond it the lane is simply down and the run must say so instead of
 * spending every iteration on a timeout.
 */
const READY_TIMEOUT_MS = MANAGES_DAEMON ? START_TIMEOUT_MS : 45_000;

/**
 * How long the connect page may take to report a live host.
 *
 * LOCAL: 40s, unchanged — it had to cover a daemon the script itself had just
 * killed and restarted.
 * PUBLIC: the daemon is already up, so the boot term disappears and what is left
 * is the SPA boot chain over a 1.1s-RTT link. That chain is ~10 SEQUENTIAL round
 * trips (document, bundle, assets, same-origin /api/bootstrap, SSE open,
 * host_hello, room join, location_*), i.e. ~10 x p95 1.82s = 18.2s on top of the
 * local 40s → 58.2s, rounded to 60s. Not an arbitrary doubling: one p95 RTT per
 * sequential step.
 */
const PAIR_DEADLINE_MS = LANE === "public" ? 60_000 : 40_000;

/**
 * How long to wait before selecting a workspace.
 *
 * LOCAL: the historical fixed 5s settle after the post-pair navigation.
 * PUBLIC: poll for the SIDEBAR + DOCK to exist, bounded by the pair deadline
 * (the shell is what the navigation was for; a fixed sleep either wastes a
 * second countdown or samples the launcher).
 */
const SHELL_SETTLE_MS = LANE === "public" ? PAIR_DEADLINE_MS : 0;

/**
 * How long a RUNNING workspace may take to show its live marker.
 *
 * LOCAL: 45s — sized for the respawn the script itself triggered.
 * PUBLIC: 30s = 2 x the 13.7s Pi boot, for the case where a workspace is
 * mid-boot when the iteration starts, plus RTT slack. Nothing is being restarted
 * here, so the local 45s has no basis on this lane.
 */
const LIVE_DEADLINE_MS = LANE === "public" ? 30_000 : 45_000;

/**
 * A terminal state must be reached this fast, or the run counts as stuck.
 *
 * LOCAL: 30s, unchanged.
 * PUBLIC: the panel's OWN retry path has to fit inside this deadline, or the script
 * calls a panel stuck while it is still legitimately retrying. Its budget is
 * SESSIONS_RETRY_BUDGET 8 extra attempts, each bounded by SESSIONS_LIST_TIMEOUT_MS
 * 2.5s; under this lane's p95 RTT of 1.82s those attempts mostly DO time out at
 * 2.5s while their reply is still in flight, so the retries cost ~8 x 2.5s = 20s,
 * and the attempt that finally lands adds its own 2.5s window plus one round trip
 * (~4.3s) → ~24.3s. The remaining margin covers a session_list issued while the
 * workspace's Pi is mid-boot (13.7s measured) but not yet answering, which the
 * room legitimately waits out. 40s is still a hard FAIL for a panel that never
 * reaches a terminal state — the client's own watchdog is 150s, an order of
 * magnitude looser, so this is the stricter of the two.
 */
const TERMINAL_DEADLINE_MS = LANE === "public" ? 40_000 : 30_000;

/**
 * How long a clicked row may take to reach a terminal READ-ONLY transcript.
 *
 * PUBLIC only. `session_read` is a disk read on the host plus one reply frame;
 * the client's own timeout for it is CHAT_TIMEOUT_MS = 600s, which is far too
 * loose to notice a stall, so the bound has to come from measurement.
 *
 * Measured on this lane: 0.41-1.24s to a terminal transcript across 40+ observed
 * reads (400ms polling; the polling step is what sets the floor). The budget is
 * therefore ~20x the slowest observed read: enough for several p95 round trips
 * plus a frame carrying a whole large transcript (a 13.4k-char transcript was
 * measured), and still an unambiguous FAIL for a viewer that never settles.
 */
const READ_TERMINAL_DEADLINE_MS = 25_000;

const RESULT_PATH =
  process.env.RP_RESULT ??
  (LANE === "public" ? "/tmp/sessions-20x-public.json" : "/tmp/sessions-20x.json");

/* --------------------------------------------------------------- banner -- */

/**
 * Observable proof that this process cannot spawn or kill anything.
 *
 * `process.moduleLoadList` lists every module the runtime has actually LOADED,
 * so on the read-only lane it is an observation of the running process rather
 * than a claim about the source: if `node:child_process` is absent there, no
 * code path in this run could have called `spawn` or `execFile`. Printed before
 * and after the run.
 */
function childProcessLoaded() {
  /* The runtime records e.g. `NativeModule child_process` and
     `NativeModule internal/child_process`; match the word, not a path prefix, so
     the detector cannot report "not loaded" while it is. Verified both ways: a
     bare `node -e` shows [], the same process after `import()` shows them. */
  return (process.moduleLoadList ?? []).some((m) => /\bchild_process$/.test(m));
}

function auditLines() {
  return [
    `lane: ${LANE}${LOOPBACK ? "" : " (non-loopback origin — remote/supervisor-managed daemon)"}`,
    `origin: ${ORIGIN}  ·  cdp: ${CDP}  ·  local port: ${PORT}`,
    MANAGES_DAEMON
      ? `local daemon management: ENABLED — each iteration kills the :${PORT} listener and cold-starts server/dist/bin/supervisord.js --direct`
      : `local daemon management: SKIPPED — no taskkill, no supervisord spawn${LOOPBACK ? " (RP_MANAGE_DAEMON=0, loopback origin)" : " (supervisor-managed daemon)"} · node:child_process loaded=${childProcessLoaded()}`,
    `deadlines: ready ${READY_TIMEOUT_MS}ms · pair ${PAIR_DEADLINE_MS}ms · live ${LIVE_DEADLINE_MS}ms · sessions-terminal ${TERMINAL_DEADLINE_MS}ms${
      LANE === "public" ? ` · session-read-terminal ${READ_TERMINAL_DEADLINE_MS}ms` : ""
    }`,
    `iterations: ${ITERATIONS}${DRY_RUN ? " (dry run)" : ""}  ·  results: ${RESULT_PATH}`,
  ];
}

console.log(auditLines().join("\n"));
console.log("");

if (DRY_RUN) {
  /* Read-only look at the two endpoints so the audit is actionable, then stop.
     Nothing is navigated, clicked, killed or written. */
  const probe = async (label, url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      console.log(`${label}: HTTP ${r.status} in ${Date.now() - t0}ms`);
    } catch (err) {
      console.log(`${label}: unreachable (${String(err).slice(0, 120)})`);
    }
  };
  await probe("origin GET /", `${ORIGIN}/`);
  await probe("cdp GET /json/version", `${CDP}/json/version`);
  process.exit(0);
}

/* ---------------------------------------------------------------- daemon -- */

/**
 * The ONLY door to process control.
 *
 * On the public lane this throws before importing `node:child_process`, so
 * there is no spawn/kill capability in the process at all — a future refactor
 * that calls one of the helpers below cannot silently resurrect the destructive
 * behaviour, it aborts with the reason.
 */
async function localProcessApi() {
  if (!MANAGES_DAEMON) {
    throw new Error(
      `refusing to manage processes: this run does not own the daemon on ${ORIGIN}` +
        (LOOPBACK ? " (RP_MANAGE_DAEMON=0)" : " (supervisor-managed daemon)"),
    );
  }
  return import("node:child_process");
}

async function portPids() {
  const { execFileSync } = await localProcessApi();
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    return [...out.matchAll(new RegExp(`:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "g"))].map((m) =>
      Number(m[1]),
    );
  } catch {
    return [];
  }
}

async function stopDaemon() {
  const { execFileSync } = await localProcessApi();
  for (const pid of await portPids()) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 40; i += 1) {
    if ((await portPids()).length === 0) return true;
    await sleep(250);
  }
  return false;
}

async function startDaemon() {
  const { spawn } = await localProcessApi();
  await stopDaemon();
  const out = spawn("node", ["dist/bin/supervisord.js", "--direct"], {
    cwd: SERVER,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  out.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(400);
    // A plain GET: /api/bootstrap needs a nonce cookie, so probing it would
    // always fail. Any HTTP answer at all proves the listener is up.
    try {
      await fetch(`${ORIGIN}/`, { redirect: "manual" });
      await sleep(1200);
      if ((await portPids()).length > 0) return { ok: true, ms: START_TIMEOUT_MS - (deadline - Date.now()) };
    } catch {
      /* not up yet */
    }
  }
  return { ok: false };
}

/**
 * Step 1 for whichever lane we are on.
 *
 * LOCAL keeps the historical restart. PUBLIC is an HTTP probe and nothing else:
 * the daemon is the user's, already running, and its liveness is the only thing
 * this script is entitled to observe.
 */
async function prepareLane() {
  if (MANAGES_DAEMON) return startDaemon();

  const t0 = Date.now();
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    try {
      const res = await fetch(`${ORIGIN}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status > 0) return { ok: true, ms: Date.now() - t0, skipped: true, status: res.status };
    } catch {
      /* tunnel not answering yet */
    }
    await sleep(1000);
  }
  return {
    ok: false,
    skipped: true,
    detail: `${ORIGIN}/ never answered within ${READY_TIMEOUT_MS}ms (lane probe only — nothing was restarted)`,
  };
}

/* ------------------------------------------------------------------- CDP -- */

/** Our own tab on the public lane, so the user's windows are left alone. */
let ownTargetId = null;

async function listTargets() {
  return (await (await fetch(`${CDP}/json/list`)).json());
}

async function openOwnTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!res.ok) {
    throw new Error(
      `could not open a CDP tab (HTTP ${res.status}) via ${CDP}/json/new; is Chrome running with --remote-debugging-port?`,
    );
  }
  const target = await res.json();
  ownTargetId = target.id;
  console.log(`  [TAB] opened ${target.id} at ${url}`);
  return target;
}

/**
 * Close the tab this script opened, if any.
 *
 * Only ever called on a tab whose id this process created. Leaving them open
 * would accumulate one live SSE subscription per iteration against the host, and
 * a reused document would carry the previous iteration's socket state into the
 * next one — both are noise in a measurement whose whole point is "from
 * nothing". A close failure is not fatal: the run's verdict does not depend on
 * it.
 */
async function closeOwnTab() {
  if (ownTargetId === null) return;
  const id = ownTargetId;
  ownTargetId = null;
  try {
    await fetch(`${CDP}/json/close/${id}`);
  } catch {
    /* the browser is gone or the tab already closed */
  }
}

/**
 * Which page target to drive.
 *
 * LOCAL: the historical pick — a tab already on this origin, else the first page
 * (that is what the local lane has always done, and it is how a developer's
 * hand-opened tab gets reused).
 *
 * PUBLIC / read-only: a tab THIS script opened. Attaching to an arbitrary page
 * would run every probe against a document the script never navigated — and
 * navigating the user's own tab away is not ours to do.
 */
async function pickTarget() {
  if (MANAGES_DAEMON) {
    const targets = await listTargets();
    const page =
      targets.find(
        (t) => t.type === "page" && new RegExp(`${PORT}|127\\.0\\.0\\.1`).test(t.url || ""),
      ) ?? targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target in Chrome");
    return page;
  }
  const pages = (await listTargets()).filter(
    (t) => t.type === "page" && !String(t.url || "").startsWith("chrome-extension://"),
  );
  const mine = ownTargetId === null ? null : pages.find((t) => t.id === ownTargetId);
  return mine ?? openOwnTab(`${ORIGIN}/remote-pi/connect`);
}

async function connect() {
  const page = await pickTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let seq = 1;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(String(msg.params?.exceptionDetails?.exception?.description ?? "").slice(0, 120));
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = seq++;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 160) };
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { ws, send, evaluate, exceptions };
}

const SIDEBAR = `[...document.querySelectorAll('aside')].find(a=>/工作区/.test(a.getAttribute('aria-label')||''))`;
const DOCK = `[...document.querySelectorAll('aside')].find(a=>/^停靠栏/.test(a.getAttribute('aria-label')||''))`;

/** Terminal-state probe for the Sessions panel. */
/*
 * Two probe tokens are lane-conditional ON PURPOSE, because on the LOCAL lane
 * they must stay byte-for-byte what they were:
 *
 *   asking  the shipped panel sentence is 正在向主机请求该工作区的会话. The extra
 *           spellings are only useful on the public lane if a future build words
 *           it differently; adding them here would also make a never-resolving
 *           panel take the full deadline to FAIL instead of failing on the first
 *           sample. That is a change to local behaviour, so it stays public-only.
 *
 *   empty   the original expression was /该工作区没有会话/, but the rendered copy is
 *           “该工作区还没有会话。”, so it never matched: `empty` was unreachable and
 *           the "wait through an empty list" branch below was DEAD CODE. The
 *           public lane gets the working spelling (so a transient empty render is
 *           waited out and reported as `empty`, not `unknown`); the LOCAL lane
 *           keeps the original expression. The PASS CONDITION is `rows` either way.
 */
const ASKING_RE =
  LANE === "public" ? "/正在向主机请求该工作区的会话|正在询问主机|Talking to the host/" : "/正在向主机请求该工作区的会话/";
const EMPTY_RE = LANE === "public" ? "/该工作区没有会话|该工作区还没有会话/" : "/该工作区没有会话/";

const PROBE = `(() => {
  const d = ${DOCK};
  if (!d) return { state: 'no-dock' };
  /* textContent, not innerText: this app's font applies ligatures that mangle innerText. */
  const text = d.textContent || '';
  const asking = ${ASKING_RE}.test(text);
  /* Rows are the ONLY proof the list loaded, so they are checked FIRST. Testing
     the sentences first made a loaded list report as 'empty' whenever the
     workspace happened to have zero rows, which hid the difference between
     "the host answered with nothing" and "nothing ever arrived". */
  const rows = [...d.querySelectorAll('li')].length;
  if (rows > 0) return { state: 'rows', rows };
  if (asking) return { state: 'asking' };
  if (/无法加载/.test(text)) return { state: 'error' };
  if (/须正在运行|未运行/.test(text)) return { state: 'not-running' };
  if (${EMPTY_RE}.test(text)) return { state: 'empty' };
  return { state: 'unknown', head: text.split(String.fromCharCode(10)).slice(6, 10).join(' | ') };
})()`;

/**
 * Which session the dock says is LIVE, identified by its SHORT ID.
 *
 * Read from the row's own `live` badge and its own age line (`01a1b6e5 · 6 天前`),
 * not from any client state, so it is an observation of the surface. Compared by
 * id rather than by label because labels repeat (31 of 46 rows in the measured
 * workspace share one first-message label), which would make a label comparison
 * pass even if the live session had actually moved.
 */
const LIVE_ID = `(() => {
  const d = ${DOCK};
  if (!d) return null;
  const li = [...d.querySelectorAll('li')].find((e) =>
    [...e.querySelectorAll('span')].some((s) => (s.textContent || '').trim() === 'live'));
  if (!li) return null;
  const age = li.querySelector('[class*="_age_"]');
  const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || '').trim());
  return m ? m[1] : null;
})()`;

/**
 * Terminal-state probe for the READ-ONLY viewer (public lane).
 *
 * Anchored on the close button's aria-label — a stable contract of this surface —
 * and then on the transcript box, identified by its CSS-module class prefix
 * `_transcript_`. No other surface in this build uses a class with that prefix
 * (`_transcriptArea_` / `_transcriptScroll_` / `_transcriptInner_` /
 * `_transcriptColumn_` do not contain `_transcript_`), so with the viewer mounted
 * the match is unambiguous.
 *
 * Returns a digest rather than the transcript text: enough to compare two reads,
 * nothing about the user's conversation copied into a results file.
 */
const READ_PROBE = `(() => {
  const close = document.querySelector('button[aria-label*="关闭只读会话视图"]');
  if (!close) return { state: 'no-viewer' };
  const head = close.parentElement;
  /*
   * The banner is read from its OWN chip element, not from a whitespace regex
   * over the header's textContent. textContent concatenates without separators
   * ("read-onlyautomation acceptance probe"), so a \\b-style test on the joined
   * string reports the chip as missing on a viewer that plainly shows it.
   */
  const chip = head ? head.querySelector('[class*="_chip_"]') : null;
  const liveBadge = head ? head.querySelector('[class*="_liveBadge_"]') : null;
  const titleEl = head ? head.querySelector('[class*="_title_"]') : null;
  let box = null;
  for (const el of document.querySelectorAll('div[class]')) {
    if ([...(el.classList || [])].some((c) => c.startsWith('_transcript_'))) { box = el; break; }
  }
  const text = box ? (box.textContent || '') : '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  const status = box ? box.querySelector('[role="status"]') : null;
  const kids = box ? [...box.children] : [];
  return {
    state: 'viewer',
    readOnly: chip !== null && (chip.textContent || '').trim() === 'read-only',
    live: liveBadge !== null,
    chip: chip === null ? null : (chip.textContent || '').trim(),
    title: titleEl ? (titleEl.textContent || '').trim() : null,
    loading: /Reading this session…/.test(text),
    notice: status ? (status.textContent || '').trim().slice(0, 80) : null,
    events: kids.filter((e) => e.tagName !== 'P').length,
    box: box !== null,
    len: text.length,
    digest: hash >>> 0,
  };
})()`;

/** Terminal state of a read: `loading`/`no-viewer` are NOT terminal.
 *
 * `empty` IS terminal here, unlike the LIST rule above. A named session file that
 * the host read successfully and that contains no messages is a real answer;
 * the list's empty-is-a-miss rule exists because a freshly respawned Pi answers
 * an empty list before its index exists, which cannot happen to one file read.
 */
function readState(probe) {
  if (!probe || probe.state !== "viewer") return "no-viewer";
  if (probe.notice) return "error";
  if (probe.loading) return "loading";
  if (probe.events === 0) return "empty";
  return "events";
}

async function oneIteration(n) {
  const started = await prepareLane();
  if (!started.ok) {
    return {
      n,
      phase: started.skipped === true ? "lane" : "daemon",
      ok: false,
      detail: started.detail ?? "daemon never answered",
    };
  }

  /*
   * The tab is opened inside `connect()`, which can fail AFTER the tab exists
   * (a CDP websocket that will not open, a stale /json/new target). Closing it
   * here means a failed iteration cannot leak a live SSE subscription into the
   * next one, which is exactly the kind of leftover that makes an intermittent
   * measurement look like a product defect.
   */
  let conn;
  try {
    conn = await connect();
  } catch (err) {
    if (!MANAGES_DAEMON) await closeOwnTab();
    throw err;
  }
  const { ws, send, evaluate, exceptions } = conn;
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${ORIGIN}/remote-pi/connect` });

    /* Wait for pairing, then for the workspace rows to arrive. */
    const bootDeadline = Date.now() + PAIR_DEADLINE_MS;
    let paired = false;
    let silentHost = false;
    while (Date.now() < bootDeadline) {
      await sleep(1000);
      const body = await evaluate(`document.body.innerText`);
      if (typeof body === "string" && /已连接主机/.test(body)) {
        paired = true;
        break;
      }
      /*
       * LOCAL keeps the historical predicate (either sentence means the
       * launcher got an answer). PUBLIC requires the CONNECTED sentence: the
       * stale sentence means the relay is open but the host is not answering,
       * which on that lane is a real failure and must not be mistaken for a
       * successful pair.
       */
      if (typeof body === "string" && /主机无响应/.test(body)) {
        if (MANAGES_DAEMON) {
          paired = true;
          break;
        }
        silentHost = true;
        break;
      }
    }
    if (!paired) {
      return {
        n,
        phase: "pair",
        ok: false,
        detail: silentHost ? "host connected but silent (主机无响应)" : "never paired",
      };
    }

    /* The connect page hands off to the app shell once the pairing is stored.
     * Navigating explicitly is what makes the SIDEBAR and the DOCK exist at all —
     * without it every probe ran against the launcher, which has neither. */
    await send("Page.navigate", { url: `${ORIGIN}/` });
    if (SHELL_SETTLE_MS === 0) {
      await sleep(5000);
    } else {
      /* Public: poll instead of guessing a duration — the shell is what the
         navigation is FOR, and an RTT of 1.1s makes a fixed sleep a coin flip. */
      const shellDeadline = Date.now() + SHELL_SETTLE_MS;
      let shell = false;
      while (Date.now() < shellDeadline) {
        await sleep(500);
        shell = (await evaluate(`Boolean(${SIDEBAR} && ${DOCK})`)) === true;
        if (shell) break;
      }
      if (!shell) return { n, phase: "shell", ok: false, detail: "app shell (sidebar + dock) never mounted" };
    }
    await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });

    /* Pick a workspace the catalog reports as running: a stopped one is gated by
       `disabledReason` and would never exercise the list at all. */
    const pickOnce = () => evaluate(`(() => {
      const side = ${SIDEBAR};
      if (!side) return 'no sidebar';
      const rows = [...side.querySelectorAll('button')]
        .filter((b) => (b.getAttribute('title') || '').includes(' · 运行中'));
      if (rows.length === 0) return 'no running workspace';
      // Prefer the workspace that actually HAS sessions on disk: an empty
      // workspace would let an empty list masquerade as a successful load.
      const preferred = rows.find((b) => /remote_pi/.test(b.getAttribute('title') || '')) ?? rows[0];
      preferred.click();
      return (preferred.getAttribute('title') || '').split('\\n')[0].slice(0, 60);
    })()`);

    let picked = await pickOnce();
    if (LANE === "public" && (typeof picked !== "string" || /^no /.test(picked))) {
      /*
       * Public only: the catalog may still be filling after the shell mounts, so
       * re-ask for the same deadline instead of failing on the first sample. No
       * Start is ever clicked — starting a workspace is a state change on the
       * user's host, which this lane must not make.
       */
      const pickDeadline = Date.now() + LIVE_DEADLINE_MS;
      while (Date.now() < pickDeadline) {
        await sleep(1000);
        picked = await pickOnce();
        if (typeof picked === "string" && !/^no /.test(picked)) break;
      }
      if (typeof picked !== "string" || /^no /.test(picked)) {
        const seen = await evaluate(`(() => {
          const side = ${SIDEBAR};
          if (!side) return [];
          return [...side.querySelectorAll('button')]
            .map((b) => (b.getAttribute('title') || '').slice(0, 80))
            .filter((t) => t.includes(' · '))
            .slice(0, 8);
        })()`);
        return { n, phase: "select", ok: false, detail: `${picked} (public lane never starts a workspace; rows: ${JSON.stringify(seen)})` };
      }
    }
    if (typeof picked !== "string" || /^no /.test(picked)) {
      return { n, phase: "select", ok: false, detail: String(picked) };
    }

    await sleep(3000);
    /*
     * Wait for the CHOSEN workspace to actually be live before opening the tab.
     *
     * In the LOCAL lane the daemon was just restarted, so every workspace has to
     * come back up. A fixed 3s sleep was measuring the tail of that startup: the
     * tab was opened while the room had no list yet, so the panel legitimately
     * showed its empty state and the iteration looked like a failure that had
     * nothing to do with the thing under test. Poll the sidebar for this
     * workspace's live marker instead of guessing a duration.
     */
    const liveDeadline = Date.now() + LIVE_DEADLINE_MS;
    let live = false;
    while (Date.now() < liveDeadline) {
      await sleep(1000);
      live = (await evaluate(`(() => {
        const side = ${SIDEBAR};
        if (!side) return false;
        const b = [...side.querySelectorAll('button')]
          .find((x) => (x.getAttribute('title') || '').includes(${JSON.stringify(String(picked).slice(0, 40))}));
        if (!b) return false;
        return /· 运行中/.test(b.getAttribute('title') || '');
      })()`)) === true;
      if (live) break;
    }
    if (!live) return { n, phase: "live", ok: false, detail: "workspace never went live", workspace: picked };
    const opened = await evaluate(`(() => {
      const d = ${DOCK};
      if (!d) return 'no dock';
      const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '会话');
      if (!b) return 'no sessions tab';
      b.click();
      return 'opened';
    })()`);
    if (opened !== "opened") return { n, phase: "open", ok: false, detail: String(opened) };

    const t0 = Date.now();
    let last = { state: "asking" };
    let sawEmpty = false;
    while (Date.now() - t0 < TERMINAL_DEADLINE_MS) {
      await sleep(400);
      last = (await evaluate(PROBE)) ?? { state: "probe-failed" };
      /*
       * An EMPTY list is NOT terminal for this measurement.
       *
       * Right after a daemon restart the workspace's Pi is up (the catalog says
       * "running") but its session index has not been rebuilt yet, so the first
       * `session_list` legitimately answers with zero rows and the panel shows
       * "No sessions in this workspace yet.". Treating that as the end state
       * recorded ~2s and reported a broken panel, when the same workspace shows
       * 11 rows a moment later. Keep waiting through it and remember that it
       * happened: a run that ends on `empty` after the full deadline is a real
       * miss, a run that ends on `rows` is a pass.
       */
      if (last.state === "empty") {
        sawEmpty = true;
        continue;
      }
      if (last.state !== "asking") break;
    }
    const ms = Date.now() - t0;

    /* ROWS is the only state that proves the list actually loaded. "empty" and
       "error" are terminal too, but an empty workspace would let a broken list
       pass as a success, so they are reported separately and counted as a
       miss for the purpose of this measurement. */
    const rowsOk = last.state === "rows";
    const result = {
      n,
      phase: "done",
      ok: rowsOk,
      ms,
      state: last.state,
      probe: JSON.stringify(last).slice(0, 200),
      rows: last.rows ?? 0,
      workspace: picked,
      head: last.head ?? null,
      daemonMs: started.ms ?? null,
      skippedManagement: started.skipped === true,
      exceptions: exceptions.length,
      sawEmpty,
    };

    /*
     * READ-ONLY PATH (public lane only).
     *
     * Clicking a row here issues `session_read`, so the surface that must be
     * verified is the read-only viewer: it has to reach a terminal transcript,
     * keep showing the row that was clicked, and leave the LIVE marker alone.
     * `rowsOk` alone says nothing about any of that.
     */
    if (LANE === "public") {
      const read = await probeReadOnly(evaluate);
      Object.assign(result, {
        readState: read.state,
        readMs: read.ms,
        readEvents: read.events ?? 0,
        readLen: read.len ?? 0,
        readDigest: read.digest ?? null,
        readTitle: read.title ?? null,
        readTarget: read.targetLabel ?? null,
        readTargetShortId: read.targetShortId ?? null,
        readViewedShortId: read.viewedShortId ?? null,
        readTitleUnique: read.targetUnique ?? null,
        readOnlyBanner: read.readOnly === true,
        readChip: read.chip ?? null,
        liveStable: read.liveStable,
        liveBefore: read.liveBefore ?? null,
        liveAfter: read.liveAfter ?? null,
        readOk: read.ok,
        readDetail: read.detail ?? null,
      });
      result.ok = rowsOk && read.ok === true;
      if (read.ok !== true) result.phase = "read-only";
    }

    return result;
  } finally {
    ws.close();
    /* Read-only lane: the tab is OURS, so it is also ours to close. Without this
       every iteration leaves an open SSE subscription behind and the next
       iteration's pair window competes with it for the host's connection slots. */
    if (!MANAGES_DAEMON) await closeOwnTab();
  }
}

/**
 * Click one row and require the READ-ONLY viewer to settle.
 *
 * OWNERSHIP is asserted on two independent, discriminating facts:
 *
 *   • the dock marks the row it is VIEWING (`_rowViewing_`), and that row's own
 *     short session id must be the id of the row this function clicked. Row
 *     LABELS are not unique in practice (measured: 31 of 46 rows in this
 *     workspace share one first-message label), so a label-only comparison
 *     could not tell two rows apart and would pass a wrong-session read.
 *   • the viewer's own title must equal the clicked row's label.
 *
 * The clicked row is the FIRST non-live row whose label is unique (so the title
 * comparison also discriminates); when the workspace has no such row the first
 * non-live row is used and `targetUnique:false` is reported rather than the
 * check being silently weakened — the id comparison still discriminates there.
 */
async function probeReadOnly(evaluate) {
  const liveBefore = await evaluate(LIVE_ID);

  const pick = await evaluate(`(() => {
    const d = ${DOCK};
    if (!d) return { rows: 0 };
    const READ = (li) => li.querySelector('button[aria-label^="Read session "]');
    const rows = [...d.querySelectorAll('li')]
      .map((li, index) => {
        const b = READ(li);
        if (!b) return null;
        const label = b.getAttribute('aria-label').replace(/^Read session /, '');
        const live = [...li.querySelectorAll('span')].some((s) => (s.textContent || '').trim() === 'live');
        const age = li.querySelector('[class*="_age_"]');
        const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || "").trim());
        return { index, label, live, shortId: m ? m[1] : null };
      })
      .filter(Boolean);
    if (rows.length === 0) return { rows: 0 };
    const counts = {};
    for (const r of rows) counts[r.label] = (counts[r.label] || 0) + 1;
    const dead = rows.filter((r) => !r.live);
    const unique = dead.find((r) => counts[r.label] === 1);
    const chosen = unique || dead[0] || rows[0];
    return {
      rows: rows.length,
      index: chosen.index,
      label: chosen.label,
      live: chosen.live,
      shortId: chosen.shortId,
      unique: counts[chosen.label] === 1,
    };
  })()`);
  if (!pick || pick.rows === 0) {
    return { ok: false, state: "no-rows", liveStable: false, detail: "no session row to read" };
  }

  /* Clicked by INDEX, not by label: labels repeat, so a label lookup can hit a
     different row than the one that was measured. */
  const clicked = await evaluate(`(() => {
    const d = ${DOCK};
    if (!d) return 'no dock';
    const btns = [...d.querySelectorAll('button[aria-label^="Read session "]')];
    const b = btns[${Number(pick.index)}];
    if (!b) return 'row-vanished (index ${Number(pick.index)} of ' + btns.length + ')';
    b.scrollIntoView({ block: 'center' });
    b.click();
    return 'clicked';
  })()`);
  if (clicked !== "clicked") {
    return { ok: false, state: "click-failed", liveStable: false, targetLabel: pick.label, detail: String(clicked) };
  }

  const t0 = Date.now();
  let probe = null;
  let state = "no-viewer";
  while (Date.now() - t0 < READ_TERMINAL_DEADLINE_MS) {
    await sleep(400);
    probe = (await evaluate(READ_PROBE)) ?? { state: "probe-failed" };
    state = readState(probe);
    if (state !== "loading" && state !== "no-viewer") break;
  }
  const ms = Date.now() - t0;

  /* Which row does the dock say is being VIEWED? The surface's own marker, read
     back after the click — never the id this script asked for. */
  const viewed = await evaluate(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const row = d.querySelector('[class*="_rowViewing_"]');
    if (!row) return null;
    const age = row.querySelector('[class*="_age_"]');
    const m = /^([0-9a-f]{8})/.exec(((age && age.textContent) || "").trim());
    const b = row.querySelector('button[aria-label^="Read session "]');
    return { shortId: m ? m[1] : null, label: b ? b.getAttribute('aria-label').replace(/^Read session /, '') : null };
  })()`);
  const liveAfter = await evaluate(LIVE_ID);

  const terminal = state === "events" || state === "empty" || state === "error";
  const ownerOk =
    probe !== null &&
    probe.state === "viewer" &&
    probe.title === pick.label &&
    (pick.shortId === null || (viewed !== null && viewed.shortId === pick.shortId));
  const readOnlyOk = probe !== null && probe.readOnly === true;
  /*
   * A read must not switch the live session: if the marker moved, this path went
   * through session_switch and the whole premise of the probe is wrong.
   *
   * `null` before the click is NOT treated as "nothing to check": the harness has
   * just waited for this workspace to report 运行中, so a missing `live` badge is
   * itself a surface defect and must not silently satisfy the assertion.
   */
  const liveObservable = liveBefore !== null;
  const liveStable = liveObservable && liveBefore === liveAfter;

  return {
    ok: terminal && ownerOk && readOnlyOk && liveStable,
    state,
    ms,
    events: probe?.events,
    len: probe?.len,
    digest: probe?.digest,
    title: probe?.title,
    readOnly: probe?.readOnly,
    chip: probe?.chip ?? null,
    liveStable,
    liveBefore,
    liveAfter,
    targetLabel: pick.label,
    targetShortId: pick.shortId,
    targetUnique: pick.unique,
    viewedShortId: viewed?.shortId ?? null,
    detail:
      terminal
        ? !ownerOk
          ? `read belongs to ${JSON.stringify(viewed?.shortId ?? null)}/${JSON.stringify(probe?.title)} but ${JSON.stringify(pick.shortId)}/${JSON.stringify(pick.label)} was clicked`
          : !readOnlyOk
            ? `read-only banner absent (chip=${JSON.stringify(probe?.chip ?? null)}): this is not the session_read surface`
            : !liveStable
              ? liveObservable
                ? `live marker moved ${JSON.stringify(liveBefore)} → ${JSON.stringify(liveAfter)} (a read must not switch)`
                : "no live badge on any row: the LIVE marker this check depends on is not rendered"
              : null
        : state === "no-viewer"
          ? "read-only viewer never mounted (click did not reach session_read)"
          : "transcript never left the loading state",
  };
}

/* ------------------------------------------------------------------ main -- */

const results = [];
for (let i = 1; i <= ITERATIONS; i += 1) {
  let r;
  try {
    r = await oneIteration(i);
  } catch (err) {
    r = { n: i, ok: false, phase: "exception", detail: String(err).slice(0, 200) };
  }
  results.push(r);
  const tag = r.ok === true ? "OK  " : "FAIL";
  const detail =
    r.ok === true
      ? `${String(r.ms).padStart(5)}ms ${r.state}${r.rows ? ` (${r.rows} rows)` : ""}${
          LANE === "public"
            ? ` · read ${r.readState}${r.readEvents ? ` (${r.readEvents} events)` : ""} in ${r.readMs}ms · owner ${r.readTitleUnique === false ? "(shared label)" : "ok"} · live ${r.liveStable ? "unmoved" : "MOVED"}`
            : ""
        }`
      : `${r.phase}: ${r.detail ?? r.state} rows=${r.rows} head=${JSON.stringify(r.head)}`;
  console.log(`${tag} #${String(i).padStart(2)} ${detail}`);
}

const passed = results.filter((r) => r.ok === true).length;
const stuck = results.filter((r) => r.state === "asking");
const times = results.filter((r) => typeof r.ms === "number").map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => (times.length === 0 ? 0 : times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]);
const stat = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 2))], max: sorted[sorted.length - 1] };
};

console.log(`\n${passed}/${results.length} iterations reached a terminal state`);
if (times.length > 0) {
  console.log(`time to sessions: min ${times[0]}ms · median ${pct(50)}ms · p90 ${pct(90)}ms · max ${times[times.length - 1]}ms`);
}
console.log(`stuck on "Asking…": ${stuck.length}`);
if (LANE === "public") {
  const readResults = results.filter((r) => typeof r.readState === "string");
  const readPassed = readResults.filter((r) => r.readOk === true).length;
  const readTimes = readResults.filter((r) => typeof r.readMs === "number").map((r) => r.readMs);
  console.log(
    `read-only path (session_read): ${readPassed}/${readResults.length} reached a terminal transcript owned by the clicked row, live marker unmoved`,
  );
  if (readTimes.length > 0) {
    const s = stat(readTimes);
    console.log(`time to read-only transcript: min ${s.min}ms · median ${s.median}ms · max ${s.max}ms`);
  }
  console.log(
    `note: this asserts the web READ-ONLY path; it does NOT exercise the mobile session_switch cross-talk route.`,
  );
}
console.log(`lane: ${LANE} · origin ${ORIGIN} · cdp ${CDP} · local daemon management ${MANAGES_DAEMON ? "ENABLED" : "SKIPPED"}${MANAGES_DAEMON ? "" : ` · node:child_process loaded=${childProcessLoaded()}`}`);
writeFileSync(
  RESULT_PATH,
  JSON.stringify({ lane: LANE, origin: ORIGIN, cdp: CDP, port: PORT, managesDaemon: MANAGES_DAEMON, childProcessLoaded: childProcessLoaded(), deadlines: { ready: READY_TIMEOUT_MS, pair: PAIR_DEADLINE_MS, live: LIVE_DEADLINE_MS, terminal: TERMINAL_DEADLINE_MS, read: LANE === "public" ? READ_TERMINAL_DEADLINE_MS : null }, results }, null, 2),
);
console.log(`results: ${RESULT_PATH}`);
if (passed !== results.length) process.exit(1);
