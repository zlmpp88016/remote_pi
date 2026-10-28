/**
 * Contrast audit gate.
 *
 * Scans every visible text node in the REAL rendered app and checks its
 * foreground against the effective background.
 *
 * ## Threshold: WCAG AA (4.5:1 body, 3:1 large), and it passes
 *
 * An earlier revision of this gate defaulted to 3:1 because the real
 * deepseek-harness instance renders its secondary labels at
 * rgb(129,133,140) = 3.71:1, so matching DSH exactly looked incompatible with
 * AA. That was the wrong conclusion: it treated one specific DSH *token value*
 * as the requirement, when the requirement is DSH's *hierarchy*. DSH's own light
 * ramp has a darker second step for secondary text --
 * `--dsw-alias-label-secondary` = neutral-bluish-700 = rgb(97,102,107) =
 * 5.80:1 -- which is what its token table declares for that role. Pointing our
 * secondary layer at that step clears AA while staying entirely inside DSH's
 * palette, so there is no need to weaken the gate.
 *
 * Usage:
 *   node scripts/audit-contrast.mjs                 # AA, exit 1 on failure
 *   node scripts/audit-contrast.mjs --json          # machine-readable
 *   node scripts/audit-contrast.mjs --allow <n>     # tolerate n known items
 *   node scripts/audit-contrast.mjs --min 3         # relaxed floor
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, evaluate } from "./_cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "_e2e-evidence");
mkdirSync(EVIDENCE, { recursive: true });

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const allowIdx = args.indexOf("--allow");
const allowed = allowIdx >= 0 ? Number(args[allowIdx + 1] ?? 0) : 0;
const minIdx = args.indexOf("--min");
/** Floor to enforce: WCAG AA. `--min 3` relaxes it. */
const MIN_RATIO = minIdx >= 0 ? Number(args[minIdx + 1]) : 4.5;

/*
 * The audit runs INSIDE the page, so it ships as one expression string.
 *
 * Two details in here were learned the hard way:
 *
 *  1. Colour parsing cannot be a regex. Chrome serialises colours as
 *     rgb(), rgba(), color(srgb r g b / a) and oklab(); a regex produced NaN
 *     for the modern syntaxes, which silently reported six real failures as
 *     "unmeasurable" instead of red. Simple rgb/rgba is parsed directly (to
 *     keep alpha), everything else is normalised by painting into a canvas.
 *
 *  2. The effective background is the whole ancestor stack composited over
 *     white, not the first opaque ancestor. The app uses translucent washes
 *     (a selected row is ~7% blue over the sidebar fill), so stopping at the
 *     first opaque colour graded text against the wrong backdrop.
 */
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
    const direct = parseRgba(c);
    if (direct) return direct;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "#000";
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };

  const lum = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const ratio = (a, b) => {
    const L1 = 0.2126 * lum(a.r) + 0.7152 * lum(a.g) + 0.0722 * lum(a.b);
    const L2 = 0.2126 * lum(b.r) + 0.7152 * lum(b.g) + 0.0722 * lum(b.b);
    return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05))).toFixed(2);
  };

  const bgOf = (el) => {
    const stack = [];
    let p = el;
    while (p) { stack.push(getComputedStyle(p).backgroundColor); p = p.parentElement; }
    let out = { r: 255, g: 255, b: 255 };
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = parse(stack[i]);
      if (!(c.a > 0.004)) continue;
      out = {
        r: c.r * c.a + out.r * (1 - c.a),
        g: c.g * c.a + out.g * (1 - c.a),
        b: c.b * c.a + out.b * (1 - c.a),
      };
    }
    return { r: Math.round(out.r), g: Math.round(out.g), b: Math.round(out.b), a: 1 };
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
    /* A font-size of 0 means the text is not rendered (icon-only buttons hide
     * their label this way and expose it to screen readers instead). Grading it
     * would report invisible-by-design labels as contrast failures. */
    if (!(fs > 0)) continue;
    const need = MIN;
    if (cr >= need) continue;
    const key = String(el.className) + "@" + Math.round(fs);
    const prev = seen.get(key);
    if (prev) { prev.count += 1; continue; }
    const entry = {
      cls: String(el.className).slice(0, 60),
      fontSize: fs,
      fontWeight: Number(cs.fontWeight) || 400,
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
})()`;

const { send, ws } = await attach();
const bad = await evaluate(send, AUDIT.replace("__MIN__", String(MIN_RATIO)));
ws.close();

bad.sort((a, b) => a.ratio - b.ratio);

const report = { checkedAt: new Date().toISOString(), minRatio: MIN_RATIO, failing: bad.length, allowed, items: bad };
writeFileSync(join(EVIDENCE, "contrast-audit.json"), JSON.stringify(report, null, 2));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  /* Print the enforced floor explicitly: a bare "0 failing" is compatible with
   * any threshold, so the number has to appear in the output to be evidence. */
  console.log(`contrast audit: ${bad.length} failing element group(s) at AA ${MIN_RATIO}:1`);
  for (const b of bad) {
    const flag = b.ratio === 1 ? "  <-- INVISIBLE" : "";
    console.log(
      `  ${String(b.ratio).padStart(5)}:1 (need ${b.need})  x${b.count}  ${b.cls}  ${b.fontSize}px ${b.fg} on ${b.bg}  "${b.text}"${flag}`,
    );
  }
}

if (bad.length > allowed) {
  console.log(`\naudit-contrast: FAILED at AA ${MIN_RATIO}:1 (${bad.length} > allowed ${allowed})`);
  process.exit(1);
}
console.log(`\naudit-contrast: OK (${bad.length} <= allowed ${allowed}) at AA ${MIN_RATIO}:1`);
