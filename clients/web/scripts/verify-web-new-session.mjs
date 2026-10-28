/**
 * Regression gate: `New session` must VISIBLY do something.
 *
 * The user's report was literally "clicking New session changes nothing". Two
 * separate reasons produced that, and this gate covers both:
 *
 *  1. No immediate feedback. The button gave no sign it had been accepted, so
 *     even a working request looked inert until the host finished respawning.
 *     It must enter a busy state right away.
 *  2. No visible change afterwards. `session_new` really did clear the host
 *     mirror, but the client's live transcript was ALWAYS empty (the
 *     `session_history` frame was being discarded by the transport), so there
 *     was never anything on screen to clear. Clearing nothing looks like a
 *     no-op. The transcript must now actually go from N turns to none.
 *
 * So the gate first proves the transcript is NON-empty, then clicks, then
 * requires both signals. Asserting only "it is empty afterwards" would pass on
 * a permanently broken empty pane - which is exactly the bug that shipped.
 *
 * Real browser, real host, real click. No fake transport.
 */
import { attach, evaluate, sleep, shot } from "./_cdp.mjs";

const FEEDBACK_MS = 1000;
const CLEAR_TIMEOUT_MS = 90_000;

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function ok(msg) { console.log("OK:", msg); }

const { send, ws } = await attach();

async function state() {
  return evaluate(send, `(function(){
    var t=document.body.innerText;
    var b=document.querySelector('[aria-label="New session"]');
    return {
      turns: document.querySelectorAll('[class*=userRow],[class*=agentRow]').length,
      len: t.length,
      empty: t.indexOf('no turns yet') >= 0,
      busy: b ? b.disabled : null,
      label: b ? (b.getAttribute('title')||'') : ''
    };
  })()`);
}

async function openSessions() {
  await evaluate(send, `(function(){
    var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
    if(b){b.click(); return 1} return 0})()`);
}

// --- Reach a transcript that actually HAS turns. Without that precondition the
//     "cleared" assertion is vacuous.
await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return !!b})()`);
await sleep(4000);
await openSessions();

let turns = 0;
for (let i = 0; i < 20 && turns === 0; i += 1) {
  const s = await state();
  turns = s.turns;
  if (turns === 0) await sleep(2000);
}

if (turns === 0) {
  // No history in the live session: open a NON-live session and resume it, which
  // is the documented way to get a transcript with content.
  await evaluate(send, `(function(){
    var c=document.querySelector('[aria-label="Close the read-only session view"]');
    if(c)c.click(); return !!c})()`);
  await sleep(2000);
  await openSessions();
  const picked = await evaluate(send, `(function(){
    var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
    for(var i=rows.length-1;i>=0;i--){
      var li=rows[i].closest('li');
      if(li && !li.querySelector('[class*=liveBadge]')){ rows[i].click(); return i; }
    }
    return -1})()`);
  if (picked >= 0) {
    await sleep(8000);
    await evaluate(send, `(function(){
      var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').indexOf('Resume here')>=0});
      if(b)b.click(); return !!b})()`);
    for (let i = 0; i < 60 && turns === 0; i += 1) {
      await sleep(2000);
      turns = (await state()).turns;
    }
  }
}

if (turns === 0) {
  fail("could not get a non-empty transcript: the cleared-state assertion would be vacuous");
} else {
  ok(`transcript has content before the click (${turns} turns)`);

  // --- Click and require IMMEDIATE feedback.
  await evaluate(send, `(function(){document.querySelector('[aria-label="New session"]').click(); return 1})()`);
  const feedbackStart = Date.now();
  let feedback = null;
  while (Date.now() - feedbackStart < FEEDBACK_MS) {
    const s = await state();
    if (s.busy === true) { feedback = { ms: Date.now() - feedbackStart, ...s }; break; }
    await sleep(50);
  }
  if (feedback === null) {
    fail(`clicking New session produced no busy state within ${FEEDBACK_MS}ms`);
  } else {
    ok(`the button showed it was starting after ${feedback.ms}ms ("${feedback.label}")`);

    // --- And require the visible outcome: the transcript is replaced by an
    //     empty new session, not left showing the old turns.
    const clearStart = Date.now();
    let cleared = null;
    while (Date.now() - clearStart < CLEAR_TIMEOUT_MS) {
      const s = await state();
      if (s.turns === 0 && (s.empty || s.len < 4000)) { cleared = { ms: Date.now() - clearStart, ...s }; break; }
      await sleep(1000);
    }
    if (cleared === null) {
      fail(`the transcript was never cleared into a new session (still ${(await state()).turns} turns)`);
    } else {
      ok(`the transcript became a fresh session after ${cleared.ms}ms (turns=0, empty=${cleared.empty})`);
    }
  }
  await shot(send, "gate-new-session");
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
