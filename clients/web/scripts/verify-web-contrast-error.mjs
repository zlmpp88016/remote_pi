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
 * are read here so a future edit to any of them fails this gate.
 *
 * THE COLOUR TABLE IS READ FROM THE SOURCE, NOT COPIED INTO THIS FILE.
 *
 * It used to be a literal map (`"--dsw-alias-label-tertiary": [129, 133, 140]`
 * and friends). When the AA work moved `label-tertiary` and `label-caption` from
 * `bluish-600` to `bluish-700`, this map kept the OLD value — and because
 * nothing graded the tertiary entry it went on passing while describing a colour
 * the product no longer renders. A gate that grades a copy of the truth is a
 * gate that cannot see the truth change.
 *
 * So this file now resolves every token out of `src/styles/design-platform.css`
 * (light `:root`, following `var()` indirection into the static ladder) and
 * grades that. Moving a token now either keeps the grade honest or fails the
 * gate — the two things a hardcoded table could never do.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const MIN = 4.5;

/* ── token resolution, straight out of the stylesheet ────────────────────── */

/**
 * Every custom property declared in the LIGHT `:root` blocks.
 *
 * The dark variant is `:root[data-theme="dark"]` and is deliberately excluded:
 * these gates grade the default (light) theme, which is what the app renders
 * unless a theme attribute is set.
 */
function lightDeclarations(css) {
  const out = new Map();
  let mode = null;
  for (const line of css.split("\n")) {
    if (/^ {2}:root\s*\{\s*$/.test(line)) {
      mode = "light";
      continue;
    }
    if (/^ {2}:root\[data-theme="dark"\]\s*\{\s*$/.test(line)) {
      mode = "dark";
      continue;
    }
    if (mode !== null && /^ {2}\}\s*$/.test(line)) {
      mode = null;
      continue;
    }
    if (mode !== "light") continue;
    const m = line.match(/^\s+(--[a-z0-9-]+):\s*([^;]+);/i);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

const DECLARATIONS = lightDeclarations(
  readFileSync(join(SRC, "styles", "design-platform.css"), "utf8"),
);

/**
 * Follow `var(--x)` to a concrete `rgb()`/`#hex` value.
 * Returns `null` for a token that is missing or resolves to nothing — an
 * unresolvable token is a failure, never a skipped entry.
 */
function resolveToken(name) {
  const seen = new Set();
  let current = name;
  for (let hop = 0; hop < 8; hop += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const raw = DECLARATIONS.get(current);
    if (raw === undefined) return null;
    const ref = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
    if (!ref) return raw;
    current = ref[1];
  }
  return null;
}

/** `rgb(r, g, b)` / `#rrggbb` → `[r, g, b]`; `null` when it is not a colour. */
function parseColor(value) {
  if (typeof value !== "string") return null;
  const rgb = value.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  return null;
}

/** Resolved `[r,g,b]` for a token name, or `null` when it does not resolve. */
function colorOfToken(name) {
  return parseColor(resolveToken(name));
}

const lum = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const ratio = (a, b) => {
  const L1 = 0.2126 * lum(a[0]) + 0.7152 * lum(a[1]) + 0.0722 * lum(a[2]);
  const L2 = 0.2126 * lum(b[0]) + 0.7152 * lum(b[1]) + 0.0722 * lum(b[2]);
  return +((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2);
};

/** The two surfaces light-theme text actually sits on. */
const SURFACES = {
  "--dsw-alias-bg-base": colorOfToken("--dsw-alias-bg-base"),
  "--dsw-alias-bg-layer-2": colorOfToken("--dsw-alias-bg-layer-2"),
};

let fail = 0;
console.log("error-state contrast (declared tokens resolved from design-platform.css):");
console.log(
  `  surfaces: ${Object.entries(SURFACES)
    .map(([k, v]) => `${k}=${v ? `rgb(${v.join(",")})` : "UNRESOLVED"}`)
    .join("  ")}`,
);
for (const [name, value] of Object.entries(SURFACES)) {
  if (!value) {
    console.log(`  FAIL surface ${name} does not resolve to a colour`);
    fail += 1;
  }
}

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

/**
 * The ink ramp, graded on BOTH light surfaces.
 *
 * This is the part that would have caught the regression this file used to
 * document wrongly: `label-tertiary`/`label-caption` at `bluish-600`
 * (rgb 129,133,140) measure 3.71:1 on white and 3.55:1 on the `#f9fafb` card —
 * under AA — while the hardcoded table here still claimed that colour was what
 * the product rendered. Every rank below is text somewhere in the product, so
 * every rank has to clear the floor.
 */
const INK_RAMP = [
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-label-caption",
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

for (const el of ELEMENTS) {
  const css = readFileSync(join(SRC, el.file), "utf8");
  const colorToken = colorOf(css, el.selector);
  if (!colorToken) {
    console.log(`  FAIL ${el.name.padEnd(26)} ${el.selector} has no var() colour declaration`);
    fail += 1;
    continue;
  }
  const fg = colorOfToken(colorToken);
  const bg = SURFACES[el.background];
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

console.log("\nink ramp on both light surfaces (all ranks carry text):");
for (const name of INK_RAMP) {
  const fg = colorOfToken(name);
  if (!fg) {
    console.log(`  FAIL ${name} does not resolve to a colour`);
    fail += 1;
    continue;
  }
  for (const [surface, bg] of Object.entries(SURFACES)) {
    if (!bg) continue;
    const cr = ratio(fg, bg);
    const ok = cr >= MIN;
    if (!ok) fail += 1;
    console.log(
      `  ${ok ? "OK  " : "FAIL"} ${name.padEnd(32)} ${String(cr).padStart(5)}:1  rgb(${fg.join(",")}) on ${surface}`,
    );
  }
}

const total = ELEMENTS.length + INK_RAMP.length * Object.keys(SURFACES).length;
console.log(
  fail === 0
    ? `\nerror-state: OK (${total} measurements at AA ${MIN}:1)`
    : `\nerror-state: FAILED (${fail}/${total})`,
);
process.exit(fail === 0 ? 0 : 1);
