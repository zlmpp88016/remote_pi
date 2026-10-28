/**
 * The reported bug, end to end.
 *
 * A workspace Pi respawn leaves the host unable to answer `session_list` for
 * seconds-to-tens-of-seconds. The panel used to surface
 * `Could not load this workspace's sessions. Press refresh to retry.` on the FIRST
 * timeout and then stop trying — so it stayed on that sentence for the whole
 * startup window and only a manual refresh ever cleared it. Measured: error shown
 * for 70+s straight while the host was merely still starting.
 *
 * This gate starts from a REAL cold host (a fresh page with no cached list) and
 * asserts the panel waits it out: it must end up listing the sessions, and it must
 * NOT display the failure sentence at any point while the host is coming up.
 *
 * Injection-verified in both directions:
 *   SESSIONS_RETRY_BUDGET = 0  → error visible for 70+s, rows stay 0  (the bug)
 *   SESSIONS_RETRY_BUDGET = 8  → recovers on its own, error never shown
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const { send, ws } = await attach();

let failed = false;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => {
  failed = true;
  console.log(`FAIL: ${m}`);
  process.exitCode = 1;
};

await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16_000);
await evaluate(send, `(function(){
  var b=document.querySelector('[class*=wsButton]');
  if(b){b.click(); return 1} return 0
})()`);
await sleep(2_000);
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b){b.click(); return 1} return 0
})()`);

/*
 * Watch without EVER clicking refresh.
 *
 * `errSeen` is the reported defect; `recoveredAt` is the fix. Both matter: a panel
 * that waits forever without recovering is no better than one that lies.
 */
const t0 = Date.now();
let errSeen = 0;
let recoveredAt = 0;
let recoveredRows = 0;

for (let i = 0; i < 90; i += 1) {
  await sleep(1_000);
  const st = await evaluate(send, `(function(){
    var t = document.body.innerText;
    return {
      rows: document.querySelectorAll('[aria-label^="Read session"]').length,
      err: t.indexOf("Could not load this workspace's sessions") >= 0
    };
  })()`);
  const dt = Math.round((Date.now() - t0) / 1000);
  if (st.err && errSeen === 0) errSeen = dt;
  if (st.rows > 0) {
    recoveredAt = dt;
    recoveredRows = st.rows;
    break;
  }
}

/*
 * Report the USER-VISIBLE symptom first.
 *
 * Both failures are real, but they are different bugs and the message must say
 * which one happened. Claiming failure while the host was merely starting is the
 * reported defect; never recovering at all is a different failure. The old order
 * reported "never listed" and hid the sentence the user actually complained about.
 */
if (errSeen !== 0) {
  fail(
    `the panel showed "Could not load this workspace's sessions" at +${errSeen}s ` +
      `while the host was still starting` +
      (recoveredAt > 0 ? ` (it later recovered at +${recoveredAt}s)` : ` (and never recovered)`),
  );
} else if (recoveredAt === 0) {
  fail("the panel never listed any session within 90s (the host was up, so this is a stuck request)");
} else {
  ok(`waited out the host startup and listed ${recoveredRows} sessions at +${recoveredAt}s`);
  ok("it never showed the failure sentence while the host was coming up");
}

// Screenshot evidence for the record.
try {
  const shot = await evaluate(send, `document.body.innerText.indexOf("Could not load this workspace") >= 0`);
  mkdirSync("scripts/_e2e-evidence", { recursive: true });
  writeFileSync("scripts/_e2e-evidence/gate-sessions-recover.txt", `errShown=${shot} recoveredAt=${recoveredAt}s rows=${recoveredRows}\n`);
} catch {
  /* evidence is best-effort */
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
