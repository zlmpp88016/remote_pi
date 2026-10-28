/**
 * Extract the distinct Tailwind utilities actually used, cleanly.
 *
 * WHY A SECOND SCRIPT: the first inventory scanned raw `className` text, so it
 * also counted JS identifiers (`isViewing`), fragments of broken-up strings
 * (`"h-8`), and operators (`&&`). Those are noise — they are not utilities and
 * must not appear in the translation table, because a bogus entry would produce a
 * bogus CSS rule.
 *
 * A token is kept only if it looks like a utility: lowercase words, optional
 * `variant:` prefixes, optional `[arbitrary]` values, and at least one hyphen or a
 * known single-word utility. Everything else is reported separately so nothing is
 * silently dropped.
 *
 * Usage: node scripts/inventory-utilities-clean.mjs
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

/** Single-word utilities that carry no hyphen but are real. */
const BARE = new Set([
  "flex", "grid", "block", "inline", "hidden", "contents", "truncate", "italic",
  "underline", "uppercase", "lowercase", "capitalize", "antialiased", "relative",
  "absolute", "fixed", "sticky", "static", "isolate", "grow", "shrink", "wrap",
  "sr-only", "not-sr-only", "transition", "transform", "resize", "outline-none",
  "table", "list-none", "list-item", "contents",
]);

/** Class names that come from the hand-written stylesheet, not Tailwind. */
const isSemantic = (token) =>
  /^(app|wrap|footer|footer-inner|hero|eyebrow|lede|meta-line|page|page-head|page-body|docs-layout|docs-article|docs-toc|prose|reveal|cta|btn|card|nav|brand|pill|dots|mono|kbd|term|glow|grid-bg|section|panel|chip|badge|row|col|stack|cluster)$/.test(
    token,
  );

const counts = new Map();
const rejected = new Map();

for (const file of walk("src")) {
  const source = readFileSync(file, "utf8");
  const expressions = [
    ...source.matchAll(/className="([^"]*)"/g),
    ...source.matchAll(/className=\{`([^`]*)`\}/g),
    ...source.matchAll(/className=\{cx\(([\s\S]*?)\)\}/g),
  ];
  for (const match of expressions) {
    // Split on whitespace AND on the punctuation that appears inside `cx(...)`
    // arguments, so `"a", cond && "b"` yields `a` and `b` rather than fragments.
    for (const raw of (match[1] ?? "").split(/[\s"',()]+/)) {
      const token = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
      if (token === "" || token.includes("${")) continue;
      const looksLikeUtility =
        BARE.has(token) ||
        /^[a-z][a-z0-9]*(?:-[a-z0-9.]+)*(?::[a-z-]+)?(?:\[[^\]]+\])?(?:\/[0-9.]+)?$/.test(token) &&
          (token.includes("-") || token.includes("["));
      if (looksLikeUtility) counts.set(token, (counts.get(token) ?? 0) + 1);
      else if (!isSemantic(token)) rejected.set(token, (rejected.get(token) ?? 0) + 1);
    }
  }
}

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log(`=== ${String(rows.length)} utilities ===`);
for (const [token, n] of rows) console.log(`${String(n).padStart(4)}  ${token}`);

const noise = [...rejected.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n=== ${String(noise.length)} non-utility tokens (expected: JS identifiers / semantic classes) ===`);
for (const [token, n] of noise.slice(0, 40)) console.log(`${String(n).padStart(4)}  ${token}`);
