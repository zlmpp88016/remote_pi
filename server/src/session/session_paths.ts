/**
 * Plan 86 P1 — pure session-bucket derivation, shared by the SQLite index
 * (`actions/session_index.ts`) and the host history read domain.
 *
 * Kept SDK-free ON PURPOSE: the host history service runs inside
 * `pi-supervisord`, where no Pi process exists. It cannot import the SDK just
 * to ask where the agent directory is, so the rule is reproduced here and the
 * index delegates to it — one definition, no drift.
 *
 * The rule mirrors the SDK's `getAgentDir()` / `getSessionsDir()`:
 *
 *   agent root = PI_CODING_AGENT_DIR (tilde-expanded) → `~/.pi/agent`
 *   bucket     = `<agent root>/sessions/--<cwd with [\/:]→->--`
 *
 * The bucket substitution uses `path.resolve(cwd)` verbatim (NOT realpath):
 * Windows drive-letter case is preserved by the SDK too, and changing it here
 * would point at a bucket that does not exist.
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Expand a leading `~` the way the SDK's `normalizePath` does. */
export function expandTilde(input: string, home: string = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (process.platform === "win32" && input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}

/**
 * The Pi agent root that owns transcripts, derived without the SDK.
 *
 * `PI_CODING_AGENT_DIR` wins when set (the SDK honours it too); otherwise the
 * conventional `~/.pi/agent`.
 */
export function agentRootFromEnv(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env["PI_CODING_AGENT_DIR"];
  if (override !== undefined && override.trim() !== "") return expandTilde(override.trim(), home);
  return join(home, ".pi", "agent");
}

/**
 * The session bucket for [cwd], derived exactly the way the SDK does it.
 *
 * resolve → forward slashes → drop the leading separator → replace every `/`,
 * `\` and `:` with `-` → wrap in `--…--`.
 */
export function sessionDirFor(cwd: string, agentDir: string): string {
  const resolved = resolve(cwd);
  const safe = `--${resolved
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/**
 * True when [child] resolves inside [parent] (or equals it).
 *
 * Used as defence-in-depth before the history worker opens a session file: the
 * path always comes from the host's own listing, never from the wire, and this
 * check refuses anything that escaped the derived bucket.
 */
export function isPathInside(child: string, parent: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const b = normalize(base);
  const t = normalize(target);
  if (t === b) return true;
  return t.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Are two absolute paths the same file for authorization purposes?
 *
 * The host derives paths itself (never from the wire), so this is a comparison,
 * not a resolution. Windows is case-insensitive; POSIX is byte-exact. Kept here
 * (SDK-free, no I/O) because BOTH the supervisor's authority registry and the
 * history service must agree on it — two definitions would drift.
 */
export function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : false;
}
