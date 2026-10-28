/**
 * Step 2 — pair against the REAL relay with the REAL pair URI, in the REAL
 * browser, and screenshot every step.
 */
import { attach, evaluate, shot, sleep, clickElement , APP_ORIGIN } from "./_cdp.mjs";

const PAIR_URI =
  "remotepi://pair?t=rjatYiZ8311jXjjN1ayAKA&epk=nSPpQXWNavrft1tZp5xAYkNKoSpDHd10dYXgWp1HcwM&n=lei&rm=host&r=https%3A%2F%2Frelay.880160.xyz";
const RELAY = "https://relay.880160.xyz";
const APP = APP_ORIGIN + "/remote-pi/connect";

const { ws, send, sent, received, consoleErr, consoleAll } = await attach();
await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

// Fresh state so the launcher is shown instead of a restored pairing.
await evaluate(send, `(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()`);
await send("Page.navigate", { url: APP });
await sleep(6000);

const ev = (expr) => evaluate(send, expr);

// A real React-controlled input ignores `el.value = x`; the native setter plus
// a bubbling input event is what an actual keystroke produces.
const NATIVE_SET = `
  (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
                                             : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
`;

console.log("\n=== Step A: launcher is shown ===");
const launcher = await ev(`(() => {
  const t = document.body.innerText;
  return {
    hasForm: t.includes("Relay address") && t.includes("Pairing code"),
    text: t.slice(0, 300),
  };
})()`);
console.log("  hasForm:", launcher.hasForm);
await shot(send, "01-launcher");

if (launcher.hasForm) {
  console.log("\n=== Step B: fill relay + pair URI (real input events) ===");
  const filled = await ev(`(() => {
    const setNative = ${NATIVE_SET};
    const inputs = [...document.querySelectorAll("input")];
    const relay = inputs.find((i) => /relay/i.test(i.placeholder || ""));
    const area = [...document.querySelectorAll("textarea")].find((i) => /remotepi/i.test(i.placeholder || ""));
    if (!relay || !area) return { ok: false, inputs: inputs.map(i => i.placeholder) };
    setNative(relay, ${JSON.stringify(RELAY)});
    setNative(area, ${JSON.stringify(PAIR_URI)});
    return { ok: true, relay: relay.value, code: area.value.slice(0, 60) };
  })()`);
  console.log("  filled:", JSON.stringify(filled).slice(0, 200));
  await sleep(400);
  await shot(send, "02-filled");

  console.log("\n=== Step C: click Connect (real mouse) ===");
  const before = { sent: sent.length, recv: received.length };
  const box = await clickElement(
    send,
    ev,
    `[...document.querySelectorAll('button[type="submit"]')].find(b => /connect/i.test(b.innerText))`,
  );
  console.log("  clicked at:", JSON.stringify(box));
  await sleep(1200);
  await shot(send, "03-connecting");

  // Wait for the host room handshake to land.
  let connected = false;
  for (let i = 0; i < 30; i += 1) {
    const s = await ev(`(() => {
      const t = document.body.innerText;
      return {
        connected: /host connected|workspace|running/i.test(t),
        failed: /Pairing failed/i.test(t),
      };
    })()`);
    if (s.connected) { connected = true; break; }
    if (s.failed) { console.log("  pairing failed on screen"); break; }
    await sleep(1000);
  }
  console.log("  connected:", connected);
  await shot(send, "04-after-connect");

  console.log("\n=== Step D: wire frames observed ===");
  const summarize = (list, dir) =>
    list.slice(before.sent === 0 ? 0 : 0).filter((f) => f.length > 2).slice(-40).map((f) => {
      try { const o = JSON.parse(f); return `${dir} ${o.type ?? "?"}`; } catch { return `${dir} <raw>`; }
    });
  console.log("  SENT:", [...new Set(summarize(sent, "→"))].join(", ") || "none");
  console.log("  RECV:", [...new Set(summarize(received, "←"))].join(", ") || "none");

  console.log("\n=== Step E: screen state ===");
  const state = await ev(`(() => {
    const t = document.body.innerText;
    return {
      chars: t.length,
      connected: /host connected/i.test(t),
      running: /running/i.test(t),
      head: t.split("\\n").map(s=>s.trim()).filter(Boolean).slice(0, 25),
    };
  })()`);
  console.log("  connected:", state.connected, "| running ws:", state.running);
  console.log("  head:", JSON.stringify(state.head, null, 0).slice(0, 700));
}

if (consoleErr.length) console.log("\n  console errors:", consoleErr.slice(0, 5));
console.log("\n  all console:", consoleAll.slice(-8).join(" | "));
ws.close();
