/**
 * Plan 86 P2 — the host-owned workspace-history index (`history-v1.sqlite`).
 *
 * OWNERSHIP (hard rule from the approved plan)
 *
 *   The database belongs to the SUPERVISOR, never to a Pi child. Exactly one
 *   writer connection exists (the writer worker): it owns DDL, schema
 *   migration, upsert/delete and generation publication. The reader worker
 *   opens the same file `readOnly` and only queries; a read that needs a
 *   refresh hands work back to the writer.
 *
 *   The old child index (`~/.pi/remote/index.sqlite`) is a DIFFERENT file. It
 *   is never migrated, never written and never opened here. Old children keep
 *   reading/writing their own DB; the host cache is disposable.
 *
 * WHAT IS STORED (and what is not)
 *
 *   - `sessions`: one row per (workspace bucket, session id) with the file
 *     identity (inode/birthtime/size/mtime/ctime), the published generation,
 *     the complete-line byte high-water, the name/preview the list needs and a
 *     content revision. This is what makes the hot list `O(page)` instead of
 *     `O(files)`.
 *   - `entries`: one row per transcript ENTRY with the `(timestamp, entry_id)`
 *     keyset columns, parent id, role, byte offsets and the already-bounded
 *     wire projection (previews are <=4 KiB, never full bodies).
 *   - `fields`: one row per body field with the raw source spans (or a tiny
 *     synthetic value), representation, decoded byte length and sha256. A body
 *     is materialized once by the reader worker into a generation-scoped
 *     sidecar; the source spans are what that worker streams.
 *   - `tool_calls`: tool call id -> declaring entry, so a tool-result page can
 *     backfill its parent with one indexed lookup instead of reverse-scanning
 *     the whole transcript.
 *   - `workspaces`: build completeness/revision/pending state. A workspace
 *     that is still `building` is NEVER presented as an empty history.
 *
 * GENERATIONS
 *
 *   A generation is `sha256(workspace|session|ino|birthtime|parser|serial)`.
 *   It survives an APPEND (serial unchanged) and changes only when the file is
 *   replaced/rewritten or the parser changes (serial+1). Entry rows are written
 *   for the generation being built; queries always join the session row's
 *   published generation, so an unfinished generation is invisible. Publication
 *   is a single transaction that flips `sessions.generation`/`state` and drops
 *   the superseded rows.
 *
 * DEGRADATION
 *
 *   The cache is disposable. A corrupt file is quarantined by the WRITER and
 *   recreated; a reader that cannot open the DB reports `no_db` and the service
 *   asks the writer for a rebuild. No failure here may take the supervisor's
 *   control plane down.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// ── Paths ────────────────────────────────────────────────────────────────────

/** Remote Pi state root (`REMOTE_PI_HOME` wins, like every other state file). */
export function remoteStateRoot(override?: string): string {
  if (override !== undefined && override.trim() !== "") return override;
  const env = process.env["REMOTE_PI_HOME"];
  return env !== undefined && env.trim() !== "" ? env : homedir();
}

/** The Plan 86 P2 index. NOT the old `index.sqlite`. */
export function historyDbPath(remoteHome?: string): string {
  return join(remoteStateRoot(remoteHome), ".pi", "remote", "history-v1.sqlite");
}

