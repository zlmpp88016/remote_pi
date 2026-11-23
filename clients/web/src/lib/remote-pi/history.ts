/**
 * Plan 86 P3 — the Web client's half of the `workspace_history_v1` contract.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A MIRROR RATHER THAN AN IMPORT
 *
 * The host serves history from disk with ZERO Pi processes. That makes the wire
 * shape a PUBLIC contract (`server/src/protocol/types.ts` + `history.ts`), not
 * an SDK detail: the Web client has to agree with the host about limits, the
 * closed error vocabulary, token opacity and the 64 KiB body chunking. Importing
 * the server module is not an option — this bundle is served to browsers and the
 * server tree is not part of it.
 *
 * So this module re-states the rules the client must enforce, and it states
 * them STRICTLY: a frame that would make the UI claim something the host did not
 * say is rejected here rather than rendered. The goal is not to duplicate the
 * server's validation for its own sake — it is that a malformed reply must
 * degrade to a typed failure, never to a truthful-looking empty transcript.
 *
 * THREE RULES THAT MATTER MORE THAN THE REST
 *
 *  1. Cursors, snapshots and body refs are OPAQUE. This module never parses,
 *     rebuilds or guesses one. It only refuses an empty/non-string token.
 *  2. `index_state: "building"` is a STATE, not an empty answer. A partial
 *     catalog is never presented as "this workspace has no history".
 *  3. `item.truncated` / `body_ref.preview_truncated` are PARTIAL, and the UI is
 *     told so. A bounded preview is never rendered as if it were the whole
 *     value.
 *
 * LEGACY IS A FIRST-CLASS PATH, NOT AN AFTERTHOUGHT
 *
 * An older host has no `workspace_history_v1`, so the client falls back to the
 * existing read-only `session_read` (when a Pi happens to be live). The failure
 * vocabulary therefore has to cover both: `legacyFailure()` maps the generic
 * `action_error` / timeout outcomes into the same closed set, so downstream code
 * has ONE error switch instead of two.
 */

import { isJsonObject, isWireSessionEvent, type WireSessionEvent } from "./protocol.ts";

// ── Capability ───────────────────────────────────────────────────────────────

/**
 * The host capability that gates this whole family.
 *
 * Its ABSENCE is not an error: it means "old host", and the client keeps the
 * legacy read-only path. It must NEVER be interpreted as "upgrade browsing into
 * `session_switch`" — reading is not resuming.
 */
export const WORKSPACE_HISTORY_CAPABILITY = "workspace_history_v1";

/** True when the host announced the host-native history family. */
export function supportsWorkspaceHistory(
  capabilities: readonly string[] | undefined | null,
): boolean {
  return Array.isArray(capabilities) && capabilities.includes(WORKSPACE_HISTORY_CAPABILITY);
}

// ── Limits (mirrors of server/src/protocol/history.ts) ───────────────────────

export const HISTORY_LIST_DEFAULT_LIMIT = 50;
export const HISTORY_LIST_MAX_LIMIT = 100;
/** `history_read` counts transcript ENTRIES, not wire events. */
export const HISTORY_READ_DEFAULT_LIMIT = 30;
export const HISTORY_READ_MAX_LIMIT = 100;
/** Decoded bytes in one `history_body` reply. */
export const HISTORY_BODY_CHUNK_BYTES = 64 * 1024;
export const HISTORY_MAX_BODY_REFS_PER_ITEM = 16;
export const HISTORY_PROJECTION_VERSION = 1;
export const HISTORY_DEFAULT_RETRY_AFTER_MS = 25;
/** Opaque token ceiling, matching the host's own guard. */
export const HISTORY_TOKEN_MAX_CHARS = 8 * 1024;

export function clampListLimit(limit: number | undefined): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : HISTORY_LIST_DEFAULT_LIMIT;
  return Math.min(HISTORY_LIST_MAX_LIMIT, Math.max(1, value));
}

export function clampReadLimit(limit: number | undefined): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : HISTORY_READ_DEFAULT_LIMIT;
  return Math.min(HISTORY_READ_MAX_LIMIT, Math.max(1, value));
}

// ── Wire shapes ──────────────────────────────────────────────────────────────

export type HistoryIndexState = "ready" | "building" | "unavailable";
export type HistoryRepresentation = "text_utf8" | "json_utf8" | "binary";

/** Closed error vocabulary. Local failures add `malformed` / `legacy` /
 *  `timeout` / `transport`, which are CLIENT facts, never wire codes. */
export type HistoryErrorCode =
  | "building"
  | "stale"
  | "not_modified"
  | "unsupported"
  | "not_found"
  | "invalid_cursor"
  | "body_too_large"
  | "invalid_request"
  | "internal";

