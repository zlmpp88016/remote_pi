/**
 * The session index is a pure cache in front of `SessionManager.list`.
 *
 * Three properties have to hold, and each one is a way this could silently be
 * wrong while looking fast:
 *
 *  1. A cold index must produce EXACTLY what the SDK produces — not "the same
 *     count", every field. A cache that changes the answer is a bug.
 *  2. A file that changed must be re-read; the ones that did not must not.
 *  3. Losing the index (deleted, corrupt, unopenable) must degrade to the slow
 *     path, never to an empty list.
 *
 * These tests use a real temp filesystem and real JSONL files, because the
 * whole subject is "what does this file look like", and mocking it away would
 * test the mock.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-idx-"));
  process.env["REMOTE_PI_HOME"] = home;
});

afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** A minimal but structurally faithful session transcript. */
function writeSession(
  dir: string,
  id: string,
  opts: {
    cwd: string;
    name?: string;
    firstUser?: string;
    lastTs?: number;
    padding?: number;
  },
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "session",
    id,
    cwd: opts.cwd,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  if (opts.name !== undefined) {
    lines.push(JSON.stringify({ type: "session_info", name: opts.name }));
  }
  lines.push(JSON.stringify({
    type: "message",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "user",
      content: opts.firstUser ?? "pergunta",
      timestamp: opts.lastTs ?? 1_767_225_601_000,
    },
  }));
  if (opts.padding) {
    for (let i = 0; i < opts.padding; i++) {
      lines.push(JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: "x".repeat(200),
          timestamp: (opts.lastTs ?? 1_767_225_601_000) + i,
        },
      }));
    }
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/** Points the module at [dir] as the bucket for [cwd], without the SDK's naming. */
function bucketFor(cwd: string): string {
  const resolved = path.resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(home, ".pi", "agent", "sessions", safe);
}

/**
 * Points the index's transcript root at this test's scratch tree.
 *
 * These tests write real JSONL fixtures, and the production root is the
 * developer's own `~/.pi/agent`. The DB still lives under `REMOTE_PI_HOME`;
 * only the transcript bucket is redirected.
 */
async function useScratchAgentRoot(): Promise<void> {
  const m = await import("./session_index.js");
  m.setAgentRootForTest(path.join(home, ".pi", "agent"));
  m.resetIndexForTest();
}

