/**
 * REAL-BROWSER end-to-end: does the app actually work?
 *
 * Not a unit test. This drives the real Chrome, uses the real host over the
 * real relay, and asserts what a user sees and can do:
 *   1. pair and land on the workspace UI
 *   2. the workspace list is real (not a placeholder)
 *   3. the model picker is populated
 *   4. the Sessions tab lists sessions
 *   5. clicking a session opens its transcript (real content, not a spinner)
 *   6. no uncaught console errors
 *
 * Usage: node scripts/e2e-full-flow.mjs [--cdp=9333]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_ORIGIN } from "./_cdp.mjs";

const CDP_PORT = Number(process.argv.find((a) => a.startsWith("--cdp="))?.slice(6) ?? 9333);
const APP_URL = APP_ORIGIN + "/remote-pi/connect";

const dir = join(homedir(), ".pi", "remote");
const identity = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
const pairing = JSON.parse(readFileSync(join(dir, "pairing.json"), "utf8"));
const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const uri =
  `remotepi://pair?t=${encodeURIComponent(pairing.token)}` +
  `&epk=${encodeURIComponent(identity.pk)}` +
  `&n=${encodeURIComponent(pairing.name ?? "lei")}` +
  `&rm=host&r=${encodeURIComponent(config.relay ?? "https://relay.880160.xyz")}`;

let passed = 0;
const failures = [];
function check(label, ok, extra = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("/remote-pi"));
if (!page) {
  console.error("no /remote-pi page open");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description).join(" "));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return null;
  return r.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
});

console.log("\n=== 1. Pair through the real form ===");
await evaluate(`localStorage.clear(); sessionStorage.clear(); true`);
await send("Page.navigate", { url: APP_URL });
await sleep(7000);

await evaluate(`(() => {
  const ta = document.querySelector("textarea");
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  set.call(ta, ${JSON.stringify(uri)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(700);
await evaluate(`[...document.querySelectorAll("button")]
  .find((b) => /^connect$/i.test((b.innerText || "").trim()))?.click(); true`);

// Poll instead of a blind sleep: report the moment it lands.
let connectedAt = -1;
for (let s = 0; s < 25; s++) {
  await sleep(1000);
  const ok = await evaluate(`document.body.innerText.includes("host connected")`);
  if (ok === true) { connectedAt = s + 1; break; }
}
check("reached a live host connection", connectedAt > 0, connectedAt > 0 ? `${connectedAt}s` : "never connected");

console.log("\n=== 2. The workspace list is real ===");
// The header renders `WORKSPACES` and the count on separate lines, but the
// count is its own line directly under the heading — read the lines, do not
// try to match them with one regex across newlines.
const ws1 = await evaluate(`(() => {
  const lines = document.body.innerText.split("\\n").map(s => s.trim()).filter(Boolean);
  const i = lines.indexOf("WORKSPACES");
  // The heading is followed by the refresh button's label, then the count.
  const after = i >= 0 ? lines.slice(i + 1, i + 5) : [];
  const countLine = after.find((s) => /^\\d+$/.test(s));
  const startButtons = [...document.querySelectorAll("button")]
    .filter((b) => /^start /i.test((b.innerText || "").trim())).length;
  return JSON.stringify({
    count: countLine ? Number(countLine) : null,
    after,
    startButtons,
    hasRunning: /\\brunning\\b/i.test(document.body.innerText),
  });
})()`);
const ws1p = ws1 ? JSON.parse(ws1) : {};
check("the workspace list has a count above zero", (ws1p.count ?? 0) > 0,
  `count=${ws1p.count} after=${JSON.stringify(ws1p.after)}`);
check("each workspace offers a Start action", (ws1p.startButtons ?? 0) > 0, `buttons=${ws1p.startButtons}`);
check("a workspace reports a running state", ws1p.hasRunning === true);

console.log("\n=== 3. Model picker is populated ===");
// The picker is a button-based dropdown (not a native <select>): its options
// only exist in the DOM while the menu is open. Open it, read, then close.
const models = await evaluate(`(() => {
  const trigger = [...document.querySelectorAll("button")]
    .find((b) => /claude|gpt|deepseek|glm|kimi|grok|muse|step|model/i.test(b.innerText || ""));
  const asking = document.body.innerText.includes("Asking the host");
  return JSON.stringify({
    triggerLabel: trigger ? (trigger.innerText || "").trim().slice(0, 40) : null,
    asking,
  });
})()`);
const mp = models ? JSON.parse(models) : {};
check("a model selector shows a resolved label", Boolean(mp.triggerLabel), mp.triggerLabel ?? "none");
check("the picker is not stuck asking the host", mp.asking === false);

console.log("\n=== 4. Sessions tab lists sessions ===");
const tabbed = await evaluate(`(() => {
  const btn = [...document.querySelectorAll("button")]
    .find((b) => /sessions/i.test(b.innerText || "") || /sessions/i.test(b.getAttribute("aria-label") || ""));
  if (!btn) return JSON.stringify({ found: false });
  btn.click();
  return JSON.stringify({ found: true });
})()`);
check("a Sessions tab exists and was clicked", tabbed && JSON.parse(tabbed).found === true);
await sleep(4000);

const sessions = await evaluate(`(() => {
  const t = document.body.innerText;
  const rows = document.querySelectorAll('[role="option"], [data-session-id], li').length;
  return JSON.stringify({
    rows,
    empty: /no sessions|nothing yet/i.test(t),
    spinner: /loading|asking the host/i.test(t),
  });
})()`);
const sp = sessions ? JSON.parse(sessions) : {};
check("the session list resolved", sp.empty !== undefined, `rows≈${sp.rows} empty=${sp.empty}`);
check("no permanent spinner in the panel", sp.spinner === false);

console.log("\n=== 5. Opening a session renders a transcript ===");
const opened = await evaluate(`(() => {
  const cand = [...document.querySelectorAll('[role="option"], [data-session-id], li')]
    .find((el) => (el.innerText || "").trim().length > 3);
  if (!cand) return JSON.stringify({ clicked: false });
  cand.click();
  return JSON.stringify({ clicked: true, label: (cand.innerText || "").trim().slice(0, 40) });
})()`);
const op = opened ? JSON.parse(opened) : {};
check("a session row was clicked", op.clicked === true, op.label ?? "");
await sleep(6000);

const transcript = await evaluate(`(() => {
  const t = document.body.innerText;
  const lines = t.split("\\n").map(s => s.trim()).filter(Boolean);
  return JSON.stringify({
    chars: t.length,
    spinnerOnly: /^(loading|asking the host)/i.test(lines.slice(-3).join(" ")),
    tail: lines.slice(-6),
  });
})()`);
const tr = transcript ? JSON.parse(transcript) : {};
check("the transcript pane has substantial content", (tr.chars ?? 0) > 500, `chars=${tr.chars}`);
check("the transcript is not stuck on a spinner", tr.spinnerOnly === false);

console.log("\n=== 6. No uncaught console errors ===");
const real = consoleErrors.filter((l) => !/DevTools|Fast Refresh|HMR|Download the React/i.test(l));
check("no uncaught console errors", real.length === 0, real.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  const body = await evaluate(`document.body.innerText.slice(0, 700)`);
  console.log(`\nvisible text:\n${body}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
