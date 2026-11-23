/**
 * Plan 86 P1 — the `history_*` wire contract: limits, opaque tokens, runtime
 * guards and frame-budget arithmetic.
 *
 * WHY THIS FILE EXISTS
 *
 * The host serves workspace history with ZERO Pi processes. Everything the
 * client needs to talk to that service is therefore a network contract, not an
 * SDK contract: the Web and App owners need the same limits, the same closed
 * error vocabulary and the same token semantics as the server, without
 * importing `pi-coding-agent`. The wire types live in `types.ts` (the protocol
 * module owns its own vocabulary); this module owns the runtime rules.
 *
 * TOKENS ARE SELF-VALIDATING, NOT SIGNED
 *
 * A cursor/snapshot/body_ref is base64url(JSON) with a version and an explicit
 * workspace + session scope. The host never trusts a token's scope: it
 * re-derives the bucket from `daemon_id` and rejects any token whose `w`/`s`
 * does not match the request (`invalid_cursor`). A valid token therefore cannot
 * address another workspace's data even if it is copied verbatim — the token
 * carries scope for VALIDATION, never for RESOLUTION.
 *
 * Tokens contain no paths, no user text and no credentials. A body ref carries
 * `(entry, event, field, representation, sha256, total_bytes)` so the host can
 * detect a rewritten entry without keeping a sidecar in P1.
 */

import type {
  ClientMessage,
  HistoryBodyOkWire,
  HistoryBodyRefWire,
  HistoryBodyRepresentationWire,
  HistoryCurrentWire,
  HistoryErrorCodeWire,
  HistoryErrorWire,
  HistoryIndexStateWire,
  HistoryItemWire,
  HistoryListOkWire,
  HistoryReadOkWire,
  HistorySessionWire,
  ServerMessage,
  SessionHistoryEvent,
} from "./types.js";

// ── Limits (shared by server, Web and App) ───────────────────────────────────

/** `history_list` default page size. */
export const HISTORY_LIST_DEFAULT_LIMIT = 50;
/** `history_list` hard upper bound; larger requests are clamped, not rejected. */
export const HISTORY_LIST_MAX_LIMIT = 100;
/** `history_read` default page size, measured in transcript ENTRIES. */
export const HISTORY_READ_DEFAULT_LIMIT = 30;
/** `history_read` hard upper bound. */
export const HISTORY_READ_MAX_LIMIT = 100;
/** Bounded per-field preview carried on the wire (UTF-8 bytes / base64 chars). */
export const HISTORY_ROW_PREVIEW_BYTES = 4 * 1024;
/** Maximum DECODED bytes returned by one `history_body` call. */
export const HISTORY_BODY_CHUNK_BYTES = 64 * 1024;
/** Maximum size of one fully-encoded host frame, base64 envelope included. */
export const HISTORY_MAX_ENCODED_FRAME_BYTES = 256 * 1024;
/** Maximum `body_refs` a single WIRE item may carry (a pathological entry with
 *  thousands of blocks must not create an unfetchable 1 MiB item). This is a
 *  WIRE cap: an event with more omitted values continues on the next page under
 *  the same stable `event_id`, so nothing becomes unreachable. */
export const HISTORY_MAX_BODY_REFS_PER_ITEM = 16;
/**
 * Maximum refs the INDEX keeps for one event.
 *
 * The index is not the wire: it must hold every value it located, or the
 * remainder becomes unfetchable by any path. The bound only stops a corrupt or
 * adversarial projection row from growing without limit; `history_body` by
 * explicit field name still reaches anything above it.
 */
export const HISTORY_MAX_INDEXED_REFS_PER_EVENT = 1024;
/**
 * Largest single body the host will materialize. Plan 86 P2 replaces the P1
 * 16 MiB in-memory cap with the approved generation-sidecar disk budget:
 * 256 MiB total, LRU, and a body that cannot fit answers `body_too_large`
 * instead of being silently truncated. A 100 MiB giant entry is servable.
 */
export const HISTORY_BODY_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Generation-scoped body sidecar budget (disk, LRU). */
export const HISTORY_BODY_SIDECAR_BUDGET_BYTES = 256 * 1024 * 1024;
/** Host page cache budget (wire pages, Plan 86 §4.3). */
export const HISTORY_PAGE_CACHE_BYTES = 32 * 1024 * 1024;
/** First materialization above this size is asynchronous: the host answers
 *  `building` and materializes once (single-flight) instead of blocking the
 *  request path or returning an empty body. */
export const HISTORY_BODY_EAGER_MAX_BYTES = 256 * 1024;
/** Event identity/projection version. Clients cache item ids per projection. */
export const HISTORY_PROJECTION_VERSION = 1;
/** Suggested retry delay while the metadata scan is still `building`. */
export const HISTORY_DEFAULT_RETRY_AFTER_MS = 25;
/** Opaque token size cap. Tokens are tiny; anything larger is junk. */
export const HISTORY_TOKEN_MAX_CHARS = 8 * 1024;
/** Base64 of an Ed25519 public key (32 bytes → 44 chars). Used only to compute
 *  the worst-case envelope for the frame budget. */
export const HOST_PEER_KEY_CHARS = 44;

