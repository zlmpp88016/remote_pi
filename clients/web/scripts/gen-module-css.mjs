/**
 * Regenerate a module stylesheet from its mapping in ONE pass.
 *
 * Running `css-for-classnames.mjs` twice on the same output file silently keeps
 * only the second batch — the file is written with `>`, not appended. That
 * happened while translating the sidebar: the first 40 classes vanished and the
 * verifier reported 67 missing selectors, which looked like a generator bug
 * rather than a two-step overwrite.
 *
 * Driving the generator from the mapping file makes the module and its evidence
 * the same source, so they cannot drift: whatever `verify-modules.mjs` compares
 * against is exactly what produced the file.
 *
 * Usage: node scripts/gen-module-css.mjs <map>
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE);

const mapPath = process.argv[2];
if (mapPath === undefined) {
  console.error("usage: node scripts/gen-module-css.mjs <map>");
  process.exit(2);
}

const { file, groups } = (await import(pathToFileURL(resolve(mapPath)).href)).default;

const args = groups.map(([name, utilities]) => `${name}=${utilities}`);
const css = execFileSync(process.execPath, [join(HERE, "css-for-classnames.mjs"), ...args], {
  cwd: WEB,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (css.includes("/* !! missing:")) {
  console.error("some utilities are not in the bridge — regenerate it first:");
  console.error("  node scripts/gen-tailwind-bridge.mjs dist/assets/index-Cabx8XcG.css");
  console.error(css.split("\n").filter((l) => l.includes("missing")).join("\n"));
  process.exit(1);
}

const out = join(WEB, file);
// Preserve the file's existing header comment (the layer-order explanation) when
// it has one: it documents WHY the wrapper exists and is not regenerable.
writeFileSync(out, css, "utf8");
execFileSync(process.execPath, [join(HERE, "wrap-module-layer.mjs"), file], { cwd: WEB, encoding: "utf8" });

console.log(`${file}: ${String(groups.length)} groups written`);
