// Unit lock for the Sessions "not ready" retry budget.
//
// This exists because the browser test CANNOT reproduce the original hang
// reliably: the defect only fires while the adapter itself is not connected, and
// by the time a probe can drive the page the transport is usually up, so the
// failure path taken is the HOST-retry path instead. Measured: setting the
// not-ready budget to 100000 did not change the browser result, which proved the
// browser test was not exercising this branch at all.
//
// The invariant is therefore pinned here, on the pure decision function, and the
// call site is a single line that cannot bypass it.
import { decideNotReadyRetry } from "../src/client/sessions-retry.ts";

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? " :: " + detail : "")); console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

console.log("sessions not-ready retry budget\n");

/* The whole point: a bounded number of retries, then a terminal decision. */
{
  const budget = 3;
  let used = 0;
  let retries = 0;
  let gaveUp = false;
  for (let i = 0; i < 100; i += 1) {
    const d = decideNotReadyRetry(used, budget);
    if (d.kind === "give_up") { gaveUp = true; break; }
    used = d.used;
    retries += 1;
  }
  check("1. it gives up instead of looping forever", gaveUp === true);
  check("1b. it retries EXACTLY the configured budget", retries === budget, `${retries} vs ${budget}`);
}

/* A zero budget means "do not retry at all" — the terminal state is immediate. */
{
  const d = decideNotReadyRetry(0, 0);
  check("2. a zero budget gives up immediately", d.kind === "give_up", JSON.stringify(d));
}

/* Off-by-one guard: `used === budget` must be terminal, not one more retry. */
{
  check("3. used === budget is terminal", decideNotReadyRetry(5, 5).kind === "give_up");
  check("4. used === budget - 1 may still retry", decideNotReadyRetry(4, 5).kind === "retry");
}

/* The counter is monotonic; it can never be driven backwards by a decision. */
{
  let used = 0;
  let prev = -1;
  let monotonic = true;
  for (let i = 0; i < 10; i += 1) {
    const d = decideNotReadyRetry(used, 4);
    if (d.used < prev) monotonic = false;
    prev = d.used;
    if (d.kind === "give_up") break;
    used = d.used;
  }
  check("5. the attempt counter never moves backwards", monotonic);
}

/* A huge budget still terminates — the loop is bounded by the budget, not by
 * luck. This is the direct regression for the shipped hang. */
{
  let used = 0;
  let steps = 0;
  while (steps < 200000) {
    const d = decideNotReadyRetry(used, 250);
    if (d.kind === "give_up") break;
    used = d.used;
    steps += 1;
  }
  check("6. even a large budget terminates", steps === 250, String(steps));
}

console.log(`\n${failures.length === 0 ? "verify-sessions-retry: OK" : "verify-sessions-retry: FAIL"} — ${pass}/${pass + failures.length}`);
if (failures.length > 0) { for (const f of failures) console.log("   - " + f); }
process.exit(failures.length === 0 ? 0 : 1);
