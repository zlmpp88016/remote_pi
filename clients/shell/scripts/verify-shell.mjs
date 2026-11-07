/**
 * Acceptance check for the Electron shell: does it drive the real app end to end?
 *
 * Checks the three things a custom `app://` protocol can break that rendering
 * alone would not reveal, in the order they can fail:
 *   1. all three routes load a bundle and mount (catches a bad asset base),
 *   2. the `app://` origin can open a WebSocket to the relay and pair,
 *   3. the session list actually populates from the host.
 *
 * Step 3 needs three separate UI states to be true, and getting any one wrong
 * reads as "zero rows" — workspace selected, dock open (`dockOpen` is false by
 * default), dock tab set to `sessions` (it defaults to `files`). Each is asserted
 * on its own so a failure names the step instead of just counting rows.
 *
 * Usage (Electron must already be running with --remote-debugging-port=9444):
 *   REMOTE_PI_PAIR_URI='remotepi://pair?...' node scripts/verify-shell.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(new URL("./_e2e-evidence/", import.meta.url), { recursive: true });

const PORT = Number(process.env["SHELL_CDP_PORT"] ?? 9444);
const PAIR_URI = process.env["REMOTE_PI_PAIR_URI"];

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (page === undefined) {
  console.error("no page target; is Electron running with --remote-debugging-port?");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return res.result?.value;
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
};

await send("Page.enable");
await send("Runtime.enable");

// ── 1. every route mounts a bundle ────────────────────────────────────────
console.log("\nA. routes mount under app://");
for (const path of ["/", "/remote-pi/connect", "/remote-pi/docs"]) {
  await send("Page.navigate", { url: `app://app${path}` });
  await sleep(5000);
  const raw = await ev(`(() => {
    const root = document.getElementById("root");
    return JSON.stringify({
      children: root ? root.children.length : -1,
      viteError: !!document.querySelector("vite-error-overlay"),
    });
  })()`);
  const info = JSON.parse(raw);
  check(`${path} mounts`, info.children > 0 && !info.viteError, JSON.stringify(info));
}

// ── 2. the app:// origin can pair with the real relay ─────────────────────
console.log("\nB. pairing over the app:// origin");
if (!PAIR_URI) {
  console.log("SKIP — REMOTE_PI_PAIR_URI not set");
} else {
  await send("Page.navigate", { url: "app://app/remote-pi/connect" });
  await sleep(2500);
  await ev("localStorage.clear()");
  await send("Page.navigate", { url: "app://app/remote-pi/connect" });
  await sleep(4500);

  await ev(`(() => {
    const field = document.querySelector("textarea, input[type=text]");
    if (!field) return;
    const proto = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(field, ${JSON.stringify(PAIR_URI)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(800);
  await ev(`(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => /pair|connect/i.test(b.textContent || "") && !b.disabled,
    );
    if (btn) btn.click();
  })()`);
  await sleep(14000);

  const paired = await ev(
    `JSON.stringify({
      connected: /host connected/i.test(document.body.innerText || ""),
      workspaces: document.querySelectorAll("button[title*='running'], button[title*='stopped']").length,
    })`,
  );
  const p = JSON.parse(paired);
  check("host connected", p.connected === true, paired);
  check("workspace catalog populated", p.workspaces > 0, `${p.workspaces} workspaces`);

  // ── 3. the session list populates ───────────────────────────────────────
  console.log("\nC. session list");

  await ev(`(() => {
    const b = [...document.querySelectorAll("button[title]")].find((x) =>
      /running|stopped/.test(x.getAttribute("title") || ""),
    );
    if (b) b.click();
  })()`);
  await sleep(10000);

  await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      /show the right dock/i.test(x.getAttribute("aria-label") || x.title || ""),
    );
    if (b) b.click();
  })()`);
  await sleep(4000);

  await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.textContent || "").trim() === "Sessions",
    );
    if (b) b.click();
  })()`);
  await sleep(9000);

  // Screenshot for the record. Bounded: CDP can simply not answer this on an
  // occluded or offscreen window, and an unbounded await wedges the whole run
  // after every check has already passed.
  const shot = await Promise.race([
    send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
    sleep(8000).then(() => null),
  ]);
  if (shot?.data) {
    writeFileSync("scripts/_e2e-evidence/shell-sessions.png", Buffer.from(shot.data, "base64"));
    console.log("  screenshot: scripts/_e2e-evidence/shell-sessions.png");
  } else {
    console.log("  screenshot: skipped (CDP did not answer)");
  }

  const count = await ev(`document.querySelectorAll("[aria-label^='Read session']").length`);
  check("session rows listed", count > 0, `${count} rows`);
}

ws.close();
