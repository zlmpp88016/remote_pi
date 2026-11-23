/**
 * Plan 86 P1 — the shared `history_*` contract as a RUNTIME contract.
 *
 * These tests are the executable version of the export/schema summary handed to
 * Web/App: limits, typed request/reply guards, opaque-token scope rules and the
 * 256 KiB frame ceiling. They use no filesystem and no host: if a client can
 * import these exports, it can validate exactly what the host sends.
 */

import { describe, expect, test } from "vitest";
import {
  HISTORY_BODY_CHUNK_BYTES,
  HISTORY_LIST_DEFAULT_LIMIT,
  HISTORY_LIST_MAX_LIMIT,
  HISTORY_MAX_ENCODED_FRAME_BYTES,
  HISTORY_READ_DEFAULT_LIMIT,
  HISTORY_READ_MAX_LIMIT,
  HISTORY_ROW_PREVIEW_BYTES,
  clampHistoryListLimit,
  clampHistoryReadLimit,
  decodeHistoryBodyRef,
  decodeHistoryListCursor,
  decodeHistoryReadCursor,
  decodeHistorySnapshot,
  encodeHistoryBodyRef,
  encodeHistoryListCursor,
  encodeHistoryReadCursor,
  encodeHistorySnapshot,
  encodedHostFrameBytes,
  fitsHistoryEncodedFrame,
  historyErrorReply,
  isHistoryRequestType,
  parseHistoryReply,
  parseHistoryRequest,
  parseSessionHistoryEvent,
  utf8Preview,
} from "../protocol/history.js";
import type { HistoryBodyOkWire, HistoryErrorWire, HistoryListOkWire, HistoryReadOkWire } from "../protocol/types.js";

const DAEMON = "aaaa1111";
const OTHER_DAEMON = "bbbb2222";
const SESSION = "s1";
const OTHER_SESSION = "s2";
const DIGEST = "0".repeat(64);

function listOk(overrides: Partial<HistoryListOkWire> = {}): HistoryListOkWire {
  return {
    type: "history_list_ok",
    in_reply_to: "q1",
    daemon_id: DAEMON,
    revision: "rev-1",
    index_state: "ready",
    current: { session_id: null, ready: null, state: "stopped", source: "runtime" },
    sessions: [{ id: SESSION, name: null, mtime: 1, preview: "hi" }],
    next_cursor: null,
    has_more: false,
    retry_after_ms: null,
    ...overrides,
  };
}

function readOk(overrides: Partial<HistoryReadOkWire> = {}): HistoryReadOkWire {
  return {
    type: "history_read_ok",
    in_reply_to: "q2",
    daemon_id: DAEMON,
    session_id: SESSION,
    snapshot: "snapshot-token",
    revision: "rev-1",
    projection: 1,
    session: { id: SESSION, name: null, mtime: 1, preview: null },
    items: [
      {
        event_id: "u1",
        entry_id: "u1",
        event: { ts: 1, type: "user_input", id: "u1", text: "hello" },
      },
      {
        event_id: "a1#0",
        entry_id: "a1",
        event: { ts: 2, type: "agent_message", in_reply_to: "u1", text: "hi" },
        body_refs: [
          {
            ref: "ref-token",
            field: "text",
            representation: "text_utf8",
            mime: null,
            total_bytes: 9000,
            preview: null,
            preview_truncated: true,
          },
        ],
      },
    ],
    older_cursor: null,
    has_older: false,
    ...overrides,
  };
}

function bodyOk(overrides: Partial<HistoryBodyOkWire> = {}): HistoryBodyOkWire {
  return {
    type: "history_body_ok",
    in_reply_to: "q3",
    daemon_id: DAEMON,
    session_id: SESSION,
    snapshot: "snapshot-token",
    body_ref: "ref-token",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 0,
    next_offset_bytes: 3,
    total_bytes: 10,
    data: Buffer.from("abc").toString("base64"),
    ...overrides,
  };
}

function errorReply(overrides: Partial<HistoryErrorWire> = {}): HistoryErrorWire {
  return {
    type: "history_error",
    in_reply_to: "q4",
    code: "stale",
    daemon_id: DAEMON,
    session_id: SESSION,
    revision: null,
    snapshot: null,
    retry_after_ms: null,
    ...overrides,
  };
}

