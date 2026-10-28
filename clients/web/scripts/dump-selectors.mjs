/**
 * Dump every CSS selector the browser parsed for a page, one per line.
 *
 * Used to compare two stylesheet configurations directly: dump under Tailwind,
 * dump under the extracted bridge, then diff the two lists. A class that appears
 * in the Tailwind dump but not in the bridge dump is a rule the migration lost —
 * which is exactly the failure mode that screenshots only report as "some
 * pixels differ" without naming the cause.
 *
 * Selectors are normalised (whitespace collapsed) so the diff shows real
 * differences rather than formatting.
 *
 * Usage: node scripts/dump-selectors.mjs <url> > selectors.txt
 */

import { attach, sleep , APP_ORIGIN } from "./_cdp.mjs";

const { send } = await attach();
const ev = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

await send("Page.navigate", { url: process.argv[2] ?? APP_ORIGIN + "/remote-pi/connect" });
await sleep(9000);

const dump = await ev(`(() => {
  const out = new Set();
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText !== undefined) {
        out.add(rule.selectorText.replace(/\\s+/g, " ").trim());
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
