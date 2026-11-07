/**
 * E2E: pair the Electron shell against a real daemon, then walk every dock tab
 * with real clicks and capture a screenshot of each.
 *
 * Five things cost a debugging round each — all of them are UI facts, not bugs:
 *
 * 1. TWO different tab UIs. Collapsed shows `button.railTabButton` whose `title`
 *    IS the bare label. Expanded shows `span.tabLabel` inside the dock header and
 *    the tab button's `title` is `"label — reason"` (right-rail.tsx:548).
 *    Clicking a rail button expands the dock as a side effect.
 * 2. The connect form has TWO fields. `input[placeholder="wss://…"]` is the RELAY
 *    ADDRESS; `textarea[placeholder^="remotepi://pair"]` is the PAIRING CODE.
 *    Writing the URI into the relay field fails with a generic
 *    "无法读取该配对码" and looks exactly like a parser bug.
 * 3. Setting `.value` is not enough — React needs the native setter plus an
 *    `input` event, otherwise the controlled field stays empty on submit.
 * 4. Body text length is NOT a per-tab signal: the chat transcript dominates it,
 *    so it stays constant across tabs. Detect the active panel by `aria-current`
 *    plus the panel's own heading.
 * 5. `app://app` must be allowed by the daemon (`REMOTE_PI_ALLOWED_ORIGINS=app://app`)
 *    or every WebSocket upgrade is refused as "Origin mismatch".
 *
 * Usage: PAIR='remotepi://pair?...' node scripts/e2e-tabs.mjs [port]
 */

import { mkdirSync, writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9444";
const PAIR = process.env["PAIR"];
const OUT = "scripts/_e2e-evidence";
const TABS = [
  ["sessions", "会话"],
  ["plan", "计划"],
  ["files", "文件"],
  ["changes", "更改"],
  ["plugins", "插件"],
  ["automations", "自动化"],
  ["models", "模型"],
  ["settings", "设置"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error(`no page target on :${port}`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const ev = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) return `__THROW__ ${res.exceptionDetails.text}`;
  return res.result?.value;
};

const shot = async (name) => {
  const res = await Promise.race([
    send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
    sleep(8000).then(() => null),
  ]);
  if (res?.data) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.data, "base64"));
    return `${OUT}/${name}.png`;
  }
  return "(screenshot failed)";
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await send("Page.enable");
await send("Runtime.enable");
mkdirSync(OUT, { recursive: true });

// ── 1. pair ───────────────────────────────────────────────────────────────
console.log("\nA. pairing");
await send("Page.navigate", { url: "app://app/remote-pi/connect" });
await sleep(3000);
await ev("localStorage.clear()");
await send("Page.navigate", { url: "app://app/remote-pi/connect" });
await sleep(4000);

if (PAIR) {
  // Target the PAIRING CODE textarea specifically — fields[0] is the relay
  // address, and pasting a URI there fails as an unreadable pairing code.
  const wrote = await ev(`(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return "no-textarea";
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(PAIR)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return ta.value.slice(0, 40);
  })()`);
  console.log(`  pairing textarea: ${wrote}`);
  await sleep(800);

  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => !x.disabled && /^(Connect|连接)$/i.test((x.textContent || "").trim()));
    if (!b) return "no-button";
    b.click();
    return "clicked";
  })()`);
  console.log(`  connect: ${clicked}`);
  await sleep(15000);
} else {
  console.log("  SKIP — PAIR not set");
}

const pairedNow = await ev(`(document.body.innerText || "").includes("已连接主机")`);
check("paired with host", pairedNow === true, `已连接主机=${pairedNow}`);
await shot("00-paired");

if (!pairedNow) {
  const body = await ev(`(document.body.innerText || "").slice(0, 200)`);
  console.log(`  body: ${body}`);
  ws.close();
  process.exit(1);
}

// ── 2. every tab ──────────────────────────────────────────────────────────
console.log("\nB. dock tabs");
for (const [id, label] of TABS) {
  const how = await ev(`(() => {
    const rail = [...document.querySelectorAll("button[class*='railTabButton']")]
      .find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(label)});
    if (rail) { rail.click(); return "rail"; }
    const tab = [...document.querySelectorAll("button")].find((b) => {
      const span = b.querySelector("span[class*='tabLabel']");
      return span && span.textContent.trim() === ${JSON.stringify(label)};
    });
    if (tab) { tab.click(); return "dock"; }
    return "no-button";
  })()`);
  await sleep(1800);

  // Active tab is marked by aria-current on the dock header button.
  const active = await ev(`(() => {
    const b = [...document.querySelectorAll("button[aria-current='true']")].find((x) => {
      const span = x.querySelector("span[class*='tabLabel']");
      return span && span.textContent.trim() === ${JSON.stringify(label)};
    });
    return Boolean(b);
  })()`);

  // The dock panel region holds the panel's own content; take the last slice of
  // body text because the chat transcript occupies the first thousands of chars
  // and is identical on every tab.
  const panel = await ev(`(() => {
    const body = document.body.innerText || "";
    return body.slice(Math.max(0, body.length - 400)).replace(/\\n+/g, " / ").trim();
  })()`);

  const file = await shot(`tab-${id}`);
  check(
    id,
    (how === "rail" || how === "dock") && active === true,
    `${how}, aria-current=${active} | ${file}\n         ${panel.slice(0, 220)}`,
  );
}

ws.close();
console.log(`\nE2E: ${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
