/**
 * Wrap a component's CSS Module in Tailwind's `utilities` cascade layer, and
 * declare the layer order so the file does not depend on load order.
 *
 * WHY THIS IS NECESSARY — a cascade subtlety that silently changed the 404 page:
 *
 * The app's original cascade was
 *
 *     global.css (unlayered)  >  @layer utilities  >  @layer base (preflight)
 *
 * `global.css` is entirely unlayered, and an unlayered rule always outranks a
 * layered one. So the hand-written classes there deliberately beat Tailwind's
 * utilities — `a { color: inherit }` beat `text-accent underline`, and
 * `.wrap { padding: 0 28px }` beat `py-24`. That was the real rendering.
 *
 * A CSS Module's rules are unlayered by default, so translating `text-accent`
 * into `.link { color: var(--accent) }` INVERTED that: the module rule now beat
 * `global.css`, and the 404 links turned from white to accent-coloured. Wrapping
 * the module in `@layer utilities` restores the original priority.
 *
 * The order statement is repeated in every file rather than left to
 * `global.css`, because layer precedence is decided by the FIRST declaration of
 * each layer name. In dev the modules are injected before `global.css`, which
 * made `utilities` the first-declared layer — the LOWEST priority — so preflight
 * started beating every utility. Declaring the same order everywhere makes the
 * result independent of which stylesheet happens to load first.
 *
 * Usage: node scripts/wrap-module-layer.mjs <file.module.css> [...]
 */

import { readFileSync, writeFileSync } from "node:fs";

const ORDER = "@layer components, properties, theme, base, utilities;";

const BANNER = `/*
 * The layer order is declared here as well as in styles/preflight.css.
 *
 * Layer precedence is fixed by the FIRST declaration of each layer name, and in
 * dev Vite injects CSS Modules before the global stylesheet — so declaring the
 * order only in global.css would make \`utilities\` the first-declared layer, i.e.
 * the LOWEST priority, and preflight would start overriding every utility.
 * Repeating the identical order here makes the outcome independent of load order.
 */

${ORDER}

`;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/wrap-module-layer.mjs <file.module.css> [...]");
  process.exit(2);
}

for (const file of files) {
  let css = readFileSync(file, "utf8").trimEnd();

  if (css.includes("Layer order is declared here")) {
    console.log(`${file}: re-wrapping`);
  }

  // Strip a previous wrapping so running twice is idempotent. Matching the
  // wrapper by its banner rather than by a trailing `}` is deliberate: a regex
  // anchored on the last brace cannot tell the layer's closing brace from a
  // rule's, and removing the wrong one leaves an unclosed block that PostCSS
  // rejects at load time.
  const bannerAt = css.indexOf("Layer order is declared here");
  if (bannerAt >= 0) {
    const open = css.indexOf("@layer utilities {", bannerAt);
    // Everything after the wrapper's opening brace, minus the final brace that
    // closes the wrapper.
    css = css.slice(open + "@layer utilities {".length).trimEnd();
    if (css.endsWith("}")) css = css.slice(0, -1).trimEnd();
  }

  // Indent the body so the layer wrapper reads as a scope rather than as noise.
  const indented = css
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");

  writeFileSync(
    file,
    `${BANNER}@layer utilities {\n\n${indented.trimEnd()}\n}\n`,
    "utf8",
  );
  console.log(`${file}: wrapped`);
}
