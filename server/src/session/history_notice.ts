/**
 * Plan 86 P2 correction (R1/R2) — the child→host writer NOTICE.
 *
 * ── STATUS: identity only. NO append authority. ───────────────────────────
 *
 * This channel publishes what a child can honestly say about ITSELF:
 *
 *   session_id + absolute session file  (who/where it is working)
 *   a custody range it claims to have written (diagnostics only)
 *
 * It does NOT prove that only this process wrote a byte range, and nothing in the
 * history path may treat it as if it did. The independent bounded analysis
 * (agent://b1a9c346-ef53-4068-b7e0-dc121c82127c) confirmed why:
 *
 *   - `pi.on("message_end")` runs BEFORE the SDK persists that message
 *     (agent-session.js:272 emits the event, :287 appends), so an extension can
 *     only observe around a write, never intercept it;
 *   - an ORDINARY unmanaged process can rewrite an early field in place while
 *     preserving the file size and the final 4 KiB, at any point between two
 *     observations — including between the SDK's append and any after-stat;
 *   - therefore two consecutive `stat` identities that match can still bracket
 *     someone else's write, and a size/mtime/ctime comparison cannot exclude it.
 *
 * Recognizing the prefix instead would cost a full O(file) hash per append, which
 * IS the rebuild we are trying to avoid. So the honest engineering decision, per
 * root supervision, is: publish identity, withhold append trust, and let every
 * change take the conservative rebuild into a new generation. That is O(file) and
 * is reported as O(file) — never as O(delta).
 *
 * The `span` field is retained because a future SUPPORTED exclusive-ownership
 * boundary would want exactly this shape; today no consumer may trust it.
 *
 * TRANSPORT
 *
 *   The child's stdout is the Pi RPC channel, and Pi's RPC mode takes over
 *   `process.stdout` (redirecting extension writes to stderr) so a notice can
 *   never corrupt a protocol frame. This module therefore writes ONE JSON object
 *   per line to STDERR, prefixed with {@link HISTORY_NOTICE_PREFIX}. The
 *   supervisor already reads its children's stderr and forwards it; it consumes
 *   ONLY lines carrying the prefix.
 *
 *   Additive INTERNAL channel: no pairing, no wire frame, no client change.
 *
 * MUST stay SDK-free: the host parses notices in `pi-supervisord`, where no Pi
 * exists.
 */

/** Line prefix. Reserved: nothing else may print it. */
export const HISTORY_NOTICE_PREFIX = "[remote-pi-history-notice]";

/** Bumped when the payload shape changes; the host ignores unknown versions. */
export const HISTORY_NOTICE_VERSION = 2;

/** Why a notice was emitted. */
export type HistoryNoticeKind =
  /** The child (re)bound a live session writer: identity is authoritative. */
  | "session"
  /** The child observed a boundary while persisting. Diagnostics only. */
  | "append"
  /** The child is tearing down this session (switch/new/reload/quit). */
  | "revoke";

/**
 * The file identity `stat` reports: inode, birth time, complete size, mtime and
 * ctime.
 */
export interface HistoryNoticeStamp {
  ino: number;
  birthtime_ms: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

/**
 * A claimed custody range: "between these two `stat` identities I persisted".
 *
 * ⚠ DIAGNOSTIC ONLY. A matching pair of endpoints does NOT prove that no other
 * process wrote inside the range (module header). Consumers must not authorize an
 * incremental append from it.
 */
export interface HistoryNoticeSpan {
  before: HistoryNoticeStamp;
  after: HistoryNoticeStamp;
}

export interface HistoryNotice {
  v: typeof HISTORY_NOTICE_VERSION;
  kind: HistoryNoticeKind;
  /** Per-INCARNATION identity; a respawn starts at 1 again. */
  incarnation: number;
  /** Monotonic per incarnation, so a reordered/short line is detectable. */
  seq: number;
  /** Pi session id. */
  session_id: string;
  /** Absolute session file path, or null when the child cannot resolve it. */
  file: string | null;
  /** The claimed range, or null. DIAGNOSTIC ONLY (see {@link HistoryNoticeSpan}). */
  span: HistoryNoticeSpan | null;
  /** Child pid, so the host can refuse a notice from an unrelated process. */
  pid: number;
  /** Emission time (ms since epoch), informational only. */
  at: number;
}

/** Serialize one notice as a single stderr line. */
export function formatHistoryNotice(notice: HistoryNotice): string {
  return `${HISTORY_NOTICE_PREFIX} ${JSON.stringify(notice).replace(/[\r\n]/gu, " ")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` = malformed, `null` = absent, else the stamp. */
function parseStamp(value: unknown): HistoryNoticeStamp | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const ino = value["ino"];
  const birthtime = value["birthtime_ms"];
  const size = value["size"];
  const mtime = value["mtime_ms"];
  const ctime = value["ctime_ms"];
  const numeric = (candidate: unknown): boolean => typeof candidate === "number" && Number.isFinite(candidate);
  if (!numeric(ino) || !numeric(birthtime) || !numeric(mtime) || !numeric(ctime)) return undefined;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return undefined;
  if ((mtime as number) < 0 || (ctime as number) < 0) return undefined;
  return {
    ino: ino as number,
    birthtime_ms: birthtime as number,
    size,
    mtime_ms: mtime as number,
    ctime_ms: ctime as number,
  };
}

/** `undefined` = malformed, `null` = absent, else the span. */
function parseSpan(value: unknown): HistoryNoticeSpan | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const before = parseStamp(value["before"]);
  const after = parseStamp(value["after"]);
  if (before === undefined || after === undefined) return undefined;
  if (before === null || after === null) return undefined;
  // A span must move forward; anything else is not a write we can even describe.
  if (after.size < before.size) return undefined;
  return { before, after };
}

/**
 * Parse one already-trimmed line into a notice, or null.
 *
 * Deliberately strict: an unknown version, a missing field or a non-string id is
 * NOT a notice. The host must never guess a writer identity from a malformed
 * line — a wrong attribution is worse than a conservative rebuild.
 */
export function parseHistoryNotice(line: string): HistoryNotice | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(HISTORY_NOTICE_PREFIX)) return null;
  const rest = trimmed.slice(HISTORY_NOTICE_PREFIX.length).trim();
  if (rest === "" || rest[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed["v"] !== HISTORY_NOTICE_VERSION) return null;
  const kind = parsed["kind"];
  if (kind !== "session" && kind !== "append" && kind !== "revoke") return null;
  const incarnation = parsed["incarnation"];
  const seq = parsed["seq"];
  const pid = parsed["pid"];
  const at = parsed["at"];
  const sessionId = parsed["session_id"];
  const file = parsed["file"];
  if (
    typeof incarnation !== "number" ||
    !Number.isInteger(incarnation) ||
    incarnation < 1 ||
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    typeof sessionId !== "string" ||
    sessionId === "" ||
    sessionId.length > 512 ||
    !(file === null || (typeof file === "string" && file !== "" && file.length <= 4096))
  ) {
    return null;
  }
  const span = parseSpan(parsed["span"]);
  if (span === undefined) return null;
  return {
    v: HISTORY_NOTICE_VERSION,
    kind,
    incarnation,
    seq,
    session_id: sessionId,
    file,
    span,
    pid,
    at,
  };
}