export type HistoryFailureCode = HistoryErrorCode | "malformed" | "legacy" | "timeout" | "transport";

export interface HistorySessionRow {
  id: string;
  name: string | null;
  mtime: number;
  preview: string | null;
}

export interface HistoryBodyRef {
  ref: string;
  field: string;
  representation: HistoryRepresentation;
  mime: string | null;
  total_bytes: number;
  /** Bounded preview, present only when the event carries a placeholder. */
  preview: string | null;
  /** True when `preview` is a cut of a larger value — PARTIAL, never complete. */
  preview_truncated: boolean;
}

export interface HistoryItem {
  event_id: string;
  entry_id: string;
  event: WireSessionEvent;
  body_refs?: HistoryBodyRef[];
  /** Prepended tool-call parent, outside the page cursor. Dedupe by event_id. */
  parent?: true;
  /** True when the host omitted part of this item: render as PARTIAL. */
  truncated?: boolean;
}

export interface HistoryCurrent {
  session_id: string | null;
  ready: boolean | null;
  state: "running" | "starting" | "crashed" | "stopped" | null;
  source: "runtime" | "unknown";
}

export interface HistoryListOk {
  type: "history_list_ok";
  in_reply_to: string;
  daemon_id: string;
  revision: string | null;
  index_state: HistoryIndexState;
  current: HistoryCurrent;
  sessions: HistorySessionRow[];
  next_cursor: string | null;
  has_more: boolean;
  retry_after_ms: number | null;
}

export interface HistoryReadOk {
  type: "history_read_ok";
  in_reply_to: string;
  daemon_id: string;
  session_id: string;
  snapshot: string;
  revision: string;
  projection: number;
  session: HistorySessionRow;
  items: HistoryItem[];
  older_cursor: string | null;
  has_older: boolean;
}

export interface HistoryBodyOk {
  type: "history_body_ok";
  in_reply_to: string;
  daemon_id: string;
  session_id: string;
  snapshot: string;
  body_ref: string;
  representation: HistoryRepresentation;
  mime: string | null;
  offset_bytes: number;
  next_offset_bytes: number;
  total_bytes: number;
  /** Standard base64 of `[offset_bytes, next_offset_bytes)`. May split a
   *  multi-byte UTF-8 sequence: text MUST be decoded statefully. */
  data: string;
}

export interface HistoryErrorFrame {
  type: "history_error";
  in_reply_to: string;
  code: HistoryErrorCode;
  daemon_id: string | null;
  session_id: string | null;
  revision: string | null;
  snapshot: string | null;
  retry_after_ms: number | null;
}

export type HistoryReply = HistoryListOk | HistoryReadOk | HistoryBodyOk | HistoryErrorFrame;

export interface HistoryFailure {
  ok: false;
  code: HistoryFailureCode;
  /** Developer-facing detail for tests/logs. Never rendered. */
  detail: string;
  /** `not_modified` answers with the revision the client already holds. */
  revision?: string | null;
  retry_after_ms?: number | null;
}

export type HistoryOutcome<T> = { ok: true; value: T } | HistoryFailure;

const INDEX_STATES: ReadonlySet<string> = new Set<HistoryIndexState>([
  "ready",
  "building",
  "unavailable",
]);
const REPRESENTATIONS: ReadonlySet<string> = new Set<HistoryRepresentation>([
  "text_utf8",
  "json_utf8",
  "binary",
]);
const ERROR_CODES: ReadonlySet<string> = new Set<HistoryErrorCode>([
  "building",
  "stale",
  "not_modified",
  "unsupported",
  "not_found",
  "invalid_cursor",
  "body_too_large",
  "invalid_request",
  "internal",
]);

function fail(code: HistoryFailureCode, detail: string): HistoryFailure {
  return { ok: false, code, detail };
}

function isNonEmptyString(value: unknown, maxChars = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown, maxChars = 512): value is string | null {
  return value === null || value === "" || isNonEmptyString(value, maxChars);
}

// ── Reply guards ─────────────────────────────────────────────────────────────

function parseSessionRow(value: unknown): HistoryOutcome<HistorySessionRow> {
  if (!isJsonObject(value)) return fail("malformed", "session is not an object");
  if (!isNonEmptyString(value["id"], 1024)) return fail("malformed", "session.id");
  const name = value["name"];
  if (name !== null && typeof name !== "string") return fail("malformed", "session.name");
  const mtime = value["mtime"];
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return fail("malformed", "session.mtime");
  const preview = value["preview"];
  if (preview !== null && typeof preview !== "string") return fail("malformed", "session.preview");
  return {
    ok: true,
    value: { id: value["id"], name: name as string | null, mtime, preview: preview as string | null },
  };
}

