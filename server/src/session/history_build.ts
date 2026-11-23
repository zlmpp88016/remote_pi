/**
 * Plan 86 P2 — the writer-side build engine.
 *
 * Everything here runs INSIDE the writer worker. It owns the only write
 * connection and turns on-disk JSONL into index rows:
 *
 *   - `advanceWorkspace` — cold build, one bounded step at a time. The cursor
 *     is persisted so a writer crash resumes instead of restarting the whole
 *     workspace; a workspace stays `building` (never an empty list) until the
 *     step covering the last file commits.
 *   - `reconcileWorkspace` / `refreshPaths` — watcher-driven or explicit
 *     refresh. A directory listing + stat is the only place N files are
 *     touched; the hot list path never calls these.
 *   - `refreshSessionFile` — one targeted file: unchanged / trusted append /
 *     conservative rebuild. Same-size and shrunk files are ALWAYS rebuilt.
 *   - `appendSessionFile` — a supported Pi append (live writer attribution +
 *     prefix tail hash) parses ONLY the new bytes. Growth alone is never proof.
 *
 * Line parsing is streamed by `history_tokenizer.ts`; a line is never
 * accumulated and a 100 MiB entry line is never `JSON.parse`d. Complete-line
 * atomicity is enforced by the line iterator: a torn tail is left for the next
 * append and never becomes a half entry.
 *
 * Generations are published only after every entry/field/tool-call row of the
 * file committed. Queries select the session row's published generation, so an
 * unfinished generation is invisible.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { basename, join } from "node:path";
import {
  contentRevisionOf,
  freshRevision,
  generationFor,
  sourceStampOf,
  type HistoryEntryRow,
  type HistoryFileIdentity,
  type HistoryIndexWriter,
  type HistorySessionRow,
  HISTORY_APPEND_TAIL_BYTES,
  HISTORY_PARSER_VERSION,
} from "./history_index.js";
import { projectScannedEntry } from "./history_format.js";
import {
  scanHistoryLine,
  type HistoryScannedEntry,
  type HistoryScannedSession,
  type HistoryTokenizerSource,
  type HistoryTokenizerStats,
} from "./history_tokenizer.js";
import { HISTORY_ROW_PREVIEW_BYTES } from "../protocol/history.js";
import { isPathInside } from "./session_paths.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface BuildMetrics {
  /** Bytes read from the JSONL source (line discovery + tokenizer). */
  read_bytes: number;
  /** Bytes of the file that were (re)parsed; 0 for an unchanged file. */
  parsed_bytes: number;
  /** Bytes read to prove the append prefix boundary (4 KiB). */
  prefix_check_bytes: number;
  parsed_entries: number;
  bad_lines: number;
  files: number;
  build_ms: number;
}

export function emptyBuildMetrics(): BuildMetrics {
  return {
    read_bytes: 0,
    parsed_bytes: 0,
    prefix_check_bytes: 0,
    parsed_entries: 0,
    bad_lines: 0,
    files: 0,
    build_ms: 0,
  };
}

export function mergeBuildMetrics(target: BuildMetrics, source: BuildMetrics): void {
  target.read_bytes += source.read_bytes;
  target.parsed_bytes += source.parsed_bytes;
  target.prefix_check_bytes += source.prefix_check_bytes;
  target.parsed_entries += source.parsed_entries;
  target.bad_lines += source.bad_lines;
  target.files += source.files;
  target.build_ms += source.build_ms;
}

export type RefreshKind = "unchanged" | "appended" | "rebuilt" | "deleted" | "not_session" | "failed";

export interface RefreshResult {
  kind: RefreshKind;
  row: HistorySessionRow | null;
  /** Generations whose sidecars must be revoked. */
  revoked: string[];
  metrics: BuildMetrics;
  detail?: string;
}

export interface AdvanceResult {
  state: "ready" | "building" | "unavailable";
  complete: boolean;
  metrics: BuildMetrics;
  /** Sessions whose files disappeared during the step. */
  removed: number;
  revoked: string[];
}

export interface ReconcileResult extends AdvanceResult {
  changed: number;
}

export interface BuildFileResult {
  kind: "session" | "not_session" | "failed";
  row: HistorySessionRow | null;
  metrics: BuildMetrics;
  bad_lines: number;
}

export interface AppendResult {
  kind: "appended" | "duplicate" | "failed";
  row: HistorySessionRow | null;
  metrics: BuildMetrics;
  detail?: string;
}

// ── File source ──────────────────────────────────────────────────────────────

class FileSource implements HistoryTokenizerSource {
  constructor(
    private readonly fd: number,
    private readonly sizeBytes: number,
  ) {}

  size(): number {
    return this.sizeBytes;
  }

  read(offset: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(this.fd, buffer, read, length - read, offset + read);
      if (count <= 0) throw new Error("history: short read");
      read += count;
    }
    return buffer;
  }
}

export function identityOfStat(stat: fs.Stats): HistoryFileIdentity {
  return {
    ino: Number(stat.ino) || 0,
    birthtime_ms: Number(stat.birthtimeMs) || 0,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
  };
}