// ── Result types ─────────────────────────────────────────────────────────────

export interface HistoryParseFailure {
  ok: false;
  /** `invalid_request` for a malformed/out-of-range frame; `unsupported` for a
   *  well-formed frame carrying a representation/version this host cannot
   *  serve. */
  code: "invalid_request" | "unsupported";
  /** Developer-facing detail for tests/logs. NEVER put this on the wire. */
  detail: string;
}

export type HistoryParseResult<T> = { ok: true; value: T } | HistoryParseFailure;

export type HistoryRequestWire = Extract<
  ClientMessage,
  { type: "history_list" | "history_read" | "history_body" }
>;

export type HistoryReplyWire =
  | HistoryListOkWire
  | HistoryReadOkWire
  | HistoryBodyOkWire
  | HistoryErrorWire;

const HISTORY_REQUEST_TYPES = new Set(["history_list", "history_read", "history_body"]);
const HISTORY_REPLY_TYPES = new Set([
  "history_list_ok",
  "history_read_ok",
  "history_body_ok",
  "history_error",
]);
const HISTORY_INDEX_STATES: ReadonlySet<string> = new Set<HistoryIndexStateWire>([
  "ready",
  "building",
  "unavailable",
]);
const HISTORY_REPRESENTATIONS: ReadonlySet<string> = new Set<HistoryBodyRepresentationWire>([
  "text_utf8",
  "json_utf8",
  "binary",
]);
const HISTORY_ERROR_CODES: ReadonlySet<string> = new Set<HistoryErrorCodeWire>([
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

// ── Small validators ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxChars = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown, maxChars = 512): value is string | null {
  return value === null || isNonEmptyString(value, maxChars) || value === "";
}

function fail(code: HistoryParseFailure["code"], detail: string): HistoryParseFailure {
  return { ok: false, code, detail };
}

/** Clamp a requested list limit into the supported range. */
export function clampHistoryListLimit(limit: number | undefined): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : HISTORY_LIST_DEFAULT_LIMIT;
  return Math.min(HISTORY_LIST_MAX_LIMIT, Math.max(1, value));
}

/** Clamp a requested read limit into the supported range. */
export function clampHistoryReadLimit(limit: number | undefined): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : HISTORY_READ_DEFAULT_LIMIT;
  return Math.min(HISTORY_READ_MAX_LIMIT, Math.max(1, value));
}

// ── UTF-8 / base64 helpers ───────────────────────────────────────────────────

/**
 * Cut [text] to at most [maxBytes] UTF-8 bytes WITHOUT splitting a code point.
 *
 * A wire preview that ends in half a multi-byte character renders as U+FFFD in
 * every client, so the cut happens on code-point boundaries even though the
 * budget is expressed in bytes.
 */
export function utf8Preview(
  text: string,
  maxBytes: number = HISTORY_ROW_PREVIEW_BYTES,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return { text: out, truncated: true };
}

/** base64 length of [bytes] bytes, including padding. */
export function base64EncodedLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Strict base64 decode length, or null when [value] is not canonical base64. */
export function base64DecodedLength(value: string): number | null {
  if (typeof value !== "string") return null;
  if (value === "") return 0;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return decoded.length;
}

// ── Frame budget ─────────────────────────────────────────────────────────────

/**
 * Bytes one host frame occupies on the wire: the outer envelope
 * `{peer, room:"host", ct}` where `ct` is base64 of the inner JSON.
 *
 * The service uses this BEFORE handing a frame to the bridge, so a page that
 * would exceed 256 KiB is trimmed (and given a cursor) instead of being dropped
 * by the transport.
 */
export function encodedHostFrameBytes(inner: ServerMessage | string): number {
  const json = typeof inner === "string" ? inner : JSON.stringify(inner);
  const ct = base64EncodedLength(Buffer.byteLength(json, "utf8"));
  const overhead = Buffer.byteLength(
    JSON.stringify({ peer: "A".repeat(HOST_PEER_KEY_CHARS), room: "host", ct: "" }),
    "utf8",
  );
  return overhead + ct;
}

/** True when [inner] fits the plan's 256 KiB encoded-frame ceiling. */
export function fitsHistoryEncodedFrame(
  inner: ServerMessage,
  limit: number = HISTORY_MAX_ENCODED_FRAME_BYTES,
): boolean {
  return encodedHostFrameBytes(inner) <= limit;
}

// ── Opaque tokens ────────────────────────────────────────────────────────────

interface TokenCommon {
  v: 1;
  /** Token kind. */
  t: "lc" | "rc" | "sn" | "bd";
  /** Workspace (daemon id). Never a path. */
  w: string;
}

/** Encode a token payload. Callers build a versioned object, never raw JSON. */
export function encodeHistoryToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode a token to a plain object, or null when it is malformed, padded,
 * truncated or from an unknown version.
 */
export function decodeHistoryToken(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HISTORY_TOKEN_MAX_CHARS) return null;
  // base64url without padding; the canonical re-encode below rejects aliases.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["v"] !== 1) return null;
  if (Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url") !== raw) return null;
  return parsed;
}

/** Scope a token must match. */
export interface HistoryTokenScope {
  daemon_id: string;
  session_id?: string;
}

