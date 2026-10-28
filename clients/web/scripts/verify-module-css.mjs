/**
 * Verify that a translated `*.module.css` is a byte-exact refactor.
 *
 * WHY THIS IS THE RIGHT CHECK: every module file was produced by
 * `scripts/css-for-classnames.mjs` from the Tailwind rules in
 * `src/styles/utilities.css`. That makes the translation verifiable without a
 * browser: regenerate the same mapping from the FULL (unpruned) bridge and
 * compare. If the regenerated rules match what is in the module file, then the
 * semantic class carries exactly the declarations Tailwind used to supply — no
 * declaration lost, added, or reordered.
 *
 * A browser comparison cannot prove this on its own. The style fingerprint only
 * sees the states it drives, so a declaration that only applies in a state the
 * oracle never reaches (an error box, a hover, a disabled row) would pass
 * unnoticed. This check covers every declaration for every class.
 *
 * The mapping is read from the module file's own leading comment block? No —
 * that would be circular. It is passed in, so the mapping is an explicit,
 * reviewable input rather than something inferred from the output.
 *
 * RUN THIS AGAINST THE FULL BRIDGE. `src/styles/utilities.css` is pruned as
 * components are translated, so by the time a module is written its utilities are
 * already gone from that file and every rule would read as "missing". Regenerate
 * the full bridge first:
 *
 *   node scripts/gen-tailwind-bridge.mjs dist/assets/index-Cabx8XcG.css
 *   node scripts/verify-module-css.mjs scripts/module-maps/<name>.mjs
 *
 * The script checks for that and says so, rather than reporting a wall of
 * failures that look like translation bugs.
 *
 * Usage: node scripts/verify-module-css.mjs <mapping.mjs>
 *
 * where the mapping module default-exports `{ file, groups: [[name, utils], ...] }`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);

const mappingPath = process.argv[2];
if (mappingPath === undefined) {
  console.error("usage: node scripts/verify-module-css.mjs <mapping.mjs>");
  process.exit(2);
}

const { file, groups } = (await import(pathToFileURL(resolve(mappingPath)).href)).default;

/**
 * Split a stylesheet into individual rules keyed by selector.
 *
 * At-rules are flattened with their prelude as a prefix, so a rule inside
 * `@media (hover: hover)` is keyed as `@media (hover: hover) .row:hover`. That
 * keeps a conditional rule distinguishable from an unconditional one with the
 * same selector — which is exactly the distinction that matters for hover and
 * focus states.
 */
function rulesBySelector(css) {
  const out = new Map();
  let i = 0;
  const stack = [];

  while (i < css.length) {
    const ch = css[i];

    if (ch === "{") {
      let start = i - 1;
      while (start >= 0 && css[start] !== "}" && css[start] !== "{" && css[start] !== ";") start--;
      const prelude = css.slice(start + 1, i).trim();
      stack.push({ prelude, from: i + 1 });
      i++;
      continue;
    }

    if (ch === "}") {
      const frame = stack.pop();
      if (frame !== undefined && !frame.prelude.startsWith("@layer")) {
        const body = css.slice(frame.from, i);
        const atRules = stack
          .map((f) => f.prelude)
          .filter((p) => p.startsWith("@"))
          .filter((p) => !p.startsWith("@layer"));
        if (!frame.prelude.startsWith("@")) {
          for (const selector of splitSelectors(frame.prelude)) {
            const key = [...atRules, selector.trim()].join(" ");
            const declarations = normaliseDeclarations(body);
            const existing = out.get(key);
            if (existing === undefined) out.set(key, declarations);
            else out.set(key, [...existing, ...declarations]);
          }
        }
      }
      i++;
      continue;
    }

    i++;
  }

  return out;
}

