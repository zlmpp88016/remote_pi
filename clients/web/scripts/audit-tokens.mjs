// Plan/82 — every `var(--x)` must resolve to a defined token.
//
// This exists because SEVEN declarations referenced `--dsw-static-green-300`,
// `--dsw-static-amber-300` and `--dsw-static-amber-200`, none of which were ever
// defined. CSS silently discards such a declaration, so `--ok-text` fell back to the
// light theme's dark-green value and the dark-mode status labels rendered at 1.44:1 —
// invisible. No type checker or linter catches this; only resolution does.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".css")) files.push(p);
  }
})(ROOT);

/* Collect every definition anywhere in the tree. A token may legitimately be defined
 * in one file and consumed in another, so this is a global set, not per-file. */
const defined = new Set();
const used = new Map();
for (const f of files) {
  const css = readFileSync(f, "utf8");
  for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(f);
  }
}

/* Tokens the browser or Tailwind's runtime provide, or that are set imperatively at
 * runtime (`--dsw-preset-accent` is applied by theme-presets.ts). None of these are
 * authored in this tree, so their absence from the sheet is correct. */
const EXTERNAL = new Set([
  "--tw-border-style",
  "--tw-gradient-from",
  "--tw-gradient-via",
  "--tw-gradient-to",
  "--tw-ring-color",
  "--tw-shadow",
  "--tw-duration",
  "--tw-ease",
  "--tw-tracking",
  "--tw-blur",
  "--tw-content",
  "--dsw-preset-accent",
  /* Tailwind v4 ships these as theme defaults consumed through var(); they are not
   * declared in this tree. */
  "--animate-pulse",
  "--animate-spin",
  "--default-font-feature-settings",
  "--default-font-variation-settings",
  "--default-mono-font-feature-settings",
  "--default-mono-font-variation-settings",
]);

const missing = [...used.entries()]
  .filter(([name]) => !defined.has(name) && !EXTERNAL.has(name))
  .map(([name, fs]) => ({ name, files: [...fs] }));

if (missing.length === 0) {
  console.log(`token audit: OK — ${defined.size} defined, ${used.size} referenced`);
  process.exit(0);
}

console.log(`token audit: ${missing.length} UNDEFINED token(s) referenced\n`);
for (const m of missing) {
  console.log(`  ${m.name}`);
  for (const f of m.files) console.log(`      ${f}`);
}
console.log("\nA `var()` pointing at an undefined token is silently dropped by the browser,");
console.log("so the declaration loses to whatever cascade rule came before it.");
process.exit(1);
