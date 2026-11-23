/**
 * Plan 86 P3 — the Web client's history contract: reply guards, typed errors,
 * body chunk assembly and the metric allow-list.
 *
 * WHY THIS GATE EXISTS BEFORE THE UI
 *
 * Every rule asserted here is a way the viewer could lie to the reader:
 *
 *   • a malformed frame rendered as an empty transcript ("this session has no
 *     messages" when the host said something else);
 *   • `building` rendered as "no history";
 *   • `truncated` rendered as a complete value;
 *   • a 64 KiB body chunk decoded per-chunk, turning one emoji that straddles the
 *     boundary into two replacement characters;
 *   • two pages spliced by ARRAY INDEX, duplicating or dropping a turn;
 *   • a metric logged as `0 ms` for a span nobody measured.
 *
 * The modules under test are the real ones the browser bundle uses — Node strips
 * their types, so this is the shipped code, not a copy.
 *
 * Run: node scripts/verify-web-history-protocol.mjs
 */

import {
  HISTORY_BODY_CHUNK_BYTES,
  HistoryBodyAssembler,
  clampListLimit,
  clampReadLimit,
  decodeBase64Strict,
  emptyMetrics,
  failureOfErrorFrame,
  historyBodyRequest,
  historyListRequest,
  historyReadRequest,
  isHistoryReplyType,
  bodyRefIdentity,
  legacyFailure,
  mergeBodyRefs,
  mergeHistoryItems,
  parseHistoryReply,
  readFromLegacyEvents,
  replyMatchesScope,
  sanitizeMetrics,
  supportsWorkspaceHistory,
} from "../src/lib/remote-pi/history.ts";

let checks = 0;
const failures = [];

/**
 * Record one assertion.
 *
 * @param label - what was checked.
 * @param ok - whether it held.
 * @param detail - observed value, shown only on failure.
 */
