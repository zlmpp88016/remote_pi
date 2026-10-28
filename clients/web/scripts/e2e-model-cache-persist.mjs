import { APP_ORIGIN } from "./_cdp.mjs";
/**
 * Proves the `list_models` catalogue survives a page reload in a REAL browser.
 *
 * The unit runner (`verify-web-models-cache.mjs`) tests the cache class over a
 * fake storage double. This one tests the thing the user actually reported:
 * press F5, and the model picker must NOT fall back to "Asking the host…".
 *
 * It reads `localStorage` directly, so it needs a running app on :3000 and a
 * Chrome/Edge with --remote-debugging-port (CDP_PORT, default 9333).
 *
 * Usage: node scripts/e2e-model-cache-persist.mjs
 */

const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const APP_URL = APP_ORIGIN + "/remote-pi/connect";
const PREFIX = "remote-pi:catalogue:v1:";

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
const page = targets.find((t) => t.type === "page" && t.url.includes("/remote-pi"))
  ?? targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target — open Chrome with --remote-debugging-port");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
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
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
});

const rowsInStorage = async () =>
  evaluate(`(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(${JSON.stringify(PREFIX)}));
    return keys.map((k) => {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        return { key: k, models: Array.isArray(v.models) ? v.models.length : -1 };
      } catch { return { key: k, models: -1 }; }
    });
  })()`);

console.log("\n=== 1. Load the app and let it connect ===");
await send("Page.navigate", { url: APP_URL });
await sleep(10000);

const boot = await evaluate(`(() => {
  const b = document.body.innerText;
  return { connected: b.includes("host connected"), pairingFailed: b.includes("Pairing failed") };
})()`);
check("app reached a live host connection", boot.connected === true,
  boot.pairingFailed ? "pairing failed — daemon offline?" : "");
if (!boot.connected) {
  console.log("\nCannot verify persistence without a connection.");
  ws.close();
  process.exit(1);
}

console.log("\n=== 2. A catalogue must be persisted (not only held in RAM) ===");
await sleep(3000);
let stored = await rowsInStorage();
check("at least one catalogue row is in localStorage", stored.length > 0,
  `rows=${stored.length}`);
check("that row actually carries models", stored.some((r) => r.models > 0),
  stored.map((r) => r.models).join(","));

const before = stored;
const roomKey = before.find((r) => r.models > 0)?.key ?? null;

console.log("\n=== 3. Reload (F5) — the row must SURVIVE ===");
await send("Page.reload", { ignoreCache: true });
await sleep(1500);
// The storage row must not depend on the app having reconnected yet.
const duringLoad = await rowsInStorage();
check("the row still exists right after reload", duringLoad.some((r) => r.key === roomKey),
  `rows=${duringLoad.length}`);

await sleep(9000);

console.log("\n=== 4. After reload the picker must NOT be asking the host ===");
const after = await evaluate(`(() => {
  const b = document.body.innerText;
  // Open the model picker if it is closed, so the spinner would be visible.
  const trigger = document.querySelector('[aria-label*="model" i], button[aria-haspopup="listbox"]');
  trigger?.click();
  return {
    connected: b.includes("host connected"),
    asking: b.includes("Asking the host for this workspace's models"),
    bodyHead: b.slice(0, 200),
  };
})()`);
await sleep(1200);
const picker = await evaluate(`(() => {
  const b = document.body.innerText;
  return {
    asking: b.includes("Asking the host for this workspace's models"),
    noModels: b.includes("The host reported no models for this workspace"),
  };
})()`);
check("no 'Asking the host…' spinner after reload", picker.asking === false,
  picker.asking ? "cache did not survive — this is the reported bug" : "");
check("the picker is not reporting an empty catalogue", picker.noModels === false);

stored = await rowsInStorage();
check("the catalogue row is still present after the full reload", stored.length > 0,
  `rows=${stored.length}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  console.log(`\nbody head: ${after.bodyHead}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
