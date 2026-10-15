/**
 * Stored web session — Wave 2 foundation (plan 69 W4 persistence).
 *
 * The web client keeps ONE record under a fixed key so a page reload can
 * resume a pairing without pasting the code again. The record is exactly the
 * five fields below and nothing else: no private key, no pending request, no
 * transcript, no random leftover. Anything on disk that does not match the
 * schema is refused AND removed — a stale/hand-edited record must never become
 * a half-valid session.
 *
 * NO BROWSER API AT MODULE SCOPE: `localStorage` is read lazily through
 * `browserSessionStorage()` (and only when a caller asks), so importing this
 * module from a Server Component neither touches `window` nor throws. Tests
 * inject any `StorageLike`. Errors are typed with fixed text: a raw
 * `DOMException` (quota, private mode, disabled storage) never reaches the UI,
 * and a failed write is never reported as success.
 */

import {
  HOST_WEB_ROOM_ID,
  normalizeRelayUrl,
} from "./protocol.ts";

/** Frozen storage key — a new schema means a new key, never a migration. */
export const SESSION_STORAGE_KEY = "remote-pi-web-session-v1";

/** The exact persisted shape (five fields, all strings). */
export interface StoredSession {
  /** Relay URL, normalized to `ws(s)://` (no trailing slash). */
  relayUrl: string;
  /** Host Pi-key: canonical standard base64 of 32 bytes (padded). */
  hostEpk: string;
  /** Session/workspace name — preview only. */
  name: string;
  /** Room the pair_request goes to; only the host room is supported here. */
  roomId: string;
  /** Bearer pairing token. Mode unknown (persistent or ephemeral). */
  token: string;
}

/** Structural subset of `Storage` — injected in tests, acquired lazily in
 *  the browser. Kept structural so no DOM lib dependency is implied. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistenceErrorCode =
  | "storage_unavailable"
  | "storage_read_failed"
  | "storage_write_failed"
  | "storage_remove_failed"
  | "invalid_record";

/** Fixed, client-authored text — the underlying exception is never echoed. */
const PERSISTENCE_MESSAGES: Readonly<Record<PersistenceErrorCode, string>> = {
  storage_unavailable: "Local storage is unavailable in this browser.",
  storage_read_failed: "Could not read the saved session.",
  storage_write_failed: "Could not save the session.",
  storage_remove_failed: "Could not delete the saved session.",
  invalid_record: "The saved session is invalid and was discarded.",
};

export class SessionPersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(PERSISTENCE_MESSAGES[code]);
    this.name = "SessionPersistenceError";
    this.code = code;
  }
}

const SESSION_FIELDS: readonly (keyof StoredSession)[] = [
  "relayUrl",
  "hostEpk",
  "name",
  "roomId",
  "token",
];

// ── record schema ───────────────────────────────────────────────────────────

/** Canonical standard base64 of exactly 32 bytes (padded, round-trips). */
function isCanonicalEpk(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  let bytes: Uint8Array;
  try {
    const binary = atob(value);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return false;
  }
  if (bytes.length !== 32) return false;
  let reencoded = "";
  for (let i = 0; i < bytes.length; i += 1) reencoded += String.fromCharCode(bytes[i]);
  return btoa(reencoded) === value; // canonical (no alternate encodings)
}

/**
 * Validates the five schema fields in place. Strict per field: non-blank
 * string with an OWN value (`Object.hasOwn`, so a prototype-inherited
 * `toString`/`constructor` can never satisfy a field), canonical 32-byte
 * standard base64 `hostEpk`, supported `roomId`, safe normalized `relayUrl`.
 * Throws `SessionPersistenceError("invalid_record")` — never a pair/URI error.
 */
function validateSessionFields(record: Record<string, unknown>): StoredSession {
  for (const field of SESSION_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      throw new SessionPersistenceError("invalid_record");
    }
    const fieldValue = record[field];
    // Blank is NOT a value: `""` and `"   "` are both refused, so a session
    // cannot be persisted with a whitespace token or name.
    if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
      throw new SessionPersistenceError("invalid_record");
    }
  }
  if (!isCanonicalEpk(record.hostEpk)) {
    throw new SessionPersistenceError("invalid_record");
  }
  if (record.roomId !== HOST_WEB_ROOM_ID) {
    throw new SessionPersistenceError("invalid_record");
  }
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(record.relayUrl as string);
  } catch {
    throw new SessionPersistenceError("invalid_record");
  }
  return {
    relayUrl,
    hostEpk: record.hostEpk as string,
    name: record.name as string,
    roomId: record.roomId as string,
    token: record.token as string,
  };
}

