#!/usr/bin/env node
/**
 * rename-pi-extension.mjs — move `pi-extension/` → `server/` and rewrite
 * only the LIVE (non-historical) references.
 *
 * Why a script: the rename touches 51 live files across 6 subprojects and must
 * be atomic (git mv + rewrites in one pass). Historical records are excluded on
 * purpose — they state what was true when written and must not be falsified.
 *
 * Usage:
 *   node scripts/rename-pi-extension.mjs --dry-run   # report only, no writes
 *   node scripts/rename-pi-extension.mjs             # perform the rename
 *
 * Preconditions (checked): no live process holds `pi-extension/` as cwd
 * (Windows locks a directory that is any process's working directory).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const OLD = "pi-extension";
const NEW = "remote-pi";
const OLD_DIR = join(ROOT, OLD);
const NEW_DIR = join(ROOT, NEW);
const DRY = process.argv.includes("--dry-run");

/** Historical / generated trees that must NOT be rewritten. */
const EXCLUDE_PREFIXES = [
  "plan/",
  ".workflow/",
  ".orchestration/",
  "review/",
  "docs/plan/",
  ".git/",
  "app/build/",
  "cockpit/build/",
  "site/.next/",
];
/** The tree being moved: its own references are rewritten after the move. */
/** Files that also need their *name* changed (not just content). */
const RENAME_FILES = [
  [".claude/agents/scout-pi-extension.md", ".claude/agents/scout-remote-pi.md"],
];

function excluded(rel) {
  const norm = rel.replaceAll("\\", "/");
  return EXCLUDE_PREFIXES.some((p) => norm === p || norm.startsWith(p));
}

function relOf(f) {
  // git returns paths relative to the repo root, but with OS separators.
  return relative(ROOT, join(ROOT, f)).replaceAll("\\", "/");
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function sourceFiles() {
  // Live files OUTSIDE the moved tree that reference the old name.
  const hits = execFileSync("git", ["grep", "-l", "-F", OLD], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return hits.filter((f) => {
    const rel = relOf(f);
    if (rel === OLD || rel.startsWith(`${OLD}/`)) return false; // handled post-move
    return !excluded(rel);
  });
}

function rewrite(rel, { alsoName = false } = {}) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  const before = readFileSync(abs, "utf8");  // Replace the token only where it denotes the directory/package:
  //   `pi-extension/`  → `server/`
  //   "pi-extension"   → "remote-pi"  (JSON/paths)
  //   `pi-extension`   → `remote-pi`  (bare in prose/comments)
  // A blanket token replace is correct here because the npm package is already
  // named `remote-pi`; no distinct `pi-extension` identifier must survive.
  const after = before.replaceAll(OLD, NEW);
  if (after === before) return null;
  if (!DRY) writeFileSync(abs, after);
  return { rel, changed: true };
}

function main() {
  console.log(`[rename] root=${ROOT}`);
  console.log(`[rename] mode=${DRY ? "dry-run" : "APPLY"}`);

  if (!existsSync(OLD_DIR)) {
    console.error(`[rename] ${OLD}/ not found — already renamed?`);
    process.exit(1);
  }
  if (existsSync(NEW_DIR)) {
    console.error(`[rename] destination ${NEW}/ already exists — aborting to avoid clobber`);
    process.exit(1);
  }

  // 1. Probe the directory lock (Windows: any process cwd blocks rename).
  if (!DRY) {
    try {
      renameSync(OLD_DIR, `${OLD_DIR}.__lockprobe__`);
      renameSync(`${OLD_DIR}.__lockprobe__`, OLD_DIR);
    } catch (err) {
      console.error(`[rename] ${OLD}/ is locked (a live process holds it as cwd).`);
      console.error(`[rename] stop pi-supervisord (and any shell cd'd into ${OLD}/) and retry.`);
      console.error(`[rename] cause: ${String(err)}`);
      process.exit(2);
    }
  }

  // 2. Rewrite live references (content), before the move, so the moved tree
  //    is consistent with the outside world at all times.
  const files = sourceFiles();
  console.log(`[rename] live files referencing "${OLD}": ${files.length}`);
  let rewritten = 0;
  for (const f of files) {
    const r = rewrite(relOf(f));
    if (r) { rewritten += 1; console.log(`  ~ ${r.rel}`); }
  }
  console.log(`[rename] content rewrites: ${rewritten}`);

  // 3. Rename the scout agent file (content rewritten post-move in step 2b).
  for (const [from, to] of RENAME_FILES) {
    const fa = join(ROOT, from), ta = join(ROOT, to);
    if (!existsSync(fa)) { console.log(`  ! ${from} missing (skip)`); continue; }
    if (DRY) { console.log(`  > ${from} -> ${to}`); continue; }
    execFileSync("git", ["mv", from, to], { cwd: ROOT });
    console.log(`  > ${from} -> ${to}`);
  }

  // 4. Move the directory itself.
  if (DRY) {
    console.log(`  > git mv ${OLD} ${NEW}`);
  } else {
    execFileSync("git", ["mv", OLD, NEW], { cwd: ROOT, stdio: "inherit" });
    console.log(`  > git mv ${OLD} ${NEW}  (done)`);
  }

  // 5. Rewrite references INSIDE the moved tree (now at NEW/).
  if (DRY) {
    console.log(`[rename] (dry-run) would rewrite references inside ${NEW}/`);
  } else {
    const inside = execFileSync("git", ["grep", "-l", "-F", OLD, "--", NEW], {
      cwd: ROOT, encoding: "utf8",
    }).split("\n").map((s) => s.trim()).filter(Boolean);
    console.log(`[rename] inside ${NEW}/ referencing "${OLD}": ${inside.length}`);
    for (const f of inside) {
      const r = rewrite(relOf(f));
      if (r) console.log(`  ~ ${r.rel}`);
    }
  }

  console.log(DRY ? "[rename] dry-run complete — no changes written" : "[rename] DONE");
}

main();
