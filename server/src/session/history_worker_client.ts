/**
 * Plan 86 P1 — the request/lifecycle client for the history worker.
 *
 * One client owns ONE worker for its role (lazy: created on the first request,
 * torn down on supervisor shutdown). Requests are serialized, the queue is bounded,
 * and every failure mode is typed so the host can answer `history_error`
 * instead of hanging:
 *
 *   - worker error/exit        → dispatched request rejected, worker retired;
 *                                unsent reader work can use its replacement.
 *                                Writer failure still rejects the whole queue.
 *   - per-request timeout      → same recovery for a stalled worker. A reader
 *                                deadline includes queueing and retirement.
 *   - queue overflow           → the new request is refused immediately.
 *   - dispose                  → everything rejected with `worker_disposed`.
 *
 * TRANSPORT
 *
 * Production (`dist/`) resolves `history_worker_main.js` next to this module and
 * spawns a real `worker_threads` Worker. Source mode (`tsx`/vitest) has no
 * compiled entry, so it uses an INLINE port that runs the exact same handler on
 * the calling thread — bounded by the same one-at-a-time queue, but not off the
 * main thread. The service reports which mode it is in; tests for the threaded
 * path compile the entry to a scratch directory and pass `workerScript`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { handleHistoryWorkerRequest, type HistoryWorkerPayload, type HistoryWorkerRole } from "./history_worker.js";

export type { HistoryWorkerRole } from "./history_worker.js";

export type HistoryWorkerMode = "threads" | "inline";

/** Minimal message-port surface shared by `worker_threads` and the inline shim. */
export interface HistoryWorkerPort {
  readonly mode: HistoryWorkerMode;
  on(event: "message", handler: (value: unknown) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  on(event: "exit", handler: (code: number) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number> | number | void;
}

/** Factories receive the role so production spawns the right connection. */
export type HistoryWorkerPortFactory = (role: HistoryWorkerRole) => HistoryWorkerPort;

// ── Inline shim (source mode / tests) ────────────────────────────────────────

/**
 * Runs the worker handler on the calling thread, one request at a time.
 *
 * This exists ONLY because a Node Worker cannot load TypeScript source: in
 * `dist/` the real thread is always used. It is still serialized and still
 * bounded, so its semantics match; only the thread boundary is absent.
 */
export function createInlineHistoryPort(): HistoryWorkerPort {
  const messageHandlers = new Set<(value: unknown) => void>();
  const errorHandlers = new Set<(error: Error) => void>();
  const exitHandlers = new Set<(code: number) => void>();
  let chain: Promise<void> = Promise.resolve();
  let termination: Promise<number> | null = null;

  return {
    mode: "inline",
    on(event: "message" | "error" | "exit", handler: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): unknown {
      if (event === "message") messageHandlers.add(handler as (value: unknown) => void);
      else if (event === "error") errorHandlers.add(handler as (error: Error) => void);
      else exitHandlers.add(handler as (code: number) => void);
      return undefined;
    },
    postMessage(message: unknown): void {
      if (termination !== null) return;
      chain = chain.then(async () => {
        if (termination !== null) return;
        try {
          // Tests only: both roles share this thread. The handler still routes
          // by message kind; production threads enforce the role strictly.
          const reply = await handleHistoryWorkerRequest(message);
          if (termination !== null || reply === null) return;
          for (const handler of messageHandlers) handler(reply);
        } catch (error) {
          for (const handler of errorHandlers) handler(error instanceof Error ? error : new Error(String(error)));
        }
      });
      chain = chain.catch(() => undefined);
    },
    terminate(): Promise<number> {
      // Closing the shim suppresses callbacks, but cannot interrupt an async
      // file operation already executing on the host thread.
      return termination ??= chain.then(() => {
        for (const handler of exitHandlers) handler(0);
        messageHandlers.clear();
        errorHandlers.clear();
        exitHandlers.clear();
        return 0;
      });
    },
  };
}

// ── worker_threads transport ─────────────────────────────────────────────────

export function createThreadsHistoryPort(scriptPath: string, role: HistoryWorkerRole = "reader"): HistoryWorkerPort {
  const worker = new Worker(scriptPath, { name: `remote-pi-history-${role}`, workerData: { role } });
  // A worker that crashes must not take the host down as an unhandled 'error'.
  worker.on("error", () => {
    /* forwarded to listeners below */
  });
  return {
    mode: "threads",
    on(event: "message" | "error" | "exit", handler: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): unknown {
      if (event === "message") return worker.on("message", handler as (value: unknown) => void);
      if (event === "error") return worker.on("error", handler as (error: Error) => void);
      return worker.on("exit", handler as (code: number) => void);
    },
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    terminate(): Promise<number> {
      return worker.terminate();
    },
  };
}

/** Compiled worker entry next to this module, when running from `dist/`. */
export function defaultHistoryWorkerScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "history_worker_main.js");
}

