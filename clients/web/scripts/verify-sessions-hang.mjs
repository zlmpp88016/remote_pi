// Regression lock for the "Asking the host for this workspace's sessions…" hang
// that never cleared (plan/78 follow-up).
//
// THE DEFECT
// `requestSessions` has a "transport is not connected yet" branch that re-asks
// after SESSIONS_RELIST_MS. Its retries were deliberately NOT charged to
// SESSIONS_RETRY_BUDGET (correct — the host was never asked, so no host budget is
// spent), but nothing else bounded them either. So while the transport stayed
// down, every retry re-entered the branch, set `busy`, and armed another 800ms
// timer — FOREVER — and the panel rendered "Asking…" indefinitely. Worse, the
// Refresh control is `disabled={busy}`, so the user's only escape was a reload.
//
// This runs the real failure: it blocks the SSE frame endpoint, forces a re-list,
// and asserts the panel reaches an honest TERMINAL state instead of spinning.
//
// The assertion is deliberately about the terminal state and not about timing, so
// it cannot pass by the transport happening to recover.
import { setTimeout as delay } from "node:timers/promises";

const CDP = "http://127.0.0.1:9444";
const BASE = "http://127.0.0.1:4124/";

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? " :: " + detail : "")); console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /127\.0\.0\.1:4124/.test(t.url || "")) ?? list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

const DOCK = `[...document.querySelectorAll('aside')].find(a=>a.getAttribute('aria-label')==='停靠栏')`;

async function viewport() {
  await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
}

/** Reads the Sessions panel's state as facts, not prose. */
async function readPanel() {
  return ev(`(() => {
    const d = ${DOCK};
    const t = (d ? d.textContent : '').replace(/\\s+/g, ' ');
    return {
      dock: !!d,
      asking: /正在向主机请求该工作区的会话/.test(t),
      rows: d ? d.querySelectorAll('li').length : 0,
      /* A terminal failure is any fixed client-authored notice. */
      failed: /Could not list this workspace's sessions|Could not load this workspace's sessions/i.test(t),
      refreshDisabled: (() => {
        const b = d ? [...d.querySelectorAll('button')].find(x => /Reload|Refresh/i.test(x.getAttribute('aria-label')||x.title||'')) : null;
        return b ? b.disabled : null;
      })(),
    };
  })()`);
}

console.log("sessions hang — transport stays down\n");

await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await viewport();
await send("Page.navigate", { url: `${BASE}?_v=${Date.now()}` });
await delay(700);
await viewport();
await delay(9000);

/* Open the dock and land on Sessions so the panel is actually mounted. */
await ev(`(() => {
  const c = document.querySelector('[aria-label="停靠栏（已折叠）"]');
  const b = c ? [...c.querySelectorAll('button')].find(x => /显示右侧停靠栏/.test(x.title||'')) : null;
  if (b) b.click();
  return !!b;
})()`);
await delay(2000);
/*
 * Select the workspace this suite measures BEFORE opening the panel.
 *
 * Selection is global app state, and a previous suite `remote_pi` may still be
 * selected with its dock on another tab. Pin it here so the baseline is a
 * property of this run rather than of whatever ran before it.
 */
/*
 * Pin a workspace that ACTUALLY HAS SESSIONS.
 *
 * The precondition below ("it listed sessions while healthy") is only meaningful
 * on a workspace with history. Hard-coding one made this suite depend on which
 * workspace this machine happened to have history for; picking the first running
 * one did the same thing with extra steps. So: try each running workspace, open
 * Sessions, and keep the first that reports rows.
 */
const runningRows = await ev(`(() => [...document.querySelectorAll('button')]
  .map((b) => String(b.getAttribute('title') || ''))
  .filter((t) => t.includes('运行中'))
  .map((t) => t.split(' — ')[0]))()`) ?? [];
