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
import { useCallback, useEffect, useRef } from "react";
import { Icon } from "../core/icons";
import css from "./session-list.module.css";
import {
  previewText,
  relativeTime,
  sessionLabel,
  shortSessionId,
  type WireSessionInfo,
} from "@/lib/remote-pi/sessions";

/**
 * Hover-to-prefetch delay.
 *
 * Short enough to hide behind normal pointing, long enough that sweeping the
 * pointer across the list issues no request at all.
 */
const PREFETCH_DELAY_MS = 120;

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
  /** Reads a session (read-only, no process change). */
  onRead: (id: string) => void;
  /**
   * Warms a transcript before the click, so the viewer has content the moment it
   * mounts. Optional: without it the list behaves exactly as before.
   */
  onPrefetch?: ((id: string) => void) | undefined;
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
  onPrefetch,
}: SessionListProps) {
  /*
   * Debounced prefetch.
   *
   * Hover fires on every row the pointer crosses, so firing a request per
   * `mouseenter` would flood the room while the user merely moves the mouse to
   * the scrollbar. The delay is short enough to hide behind normal pointing
   * (~120ms) and long enough that a fast sweep issues nothing: the timer of the
   * row being LEFT is cleared before it fires.
   *
   * Focus uses the same path, so keyboard users get the same warm start.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const schedule = useCallback(
    (id: string) => {
      if (onPrefetch === undefined) return;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        onPrefetch(id);
      }, PREFETCH_DELAY_MS);
    },
    [cancel, onPrefetch],
  );
  // A row unmounting (list refresh) must not leave a pending prefetch behind.
  useEffect(() => cancel, [cancel]);

  return (
    /* The dock body already scrolls, but the list must not grow the page when a
     * workspace has hundreds of sessions: the header stays put and only the
     * rows scroll, inside this section's own bounded box. */
    <section
      className={css.root}
      aria-label="会话"
    >
      <div className={css.head}>
        <span className={css.title}>
          会话
        </span>
        <button
          type="button"
          /*
           * `() => onOpen()` and NOT `onOpen`.
           *
           * React passes the MouseEvent as the first argument. A zero-arg prop
           * type accepts that silently, so `onClick={onOpen}` hands the EVENT to
           * the handler as its optional parameter — and a handler shaped like
           * `(adapterOverride?) => …` then treats a MouseEvent as its adapter and
           * throws before doing anything. The control renders enabled, click
           * feedback is nil, and the panel looks frozen.
           */
          onClick={() => onOpen()}
          disabled={busy || disabledReason !== null}
          aria-label="刷新会话列表"
          title={disabledReason ?? "重新加载该工作区的会话"}
          className={css.refresh}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>

      {disabledReason !== null ? (
        <div className={css.scroll}>
          <p className={css.note}>{disabledReason}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className={css.scroll}>
          {/*
           * "还没有会话" may only be claimed when the host actually SAID
           * so. An empty list can also mean: still asking, or the request failed
           * (the host respawns its Pi on a switch and cannot answer in that
           * window). Rendering the empty-state in those cases tells the user
           * their history is gone when it is not.
           */}
          <p className={css.note}>
            {notice !== null
              ? "无法加载该工作区的会话。点击刷新重试。"
              : busy
                ? "正在向主机请求该工作区的会话…"
                : "该工作区还没有会话。"}
          </p>
        </div>
      ) : (
        <div className={css.scrollX}>
          <ul className={css.list}>
            {sessions.map((session) => {
              const isLive = session.id === liveId;
              const isViewing = session.id === viewingId;
              const preview = previewText(session);
              const label = sessionLabel(session);
              /* The label IS the first message most of the time, so printing
                 the preview underneath would repeat the same sentence twice.
                 Show it only when it adds something the label does not. */
              const subtitleInside = preview !== "" && !label.startsWith(preview.slice(0, 24)) ? preview : "";
              return (
                <li key={session.id}>
                  <div
                    className={`${css.row} ${isViewing ? css.rowViewing : css.rowIdle}`}
                  >
                    <button
                      type="button"
                      onClick={() => onRead(session.id)}
                      onMouseEnter={() => schedule(session.id)}
                      onMouseLeave={cancel}
                      onFocus={() => schedule(session.id)}
                      onBlur={cancel}
                      aria-label={`Read session ${label}`}
                      title={preview === "" ? "查看该会话" : preview}
                      className={css.readButton}
                    >
                      <span className={css.rowHead}>
                        <span className={css.rowName}>
                          {label}
                        </span>
                        {isLive ? (
                          <span className={css.liveBadge}>
                            live
                          </span>
                        ) : null}
                        <span className={css.age}>
                          {shortSessionId(session.id)} · {relativeTime(session.mtime, now)}
                        </span>
                      </span>
                      {subtitleInside === "" ? null : (
                        <span className={css.preview}>
                          {subtitleInside}
                        </span>
                      )}
                    </button>

                    {/* No per-row switch control.
                        Opening a transcript is read-only and cheap: the host
                        answers `session_read` from disk without touching the
                        agent process. Resuming execution is a different, far
                        more expensive action (it exits the daemon and the
                        supervisor respawns a new Pi onto the target file), so
                        it does not belong on every row where a stray click
                        costs a full restart. It lives once, deliberately, in
                        the session viewer as "Resume here". */}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {notice !== null ? (
        <p role="status" className={css.notice}>
          {notice}
        </p>
      ) : null}
    </section>
  );
}