function parseBodyRef(value: unknown): HistoryOutcome<HistoryBodyRef> {
  if (!isJsonObject(value)) return fail("malformed", "body_ref is not an object");
  if (!isNonEmptyString(value["ref"], HISTORY_TOKEN_MAX_CHARS)) return fail("malformed", "body_ref.ref");
  if (!isNonEmptyString(value["field"], 128)) return fail("malformed", "body_ref.field");
  const representation = value["representation"];
  if (typeof representation !== "string" || !REPRESENTATIONS.has(representation)) {
    return fail("malformed", "body_ref.representation");
  }
  const mime = value["mime"];
  if (mime !== null && typeof mime !== "string") return fail("malformed", "body_ref.mime");
  if (!isNonNegativeInteger(value["total_bytes"])) return fail("malformed", "body_ref.total_bytes");
  const preview = value["preview"];
  if (preview !== null && typeof preview !== "string") return fail("malformed", "body_ref.preview");
  if (typeof value["preview_truncated"] !== "boolean") {
    return fail("malformed", "body_ref.preview_truncated");
  }
  return {
    ok: true,
    value: {
      ref: value["ref"],
      field: value["field"],
      representation: representation as HistoryRepresentation,
      mime: mime as string | null,
      total_bytes: value["total_bytes"] as number,
      preview: preview as string | null,
      preview_truncated: value["preview_truncated"],
    },
  };
}

function parseItem(value: unknown): HistoryOutcome<HistoryItem> {
  if (!isJsonObject(value)) return fail("malformed", "item is not an object");
  if (!isNonEmptyString(value["event_id"], 2048)) return fail("malformed", "item.event_id");
  if (!isNonEmptyString(value["entry_id"], 1024)) return fail("malformed", "item.entry_id");
  if (!isWireSessionEvent(value["event"])) return fail("malformed", "item.event");
  const item: HistoryItem = {
    event_id: value["event_id"],
    entry_id: value["entry_id"],
    // The event was validated field-by-field just above; the cast only names
    // the already-proven shape.
    event: value["event"] as WireSessionEvent,
  };
  const refs = value["body_refs"];
  if (refs !== undefined) {
    if (!Array.isArray(refs) || refs.length > HISTORY_MAX_BODY_REFS_PER_ITEM) {
      return fail("malformed", "item.body_refs");
    }
    const parsed: HistoryBodyRef[] = [];
    for (const ref of refs) {
      const result = parseBodyRef(ref);
      if (!result.ok) return result;
      parsed.push(result.value);
    }
    item.body_refs = parsed;
  }
  if (value["parent"] !== undefined) {
    if (value["parent"] !== true) return fail("malformed", "item.parent");
    item.parent = true;
  }
  if (value["truncated"] !== undefined) {
    if (typeof value["truncated"] !== "boolean") return fail("malformed", "item.truncated");
    item.truncated = value["truncated"];
  }
  return { ok: true, value: item };
}

function parseCurrent(value: unknown): HistoryOutcome<HistoryCurrent> {
  if (!isJsonObject(value)) return fail("malformed", "current is not an object");
  const sessionId = value["session_id"];
  if (sessionId !== null && !isNonEmptyString(sessionId, 1024)) return fail("malformed", "current.session_id");
  const ready = value["ready"];
  if (ready !== null && typeof ready !== "boolean") return fail("malformed", "current.ready");
  const state = value["state"];
  if (state !== null && !["running", "starting", "crashed", "stopped"].includes(String(state))) {
    return fail("malformed", "current.state");
  }
  const source = value["source"];
  if (source !== "runtime" && source !== "unknown") return fail("malformed", "current.source");
  return {
    ok: true,
    value: {
      session_id: sessionId as string | null,
      ready: ready as boolean | null,
      state: state as HistoryCurrent["state"],
      source,
    },
  };
}

