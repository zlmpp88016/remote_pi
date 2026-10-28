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
  "verify-web-usage-stats",
  "verify-web-dock-alignment",
  "verify-web-chat-stream",
  "verify-web-chat-rows",
  "verify-web-handshake",
  "verify-web-models-cache",
  "verify-web-model-prefetch",
  "verify-web-skills",
  "verify-web-markdown",
  "verify-web-sessions",
  "verify-web-contrast-selection",
  "verify-web-contrast-states",
  "verify-web-contrast-error",
  "verify-web-contrast-tokens",
  "verify-web-contrast-rail-hover",
  "verify-web-contrast-hover",
  "verify-session-labels",
  "verify-web-session-click-feedback",
  "verify-web-resume-feedback",
];

/**
 * Gates that RESPAWN the host.
 *
 * Moved out of this runner entirely: `session_switch` and `session_new` make the
 * host exit and come back, and a loaded machine takes 45s to a usable composer
 * and ~4 minutes to a full session list. Back-to-back they each start while the
 * previous respawn is still finishing and fail on their own precondition
 * (`no session rows`, `turns=0`) rather than on a defect — which reads as a
 * regression in a gate nothing changed.
 *
 * Run them with `node scripts/run-respawn-gates.mjs`, which waits for a mature
 * host before each one and again after it. This runner stays fast and stable by
 * not knowing about them.
 */
/**
 * Gates that LIVE in `run-respawn-gates.mjs` instead of this runner.
 *
 * They are listed here ONLY so the drift guard below knows they are accounted
 * for (a `verify-web-*.mjs` that appears in no list is reported as unlisted).
 * They do NOT run from this file: each needs a settled host before and after,
 * because a switch makes the host exit and come back.
 */
const SUITE_LIVE = [
  "verify-web-resume-chat",
  "verify-web-new-session",
  "verify-web-ctrl-n",
  "verify-web-read-prefetch",
  "verify-web-host-liveness",
  "verify-web-draft-per-session",
  "verify-web-resume-history",
  "verify-web-sessions-retry",
  "verify-web-sessions-selfheal",
  "verify-web-sessions-warmup",
];

/**
 * Gates whose subject RESPAWNS the host.
 *
 * `session_switch` and `session_new` both make the host exit and come back, and
 * a loaded machine takes 45s+ to do it. Two of these back to back therefore
 * means the second one starts while the first respawn is still finishing, and it
 * fails on its own precondition (`no session rows`, `turns=0`) rather than on a
 * defect.
 *
 * They are correct and reliable one at a time — that is how each was developed
 * and verified. Running them as a group needs a host-settle pause between each,
 * which is what `--live` does. They are NOT part of the fast suite: a fast gate
 * that needs a minute of quiet before it can even begin is not fast.
 */
const SUITE_RESPAWN = [
  "verify-web-resume-chat",
  "verify-web-new-session",
  "verify-web-ctrl-n",
];

// Drift guard: a new script must be added above (or to SUITE_LIVE), not
// forgotten. A silently unlisted gate is a gate that stopped running.
/**
 * Gates that require a running `--direct` server on 4124.
 *
 * They cannot live in `SUITE`, which must pass with no server at all, and they
 * are not respawn gates either. Listed here so the drift guard still sees them as
 * accounted for: a `verify-web-*.mjs` in no list is reported as unlisted.
 */
const SUITE_DIRECT = ["verify-web-local-auth", "verify-web-sse-transport"];

const SUITE_EXTRA = ["verify-session-labels"];
const present = readdirSync(here)
  .filter((f) => /^verify-web-.*\.mjs$/.test(f) || SUITE_EXTRA.some((n) => f === `${n}.mjs`))
  .map((f) => f.replace(/\.mjs$/, ""));
const known = [...SUITE, ...SUITE_LIVE, ...SUITE_DIRECT];const unlisted = present.filter((name) => !known.includes(name));
const missing = known.filter((name) => !present.includes(name));
if (unlisted.length > 0) {
  console.log(`\n!! verify-web-*.mjs não listado em SUITE: ${unlisted.join(", ")}`);
}
if (missing.length > 0) {
  console.log(`\n!! listado em SUITE mas ausente do disco: ${missing.join(", ")}`);
}

const runLive = process.argv.includes("--live");
/*
 * `--live` delegates to the dedicated runner and exits.
 *
 * Those gates need a MATURE host before each one and a fresh settle after it, so
 * they cannot share this loop's simple sequencing. Delegating keeps one obvious
 * entry point (`--live`) without pretending the two can be interleaved.
 */
if (runLive) {
  console.log("[--live] handing over to run-respawn-gates.mjs (they need a settled host each)\n");
  const { spawnSync } = await import("node:child_process");
  const delegated = spawnSync("node", [join(here, "run-respawn-gates.mjs")], {
    cwd: siteRoot,
    stdio: "inherit",
  });
  process.exit(delegated.status ?? 1);
}

/**
 * Gates that need a reload between them, but do NOT respawn the host.
 *
 * They click session rows and open the read-only viewer, which changes what the
 * NEXT gate sees even though nothing is resumed.
 */
const SUITE_ISOLATED = new Set([
  "verify-web-resume-feedback",
  "verify-web-contrast-states",
  "verify-web-session-click-feedback",
]);
const suite = SUITE;

const failed = [];
for (const name of suite) {
  /*
   * Reset the page between the gates that mutate the host's live session.
   *
   * These gates share one real Chrome and one real host session; resuming or
   * starting a new one changes what the NEXT gate sees. Without the reset the
   * failure set changed on every run, which reads as a regression while moving
   * around. A reload is what a user would do and is sufficient.
   */
  if (SUITE_ISOLATED.has(name)) {
    /*
     * Let the host settle before the reset.
     *
     * The gates in this group resume or start sessions, which makes the host
     * RESPAWN. That respawn is asynchronous: a `session_new` issued by the gate
     * that just finished can still be restarting the process when the next gate
     * begins, and the reload then attaches to a page whose room is about to drop.
     * Without this pause the group failed as a block while every gate passed on
     * its own.
     */
    try {
      execFileSync("node", [join(here, "_settle-host.mjs")], {
        cwd: siteRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      /* A failed settle is reported by the gate itself. */
    }
    try {
      execFileSync("node", [join(here, "_reset-page.mjs")], {
        cwd: siteRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      /* A failed reset is reported by the gate itself. */
    }
  }
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
  `\n${suite.length - failed.length}/${suite.length} runners OK${failed.length ? ` · FAIL: ${failed.join(", ")}` : ""}`,
);
process.exit(exit);