describe("plan 86 P1 — limits", () => {
  test("defaults and hard upper bounds match the plan", () => {
    expect(HISTORY_LIST_DEFAULT_LIMIT).toBe(50);
    expect(HISTORY_LIST_MAX_LIMIT).toBe(100);
    expect(HISTORY_READ_DEFAULT_LIMIT).toBe(30);
    expect(HISTORY_READ_MAX_LIMIT).toBe(100);
    expect(HISTORY_BODY_CHUNK_BYTES).toBe(64 * 1024);
    expect(HISTORY_ROW_PREVIEW_BYTES).toBe(4 * 1024);
    expect(HISTORY_MAX_ENCODED_FRAME_BYTES).toBe(256 * 1024);
  });

  test("limits are CLAMPED, never rejected, so a client asking for 1000 gets 100", () => {
    expect(clampHistoryListLimit(undefined)).toBe(50);
    expect(clampHistoryListLimit(1000)).toBe(100);
    expect(clampHistoryListLimit(0)).toBe(1);
    expect(clampHistoryListLimit(Number.NaN)).toBe(50);
    expect(clampHistoryReadLimit(undefined)).toBe(30);
    expect(clampHistoryReadLimit(500)).toBe(100);
  });
});

describe("plan 86 P1 — typed request guards", () => {
  test("happy path for all three requests", () => {
    const list = parseHistoryRequest({ type: "history_list", id: "1", daemon_id: DAEMON, limit: 1000, before: "c", if_revision: "r" });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.type).toBe("history_list");
      // limit is preserved for clamping downstream, not rewritten by the guard.
      expect(list.value.limit).toBe(1000);
    }

    const read = parseHistoryRequest({
      type: "history_read",
      id: "2",
      daemon_id: DAEMON,
      session_id: SESSION,
      limit: 30,
      before: "c",
      snapshot: "s",
      if_revision: "r",
    });
    expect(read.ok).toBe(true);

    const body = parseHistoryRequest({
      type: "history_body",
      id: "3",
      daemon_id: DAEMON,
      session_id: SESSION,
      snapshot: "s",
      body_ref: "b",
      offset_bytes: 0,
    });
    expect(body.ok).toBe(true);
  });

  test("rejects malformed/out-of-range members", () => {
    const cases: unknown[] = [
      null,
      [],
      {},
      { type: "history_nope", id: "1", daemon_id: DAEMON },
      { type: "history_list" },
      { type: "history_list", id: "", daemon_id: DAEMON },
      { type: "history_list", id: "1", daemon_id: "" },
      { type: "history_list", id: "1", daemon_id: DAEMON, limit: 1.5 },
      { type: "history_list", id: "1", daemon_id: DAEMON, limit: -1 },
      { type: "history_list", id: "1", daemon_id: DAEMON, before: 42 },
      { type: "history_read", id: "1", daemon_id: DAEMON },
      { type: "history_read", id: "1", daemon_id: DAEMON, session_id: "" },
      { type: "history_body", id: "1", daemon_id: DAEMON, session_id: SESSION, snapshot: "s", body_ref: "b", offset_bytes: 1.5 },
      { type: "history_body", id: "1", daemon_id: DAEMON, session_id: SESSION, snapshot: "s", body_ref: "", offset_bytes: 0 },
    ];
    for (const value of cases) {
      const parsed = parseHistoryRequest(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("invalid_request");
    }
    expect(isHistoryRequestType("history_list")).toBe(true);
    expect(isHistoryRequestType("session_list")).toBe(false);
  });
});

