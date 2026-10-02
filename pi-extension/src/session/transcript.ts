/**
 * Plan 01 (Wave 0) — transcript reading, active-branch filtering and cursor
 * pagination.
 *
 * Ported from `zerray/pi-remote-control`'s `src/transcript-pagination.ts` and
 * `src/session-transcript.ts`. That project runs a long-lived daemon which
 * reads the Pi session JSONL file to serve transcript pages. We have no daemon,
 * so the same read-side work runs inside the extension.
 *
 * The daemon there also normalizes Pi messages into a public `TranscriptMessage`
 * shape. We keep using our own `SessionHistoryEvent` wire shape instead, so
 * this module only owns: reading entries, filtering to the active branch, and
 * slicing with an opaque cursor.
 */

import { readFileSync } from "node:fs";


/** One `type:"message"` entry from the Pi session JSONL file. */
export interface TranscriptEntry {
  /** Pi session entry id — the canonical message id. */
  id: string;
  parentId: string | null;
  timestamp: string;
  /** The raw Pi `AgentMessage` (`{ role, content, ... }`). */
  message: Record<string, unknown>;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** Cursor for the next older page, or null when nothing older remains. */
  olderCursor: string | null;
  hasOlder: boolean;
}

export class InvalidTranscriptCursorError extends Error {
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidTranscriptCursorError";
  }
}

/**
 * Encode a cursor. Base64url of the `createdAt` timestamp — opaque to clients
 * but self-validating, so a forged cursor cannot be smuggled into a filter.
 */
export function encodeTranscriptCursor(createdAt: string): string {
  return Buffer.from(createdAt, "utf8").toString("base64url");
}

export function decodeTranscriptCursor(cursor: string): string {
  try {
    // Round-trip check rejects both malformed base64 and non-canonical
    // encodings, so `decode(encode(x)) === x` is guaranteed for valid input.
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidTranscriptCursorError();
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!decoded || Number.isNaN(Date.parse(decoded)) || encodeTranscriptCursor(decoded) !== cursor) {
      throw new InvalidTranscriptCursorError();
    }
    return decoded;
  } catch (error) {
    if (error instanceof InvalidTranscriptCursorError) throw error;
    throw new InvalidTranscriptCursorError();
  }
}

/**
 * The most recent `limit` entries, newest-last (chronological order preserved).
 */
export function recentTranscriptWindow(entries: TranscriptEntry[], limit: number): TranscriptPage {
  return pageFromCandidates(normalizeEntries(entries), limit);
}

/**
 * The page strictly older than `beforeCursor`. The cursor must correspond to an
 * entry that exists in the current transcript — a cursor from a different
 * session (or a stale branch) is rejected rather than silently mis-sliced.
 */
export function olderTranscriptPage(entries: TranscriptEntry[], beforeCursor: string, limit: number): TranscriptPage {
  const beforeCreatedAt = decodeTranscriptCursor(beforeCursor);
  const normalized = normalizeEntries(entries);
  if (!normalized.some((entry) => entry.timestamp === beforeCreatedAt)) {
    throw new InvalidTranscriptCursorError();
  }
  return pageFromCandidates(
    normalized.filter((entry) => entry.timestamp < beforeCreatedAt),
    limit,
  );
}

function pageFromCandidates(candidates: TranscriptEntry[], limit: number): TranscriptPage {
  const start = Math.max(0, candidates.length - limit);
  const primary = candidates.slice(start);
  const hasOlder = start > 0;
  const withParents = withToolCallParents(primary, candidates);
  // The cursor always refers to the primary chronological boundary, never to a
  // prepended parent — otherwise a client could page the same parent forever.
  return {
    entries: withParents,
    olderCursor: hasOlder && primary[0] ? encodeTranscriptCursor(primary[0].timestamp) : null,
    hasOlder,
  };
}

