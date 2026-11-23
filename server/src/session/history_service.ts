/**
 * Plan 86 P2 — host-native workspace history service (writer + reader).
 *
 * Runs inside `pi-supervisord` (the host room) with ZERO Pi processes. It owns
 * two bounded workers and nothing else:
 *
 *   writer — the ONLY SQLite writer for `<REMOTE_PI_HOME>/.pi/remote/history-v1.sqlite`
 *            (schema/migration/upsert/delete/generation publication, cold build,
 *            reconcile, trusted append).
 *   reader — a READ-ONLY connection for keyset pages + the generation-scoped
 *            body sidecar.
 *
 * The hot list/read path never scans a bucket: the index serves one keyset page
 * and only the RETURNED page rows are stat'ed. A missing/changed row is handed
 * back to the writer (targeted refresh); a changed 100 MiB file is rebuilt in
 * the worker, never on the supervisor thread.
 *
 * WIRE CONTRACT
 *
 * Unchanged from P1 (`protocol/history.ts`): the same frames, tokens, limits,
 * error vocabulary and 256 KiB encoded-frame fitting. Only the engine behind
 * the seams changed. The supervisor's control plane stays responsive because
 * every disk parse/decode happens in a worker thread in production; the inline
 * port exists only for source-mode tests.
 */

import type {
  HistoryBodyOkWire,
  HistoryCurrentWire,
  HistoryErrorWire,
  HistoryItemWire,
  HistoryListOkWire,
  HistoryReadOkWire,
  HistoryBodyRefWire,
  SessionHistoryEvent,
  WorkspaceState,
} from "../protocol/types.js";
import {
  HISTORY_BODY_EAGER_MAX_BYTES,
  HISTORY_BODY_MAX_TOTAL_BYTES,
  HISTORY_BODY_CHUNK_BYTES,
  HISTORY_DEFAULT_RETRY_AFTER_MS,
  HISTORY_MAX_BODY_REFS_PER_ITEM,
  HISTORY_MAX_ENCODED_FRAME_BYTES,
  HISTORY_PAGE_CACHE_BYTES,
  HISTORY_PROJECTION_VERSION,
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
  fitsHistoryEncodedFrame,
  encodedHostFrameBytes,
  historyErrorReply,
  parseSessionHistoryEvent,
  utf8Preview,
  type HistoryReadCursor,
  type HistoryRequestWire,
} from "../protocol/history.js";
import {
  defaultHistoryWorkerPortFactory,
  hasCompiledHistoryWorker,
  HistoryWorkerClient,
  HistoryWorkerFailure,
  createThreadsHistoryPort,
  type HistoryWorkerFailureCode,
  type HistoryWorkerMode,
  type HistoryWorkerPortFactory,
  type HistoryWorkerRole,
} from "./history_worker_client.js";
import type {
  BuildStepValue,
  HistoryBodyResult,
  HistoryListResult,
  HistoryReadResult,
  HistoryRefreshValue,
  HistoryWorkerItem,
  HistoryWorkerPayload,
  TrustedWriterPayload,
} from "./history_worker.js";
import { agentRootFromEnv, samePath, sessionDirFor } from "./session_paths.js";
import type { HistoryNoticeSpan } from "./history_notice.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** The slice of a registered fleet entry the history service needs. */
export interface HistoryWorkspaceRef {
  daemon_id: string;
  cwd: string;
  name?: string;
}

/**
 * Supervisor runtime authority for `current` and for the trusted-append seam.
 *
 * It is deliberately narrow: the supervisor knows the workspace lifecycle and
 * may know the live session id. It must NOT be derived from disk — that is the
 * "newest file = current" guess the plan forbids.
 *
 * Plan 86 P2 correction (R1/R2) — `session_file`/`append_authority` are the
 * child's OWN writer notice for the incarnation it is currently running. The
 * service requires that chain (not just a session id) before it will classify
 * a growth as an incremental append.
 */
export interface HistoryRuntimeSnapshot {
  state: WorkspaceState;
  session_id: string | null;
  ready: boolean | null;
  /** Absolute session file the live child published, or null. */
  session_file?: string | null;
  /** True only for the CURRENT incarnation of the CURRENT child. */
  append_authority?: boolean;
  /**
   * The custody range the live child proved (R2), or null.
   *
   * The writer requires `span.before` to equal the identity it last indexed,
   * then parses exactly [before.size, after.size). Null (or a mismatch) means
   * the chain is broken and a rebuild is required.
   */
  session_span?: HistoryNoticeSpan | null;
}

export interface HistoryServiceOptions {
  /** Resolve a HOST-REGISTERED workspace id. Returning null = `not_found`. */
  resolveWorkspace(daemonId: string): HistoryWorkspaceRef | null;
  /** Independent runtime snapshot, when the host has one. */
  runtime?(daemonId: string): HistoryRuntimeSnapshot | null;
  /**
   * Optional extra gate, ANDed with the runtime chain (R1/R2).
   *
   * It exists for a host that keeps its own writer bookkeeping; the supervisor
   * does not need it because `runtime()` already carries the child's own notice.
   * A caller cannot use it to WEAKEN the chain — the snapshot check still runs.
   */
  trustedAppend?(daemonId: string, sessionId: string, file: string): boolean;
  /** Transcript root override (tests); defaults to `PI_CODING_AGENT_DIR` or
   *  `~/.pi/agent` WITHOUT importing the SDK. */
  agentRoot?: string;
  /** Remote Pi state root override (tests). Defaults to `REMOTE_PI_HOME`. */
  remoteHome?: string;
  /** Injected worker transport (tests). One port per role. */
  workerPortFactory?: HistoryWorkerPortFactory;
  /** Explicit compiled worker entry (tests compile it to a scratch dir). */
  workerScript?: string;
  workerTimeoutMs?: number;
  /** Files per cold-build step. Lower values make `building` observable. */
  maxFilesPerScan?: number;
  /** Bytes per cold-build step (a single file may exceed it; a line is atomic). */
  maxBytesPerStep?: number;
  /** Bodies above this size return `building` on first materialization. */
  bodyEagerMaxBytes?: number;
  /** Per-body sidecar budget before `body_too_large`. */
  bodyMaxBytes?: number;
  /** Decoded bytes per body chunk (≤64 KiB). */
  chunkBytes?: number;
  /** Wire-page LRU budget (Plan 86 §4.3: 32 MiB/process). */
  pageCacheBytes?: number;
  /** Periodic reconcile for missed watcher events; 0 disables. */
  reconcileIntervalMs?: number;
  /** Delay between background cold-build steps. */
  buildKickMs?: number;
  now?: () => number;
}

/** P0's scalar vocabulary plus P2's separate O(bytes) cost buckets. */
export interface HistoryQueryMetrics {
  queue_ms: number | null;
  query_ms: number | null;
  read_bytes: number | null;
  parsed_entries: number | null;
  cache_hit: boolean | null;
  worker_mode: HistoryWorkerMode;
  /** Cold build is O(file bytes) and must never be confused with a page read. */
  cold_build_ms: number | null;
  cold_build_bytes: number | null;
  cold_build_entries: number | null;
  /** Body materialization is O(body bytes); subsequent chunks are O(chunk). */
  body_decode_ms: number | null;
  body_source_bytes: number | null;
  body_sidecar_bytes: number | null;
  /** Filesystem stats performed on the foreground path (page rows/target only). */
  stat_count: number | null;
}

export interface HistoryOutcome<T> {
  reply: T;
  metrics: HistoryQueryMetrics;
}

type HistoryReply = HistoryListOkWire | HistoryReadOkWire | HistoryBodyOkWire | HistoryErrorWire;
type HistoryReplyRequest = HistoryRequestWire;

interface MetricsAccumulator {
  queue: Array<number | null>;
  read_bytes: number | null;
  parsed_entries: number | null;
  cache_hit: boolean | null;
  cold_build_ms: number | null;
  cold_build_bytes: number | null;
  cold_build_entries: number | null;
  body_decode_ms: number | null;
  body_source_bytes: number | null;
  body_sidecar_bytes: number | null;
  stat_count: number | null;
}

