/**
 * Quantified proof for the workspace selection bug the user reported.
 *
 * Checks that the SELECTED workspace row is (a) readable at all and (b) a
 * stronger text style than an idle row. The original defect had these exactly
 * inverted: `.wsNameActive` was white (1.16:1, invisible on the sidebar) while
 * `.wsNameIdle` was dark and perfectly readable.
 */
import { attach, evaluate } from "./_cdp.mjs";

const EXPR = String.raw`(() => {
  const cv = document.createElement("canvas");
  cv.width = 1; cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const direct = (c) => {
    const m = String(c).match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const n = m[1].split(/[,\/]/).map((v) => +v.trim());
    if (n.length < 3) return null;
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };
  const parse = (c) => {
    const d = direct(c);
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
  const out = [];
  for (const sel of ["[class*=wsNameActive]", "[class*=wsNameIdle]"]) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel: sel, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    out.push({
      sel: sel,
      fg: cs.color,
      bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")",
      ratio: ratio(fg, bg),
      fontWeight: cs.fontWeight,
      fontSize: cs.fontSize,
      text: (el.textContent || "").trim(),
    });
  }
  return out;
})()`;

/**
 * Scrollbar assertion, kept next to the contrast one because both were the same
 * class of bug: an unstyled OS affordance appearing inside a flat light UI.
 *
 * Without the global rules every scroll container fell back to the Windows UA
 * scrollbar (17px trough + arrow buttons). The check is on the computed values
 * of the real scroll containers, so removing the global rule turns this red.
 */
const SCROLLBAR = String.raw`(() => {
  const cs = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const t of [
    "--dsw-alias-scrollbar-bg-l2",
    "--dsw-alias-scrollbar-hover-l2",
    "--dsw-static-neutral-200",
    "--dsw-static-neutral-300",
  ]) {
    tokens[t] = cs.getPropertyValue(t).trim();
  }
  const bad = [];
  for (const el of document.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (s.overflowY !== "auto" && s.overflowY !== "scroll") continue;
    if (el.scrollHeight <= el.clientHeight + 4) continue;
    if (s.scrollbarWidth === "thin") continue;
    bad.push({ cls: String(el.className).slice(0, 40), scrollbarWidth: s.scrollbarWidth });
  }
  return { tokens: tokens, scrollingWithoutThinScrollbar: bad };
})()`;

const { send, ws } = await attach();
const rows = await evaluate(send, EXPR);
const sb = await evaluate(send, SCROLLBAR);
ws.close();

console.log("workspace row contrast:");
for (const r of rows) {
  if (r.missing) { console.log(`  ${r.sel}  MISSING`); continue; }
  console.log(
    `  ${r.sel.padEnd(26)} "${r.text}" ${r.fg} on ${r.bg}  ${r.ratio}:1  ${r.fontSize}/${r.fontWeight}`,
  );
}

console.log("\nscrollbars:");
for (const [k, v] of Object.entries(sb.tokens)) {
  console.log(`  ${k.padEnd(34)} ${v || "EMPTY"}`);
}
for (const b of sb.scrollingWithoutThinScrollbar) {
  console.log(`  FAIL ${b.cls} scrolls with ${b.scrollbarWidth} scrollbar`);
}

const active = rows.find((r) => r.sel.includes("Active"));
const idle = rows.find((r) => r.sel.includes("Idle"));
let fail = 0;
for (const [k, v] of Object.entries(sb.tokens)) {
  if (!v) { console.log(`FAIL: scrollbar token ${k} is unresolved (colour ramp missing)`); fail++; }
}
if (sb.scrollingWithoutThinScrollbar.length > 0) {
  console.log(`FAIL: ${sb.scrollingWithoutThinScrollbar.length} scroll container(s) use the UA scrollbar`);
  fail++;
}
if (!active || active.missing) { console.log("FAIL: no selected workspace row rendered"); fail++; }
else if (active.ratio < 3) { console.log(`FAIL: selected row is ${active.ratio}:1 (< 3)`); fail++; }
if (active && idle && !active.missing && !idle.missing) {
  const aW = Number(active.fontWeight);
  const iW = Number(idle.fontWeight);
  if (active.ratio <= idle.ratio && aW <= iW) {
    console.log("FAIL: selected row is not visually stronger than idle (no ratio and no weight lead)");
    fail++;
  } else {
    console.log(
      `selected leads idle: ratio ${active.ratio} vs ${idle.ratio}, weight ${aW} vs ${iW}`,
    );
  }
}
console.log(fail === 0 ? "\nweb-contrast-selection: OK" : `\nweb-contrast-selection: FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
