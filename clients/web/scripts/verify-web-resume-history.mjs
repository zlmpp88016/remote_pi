/**
 * The user-facing acceptance test for the resume experience.
 *
 * Asserts what a user actually perceives, in order:
 *   1. While the host restarts, the transcript says it is REOPENING the session —
 *      it must never claim the workspace has no turns ("What should the agent
 *      work on?"), which reads as "your history is gone".
 *   2. The real history then appears, and the false empty state is gone.
 *
 * Also records the measured timeline so the numbers are auditable.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

const TARGET = process.env.TARGET_ID ?? "01a1499d";
const { send, ws } = await attach();

let failed = false;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { failed = true; console.log(`FAIL: ${m}`); process.exitCode = 1; };

await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16_000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b){b.click();return 1}return 0})()`);
await sleep(2_000);
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b){b.click();return 1}return 0})()`);
for (let i = 0; i < 90; i += 1) {
  await sleep(1_000);
  const n = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
  if (n > 0) break;
}

// If the target is already live it cannot be resumed; switch away first.
const state = await evaluate(
  send,
  `(function(){
    var want = ${JSON.stringify(TARGET)};
    var rows = [...document.querySelectorAll('[aria-label^="Read session"]')];
    for (var i = 0; i < rows.length; i += 1) {
      var li = rows[i].closest('li');
      var t = li ? li.innerText : '';
      if (t.indexOf(want) < 0) continue;
      return { live: !!(li && li.querySelector('[class*=liveBadge]')) };
    }
    return { missing: true };
  })()`,
);
if (state.missing) { fail(`${TARGET} is not in the session list`); ws.close(); process.exit(); }
if (state.live) {
  /*
   * A live session cannot be resumed — the Resume control only exists for a
   * non-live row. Switch to a different session first and let the host settle, so
   * the gate is repeatable instead of depending on which session happened to be
   * live when it started.
   */
  console.log(`${TARGET} is live; switching away first so it can be resumed`);
  await evaluate(send, `(function(){
    var want = ${JSON.stringify(TARGET)};
    var rows = [...document.querySelectorAll('[aria-label^="Read session"]')];
    for (var i = 0; i < rows.length; i += 1) {
      var li = rows[i].closest('li');
      if (li && !li.querySelector('[class*=liveBadge]') && li.innerText.indexOf(want) < 0) { rows[i].click(); return i; }
    }
    return -1;
  })()`);
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    const c = await evaluate(send, `(function(){
      var b=[...document.querySelectorAll('button')].find(function(x){return /resume here/i.test(x.textContent||'')});
      if(!b) return 0; b.click(); return 1})()`);
    if (c === 1) break;
  }
  // Wait for that switch to settle before resuming the target.
  for (let i = 0; i < 120; i += 1) {
    await sleep(1_000);
    const st = await evaluate(send, `document.querySelectorAll('[class*=userRow],[class*=agentRow],[class*=turnRow],[class*=chatRow],[class*=messageRow]').length`).then((n) => ({ rows: n }));
    if (st.rows > 0) break;
  }
  await evaluate(send, `location.href='http://localhost:3010/'`);
  await sleep(16_000);
  await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b){b.click();return 1}return 0})()`);
  await sleep(2_000);
  await evaluate(send, `(function(){
    var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
    if(b){b.click();return 1}return 0})()`);
  for (let i = 0; i < 90; i += 1) {
    await sleep(1_000);
    const n = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
    if (n > 0) break;
  }
}

await evaluate(
  send,
  `(function(){
    var want = ${JSON.stringify(TARGET)};
    var rows = [...document.querySelectorAll('[aria-label^="Read session"]')];
    for (var i = 0; i < rows.length; i += 1) {
      var li = rows[i].closest('li');
      if (li && li.innerText.indexOf(want) >= 0) { rows[i].click(); return 1; }
    }
    return 0;
  })()`,
);
let t0 = 0;
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  const c = await evaluate(send, `(function(){
    var b=[...document.querySelectorAll('button')].find(function(x){return /resume here/i.test(x.textContent||'')});
    if(!b) return 0; b.click(); return 1})()`);
  if (c === 1) { t0 = Date.now(); break; }
}
if (t0 === 0) { fail("no Resume here control appeared"); ws.close(); process.exit(); }
console.log("Resume here pressed\n");

const STATE_WARM = String.raw`(function(){
  var main = document.querySelector('main') || document.body;
  var rows = main.querySelectorAll('[class*=userRow],[class*=agentRow],[class*=turnRow],[class*=chatRow],[class*=messageRow]');
  return { rows: rows.length };
})()`;

const STATE = String.raw`(function(){
  var main = document.querySelector('main') || document.body;
  var text = main.innerText || '';
  var rows = main.querySelectorAll('[class*=userRow],[class*=agentRow],[class*=turnRow],[class*=chatRow],[class*=messageRow]');
  return {
    rows: rows.length,
    reopening: text.indexOf('Reopening this session') >= 0,
    falseEmpty: text.indexOf('What should the agent work on?') >= 0
  };
})()`;

let sawReopening = 0;
let sawFalseEmpty = 0;
let historyAt = 0;
let sawComposerWhileReopening = false;

for (let i = 0; i < 120; i += 1) {
  await sleep(1_000);
  const st = await evaluate(send, STATE);
  const dt = Math.round((Date.now() - t0) / 1000);
  if (st.reopening && sawReopening === 0) { sawReopening = dt; console.log(`  +${dt}s  says "Reopening this session…"`); }
  if (st.falseEmpty && st.rows === 0 && sawFalseEmpty === 0) {
    sawFalseEmpty = dt;
    console.log(`  +${dt}s  FALSE EMPTY STATE ("What should the agent work on?")`);
  }
  if (st.rows > 0 && historyAt === 0) { historyAt = dt; console.log(`  +${dt}s  history visible (rows=${st.rows})`); break; }
  if (i % 4 === 0) console.log(`  +${dt}s rows=${st.rows} reopening=${st.reopening} falseEmpty=${st.falseEmpty}`);
}

if (historyAt === 0) {
  fail("the history never appeared within 120s");
} else {
  ok(`the history appeared at +${historyAt}s`);
}
if (sawFalseEmpty !== 0) {
  fail(
    `the transcript claimed "What should the agent work on?" at +${sawFalseEmpty}s ` +
      `while the session was reopening — that reads as "your history is gone"`,
  );
} else {
  ok("it never claimed the workspace had no turns while reopening");
}
if (sawReopening === 0) {
  fail("the reopening state was never shown; the restart window renders as unexplained emptiness");
} else {
  ok(`it explained the restart at +${sawReopening}s instead of showing an empty transcript`);
}

ws.close();
console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
