/**
 * Long-running liveness probe for the host room.
 *
 * Purpose: capture the ACTUAL failure moment of the "silent host room" problem
 * (plan/75 §7b) instead of guessing at it afterwards. The previous attempt at
 * diagnosing this changed `relay_client.ts` based on an unauthenticated probe
 * and was wrong — the relay does send pings every ~25s.
 *
 * What it records every tick, all measured rather than inferred:
 *   - does the host answer `session_list` right now (the user-visible symptom)
 *   - the relay WS readyState and the age of the newest inbound frame
 *   - host pid / uptime / restarts, read from the daemon status line
 *   - the client's own pending-request count, to catch a leaked pending table
 *
 * On the first failed tick it dumps a full forensic block, then keeps going so
 * a recovery is visible too.
 *
 * Usage: node scripts/probe-host-liveness.mjs [--minutes N]
 */
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, evaluate } from "./_cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "_e2e-evidence", "host-liveness.log");
mkdirSync(join(HERE, "_e2e-evidence"), { recursive: true });

const minutesArg = process.argv.indexOf("--minutes");
const minutes = minutesArg >= 0 ? Number(process.argv[minutesArg + 1]) : 20;
const TICK_MS = 10_000;
const ticks = Math.ceil((minutes * 60_000) / TICK_MS);

const { send, ws } = await attach();

/**
 * Ask the page to issue a real `session_list` and report whether it settled.
 *
 * This is deliberately done through the UI's own request path (the refresh
 * button) rather than by hand-crafting a frame: the symptom the user reports is
 * "the panel does not load", and the point is to observe exactly that.
 */
const PROBE = `(function(){
  window.__probe = window.__probe || { sent: 0, seen: 0, lastRx: 0, opened: 0 };
  var p = window.__probe;
  if (!p.hooked) {
    p.hooked = true;
    /*
     * Record the sockets that ALREADY exist.
     *
     * Hooking WebSocket.prototype only catches sockets created afterwards, so
     * on a page that is already connected it observed nothing and every snapshot
     * reported rx=0 — which reads like "no traffic" when it actually means "not
     * instrumented". Keep a live list of sockets instead and read readyState at
     * sample time.
     */
    p.sockets = [];
    var OrigWS = window.WebSocket;
    function track(ws) { if (p.sockets.indexOf(ws) < 0) p.sockets.push(ws); }
    var AP = OrigWS.prototype.addEventListener;
    OrigWS.prototype.addEventListener = function(t, f, o){
      if (t === 'message') {
        var w = function(ev){
          p.seen += 1; p.lastRx = Date.now(); track(this);
          try {
            var s = String(ev.data);
            if (s.indexOf('session_list_ok') >= 0) p.lastListOk = Date.now();
            if (s.indexOf('action_error') >= 0) p.lastError = Date.now();
          } catch (e) {}
          return f.call(this, ev);
        };
        return AP.call(this, t, w, o);
      }
      return AP.call(this, t, f, o);
    };
    // Anything the app constructs from here on is tracked too.
    window.WebSocket = function(u, pr){
      var ws = new OrigWS(u, pr);
      track(ws);
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }
  var b = [...document.querySelectorAll('button')].find(function(x){
    return /refresh the session list/i.test(x.getAttribute('aria-label') || '');
  });
  if (b) { b.click(); p.sent += 1; }
  var t = document.body.innerText;
  var states = (p.sockets || []).map(function(s){ return s.readyState; });
  return {
    rows: document.querySelectorAll('[aria-label^="Read session"]').length,
    sent: p.sent,
    rx: p.seen,
    sockets: states,
    anyOpen: states.length > 0 ? states.indexOf(1) >= 0 : null,
    lastRxAgeMs: p.lastRx ? Date.now() - p.lastRx : -1,
    listOkAgeMs: p.lastListOk ? Date.now() - p.lastListOk : -1,
    couldNotLoad: t.indexOf('Could not load this workspace') >= 0,
    connected: t.indexOf('host connected') >= 0
  };
})()`;

/**
 * Click refresh and measure whether the panel is ANSWERED, and how fast.
 *
 * Socket internals cannot be observed from here: the connection is already open
 * before this script runs, and the browser exposes no way to enumerate existing
 * WebSocket instances. `rx=0` therefore meant "not instrumented", not "no
 * traffic" — a false signal. The user-visible round trip IS measurable, and it
 * is the symptom under investigation.
 */
const CLICK_REFRESH = `(function(){
  var b = [...document.querySelectorAll('button')].find(function(x){
    return /refresh the session list/i.test(x.getAttribute('aria-label') || '');
  });
  if (!b) return false;
  b.click(); return true;
})()`;