function scopeMatches(token: Record<string, unknown> & TokenCommon, scope: HistoryTokenScope): boolean {
  if (token.w !== scope.daemon_id) return false;
  if (scope.session_id !== undefined && token["s"] !== scope.session_id) return false;
  return true;
}

// List cursor: keyset boundary (mtime DESC, id DESC).

export interface HistoryListBoundary {
  mtime: number;
  id: string;
}

export function encodeHistoryListCursor(daemonId: string, boundary: HistoryListBoundary): string {
  return encodeHistoryToken({ v: 1, t: "lc", w: daemonId, k: [boundary.mtime, boundary.id] });
}

export function decodeHistoryListCursor(
  raw: unknown,
  scope: HistoryTokenScope,
): { ok: true; before: HistoryListBoundary } | { ok: false; code: "invalid_cursor" } {
  const token = decodeHistoryToken(raw);
  if (token === null || token["t"] !== "lc") return { ok: false, code: "invalid_cursor" };
  if (!scopeMatches(token as Record<string, unknown> & TokenCommon, scope)) {
    return { ok: false, code: "invalid_cursor" };
  }
  const key = token["k"];
  if (!Array.isArray(key) || key.length !== 2) return { ok: false, code: "invalid_cursor" };
  const [mtime, id] = key;
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return { ok: false, code: "invalid_cursor" };
  if (!isNonEmptyString(id, 512)) return { ok: false, code: "invalid_cursor" };
  return { ok: true, before: { mtime, id } };
}

// Read cursor: keyset boundary (timestamp ASC, entry id ASC) + generation.

export interface HistoryReadBoundary {
  timestamp: string;
  id: string;
}

/**
 * Position of a read PAGE SEQUENCE.
 *
 * Two mutually exclusive forms, both scoped to `(workspace, session)`:
 *
 * ENTRY form (`q` absent) — the P1 shape. `k` is the OLDEST primary entry of
 * the delivered page and the next page is STRICTLY OLDER than it. A page that
 * delivered every event of every entry it kept hands this out.
 *
 * RESUME form (`q` present) — `k` is absent. `q` is the NEWEST entry boundary
 * of the page window (INCLUSIVE), `n` its size in primary entries, and `a`/`r`
 * the resume position inside it: the newest `a` items of the window are already
 * delivered, and the item at index `a` (ascending order) has already shipped
 * its first `r` body refs. The next page re-derives EXACTLY that window and
 * continues — this is what makes a single giant entry (thousands of blocks, or
 * an event with more than `HISTORY_MAX_BODY_REFS_PER_ITEM` omitted values)
 * reachable instead of being dropped when the frame budget runs out.
 *
 * `h` is the FIXED byte high-water of the sequence (R5): every page answers
 * against that boundary and echoes it back unchanged, so an append performed
 * while a client is reading older pages can never leak into them.
 *
 * Every extension field is optional, so a cursor issued by an older host still
 * decodes (as a plain entry boundary). Clients MUST treat these tokens as
 * opaque; nothing here is stable API for them.
 */
export interface HistoryReadCursor {
  /** ENTRY form only: exclusive boundary of the next (older) page. */
  before: HistoryReadBoundary | null;
  generation: string;
  /** Fixed page-sequence byte high-water, or null for a legacy cursor. */
  high_water: number | null;
  /** RESUME form only: inclusive newest boundary of the pinned window. */
  anchor: HistoryReadBoundary | null;
  /** RESUME form: primary-entry window size. */
  window_limit: number | null;
  /** RESUME form: newest items already delivered. */
  delivered_items: number | null;
  /** RESUME form: body refs already delivered for the item at index `delivered_items`. */
  delivered_refs: number | null;
}

/** Cursor payload builder input. `anchor` switches to the RESUME form. */
export interface HistoryReadCursorInput {
  before?: HistoryReadBoundary;
  anchor?: HistoryReadBoundary;
  window_limit?: number;
  delivered_items?: number;
  delivered_refs?: number;
  high_water?: number | null;
}

export function encodeHistoryReadCursor(
  daemonId: string,
  sessionId: string,
  generation: string,
  input: HistoryReadCursorInput,
): string {
  const resume = input.anchor !== undefined;
  return encodeHistoryToken({
    v: 1,
    t: "rc",
    w: daemonId,
    s: sessionId,
    g: generation,
    ...(resume
      ? {
          q: [input.anchor!.timestamp, input.anchor!.id],
          n: input.window_limit ?? 0,
          a: input.delivered_items ?? 0,
          r: input.delivered_refs ?? 0,
        }
      : { k: [input.before!.timestamp, input.before!.id] }),
    ...(input.high_water !== undefined && input.high_water !== null ? { h: input.high_water } : {}),
  });
}

