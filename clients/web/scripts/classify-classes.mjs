/**
 * Classify every class token used in the app's source: which come from Tailwind's
 * utility layer (and must be translated), and which are already hand-written
 * semantic classes in `global.css` (and must be left alone).
 *
 * WHY THIS IS NEEDED BEFORE TRANSLATING ANYTHING: the raw token count is
 * misleading. A component written as `className="terminal"` counts as one
 * "Tailwind token" in a naive scan, but it is really a semantic class that
 * already lives in `global.css` and needs no work at all. Only the utilities
 * Tailwind generates are the migration's actual surface — and the difference is
 * large enough to change the whole shape of the job, so it is measured first
 * rather than assumed.
 *
 * A token counts as a utility if Tailwind emitted a rule for it in the last
 * build. Everything else is treated as semantic, EXCEPT tokens that match no
 * rule anywhere — those are reported separately, because they are either
 * Tailwind classes the scanner missed or genuinely dead class names, and both
 * are worth knowing about.
 *
 * Usage: node scripts/classify-classes.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);
const SRC = join(WEB, "src");

/**
 * Every class name Tailwind emitted a rule for, read from the extracted
 * stylesheet. Unescaping `\.` `\/` `\[` back to the literal characters is what
 * lets `.gap-1\.5` match the `gap-1.5` that appears in source.
 */
function utilityNames(css) {
  const names = new Set();
  for (const m of css.matchAll(/^\.((?:[^\s{,]|\\[^\s])+)\s*[,{]/gm)) {
    names.add(m[1].replace(/\\(.)/g, "$1"));
  }
  return names;
}

/** Class names defined by the hand-written semantic stylesheets. */
function semanticNames(...cssFiles) {
  const names = new Set();
  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");
    for (const m of css.matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(m[1]);
  }
  return names;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Pull the class tokens out of a source file.
 *
 * Three shapes are handled, because the app uses all three and a scanner that
 * understands only the first silently under-reports the surface:
 *   className="a b"        — plain string
 *   className={`a ${x}`}   — template literal
 *   className={cx("a")}    — helper call
 * Interpolations are stripped rather than guessed at; a class built from a
 * variable cannot be classified statically and is reported as unknown.
 */
function classTokens(source) {
  const tokens = new Set();
  const push = (raw) => {
    for (const t of raw.split(/\s+/)) {
      if (t !== "" && !t.includes("$") && !t.includes("{") && !t.includes("`")) tokens.add(t);
    }
  };
  for (const m of source.matchAll(/className\s*=\s*"([^"]*)"/g)) push(m[1]);
  for (const m of source.matchAll(/className\s*=\s*\{`([^`]*)`\}/g)) push(m[1]);
  for (const m of source.matchAll(/className\s*=\s*\{([^}]*)\}/g)) {
    for (const s of m[1].matchAll(/"([^"]*)"/g)) push(s[1]);
  }
  return tokens;
}

const utilities = utilityNames(readFileSync(join(WEB, "src", "styles", "utilities.css"), "utf8"));
const semantic = semanticNames(
  join(WEB, "src", "styles", "global.css"),
  join(WEB, "src", "styles", "preflight.css"),
);

const rows = [];
const globalUtilities = new Set();
const globalUnknown = new Set();

for (const file of walk(SRC).sort()) {
  const source = readFileSync(file, "utf8");
  const tokens = classTokens(source);
  const util = new Set();
  const unknown = new Set();
  for (const t of tokens) {
    if (utilities.has(t)) {
      util.add(t);
      globalUtilities.add(t);
    } else if (!semantic.has(t)) {
      unknown.add(t);
      globalUnknown.add(t);
    }
  }
  if (util.size > 0 || unknown.size > 0) {
    rows.push({ file: relative(WEB, file).replace(/\\/g, "/"), util: util.size, unknown: unknown.size });
  }
}

rows.sort((a, b) => b.util - a.util);
console.log("file".padEnd(58), "utility", "unknown");
for (const r of rows) console.log(r.file.padEnd(58), String(r.util).padStart(7), String(r.unknown).padStart(7));

const total = rows.reduce((n, r) => n + r.util, 0);
console.log(`\ndistinct utilities actually used: ${String(globalUtilities.size)}`);
console.log(`files with utilities:             ${String(rows.filter((r) => r.util > 0).length)}`);
console.log(`total utility references:         ${String(total)}`);
console.log(`distinct unknown tokens:          ${String(globalUnknown.size)}`);
if (globalUnknown.size > 0) {
  console.log("\nunknown tokens (no rule anywhere):");
  console.log([...globalUnknown].sort().join(" "));
}