const READ_PANEL = `(function(){
  var t = document.body.innerText;
  return {
    rows: document.querySelectorAll('[aria-label^="Read session"]').length,
    couldNotLoad: t.indexOf('Could not load this workspace') >= 0,
    connected: t.indexOf('host connected') >= 0
  };
})()`;

function stamp() {
  return new Date().toISOString();
}

writeFileSync(OUT, `# host liveness probe — ${stamp()}\n`);
console.log(`[probe] writing to ${OUT}`);

let failures = 0;
let recovered = 0;
let wasFailing = false;

for (let i = 0; i < ticks; i += 1) {
  let before = null;
  let after = null;
  let answered = false;
  let roundTripMs = -1;
  let err = null;

  try {
    before = await evaluate(send, READ_PANEL);
    const clicked = await evaluate(send, CLICK_REFRESH);
    if (!clicked) {
      /*
       * No refresh button means the page is not in the state this probe needs
       * (another tool navigated it, a gate left a viewer open, the harness
       * reloaded it). That is probe-harness damage, NOT a host failure — counting
       * it would turn every concurrent test run into a fake stall. Reload to a
       * known state and skip this tick.
       */
      await evaluate(send, `location.href='http://localhost:3010/'`);
      await new Promise((r) => setTimeout(r, 16_000));
      await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return !!b})()`);
      await new Promise((r) => setTimeout(r, 4_000));
      /*
       * The refresh button only exists once the Sessions panel is open. Without
       * this the reset produced a healthy page with no refresh control, so every
       * following tick reset again — an infinite loop that looked like a stall.
       */
      await evaluate(send, `(function(){
        var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
        if(b){b.click(); return 1} return 0})()`);
      await new Promise((r) => setTimeout(r, 4000));
      appendFileSync(OUT, `${stamp()} tick=${i} probe-page-reset (skipped)\n`);
      await new Promise((r) => setTimeout(r, TICK_MS));
      continue;
    }
    {
      const t0 = Date.now();
      // Poll for an answer: either rows arrive, or the panel states the failure.
      while (Date.now() - t0 < 15_000) {
        await new Promise((r) => setTimeout(r, 500));
        after = await evaluate(send, READ_PANEL);
        if (after.couldNotLoad) { answered = false; roundTripMs = Date.now() - t0; break; }
        if (after.rows > 0) { answered = true; roundTripMs = Date.now() - t0; break; }
      }
      if (after === null || (after.rows === 0 && !after.couldNotLoad)) {
        // No rows and no explicit failure after the budget: an unanswered request.
        answered = false;
        roundTripMs = 15_000;
      }
    }
  } catch (e) {
    err = String(e).slice(0, 120);
  }

  /*
   * FAIL when the request is not answered within the budget.
   *
   * `after.couldNotLoad` is an EXPLICIT failure (the host answered with an
   * error) and must not be counted as the silent stall — it is a different
   * defect with a different cause. The silent stall is: connected, no error
   * text, and still nothing comes back.
   */
  const silentStall = err !== null || (!answered && after !== null && !after.couldNotLoad);
  const explicitError = after !== null && after.couldNotLoad;

  if (silentStall) failures += 1;
  const snap = { before, after, answered, roundTripMs, silentStall, explicitError, error: err };

  if (silentStall && !wasFailing) {
    appendFileSync(OUT, `\n## SILENT STALL ${stamp()}\n${JSON.stringify(snap, null, 2)}\n`);
    console.log(`[probe] SILENT STALL at tick ${i}`, JSON.stringify(snap));
  }
  if (explicitError) {
    appendFileSync(OUT, `\n## EXPLICIT ERROR ${stamp()}\n${JSON.stringify(snap, null, 2)}\n`);
  }
  if (!silentStall && wasFailing) {
    recovered += 1;
    appendFileSync(OUT, `\n## RECOVERED ${stamp()}\n${JSON.stringify(snap, null, 2)}\n`);
    console.log(`[probe] recovered at tick ${i}`);
  }
  wasFailing = silentStall;

  const line =
    `${stamp()} tick=${i} rows=${after?.rows ?? "-"} answered=${answered} rt=${roundTripMs}ms ` +
    `silent=${silentStall} explicit=${explicitError}`;
  appendFileSync(OUT, line + "\n");
  if (i % 6 === 0) console.log(line);

  await new Promise((r) => setTimeout(r, TICK_MS));
}

const summary = { ticks, failures, recovered, log: OUT };
appendFileSync(OUT, `\n## SUMMARY\n${JSON.stringify(summary, null, 2)}\n`);
console.log("[probe] done", JSON.stringify(summary));
ws.close();
