/**
 * Reset the browser to a clean page load, between gates.
 *
 * The browser gates share ONE real Chrome and ONE real host session. Several of
 * them resume a session or start a new one, which permanently changes what the
 * next gate sees — the viewed session, the live transcript, whether a reader is
 * open. Without a reset, running them in sequence produced a different set of
 * failures on every run, which is worse than useless: it looks like a regression
 * and moves each time you look at it.
 *
 * A plain reload is what a user would do, and it is enough: the page reconnects,
 * re-adopts the live room and re-hydrates from the host.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

const { send, ws } = await attach();
await evaluate(send, `location.href='${process.env.APP_ORIGIN ?? "http://localhost:3010"}/'`);
// Wait for the app to come back and reconnect, not just for the document.
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  const ready = await evaluate(send, `(function(){
    var t = document.body.innerText;
    return t.indexOf('Remote Pi') >= 0 && t.indexOf('host connected') >= 0;
  })()`);
  if (ready) break;
}

/*
 * Bring the page to the state the gates expect: a workspace selected and the
 * session list open. Several gates assert on session ROWS, which do not exist
 * until both of those have happened, so stopping at "connected" left them
 * failing on their own precondition rather than on a defect.
 */
await evaluate(send, `(function(){
  var b=document.querySelector('[class*=wsButton]');
  if(b){b.click(); return 1} return 0})()`);
for (let i = 0; i < 20; i += 1) {
  await sleep(1000);
  const sel = await evaluate(send, `document.body.innerText.indexOf('Sessions')>=0`);
  if (sel) break;
}
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b){b.click(); return 1} return 0})()`);
/*
 * Poll until rows appear, refreshing while waiting.
 *
 * The budget is 90s, not 20s: after a reload a host that just respawned needs
 * time before its session directory answers with a non-empty list, and giving up
 * early returned "0 session rows" to the caller — which every gate then reported
 * as its own precondition failing.
 */
for (let i = 0; i < 90; i += 1) {
  await sleep(1000);
  const rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
  if (rows > 0) break;
  await evaluate(send, `(function(){
    var b=[...document.querySelectorAll('button')].find(function(x){return /refresh the session list/i.test(x.getAttribute('aria-label')||'')});
    if(b){b.click(); return 1} return 0})()`);
}
const rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
ws.close();
console.log(`reset: page reloaded, ${rows} session rows`);