describe("plan 86 P1 — typed reply guards", () => {
  test("accepts every happy reply", () => {
    for (const reply of [listOk(), readOk(), bodyOk(), errorReply()]) {
      const parsed = parseHistoryReply(reply);
      expect(parsed.ok).toBe(true);
    }
  });

  test("recognizes all required error codes", () => {
    const codes = [
      "building",
      "stale",
      "not_modified",
      "unsupported",
      "not_found",
      "invalid_cursor",
      "body_too_large",
      "invalid_request",
      "internal",
    ] as const;
    for (const code of codes) {
      const parsed = parseHistoryReply(errorReply({ code }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.value.type === "history_error") expect(parsed.value.code).toBe(code);
    }
    expect(parseHistoryReply(errorReply({ code: "nope" as never })).ok).toBe(false);
  });

  test("rejects a body chunk whose decoded length disagrees with the offsets", () => {
    const parsed = parseHistoryReply(bodyOk({ next_offset_bytes: 5 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toMatch(/data length/);
    expect(parseHistoryReply(bodyOk({ offset_bytes: 4, next_offset_bytes: 3, total_bytes: 10 })).ok).toBe(false);
    expect(parseHistoryReply(bodyOk({ next_offset_bytes: 11, total_bytes: 10 })).ok).toBe(false);
    expect(parseHistoryReply(bodyOk({ data: "not base64!" })).ok).toBe(false);
  });

  test("rejects oversized chunks and unknown item shapes", () => {
    const oversized = Buffer.alloc(HISTORY_BODY_CHUNK_BYTES + 1).toString("base64");
    expect(
      parseHistoryReply(
        bodyOk({ offset_bytes: 0, next_offset_bytes: HISTORY_BODY_CHUNK_BYTES + 1, total_bytes: HISTORY_BODY_CHUNK_BYTES + 1, data: oversized }),
      ).ok,
    ).toBe(false);

    const badItem = readOk();
    (badItem.items[0]!.event as unknown as Record<string, unknown>)["type"] = "invented";
    expect(parseHistoryReply(badItem).ok).toBe(false);
  });

  test("parses the existing event projection independently", () => {
    expect(parseSessionHistoryEvent({ ts: 1, type: "user_input", id: "u", text: "t" }).ok).toBe(true);
    expect(
      parseSessionHistoryEvent({ ts: 1, type: "tool_request", tool_call_id: "t", tool: "x", args: {} }).ok,
    ).toBe(true);
    expect(
      parseSessionHistoryEvent({ ts: 1, type: "tool_result", tool_call_id: "t", result: "r" }).ok,
    ).toBe(true);
    expect(
      parseSessionHistoryEvent({ ts: 1, type: "agent_message", in_reply_to: "u", text: "t" }).ok,
    ).toBe(true);
    expect(parseSessionHistoryEvent({ ts: 1, type: "compaction", summary: "s", tokens_before: 1 }).ok).toBe(true);
    expect(parseSessionHistoryEvent({ ts: 1, type: "nope" }).ok).toBe(false);
  });
});

describe("plan 86 P1 — opaque token scope", () => {
  test("list cursor round-trips and refuses another workspace", () => {
    const cursor = encodeHistoryListCursor(DAEMON, { mtime: 123, id: "s9" });
    const good = decodeHistoryListCursor(cursor, { daemon_id: DAEMON });
    expect(good.ok && good.before).toEqual({ mtime: 123, id: "s9" });
    const cross = decodeHistoryListCursor(cursor, { daemon_id: OTHER_DAEMON });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe("invalid_cursor");
    expect(decodeHistoryListCursor("garbage!!", { daemon_id: DAEMON }).ok).toBe(false);
    // A padded base64 spelling is not canonical and must be refused.
    const padded = Buffer.from(JSON.stringify({ v: 1, t: "lc", w: DAEMON, k: [1, "a"] })).toString("base64");
    if (padded.endsWith("=")) expect(decodeHistoryListCursor(padded, { daemon_id: DAEMON }).ok).toBe(false);
  });

  test("read cursor round-trips and refuses another session/workspace", () => {
    const cursor = encodeHistoryReadCursor(DAEMON, SESSION, "gen-1", {
      before: { timestamp: "t", id: "e" },
    });
    const good = decodeHistoryReadCursor(cursor, { daemon_id: DAEMON, session_id: SESSION });
    expect(good.ok).toBe(true);
    if (good.ok) {
      // ENTRY form: an exclusive boundary, no resume position.
      expect(good.value.before).toEqual({ timestamp: "t", id: "e" });
      expect(good.value.generation).toBe("gen-1");
      expect(good.value.anchor).toBeNull();
      expect(good.value.delivered_items).toBeNull();
      expect(good.value.delivered_refs).toBeNull();
      expect(good.value.high_water).toBeNull();
    }
    const crossSession = decodeHistoryReadCursor(cursor, { daemon_id: DAEMON, session_id: OTHER_SESSION });
    expect(crossSession.ok).toBe(false);
    if (!crossSession.ok) expect(crossSession.code).toBe("invalid_cursor");
    const crossWorkspace = decodeHistoryReadCursor(cursor, { daemon_id: OTHER_DAEMON, session_id: SESSION });
    expect(crossWorkspace.ok).toBe(false);
  });

  /*
   * R4/R5 — the cursor is a POSITION in a page sequence: it may resume inside a
   * pinned entry window (item index + refs of that item already shipped) and it
   * carries the fixed byte high-water of the sequence. Both extensions are
   * additive, so an older host's cursor still decodes as an entry boundary.
   */
  test("read cursor carries a mid-entry resume position and the fixed high-water", () => {
    const cursor = encodeHistoryReadCursor(DAEMON, SESSION, "gen-2", {
      anchor: { timestamp: "t9", id: "giant" },
      window_limit: 30,
      delivered_items: 3,
      delivered_refs: 16,
      high_water: 4096,
    });
    const decoded = decodeHistoryReadCursor(cursor, { daemon_id: DAEMON, session_id: SESSION });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({
      before: null,
      generation: "gen-2",
      high_water: 4096,
      anchor: { timestamp: "t9", id: "giant" },
      window_limit: 30,
      delivered_items: 3,
      delivered_refs: 16,
    });
    // Scope still applies, and the resume form is not accepted for another session.
    expect(decodeHistoryReadCursor(cursor, { daemon_id: DAEMON, session_id: OTHER_SESSION }).ok).toBe(false);
    // The two forms are mutually exclusive: a token carrying BOTH is refused.
    const both = Buffer.from(
      JSON.stringify({
        v: 1,
        t: "rc",
        w: DAEMON,
        s: SESSION,
        g: "gen-2",
        k: ["t", "e"],
        q: ["t9", "giant"],
        n: 30,
        a: 0,
        r: 0,
      }),
    ).toString("base64url");
    expect(decodeHistoryReadCursor(both, { daemon_id: DAEMON, session_id: SESSION }).ok).toBe(false);
    // A resume position without a window size is malformed, not defaulted.
    const noWindow = Buffer.from(
      JSON.stringify({ v: 1, t: "rc", w: DAEMON, s: SESSION, g: "gen-2", q: ["t9", "giant"], a: 0, r: 0 }),
    ).toString("base64url");
    expect(decodeHistoryReadCursor(noWindow, { daemon_id: DAEMON, session_id: SESSION }).ok).toBe(false);
  });

  test("snapshot is scoped, versioned and carries the high-water", () => {
    const token = encodeHistorySnapshot(DAEMON, SESSION, "gen-1", 4096);
    const good = decodeHistorySnapshot(token, { daemon_id: DAEMON, session_id: SESSION });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toEqual({ generation: "gen-1", high_water: 4096 });
    expect(decodeHistorySnapshot(token, { daemon_id: DAEMON, session_id: OTHER_SESSION }).ok).toBe(false);
    expect(decodeHistorySnapshot(token, { daemon_id: OTHER_DAEMON, session_id: SESSION }).ok).toBe(false);
  });

  test("body ref round-trips; tampered digests/representations are refused", () => {
    const token = encodeHistoryBodyRef(DAEMON, SESSION, {
      generation: "gen-1",
      entry_id: "e1",
      event_id: "e1#0",
      field: "args",
      representation: "json_utf8",
      mime: null,
      total_bytes: 10,
      digest: DIGEST,
    });
    const good = decodeHistoryBodyRef(token, { daemon_id: DAEMON, session_id: SESSION });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.entry_id).toBe("e1");
      expect(good.value.digest).toBe(DIGEST);
    }
    expect(decodeHistoryBodyRef(token, { daemon_id: DAEMON, session_id: OTHER_SESSION }).ok).toBe(false);
    const tampered = Buffer.from(
      JSON.stringify({ v: 1, t: "bd", w: DAEMON, s: SESSION, g: "g", e: "e1", ev: "e1", f: "args", r: "nope", m: null, tb: 1, d: DIGEST }),
    ).toString("base64url");
    const bad = decodeHistoryBodyRef(tampered, { daemon_id: DAEMON, session_id: SESSION });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("unsupported");
  });
});

describe("plan 86 P1 — frame budget", () => {
  test("encoded frame accounts for the base64 host envelope", () => {
    const small = bodyOk({ offset_bytes: 0, next_offset_bytes: 0, total_bytes: 0, data: "" });
    const bytes = encodedHostFrameBytes(small);
    expect(bytes).toBeGreaterThan(JSON.stringify(small).length);
    expect(fitsHistoryEncodedFrame(small)).toBe(true);

    const chunk = Buffer.alloc(HISTORY_BODY_CHUNK_BYTES, 0x41).toString("base64");
    const fullChunk = bodyOk({
      offset_bytes: 0,
      next_offset_bytes: HISTORY_BODY_CHUNK_BYTES,
      total_bytes: HISTORY_BODY_CHUNK_BYTES * 2,
      data: chunk,
    });
    expect(fitsHistoryEncodedFrame(fullChunk)).toBe(true);

    const tooBig = bodyOk({
      offset_bytes: 0,
      next_offset_bytes: 300 * 1024,
      total_bytes: 400 * 1024,
      data: Buffer.alloc(300 * 1024, 0x41).toString("base64"),
    });
    expect(fitsHistoryEncodedFrame(tooBig)).toBe(false);
  });
});

describe("plan 86 P1 — bounded previews", () => {
  test("cuts on a UTF-8 code-point boundary, never mid-character", () => {
    const text = "é".repeat(3000); // 2 bytes each = 6000 bytes
    const preview = utf8Preview(text, 4096);
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.text, "utf8")).toBeLessThanOrEqual(4096);
    expect(Buffer.from(preview.text, "utf8").toString("utf8")).toBe(preview.text);
    expect(preview.text.endsWith("é")).toBe(true);
    expect(utf8Preview("short", 4096)).toEqual({ text: "short", truncated: false });
    expect(utf8Preview("abc", 0)).toEqual({ text: "", truncated: true });
  });

  test("history_error carries explicit nulls and no free text", () => {
    const reply = historyErrorReply("q", "not_found");
    expect(reply).toEqual({
      type: "history_error",
      in_reply_to: "q",
      code: "not_found",
      daemon_id: null,
      session_id: null,
      revision: null,
      snapshot: null,
      retry_after_ms: null,
    });
    expect(Object.keys(reply)).not.toContain("message");
  });
});
