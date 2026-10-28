/**
 * Dump every CSS declaration the browser parsed, as `selector|property:value`.
 *
 * Selector-level comparison is not enough: two stylesheets can declare the same
 * set of selectors while resolving different values, and a declaration can move
 * between selectors (`.a,.b{...}` vs `.a{...}` `.b{...}`) without any class being
 * lost. Comparing declarations directly is what proves the extracted stylesheet
 * is equivalent rather than merely similarly shaped.
 *
 * Usage: node scripts/dump-declarations.mjs <url> > decls.txt
 */

import { attach, sleep , APP_ORIGIN } from "./_cdp.mjs";

const { send } = await attach();
const ev = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

await send("Page.navigate", { url: process.argv[2] ?? APP_ORIGIN + "/remote-pi/connect" });
await sleep(9000);

const dump = await ev(`(() => {
  const out = new Set();
  const norm = (s) => s.replace(/\\s+/g, " ").trim();
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText !== undefined) {
        const props = [];
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style[i];
          props.push(name + ":" + norm(rule.style.getPropertyValue(name)));
        }
        props.sort();
        // Split grouped selectors so .a,.b{...} compares equal to separate rules.
        for (const one of rule.selectorText.split(",")) {
          out.add(norm(one) + " | " + props.join(";"));
        }
      }
      if (rule.cssRules !== undefined) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    walk(rules);
  }
  return [...out].sort().join("\\n");
})()`);

console.log(dump);
process.exit(0);