export function decodeHistoryReadCursor(
  raw: unknown,
  scope: HistoryTokenScope & { session_id: string },
): { ok: true; value: HistoryReadCursor } | { ok: false; code: "invalid_cursor" | "stale" } {
  const token = decodeHistoryToken(raw);
  if (token === null || token["t"] !== "rc") return { ok: false, code: "invalid_cursor" };
  if (!scopeMatches(token as Record<string, unknown> & TokenCommon, scope)) {
    return { ok: false, code: "invalid_cursor" };
  }
  const generation = token["g"];
  if (!isNonEmptyString(generation, 128)) return { ok: false, code: "invalid_cursor" };
  const highWater = optionalNonNegativeInteger(token["h"]);
  if (highWater === undefined) return { ok: false, code: "invalid_cursor" };

  const anchor = readBoundary(token["q"]);
  if (anchor.present) {
    if (anchor.value === null || token["k"] !== undefined) return { ok: false, code: "invalid_cursor" };
    const windowLimit = optionalNonNegativeInteger(token["n"]);
    const deliveredItems = optionalNonNegativeInteger(token["a"]);
    const deliveredRefs = optionalNonNegativeInteger(token["r"]);
    if (windowLimit === undefined || deliveredItems === undefined || deliveredRefs === undefined) {
      return { ok: false, code: "invalid_cursor" };
    }
    if (windowLimit === null || windowLimit < 1 || deliveredItems === null) {
      return { ok: false, code: "invalid_cursor" };
    }
    return {
      ok: true,
      value: {
        before: null,
        generation,
        high_water: highWater,
        anchor: anchor.value,
        window_limit: windowLimit,
        delivered_items: deliveredItems,
        delivered_refs: deliveredRefs ?? 0,
      },
    };
  }

  const boundary = readBoundary(token["k"]);
  if (!boundary.present || boundary.value === null) return { ok: false, code: "invalid_cursor" };
  return {
    ok: true,
    value: {
      before: boundary.value,
      generation,
      high_water: highWater,
      anchor: null,
      window_limit: null,
      delivered_items: null,
      delivered_refs: null,
    },
  };
}

/** `[timestamp, id]` pair decode. `present` distinguishes absent from invalid. */
function readBoundary(value: unknown): { present: boolean; value: HistoryReadBoundary | null } {
  if (value === undefined) return { present: false, value: null };
  if (!Array.isArray(value) || value.length !== 2) return { present: true, value: null };
  const [timestamp, id] = value;
  if (!isNonEmptyString(timestamp, 128) || !isNonEmptyString(id, 512)) return { present: true, value: null };
  return { present: true, value: { timestamp, id } };
}

/** `undefined` = malformed, `null` = absent (legacy token), else the value. */
function optionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) return null;
  return isNonNegativeInteger(value) ? value : undefined;
}

// Snapshot: generation + byte high-water at page time.

export interface HistorySnapshotValue {
  generation: string;
  high_water: number;
}

export function encodeHistorySnapshot(
  daemonId: string,
  sessionId: string,
  generation: string,
  highWater: number,
): string {
  return encodeHistoryToken({
    v: 1,
    t: "sn",
    w: daemonId,
    s: sessionId,
    g: generation,
    hw: highWater,
  });
}

export function decodeHistorySnapshot(
  raw: unknown,
  scope: HistoryTokenScope & { session_id: string },
): { ok: true; value: HistorySnapshotValue } | { ok: false; code: "invalid_cursor" } {
  const token = decodeHistoryToken(raw);
  if (token === null || token["t"] !== "sn") return { ok: false, code: "invalid_cursor" };
  if (!scopeMatches(token as Record<string, unknown> & TokenCommon, scope)) {
    return { ok: false, code: "invalid_cursor" };
  }
  const generation = token["g"];
  const highWater = token["hw"];
  if (!isNonEmptyString(generation, 128) || !isNonNegativeInteger(highWater)) {
    return { ok: false, code: "invalid_cursor" };
  }
  return { ok: true, value: { generation, high_water: highWater } };
}

// Body ref: snapshot generation + entry/event/field identity + digest.

export interface HistoryBodyRefPayload {
  generation: string;
  entry_id: string;
  event_id: string;
  field: string;
  representation: HistoryBodyRepresentationWire;
  mime: string | null;
  total_bytes: number;
  /** sha256 (hex) of the FULL representation bytes. */
  digest: string;
}

export function encodeHistoryBodyRef(
  daemonId: string,
  sessionId: string,
  payload: HistoryBodyRefPayload,
): string {
  return encodeHistoryToken({
    v: 1,
    t: "bd",
    w: daemonId,
    s: sessionId,
    g: payload.generation,
    e: payload.entry_id,
    ev: payload.event_id,
    f: payload.field,
    r: payload.representation,
    m: payload.mime,
    tb: payload.total_bytes,
    d: payload.digest,
  });
}