describe("session index", () => {
  test("cold and hot runs agree, and only the first one parses", async () => {
    const { listSessionsIndexed, lastIndexStats, resetIndexForTest } =
      await import("./session_index.js");
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws");
    const bucket = bucketFor(cwd);
    writeSession(bucket, "s1", { cwd, name: "proj", firstUser: "primeira" });
    writeSession(bucket, "s2", {
      cwd,
      firstUser: "segunda",
      lastTs: 1_767_225_900_000,
    });

    const cold = await listSessionsIndexed(cwd);
    expect(cold).not.toBeNull();
    expect(cold!.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    // Cold had to read both files.
    expect(lastIndexStats().parsed).toBe(2);

    const warm = await listSessionsIndexed(cwd);
    // Same answer...
    expect(warm).toEqual(cold);
    // ...with zero re-parsing. This is the property a stopwatch cannot prove.
    expect(lastIndexStats().parsed).toBe(0);

    resetIndexForTest();
  });

  test("the reported mtime is the newest message, not the file's", async () => {
    const { listSessionsIndexed, resetIndexForTest } = await import(
      "./session_index.js"
    );
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws2");
    const bucket = bucketFor(cwd);
    const lastTs = 1_767_300_000_000;
    const file = writeSession(bucket, "s1", { cwd, lastTs });

    const rows = await listSessionsIndexed(cwd);
    expect(rows![0]!.mtime).toBe(lastTs);
    // Explicitly NOT the filesystem stamp, which is what an index keyed on the
    // wrong column would have reported.
    expect(rows![0]!.mtime).not.toBe(fs.statSync(file).mtimeMs);

    resetIndexForTest();
  });

  test("changing one file re-parses only that file", async () => {
    const { listSessionsIndexed, lastIndexStats, resetIndexForTest } =
      await import("./session_index.js");
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws3");
    const bucket = bucketFor(cwd);
    const a = writeSession(bucket, "a", { cwd, firstUser: "aaa" });
    writeSession(bucket, "b", { cwd, firstUser: "bbb" });

    await listSessionsIndexed(cwd);
    expect(lastIndexStats().parsed).toBe(2);

    // Rewrite ONE file with a different size so (mtime, size) must differ.
    writeSession(bucket, "a", { cwd, firstUser: "aaa-mudou-de-verdade" });
    // Filesystems with coarse timestamps need the difference to be real.
    const now = new Date();
    fs.utimesSync(a, now, now);

    const rows = await listSessionsIndexed(cwd);
    expect(lastIndexStats().parsed).toBe(1);
    expect(rows!.find((r) => r.id === "a")!.preview).toBe("aaa-mudou-de-verdade");
    // The untouched one kept its cached preview rather than being re-read.
    expect(rows!.find((r) => r.id === "b")!.preview).toBe("bbb");

    resetIndexForTest();
  });

  test("a deleted transcript disappears instead of lingering as a ghost", async () => {
    const { listSessionsIndexed, resetIndexForTest } = await import(
      "./session_index.js"
    );
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws4");
    const bucket = bucketFor(cwd);
    const a = writeSession(bucket, "a", { cwd });
    writeSession(bucket, "b", { cwd });

    expect((await listSessionsIndexed(cwd))!).toHaveLength(2);

    fs.rmSync(a);
    const rows = await listSessionsIndexed(cwd);
    expect(rows!.map((r) => r.id)).toEqual(["b"]);

    resetIndexForTest();
  });

  test("deleting the index file rebuilds it with the same answer", async () => {
    const { listSessionsIndexed, lastIndexStats, resetIndexForTest, indexDbPath } =
      await import("./session_index.js");
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws5");
    const bucket = bucketFor(cwd);
    writeSession(bucket, "a", { cwd, firstUser: "um" });
    writeSession(bucket, "b", { cwd, firstUser: "dois" });

    const before = await listSessionsIndexed(cwd);
    expect(fs.existsSync(indexDbPath())).toBe(true);

    resetIndexForTest();
    fs.rmSync(indexDbPath(), { force: true });

    const after = await listSessionsIndexed(cwd);
    expect(after).toEqual(before);
    // A rebuilt index necessarily had to parse again.
    expect(lastIndexStats().parsed).toBe(2);

    resetIndexForTest();
  });

  test("a file that is not a session is ignored, not listed", async () => {
    const { listSessionsIndexed, resetIndexForTest } = await import(
      "./session_index.js"
    );
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws6");
    const bucket = bucketFor(cwd);
    writeSession(bucket, "real", { cwd });
    // No `type: "session"` header — the SDK drops these silently.
    fs.writeFileSync(path.join(bucket, "junk.jsonl"), "{}\n{}\n");

    const rows = await listSessionsIndexed(cwd);
    expect(rows!.map((r) => r.id)).toEqual(["real"]);

    resetIndexForTest();
  });

  test("an unusable index yields null so the caller falls back", async () => {
    const { listSessionsIndexed, closeIndex, indexDbPath } = await import(
      "./session_index.js"
    );
    await useScratchAgentRoot();
    const cwd = path.join(home, "ws7");
    writeSession(bucketFor(cwd), "a", { cwd });

    await listSessionsIndexed(cwd);
    closeIndex();
    // Make the path unopenable for a database: a DIRECTORY where the file
    // should be. The index must report "unavailable", not throw and not lie.
    fs.rmSync(indexDbPath(), { force: true });
    fs.mkdirSync(indexDbPath(), { recursive: true });

    const rows = await listSessionsIndexed(cwd);
    expect(rows).toBeNull();
  });

  test("a workspace with no bucket returns an empty list, not stale rows", async () => {
    const { listSessionsIndexed, resetIndexForTest } = await import(
      "./session_index.js"
    );
    const cwd = path.join(home, "nunca-existiu");
    const rows = await listSessionsIndexed(cwd);
    expect(rows).toEqual([]);
    resetIndexForTest();
  });
});