/** True when the default transport is the real worker thread. */
export function hasCompiledHistoryWorker(): boolean {
  return existsSync(defaultHistoryWorkerScript());
}

/** Default port factory: real threads in `dist/`, inline shim in source mode. */
export function defaultHistoryWorkerPortFactory(): HistoryWorkerPortFactory {
  const script = defaultHistoryWorkerScript();
  if (existsSync(script)) return (role) => createThreadsHistoryPort(script, role);
  return () => createInlineHistoryPort();
}

// ── Failures ─────────────────────────────────────────────────────────────────

export type HistoryWorkerFailureCode =
  | "worker_failed"
  | "worker_timeout"
  | "worker_disposed"
  | "worker_busy";

/** Typed worker failure. The message is developer-only and never goes on the
 *  wire (the host maps it to a `history_error` code). */
export class HistoryWorkerFailure extends Error {
  constructor(readonly code: HistoryWorkerFailureCode) {
    super(code);
    this.name = "HistoryWorkerFailure";
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

interface PendingRequest {
  id: number;
  message: HistoryWorkerPayload;
  resolve: (value: { value: unknown; queue_ms: number | null }) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  queueMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HistoryWorkerClientOptions {
  portFactory?: HistoryWorkerPortFactory;
  /** Role this client drives; production spawns a dedicated thread per role. */
  role?: HistoryWorkerRole;
  /** Reader deadline from enqueue; writer timeout from dispatch. A dispatched
   * timeout retires the current worker (it may be wedged). */
  timeoutMs?: number;
  /** Bounded queue: the host answers `internal` instead of growing forever. */
  maxQueue?: number;
  now?: () => number;
}

export interface HistoryWorkerResult<T> {
  value: T;
  /** Milliseconds spent waiting in this client's queue; null when the request
   *  started immediately (not enough evidence to call it zero). */
  queue_ms: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HistoryWorkerClient {
  private port: HistoryWorkerPort | null = null;
  private nextId = 1;
  private inFlight: PendingRequest | null = null;
  private readonly queue: PendingRequest[] = [];
  private retirement: Promise<void> | null = null;
  private retirementFailed = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private readonly opts: Required<Pick<HistoryWorkerClientOptions, "timeoutMs" | "maxQueue" | "now" | "role">> &
    Pick<HistoryWorkerClientOptions, "portFactory">;

  constructor(options: HistoryWorkerClientOptions = {}) {
    this.opts = {
      portFactory: options.portFactory ?? defaultHistoryWorkerPortFactory(),
      role: options.role ?? "reader",
      timeoutMs: options.timeoutMs ?? 30_000,
      maxQueue: options.maxQueue ?? 32,
      now: options.now ?? (() => performance.now()),
    };
  }

  /** Transport of the CURRENT worker, or null before one is created. */
  currentMode(): HistoryWorkerMode | null {
    return this.port === null ? null : this.port.mode;
  }

  /** Transport the default factory would use (source-mode heuristic). */
  mode(): HistoryWorkerMode {
    return this.currentMode() ?? (existsSync(defaultHistoryWorkerScript()) ? "threads" : "inline");
  }

  queueLength(): number {
    return this.queue.length + (this.inFlight === null ? 0 : 1);
  }

  request<T>(message: HistoryWorkerPayload): Promise<HistoryWorkerResult<T>> {
    if (this.disposed) return Promise.reject(new HistoryWorkerFailure("worker_disposed"));
    if (this.retirementFailed || (this.opts.role === "writer" && this.retirement !== null)) {
      return Promise.reject(new HistoryWorkerFailure("worker_failed"));
    }
    if (this.queue.length + (this.inFlight === null ? 0 : 1) >= this.opts.maxQueue) {
      return Promise.reject(new HistoryWorkerFailure("worker_busy"));
    }
    return new Promise<HistoryWorkerResult<T>>((resolve, reject) => {
      const pending: PendingRequest = {
        id: this.nextId++,
        message,
        resolve: resolve as (value: { value: unknown; queue_ms: number | null }) => void,
        reject,
        enqueuedAt: this.opts.now(),
        queueMs: null,
        timer: null,
      };
      this.queue.push(pending);
      if (this.opts.role === "reader") {
        pending.timer = setTimeout(() => this.expireReaderRequest(pending), this.opts.timeoutMs);
      }
      this.pump();
    });
  }

  private expireReaderRequest(pending: PendingRequest): void {
    const failure = new HistoryWorkerFailure("worker_timeout");
    if (this.inFlight === pending) {
      this.onFailure(failure);
      return;
    }
    const index = this.queue.indexOf(pending);
    if (index === -1) return;
    this.queue.splice(index, 1);
    pending.reject(failure);
  }

  private ensurePort(): HistoryWorkerPort {
    if (this.port !== null) return this.port;
    const port = (this.opts.portFactory ?? defaultHistoryWorkerPortFactory())(this.opts.role);
    // terminate() is asynchronous; late events from a discarded worker must
    // not complete requests or tear down its replacement.
    port.on("message", (value) => {
      if (this.port === port) this.onMessage(value);
    });
    port.on("error", (error) => {
      if (this.port === port) this.onFailure(new HistoryWorkerFailure(error instanceof HistoryWorkerFailure ? error.code : "worker_failed"));
    });
    port.on("exit", () => {
      if (this.port === port) this.onFailure(new HistoryWorkerFailure("worker_failed"));
    });
    this.port = port;
    return port;
  }

  private readerDeadlineReached(pending: PendingRequest): boolean {
    return this.opts.role === "reader" && this.opts.now() - pending.enqueuedAt >= this.opts.timeoutMs;
  }

  private pump(): void {
    if (this.disposed || this.inFlight !== null || this.retirement !== null || this.retirementFailed) return;
    let pending = this.queue.shift();
    // An exit/message callback can run before due deadline callbacks. Never
    // send already-expired reader work to a healthy replacement.
    while (pending !== undefined && this.readerDeadlineReached(pending)) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(new HistoryWorkerFailure("worker_timeout"));
      pending = this.queue.shift();
    }
    if (pending === undefined) return;

    let port: HistoryWorkerPort;
    try {
      port = this.ensurePort();
    } catch {
      if (pending.timer !== null) clearTimeout(pending.timer);
      const failure = new HistoryWorkerFailure("worker_failed");
      this.failQueued(failure);
      pending.reject(failure);
      return;
    }

    this.inFlight = pending;
    pending.queueMs = Math.max(0, this.opts.now() - pending.enqueuedAt);
    if (this.opts.role === "writer") {
      pending.timer = setTimeout(() => {
        this.onFailure(new HistoryWorkerFailure("worker_timeout"));
      }, this.opts.timeoutMs);
    }
    try {
      port.postMessage({ ...pending.message, id: pending.id });
    } catch {
      this.onFailure(new HistoryWorkerFailure("worker_failed"));
    }
  }

  private onMessage(value: unknown): void {
    if (!isRecord(value)) return;
    const id = value["id"];
    const ok = value["ok"];
    if (typeof id !== "number" || typeof ok !== "boolean") return;
    const pending = this.inFlight;
    if (pending === null || pending.id !== id) return;

    if (pending.timer !== null) clearTimeout(pending.timer);
    this.inFlight = null;

    if (this.readerDeadlineReached(pending)) {
      // I/O can be delivered ahead of an overdue timer callback. The call has
      // ended, so reject it without retiring a responsive reader or harming B.
      pending.reject(new HistoryWorkerFailure("worker_timeout"));
    } else if (ok) {
      pending.resolve({ value: value["value"], queue_ms: pending.queueMs });
    } else {
      const error = value["error"];
      const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : null;
      // Worker-level refusals are NOT transport failures: the worker is healthy
      // and the service maps them to typed wire errors.
      pending.resolve({
        value: { __historyWorkerError: code ?? "internal" },
        queue_ms: pending.queueMs,
      });
    }
    this.pump();
  }

  private onFailure(failure: HistoryWorkerFailure): void {
    const pending = this.inFlight;
    this.inFlight = null;
    if (pending !== null && pending.timer !== null) clearTimeout(pending.timer);
    pending?.reject(failure);
    if (this.opts.role === "writer") this.failQueued(failure);
    this.retirePort();
  }

  private retirePort(): void {
    const port = this.port;
    // Ignore late events immediately but wait for termination before replacing
    // either role. In particular a writer failure cannot overlap two writers.
    this.port = null;
    const failed = () => {
      this.retirementFailed = true;
      this.failQueued(new HistoryWorkerFailure("worker_failed"));
    };
    try {
      const exit = port?.terminate();
      if (exit === undefined || typeof exit === "number") {
        this.pump();
        return;
      }
      this.retirement = exit.then(() => {
        this.retirement = null;
        this.pump();
      }, () => {
        this.retirement = null;
        failed();
      });
    } catch {
      failed();
    }
  }

  private failQueued(failure: HistoryWorkerFailure): void {
    const queued = this.queue.splice(0);
    for (const pending of queued) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(failure);
    }
  }

  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOnce();
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    const pending = this.inFlight;
    this.inFlight = null;
    if (pending !== null && pending.timer !== null) clearTimeout(pending.timer);
    pending?.reject(new HistoryWorkerFailure("worker_disposed"));
    this.failQueued(new HistoryWorkerFailure("worker_disposed"));
    const port = this.port;
    this.port = null;
    if (port !== null) {
      try {
        await port.terminate();
      } catch {
        /* already gone */
      }
    }
    if (this.retirement !== null) await this.retirement;
  }
}