function parseList(value: Record<string, unknown>): HistoryOutcome<HistoryListOk> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("malformed", "in_reply_to");
  if (!isNonEmptyString(value["daemon_id"], 128)) return fail("malformed", "daemon_id");
  const revision = value["revision"];
  if (revision !== null && typeof revision !== "string") return fail("malformed", "revision");
  const indexState = value["index_state"];
  if (typeof indexState !== "string" || !INDEX_STATES.has(indexState)) {
    return fail("malformed", "index_state");
  }
  const current = parseCurrent(value["current"]);
  if (!current.ok) return current;
  const rawSessions = value["sessions"];
  if (!Array.isArray(rawSessions) || rawSessions.length > HISTORY_LIST_MAX_LIMIT) {
    return fail("malformed", "sessions");
  }
  const sessions: HistorySessionRow[] = [];
  for (const row of rawSessions) {
    const parsed = parseSessionRow(row);
    if (!parsed.ok) return parsed;
    sessions.push(parsed.value);
  }
  const nextCursor = value["next_cursor"];
  if (nextCursor !== null && !isNonEmptyString(nextCursor, HISTORY_TOKEN_MAX_CHARS)) {
    return fail("malformed", "next_cursor");
  }
  if (typeof value["has_more"] !== "boolean") return fail("malformed", "has_more");
  const retry = value["retry_after_ms"];
  if (retry !== null && !isNonNegativeInteger(retry)) return fail("malformed", "retry_after_ms");
  return {
    ok: true,
    value: {
      type: "history_list_ok",
      in_reply_to: value["in_reply_to"],
      daemon_id: value["daemon_id"],
      revision: revision as string | null,
      index_state: indexState as HistoryIndexState,
      current: current.value,
      sessions,
      next_cursor: nextCursor as string | null,
      has_more: value["has_more"],
      retry_after_ms: retry as number | null,
    },
  };
}

function parseRead(value: Record<string, unknown>): HistoryOutcome<HistoryReadOk> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("malformed", "in_reply_to");
  if (!isNonEmptyString(value["daemon_id"], 128)) return fail("malformed", "daemon_id");
  if (!isNonEmptyString(value["session_id"], 1024)) return fail("malformed", "session_id");
  if (!isNonEmptyString(value["snapshot"], HISTORY_TOKEN_MAX_CHARS)) return fail("malformed", "snapshot");
  if (!isNonEmptyString(value["revision"], 256)) return fail("malformed", "revision");
  if (!isNonNegativeInteger(value["projection"])) return fail("malformed", "projection");
  const session = parseSessionRow(value["session"]);
  if (!session.ok) return session;
  const rawItems = value["items"];
  // The host trims a page to fit one encoded frame, so the array can be SHORTER
  // than the requested limit; a wildly oversized one is a malformed reply.
  if (!Array.isArray(rawItems) || rawItems.length > 2048) return fail("malformed", "items");
  const items: HistoryItem[] = [];
  for (const row of rawItems) {
    const parsed = parseItem(row);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  const olderCursor = value["older_cursor"];
  if (olderCursor !== null && !isNonEmptyString(olderCursor, HISTORY_TOKEN_MAX_CHARS)) {
    return fail("malformed", "older_cursor");
  }
  if (typeof value["has_older"] !== "boolean") return fail("malformed", "has_older");
  return {
    ok: true,
    value: {
      type: "history_read_ok",
      in_reply_to: value["in_reply_to"],
      daemon_id: value["daemon_id"],
      session_id: value["session_id"],
      snapshot: value["snapshot"],
      revision: value["revision"],
      projection: value["projection"],
      session: session.value,
      items,
      older_cursor: olderCursor as string | null,
      has_older: value["has_older"],
    },
  };
}

function parseBody(value: Record<string, unknown>): HistoryOutcome<HistoryBodyOk> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("malformed", "in_reply_to");
  if (!isNonEmptyString(value["daemon_id"], 128)) return fail("malformed", "daemon_id");
  if (!isNonEmptyString(value["session_id"], 1024)) return fail("malformed", "session_id");
  if (!isNonEmptyString(value["snapshot"], HISTORY_TOKEN_MAX_CHARS)) return fail("malformed", "snapshot");
  if (!isNonEmptyString(value["body_ref"], HISTORY_TOKEN_MAX_CHARS)) return fail("malformed", "body_ref");
  const representation = value["representation"];
  if (typeof representation !== "string" || !REPRESENTATIONS.has(representation)) {
    return fail("malformed", "representation");
  }
  const mime = value["mime"];
  if (mime !== null && typeof mime !== "string") return fail("malformed", "mime");
  const offset = value["offset_bytes"];
  const next = value["next_offset_bytes"];
  const total = value["total_bytes"];
  if (!isNonNegativeInteger(offset) || !isNonNegativeInteger(next) || !isNonNegativeInteger(total)) {
    return fail("malformed", "body offsets");
  }
  if (offset > total || next < offset || next > total) {
    return fail("malformed", "body offsets out of range");
  }
  const data = value["data"];
  if (typeof data !== "string") return fail("malformed", "data");
  const decoded = decodeBase64Strict(data);
  if (decoded === null) return fail("malformed", "data is not base64");
  if (decoded.length !== next - offset) return fail("malformed", "data length != chunk length");
  if (decoded.length > HISTORY_BODY_CHUNK_BYTES) return fail("malformed", "chunk exceeds 64 KiB");
  return {
    ok: true,
    value: {
      type: "history_body_ok",
      in_reply_to: value["in_reply_to"],
      daemon_id: value["daemon_id"],
      session_id: value["session_id"],
      snapshot: value["snapshot"],
      body_ref: value["body_ref"],
      representation: representation as HistoryRepresentation,
      mime: mime as string | null,
      offset_bytes: offset,
      next_offset_bytes: next,
      total_bytes: total,
      data,
    },
  };
}

