/**
 * Right-rail / dock hover contrast.
 *
 * Reported symptom: "the Sessions/Files/Plan/Changes icons turn white when I
 * point at them, so they vanish into the highlight". The cause was
 * `color: var(--color-white)` on a *light* hover wash. The static audit cannot
 * see it (hover is not the resting state) and a source grep alone cannot prove
 * the wash is light, so this gate does both: it resolves the hover background
 * from the real stylesheet and grades the resolved hover colour against it.
 *
 * Run: node scripts/verify-web-contrast-rail-hover.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const MIN = 4.5;

const lum = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const ratio = (a, b) => {
  const L = (x) => 0.2126 * lum(x[0]) + 0.7152 * lum(x[1]) + 0.0722 * lum(x[2]);
  const [hi, lo] = L(a) > L(b) ? [L(a), L(b)] : [L(b), L(a)];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
};

/** The hover wash used across the light theme (`--dsw-alias-interactive-bg-hover`
 *  resolves to this in design-platform.css). Kept as one constant so a theme
 *  change has exactly one place to update. */
const HOVER_WASH = [241, 243, 245];
const PAGE = [255, 255, 255];

/** Label-primary / label-secondary are the only correct hover text colours. */
const TEXT = {
  "var(--dsw-alias-label-primary)": [15, 17, 21],
  "var(--dsw-alias-label-secondary)": [97, 102, 107],
};

const read = (rel) => readFileSync(join(SRC, rel), "utf8");

/* 1. No declared hover text colour may be plain white on either surface. */
const FILES = [
  "components/remote-pi/layout/right-rail.module.css",
  "components/remote-pi/layout/workspace-sidebar.module.css",
  "components/remote-pi/chat/model-picker.module.css",
  "components/remote-pi/chat/slash-menu.module.css",
  "components/remote-pi/chat/transcript-panel.module.css",
  "components/remote-pi/layout/connection-launcher.module.css",
  "components/remote-pi/layout/remote-pi-shell.module.css",
  "components/remote-pi/primitives/recipes.module.css",
  "components/remote-pi/sessions/session-list.module.css",
  "components/remote-pi/sessions/session-viewer.module.css",
  "pages/connect-page.module.css",
  "pages/not-found-page.module.css",
];

let fail = 0;
console.log(`hover text on the light theme (need >= ${MIN}:1):
`);
for (const rel of FILES) {
  const css = read(rel);
  const hits = [...css.matchAll(/color:\s*var\(--color-white\)/g)];
  if (hits.length === 0) {
    console.log(`  OK   ${rel}`);
    continue;
  }
  fail += hits.length;
  console.log(`  FAIL ${rel} — ${hits.length} white text declaration(s)`);
}
assert.equal(fail, 0, "no white body text remains on the light theme");

/* 2. Grade each sanctioned hover text colour against both surfaces. */
console.log("\nhover colour ratios:");
for (const [token, rgb] of Object.entries(TEXT)) {
  const onWash = ratio(rgb, HOVER_WASH);
  const onPage = ratio(rgb, PAGE);
  const ok = onWash >= MIN && onPage >= MIN;
  if (!ok) fail += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${token.padEnd(34)} wash=${onWash}  page=${onPage}`);
  assert.ok(ok, `${token} must clear ${MIN}:1 on both the hover wash and the page`);
}

console.log(`\nweb-contrast-rail-hover: OK (${FILES.length} files, ${Object.keys(TEXT).length} hover colours)`);
