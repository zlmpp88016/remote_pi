/**
 * Generate the Tailwind-equivalent stylesheets.
 *
 * WHY GENERATED FROM THE BUILT CSS RATHER THAN WRITTEN BY HAND: the goal is that
 * removing Tailwind changes nothing visually. Tailwind's preflight and its
 * utilities have exact, non-obvious definitions (`sr-only` is six declarations,
 * `truncate` is three, `::file-selector-button` carries appearance resets), and
 * reproducing them from memory would introduce differences that are invisible
 * until something looks subtly wrong. So this reads the CURRENT built CSS — the
 * byte-for-byte output the browser is rendering today — and emits the same
 * declarations as plain CSS.
 *
 * TWO OUTPUTS:
 *   • `preflight.css` — Tailwind's base layer, which every element depends on
 *     (`box-sizing: border-box`, `margin: 0`, heading font inheritance). This
 *     must ship, or the whole page reflows.
 *   • `utilities.css` — the utility classes still referenced by the components,
 *     as real classes, so the translation can proceed file by file without the
 *     app breaking in between.
 *
 * `utilities.css` is a BRIDGE, not the destination: each component's utilities
 * move into its own `*.module.css` as it is translated. The file shrinks as that
 * happens and is deleted at the end — which is how "no Tailwind left" is proven
 * rather than asserted.
 *
 * Usage: node scripts/gen-tailwind-bridge.mjs <built.css>
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);

const source = process.argv[2];
if (source === undefined) {
  console.error("usage: node scripts/gen-tailwind-bridge.mjs <built.css>");
  process.exit(2);
}

const css = readFileSync(source, "utf8");

/** Slice one `@layer <name>{...}` block, tracking brace depth. */
function layer(name) {
  const start = css.indexOf(`@layer ${name}{`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start + `@layer ${name}`.length; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + `@layer ${name}{`.length, i);
    }
  }
  return "";
}

/**
 * Collect every top-level `@property ...{...}` rule.
 *
 * These sit OUTSIDE the layers, interleaved among the `@keyframes`, so they are
 * matched by name rather than sliced out of a layer. They register Tailwind's
 * `--tw-*` custom properties with their initial values; without them every
 * `translate-y-*`, `shadow-*` and `ring-*` utility computes against an undefined
 * variable and quietly renders nothing.
 */
function propertyRules() {
  const found = [];
  let i = 0;
  while ((i = css.indexOf("@property", i)) >= 0) {
    const open = css.indexOf("{", i);
    let depth = 0;
    let j = open;
    while (j < css.length) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    found.push(css.slice(i, j));
    i = j;
  }
  return found;
}

/** Pretty-print a minified block: one rule per line, one declaration per line. */
function pretty(block) {
  return block
    .replace(/\}/g, "}\n")
    .replace(/\{/g, " {\n  ")
    .replace(/;/g, ";\n  ")
    .replace(/\n  \}/g, "\n}")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const base = layer("base");
const utilities = layer("utilities");
const theme = layer("theme");
const properties = layer("properties");
const atProperties = propertyRules();

/**
 * The layer order Tailwind declared, as a single statement.
 *
 * Read from the build rather than hardcoded so it cannot drift from the layers
 * the extracted rules actually use. Tailwind writes it as a comma list; the build
 * may split it across statements, so every `@layer <names>;` statement is
 * collected and merged in the order it appears.
 */
