/**
 * Measures the session index against the direct SDK path.
 *
 * This exists because the performance goal of Passo 6 is a NUMBER ("remote_pi
 * from 4251 ms to under 300 ms"), and a number nobody can re-measure is folklore.
 * It reports, per workspace:
 *
 *   coldMs    — empty index, everything parsed (the old cost, plus index writes)
 *   hotMs     — warm index, nothing parsed (the new cost)
 *   coldParsed/hotParsed — files actually read, so "it got faster" cannot be
 *                explained by silently returning fewer sessions
 *
 * Usage:
 *   cd server && npx tsc -p tsconfig.json && node scripts/bench-session-index.mjs [cwd...]
 *
 * Defaults to two workspaces with very different transcript volumes (small and
 * large) so the difference is visible rather than anecdotal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rp-bench-idx-"));
process.env["REMOTE_PI_HOME"] = scratch;

const { listWorkspaceSessions } = await import("../dist/actions/sessions.js");
const { lastIndexStats, indexDbPath, resetIndexForTest } = await import(
  "../dist/actions/session_index.js"
);

const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push(
    String.raw`D:\模型测试\4.1f`,
    path.resolve(process.cwd(), ".."),
  );
}

console.log(`index: ${indexDbPath()}`);
for (const cwd of targets) {
  if (!fs.existsSync(cwd)) {
    console.log(`skip (missing): ${cwd}`);
    continue;
  }
  resetIndexForTest();
  fs.rmSync(indexDbPath(), { force: true });

  let t = Date.now();
  const cold = await listWorkspaceSessions(cwd);
  const coldMs = Date.now() - t;
  const coldParsed = lastIndexStats().parsed;

  t = Date.now();
  const hot = await listWorkspaceSessions(cwd);
  const hotMs = Date.now() - t;
  const hotParsed = lastIndexStats().parsed;

  console.log(JSON.stringify({
    cwd,
    sessions: cold.length,
    coldMs,
    coldParsed,
    hotMs,
    hotParsed,
    sameAnswer: cold.length === hot.length,
  }));
}

// Best-effort: on Windows an open SQLite handle can keep the directory locked
// even after the process stops using it, and a benchmark must not "fail"
// because it could not delete its own scratch space.
try {
  resetIndexForTest();
  fs.rmSync(scratch, { recursive: true, force: true });
} catch {
  /* leave the temp dir to the OS */
}
