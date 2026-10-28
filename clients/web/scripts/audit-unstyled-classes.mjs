/**
 * Report class names used in the live DOM that no stylesheet defines.
 *
 * WHY THIS EXISTS: after removing Tailwind, a missing utility does not error —
 * the element simply renders unstyled, and the only symptom is a screenshot that
 * is a few thousand pixels off. The screenshot tells you *that* something is
 * wrong but not *what*. This walks the rendered DOM, collects every class token,
 * and asks the browser's own CSSOM which of them match no rule. That turns
 * "connect-unauth differs by 9 531 px" into a list of exact class names to go fix.
 *
 * A class with no rule is not automatically a bug — it may be a hook that only
 * exists for tests or for `:has()` — so the output is a candidate list to review,
 * not a verdict.
 *
 * Usage: node scripts/audit-unstyled-classes.mjs <url>
 */

import { attach, sleep , APP_ORIGIN } from "./_cdp.mjs";

const url = process.argv[2] ?? APP_ORIGIN + "/remote-pi/connect";

const { send } = await attach();

await send("Page.enable");
await send("Page.navigate", { url });
await sleep(9000);

const expression = `(() => {
  const used = new Set();
  for (const el of document.querySelectorAll("*")) {
    const raw = el.getAttribute("class");
    if (raw === null) continue;
    for (const token of raw.split(/\\s+/)) if (token !== "") used.add(token);
  }

  // Every selector text the browser actually parsed, including inside @media and
  // @supports, so a utility defined behind a media query still counts as defined.
  const selectors = [];
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText !== undefined) selectors.push(rule.selectorText);
      if (rule.cssRules !== undefined) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    walk(rules);
  }

  // A class is "defined" if some selector mentions .name not followed by another
  // identifier character — so .flex does not match a .flex-1 rule.
  const defined = new Set();
  for (const sel of selectors) {
    for (const m of sel.matchAll(/\\.(-?[_a-zA-Z][\\w-]*)/g)) defined.add(m[1]);
  }

  const missing = [...used].filter((c) => !defined.has(c)).sort();
  return JSON.stringify({ usedCount: used.size, missing }, null, 1);
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true });
console.log(result.result.value);
process.exit(0);
