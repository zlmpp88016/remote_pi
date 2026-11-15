/**
 * Runs the contrast audit across every reachable UI state.
 *
 * A single audit pass only proves the state that happens to be rendered. The
 * first round of this work "passed" while error states still had a white-on-
 * white Retry button, because that state had never been triggered. This script
 * walks the states explicitly so a clean result means something.
 *
 * A STATE THAT COULD NOT BE REACHED IS A FAILURE, NOT A SKIP.
 *
 * Every state used to return a bare string and the settle loop treated
 * `no-tab` as terminal-and-fine, so the "right dock / session list" audit ran
 * against whatever document happened to be loaded and the state could not fail
 * on the surface it claimed to cover. Each state now returns
 * `{ ok, detail, wait }`, an unreachable state fails the run, and the selectors
 * are the product's own strings — the English ones (`/right dock/i` on button
 * text, an exact `"Sessions"` tab label) exist nowhere in `src`, which is
 * exactly why that state silently degraded.
 *
 * The audit expression is duplicated from audit-contrast.mjs on purpose: it must
 * run in the SAME CDP session that drives the state changes, otherwise the
 * second connection sees a different (or already-navigated) page.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";
import { DOCK_EXPAND_TITLE, DOCK_OPEN, assertUiReady, ensureUiReady } from "./_ui-state.mjs";

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

/*
 * Every state is a `{ ok, detail, wait }` result.
 *
 * `wait` names the settle condition the loop below should poll for; `detail` is
 * what the log prints. A state that could not be established returns
 * `ok: false` and the run fails — it must never be audited anyway, because an
 * audit of the wrong document is worse than no audit: it reports OK.
 */
const STATES = [
  {
    /*
     * "Empty" here means THE WORKSPACE LIST IS EMPTY, which is reachable in the
     * running product without mutating anything: the sidebar filter narrows
     * `visible` to zero rows and the product renders its own empty state
     * (`workspace-sidebar.tsx:412-427`).
     *
     * It used to be called "empty (no workspace selected)" and simply measured
     * the initial paint — but `ensureUiReady` now selects a workspace and
     * expands both rails before this loop runs, so it measured a fully loaded
     * screen while claiming to be the empty one. Driving the real empty state is
     * strictly more coverage: the compact empty state's own text is now graded
     * (it uses `--muted`, which is `label-secondary`).
     */
    name: "empty workspace list (filter matches nothing)",
    setup: async (send) => {
      const outcome = await evaluate(
        send,
        `(function(){
           var el = document.querySelector('input[aria-label="筛选工作区"]');
           if (!el) return "no-filter";
           var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
           setter.call(el, "zzz-no-match-zzz");
           el.dispatchEvent(new Event("input", { bubbles: true }));
           return "filtered";
         })()`,
      );
      await sleep(600);
      const rows = await evaluate(
        send,
        `document.querySelectorAll('[class*=wsNameActive], [class*=wsNameIdle]').length`,
      );
      const emptyShown = await evaluate(
        send,
        `!!document.querySelector('aside[aria-label="工作区"] [class*=emptyCompact]')`,
      );
      return {
        ok: outcome === "filtered" && rows === 0 && emptyShown === true,
        detail: `${outcome} rows=${rows} emptyState=${emptyShown}`,
        wait: "none",
      };
    },
  },
  {
    name: "workspace selected",
    setup: async (send) => {
      /* Restore the full list first: the state above filters it to zero. */
      await evaluate(
        send,
        `(function(){
           var el = document.querySelector('input[aria-label="筛选工作区"]');
           if (!el) return "no-filter";
           var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
           setter.call(el, "");
           el.dispatchEvent(new Event("input", { bubbles: true }));
           return "cleared";
         })()`,
      );
      await sleep(600);
      const outcome = await evaluate(
        send,
        `(function(){
           var el = [...document.querySelectorAll("[class*=wsName]")][0];
           if (!el) return "no-workspace";
           var row = el.closest("li") || el.parentElement;
           (row.querySelector("button") || row).click();
           return "ok";
         })()`,
      );
      return { ok: outcome === "ok", detail: outcome, wait: "none" };
    },
  },
  {
    /*
     * The right dock / session list.
     *
     * The product's strings are 右侧停靠栏 and 会话 — `workspace-sidebar.tsx:610-624`
     * and `right-rail.tsx:59`. The English `/right dock/i` and `"Sessions"` this
     * state used to search for do not exist anywhere in `src`, so the toggle was
     * never clicked, the tab never opened, and the state resolved to `no-tab`
     * every single run. The AA fix for the dock's modules was therefore never
     * exercised by this file while the gate reported OK. `_ui-state.mjs` already
     * locates both by the real strings; this uses the same selectors.
     */
    name: "right dock / session list",
    setup: async (send) => {
      const dock = await evaluate(
        send,
        `(function(){
           if (${DOCK_OPEN}) return "already-open";
           var b = [...document.querySelectorAll("button")].find(function(x){
             return (x.getAttribute("title") || "").startsWith(${JSON.stringify(DOCK_EXPAND_TITLE)});
           });
           if (!b) return "no-dock-toggle";
           b.click();
           return "opened";
         })()`,
      );
      await sleep(2500);
      const tab = await evaluate(
        send,
        `(function(){
           var d = ${DOCK_OPEN};
           if (!d) return "no-dock";
           var b = [...d.querySelectorAll("button, [role=tab]")].find(function(x){
             return (x.textContent || "").trim() === "会话";
           });
           if (!b) return "no-tab";
           b.click();
           return "ok";
         })()`,
      );
      /* The rows are the proof the tab actually rendered, and they are what the
       * dock's `--ink-*` and age/preview colours sit on. */
      let rows = 0;
      for (let i = 0; i < 20; i += 1) {
        rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
        if (rows > 0) break;
        await sleep(500);
      }
      return {
        ok: tab === "ok" && rows > 0,
        detail: `dock=${dock} tab=${tab} rows=${rows}`,
        wait: "none",
      };
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
      const outcome = await evaluate(
        send,
        `(function(){
           var b = document.querySelectorAll('[aria-label^="Read session"]')[0];
           if (!b) return "no-row";
           b.click(); return "opened";
         })()`,
      );
      return { ok: outcome === "opened", detail: outcome, wait: "viewer" };
    },
  },
];

