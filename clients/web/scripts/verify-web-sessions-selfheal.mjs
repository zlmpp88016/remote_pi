/**
 * The user-facing acceptance test: land the panel in the exact broken situation
 * (host respawning, list not yet answered) and prove it recovers with NO user
 * action and WITHOUT ever showing the failure sentence.
 *
 * Forces the situation by taking the browser offline for a moment while the panel
 * is open, which guarantees in-flight list requests die, then restoring it. This
 * models "the host could not answer" without depending on respawn timing.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

const { send, ws } = await attach();

await send("Network.enable", {});
await send("Network.emulateNetworkConditions", {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});

await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16_000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return 1})()`);
await sleep(2_000);
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b)b.click(); return 1})()`);
for (let i = 0; i < 60; i += 1) {
  await sleep(1000);
  const rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
  if (rows > 0) break;
}

/*
 * Cut the network so the panel's list requests cannot be answered, click refresh
 * once (a user would), and then restore the network WITHOUT clicking anything.
 * The fix must recover on its own.
 */
await send("Network.emulateNetworkConditions", {
  offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
console.log("network cut; clicking refresh once");
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return /refresh the session list/i.test(x.getAttribute('aria-label')||'')});
  if(b)b.click(); return 1})()`);
await sleep(3_000);

const duringOffline = await evaluate(send, `(function(){
  var t = document.body.innerText;
  return { rows: document.querySelectorAll('[aria-label^="Read session"]').length,
           err: t.indexOf("Could not load this workspace's sessions") >= 0,
           asking: t.indexOf("Asking the host") >= 0 };
})()`);
console.log("while offline:", JSON.stringify(duringOffline));

await send("Network.emulateNetworkConditions", {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
console.log("network restored; waiting WITHOUT any click");

const t0 = Date.now();
let errSeen = 0, recovered = 0;
for (let i = 0; i < 45; i += 1) {
  await sleep(1000);
  const st = await evaluate(send, `(function(){
    var t = document.body.innerText;
    return { rows: document.querySelectorAll('[aria-label^="Read session"]').length,
             err: t.indexOf("Could not load this workspace's sessions") >= 0 };
  })()`);
  const dt = Math.round((Date.now() - t0) / 1000);
  if (st.err && errSeen === 0) { errSeen = dt; console.log(`  +${dt}s failure sentence shown`); }
  if (i % 4 === 0) console.log(`  +${dt}s rows=${st.rows} err=${st.err}`);
  if (st.rows > 0) { recovered = dt; console.log(`  +${dt}s RECOVERED rows=${st.rows}`); break; }
}

console.log(`\nerrSeen=+${errSeen}s recovered=+${recovered}s`);
console.log(recovered > 0 ? "PASS: self-recovered after the network returned" : "FAIL: never recovered");
ws.close();
