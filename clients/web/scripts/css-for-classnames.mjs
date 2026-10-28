/**
 * Emit the CSS declarations for a set of Tailwind class names.
 *
 * WHY THIS EXISTS: the migration moves each component's utilities into its own
 * `*.module.css`. The declarations must be byte-identical to what Tailwind
 * emitted, and reproducing `truncate` (three declarations), `sr-only` (six),
 * `size-7`, `focus-visible:ring-2` and the `@supports (color:color-mix(...))`
 * colour fallbacks from memory is exactly how a "no visual change" refactor
 * quietly becomes a visual change.
 *
 * So the declarations are not retyped: they are read back out of the extracted
 * stylesheet, which was itself read out of Tailwind's own output. Variant
 * wrappers are preserved — a `hover:` utility keeps its `@media (hover: hover)`
 * guard and its `:hover` suffix, a `max-[1023px]:` utility keeps its query —
 * because dropping them changes behaviour on touch devices and narrow windows
 * while still looking correct on the desktop screenshot used for verification.
 *
 * The output is pasted into a hand-named semantic class, so the result reads as
 * ordinary CSS Modules rather than as generated utility soup.
 *
 * Usage: node scripts/css-for-classnames.mjs "flex items-center" "gap-2 truncate"
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);
const css = readFileSync(join(WEB, "src", "styles", "utilities.css"), "utf8");

/**
 * Split the stylesheet into top-level rules, remembering any wrapping at-rule.
 *
 * Nesting is tracked rather than assumed: `@media` and `@supports` both wrap
 * rules, and `@supports` appears INSIDE `@media (hover: hover)` for the
 * `hover:` colour utilities, so a one-level scan would lose the guard on those.
 */
