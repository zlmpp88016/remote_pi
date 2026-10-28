/**
 * Compare two computed-style fingerprints and report element-level differences.
 *
 * Reports the first few concrete differences with their element path and the
 * property values on each side, because "the docs page differs" is not
 * actionable while "body[0]/div[3]/button[1] lost its border-radius" is.
 *
 * Elements are matched by DOM path. A path that exists on only one side is
 * reported separately as added/removed, since that means the tree itself changed
 * — a missing element is a rendering failure, not a styling one, and conflating
 * the two would hide it.
 *
 * Usage: node scripts/diff-style-fingerprint.mjs <a.json> <b.json> [maxDetails]
 */

import { readFileSync } from "node:fs";

const [, , fileA, fileB, maxArg] = process.argv;
if (fileA === undefined || fileB === undefined) {
  console.error("usage: node scripts/diff-style-fingerprint.mjs <a.json> <b.json> [maxDetails]");
  process.exit(2);
}
const maxDetails = maxArg === undefined ? 12 : Number(maxArg);

const a = JSON.parse(readFileSync(fileA, "utf8"));
const b = JSON.parse(readFileSync(fileB, "utf8"));

let anyDiff = false;

for (const route of Object.keys(a.routes)) {
  const left = a.routes[route];
  const right = b.routes[route] ?? [];
  const byPath = new Map(right.map((e) => [e.path, e]));

  let changed = 0;
  let removed = 0;
  let geometryOnly = 0;
  const details = [];

  for (const el of left) {
    const other = byPath.get(el.path);
    if (other === undefined) {
      removed++;
      if (details.length < maxDetails) details.push(`REMOVED  ${el.path}`);
      continue;
    }
    byPath.delete(el.path);

    const diffs = [];
    for (const key of Object.keys(el.values)) {
      // Raw colour properties are skipped: the browser's serialisation of a colour
      // depends on how it was produced (`oklab(...)` vs `rgba(...)` for the same
      // value). The canonical `~prop` entry recorded alongside is what is compared.
      if (key.startsWith("~")) continue;
      if (el.values["~" + key] !== undefined) continue;
      if (el.values[key] !== other.values[key]) {
        diffs.push(`${key}: ${JSON.stringify(el.values[key])} -> ${JSON.stringify(other.values[key])}`);
      }
    }
    for (const key of Object.keys(el.values)) {
      if (!key.startsWith("~")) continue;
      if (el.values[key] !== other.values[key]) {
        const name = key.slice(1);
        diffs.push(`${name} (resolved): ${JSON.stringify(el.values[name])} -> ${JSON.stringify(other.values[name])}`);
      }
    }
    const moved = el.rect.join(",") !== other.rect.join(",");
    if (diffs.length > 0) {
      changed++;
      if (details.length < maxDetails) {
        details.push(`CHANGED  ${el.path}\n         ${diffs.slice(0, 6).join("\n         ")}`);
      }
    } else if (moved) {
      // Geometry moved but every declared style matched: usually text reflow from
      // a font or a scroll position, not a style regression.
      geometryOnly++;
    }
  }

  const added = byPath.size;
  const label = route.padEnd(10);
  if (changed === 0 && removed === 0 && added === 0) {
    console.log(`${label} OK   ${String(left.length)} elements, styles identical${geometryOnly > 0 ? ` (${String(geometryOnly)} moved without style change)` : ""}`);
    continue;
  }

  anyDiff = true;
  console.log(`${label} DIFF elements ${String(left.length)} -> ${String(right.length)}; changed ${String(changed)}, removed ${String(removed)}, added ${String(added)}${geometryOnly > 0 ? `, moved ${String(geometryOnly)}` : ""}`);
  for (const d of details) console.log(`  ${d}`);
}

process.exit(anyDiff ? 1 : 0);
