/**
 * Plan 86 P2 correction (R1/R2) — the supervisor-side WRITER AUTHORITY registry.
 *
 * ── STATUS: FAIL CLOSED (86-P2-R1/R2 blocked) ──────────────────────────────
 *
 * The independent bounded analysis (agent://b1a9c346-ef53-4068-b7e0-dc121c82127c)
 * confirmed that Pi SDK 0.79.10 provides NO supported general persistence
 * observer and NO exclusive-writer guarantee:
 *
 *   - `message_end` runs BEFORE the SDK persists (agent-session.js:272 vs :287),
 *     so an extension can only OBSERVE, never intercept, a write;
 *   - `ctx.sessionManager` is the real mutable object at runtime, but
 *     `ReadonlySessionManager` (session-manager.d.ts:136) and extensions.md:926
 *     document it as READ-ONLY. Replacing its methods is mechanical reachability,
 *     not a supported contract, and it still would not exclude an ordinary
 *     unmanaged writer rewriting the prefix between the append and our after-stat;
 *   - the persist path is not 1 method call = 1 record (_persist can defer, append
 *     one, or write all buffered entries), so no wrapper covers every write.
 *
 * Therefore NO observation-based receipt can prove that only this child wrote a
 * byte range. Root supervision: stop the observation-wrapper redesign and fail
 * closed.
 *
 * WHAT THIS REGISTRY THEREFORE DOES
 *
 *   - Authenticates ATTRIBUTION: which session/file the CURRENT child of a
 *     workspace is working on, per (pid, incarnation, seq). That is honest,
 *     useful metadata and it feeds `current.session_id`.
 *   - Publishes `append_trusted: false` ALWAYS. There is no code path that sets
 *     it true, in production or in tests. `FleetRuntimeSnapshot.append_authority`
 *     is consequently false, so `HistoryService.trustedWriters()` returns an
 *     empty list and `history_build.refreshSessionFile` takes the conservative
 *     rebuild path — a NEW generation — for every change. That is O(file), and it
 *     is reported as O(file); it is not claimed to be O(delta).
 *   - Keeps the `span` the child publishes, for diagnostics only. It is NEVER
 *     consulted to authorize anything (see {@link claimedSpan}).
 *
 * WHAT WOULD UNBLOCK R1/R2
 *
 *   A SUPPORTED exclusive-ownership boundary, e.g. an SDK builder seam that hands
 *   the host the persistence writer itself (so appends can be intercepted before
 *   and after inside one owned call), or a cooperative lock the SDK honours. Both
 *   are an architectural decision for the user, not something this task can
 *   invent.
 */

import type { HistoryNotice, HistoryNoticeSpan } from "../session/history_notice.js";
import { samePath } from "../session/session_paths.js";

/** What the host can honestly say about a workspace's live writer. */
export interface WriterAuthoritySnapshot {
  /** Workspace lifecycle state, mirrored from the child slot. */
  state: "running" | "starting" | "crashed" | "stopped";
  /** Pi session id the CHILD itself published, or null when unknown. */
  session_id: string | null;
  /** Absolute session file the child published, or null when unknown. */
  file: string | null;
  /**
   * The last range the child CLAIMED, for diagnostics only.
   *
   * It is never evidence: see the module header. Kept so an operator can see what
   * a child believed, and because removing the field would churn the wire types
   * for no benefit.
   */
  span: HistoryNoticeSpan | null;
  /**
   * ALWAYS false on this build.
   *
   * R1/R2 are blocked on a supported exclusive-writer boundary; until one exists
   * no observation may authorize an incremental append. The field stays on the
   * wire so the history service, the tests and any future implementation share
   * ONE shape.
   */
  append_trusted: boolean;
  /** Child pid whose notices are accepted (0 before the first notice). */
  pid: number;
  /** Incarnation of the accepted notice stream. */
  incarnation: number;
  /** Last accepted sequence number in that incarnation. */
  seq: number;
  /** Emission time of the last accepted notice (ms). */
  at: number;
}

interface Slot {
  pid: number;
  incarnation: number;
  seq: number;
  at: number;
  sessionId: string | null;
  file: string | null;
  span: HistoryNoticeSpan | null;
  /** Set once a `revoke` for this (pid, incarnation) arrives. */
  revoked: boolean;
}

/** Outcome of applying one notice. Exposed for logging/tests only. */
export type WriterNoticeResult =
  | "accepted_session"
  | "accepted_append"
  | "accepted_revoke"
  | "duplicate"
  | "stale_incarnation"
  | "foreign_pid";

export class WriterAuthorityRegistry {
  private readonly slots = new Map<string, Slot>();

  /**
   * The current child pid for a workspace, or 0 when it has none.
   *
   * Injected so this registry never reaches into the supervisor's map: the
   * caller decides what "the current child" means, and a stopped workspace has
   * no live writer at all.
   */
  private readonly currentPid: (workspaceId: string) => number;

  constructor(options: { currentPid(workspaceId: string): number }) {
    this.currentPid = options.currentPid;
  }

