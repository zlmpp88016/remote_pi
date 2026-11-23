/**
 * Plan 86 P2 — the typed worker protocol and request dispatch.
 *
 * TWO ROLES, TWO CONNECTIONS (max two workers total):
 *
 *   writer — the only SQLite writer. Handles cold-build steps, reconcile,
 *            targeted refresh, trusted append and generation publication.
 *   reader — a READ-ONLY SQLite connection. Handles list/read/body queries and
 *            owns the generation-scoped body sidecar (files, not SQL).
 *
 * Both roles run in real `worker_threads` in `dist/`. In source/tests the inline
 * port runs the same handler on the calling thread; it is a test shim only.
 * The supervisor control plane never parses a transcript or reads a large file
 * itself.
 *
 * The handler is intentionally free of SDK imports: history must work with
 * every Pi stopped, and must never drag `pi-coding-agent` into the host process.
 */

import fs from "node:fs";
import {
  historyBodiesRoot,
  historyDbPath,
  closeIndexHandles,
  readerFor,
  writerFor,
  sourceStampOf,
  type HistoryEntryRow,
  type HistoryFieldRow,
  type HistorySessionRow,
  type HistoryStoredEvent,
} from "./history_index.js";
import {
  advanceWorkspace,
  ensureSessionFile,
  reconcileWorkspace,
  refreshPaths,
  refreshSessionFile,
  type AdvanceResult,
  type BuildMetrics,
  type ReconcileResult,
  type RefreshResult,
} from "./history_build.js";
import {
  HistoryBodyStore,
  BODY_SIDECAR_BUDGET_BYTES,
  type BodyFieldSpec,
  type BodyStoreErrorCode,
} from "./history_body_store.js";
import { parseStoredEvents } from "./history_format.js";
import { isPathInside } from "./session_paths.js";
import type { HistoryBodyRepresentationWire } from "../protocol/types.js";

// ── Protocol ─────────────────────────────────────────────────────────────────

export type HistoryWorkerRole = "writer" | "reader";

/**
 * The live writer attribution for ONE session file (R1/R2).
 *
 * It is file-keyed on purpose: a session id alone cannot distinguish "this file
 * is appended by its owner" from "a process with that id happens to run". The
 * service only ever puts an entry here after the supervisor's authority registry
 * confirmed the child's own notice for the CURRENT incarnation.
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

export interface TrustedWriterPayload {
  session_id: string;
  /** Absolute session file the authority is scoped to. */
  file: string;
  /**
   * The custody RANGE the live writer proved (R2), or null.
   *
   * The worker requires `span.before` to equal the identity it last INDEXED and
   * then parses exactly [before.size, after.size). Null = no evidence = rebuild.
   */
  span: TrustedWriterSpan | null;
}

export interface WriterAdvancePayload {
  kind: "advance";
  remote_home: string | null;
  bucket: string;
  max_files: number;
  max_bytes: number;
  /** Session files with a live, verified Pi writer (narrow lifecycle seam). */
  trusted_writers?: TrustedWriterPayload[];
}

export interface WriterReconcilePayload {
  kind: "reconcile";
  remote_home: string | null;
  bucket: string;
  max_files: number;
  trusted_writers?: TrustedWriterPayload[];
}

export interface WriterRefreshPathsPayload {
  kind: "refresh_paths";
  remote_home: string | null;
  bucket: string;
  paths: string[];
  trusted_writers?: TrustedWriterPayload[];
}

export interface WriterRefreshFilePayload {
  kind: "refresh_file";
  remote_home: string | null;
  bucket: string;
  file: string;
  session_id?: string | null;
  /** Verified live writer for exactly this file, or null. */
  trusted?: TrustedWriterPayload | null;
}

export interface WriterEnsureSessionPayload {
  kind: "ensure_session";
  remote_home: string | null;
  bucket: string;
  session_id: string;
  /** Verified live writer for this session's file, or null. */
  trusted?: TrustedWriterPayload | null;
}

export interface ReaderListPayload {
  kind: "list";
  remote_home: string | null;
  bucket: string;
  limit: number;
  before: { mtime: number; id: string } | null;
}

export interface ReaderReadPayload {
  kind: "read";
  remote_home: string | null;
  bucket: string;
  session_id: string;
  limit: number;
  before: { timestamp: string; id: string } | null;
  /** Include the boundary entry itself in the window (mid-entry resume). */
  before_inclusive?: boolean;
  /** Window size (primary entries) pinned by a page cursor. */
  window_limit?: number;
  /** Snapshot generation when the caller holds one; null for the newest page. */
  generation: string | null;
  /** Snapshot high-water when the caller holds one; null for the newest page. */
  high_water: number | null;
  /**
   * Verified live writer for this session's file, or null (R1/R2).
   *
   * PRESENCE is what allows the reader to accept a file that grew since the
   * index was written: without it a changed stamp forces a refresh. It replaces
   * the old bare boolean, which could not say WHICH file the writer owned nor
   * how many bytes it could account for.
   */
  trusted: TrustedWriterPayload | null;
  delivered_items?: number;
  delivered_refs?: number;
}