function parseErrorFrame(value: Record<string, unknown>): HistoryOutcome<HistoryErrorFrame> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("malformed", "in_reply_to");
  const code = value["code"];
  if (typeof code !== "string" || !ERROR_CODES.has(code)) return fail("malformed", "code");
  const daemonId = value["daemon_id"];
  if (!isNullableString(daemonId, 128)) return fail("malformed", "daemon_id");
  const sessionId = value["session_id"];
  if (!isNullableString(sessionId, 1024)) return fail("malformed", "session_id");
  const revision = value["revision"];
  if (!isNullableString(revision, 256)) return fail("malformed", "revision");
  const snapshot = value["snapshot"];
  if (!isNullableString(snapshot, HISTORY_TOKEN_MAX_CHARS)) return fail("malformed", "snapshot");
  const retry = value["retry_after_ms"];
  if (retry !== null && !isNonNegativeInteger(retry)) return fail("malformed", "retry_after_ms");
  return {
    ok: true,
    value: {
      type: "history_error",
      in_reply_to: value["in_reply_to"],
      code: code as HistoryErrorCode,
      daemon_id: daemonId as string | null,
      session_id: sessionId as string | null,
      revision: revision as string | null,
      snapshot: snapshot as string | null,
      retry_after_ms: retry as number | null,
    },
  };
}

/** True when `type` names one of the four replies this module understands. */
export function isHistoryReplyType(type: unknown): boolean {
  return (
    type === "history_list_ok" ||
    type === "history_read_ok" ||
    type === "history_body_ok" ||
    type === "history_error"
  );
}

/**
 * Validate ONE inbound `history_*` reply.
 *
 * A frame of any other kind is not this function's business: callers route by
 * `type` first, so reaching here with a foreign kind is a malformed reply.
 */
export function parseHistoryReply(value: unknown): HistoryOutcome<HistoryReply> {
  if (!isJsonObject(value)) return fail("malformed", "reply is not an object");
  const type = value["type"];
  if (type === "history_list_ok") return parseList(value);
  if (type === "history_read_ok") return parseRead(value);
  if (type === "history_body_ok") return parseBody(value);
  if (type === "history_error") return parseErrorFrame(value);
  return fail("malformed", "unknown history reply type");
}

/** Turn a validated wire error into the client's typed failure. */
export function failureOfErrorFrame(frame: HistoryErrorFrame): HistoryFailure {
  return {
    ok: false,
    code: frame.code,
    detail: `history_error:${frame.code}`,
    revision: frame.revision,
    retry_after_ms: frame.retry_after_ms,
  };
}

/**
 * Map a LEGACY `session_read` outcome onto the same vocabulary.
 *
 * The old path answers with `session_read_ok` or the generic
 * `action_error`/timeout. Nothing about the vocabulary is invented here: a
 * refusal becomes `unsupported` (the host will not serve this read on this
 * path), a lost frame becomes `timeout`, and a closed connection becomes
 * `transport`. A caller therefore has ONE switch.
 */
export function legacyFailure(reason: "refused" | "timeout" | "transport" | "malformed"): HistoryFailure {
  if (reason === "timeout") return fail("timeout", "legacy session_read timed out");
  if (reason === "transport") return fail("transport", "legacy session_read lost its connection");
  if (reason === "refused") return fail("unsupported", "legacy session_read was refused");
  return fail("malformed", "legacy session_read reply was malformed");
}

/**
 * Fold a legacy `session_read_ok` into a paged read, so the viewer's render path
 * is the same for both transports.
 *
 * The legacy cursor is opaque here too: it is passed through as the older
 * cursor, and `has_older` is only believed when the host stated it. The events
 * are given stable ids from their own content identity so de-duplication across
 * pages still works:
 *   - `user_input` carries the host's own `id`, which the live stream uses;
 *   - everything else falls back to `${kind}:${tool_call_id|in_reply_to|ts}#n`,
 *     which is stable for the same underlying entry.
 */
export function readFromLegacyEvents(
  sessionId: string,
  events: readonly WireSessionEvent[],
  page: { older_cursor?: string | null; has_older?: boolean; truncated?: boolean } = {},
): { items: HistoryItem[]; older_cursor: string | null; has_older: boolean; truncated: boolean } {
  const seen = new Map<string, number>();
  const items: HistoryItem[] = events.map((event) => {
    const base = legacyEventIdentity(event);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const eventId = count === 0 ? base : `${base}#${count}`;
    return { event_id: eventId, entry_id: eventId, event };
  });
  return {
    items,
    older_cursor: typeof page.older_cursor === "string" && page.older_cursor !== "" ? page.older_cursor : null,
    has_older: page.has_older === true,
    truncated: page.truncated === true,
  };
}