  /** Fresh slot for a new process/incarnation. */
  private open(workspaceId: string, notice: HistoryNotice): void {
    const revoked = notice.kind === "revoke";
    this.slots.set(workspaceId, {
      pid: notice.pid,
      incarnation: notice.incarnation,
      seq: notice.seq,
      at: notice.at,
      sessionId: revoked ? null : notice.session_id,
      file: revoked ? null : notice.file,
      span: revoked ? null : notice.span,
      revoked,
    });
  }

  /**
   * Apply one notice from one child.
   *
   * `workspaceId` is resolved by the caller (it owns the pid→workspace map), so
   * this registry cannot be tricked into attributing a notice to another
   * workspace by the payload alone.
   *
   * PID IDENTITY COMES FIRST. A respawned child restarts its own `incarnation`
   * at 1 and its `seq` at 1 — correct and expected — so the old slot is REPLACED,
   * not treated as a stale stream. The incarnation is only monotonic per pid.
   */
  apply(workspaceId: string, notice: HistoryNotice): WriterNoticeResult {
    const expectedPid = this.currentPid(workspaceId);
    if (expectedPid === 0 || expectedPid !== notice.pid) return "foreign_pid";
    const slot = this.slots.get(workspaceId);

    // A NEW child process (or a new incarnation of a reused one): its counters
    // are its own, so the old stream is replaced rather than compared.
    if (slot === undefined || slot.pid !== notice.pid || notice.incarnation > slot.incarnation) {
      this.open(workspaceId, notice);
      return notice.kind === "revoke" ? "accepted_revoke" : notice.kind === "append" ? "accepted_append" : "accepted_session";
    }

    if (notice.incarnation < slot.incarnation) return "stale_incarnation";
    // Same pid + same incarnation: the sequence must advance. A replayed or
    // reordered line changes nothing (authority is not a message counter).
    if (notice.seq <= slot.seq) return "duplicate";

    slot.seq = notice.seq;
    slot.at = notice.at;
    if (notice.kind === "revoke") {
      slot.revoked = true;
      slot.file = null;
      slot.span = null;
      slot.sessionId = slot.sessionId === notice.session_id ? null : slot.sessionId;
      return "accepted_revoke";
    }
    /*
     * A session notice must NOT inherit a previous file's span: a `session`
     * notice opens a new attribution and cannot carry a range at all
     * (history_notice.ts emits `span: null` for it). Only an `append` may set it.
     */
    slot.sessionId = notice.session_id;
    slot.file = notice.file;
    slot.span = notice.kind === "append" ? (notice.span ?? slot.span) : null;
    slot.revoked = false;
    return notice.kind === "append" ? "accepted_append" : "accepted_session";
  }

  /**
   * Revoke a workspace's authority unconditionally (child exit, stop, restart,
   * recycle). Called by the supervisor on every lifecycle transition, so a
   * crashed child's last notice can never keep a file trusted.
   */
  revoke(workspaceId: string): void {
    const slot = this.slots.get(workspaceId);
    if (slot === undefined) return;
    slot.revoked = true;
    slot.file = null;
    slot.span = null;
    slot.sessionId = null;
  }

  /** Drop every trace (workspace removed from the fleet). */
  forget(workspaceId: string): void {
    this.slots.delete(workspaceId);
  }

  /** Snapshot for the history service. */
  snapshot(workspaceId: string, state: WriterAuthoritySnapshot["state"]): WriterAuthoritySnapshot {
    const slot = this.slots.get(workspaceId);
    if (slot === undefined) {
      return {
        state,
        session_id: null,
        file: null,
        span: null,
        append_trusted: false,
        pid: 0,
        incarnation: 0,
        seq: 0,
        at: 0,
      };
    }
    // The pid check is repeated HERE, not only at apply time: a slot whose child
    // has since been replaced must stop being attributed even if no new notice
    // arrived (e.g. the replacement never publishes one).
    const live = this.currentPid(workspaceId) === slot.pid;
    const attributed = state === "running" && live && !slot.revoked && slot.file !== null;
    return {
      state,
      session_id: attributed ? slot.sessionId : null,
      file: attributed ? slot.file : null,
      span: attributed ? slot.span : null,
      /*
       * ALWAYS FALSE. Attribution is not ownership: an ordinary unmanaged process
       * can rewrite the prefix inside any interval we can observe, so no receipt
       * may authorize an incremental append on this SDK (module header).
       */
      append_trusted: false,
      pid: slot.pid,
      incarnation: slot.incarnation,
      seq: slot.seq,
      at: slot.at,
    };
  }

  /** True only when [file] is the file the current child ATTRIBUTED itself to. */
  ownsFile(workspaceId: string, file: string): boolean {
    const slot = this.slots.get(workspaceId);
    if (slot === undefined || slot.revoked) return false;
    if (this.currentPid(workspaceId) !== slot.pid) return false;
    return slot.file !== null && samePath(slot.file, file);
  }

  /**
   * ALWAYS null on this build.
   *
   * Retained so the keep-it-explicit shape stays: a future supported ownership
   * boundary would re-implement this method, and nothing else in the call chain
   * would have to change. Returning a span here would resurrect the unsound
   * "observation = custody" claim this correction removed.
   */
  claimedSpan(workspaceId: string, file: string): HistoryNoticeSpan | null {
    void workspaceId;
    void file;
    return null;
  }
}