function statIdentity(file: string): HistoryFileIdentity | null {
  try {
    return identityOfStat(fs.statSync(file));
  } catch {
    return null;
  }
}

function rangeHash(source: HistoryTokenizerSource, start: number, end: number): string {
  const hash = createHash("sha256");
  const safeStart = Math.max(0, Math.min(start, end));
  let position = safeStart;
  while (position < end) {
    const length = Math.min(64 * 1024, end - position);
    hash.update(source.read(position, length));
    position += length;
  }
  return hash.digest("hex");
}

/** Newline discovery over COMPLETE lines only; a torn tail is not emitted. */
function forEachCompleteLine(
  source: HistoryTokenizerSource,
  startOffset: number,
  size: number,
  visit: (start: number, end: number) => void,
): { highWater: number; lines: number } {
  let offset = Math.max(0, startOffset);
  let lineStart = offset;
  let lines = 0;
  while (offset < size) {
    const length = Math.min(64 * 1024, size - offset);
    const buffer = source.read(offset, length);
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      visit(lineStart, offset + index);
      lines += 1;
      lineStart = offset + index + 1;
    }
    offset += buffer.length;
  }
  return { highWater: lineStart, lines };
}

// ── Full file build ──────────────────────────────────────────────────────────

export interface BuildFileInput {
  workspace: string;
  bucket: string;
  file: string;
  /** 0 for a first build, existing.build_serial+1 for a rebuild. */
  serial: number;
}

/**
 * Build one file into a NEW generation and publish it (caller transaction).
 *
 * Returns `not_session` for a file whose first valid JSON line is not a session
 * header — the caller removes any stale row for that path.
 */
