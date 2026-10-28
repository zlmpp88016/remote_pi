/**
 * List the Tailwind utilities a single source file uses, grouped by the className
 * string they came from.
 *
 * WHY: translating a file means turning each className into named CSS Module
 * rules. Deciding the names is the actual work; collecting the tokens is
 * mechanical and error-prone by hand (a 400-character className on one line is
 * easy to mis-transcribe). This prints the tokens in source order, one group per
 * className, so the translation is a read-and-name exercise instead of a
 * transcription exercise.
 *
 * Tokens that are NOT Tailwind utilities are marked `semantic` — those already
 * live in `global.css` and must be left alone rather than moved.
 *
 * Usage: node scripts/list-file-utilities.mjs src/components/footer.tsx
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);

const utilitiesCss = readFileSync(join(WEB, "src", "styles", "utilities.css"), "utf8");
const globalCss = readFileSync(join(WEB, "src", "styles", "global.css"), "utf8");

/** Class names Tailwind defines (unescaped back to literal characters). */
const utilities = new Set();
for (const m of utilitiesCss.matchAll(/^\.((?:[^\s{,]|\\[^\s])+)\s*[,{]/gm)) {
  utilities.add(m[1].replace(/\\(.)/g, "$1"));
}

/** Class names the hand-written stylesheets define. */
const semantic = new Set();
for (const m of globalCss.matchAll(/\.([A-Za-z_][\w-]*)/g)) semantic.add(m[1]);

const file = resolve(process.argv[2]);
const source = readFileSync(file, "utf8");

/** Pull out each className expression with its line number. */
const groups = [];
const patterns = [
  /className\s*=\s*"([^"]*)"/g,
  /className\s*=\s*\{`([^`]*)`\}/g,
  /className\s*=\s*\{([^}]*)\}/g,
];

for (const re of patterns) {
  for (const m of source.matchAll(re)) {
    const line = source.slice(0, m.index).split("\n").length;
    const raw = m[1];
    // From a JSX expression, collect the string literals; from a plain string,
    // the whole thing.
    const literals = re.source.startsWith("className\\s*=\\s*\"")
      ? [raw]
      : [...raw.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    for (const lit of literals) {
      const tokens = lit.split(/\s+/).filter((t) => t !== "");
      if (tokens.length === 0) continue;
      groups.push({ line, tokens, raw: lit });
    }
  }
}

groups.sort((a, b) => a.line - b.line);

let utilCount = 0;
for (const g of groups) {
  const util = [];
  const sem = [];
  const unknown = [];
  for (const t of g.tokens) {
    if (utilities.has(t)) util.push(t);
    else if (semantic.has(t)) sem.push(t);
    else unknown.push(t);
  }
  utilCount += util.length;
  console.log(`L${String(g.line).padStart(4)}`);
  if (util.length > 0) console.log(`  utility:  ${util.join(" ")}`);
  if (sem.length > 0) console.log(`  semantic: ${sem.join(" ")}`);
  if (unknown.length > 0) console.log(`  unknown:  ${unknown.join(" ")}`);
}

console.log(`\n${String(utilCount)} utility tokens in ${String(groups.length)} className strings`);

// Distinct utilities matter more than the raw count: a file can reference the
// same seven utilities 135 times, and translating it means naming those seven.
const distinct = new Set();
for (const g of groups) for (const t of g.tokens) if (utilities.has(t)) distinct.add(t);
console.log(`${String(distinct.size)} distinct utilities:`);
console.log([...distinct].sort().join(" "));
