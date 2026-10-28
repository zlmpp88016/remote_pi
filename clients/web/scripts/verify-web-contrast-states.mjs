/**
 * Runs the contrast audit across every reachable UI state.
 *
 * A single audit pass only proves the state that happens to be rendered. The
 * first round of this work "passed" while error states still had a white-on-
 * white Retry button, because that state had never been triggered. This script
 * walks the states explicitly so a clean result means something.
 *
 * The audit expression is duplicated from audit-contrast.mjs on purpose: it must
 * run in the SAME CDP session that drives the state changes, otherwise the
 * second connection sees a different (or already-navigated) page.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

const MIN = 4.5;

const AUDIT = String.raw`(() => {
  const MIN = __MIN__;
  const cv = document.createElement("canvas");
  cv.width = 1; cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const parseRgba = (c) => {
    const m = String(c).match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const n = m[1].split(/[,\/]/).map((v) => v.trim()).filter((v) => v.length > 0);
    if (n.length < 3) return null;
    return { r: +n[0], g: +n[1], b: +n[2], a: n.length > 3 ? +n[3] : 1 };
  };
  const parse = (c) => {
    const d = parseRgba(c);
    if (d) return d;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "#000";
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const p = cx.getImageData(0, 0, 1, 1).data;
    return { r: p[0], g: p[1], b: p[2], a: p[3] / 255 };
  };
  const lum = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const ratio = (a, b) => {
    const L1 = 0.2126 * lum(a.r) + 0.7152 * lum(a.g) + 0.0722 * lum(a.b);
    const L2 = 0.2126 * lum(b.r) + 0.7152 * lum(b.g) + 0.0722 * lum(b.b);
    return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05))).toFixed(2);
  };
  const bgOf = (el) => {
    const st = [];
    let p = el;
    while (p) { st.push(getComputedStyle(p).backgroundColor); p = p.parentElement; }
    let o = { r: 255, g: 255, b: 255 };
    for (let i = st.length - 1; i >= 0; i--) {
      const c = parse(st[i]);
      if (!c || !(c.a > 0.004)) continue;
      o = { r: c.r * c.a + o.r * (1 - c.a), g: c.g * c.a + o.g * (1 - c.a), b: c.b * c.a + o.b * (1 - c.a) };
    }
    return { r: Math.round(o.r), g: Math.round(o.g), b: Math.round(o.b), a: 1 };
  };
  const bad = [];
  const seen = new Map();
  for (const el of document.querySelectorAll("*")) {
    const kids = [...el.childNodes];
    if (!kids.some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    if (el.closest(".sr-only")) continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    const fg = parse(cs.color);
    if (!(fg.a >= 0.9)) continue;
    const bg = bgOf(el);
    const cr = ratio(fg, bg);
    const fs = parseFloat(cs.fontSize);
    if (!(fs > 0)) continue;
    const fw = Number(cs.fontWeight) || 400;
    const large = fs >= 18.66 || (fs >= 14 && fw >= 700);
    const need = large ? Math.min(MIN, 3) : MIN;
    if (cr >= need) continue;
    const key = String(el.className) + "@" + Math.round(fs);
    const prev = seen.get(key);
    if (prev) { prev.count += 1; continue; }
    const entry = {
      cls: String(el.className).slice(0, 60),
      fontSize: fs,
      fg: cs.color,
      bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")",
      ratio: cr,
      need: need,
      text: (el.textContent || "").trim().slice(0, 40),
      count: 1,
    };
    seen.set(key, entry);
    bad.push(entry);
  }
  return bad;
})()`.replace("__MIN__", String(MIN));

const STATES = [
  {
    name: "empty (no workspace selected)",
    setup: async () => "initial",
  },
  {
    name: "workspace selected",
    setup: async (send) =>
      evaluate(
        send,
        `(function(){
           var el = [...document.querySelectorAll("[class*=wsName]")][0];
           if (!el) return "no-workspace";
           var row = el.closest("li") || el.parentElement;
           (row.querySelector("button") || row).click();
           return "ok";
         })()`,
      ),
  },
  {
    name: "right dock / session list",
    setup: async (send) => {
      await evaluate(
        send,
        `(function(){
           var b = [...document.querySelectorAll("button")].find(function(x){ return /right dock/i.test(x.textContent||""); });
           if (b && !/^hide/i.test((b.textContent||"").trim())) b.click();
           return 1;
         })()`,
      );
      await sleep(2500);
      return evaluate(
        send,
        `(function(){
           var b = [...document.querySelectorAll("button, [role=tab]")].find(function(x){ return (x.textContent||"").trim()==="Sessions"; });
           if (!b) return "no-tab";
           b.click(); return "ok";
         })()`,
      );
    },
  },
  {
    name: "session content (markdown)",
    setup: async (send) => {
      for (let i = 0; i < 6; i += 1) {
        await evaluate(
          send,
          `(function(){ var b = document.querySelector("[class*=refresh]"); if (b) b.click(); return 1; })()`,
        );
        await sleep(3500);
        const n = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
        if (n > 0) break;
      }
      return evaluate(
        send,
        `(function(){
           var b = document.querySelectorAll('[aria-label^="Read session"]')[0];
           if (!b) return "no-row";
           b.click(); return "opened";
         })()`,
      );
    },
  },
];

const { send, ws } = await attach();
let failedStates = 0;

for (const state of STATES) {
  const outcome = await state.setup(send);
  /*
   * Wait for the state to actually SETTLE rather than for a fixed 6s.
   *
   * The two states that open a session depend on `session_read` returning its
   * transcript, which can take longer than a fixed budget right after the host
   * respawns. Sampling too early audited a half-loaded pane and made this gate
   * fail intermittently — the failure moved between states on each run, which is
   * the signature of a timing assumption rather than a contrast defect.
   */
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    if (outcome === "initial" || outcome === "ok" || outcome === "no-tab") break;
    const settled = await evaluate(
      send,
      `(function(){
         var v=document.querySelector('[aria-label="Close the read-only session view"]');
         if(!v) return false;
         var sec=v.closest('section');
         return !!sec && sec.innerText.length > 400;
       })()`,
    );
    if (settled) { await sleep(1500); break; }
  }
  const bad = await evaluate(send, AUDIT);
  const status = bad.length === 0 ? "OK" : "FAIL";
  if (bad.length > 0) failedStates += 1;
  console.log(`${status.padEnd(4)} ${state.name.padEnd(32)} setup=${outcome} failing=${bad.length}`);
  for (const it of bad) {
    console.log(`       ${it.ratio}:1 (need ${it.need})  ${it.cls}  ${it.fg} on ${it.bg}  "${it.text}"`);
  }

  /* Per-selector positive proof for the 1:1 white-text fixes. Only meaningful
   * in a state that renders them, which is why it is reported here rather than
   * in a separate run that might land on the empty screen. */
  if (state.name.includes("markdown")) {
    const sel = await evaluate(
      send,
      `(function(){
         const cv=document.createElement("canvas");cv.width=1;cv.height=1;
         const cx=cv.getContext("2d",{willReadFrequently:true});
         const pr=(c)=>{const m=String(c).match(/^rgba?\\(([^)]+)\\)$/);if(!m)return null;const n=m[1].split(/[,\\/]/).map(v=>+v.trim());return {r:n[0],g:n[1],b:n[2],a:n.length>3?n[3]:1};};
         const pa=(c)=>{const d=pr(c);if(d)return d;cx.clearRect(0,0,1,1);cx.fillStyle="#000";cx.fillStyle=c;cx.fillRect(0,0,1,1);const p=cx.getImageData(0,0,1,1).data;return {r:p[0],g:p[1],b:p[2],a:p[3]/255};};
         const L=(v)=>{const s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
         const cr=(a,b)=>{const A=0.2126*L(a.r)+0.7152*L(a.g)+0.0722*L(a.b);const B=0.2126*L(b.r)+0.7152*L(b.g)+0.0722*L(b.b);return +(((Math.max(A,B)+0.05)/(Math.min(A,B)+0.05))).toFixed(2);};
         const bgOf=(el)=>{const st=[];let p=el;while(p){st.push(getComputedStyle(p).backgroundColor);p=p.parentElement;}let o={r:255,g:255,b:255};for(let i=st.length-1;i>=0;i--){const c=pa(st[i]);if(!c||!(c.a>0.004))continue;o={r:c.r*c.a+o.r*(1-c.a),g:c.g*c.a+o.g*(1-c.a),b:c.b*c.a+o.b*(1-c.a)};}return {r:Math.round(o.r),g:Math.round(o.g),b:Math.round(o.b),a:1};};
         const out=[];
         for (const p of ["strong","h3","h4","th","userBubble","rowName"]) {
           const el=document.querySelector('[class*="'+p+'"]');
           if(!el){out.push({p: p, ratio: -1}); continue;}
           const cs=getComputedStyle(el);const fg=pa(cs.color);const bg=bgOf(el);
           out.push({p: p, fg: cs.color, bg: "rgb("+bg.r+","+bg.g+","+bg.b+")", ratio: cr(fg,bg)});
         }
         return out;
       })()`,
    );
    console.log("     per-selector proof:");
    for (const s of sel) {
      if (s.ratio < 0) { console.log(`       --   ${s.p} not rendered`); continue; }
      const ok = s.ratio >= 4.5;
      if (!ok) failedStates += 1;
      console.log(`       ${ok ? "OK  " : "FAIL"} ${s.p.padEnd(11)} ${String(s.ratio).padStart(6)}:1  ${s.fg} on ${s.bg}`);
    }
  }
}

ws.close();
console.log(
  failedStates === 0
    ? `\nweb-contrast-states: OK (${STATES.length} states at AA ${MIN}:1)`
    : `\nweb-contrast-states: FAILED (${failedStates}/${STATES.length} states)`,
);
process.exit(failedStates === 0 ? 0 : 1);
