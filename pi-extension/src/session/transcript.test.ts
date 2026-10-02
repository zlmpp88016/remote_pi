import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeBranchEntryIds,
  decodeTranscriptCursor,
  encodeTranscriptCursor,
  InvalidTranscriptCursorError,
  normalizeEntries,
  olderTranscriptPage,
  readTranscriptEntries,
  recentTranscriptWindow,
  type TranscriptEntry,
} from "./transcript.js";

const tempDirs: string[] = [];

function tempSessionFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rp-transcript-"));
  tempDirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

function entry(id: string, parentId: string | null, timestamp: string, role = "user"): TranscriptEntry {
  return { id, parentId, timestamp, message: { role, content: "text" } };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("transcript cursor", () => {
  it("round-trips a timestamp", () => {
    const iso = "2026-09-29T10:00:00.000Z";
    expect(decodeTranscriptCursor(encodeTranscriptCursor(iso))).toBe(iso);
  });

  it("rejects a forged cursor", () => {
    expect(() => decodeTranscriptCursor("not-a-cursor!!")).toThrow(InvalidTranscriptCursorError);
    // Valid base64url of a non-date string must also be rejected.
    expect(() => decodeTranscriptCursor(Buffer.from("hello", "utf8").toString("base64url"))).toThrow(
      InvalidTranscriptCursorError,
    );
  });

  it("rejects a padded encoding, since the encoder never pads", () => {
    // A valid timestamp whose base64 requires padding; the regex rejects '='.
    const iso = "2026-09-29T10:00:00Z";
    const padded = Buffer.from(iso, "utf8").toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(() => decodeTranscriptCursor(padded)).toThrow(InvalidTranscriptCursorError);
  });
});

describe("recentTranscriptWindow", () => {
  const entries = Array.from({ length: 5 }, (_, index) =>
    entry(`e${index}`, index === 0 ? null : `e${index - 1}`, `2026-09-29T10:0${index}:00.000Z`),
  );

  it("returns the newest `limit` entries with hasOlder=true", () => {
    const page = recentTranscriptWindow(entries, 2);
    expect(page.entries.map((e) => e.id)).toEqual(["e3", "e4"]);
    expect(page.hasOlder).toBe(true);
    expect(page.olderCursor).toBe(encodeTranscriptCursor("2026-09-29T10:03:00.000Z"));
  });

  it("returns everything when limit exceeds the count, with no cursor", () => {
    const page = recentTranscriptWindow(entries, 50);
    expect(page.entries).toHaveLength(5);
    expect(page.hasOlder).toBe(false);
    expect(page.olderCursor).toBeNull();
  });

  it("treats an exact-size window as complete", () => {
    const page = recentTranscriptWindow(entries, 5);
    expect(page.entries).toHaveLength(5);
    expect(page.hasOlder).toBe(false);
  });
});

describe("olderTranscriptPage", () => {
  const entries = Array.from({ length: 5 }, (_, index) =>
    entry(`e${index}`, null, `2026-09-29T10:0${index}:00.000Z`),
  );

  it("pages backwards exclusively above the cursor", () => {
    const cursor = encodeTranscriptCursor("2026-09-29T10:03:00.000Z");
    const page = olderTranscriptPage(entries, cursor, 2);
    expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(page.hasOlder).toBe(true);
  });

  it("reports the tail of history as complete", () => {
    const cursor = encodeTranscriptCursor("2026-09-29T10:02:00.000Z");
    const page = olderTranscriptPage(entries, cursor, 10);
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "e1"]);
    expect(page.hasOlder).toBe(false);
    expect(page.olderCursor).toBeNull();
  });

  it("rejects a cursor that is not in the transcript", () => {
    const foreign = encodeTranscriptCursor("2026-01-01T00:00:00.000Z");
    expect(() => olderTranscriptPage(entries, foreign, 2)).toThrow(InvalidTranscriptCursorError);
  });

  it("walks the whole history without gaps or duplicates", () => {
    const collected: string[] = [];
    let cursor: string | null = recentTranscriptWindow(entries, 2).olderCursor;
    while (cursor) {
      const page = olderTranscriptPage(entries, cursor, 2);
      collected.unshift(...page.entries.map((e) => e.id));
      cursor = page.olderCursor;
    }
    collected.push("e3", "e4");
    expect(collected).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });
});

describe("normalizeEntries", () => {
  it("de-duplicates by id keeping the first occurrence", () => {
    const first = entry("a", null, "2026-09-29T10:00:00.000Z", "user");
    const shadowed = entry("a", null, "2026-09-29T11:00:00.000Z", "assistant");
    expect(normalizeEntries([first, shadowed])).toEqual([first]);
  });

  it("orders by timestamp then id", () => {
    const later = entry("b", null, "2026-09-29T10:01:00.000Z");
    const sameTimeA = entry("a", null, "2026-09-29T10:01:00.000Z");
    const earlier = entry("c", null, "2026-09-29T10:00:00.000Z");
    expect(normalizeEntries([later, sameTimeA, earlier]).map((e) => e.id)).toEqual(["c", "a", "b"]);
  });
});

