/**
 * Shared helpers for tests that depend on POSIX-only filesystem semantics.
 *
 * `symlinkSync` needs `SeCreateSymbolicLinkPrivilege` on Windows (or Developer
 * Mode). Without it Node throws `EPERM`, so a test that sets up a symlink to
 * assert realpath canonicalization cannot run at all — it fails on the setup
 * line, long before the behavior under test is exercised.
 *
 * The behavior being tested is genuinely platform-dependent: on Windows the
 * same canonicalization goes through a different code path. Rather than
 * silently passing, tests skip explicitly with the reason recorded, so a
 * Windows run reports "skipped (no symlink privilege)" instead of pretending
 * coverage it never had.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * True when this host can actually create directory symlinks.
 *
 * Probed once by attempting the real operation in a throwaway directory —
 * checking the platform alone would wrongly skip Windows machines that DO have
 * Developer Mode enabled.
 */
export function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "pi-symlink-probe-"));
  try {
    const target = join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Reason string for `test.skipIf`, so the skip is self-explanatory in output. */
export const SYMLINK_SKIP_REASON =
  "requires symlink creation privilege (unavailable on this host — Windows without Developer Mode)";
