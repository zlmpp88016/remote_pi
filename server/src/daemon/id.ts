import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/**
 * Stable 8-character hex id for a daemon, derived from the cwd it manages.
 *
 * Derivation: `sha256(realpath(cwd))` truncated to 8 hex chars (32 bits ≈
 * 4 billion). Collision risk is negligible at fleet sizes a single user
 * will ever have (<1000 daemons), and 8 hex characters are short enough
 * to type on the CLI (`/remote-pi send a1b2c3d4 "..."`).
 *
 * Same scheme as `roomIdForCwd` in `src/rooms.ts` — but we use hex
 * instead of base64url so the id has no `_`/`-` (cleaner double-click
 * selection in terminals).
 *
 * Symlinks resolve to a single canonical id via `realpath`, so
 * `/Users/x/Movies` and `/Users/x/link-to-Movies` map to the same daemon.
 * Falls back to the raw path when realpath fails (cwd doesn't exist —
 * shouldn't happen in production but covers test sandboxes).
 *
 * plan/41 audit (2026-06-08): this stays **per-cwd** (no name axis). The
 * multiagent-per-folder model (plan/38/41) applies to the App↔Pi room and the
 * mesh address; a *supervisor daemon* is **one per cwd** by design — the
 * registry keys exactly one entry per cwd (`registry.ts`), so a daemon id never
 * needs the name to disambiguate. Decision: leave `daemonIdForCwd` cwd-only.
 */
export function daemonIdForCwd(cwd: string): string {
  return createHash("sha256").update(canonicalCwd(cwd)).digest("hex").slice(0, 8);
}

/**
 * The single canonical spelling of a directory, used for BOTH the registry's
 * dedupe comparison and the id derivation.
 *
 * Why this exists: the two used to disagree. `normalizeCwd` called
 * `realpathSync` (the JS implementation), which on Windows resolves symlinks but
 * PRESERVES the caller's drive-letter case — `d:\x` stays `d:\x` while `D:\x`
 * stays `D:\x`. The registry then deduped on that string, so the same physical
 * directory could be registered twice under two spellings, producing two daemon
 * ids and TWO live Pi processes for one folder (measured: 93264 + 16448 alive at
 * once against `D:\模型测试\4.1f`).
 *
 * `realpathSync.native` delegates to the OS canonicalizer and returns the real
 * on-disk case, so `d:/x` and `D:/x` collapse to one string. Deliberately does NO
 * `toLowerCase`: ids are already persisted in `daemons.json` and referenced by
 * scheduled tasks, so changing the case of an existing path would silently
 * re-key every daemon. Native realpath is enough — it is the only step that was
 * missing.
 *
 * Falls back to the trimmed input when the path cannot be resolved (a registry
 * entry pointing at a deleted folder), which keeps two genuinely different
 * missing paths distinct.
 */
export function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd.trim();
  }
}
