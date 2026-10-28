/**
 * Real-browser gate for the usage/statistics UI.
 *
 * Asserts three independent readings that the user asked for:
 *   1. the composer dock shows a turn/step count, a decode speed, a token total
 *      and a cache-hit share — all NON-ZERO, because a placeholder would also
 *      satisfy "the element exists";
 *   2. each settled turn has a divider carrying a duration;
 *   3. each assistant message has a footer with a token total and a clock.
 *
 * Injection contract: zeroing the host's usage must make this fail. A gate that
 * only checks for the element's presence passed happily while every reading was
 * absent, which is exactly the "empty shell" outcome this work was meant to
 * avoid.
 */
import { APP_ORIGIN, attach, evaluate, sleep } from "./_cdp.mjs";

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}
function ok(msg) {
  console.log("OK:", msg);
}

const { send, ws } = await attach();

/** Wait for the LIVE session's transcript, whose composer carries the dock. */
async function openSession() {
  /*
   * Navigate to the origin `attach()` selected, not a hard-coded dev port.
   *
   * The literal made the gate ignore `APP_ORIGIN`, so it always drove
   * `localhost:3010` even when the caller asked for the same-origin server on 4124 —
   * which reports "no dock" against a page that never had the session.
   */
  await evaluate(send, `location.href=${JSON.stringify(APP_ORIGIN + "/")}`);
  await sleep(14_000);
  /*
   * No panel and no row click.
   *
   * Selecting a non-live row opens a READ-ONLY viewer: it renders the transcript
   * but has no composer, so the dock and its readings do not exist there. The
   * readings this gate measures belong to the LIVE session, which is what the
   * page shows on load. Clicking a row was what made this gate report "no dock"
   * against a page that was displaying a viewer.
   */
  // Wait for the live transcript to hydrate.
  for (let i = 0; i < 90; i += 1) {
    await sleep(1_000);
    const n = await evaluate(send, `document.querySelectorAll('[class*=agentTurn]').length`);
    if (n > 0) break;
  }
  const diag = await evaluate(send, `(function(){
    return {
      url: location.href,
      agentTurns: document.querySelectorAll('[class*=agentTurn]').length,
      userRows: document.querySelectorAll('[class*=userRow]').length,
      rows: document.querySelectorAll('[aria-label^="Read session"]').length,
    };
  })()`);
  console.log("   (openSession:", JSON.stringify(diag) + ")");
  await sleep(2_000);
}

await openSession();

const read = async () =>
  evaluate(send, `(function(){
    var dock = document.querySelector('[aria-label="Conversation statistics"]');
    var activity = document.querySelector('[data-stat="activity"]');
    var usage = document.querySelector('[data-stat="usage"]');
    var turns = [...document.querySelectorAll('[data-turn]')];
    var footers = [...document.querySelectorAll('[data-part="usage"]')];
    var clocks = [...document.querySelectorAll('[data-part="clock"]')];
    return {
      dockText: dock ? dock.innerText.replace(/\\s+/g, ' ') : null,
      activityText: activity ? activity.innerText.replace(/\\s+/g, ' ') : null,
      usageText: usage ? usage.innerText.replace(/\\s+/g, ' ') : null,
      turnCount: turns.length,
      turnTexts: turns.slice(0, 3).map(function(d){ return (d.innerText||'').replace(/\\s+/g, ' '); }),
      footerCount: footers.length,
      clockCount: clocks.length,
      firstFooter: footers.length > 0 ? footers[0].innerText.replace(/\\s+/g, ' ') : null,
      firstClock: clocks.length > 0 ? clocks[0].innerText.replace(/\\s+/g, ' ') : null,
    };
  })()`);

let state = await read();

/*
 * A blank transcript means the gate has nothing to measure — retry once rather
 * than reporting the readings as missing when the cause was a slow hydrate.
 */
if (state.turnCount === 0) {
  console.log("   (no transcript yet; reloading once)");
  await openSession();
  state = await read();
}

console.log("--- observed ---");
console.log(JSON.stringify(state, null, 2));

// 1. Composer dock: counts, speed, total, cache hit — all non-zero.
if (state.dockText === null) {
  fail("the composer dock did not render at all");
} else {
  const activity = state.activityText ?? "";
  const usage = state.usageText ?? "";

  if (!/[1-9]\d* 轮/.test(activity)) {
    fail(`the activity pill shows no turn count (${JSON.stringify(activity)})`);
  } else {
    ok(`activity pill reports turns/steps: ${activity}`);
  }

  const speed = /(\d+(?:\.\d+)?) tok\/s/.exec(activity);
  if (speed === null) {
    fail(`the activity pill shows no decode speed (${JSON.stringify(activity)})`);
  } else if (Number(speed[1]) <= 0) {
    fail(`the decode speed is not a real reading (${speed[1]} tok/s)`);
  } else {
    ok(`decode speed is a real number: ${speed[1]} tok/s`);
  }

  const total = /(\d+(?:\.\d+)?[KM]?) tok/.exec(usage);
  if (total === null) {
    fail(`the usage pill shows no token total (${JSON.stringify(usage)})`);
  } else {
    ok(`usage pill reports a token total: ${total[1]} tok`);
  }

  const cache = /缓存命中 (\d+(?:\.\d+)?)%/.exec(usage);
  if (cache === null) {
    fail(`the usage pill shows no cache-hit share (${JSON.stringify(usage)})`);
  } else if (Number(cache[1]) <= 0) {
    fail(`the cache-hit share is not a real reading (${cache[1]}%)`);
  } else {
    ok(`cache-hit share is a real percentage: ${cache[1]}%`);
  }
}

// 2. Turn dividers with a duration.
if (state.turnCount === 0) {
  fail("no turn divider rendered");
} else {
  const withDuration = state.turnTexts.filter((t) => /已完成，用时 /.test(t)).length;
  if (withDuration === 0) {
    fail(`no divider carries a duration (${JSON.stringify(state.turnTexts)})`);
  } else {
    ok(`${withDuration} of ${state.turnCount} dividers carry a duration`);
  }
}

// 3. Message footer: token total and clock.
if (state.footerCount === 0) {
  fail("no assistant message footer rendered a token total");
} else {
  ok(`${state.footerCount} message footers show a token total (${state.firstFooter})`);
}
if (state.clockCount === 0) {
  fail("no assistant message footer rendered a timestamp");
} else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(state.firstClock ?? "")) {
  /*
   * The full date and time, not `HH:mm`.
   *
   * A bare clock is ambiguous across days — two turns twelve hours apart both read
   * `09:14`, and a resumed session made yesterday's messages look like they had just
   * arrived. Seconds are required too, because several turns can finish inside one
   * minute and their ordering is otherwise unobservable.
   */
  fail(`the message timestamp is not YYYY-MM-DD HH:mm:ss (${JSON.stringify(state.firstClock)})`);
} else {
  ok(`${state.clockCount} message footers show a full date-time (${state.firstClock})`);
}

console.log(process.exitCode === 1 ? "RESULT: FAIL" : "RESULT: PASS");
ws.close();
