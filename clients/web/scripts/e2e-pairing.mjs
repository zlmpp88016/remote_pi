/**
 * REAL-BROWSER pairing test.
 *
 * Drives the actual app in a real Chrome over CDP: types the real pairing URI
 * into the real form, clicks the real Connect button, and records every
 * WebSocket frame the page sends and receives. Nothing is mocked.
 *
 * Usage:
 *   node scripts/e2e-pairing.mjs [--cdp=9333]
 */

const CDP_PORT = Number(process.argv.find((a) => a.startsWith("--cdp="))?.slice("--cdp=".length) ?? 9333);
const APP_URL = APP_ORIGIN + "/remote-pi/connect";

// Real credentials read from the host — never invented.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_ORIGIN } from "./_cdp.mjs";

function readHostIdentity() {
  const dir = join(homedir(), ".pi", "remote");
  const identity = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
  const pairing = JSON.parse(readFileSync(join(dir, "pairing.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const epk = identity.pk;
  return {
    epk,
    token: pairing.token,
    name: pairing.name ?? "lei",
    relay: config.relay ?? "https://relay.880160.xyz",
  };
}

const host = readHostIdentity();
const uri =
  `remotepi://pair?t=${encodeURIComponent(host.token)}` +
  `&epk=${encodeURIComponent(host.epk)}` +
  `&n=${encodeURIComponent(host.name)}` +
  `&rm=host&r=${encodeURIComponent(host.relay)}`;

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
const frames = [];
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
  if (msg.method === "Network.webSocketFrameSent") {
    frames.push({ dir: "SENT", data: String(msg.params.response.payloadData ?? "") });
  }
  if (msg.method === "Network.webSocketFrameReceived") {
    frames.push({ dir: "RECV", data: String(msg.params.response.payloadData ?? "") });
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate failed");
  return r.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
});

console.log("\n=== 1. Clear stored pairing and load the app fresh ===");
await evaluate(`localStorage.clear(); sessionStorage.clear(); true`);
await send("Page.navigate", { url: APP_URL });
await sleep(7000);

let state = await evaluate(`(() => {
  const b = document.body.innerText;
  return {
    hasForm: b.includes("Paste the relay address"),
    textareaCount: document.querySelectorAll("textarea").length,
  };
})()`);
check("the connect form is shown", state.hasForm === true, `textareas=${state.textareaCount}`);

console.log("\n=== 2. Type the REAL pairing URI and click Connect ===");
const typed = await evaluate(`(() => {
  const ta = document.querySelector("textarea");
  if (!ta) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(uri)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: ta.value.slice(0, 40) };
})()`);
check("the pairing URI was typed into the form", typed.ok === true);

await sleep(800);
const clicked = await evaluate(`(() => {
  const btn = [...document.querySelectorAll("button")]
    .find((b) => /^connect$/i.test((b.innerText || "").trim()));
  if (!btn) return { ok: false, buttons: [...document.querySelectorAll("button")].map(b => (b.innerText||"").trim()).slice(0,8) };
  btn.click();
  return { ok: true };
})()`);
check("the Connect button was clicked", clicked.ok === true, clicked.buttons ? JSON.stringify(clicked.buttons) : "");

console.log("\n=== 3. Wait for the handshake ===");
await sleep(16000);

state = await evaluate(`(() => {
  const b = document.body.innerText;
  return {
    connected: b.includes("host connected"),
    pairingFailed: b.includes("Pairing failed"),
    timeout: b.includes("The host machine did not answer"),
    head: b.slice(0, 300),
  };
})()`);
check("the page reports a live host connection", state.connected === true,
  state.pairingFailed ? `pairing failed${state.timeout ? " (timeout)" : ""}` : "");

console.log("\n=== 4. Real WebSocket frames ===");
// Outer envelopes look like {"peer":"…","room":"host","ct":"<base64>"}.
// The protocol type (pair_request / pair_ok / …) lives INSIDE the base64 `ct`,
// so a plain substring search over the frame text finds nothing.
function decodeCt(data) {
  try {
    const env = JSON.parse(data);
    if (typeof env.ct !== "string") return null;
    return JSON.parse(Buffer.from(env.ct, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const decoded = frames.map((f) => ({ dir: f.dir, inner: decodeCt(f.data), raw: f.data }));
const relevant = decoded.filter((f) =>
  f.inner !== null || /hello|challenge|auth|"ping"|"pong"/.test(f.raw));

if (relevant.length === 0) {
  console.log("  (no protocol frames captured)");
} else {
  for (const f of relevant.slice(0, 22)) {
    if (f.inner) {
      const summary = JSON.stringify(f.inner).slice(0, 130);
      console.log(`  ${f.dir} [envelope] ${summary}`);
    } else {
      console.log(`  ${f.dir} ${f.raw.slice(0, 110)}`);
    }
  }
}

const sentPair = decoded.some((f) => f.dir === "SENT" && f.inner?.type === "pair_request");
const recvPair = decoded.some((f) => f.dir === "RECV" && f.inner?.type === "pair_ok");
check("the browser SENT pair_request", sentPair === true,
  sentPair ? "" : "never left the client");
check("the browser RECEIVED pair_ok", recvPair === true,
  recvPair ? "" : "host never answered — this is the reported failure");

console.log("\n=== 5. Uncaught console errors ===");
const real = consoleErrors.filter((l) => !/DevTools|Fast Refresh|HMR|Download the React/i.test(l));
check("no uncaught console errors", real.length === 0, real.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  console.log(`\npage head:\n${state.head}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
