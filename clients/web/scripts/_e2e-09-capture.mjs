import { attach, evaluate, shot, sleep , APP_ORIGIN } from "./_cdp.mjs";
const { ws, send, sent, received, consoleErr } = await attach();
await send("Runtime.enable");
await send("Network.enable");   // MUST be before the WS opens
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const ev = (e) => evaluate(send, e);

console.log("=== reload with Network enabled so frames are captured from the start ===");
await send("Page.navigate", { url: APP_ORIGIN + "/remote-pi/connect" });
await sleep(9000);

// select workspace 4.1f
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('title')||'').startsWith('4.1f —'));
  b.click(); return true;
})()`);
await sleep(3000);
// open dock + sessions tab
await ev(`(() => {
  const d = [...document.querySelectorAll('button')].find(x => (x.getAttribute('title')||'').startsWith('Show the right dock'));
  if (d) d.click();
  const t = [...document.querySelectorAll('button')].find(x => /^会话$/i.test((x.innerText||'').trim()));
  if (t) t.click();
  return true;
})()`);
await sleep(4000);

const nRows = await ev(`(() => {
  const sec = document.querySelector('section[aria-label="Sessions"]');
  return sec ? sec.querySelectorAll('li').length : -1;
})()`);
console.log("rows:", nRows);
await shot(send, "12-reloaded-panel");

const beforeSent = sent.length, beforeRecv = received.length;
// real mouse click on row 1
const c = await ev(`(() => {
  const sec = document.querySelector('section[aria-label="Sessions"]');
  const b = sec.querySelectorAll('li')[1].querySelector('button');
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), aria: b.getAttribute('aria-label') };
})()`);
console.log("clicking:", JSON.stringify(c));
for (const type of ["mouseMoved","mousePressed","mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: type==="mouseMoved"?"none":"left", clickCount: type==="mouseMoved"?0:1 });
}
await sleep(5000);
await shot(send, "13-after-read-click");

console.log("\n=== SENT frames since click ===");
for (const f of sent.slice(beforeSent)) {
  try { const o = JSON.parse(f);
    if (o.ct) { const inner = JSON.parse(Buffer.from(o.ct,'base64').toString('utf8')); console.log("  →", inner.type, JSON.stringify(inner).slice(0,160)); }
    else console.log("  →", o.type);
  } catch { console.log("  → <raw>"); }
}
console.log("\n=== RECV frames since click ===");
for (const f of received.slice(beforeRecv)) {
  try { const o = JSON.parse(f);
    if (o.type === "host_message") {
      const inner = JSON.parse(Buffer.from(o.ct,'base64').toString('utf8'));
      const clone = { ...inner, events: inner.events ? `[${inner.events.length} events]` : undefined };
      console.log("  ← host_message room=", o.room, JSON.stringify(clone).slice(0,300));
    } else console.log("  ←", o.type);
  } catch { console.log("  ← <raw>"); }
}
if (consoleErr.length) console.log("\nconsole errors:", consoleErr.slice(-5));
ws.close();