function layerOrder() {
  const names = [];
  for (const m of css.matchAll(/@layer\s+([a-z,\s]+);/g)) {
    for (const n of m[1].split(",")) {
      const name = n.trim();
      if (name !== "" && !names.includes(name)) names.push(name);
    }
  }
  // The blocks themselves may declare layers the bare statements do not.
  for (const m of css.matchAll(/@layer\s+([a-z]+)\{/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names.join(", ");
}

const LAYER_ORDER = layerOrder();
if (LAYER_ORDER === "") throw new Error("no @layer order statement in the built CSS");

if (base === "") throw new Error("no @layer base in the built CSS — wrong file?");
if (utilities === "") throw new Error("no @layer utilities in the built CSS — wrong file?");
if (theme === "") throw new Error("no @layer theme in the built CSS — wrong file?");
if (properties === "") throw new Error("no @layer properties in the built CSS — wrong file?");
if (atProperties.length === 0) throw new Error("no @property rules in the built CSS — wrong file?");

mkdirSync(join(WEB, "src", "styles"), { recursive: true });

writeFileSync(
  join(WEB, "src", "styles", "preflight.css"),
  `/*
 * Tailwind's preflight, extracted from the last Tailwind build.
 *
 * THIS FILE IS WHY REMOVING TAILWIND IS NOT A VISUAL CHANGE. Every element in the
 * app depends on these resets: \`box-sizing: border-box\` on everything, \`margin: 0\`
 * on everything, headings that inherit their size instead of using the UA
 * default, form controls with the platform appearance removed. Dropping Tailwind
 * without this would reflow the entire page.
 *
 * Generated by \`scripts/gen-tailwind-bridge.mjs\` from the built stylesheet, so
 * the declarations are Tailwind's own rather than a hand-written approximation.
 *
 * THE \`@layer base\` WRAPPER IS LOAD-BEARING. Tailwind put preflight in a LOWER
 * layer than the utilities and components, and that is the only reason a
 * component rule can set padding on an element the reset zeroed. Removing the
 * wrapper — which an earlier version of this generator did — puts \`padding: 0\` on
 * equal footing with every other rule, where it wins on source order and silently
 * unstyles the page.
 */

@layer ${LAYER_ORDER};

@layer base {
${pretty(base)}
}
`,
  "utf8",
);

writeFileSync(
  join(WEB, "src", "styles", "properties.css"),
  `/*
 * The custom-property definitions Tailwind's utilities are written in terms of.
 *
 * WHY THIS OUTLIVES TAILWIND: utilities like \`border-*\`, \`ring-*\`, \`shadow-*\` and
 * \`translate-*\` do not set a plain property — they set a \`--tw-*\` variable that a
 * second declaration then consumes (\`border-width: 1px\` plus
 * \`border-style: var(--tw-border-style)\`; \`--tw-ring-shadow: ...\` plus a composed
 * \`box-shadow\`). Those variables need an initial value, or every one of those
 * rules resolves to nothing and the element silently loses its border.
 *
 * So the translated component stylesheets keep using the same declarations, and
 * this file supplies the values. It is standard CSS — \`@property\` is a browser
 * feature, not a framework one — and it is kept separate from the utility bridge
 * because it has to survive the bridge's deletion.
 *
 * Generated by \`scripts/gen-tailwind-bridge.mjs\` from the last Tailwind build.
 */

${pretty(properties)}

${atProperties.join("\n")}
`,
  "utf8",
);

writeFileSync(
  join(WEB, "src", "styles", "utilities.css"),
  `/*
 * Tailwind's theme layer and its utility classes, extracted from the last build.
 *
 * A BRIDGE, NOT A DESTINATION. Each component's utilities are being moved into
 * its own \`*.module.css\`; while that is in progress the app keeps rendering
 * because these class names still exist. Every entry removed from here is one
 * component that no longer depends on Tailwind, and the file is deleted when it
 * is empty — that is how the migration is proven complete rather than claimed.
 *
 * The leading \`:root\` block is Tailwind's theme layer: the utilities below are
 * written in terms of \`var(--color-white)\`, \`var(--spacing)\` and friends, so
 * dropping it leaves every colour and size unresolved.
 *
 * The \`--tw-*\` initial values live in \`properties.css\`, because the translated
 * component stylesheets still need them after this file is gone.
 *
 * Generated by \`scripts/gen-tailwind-bridge.mjs\` so the declarations are
 * byte-identical to what Tailwind emitted.
 *
 * THE \`@layer\` WRAPPERS ARE LOAD-BEARING: \`theme\` must stay below \`utilities\`,
 * and \`utilities\` above \`base\`, or a utility stops beating the reset. The layer
 * ORDER is declared in \`preflight.css\`; this file relies on it.
 */

@layer theme {
${pretty(theme)}
}

@layer utilities {
${pretty(utilities)}
}
`,
  "utf8",
);

console.log(`preflight:  ${String(base.length)} chars`);
console.log(`theme:      ${String(theme.length)} chars`);
console.log(`properties: ${String(properties.length)} chars`);
console.log(`@property:  ${String(atProperties.length)} rules`);
console.log(`utilities:  ${String(utilities.length)} chars`);
console.log(`written to src/styles/`);
