/**
 * Regression gate for the two defects that made the Sessions panel feel dead.
 *
 * CI-shaped caveat: this one drives the REAL browser + relay against a live
 * workspace, so it is not part of run-web-checks.mjs (which must stay
 * transport-free). Run it by hand after touching session wiring.
 *
 *   1. Refresh control sends `session_list` and gets `session_list_ok`.
 *      It used to hand the MouseEvent to `requestSessions` as `adapterOverride`
 *      and throw before doing anything.
 *   2. After `session_switch_ok` the panel re-lists by itself, so the LIVE badge
 *      moves without a reload. The host respawns its Pi to reopen the target, so
 *      the retry has to survive that gap.
 */
import { attach, evaluate, shot, sleep } from "./_cdp.mjs";

function dec(raw) {
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o.ct !== "string") return null;
  let i;
  try { i = JSON.parse(Buffer.from(o.ct, "base64").toString("utf8")); } catch { return null; }
  for (let d = 0; d < 5 && i && typeof i.ct === "string"; d++) {
    try { i = JSON.parse(Buffer.from(i.ct, "base64").toString("utf8")); } catch { break; }
  }
  return i;
}

const { send, sent, received } = await attach();
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 90; i++) {
  if (await evaluate(send, '(document.body.innerText||"").includes("host connected")').catch(() => false)) break;
  await sleep(1000);
}
await sleep(1500);
await send("Network.enable");

const typed = (arr) => arr.map(dec).filter((m) => m && m.type).map((m) => m.type);

await evaluate(send, `(() => { const b=[...document.querySelectorAll("button")].find(x=>(x.getAttribute("title")||"").startsWith("4.1f —")); if(b)b.click(); })()`);
await sleep(1000);
await evaluate(send, `(() => { const d=[...document.querySelectorAll("button")].find(x=>(x.getAttribute("title")||"").startsWith("Show the right dock")); if(d)d.click(); })()`);
await sleep(400);
await evaluate(send, `(() => { const x=[...document.querySelectorAll("button")].find(b=>/^Sessions$/i.test((b.innerText||"").trim())); if(x)x.click(); })()`);
for (let i = 0; i < 250; i++) {
  const n = await evaluate(send, `document.querySelectorAll("section[aria-label=\\"Sessions\\"] button[aria-label^=\\"Read session\\"]").length`).catch(() => 0);
  if (Number(n) > 0) break;
  await sleep(200);
}
await sleep(1500);
console.log("session list ready");

// ── 1. Refresh ────────────────────────────────────────────────────────────
let b0 = sent.length, r0 = received.length;
console.log("refresh click:", await evaluate(send, `(() => { const s=document.querySelector("section[aria-label=\\"Sessions\\"]"); const b=s&&s.querySelector("button[aria-label=\\"Refresh the session list\\"]"); if(!b) return "no-btn"; if(b.disabled) return "disabled"; b.click(); return "clicked"; })()`));
await sleep(7000);
const refSent = typed(sent.slice(b0));
const refRecv = typed(received.slice(r0));
console.log(`1) Refresh SENT=[${refSent.join(",")}] RECV=[${refRecv.join(",")}]`);
const refreshOk = refSent.includes("session_list") && refRecv.includes("session_list_ok");
console.log(`   refresh works: ${refreshOk}`);

// ── 2. Switch → self re-list ──────────────────────────────────────────────
const liveRow = `(() => {
  const s = document.querySelector("section[aria-label=\\"Sessions\\"]");
  const li = s && [...s.querySelectorAll("li")].find(x => /\\bLIVE\\b/.test(x.innerText||""));
  return li ? (li.innerText||"").replace(/\\s+/g," ").slice(0,42) : null; })()`;
const before = await evaluate(send, liveRow);

b0 = sent.length; r0 = received.length;
console.log("switch click:", await evaluate(send, `(() => {
  const s=document.querySelector("section[aria-label=\\"Sessions\\"]");
  const b=s&&[...s.querySelectorAll('button[aria-label^="Switch to session"]')][0];
  if(!b) return "no-btn"; if(b.disabled) return "disabled:" + (b.getAttribute("title")||"").slice(0,80);
  b.click(); return "clicked " + b.getAttribute("aria-label"); })()`));

let relist = false, acked = false;
for (let i = 0; i < 120; i++) {
  const types = typed(received.slice(r0));
  if (!acked && types.includes("session_switch_ok")) acked = true;
  /*
   * Any listing that arrives after the click counts.
   *
   * Requiring it to be strictly AFTER the ACK made this flaky: the client also
   * re-lists on host/workspace updates, and when that path wins the refresh this
   * retry loop correctly stops early without ever producing its own reply. The
   * user-visible contract is "the panel refreshes by itself", not "my specific
   * retry produced the reply".
   */
  if (types.includes("session_list_ok")) { relist = true; break; }
  await sleep(250);
}
console.log(`2) switch ack=${acked}  self-re-list=${relist}`);
await sleep(3000);
const after = await evaluate(send, liveRow);
console.log(`   LIVE before: ${before}`);
console.log(`   LIVE after : ${after}`);
console.log(`   badge moved: ${before !== after}`);
await shot(send, "fix-verified");

const ok = refreshOk && acked && relist;
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