function check(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(`${label}${detail ? ` :: ${detail}` : ""}`);
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const utf8 = (text) => new TextEncoder().encode(text);

/** A valid `history_list_ok`, then mutated per case. */
function listFrame(overrides = {}) {
  return {
    type: "history_list_ok",
    in_reply_to: "q1",
    daemon_id: "daemon-1",
    revision: "rev-1",
    index_state: "ready",
    current: { session_id: null, ready: null, state: null, source: "unknown" },
    sessions: [{ id: "s1", name: "First", mtime: 1700000000000, preview: "hello" }],
    next_cursor: null,
    has_more: false,
    retry_after_ms: null,
    ...overrides,
  };
}

/** A valid `history_read_ok`, then mutated per case. */
function readFrame(overrides = {}) {
  return {
    type: "history_read_ok",
    in_reply_to: "q2",
    daemon_id: "daemon-1",
    session_id: "s1",
    snapshot: "snap-1",
    revision: "rev-1",
    projection: 1,
    session: { id: "s1", name: null, mtime: 1700000000000, preview: null },
    items: [
      {
        event_id: "e1",
        entry_id: "e1",
        event: { ts: 1, type: "user_input", id: "u1", text: "hi" },
      },
    ],
    older_cursor: null,
    has_older: false,
    ...overrides,
  };
}

// ── A. capability + request builders ────────────────────────────────────────

function buildersAndCapability() {
  console.log("\nA. capability and request builders");
  check(
    "the capability is `workspace_history_v1`",
    supportsWorkspaceHistory(["workspace_history_v1"]) === true,
  );
  check("an older host is NOT capability-gated in", supportsWorkspaceHistory(["fs_nav"]) === false);
  check("no capability list at all is false", supportsWorkspaceHistory(undefined) === false);

  const list = historyListRequest("q1", "d1", { limit: 1000 });
  check("list limit is clamped to 100", list.limit === 100, String(list.limit));
  check("list default is 50", historyListRequest("q", "d").limit === 50);
  check("read limit default is 30", historyReadRequest("q", "d", "s").limit === 30);
  check("clampListLimit(0) is 1", clampListLimit(0) === 1, String(clampListLimit(0)));
  check("clampReadLimit(undefined) is 30", clampReadLimit(undefined) === 30);

  const read = historyReadRequest("q2", "d1", "s1", {
    before: "opaque-older",
    ifRevision: "rev-1",
  });
  check(
    "the cursor is passed through UNPARSED",
    read.before === "opaque-older",
    String(read.before),
  );
  check("if_revision is passed through", read.if_revision === "rev-1");
  check(
    "empty tokens are omitted, never sent as \"\"",
    !("before" in historyReadRequest("q", "d", "s", { before: "" })),
  );

  const body = historyBodyRequest("q3", "d1", "s1", "snap-1", "ref-token", 128);
  check("body offset is echoed", body.offset_bytes === 128);
  check("a negative offset degrades to 0", historyBodyRequest("q", "d", "s", "sn", "r", -5).offset_bytes === 0);
}

// ── B. reply guards, native ──────────────────────────────────────────────────

function replyGuards() {
  console.log("\nB. native replies parse strictly");
  const list = parseHistoryReply(listFrame());
  check("a valid list parses", list.ok === true, list.ok ? "" : list.detail);
  check("list rows keep their identity", list.ok && list.value.sessions[0].id === "s1");
  check(
    "an unknown index_state is refused",
    parseHistoryReply(listFrame({ index_state: "partial" })).ok === false,
  );
  check(
    "a list over the page cap is refused",
    parseHistoryReply(
      listFrame({ sessions: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, name: null, mtime: i, preview: null })) }),
    ).ok === false,
  );
  check(
    "current.source must be runtime|unknown",
    parseHistoryReply(listFrame({ current: { session_id: null, ready: null, state: null, source: "guess" } })).ok === false,
  );
  check(
    "an unknown current.state is refused",
    parseHistoryReply(listFrame({ current: { session_id: null, ready: null, state: "paused", source: "runtime" } })).ok === false,
  );

  const read = parseHistoryReply(readFrame());
  check("a valid read parses", read.ok === true, read.ok ? "" : read.detail);
  check(
    "an item with an unknown event kind is refused",
    parseHistoryReply(readFrame({ items: [{ event_id: "e", entry_id: "e", event: { ts: 1, type: "mystery" } }] })).ok === false,
  );
  check(
    "an item over the body_ref cap is refused",
    parseHistoryReply(
      readFrame({
        items: [
          {
            event_id: "e",
            entry_id: "e",
            event: { ts: 1, type: "tool_request", tool_call_id: "t", tool: "bash", args: {} },
            body_refs: Array.from({ length: 17 }, (_, i) => ({
              ref: `r${i}`,
              field: "args",
              representation: "json_utf8",
              mime: null,
              total_bytes: 10,
              preview: null,
              preview_truncated: false,
            })),
          },
        ],
      }),
    ).ok === false,
  );
  check(
    "has_older must be stated, not inferred",
    parseHistoryReply(readFrame({ has_older: undefined })).ok === false,
  );

  const body = parseHistoryReply({
    type: "history_body_ok",
    in_reply_to: "q4",
    daemon_id: "daemon-1",
    session_id: "s1",
    snapshot: "snap-1",
    body_ref: "ref-1",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 0,
    next_offset_bytes: 3,
    total_bytes: 3,
    data: b64(utf8("abc")),
  });
  check("a valid body chunk parses", body.ok === true, body.ok ? "" : body.detail);
  check(
    "a chunk whose decoded length disagrees with its offsets is refused",
    parseHistoryReply({
      type: "history_body_ok",
      in_reply_to: "q4",
      daemon_id: "daemon-1",
      session_id: "s1",
      snapshot: "snap-1",
      body_ref: "ref-1",
      representation: "text_utf8",
      mime: null,
      offset_bytes: 0,
      next_offset_bytes: 10,
      total_bytes: 10,
      data: b64(utf8("abc")),
    }).ok === false,
  );
  check(
    "a non-canonical base64 alias is refused",
    decodeBase64Strict("YQ==") !== null && decodeBase64Strict("YQ") === null,
  );
  check(
    "a chunk above 64 KiB is refused",
    parseHistoryReply({
      type: "history_body_ok",
      in_reply_to: "q4",
      daemon_id: "daemon-1",
      session_id: "s1",
      snapshot: "snap-1",
      body_ref: "ref-1",
      representation: "binary",
      mime: "image/png",
      offset_bytes: 0,
      next_offset_bytes: HISTORY_BODY_CHUNK_BYTES + 1,
      total_bytes: HISTORY_BODY_CHUNK_BYTES + 1,
      data: b64(new Uint8Array(HISTORY_BODY_CHUNK_BYTES + 1)),
    }).ok === false,
  );

  check("reply type classifier", isHistoryReplyType("history_error") && !isHistoryReplyType("history_nope"));
}

