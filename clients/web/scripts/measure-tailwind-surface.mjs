/**
 * Measure the Tailwind surface: how many class tokens each file carries.
 *
 * This exists to size the migration, not to enforce anything. Translating
 * utility classes into CSS Modules is mechanical but not automatic — a class
 * like `text-[12.5px]` maps to one declaration while `truncate` maps to three,
 * and `hover:` variants map to a nested selector — so the number that matters is
 * the token count per file, which is what this prints.
 *
 * Usage: node scripts/measure-tailwind-surface.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every `.ts`/`.tsx` under `dir`, recursively. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Class tokens inside the `className` expressions of one file. */
function classTokens(source) {
  // Three shapes are used across the codebase: a plain string, a template
  // literal, and a `cx(...)` helper call. The helper's arguments are scanned as
  // text, which over-counts slightly (a conditional's operand names count too)
  // — acceptable for sizing, and it errs toward a larger estimate.
  const expressions = [
    ...source.matchAll(/className="([^"]*)"/g),
    ...source.matchAll(/className=\{`([^`]*)`\}/g),
    ...source.matchAll(/className=\{cx\(([\s\S]*?)\)\}/g),
  ];
  let count = 0;
  for (const match of expressions) {
    const text = match[1] ?? "";
    count += (text.match(/[a-z][a-z0-9-]*(?::[a-z-]+)?(?:\[[^\]]*\])?/g) ?? []).length;
  }
  return count;
}

const rows = [];
let total = 0;
for (const file of walk("src")) {
  if (!statSync(file).isFile()) continue;
  const tokens = classTokens(readFileSync(file, "utf8"));
  if (tokens > 0) {
    rows.push([tokens, file]);
    total += tokens;
  }
}

rows.sort((a, b) => b[0] - a[0]);
for (const [tokens, file] of rows) console.log(`${String(tokens).padStart(5)}  ${file}`);
console.log(`\n${String(total)} class tokens across ${String(rows.length)} files`);