/**
 * Validates an unknown value as a `StoredSession`. Strict: unknown keys are
 * refused (a record on disk is exactly this record) on top of the per-field
 * rules in `validateSessionFields`.
 */
export function parseStoredSession(value: unknown): StoredSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionPersistenceError("invalid_record");
  }
  const record = value as Record<string, unknown>;
  // Exactly the five own schema keys: an inherited key is not an own key, and
  // an extra own key means this is not this record.
  for (const key of Object.keys(record)) {
    if (!(SESSION_FIELDS as readonly string[]).includes(key)) {
      throw new SessionPersistenceError("invalid_record");
    }
  }
  return validateSessionFields(record);
}

/** Parses the stored JSON text. Malformed JSON → `invalid_record`. */
export function parseStoredSessionJson(raw: string): StoredSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionPersistenceError("invalid_record");
  }
  return parseStoredSession(parsed);
}

/**
 * Serializes ONLY the five schema fields (in a fixed order). Extra properties
 * on the argument (`privateKey`, `pending`, a transcript, …) are dropped by
 * construction and can never reach disk; the five fields themselves are still
 * validated, so a bad session is refused instead of persisted.
 */
export function serializeStoredSession(session: StoredSession): string {
  const source = session as unknown as Record<string, unknown>;
  const clean = validateSessionFields({
    relayUrl: source.relayUrl,
    hostEpk: source.hostEpk,
    name: source.name,
    roomId: source.roomId,
    token: source.token,
  });
  return JSON.stringify({
    relayUrl: clean.relayUrl,
    hostEpk: clean.hostEpk,
    name: clean.name,
    roomId: clean.roomId,
    token: clean.token,
  });
}

// ── storage plumbing ────────────────────────────────────────────────────────

/**
 * Reads `globalThis.localStorage` lazily. Returns `null` when there is no
 * browser storage (server render, SSR pass) — never throws, never caches a
 * module-level handle. Access itself can throw (Safari private mode, disabled
 * cookies) and is reported as `storage_unavailable`.
 */
export function browserSessionStorage(): StorageLike | null {
  let candidate: StorageLike | undefined;
  try {
    candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    // Access itself can throw (Safari private mode, disabled cookies).
    throw new SessionPersistenceError("storage_unavailable");
  }
  if (!candidate) return null;
  try {
    // Touch the API so a throwing implementation fails here, not later.
    candidate.getItem(SESSION_STORAGE_KEY);
  } catch {
    throw new SessionPersistenceError("storage_unavailable");
  }
  return candidate;
}

/**
 * Loads the stored session, or `null` when there is none.
 *
 * A record that fails validation (malformed JSON, unknown/extra key, bad epk,
 * unsupported room, unsafe relay URL) is REMOVED and reported as `null`: a
 * corrupt record must not linger and must not become a partial session. Read
 * and removal failures surface as typed errors rather than silence.
 */
export function loadStoredSession(storage: StorageLike): StoredSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    throw new SessionPersistenceError("storage_read_failed");
  }
  if (raw === null) return null;

  try {
    return parseStoredSessionJson(raw);
  } catch (err) {
    if (!(err instanceof SessionPersistenceError)) {
      throw new SessionPersistenceError("invalid_record");
    }
    // Corrupt → drop it (best effort, but a failing removal stays visible).
    try {
      storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      throw new SessionPersistenceError("storage_remove_failed");
    }
    return null;
  }
}

/**
 * Persists the session. Throws `storage_write_failed` when the write does not
 * land — a write is never assumed to have succeeded, and the stored value is
 * re-read to confirm (a storage stub that silently swallows writes is caught
 * here rather than at the next page load).
 */
export function saveStoredSession(storage: StorageLike, session: StoredSession): void {
  const serialized = serializeStoredSession(session);
  try {
    storage.setItem(SESSION_STORAGE_KEY, serialized);
  } catch {
    throw new SessionPersistenceError("storage_write_failed");
  }
  let readBack: string | null;
  try {
    readBack = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    throw new SessionPersistenceError("storage_write_failed");
  }
  if (readBack !== serialized) {
    throw new SessionPersistenceError("storage_write_failed");
  }
}

/**
 * Removes the stored session. Explicit and unconditional: an already-empty or
 * corrupt record is still cleared (the caller asked for it), and a removal
 * that fails is reported — never swallowed.
 */
export function clearStoredSession(storage: StorageLike): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    throw new SessionPersistenceError("storage_remove_failed");
  }
}

export function isSessionPersistenceError(value: unknown): value is SessionPersistenceError {
  return value instanceof SessionPersistenceError;
}
