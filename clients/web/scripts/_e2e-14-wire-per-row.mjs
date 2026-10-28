// Per-row E2E wire proof with a correct baseline.
//
// Network.webSocketFrameReceived is only delivered for traffic that happens
// AFTER Network.enable, so the baseline must be snapshotted at the top of each
// iteration (not once before the loop). Everything here is a real Chrome page
// on a real relay connection; there are no stubs.
import { attach, evaluate, shot, sleep } from "./_cdp.mjs";

const { send, sent, received } = await attach();
await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await sleep(400);
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
});
const ev = (e) => evaluate(send, e);

const dec = (s) => {
  try {
    const t = Buffer.from(s, "base64").toString("utf8");
    return t.startsWith("{") ? JSON.parse(t) : null;
  } catch { return null; }
};

await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'').startsWith('4.1f —')); if(b) b.click(); return !!b; })()`);
await sleep(3000);
await ev(`(() => { const d=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'').startsWith('Show the right dock')); if(d) d.click(); return true; })()`);
await sleep(1200);
await ev(`(() => { const t=[...document.querySelectorAll('button')].find(x=>/^Sessions$/i.test((x.innerText||'').trim())); if(t) t.click(); return !!t; })()`);

let rows = 0;
for (let i = 0; i < 20; i++) {
  rows = await ev(`(() => { const s=document.querySelector('section[aria-label="Sessions"]'); return s?s.querySelectorAll('li').length:-1; })()`);
  if (rows > 1) break;
  await sleep(2000);
}
console.log("rows:", rows, "| captured frames so far: sent=", sent.length, "recv=", received.length);
if (rows < 2) { await shot(send, "e2e-wire-00-no-rows"); process.exit(1); }

const meta = JSON.parse(await ev(`(() => {
  const s=document.querySelector('section[aria-label="Sessions"]');
  return JSON.stringify([...s.querySelectorAll('li')].map((li,i)=>({
    i, aria:(li.querySelector('button')||{getAttribute:()=>''}).getAttribute('aria-label')||'' })));
})()`));

const results = [];
// Live row last: clicking it while it is already the active transcript does
// not issue a read, so sequence it after a history session is on screen.
const order = [...meta.filter((r) => r.i !== 0), ...meta.filter((r) => r.i === 0)];
for (const row of order) {
  // Do NOT touch the dock between rows: it is already open on the Sessions tab
  // and toggling it would reset the panel while we are measuring.
  const sec = await ev(`(() => {
    const s=document.querySelector('section[aria-label="Sessions"]');
    return s ? s.querySelectorAll('li').length : -1;
  })()`);
  if (sec < row.i + 1) {
    await ev(`(() => { const d=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'').startsWith('Show the right dock')); if(d) d.click();
      const t=[...document.querySelectorAll('button')].find(x=>/^Sessions$/i.test((x.innerText||'').trim())); if(t) t.click(); return true; })()`);
    await sleep(900);
  }

  const box = JSON.parse(await ev(`(() => {
    const s=document.querySelector('section[aria-label="Sessions"]'); if(!s) return JSON.stringify({err:'no-section'});
    const lis=s.querySelectorAll('li'); if(!lis[${row.i}]) return JSON.stringify({err:'no-row'});
    const b=lis[${row.i}].querySelector('button'); b.scrollIntoView({block:'center'});
    const r=b.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
  })()`));
  if (box.err) { results.push({ ...row, ok:false, why:box.err }); continue; }

  // Baseline is snapshotted HERE: frames only arrive for traffic after enable.
  const before = received.length;
  const wantEarly = (row.aria.match(/^Read session (0[0-9a-f]{7})$/) || [])[1] || null;
  const readShown = async () => JSON.parse(await ev(`(() => {
    const t=document.body.innerText||'';
    const m=t.match(/(READ-ONLY|LIVE)\s+(0[0-9a-f]{7})/);
    return JSON.stringify({ id:m?m[2]:"", hasRO:t.indexOf('READ-ONLY')>=0 });
  })()`));
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const type of ["mouseMoved","mousePressed","mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y,
        button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
    // Give the click time to be observed before deciding to retry.
    await sleep(3500);
    const cur = await readShown();
    const landed = wantEarly ? cur.id === wantEarly : cur.hasRO;
    if (landed) break;
  }
  // Wait for the UI to settle on the requested session instead of a fixed
  // sleep: a large transcript can take several seconds to render.
  const wantId = (row.aria.match(/^Read session (0[0-9a-f]{7})$/) || [])[1] || null;
  const isLiveRow = wantId === null;
  for (let w = 0; w < 25; w++) {
    await sleep(1000);
    const cur = await ev(`(() => {
      const t=document.body.innerText||'';
      const m=t.match(/(READ-ONLY|LIVE)s+(0[0-9a-f]{7})/);
      return JSON.stringify({ id:m?m[2]:"", hasRO:t.indexOf('READ-ONLY')>=0, hasLive:t.indexOf('LIVE')>=0 });
    })()`.replace(/\n/g, ""));
    const c = JSON.parse(cur);
    const settled = isLiveRow ? (c.id === "" && c.hasRO && c.hasLive) : c.id === wantId;
    if (settled && w >= 2) break;
  }

  // Decode EVERY session_read_ok in this window and keep the one whose
  // session_id matches this row; a click can inherit the previous reply when
  // the prior transcript was still streaming.
  const want = (row.aria.match(/^Read session (0[0-9a-f]{7})$/) || [])[1] || null;
  const replies = [];
  for (const raw of received.slice(before)) {
    let o; try { o = JSON.parse(raw); } catch { continue; }
    // Wire envelopes carry {peer, room, ct} with no top-level `type`; the type
    // only exists inside the decrypted `ct`.
    if (!o.ct) continue;
    let inner = dec(o.ct);
    if (!inner) continue;
    if (inner.type === "host_message" && inner.ct) inner = dec(inner.ct) || inner;
    if (inner.type === "session_read_ok") replies.push({ inner, len: o.ct.length });
  }
  const pick = want
    ? replies.find((r) => String(r.inner.session_id || "").startsWith(want))
    : replies[0];
  const replyOk = pick ? pick.inner : null;
  const replyRawLen = pick ? pick.len : 0;

  const shown = JSON.parse(await ev(`(() => {
    const t=document.body.innerText||'';
    const m=t.match(/(READ-ONLY|LIVE)\\s+(0[0-9a-f]{7})/);
    const body=(document.querySelector('main')||document.body).innerText||'';
    return JSON.stringify({ badge:m?m[1]:null, shownId:m?m[2]:null,
      hasReadOnly:t.indexOf('READ-ONLY')>=0, hasLive:t.indexOf('LIVE')>=0,
      bodyLen:body.replace(/\\s+/g,' ').trim().length });
  })()`));

  const expected = (row.aria.match(/^Read session (0[0-9a-f]{7})$/) || [])[1] || null;
  const isLive = row.aria === "Read session 4.1f";
  const replySid = replyOk ? String(replyOk.session_id || "").slice(0, 8) : null;
  const idOk = isLive ? replySid !== null : replySid === expected;
  const uiOk = isLive
    ? shown.bodyLen > 1000
    : shown.badge === "READ-ONLY" && shown.shownId === expected && shown.bodyLen > 200;
  const ok = !!replyOk && idOk && uiOk;

  results.push({ row: row.i, label: expected || "LIVE", wire: replyOk ? "session_read_ok" : "NONE",
    replySid, expected, ctLen: replyRawLen,
    events: replyOk && Array.isArray(replyOk.events) ? replyOk.events.length : 0,
    ui: `${shown.badge || "-"}/${shown.shownId || "-"}/${shown.bodyLen}`, ok });

  console.log(`${ok ? "PASS" : "FAIL"} row ${row.i} ${expected || "LIVE"}: wire=${replyOk ? "session_read_ok" : "NONE"} sid=${replySid} events=${replyOk && replyOk.events ? replyOk.events.length : 0} ctLen=${replyRawLen} ui=${shown.badge || "-"}/${shown.shownId || "-"}/${shown.bodyLen}`);
  await shot(send, `e2e-wire-${String(row.i).padStart(2, "0")}-${expected || "live"}`);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} rows: session_read_ok on the wire AND correct transcript on screen ===`);
for (const r of results) if (!r.ok) console.log("  FAILED:", JSON.stringify(r));
process.exit(pass === results.length ? 0 : 2);