function emptyMetrics(): MetricsAccumulator {
  return {
    queue: [],
    read_bytes: null,
    parsed_entries: null,
    cache_hit: null,
    cold_build_ms: null,
    cold_build_bytes: null,
    cold_build_entries: null,
    body_decode_ms: null,
    body_source_bytes: null,
    body_sidecar_bytes: null,
    stat_count: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workerErrorCode(value: unknown): string | null {
  if (isRecord(value) && typeof value.__historyWorkerError === "string") {
    return value.__historyWorkerError;
  }
  return null;
}

// ── Wire page cache ──────────────────────────────────────────────────────────

interface CachedPage {
  reply: HistoryReadOkWire;
  bytes: number;
}

/**
 * Bounded LRU of read pages. It is keyed by the full snapshot identity:
 * scope + generation + high-water + projection + limit + cursor. Any refresh
 * that changes a generation invalidates the session's entries; an append
 * produces a new high-water key, so a stale page can never be served as the
 * newest one. Correctness still comes from the reader's stat/validation — this
 * cache only skips re-projecting the same immutable page.
 */
class HistoryPageCache {
  private readonly entries = new Map<string, CachedPage>();
  private bytes = 0;

  constructor(private readonly capacity: number) {}

  get(key: string): HistoryReadOkWire | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.reply;
  }

  put(key: string, scope: string, reply: HistoryReadOkWire): void {
    const bytes = Buffer.byteLength(JSON.stringify(reply), "utf8") + Buffer.byteLength(scope, "utf8") + key.length;
    if (bytes > this.capacity) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { reply, bytes });
    this.bytes += bytes;
    while (this.bytes > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      if (evicted !== undefined) this.bytes -= evicted.bytes;
      this.entries.delete(oldest.value);
    }
  }

  invalidateScope(scope: string): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      if (!key.startsWith(scope)) continue;
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }

  size(): number {
    return this.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

export class HistoryService {
  private readonly resolveWorkspace: (daemonId: string) => HistoryWorkspaceRef | null;
  private readonly runtime: ((daemonId: string) => HistoryRuntimeSnapshot | null) | null;
  private readonly trustedAppend: ((daemonId: string, sessionId: string, file: string) => boolean) | null;
  private readonly agentRoot: string;
  private readonly remoteHome: string | null;
  private readonly writer: HistoryWorkerClient;
  private readonly reader: HistoryWorkerClient;
  private readonly workerModeHint: HistoryWorkerMode;
  private readonly maxFilesPerScan: number;
  private readonly maxBytesPerStep: number;
  private readonly bodyEagerMaxBytes: number;
  private readonly bodyMaxBytes: number;
  private readonly chunkBytes: number;
  private readonly buildKickMs: number;
  private readonly now: () => number;
  private readonly pageCache: HistoryPageCache;
  /** Single-flight body materializations, keyed by generation+entry+field. */
  private readonly materializing = new Map<string, Promise<void>>();
  private readonly materialized = new Set<string>();
  private readonly materializationFailures = new Map<string, string>();
  private readonly buildKicks = new Set<string>();
  /** A cold first step is shared, but must not hold a foreground reply open. */
  private readonly initialBuilds = new Map<string, Promise<WorkerCall<BuildStepValue>>>();
  private readonly buildFailures = new Map<string, Extract<WorkerCall<BuildStepValue>, { ok: false }>>();
  private readonly activeWorkspaces = new Map<string, { daemonId: string; bucket: string; at: number }>();
  private readonly reconcileTimer: ReturnType<typeof setInterval> | null;
  private readonly reconcileIntervalMs: number;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: HistoryServiceOptions) {
    this.resolveWorkspace = options.resolveWorkspace;
    this.runtime = options.runtime ?? null;
    this.trustedAppend = options.trustedAppend ?? null;
    this.agentRoot = options.agentRoot ?? agentRootFromEnv();
    this.remoteHome = options.remoteHome ?? (process.env["REMOTE_PI_HOME"]?.trim() || null);
    this.maxFilesPerScan = Math.max(1, Math.floor(options.maxFilesPerScan ?? 256));
    this.maxBytesPerStep = Math.max(1, Math.floor(options.maxBytesPerStep ?? 32 * 1024 * 1024));
    this.bodyEagerMaxBytes = Math.max(0, Math.floor(options.bodyEagerMaxBytes ?? HISTORY_BODY_EAGER_MAX_BYTES));
    this.bodyMaxBytes = Math.max(0, Math.floor(options.bodyMaxBytes ?? HISTORY_BODY_MAX_TOTAL_BYTES));
    this.chunkBytes = Math.min(
      HISTORY_BODY_CHUNK_BYTES,
      Math.max(1, Math.floor(options.chunkBytes ?? HISTORY_BODY_CHUNK_BYTES)),
    );
    this.buildKickMs = Math.max(0, Math.floor(options.buildKickMs ?? 0));
    this.now = options.now ?? (() => Date.now());
    this.pageCache = new HistoryPageCache(Math.max(0, Math.floor(options.pageCacheBytes ?? HISTORY_PAGE_CACHE_BYTES)));
    this.reconcileIntervalMs = Math.max(0, Math.floor(options.reconcileIntervalMs ?? 30_000));

    let portFactory: HistoryWorkerPortFactory = options.workerPortFactory ?? defaultHistoryWorkerPortFactory();
    if (options.workerScript !== undefined) {
      const script = options.workerScript;
      portFactory = (role: HistoryWorkerRole) => createThreadsHistoryPort(script, role);
    }
    this.workerModeHint = options.workerScript !== undefined
      ? "threads"
      : hasCompiledHistoryWorker()
        ? "threads"
        : "inline";
    this.writer = new HistoryWorkerClient({
      portFactory,
      role: "writer",
      ...(options.workerTimeoutMs !== undefined ? { timeoutMs: options.workerTimeoutMs } : {}),
    });
    this.reader = new HistoryWorkerClient({
      portFactory,
      role: "reader",
      ...(options.workerTimeoutMs !== undefined ? { timeoutMs: options.workerTimeoutMs } : {}),
    });

    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcileActive();
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    } else {
      this.reconcileTimer = null;
    }
  }

  /** "threads" when either role uses a real thread, "inline" for the test shim. */
  workerMode(): HistoryWorkerMode {
    const modes = [this.writer.currentMode(), this.reader.currentMode()].filter(
      (mode): mode is HistoryWorkerMode => mode !== null,
    );
    if (modes.includes("threads")) return "threads";
    if (modes.length > 0) return "inline";
    return this.workerModeHint;
  }

  /** The agent root actually used (tests assert it points at scratch). */
  transcriptRoot(): string {
    return this.agentRoot;
  }

  // ── history_list ─────────────────────────────────────────────────────────

  async list(request: Extract<HistoryReplyRequest, { type: "history_list" }>): Promise<HistoryOutcome<HistoryListOkWire | HistoryErrorWire>> {
    const started = this.now();
    const metrics = emptyMetrics();
    const workspace = this.resolveWorkspace(request.daemon_id);
    if (workspace === null) {
      return this.outcome(historyErrorReply(request.id, "not_found", { daemon_id: request.daemon_id }), started, metrics);
    }
    const bucket = sessionDirFor(workspace.cwd, this.agentRoot);
    this.noteActive(workspace.daemon_id, bucket);
    let before: { mtime: number; id: string } | null = null;
    if (request.before !== undefined) {
      const decoded = decodeHistoryListCursor(request.before, { daemon_id: request.daemon_id });
      if (!decoded.ok) {
        return this.outcome(
          historyErrorReply(request.id, "invalid_cursor", { daemon_id: workspace.daemon_id }),
          started,
          metrics,
        );
      }
      before = decoded.before;
    }
    const limit = clampHistoryListLimit(request.limit);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await this.callReader<HistoryListResult>({
        kind: "list",
        remote_home: this.remoteHome,
        bucket,
        limit,
        before,
      });
      if (!listed.ok) {
        return this.outcome(
          historyErrorReply(request.id, mapWorkerError(listed.code), { daemon_id: workspace.daemon_id }),
          started,
          metrics,
        );
      }
      metrics.queue.push(listed.queue_ms);
      const value = listed.value;
      const buildFailure = this.takeBuildFailure(bucket);
      if (buildFailure !== null) {
        return this.outcome(historyErrorReply(request.id, mapWorkerError(buildFailure), { daemon_id: workspace.daemon_id }), started, metrics);
      }

      if (value.status === "unavailable") {
        return this.outcome(
          this.listReply(workspace, request.id, {
            revision: null,
            indexState: "unavailable",
            sessions: [],
            hasMore: false,
            retryAfter: null,
          }),
          started,
          metrics,
        );
      }
      if (value.status === "no_db" || value.status === "missing") {
        const advanced = await this.advanceWorkspace(workspace.daemon_id, bucket, metrics);
        if (!advanced.ok) {
          return this.outcome(historyErrorReply(request.id, "internal", { daemon_id: workspace.daemon_id }), started, metrics);
        }
        if (advanced.state === "unavailable") {
          return this.outcome(
            this.listReply(workspace, request.id, {
              revision: null,
              indexState: "unavailable",
              sessions: [],
              hasMore: false,
              retryAfter: null,
            }),
            started,
            metrics,
          );
        }
        if (advanced.complete) continue;
        this.kickBuild(workspace.daemon_id, bucket);
        return this.outcome(
          this.listReply(workspace, request.id, {
            revision: null,
            indexState: "building",
            sessions: [],
            hasMore: false,
            retryAfter: HISTORY_DEFAULT_RETRY_AFTER_MS,
          }),
          started,
          metrics,
        );
      }
      if (value.status === "building") {
        this.kickBuild(workspace.daemon_id, bucket);
        return this.outcome(
          this.listReply(workspace, request.id, {
            revision: null,
            indexState: "building",
            sessions: [],
            hasMore: false,
            retryAfter: HISTORY_DEFAULT_RETRY_AFTER_MS,
          }),
          started,
          metrics,
        );
      }

      // ready — verify ONLY the returned page rows, never the whole bucket.
      if (value.status !== "ready") {
        return this.outcome(historyErrorReply(request.id, "internal", { daemon_id: workspace.daemon_id }), started, metrics);
      }
      metrics.stat_count = (metrics.stat_count ?? 0) + value.stat_count;
      if (value.deleted_paths.length > 0 || value.changed_paths.length > 0) {
        SqlRetry: {
          const refreshed = await this.callWriter<BuildStepValue>({
            kind: "refresh_paths",
            remote_home: this.remoteHome,
            bucket,
            paths: [...value.deleted_paths, ...value.changed_paths],
            trusted_writers: this.trustedWriters(workspace.daemon_id),
          });
          if (!refreshed.ok) break SqlRetry;
          metrics.queue.push(refreshed.queue_ms);
          this.addBuildMetrics(metrics, refreshed.value.metrics);
          this.revokeSidecars(refreshed.value.step.revoked);
          this.pageCache.invalidateScope(`${workspace.daemon_id}|`);
          continue;
        }
      }

      if (request.if_revision !== undefined && request.if_revision === value.revision) {
        return this.outcome(
          historyErrorReply(request.id, "not_modified", {
            daemon_id: workspace.daemon_id,
            revision: value.revision,
          }),
          started,
          metrics,
        );
      }

      const rows = value.rows;
      const listRows = rows.map((row) => ({
        row,
        wire: {
          id: row.session_id,
          name: row.name === null ? null : utf8Preview(row.name, 200).text,
          mtime: row.mtime,
          preview: row.preview === null ? null : utf8Preview(row.preview, 200).text,
        },
      }));
      let keep = listRows.length;
      let reply = this.listReply(workspace, request.id, {
        revision: value.revision,
        indexState: "ready",
        sessions: listRows.map((row) => row.wire),
        hasMore: value.has_more,
        rows: listRows,
        retryAfter: null,
      });
      while (!fitsHistoryEncodedFrame(reply) && keep > 1) {
        keep -= 1;
        reply = this.listReply(workspace, request.id, {
          revision: value.revision,
          indexState: "ready",
          sessions: listRows.slice(0, keep).map((row) => row.wire),
          hasMore: true,
          rows: listRows.slice(0, keep),
          retryAfter: null,
        });
      }
      if (!fitsHistoryEncodedFrame(reply) && reply.sessions.length === 1) {
        const only = reply.sessions[0]!;
        reply = { ...reply, sessions: [{ ...only, name: null, preview: null }] };
      }
      if (metrics.cache_hit === null) metrics.cache_hit = rows.length === 0 ? null : true;
      metrics.read_bytes = metrics.read_bytes ?? 0;
      metrics.parsed_entries = metrics.parsed_entries ?? 0;
      return this.outcome(reply, started, metrics);
    }
    return this.outcome(historyErrorReply(request.id, "internal", { daemon_id: workspace.daemon_id }), started, metrics);
  }

  // ── history_read ─────────────────────────────────────────────────────────

  async read(
    request: Extract<HistoryReplyRequest, { type: "history_read" }>,
  ): Promise<HistoryOutcome<HistoryReadOkWire | HistoryErrorWire>> {
    const started = this.now();
    const metrics = emptyMetrics();
    const workspace = this.resolveWorkspace(request.daemon_id);
    if (workspace === null) {
      return this.outcome(historyErrorReply(request.id, "not_found", { daemon_id: request.daemon_id }), started, metrics);
    }
    const scope = { daemon_id: workspace.daemon_id, session_id: request.session_id };
    const bucket = sessionDirFor(workspace.cwd, this.agentRoot);
    this.noteActive(workspace.daemon_id, bucket);

    let snapshot: { generation: string; high_water: number } | null = null;
    if (request.snapshot !== undefined) {
      const decoded = decodeHistorySnapshot(request.snapshot, scope);
      if (!decoded.ok) {
        return this.outcome(historyErrorReply(request.id, "invalid_cursor", scope), started, metrics);
      }
      snapshot = decoded.value;
    }
    let cursor: HistoryReadCursor | null = null;
    if (request.before !== undefined) {
      const decoded = decodeHistoryReadCursor(request.before, scope);
      if (!decoded.ok) {
        return this.outcome(historyErrorReply(request.id, decoded.code, scope), started, metrics);
      }
      cursor = decoded.value;
    }
    if (snapshot !== null && cursor !== null && snapshot.generation !== cursor.generation) {
      return this.outcome(historyErrorReply(request.id, "stale", scope), started, metrics);
    }
    /*
     * R5 — the page-sequence byte boundary.
     *
     * A cursor carries the boundary it was issued at, so following an older
     * page NEVER re-derives it from the current file: an append performed while
     * the client reads must not appear in a sequence that started before it. A
     * snapshot token and a cursor must agree when both are supplied (a forged
     * or crossed pair is `stale`, never silently re-based).
     */
    if (
      snapshot !== null &&
      cursor !== null &&
      cursor.high_water !== null &&
      cursor.high_water !== snapshot.high_water
    ) {
      return this.outcome(historyErrorReply(request.id, "stale", scope), started, metrics);
    }
    const knownGeneration = cursor?.generation ?? snapshot?.generation ?? null;
    /*
     * R5 — the page-sequence boundary. A cursor carries the water it was issued
     * at; a NEW sequence (neither cursor nor snapshot supplied) starts at the
     * current row water, which the reader reports. Either way, every reply of
     * the sequence echoes the SAME boundary.
     */
    const requestedHighWater = cursor?.high_water ?? snapshot?.high_water ?? null;
    const knownHighWater = requestedHighWater;
    /*
     * R1/R2 — one attribution for the whole request. The worker re-checks it
     * against the file it actually holds the row for, so naming the file here is
     * a claim it verifies, not a decision it trusts.
     */
    const trusted = this.trustedWriterFor(workspace.daemon_id, request.session_id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = await this.callReader<HistoryReadResult>({
        kind: "read",
        remote_home: this.remoteHome,
        bucket,
        session_id: request.session_id,
        limit: clampHistoryReadLimit(request.limit),
        ...(cursor?.window_limit !== null && cursor?.window_limit !== undefined
          ? { window_limit: cursor.window_limit }
          : {}),
        /*
         * R4 — a resume cursor pins the window by its INCLUSIVE newest boundary
         * and re-delivers the entry that was only partially sent. An entry-form
         * cursor is exclusive, exactly as before.
         */
        before: cursor?.anchor ?? cursor?.before ?? null,
        before_inclusive: cursor?.anchor !== null && cursor?.anchor !== undefined,
        generation: knownGeneration,
        high_water: knownHighWater,
        delivered_items: cursor?.delivered_items ?? 0,
        delivered_refs: cursor?.delivered_refs ?? 0,
        trusted,
      });
      if (!read.ok) {
        return this.outcome(historyErrorReply(request.id, mapWorkerError(read.code), scope), started, metrics);
      }
      metrics.queue.push(read.queue_ms);
      const value = read.value;
      const buildFailure = this.takeBuildFailure(bucket);
      if (buildFailure !== null) {
        return this.outcome(historyErrorReply(request.id, mapWorkerError(buildFailure), scope), started, metrics);
      }

      if (value.status === "no_db" || value.status === "missing" || value.status === "deleted") {
        if (attempt === 0 && value.status === "no_db") {
          const advanced = await this.advanceWorkspace(workspace.daemon_id, bucket, metrics);
          if (!advanced.ok) return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
          if (advanced.complete) continue;
          if (advanced.state === "unavailable") {
            return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
          }
          this.kickBuild(workspace.daemon_id, bucket);
          return this.outcome(this.buildingReply(request, scope), started, metrics);
        }
        if (attempt === 0 && value.status === "deleted") {
          const refreshed = await this.refreshSession(workspace.daemon_id, bucket, request.session_id, metrics, null);
          if (refreshed === "ready") continue;
          if (refreshed === "building") return this.outcome(this.buildingReply(request, scope), started, metrics);
          return this.outcome(
            historyErrorReply(request.id, snapshot !== null || cursor !== null ? "stale" : "not_found", scope),
            started,
            metrics,
          );
        }
        if (attempt === 0 && value.status === "missing") {
          const workspaceState = "workspace_state" in value ? value.workspace_state : null;
          if (workspaceState === "building") {
            this.kickBuild(workspace.daemon_id, bucket);
            return this.outcome(this.buildingReply(request, scope), started, metrics);
          }
          if (workspaceState === "unavailable") {
            return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
          }
          const refreshed = await this.refreshSession(workspace.daemon_id, bucket, request.session_id, metrics, null);
          if (refreshed === "ready") continue;
          if (refreshed === "building") return this.outcome(this.buildingReply(request, scope), started, metrics);
        }
        return this.outcome(
          historyErrorReply(request.id, snapshot !== null || cursor !== null ? "stale" : "not_found", scope),
          started,
          metrics,
        );
      }
      if (value.status === "building") {
        this.kickBuild(workspace.daemon_id, bucket);
        return this.outcome(this.buildingReply(request, scope), started, metrics);
      }
      if (value.status === "stale") {
        return this.outcome(historyErrorReply(request.id, "stale", scope), started, metrics);
      }
      if (value.status === "changed") {
        if (attempt === 0) {
          const refreshed = await this.refreshSession(
            workspace.daemon_id,
            bucket,
            request.session_id,
            metrics,
            null,
          );
          if (refreshed === "ready") continue;
          if (refreshed === "building") return this.outcome(this.buildingReply(request, scope), started, metrics);
        }
        return this.outcome(
          historyErrorReply(request.id, snapshot !== null || cursor !== null ? "stale" : "building", {
            ...scope,
            retry_after_ms: snapshot === null && cursor === null ? HISTORY_DEFAULT_RETRY_AFTER_MS : null,
          }),
          started,
          metrics,
        );
      }

      // ready
      if (value.status !== "ready") {
        return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
      }
      metrics.stat_count = (metrics.stat_count ?? 0) + value.stat_count;
      if (request.if_revision !== undefined && request.if_revision === value.session.content_revision) {
        return this.outcome(
          historyErrorReply(request.id, "not_modified", {
            ...scope,
            revision: value.session.content_revision,
          }),
          started,
          metrics,
        );
      }
      /*
       * R5 — the fixed boundary for THIS sequence: an explicit snapshot/cursor
       * pins it, otherwise the row's water at the moment the sequence starts.
       * It is echoed in the reply and reused by every later page, so an append
       * can never leak into a sequence that began before it.
       */
      const fixedHighWater = requestedHighWater ?? value.session.high_water;
      const cacheKey = [
        workspace.daemon_id,
        request.session_id,
        value.session.generation,
        String(fixedHighWater),
        `p${HISTORY_PROJECTION_VERSION}`,
        String(clampHistoryReadLimit(request.limit)),
        request.before ?? "newest",
      ].join("|");
      const cacheScope = `${workspace.daemon_id}|${request.session_id}`;
      const cached = this.pageCache.get(cacheKey);
      if (cached !== null && fitsHistoryEncodedFrame({ ...cached, in_reply_to: request.id })) {
        if (metrics.cache_hit === null) metrics.cache_hit = true;
        metrics.read_bytes = metrics.read_bytes ?? 0;
        metrics.parsed_entries = metrics.parsed_entries ?? 0;
        return this.outcome({ ...cached, in_reply_to: request.id }, started, metrics);
      }
      const built = this.buildReadPage(request, workspace.daemon_id, value, fixedHighWater, {
        itemIndex: cursor?.delivered_items ?? 0,
        refsFrom: cursor?.delivered_refs ?? 0,
      }).reply;
      if (built === null) {
        return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
      }
      this.pageCache.put(cacheKey, cacheScope, built);
      if (metrics.cache_hit === null) metrics.cache_hit = false;
      metrics.read_bytes = metrics.read_bytes ?? 0;
      metrics.parsed_entries = metrics.parsed_entries ?? 0;
      return this.outcome({ ...built, in_reply_to: request.id }, started, metrics);
    }
    return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
  }

  // ── history_body ─────────────────────────────────────────────────────────

  async body(
    request: Extract<HistoryReplyRequest, { type: "history_body" }>,
  ): Promise<HistoryOutcome<HistoryBodyOkWire | HistoryErrorWire>> {
    const started = this.now();
    const metrics = emptyMetrics();
    const workspace = this.resolveWorkspace(request.daemon_id);
    const scope = { daemon_id: request.daemon_id, session_id: request.session_id };
    if (workspace === null) {
      return this.outcome(historyErrorReply(request.id, "not_found", { daemon_id: request.daemon_id }), started, metrics);
    }

    const snapshot = decodeHistorySnapshot(request.snapshot, scope);
    if (!snapshot.ok) {
      return this.outcome(historyErrorReply(request.id, "invalid_cursor", scope), started, metrics);
    }
    const ref = decodeHistoryBodyRef(request.body_ref, scope);
    if (!ref.ok) {
      return this.outcome(historyErrorReply(request.id, ref.code, scope), started, metrics);
    }
    if (ref.value.generation !== snapshot.value.generation) {
      return this.outcome(historyErrorReply(request.id, "invalid_cursor", scope), started, metrics);
    }
    if (request.offset_bytes > ref.value.total_bytes) {
      return this.outcome(historyErrorReply(request.id, "invalid_request", scope), started, metrics);
    }
    if (ref.value.total_bytes > this.bodyMaxBytes) {
      return this.outcome(
        historyErrorReply(request.id, "body_too_large", { ...scope, snapshot: request.snapshot }),
        started,
        metrics,
      );
    }

    const bucket = sessionDirFor(workspace.cwd, this.agentRoot);
    this.noteActive(workspace.daemon_id, bucket);
    /*
     * R2 — the body path cannot name a file before the snapshot is resolved, so
     * it uses the session-scoped authority (published file + CURRENT
     * incarnation). The worker still refuses the read when the digest/length of
     * the ref disagree, i.e. when this session was rewritten meanwhile.
     */
    const trusted = this.trustedWriterFor(workspace.daemon_id, request.session_id);
    const materializationKey = [
      workspace.daemon_id,
      request.session_id,
      snapshot.value.generation,
      ref.value.entry_id,
      ref.value.event_id,
      ref.value.field,
    ].join("|");

    const failed = this.materializationFailures.get(materializationKey);
    if (failed !== undefined) {
      this.materializationFailures.delete(materializationKey);
      return this.outcome(
        historyErrorReply(request.id, mapWorkerErrorName(failed), { ...scope, snapshot: request.snapshot }),
        started,
        metrics,
      );
    }
    if (ref.value.total_bytes > this.bodyEagerMaxBytes && !this.materialized.has(materializationKey)) {
      if (!this.materializing.has(materializationKey)) {
        this.startMaterialization(materializationKey, {
          kind: "body",
          remote_home: this.remoteHome,
          bucket,
          session_id: request.session_id,
          generation: snapshot.value.generation,
          entry_id: ref.value.entry_id,
          event_id: ref.value.event_id,
          field: ref.value.field,
          offset_bytes: 0,
          chunk_bytes: 0,
          expected_digest: ref.value.digest,
          expected_total_bytes: ref.value.total_bytes,
          trusted,
        });
      }
      return this.outcome(
        historyErrorReply(request.id, "building", {
          ...scope,
          snapshot: request.snapshot,
          retry_after_ms: HISTORY_DEFAULT_RETRY_AFTER_MS,
        }),
        started,
        metrics,
      );
    }

    const remaining = ref.value.total_bytes - request.offset_bytes;
    const chunk = Math.min(this.chunkBytes, remaining);
    const body = await this.callReader<HistoryBodyResult>({
      kind: "body",
      remote_home: this.remoteHome,
      bucket,
      session_id: request.session_id,
      generation: snapshot.value.generation,
      entry_id: ref.value.entry_id,
      event_id: ref.value.event_id,
      field: ref.value.field,
      offset_bytes: request.offset_bytes,
      chunk_bytes: chunk,
      expected_digest: ref.value.digest,
      expected_total_bytes: ref.value.total_bytes,
      trusted,
    });
    if (!body.ok) {
      return this.outcome(historyErrorReply(request.id, mapWorkerError(body.code), scope), started, metrics);
    }
    metrics.queue.push(body.queue_ms);
    this.addBodyMetrics(metrics, body.value);
    if (body.value.digest !== ref.value.digest) {
      return this.outcome(historyErrorReply(request.id, "stale", scope), started, metrics);
    }
    if (body.value.offset_bytes !== request.offset_bytes) {
      return this.outcome(historyErrorReply(request.id, "internal", scope), started, metrics);
    }
    if (body.value.materialized) this.materialized.add(materializationKey);

    return this.outcome(
      {
        type: "history_body_ok",
        in_reply_to: request.id,
        daemon_id: workspace.daemon_id,
        session_id: request.session_id,
        snapshot: request.snapshot,
        body_ref: request.body_ref,
        representation: ref.value.representation,
        mime: ref.value.mime,
        offset_bytes: body.value.offset_bytes,
        next_offset_bytes: body.value.next_offset_bytes,
        total_bytes: body.value.total_bytes,
        data: body.value.data_base64,
      },
      started,
      metrics,
    );
  }

  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOnce();
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
    this.materializing.clear();
    this.materialized.clear();
    this.materializationFailures.clear();
    this.buildKicks.clear();
    this.initialBuilds.clear();
    this.buildFailures.clear();
    this.activeWorkspaces.clear();
    this.pageCache.clear();
    // Let each role close its SQLite handle / watchers before the thread (or
    // inline shim) is torn down. Failures are expected when a worker already
    // died; the subsequent terminate is the backstop.
    await Promise.allSettled([
      this.writer.request({ kind: "dispose" }).catch(() => undefined),
      this.reader.request({ kind: "dispose" }).catch(() => undefined),
    ]);
    await Promise.allSettled([this.writer.dispose(), this.reader.dispose()]);
  }

  /**
   * Explicit refresh without a wire frame (tests and the periodic reconciler).
   * Never the source of truth for a page: it schedules/executes a reconcile and
   * returns the step metrics.
   */
  async refreshWorkspace(daemonId: string): Promise<HistoryQueryMetrics> {
    const started = this.now();
    const metrics = emptyMetrics();
    const workspace = this.resolveWorkspace(daemonId);
    if (workspace === null) return this.outcomeMetrics(started, metrics);
    const bucket = sessionDirFor(workspace.cwd, this.agentRoot);
    const refreshed = await this.callWriter<BuildStepValue>({
      kind: "reconcile",
      remote_home: this.remoteHome,
      bucket,
      max_files: this.maxFilesPerScan,
      trusted_writers: this.trustedWriters(daemonId),
    });
    if (refreshed.ok) {
      metrics.queue.push(refreshed.queue_ms);
      this.addBuildMetrics(metrics, refreshed.value.metrics);
      this.pageCache.invalidateScope(`${daemonId}|`);
    }
    return this.outcomeMetrics(started, metrics);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private noteActive(daemonId: string, bucket: string): void {
    this.activeWorkspaces.set(bucket, { daemonId, bucket, at: this.now() });
    while (this.activeWorkspaces.size > 64) {
      const oldest = this.activeWorkspaces.keys().next();
      if (oldest.done) break;
      this.activeWorkspaces.delete(oldest.value);
    }
  }

  private async reconcileActive(): Promise<void> {
    if (this.disposed) return;
    const cutoff = this.now() - 5 * 60_000;
    for (const [bucket, entry] of [...this.activeWorkspaces.entries()]) {
      if (entry.at < cutoff) {
        this.activeWorkspaces.delete(bucket);
        continue;
      }
      if (this.disposed) return;
      try {
        const refreshed = await this.callWriter<BuildStepValue>({
          kind: "reconcile",
          remote_home: this.remoteHome,
          bucket,
          max_files: Math.min(64, this.maxFilesPerScan),
          trusted_writers: this.trustedWriters(entry.daemonId),
        });
        if (refreshed.ok) {
          this.revokeSidecars(refreshed.value.step.revoked);
          if (refreshed.value.metrics.files > 0) this.pageCache.invalidateScope(`${entry.daemonId}|`);
        }
      } catch {
        // Periodic reconcile is best-effort; explicit requests still work.
      }
    }
  }

  private async advanceWorkspace(
    daemonId: string,
    bucket: string,
    metrics: MetricsAccumulator,
  ): Promise<{ ok: boolean; complete: boolean; state: "ready" | "building" | "unavailable" }> {
    if (this.disposed) return { ok: false, complete: false, state: "building" };
    if (this.takeBuildFailure(bucket) !== null) return { ok: false, complete: false, state: "building" };
    let pending = this.initialBuilds.get(bucket);
    if (pending === undefined) {
      // A background continuation already owns this bucket's next step.
      if (this.buildKicks.has(bucket)) return { ok: true, complete: false, state: "building" };
      pending = this.callWriter<BuildStepValue>({
        kind: "advance",
        remote_home: this.remoteHome,
        bucket,
        max_files: this.maxFilesPerScan,
        max_bytes: this.maxBytesPerStep,
        trusted_writers: this.trustedWriters(daemonId),
      });
      this.initialBuilds.set(bucket, pending);
      const owned = pending;
      void pending.then((result) => {
        if (this.initialBuilds.get(bucket) === owned) this.initialBuilds.delete(bucket);
        if (this.disposed) return;
        if (!result.ok) this.rememberBuildFailure(bucket, result);
        else if (!result.value.step.complete && result.value.step.state === "building") this.kickBuild(daemonId, bucket);
      });
    }
    // Inline/small work can finish in this turn. Real worker work continues
    // under its existing single-writer ownership after one event-loop yield.
    // Never pass the foreground accumulator into a deferred continuation.
    const advanced = await Promise.race([
      pending,
      new Promise<null>((resolve) => setImmediate(() => resolve(null))),
    ]);
    if (this.disposed) return { ok: false, complete: false, state: "building" };
    if (advanced === null) return { ok: true, complete: false, state: "building" };
    if (!advanced.ok) {
      // This request observed the failure; do not replay it on the next retry.
      if (this.buildFailures.get(bucket) === advanced) this.buildFailures.delete(bucket);
      return { ok: false, complete: false, state: "building" };
    }
    metrics.queue.push(advanced.queue_ms);
    this.addBuildMetrics(metrics, advanced.value.metrics);
    const state = advanced.value.step.state;
    return {
      ok: true,
      complete: advanced.value.step.complete && state !== "unavailable",
      state,
    };
  }

  /** Test seam: the attribution list the writer worker receives (read-only). */
  trustedWritersForTest(daemonId: string): TrustedWriterPayload[] {
    return this.trustedWriters(daemonId);
  }

  /** Test seam: the verified writer for one session, or null. */
  trustedWriterForTest(daemonId: string, sessionId: string): TrustedWriterPayload | null {
    return this.trustedWriterFor(daemonId, sessionId);
  }

  private async refreshSession(
    daemonId: string,
    bucket: string,
    sessionId: string,
    metrics: MetricsAccumulator,
    file: string | null,
  ): Promise<"ready" | "building" | "not_found" | "failed"> {
    /*
     * R1/R2 — attribution is resolved HERE, per file, from the supervisor's
     * authority chain. It is never a boolean the caller passes down, because a
     * boolean cannot say which FILE a live writer owns.
     */
    const trusted = this.trustedWriterFor(daemonId, sessionId, file);
    const refreshed = await this.callWriter<HistoryRefreshValue>(
      file === null
        ? {
            kind: "ensure_session",
            remote_home: this.remoteHome,
            bucket,
            session_id: sessionId,
            trusted,
          }
        : {
            kind: "refresh_file",
            remote_home: this.remoteHome,
            bucket,
            file,
            session_id: sessionId,
            trusted,
          },
    );
    if (!refreshed.ok) return "failed";
    metrics.queue.push(refreshed.queue_ms);
    this.addBuildMetrics(metrics, refreshed.value.metrics);
    this.revokeSidecars(refreshed.value.revoked);
    this.pageCache.invalidateScope(`${daemonId}|${sessionId}`);
    if (refreshed.value.kind === "failed") return "failed";
    if (refreshed.value.kind === "deleted") return "not_found";
    if (refreshed.value.row === null) return "not_found";
    if (refreshed.value.row.state === "building") return "building";
    return "ready";
  }

  private kickBuild(daemonId: string, bucket: string): void {
    if (this.disposed) return;
    if (this.buildKicks.has(bucket) || this.initialBuilds.has(bucket) || this.buildFailures.has(bucket)) return;
    this.buildKicks.add(bucket);
    void (async () => {
      try {
        for (;;) {
          if (this.disposed) return;
          if (this.buildKickMs > 0) await new Promise((resolve) => setTimeout(resolve, this.buildKickMs));
          if (this.disposed) return;
          const advanced = await this.callWriter<BuildStepValue>({
            kind: "advance",
            remote_home: this.remoteHome,
            bucket,
            max_files: this.maxFilesPerScan,
            max_bytes: this.maxBytesPerStep,
            trusted_writers: this.trustedWriters(daemonId),
          });
          if (!advanced.ok) { this.rememberBuildFailure(bucket, advanced); return; }
          if (advanced.value.step.complete || advanced.value.step.state !== "building") return;
        }
      } catch {
        this.rememberBuildFailure(bucket, { ok: false, code: "transport", queue_ms: null });
      } finally {
        this.buildKicks.delete(bucket);
      }
    })();
  }

  private rememberBuildFailure(bucket: string, failure: Extract<WorkerCall<BuildStepValue>, { ok: false }>): void {
    if (this.disposed) return;
    this.buildFailures.set(bucket, failure);
    while (this.buildFailures.size > 64) {
      const oldest = this.buildFailures.keys().next();
      if (oldest.done) break;
      this.buildFailures.delete(oldest.value);
    }
  }

  private takeBuildFailure(bucket: string): string | null {
    const failure = this.buildFailures.get(bucket);
    if (failure === undefined) return null;
    this.buildFailures.delete(bucket);
    return failure.code;
  }

  private revokeSidecars(generations: readonly string[]): void {
    if (generations.length === 0 || this.disposed) return;
    // The sidecar is a disposable cache: revocation is best-effort and must
    // never delay or fail the request that discovered the generation change.
    void this.callReader<{ removed: number }>({
      kind: "revoke",
      remote_home: this.remoteHome,
      generations: [...generations],
    });
  }

  /**
   * The live writer attribution the writer worker may treat as an append chain.
   *
   * Plan 86 P2 correction (R1/R2) — this used to hand over a session id as soon
   * as the runtime snapshot said `running`. That is exactly the unsafe fallback
   * R2 found: an id proves a process exists, not that it OWNS this file. The
   * chain must be complete (state + the child's own published file + authority
   * for the CURRENT incarnation) before anything is offered, and the entry is
   * keyed by the FILE the child named.
   */
  private trustedWriters(_daemonId: string): TrustedWriterPayload[] {
    // R1/R2: runtime identity and notice spans do not establish exclusive writer
    // custody. Keep production append attribution disabled pending that design.
    return [];
  }

  /**
   * The verified writer for [sessionId] (and [file] when the caller knows it).
   *
   * Returns null unless the supervisor's chain names this session AND, when a
   * file is supplied, exactly that file. The worker re-verifies the file it
   * actually holds the row for, so this can never widen to another transcript.
   */
  private trustedWriterFor(daemonId: string, sessionId: string, file: string | null = null): TrustedWriterPayload | null {
    for (const writer of this.trustedWriters(daemonId)) {
      if (writer.session_id !== sessionId) continue;
      if (file !== null && !samePath(writer.file, file)) continue;
      return writer;
    }
    return null;
  }

  /**
   * Session-scoped authority: the live child published THIS session id AND its
   * file, for the incarnation it is currently running.
   *
   * Used where the caller cannot name the file yet (a body request arrives with
   * a snapshot + body_ref, not a path). It is still strictly stronger than the
   * old "running && matching id" rule: without a published FILE there is no
   * authority at all, and the body path additionally verifies the digest and the
   * exact byte length of the ref.
   */
  private currentFor(daemonId: string): HistoryCurrentWire {
    const snapshot = this.runtime?.(daemonId) ?? null;
    if (snapshot === null) {
      return { session_id: null, ready: null, state: null, source: "unknown" };
    }
    return {
      session_id: snapshot.session_id,
      ready: snapshot.ready,
      state: snapshot.state,
      source: "runtime",
    };
  }

  private listReply(
    workspace: HistoryWorkspaceRef,
    inReplyTo: string,
    page: {
      revision: string | null;
      indexState: HistoryListOkWire["index_state"];
      sessions: HistoryListOkWire["sessions"];
      hasMore: boolean;
      retryAfter: number | null;
      rows?: Array<{ row: { mtime: number; session_id: string } }>;
    },
  ): HistoryListOkWire {
    const last = page.rows === undefined ? undefined : page.rows[page.rows.length - 1];
    const nextCursor =
      page.hasMore && last !== undefined
        ? encodeHistoryListCursor(workspace.daemon_id, { mtime: last.row.mtime, id: last.row.session_id })
        : null;
    return {
      type: "history_list_ok",
      in_reply_to: inReplyTo,
      daemon_id: workspace.daemon_id,
      revision: page.revision,
      index_state: page.indexState,
      current: this.currentFor(workspace.daemon_id),
      sessions: page.sessions,
      next_cursor: nextCursor,
      has_more: page.hasMore,
      retry_after_ms: page.retryAfter,
    };
  }

  private buildingReply(
    request: Extract<HistoryReplyRequest, { type: "history_read" }>,
    scope: { daemon_id: string; session_id: string },
  ): HistoryErrorWire {
    return historyErrorReply(request.id, "building", {
      ...scope,
      retry_after_ms: HISTORY_DEFAULT_RETRY_AFTER_MS,
    });
  }

  /**
   * Fit a read page into the 256 KiB encoded-frame ceiling WITHOUT losing data.
   *
   * R4 — the old implementation popped trailing items and advanced the cursor by
   * primary ENTRY, so a single entry with thousands of blocks silently lost
   * everything past the frame limit and then reported `has_older: false`. This
   * treats a page as a POSITION in a stable sequence and hands out a resume
   * cursor whenever that sequence is not exhausted. R3 rides the same mechanism:
   * an event with more omitted values than one wire item may carry is continued
   * ref-chunk by ref-chunk, under the SAME stable `event_id`.
   *
   * The algorithm is a PLAN, not a retry loop:
   *
   *   1. walk the item sequence from the resume position and cut it into
   *      delivery CHUNKS. A chunk is either one whole item, or the next
   *      `HISTORY_MAX_BODY_REFS_PER_ITEM` refs of an item that has more (that
   *      item then ends the chunk list, so nothing is skipped);
   *   2. take the longest chunk prefix that fits the encoded-frame budget;
   *   3. point the cursor at the exact position AFTER that prefix (or at the
   *      strictly-older entry boundary when the window is fully delivered).
   *
   * Because the cursor is a position, "one entry, thousands of blocks" simply
   * takes several pages. Nothing on this path erases data.
   */
  private buildReadPage(
    request: Extract<HistoryReplyRequest, { type: "history_read" }>,
    daemonId: string,
    value: Extract<HistoryReadResult, { status: "ready" }>,
    fixedHighWater: number,
    resume: { itemIndex: number; refsFrom: number },
  ): { reply: HistoryReadOkWire | null } {
    const items: HistoryItemWire[] = [];
    for (const item of value.items) {
      const wire = this.toWireItem(daemonId, request.session_id, value.session.generation, item);
      if (wire === null) continue;
      items.push(wire);
    }

    /*
     * R5 — the snapshot token is the FIXED page-sequence boundary, never the
     * current row high-water. Handing back the newest water would silently
     * re-base a sequence that started before an append, which is exactly what
     * this corrects.
     */
    const snapshotToken = encodeHistorySnapshot(
      daemonId,
      request.session_id,
      value.session.generation,
      fixedHighWater,
    );
    const revision = value.session.content_revision;
    const windowLimit = value.primary.length;
    const anchor = value.primary[value.primary.length - 1] ?? null;
    const oldest = value.primary[0] ?? null;

    /** An item carrying exactly the ref SUB-RANGE [from, from+count). */
    const withRefs = (item: HistoryItemWire, from: number, count: number): HistoryItemWire => {
      const refs = item.body_refs;
      if (refs === undefined) return item;
      const start = Math.min(from, refs.length);
      const end = Math.min(start + count, refs.length);
      const { body_refs: _drop, ...rest } = item;
      const kept = refs.slice(start, end);
      // `truncated` keeps meaning "part of this item is continued later".
      if (kept.length === 0) return rest;
      return end < refs.length ? { ...rest, body_refs: kept, truncated: true } : { ...rest, body_refs: kept };
    };

    /**
     * Item whose INLINE values were replaced by the handles the worker already
     * indexed — the frame-pressure escape hatch, and NOT a data-loss path.
     *
     * R3 (original acceptance: "shrink discarding inline"): when a single item
     * cannot fit even with an empty ref list, the values must not simply vanish.
     * Every field of every event is indexed with its own `(event, field)` handle
     * (`history_format.projectScannedEntry` publishes one for each image/text/args
     * /result value), so dropping the INLINE copy still leaves each value
     * reachable through `history_body` under the SAME `snapshot` — which is
     * exactly how a client that hits this path fetches it.
     *
     * The invariant this function must preserve:
     *
     *     every value is either inline on the wire, or has a body ref. NEVER
     *     neither, and never silently.
     */
    const evictInline = (item: HistoryItemWire): HistoryItemWire => {
      /*
       * Handles for the values being evicted. `body_refs` already carries one per
       * indexed field (the format layer publishes them for truncated AND inline
       * values alike), so nothing has to be invented here — we only have to KEEP
       * them instead of stripping them.
       */
      const refs = item.body_refs ?? [];
      const event = evictInlineEvent(item.event);
      /*
       * Keep EVERY handle this chunk already carries.
       *
       * The chunk was built by the planner and is therefore ALREADY limited to the
       * wire cap, so trimming it again here would silently drop handles: an
       * earlier version sliced to one ref per item, which discarded 15 of every
       * 16 evicted values. The eviction removes INLINE bytes only; the handles
       * are what make the values reachable.
       */
      const kept = refs;
      const { body_refs: _drop, ...rest } = item;
      return {
        ...rest,
        event,
        ...(kept.length > 0 ? { body_refs: kept } : {}),
        truncated: true,
      };
    };

    const skeleton = (
      pageItems: HistoryItemWire[],
      cursor: string | null,
      hasOlder: boolean,
    ): HistoryReadOkWire => ({
      type: "history_read_ok",
      in_reply_to: request.id,
      daemon_id: daemonId,
      session_id: request.session_id,
      snapshot: snapshotToken,
      revision,
      projection: HISTORY_PROJECTION_VERSION,
      session: {
        id: value.session.session_id,
        name: value.session.name === null ? null : utf8Preview(value.session.name, 200).text,
        mtime: value.session.mtime,
        preview: value.session.preview === null ? null : utf8Preview(value.session.preview, 200).text,
      },
      items: pageItems,
      older_cursor: cursor,
      has_older: hasOlder,
    });

    /** Resume INSIDE the pinned window at (item index, refs already shipped). */
    const resumeCursor = (itemIndex: number, refsFrom: number): string | null => {
      if (anchor === null) return null;
      return encodeHistoryReadCursor(daemonId, request.session_id, value.session.generation, {
        anchor: { timestamp: anchor.timestamp, id: anchor.entry_id },
        window_limit: windowLimit,
        delivered_items: itemIndex,
        delivered_refs: refsFrom,
        high_water: fixedHighWater,
      });
    };

    /** Cursor to STRICTLY older entries, for a fully delivered window. */
    const olderCursor = (): string | null => {
      if (!value.has_older || oldest === null) return null;
      return encodeHistoryReadCursor(daemonId, request.session_id, value.session.generation, {
        before: { timestamp: oldest.timestamp, id: oldest.entry_id },
        high_water: fixedHighWater,
      });
    };

    if (items.length === 0) {
      // An empty window is still progress: keep the entry cursor so older entries
      // stay reachable (an entry may legitimately project to zero wire items).
      const reply = skeleton([], olderCursor(), value.has_older);
      return { reply: fitsHistoryEncodedFrame(reply) ? reply : null };
    }

    const skip = Math.max(0, Math.min(Math.floor(resume.itemIndex), items.length));
    if (skip >= items.length) {
      // The cursor already consumed the window (projection shrink, or a stale
      // `delivered_refs`): continue with strictly older entries.
      const reply = skeleton([], olderCursor(), value.has_older);
      return { reply: fitsHistoryEncodedFrame(reply) ? reply : null };
    }

    interface Chunk {
      item: HistoryItemWire;
      /** Position the NEXT chunk starts at if this one is the last delivered. */
      next: { itemIndex: number; refsFrom: number };
      bytes: number;
    }

    const cap = HISTORY_MAX_BODY_REFS_PER_ITEM;
    const plan: Chunk[] = [];
    let index = skip;
    let from = Math.max(0, Math.floor(resume.refsFrom));
    while (index < items.length) {
      const source = items[index]!;
      const meta = value.items[index]!;
      const offset = meta.ref_offset ?? 0;
      const localTotal = source.body_refs?.length ?? 0;
      const total = offset + localTotal + (meta.refs_more ? 1 : 0);
      if (from > 0) {
        // Continuing an item: ship at most one page's worth of its refs.
        const take = Math.min(cap, Math.max(0, total - from));
        const chunkItem = withRefs(source, from - offset, Math.min(take, localTotal));
        const next = from + Math.min(take, localTotal);
        plan.push({
          item: chunkItem,
          next: next < total ? { itemIndex: index, refsFrom: next } : { itemIndex: index + 1, refsFrom: 0 },
          bytes: jsonBytes(chunkItem),
        });
        if (next < total) break; // the rest of THIS item continues next page
        index += 1;
        from = 0;
        continue;
      }
      if (total > cap) {
        // A single item may not carry more than the wire cap: deliver the first
        // page of refs and continue at the SAME item (R3).
        const chunkItem = withRefs(source, 0, cap);
        plan.push({ item: chunkItem, next: { itemIndex: index, refsFrom: cap }, bytes: jsonBytes(chunkItem) });
        break;
      }
      plan.push({
        item: source,
        next: { itemIndex: index + 1, refsFrom: 0 },
        bytes: jsonBytes(source),
      });
      index += 1;
    }

    /*
     * Frame arithmetic in BYTES: base64 length is monotone in the inner JSON
     * size, so measuring each chunk once is enough to pick the prefix that fits
     * without re-stringifying the page per candidate.
     */
    const baseBytes = frameBytes(skeleton([], null, false) as unknown);
    // Erring on the safe side: the widest cursor this page could emit.
    const cursorBytes = jsonBytes(resumeCursor(0, 0));
    const budget = HISTORY_MAX_ENCODED_FRAME_BYTES - baseBytes - cursorBytes - 2;

    let taken = 0;
    let used = 0;
    while (taken < plan.length) {
      const cost = plan[taken]!.bytes + (taken === 0 ? 0 : 1);
      if (used + cost > budget) break;
      used += cost;
      taken += 1;
    }

    if (taken === 0) {
      /*
       * One item still exceeds the frame with an empty ref list. Evict its INLINE
       * copies (keeping the indexed handles) and advance the cursor, so this is
       * never a dead end and never a silent omission.
       */
      const only = plan[0]!;
      const done = only.next.itemIndex >= items.length && only.next.refsFrom === 0;
      const cursor = done ? olderCursor() : resumeCursor(only.next.itemIndex, only.next.refsFrom);
      const reply = skeleton([evictInline(only.item)], cursor, cursor !== null);
      if (fitsHistoryEncodedFrame(reply)) return { reply };
      // Even the identity+one-ref form does not fit: that would mean the ITEM is
      // larger than the frame contract allows, which the projection prevents. Fail
      // the request rather than emit a page with unreachable values.
      return { reply: null };
    }

    const positionAt = (count: number): { itemIndex: number; refsFrom: number } => plan[count - 1]!.next;
    const replyFor = (count: number): HistoryReadOkWire => {
      const position = positionAt(count);
      const done = position.itemIndex >= items.length && position.refsFrom === 0;
      const cursor = done ? olderCursor() : resumeCursor(position.itemIndex, position.refsFrom);
      // `has_older` is honest: a cursor exists exactly when this page is NOT the
      // end of the sequence (more items, more refs of the same item, or older
      // entries). There is no separate "entry complete" flag to get wrong.
      return skeleton(plan.slice(0, count).map((chunk) => chunk.item), cursor, cursor !== null);
    };

    let reply = replyFor(taken);
    if (fitsHistoryEncodedFrame(reply)) return { reply };
    // Defensive: the byte model and the real encoder disagreed (they should not).
    // Drop trailing chunks rather than emit an oversized frame.
    for (let take = taken - 1; take >= 1; take -= 1) {
      reply = replyFor(take);
      if (fitsHistoryEncodedFrame(reply)) return { reply };
    }
    const only = plan[0]!;
    const cursor = resumeCursor(only.next.itemIndex, only.next.refsFrom);
    const single = skeleton([evictInline(only.item)], cursor, cursor !== null);
    return { reply: fitsHistoryEncodedFrame(single) ? single : null };
  }

  private toWireItem(
    daemonId: string,
    sessionId: string,
    generation: string,
    item: HistoryWorkerItem,
  ): HistoryItemWire | null {
    const parsed = parseSessionHistoryEvent(item.event);
    if (!parsed.ok) return null;
    const event: SessionHistoryEvent = parsed.value;
    const refs: HistoryBodyRefWire[] = item.refs.map((ref) => ({
      ref: encodeHistoryBodyRef(daemonId, sessionId, {
        generation,
        entry_id: item.entry_id,
        event_id: item.event_id,
        field: ref.field,
        representation: ref.representation,
        mime: ref.mime,
        total_bytes: ref.total_bytes,
        digest: ref.digest,
      }),
      field: ref.field,
      representation: ref.representation,
      mime: ref.mime,
      total_bytes: ref.total_bytes,
      preview: ref.preview,
      preview_truncated: ref.preview_truncated,
    }));
    return {
      event_id: item.event_id,
      entry_id: item.entry_id,
      event,
      ...(refs.length > 0 ? { body_refs: refs } : {}),
      ...(item.parent ? { parent: true as const } : {}),
      ...(item.truncated ? { truncated: true } : {}),
    };
  }

  private async callWriter<T>(payload: HistoryWorkerPayload): Promise<WorkerCall<T>> {
    return this.call<T>(this.writer, payload);
  }

  private async callReader<T>(payload: HistoryWorkerPayload): Promise<WorkerCall<T>> {
    return this.call<T>(this.reader, payload);
  }

  private async call<T>(client: HistoryWorkerClient, payload: HistoryWorkerPayload): Promise<WorkerCall<T>> {
    try {
      const result = await client.request(payload);
      const error = workerErrorCode(result.value);
      if (error !== null) return { ok: false, code: error, queue_ms: result.queue_ms };
      return { ok: true, value: result.value as T, queue_ms: result.queue_ms };
    } catch (error) {
      if (error instanceof HistoryWorkerFailure) {
        this.logWorkerFailure(error.code);
        if (error.code === "worker_busy") return { ok: false, code: "busy", queue_ms: null };
        return { ok: false, code: "transport", queue_ms: null };
      }
      return { ok: false, code: "transport", queue_ms: null };
    }
  }

  private logWorkerFailure(code: HistoryWorkerFailureCode): void {
    process.stderr.write(`[remote-pi-history] worker ${code}\n`);
  }

  private startMaterialization(key: string, message: HistoryWorkerPayload): void {
    const job = this.reader
      .request<HistoryBodyResult>(message)
      .then((result) => {
        const error = workerErrorCode(result.value);
        if (error !== null) {
          process.stderr.write(`[remote-pi-history] materialization ${error}\n`);
          this.rememberMaterializationFailure(key, error);
          return;
        }
        this.materialized.add(key);
        this.materializationFailures.delete(key);
        while (this.materialized.size > 512) {
          const oldest = this.materialized.values().next();
          if (oldest.done) break;
          this.materialized.delete(oldest.value);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof HistoryWorkerFailure) {
          this.logWorkerFailure(error.code);
          this.rememberMaterializationFailure(key, "transport");
        }
      })
      .finally(() => {
        this.materializing.delete(key);
      });
    this.materializing.set(key, job);
  }

  private rememberMaterializationFailure(key: string, code: string): void {
    this.materializationFailures.set(key, code);
    while (this.materializationFailures.size > 512) {
      const oldest = this.materializationFailures.keys().next();
      if (oldest.done) break;
      this.materializationFailures.delete(oldest.value);
    }
  }

  private addBuildMetrics(metrics: MetricsAccumulator | null, build: { read_bytes: number; parsed_entries: number; parsed_bytes: number; files: number; build_ms: number; prefix_check_bytes: number }): void {
    if (metrics === null) return;
    metrics.read_bytes = (metrics.read_bytes ?? 0) + build.read_bytes + build.prefix_check_bytes;
    metrics.parsed_entries = (metrics.parsed_entries ?? 0) + build.parsed_entries;
    metrics.cold_build_ms = (metrics.cold_build_ms ?? 0) + build.build_ms;
    metrics.cold_build_bytes = (metrics.cold_build_bytes ?? 0) + build.parsed_bytes;
    metrics.cold_build_entries = (metrics.cold_build_entries ?? 0) + build.parsed_entries;
    if (build.files > 0) {
      metrics.cache_hit = build.parsed_bytes === 0 ? true : false;
    }
  }

  private addBodyMetrics(metrics: MetricsAccumulator, body: HistoryBodyResult): void {
    metrics.read_bytes = (metrics.read_bytes ?? 0) + body.source_bytes_read + body.sidecar_bytes_read;
    metrics.body_decode_ms = (metrics.body_decode_ms ?? 0) + body.decode_ms;
    metrics.body_source_bytes = (metrics.body_source_bytes ?? 0) + body.source_bytes_read;
    metrics.body_sidecar_bytes = (metrics.body_sidecar_bytes ?? 0) + body.sidecar_bytes_read;
    metrics.stat_count = (metrics.stat_count ?? 0) + body.stat_count;
    metrics.cache_hit = body.cache_hit;
  }

  private outcome<T extends HistoryReply>(
    reply: T,
    started: number,
    metrics: MetricsAccumulator,
  ): HistoryOutcome<T> {
    return { reply, metrics: this.outcomeMetrics(started, metrics) };
  }

  private outcomeMetrics(started: number, metrics: MetricsAccumulator): HistoryQueryMetrics {
    return {
      queue_ms: metrics.queue.length === 0 || metrics.queue.some((value) => value === null)
        ? null
        : metrics.queue.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      query_ms: Math.max(0, this.now() - started),
      read_bytes: metrics.read_bytes,
      parsed_entries: metrics.parsed_entries,
      cache_hit: metrics.cache_hit,
      worker_mode: this.workerMode(),
      cold_build_ms: metrics.cold_build_ms,
      cold_build_bytes: metrics.cold_build_bytes,
      cold_build_entries: metrics.cold_build_entries,
      body_decode_ms: metrics.body_decode_ms,
      body_source_bytes: metrics.body_source_bytes,
      body_sidecar_bytes: metrics.body_sidecar_bytes,
      stat_count: metrics.stat_count,
    };
  }
}

