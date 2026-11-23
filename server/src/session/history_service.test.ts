/**
 * Plan 86 P1 — the host history service against REAL temporary session buckets.
 *
 * These tests never mock the filesystem: every case writes JSONL transcripts to
 * an OS temp root and points the service's `agentRoot` there. They prove the
 * acceptance boundary that matters for P1:
 *
 *   - list/read work while the workspace Pi is stopped/starting/restarting
 *     (the service has no fleet ops and spawns nothing);
 *   - authorization is derived from the resolved workspace, never from a path;
 *   - cursors/snapshots/body refs are scoped and cross-scope reuse is refused;
 *   - `building` never masquerades as "no history";
 *   - pages fit the 256 KiB encoded frame and always advance;
 *   - body chunks are byte-exact, bounded and identity-checked.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import { HistoryService, type HistoryServiceOptions } from "./history_service.js";
import { HistoryWorkerFailure, createInlineHistoryPort } from "./history_worker_client.js";
import { encodeHistoryBodyRef, fitsHistoryEncodedFrame, parseHistoryReply } from "../protocol/history.js";
import {
  assistantMessage,
  imageBlock,
  makeHistoryFixture,
  textBlock,
  timestampAt,
  toolCallBlock,
  toolResultMessage,
  userMessage,
  writeRawLines,
  writeTranscript,
  type HistoryFixture,
} from "../../test/history_fixtures.js";
import type { HistoryReplyWire } from "../protocol/history.js";

const DAEMON = "aaaa1111";
const OTHER_DAEMON = "bbbb2222";
const SESSION = "s1";
const OTHER_SESSION = "s2";

let fixture: HistoryFixture;

beforeEach(() => {
  fixture = makeHistoryFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function service(options: Partial<HistoryServiceOptions> = {}): HistoryService {
  return new HistoryService({
    resolveWorkspace: (daemonId) =>
      daemonId === DAEMON ? { daemon_id: daemonId, cwd: fixture.cwd, name: "ws" } : null,
    runtime: (daemonId) =>
      daemonId === DAEMON ? { state: "stopped", session_id: null, ready: false } : null,
    agentRoot: fixture.root,
    remoteHome: `${fixture.root}/remote-home`,
    reconcileIntervalMs: 0,
    workerPortFactory: () => createInlineHistoryPort(),
    ...options,
  });
}

const list = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "history_list" as const, id, daemon_id: DAEMON, ...extra });
const read = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "history_read" as const, id, daemon_id: DAEMON, session_id: SESSION, ...extra });

function writeStandardSession(id = SESSION, start = "2026-01-01T00:00:00.000Z", name = "project one") {
  return writeTranscript(fixture.bucket, {
    id,
    cwd: fixture.cwd,
    name,
    start,
    messages: [
      userMessage("u1", "hello"),
      assistantMessage(
        "a1",
        [textBlock("hi there"), toolCallBlock("tc1", "read", { path: "/x", padding: "p".repeat(9000) })],
        { input: 1, output: 2 },
      ),
      toolResultMessage("r1", "tc1", "result text"),
    ],
  });
}

function replyOf(outcome: { reply: HistoryReplyWire }): HistoryReplyWire {
  const parsed = parseHistoryReply(outcome.reply);
  expect(parsed.ok, parsed.ok ? "" : parsed.detail).toBe(true);
  return parsed.ok ? parsed.value : outcome.reply;
}

async function bodyUntil(
  svc: HistoryService,
  request: { type: "history_body"; id: string; daemon_id: string; session_id: string; snapshot: string; body_ref: string; offset_bytes: number },
  timeoutMs = 3000,
): Promise<HistoryReplyWire> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await svc.body(request);
    if (outcome.reply.type !== "history_error" || outcome.reply.code !== "building") {
      return replyOf(outcome);
    }
    if (Date.now() > deadline) throw new Error("history_body stayed building");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function collectBody(
  svc: HistoryService,
  snapshot: string,
  bodyRef: string,
  sessionId = SESSION,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (let guard = 0; guard < 1000; guard += 1) {
    const reply = await bodyUntil(svc, {
      type: "history_body",
      id: `b-${offset}`,
      daemon_id: DAEMON,
      session_id: sessionId,
      snapshot,
      body_ref: bodyRef,
      offset_bytes: offset,
    });
    if (reply.type !== "history_body_ok") throw new Error(`body ${reply.type}`);
    chunks.push(Buffer.from(reply.data, "base64"));
    offset = reply.next_offset_bytes;
    if (offset >= reply.total_bytes) return Buffer.concat(chunks);
  }
  throw new Error("body did not terminate");
}

describe("plan 86 P1 — history_list (real disk, zero spawn)", () => {
  test("lists real sessions newest-first with identity and runtime current", async () => {
    writeStandardSession(OTHER_SESSION, "2026-02-01T00:00:00.000Z", "older");
    writeStandardSession(SESSION, "2026-03-01T00:00:00.000Z", "newer");
    // A file that is not a session must not appear as one.
    writeRawLines(fixture.bucket, "junk.jsonl", ["{}", "not json"]);

    const svc = service();
    try {
      const reply = replyOf(await svc.list(list("L1")));
      expect(reply.type).toBe("history_list_ok");
      if (reply.type !== "history_list_ok") return;
      expect(reply.sessions.map((row) => row.id)).toEqual([SESSION, OTHER_SESSION]);
      expect(reply.sessions[0]!.name).toBe("newer");
      expect(reply.sessions[0]!.preview).toContain("hello");
      expect(typeof reply.revision).toBe("string");
      expect(reply.index_state).toBe("ready");
      expect(reply.current).toEqual({ session_id: null, ready: false, state: "stopped", source: "runtime" });
      expect(reply.next_cursor).toBeNull();
      expect(reply.has_more).toBe(false);
      // No host path ever reaches the wire.
      expect(JSON.stringify(reply)).not.toContain(fixture.bucket);
      expect(JSON.stringify(reply)).not.toContain(fixture.cwd);
    } finally {
      await svc.dispose();
    }
  });

  test("unknown workspace and unknown daemon id are not_found (never a disk scan)", async () => {
    const svc = service();
    try {
      const unknown = replyOf(await svc.list(list("L1", { daemon_id: OTHER_DAEMON })));
      expect(unknown).toMatchObject({ type: "history_error", code: "not_found", daemon_id: OTHER_DAEMON });
    } finally {
      await svc.dispose();
    }
  });

  test("limit is an upper bound, pages use an opaque keyset cursor, cross-scope is refused", async () => {
    writeTranscript(fixture.bucket, {
      id: "old",
      cwd: fixture.cwd,
      start: "2026-01-01T00:00:00.000Z",
      messages: [userMessage("u1", "old")],
    });
    writeTranscript(fixture.bucket, {
      id: "mid",
      cwd: fixture.cwd,
      start: "2026-02-01T00:00:00.000Z",
      messages: [userMessage("u1", "mid")],
    });
    writeTranscript(fixture.bucket, {
      id: "new",
      cwd: fixture.cwd,
      start: "2026-03-01T00:00:00.000Z",
      messages: [userMessage("u1", "new")],
    });

    const svc = service();
    try {
      const first = replyOf(await svc.list(list("L1", { limit: 2 })));
      if (first.type !== "history_list_ok") throw new Error("no list");
      expect(first.sessions.map((row) => row.id)).toEqual(["new", "mid"]);
      expect(first.has_more).toBe(true);
      expect(first.next_cursor).not.toBeNull();

      const second = replyOf(await svc.list(list("L2", { limit: 2, before: first.next_cursor! })));
      if (second.type !== "history_list_ok") throw new Error("no list");
      expect(second.sessions.map((row) => row.id)).toEqual(["old"]);
      expect(second.has_more).toBe(false);
      expect(second.next_cursor).toBeNull();

      // A cursor minted for another workspace must be refused, not mined.
      const forged = replyOf(
        await svc.list(list("L3", { before: Buffer.from("garbage").toString("base64url") })),
      );
      expect(forged).toMatchObject({ type: "history_error", code: "invalid_cursor" });

      const crossScope = replyOf(
        await svc.list(
          list("L4", {
            before: Buffer.from(JSON.stringify({ v: 1, t: "lc", w: OTHER_DAEMON, k: [1, "x"] })).toString("base64url"),
          }),
        ),
      );
      expect(crossScope).toMatchObject({ type: "history_error", code: "invalid_cursor" });
    } finally {
      await svc.dispose();
    }
  });

  test("building is a state, NEVER an empty history answer", async () => {
    for (const [index, id] of ["a", "b", "c"].entries()) {
      writeTranscript(fixture.bucket, {
        id,
        cwd: fixture.cwd,
        start: timestampAt("2026-01-01T00:00:00.000Z", index * 60),
        messages: [userMessage("u1", id)],
      });
    }
    const svc = service({ maxFilesPerScan: 1 });
    try {
      const first = replyOf(await svc.list(list("L1")));
      expect(first.type).toBe("history_list_ok");
      if (first.type !== "history_list_ok") return;
      expect(first.index_state).toBe("building");
      expect(first.sessions).toEqual([]);
      expect(first.revision).toBeNull();
      expect(first.retry_after_ms).toBe(25);
      expect(first.has_more).toBe(false);

      let reply = first;
      for (let attempt = 0; attempt < 10 && reply.type === "history_list_ok" && reply.index_state === "building"; attempt += 1) {
        const next = replyOf(await svc.list(list(`L-retry-${attempt}`)));
        if (next.type !== "history_list_ok") throw new Error("not a list");
        reply = next;
      }
      expect(reply.type).toBe("history_list_ok");
      if (reply.type !== "history_list_ok") return;
      expect(reply.index_state).toBe("ready");
      expect(reply.sessions).toHaveLength(3);
    } finally {
      await svc.dispose();
    }
  });

  test("an unreadable bucket is `unavailable`, not evidence of no history", async () => {
    fs.rmSync(fixture.bucket, { recursive: true, force: true });
    fs.mkdirSync(fixture.bucket, { recursive: true });
    // Replace the bucket DIRECTORY with a file: readdir fails with ENOTDIR.
    fs.rmdirSync(fixture.bucket);
    fs.writeFileSync(fixture.bucket, "not a directory");

    const svc = service();
    try {
      const reply = replyOf(await svc.list(list("L1")));
      expect(reply).toMatchObject({ type: "history_list_ok", index_state: "unavailable", sessions: [], revision: null });
    } finally {
      await svc.dispose();
    }
  });

  test("if_revision matches answer not_modified with the revision echoed", async () => {
    writeStandardSession();
    const svc = service();
    try {
      const first = replyOf(await svc.list(list("L1")));
      if (first.type !== "history_list_ok" || first.revision === null) throw new Error("no list");
      const again = replyOf(await svc.list(list("L2", { if_revision: first.revision })));
      expect(again).toMatchObject({
        type: "history_error",
        code: "not_modified",
        revision: first.revision,
        daemon_id: DAEMON,
      });
    } finally {
      await svc.dispose();
    }
  });

  test("empty workspace reports real zeros and a null cache_hit (not a fake 0)", async () => {
    const svc = service();
    try {
      const outcome = await svc.list(list("L1"));
      const reply = replyOf(outcome);
      expect(reply).toMatchObject({ type: "history_list_ok", sessions: [], index_state: "ready" });
      expect(outcome.metrics.read_bytes).toBe(0);
      expect(outcome.metrics.parsed_entries).toBe(0);
      expect(outcome.metrics.cache_hit).toBeNull();
      expect(typeof outcome.metrics.query_ms).toBe("number");
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P1 — history_read identity, projection and cursors", () => {
  test("items carry stable event/entry identity and the existing event projection", async () => {
    writeStandardSession();
    const svc = service();
    try {
      const outcome = await svc.read(read("R1"));
      const reply = replyOf(outcome);
      if (reply.type !== "history_read_ok") throw new Error(`not read: ${JSON.stringify(reply)}`);
      expect(reply.projection).toBe(1);
      expect(reply.session.id).toBe(SESSION);
      expect(reply.items.map((item) => item.event_id)).toEqual(["u1", "a1#0", "a1#1", "r1"]);
      expect(reply.items.map((item) => item.entry_id)).toEqual(["u1", "a1", "a1", "r1"]);

      const assistant = reply.items.find((item) => item.event_id === "a1#0")!;
      expect(assistant.event.type).toBe("agent_message");
      if (assistant.event.type === "agent_message") {
        expect(assistant.event.in_reply_to).toBe("u1");
        expect(assistant.event.text).toBe("hi there");
        expect(assistant.event.usage).toMatchObject({ input_tokens: 1, output_tokens: 2 });
      }

      const toolRequest = reply.items.find((item) => item.event_id === "a1#1")!;
      if (toolRequest.event.type !== "tool_request") throw new Error("expected tool_request");
      // Oversized args keep identity + a bounded ref; the preview is not the value.
      expect(toolRequest.event.args).toEqual({});
      const argsRef = toolRequest.body_refs?.[0];
      expect(argsRef).toMatchObject({ field: "args", representation: "json_utf8", preview_truncated: true });
      expect(argsRef!.total_bytes).toBeGreaterThan(9000);
      expect(Buffer.byteLength(argsRef!.preview ?? "", "utf8")).toBeLessThanOrEqual(4096);

      expect(reply.snapshot).not.toBeNull();
      expect(reply.revision).toHaveLength(32);
      expect(reply.older_cursor).toBeNull();
      expect(reply.has_older).toBe(false);
      expect(JSON.stringify(reply)).not.toContain(fixture.bucket);
    } finally {
      await svc.dispose();
    }
  });

  test("pages are bounded by transcript ENTRIES, backfill tool parents and advance", async () => {
    writeStandardSession();
    const svc = service();
    try {
      // limit=1 → the newest primary entry is the tool RESULT, whose tool-call
      // parent must be prepended for context.
      const newest = replyOf(await svc.read(read("R1", { limit: 1 })));
      if (newest.type !== "history_read_ok") throw new Error("no read");
      expect(newest.items.map((item) => item.event_id)).toContain("r1");
      const parentItems = newest.items.filter((item) => item.parent === true);
      // The whole declaring entry is backfilled (its text block and its toolCall),
      // exactly like the legacy `withToolCallParents`; de-duplication is by id.
      expect(parentItems.map((item) => item.event_id)).toEqual(["a1#0", "a1#1"]);
      expect(newest.has_older).toBe(true);
      expect(newest.older_cursor).not.toBeNull();

      const older = replyOf(await svc.read(read("R2", { limit: 1, before: newest.older_cursor! })));
      if (older.type !== "history_read_ok") throw new Error("no read");
      expect(older.items.map((item) => item.event_id)).toEqual(["a1#0", "a1#1"]);
      expect(older.has_older).toBe(true);

      const oldest = replyOf(await svc.read(read("R3", { limit: 1, before: older.older_cursor! })));
      if (oldest.type !== "history_read_ok") throw new Error("no read");
      expect(oldest.items.map((item) => item.event_id)).toEqual(["u1"]);
      expect(oldest.has_older).toBe(false);
      expect(oldest.older_cursor).toBeNull();

      // Cross-session cursor is refused, never re-sliced.
      const cross = Buffer.from(
        JSON.stringify({ v: 1, t: "rc", w: DAEMON, s: OTHER_SESSION, g: "x", k: ["2026-03-01T00:00:00.000Z", "e"] }),
      ).toString("base64url");
      expect(replyOf(await svc.read(read("R4", { before: cross })))).toMatchObject({
        type: "history_error",
        code: "invalid_cursor",
      });
    } finally {
      await svc.dispose();
    }
  });

  test("same-timestamp entries are paged by (timestamp, id) keyset — no drop, no duplicate", async () => {
    const sameInstant = "2026-01-01T00:00:10.000Z";
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        { id: "a", timestamp: sameInstant, message: { role: "user", content: "A" } },
        { id: "b", timestamp: sameInstant, message: { role: "user", content: "B" } },
      ],
    });
    const svc = service();
    try {
      const newest = replyOf(await svc.read(read("R1", { limit: 1 })));
      if (newest.type !== "history_read_ok") throw new Error("no read");
      expect(newest.items.map((item) => item.event_id)).toEqual(["b"]);

      const older = replyOf(await svc.read(read("R2", { limit: 1, before: newest.older_cursor! })));
      if (older.type !== "history_read_ok") throw new Error("no read");
      expect(older.items.map((item) => item.event_id)).toEqual(["a"]);
      expect(older.has_older).toBe(false);
    } finally {
      await svc.dispose();
    }
  });

  test("deleted transcripts disappear from the list and are not_found on read", async () => {
    const { file } = writeStandardSession();
    const svc = service();
    try {
      const before = replyOf(await svc.list(list("L1")));
      if (before.type !== "history_list_ok") throw new Error("no list");
      expect(before.sessions).toHaveLength(1);

      fs.rmSync(file);
      const after = replyOf(await svc.list(list("L2")));
      if (after.type !== "history_list_ok") throw new Error("no list");
      expect(after.sessions).toEqual([]);
      expect(after.revision).not.toBe(before.revision);

      expect(replyOf(await svc.read(read("R1")))).toMatchObject({ type: "history_error", code: "not_found" });
    } finally {
      await svc.dispose();
    }
  });

  test("unknown session / unknown workspace are typed not_found", async () => {
    writeStandardSession();
    const svc = service();
    try {
      expect(replyOf(await svc.read(read("R1", { session_id: "nope" })))).toMatchObject({
        type: "history_error",
        code: "not_found",
      });
      expect(replyOf(await svc.read(read("R2", { daemon_id: OTHER_DAEMON })))).toMatchObject({
        type: "history_error",
        code: "not_found",
        daemon_id: OTHER_DAEMON,
      });
    } finally {
      await svc.dispose();
    }
  });

  test("read while the metadata scan is building answers building, not not_found", async () => {
    // Two files, one parse per scan: the alphabetically-first file is parsed
    // first, so a read for the OTHER session cannot know it is absent yet.
    writeTranscript(fixture.bucket, {
      id: "aaa",
      cwd: fixture.cwd,
      start: "2026-01-01T00:00:00.000Z",
      messages: [userMessage("u1", "first")],
    });
    writeTranscript(fixture.bucket, {
      id: "zzz",
      cwd: fixture.cwd,
      start: "2026-02-01T00:00:00.000Z",
      messages: [userMessage("u1", "second")],
    });
    const svc = service({ maxFilesPerScan: 1 });
    try {
      const first = replyOf(await svc.read(read("R1", { session_id: "zzz" })));
      expect(first).toMatchObject({ type: "history_error", code: "building", retry_after_ms: 25, session_id: "zzz" });

      let reply: HistoryReplyWire = first;
      for (let attempt = 0; attempt < 10 && reply.type === "history_error" && reply.code === "building"; attempt += 1) {
        reply = replyOf(await svc.read(read(`R-retry-${attempt}`, { session_id: "zzz" })));
      }
      expect(reply.type).toBe("history_read_ok");
      if (reply.type === "history_read_ok") expect(reply.session.id).toBe("zzz");
    } finally {
      await svc.dispose();
    }
  });

  test("if_revision on read answers not_modified", async () => {
    writeStandardSession();
    const svc = service();
    try {
      const first = replyOf(await svc.read(read("R1")));
      if (first.type !== "history_read_ok") throw new Error("no read");
      const again = replyOf(await svc.read(read("R2", { if_revision: first.revision })));
      expect(again).toMatchObject({ type: "history_error", code: "not_modified", revision: first.revision });
    } finally {
      await svc.dispose();
    }
  });

  test("corrupt JSONL lines are skipped, never fabricated; torn tails stay out", async () => {
    const { file } = writeStandardSession();
    fs.appendFileSync(file, "{\"type\":\"message\",\"id\":\"torn\""); // no newline
    const svc = service();
    try {
      const clean = replyOf(await svc.read(read("R1")));
      if (clean.type !== "history_read_ok") throw new Error("no read");
      expect(clean.items.map((item) => item.event_id)).toEqual(["u1", "a1#0", "a1#1", "r1"]);

      fs.appendFileSync(file, "\n{ this is not json }\n");
      const stillClean = replyOf(await svc.read(read("R2")));
      if (stillClean.type !== "history_read_ok") throw new Error("no read");
      expect(stillClean.items.map((item) => item.event_id)).toEqual(["u1", "a1#0", "a1#1", "r1"]);
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P1 — history_body bytes, chunking and staleness", () => {
  test("text / json / binary bodies reassemble byte-exactly across 64 KiB chunks", async () => {
    const bigText = "line-αβγ-".repeat(4000); // >100 KiB of UTF-8
    const image = Buffer.alloc(5000);
    for (let index = 0; index < image.length; index += 1) image[index] = index % 251;
    const imageBase64 = image.toString("base64");

    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        {
          id: "u1",
          message: { role: "user", content: [{ type: "text", text: bigText }, imageBlock(imageBase64, "image/png")] },
        },
      ],
    });

    const svc = service({ chunkBytes: 4096 });
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const item = readReply.items[0]!;
      if (item.event.type !== "user_input") throw new Error("not user input");
      const textRef = item.body_refs?.find((ref) => ref.field === "text")!;
      const imageRef = item.body_refs?.find((ref) => ref.field === "images.0")!;
      expect(textRef.representation).toBe("text_utf8");
      expect(textRef.total_bytes).toBe(Buffer.byteLength(bigText, "utf8"));
      expect(item.event.text.length).toBeLessThan(bigText.length); // bounded preview
      expect(imageRef.representation).toBe("binary");
      expect(imageRef.mime).toBe("image/png");
      expect(imageRef.total_bytes).toBe(image.length);

      const textBytes = await collectBody(svc, readReply.snapshot, textRef.ref);
      expect(textBytes.toString("utf8")).toBe(bigText);
      const imageBytes = await collectBody(svc, readReply.snapshot, imageRef.ref);
      expect(Buffer.compare(imageBytes, image)).toBe(0);

      // Chunking is bounded by the requested chunk size on every hop.
      const firstChunk = await bodyUntil(svc, {
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: readReply.snapshot,
        body_ref: textRef.ref,
        offset_bytes: 0,
      });
      if (firstChunk.type !== "history_body_ok") throw new Error("no body");
      expect(firstChunk.next_offset_bytes - firstChunk.offset_bytes).toBe(4096);
    } finally {
      await svc.dispose();
    }
  });

  test("a multi-byte character split across the 64 KiB chunk boundary reassembles with a stateful decoder", async () => {
    // 3-byte code points: 65536 is NOT a multiple of 3, so the default chunk
    // boundary lands INSIDE a character. The client contract requires a
    // stateful UTF-8 decoder; the bytes themselves must be exact.
    const text = "€".repeat(30_000); // 90 000 bytes
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", text)],
    });
    const svc = service(); // default 64 KiB chunks
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;
      expect(ref.total_bytes).toBe(90_000);
      const bytes = await collectBody(svc, readReply.snapshot, ref.ref);
      expect(bytes.toString("utf8")).toBe(text);

      // Stateful decoding across the split preserves the character; decoding
      // each chunk independently does not — which is exactly why the contract
      // requires a streaming decoder rather than per-chunk toString().
      const streaming = new TextDecoder("utf-8", { fatal: true });
      const joined =
        streaming.decode(bytes.subarray(0, 65_536), { stream: true }) +
        streaming.decode(bytes.subarray(65_536), { stream: true });
      expect(joined).toBe(text);
      const independent = new TextDecoder("utf-8");
      const naive =
        independent.decode(bytes.subarray(0, 65_536)) + independent.decode(bytes.subarray(65_536));
      expect(naive).not.toBe(text);
    } finally {
      await svc.dispose();
    }
  });

  test("tool results and compaction summaries use text_utf8 refs; oversized image bytes are cleared from the event", async () => {
    const bigResult = "r".repeat(9000);
    const summary = "s".repeat(6000);
    const image = Buffer.alloc(5000, 7);
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        { id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }, imageBlock(image.toString("base64"), "image/jpeg")] } },
        assistantMessage("a1", [toolCallBlock("tc1", "read", {})]),
        toolResultMessage("r1", "tc1", bigResult),
        { id: "c1", message: { role: "compaction", content: summary, tokensBefore: 42 } },
      ],
    });
    const svc = service();
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");

      const user = readReply.items.find((item) => item.event_id === "u1")!;
      if (user.event.type !== "user_input") throw new Error("not user");
      expect(user.event.images?.[0]?.data).toBe("");
      const imageRef = user.body_refs?.find((ref) => ref.field === "images.0")!;
      expect(imageRef).toMatchObject({ representation: "binary", mime: "image/jpeg", preview_truncated: true });
      expect(Buffer.byteLength(imageRef.preview ?? "", "utf8")).toBeLessThanOrEqual(4096);
      expect(Buffer.compare(await collectBody(svc, readReply.snapshot, imageRef.ref), image)).toBe(0);

      const result = readReply.items.find((item) => item.event_id === "r1")!;
      if (result.event.type !== "tool_result") throw new Error("not result");
      expect(String(result.event.result).length).toBeLessThan(bigResult.length);
      const resultRef = result.body_refs?.[0]!;
      expect(resultRef.representation).toBe("text_utf8");
      expect((await collectBody(svc, readReply.snapshot, resultRef.ref)).toString("utf8")).toBe(bigResult);

      const compaction = readReply.items.find((item) => item.event_id === "c1")!;
      if (compaction.event.type !== "compaction") throw new Error("not compaction");
      expect(compaction.event.summary.length).toBeLessThan(summary.length);
      const summaryRef = compaction.body_refs?.[0]!;
      expect((await collectBody(svc, readReply.snapshot, summaryRef.ref)).toString("utf8")).toBe(summary);
    } finally {
      await svc.dispose();
    }
  });

  test("a valid-scope token for an unknown field is unsupported, not a crash", async () => {
    writeStandardSession();
    const svc = service();
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      // Mint a structurally valid, correctly-scoped ref for a field this host
      // cannot represent. It cannot be produced by the host itself.
      const bogus = encodeHistoryBodyRef(DAEMON, SESSION, {
        generation: JSON.parse(Buffer.from(readReply.snapshot, "base64url").toString("utf8")).g,
        entry_id: "u1",
        event_id: "u1",
        field: "bogus",
        representation: "text_utf8",
        mime: null,
        total_bytes: 3,
        digest: "0".repeat(64),
      });
      const reply = replyOf(
        await svc.body({
          type: "history_body",
          id: "B1",
          daemon_id: DAEMON,
          session_id: SESSION,
          snapshot: readReply.snapshot,
          body_ref: bogus,
          offset_bytes: 0,
        }),
      );
      expect(reply).toMatchObject({ type: "history_error", code: "unsupported" });
    } finally {
      await svc.dispose();
    }
  });

  test("tool args materialize as the complete valid JSON value", async () => {
    const args = { path: "/x", nested: { a: [1, 2, 3] }, text: "é".repeat(3000) };
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [assistantMessage("a1", [toolCallBlock("tc1", "read", args)])],
    });
    const svc = service();
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;
      expect(ref.representation).toBe("json_utf8");
      const bytes = await collectBody(svc, readReply.snapshot, ref.ref);
      expect(JSON.parse(bytes.toString("utf8"))).toEqual(args);
      expect(bytes.toString("utf8")).toBe(JSON.stringify(args));
    } finally {
      await svc.dispose();
    }
  });

  test("first materialization of a large body answers building, never an empty body", async () => {
    const bigText = "x".repeat(200_000);
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", bigText)],
    });
    const svc = service({ bodyEagerMaxBytes: 0 });
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;
      const first = await svc.body({
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: readReply.snapshot,
        body_ref: ref.ref,
        offset_bytes: 0,
      });
      expect(first.reply).toMatchObject({
        type: "history_error",
        code: "building",
        retry_after_ms: 25,
        session_id: SESSION,
      });
      const bytes = await collectBody(svc, readReply.snapshot, ref.ref);
      expect(bytes.toString("utf8")).toBe(bigText);
    } finally {
      await svc.dispose();
    }
  });

  test("offset bounds, body budget and snapshot tampering are typed", async () => {
    const bigText = "y".repeat(20_000);
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", bigText)],
    });
    const svc = service({ bodyMaxBytes: 10_000 });
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;

      const request = (extra: Record<string, unknown>) =>
        ({ type: "history_body" as const, id: "B", daemon_id: DAEMON, session_id: SESSION, snapshot: readReply.snapshot, body_ref: ref.ref, offset_bytes: 0, ...extra });

      expect(replyOf(await svc.body(request({ offset_bytes: ref.total_bytes + 1 })))).toMatchObject({
        type: "history_error",
        code: "invalid_request",
      });
      expect(replyOf(await svc.body(request({})))).toMatchObject({
        type: "history_error",
        code: "body_too_large",
      });
      expect(replyOf(await svc.body(request({ snapshot: "not-a-token" })))).toMatchObject({
        type: "history_error",
        code: "invalid_cursor",
      });
      // A snapshot minted for ANOTHER session must not address this one.
      const cross = Buffer.from(
        JSON.stringify({ v: 1, t: "sn", w: DAEMON, s: OTHER_SESSION, g: "g", hw: 0 }),
      ).toString("base64url");
      expect(replyOf(await svc.body(request({ snapshot: cross })))).toMatchObject({
        type: "history_error",
        code: "invalid_cursor",
      });
    } finally {
      await svc.dispose();
    }
  });

  test("rewritten content with the same generation is caught by the digest (stale)", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "A".repeat(10_000))],
    });
    const svc = service();
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;

      // Same size, same inode/birthtime: only the digest can notice.
      const rewritten = fs.readFileSync(file, "utf8").replace("A".repeat(10_000), "B".repeat(10_000));
      fs.writeFileSync(file, rewritten);
      const reply = await svc.body({
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: readReply.snapshot,
        body_ref: ref.ref,
        offset_bytes: 0,
      });
      expect(replyOf(reply)).toMatchObject({ type: "history_error", code: "stale" });
    } finally {
      await svc.dispose();
    }
  });

  test("a failed background materialization reports the error instead of building forever", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "A".repeat(10_000))],
    });
    // Every body is "large" here, so materialization is asynchronous.
    const svc = service({ bodyEagerMaxBytes: 0 });
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;
      const rewritten = fs.readFileSync(file, "utf8").replace("A".repeat(10_000), "B".repeat(10_000));
      fs.writeFileSync(file, rewritten);

      let last: HistoryReplyWire | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const outcome = await svc.body({
          type: "history_body",
          id: `B-${attempt}`,
          daemon_id: DAEMON,
          session_id: SESSION,
          snapshot: readReply.snapshot,
          body_ref: ref.ref,
          offset_bytes: 0,
        });
        last = replyOf(outcome);
        if (last.type !== "history_error" || last.code !== "building") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(last).toMatchObject({ type: "history_error", code: "stale" });
    } finally {
      await svc.dispose();
    }
  });

  test("a truncated file invalidates an old snapshot (stale)", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "Z".repeat(10_000))],
    });
    const svc = service();
    try {
      const readReply = replyOf(await svc.read(read("R1")));
      if (readReply.type !== "history_read_ok") throw new Error("no read");
      const ref = readReply.items[0]!.body_refs?.[0]!;

      const headerOnly = fs.readFileSync(file, "utf8").split("\n")[0]! + "\n";
      fs.writeFileSync(file, headerOnly);
      const reply = await svc.body({
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: readReply.snapshot,
        body_ref: ref.ref,
        offset_bytes: 0,
      });
      expect(replyOf(reply)).toMatchObject({ type: "history_error", code: "stale" });

      // Deleting the transcript must also invalidate the old snapshot.
      fs.rmSync(file);
      const deleted = replyOf(
        await svc.body({
          type: "history_body",
          id: "B2",
          daemon_id: DAEMON,
          session_id: SESSION,
          snapshot: readReply.snapshot,
          body_ref: ref.ref,
          offset_bytes: 0,
        }),
      );
      expect(deleted).toMatchObject({ type: "history_error", code: "stale" });
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P1 — bounded frames and metrics", () => {
  test("a 60-giant-entry page is trimmed to fit 256 KiB and still advances", async () => {
    const messages = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(userMessage(`u${index}`, `entry-${index}-` + "q".repeat(5000)));
    }
    writeTranscript(fixture.bucket, { id: SESSION, cwd: fixture.cwd, messages });

    const svc = service();
    try {
      const first = replyOf(await svc.read(read("R1", { limit: 60 })));
      if (first.type !== "history_read_ok") throw new Error("no read");
      expect(first.items.length).toBeLessThan(60);
      expect(first.has_older).toBe(true);
      expect(first.older_cursor).not.toBeNull();
      expect(fitsHistoryEncodedFrame(first)).toBe(true);
      expect(JSON.stringify(first).length).toBeGreaterThan(0);

      const second = replyOf(await svc.read(read("R2", { limit: 60, before: first.older_cursor! })));
      if (second.type !== "history_read_ok") throw new Error("no read");
      const firstIds = new Set(first.items.map((item) => item.event_id));
      for (const item of second.items) expect(firstIds.has(item.event_id)).toBe(false);
      expect(second.items.length).toBeGreaterThan(0);
      expect(fitsHistoryEncodedFrame(second)).toBe(true);
    } finally {
      await svc.dispose();
    }
  });

  test("metrics use P0 names, real counts, and cache hits are observable", async () => {
    writeStandardSession();
    const svc = service();
    try {
      const cold = await svc.list(list("L1"));
      expect(cold.metrics.worker_mode).toBe("inline");
      expect(cold.metrics.query_ms).toBeGreaterThanOrEqual(0);
      expect(cold.metrics.read_bytes).toBeGreaterThan(0);
      expect(cold.metrics.parsed_entries).toBeGreaterThan(0);
      expect(cold.metrics.cache_hit).toBe(false);

      const warm = await svc.list(list("L2"));
      expect(warm.metrics.read_bytes).toBe(0);
      expect(warm.metrics.parsed_entries).toBe(0);
      expect(warm.metrics.cache_hit).toBe(true);
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P1 — the read domain stays SDK-free", () => {
  test("no history module imports the Pi SDK", () => {
    const here = new URL(".", import.meta.url);
    const files = [
      "history_service.ts",
      "history_index.ts",
      "history_build.ts",
      "history_body_store.ts",
      "history_utf8.ts",
      "history_tokenizer.ts",
      "history_worker.ts",
      "history_worker_main.ts",
      "history_worker_client.ts",
      "history_format.ts",
      "session_paths.ts",
      "session_reader.ts",
      "transcript.ts",
      "../protocol/history.ts",
      "../protocol/types.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(new URL(file, here), "utf8");
      // Import/require specifiers only: prose comments may name the SDK, the
      // module graph must not load it.
      expect(source, file).not.toMatch(/(?:from\s+|require\()\s*["'][^"']*(?:@earendil-works|pi-coding-agent|pi-tui)/);
    }
  });
});

describe("plan 86 P1 — worker ownership and failure cleanup", () => {
  test("a transport failure is typed, the service stays alive, and the next request recovers", async () => {
    writeStandardSession();
    let created = 0;
    const svc = service({
      workerPortFactory: () => {
        created += 1;
        if (created === 1) throw new Error("cannot spawn");
        return createInlineHistoryPort();
      },
    });
    try {
      const broken = replyOf(await svc.list(list("L1")));
      expect(broken).toMatchObject({ type: "history_error", code: "internal" });
      const recovered = replyOf(await svc.list(list("L2")));
      expect(recovered.type).toBe("history_list_ok");
      // Two roles are created lazily (reader for the query, writer for the
      // cold build), so recovery legitimately recreates more than one port.
      expect(created).toBeGreaterThanOrEqual(2);
    } finally {
      await svc.dispose();
    }
  });

  test("dispose terminates the worker and refuses further work", async () => {
    writeStandardSession();
    let terminated = 0;
    const svc = service({
      workerPortFactory: () => {
        const port = createInlineHistoryPort();
        return {
          ...port,
          terminate: async () => {
            terminated += 1;
            await port.terminate();
            return 0;
          },
        };
      },
    });
    await svc.list(list("L1"));
    await svc.dispose();
    // One port per role (writer + reader) is terminated on shutdown.
    expect(terminated).toBeGreaterThanOrEqual(1);
    const after = replyOf(await svc.list(list("L2")));
    expect(after).toMatchObject({ type: "history_error", code: "internal" });
  });

  test("worker failure code is typed (HistoryWorkerFailure) and does not leak host text", () => {
    const failure = new HistoryWorkerFailure("worker_timeout");
    expect(failure.code).toBe("worker_timeout");
    expect(failure.message).toBe("worker_timeout");
  });
});

test("concurrent service shutdown callers both wait for all role retirements", async () => {
  const exits: (() => void)[] = [];
  const svc = service({ workerPortFactory: () => {
    const port = createInlineHistoryPort();
    return { ...port, terminate: async () => {
      await new Promise<void>(resolve => { exits.push(resolve); });
      await port.terminate();
      return 0;
    } };
  } });
  try {
    const first = svc.dispose();
    const second = svc.dispose();
    expect(second).toBe(first);
    let ended = false;
    void second.then(() => { ended = true; });
    for (let n = 0; exits.length < 2 && n < 30; n++) await Promise.resolve();
    expect(exits).toHaveLength(2);
    expect(ended).toBe(false);
    exits[0]!();
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(ended).toBe(false);
    exits[1]!();
    await Promise.all([first, second]);
    expect(ended).toBe(true);
    expect(svc.dispose()).toBe(first);
  } finally { for (const exit of exits) exit(); await svc.dispose(); }
});