export interface ReaderBodyPayload {
  kind: "body";
  remote_home: string | null;
  bucket: string;
  session_id: string;
  generation: string;
  entry_id: string;
  event_id: string;
  field: string;
  offset_bytes: number;
  chunk_bytes: number;
  expected_digest: string;
  expected_total_bytes: number;
  /** Verified live writer for this session's file, or null (R1/R2). */
  trusted: TrustedWriterPayload | null;
}

export interface ReaderFieldsPayload {
  kind: "fields";
  remote_home: string | null;
  bucket: string;
  session_id: string;
  generation: string;
  entry_id: string;
  event_id: string;
  high_water: number | null;
}

export interface ReaderStatsPayload {
  kind: "stats";
  remote_home: string | null;
  bucket: string;
}

export interface ReaderRevokePayload {
  kind: "revoke";
  remote_home: string | null;
  generations: string[];
}

export interface WorkerDisposePayload {
  kind: "dispose";
}

export type HistoryWriterPayload =
  | WriterAdvancePayload
  | WriterReconcilePayload
  | WriterRefreshPathsPayload
  | WriterRefreshFilePayload
  | WriterEnsureSessionPayload
  | WorkerDisposePayload;

export type HistoryReaderPayload =
  | ReaderListPayload
  | ReaderReadPayload
  | ReaderFieldsPayload
  | ReaderBodyPayload
  | ReaderStatsPayload
  | ReaderRevokePayload
  | WorkerDisposePayload;

export type HistoryWorkerPayload = HistoryWriterPayload | HistoryReaderPayload;
export type HistoryWorkerRequest = HistoryWorkerPayload & { id: number };

export type HistoryWorkerErrorCode =
  | "not_found"
  | "stale"
  | "unsupported"
  | "body_too_large"
  | "internal";

export interface HistoryWorkerErrorReply {
  id: number;
  ok: false;
  error: { code: HistoryWorkerErrorCode };
}

export interface HistoryWorkerOkReply<T> {
  id: number;
  ok: true;
  value: T;
}

export type HistoryWorkerReply = HistoryWorkerOkReply<unknown> | HistoryWorkerErrorReply;

// ── Values returned to the service ───────────────────────────────────────────

export interface HistoryWorkerRef {
  field: string;
  representation: HistoryBodyRepresentationWire;
  mime: string | null;
  total_bytes: number;
  digest: string;
  preview: string | null;
  preview_truncated: boolean;
}

export interface HistoryWorkerItem {
  event_id: string;
  entry_id: string;
  event: Record<string, unknown>;
  refs: HistoryWorkerRef[];
  ref_offset?: number;
  refs_more?: boolean;
  truncated: boolean;
  /** Index into `primary` of the primary entry this item belongs to. */
  owner: number;
  parent: boolean;
}

export interface HistoryListValue {
  status: "ready";
  rows: HistorySessionRow[];
  /** Rows whose file vanished since the index was written. */
  deleted_paths: string[];
  /** Rows whose identity changed; the service asks the writer to refresh. */
  changed_paths: string[];
  has_more: boolean;
  revision: string;
  stat_count: number;
}

export type HistoryListResult =
  | HistoryListValue
  | { status: "missing" | "building" | "unavailable" | "no_db" };

export interface HistoryReadValue {
  status: "ready";
  session: HistorySessionRow;
  items: HistoryWorkerItem[];
  primary: Array<{ entry_id: string; timestamp: string }>;
  has_older: boolean;
  stat_count: number;
}

export type HistoryReadResult =
  | HistoryReadValue
  | {
      status: "missing";
      workspace_state?: "ready" | "building" | "unavailable";
    }
  | { status: "building" | "changed" | "deleted" | "no_db" | "stale" };

export interface HistoryBodyValue {
  digest: string;
  total_bytes: number;
  offset_bytes: number;
  next_offset_bytes: number;
  data_base64: string;
  source_bytes_read: number;
  sidecar_bytes_read: number;
  cache_hit: boolean;
  decode_ms: number;
  materialized: boolean;
  stat_count: number;
}

export type HistoryBodyResult = HistoryBodyValue;

/** Every indexed body field of ONE event (R3 manifest; see handleReaderFields). */
export interface HistoryFieldsValue {
  status: "ready";
  fields: HistoryWorkerRef[];
}

export interface HistoryStatsValue {
  sessions: number;
  working: boolean;
}

export interface BuildStepValue {
  step: AdvanceResult | ReconcileResult;
  metrics: BuildMetrics;
}

export type HistoryRefreshValue = RefreshResult;

// ── Small helpers ────────────────────────────────────────────────────────────