/** Body sidecar cache root (generation-scoped files live underneath). */
export function historyBodiesRoot(remoteHome?: string): string {
  return join(remoteStateRoot(remoteHome), ".pi", "remote", "history-v1-bodies");
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Schema version written to `meta.schema_version`. Bump + migrate deliberately. */
export const HISTORY_SCHEMA_VERSION = 1;
/** Parser/tokenizer version. A changed value invalidates every cached row. */
export const HISTORY_PARSER_VERSION = 1;
/** Hash of the last bytes before the high-water, used to gate a trusted append. */
export const HISTORY_APPEND_TAIL_BYTES = 4 * 1024;
/** Maximum number of session rows one list page can return. */
export const HISTORY_INDEX_MAX_PAGE = 100;

// ── Types ────────────────────────────────────────────────────────────────────

export interface HistoryFileIdentity {
  ino: number;
  birthtime_ms: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

export type HistoryWorkspaceState = "ready" | "building" | "unavailable";
export type HistorySessionState = "ready" | "building";

export interface HistoryWorkspaceRow {
  workspace: string;
  state: HistoryWorkspaceState;
  revision: string;
  scanned_at: number;
  scan_error: string | null;
  pending: number;
  cursor: string | null;
}

export interface HistorySessionRow {
  workspace: string;
  session_id: string;
  path: string;
  name: string | null;
  preview: string | null;
  mtime: number;
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  ino: number;
  birthtime_ms: number;
  generation: string;
  high_water: number;
  state: HistorySessionState;
  entry_count: number;
  bad_lines: number;
  source_stamp: string;
  tail_hash: string | null;
  content_revision: string;
  build_serial: number;
  indexed_at: number;
  parser_version: number;
}

export interface HistoryEntryRow {
  entry_id: string;
  parent_id: string | null;
  timestamp: string;
  role: string;
  event_count: number;
  seed_user_id: string | null;
  line_start: number;
  line_end: number;
  /** JSON array of `HistoryStoredEvent`; bounded previews only. */
  projections: string;
}

export interface HistoryStoredRef {
  field: string;
  representation: "text_utf8" | "json_utf8" | "binary";
  mime: string | null;
  total_bytes: number;
  digest: string;
  preview: string | null;
  preview_truncated: boolean;
}

export interface HistoryStoredEvent {
  event_id: string;
  entry_id: string;
  /** Existing SessionHistoryEvent wire projection with bounded previews. */
  event: Record<string, unknown>;
  refs: HistoryStoredRef[];
  truncated: boolean;
}

export interface HistoryFieldRow {
  workspace: string;
  session_id: string;
  generation: string;
  entry_id: string;
  event_id: string;
  field: string;
  representation: "text_utf8" | "json_utf8" | "binary";
  mime: string | null;
  /** JSON array of `{ start, end }` source byte spans. Empty for synthetic. */
  spans: string;
  synthetic_base64: string | null;
  total_bytes: number;
  digest: string;
}

export type IndexFailureCode = "corrupt" | "incompatible" | "io";

export interface IndexFailure {
  ok: false;
  code: IndexFailureCode;
  detail: string;
}

export type IndexResult = { ok: true } | IndexFailure;

// ── Small helpers ────────────────────────────────────────────────────────────

type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable identity of the file BYTES as far as stat can tell. ctime catches a
 *  same-size+restored-mtime rewrite (the case size/mtime alone cannot). */
export function sourceStampOf(identity: HistoryFileIdentity): string {
  return sha256Hex(
    `${identity.ino}|${identity.birthtime_ms}|${identity.size}|${identity.mtime_ms}|${identity.ctime_ms}`,
  );
}

/** Content revision surfaced to clients (`if_revision`). */
export function contentRevisionOf(identity: HistoryFileIdentity): string {
  return sha256Hex(
    `${identity.ino}|${identity.birthtime_ms}|${identity.size}|${identity.mtime_ms}|${identity.ctime_ms}`,
  ).slice(0, 32);
}

/** A generation survives appends; serial+1 forces a new one after a rewrite. */
export function generationFor(
  workspace: string,
  sessionId: string,
  identity: Pick<HistoryFileIdentity, "ino" | "birthtime_ms">,
  buildSerial: number,
): string {
  return sha256Hex(
    `${workspace}|${sessionId}|${identity.ino}|${identity.birthtime_ms}|${HISTORY_PARSER_VERSION}|${buildSerial}`,
  ).slice(0, 32);
}

let revisionCounter = 0;
/** Opaque workspace revision. Every visible change bumps it. */
export function freshRevision(seed = ""): string {
  revisionCounter += 1;
  return sha256Hex(`${seed}|${Date.now()}|${process.pid}|${revisionCounter}|${randomBytes(8).toString("hex")}`).slice(0, 32);
}

function rowString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function rowNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function rowNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function rowNullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function isCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed|malformed database/i.test(
    message,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  revision TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  scan_error TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  cursor TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT,
  preview TEXT,
  mtime REAL NOT NULL,
  mtime_ms REAL NOT NULL,
  ctime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  birthtime_ms REAL NOT NULL,
  generation TEXT NOT NULL,
  high_water INTEGER NOT NULL,
  state TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  bad_lines INTEGER NOT NULL DEFAULT 0,
  source_stamp TEXT NOT NULL,
  tail_hash TEXT,
  content_revision TEXT NOT NULL,
  build_serial INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  PRIMARY KEY (workspace, session_id)
);
CREATE INDEX IF NOT EXISTS sessions_list ON sessions(workspace, mtime DESC, session_id DESC);
CREATE INDEX IF NOT EXISTS sessions_path ON sessions(workspace, path);

CREATE TABLE IF NOT EXISTS entries (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  timestamp TEXT NOT NULL,
  role TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  seed_user_id TEXT,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  projections TEXT NOT NULL,
  PRIMARY KEY (workspace, session_id, generation, entry_id)
);
CREATE INDEX IF NOT EXISTS entries_page ON entries(workspace, session_id, generation, timestamp, entry_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (workspace, session_id, generation, tool_call_id, entry_id)
);

CREATE TABLE IF NOT EXISTS fields (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  field TEXT NOT NULL,
  representation TEXT NOT NULL,
  mime TEXT,
  spans TEXT NOT NULL,
  synthetic_base64 TEXT,
  total_bytes INTEGER NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (workspace, session_id, generation, entry_id, event_id, field)
);
`;

/** Statements per connection. `DatabaseSync.prepare` is cheap but not free. */
class StatementCache {
  private readonly cache = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  get(sql: string): StatementSync {
    const hit = this.cache.get(sql);
    if (hit !== undefined) return hit;
    const prepared = this.db.prepare(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }

  clear(): void {
    this.cache.clear();
  }
}

function quarantineDatabase(file: string): void {
  const stamp = `${Date.now()}-${process.pid}`;
  let moved = false;
  try {
    fs.renameSync(file, `${file}.corrupt-${stamp}`);
    moved = true;
  } catch {
    moved = false;
  }
  if (!moved) {
    // Windows may keep the file locked for a few milliseconds after SQLite's
    // failed open. Retrying a cache deletion is honest recovery, not a wait on
    // user data: the DB is disposable by definition.
    try {
      fs.rmSync(file, { force: true, maxRetries: 20, retryDelay: 25 });
    } catch {
      /* the next open reports corrupt instead of pretending otherwise */
    }
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true, maxRetries: 20, retryDelay: 25 });
    } catch {
      /* best effort */
    }
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

/**
 * The ONLY writable connection. Instantiate in the writer worker only.
 *
 * `open()` is forgiving by design: a corrupt cache is quarantined and recreated
 * once. A future schema is reported as `incompatible` instead of being
 * destroyed.
 */
export class HistoryIndexWriter {
  private readonly file: string;
  private db: DatabaseSync | null = null;
  private statements: StatementCache | null = null;
  private transactionDepth = 0;
  private quarantined = false;

  constructor(file: string) {
    this.file = file;
  }

  get path(): string {
    return this.file;
  }

  open(): IndexResult {
    if (this.db !== null) return { ok: true };
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    } catch (error) {
      return { ok: false, code: "io", detail: errorText(error) };
    }
    const first = this.tryOpen();
    if (first.ok) return first;
    if (first.code !== "corrupt" || this.quarantined) return first;
    // One quarantine+recreate attempt. A second failure is reported honestly.
    this.quarantined = true;
    quarantineDatabase(this.file);
    return this.tryOpen();
  }

  private tryOpen(): IndexResult {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.file, { readBigInts: true });
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA foreign_keys = ON;");
      const statements = new StatementCache(db);
      const version = this.readSchemaVersion(db);
      if (version === null) {
        db.exec(SCHEMA_SQL);
        statements.get("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "schema_version",
          String(HISTORY_SCHEMA_VERSION),
        );
        statements.get("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "created_at",
          String(Date.now()),
        );
      } else if (version > HISTORY_SCHEMA_VERSION) {
        db.close();
        return {
          ok: false,
          code: "incompatible",
          detail: `schema ${version} is newer than ${HISTORY_SCHEMA_VERSION}`,
        };
      } else if (version < HISTORY_SCHEMA_VERSION) {
        const migrated = this.migrate(db, version);
        if (!migrated.ok) {
          db.close();
          return migrated;
        }
      } else {
        // Tables may be missing in a partially created file; IF NOT EXISTS is
        // cheap and makes the schema self-healing without touching data.
        db.exec(SCHEMA_SQL);
      }
      this.db = db;
      this.statements = statements;
      this.recoverUnfinished();
      return { ok: true };
    } catch (error) {
      // Close the LOCAL handle: assigning it to `this.db` happens only after the
      // schema check, and a leaked handle keeps the corrupt file locked on
      // Windows so quarantine could never recreate it.
      try {
        db?.close();
      } catch {
        /* already closed */
      }
      try {
        this.db?.close();
      } catch {
        /* already closed */
      }
      this.db = null;
      this.statements = null;
      return {
        ok: false,
        code: isCorruptionError(error) ? "corrupt" : "io",
        detail: errorText(error),
      };
    }
  }

  private readSchemaVersion(db: DatabaseSync): number | null {
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as SqlRow | undefined;
      if (row === undefined) return null;
      const value = rowNumber(row, "value");
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch (error) {
      // A brand-new (empty) file has no `meta` table yet.
      if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
  }

  private migrate(db: DatabaseSync, from: number): IndexResult {
    // v1 is the first schema. Kept as an explicit switch so a future version
    // has one place to add an ordered migration instead of ad-hoc ALTERs.
    let version = from;
    while (version < HISTORY_SCHEMA_VERSION) {
      switch (version) {
        case 0:
          db.exec(SCHEMA_SQL);
          version = 1;
          break;
        default:
          return { ok: false, code: "incompatible", detail: `no migration from schema ${version}` };
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(HISTORY_SCHEMA_VERSION),
    );
    return { ok: true };
  }

  /** A writer crash can leave a "building" marker; the published generation is
   *  still valid, so reads resume and the next reconcile rebuilds if needed. */
  private recoverUnfinished(): void {
    const db = this.require();
    try {
      db.exec("UPDATE sessions SET state = 'ready' WHERE state = 'building'");
      db.exec("UPDATE workspaces SET pending = 1 WHERE state = 'ready'");
      // Parser-version changes are handled per file by refreshSessionFile: the
      // old row stays visible (valid old data) and the next targeted refresh
      // rebuilds it under a new generation. Deleting the row here would orphan
      // its child rows and make a valid session temporarily not_found.
    } catch {
      // Recovery is best-effort; a failure surfaces as a rebuild on demand.
    }
  }

  close(): void {
    this.statements?.clear();
    this.statements = null;
    const db = this.db;
    this.db = null;
    if (db === null) return;
    try {
      db.close();
    } catch {
      /* closing a disposable cache is best-effort */
    }
  }

  /** True when the open DB can be used (tests / diagnostics). */
  isOpen(): boolean {
    return this.db !== null;
  }

  private require(): DatabaseSync {
    if (this.db === null) throw new Error("history writer is not open");
    return this.db;
  }

  private stmt(sql: string): StatementSync {
    if (this.statements === null) throw new Error("history writer is not open");
    return this.statements.get(sql);
  }

  /** Run [fn] inside one write transaction. Nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    const db = this.require();
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────

  getWorkspace(workspace: string): HistoryWorkspaceRow | null {
    const row = this.stmt(
      "SELECT workspace, state, revision, scanned_at, scan_error, pending, cursor FROM workspaces WHERE workspace = ?",
    ).get(workspace) as SqlRow | undefined;
    return row === undefined ? null : workspaceRow(row);
  }

  upsertWorkspace(row: HistoryWorkspaceRow): void {
    this.stmt(`
      INSERT INTO workspaces (workspace, state, revision, scanned_at, scan_error, pending, cursor)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace) DO UPDATE SET
        state = excluded.state,
        revision = excluded.revision,
        scanned_at = excluded.scanned_at,
        scan_error = excluded.scan_error,
        pending = excluded.pending,
        cursor = excluded.cursor
    `).run(
      row.workspace,
      row.state,
      row.revision,
      row.scanned_at,
      row.scan_error,
      row.pending,
      row.cursor,
    );
  }

  /** Atomically change the visible revision (and optionally the state). */
  bumpWorkspaceRevision(workspace: string, seed: string): string {
    const revision = freshRevision(`${workspace}|${seed}`);
    this.stmt("UPDATE workspaces SET revision = ? WHERE workspace = ?").run(revision, workspace);
    return revision;
  }

  deleteWorkspace(workspace: string): void {
    this.stmt("DELETE FROM entries WHERE workspace = ?").run(workspace);
    this.stmt("DELETE FROM tool_calls WHERE workspace = ?").run(workspace);
    this.stmt("DELETE FROM fields WHERE workspace = ?").run(workspace);
    this.stmt("DELETE FROM sessions WHERE workspace = ?").run(workspace);
    this.stmt("DELETE FROM workspaces WHERE workspace = ?").run(workspace);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  getSession(workspace: string, sessionId: string): HistorySessionRow | null {
    const row = this.stmt(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace = ? AND session_id = ?`).get(
      workspace,
      sessionId,
    ) as SqlRow | undefined;
    return row === undefined ? null : sessionRow(row);
  }

  getSessionByPath(workspace: string, path: string): HistorySessionRow | null {
    const row = this.stmt(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace = ? AND path = ? ORDER BY mtime DESC`).get(
      workspace,
      path,
    ) as SqlRow | undefined;
    return row === undefined ? null : sessionRow(row);
  }

  listSessions(workspace: string): HistorySessionRow[] {
    const rows = this.stmt(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace = ?`).all(workspace) as SqlRow[];
    return rows.map(sessionRow);
  }

  listSessionPaths(workspace: string): Array<{ path: string; source_stamp: string; session_id: string; generation: string }> {
    const rows = this.stmt(
      "SELECT path, source_stamp, session_id, generation FROM sessions WHERE workspace = ?",
    ).all(workspace) as SqlRow[];
    return rows.map((row) => ({
      path: rowString(row, "path"),
      source_stamp: rowString(row, "source_stamp"),
      session_id: rowString(row, "session_id"),
      generation: rowString(row, "generation"),
    }));
  }

  /** Mark an existing session as being rebuilt. A committed marker makes reads
   *  answer `building` while the published generation is still intact. */
  markSessionBuilding(workspace: string, sessionId: string): void {
    this.stmt("UPDATE sessions SET state = 'building' WHERE workspace = ? AND session_id = ?").run(workspace, sessionId);
  }

  /**
   * Publish a fully built generation in the CURRENT transaction and drop every
   * superseded generation of the same session. Incomplete generations never
   * reach this call.
   */
  publishSession(row: HistorySessionRow): void {
    this.stmt(`
      INSERT INTO sessions (
        workspace, session_id, path, name, preview, mtime, mtime_ms, ctime_ms, size, ino, birthtime_ms,
        generation, high_water, state, entry_count, bad_lines, source_stamp, tail_hash, content_revision,
        build_serial, indexed_at, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace, session_id) DO UPDATE SET
        path = excluded.path,
        name = excluded.name,
        preview = excluded.preview,
        mtime = excluded.mtime,
        mtime_ms = excluded.mtime_ms,
        ctime_ms = excluded.ctime_ms,
        size = excluded.size,
        ino = excluded.ino,
        birthtime_ms = excluded.birthtime_ms,
        generation = excluded.generation,
        high_water = excluded.high_water,
        state = excluded.state,
        entry_count = excluded.entry_count,
        bad_lines = excluded.bad_lines,
        source_stamp = excluded.source_stamp,
        tail_hash = excluded.tail_hash,
        content_revision = excluded.content_revision,
        build_serial = excluded.build_serial,
        indexed_at = excluded.indexed_at,
        parser_version = excluded.parser_version
    `).run(
      row.workspace,
      row.session_id,
      row.path,
      row.name,
      row.preview,
      row.mtime,
      row.mtime_ms,
      row.ctime_ms,
      row.size,
      row.ino,
      row.birthtime_ms,
      row.generation,
      row.high_water,
      row.state,
      row.entry_count,
      row.bad_lines,
      row.source_stamp,
      row.tail_hash,
      row.content_revision,
      row.build_serial,
      row.indexed_at,
      row.parser_version,
    );
    this.stmt("DELETE FROM entries WHERE workspace = ? AND session_id = ? AND generation <> ?").run(
      row.workspace,
      row.session_id,
      row.generation,
    );
    this.stmt("DELETE FROM tool_calls WHERE workspace = ? AND session_id = ? AND generation <> ?").run(
      row.workspace,
      row.session_id,
      row.generation,
    );
    this.stmt("DELETE FROM fields WHERE workspace = ? AND session_id = ? AND generation <> ?").run(
      row.workspace,
      row.session_id,
      row.generation,
    );
  }

  deleteSession(workspace: string, sessionId: string): void {
    this.stmt("DELETE FROM entries WHERE workspace = ? AND session_id = ?").run(workspace, sessionId);
    this.stmt("DELETE FROM tool_calls WHERE workspace = ? AND session_id = ?").run(workspace, sessionId);
    this.stmt("DELETE FROM fields WHERE workspace = ? AND session_id = ?").run(workspace, sessionId);
    this.stmt("DELETE FROM sessions WHERE workspace = ? AND session_id = ?").run(workspace, sessionId);
  }

  deleteEntriesFrom(workspace: string, sessionId: string, generation: string, entryId: string): void {
    this.stmt(
      "DELETE FROM entries WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ?",
    ).run(workspace, sessionId, generation, entryId);
    this.stmt(
      "DELETE FROM fields WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ?",
    ).run(workspace, sessionId, generation, entryId);
    this.stmt(
      "DELETE FROM tool_calls WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ?",
    ).run(workspace, sessionId, generation, entryId);
  }

  // ── Entries / fields / tool calls ──────────────────────────────────────────

  insertEntry(row: HistoryEntryRow & { workspace: string; session_id: string; generation: string }): number {
    const result = this.stmt(`
      INSERT OR IGNORE INTO entries (
        workspace, session_id, generation, entry_id, parent_id, timestamp, role,
        event_count, seed_user_id, line_start, line_end, projections
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.workspace,
      row.session_id,
      row.generation,
      row.entry_id,
      row.parent_id,
      row.timestamp,
      row.role,
      row.event_count,
      row.seed_user_id,
      row.line_start,
      row.line_end,
      row.projections,
    );
    return Number(result.changes);
  }

  insertField(row: HistoryFieldRow): void {
    this.stmt(`
      INSERT OR IGNORE INTO fields (
        workspace, session_id, generation, entry_id, event_id, field, representation,
        mime, spans, synthetic_base64, total_bytes, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.workspace,
      row.session_id,
      row.generation,
      row.entry_id,
      row.event_id,
      row.field,
      row.representation,
      row.mime,
      row.spans,
      row.synthetic_base64,
      row.total_bytes,
      row.digest,
    );
  }

  insertToolCall(
    workspace: string,
    sessionId: string,
    generation: string,
    toolCallId: string,
    entryId: string,
    timestamp: string,
  ): void {
    if (toolCallId === "") return;
    this.stmt(`
      INSERT OR REPLACE INTO tool_calls (workspace, session_id, generation, tool_call_id, entry_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workspace, sessionId, generation, toolCallId, entryId, timestamp);
  }

  /** Recompute `seed_user_id` for a whole generation (assistant `in_reply_to`).
   *  Ordered by the SAME `(timestamp, entry_id)` keyset the page uses. The row
   *  comparison lets entries_page seek the predecessor timestamp instead of
   *  scanning later entries again for every row in a cold generation. */
  recomputeSeeds(workspace: string, sessionId: string, generation: string): void {
    this.require()
      .prepare(`
        UPDATE entries SET seed_user_id = (
          SELECT prev.entry_id FROM entries AS prev
          WHERE prev.workspace = entries.workspace
            AND prev.session_id = entries.session_id
            AND prev.generation = entries.generation
            AND prev.role = 'user'
            AND (prev.timestamp, prev.entry_id) < (entries.timestamp, entries.entry_id)
          ORDER BY prev.timestamp DESC, prev.entry_id DESC
          LIMIT 1
        )
        WHERE workspace = ? AND session_id = ? AND generation = ?
      `)
      .run(workspace, sessionId, generation);
  }

  countEntries(workspace: string, sessionId: string, generation: string): number {
    const row = this.stmt(
      "SELECT COUNT(*) AS n FROM entries WHERE workspace = ? AND session_id = ? AND generation = ?",
    ).get(workspace, sessionId, generation) as SqlRow | undefined;
    return row === undefined ? 0 : rowNumber(row, "n");
  }

  /** Drop rows whose generation was never published (a failed build). */
  gcUnpublished(): number {
    const db = this.require();
    const statement = db.prepare(`
      DELETE FROM entries WHERE NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.workspace = entries.workspace AND s.session_id = entries.session_id AND s.generation = entries.generation
      )
    `);
    const entries = Number(statement.run().changes);
    db.prepare(`
      DELETE FROM fields WHERE NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.workspace = fields.workspace AND s.session_id = fields.session_id AND s.generation = fields.generation
      )
    `).run();
    db.prepare(`
      DELETE FROM tool_calls WHERE NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.workspace = tool_calls.workspace AND s.session_id = tool_calls.session_id AND s.generation = tool_calls.generation
      )
    `).run();
    return entries;
  }

  /** Savepoint wrapper so a batched step can isolate one bad file. */
  savepoint<T>(name: string, fn: () => T): T {
    this.require().exec(`SAVEPOINT ${name}`);
    try {
      const value = fn();
      this.require().exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      try {
        this.require().exec(`ROLLBACK TO ${name}`);
        this.require().exec(`RELEASE ${name}`);
      } catch {
        /* the outer transaction will roll back */
      }
      throw error;
    }
  }

  /** Seed update for the APPENDED entries only: O(new * log n), not O(n). */
  recomputeSeedsFor(
    workspace: string,
    sessionId: string,
    generation: string,
    entryIds: readonly string[],
  ): void {
    if (entryIds.length === 0) return;
    const statement = this.require().prepare(`
      UPDATE entries SET seed_user_id = (
        SELECT prev.entry_id FROM entries AS prev
        WHERE prev.workspace = entries.workspace
          AND prev.session_id = entries.session_id
          AND prev.generation = entries.generation
          AND prev.role = 'user'
          AND (prev.timestamp, prev.entry_id) < (entries.timestamp, entries.entry_id)
        ORDER BY prev.timestamp DESC, prev.entry_id DESC
        LIMIT 1
      )
      WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ?
    `);
    for (const entryId of entryIds) statement.run(workspace, sessionId, generation, entryId);
  }

  // ── Writer-side reads used by the build engine ─────────────────────────────

  countWorkspaceSessions(workspace: string): number {
    const row = this.stmt("SELECT COUNT(*) AS n FROM sessions WHERE workspace = ?").get(workspace) as
      | SqlRow
      | undefined;
    return row === undefined ? 0 : rowNumber(row, "n");
  }

  /** For diagnostics/tests: the number of `building` rows with no visible data. */
  countBuildingSessions(workspace: string): number {
    const row = this.stmt(
      "SELECT COUNT(*) AS n FROM sessions WHERE workspace = ? AND state = 'building'",
    ).get(workspace) as SqlRow | undefined;
    return row === undefined ? 0 : rowNumber(row, "n");
  }
}

// ── Reader ───────────────────────────────────────────────────────────────────

export interface HistoryReaderListValue {
  state: "ready";
  rows: HistorySessionRow[];
  has_more: boolean;
  revision: string;
}

export type HistoryReaderListResult =
  | HistoryReaderListValue
  | { state: "missing" | "building" | "unavailable" | "no_db" };

export interface HistoryReaderPageValue {
  entries: HistoryEntryRow[];
  has_older: boolean;
}

/**
 * Read-only connection + keyset queries. Instantiate in the READER worker only.
 *
 * It never creates the schema and never writes. If the DB does not exist yet it
 * reports `no_db`; the service then asks the writer to build. If the file is
 * corrupt it reports `no_db` as well: the writer quarantines/recreates it.
 */
export class HistoryIndexReader {
  private readonly file: string;
  private db: DatabaseSync | null = null;
  private statements: StatementCache | null = null;

  constructor(file: string) {
    this.file = file;
  }

  open(): boolean {
    if (this.db !== null) return true;
    let db: DatabaseSync | null = null;
    try {
      if (!fs.existsSync(this.file)) return false;
      db = new DatabaseSync(this.file, { readOnly: true, readBigInts: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA query_only = ON;");
      // The writer publishes the schema version only after all DDL completes.
      // A file can already exist while that initialization is still running;
      // never cache a reader for an empty/partial schema or issue table queries
      // against it. Only the writer may initialize, migrate or recover the DB.
      const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as SqlRow | undefined;
      if (schema?.["value"] !== String(HISTORY_SCHEMA_VERSION)) {
        db.close();
        return false;
      }
      this.db = db;
      this.statements = new StatementCache(db);
      return true;
    } catch {
      // Missing/locked/corrupt: the writer owns recovery. Close a partially
      // constructed handle so Windows does not keep the file locked while the
      // writer quarantines/recreates it.
      try {
        db?.close();
      } catch {
        /* already closed */
      }
      this.db = null;
      this.statements = null;
      return false;
    }
  }

  close(): void {
    this.statements?.clear();
    this.statements = null;
    const db = this.db;
    this.db = null;
    if (db === null) return;
    try {
      db.close();
    } catch {
      /* disposing a read-only cache is best-effort */
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  /** Re-open on the next call (used when the writer recreated the DB). */
  reset(): void {
    this.close();
  }

  private stmt(sql: string): StatementSync {
    if (this.db === null || this.statements === null) throw new Error("history reader is not open");
    return this.statements.get(sql);
  }

  workspace(workspace: string): HistoryWorkspaceRow | null {
    const row = this.stmt(
      "SELECT workspace, state, revision, scanned_at, scan_error, pending, cursor FROM workspaces WHERE workspace = ?",
    ).get(workspace) as SqlRow | undefined;
    return row === undefined ? null : workspaceRow(row);
  }

  /**
   * One keyset page of the workspace list: `(mtime DESC, session_id DESC)`.
   * The index does the ordering; the caller stats ONLY the returned page rows.
   */
  list(workspace: string, limit: number, before: { mtime: number; id: string } | null): HistoryReaderListResult {
    if (!this.open()) return { state: "no_db" };
    const state = this.workspace(workspace);
    if (state === null) return { state: "missing" };
    if (state.state === "building") return { state: "building" };
    if (state.state === "unavailable") return { state: "unavailable" };
    const pageLimit = Math.max(1, Math.min(HISTORY_INDEX_MAX_PAGE, Math.floor(limit)));
    const rows =
      before === null
        ? (this.stmt(`
            SELECT ${SESSION_COLUMNS} FROM sessions
            WHERE workspace = ?
            ORDER BY mtime DESC, session_id DESC
            LIMIT ?
          `).all(workspace, pageLimit + 1) as SqlRow[])
        : (this.stmt(`
            SELECT ${SESSION_COLUMNS} FROM sessions
            WHERE workspace = ? AND (mtime < ? OR (mtime = ? AND session_id < ?))
            ORDER BY mtime DESC, session_id DESC
            LIMIT ?
          `).all(workspace, before.mtime, before.mtime, before.id, pageLimit + 1) as SqlRow[]);
    const hasMore = rows.length > pageLimit;
    return {
      state: "ready",
      rows: (hasMore ? rows.slice(0, pageLimit) : rows).map(sessionRow),
      has_more: hasMore,
      revision: state.revision,
    };
  }

  /** Diagnostic count (never on the wire). */
  countSessions(workspace: string): number {
    if (!this.open()) return 0;
    const row = this.stmt("SELECT COUNT(*) AS n FROM sessions WHERE workspace = ?").get(workspace) as
      | SqlRow
      | undefined;
    return row === undefined ? 0 : rowNumber(row, "n");
  }

  session(workspace: string, sessionId: string): HistorySessionRow | null {
    if (!this.open()) return null;
    const row = this.stmt(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace = ? AND session_id = ?`).get(
      workspace,
      sessionId,
    ) as SqlRow | undefined;
    return row === undefined ? null : sessionRow(row);
  }

  sessionByPath(workspace: string, path: string): HistorySessionRow | null {
    if (!this.open()) return null;
    const row = this.stmt(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace = ? AND path = ? ORDER BY mtime DESC`,
    ).get(workspace, path) as SqlRow | undefined;
    return row === undefined ? null : sessionRow(row);
  }

  /**
   * Newest `limit` entries strictly older than [before], ascending.
   *
   * `before` is a `(timestamp, entry_id)` keyset boundary. With
   * `inclusive: true` the boundary entry itself is part of the window — that
   * is what lets a page sequence resume INSIDE one entry (R4): the window is
   * re-derived as "the n newest entries at-or-before the last delivered item's
   * entry", so the remaining items of that entry are still reachable.
   *
   * `highWater` is the SNAPSHOT byte fence (R5): only entries whose complete
   * line ends before that byte offset belong to the snapshot, so an entry
   * appended after the snapshot was taken can never enter an older page.
   */
  page(
    workspace: string,
    sessionId: string,
    generation: string,
    limit: number,
    before: { timestamp: string; id: string } | null,
    options: { inclusive?: boolean; highWater?: number | null } = {},
  ): HistoryReaderPageValue {
    const pageLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const fence = options.highWater === undefined || options.highWater === null ? [] : [options.highWater];
    const fenceSql = fence.length === 0 ? "" : " AND line_end < ?";
    const inclusive = options.inclusive === true;
    const beforeSql =
      before === null
        ? ""
        : inclusive
          ? " AND (timestamp < ? OR (timestamp = ? AND entry_id <= ?))"
          : " AND (timestamp < ? OR (timestamp = ? AND entry_id < ?))";
    const beforeArgs =
      before === null ? [] : [before.timestamp, before.timestamp, before.id];
    const rows = this.stmt(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE workspace = ? AND session_id = ? AND generation = ?${beforeSql}${fenceSql}
      ORDER BY timestamp DESC, entry_id DESC
      LIMIT ?
    `).all(workspace, sessionId, generation, ...beforeArgs, ...fence, pageLimit + 1) as SqlRow[];
    const hasOlder = rows.length > pageLimit;
    const kept = hasOlder ? rows.slice(0, pageLimit) : rows;
    return { entries: kept.reverse().map(entryRow), has_older: hasOlder };
  }

  entry(workspace: string, sessionId: string, generation: string, entryId: string): HistoryEntryRow | null {
    const row = this.stmt(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ?
    `).get(workspace, sessionId, generation, entryId) as SqlRow | undefined;
    return row === undefined ? null : entryRow(row);
  }

  seedAt(workspace: string, sessionId: string, generation: string, entry: HistoryEntryRow, highWater: number | null): string | null {
    const row = this.stmt(`SELECT entry_id FROM entries
      WHERE workspace = ? AND session_id = ? AND generation = ? AND role = 'user'
        AND (timestamp < ? OR (timestamp = ? AND entry_id < ?))
        AND (? IS NULL OR line_end < ?)
      ORDER BY timestamp DESC, entry_id DESC LIMIT 1
    `).get(workspace, sessionId, generation, entry.timestamp, entry.timestamp, entry.entry_id, highWater, highWater) as SqlRow | undefined;
    return row === undefined ? null : rowString(row, "entry_id");
  }

  /**
   * The declaring entry for a tool call, at or before [resultTimestamp].
   * One indexed lookup; no reverse history scan.
   *
   * `highWater` fences the lookup to the caller's snapshot (R5): a parent that
   * was appended after the snapshot was taken is not part of it.
   */
  toolCallParent(
    workspace: string,
    sessionId: string,
    generation: string,
    toolCallId: string,
    resultTimestamp: string,
    highWater: number | null = null,
  ): string | null {
    const row = this.stmt(`
      SELECT t.entry_id AS entry_id FROM tool_calls AS t
      WHERE t.workspace = ? AND t.session_id = ? AND t.generation = ? AND t.tool_call_id = ?
        AND t.timestamp <= ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM entries AS e
          WHERE e.workspace = t.workspace AND e.session_id = t.session_id
            AND e.generation = t.generation AND e.entry_id = t.entry_id AND e.line_end < ?
        ))
      ORDER BY t.timestamp DESC, t.entry_id DESC
      LIMIT 1
    `).get(workspace, sessionId, generation, toolCallId, resultTimestamp, highWater, highWater) as
      | SqlRow
      | undefined;
    return row === undefined ? null : rowString(row, "entry_id");
  }

  /**
   * EVERY body field of one event, in delivery order (R3).
   *
   * A wire item carries at most `HISTORY_MAX_BODY_REFS_PER_ITEM` refs, so an
   * event with more omitted values (a user entry with 17+ images) needs a way
   * to enumerate the rest. The rows are already indexed; this is the manifest.
   */
  fieldsOfEvent(
    workspace: string,
    sessionId: string,
    generation: string,
    entryId: string,
    eventId: string,
    offset = 0,
    limit = 16,
  ): HistoryFieldRow[] {
    const rows = this.stmt(`
      SELECT workspace, session_id, generation, entry_id, event_id, field, representation,
             mime, spans, synthetic_base64, total_bytes, digest
      FROM fields
      WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ? AND event_id = ?
      ORDER BY CASE WHEN field LIKE 'images.%' THEN 0 ELSE 1 END,
        CASE WHEN field LIKE 'images.%' THEN CAST(substr(field, 8) AS INTEGER) ELSE 0 END, field
      LIMIT ? OFFSET ?
    `).all(workspace, sessionId, generation, entryId, eventId, limit, offset) as SqlRow[];
    return sortFields(rows.map(fieldRow));
  }

  field(
    workspace: string,
    sessionId: string,
    generation: string,
    entryId: string,
    eventId: string,
    field: string,
  ): HistoryFieldRow | null {
    const row = this.stmt(`
      SELECT workspace, session_id, generation, entry_id, event_id, field, representation,
             mime, spans, synthetic_base64, total_bytes, digest
      FROM fields
      WHERE workspace = ? AND session_id = ? AND generation = ? AND entry_id = ? AND event_id = ? AND field = ?
    `).get(workspace, sessionId, generation, entryId, eventId, field) as SqlRow | undefined;
    return row === undefined ? null : fieldRow(row);
  }

  /** Diagnostic/test hook: the query plan for the hot page query. */
  explainPage(workspace: string, sessionId: string, generation: string): string[] {
    const rows = this.stmt(`
      EXPLAIN QUERY PLAN
      SELECT entry_id FROM entries
      WHERE workspace = ? AND session_id = ? AND generation = ?
      ORDER BY timestamp DESC, entry_id DESC
      LIMIT 30
    `).all(workspace, sessionId, generation) as SqlRow[];
    return rows.map((row) => rowString(row, "detail"));
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

const SESSION_COLUMNS = `workspace, session_id, path, name, preview, mtime, mtime_ms, ctime_ms, size, ino,
  birthtime_ms, generation, high_water, state, entry_count, bad_lines, source_stamp, tail_hash,
  content_revision, build_serial, indexed_at, parser_version`;

const ENTRY_COLUMNS = `entry_id, parent_id, timestamp, role, event_count, seed_user_id, line_start, line_end, projections`;

function workspaceRow(row: SqlRow): HistoryWorkspaceRow {
  const rawState = rowString(row, "state");
  const state: HistoryWorkspaceState =
    rawState === "building" || rawState === "unavailable" ? rawState : "ready";
  return {
    workspace: rowString(row, "workspace"),
    state,
    revision: rowString(row, "revision"),
    scanned_at: rowNumber(row, "scanned_at"),
    scan_error: rowNullableString(row, "scan_error"),
    pending: rowNumber(row, "pending"),
    cursor: rowNullableString(row, "cursor"),
  };
}

function sessionRow(row: SqlRow): HistorySessionRow {
  return {
    workspace: rowString(row, "workspace"),
    session_id: rowString(row, "session_id"),
    path: rowString(row, "path"),
    name: rowNullableString(row, "name"),
    preview: rowNullableString(row, "preview"),
    mtime: rowNumber(row, "mtime"),
    mtime_ms: rowNumber(row, "mtime_ms"),
    ctime_ms: rowNumber(row, "ctime_ms"),
    size: rowNumber(row, "size"),
    ino: rowNumber(row, "ino"),
    birthtime_ms: rowNumber(row, "birthtime_ms"),
    generation: rowString(row, "generation"),
    high_water: rowNumber(row, "high_water"),
    state: rowString(row, "state") === "building" ? "building" : "ready",
    entry_count: rowNumber(row, "entry_count"),
    bad_lines: rowNumber(row, "bad_lines"),
    source_stamp: rowString(row, "source_stamp"),
    tail_hash: rowNullableString(row, "tail_hash"),
    content_revision: rowString(row, "content_revision"),
    build_serial: rowNumber(row, "build_serial"),
    indexed_at: rowNumber(row, "indexed_at"),
    parser_version: rowNumber(row, "parser_version"),
  };
}

function entryRow(row: SqlRow): HistoryEntryRow {
  return {
    entry_id: rowString(row, "entry_id"),
    parent_id: rowNullableString(row, "parent_id"),
    timestamp: rowString(row, "timestamp"),
    role: rowString(row, "role"),
    event_count: rowNumber(row, "event_count"),
    seed_user_id: rowNullableString(row, "seed_user_id"),
    line_start: rowNumber(row, "line_start"),
    line_end: rowNumber(row, "line_end"),
    projections: rowString(row, "projections"),
  };
}

function fieldRow(row: SqlRow): HistoryFieldRow {
  const representation = rowString(row, "representation");
  return {
    workspace: rowString(row, "workspace"),
    session_id: rowString(row, "session_id"),
    generation: rowString(row, "generation"),
    entry_id: rowString(row, "entry_id"),
    event_id: rowString(row, "event_id"),
    field: rowString(row, "field"),
    representation:
      representation === "json_utf8" || representation === "binary" ? representation : "text_utf8",
    mime: rowNullableString(row, "mime"),
    spans: rowString(row, "spans"),
    synthetic_base64: rowNullableString(row, "synthetic_base64"),
    total_bytes: rowNumber(row, "total_bytes"),
    digest: rowString(row, "digest"),
  };
}

/**
 * Delivery order of the body fields of one event.
 *
 * `images.<n>` is ordered NUMERICALLY (`images.2` before `images.10`), which a
 * plain string sort would get wrong and which would reorder a user's images.
 * Named fields keep their natural relative order behind the images.
 */
function sortFields(fields: HistoryFieldRow[]): HistoryFieldRow[] {
  const rank = (field: string): [number, number, string] => {
    if (field.startsWith("images.")) {
      const index = Number(field.slice("images.".length));
      return [0, Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER, field];
    }
    return [1, 0, field];
  };
  return [...fields].sort((left, right) => {
    const [groupA, indexA, nameA] = rank(left.field);
    const [groupB, indexB, nameB] = rank(right.field);
    if (groupA !== groupB) return groupA - groupB;
    if (indexA !== indexB) return indexA - indexB;
    return nameA.localeCompare(nameB);
  });
}

// ── Module-level role handles (per thread; inline tests share a process) ─────
let writerHandle: HistoryIndexWriter | null = null;
let readerHandle: HistoryIndexReader | null = null;
let writerPath: string | null = null;
let readerPath: string | null = null;

/** The writer worker's connection. Reopened when the path changes (tests). */
export function writerFor(path: string): HistoryIndexWriter {
  if (writerHandle !== null && writerPath === path) return writerHandle;
  writerHandle?.close();
  writerHandle = new HistoryIndexWriter(path);
  writerPath = path;
  return writerHandle;
}

/** The reader worker's connection. Reopened when the path changes (tests). */
export function readerFor(path: string): HistoryIndexReader {
  if (readerHandle !== null && readerPath === path) return readerHandle;
  readerHandle?.close();
  readerHandle = new HistoryIndexReader(path);
  readerPath = path;
  return readerHandle;
}

/** Close both handles (worker dispose / test teardown). */
export function closeIndexHandles(): void {
  writerHandle?.close();
  writerHandle = null;
  writerPath = null;
  readerHandle?.close();
  readerHandle = null;
  readerPath = null;
}

/** Diagnostics for tests: parsing helpers are exported from one place. */
export const historyIndexInternals = {
  isCorruptionError,
  rowString,
  rowNumber,
};
