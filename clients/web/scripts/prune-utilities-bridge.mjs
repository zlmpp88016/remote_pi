/**
 * Remove utilities from the bridge that no source file references any more.
 *
 * WHY THIS IS THE MIGRATION'S PROGRESS METER: the bridge (`utilities.css`) starts
 * as a complete copy of Tailwind's utility output and ends empty. Every class
 * removed is one that a component now owns in its own `*.module.css`. So "is
 * Tailwind gone?" is not a judgement call — it is the size of this file, and the
 * file disappearing is the proof.
 *
 * A class is only dropped when NO source file still names it. The same utility is
 * usually shared (`flex` appears in dozens of places), so a component's utilities
 * become removable only once every file using them has been translated. That is
 * the correct dependency: removing early would silently unstyle the files that
 * still rely on the bridge.
 *
 * STRUCTURE IS PRESERVED, NOT REBUILT. The file is a set of `@layer` blocks, and
 * a layer's braces must stay paired: dropping a rule is safe, dropping the
 * wrapper's opening brace would make the browser discard the layer and every rule
 * after it. So the layers are split apart, their CONTENTS are filtered, and each
 * layer is re-emitted with whatever survived. The layer order statement and the
 * `:root` theme block are never touched — the surviving rules are written in
 * terms of the variables it declares.
 *
 * `--dry-run` reports what would go without writing; `--list` names the classes.
 *
 * Usage: node scripts/prune-utilities-bridge.mjs [--dry-run] [--list]
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);
const SRC = join(WEB, "src");
const BRIDGE = join(SRC, "styles", "utilities.css");

const dryRun = process.argv.includes("--dry-run");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every class token named anywhere in the source.
 *
 * Over-collecting is safe (it only delays a removal); under-collecting would
 * delete a class still in use and silently unstyle the page, so the scan is
 * deliberately broad and includes `index.html`, which carries class names on
 * `<html>` and `<body>`.
 */