class WorkerRequestError extends Error {
  constructor(readonly code: HistoryWorkerErrorCode) {
    super(code);
    this.name = "WorkerRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(value: unknown): boolean {
  return value === true;
}

/**
 * Parse the live-writer attribution list into a file-keyed lookup.
 *
 * A malformed entry is DROPPED (never guessed): a wrong attribution would let
 * the writer skip a rebuild it should have done.
 */
function trustedWriters(value: unknown): Map<string, TrustedWriterPayload> {
  const out = new Map<string, TrustedWriterPayload>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sessionId = stringField(item["session_id"]);
    const file = stringField(item["file"]);
    if (sessionId === null || sessionId === "" || file === null || file === "") continue;
    out.set(file, { session_id: sessionId, file, span: trustedSpan(item["span"]) });
  }
  return out;
}

/** The verified writer for [file] when it also matches [sessionId]. */
function trustedFor(
  writers: Map<string, TrustedWriterPayload>,
  file: string,
  sessionId: string | null,
): TrustedWriterPayload | null {
  for (const [key, writer] of writers) {
    if (!sameFilePath(key, file)) continue;
    if (sessionId !== null && writer.session_id !== sessionId) return null;
    return writer;
  }
  return null;
}

/** One verified writer payload from the service, or null (nothing guessed). */
function trustedPayload(value: unknown): TrustedWriterPayload | null {
  if (!isRecord(value)) return null;
  const sessionId = stringField(value["session_id"]);
  const file = stringField(value["file"]);
  if (sessionId === null || sessionId === "" || file === null || file === "") return null;
  return { session_id: sessionId, file, span: trustedSpan(value["span"]) };
}

/** One custody span from the service, or null (nothing guessed). */
function trustedSpan(value: unknown): TrustedWriterSpan | null {
  if (!isRecord(value)) return null;
  const before = trustedStamp(value["before"]);
  const after = trustedStamp(value["after"]);
  if (before === null || after === null) return null;
  if (after.size < before.size) return null;
  return { before, after };
}

/**
 * Parse one stamp, or null when it is absent/malformed.
 *
 * A malformed stamp is NULL, never a guessed one: the worker's only reaction to
 * "no evidence" is a conservative rebuild, which is always safe.
 */
function trustedStamp(value: unknown): TrustedWriterStamp | null {
  if (!isRecord(value)) return null;
  const ino = value["ino"];
  const birthtime = value["birthtime_ms"];
  const size = value["size"];
  const mtime = value["mtime_ms"];
  const ctime = value["ctime_ms"];
  const numeric = (candidate: unknown): boolean => typeof candidate === "number" && Number.isFinite(candidate);
  if (!numeric(ino) || !numeric(birthtime) || !numeric(mtime) || !numeric(ctime)) return null;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return null;
  return {
    ino: ino as number,
    birthtime_ms: birthtime as number,
    size,
    mtime_ms: mtime as number,
    ctime_ms: ctime as number,
  };
}

/** Windows-safe comparison of two absolute paths (both come from the host). */
function sameFilePath(left: string, right: string): boolean {
  if (left === right) return true;
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : false;
}

function statIdentity(file: string): { ino: number; birthtime_ms: number; size: number; mtime_ms: number; ctime_ms: number } | null {
  try {
    const stat = fs.statSync(file);
    return {
      ino: Number(stat.ino) || 0,
      birthtime_ms: Number(stat.birthtimeMs) || 0,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
    };
  } catch {
    return null;
  }
}

function sourceStamp(identity: { ino: number; birthtime_ms: number; size: number; mtime_ms: number; ctime_ms: number }): string {
  return sourceStampOf(identity);
}

// ── Role state ───────────────────────────────────────────────────────────────

interface WatchState {
  watcher: fs.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  bucket: string;
  remoteHome: string | null;
  trusted: Map<string, TrustedWriterPayload>;
  maxFiles: number;
}

const watches = new Map<string, WatchState>();
const readerBodies = new Map<string, HistoryBodyStore>();

function writerForRequest(remoteHome: string | null) {
  const db = writerFor(historyDbPath(remoteHome ?? undefined));
  const opened = db.open();
  if (!opened.ok) throw new WorkerRequestError("internal");
  return db;
}

function readerForRequest(remoteHome: string | null) {
  return readerFor(historyDbPath(remoteHome ?? undefined));
}

function bodiesFor(remoteHome: string | null): HistoryBodyStore {
  const root = historyBodiesRoot(remoteHome ?? undefined);
  const existing = readerBodies.get(root);
  if (existing !== undefined) return existing;
  const store = new HistoryBodyStore({ root, budgetBytes: BODY_SIDECAR_BUDGET_BYTES });
  readerBodies.set(root, store);
  return store;
}

/**
 * The watcher is a HINT only: it schedules a reconcile (which stats and
 * compares), it never publishes anything itself. It is deliberately
 * `persistent:false` so it cannot keep the supervisor alive.
 */