// ── C. typed errors: building / stale / not_modified / legacy ───────────────

function typedErrors() {
  console.log("\nC. the error vocabulary is closed and typed");
  const codes = ["building", "stale", "not_modified", "unsupported", "not_found", "invalid_cursor", "body_too_large", "invalid_request", "internal"];
  for (const code of codes) {
    const parsed = parseHistoryReply({
      type: "history_error",
      in_reply_to: "q",
      code,
      daemon_id: "daemon-1",
      session_id: "s1",
      revision: code === "not_modified" ? "rev-1" : null,
      snapshot: null,
      retry_after_ms: code === "building" ? 25 : null,
    });
    check(`history_error{${code}} parses`, parsed.ok === true, parsed.ok ? "" : parsed.detail);
    if (parsed.ok) {
      const failure = failureOfErrorFrame(parsed.value);
      check(`  ${code} maps to a typed failure`, failure.ok === false && failure.code === code);
      if (code === "not_modified") {
        check("  not_modified carries the held revision", failure.revision === "rev-1");
      }
      if (code === "building") {
        check("  building carries retry_after_ms", failure.retry_after_ms === 25);
      }
    }
  }
  check(
    "an unknown error code is refused (never shown as a known reason)",
    parseHistoryReply({ type: "history_error", in_reply_to: "q", code: "exploded" }).ok === false,
  );

  const timeout = legacyFailure("timeout");
  const refused = legacyFailure("refused");
  check("legacy timeout is typed", timeout.ok === false && timeout.code === "timeout");
  check("legacy refusal is typed `unsupported`", refused.ok === false && refused.code === "unsupported");
}

// ── D. body assembly: 64 KiB chunks, stateful UTF-8, base64 ─────────────────

function bodyAssembly() {
  console.log("\nD. large bodies reassemble across 64 KiB chunk boundaries");
  // 4-byte code points make a boundary land INSIDE a character on purpose.
  const text = "A😀B".repeat(20_000);
  const bytes = utf8(text);
  const assembler = new HistoryBodyAssembler({
    representation: "text_utf8",
    mime: null,
    totalBytes: bytes.length,
  });

  let offset = 0;
  let chunks = 0;
  let rejected = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + HISTORY_BODY_CHUNK_BYTES);
    const ok = assembler.push({
      type: "history_body_ok",
      in_reply_to: "b",
      daemon_id: "daemon-1",
      session_id: "s1",
      snapshot: "snap-1",
      body_ref: "ref-1",
      representation: "text_utf8",
      mime: null,
      offset_bytes: offset,
      next_offset_bytes: end,
      total_bytes: bytes.length,
      data: b64(bytes.subarray(offset, end)),
    });
    if (!ok) rejected += 1;
    chunks += 1;
    offset = end;
  }
  check("every chunk was accepted in order", rejected === 0, `rejected=${rejected}`);
  check("the body reports done only at the declared total", assembler.done === true);
  check("chunk count matches ceil(bytes/64KiB)", chunks === Math.ceil(bytes.length / HISTORY_BODY_CHUNK_BYTES), String(chunks));
  check(
    "the text is byte-identical (a split 4-byte code point is ONE character)",
    assembler.textValue() === text,
    `len=${assembler.textValue().length}/${text.length}`,
  );
  check(
    "no replacement characters were introduced at the boundaries",
    !assembler.textValue().includes("\uFFFD"),
  );

  const gap = new HistoryBodyAssembler({ representation: "text_utf8", totalBytes: 6 });
  gap.push({
    type: "history_body_ok",
    in_reply_to: "b",
    daemon_id: "d",
    session_id: "s",
    snapshot: "sn",
    body_ref: "r",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 0,
    next_offset_bytes: 3,
    total_bytes: 6,
    data: b64(utf8("abc")),
  });
  const skipped = gap.push({
    type: "history_body_ok",
    in_reply_to: "b",
    daemon_id: "d",
    session_id: "s",
    snapshot: "sn",
    body_ref: "r",
    representation: "text_utf8",
    mime: null,
    offset_bytes: 4,
    next_offset_bytes: 6,
    total_bytes: 6,
    data: b64(utf8("de")),
  });
  check("a GAP in offsets is refused, not silently joined", skipped === false);
  check("the refused chunk did not advance the body", gap.offset === 3 && gap.done === false);

  const binary = new HistoryBodyAssembler({ representation: "binary", mime: "image/png", totalBytes: 4 });
  binary.push({
    type: "history_body_ok",
    in_reply_to: "b",
    daemon_id: "d",
    session_id: "s",
    snapshot: "sn",
    body_ref: "r",
    representation: "binary",
    mime: "image/png",
    offset_bytes: 0,
    next_offset_bytes: 4,
    total_bytes: 4,
    data: b64(new Uint8Array([0, 255, 1, 2])),
  });
  check("binary bytes survive untouched", Array.from(binary.binaryValue()).join(",") === "0,255,1,2");
}

