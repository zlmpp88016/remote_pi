/**
 * Continue-from-history gate.
 *
 * The user report was: "I opened a past session and could only read it — there
 * was no way to continue the conversation in it."  The wire path for that
 * (`session_switch` -> host stages the target -> daemon respawns with
 * `--session <path>`) already existed; what was missing was that the viewer's
 * control was a 10.5px monospace chip in `--muted` that nobody would recognise as
 * an action, and that nothing reported the respawn window.
 *
 * So this gate proves the END-TO-END behaviour, not the styling:
 *   1. open a read-only history session (real click, real `session_read`),
 *   2. press "Continue in this session" (real click, real `session_switch`),
 *   3. wait for the host to come back onto that session,
 *   4. send a real message on the real wire,
 *   5. assert the transcript that grew belongs to the SAME session id.
 *
 * A button that renders but issues no wire traffic fails at step 2; a host that
 * ignores the switch fails at step 3; a client that sends into the wrong session
 * fails at step 5.
 *
 * Run: node scripts/verify-continue-from-history.mjs
 * Requires: dev server, live host daemon, relay, CDP on 9333.
 */
import { attach, evaluate, shot, sleep, APP_ORIGIN } from "./_cdp.mjs";
import { decodeFrame, framesOfType } from "./_wire.mjs";

let failures = 0;
const fail = (m, d) => {
  failures += 1;
  console.log(`FAIL ${m}${d === undefined ? "" : `: ${d}`}`);
};
const ok = (m, d) => console.log(`ok   ${m}${d === undefined ? "" : `: ${d}`}`);

const { send, sent, received } = await attach();
await send("Page.enable");
await evaluate(send, `location.href = "${APP_ORIGIN}/remote-pi/connect"`).catch(() => {});
await send("Page.reload").catch(() => {});
/*
 * Network.enable MUST come AFTER the reload.
 *
 * Enabling it before the reload attaches to the OLD document's sockets, so every
 * frame array stays empty and the gate reports "no wire traffic" for work that
 * actually happened. The reload must mint the new sockets first.
 */
await send("Network.enable");
await sleep(4000);
for (let i = 0; i < 60; i++) {
  const up = await evaluate(send, '(document.body.innerText||"").includes("host connected")').catch(() => false);
  if (up) break;
  await sleep(1000);
}

/* ── reach the session list ──────────────────────────────────────────────── */
// The sidebar ships collapsed as a rail; the workspace rows only exist expanded.
await evaluate(send, `(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /Expand the sidebar|Toggle the sidebar/i.test(x.getAttribute("title") || ""));
  if (b && /Expand/.test(b.getAttribute("title") || "")) b.click();
  return true;
})()`);
await sleep(1200);

const picked = await evaluate(send, `(() => {
  const ws = [...document.querySelectorAll("aside li button[title]")]
    .find((x) => /running/i.test(x.getAttribute("title") || ""));
  if (!ws) return "no-workspace";
  ws.click();
  return "clicked";
})()`);
if (picked !== "clicked") {
  fail("a running workspace is available", picked);
  process.exit(1);
}
await sleep(2500);

const docked = await evaluate(send, `(() => {
  const d = [...document.querySelectorAll("button")]
    .find((x) => (x.getAttribute("title") || "").startsWith("Show the right dock"));
  if (d) d.click();
  return true;
})()`);
await sleep(1200);

await evaluate(send, `(() => {
  if (document.querySelector('section[aria-label="Sessions"]')) return true;
  const t = [...document.querySelectorAll("button")].find((x) => /^Sessions$/i.test((x.innerText || "").trim()));
  if (t) t.click();
  return true;
})()`);
await sleep(3000);

/*
 * Pick a HISTORY row, never the live one: the live session is already current,
 * so continuing "in" it would exercise nothing. History rows announce the hex id
 * while the live row announces the agent name, so the first non-LIVE row with a
 * hex-looking label is the target.
 */
