/**
 * Plan 86 P2 correction (R1/R2) — the CHILD side of the writer notice.
 *
 * Emits `[remote-pi-history-notice] {...}` lines on STDERR (see
 * `history_notice.ts` for why stderr, not stdout) so the supervisor can attribute
 * a session/file to this process and see what it believes it persisted.
 *
 * ── WHAT IT CANNOT DO (86-P2-R1/R2 BLOCKED) ──────────────────────────────
 *
 *   agent-session.js:272  await this._emitExtensionEvent(message_end)  <- we run
 *   agent-session.js:275  this._emit(event)                          <- listeners
 *   agent-session.js:287  this.sessionManager.appendMessage(...)      <- bytes land
 *
 * The hook runs BEFORE the SDK persists, so this module can only take file
 * observations AROUND a write; it cannot intercept or own one. Two consecutive
 * observations are NOT proof that only this process wrote between them: an
 * ordinary unmanaged process can rewrite an early field in place (same length,
 * same final 4 KiB) at any moment, including between the SDK append and the next
 * observation. The resulting pair of stamps then matches at both endpoints and
 * still brackets someone else's write.
 *
 * Publishing the observations is still worthwhile (identity, diagnostics, and the
 * exact shape a future supported ownership boundary would need), but NO consumer
 * may conclude "these bytes are mine" from them. The supervisor therefore keeps
 * `append_authority` false and every change takes the conservative rebuild. See
 * `history_notice.ts` and `daemon/history_writer_authority.ts`.
 *
 * CONTIGUITY. Even as pure observation, the sequence has one real requirement: the
 * END of one published range must be the START of the next, or the persisted
 * entries in between fall outside every reported range. An earlier version dropped
 * the chain on each publish and therefore described only every other entry; the
 * reseed in `publishPending` is that fix.
 * It never reads the transcript, never opens the file for writing, and never
 * persists anything. SDK-free on purpose (the ctx is narrowed to two methods) so
 * this file is unit-testable without a Pi.
 */

import {
  formatHistoryNotice,
  HISTORY_NOTICE_VERSION,
  type HistoryNotice,
  type HistoryNoticeKind,
  type HistoryNoticeSpan,
  type HistoryNoticeStamp,
} from "./history_notice.js";
import fs from "node:fs";

/** The narrow slice of `ExtensionContext.sessionManager` this module needs. */
export interface HistoryNoticeContext {
  sessionManager: {
    /** `string | undefined`: an in-memory session has no path. */
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
}

export interface HistoryNoticeEmitterOptions {
  /** Sink for the formatted line. Defaults to `process.stderr.write`. */
  write?(line: string): void;
  now?(): number;
  pid?(): number;
  /** Incremented per emitter instance (tests assert the sequence). */
  incarnation?(): number;
  /** Stamp override (tests): the same shape `stat` would report. */
  stampOf?(file: string): HistoryNoticeStamp | null;
}

export interface HistoryNoticeEmitter {
  /** A session is live: publish (session_id, file) for this incarnation. */
  session(ctx: HistoryNoticeContext): void;
  /**
   * The SDK is about to persist an entry (the `message_end` hook).
   *
   * Records the boundary. Does NOT publish: the end of the span is only known at
   * the NEXT boundary (or at {@link flush}).
   */
  boundary(ctx: HistoryNoticeContext): void;
  /** Publish the accumulated span now (turn end, session end). */
  flush(ctx?: HistoryNoticeContext): void;
  /** The session is going away; `sessionId` is the one being revoked. */
  revoke(sessionId: string | null): void;
  /** Have we published a `session` notice for this incarnation? */
  published(): boolean;
  incarnation(): number;
}

/**
 * Create one emitter per process (module-level singleton in `index.ts`).
 *
 * Failures are swallowed ON PURPOSE: a notice is observability, and a broken
 * stderr must never turn a working agent into a failing one. The consequence is
 * only that the host keeps treating this process conservatively (rebuild).
 */
export function createHistoryNoticeEmitter(
  options: HistoryNoticeEmitterOptions = {},
): HistoryNoticeEmitter {
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const now = options.now ?? (() => Date.now());
  const pid = options.pid ?? (() => process.pid);
  const incarnationOf = options.incarnation ?? (() => 1);
  let seq = 0;
  let incarnation = Math.max(1, Math.floor(incarnationOf()));
  let currentSession: string | null = null;
  let currentFile: string | null = null;
  /** The stamp observed at the last NOT-yet-published boundary. */
  let pendingStart: HistoryNoticeStamp | null = null;
  /** The latest boundary observed for the pending span. */
  let pendingEnd: HistoryNoticeStamp | null = null;

  /** The file's identity right now, or null when it cannot be read. */
  const stampOf = (file: string | null): HistoryNoticeStamp | null => {
    if (file === null) return null;
    if (options.stampOf !== undefined) return options.stampOf(file);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      return {
        ino: Number(stat.ino) || 0,
        birthtime_ms: Number(stat.birthtimeMs) || 0,
        size: stat.size,
        mtime_ms: Number(stat.mtimeMs) || 0,
        ctime_ms: Number(stat.ctimeMs) || 0,
      };
    } catch {
      return null;
    }
  };