export function buildSessionFile(writer: HistoryIndexWriter, input: BuildFileInput): BuildFileResult {
  const started = Date.now();
  if (!isPathInside(input.file, input.bucket)) {
    return { kind: "not_session", row: null, metrics: emptyBuildMetrics(), bad_lines: 0 };
  }
  let fd: number;
  try {
    fd = fs.openSync(input.file, "r");
  } catch {
    return { kind: "failed", row: null, metrics: emptyBuildMetrics(), bad_lines: 0 };
  }
  const metrics = emptyBuildMetrics();
  metrics.files = 1;
  let badLines = 0;
  try {
    return writer.savepoint("p2_file", () => {
    const fstat = fs.fstatSync(fd);
    const identity = identityOfStat(fstat);
    const source = new FileSource(fd, identity.size);
    const stats: HistoryTokenizerStats = { bytes_read: 0, max_buffer_bytes: 0, chunks: 0 };

    const state = {
      header: null as HistoryScannedSession | null,
      sessionId: null as string | null,
      generation: null as string | null,
      firstValidSeen: false,
      invalidFile: false,
      name: null as string | null,
      preview: null as string | null,
      activity: 0,
      entryCount: 0,
      badLines: 0,
    };

    const lineScan = forEachCompleteLine(source, 0, identity.size, (start, end) => {
      if (state.invalidFile) return;
      const scanned = scanHistoryLine(
        source,
        start,
        end,
        { preview_bytes: HISTORY_ROW_PREVIEW_BYTES },
        stats,
      );
      if (scanned === null) {
        state.badLines += 1;
        return;
      }
      if (!state.firstValidSeen) {
        state.firstValidSeen = true;
        // Matches readSessionFile: the FIRST valid line must be a session
        // header, otherwise the file is not a session transcript.
        const detected = scanned.kind === "session" ? scanned.session : undefined;
        if (detected === undefined || detected === null) {
          state.invalidFile = true;
          return;
        }
        state.header = detected;
        const detectedId =
          detected.id !== null && detected.id !== "" ? detected.id : basename(input.file, ".jsonl");
        state.sessionId = detectedId;
        state.generation = generationFor(input.workspace, detectedId, identity, input.serial);
        return;
      }
      const sessionId = state.sessionId;
      const generation = state.generation;
      if (state.header === null || sessionId === null || generation === null) return;

      if (scanned.kind === "session_info") {
        const candidate = scanned.name?.trim();
        if (candidate !== undefined && candidate !== "") state.name = candidate;
        return;
      }
      if (scanned.kind !== "message" || scanned.entry === undefined) return;

      const entry = scanned.entry;
      const stored = projectScannedEntry(entry);
      const timestamp = entry.timestamp ?? "1970-01-01T00:00:00.000Z";
      const entryRow: HistoryEntryRow & { workspace: string; session_id: string; generation: string } = {
        workspace: input.workspace,
        session_id: sessionId,
        generation,
        entry_id: entry.id,
        parent_id: entry.parent_id,
        timestamp,
        role: entry.role,
        event_count: stored.length,
        seed_user_id: null,
        line_start: start,
        line_end: end,
        projections: JSON.stringify(stored),
      };
      const changes = writer.insertEntry(entryRow);
      if (changes === 0) {
        // Duplicate id: the first occurrence wins (normalizeEntries). Keep the
        // existing row and do not double-count fields.
        return;
      }
      state.entryCount += 1;
      insertFields(writer, input.workspace, sessionId, generation, entry);

      if (state.preview === null && typeof scanned.user_preview === "string" && scanned.user_preview !== "") {
        state.preview = scanned.user_preview.slice(0, 200);
      }
      if (entry.role === "user" || entry.role === "assistant") {
        const at = entry.message_timestamp_ms ?? Date.parse(timestamp);
        if (Number.isFinite(at) && at > state.activity) state.activity = at;
      }
    });

    metrics.read_bytes += identity.size + stats.bytes_read;
    metrics.parsed_bytes += identity.size;
    metrics.parsed_entries += state.entryCount;
    metrics.bad_lines += state.badLines;

    if (state.header === null || state.sessionId === null || state.generation === null) {
      metrics.build_ms = Date.now() - started;
      return { kind: "not_session", row: null, metrics, bad_lines: state.badLines };
    }

    const headerAt = state.header.timestamp !== null ? Date.parse(state.header.timestamp) : Number.NaN;
    const mtime = state.activity > 0 ? state.activity : Number.isFinite(headerAt) && headerAt > 0 ? headerAt : identity.mtime_ms;

    const row: HistorySessionRow = {
      workspace: input.workspace,
      session_id: state.sessionId,
      path: input.file,
      name: state.name,
      preview: state.preview,
      mtime,
      mtime_ms: identity.mtime_ms,
      ctime_ms: identity.ctime_ms,
      size: identity.size,
      ino: identity.ino,
      birthtime_ms: identity.birthtime_ms,
      generation: state.generation,
      high_water: lineScan.highWater,
      state: "ready",
      entry_count: state.entryCount,
      bad_lines: state.badLines,
      source_stamp: sourceStampOf(identity),
      tail_hash: tailHashFor(source, lineScan.highWater),
      content_revision: contentRevisionOf(identity),
      build_serial: input.serial,
      indexed_at: Date.now(),
      parser_version: HISTORY_PARSER_VERSION,
    };
    writer.publishSession(row);
    writer.recomputeSeeds(input.workspace, state.sessionId, state.generation);
    metrics.build_ms = Date.now() - started;
    return { kind: "session", row, metrics, bad_lines: state.badLines };
    });
  } catch {
    metrics.build_ms = Date.now() - started;
    return {
      kind: "failed",
      row: null,
      metrics,
      bad_lines: metrics.bad_lines,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

function tailHashFor(source: HistoryTokenizerSource, highWater: number): string {
  return rangeHash(source, Math.max(0, highWater - HISTORY_APPEND_TAIL_BYTES), highWater);
}

function insertFields(
  writer: HistoryIndexWriter,
  workspace: string,
  sessionId: string,
  generation: string,
  entry: HistoryScannedEntry,
): void {
  const single = entry.events.length === 1;
  for (const event of entry.events) {
    const eventId = single ? entry.id : `${entry.id}#${event.index}`;
    if (event.type === "tool_request" && event.tool_call_id !== undefined && event.tool_call_id !== "") {
      writer.insertToolCall(
        workspace,
        sessionId,
        generation,
        event.tool_call_id,
        entry.id,
        entry.timestamp ?? "1970-01-01T00:00:00.000Z",
      );
    }
    for (const field of event.fields) {
      writer.insertField({
        workspace,
        session_id: sessionId,
        generation,
        entry_id: entry.id,
        event_id: eventId,
        field: field.field,
        representation: field.representation,
        mime: field.mime,
        spans: JSON.stringify(field.spans),
        synthetic_base64: field.synthetic_base64,
        total_bytes: field.total_bytes,
        digest: field.digest,
      });
    }
  }
}

// ── Append ───────────────────────────────────────────────────────────────────

export function appendSessionFile(
  writer: HistoryIndexWriter,
  row: HistorySessionRow,
  bucket: string,
  file: string,
  trusted: TrustedWriterRef | null,
): AppendResult {
  const started = Date.now();
  if (!isPathInside(file, bucket)) return { kind: "failed", row: null, metrics: emptyBuildMetrics(), detail: "outside bucket" };
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { kind: "failed", row: null, metrics: emptyBuildMetrics(), detail: "open" };
  }
  const metrics = emptyBuildMetrics();
  metrics.files = 1;
  try {
    const identity = identityOfStat(fs.fstatSync(fd));
    if (identity.ino !== row.ino || identity.birthtime_ms !== row.birthtime_ms) {
      return { kind: "failed", row: null, metrics, detail: "identity changed" };
    }
    if (trusted === null) {
      return { kind: "failed", row: null, metrics, detail: "untrusted append" };
    }
    if (trusted.session_id !== row.session_id) {
      return { kind: "failed", row: null, metrics, detail: "writer session mismatch" };
    }
    if (identity.size < row.high_water) {
      return { kind: "failed", row: null, metrics, detail: "shrunk" };
    }
    /*
     * R2 — THE CUSTODY RANGE. The receipt says "between `span.before` and
     * `span.after`, the only writes to this file were mine". That is verifiable:
     *
     *   - `span.before` must BE the identity this index recorded, so the range
     *     starts exactly where our verified prefix ends;
     *   - `span.before.size` must equal the indexed complete-line high-water;
     *   - `span.after.size` must still be what is on disk.
     *
     * Only then are `[before.size, after.size)` this writer's bytes, and only
     * those are parsed. A null span is never evidence, and a mismatch on ANY
     * endpoint means someone else touched the file — both fall through to the
     * conservative rebuild.
     */
    if (trusted.span === null) {
      return { kind: "failed", row: null, metrics, detail: "no custody span" };
    }
    if (sourceStampOf(trusted.span.before) !== row.source_stamp) {
      return { kind: "failed", row: null, metrics, detail: "custody range start mismatch" };
    }
    if (trusted.span.before.size !== row.high_water) {
      return { kind: "failed", row: null, metrics, detail: "custody range is not our prefix" };
    }
    if (sourceStampOf(trusted.span.after) !== sourceStampOf(identity)) {
      return { kind: "failed", row: null, metrics, detail: "custody range end mismatch" };
    }
    if (identity.size <= row.high_water) {
      return { kind: "failed", row: null, metrics, detail: "no growth in the custody range" };
    }
    const source = new FileSource(fd, identity.size);
    metrics.prefix_check_bytes = Math.min(HISTORY_APPEND_TAIL_BYTES, row.high_water);
    const prefixHash = rangeHash(source, Math.max(0, row.high_water - HISTORY_APPEND_TAIL_BYTES), row.high_water);
    if (row.tail_hash !== null && prefixHash !== row.tail_hash) {
      return { kind: "failed", row: null, metrics, detail: "prefix changed" };
    }

    const stats: HistoryTokenizerStats = { bytes_read: 0, max_buffer_bytes: 0, chunks: 0 };
    let appendedEntries = 0;
    let badLines = 0;
    const newEntryIds: string[] = [];
    let name = row.name;
    let preview = row.preview;
    let activity = row.mtime;
    let duplicate = false;

    /*
     * Parse EXACTLY the custody range: from the verified prefix end
     * (`span.before.size`, which was just asserted to equal `row.high_water`) to
     * the range end. Nothing before the range is re-read, and nothing after it is
     * attributed to this writer.
     */
    const lineScan = forEachCompleteLine(source, row.high_water, identity.size, (start, end) => {
      if (duplicate) return;
      const scanned = scanHistoryLine(
        source,
        start,
        end,
        { preview_bytes: HISTORY_ROW_PREVIEW_BYTES },
        stats,
      );
      if (scanned === null) {
        badLines += 1;
        return;
      }
      if (scanned.kind === "session_info") {
        const candidate = scanned.name?.trim();
        if (candidate !== undefined && candidate !== "") name = candidate;
        return;
      }
      if (scanned.kind !== "message" || scanned.entry === undefined) return;
      const entry = scanned.entry;
      const stored = projectScannedEntry(entry);
      const timestamp = entry.timestamp ?? "1970-01-01T00:00:00.000Z";
      const changes = writer.insertEntry({
        workspace: row.workspace,
        session_id: row.session_id,
        generation: row.generation,
        entry_id: entry.id,
        parent_id: entry.parent_id,
        timestamp,
        role: entry.role,
        event_count: stored.length,
        seed_user_id: null,
        line_start: start,
        line_end: end,
        projections: JSON.stringify(stored),
      });
      if (changes === 0) {
        duplicate = true;
        return;
      }
      appendedEntries += 1;
      newEntryIds.push(entry.id);
      insertFields(writer, row.workspace, row.session_id, row.generation, entry);
      if (preview === null && typeof scanned.user_preview === "string" && scanned.user_preview !== "") {
        preview = scanned.user_preview.slice(0, 200);
      }
      if (entry.role === "user" || entry.role === "assistant") {
        const at = entry.message_timestamp_ms ?? Date.parse(timestamp);
        if (Number.isFinite(at) && at > activity) activity = at;
      }
    });

    if (duplicate) {
      // Roll the partial append out of this transaction: entries inserted
      // before the duplicate share the PUBLISHED generation, so leaving them
      // would leak rows without a matching session high-water.
      for (const entryId of newEntryIds) {
        writer.deleteEntriesFrom(row.workspace, row.session_id, row.generation, entryId);
      }
      metrics.read_bytes += stats.bytes_read;
      metrics.build_ms = Date.now() - started;
      return { kind: "duplicate", row: null, metrics, detail: "entry id already indexed" };
    }

    metrics.read_bytes += identity.size - row.high_water + stats.bytes_read;
    metrics.parsed_bytes += identity.size - row.high_water;
    metrics.parsed_entries += appendedEntries;
    metrics.bad_lines += badLines;

    const updated: HistorySessionRow = {
      ...row,
      name,
      preview,
      mtime: activity,
      mtime_ms: identity.mtime_ms,
      ctime_ms: identity.ctime_ms,
      size: identity.size,
      source_stamp: sourceStampOf(identity),
      high_water: lineScan.highWater,
      entry_count: row.entry_count + appendedEntries,
      bad_lines: row.bad_lines + badLines,
      tail_hash: tailHashFor(source, lineScan.highWater),
      content_revision: contentRevisionOf(identity),
      indexed_at: Date.now(),
      state: "ready",
    };
    writer.recomputeSeedsFor(row.workspace, row.session_id, row.generation, newEntryIds);
    writer.publishSession(updated);
    metrics.build_ms = Date.now() - started;
    return { kind: "appended", row: updated, metrics };
  } catch (error) {
    metrics.build_ms = Date.now() - started;
    return {
      kind: "failed",
      row: null,
      metrics,
      detail: error instanceof Error ? error.name : "error",
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

// ── Targeted refresh ─────────────────────────────────────────────────────────

/**
 * A VERIFIED live writer for one session file (R1/R2).
 *
 * Presence means the supervisor's authority registry matched the child's own
 * notice for its CURRENT incarnation, and that notice named exactly this file.
 * `size` (when the child could stat it) is the byte count the writer can
 * account for; a bigger file therefore has foreign bytes and must be rebuilt.
 */
export interface TrustedWriterStamp {
  ino: number;
  birthtime_ms: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

/** A custody range: this writer wrote `[before.size, after.size)`. */
export interface TrustedWriterSpan {
  before: TrustedWriterStamp;
  after: TrustedWriterStamp;
}

export interface TrustedWriterRef {
  session_id: string;
  file: string;
  /** The custody range the writer proved, or null. */
  span: TrustedWriterSpan | null;
}

export interface RefreshFileInput {
  workspace: string;
  bucket: string;
  file: string;
  sessionIdHint?: string | null;
  trusted: TrustedWriterRef | null;
}

export function refreshSessionFile(writer: HistoryIndexWriter, input: RefreshFileInput): RefreshResult {
  const started = Date.now();
  const metrics = emptyBuildMetrics();
  const identity = statIdentity(input.file);
  const existingByPath = writer.getSessionByPath(input.workspace, input.file);
  const existingById =
    input.sessionIdHint !== undefined && input.sessionIdHint !== null
      ? writer.getSession(input.workspace, input.sessionIdHint)
      : null;
  const existing = existingByPath ?? existingById;

  if (identity === null) {
    if (existing !== null) {
      writer.transaction(() => {
        writer.deleteSession(input.workspace, existing.session_id);
        writer.bumpWorkspaceRevision(input.workspace, `delete:${existing.session_id}`);
      });
      metrics.build_ms = Date.now() - started;
      return { kind: "deleted", row: null, revoked: [existing.generation], metrics };
    }
    metrics.build_ms = Date.now() - started;
    return { kind: "deleted", row: null, revoked: [], metrics };
  }

  if (existing !== null && existing.path !== input.file) {
    // The same session id can appear in more than one file. Keep the newest by
    // file mtime (P1's tie-break: greater path wins).
    if (
      existing.mtime_ms > identity.mtime_ms ||
      (existing.mtime_ms === identity.mtime_ms && existing.path > input.file)
    ) {
      metrics.build_ms = Date.now() - started;
      return { kind: "unchanged", row: existing, revoked: [], metrics };
    }
  }

  if (existing !== null && existing.path === input.file) {
    if (existing.parser_version === HISTORY_PARSER_VERSION && existing.source_stamp === sourceStampOf(identity)) {
      if (existing.state !== "ready") {
        writer.transaction(() => {
          writer.publishSession({ ...existing, state: "ready" });
        });
      }
      metrics.build_ms = Date.now() - started;
      return { kind: "unchanged", row: existing, revoked: [], metrics };
    }

    const sameIdentity = existing.ino === identity.ino && existing.birthtime_ms === identity.birthtime_ms;
    const grew = identity.size > existing.size;
    const sameSize = identity.size === existing.size;
    const shrunk = identity.size < existing.size;

    if (
      sameIdentity &&
      grew &&
      existing.parser_version === HISTORY_PARSER_VERSION &&
      !shrunk &&
      !sameSize
    ) {
      const prefix = readPrefixHash(input.file, existing.high_water);
      metrics.prefix_check_bytes = prefix.bytes;
      if (prefix.hash !== null && existing.tail_hash !== null && prefix.hash !== existing.tail_hash) {
        return rebuild(writer, input, existing, metrics, started);
      }
      if (input.trusted !== null && input.trusted.session_id === existing.session_id) {
        const appended = writer.transaction(() => {
          const result = appendSessionFile(writer, existing, input.bucket, input.file, input.trusted);
          if (result.kind === "appended") {
            writer.bumpWorkspaceRevision(input.workspace, `append:${existing.session_id}`);
          }
          return result;
        });
        mergeBuildMetrics(metrics, appended.metrics);
        if (appended.kind === "appended" && appended.row !== null) {
          metrics.build_ms = Date.now() - started;
          return { kind: "appended", row: appended.row, revoked: [], metrics };
        }
        if (appended.kind === "duplicate") {
          // A rewritten/copied line is NOT a supported append: rebuild.
          return rebuild(writer, input, existing, metrics, started);
        }
        // Any other append failure also falls back to a conservative rebuild.
        return rebuild(writer, input, existing, metrics, started);
      }
      return rebuild(writer, input, existing, metrics, started);
    }
    // same-size rewrite, shrink, identity change or parser change
    return rebuild(writer, input, existing, metrics, started);
  }

  // New file (or a newer file for the same session id): first build.
  return rebuild(writer, input, null, metrics, started);
}

function readPrefixHash(file: string, highWater: number): { hash: string | null; bytes: number } {
  const start = Math.max(0, highWater - HISTORY_APPEND_TAIL_BYTES);
  const length = Math.max(0, highWater - start);
  if (length === 0) return { hash: null, bytes: 0 };
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, start);
      return {
        hash: createHash("sha256").update(buffer.subarray(0, read)).digest("hex"),
        bytes: read,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { hash: null, bytes: 0 };
  }
}

function rebuild(
  writer: HistoryIndexWriter,
  input: RefreshFileInput,
  existing: HistorySessionRow | null,
  metrics: BuildMetrics,
  started: number,
): RefreshResult {
  const serial = existing === null ? 0 : existing.build_serial + 1;
  if (existing !== null) {
    // Committed marker: reads answer `building` while the old generation is
    // still the last complete one. A crash leaves the old data readable on the
    // next writer open (recoverUnfinished).
    writer.transaction(() => writer.markSessionBuilding(input.workspace, existing.session_id));
  }
  let built: BuildFileResult;
  try {
    built = writer.transaction(() =>
      writer.savepoint("p2_build", () =>
        buildSessionFile(writer, {
          workspace: input.workspace,
          bucket: input.bucket,
          file: input.file,
          serial,
        }),
      ),
    );
  } catch {
    if (existing !== null) {
      writer.transaction(() => writer.publishSession({ ...existing, state: "ready" }));
    }
    try {
      writer.gcUnpublished();
    } catch {
      /* the next rebuild retries */
    }
    metrics.build_ms = Date.now() - started;
    return { kind: "failed", row: existing, revoked: [], metrics, detail: "build threw" };
  }
  mergeBuildMetrics(metrics, built.metrics);

  if (built.kind === "failed") {
    if (existing !== null) {
      writer.transaction(() => writer.publishSession({ ...existing, state: "ready" }));
    }
    // A failed savepoint should have rolled the partial rows back; this is a
    // belt-and-braces sweep so a crashed/committed half-generation can never
    // accumulate as invisible garbage.
    try {
      writer.gcUnpublished();
    } catch {
      /* the next rebuild retries */
    }
    metrics.build_ms = Date.now() - started;
    return { kind: "failed", row: existing, revoked: [], metrics, detail: "build failed" };
  }

  if (built.kind === "not_session" || built.row === null) {
    writer.transaction(() => {
      if (existing !== null) writer.deleteSession(input.workspace, existing.session_id);
      // A file that merely stopped being a session can still occupy the path.
      const byPath = writer.getSessionByPath(input.workspace, input.file);
      if (byPath !== null) writer.deleteSession(input.workspace, byPath.session_id);
    });
    metrics.build_ms = Date.now() - started;
    return {
      kind: "not_session",
      row: null,
      revoked: existing !== null ? [existing.generation] : [],
      metrics,
    };
  }

  writer.transaction(() => {
    if (existing !== null && existing.session_id !== built.row!.session_id) {
      writer.deleteSession(input.workspace, existing.session_id);
    }
    writer.bumpWorkspaceRevision(input.workspace, `publish:${built.row!.session_id}`);
  });
  metrics.build_ms = Date.now() - started;
  const revoked: string[] = [];
  if (existing !== null && existing.generation !== built.row.generation) revoked.push(existing.generation);
  return { kind: "rebuilt", row: built.row, revoked, metrics };
}

// ── Workspace cold build ─────────────────────────────────────────────────────

export interface AdvanceInput {
  workspace: string;
  bucket: string;
  max_files: number;
  max_bytes: number;
  /**
   * Verified live writer for one FILE (R1/R2).
   *
   * A cold build walks files, so the only case it can newly trust is a file
   * whose writer published a notice — which cannot happen for a file it has
   * never indexed. Kept in the signature so the caller has ONE seam and cannot
   * accidentally opt a cold step into trust.
   */
  trusted?(file: string, sessionId: string): TrustedWriterRef | null;
}

export function advanceWorkspace(writer: HistoryIndexWriter, input: AdvanceInput): AdvanceResult {
  const started = Date.now();
  const metrics = emptyBuildMetrics();
  const revoked: string[] = [];
  let workspaceRow = writer.getWorkspace(input.workspace);
  if (workspaceRow === null) {
    workspaceRow = {
      workspace: input.workspace,
      state: "building",
      revision: freshRevision(input.workspace),
      scanned_at: 0,
      scan_error: null,
      pending: 0,
      cursor: null,
    };
    writer.transaction(() => writer.upsertWorkspace({ ...workspaceRow! }));
  }
  if (workspaceRow.state === "ready") {
    return { state: "ready", complete: true, metrics, removed: 0, revoked };
  }

  let names: string[];
  try {
    names = fs.readdirSync(input.bucket).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const state = code === "ENOENT" ? "ready" : "unavailable";
    writer.transaction(() => {
      writer.upsertWorkspace({
        ...workspaceRow!,
        state,
        scanned_at: Date.now(),
        scan_error: code === "ENOENT" ? null : "unreadable",
        pending: 0,
        cursor: null,
        revision: workspaceRow!.revision === "" ? freshRevision(input.workspace) : workspaceRow!.revision,
      });
    });
    metrics.build_ms = Date.now() - started;
    return { state, complete: state === "ready", metrics, removed: 0, revoked };
  }

  const cursor = workspaceRow.cursor;
  const startIndex = cursor === null ? 0 : names.findIndex((name) => name > cursor);
  const pendingNames = startIndex < 0 ? [] : names.slice(startIndex);
  const maxFiles = Math.max(1, Math.floor(input.max_files));
  const maxBytes = Math.max(1, Math.floor(input.max_bytes));
  let processed = 0;
  let bytes = 0;
  let removed = 0;
  let nextCursor = cursor;

  for (const name of pendingNames) {
    if (processed >= maxFiles || bytes >= maxBytes) break;
    const file = joinBucket(input.bucket, name);
    let identity: HistoryFileIdentity | null;
    try {
      identity = identityOfStat(fs.statSync(file));
    } catch {
      nextCursor = name;
      continue;
    }
    const result = writer.transaction(() =>
      writer.savepoint("p2_advance", () =>
        refreshSessionFile(writer, {
          workspace: input.workspace,
          bucket: input.bucket,
          file,
          sessionIdHint: null,
          trusted: null,
        }),
      ),
    );
    mergeBuildMetrics(metrics, result.metrics);
    revoked.push(...result.revoked);
    bytes += identity.size;
    processed += 1;
    nextCursor = name;
    if (result.kind === "deleted" || result.kind === "not_session") removed += 1;
  }

  const complete = processed === pendingNames.length;
  writer.transaction(() => {
    writer.upsertWorkspace({
      ...workspaceRow!,
      state: complete ? "ready" : "building",
      scanned_at: Date.now(),
      scan_error: null,
      // A completed cold build still wants one reconcile pass for files that
      // appeared with a name below the cursor while it was running.
      pending: complete ? 1 : 0,
      cursor: complete ? null : nextCursor,
      revision: workspaceRow!.revision === "" ? freshRevision(input.workspace) : workspaceRow!.revision,
    });
  });
  metrics.build_ms = Date.now() - started;
  return { state: complete ? "ready" : "building", complete, metrics, removed, revoked };
}

// ── Workspace reconcile ──────────────────────────────────────────────────────

export interface ReconcileInput {
  workspace: string;
  bucket: string;
  max_files: number;
  /** Verified live writer for one FILE (R1/R2): the append-authority chain. */
  trusted?(file: string, sessionId: string): TrustedWriterRef | null;
}

export function reconcileWorkspace(writer: HistoryIndexWriter, input: ReconcileInput): ReconcileResult {
  const started = Date.now();
  const metrics = emptyBuildMetrics();
  const revoked: string[] = [];
  let removed = 0;
  let changed = 0;
  const workspaceRow = writer.getWorkspace(input.workspace);
  if (workspaceRow === null) {
    return { ...advanceWorkspace(writer, { workspace: input.workspace, bucket: input.bucket, max_files: input.max_files, max_bytes: Number.MAX_SAFE_INTEGER }), changed: 0 };
  }

  let names: string[];
  try {
    names = fs.readdirSync(input.bucket).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    writer.transaction(() => {
      writer.upsertWorkspace({
        ...workspaceRow,
        state: code === "ENOENT" ? "ready" : "unavailable",
        scanned_at: Date.now(),
        scan_error: code === "ENOENT" ? null : "unreadable",
        pending: 0,
        cursor: null,
      });
    });
    metrics.build_ms = Date.now() - started;
    return {
      state: code === "ENOENT" ? "ready" : "unavailable",
      complete: code === "ENOENT",
      metrics,
      removed: 0,
      revoked,
      changed: 0,
    };
  }

  const present = new Set(names.map((name) => joinBucket(input.bucket, name)));
  for (const row of writer.listSessionPaths(input.workspace)) {
    if (present.has(row.path)) continue;
    writer.transaction(() => {
      writer.deleteSession(input.workspace, row.session_id);
      writer.bumpWorkspaceRevision(input.workspace, `delete:${row.session_id}`);
    });
    removed += 1;
    revoked.push(row.generation);
  }

  const cursor = workspaceRow.cursor;
  const startIndex = cursor === null ? 0 : names.findIndex((name) => name > cursor);
  const pending = startIndex < 0 ? [] : names.slice(startIndex);
  const maxFiles = Math.max(1, Math.floor(input.max_files));
  let processed = 0;
  let nextCursor = cursor;
  for (const name of pending) {
    if (processed >= maxFiles) break;
    const file = joinBucket(input.bucket, name);
    const stat = statIdentity(file);
    const existing = writer.getSessionByPath(input.workspace, file);
    if (stat === null) {
      if (existing !== null) {
        writer.transaction(() => {
          writer.deleteSession(input.workspace, existing.session_id);
          writer.bumpWorkspaceRevision(input.workspace, `delete:${existing.session_id}`);
        });
        revoked.push(existing.generation);
        removed += 1;
      }
      nextCursor = name;
      continue;
    }
    if (existing !== null && existing.source_stamp === sourceStampOf(stat) && existing.parser_version === HISTORY_PARSER_VERSION) {
      nextCursor = name;
      processed += 1;
      continue;
    }
    const trusted = existing !== null && input.trusted !== undefined ? input.trusted(file, existing.session_id) : null;
    const result = writer.transaction(() =>
      writer.savepoint("p2_reconcile", () =>
        refreshSessionFile(writer, {
          workspace: input.workspace,
          bucket: input.bucket,
          file,
          sessionIdHint: null,
          trusted,
        }),
      ),
    );
    mergeBuildMetrics(metrics, result.metrics);
    revoked.push(...result.revoked);
    if (result.kind === "deleted" || result.kind === "not_session") removed += 1;
    else changed += 1;
    nextCursor = name;
    processed += 1;
  }

  const complete = nextCursor === names[names.length - 1] || pending.length === 0;
  writer.transaction(() => {
    writer.upsertWorkspace({
      ...workspaceRow,
      state: "ready",
      scanned_at: complete ? Date.now() : workspaceRow.scanned_at,
      scan_error: null,
      pending: complete ? 0 : 1,
      cursor: complete ? null : nextCursor,
    });
  });
  metrics.build_ms = Date.now() - started;
  return { state: "ready", complete, metrics, removed, revoked, changed };
}

/** Targeted refresh of the rows a list page just observed. */
export function refreshPaths(
  writer: HistoryIndexWriter,
  input: {
    workspace: string;
    bucket: string;
    paths: readonly string[];
    trusted?(file: string, sessionId: string): TrustedWriterRef | null;
  },
): ReconcileResult {
  const started = Date.now();
  const metrics = emptyBuildMetrics();
  const revoked: string[] = [];
  let removed = 0;
  let changed = 0;
  for (const path of input.paths) {
    if (!isPathInside(path, input.bucket)) continue;
    const existing = writer.getSessionByPath(input.workspace, path);
    const stat = statIdentity(path);
    if (stat === null) {
      if (existing !== null) {
        writer.transaction(() => {
          writer.deleteSession(input.workspace, existing.session_id);
          writer.bumpWorkspaceRevision(input.workspace, `delete:${existing.session_id}`);
        });
        revoked.push(existing.generation);
        removed += 1;
      }
      continue;
    }
    if (existing !== null && existing.source_stamp === sourceStampOf(stat) && existing.parser_version === HISTORY_PARSER_VERSION) {
      continue;
    }
    const trusted = existing !== null && input.trusted !== undefined ? input.trusted(path, existing.session_id) : null;
    const result = writer.transaction(() =>
      writer.savepoint("p2_paths", () =>
        refreshSessionFile(writer, {
          workspace: input.workspace,
          bucket: input.bucket,
          file: path,
          sessionIdHint: existing?.session_id ?? null,
          trusted,
        }),
      ),
    );
    mergeBuildMetrics(metrics, result.metrics);
    revoked.push(...result.revoked);
    if (result.kind === "deleted" || result.kind === "not_session") removed += 1;
    else changed += 1;
  }
  metrics.build_ms = Date.now() - started;
  return { state: "ready", complete: true, metrics, removed, revoked, changed };
}

/**
 * Resolve a session id that is not yet indexed (first read after a new file).
 * Directory NAMES are inspected (no N stats); only candidates whose name
 * contains the session id are opened. If the cold build is still running the
 * caller should answer `building`, not `not_found`.
 */
export function ensureSessionFile(
  writer: HistoryIndexWriter,
  input: { workspace: string; bucket: string; sessionId: string; trusted: TrustedWriterRef | null },
): RefreshResult {
  const started = Date.now();
  const existing = writer.getSession(input.workspace, input.sessionId);
  if (existing !== null) {
    const refreshed = refreshSessionFile(writer, {
      workspace: input.workspace,
      bucket: input.bucket,
      file: existing.path,
      sessionIdHint: input.sessionId,
      trusted: input.trusted,
    });
    return refreshed;
  }
  let names: string[];
  try {
    names = fs.readdirSync(input.bucket).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return { kind: "failed", row: null, revoked: [], metrics: emptyBuildMetrics() };
  }
  const candidates = names.filter((name) => name.includes(input.sessionId));
  for (const name of candidates) {
    const file = joinBucket(input.bucket, name);
    const result = writer.transaction(() =>
      writer.savepoint("p2_ensure", () =>
        refreshSessionFile(writer, {
          workspace: input.workspace,
          bucket: input.bucket,
          file,
          sessionIdHint: input.sessionId,
          trusted: null,
        }),
      ),
    );
    if (result.row !== null && result.row.session_id === input.sessionId) {
      result.metrics.build_ms = Date.now() - started;
      return result;
    }
  }
  return { kind: "failed", row: null, revoked: [], metrics: emptyBuildMetrics() };
}

function joinBucket(bucket: string, name: string): string {
  return join(bucket, name);
}
