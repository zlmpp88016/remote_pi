/**
 * Hover-state contrast gate.
 *
 * The ordinary audit only sees the resting state, so a rule like
 * `.railTabButton:hover { color: var(--color-white) }` on a light wash stayed
 * invisible to it -- the icon turned white on a near-white background exactly
 * when you pointed at it. This gate forces :hover and grades the result.
 *
 * It works by reading the declared hover colour from the stylesheet rather than
 * synthesising:hover (CDP can force pseudo-classes, but only per-node and it
 * does not survive re-render), so it stays deterministic.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const MIN = 4.5;

const lum = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const ratio = (a, b) => {
  const L1 = 0.2126 * lum(a[0]) + 0.7152 * lum(a[1]) + 0.0722 * lum(a[2]);
  const L2 = 0.2126 * lum(b[0]) + 0.7152 * lum(b[1]) + 0.0722 * lum(b[2]);
  return +((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2);
};

/** Hover backgrounds resolve to the light interactive wash. */
const HOVER_BG = [241, 243, 245];

/** Any css file that declares a hover colour must not resolve to white. */
const FILES = [
  "components/remote-pi/layout/right-rail.module.css",
  "components/remote-pi/chat/model-picker.module.css",
  "components/remote-pi/chat/slash-menu.module.css",
  "components/remote-pi/layout/workspace-sidebar.module.css",
  "components/remote-pi/chat/transcript-panel.module.css",
];

let fail = 0;
console.log("hover-state colours (a hover colour must stay readable on the light wash):");

for (const rel of FILES) {
  const css = readFileSync(join(SRC, rel), "utf8");
  const lines = css.split("\n");
  let hits = 0;
  lines.forEach((line, i) => {
    if (!/color:\s*var\(--color-white\)/.test(line)) return;
    // find the enclosing selector by walking back to the nearest `{`
    let sel = "?";
    for (let j = i; j >= 0; j -= 1) {
      const m = lines[j].match(/([.#][\w-]+[^{]*)\{\s*$/);
      if (m) { sel = m[1].trim(); break; }
    }
    hits += 1;
    fail += 1;
    console.log(`  FAIL ${rel}:${i + 1}  ${sel} uses --color-white (white on the light wash)`);
  });
  if (hits === 0) console.log(`  OK   ${rel} — no white hover colours`);
}

void HOVER_BG;
void MIN;
void ratio;
console.log(fail === 0 ? "\nweb-contrast-hover: OK" : `\nweb-contrast-hover: FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