const { send, ws } = await attach();
// This gate clicks a session row and then measures the viewer, so the session
// list must already be populated when it starts. The fixture is ASSERTED: a
// fixture that never became ready used to degrade into a bogus product finding
// on a document nobody had set up (after 9s + up to 60s + 6×10s of retries).
const fixture = assertUiReady(await ensureUiReady(send), "verify-web-contrast-states");
console.log(
  `ui fixture: ok=${fixture.ok} sidebarExpanded=${fixture.sidebarExpanded} ` +
    `dockOpen=${fixture.dockOpen} rows=${fixture.sessionRows}`,
);
let failedStates = 0;

for (const state of STATES) {
  const outcome = await state.setup(send);
  /*
   * Wait for the state to actually SETTLE rather than for a fixed 6s.
   *
   * The state that opens a session depends on `session_read` returning its
   * transcript, which can take longer than a fixed budget right after the host
   * respawns. Sampling too early audited a half-loaded pane and made this gate
   * fail intermittently — the failure moved between states on each run, which is
   * the signature of a timing assumption rather than a contrast defect.
   */
  if (outcome.wait === "viewer") {
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      const settled = await evaluate(
        send,
        `(function(){
           var v=document.querySelector('[aria-label="关闭只读会话视图"]');
           if(!v) return false;
           var sec=v.closest('section');
           return !!sec && sec.innerText.length > 400;
         })()`,
      );
      if (settled) { await sleep(1500); break; }
    }
  }
  const bad = await evaluate(send, AUDIT);
  /*
   * An UNREACHABLE state is a failure of this gate, not a pass with a note.
   * `no-tab` used to short-circuit the settle loop while the run still counted
   * the state as audited; that is how the dock state reported OK for a document
   * that never had the dock open.
   */
  const reachable = outcome.ok === true;
  const status = !reachable ? "FAIL" : bad.length === 0 ? "OK" : "FAIL";
  if (!reachable || bad.length > 0) failedStates += 1;
  console.log(
    `${status.padEnd(4)} ${state.name.padEnd(42)} setup=${outcome.detail} failing=${bad.length}`,
  );
  if (!reachable) {
    console.log(`       state could not be established — not audited (setup=${outcome.detail})`);
    continue;
  }
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