  const emit = (kind: HistoryNoticeKind, sessionId: string, file: string | null, span: HistoryNoticeSpan | null): void => {
    seq += 1;
    const notice: HistoryNotice = {
      v: HISTORY_NOTICE_VERSION,
      kind,
      incarnation,
      seq,
      session_id: sessionId,
      file,
      span,
      pid: Math.floor(pid()),
      at: now(),
    };
    try {
      write(formatHistoryNotice(notice));
    } catch {
      /* observability only: never fail a session on a write error */
    }
  };

  const resolve = (ctx: HistoryNoticeContext): { sessionId: string; file: string | null } | null => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (typeof sessionId !== "string" || sessionId === "") return null;
      const file = ctx.sessionManager.getSessionFile();
      return { sessionId, file: typeof file === "string" && file !== "" ? file : null };
    } catch {
      return null;
    }
  };

  /** Forget the pending range (a session boundary, a revoke, a moved file). */
  const dropPending = (): void => {
    pendingStart = null;
    pendingEnd = null;
  };

  /**
   * Publish the pending span, if it proves a write, WITHOUT breaking the chain.
   *
   * The range end becomes the next range's start. Dropping it (as an earlier
   * version did) made consecutive hooks cover only every OTHER persisted entry,
   * which pushed the uncovered half onto the host's expensive rebuild path.
   *
   * A span with `before.size === after.size` is not published: nothing was
   * added, so there is no custody to claim — but the boundary is still kept.
   */
  const publishPending = (sessionId: string, file: string | null): void => {
    const start = pendingStart;
    const end = pendingEnd;
    if (start === null || end === null || file === null) {
      dropPending();
      return;
    }
    // RESEED: the end of this range is the start of the next one.
    pendingStart = end;
    pendingEnd = end;
    if (end.size <= start.size) return;
    emit("append", sessionId, file, { before: start, after: end });
  };

  const publishSession = (ctx: HistoryNoticeContext): { sessionId: string; file: string | null } | null => {
    const resolved = resolve(ctx);
    if (resolved === null) return null;
    // A DIFFERENT session on the same incarnation means the previous one is
    // gone: revoke first so the host never keeps two live writers.
    if (currentSession !== null && currentSession !== resolved.sessionId) {
      dropPending();
      emit("revoke", currentSession, currentFile, null);
    }
    currentSession = resolved.sessionId;
    currentFile = resolved.file;
    dropPending();
    // The file may not exist yet (the SDK creates it on the first persisted
    // message), so a session notice publishes identity only.
    emit("session", resolved.sessionId, resolved.file, null);
    return resolved;
  };

  return {
    session(ctx) {
      publishSession(ctx);
    },

    boundary(ctx) {
      const resolved = resolve(ctx);
      if (resolved === null) return;
      if (resolved.sessionId !== currentSession) {
        // A new session mid-flight: publish the new identity, then start over.
        publishSession(ctx);
        pendingStart = stampOf(resolved.file);
        pendingEnd = pendingStart;
        return;
      }
      if (resolved.file !== currentFile) {
        // The file moved (fork writes a new one): the old range is void.
        dropPending();
        currentFile = resolved.file;
        emit("session", resolved.sessionId, resolved.file, null);
        pendingStart = stampOf(resolved.file);
        pendingEnd = pendingStart;
        return;
      }
      const stamp = stampOf(resolved.file);
      if (stamp === null) {
        // The file vanished or is unreadable: the chain is broken, and the host
        // must not extend trust across a gap.
        dropPending();
        return;
      }
      if (pendingStart === null) {
        pendingStart = stamp;
        pendingEnd = stamp;
        return;
      }
      /*
       * This hook ENDS the range the previous hook started. The bytes in between
       * are the entry the SDK persisted after the PREVIOUS hook, which is why
       * publishing one boundary late is correct.
       */
      pendingEnd = stamp;
      publishPending(resolved.sessionId, resolved.file);
    },

    flush(ctx) {
      const resolved = ctx === undefined ? null : resolve(ctx);
      const sessionId = resolved?.sessionId ?? currentSession;
      const file = resolved?.file ?? currentFile;
      if (sessionId === null) return;
      // Take a fresh end boundary: at a turn/session end the persisted bytes are
      // already on disk, so this closes the range for the last message.
      if (file !== null) {
        const stamp = stampOf(file);
        if (stamp !== null && pendingStart !== null) pendingEnd = stamp;
      }
      publishPending(sessionId, file);
    },

    revoke(sessionId) {
      const target = sessionId ?? currentSession;
      if (target === null) return;
      dropPending();
      emit("revoke", target, currentFile, null);
      if (currentSession === target) {
        currentSession = null;
        currentFile = null;
      }
    },

    published() {
      return currentSession !== null;
    },

    incarnation() {
      incarnation = Math.max(incarnation, Math.floor(incarnationOf()));
      return incarnation;
    },
  };
}
