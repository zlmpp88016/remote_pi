/**
 * Pure presentation helpers for the session list.
 *
 * No JSX and no React, so Node can verify them directly — the same split as
 * `slash.ts` / `model-cache.ts`.
 */
import type { WireSessionInfo } from "./protocol.ts";

export type { WireSessionInfo } from "./protocol.ts";

/** A short, stable label for a session id (`01a0fb4e-b263-…` → `01a0fb4e`). */
export function shortSessionId(id: string): string {
  return id.split("-")[0] ?? id;
}

/**
 * The name to show for a session.
 *
 * The host's `name` is NOT a title: the SDK's `SessionManager.list()` fills it
 * from the user-defined display name, which in practice holds the WORKSPACE
 * FOLDER NAME. Every session in one folder therefore arrives with the same
 * `name` (measured: 11 sessions, all `"name":"4.1f"`), and rendering it made
 * every row read identically.
 *
 * The distinguishing text is the session's own first message, so that is the
 * title. A user-set display name still wins when it actually differs from the
 * folder name, because someone explicitly typed it. Falling back to the id
 * prefix stays last: it is only a handle for matching the Pi TUI.
 */
export function sessionLabel(session: WireSessionInfo): string {
  const name = session.name?.trim() ?? "";
  const preview = previewText(session);
  const folderLike = session.cwd !== undefined && name === basenameOf(session.cwd);

  if (name !== "" && !folderLike) return name;
  if (preview !== "") return truncateLabel(preview);
  return shortSessionId(session.id);
}

/** Last path segment of a cwd, tolerating both separators (host may be POSIX). */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter((x) => x !== "");
  return parts[parts.length - 1] ?? p;
}

const LABEL_MAX = 64;

/** Keep the label one line; the row ellipsises, but a cut here keeps the DOM
 *  small and stops a pasted blob from dominating the row. */
function truncateLabel(text: string): string {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

/**
 * Relative age, coarse on purpose: the row is a hint, not a timestamp. Clock
 * skew or a future mtime clamps to "now" rather than printing a negative age.
 */
export function relativeTime(mtime: number, now: number): string {
  const delta = Math.max(0, now - mtime);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Fixed, client-authored text for the `session_switch` refusal codes. The
 * host's `message` is diagnostic detail and is NEVER shown: these say what the
 * user can do, and each maps to a real SDK outcome.
 */
export const SWITCH_ERROR_TEXT: Readonly<Record<string, string>> = {
  locked: "That session is open in the Pi terminal. Close it there before switching.",
  unknown: "That session no longer exists in this workspace.",
  no_sdk: "This workspace Pi cannot switch sessions right now (no command context).",
};

/** The fixed sentence for a refusal code, with a non-guessing fallback. */
export function switchErrorText(code: string): string {
  return SWITCH_ERROR_TEXT[code] ?? "The host did not switch to that session.";
}

/** Ordered newest-first. The host list is already sorted, but the UI relies on
 *  it, so it is enforced here rather than assumed. */
export function sortSessions(sessions: readonly WireSessionInfo[]): readonly WireSessionInfo[] {
  return [...sessions].sort((a, b) => b.mtime - a.mtime);
}

/** Short one-line preview; the host already truncates to ~200 chars. */
export function previewText(session: WireSessionInfo): string {
  const raw = (session.preview ?? "").replace(/\s+/g, " ").trim();
  return raw;
}

/** The session-surface requests the host can refuse with `action_error`. */
export type SessionActionName =
  | "session_read"
  | "session_switch"
  | "session_list"
  | "session_new";

/**
 * Fixed, client-authored sentence for a REFUSED session request.
 *
 * The host refuses these with the same generic `action_error` frame it uses for
 * everything else (an unknown session id, a workspace with no cwd yet, a Pi
 * without command context). Before this existed the refusal was invisible: the
 * client only handled the `_ok` replies, so the pending request never settled
 * and clicking a session looked like it did nothing at all.
 *
 * Returns null for any other action so a caller can let unrelated failures fall
 * through to their own handling instead of being rewritten as a session error.
 */
export function sessionActionErrorText(action: string): string | null {
  if (action === "session_read") return "Could not read that session.";
  if (action === "session_switch") return "Could not ask the host to switch sessions.";
  if (action === "session_list") return "Could not list this workspace's sessions.";
  if (action === "session_new") return "Could not start a new session in this workspace.";
  return null;
}