function ensureWatch(input: {
  bucket: string;
  remoteHome: string | null;
  trusted: Map<string, TrustedWriterPayload>;
  maxFiles: number;
}): void {
  const existing = watches.get(input.bucket);
  if (existing !== undefined) {
    existing.trusted = input.trusted;
    existing.remoteHome = input.remoteHome;
    existing.maxFiles = input.maxFiles;
    return;
  }
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(input.bucket, { persistent: false }, () => {
      const state = watches.get(input.bucket);
      if (state === undefined || state.timer !== null) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        try {
          const writer = writerForRequest(state.remoteHome);
          reconcileWorkspace(writer, {
            workspace: state.bucket,
            bucket: state.bucket,
            max_files: state.maxFiles,
            trusted: (file, sessionId) => trustedFor(state.trusted, file, sessionId),
          });
        } catch {
          // A watcher-triggered reconcile is best-effort. The next explicit
          // request/reconcile retries; the watcher is never the source of truth.
        }
      }, 100);
      state.timer.unref?.();
    });
  } catch {
    return;
  }
  watcher.on("error", () => {
    // Missed events are expected (overflow/rename). Explicit/periodic reconcile
    // is the correctness path; the watcher only lowers latency.
    const state = watches.get(input.bucket);
    if (state === undefined) return;
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
    watches.delete(input.bucket);
  });
  watcher.unref?.();
  watches.set(input.bucket, {
    watcher,
    timer: null,
    bucket: input.bucket,
    remoteHome: input.remoteHome,
    trusted: input.trusted,
    maxFiles: input.maxFiles,
  });
}

function closeWatches(): void {
  for (const state of watches.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
    try {
      state.watcher.close();
    } catch {
      /* already closed */
    }
  }
  watches.clear();
}

// ── Writer handler ───────────────────────────────────────────────────────────

async function handleWriterRequest(request: Record<string, unknown>): Promise<unknown> {
  switch (request["kind"]) {
    case "advance": {
      const bucket = stringField(request["bucket"]);
      if (bucket === null) throw new WorkerRequestError("internal");
      const remoteHome = stringField(request["remote_home"]);
      const writer = writerForRequest(remoteHome);
      const trusted = trustedWriters(request["trusted_writers"]);
      const result = advanceWorkspace(writer, {
        workspace: bucket,
        bucket,
        max_files: numberField(request["max_files"], 256),
        max_bytes: numberField(request["max_bytes"], 32 * 1024 * 1024),
        trusted: (file, sessionId) => trustedFor(trusted, file, sessionId),
      });
      ensureWatch({
        bucket,
        remoteHome,
        trusted,
        maxFiles: Math.max(16, numberField(request["max_files"], 256)),
      });
      return { step: result, metrics: result.metrics } satisfies BuildStepValue;
    }
    case "reconcile": {
      const bucket = stringField(request["bucket"]);
      if (bucket === null) throw new WorkerRequestError("internal");
      const remoteHome = stringField(request["remote_home"]);
      const trusted = trustedWriters(request["trusted_writers"]);
      const writer = writerForRequest(remoteHome);
      const maxFiles = numberField(request["max_files"], 64);
      const result = reconcileWorkspace(writer, {
        workspace: bucket,
        bucket,
        max_files: maxFiles,
        trusted: (file, sessionId) => trustedFor(trusted, file, sessionId),
      });
      ensureWatch({ bucket, remoteHome, trusted, maxFiles });
      return { step: result, metrics: result.metrics } satisfies BuildStepValue;
    }
    case "refresh_paths": {
      const bucket = stringField(request["bucket"]);
      if (bucket === null) throw new WorkerRequestError("internal");
      const paths = Array.isArray(request["paths"])
        ? request["paths"].filter((path): path is string => typeof path === "string")
        : [];
      const remoteHome = stringField(request["remote_home"]);
      const trusted = trustedWriters(request["trusted_writers"]);
      const writer = writerForRequest(remoteHome);
      const result = refreshPaths(writer, {
        workspace: bucket,
        bucket,
        paths,
        trusted: (file, sessionId) => trustedFor(trusted, file, sessionId),
      });
      ensureWatch({ bucket, remoteHome, trusted, maxFiles: 64 });
      return { step: result, metrics: result.metrics } satisfies BuildStepValue;
    }
    case "refresh_file": {
      const bucket = stringField(request["bucket"]);
      const file = stringField(request["file"]);
      if (bucket === null || file === null) throw new WorkerRequestError("internal");
      if (!isPathInside(file, bucket)) throw new WorkerRequestError("stale");
      const remoteHome = stringField(request["remote_home"]);
      const writer = writerForRequest(remoteHome);
      const result = refreshSessionFile(writer, {
        workspace: bucket,
        bucket,
        file,
        sessionIdHint: stringField(request["session_id"]),
        trusted: trustedPayload(request["trusted"]),
      });
      return result satisfies HistoryRefreshValue;
    }
    case "ensure_session": {
      const bucket = stringField(request["bucket"]);
      const sessionId = stringField(request["session_id"]);
      if (bucket === null || sessionId === null) throw new WorkerRequestError("internal");
      const remoteHome = stringField(request["remote_home"]);
      const writer = writerForRequest(remoteHome);
      return ensureSessionFile(writer, {
        workspace: bucket,
        bucket,
        sessionId,
        trusted: trustedPayload(request["trusted"]),
      }) satisfies HistoryRefreshValue;
    }
    case "dispose": {
      closeWatches();
      return null;
    }
    default:
      throw new WorkerRequestError("internal");
  }
}

