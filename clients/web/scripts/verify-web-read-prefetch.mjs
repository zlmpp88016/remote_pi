/**
 * Regression gate: hovering a session row must warm its transcript, so clicking
 * the row shows content immediately instead of an empty pane.
 *
 * The cost being removed is a full network round trip. Before prefetching, the
 * `session_read` only left on click, so the viewer mounted empty and the user
 * read a spinner for the whole trip (~500ms locally, far worse over a relay).
 *
 * The gate measures the thing the user experiences — how long the viewer stays
 * empty after the click — and requires it to be far below the measured round
 * trip. Timing is taken from the wire, not guessed: the click-to-content budget
 * is a fraction of the round trip observed in the SAME run.
 *
 * It also asserts the prefetch stays invisible: pointing at a row must NOT mount
 * the read-only viewer or steal the composer from the live session.
 */
import { attach, evaluate, sleep, shot } from "./_cdp.mjs";

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function ok(msg) { console.log("OK:", msg); }

const { send, ws } = await attach();

async function panel() {
  return evaluate(send, `(function(){
    var v=document.querySelector('[aria-label="Close the read-only session view"]');
    var sec=v ? v.closest('section') : null;
    var ta=document.querySelector('textarea');
    return {
      rows: document.querySelectorAll('[aria-label^="Read session"]').length,
      viewerOpen: !!v,
      viewerText: sec ? sec.innerText.length : 0,
      hasComposer: !!ta
    };
  })()`);
}

/** Start from a connected page with the Sessions panel open. */
await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16_000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return !!b})()`);
await sleep(4_000);
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b){b.click(); return 1} return 0})()`);
await sleep(4_000);

let st = await panel();
if (st.rows < 2) {
  fail(`need at least 2 session rows, found ${st.rows}`);
} else {
  /*
   * 1. Measure the COLD round trip on the row that will be clicked LAST, so the
   *    budget below is derived from this machine and this run rather than a
   *    constant that would rot.
   */
  const coldRow = st.rows - 1;
  await evaluate(send, `(function(){
    var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
    var b=rows[${coldRow}];
    if(b) b.click();
    return 1})()`);

  let coldMs = -1;
  for (let i = 0; i < 200; i += 1) {
    await sleep(100);
    const now = await panel();
    if (now.viewerOpen && now.viewerText > 400) { coldMs = (i + 1) * 100; break; }
  }
  if (coldMs < 0) {
    fail(`the click-driven read never rendered content (cold path); cannot measure a budget`);
  } else {
    ok(`cold click-to-content: ~${coldMs}ms (this is the cost prefetch should remove)`);

    // Close the viewer so the next measurement starts clean.
    await evaluate(send, `(function(){
      var c=document.querySelector('[aria-label="Close the read-only session view"]');
      if(c) c.click(); return 1})()`);
    await sleep(1500);

    /*
     * 2. Prefetch must be INVISIBLE. Hover a different row and confirm nothing
     *    mounts: the live transcript and its composer must stay put.
     *
     *    The hover is a REAL pointer move through CDP. Dispatching a synthetic
     *    `mouseover` does not make React fire `onMouseEnter` (it tracks the
     *    pointer's enter/leave pairs), so a synthetic event would silently skip
     *    the prefetch and then "pass" the invisibility check for the wrong
     *    reason.
     */
    const beforeHover = await panel();
    const target = await evaluate(send, `(function(){
      var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
      var b=rows[0];
      if(!b) return null;
      var r=b.getBoundingClientRect();
      return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
    })()`);
    if (target === null) {
      fail("could not locate the first session row to hover");
    } else {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none" });
      await sleep(300);
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: target.x,
        y: target.y,
        button: "none",
      });
    }
    /*
     * Wait for the prefetch to actually LAND.
     *
     * A `session_read` on this host reads the transcript from disk and takes
     * seconds — measured 3.3s to 5s. Waiting a fixed short time clicked before
     * the reply arrived and then measured the COLD path, so the gate failed while
     * prefetching worked.
     *
     * The wait is now twice the cold trip: generous enough for a loaded host, and
     * still bounded. If prefetch were removed the wait would simply be wasted and
     * the assertion below would fail on its own merits — which is exactly what
     * the injection test confirms.
     */
    await sleep(coldMs * 2);
    const afterHover = await panel();
    if (afterHover.viewerOpen) {
      fail("hovering a row opened the read-only viewer: prefetch must not mount it");
    } else if (beforeHover.hasComposer && !afterHover.hasComposer) {
      fail("hovering a row removed the composer from the live session");
    } else {
      ok("hovering a row does not mount the viewer and leaves the composer alone");

      /*
       * 3. The warm click. Content must appear far sooner than the cold trip.
       *    Budget: half the measured cold trip, and never more than 250ms (a
       *    cached render is a React commit, not a round trip).
       */
      const budget = Math.max(60, Math.min(250, Math.floor(coldMs / 2)));
      const warmStart = Date.now();
      await evaluate(send, `(function(){
        var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
        var b=rows[0];
        if(b) b.click();
        return 1})()`);

      let warmMs = -1;
      for (let i = 0; i < 100; i += 1) {
        const now = await panel();
        if (now.viewerOpen && now.viewerText > 400) { warmMs = Date.now() - warmStart; break; }
        await sleep(20);
      }

      if (warmMs < 0) {
        fail(`the prefetched row never rendered content (waited ${Date.now() - warmStart}ms)`);
      } else if (warmMs > budget) {
        fail(
          `the warm click took ${warmMs}ms, over the ${budget}ms budget ` +
            `(cold trip was ${coldMs}ms) — the transcript was not prefetched`,
        );
      } else {
        ok(`warm click-to-content: ${warmMs}ms, within the ${budget}ms budget (cold was ~${coldMs}ms)`);
      }
      await shot(send, "gate-prefetch");
    }
  }
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
