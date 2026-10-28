/**
 * Assert that `clients/web` is actually on the deepseek-harness stack.
 *
 * The migration moved four things at once (TypeScript, bundler, React, styling),
 * and every one of them can silently regress without any test failing: a stray
 * `next/*` import compiles under Vite, a Tailwind directive is inert without the
 * plugin, and nothing in the app notices either. So this checks the stack itself
 * rather than behaviour — behaviour is covered by the E2E harnesses.
 *
 * Run: `node scripts/verify-stack-parity.mjs` (from `clients/web`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
};

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

/** `^6.0.3` / `~6.1` / `6.0.3` all mean "major 6". */
const majorOf = (range) => {
  const m = String(range).match(/(\d+)\./);
  return m === null ? null : Number(m[1]);
};

console.log("A. dependency versions");
check(
  "typescript is v6",
  majorOf(deps["typescript"]) === 6,
  `typescript ${deps["typescript"] ?? "(missing)"}`,
);
check("react is v18", majorOf(deps["react"]) === 18, `react ${deps["react"] ?? "(missing)"}`);
check(
  "react-dom is v18",
  majorOf(deps["react-dom"]) === 18,
  `react-dom ${deps["react-dom"] ?? "(missing)"}`,
);
check("vite is v6", majorOf(deps["vite"]) === 6, `vite ${deps["vite"] ?? "(missing)"}`);

console.log("\nB. removed frameworks");
for (const gone of ["next", "tailwindcss", "@tailwindcss/postcss", "@tailwindcss/vite"]) {
  check(`${gone} is not a dependency`, deps[gone] === undefined, deps[gone] ?? "");
}

console.log("\nC. no framework-specific imports");
/*
 * `next/*` is the one that matters: Vite would happily resolve nothing and the
 * build would fail — but `next/link` replaced by a local component means a STALE
 * import can linger in a file the build happens not to reach (a story, a test, a
 * dead module). Scanning the source is the only way to see that.
 */
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

const sourceFiles = walk(join(ROOT, "src"));
const offenders = [];
for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  // Comments are stripped first: several files legitimately DISCUSS Next in a
  // comment explaining what the replacement does.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  for (const m of code.matchAll(/from\s+["'](next\/[^"']+|tailwindcss)["']/g)) {
    offenders.push(`${relative(ROOT, file)}: ${m[1]}`);
  }
  if (/@tailwind\s+base|@tailwind\s+components|@tailwind\s+utilities|@apply\s/.test(code)) {
    offenders.push(`${relative(ROOT, file)}: Tailwind directive`);
  }
}
check(
  "no next/* or tailwind imports/directives under src/",
  offenders.length === 0,
  offenders.slice(0, 5).join("; "),
);

console.log("\nD. CSS Modules are in use");
const modules = sourceFiles.filter((f) => f.endsWith(".module.css"));
check("at least one *.module.css exists", modules.length > 0, `${modules.length} modules`);

/*
 * The real question is not "are modules present" but "did the utilities actually
 * move". A component that still carries a utility-soup `className` string would
 * render correctly only as long as a bridge stylesheet exists, and the bridge is
 * gone — the classes would be inert and the element unstyled.
 *
 * The shape being detected: a className string literal with three or more
 * space-separated tokens where at least one looks like a Tailwind utility
 * (contains `-` and no `_`). Ordinary class strings (`"field"`) do not match.
 */
const UTILITY_SHAPE = /(?:^|\s)(?:[a-z-]+:)?[a-z][a-z0-9]*(?:-[a-z0-9.[\]/%]+)+/;
const soup = [];
for (const file of sourceFiles.filter((f) => f.endsWith(".tsx"))) {
  const code = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  for (const m of code.matchAll(/className="([^"]*)"/g)) {
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    if (tokens.length >= 3 && UTILITY_SHAPE.test(m[1])) {
      soup.push(`${relative(ROOT, file)}: ${m[1].slice(0, 60)}`);
    }
  }
}
check(
  "no utility-soup className strings left",
  soup.length === 0,
  soup.length === 0 ? `${modules.length} modules` : soup.slice(0, 4).join("; "),
);

console.log("\nE. build entry points");
const entryFiles = ["index.html", "vite.config.ts", "src/main.tsx"];
for (const rel of entryFiles) {
  let exists = true;
  try {
    statSync(join(ROOT, rel));
  } catch {
    exists = false;
  }
  check(`${rel} exists`, exists);
}
for (const gone of ["next.config.ts", "next.config.mjs", "postcss.config.mjs", "next-env.d.ts"]) {
  let exists = true;
  try {
    statSync(join(ROOT, gone));
  } catch {
    exists = false;
  }
  check(`${gone} is gone`, !exists);
}

console.log(
  failures === 0 ? "\nstack parity: OK" : `\nstack parity: ${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
