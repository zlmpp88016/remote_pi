/**
 * Verify the retry fix through the REAL failure: an empty panel while the host
 * respawns.
 *
 * Forces the condition instead of hoping for it — a `session_switch` from the UI
 * makes the child exit and come back, and the panel is emptied of the live badge
 * meanwhile. Then it records, second by second, whether the panel ends up showing
 * the error sentence or recovers on its own (the fix) — and whether the user has
 * to press refresh at all.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

const { send, ws } = await attach();

await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16_000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return 1})()`);
await sleep(2_000);
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b)b.click(); return 1})()`);
for (let i = 0; i < 90; i += 1) {
  await sleep(1000);
  const rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
  if (rows > 0) break;
}

// Drive a real switch so the host genuinely respawns.
const pressed = await evaluate(send, `(function(){
  var rows = [...document.querySelectorAll('[aria-label^="Read session"]')];
  for (var i = 0; i < rows.length; i += 1) {
    var li = rows[i].closest('li');
    if (li && !li.querySelector('[class*=liveBadge]')) { rows[i].click(); return 1; }
  }
  return 0;
})()`);
console.log("row clicked:", pressed);
let resumed = false;
for (let i = 0; i < 80; i += 1) {
  await sleep(250);
  const c = await evaluate(send, `(function(){
    var b=[...document.querySelectorAll('button')].find(function(x){return /resume here/i.test(x.textContent||'')});
    if(!b) return 0; b.click(); return 1})()`);
  if (c === 1) { resumed = true; break; }
}
console.log("resume pressed:", resumed);
if (!resumed) { ws.close(); process.exit(1); }

/*
 * Now watch WITHOUT ever clicking refresh. The fix must recover on its own.
 * `errEver` records whether the failure sentence ever appeared, and `recoveredAt`
 * records when rows came back.
 */
const t0 = Date.now();
let errEver = 0, recoveredAt = 0, refreshClicks = 0;
for (let i = 0; i < 75; i += 1) {
  await sleep(1000);
  const st = await evaluate(send, `(function(){
    var t = document.body.innerText;
    return {
      rows: document.querySelectorAll('[aria-label^="Read session"]').length,
      err: t.indexOf("Could not load this workspace's sessions") >= 0,
      asking: t.indexOf("Asking the host for this workspace") >= 0
    };
  })()`);
  const dt = Math.round((Date.now() - t0) / 1000);
  if (st.err && errEver === 0) { errEver = dt; console.log(`  +${dt}s  ERROR VISIBLE (rows=${st.rows})`); }
  if (i % 5 === 0) console.log(`  +${dt}s rows=${st.rows} err=${st.err} asking=${st.asking}`);
  if (st.rows > 0 && i > 2) { recoveredAt = dt; console.log(`  +${dt}s RECOVERED rows=${st.rows}`); break; }
}

console.log(`\nrefreshClicks=${refreshClicks} errEver=+${errEver}s recoveredAt=+${recoveredAt}s`);
console.log(
  recoveredAt > 0 && errEver === 0
    ? "PASS: recovered without the user pressing refresh, and never claimed failure"
    : `RESULT: errEver=${errEver} recoveredAt=${recoveredAt}`,
);
ws.close();