export function decodeHistoryBodyRef(
  raw: unknown,
  scope: HistoryTokenScope & { session_id: string },
): { ok: true; value: HistoryBodyRefPayload } | { ok: false; code: "invalid_cursor" | "unsupported" } {
  const token = decodeHistoryToken(raw);
  if (token === null || token["t"] !== "bd") return { ok: false, code: "invalid_cursor" };
  if (!scopeMatches(token as Record<string, unknown> & TokenCommon, scope)) {
    return { ok: false, code: "invalid_cursor" };
  }
  const generation = token["g"];
  const entryId = token["e"];
  const eventId = token["ev"];
  const field = token["f"];
  const representation = token["r"];
  const mime = token["m"];
  const totalBytes = token["tb"];
  const digest = token["d"];
  if (
    !isNonEmptyString(generation, 128) ||
    !isNonEmptyString(entryId, 512) ||
    !isNonEmptyString(eventId, 1024) ||
    !isNonEmptyString(field, 128) ||
    typeof representation !== "string" ||
    !HISTORY_REPRESENTATIONS.has(representation) ||
    (mime !== null && typeof mime !== "string") ||
    !isNonNegativeInteger(totalBytes) ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return { ok: false, code: "unsupported" };
  }
  return {
    ok: true,
    value: {
      generation,
      entry_id: entryId,
      event_id: eventId,
      field,
      representation: representation as HistoryBodyRepresentationWire,
      mime: mime as string | null,
      total_bytes: totalBytes,
      digest,
    },
  };
}

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Build a fully-populated `history_error` (explicit nulls, no host text). */
export function historyErrorReply(
  inReplyTo: string,
  code: HistoryErrorCodeWire,
  scope: {
    daemon_id?: string | null;
    session_id?: string | null;
    revision?: string | null;
    snapshot?: string | null;
    retry_after_ms?: number | null;
  } = {},
): HistoryErrorWire {
  return {
    type: "history_error",
    in_reply_to: inReplyTo,
    code,
    daemon_id: scope.daemon_id ?? null,
    session_id: scope.session_id ?? null,
    revision: scope.revision ?? null,
    snapshot: scope.snapshot ?? null,
    retry_after_ms: scope.retry_after_ms ?? null,
  };
}

/** True when [value] is one of the request frames this module guards. */
export function isHistoryRequestType(value: unknown): value is HistoryRequestWire["type"] {
  return typeof value === "string" && HISTORY_REQUEST_TYPES.has(value);
}

// ── Request guards ───────────────────────────────────────────────────────────

/**
 * Validate one `history_*` frame before it reaches the service.
 *
 * Extra unknown members are tolerated (forward compatibility); a KNOWN member
 * with the wrong type is rejected. `limit` is accepted as any positive integer
 * and clamped later, so a client asking for 1000 gets 100 rather than an error.
 */
