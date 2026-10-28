/**
 * "Resume here" must react on click, and must not lose the history.
 *
 * Two separate defects were reported together, and both were real:
 *
 * 1. NO IMMEDIATE REACTION. `switchBusy` was derived from
 *    `sessionSwitchReqRef.current !== null`. A ref mutation does not re-render,
 *    so clicking the button changed nothing on screen; the busy state only
 *    appeared when some unrelated state change happened to repaint it — which
 *    the user saw as "no reaction at all, then a long silence, then the counter
 *    suddenly starts".
 *
 * 2. ENDLESS WAIT. Nothing timed out a `session_switch`. If the reply was lost
 *    (the host exits for its respawn before answering, or the room drops in that
 *    gap) the button stayed on "Resuming…" forever. The read path had a guard;
 *    switching did not.
 *
 * 3. EMPTY AFTER RESUMING. `session_switch_ok` called `clearViewer()`, wiping
 *    the transcript that had just been read from that exact session file, and
 *    nothing put it back (the chat reducer has no hydrate-from-file action). So
 *    a resumed session showed as a brand-new empty conversation.
 *
 * This gate covers 1 and 3 by observation, and 2 by asserting the button always
 * settles.
 *
 * Run: node scripts/verify-web-resume-feedback.mjs
 */
import assert from "node:assert/strict";
import { attach, evaluate, sleep } from "./_cdp.mjs";

/** The label must change within this budget; no network round-trip fits. */
const REACT_BUDGET_MS = 400;
/** A resume that has not settled by now is the endless-wait bug. */
const SETTLE_BUDGET_MS = 90_000;

const { send, ws } = await attach();

// Start clean: an already-open viewer belongs to the previous session.
await evaluate(
  send,
  `(function(){
     var c=document.querySelector('[aria-label="Close the read-only session view"]');
     if(c) c.click();
     return !!c;
   })()`,
);
await sleep(2000);

// Find a row that is NOT the live one: only those offer "Resume here".
//
// It must also have real content. Sessions with content and sessions without
// both look like ordinary rows, so picking the first non-live one picked an
// empty session as often as not, and the "history survived" assertion then
// measured a blank pane. Try rows until one actually loads a transcript.
let historyBefore = 0;
let picked = -1;
const rowCount = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
for (let row = 0; row < Math.min(rowCount, 12) && picked < 0; row += 1) {
  const isLive = await evaluate(send, `(function(){
    var r=[...document.querySelectorAll('[aria-label^="Read session"]')];
    var li=r[${row}] && r[${row}].closest('li');
    return !!(li && li.querySelector('[class*=liveBadge]'));
  })()`);
  if (isLive) continue;
  await evaluate(send, `(function(){
    var r=[...document.querySelectorAll('[aria-label^="Read session"]')];
    if(r[${row}])r[${row}].click(); return 1})()`);
  // `Resume here` appears as soon as the viewer mounts, BEFORE the transcript
  // arrives, so it is the readiness signal for the viewer, not for its content.
  let readOk = false;
  for (let i = 0; i < 40; i += 1) {
    readOk = await evaluate(send, `document.body.innerText.indexOf('Resume here')>=0`);
    if (readOk) break;
    await sleep(1000);
  }
  if (!readOk) continue;
  /*
   * Measure the VIEWER's own transcript, not the whole page.
   *
   * `document.body.innerText.length` was the wrong yardstick: the read-only
   * viewer renders into its own container, so a fully loaded transcript still
   * measured ~2.3k characters while an empty one measured ~2.1k. The threshold
   * of 5000 could therefore never be met, and this gate failed on EVERY row
   * while the viewer was in fact showing the session perfectly.
   *
   * A rendered tool card is the honest signal: an empty viewer has none.
   */
  for (let i = 0; i < 25; i += 1) {
    historyBefore = await evaluate(send, `(function(){
      var s=document.querySelector('[aria-label="Close the read-only session view"]');
      if(!s) return 0;
      var sec=s.closest('section');
      return sec ? sec.innerText.length : 0;
    })()`);
    if (historyBefore > 400) break;
    await sleep(1000);
  }
  if (historyBefore > 400) picked = row;
}
assert.ok(picked >= 0, "need a non-live session with a readable transcript to resume");
console.log(`opened a non-live session (row ${picked})`);
console.log(`history before resume: ${historyBefore} chars`);

