/*
 * End-to-end browser check for a plain-HTTP entry point.
 *
 * A non-loopback `http://` origin is NOT a secure context, so `crypto.subtle`
 * is absent and pairing must complete through the pure-TS Ed25519 backend. That
 * is true both on a LAN address and through a tunnel forwarding a public IP, so
 * this one script covers both.
 *
 * Usage: node scripts/verify-browser-connect.mjs http://192.168.1.7:4124/remote-pi/connect
 *        node scripts/verify-browser-connect.mjs http://203.0.113.5:58300/remote-pi/connect
 *
 * Exits non-zero on any failure, so it doubles as the acceptance check for
 * "a device can pair with nothing but the address".
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = mkdtempSync(join(tmpdir(), "rp-e2e-"));
const port = 9240;
const proc = spawn(
  chrome,
  [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

try {
  let targets = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.length > 0) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("no chrome page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      problems.push(
        String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300),
      );
    }
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
      problems.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.navigate", { url });
  await sleep(12000);

  const probe = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      secure: window.isSecureContext,
      hasSubtle: !!(window.crypto && window.crypto.subtle),
      connected: /已连接/.test(document.body.innerText),
      pasting: /Connect to a host/.test(document.body.innerText),
      text: document.body.innerText.slice(0, 60).replace(/\\n/g, " · "),
    })`,
    returnByValue: true,
  });
  const state = JSON.parse(probe.result.result.value);

  console.log(`state: ${JSON.stringify(state)}`);
  echo(problems);
  check("page is NOT a secure context (this is the point of the test)", state.secure === false);
  check("crypto.subtle is absent", state.hasSubtle === false);
  check("client reports a connected host", state.connected === true);
  check("no paste fallback screen", state.pasting === false);
  check("no console exceptions or 4xx/5xx responses", problems.length === 0);

  ws.close();
} catch (error) {
  failed = true;
  console.error("ERROR", error);
} finally {
  proc.kill("SIGKILL");
}

function echo(problems) {
  if (problems.length === 0) return;
  console.log("--- problems ---");
  for (const problem of problems.slice(0, 8)) console.log("  " + problem);
}

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: PASSED");
process.exit(failed ? 1 : 0);