/** Stable identity for one legacy event, never the array index. */
function legacyEventIdentity(event: WireSessionEvent): string {
  switch (event.type) {
    case "user_input":
      return event.id !== "" ? event.id : `user_input:${event.ts}`;
    case "agent_message":
      return `agent_message:${event.in_reply_to}:${event.ts}`;
    case "tool_request":
      return `tool_request:${event.tool_call_id}`;
    case "tool_result":
      return `tool_result:${event.tool_call_id}`;
    case "compaction":
      return `compaction:${event.ts}`;
  }
}

// ── Request builders ─────────────────────────────────────────────────────────

export interface HistoryListRequestShape {
  type: "history_list";
  id: string;
  daemon_id: string;
  limit?: number;
  before?: string;
  if_revision?: string;
}

export interface HistoryReadRequestShape {
  type: "history_read";
  id: string;
  daemon_id: string;
  session_id: string;
  limit?: number;
  before?: string;
  snapshot?: string;
  if_revision?: string;
}

export interface HistoryBodyRequestShape {
  type: "history_body";
  id: string;
  daemon_id: string;
  session_id: string;
  snapshot: string;
  body_ref: string;
  offset_bytes: number;
}

/**
 * Build a `history_list` body.
 *
 * Tokens are passed through untouched: this function never inspects a cursor or
 * a revision, because they are opaque and may change shape without a client
 * release.
 */
export function historyListRequest(
  id: string,
  daemonId: string,
  options: { limit?: number; before?: string | null; ifRevision?: string | null } = {},
): HistoryListRequestShape {
  return {
    type: "history_list",
    id,
    daemon_id: daemonId,
    limit: clampListLimit(options.limit),
    ...(typeof options.before === "string" && options.before !== "" ? { before: options.before } : {}),
    ...(typeof options.ifRevision === "string" && options.ifRevision !== ""
      ? { if_revision: options.ifRevision }
      : {}),
  };
}

export function historyReadRequest(
  id: string,
  daemonId: string,
  sessionId: string,
  options: { limit?: number; before?: string | null; snapshot?: string | null; ifRevision?: string | null } = {},
): HistoryReadRequestShape {
  return {
    type: "history_read",
    id,
    daemon_id: daemonId,
    session_id: sessionId,
    limit: clampReadLimit(options.limit),
    ...(typeof options.before === "string" && options.before !== "" ? { before: options.before } : {}),
    ...(typeof options.snapshot === "string" && options.snapshot !== "" ? { snapshot: options.snapshot } : {}),
    ...(typeof options.ifRevision === "string" && options.ifRevision !== ""
      ? { if_revision: options.ifRevision }
      : {}),
  };
}

export function historyBodyRequest(
  id: string,
  daemonId: string,
  sessionId: string,
  snapshot: string,
  bodyRef: string,
  offsetBytes: number,
): HistoryBodyRequestShape {
  return {
    type: "history_body",
    id,
    daemon_id: daemonId,
    session_id: sessionId,
    snapshot,
    body_ref: bodyRef,
    offset_bytes: Number.isInteger(offsetBytes) && offsetBytes >= 0 ? offsetBytes : 0,
  };
}

// ── Scope checks (late/foreign reply guards) ──────────────────────────────────

export interface HistoryScope {
  /** Host identity (relay peer key) — part of every cache and request scope. */
  host: string;
  /** Workspace identity: the daemon id, never a path. */
  daemon_id: string;
}

/**
 * True when a reply belongs to `scope`.
 *
 * A reply that names a DIFFERENT workspace is never applied to the open one,
 * even if its `in_reply_to` happened to match: the host is the authority on
 * scope, and a spliced transcript from another workspace is exactly the
 * cross-talk failure this plan exists to prevent.
 */
export function replyMatchesScope(reply: HistoryReply, scope: HistoryScope): boolean {
  if (reply.type === "history_error") {
    return reply.daemon_id === null || reply.daemon_id === scope.daemon_id;
  }
  return reply.daemon_id === scope.daemon_id;
}

// ── Body: strict base64, stateful UTF-8, offset continuity ───────────────────

/**
 * Strict standard base64 decode, or null.
 *
 * `atob` silently tolerates whitespace and truncates on some inputs, so the
 * shape is checked first and the round-trip is verified: an alternate encoding
 * of the same bytes is still a protocol violation.
 */
