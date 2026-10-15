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
 * The name to show for a session. A session without a name is NOT unnamed in
 * the UI: the id prefix is what the user can match against the Pi TUI, so the
 * row shows that instead of an empty label.
 */
export function sessionLabel(session: WireSessionInfo): string {
  const name = session.name?.trim() ?? "";
  return name === "" ? shortSessionId(session.id) : name;
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
