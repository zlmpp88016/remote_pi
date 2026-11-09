/**
 * CONTRACT TEST — the index must be indistinguishable from the SDK.
 *
 * `session_index.ts` reproduces the SDK's derivation rules (newest message
 * timestamp rather than file mtime, first USER message as the preview, header
 * `cwd`), because the SDK exports neither its parser nor its session-bucket
 * helper. Reproduced rules drift; this test is what stops them.
 *
 * It deliberately uses the REAL SDK on the REAL developer session directory
 * rather than synthetic fixtures: an earlier probe of this very repo produced a
 * bucket name containing a backslash because the path normalisation was wrong,
 * and only comparing against `SessionManager.list` surfaced it. When the
 * machine has no sessions for the chosen cwd, the test skips instead of
 * pretending to have checked.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const { listSessionsIndexed } = await import("./session_index.js");

/**
 * Picks any cwd that actually has sessions on this machine, so the comparison
 * has something to compare. Returns null when there is nothing to check.
 */
function findPopulatedCwd(): string | null {
  try {
    const root = path.join(os.homedir(), ".pi", "agent", "sessions");
    const buckets = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const b of buckets) {
      const dir = path.join(root, b.name);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) continue;
      // The header carries the authoritative cwd; the bucket name is derived.
      const first = fs.readFileSync(path.join(dir, files[0]!), "utf8").split("\n")[0];
      const header = JSON.parse(first) as { cwd?: string };
      if (typeof header.cwd === "string" && header.cwd !== "") return header.cwd;
    }
  } catch {
    /* no sessions on this machine */
  }
  return null;
}

const cwd = findPopulatedCwd();

describe("session index — SDK contract", () => {
  test(
    "a cold index returns exactly what SessionManager.list returns",
    async () => {
      if (cwd === null) {
        // Nothing to compare on this machine. Skipping is honest; asserting
        // equality against an empty expectation would not be.
        expect(cwd).toBeNull();
        return;
      }

      const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-contract-"));
      const previous = process.env["REMOTE_PI_HOME"];
      process.env["REMOTE_PI_HOME"] = home;
      try {
        const { resetIndexForTest } = await import("./session_index.js");
        resetIndexForTest();

        const direct = (await SessionManager.list(cwd)).map((s) => ({
          id: s.id,
          path: s.path,
          name: s.name,
          mtime: s.modified instanceof Date ? s.modified.getTime() : Number(s.modified),
          preview: s.firstMessage ? s.firstMessage.slice(0, 200) : undefined,
          cwd: s.cwd || cwd,
        }));

        const indexed = await listSessionsIndexed(cwd);

        expect(indexed).not.toBeNull();
        const byPath = new Map(indexed!.map((r) => [r.path, r]));
        expect(indexed!.length).toBe(direct.length);

        for (const d of direct) {
          const i = byPath.get(d.path);
          expect(i, `missing ${d.path}`).toBeDefined();
          expect(i!.id).toBe(d.id);
          expect(i!.name).toBe(d.name);
          // The field most likely to drift: file mtime vs newest message.
          expect(i!.mtime).toBe(d.mtime);
          expect(i!.preview).toBe(d.preview);
          expect(i!.cwd).toBe(d.cwd);
        }
      } finally {
        // Close BEFORE restoring the env and deleting: on Windows an open
        // SQLite handle makes the directory un-removable (EBUSY).
        try {
          const { resetIndexForTest } = await import("./session_index.js");
          resetIndexForTest();
        } catch {
          /* nothing to close */
        }
        if (previous === undefined) {
          delete process.env["REMOTE_PI_HOME"];
        } else {
          process.env["REMOTE_PI_HOME"] = previous;
        }
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
