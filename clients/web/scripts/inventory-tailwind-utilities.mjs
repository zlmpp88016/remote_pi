/**
 * Inventory the distinct Tailwind utilities in use.
 *
 * Translating 2000+ class tokens by hand is both slow and error-prone, but the
 * vocabulary is small and closed: Tailwind's utilities are a finite set, and most
 * of them map to one or two declarations. Knowing the distinct set tells us
 * whether a systematic translation is possible, and which utilities need a
 * hand-written rule (a `truncate` is three declarations; a `sr-only` is six).
 *
 * Usage: node scripts/inventory-tailwind-utilities.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const counts = new Map();
function add(token) {
  counts.set(token, (counts.get(token) ?? 0) + 1);
}

for (const file of walk("src")) {
  const source = readFileSync(file, "utf8");
  const expressions = [
    ...source.matchAll(/className="([^"]*)"/g),
    ...source.matchAll(/className=\{`([^`]*)`\}/g),
    ...source.matchAll(/className=\{cx\(([\s\S]*?)\)\}/g),
  ];
  for (const match of expressions) {
    for (const raw of (match[1] ?? "").split(/\s+/)) {
      const token = raw.trim();
      if (token === "" || token.includes("${")) continue;
      add(token);
    }
  }
}

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${String(rows.length)} distinct utilities\n`);
for (const [token, n] of rows) console.log(`${String(n).padStart(4)}  ${token}`);