function referencedTokens() {
  const tokens = new Set();

  /*
   * Collect the class tokens a source file actually applies.
   *
   * Three sources, all of which are class lists:
   *   1. `className="..."` — a plain attribute.
   *   2. `className={`...`}` / `className={"..."}` — expressions, including the
   *      template literals that hold conditional utilities.
   *   3. String literals assigned to a constant, which is how shared recipes
   *      (`FIELD`, tone maps) are written.
   *
   * Deliberately NOT: every quoted string in the file. That collected
   * `aria-hidden="true"` as `hidden` and prose such as "the grid centring", which
   * kept bridge rules alive for utilities nothing used — correct, but it stopped
   * the bridge from ever reaching empty.
   */
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  const addTokens = (text) => {
    for (const t of text.split(/\s+/)) {
      if (t === "" || t.includes("$") || t.includes("{")) continue;
      tokens.add(t);
    }
  };

  const scan = (raw) => {
    const code = stripComments(raw);

    // 1. className="a b c"
    for (const m of code.matchAll(/className="([^"]*)"/g)) addTokens(m[1]);

    // 2. className={...} — take the literals inside the braces only.
    for (const m of code.matchAll(/className=\{([\s\S]{0,600}?)\}\s*(?:\/>|>)/g)) {
      for (const lit of m[1].matchAll(/["'`]([^"'`\n]*)["'`]/g)) addTokens(lit[1]);
    }

    // 3. const NAME = "a b c" (recipes and tone maps).
    for (const m of code.matchAll(/(?:const|let)\s+([A-Za-z0-9_]*CLASS[A-Za-z0-9_]*|[A-Z][A-Z0-9_]+)\s*=\s*\n?\s*"([^"]*)"/g)) {
      addTokens(m[2]);
    }
  };

  for (const file of walk(SRC)) scan(readFileSync(file, "utf8"));
  for (const name of ["index.html", "vite.config.ts"]) {
    try {
      scan(readFileSync(join(WEB, name), "utf8"));
    } catch {
      // Not every checkout has every file; a missing one is not an error here.
    }
  }
return tokens;
}

/**
 * Class names a rule's SELECTOR defines.
 *
 * Only the part before the first `{` is scanned. The declaration block contains
 * dots of its own (`line-height: 1.62`, `letter-spacing: .14em`), and treating
 * those as class names produces entries like `14em;` that no source file can
 * match — noise in the report, and a rule whose only "names" are that noise would
 * be dropped even though it is still needed.
 *
 * The scan is character-by-character rather than by regex because a Tailwind
 * class name is full of escaped punctuation (`bg-[rgba(242,90,90,0.08)]` appears
 * as `.bg-\[rgba\(242\,90\,90\,0\.08\)\]`); a regex that does not treat `\x` as
 * a single character truncates the name at the first escape, which would make the
 * pruner believe a class is unreferenced and delete CSS still in use.
 */
function classesIn(text) {
  const brace = text.indexOf("{");
  const selector = brace < 0 ? text : text.slice(0, brace);
  const names = new Set();
  let i = 0;
  while (i < selector.length) {
    if (selector[i] !== ".") {
      i++;
      continue;
    }
    let name = "";
    let j = i + 1;
    while (j < selector.length) {
      const ch = selector[j];
      if (ch === "\\") {
        name += selector[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (/[\s,{>+~:)]/.test(ch)) break;
      name += ch;
      j++;
    }
    // A bare number after a dot is a decimal in a value, not a class name.
    if (name !== "" && !/^[0-9]/.test(name)) names.add(name);
    i = j + 1;
  }
  return names;
}

/** Split a stylesheet into top-level constructs, at-rules kept whole. */
function topLevelConstructs(css) {
  const out = [];
  let i = 0;
  let start = 0;
  let depth = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        out.push(css.slice(start, i + 1));
        start = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      out.push(css.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  if (start < css.length) {
    const tail = css.slice(start);
    if (tail.trim() !== "") out.push(tail);
  }
  return out;
}

/**
 * Split a stylesheet (or a layer body) into filterable units.
 *
 * A unit is either one rule, or one conditional wrapper (`@media`, `@supports`)
 * containing its own rules — and the wrapper is FILTERED, not kept whole. Keeping
 * it whole looked safe but was not: `classesIn` only inspects the selector before
 * the first `{`, so for `@media ... { .a {...} .b {...} }` it saw the wrapper's
 * prelude and none of the inner classes. Every rule inside a `@media` was then
 * treated as unreferenced and could never be pruned, which is why the bridge
 * stalled at 9.9KB with a pile of `@media`-wrapped utilities still in it.
 *
 * The recursion returns the surviving inner rules so the caller can re-emit the
 * wrapper around them, keeping the braces paired.
 */
function splitRules(css) {
  const out = [];
  let i = 0;
  let start = 0;
  let depth = 0;

  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        out.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
      i++;
      continue;
    }
    i++;
  }
  const tail = css.slice(start).trim();
  if (tail !== "") out.push(tail);
  return out.filter((u) => u !== "");
}

const referenced = referencedTokens();

/**
 * Filter one rule or conditional wrapper, returning what survives.
 *
 * A `@media`/`@supports` wrapper is descended into so its inner rules are
 * filtered individually. That is required, not cosmetic: dropping a wrapper only
 * when EVERY inner class is unreferenced keeps a wrapper whose classes are mostly
 * dead forever, and the bridge then never shrinks past its first `@media` block.
 */
function filterUnit(unit) {
  const wrapperMatch = unit.match(/^(@media[^{]*|@supports[^{]*)\{([\s\S]*)\}\s*$/);
  if (wrapperMatch !== null) {
    const [, prelude, body] = wrapperMatch;
    const survivors = [];
    for (const inner of splitRules(body)) {
      const keptInner = filterUnit(inner);
      if (keptInner !== null) survivors.push(keptInner);
    }
    if (survivors.length === 0) return null;
    return `${prelude.trim()} {\n${survivors.join("\n\n")}\n}`;
  }

  const names = classesIn(unit);
  if (names.size === 0) return unit;
  if ([...names].some((n) => referenced.has(n))) {
    keptRules++;
    return unit;
  }
  dropped++;
  for (const n of names) droppedNames.add(n);
  return null;
}

const bridge = readFileSync(BRIDGE, "utf8");
const constructs = topLevelConstructs(bridge);

const kept = [];
const droppedNames = new Set();
let dropped = 0;
let keptRules = 0;

for (const construct of constructs) {
  const trimmed = construct.trim();
  if (trimmed === "") continue;

  // Comments, the layer-order statement and the `:root` theme block are never
  // dropped: the theme block declares the variables every surviving rule uses.
  if (trimmed.startsWith("/*") || /^@layer\s+[a-z,\s]+;$/.test(trimmed) || /^:root\s*[,{]/.test(trimmed)) {
    kept.push(construct);
    continue;
  }

  // A `@layer` block: filter its contents, then re-emit the wrapper so the
  // braces stay paired and the cascade is unchanged.
  const layerMatch = trimmed.match(/^@layer\s+([a-z]+)\s*\{([\s\S]*)\}\s*$/);
  if (layerMatch !== null) {
    const [, layerName, body] = layerMatch;
    const survivors = [];
    for (const rule of splitRules(body)) {
      const keptRule = filterUnit(rule);
      if (keptRule !== null) survivors.push(keptRule);
    }
    if (survivors.length > 0) {
      kept.push(`@layer ${layerName} {\n${survivors.join("\n\n")}\n}\n`);
    } else {
      kept.push(`@layer ${layerName} {\n}\n`);
    }
    continue;
  }

  const keptUnit = filterUnit(trimmed);
  if (keptUnit !== null) kept.push(construct);
}

const output = kept.join("").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

if (process.argv.includes("--list")) {
  // Report the dropped class names. Tailwind generated these by scanning this
  // same source, so a class that looks unreferenced here is more likely a
  // scanner blind spot than genuinely dead CSS — the list is how to tell the two
  // apart before trusting a removal.
  console.log(`\ndropped class names (${String(droppedNames.size)}):`);
  console.log([...droppedNames].sort().join("\n"));
}

console.log(`rules kept:    ${String(keptRules)}`);
console.log(`rules dropped: ${String(dropped)}`);
console.log(`bridge size:   ${String(bridge.length)} -> ${String(output.length)} bytes`);

if (!dryRun) {
  writeFileSync(BRIDGE, output, "utf8");
  console.log("bridge written");
}
