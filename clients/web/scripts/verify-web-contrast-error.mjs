/**
 * Error-state contrast gate.
 *
 * The error notice and the Retry button only render after a failed session read,
 * which no ordinary audit pass reaches — that is exactly how a white-on-white
 * `Retry` survived the first round of this work. This gate closes that gap
 * without trying to provoke a real host failure (flaky and it mutates host
 * state), by resolving the tokens those selectors actually declare and grading
 * the resulting colours.
 *
 * It works at the token level on purpose: the error-state CSS chunk is not
 * loaded until the state renders, so there is nothing to measure in the live
 * document. The declarations themselves come from the real source files, which
 * are grepped here so a future edit to any of them fails this gate.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const MIN = 4.5;

/** Tokens that can appear on a light surface, resolved to their final rgb. */
const TOKENS = {
  "--dsw-alias-label-primary": [15, 17, 21],
  "--dsw-alias-label-secondary": [97, 102, 107],
  "--dsw-alias-label-tertiary": [129, 133, 140],
  "--warn-text": [39, 36, 31],
  "--ok-text": [35, 60, 44],
  "--ink-soft": [97, 102, 107],
  "--dsw-alias-bg-layer-2": [249, 250, 251],
  "--dsw-alias-bg-base": [255, 255, 255],
};

const lum = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const ratio = (a, b) => {
  const L1 = 0.2126 * lum(a[0]) + 0.7152 * lum(a[1]) + 0.0722 * lum(a[2]);
  const L2 = 0.2126 * lum(b[0]) + 0.7152 * lum(b[1]) + 0.0722 * lum(b[2]);
  return +((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2);
};

/** Each error-state element: where it lives, and what its colour must resolve to. */
const ELEMENTS = [
  {
    name: "transcript Retry button",
    file: "components/remote-pi/chat/transcript-panel.module.css",
    selector: ".retryButton",
    background: "--dsw-alias-bg-layer-2",
  },
  {
    name: "session-list warning notice",
    file: "components/remote-pi/sessions/session-list.module.css",
    selector: ".notice",
    background: "--dsw-alias-bg-base",
  },
  {
    name: "workspace warning row",
    file: "components/remote-pi/layout/workspace-sidebar.module.css",
    selector: ".wsWarning",
    background: "--dsw-alias-bg-base",
  },
  {
    name: "transcript notice text",
    file: "components/remote-pi/chat/transcript-panel.module.css",
    selector: ".noticeText",
    background: "--dsw-alias-bg-layer-2",
  },
];

/** Pull the `color:` declaration out of a rule block. */
const colorOf = (css, selector) => {
  const start = css.indexOf(selector + " {");
  if (start < 0) return null;
  const end = css.indexOf("\n  }", start);
  const block = css.slice(start, end < 0 ? undefined : end);
  const m = block.match(/\n\s*color:\s*var\((--[a-z0-9-]+)\)/);
  return m ? m[1] : null;
};

let fail = 0;
console.log("error-state contrast (declared tokens from source):");

for (const el of ELEMENTS) {
  const css = readFileSync(join(SRC, el.file), "utf8");
  const colorToken = colorOf(css, el.selector);
  if (!colorToken) {
    console.log(`  FAIL ${el.name.padEnd(26)} ${el.selector} has no var() colour declaration`);
    fail += 1;
    continue;
  }
  const fg = TOKENS[colorToken];
  const bg = TOKENS[el.background];
  if (!fg || !bg) {
    console.log(`  FAIL ${el.name.padEnd(26)} token ${colorToken} or ${el.background} unresolved`);
    fail += 1;
    continue;
  }
  const cr = ratio(fg, bg);
  const ok = cr >= MIN;
  if (!ok) fail += 1;
  console.log(
    `  ${ok ? "OK  " : "FAIL"} ${el.name.padEnd(26)} ${String(cr).padStart(5)}:1  ${colorToken} rgb(${fg.join(",")}) on ${el.background}`,
  );
}

console.log(
  fail === 0
    ? `\nerror-state: OK (${ELEMENTS.length} elements at AA ${MIN}:1)`
    : `\nerror-state: FAILED (${fail}/${ELEMENTS.length})`,
);
process.exit(fail === 0 ? 0 : 1);