let chosen = null;
for (const name of runningRows) {
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => String(x.getAttribute('title')||'').startsWith(${JSON.stringify(name)} + ' —'));
    if (b) b.click();
    return !!b;
  })()`);
  await delay(5000);
  await ev(`(() => {
    const d = ${DOCK};
    const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '会话') : null;
    if (b) b.click();
    return !!b;
  })()`);
  await delay(5000);
  const probe = await readPanel();
  if ((probe?.rows ?? 0) > 0) { chosen = name; break; }
}
if (chosen === null) console.log('  note: no running workspace reported sessions; the precondition check will fail');
await ev(`(() => {
  const d = ${DOCK};
  const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '会话') : null;
  if (b) b.click();
  return !!b;
})()`);
await delay(4000);

const baseline0 = await readPanel();
check("1.1 the Sessions panel is mounted", baseline0?.dock === true, JSON.stringify(baseline0));
check("1.2 it is not stuck before the failure is induced", baseline0?.asking === false, JSON.stringify(baseline0));
/*
 * Wait for the first listing rather than assuming it.
 *
 * The dock mounts before the host answers, and a previous suite may have left the
 * workspace selection elsewhere, so a fixed 4s wait measured whatever happened to
 * be on screen. Polling for the real precondition keeps this suite independent of
 * execution order instead of inheriting someone else's leftovers.
 */
let baseline = baseline0;
for (let i = 0; i < 12 && (baseline?.rows ?? 0) === 0; i += 1) {
  await delay(2000);
  baseline = await readPanel();
}
check("1.3 it actually listed sessions while healthy", (baseline?.rows ?? 0) > 0, String(baseline?.rows));

/*
 * Induce the exact condition: the transport cannot deliver anything, then
 * something asks for a re-list. Before the fix this re-armed an 800ms timer
 * forever, so `asking` stayed true with no way out.
 */
await send("Network.setBlockedURLs", { urls: ["*/api/frame*", "*/api/events*"] });
console.log("  (transport blocked)");
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => String(x.getAttribute('title')||'').startsWith('remote_pi —'));
  if (b) b.click();
  return !!b;
})()`);

/* Wait past the whole not-ready budget (30 x 800ms = 24s) with margin: 18 x 4s = 72s. */
const samples = [];
for (let i = 0; i < 18; i += 1) {
  await delay(4000);
  samples.push(await readPanel());
}
const final = samples[samples.length - 1];
const everStuckWorse = samples.filter((s) => s.asking === true).length;

console.log(`\n  samples (asking / failed): ${samples.map((s) => (s.asking ? "A" : s.failed ? "F" : ".")).join("")}`);

check("2.1 the panel reaches a TERMINAL state (not still asking)", final?.asking === false, JSON.stringify(final));
check("2.2 the terminal state is an honest failure notice", final?.failed === true, JSON.stringify(final));
/*
 * The Refresh control is `disabled={busy || disabledReason !== null}`, and
 * `disabledReason` is set whenever the transport is not connected — which is
 * exactly the induced condition. So the CORRECT observable is that it stays
 * disabled (there is no transport to refresh over) while the PANEL has stopped
 * claiming it is waiting.
 *
 * An earlier version of this check asserted the button was enabled, which was
 * simply wrong about the product: a refresh button that is clickable while the
 * connection is down would be a dead control, not a rescue. The defect being
 * locked here is the endless "Asking…", not the button.
 */
check("2.3 the panel does not pretend a request is outstanding",
  final?.asking === false && final?.failed === true, JSON.stringify(final));
/*
 * The load-bearing one: once the budget is spent the panel must STOP asking.
 *
 * The budget is 30 x 800ms = 24s and the samples span ~48s, so the first ~24s
 * are LEGITIMATELY still asking — that is the point of a retry budget. The
 * regression being locked is the panel that never stops, so the assertion is
 * about the TAIL: the last third of the samples must all be terminal.
 *
 * Asserting on total asking-samples instead measured the budget rather than the
 * bug, and failed on a healthy build.
 */
const tail = samples.slice(Math.floor(samples.length * 2 / 3));
check("2.4 it stops asking by the end instead of re-arming forever",
  tail.every((s) => s.asking === false),
  `tail asking: ${tail.filter((s) => s.asking).length}/${tail.length}`);

/* Restore the transport so the rest of the suite is not poisoned. */
await send("Network.setBlockedURLs", { urls: [] });
await delay(3000);

/*
 * Put the workspace selection back.
 *
 * This run switches to `remote_pi` to force a re-list, and selection is GLOBAL
 * app state: leaving it there made `verify-changes` inspect a workspace whose
 * rows had not loaded yet (`5b.2 inspected 0 paths`). Suites must not have to
 * defend themselves against each other's leftovers.
 */
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => String(x.getAttribute('title')||'').startsWith('4.1f —'));
  if (b) b.click();
  return !!b;
})()`);
await delay(6000);

console.log(`\n${failures.length === 0 ? "verify-sessions-hang: OK" : "verify-sessions-hang: FAIL"} — ${pass}/${pass + failures.length}`);
if (failures.length > 0) { for (const f of failures) console.log("   - " + f); }
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