export function parseHistoryRequest(value: unknown): HistoryParseResult<HistoryRequestWire> {
  if (!isRecord(value)) return fail("invalid_request", "request is not an object");
  const type = value["type"];
  if (!isHistoryRequestType(type)) return fail("invalid_request", "unknown history request type");
  const id = value["id"];
  if (!isNonEmptyString(id, 512)) return fail("invalid_request", "id must be a non-empty string");
  const daemonId = value["daemon_id"];
  if (!isNonEmptyString(daemonId, 128)) {
    return fail("invalid_request", "daemon_id must be a non-empty string");
  }

  if (type === "history_list") {
    const limit = value["limit"];
    if (limit !== undefined && !(isNonNegativeInteger(limit) && limit > 0)) {
      return fail("invalid_request", "limit must be a positive integer");
    }
    const before = value["before"];
    if (before !== undefined && !isNonEmptyString(before, HISTORY_TOKEN_MAX_CHARS)) {
      return fail("invalid_request", "before must be an opaque token");
    }
    const ifRevision = value["if_revision"];
    if (ifRevision !== undefined && !isNonEmptyString(ifRevision, 256)) {
      return fail("invalid_request", "if_revision must be an opaque revision");
    }
    return {
      ok: true,
      value: {
        type,
        id,
        daemon_id: daemonId,
        ...(limit !== undefined ? { limit } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(ifRevision !== undefined ? { if_revision: ifRevision } : {}),
      },
    };
  }

  const sessionId = value["session_id"];
  if (!isNonEmptyString(sessionId, 512)) {
    return fail("invalid_request", "session_id must be a non-empty string");
  }

  if (type === "history_read") {
    const limit = value["limit"];
    if (limit !== undefined && !(isNonNegativeInteger(limit) && limit > 0)) {
      return fail("invalid_request", "limit must be a positive integer");
    }
    const before = value["before"];
    if (before !== undefined && !isNonEmptyString(before, HISTORY_TOKEN_MAX_CHARS)) {
      return fail("invalid_request", "before must be an opaque token");
    }
    const snapshot = value["snapshot"];
    if (snapshot !== undefined && !isNonEmptyString(snapshot, HISTORY_TOKEN_MAX_CHARS)) {
      return fail("invalid_request", "snapshot must be an opaque token");
    }
    const ifRevision = value["if_revision"];
    if (ifRevision !== undefined && !isNonEmptyString(ifRevision, 256)) {
      return fail("invalid_request", "if_revision must be an opaque revision");
    }
    return {
      ok: true,
      value: {
        type,
        id,
        daemon_id: daemonId,
        session_id: sessionId,
        ...(limit !== undefined ? { limit } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...(ifRevision !== undefined ? { if_revision: ifRevision } : {}),
      },
    };
  }

  const snapshot = value["snapshot"];
  if (!isNonEmptyString(snapshot, HISTORY_TOKEN_MAX_CHARS)) {
    return fail("invalid_request", "snapshot is required for history_body");
  }
  const bodyRef = value["body_ref"];
  if (!isNonEmptyString(bodyRef, HISTORY_TOKEN_MAX_CHARS)) {
    return fail("invalid_request", "body_ref must be an opaque token");
  }
  const offset = value["offset_bytes"];
  if (!isNonNegativeInteger(offset)) {
    return fail("invalid_request", "offset_bytes must be a non-negative integer");
  }
  return {
    ok: true,
    value: {
      type,
      id,
      daemon_id: daemonId,
      session_id: sessionId,
      snapshot,
      body_ref: bodyRef,
      offset_bytes: offset,
    },
  };
}

// ── Reply guards (Web / App / tests) ─────────────────────────────────────────

/** Validate one existing `SessionHistoryEvent` without re-typing its union. */
export function parseSessionHistoryEvent(value: unknown): HistoryParseResult<SessionHistoryEvent> {
  if (!isRecord(value)) return fail("invalid_request", "event is not an object");
  const ts = value["ts"];
  if (typeof ts !== "number" || !Number.isFinite(ts)) return fail("invalid_request", "event.ts");
  const type = value["type"];
  switch (type) {
    case "user_input": {
      if (!isNonEmptyString(value["id"], 1024)) return fail("invalid_request", "user_input.id");
      if (typeof value["text"] !== "string") return fail("invalid_request", "user_input.text");
      const images = value["images"];
      if (images !== undefined) {
        if (!Array.isArray(images)) return fail("invalid_request", "user_input.images");
        for (const image of images) {
          if (!isRecord(image) || typeof image["data"] !== "string" || typeof image["mime"] !== "string") {
            return fail("invalid_request", "user_input.images[]");
          }
        }
      }
      return { ok: true, value: value as unknown as SessionHistoryEvent };
    }
    case "tool_request": {
      if (typeof value["tool_call_id"] !== "string") return fail("invalid_request", "tool_request.tool_call_id");
      if (typeof value["tool"] !== "string") return fail("invalid_request", "tool_request.tool");
      if (!isRecord(value["args"])) return fail("invalid_request", "tool_request.args");
      return { ok: true, value: value as unknown as SessionHistoryEvent };
    }
    case "tool_result": {
      if (typeof value["tool_call_id"] !== "string") return fail("invalid_request", "tool_result.tool_call_id");
      if (value["error"] !== undefined && typeof value["error"] !== "string") {
        return fail("invalid_request", "tool_result.error");
      }
      return { ok: true, value: value as unknown as SessionHistoryEvent };
    }
    case "agent_message": {
      if (!isNonEmptyString(value["in_reply_to"], 1024)) return fail("invalid_request", "agent_message.in_reply_to");
      if (typeof value["text"] !== "string") return fail("invalid_request", "agent_message.text");
      const usage = value["usage"];
      if (usage !== undefined && !isRecord(usage)) return fail("invalid_request", "agent_message.usage");
      return { ok: true, value: value as unknown as SessionHistoryEvent };
    }
    case "compaction": {
      if (typeof value["summary"] !== "string") return fail("invalid_request", "compaction.summary");
      if (typeof value["tokens_before"] !== "number") return fail("invalid_request", "compaction.tokens_before");
      return { ok: true, value: value as unknown as SessionHistoryEvent };
    }
    default:
      return fail("unsupported", `unknown event type: ${String(type)}`);
  }
}

function parseHistorySession(value: unknown): HistoryParseResult<HistorySessionWire> {
  if (!isRecord(value)) return fail("invalid_request", "session is not an object");
  if (!isNonEmptyString(value["id"], 1024)) return fail("invalid_request", "session.id");
  const name = value["name"];
  if (name !== null && typeof name !== "string") return fail("invalid_request", "session.name");
  const mtime = value["mtime"];
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return fail("invalid_request", "session.mtime");
  const preview = value["preview"];
  if (preview !== null && typeof preview !== "string") return fail("invalid_request", "session.preview");
  return { ok: true, value: { id: value["id"], name: name as string | null, mtime, preview: preview as string | null } };
}

function parseHistoryBodyRefWire(value: unknown): HistoryParseResult<HistoryBodyRefWire> {
  if (!isRecord(value)) return fail("invalid_request", "body_ref is not an object");
  if (!isNonEmptyString(value["ref"], HISTORY_TOKEN_MAX_CHARS)) return fail("invalid_request", "body_ref.ref");
  if (!isNonEmptyString(value["field"], 128)) return fail("invalid_request", "body_ref.field");
  const representation = value["representation"];
  if (typeof representation !== "string" || !HISTORY_REPRESENTATIONS.has(representation)) {
    return fail("invalid_request", "body_ref.representation");
  }
  const mime = value["mime"];
  if (mime !== null && typeof mime !== "string") return fail("invalid_request", "body_ref.mime");
  if (!isNonNegativeInteger(value["total_bytes"])) return fail("invalid_request", "body_ref.total_bytes");
  const preview = value["preview"];
  if (preview !== null && typeof preview !== "string") return fail("invalid_request", "body_ref.preview");
  if (typeof value["preview_truncated"] !== "boolean") {
    return fail("invalid_request", "body_ref.preview_truncated");
  }
  return {
    ok: true,
    value: {
      ref: value["ref"],
      field: value["field"],
      representation: representation as HistoryBodyRepresentationWire,
      mime: mime as string | null,
      total_bytes: value["total_bytes"],
      preview: preview as string | null,
      preview_truncated: value["preview_truncated"],
    },
  };
}

function parseHistoryItem(value: unknown): HistoryParseResult<HistoryItemWire> {
  if (!isRecord(value)) return fail("invalid_request", "item is not an object");
  if (!isNonEmptyString(value["event_id"], 2048)) return fail("invalid_request", "item.event_id");
  if (!isNonEmptyString(value["entry_id"], 1024)) return fail("invalid_request", "item.entry_id");
  const event = parseSessionHistoryEvent(value["event"]);
  if (!event.ok) return event;
  const item: HistoryItemWire = {
    event_id: value["event_id"],
    entry_id: value["entry_id"],
    event: event.value,
  };
  const refs = value["body_refs"];
  if (refs !== undefined) {
    if (!Array.isArray(refs) || refs.length > HISTORY_MAX_BODY_REFS_PER_ITEM) {
      return fail("invalid_request", "item.body_refs");
    }
    const parsed: HistoryBodyRefWire[] = [];
    for (const ref of refs) {
      const result = parseHistoryBodyRefWire(ref);
      if (!result.ok) return result;
      parsed.push(result.value);
    }
    item.body_refs = parsed;
  }
  if (value["parent"] !== undefined) {
    if (value["parent"] !== true) return fail("invalid_request", "item.parent");
    item.parent = true;
  }
  if (value["truncated"] !== undefined) {
    if (typeof value["truncated"] !== "boolean") return fail("invalid_request", "item.truncated");
    item.truncated = value["truncated"];
  }
  return { ok: true, value: item };
}

function parseHistoryCurrent(value: unknown): HistoryParseResult<HistoryCurrentWire> {
  if (!isRecord(value)) return fail("invalid_request", "current is not an object");
  const sessionId = value["session_id"];
  if (sessionId !== null && !isNonEmptyString(sessionId, 1024)) return fail("invalid_request", "current.session_id");
  const ready = value["ready"];
  if (ready !== null && typeof ready !== "boolean") return fail("invalid_request", "current.ready");
  const state = value["state"];
  if (state !== null && !["running", "starting", "crashed", "stopped"].includes(String(state))) {
    return fail("invalid_request", "current.state");
  }
  const source = value["source"];
  if (source !== "runtime" && source !== "unknown") return fail("invalid_request", "current.source");
  return {
    ok: true,
    value: {
      session_id: sessionId as string | null,
      ready: ready as boolean | null,
      state: state as HistoryCurrentWire["state"],
      source,
    },
  };
}

function parseHistoryListReply(value: Record<string, unknown>): HistoryParseResult<HistoryListOkWire> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("invalid_request", "in_reply_to");
  if (!isNonEmptyString(value["daemon_id"], 128)) return fail("invalid_request", "daemon_id");
  const revision = value["revision"];
  if (revision !== null && typeof revision !== "string") return fail("invalid_request", "revision");
  const indexState = value["index_state"];
  if (typeof indexState !== "string" || !HISTORY_INDEX_STATES.has(indexState)) {
    return fail("invalid_request", "index_state");
  }
  const current = parseHistoryCurrent(value["current"]);
  if (!current.ok) return current;
  const sessionsRaw = value["sessions"];
  if (!Array.isArray(sessionsRaw) || sessionsRaw.length > HISTORY_LIST_MAX_LIMIT) {
    return fail("invalid_request", "sessions");
  }
  const sessions: HistorySessionWire[] = [];
  for (const row of sessionsRaw) {
    const parsed = parseHistorySession(row);
    if (!parsed.ok) return parsed;
    sessions.push(parsed.value);
  }
  const nextCursor = value["next_cursor"];
  if (nextCursor !== null && !isNonEmptyString(nextCursor, HISTORY_TOKEN_MAX_CHARS)) {
    return fail("invalid_request", "next_cursor");
  }
  if (typeof value["has_more"] !== "boolean") return fail("invalid_request", "has_more");
  const retry = value["retry_after_ms"];
  if (retry !== null && !isNonNegativeInteger(retry)) return fail("invalid_request", "retry_after_ms");
  return {
    ok: true,
    value: {
      type: "history_list_ok",
      in_reply_to: value["in_reply_to"],
      daemon_id: value["daemon_id"],
      revision: revision as string | null,
      index_state: indexState as HistoryIndexStateWire,
      current: current.value,
      sessions,
      next_cursor: nextCursor as string | null,
      has_more: value["has_more"],
      retry_after_ms: retry as number | null,
    },
  };
}

function parseHistoryReadReply(value: Record<string, unknown>): HistoryParseResult<HistoryReadOkWire> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("invalid_request", "in_reply_to");
  if (!isNonEmptyString(value["daemon_id"], 128)) return fail("invalid_request", "daemon_id");
  if (!isNonEmptyString(value["session_id"], 1024)) return fail("invalid_request", "session_id");
  if (!isNonEmptyString(value["snapshot"], HISTORY_TOKEN_MAX_CHARS)) return fail("invalid_request", "snapshot");
  if (!isNonEmptyString(value["revision"], 256)) return fail("invalid_request", "revision");
  if (!isNonNegativeInteger(value["projection"])) return fail("invalid_request", "projection");
  const session = parseHistorySession(value["session"]);
  if (!session.ok) return session;
  const itemsRaw = value["items"];
  if (!Array.isArray(itemsRaw) || itemsRaw.length > 2048) return fail("invalid_request", "items");
  const items: HistoryItemWire[] = [];
  for (const row of itemsRaw) {
    const parsed = parseHistoryItem(row);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  const olderCursor = value["older_cursor"];
  if (olderCursor !== null && !isNonEmptyString(olderCursor, HISTORY_TOKEN_MAX_CHARS)) {
    return fail("invalid_request", "older_cursor");
  }
  if (typeof value["has_older"] !== "boolean") return fail("invalid_request", "has_older");
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

function parseHistoryBodyReply(value: Record<string, unknown>): HistoryParseResult<HistoryBodyOkWire> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("invalid_request", "in_reply_to");
  if (!isNonEmptyString(value["daemon_id"], 128)) return fail("invalid_request", "daemon_id");
  if (!isNonEmptyString(value["session_id"], 1024)) return fail("invalid_request", "session_id");
  if (!isNonEmptyString(value["snapshot"], HISTORY_TOKEN_MAX_CHARS)) return fail("invalid_request", "snapshot");
  if (!isNonEmptyString(value["body_ref"], HISTORY_TOKEN_MAX_CHARS)) return fail("invalid_request", "body_ref");
  const representation = value["representation"];
  if (typeof representation !== "string" || !HISTORY_REPRESENTATIONS.has(representation)) {
    return fail("invalid_request", "representation");
  }
  const mime = value["mime"];
  if (mime !== null && typeof mime !== "string") return fail("invalid_request", "mime");
  const offset = value["offset_bytes"];
  const next = value["next_offset_bytes"];
  const total = value["total_bytes"];
  if (!isNonNegativeInteger(offset) || !isNonNegativeInteger(next) || !isNonNegativeInteger(total)) {
    return fail("invalid_request", "body offsets");
  }
  if (offset > total || next < offset || next > total) {
    return fail("invalid_request", "body offsets out of range");
  }
  const data = value["data"];
  if (typeof data !== "string") return fail("invalid_request", "data");
  const decoded = base64DecodedLength(data);
  if (decoded === null) return fail("invalid_request", "data is not base64");
  if (decoded !== next - offset) return fail("invalid_request", "data length != chunk length");
  if (decoded > HISTORY_BODY_CHUNK_BYTES) return fail("invalid_request", "chunk exceeds 64 KiB");
  return {
    ok: true,
    value: {
      type: "history_body_ok",
      in_reply_to: value["in_reply_to"],
      daemon_id: value["daemon_id"],
      session_id: value["session_id"],
      snapshot: value["snapshot"],
      body_ref: value["body_ref"],
      representation: representation as HistoryBodyRepresentationWire,
      mime: mime as string | null,
      offset_bytes: offset,
      next_offset_bytes: next,
      total_bytes: total,
      data,
    },
  };
}

function parseHistoryErrorReply(value: Record<string, unknown>): HistoryParseResult<HistoryErrorWire> {
  if (!isNonEmptyString(value["in_reply_to"], 512)) return fail("invalid_request", "in_reply_to");
  const code = value["code"];
  if (typeof code !== "string" || !HISTORY_ERROR_CODES.has(code)) return fail("invalid_request", "code");
  const daemonId = value["daemon_id"];
  if (!isNullableString(daemonId, 128)) return fail("invalid_request", "daemon_id");
  const sessionId = value["session_id"];
  if (!isNullableString(sessionId, 1024)) return fail("invalid_request", "session_id");
  const revision = value["revision"];
  if (!isNullableString(revision, 256)) return fail("invalid_request", "revision");
  const snapshot = value["snapshot"];
  if (!isNullableString(snapshot, HISTORY_TOKEN_MAX_CHARS)) return fail("invalid_request", "snapshot");
  const retry = value["retry_after_ms"];
  if (retry !== null && !isNonNegativeInteger(retry)) return fail("invalid_request", "retry_after_ms");
  return {
    ok: true,
    value: {
      type: "history_error",
      in_reply_to: value["in_reply_to"],
      code: code as HistoryErrorCodeWire,
      daemon_id: daemonId as string | null,
      session_id: sessionId as string | null,
      revision: revision as string | null,
      snapshot: snapshot as string | null,
      retry_after_ms: retry as number | null,
    },
  };
}

/** Validate one `history_*` REPLY (used by clients and by contract tests). */
export function parseHistoryReply(value: unknown): HistoryParseResult<HistoryReplyWire> {
  if (!isRecord(value)) return fail("invalid_request", "reply is not an object");
  const type = value["type"];
  if (typeof type !== "string" || !HISTORY_REPLY_TYPES.has(type)) {
    return fail("invalid_request", "unknown history reply type");
  }
  switch (type) {
    case "history_list_ok":
      return parseHistoryListReply(value);
    case "history_read_ok":
      return parseHistoryReadReply(value);
    case "history_body_ok":
      return parseHistoryBodyReply(value);
    default:
      return parseHistoryErrorReply(value);
  }
}
