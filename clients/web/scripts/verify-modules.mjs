/**
 * Verify one or more translated modules against the FULL Tailwind bridge.
 *
 * `src/styles/utilities.css` is pruned as components are translated, so by the
 * time a module is written its utilities are already gone from that file. The
 * comparison therefore needs the un-pruned bridge, which is regenerated from the
 * recovered Tailwind build for the duration of the check and then put back.
 *
 * Doing the backup/regenerate/restore by hand is three steps that are easy to get
 * wrong — and getting them wrong either reports a wall of false failures (pruned
 * bridge) or leaves the repo with a 32KB bridge that no longer reflects what is
 * still in use. This script owns the whole sequence so neither can happen.
 *
 * Usage: node scripts/verify-modules.mjs <map...>
 *        node scripts/verify-modules.mjs --all
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);
const STYLES = join(WEB, "src/styles");
const BRIDGE_SOURCE = join(WEB, "dist/assets/index-Cabx8XcG.css");
const MAPS = join(HERE, "module-maps");
/** Where the pruned bridge is parked while the full one is in place. */
const PARKED = [join(STYLES, "utilities.css"), join(STYLES, "preflight.css"), join(STYLES, "properties.css")];

const args = process.argv.slice(2);
const requested =
  args.length === 1 && args[0] === "--all"
    ? readdirSync(MAPS)
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => join(MAPS, f))
    : args;

if (requested.length === 0) {
  console.error("usage: node scripts/verify-modules.mjs <map...> | --all");
  process.exit(2);
}

const run = (script, extra = []) =>
  execFileSync(process.execPath, [join(HERE, script), ...extra], { cwd: WEB, encoding: "utf8" });

// Park the pruned bridge, then regenerate the full one.
for (const path of PARKED) copyFileSync(path, `${path}.pruned`);
try {
  run("gen-tailwind-bridge.mjs", [BRIDGE_SOURCE]);

  let failures = 0;
  for (const map of requested) {
    process.stdout.write(`${map.split(/[\\/]/).pop().replace(/\.mjs$/, "").padEnd(22)} `);
    try {
      const out = run("verify-module-css.mjs", [map]);
      console.log(out.trim().split("\n").pop());
    } catch (error) {
      failures++;
      console.log("FAILED");
      console.log(String(error.stdout ?? error.message).trim());
    }
  }

  console.log(failures === 0 ? "\nall mappings verified" : `\n${String(failures)} mapping(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  // Always restore, including on a failed comparison: leaving the full bridge in
  // place would make the next prune run think nothing is translated.
  for (const path of PARKED) copyFileSync(`${path}.pruned`, path);
}
