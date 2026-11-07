import { attach, evaluate, shot, sleep , APP_ORIGIN } from "./_cdp.mjs";
const { ws, send, sent, received, consoleErr } = await attach();
await send("Runtime.enable"); await send("Network.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const ev = (e) => evaluate(send, e);

await send("Page.navigate", { url: APP_ORIGIN + "/remote-pi/connect" });
await sleep(10000);

// select workspace
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'').startsWith('4.1f —')); if(b) b.click(); return true; })()`);
await sleep(3500);
// open dock + Sessions tab
await ev(`(() => {
  const d=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'').startsWith('Show the right dock')); if(d) d.click();
  const t=[...document.querySelectorAll('button')].find(x=>/^会话$/i.test((x.innerText||'').trim())); if(t) t.click();
  return true;
})()`);
await sleep(5000);

let rows = 0;
for (let i = 0; i < 15; i++) {
  rows = await ev(`(() => { const s=document.querySelector('section[aria-label="Sessions"]'); return s?s.querySelectorAll('li').length:-1; })()`);
  if (rows > 1) break;
  await sleep(2000);
}
console.log("rows:", rows);
if (rows < 2) { await shot(send, "16-no-rows"); ws.close(); process.exit(1); }

const c = await ev(`(() => {
  const s=document.querySelector('section[aria-label="Sessions"]');
  const b=s.querySelectorAll('li')[1].querySelector('button');
  b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), aria:b.getAttribute('aria-label')};
})()`);
console.log("clicking:", JSON.stringify(c));
const bSent = sent.length, bRecv = received.length;
for (const type of ["mouseMoved","mousePressed","mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: type==="mouseMoved"?"none":"left", clickCount: type==="mouseMoved"?0:1 });
}
await sleep(7000);
await shot(send, "17-read-result");

console.log("RECV delta:");
for (const f of received.slice(bRecv)) {
  try { const o=JSON.parse(f);
    if (o.type==="host_message") { const inner=JSON.parse(Buffer.from(o.ct,'base64').toString('utf8'));
      const cl={...inner}; if(Array.isArray(cl.events)) cl.events=`[n=${cl.events.length}]`;
      console.log("  ← host_message", JSON.stringify(cl).slice(0,200)); }
    else console.log("  ←", o.type);
  } catch {}
}
const st = await ev(`(() => {
  const s=document.querySelector('section[aria-label="Sessions"]');
  const t=document.body.innerText;
  return { rows: s?s.querySelectorAll('li').length:-1, readFailed: /Could not read that session/i.test(t) };
})()`);
console.log("state:", JSON.stringify(st));
ws.close();
