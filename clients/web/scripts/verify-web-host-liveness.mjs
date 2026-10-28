/**
 * Regression gate: the UI must distinguish "connected" from "answering".
 *
 * The reported defect (plan/75 §7b) was that every request could go unanswered
 * while the page still claimed `host connected`, so the user could not tell a
 * broken host from a dead button. The liveness probe measured that stall for
 * real, so this gate tests the remedy the same way: silence the room, then
 * require the label to change.
 *
 * The silence is produced with CDP network emulation (`Network.emulateNetwork
 * Conditions` with `offline`), which is the closest thing to unplugging the relay
 * without touching the host. The gate then waits past `HOST_STALE_MS` and asserts
 * the pill flips to "host not responding".
 *
 * SLOW BY DESIGN: it must outlast the real threshold (75s), because a shorter
 * wait would only prove the timer exists, not that it fires.
 */
import { attach, evaluate, sleep, shot } from "./_cdp.mjs";

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function ok(msg) { console.log("OK:", msg); }

/**
 * Must exceed HOST_STALE_MS (75s) plus the 5s sampling interval, with real margin.
 *
 * Measured: the label flips at ~90s of silence, because the inbound clock only
 * starts aging from the last frame the host sent (up to a full keepalive period
 * before the emulation began). A 95s window was inside the noise and failed
 * intermittently while the feature worked correctly.
 */
const SILENCE_WAIT_MS = 140_000;

const { send, ws } = await attach();

async function pill() {
  return evaluate(send, `(function(){
    var el=[...document.querySelectorAll('[class*=pill]')]
      .find(function(x){return /host connected|host not responding|offline/.test(x.textContent||'')});
    return {text: el ? el.textContent.trim() : null, title: el ? el.getAttribute('title') : null};
  })()`);
}

// Reach a connected page.
await evaluate(send, `location.href='http://localhost:3010/'`);
/*
 * Restore networking FIRST.
 *
 * This gate is the only one that takes the browser offline, and a previous run
 * that failed mid-way could leave the emulation on — every later gate would
 * then run against a disconnected page and fail for an unrelated reason.
 */
await send("Network.enable", {});
await send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await evaluate(send, `location.href='http://localhost:3010/'`);
/*
 * Wait for a HEALTHY connection, not merely for the page to load.
 *
 * `host connected` requires the relay handshake to complete, which after a host
 * respawn takes far longer than a document load. Giving up early made this gate
 * report "never reported connected" — its own precondition, not a defect.
 */
for (let i = 0; i < 120; i += 1) {
  await sleep(1000);
  const ready = await evaluate(send, `document.body.innerText.indexOf('host connected') >= 0`);
  if (ready) break;
}
const first = await pill();
if (first.text !== "host connected") {
  fail(`the host never reported connected (pill=${JSON.stringify(first.text)}); cannot test liveness`);
} else {
  ok(`healthy state reports "${first.text}"`);

  // --- 1. A healthy session must NOT raise a false alarm.
  await sleep(8_000);
  const stillHealthy = await pill();
  if (stillHealthy.text !== "host connected") {
    fail(`an idle-but-healthy session flipped to "${stillHealthy.text}": the threshold is too aggressive`);
  } else {
    ok("an idle session stays healthy (no false alarm)");

    /*
     * 2. Silence the room and require the label to change.
     *
     * Offline emulation drops the WebSocket, so no inbound frame can arrive and
     * the age clock runs. That is exactly the condition the probe recorded.
     */
    await send("Network.enable", {});
    await send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    console.log(`   (silencing the room for ${SILENCE_WAIT_MS / 1000}s…)`);

    let stalled = null;
    const t0 = Date.now();
    while (Date.now() - t0 < SILENCE_WAIT_MS) {
      await sleep(5_000);
      const now = await pill();
      if (now.text === "host not responding") {
        stalled = { ms: Date.now() - t0, title: now.title };
        break;
      }
    }

    // Restore the network before asserting, so a failure cannot leave the
    // browser offline for the next gate.
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    if (stalled === null) {
      fail(
        `the label never reported a stall after ${SILENCE_WAIT_MS / 1000}s of silence: ` +
          "the UI cannot distinguish 'connected' from 'answering'",
      );
    } else {
      ok(`the stall was reported after ~${Math.round(stalled.ms / 1000)}s ("host not responding")`);
      if (typeof stalled.title !== "string" || !/has not answered/i.test(stalled.title)) {
        fail(`the stalled pill must explain the condition, got ${JSON.stringify(stalled.title)}`);
      } else {
        ok("the stalled pill explains that the host stopped answering");
      }

      // --- 3. It must clear once the host speaks again.
      await evaluate(send, `location.href='http://localhost:3010/'`);
      let recovered = false;
      for (let i = 0; i < 40; i += 1) {
        await sleep(1000);
        const now = await pill();
        if (now.text === "host connected") { recovered = true; break; }
      }
      if (!recovered) {
        fail("the stall label did not clear after reconnecting: it would stick forever");
      } else {
        ok("the label clears once the host answers again");
      }
    }
    await shot(send, "gate-host-liveness");
  }
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