function indexRules(source) {
  const rules = new Map();
  let i = 0;
  const stack = [];

  while (i < source.length) {
    const ch = source[i];

    if (ch === "{" && source[i - 1] !== "\\") {
      // Find the prelude that introduced this block.
      let start = i - 1;
      while (start >= 0 && source[start] !== "}" && source[start] !== "{" && source[start] !== ";") start--;
      const prelude = source.slice(start + 1, i).trim();
      stack.push({ prelude, from: i + 1 });
      i++;
      continue;
    }

    if (ch === "}" && source[i - 1] !== "\\") {
      const frame = stack.pop();
      if (frame !== undefined) {
        const body = source.slice(frame.from, i);
        // `@layer` is transparent for our purposes: a utility inside
        // `@layer utilities` is still an unconditional rule, and the module as a
        // whole is placed in that layer later. Treating it as a conditional
        // wrapper would nest every rule under a stray `utilities { }` block.
        const wrappers = stack
          .filter((f) => f.prelude.startsWith("@"))
          .filter((f) => !f.prelude.startsWith("@layer"));
        if (!frame.prelude.startsWith("@")) {
          // A selector rule: record it with its wrapper chain, keyed by the class
          // name it defines so a variant suffix (`:hover`) does not hide it.
          //
          // EVERY selector in the list is recorded, not just the first: Tailwind
          // merges utilities that share a declaration into one grouped rule
          // (`.text-\[var\(--danger\)\],.text-\[var\(--danger\)\]\/80{color:var(--danger)}`),
          // so taking only the first would silently drop the `/80` variant and
          // its `color-mix` refinement.
          for (const sel of splitSelectors(frame.prelude)) {
            const key = classNameOf(sel.trim());
            if (key === null) continue;
            // Keep the ORIGINAL selector: its variant suffix (`:disabled`, `:hover`,
            // `> p`) is part of the rule's meaning, and emitting only the class
            // name would apply the declarations unconditionally.
            const existing = rules.get(key);
            // A later `@supports` block refines an earlier plain declaration for the
            // same class; both are kept so the refinement can be emitted too.
            //
            // `at` records where the rule sat in the stylesheet. When a single
            // className lists two utilities that set the same property
            // (`break-words [overflow-wrap:anywhere]`), the winner is whichever
            // rule comes LATER in the sheet — not whichever is listed later in the
            // className. Without the position the generator cannot reproduce that,
            // and it silently emitted the first-listed one.
            const entry = { wrappers: wrappers.map((w) => w.prelude), body, selector: sel.trim(), at: i };
            if (existing === undefined) {
              rules.set(key, [entry]);
            } else {
              existing.push(entry);
            }
          }
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return rules;
}

/**
 * Extract the class name a selector defines, undoing Tailwind's escaping.
 *
 * A Tailwind rule's selector carries its variant as a SUFFIX — `.hover\:bg-white\/10:hover`,
 * `.disabled\:opacity-45:disabled`, `.max-\[1023px\]\:pr-6` inside a media query. Keying
 * the index by the whole selector would therefore never match the class token the
 * component actually writes, so the class name is isolated here: scan past the
 * leading dot, consuming `\x` pairs as single characters, and stop at the first
 * unescaped `:`, `[`, whitespace or combinator.
 */
function classNameOf(selector) {
  if (!selector.startsWith(".")) return null;
  let out = "";
  for (let i = 1; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\") {
      out += selector[i + 1] ?? "";
      i++;
      continue;
    }
    if (ch === ":" || ch === "[" || ch === " " || ch === ">" || ch === "~" || ch === "+") break;
    out += ch;
  }
  return out === "" ? null : out;
}

/** Split a selector list on commas that are not inside brackets or escaped. */
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === "\\") {
      cur += ch + (prelude[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Escape a class token the way Tailwind escapes it in a selector. */
function escapedToken(token) {
  return token.replace(/[.:/[\]()%#,+*~>='"!&^$@]/g, (c) => `\\${c}`);
}

const rules = indexRules(css);

/** The selector Tailwind emitted for a class token (used only for diagnostics). */
function selectorFor(token) {
  // Tailwind escapes every character that is not valid in a bare class name.
  return `.${token.replace(/[.:/[\]()%#,+*~>='"!&^$@]/g, (c) => `\\${c}`)}`;
}

void selectorFor;

/** Pretty-print a declaration body, one declaration per line. */
function declarations(body) {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "")
    .map((d) => `  ${d.replace(/:(?=[^:]*$)/, ": ")}`)
    .join(";\n");
}

/**
 * Emit CSS for a group of utilities under one semantic class name.
 *
 * Input is `name=util util util` (repeatable). The output is a single rule whose
 * declarations are those utilities' declarations merged in order, with variant
 * wrappers preserved and nested under `&`:
 *
 *   name=flex items-center gap-2 hover:bg-white/10
 *   →
 *   .name { display: flex; align-items: center; gap: ...; }
 *   @media (hover: hover) { .name:hover { background-color: ...; } }
 *
 * WHY GROUPS RATHER THAN ONE CLASS PER UTILITY: the destination is CSS Modules,
 * where the class name is a semantic handle (`card`, `title`), not a utility. A
 * file of `.flex{...} .items-center{...}` would just be Tailwind with extra steps
 * and would keep every call site as unreadable as it is today. Merging keeps the
 * declarations byte-identical while giving each rule a name that says what it is
 * for.
 *
 * Two utilities that both set the same property merge by ORDER, matching how the
 * cascade already resolved them: the later one wins. That mirrors Tailwind's own
 * behaviour, where specificity is equal and source order decides.
 *
 * Usage: node scripts/css-for-classnames.mjs "card=flex items-center" "title=truncate"
 */

/** Split a declaration body into `property: value` pairs, keeping order. */
function parseDeclarations(body) {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "")
    .map((d) => {
      const i = d.indexOf(":");
      return i < 0 ? { property: d, value: "" } : { property: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
    });
}

/**
 * Build one semantic rule from a list of utilities.
 *
 * Returns the base declarations plus one bucket per wrapper chain, so a variant
 * utility lands in the same at-rule it had in Tailwind rather than being flattened
 * into the base rule (which would apply a `hover:` colour unconditionally).
 */
function buildGroup(name, tokens, rules) {
  /** property -> value for the unconditional rule, later utilities overwriting. */
  const base = new Map();
  /** "chain|suffix" -> { chain, suffix, props }, so each variant nests separately. */
  const nested = new Map();
  const missing = [];

  /*
   * Flatten every token's rules into one list sorted by STYLESHEET POSITION.
   *
   * The order matters when one className names two utilities that set the same
   * property: `break-words [overflow-wrap:anywhere]` has both, and the winner is
   * whichever rule comes later in the sheet — not whichever is listed later in
   * the className. Emitting in className order got this backwards and silently
   * changed the computed `overflow-wrap`.
   */
  const ordered = [];
  for (const token of tokens) {
    const list = rules.get(token);
    if (list === undefined) {
      missing.push(token);
      continue;
    }
    for (const rule of list) ordered.push({ token, rule });
  }
  ordered.sort((a, b) => a.rule.at - b.rule.at);

  /*
   * `line-clamp-*` must win over `block`.
   *
   * Its `display: -webkit-box` is not a stylistic choice — the clamp only works
   * on a `-webkit-box`, and pairing it with `display: block` silently turns a
   * two-line clamp into an unbounded block (the text then grows the row).
   * Tailwind emits `.line-clamp-*` before `.block`, so pure source order would
   * hand the win to `block`; the clamp token is therefore moved to the end.
   */
  const isClamp = (token) => /^line-clamp-/.test(token);
  ordered.sort((a, b) => Number(isClamp(a.token)) - Number(isClamp(b.token)));

  for (const { token, rule } of ordered) {
    {
      const prefix = "." + escapedToken(token);
      const chain = rule.wrappers.join(" ");
      // Whatever follows the class name is the variant suffix — `:hover`,
      // `:disabled`, `:disabled:hover`, `> p`. It is part of the rule's meaning:
      // flattening it into the base rule would apply the declarations always.
      const suffix = rule.selector.slice(rule.selector.indexOf(prefix) + prefix.length);

      if (chain === "" && suffix === "") {
        for (const d of parseDeclarations(rule.body)) base.set(d.property, d.value);
      } else {
        const key = `${chain}|${suffix}`;
        const entry = nested.get(key) ?? { chain, wrappers: rule.wrappers, suffix, props: new Map() };
        for (const d of parseDeclarations(rule.body)) entry.props.set(d.property, d.value);
        nested.set(key, entry);
      }
    }
  }

  const lines = [`.${name} {`];
  for (const [property, value] of base) lines.push(`  ${property}: ${value};`);
  lines.push(`}`);

  for (const { wrappers, suffix, props } of nested.values()) {
    const rule = [`.${name}${suffix} {`];
    for (const [property, value] of props) rule.push(`  ${property}: ${value};`);
    rule.push(`}`);
    // Only genuinely conditional wrappers (`@media`, `@supports`) are kept.
    // Tailwind also wraps every utility in `@layer utilities`, which is dropped
    // here: the whole module is placed in that layer by
    // `scripts/wrap-module-layer.mjs`.
    //
    // The chain is already a list of whole at-rule preludes, so it is used
    // as-is. Splitting it on spaces would break `@supports (color:color-mix(in
    // lab,red,red))` into fragments and emit invalid CSS.
    const conditional = wrappers.filter((w) => w !== "" && !w.startsWith("@layer"));
    lines.push(``);
    if (conditional.length === 0) {
      lines.push(rule.join("\n"));
    } else {
      // Nested at-rules, NOT concatenated on one line.
      //
      // Tailwind wraps a hover colour in `@media (hover: hover)` and then a
      // `@supports (color: color-mix(...))` refinement inside it. Emitting them
      // as `@media(...) @supports(...) { ... }` is invalid CSS — the browser
      // drops the whole rule, so the hover colour silently disappears.
      let body = rule;
      for (const at of [...conditional].reverse()) {
        body = [`${at} {`, ...body.map((l) => `  ${l}`), `}`];
      }
      lines.push(body.join("\n"));
    }
  }

  return { css: lines.join("\n"), missing };
}

for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf("=");
  if (eq < 0) {
    console.error(`expected name=utilities, got: ${arg}`);
    process.exit(2);
  }
  const name = arg.slice(0, eq);
  const tokens = arg.slice(eq + 1).split(/\s+/).filter((t) => t !== "");
  const { css, missing } = buildGroup(name, tokens, rules);
  console.log(css);
  if (missing.length > 0) console.log(`/* !! missing: ${missing.join(" ")} */`);
  console.log();
}
