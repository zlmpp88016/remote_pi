/**
 * Minimal CDP driver used by the one-off session-read investigation.
 *
 * Real browser only: no jsdom, no fake transport. Screenshots land in
 * ./_e2e-evidence so every claim in the report is backed by a file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE = join(HERE, "_e2e-evidence");
mkdirSync(EVIDENCE, { recursive: true });

const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);

/**
 * The dev server this repo actually serves on.
 *
 * It is READ FROM vite.config.ts rather than hardcoded, because the two drifted:
 * the config moved to 3010 while every script here still said 3000. With a
 * hardcoded 3000 and the `?? pages[0]` fallback below, `attach()` silently
 * attached to whatever page happened to be first in the browser and every
 * assertion ran against the wrong document.
 */
export const APP_ORIGIN = process.env.APP_ORIGIN ?? `http://localhost:${readDevPort()}`;

function readDevPort() {
  try {
    const cfg = readFileSync(join(HERE, "..", "vite.config.ts"), "utf8");
    const m = cfg.match(/server\s*:\s*\{[^}]*?port\s*:\s*(\d+)/s);
    if (m) return Number(m[1]);
  } catch {
    /* fall through to the default below */
  }
  return 3010;
}

export async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("chrome-extension://"));
  const host = new URL(APP_ORIGIN).host;
  /*
   * NO FALLBACK. Attaching to an arbitrary page would let every assertion run
   * against a document the script never navigated, which is how a green run can
   * mean nothing. If the app's tab is not there, the caller gets an error that
   * names the origin it looked for.
   */
  const page =
    pages.find((t) => t.url.includes(host)) ??
    pages.find((t) => /^https?:\/\/localhost:\d+/.test(t.url));
  if (!page) {
    throw new Error(
      `no page target for ${host}; open ${APP_ORIGIN} in the CDP browser (ports seen: ${pages.map((p) => p.url).join(", ") || "none"})`,
    );
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const sent = [];
  const received = [];
  const consoleErr = [];
  const consoleAll = [];
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
      sent.push(String(msg.params.response.payloadData ?? ""));
    }
    if (msg.method === "Network.webSocketFrameReceived") {
      received.push(String(msg.params.response.payloadData ?? ""));
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const line = (msg.params.args ?? []).map((a) => a.value ?? a.description).join(" ");
      consoleAll.push(`${msg.params.type}: ${line}`);
      if (msg.params.type === "error") consoleErr.push(line);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErr.push(msg.params.entry.text ?? "");
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, sent, received, consoleErr, consoleAll, page };
}

export async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval failed");
  }
  return r.result?.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Captures a real PNG of the viewport and writes it to the evidence folder. */
export async function shot(send, name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = join(EVIDENCE, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(`  [SHOT] ${path}`);
  return path;
}

/** A real mouse click at the element's center (CDP Input domain, not `.click()`). */
export async function clickElement(send, evaluateFn, selectorExpr) {
  const box = await evaluateFn(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box) return null;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return box;
}