// ── Reader handler ───────────────────────────────────────────────────────────

function toWorkerRef(ref: HistoryStoredEvent["refs"][number]): HistoryWorkerRef {
  return {
    field: ref.field,
    representation: ref.representation,
    mime: ref.mime,
    total_bytes: ref.total_bytes,
    digest: ref.digest,
    preview: ref.preview,
    preview_truncated: ref.preview_truncated,
  };
}

function injectSeed(events: HistoryStoredEvent[], seedUserId: string | null, entryId: string): HistoryStoredEvent[] {
  if (seedUserId === null) return events;
  return events.map((event) => {
    if (event.event["type"] !== "agent_message") return event;
    return { ...event, event: { ...event.event, in_reply_to: seedUserId || entryId } };
  });
}

function toolCallIdsOf(events: readonly HistoryStoredEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.event["type"] !== "tool_request") continue;
    const id = event.event["tool_call_id"];
    if (typeof id === "string" && id !== "") out.push(id);
  }
  return out;
}

function toolResultIdOf(events: readonly HistoryStoredEvent[]): string | null {
  for (const event of events) {
    if (event.event["type"] !== "tool_result") continue;
    const id = event.event["tool_call_id"];
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

function handleReaderList(request: Record<string, unknown>): HistoryListResult {
  const bucket = stringField(request["bucket"]);
  if (bucket === null) throw new WorkerRequestError("internal");
  const remoteHome = stringField(request["remote_home"]);
  const reader = readerForRequest(remoteHome);
  const beforeRaw = request["before"];
  let before: { mtime: number; id: string } | null = null;
  if (isRecord(beforeRaw)) {
    const mtime = beforeRaw["mtime"];
    const id = beforeRaw["id"];
    if (typeof mtime === "number" && typeof id === "string") before = { mtime, id };
  }
  const list = reader.list(bucket, numberField(request["limit"], 50), before);
  if (list.state !== "ready") return { status: list.state };

  const rows: HistorySessionRow[] = [];
  const deleted: string[] = [];
  const changed: string[] = [];
  let statCount = 0;
  for (const row of list.rows) {
    statCount += 1;
    const identity = statIdentity(row.path);
    if (identity === null) {
      deleted.push(row.path);
      continue;
    }
    if (identity.ino !== row.ino || identity.birthtime_ms !== row.birthtime_ms) {
      changed.push(row.path);
      continue;
    }
    if (sourceStamp(identity) !== row.source_stamp) {
      changed.push(row.path);
      continue;
    }
    rows.push(row);
  }
  return {
    status: "ready",
    rows,
    deleted_paths: deleted,
    changed_paths: changed,
    has_more: list.has_more,
    revision: list.revision,
    stat_count: statCount,
  };
}

function handleReaderRead(request: Record<string, unknown>): HistoryReadResult {
  const bucket = stringField(request["bucket"]);
  const sessionId = stringField(request["session_id"]);
  if (bucket === null || sessionId === null) throw new WorkerRequestError("internal");
  const remoteHome = stringField(request["remote_home"]);
  const reader = readerForRequest(remoteHome);
  if (!reader.open()) return { status: "no_db" };
  const workspace = reader.workspace(bucket);
  const row = reader.session(bucket, sessionId);
  if (row === null) {
    return { status: "missing", ...(workspace !== null ? { workspace_state: workspace.state } : {}) };
  }
  if (row.state === "building") return { status: "building" };

  const identity = statIdentity(row.path);
  if (identity === null) return { status: "deleted" };
  const stamp = sourceStamp(identity);
  if (stamp !== row.source_stamp) {
    // Even a trusted append changes the newest page: the writer must append the
    // new complete lines before this request can claim to be current. The
    // service then retries; for an OLD snapshot the appended entries do not
    // affect the requested page, but the generation/high-water check still
    // decides staleness honestly.
    return { status: "changed" };
  }

  const generation = stringField(request["generation"]);
  const highWater = typeof request["high_water"] === "number" ? request["high_water"] : null;
  if (generation !== null && generation !== row.generation) return { status: "stale" };
  /*
   * R5 — the requested snapshot boundary is ENFORCED, not merely compared.
   *
   * A high-water past the indexed bytes cannot be an old snapshot of this
   * generation: it would let a caller ask for a page that never existed (and, if
   * we simply ignored it, silently hand out newer data under an old token).
   * A high-water that is not a COMPLETE-LINE boundary is equally impossible for
   * a snapshot the host issued — the index only records complete lines — so a
   * token pointing into a torn tail is refused instead of being clamped to a
   * plausible-looking page.
   */
  if (highWater !== null) {
    if (highWater > row.high_water) return { status: "stale" };
    if (highWater > 0 && !isLineBoundary(row.path, highWater)) return { status: "stale" };
  }

  const beforeRaw = request["before"];
  let before: { timestamp: string; id: string } | null = null;
  if (isRecord(beforeRaw)) {
    const timestamp = beforeRaw["timestamp"];
    const id = beforeRaw["id"];
    if (typeof timestamp === "string" && typeof id === "string") before = { timestamp, id };
  }

  const page = reader.page(
    bucket,
    sessionId,
    row.generation,
    numberField(request["window_limit"], numberField(request["limit"], 30)),
    before,
    { inclusive: request["before_inclusive"] === true, highWater },
  );
  const primaryEntries = page.entries;
  const primaryIndex = new Map(primaryEntries.map((entry, index) => [entry.entry_id, index]));
  const primaryEvents = primaryEntries.map((entry) => injectSeed(parseStoredEvents(entry.projections), reader.seedAt(bucket, sessionId, row.generation, entry, highWater), entry.entry_id));

  // Tool parents: one indexed lookup per orphaned result, no reverse scan.
  const declared = new Set<string>();
  for (const events of primaryEvents) for (const id of toolCallIdsOf(events)) declared.add(id);
  const parents: Array<{ entry: HistoryEntryRow; owner: number }> = [];
  const seenParents = new Set<string>();
  for (let index = 0; index < primaryEntries.length; index += 1) {
    const entry = primaryEntries[index]!;
    if (entry.role !== "toolResult") continue;
    const toolCallId = toolResultIdOf(primaryEvents[index]!);
    if (toolCallId === null || declared.has(toolCallId)) continue;
    const parentId = reader.toolCallParent(
      bucket,
      sessionId,
      row.generation,
      toolCallId,
      entry.timestamp,
      highWater,
    );
    if (parentId === null || primaryIndex.has(parentId) || seenParents.has(parentId)) continue;
    const parentEntry = reader.entry(bucket, sessionId, row.generation, parentId);
    if (parentEntry === null) continue;
    seenParents.add(parentId);
    parents.push({ entry: parentEntry, owner: index });
    for (const id of toolCallIdsOf(parseStoredEvents(parentEntry.projections))) declared.add(id);
  }

  const ordered: Array<{
    entry: HistoryEntryRow;
    events: HistoryStoredEvent[];
    owner: number;
    parent: boolean;
  }> = [
    ...parents.map((parent) => ({
      entry: parent.entry,
      events: injectSeed(parseStoredEvents(parent.entry.projections), reader.seedAt(bucket, sessionId, row.generation, parent.entry, highWater), parent.entry.entry_id),
      owner: parent.owner,
      parent: true,
    })),
    ...primaryEntries.map((entry, index) => ({
      entry,
      events: primaryEvents[index]!,
      owner: index,
      parent: false,
    })),
  ];
  ordered.sort((left, right) => {
    const byTimestamp = left.entry.timestamp.localeCompare(right.entry.timestamp);
    return byTimestamp === 0 ? left.entry.entry_id.localeCompare(right.entry.entry_id) : byTimestamp;
  });

  const items: HistoryWorkerItem[] = [];
  for (const current of ordered) {
    for (const event of current.events) {
      const offset = items.length === numberField(request["delivered_items"], 0)
        ? numberField(request["delivered_refs"], 0) : 0;
      const fields = reader.fieldsOfEvent(bucket, sessionId, row.generation, event.entry_id, event.event_id, offset, 17);
      items.push({
        event_id: event.event_id,
        entry_id: event.entry_id,
        event: event.event,
        refs: fields.slice(0, 16).map((field) => ({
          field: field.field, representation: field.representation, mime: field.mime,
          total_bytes: field.total_bytes, digest: field.digest, preview: null, preview_truncated: true,
        })),
        ref_offset: offset,
        refs_more: fields.length > 16,
        truncated: event.truncated,
        owner: current.owner,
        parent: current.parent,
      });
    }
  }

  return {
    status: "ready",
    session: row,
    items,
    primary: primaryEntries.map((entry) => ({ entry_id: entry.entry_id, timestamp: entry.timestamp })),
    has_older: page.has_older,
    stat_count: 1,
  };
}

/**
 * Is [offset] a complete-line boundary (i.e. the byte before it is `\n`)?
 *
 * O(1): one byte read. Used to refuse a snapshot token that points into a torn
 * tail — the index only ever records complete lines, so such a token cannot
 * have been issued by this host for this generation.
 */
function isLineBoundary(file: string, offset: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const byte = Buffer.allocUnsafe(1);
    return fs.readSync(fd, byte, 0, 1, offset - 1) === 1 && byte[0] === 0x0a;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Every indexed body field of one event (R3 manifest).
 *
 * `history_read` caps an item at `HISTORY_MAX_BODY_REFS_PER_ITEM` refs and
 * continues the remainder on later pages, so this handler exists for the
 * pathological manifests the wire deliberately never carries whole: an event
 * with hundreds of images. It is an indexed lookup by primary ke
 */
function handleReaderFields(request: Record<string, unknown>): HistoryFieldsValue {
  const bucket = stringField(request["bucket"]);
  const sessionId = stringField(request["session_id"]);
  const generation = stringField(request["generation"]);
  const entryId = stringField(request["entry_id"]);
  const eventId = stringField(request["event_id"]);
  if (
    bucket === null ||
    sessionId === null ||
    generation === null ||
    entryId === null ||
    eventId === null
  ) {
    throw new WorkerRequestError("internal");
  }
  const remoteHome = stringField(request["remote_home"]);
  const reader = readerForRequest(remoteHome);
  if (!reader.open()) throw new WorkerRequestError("stale");
  const row = reader.session(bucket, sessionId);
  if (row === null || row.state === "building") throw new WorkerRequestError("stale");
  if (row.generation !== generation) throw new WorkerRequestError("stale");
  const fields = reader.fieldsOfEvent(bucket, sessionId, generation, entryId, eventId);
  return {
    status: "ready",
    fields: fields.map((field) => ({
      field: field.field,
      representation: field.representation,
      mime: field.mime,
      total_bytes: field.total_bytes,
      digest: field.digest,
      preview: null,
      preview_truncated: true,
    })),
  };
}

function bodyFieldSpec(
  row: HistorySessionRow,
  field: HistoryFieldRow,
): BodyFieldSpec {
  let spans: Array<{ start: number; end: number }> = [];
  try {
    const parsed = JSON.parse(field.spans) as unknown;
    if (Array.isArray(parsed)) {
      for (const span of parsed) {
        if (typeof span !== "object" || span === null || Array.isArray(span)) continue;
        const record = span as Record<string, unknown>;
        if (typeof record["start"] === "number" && typeof record["end"] === "number") {
          spans.push({ start: record["start"], end: record["end"] });
        }
      }
    }
  } catch {
    spans = [];
  }
  return {
    workspace: row.workspace,
    session_id: row.session_id,
    generation: row.generation,
    entry_id: field.entry_id,
    event_id: field.event_id,
    field: field.field,
    representation: field.representation,
    mime: field.mime,
    spans,
    synthetic_base64: field.synthetic_base64,
    total_bytes: field.total_bytes,
    digest: field.digest,
  };
}

function handleReaderBody(request: Record<string, unknown>): HistoryBodyResult {
  const bucket = stringField(request["bucket"]);
  const sessionId = stringField(request["session_id"]);
  const generation = stringField(request["generation"]);
  const entryId = stringField(request["entry_id"]);
  const eventId = stringField(request["event_id"]);
  const fieldName = stringField(request["field"]);
  if (
    bucket === null ||
    sessionId === null ||
    generation === null ||
    entryId === null ||
    eventId === null ||
    fieldName === null
  ) {
    throw new WorkerRequestError("internal");
  }
  const remoteHome = stringField(request["remote_home"]);
  const reader = readerForRequest(remoteHome);
  if (!reader.open()) throw new WorkerRequestError("stale");
  const row = reader.session(bucket, sessionId);
  if (row === null) throw new WorkerRequestError("stale");
  if (row.state === "building") throw new WorkerRequestError("stale");
  if (row.generation !== generation) throw new WorkerRequestError("stale");

  const field = reader.field(bucket, sessionId, generation, entryId, eventId, fieldName);
  if (field === null) throw new WorkerRequestError("unsupported");
  const expectedDigest = stringField(request["expected_digest"]);
  const expectedTotal = numberField(request["expected_total_bytes"], -1);
  if (expectedDigest !== null && field.digest !== expectedDigest) throw new WorkerRequestError("stale");
  if (expectedTotal >= 0 && field.total_bytes !== expectedTotal) throw new WorkerRequestError("stale");

  const identity = statIdentity(row.path);
  if (identity === null) throw new WorkerRequestError("stale");
  if (identity.ino !== row.ino || identity.birthtime_ms !== row.birthtime_ms) throw new WorkerRequestError("stale");
  const trusted = trustedPayload(request["trusted"]);
  if (sourceStamp(identity) !== row.source_stamp) {
    /*
     * R2 — a changed file is only survivable with a COMPLETE custody range:
     *
     *   - the receipt names THIS session and THIS file, AND
     *   - `span.before` IS the identity the index recorded, i.e. the file was
     *     untouched from our last verification up to the writer's first write.
     *
     * Anything else — including a null span — is stale, and the caller rebuilds
     * conservatively. A size observation alone is never enough.
     */
    if (
      trusted === null ||
      trusted.session_id !== row.session_id ||
      !sameFilePath(trusted.file, row.path) ||
      trusted.span === null ||
      sourceStamp(trusted.span.before) !== row.source_stamp
    ) {
      throw new WorkerRequestError("stale");
    }
  }

  const spec = bodyFieldSpec(row, field);
  const maxSpanEnd = spec.spans.reduce((max, span) => Math.max(max, span.end), 0);
  if (identity.size < maxSpanEnd) throw new WorkerRequestError("stale");

  const store = bodiesFor(remoteHome);
  const chunk = store.chunk(
    spec,
    row.path,
    { ino: identity.ino, birthtime_ms: identity.birthtime_ms, size: identity.size },
    numberField(request["offset_bytes"], 0),
    numberField(request["chunk_bytes"], 0),
    { trustedAppend: trusted !== null },
  );
  if (!chunk.ok) {
    const code: BodyStoreErrorCode = chunk.code;
    throw new WorkerRequestError(code === "body_too_large" ? "body_too_large" : code === "stale" ? "stale" : "internal");
  }
  return {
    digest: chunk.value.digest,
    total_bytes: chunk.value.total_bytes,
    offset_bytes: chunk.value.offset_bytes,
    next_offset_bytes: chunk.value.next_offset_bytes,
    data_base64: chunk.value.data_base64,
    source_bytes_read: chunk.value.source_bytes_read,
    sidecar_bytes_read: chunk.value.sidecar_bytes_read,
    cache_hit: chunk.value.cache_hit,
    decode_ms: chunk.value.decode_ms,
    materialized: chunk.value.materialized,
    stat_count: 1,
  };
}

async function handleReaderRequest(request: Record<string, unknown>): Promise<unknown> {
  switch (request["kind"]) {
    case "list":
      return handleReaderList(request);
    case "read":
      return handleReaderRead(request);
    case "fields":
      return handleReaderFields(request);
    case "body":
      return handleReaderBody(request);
    case "revoke": {
      const remoteHome = stringField(request["remote_home"]);
      const generations = Array.isArray(request["generations"])
        ? request["generations"].filter((generation): generation is string => typeof generation === "string")
        : [];
      const store = bodiesFor(remoteHome);
      let removed = 0;
      for (const generation of generations) removed += store.revokeGeneration(generation);
      return { removed };
    }
    case "stats": {
      const bucket = stringField(request["bucket"]);
      if (bucket === null) throw new WorkerRequestError("internal");
      const reader = readerForRequest(remoteHomeOf(request));
      const workspace = reader.workspace(bucket);
      const open = reader.open();
      return {
        sessions: open ? reader.countSessions(bucket) : 0,
        working: workspace?.state === "building",
      } satisfies HistoryStatsValue;
    }
    case "dispose": {
      closeIndexHandles();
      for (const store of readerBodies.values()) store.dispose();
      readerBodies.clear();
      return null;
    }
    default:
      throw new WorkerRequestError("internal");
  }
}

function remoteHomeOf(request: Record<string, unknown>): string | null {
  return stringField(request["remote_home"]);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Handle one request. Exported so the inline/test port runs the SAME code as
 * the real worker thread. Returns null only for a frame that is not a request.
 */
export async function handleHistoryWorkerRequest(
  request: unknown,
  role?: HistoryWorkerRole,
): Promise<HistoryWorkerReply | null> {
  if (!isRecord(request)) return null;
  const id = request["id"];
  const kind = request["kind"];
  if (typeof id !== "number" || !Number.isInteger(id) || typeof kind !== "string") return null;

  const fail = (code: HistoryWorkerErrorCode): HistoryWorkerErrorReply => ({ id, ok: false, error: { code } });
  const isWriterKind = kind === "advance" || kind === "reconcile" || kind === "refresh_paths" || kind === "refresh_file" || kind === "ensure_session";
  const isReaderKind = kind === "list" || kind === "read" || kind === "fields" || kind === "body" || kind === "stats" || kind === "revoke";
  try {
    if (role === "writer" && isReaderKind) return fail("internal");
    if (role === "reader" && isWriterKind) return fail("internal");
    if (isWriterKind) return { id, ok: true, value: await handleWriterRequest(request) };
    if (isReaderKind) return { id, ok: true, value: await handleReaderRequest(request) };
    if (kind === "dispose") {
      closeWatches();
      closeIndexHandles();
      for (const store of readerBodies.values()) store.dispose();
      readerBodies.clear();
      return { id, ok: true, value: null };
    }
    return null;
  } catch (error) {
    if (error instanceof WorkerRequestError) return fail(error.code);
    if (process.env["RP86_DEBUG"] === "1") {
      process.stderr.write(`[history-worker] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    return fail("internal");
  }
}

/** Minimal MessagePort surface shared by `worker_threads` and the inline shim. */
export interface HistoryWorkerMessagePort {
  on(event: "message", handler: (value: unknown) => void): unknown;
  postMessage(message: unknown): void;
}

/**
 * Attach the worker to a message port and process requests strictly ONE at a
 * time. Serialization is what keeps the byte/parse budgets meaningful: two
 * concurrent 100 MiB scans would defeat them.
 */
export function attachHistoryWorker(port: HistoryWorkerMessagePort, role?: HistoryWorkerRole): void {
  let chain: Promise<void> = Promise.resolve();
  port.on("message", (raw) => {
    chain = chain.then(async () => {
      const reply = await handleHistoryWorkerRequest(raw, role);
      if (reply !== null) port.postMessage(reply);
    });
    chain = chain.catch(() => undefined);
  });
}