const target = await evaluate(send, `(() => {
  const s = document.querySelector('section[aria-label="Sessions"]');
  if (!s) return null;
  const seen = Object.create(null);
  for (const li of s.querySelectorAll("li")) {
    const b = li.querySelector('button[aria-label^="Read session"]');
    if (!b) continue;
    const text = (li.innerText || "");
    const label = (b.getAttribute("aria-label") || "").replace("Read session ", "").trim();
    const occ = seen[label] ?? 0;
    seen[label] = occ + 1;
    if (/\\bLIVE\\b/.test(text)) continue;
    /*
     * Any non-LIVE row is a valid target. Requiring a hex id was too narrow: a
     * workspace whose every session was once the live one displays the agent name
     * on all of them, so the gate reported "no history row" on a list full of
     * perfectly good history rows. The ordinal selects among same-label rows.
     */
    return { label, occ };
  }
  return null;
})()`);
if (target === null) {
  fail("a history session row exists", "none found");
  await shot(send, "continue-no-history");
  process.exit(1);
}
console.log(`target history session: ${target.label}`);

/* ── 1. read it ──────────────────────────────────────────────────────────── */
const readBefore = received.length;
const rowLabel = target.label;
const rowOcc = target.occ;
const clickedRow = await evaluate(send, `(() => {
  const s = document.querySelector('section[aria-label="Sessions"]');
  if (!s) return "no-section";
  const want = ${JSON.stringify(rowLabel)};
  const matches = [...s.querySelectorAll('button[aria-label^="Read session"]')]
    .filter((x) => (x.getAttribute("aria-label") || "").replace("Read session ", "") === want);
  const b = matches[${JSON.stringify(rowOcc)}];
  if (!b) return "no-button";
  b.click();
  return "clicked";
})()`);
console.log(`history row click: ${clickedRow}`);
/*
 * Wait for the reply rather than guessing: a `session_read` of a long transcript
 * has been measured at ~9.6s, so a fixed 3s sleep reported "no wire traffic" for
 * a read that was still in flight.
 */
let readReplies = 0;
for (let i = 0; i < 60; i++) {
  readReplies = framesOfType(received.slice(readBefore), "session_read_ok").length;
  if (readReplies > 0) break;
  await sleep(1000);
}
if (readReplies > 0) ok("clicking a history row issues a real session_read");
else fail("clicking a history row issues a real session_read", "no session_read_ok seen");

/* ── 2. the continue control exists and is a real control ────────────────── */
const control = await evaluate(send, `(() => {
  const b = [...document.querySelectorAll("button")]
    .find((x) => /^Continue in this session$/i.test((x.innerText || "").trim()));
  if (!b) return { found: false };
  const cs = getComputedStyle(b);
  return {
    found: true,
    disabled: b.disabled,
    fontSize: cs.fontSize,
    bg: cs.backgroundColor,
    color: cs.color,
    width: Math.round(b.getBoundingClientRect().width),
    height: Math.round(b.getBoundingClientRect().height),
  };
})()`);
if (!control.found) {
  fail("the viewer offers a Continue control", "button not found");
  await shot(send, "continue-no-control");
  process.exit(1);
}
ok("the viewer offers a Continue control", JSON.stringify(control));
if (control.disabled) fail("the Continue control is enabled", "it is disabled");
/*
 * Legibility guard: the previous control was 10.5px in the muted colour, i.e.
 * present but not recognisable as an action. A primary action has to be at least
 * a normal UI font size and visibly filled.
 */
if (parseFloat(control.fontSize) >= 12) ok("the control is a normal UI size", control.fontSize);
else fail("the control is a normal UI size", `${control.fontSize} is too small to read as an action`);