/**
 * Prepend assistant entries whose `toolCall` blocks are referenced by a
 * `toolResult` inside the window but whose declaring message was truncated out.
 *
 * Consumers pair a tool result to its declaring call by id; without this an
 * orphaned result renders as an unknown tool with no arguments.
 */
export function withToolCallParents(primary: TranscriptEntry[], all: TranscriptEntry[]): TranscriptEntry[] {
  const present = new Set(primary.map((entry) => entry.id));
  const declared = toolCallIds(primary.map((entry) => entry.message));
  const parents: TranscriptEntry[] = [];

  for (const entry of primary) {
    if (!isToolResult(entry.message)) continue;
    const toolCallId = readString(entry.message.toolCallId);
    if (!toolCallId || declared.has(toolCallId)) continue;
    const parent = findToolCallParent(toolCallId, entry.timestamp, all);
    if (!parent || present.has(parent.id) || parents.some((candidate) => candidate.id === parent.id)) continue;
    parents.push(parent);
    for (const id of toolCallIds([parent.message])) declared.add(id);
  }

  return parents.length === 0 ? primary : normalizeEntries([...parents, ...primary]);
}

/**
 * The latest entry at or before `timestamp` declaring `toolCallId`.
 */
function findToolCallParent(
  toolCallId: string,
  resultTimestamp: string,
  all: TranscriptEntry[],
): TranscriptEntry | undefined {
  return [...all]
    .reverse()
    .find((entry) => entry.timestamp <= resultTimestamp && toolCallIds([entry.message]).has(toolCallId));
}

function toolCallIds(messages: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const record = asRecord(block);
      if (record.type !== "toolCall") continue;
      const id = readString(record.id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function isToolResult(message: Record<string, unknown>): boolean {
  return message.role === "toolResult";
}

/**
 * De-duplicate by id and order by `(timestamp, id)`.
 *
 * Pi session files are append-only, so duplicates mean a rewritten entry rather
 * than two distinct messages; first occurrence wins, mirroring the reference.
 */
export function normalizeEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const byId = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    return byTimestamp === 0 ? left.id.localeCompare(right.id) : byTimestamp;
  });
}

/**
 * Read every `type:"message"` entry from a Pi session JSONL file.
 *
 * Unparseable lines are skipped: a session file is append-only and a crash mid
 * write leaves a torn final line, which must not fail the whole read.
 */
export function readTranscriptEntries(
  sessionFile: string,
  options: { entryIds?: ReadonlySet<string> } = {},
): TranscriptEntry[] {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: TranscriptEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record.type !== "message") continue;
    const id = readString(record.id);
    if (!id) continue;
    if (options.entryIds && !options.entryIds.has(id)) continue;
    entries.push({
      id,
      parentId: readString(record.parentId) ?? null,
      timestamp: readString(record.timestamp) ?? new Date(0).toISOString(),
      message: asRecord(record.message),
    });
  }
  return entries;
}

/**
 * The set of entry ids on the branch from `leafId` up to the root.
 *
 * Returns `undefined` when the branch cannot be resolved (unknown leaf, cycle,
 * unreadable file) so callers can fall back to a linear read instead of
 * silently serving an empty transcript.
 */
export function activeBranchEntryIds(sessionFile: string, leafId: string | null): Set<string> | undefined {
  if (!leafId) return undefined;
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }

  const parentById = new Map<string, string | null>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const id = readString(record.id);
    if (id) parentById.set(id, readString(record.parentId) ?? null);
  }
  return walkToRoot(leafId, parentById);
}

function walkToRoot(leafId: string | null, parentById: ReadonlyMap<string, string | null>): Set<string> | undefined {
  if (!leafId || !parentById.has(leafId)) return undefined;
  const ids = new Set<string>();
  let currentId: string | null = leafId;
  while (currentId) {
    // A cycle means the file is corrupt; refusing beats looping forever.
    if (ids.has(currentId)) return undefined;
    ids.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }
  return ids;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
