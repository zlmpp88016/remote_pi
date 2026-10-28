/**
 * Run the gates that RESPAWN the host, one at a time, each from a settled host.
 *
 * Why this is separate from `run-web-checks.mjs`:
 *
 * These four gates each make the host exit and come back — `session_switch` and
 * `session_new` restart the Pi, and `session_read` prefetch measurement depends on
 * a responsive host. A respawn takes 45s to a usable composer and ~4 minutes to a
 * full session list on this machine. Running them back to back therefore means
 * each one starts while the previous respawn is still finishing, and it fails on
 * its own precondition (`no session rows`, `turns=0`) rather than on a defect.
 *
 * Each gate is reliable ALONE (that is how each was developed and verified), so
 * this runner:
 *   1. waits for the host to be genuinely mature before each gate, and
 *   2. waits again after each gate, before the next one starts.
 *
 * The fast suite (`run-web-checks.mjs`) stays fast and stable by excluding them.
 *
 * Usage: node scripts/run-respawn-gates.mjs [name…]
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");

const ALL = [
  /*
   * `read-prefetch` goes FIRST: it is the only gate here that needs nothing but
   * a non-empty session list, and every gate after it forces a host respawn. Run
   * later and it fails on `0 session rows` — its own precondition, caused purely
   * by the previous gate's restart, which reads like a regression in prefetch.
   */
  "verify-web-read-prefetch",
  "verify-web-resume-chat",
  "verify-web-new-session",
  "verify-web-ctrl-n",
  "verify-web-host-liveness",
  "verify-web-draft-per-session",
  /*
   * `sessions-*` after the resuming gates on purpose: `sessions-warmup` needs a
   * host that is still COMING UP, which is exactly the state the previous gate
   * leaves behind. Run it on a long-settled host and it would pass trivially
   * without exercising the startup window it exists to cover.
   */
  "verify-web-resume-history",
  "verify-web-sessions-retry",
  "verify-web-sessions-warmup",
  "verify-web-sessions-selfheal",
];

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const gates = requested.length > 0 ? requested : ALL;

function run(script, label) {
  try {
    execFileSync("node", [join(here, script)], {
      cwd: siteRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, out: "" };
  } catch (err) {
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const lines = text
      .split("\n")
      .filter((l) => /FAIL:|Error/.test(l))
      .slice(0, 6)
      .join("\n");
    return { ok: false, out: lines || label };
  }
}

const failed = [];
for (const gate of gates) {
  process.stdout.write(`${gate.padEnd(30)} `);

  /*
   * Host maturity, not merely liveness.
   *
   * `_settle-host` demands a non-empty session list twice, spaced out, which is
   * what distinguishes "the process answered" from "the workspace is ready".
   */
  const settled = run("_settle-host.mjs", "host did not settle");
  if (!settled.ok) {
    console.log("SKIP (host never settled)");
    failed.push(gate);
    continue;
  }
  const reset = run("_reset-page.mjs", "page did not reset");
  if (!reset.ok) {
    console.log("SKIP (page did not reset)");
    failed.push(gate);
    continue;
  }

  const result = run(`${gate}.mjs`, "gate failed");
  console.log(result.ok ? "OK" : "FAIL");
  if (!result.ok) {
    failed.push(gate);
    if (result.out) console.log(result.out);
  }

  /*
   * Let the host finish respawning before the next gate touches it.
   *
   * Without this pause the failure moves to whichever gate runs second, which
   * reads as a regression in that gate while nothing about it changed.
   */
  if (gate !== gates[gates.length - 1]) {
    console.log("   (waiting for the host to settle again…)");
    run("_settle-host.mjs", "host did not settle");
  }
}

console.log(
  `\n${gates.length - failed.length}/${gates.length} respawn gates OK` +
    (failed.length > 0 ? ` · FAIL: ${failed.join(", ")}` : ""),
);
process.exit(failed.length > 0 ? 1 : 0);