// ── E. merging by stable identity ───────────────────────────────────────────

function merging() {
  console.log("\nE. pages merge by event_id, never by index");
  const item = (id, extra = {}) => ({
    event_id: id,
    entry_id: id,
    event: { ts: id === "e1" ? 1 : 2, type: "user_input", id: `u-${id}`, text: id },
    ...extra,
  });

  const merged = mergeHistoryItems([item("e1"), item("e2")], [item("e2"), item("e3")]);
  check("overlap does not duplicate", merged.length === 3, String(merged.length));
  check("order is preserved (oldest first)", merged.map((i) => i.event_id).join(",") === "e1,e2,e3");

  const parent = mergeHistoryItems([item("e1")], [item("e1", { parent: true, truncated: true })]);
  check("a tool parent merges in place", parent.length === 1 && parent[0].parent === true);
  check("PARTIAL is sticky across pages", parent[0].truncated === true);

  const refA = {
    ref: "r1",
    field: "text",
    representation: "text_utf8",
    mime: null,
    total_bytes: 100,
    preview: "cut",
    preview_truncated: true,
  };
  const refB = { ...refA, field: "args", representation: "json_utf8", ref: "r2" };
  const refs = mergeBodyRefs([refA], [refA, refB]);
  check("body refs are a union by identity", refs.length === 2, String(refs.length));
  check("a repeated ref is not duplicated", refs.filter((r) => r.field === "text").length === 1);

  /*
   * 86 P3 coordination constraint: a continuation merges body_refs by
   * (field, ref) and MUST NOT overwrite the complete event with its fragment.
   */
  const complete = item("e9", { event: { ts: 9, type: "agent_message", in_reply_to: "u9", text: "the FULL original body" } });
  const fragment = item("e9", { event: { ts: 9, type: "agent_message", in_reply_to: "u9", text: "" } });
  const continued = mergeHistoryItems([complete], [fragment]);
  check("a repeated event keeps ONE row", continued.length === 1);
  check(
    "the continuation does NOT overwrite the complete event body",
    continued[0].event.text === "the FULL original body",
    JSON.stringify(continued[0].event.text),
  );

  const refSameFieldA = { ref: "ref-cont-1", field: "text", representation: "text_utf8", mime: null, total_bytes: 100, preview: null, preview_truncated: true };
  const refSameFieldB = { ref: "ref-cont-2", field: "text", representation: "text_utf8", mime: null, total_bytes: 100, preview: null, preview_truncated: true };
  check("two different refs for the same field have different identities", bodyRefIdentity(refSameFieldA) !== bodyRefIdentity(refSameFieldB));
  const bothRefs = mergeBodyRefs([refSameFieldA], [refSameFieldB]);
  check("a continuation keeps BOTH refs of the same field", bothRefs.length === 2, String(bothRefs.length));
  check("the same ref repeated is still one", mergeBodyRefs([refSameFieldA], [refSameFieldA]).length === 1);
  check(
    "the ref token is compared, never parsed",
    bodyRefIdentity({ ...refSameFieldA, ref: "v1.anything-opaque" }).startsWith("text|v1.anything-opaque"),
  );
}

