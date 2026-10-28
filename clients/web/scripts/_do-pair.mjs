/**
 * Re-establish the browser's pairing so the parity harness has real credentials.
 *
 * The harness compares screenshots, and the paired shell is one of the surfaces
 * under comparison. When the browser profile is recreated (which happens whenever
 * Chrome is restarted to clear a stuck compositor) `localStorage` is empty and the
 * "paired" shot silently becomes a duplicate of the unsigned one — the comparison
 * then passes while testing nothing. This script restores a real pairing against
 * the real relay, so that cannot happen unnoticed.
 *
 * The pairing code is read from the environment rather than hard-coded: it is a
 * credential, and a stale one in the repo would silently pair with nothing.
 */

import { attach, sleep , APP_ORIGIN } from "./_cdp.mjs";

const code = process.env["PAIR_CODE"];
if (code === undefined) {
  console.error("PAIR_CODE is required (run `remote-pi-server pair` to get one)");
  process.exit(2);
}

const { send } = await attach();
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

await send("Page.enable");
await send("Page.navigate", { url: APP_ORIGIN + "/remote-pi/connect" });
await sleep(7000);

// Fill through the native value setter + an `input` event: assigning `.value`
// directly does not notify React's synthetic event system, so a controlled input
// keeps rendering the old (empty) value and the form submits blank.
const filled = await evaluate(`(() => {
  const inputs = [...document.querySelectorAll("input, textarea")];
  const relay = inputs[0];
  const pair = inputs[1];
  if (relay === undefined || pair === undefined) return "no-inputs";
  const set = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(relay, "wss://relay.880160.xyz");
  set(pair, ${JSON.stringify(code)});
  return "filled";
})()`);
console.log("form:", filled);
await sleep(1500);

const clicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /^Connect$/.test((x.innerText || "").trim()));
  if (b === undefined) return false;
  b.click();
  return true;
})()`);
console.log("connect clicked:", clicked);
await sleep(14000);

const len = await evaluate("document.body.innerText.length");
const head = await evaluate("document.body.innerText.slice(0, 120)");
const keys = await evaluate("JSON.stringify(Object.keys(localStorage))");
console.log("bodyLen:", len);
console.log("head:", JSON.stringify(head));
console.log("storageKeys:", keys);
const paired = !head.includes("Connect to a host");
console.log(paired ? "PAIRED" : "NOT-PAIRED");
process.exit(paired ? 0 : 1);
