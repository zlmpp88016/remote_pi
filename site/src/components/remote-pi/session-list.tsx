"use client";

/* Session list for the sidebar: the workspace's AgentSessions, newest first.
 *
 * Two DISTINCT actions, because they are genuinely different operations:
 *
 *   • Clicking a row READS that session's transcript (`session_read`). This is
 *     read-only and does NOT touch the live session — the workspace Pi keeps
 *     running whatever it was running.
 *   • The explicit "Switch" control issues `session_switch`, which DOES change
 *     the active session for every paired client (and the Pi TUI). It is a
 *     separate, deliberate button for exactly that reason, and the host can
 *     refuse it (`locked` when the TUI holds the session).
 *
 * Presentational, like `model-picker`: the container owns the requests, the
 * reply correlation and the state.
 */
import { Icon } from "./icons";
import {
  previewText,
  relativeTime,
  sessionLabel,
  shortSessionId,
  type WireSessionInfo,
} from "@/lib/remote-pi/sessions";

export interface SessionListProps {
  sessions: readonly WireSessionInfo[];
  /** True while a `session_list` request is in flight. */
  busy: boolean;
  /** Fixed, client-authored reason the list cannot load, or null. */
  disabledReason: string | null;
  /** The session currently open for READING (may differ from the live one). */
  viewingId: string | null;
  /** The live session, as the host reported it. */
  liveId: string | null;
  /** Fixed sentence for the last failed action, or null. */
  notice: string | null;
  /** "Now" for the relative ages, passed IN so the render stays pure (a
   *  `Date.now()` in the body would be an impure read during render). */
  now: number;
  onOpen: () => void;
  /** Reads a session (read-only). */
  onRead: (id: string) => void;
  /** SWITCHES the live session — a real state change, hence its own control. */
  onSwitch: (id: string) => void;
  /** The workspace's own column width: the rail hides the labels. */
  rail: boolean;
}

export function SessionList({
  sessions,
  busy,
  disabledReason,
  viewingId,
  liveId,
  notice,
  now,
  onOpen,
  onRead,
  onSwitch,
  rail,
}: SessionListProps) {
  return (
    <section className="grid gap-1.5" aria-label="Sessions">
      <div className="flex items-center gap-2 px-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#6b6b6b]">
          Sessions
        </span>
        <button
          type="button"
          onClick={onOpen}
          disabled={busy || disabledReason !== null}
          aria-label="Refresh the session list"
          title={disabledReason ?? "Reload this workspace's sessions"}
          className="ml-auto grid size-6 place-items-center rounded-md border border-white/10 text-[#6b6b6b] transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>

      {disabledReason !== null ? (
        <p className="px-2 py-1.5 text-[12px] leading-relaxed text-[#6b6b6b]">{disabledReason}</p>
      ) : sessions.length === 0 ? (
        <p className="px-2 py-1.5 text-[12px] leading-relaxed text-[#6b6b6b]">
          {busy ? "Asking the host for this workspace's sessions…" : "No sessions in this workspace yet."}
        </p>
      ) : (
        <ul className="grid gap-1">
          {sessions.map((session) => {
            const isLive = session.id === liveId;
            const isViewing = session.id === viewingId;
            const preview = previewText(session);
            return (
              <li key={session.id}>
                <div
                  className={`group grid gap-1 rounded-[10px] border px-2.5 py-2 transition ${
                    isViewing
                      ? "border-[rgba(79,195,247,0.35)] bg-[rgba(79,195,247,0.07)]"
                      : "border-white/10 bg-white/[0.03] hover:border-white/20"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onRead(session.id)}
                    aria-label={`Read session ${sessionLabel(session)}`}
                    title={preview === "" ? "Read this session" : preview}
                    className="grid min-w-0 gap-0.5 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-white">
                        {rail ? shortSessionId(session.id) : sessionLabel(session)}
                      </span>
                      {isLive ? (
                        <span className="shrink-0 rounded border border-[rgba(95,211,138,0.3)] px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-[#5fd38a]">
                          live
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[#6b6b6b]">
                        {relativeTime(session.mtime, now)}
                      </span>
                    </span>
                    {rail || preview === "" ? null : (
                      <span className="truncate font-mono text-[10.5px] text-[#8a8a8a]">
                        {preview}
                      </span>
                    )}
                  </button>

                  {/* The SWITCH control only exists where switching would do
                      something: already-live sessions are not switchable. */}
                  {isLive ? null : (
                    <button
                      type="button"
                      onClick={() => onSwitch(session.id)}
                      aria-label={`Switch to session ${sessionLabel(session)}`}
                      title="Make this the workspace's live session (affects every paired client)"
                      className="justify-self-start rounded-md border border-white/15 px-2 py-0.5 font-mono text-[10.5px] text-[#a3a3a3] transition hover:border-[#4fc3f7] hover:text-[#4fc3f7]"
                    >
                      switch
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {notice !== null ? (
        <p role="status" className="px-2 text-[11.5px] leading-relaxed text-[#f0a35e]">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