// ── F. legacy fold keeps stable identity ────────────────────────────────────

function legacyFold() {
  console.log("\nF. the legacy read folds into the same row identity");
  const events = [
    { ts: 1, type: "user_input", id: "u-1", text: "hi" },
    { ts: 2, type: "tool_request", tool_call_id: "t1", tool: "bash", args: {} },
    { ts: 3, type: "tool_result", tool_call_id: "t1", result: "ok" },
    { ts: 4, type: "agent_message", in_reply_to: "u-1", text: "done" },
  ];
  const folded = readFromLegacyEvents("s1", events, { older_cursor: "legacy-cursor", has_older: true });
  check("one row per event", folded.items.length === 4);
  check("user_input keeps the host id", folded.items[0].event_id === "u-1");
  check("tool identity is the tool_call_id", folded.items[1].event_id === "tool_request:t1");
  check("an opaque legacy cursor is passed through", folded.older_cursor === "legacy-cursor");
  check("has_older is copied, not invented", folded.has_older === true);

  const repeated = readFromLegacyEvents("s1", [
    { ts: 1, type: "user_input", id: "u-1", text: "a" },
    { ts: 1, type: "user_input", id: "u-1", text: "a" },
  ]);
  check("a repeated identity gets a stable suffix", repeated.items[1].event_id === "u-1#1");
}

// ── G. scope + metrics ──────────────────────────────────────────────────────

function scopeAndMetrics() {
  console.log("\nG. scope guards and scalar-only metrics");
  const reply = parseHistoryReply(readFrame());
  check(
    "a reply for another workspace is refused",
    reply.ok && replyMatchesScope(reply.value, { host: "h", daemon_id: "daemon-2" }) === false,
  );
  check(
    "a reply for the requested workspace matches",
    reply.ok && replyMatchesScope(reply.value, { host: "h", daemon_id: "daemon-1" }) === true,
  );

  const sample = sanitizeMetrics({
    op: "read",
    requestId: "req-1",
    queue_ms: 2,
    wire_ms: 8,
    query_ms: null,
    read_bytes: 512,
    parsed_entries: 3,
    cache_hit: true,
    apply_ms: Number.NaN,
    first_content_ms: 12,
    long_task_ms: "-",
    // Anything not on the allow-list must not survive.
    text: "SECRET",
    token: "nope",
    nested: { a: 1 },
    extra_ms: 5,
  });
  check("op and requestId survive", sample.op === "read" && sample.requestId === "req-1");
  check("a measured span survives", sample.wire_ms === 8 && sample.first_content_ms === 12);
  check("a non-finite span becomes null, never 0", sample.apply_ms === null);
  check("a non-numeric span becomes null", sample.long_task_ms === null);
  check("an unknown span is null", sample.query_ms === null);
  check(
    "the key set is exactly the P0 vocabulary",
    JSON.stringify(Object.keys(sample)) ===
      JSON.stringify([
        "op",
        "requestId",
        "queue_ms",
        "wire_ms",
        "query_ms",
        "read_bytes",
        "parsed_entries",
        "cache_hit",
        "apply_ms",
        "first_content_ms",
        "long_task_ms",
      ]),
    Object.keys(sample).join(","),
  );
  check("payload text never survives", JSON.stringify(sample).includes("SECRET") === false);
  check(
    "an all-unknown sample is all null",
    Object.entries(emptyMetrics("list")).every(([key, value]) =>
      key === "op" || key === "requestId" ? true : value === null,
    ),
  );
}

console.log("verify-web-history-protocol — typed history contract");
buildersAndCapability();
replyGuards();
typedErrors();
bodyAssembly();
merging();
legacyFold();
scopeAndMetrics();

console.log(`\n${checks - failures.length}/${checks} checks PASS`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-history-protocol: OK");
