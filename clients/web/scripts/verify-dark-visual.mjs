// Plan/82 — dark-mode visual sweep. Captures EVERY dock tab in dark mode so the
// unreadable surfaces can be found by looking, not by guessing.
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CDP = "http://127.0.0.1:9444";
const BASE = "http://127.0.0.1:4124/";
const OUT = "scripts/.dark";
mkdirSync(OUT, { recursive: true });

const listing = await (await fetch(`${CDP}/json/list`)).json();
const page = listing.find((t) => t.type === "page" && /4124/.test(t.url || ""));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = pend.get(m.id);
  if (p) { pend.delete(m.id); p(m); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

const viewport = () => send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

await send("Page.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await viewport();
await send("Page.navigate", { url: BASE + "?_v=" + Date.now() });
await delay(7000);
await viewport();

// Force dark through the same localStorage key the app reads.
await ev(`window.localStorage.setItem("remote-pi.theme-mode","dark")`);
await send("Page.reload");
await delay(7000);
await viewport();
console.log("theme:", await ev(`document.documentElement.getAttribute("data-theme")`));

// Expand the dock.
await ev(`(() => {
  const c = document.querySelector('[aria-label="停靠栏（已折叠）"]');
  const b = c ? [...c.querySelectorAll('button')].find(x => /显示右侧停靠栏/.test(x.title||'')) : null;
  if (b) b.click();
  return !!b;
})()`);
await delay(2000);

const DOCK = `[...document.querySelectorAll('aside')].find(a=>a.getAttribute('aria-label')==='停靠栏')`;
const tabs = await ev(`(() => {
  const d = ${DOCK};
  return d ? [...d.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean) : [];
})()`);
console.log("tabs:", JSON.stringify(tabs));

// Open each tab and shoot it.
for (const label of ["Sessions", "Plan", "Files", "Changes", "Plugins", "Automations", "Models", "Settings"]) {
  const opened = await ev(`(() => {
    const d = ${DOCK};
    const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === ${JSON.stringify(label)}) : null;
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await delay(2400);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const file = `${OUT}/dark-${label.toLowerCase()}.png`;
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log(`${opened ? "ok" : "MISS"} ${label} -> ${file}`);
}

// Also capture the SESSION VIEWER, which is where the "live" badge lives. It only
// appears when the reader is looking at a session that is NOT the live one.
await ev(`(() => {
  const d = ${DOCK};
  const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '会话') : null;
  if (b) b.click();
  return !!b;
})()`);
await delay(2200);
const rowInfo = await ev(`(() => {
  const d = ${DOCK};
  if (!d) return null;
  const rows = [...d.querySelectorAll('button,[role="option"],li')]
    .filter(x => /session|trajectory|·/i.test((x.textContent||'')));
  return { count: rows.length, sample: rows.slice(0,5).map(r => (r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)) };
})()`);
console.log("session rows:", JSON.stringify(rowInfo));

// Click the 2nd session row if there is one — that opens the read-only viewer.
const viewer = await ev(`(() => {
  const d = ${DOCK};
  if (!d) return 'no-dock';
  const items = [...d.querySelectorAll('button')].filter(b => /open|view|switch/i.test(b.title||''));
  if (!items.length) return 'no-items';
  items[items.length - 1].click();
  return 'clicked:' + items[items.length-1].title;
})()`);
console.log("viewer:", viewer);
await delay(3000);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/dark-session-viewer.png`, Buffer.from(shot2.result.data, "base64"));
console.log("saved dark-session-viewer.png");

// Measure every "live"-ish badge's contrast against its own background.
const contrast = await ev(`(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.01) return c;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim();
    if (!/^(live|ok|running|ready|connected|idle)$/i.test(t)) continue;
    if (el.children.length > 0) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg) continue;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1,L2) + 0.05) / (Math.min(L1,L2) + 0.05);
    out.push({ text: t, fg: cs.color, bg: \`rgb(\${bg.r},\${bg.g},\${bg.b})\`, ratio: Math.round(ratio*100)/100 });
  }
  return out;
})()`);
console.log("\nBADGE CONTRAST (dark):");
for (const c of contrast ?? []) console.log(`  ${c.text.padEnd(10)} ${String(c.ratio).padStart(6)}  fg=${c.fg} bg=${c.bg}`);
const bad = (contrast ?? []).filter((c) => c.ratio < 4.5);
console.log(`\nbelow AA 4.5:1 -> ${bad.length ? bad.map(b=>b.text+" "+b.ratio).join(", ") : "none"}`);

ws.close();