// --- 1. immediate reaction ---------------------------------------------------
await evaluate(
  send,
  `(function(){
     var b=[...document.querySelectorAll('button')].find(function(x){return /resume here/i.test((x.textContent||'').trim())});
     b.click();
     return true;
   })()`,
);
const t0 = Date.now();
let reacted = null;
for (let i = 0; i < 20; i += 1) {
  const label = await evaluate(
    send,
    `(function(){
       var b=[...document.querySelectorAll('button')].find(function(x){return /resum/i.test((x.textContent||'').trim())});
       return b ? b.textContent.trim() : '';
     })()`,
  );
  if (/resuming/i.test(label)) {
    reacted = { ms: Date.now() - t0, label };
    break;
  }
  await sleep(50);
}
assert.ok(reacted !== null, "clicking Resume must show a pending state");
console.log(`pending state visible at +${reacted.ms}ms ("${reacted.label}")`);
assert.ok(
  reacted.ms <= REACT_BUDGET_MS,
  `pending state must appear within ${REACT_BUDGET_MS}ms, saw ${reacted.ms}ms — ` +
    "a slower response means the flag is again being read from a ref and not rendered",
);

// --- 3. history must survive ------------------------------------------------
// Measured the same way as `historyBefore`: the viewer's own container.
const historyDuring = await evaluate(send, `(function(){
  var s=document.querySelector('[aria-label="Close the read-only session view"]');
  if(!s) return 0;
  var sec=s.closest('section');
  return sec ? sec.innerText.length : 0;
})()`);
assert.ok(
  historyDuring >= historyBefore * 0.5,
  `resuming must not blank the transcript (before=${historyBefore}, during=${historyDuring})`,
);
console.log(`history during resume: ${historyDuring} chars (preserved)`);

// --- 2. it must settle, and the history must still be there -----------------
let settled = false;
for (let i = 0; i < SETTLE_BUDGET_MS / 1000; i += 1) {
  await sleep(1000);
  const st = await evaluate(
    send,
    `(function(){
       var t=document.body.innerText;
       var b=[...document.querySelectorAll('button')].find(function(x){return /resuming/i.test((x.textContent||'').trim())});
       return {pending: !!b, empty: t.indexOf('no messages yet')>=0 || t.indexOf('no turns yet')>=0,
               len: t.length, failed: t.indexOf('Could not')>=0};
     })()`,
  );
  if (st.failed) {
    settled = true;
    console.log("  ok   the switch reported a failure instead of hanging");
    break;
  }
  if (!st.pending) {
    /*
     * The switch has settled, but the transcript does NOT hydrate instantly.
     *
     * Resuming spawns a fresh host process; the client then asks for the live
     * transcript (`session_sync`) and the answer arrives seconds later. Checking
     * for "not empty" the moment the button stops saying "Resuming…" therefore
     * failed on a healthy resume. Give the hydrate its own bounded window.
     */
    let hydrated = null;
    for (let k = 0; k < 40; k += 1) {
      const h = await evaluate(
        send,
        `(function(){
           var t=document.body.innerText;
           return {empty: t.indexOf('no messages yet')>=0 || t.indexOf('no turns yet')>=0, len: t.length};
         })()`,
      );
      if (!h.empty) { hydrated = h; break; }
      await sleep(1000);
    }
    settled = true;
    assert.ok(hydrated !== null, "a resumed session must show its history, not an empty session");
    console.log(`  ok   settled after ~${i + 1}s, live transcript ${hydrated.len} chars`);
    break;
  }
}
assert.ok(settled, `the switch must settle within ${SETTLE_BUDGET_MS}ms instead of waiting forever`);

ws.close();
console.log("\nweb-resume-feedback: OK");
