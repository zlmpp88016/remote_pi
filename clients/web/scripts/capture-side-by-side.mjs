/**
 * Side-by-side capture: DSH (the reference) against our client, same viewport.
 *
 * This exists because the earlier "parity" work asserted computed CSS values and
 * never once put the two interfaces next to each other. A hundred matching values
 * can still add up to a different-looking product — that is exactly what happened
 * when the entire UI was built on a dark palette while the reference rendered
 * white. Look at the images; do not trust the assertions alone.
 *
 * Both shots use the SAME viewport (1600x945) and the same device scale factor,
 * and the sidebar is forced into its expanded state on both sides, so the two
 * images can be diffed by eye without adjusting for layout state.
 *
 * Run:
 *   DSH_URL='http://127.0.0.1:3099/?token=<token>' node scripts/capture-side-by-side.mjs
 * The token is printed by `dsh web` on startup and dies with the process.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, sleep, APP_ORIGIN, EVIDENCE } from "./_cdp.mjs";

const VIEWPORT = { width: 1600, height: 945 };
const DSH_URL = process.env.DSH_URL ?? "http://127.0.0.1:3099/";
const CDP = Number(process.env.CDP_PORT ?? 9333);

const OUT = join(EVIDENCE, "side-by-side");
mkdirSync(OUT, { recursive: true });

/* One tab for both captures, addressed by target id (see verify-sidebar-parity
 * for why `attach()` is unusable when a script navigates away from our origin). */
async function openTab(url) {
  const created = await (
    await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = msg.id && pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, id: created.id, ws };
}

const { send, ws } = await openTab("about:blank");
await send("Page.enable");

const goto = async (url) => {
  await send("Page.navigate", { url }).catch(() => {});
  await sleep(3000);
};

const shoot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = join(OUT, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(`  wrote ${path}`);
  return path;
};

const viewport = () =>
  send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

/* ── 1. the reference ────────────────────────────────────────────────────── */
await goto(DSH_URL);
const hasToken = /[?&]token=/.test(DSH_URL);
for (let i = 0; i < 60; i++) {
  const text = await evaluate(send, `(document.body.innerText || "").slice(0, 200)`).catch(() => "");
  if (/authentication required/i.test(text) && hasToken) {
    await sleep(1000);
    continue;
  }
  if (text.length > 30) break;
  await sleep(1000);
}
await viewport();
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(
    send,
    '!!document.querySelector("[class*=sidebarCol]") || document.body.innerText.length > 200',
  ).catch(() => false);
  if (ready) break;
  await sleep(500);
}
await sleep(2500);
const dshText = await evaluate(send, `(document.body.innerText||"").replace(/\\s+/g," ")`).catch(() => "");
if (/authentication required/i.test(dshText)) {
  console.error(
    "DSH refused the request. Pass the CURRENT token:\n  DSH_URL='http://127.0.0.1:3099/?token=<token>' node scripts/capture-side-by-side.mjs",
  );
  process.exit(1);
}
await shoot("01-dsh-reference");

/* ── 2. our client ───────────────────────────────────────────────────────── */
await goto(`${APP_ORIGIN}/remote-pi/connect`);
for (let i = 0; i < 60; i++) {
  const up = await evaluate(send, '(document.body.innerText||"").includes("host connected")').catch(() => false);
  if (up) break;
  await sleep(1000);
}
await viewport();
await sleep(2000);
/* Expand the rail so both sides show the full-width sidebar. */
await evaluate(send, `(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /Expand the sidebar/i.test(x.getAttribute("title") || ""));
  if (b) b.click();
  return true;
})()`);
await sleep(1500);
await shoot("02-ours-connect");

/* ── 3. our sidebar with a workspace + session list open ─────────────────── */
await evaluate(send, `(() => {
  const ws = [...document.querySelectorAll("aside li button[title]")]
    .find((x) => /running/i.test(x.getAttribute("title") || ""));
  if (ws) ws.click();
  return !!ws;
})()`);
await sleep(2500);
await evaluate(send, `(() => {
  const d = [...document.querySelectorAll("button")]
    .find((x) => (x.getAttribute("title") || "").startsWith("Show the right dock"));
  if (d) d.click();
  return true;
})()`);
await sleep(1500);
await shoot("03-ours-workspace");

/*
 * No composite contact sheet here on purpose.
 *
 * Building one would mean shipping both PNGs into a page and drawing them onto a
 * canvas — extra machinery that can silently mis-scale the images it is supposed
 * to be objectively comparing. Two full-resolution files at the same viewport are
 * the honest artefact: open them side by side and look.
 */

ws.close();
console.log(
  "\ncaptured at 1600x945 each. Compare these two by eye:\n" +
    `  reference: ${join(OUT, "01-dsh-reference.png")}\n` +
    `  ours     : ${join(OUT, "02-ours-connect.png")}\n` +
    `  ours(ws) : ${join(OUT, "03-ours-workspace.png")}`,
);
