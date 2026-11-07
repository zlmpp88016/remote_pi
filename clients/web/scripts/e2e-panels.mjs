#!/usr/bin/env node
/**
 * FULL end-to-end verification in a REAL browser, against the REAL daemon.
 *
 * Unlike the `verify-web-*.mjs` runners (pure Node, no browser), this drives the
 * actual app: reload it, let it pair from the stored credential, then exercise
 * every panel and assert on the DOM and on the WebSocket frames the app sends.
 *
 * It exists because the unit-level suites were green while the Sessions panel
 * still showed a permanent "Asking the host…" spinner — the request was never
 * emitted, which no pure-function test could observe.
 *
 * Usage:
 *   node scripts/e2e-panels.mjs                 # verify only
 *   node scripts/e2e-panels.mjs                 # (pairs from the stored credential)
 *
 * Requires Chrome/Edge with --remote-debugging-port (CDP_PORT, default 9333)
 * and the web dev server (port from vite.config.ts).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The dev server origin, read from vite.config.ts so this file never carries a
 * stale port. The config once moved to 3010 while every script still said 3000.
 */
function devPort() {
  try {
    const cfg = readFileSync(join(HERE, "..", "vite.config.ts"), "utf8");
    const m = cfg.match(/server\s*:\s*\{[^}]*?port\s*:\s*(\d+)/s);
    if (m) return Number(m[1]);
  } catch {
    /* fall through */
  }
  return 3010;
}

const APP_ORIGIN = process.env.APP_ORIGIN ?? `http://localhost:${devPort()}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const APP_URL = APP_ORIGIN + "/remote-pi/connect";
const WIDE = { width: 1600, height: 1000 };

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

async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const pages = targets.filter((t) => t.type === "page");
  let page = pages.find((t) => t.url.includes("/remote-pi")) ?? pages[0];
  if (!page) throw new Error("no page target; open Chrome with --remote-debugging-port");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const frames = [];
  const consoleLines = [];
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
      frames.push(String(msg.params.response.payloadData ?? ""));
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleLines.push((msg.params.args ?? []).map((a) => a.value ?? a.description).join(" "));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, frames, consoleLines, page };
}

const { ws, send, frames, consoleLines } = await attach();

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate failed");
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");
// The right dock (and therefore every panel) only exists above 760px.
await send("Emulation.setDeviceMetricsOverride", { ...WIDE, deviceScaleFactor: 1, mobile: false });

console.log("\n=== 1. Load the app fresh ===");
await send("Page.navigate", { url: APP_URL });
await sleep(9000);

const boot = await evaluate(`(() => {
  const b = document.body.innerText;
  return {
    connected: b.includes("host connected"),
    pairingFailed: b.includes("Pairing failed"),
    hasConnectForm: b.includes("Paste the relay address"),
  };
})()`);
check("page reports a live host connection", boot.connected === true,
  boot.pairingFailed ? "pairing failed — is the daemon online?" : "");
if (!boot.connected) {
  console.log("\nCannot continue without a connection. Start the daemon and retry.");
  console.log(`  pairing failed: ${boot.pairingFailed}, connect form: ${boot.hasConnectForm}`);
  ws.close();
  process.exit(1);
}

console.log("\n=== 2. Workspace auto-selection ===");
// Everything room-scoped (sessions, models, transcript) is gated on a selected
// room. The daemon reports one running workspace, so it must be adopted without
// any Start click. NOTE: the frame buffer is deliberately NOT cleared here —
// auto-selection happens during connect, and its `session_list` is exactly what
// section 3 asserts on.
await sleep(1500);
let state = await evaluate(`(() => {
  const b = document.body.innerText;
  return {
    running: b.includes("running"),
    transcriptReady: b.includes("Send the message"),
    sessionPromptVisible: b.includes("session"),
  };
})()`);
check("a running workspace is listed", state.running === true);
check("its transcript is open without pressing Start", state.transcriptReady === true);

console.log("\n=== 3. Sessions panel ===");
const opened = await evaluate(`(() => {
  const s = [...document.querySelectorAll("span.sr-only")]
    .find((el) => (el.innerText || "").trim() === "会话");
  if (!s) return { ok: false, why: "no Sessions tab button in the dock" };
  s.closest("button")?.click();
  return { ok: true };
})()`);
check("Sessions tab is present in the dock", opened.ok === true, opened.why ?? "");

await sleep(4000);

state = await evaluate(`(() => {
  const b = document.body.innerText;
  const i = b.indexOf("SESSIONS");
  // Scope the spinner assertion to the Sessions PANEL, not the whole page: the
  // same sentence can legitimately appear in another dock panel's body.
  const panel = i >= 0 ? b.slice(i, i + 900) : "";
  return {
    spinning: /Asking the host for this workspace's sessions/.test(panel),
    modelsLeak: /List the workspace's models/.test(panel),
    disabled: /List this workspace's sessions/.test(panel),
    empty: /No sessions in this workspace/.test(panel),
    panel: panel || null,
    rows: document.querySelectorAll("ul li button[title]").length,
  };
})()`);

check("no permanent spinner", state.spinning === false,
  state.spinning ? "the panel is still waiting for a reply" : "");
check("the panel is not showing a disabled reason", state.disabled === false);
check("the models sentence never appears in the Sessions panel", state.modelsLeak === false);
check("the session list resolved (rows or an explicit empty state)",
  state.rows > 0 || state.empty === true,
  `rows=${state.rows} empty=${state.empty}`);

// The decisive check: did the app actually ASK the host? Frames are collected
// from the moment Network is enabled, so a request issued during connect (the
// auto-selection path) is still in the buffer here.
//
// The protocol type lives INSIDE the base64 `ct` of an outer envelope, so a
// plain substring search over the frame text finds nothing. Requests to a
// workspace ride `host_forward`, whose OWN `ct` carries the real inner type —
// decode both levels.
function decodeCt(data) {
  try {
    const env = JSON.parse(data);
    if (typeof env.ct !== "string") return null;
    return JSON.parse(Buffer.from(env.ct, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
const innerTypes = [];
for (const f of frames) {
  const inner = decodeCt(f);
  if (!inner) continue;
  if (inner.type === "host_forward" && typeof inner.ct === "string") {
    try {
      innerTypes.push(JSON.parse(Buffer.from(inner.ct, "base64").toString("utf8")).type);
    } catch {
      innerTypes.push("host_forward");
    }
  } else {
    innerTypes.push(inner.type);
  }
}
const askedList = innerTypes.includes("session_list");
check("session_list was sent on the wire", askedList === true,
  `inner frames: ${[...new Set(innerTypes)].slice(0, 8).join(", ")}`);

console.log("\n=== 4. Models panel ===");
await evaluate(`(() => {
  const s = [...document.querySelectorAll("span.sr-only")]
    .find((el) => (el.innerText || "").trim() === "模型");
  s?.closest("button")?.click();
})()`);
await sleep(2000);
state = await evaluate(`(() => {
  const b = document.body.innerText;
  return {
    spinning: b.includes("Asking the host for this workspace's models"),
    pickerPresent: b.includes("select a model") || /[A-Za-z0-9._-]+\\s*\\/\\s*[A-Za-z0-9._-]+/.test(b),
  };
})()`);
check("model picker is populated at connect time", state.spinning === false,
  state.spinning ? "still asking — the prefetch did not land" : "");

console.log("\n=== 5. No client-side errors ===");
const realErrors = consoleLines.filter(
  (l) => !/DevTools|Fast Refresh|HMR|Download the React/i.test(l),
);
check("no uncaught console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  if (state.panel) console.log(`\nSessions panel text:\n${state.panel}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
