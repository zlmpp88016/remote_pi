/**
 * Wait until the host is actually serving, before a gate starts.
 *
 * The gates that resume or start a session make the host RESPAWN, and that
 * respawn is asynchronous. A gate finishing does not mean the host has come
 * back: `session_new` returns immediately, the process exits, and it returns a
 * second or two later. A gate that starts during that window attaches to a room
 * about to drop and fails on its precondition rather than on a defect.
 *
 * "Settled" means the panel answered a refresh TWICE in a row, spaced out. One
 * answer is not enough: the host can be mid-respawn and still serve the request
 * already queued.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

const { send, ws } = await attach();

const REFRESH = `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){
    return /refresh the session list/i.test(x.getAttribute('aria-label') || '');
  });
  if(!b) return false;
  b.click(); return true;
})()`;

const ROWS = `document.querySelectorAll('[aria-label^="Read session"]').length`;

async function answeredOnce(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const clicked = await evaluate(send, REFRESH);
    if (!clicked) return false;
    for (let i = 0; i < 20; i += 1) {
      await sleep(300);
      const rows = await evaluate(send, ROWS);
      const failed = await evaluate(
        send,
        `document.body.innerText.indexOf('Could not load this workspace') >= 0`,
      );
      if (failed === true) break;
      /*
       * Rows must be NON-ZERO and STABLE, not merely answered.
       *
       * Right after a respawn the host can answer `session_list` with an empty
       * list — it is up, but its session directory is not ready yet. Accepting
       * "answered" alone declared the host settled while the panel was still
       * empty, and the next gate then failed on "no session rows" as if the
       * feature were broken.
       *
       * A single non-zero reading is not enough either: the directory fills
       * gradually, so an early probe can see 1–2 rows of 11. Requiring the same
       * non-zero count twice is what distinguishes "the host is listing its real
       * sessions" from "the host is still warming up".
       */
      if (rows > 0) {
        /*
         * Sample again after a REAL gap, and require growth to have stopped.
         *
         * A short 700ms re-check passes while the directory is still filling:
         * two probes 700ms apart can both read 2 rows of 11 and look "stable".
         * The host needs seconds to finish enumerating, so the gap has to be big
         * enough that a still-filling list has visibly changed.
         */
        await sleep(2_500);
        const again = await evaluate(send, ROWS);
        if (again === rows) return true;
      }
    }
  }
  return false;
}

let settled = false;
/*
 * A respawn can take minutes on a loaded machine: measured 45s to a usable
 * composer and ~4min to a full session list. This waits for the real condition
 * (non-empty rows, twice, spaced out) rather than a fixed pause, so a fast host
 * costs seconds and a slow one is actually waited for.
 */
for (let attempt = 0; attempt < 8 && !settled; attempt += 1) {
  const first = await answeredOnce(30_000);
  if (!first) {
    /*
     * Reload before giving up on the attempt.
     *
     * The failure this recovers from is NOT always the host: the page can be left
     * in a state that has no refresh control at all (a viewer left open, a
     * half-applied switch), and then no amount of waiting produces rows no matter
     * how healthy the host is. A reload is what a user would do, and it is the
     * only self-healing step available from here.
     */
    await evaluate(send, `location.href='http://localhost:3010/'`);
    await sleep(8_000);
    await evaluate(send, `(function(){
      var b=document.querySelector('[class*=wsButton]');
      if(b){b.click(); return 1} return 0})()`);
    await sleep(3_000);
    await evaluate(send, `(function(){
      var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
      if(b){b.click(); return 1} return 0})()`);
    await sleep(2_000);
    continue;
  }
  // Space the second probe out: a host mid-respawn can still answer the request
  // that was already in flight.
  await sleep(5_000);
  const second = await answeredOnce(30_000);
  settled = second;
}

ws.close();
console.log(settled ? "settle: host is answering consistently" : "settle: host did not settle");
process.exitCode = settled ? 0 : 1;