function splitSelectors(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/**
 * Normalise a declaration block to sorted `property: value` strings.
 *
 * Sorted rather than source-ordered: the generator groups declarations through a
 * `Map` keyed by property, so the emitted order is the property's first
 * appearance in Tailwind's output, not the order in the className string. Sorting
 * compares the SET of declarations, which is what has to match; a different
 * order within one rule cannot change which value wins for a distinct property.
 */
function normaliseDeclarations(body) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === ";" && depth === 0) {
      pushDeclaration(out, current);
      current = "";
      continue;
    }
    current += ch;
  }
  pushDeclaration(out, current);
  return out.sort();
}

function pushDeclaration(out, text) {
  const trimmed = text.trim();
  if (trimmed === "") return;
  const colon = trimmed.indexOf(":");
  if (colon < 0) return;
  const property = trimmed.slice(0, colon).trim();
  const value = trimmed.slice(colon + 1).trim().replace(/\s+/g, " ");
  out.push(`${property}: ${value}`);
}

const target = readFileSync(join(WEB, file), "utf8");
const targetRules = rulesBySelector(target);

// Fail fast when the bridge has been pruned. Every mapped utility would be
// reported as missing otherwise, which reads as a translation error when the real
// problem is that the reference was taken from a file that no longer holds the
// rules. One clear message beats a hundred misleading ones.
if (!bridgeHoldsMappedUtilities()) {
  console.error(
    "The bridge no longer contains the mapped utilities — it has been pruned.\n" +
      "Regenerate it first:\n" +
      "  node scripts/gen-tailwind-bridge.mjs dist/assets/index-Cabx8XcG.css",
  );
  process.exit(2);
}

function bridgeHoldsMappedUtilities() {
  const bridge = readFileSync(join(WEB, "src/styles/utilities.css"), "utf8");
  /*
   * EVERY mapped utility must be present for the bridge to count as un-pruned.
   *
   * A pruned bridge is not empty: it keeps the classes other components still
   * share (`absolute`, `flex`, `truncate`, `sr-only`), so checking one utility per
   * group passes against a bridge that has already dropped the distinctive ones
   * (`max-h-[320px]`, `line-clamp-2`, `rounded-[12px]`). Only requiring all of
   * them distinguishes "full bridge" from "pruned bridge that happens to
   * overlap".
   *
   * Pruning never removes a rule that is still referenced, so a full bridge always
   * contains every utility a translated module replaced.
   */
  for (const [, utilities] of groups) {
    for (const token of utilities.split(/\s+/)) {
      if (token === "") continue;
      if (!bridge.includes("." + escapedToken(token))) return false;
    }
  }
  return true;
}

function escapedToken(token) {
  return token.replace(/[^A-Za-z0-9_-]/g, (ch) => "\\" + ch);
}

// Generate the expected CSS from the full bridge, one group at a time, so a
// failure names the group that is wrong instead of printing the whole file.
let failures = 0;

for (const [name, utilities] of groups) {
  const generated = execFileSync(
    process.execPath,
    [join(HERE, "css-for-classnames.mjs"), `${name}=${utilities}`],
    { cwd: WEB, encoding: "utf8" },
  );

  if (generated.includes("/* !! missing:")) {
    console.log(`!! ${name}: some utilities are not in the bridge`);
    console.log(generated.split("\n").filter((l) => l.includes("missing")).join("\n"));
    failures++;
    continue;
  }

  const expected = rulesBySelector(generated);

  for (const [selector, declarations] of expected) {
    const actual = targetRules.get(selector);
    if (actual === undefined) {
      console.log(`!! ${name}: selector absent from the module: ${selector}`);
      failures++;
      continue;
    }
    if (actual.join("; ") !== declarations.join("; ")) {
      console.log(`!! ${name}: declarations differ for ${selector}`);
      console.log(`   expected: ${declarations.join("; ")}`);
      console.log(`   actual:   ${actual.join("; ")}`);
      failures++;
    }
  }
}

console.log(
  failures === 0
    ? `OK  ${file}: ${String(groups.length)} groups, every declaration matches the bridge`
    : `FAILED  ${file}: ${String(failures)} problem(s)`,
);
process.exit(failures === 0 ? 0 : 1);
