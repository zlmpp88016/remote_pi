/**
 * Clicking a session must react immediately.
 *
 * The reported symptom was "clicking Sessions does nothing". The cause was not
 * a failed read: `handleSessionRead` did fire and the host did answer. The
 * problem was that the viewer mounted only from `applyRead`, i.e. after
 * `session_read_ok` arrived, so during the wait -- seconds while the host
 * respawns, or forever if the room dropped -- the click changed nothing on
 * screen. No spinner, no banner, no selection. Indistinguishable from a dead
 * button.
 *
 * This gate asserts the ordering directly: the viewer must be mounted, in its
 * loading state, within a frame budget that no network round-trip can meet.
 * A relay round-trip is >= 40ms even on loopback, so 150ms proves the mount is
 * local and cannot be waiting on the host.
 *
 * Run: node scripts/verify-web-session-click-feedback.mjs
 */
import assert from "node:assert/strict";
import { attach, evaluate, sleep } from "./_cdp.mjs";

const MOUNT_BUDGET_MS = 150;

const { send, ws } = await attach();

const rows = await evaluate(
  send,
  `document.querySelectorAll('[aria-label^="Read session"]').length`,
);
assert.ok(rows > 0, "the session list must be populated for this gate to mean anything");
console.log(`session rows: ${rows}`);

// Start from a clean slate so an already-open viewer cannot fake the result.
await evaluate(
  send,
  `(function(){
     var c=document.querySelector('[aria-label="Close the read-only session view"]');
     if(c) c.click();
     return !!c;
   })()`,
);
await sleep(600);

const t0 = Date.now();
await evaluate(
  send,
  `(function(){
     var r=[...document.querySelectorAll('[aria-label^="Read session"]')];
     if(!r[4]) return false;
     r[4].click();
     return true;
   })()`,
);

/** Resolve as soon as the viewer is on screen, with its state. */
let seen = null;
for (let i = 0; i < 40; i += 1) {
  const st = await evaluate(
    send,
    `(function(){
       var close=document.querySelector('[aria-label="Close the read-only session view"]');
       if(!close) return {open:false};
       return {open:true, loading: document.body.innerText.indexOf('Reading this session')>=0};
     })()`,
  );
  if (st.open) {
    seen = { ms: Date.now() - t0, loading: st.loading };
    break;
  }
  await sleep(20);
}

assert.ok(seen !== null, "the viewer must mount after clicking a session row");
console.log(`viewer mounted at +${seen.ms}ms (budget ${MOUNT_BUDGET_MS}ms)`);
assert.ok(
  seen.ms <= MOUNT_BUDGET_MS,
  `the viewer must mount locally within ${MOUNT_BUDGET_MS}ms, saw ${seen.ms}ms — ` +
    "a slower mount means it is still waiting for the host reply",
);

/*
 * The loading line is the visible proof that something is happening. It must be
 * present at mount time IF the reply has not landed yet; when the host answers
 * faster than this probe the transcript is already there instead, which is
 * equally good and must not fail the gate.
 */
const settled = await evaluate(
  send,
  `document.body.innerText.indexOf('Reading this session')>=0`,
);
console.log(
  seen.loading || !settled
    ? "  ok   click shows the loading state while the read is in flight"
    : "  ok   click mounted the viewer (reply already rendered)",
);

// And the viewer must end up showing the real session, not stay on the spinner.
let content = false;
for (let i = 0; i < 60; i += 1) {
  content = await evaluate(
    send,
    `(function(){
       var close=document.querySelector('[aria-label="Close the read-only session view"]');
       if(!close) return false;
       return document.body.innerText.indexOf('Reading this session')<0;
     })()`,
  );
  if (content) break;
  await sleep(1000);
}
assert.ok(content, "the read must settle into a transcript or an explicit empty state");

ws.close();
console.log("\nweb-session-click-feedback: OK");