describe("readTranscriptEntries", () => {
  it("reads only message entries and skips non-message records", () => {
    const file = tempSessionFile([
      { type: "session_info", id: "h1", parentId: null, timestamp: "2026-09-29T09:59:00.000Z", name: "s" },
      { type: "message", id: "m1", parentId: "h1", timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user", content: "hi" } },
      { type: "model_change", id: "mc", parentId: "m1", timestamp: "2026-09-29T10:01:00.000Z" },
    ]);
    expect(readTranscriptEntries(file).map((e) => e.id)).toEqual(["m1"]);
  });

  it("skips a torn final line instead of failing the read", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-transcript-"));
    tempDirs.push(dir);
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user" } })}\n{"type":"mess`,
      "utf8",
    );
    expect(readTranscriptEntries(file).map((e) => e.id)).toEqual(["m1"]);
  });

  it("filters by entryIds when provided", () => {
    const file = tempSessionFile([
      { type: "message", id: "m1", parentId: null, timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-29T10:01:00.000Z", message: { role: "assistant" } },
    ]);
    const filtered = readTranscriptEntries(file, { entryIds: new Set(["m2"]) });
    expect(filtered.map((e) => e.id)).toEqual(["m2"]);
  });

  it("returns an empty array for a missing file", () => {
    expect(readTranscriptEntries(join(tmpdir(), "definitely-missing-session.jsonl"))).toEqual([]);
  });
});

describe("tool call parent inclusion", () => {
  // A tool call lives in an assistant entry; its result is a separate entry.
  function assistantWithToolCall(id: string, parentId: string | null, timestamp: string, toolCallId: string): TranscriptEntry {
    return {
      id,
      parentId,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }],
      },
    };
  }

  function toolResult(id: string, parentId: string | null, timestamp: string, toolCallId: string): TranscriptEntry {
    return { id, parentId, timestamp, message: { role: "toolResult", toolCallId, toolName: "bash", content: "out" } };
  }

  const call = assistantWithToolCall("a1", null, "2026-09-29T10:00:00.000Z", "call_1");
  const result = toolResult("r1", "a1", "2026-09-29T10:01:00.000Z", "call_1");
  const filler = entry("u2", "r1", "2026-09-29T10:02:00.000Z");

  it("prepends the declaring call when the window starts at the result", () => {
    const page = recentTranscriptWindow([call, result, filler], 2);
    expect(page.entries.map((e) => e.id)).toEqual(["a1", "r1", "u2"]);
  });

  it("keeps the cursor at the chronological boundary, not the prepended parent", () => {
    const page = recentTranscriptWindow([call, result, filler], 2);
    expect(page.olderCursor).toBe(encodeTranscriptCursor(result.timestamp));
  });

  it("does not duplicate a parent already inside the window", () => {
    const page = recentTranscriptWindow([call, result], 10);
    expect(page.entries.map((e) => e.id)).toEqual(["a1", "r1"]);
  });

  it("leaves an orphaned result alone when no parent exists", () => {
    const orphan = toolResult("r9", null, "2026-09-29T10:05:00.000Z", "call_missing");
    const page = recentTranscriptWindow([orphan], 5);
    expect(page.entries.map((e) => e.id)).toEqual(["r9"]);
  });

  it("prepends a parent that sits outside the older-page window", () => {
    const cursor = encodeTranscriptCursor(filler.timestamp);
    const page = olderTranscriptPage([call, result, filler], cursor, 1);
    expect(page.entries.map((e) => e.id)).toEqual(["a1", "r1"]);
  });
});

describe("activeBranchEntryIds", () => {
  it("walks from the leaf back to the root", () => {
    const file = tempSessionFile([
      { type: "message", id: "m1", parentId: null, timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-29T10:01:00.000Z", message: { role: "assistant" } },
      // An abandoned branch: same parent as m2, never extended.
      { type: "message", id: "abandoned", parentId: "m1", timestamp: "2026-09-29T10:02:00.000Z", message: { role: "assistant" } },
      { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-29T10:03:00.000Z", message: { role: "user" } },
    ]);
    expect([...activeBranchEntryIds(file, "m3")!].sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("returns undefined for an unknown leaf so callers can fall back", () => {
    const file = tempSessionFile([
      { type: "message", id: "m1", parentId: null, timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user" } },
    ]);
    expect(activeBranchEntryIds(file, "nope")).toBeUndefined();
    expect(activeBranchEntryIds(file, null)).toBeUndefined();
  });

  it("returns undefined on a parent cycle instead of looping forever", () => {
    const file = tempSessionFile([
      { type: "message", id: "a", parentId: "b", timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user" } },
      { type: "message", id: "b", parentId: "a", timestamp: "2026-09-29T10:01:00.000Z", message: { role: "user" } },
    ]);
    expect(activeBranchEntryIds(file, "a")).toBeUndefined();
  });
});