export function decodeBase64Strict(value: string): Uint8Array | null {
  if (typeof value !== "string") return null;
  if (value === "") return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.length % 4 !== 0) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Canonical check: re-encode and compare, so `AA==` and an alias both fail.
  if (bytesToBase64Local(bytes) !== value) return null;
  return bytes;
}

function bytesToBase64Local(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Reassembles one `body_ref` from its 64 KiB chunks.
 *
 * THE ONE THING THAT CANNOT BE DONE PER-CHUNK: `TextDecoder` with
 * `{stream: true}` keeps the trailing bytes of a split multi-byte sequence, so a
 * 4-byte emoji straddling two chunks decodes to ONE character rather than two
 * U+FFFD replacement characters. Decoding each chunk independently is the bug
 * this class exists to prevent.
 *
 * Offsets are checked for CONTINUITY: a gap or an overlap is a malformed body,
 * not a body with a hole. `body_too_large` is surfaced from the wire error, and
 * this class never pretends a partial body is complete (`done` is only true when
 * the declared total was reached).
 */
export class HistoryBodyAssembler {
  readonly representation: HistoryRepresentation;
  readonly mime: string | null;
  readonly totalBytes: number;
  private readonly decoder: TextDecoder | null;
  private readonly parts: Uint8Array[] = [];
  private received = 0;
  private text = "";

  constructor(input: { representation: HistoryRepresentation; mime?: string | null; totalBytes: number }) {
    this.representation = input.representation;
    this.mime = input.mime ?? null;
    this.totalBytes = input.totalBytes;
    this.decoder = input.representation === "binary" ? null : new TextDecoder("utf-8");
  }

  /** Next byte offset this assembler expects. */
  get offset(): number {
    return this.received;
  }

  /** True only when every declared byte arrived. */
  get done(): boolean {
    return this.received === this.totalBytes;
  }

  /** True when a chunk was accepted but the body is still incomplete. */
  get partial(): boolean {
    return this.received > 0 && !this.done;
  }

  /**
   * Accept one chunk.
   *
   * Rejects (returns false and changes nothing) a chunk that does not continue
   * at the current offset, a chunk larger than the protocol's 64 KiB, or one
   * whose decoded length disagrees with its own offset arithmetic.
   */
  push(chunk: HistoryBodyOk): boolean {
    if (chunk.representation !== this.representation) return false;
    if (chunk.total_bytes !== this.totalBytes) return false;
    if (chunk.offset_bytes !== this.received) return false;
    const bytes = decodeBase64Strict(chunk.data);
    if (bytes === null) return false;
    if (bytes.length !== chunk.next_offset_bytes - chunk.offset_bytes) return false;
    if (bytes.length > HISTORY_BODY_CHUNK_BYTES) return false;
    if (this.received + bytes.length > this.totalBytes) return false;
    if (this.decoder !== null) {
      this.text += this.decoder.decode(bytes, { stream: true });
    } else {
      this.parts.push(bytes);
    }
    this.received += bytes.length;
    return true;
  }

  /** Full text for `text_utf8` / `json_utf8`. Flushes any trailing partial
   *  sequence as U+FFFD, which is the honest result for a truncated body. */
  textValue(): string {
    if (this.decoder === null) return "";
    if (!this.done) return this.text;
    // Flush once, at completion. Calling this repeatedly is safe: the flush
    // only happens on a completed body and `text` already holds the decoded
    // prefix.
    return this.text + this.decoder.decode();
  }

  /** Bytes for `binary` payloads (a copy, so callers may transfer it). */
  binaryValue(): Uint8Array {
    const out = new Uint8Array(this.received);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

// ── Merge helpers (stable identity, never array position) ────────────────────

/**
 * Merge a page into what is already rendered.
 *
 * De-duplication is by `event_id` — the host's STABLE identity — never by array
 * index or timestamp. A tool-call parent that arrives with a later page is
 * merged where it already sits, and a repeated item does not move.
 *
 * CONTINUATION RULE (root constraint, 86 P3 coordination): the host may send the
 * SAME item again with additional `body_refs` (an intra-entry continuation). The
 * merge therefore:
 *   • keeps the ORIGINAL event payload verbatim — a continuation's small fragment
 *     must never overwrite the complete event text that is already rendered;
 *   • unions the refs by `field` + opaque `ref`, so two DIFFERENT refs for the same
 *     field both survive (dropping one would lose data) while a repeated ref is
 *     not duplicated;
 *   • keeps `truncated` sticky, because a later page omitting the flag does not
 *     prove the earlier omission was resolved.
 */
export function mergeHistoryItems(
  existing: readonly HistoryItem[],
  incoming: readonly HistoryItem[],
): HistoryItem[] {
  return mergeHistoryPages([existing, incoming]);
}

/** Merge the entire resident window with ONE identity index. */
export function mergeHistoryPages(pages: Iterable<readonly HistoryItem[]>): HistoryItem[] {
  const index = new Map<string, number>();
  const out: HistoryItem[] = [];
  for (const incoming of pages) {
    for (const item of incoming) {
      const at = index.get(item.event_id);
      if (at === undefined) {
        index.set(item.event_id, out.length);
        out.push(item);
        continue;
      }
      const current = out[at] as HistoryItem;
      const mergedRefs = mergeBodyRefs(current.body_refs, item.body_refs);
      const next: HistoryItem = {
        ...current,
        // PARTIAL is sticky: a later page that omits the flag does not prove the
        // earlier omission was resolved.
        ...(current.truncated === true || item.truncated === true ? { truncated: true } : {}),
        ...(current.parent === true || item.parent === true ? { parent: true as const } : {}),
        ...(mergedRefs === undefined ? {} : { body_refs: mergedRefs }),
      };
      out[at] = next;
    }
  }
  return out;
}

/** Union of two ref lists by (field, ref), capped by the protocol. */
export function mergeBodyRefs(
  existing: readonly HistoryBodyRef[] | undefined,
  incoming: readonly HistoryBodyRef[] | undefined,
): HistoryBodyRef[] | undefined {
  if (incoming === undefined || incoming.length === 0) {
    return existing === undefined ? undefined : [...existing];
  }
  const out: HistoryBodyRef[] = existing === undefined ? [] : [...existing];
  const seen = new Set(out.map(bodyRefIdentity));
  for (const ref of incoming) {
    const id = bodyRefIdentity(ref);
    if (seen.has(id)) continue;
    if (out.length >= HISTORY_MAX_BODY_REFS_PER_ITEM) break;
    seen.add(id);
    out.push(ref);
  }
  return out;
}

/**
 * Stable identity of one body ref: the FIELD it materializes + the opaque REF.
 *
 * `ref` is opaque and host-issued, so it is compared, never parsed. Two different
 * refs for the same field are two different payloads (a continuation, or two
 * chunks of the same giant field) and both must be kept; the same ref repeated is
 * the same payload and is de-duplicated.
 */
export function bodyRefIdentity(ref: HistoryBodyRef): string {
  return `${ref.field}|${ref.ref}`;
}

// ── Metrics: scalar-only, unknown is null ────────────────────────────────────

/**
 * The P0 metric vocabulary, verbatim.
 *
 * Scalar only: no arrays, no objects, no message text. An unavailable span is
 * `null`, NEVER 0 — "0 ms" reads as a measurement this client did not make.
 */
export interface HistoryMetricsSample {
  op: string;
  requestId: string | null;
  queue_ms: number | null;
  wire_ms: number | null;
  query_ms: number | null;
  read_bytes: number | null;
  parsed_entries: number | null;
  cache_hit: boolean | null;
  apply_ms: number | null;
  first_content_ms: number | null;
  long_task_ms: number | null;
}

export const HISTORY_METRIC_NUMERIC_KEYS = [
  "queue_ms",
  "wire_ms",
  "query_ms",
  "read_bytes",
  "parsed_entries",
  "apply_ms",
  "first_content_ms",
  "long_task_ms",
] as const;

export type HistoryMetricNumericKey = (typeof HISTORY_METRIC_NUMERIC_KEYS)[number];

/** An all-unknown sample: every span null until something measures it. */
export function emptyMetrics(op: string, requestId: string | null = null): HistoryMetricsSample {
  return {
    op,
    requestId,
    queue_ms: null,
    wire_ms: null,
    query_ms: null,
    read_bytes: null,
    parsed_entries: null,
    cache_hit: null,
    apply_ms: null,
    first_content_ms: null,
    long_task_ms: null,
  };
}

/**
 * Rebuild a sample from the allow-list.
 *
 * Whatever the caller passed, the result has exactly the documented keys, every
 * numeric span is a finite number or `null`, `cache_hit` is a boolean or `null`,
 * and `requestId` is a string or `null`. This is the guard that keeps message
 * text, ids beyond the request id, and stray object graphs out of the log.
 */
export function sanitizeMetrics(input: unknown): HistoryMetricsSample {
  const raw = isJsonObject(input) ? input : {};
  const sample = emptyMetrics(
    typeof raw["op"] === "string" && raw["op"] !== "" ? raw["op"].slice(0, 32) : "unknown",
    typeof raw["requestId"] === "string" && raw["requestId"] !== "" ? raw["requestId"].slice(0, 128) : null,
  );
  for (const key of HISTORY_METRIC_NUMERIC_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) sample[key] = value;
  }
  const hit = raw["cache_hit"];
  if (typeof hit === "boolean") sample.cache_hit = hit;
  return sample;
}
