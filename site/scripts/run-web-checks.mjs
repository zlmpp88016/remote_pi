/**
 * One command for the whole Web client regression set.
 *
 * Every `verify-web-*.mjs` script is a self-contained Node check that runs the
 * REAL TypeScript modules (no stubs of our own code) through Node's type
 * stripping. They are listed here explicitly — in order — so "did I run
 * everything?" has a single answer instead of depending on remembering the
 * file names. A newly added `verify-web-*.mjs` that is NOT listed here is
 * reported, so the list cannot silently drift behind the suite.
 *
 * Run: npm run verify:web
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");

/** Every Web regression script, in dependency order (cheapest first). */
const SUITE = [
  "verify-web-foundations",
  "verify-web-transport",
  "verify-web-recovery",
  "verify-web-workspaces",
  "verify-web-client",
  "verify-web-chat",
  "verify-web-models-cache",
  "verify-web-skills",
  "verify-web-markdown",
  "verify-web-sessions",
];

// Drift guard: a new script must be added above, not forgotten.
const present = readdirSync(here)
  .filter((f) => /^verify-web-.*\.mjs$/.test(f))
  .map((f) => f.replace(/\.mjs$/, ""));
const unlisted = present.filter((name) => !SUITE.includes(name));
const missing = SUITE.filter((name) => !present.includes(name));
if (unlisted.length > 0) {
  console.log(`\n!! verify-web-*.mjs não listado em SUITE: ${unlisted.join(", ")}`);
}
if (missing.length > 0) {
  console.log(`\n!! listado em SUITE mas ausente do disco: ${missing.join(", ")}`);
}

const failed = [];
for (const name of SUITE) {
  process.stdout.write(`${name.padEnd(28)} `);
  try {
    const out = execFileSync("node", [join(here, `${name}.mjs`)], {
      cwd: siteRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    const tally = out.match(/(\d+)\/(\d+) checks PASS/);
    console.log(tally ? `OK (${tally[1]}/${tally[2]})` : "OK");
  } catch (err) {
    failed.push(name);
    console.log("FAIL");
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    console.log(
      text
        .split("\n")
        .filter((l) => /\[FAIL\]|FAILED|Error/.test(l))
        .slice(0, 12)
        .join("\n"),
    );
  }
}

const exit = failed.length > 0 || unlisted.length > 0 || missing.length > 0 ? 1 : 0;
console.log(
  `\n${SUITE.length - failed.length}/${SUITE.length} runners OK${failed.length ? ` · FAIL: ${failed.join(", ")}` : ""}`,
);
process.exit(exit);