// ── Worker call plumbing ─────────────────────────────────────────────────────

type WorkerCall<T> =
  | { ok: true; value: T; queue_ms: number | null }
  | { ok: false; code: string; queue_ms: number | null };

function mapWorkerError(code: string): Parameters<typeof historyErrorReply>[1] {
  switch (code) {
    case "not_found":
    case "stale":
    case "unsupported":
    case "body_too_large":
      return code;
    default:
      return "internal";
  }
}

function mapWorkerErrorName(code: string): Parameters<typeof historyErrorReply>[1] {
  return mapWorkerError(code);
}

/**
 * Exact bytes ONE object occupies inside the inner JSON that the host wrapper
 * base64-encodes, measured without allocating the whole page again.
 *
 * `JSON.stringify` of a single item IS the item's own contribution (separators
 * are accounted for by the caller), and base64 length is monotone in it — which
 * is all the frame fitter needs to pick a prefix.
 */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * Encoded host-frame bytes a page WOULD occupy, given the inner JSON text.
 *
 * Measured on the real object so the fitter and `fitsHistoryEncodedFrame`
 * cannot disagree: the skeleton's own fields (snapshot, revision, session,
 * older_cursor) dominate the fixed cost and are included.
 */
function frameBytes(inner: unknown): number {
  return encodedHostFrameBytes(JSON.stringify(inner));
}

/**
 * Same event TYPE and identity, with its INLINE values removed.
 *
 * Used only by {@link buildReadPage}'s frame-pressure path, where the values are
 * still reachable through the item's `body_refs`. It keeps `type`, `ts`, the
 * ids (including `in_reply_to`) and every non-value field so a client can still
 * identify the event and know exactly which values to fetch.
 */
function evictInlineEvent(event: SessionHistoryEvent): SessionHistoryEvent {
  switch (event.type) {
    case "user_input":
      // The images stay as entries (mime preserved) with empty data: their bytes
      // are the handles, and the count/mime are identity, not payload.
      return { ...event, text: "", ...(event.images === undefined ? {} : { images: event.images.map((image) => ({ data: "", mime: image.mime })) }) };
    case "agent_message":
      return { ...event, text: "" };
    case "tool_request":
      return { ...event, args: {} };
    case "tool_result":
      return event.error !== undefined ? { ...event, error: "" } : { ...event, result: "" };
    case "compaction":
      return { ...event, summary: "" };
    default:
      return event;
  }
}