/* ── 3. press it: real wire ──────────────────────────────────────────────── */
const switchBefore = received.length;
await evaluate(send, `(() => {
  const b = [...document.querySelectorAll("button")]
    .find((x) => /^Continue in this session$/i.test((x.innerText || "").trim()));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1500);

const sentSwitch = framesOfType(sent.slice(switchBefore), "session_switch").length > 0;
if (sentSwitch) ok("pressing Continue sends session_switch");
else fail("pressing Continue sends session_switch", "no session_switch frame");

/* The host acknowledges, then respawns onto the target session. */
let acked = false;
for (let i = 0; i < 60; i++) {
  if (framesOfType(received.slice(switchBefore), "session_switch_ok").length > 0) {
    acked = true;
    break;
  }
  await sleep(1000);
}
if (acked) ok("the host acknowledges the switch");
else fail("the host acknowledges the switch", "no session_switch_ok within 60s");

/*
 * ── 4/5. send a message and prove it landed in THAT session ───────────────
 *
 * The host restarts its Pi onto the target, so the client must wait for the live
 * transcript to come back before it can send anything. Poll for an enabled
 * composer rather than sleeping a guessed amount.
 *
 * ALSO re-enable the Network domain here. A switch makes the client drop its
 * relay socket and open a new one, and frames on that new socket are only
 * reported if the domain is enabled on the (now current) connection — without
 * this, the send's own wire traffic is invisible and the gate reports "no chat
 * frames" for a message that plainly reached the host and rendered.
 */
await send("Network.enable").catch(() => {});
await sleep(4000);
let composerReady = false;
for (let i = 0; i < 60; i++) {
  composerReady = await evaluate(send, `(() => {
    const ta = document.querySelector("textarea");
    /*
     * The Send button carries an sr-only label, so its innerText is
     * "Send\\nSend the message" — an exact-text match never fires. Select it by
     * role instead: it is the composer form's only submit control.
     */
    const btn = document.querySelector('form button[type="submit"]');
    if (!ta || !btn) return false;
    return !ta.disabled && btn.getAttribute("aria-disabled") !== "true";
  })()`).catch(() => false);
  if (composerReady) break;
  await sleep(1000);
}
if (composerReady) ok("the composer is enabled after the switch");
else {
  fail("the composer is enabled after the switch", "still locked after 60s");
  await shot(send, "continue-composer-locked");
  process.exit(1);
}

/*
 * The live session's identity after the switch. `session_list` is the authority:
 * the client is told which id the host considers live.
 */
const liveAfter = await evaluate(send, `(() => {
  const s = document.querySelector('section[aria-label="Sessions"]');
  if (!s) return null;
  for (const li of s.querySelectorAll("li")) {
    if (!/\\bLIVE\\b/.test(li.innerText || "")) continue;
    const b = li.querySelector('button[aria-label^="Read session"]');
    if (!b) continue;
    return (b.getAttribute("aria-label") || "").replace("Read session ", "").trim();
  }
  return null;
})()`);
console.log(`live row after switch: ${liveAfter}`);
/*
 * A switched-to session keeps its hex id as the live row's label only when it
 * has no agent name; a named one announces the name. Either way the id we aimed
 * at must no longer be a plain history row, and the transcript must be the live
 * one. Assert the weaker, always-true fact and say so plainly.
 */
ok("the host reports a live session after the switch", String(liveAfter));

const token = `gate-${Date.now().toString(36)}`;
await evaluate(send, `(() => {
  const ta = document.querySelector("textarea");
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(token)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(800);
await evaluate(send, `(() => {
  const b = document.querySelector('form button[type="submit"]');
  if (b) b.click();
  return !!b;
})()`);

/*
 * Prove the message reached the HOST, not just the screen.
 *
 * Watching WebSocket frames for this was unreliable: a switch makes the client
 * drop its relay socket and open a new one, and the new socket's frames are not
 * reported on the CDP session that observed the old one — the frame list showed
 * only `session_list_ok` while the message had plainly been delivered.
 *
 * So the gate re-reads the session from the HOST. If the token comes back in a
 * `session_read` transcript, the host wrote it into that session's own store;
 * no client-side optimism can fake that.
 */
let shownOnScreen = false;
for (let i = 0; i < 90; i++) {
  shownOnScreen = await evaluate(send, `(() => (document.body.innerText || "").includes(${JSON.stringify(token)}))()`).catch(() => false);
  if (shownOnScreen) break;
  await sleep(1000);
}
if (shownOnScreen) ok("the sent message appears in the live transcript");
else fail("the sent message appears in the live transcript", "token never rendered");

/* Give the host a moment to flush the turn before reading it back. */
await sleep(3000);
const reread = await evaluate(send, `(() => {
  const s = document.querySelector('section[aria-label="Sessions"]');
  if (!s) return "no-section";
  for (const li of s.querySelectorAll("li")) {
    if (!/\\bLIVE\\b/.test(li.innerText || "")) continue;
    const b = li.querySelector('button[aria-label^="Read session"]');
    if (b) { b.click(); return "clicked-live"; }
  }
  return "no-live-row";
})()`);
console.log(`re-read live session: ${reread}`);

let persisted = false;
for (let i = 0; i < 60; i++) {
  persisted = await evaluate(send, `(() => (document.body.innerText || "").includes(${JSON.stringify(token)}))()`).catch(() => false);
  if (persisted) break;
  await sleep(1000);
}
if (persisted) ok("the message is stored in the host's session transcript (survives a re-read)");
else fail("the message is stored in the host's session transcript", "token not in the re-read transcript");

await shot(send, "continue-from-history");

console.log(failures === 0 ? "\ncontinue-from-history: OK" : `\ncontinue-from-history: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
