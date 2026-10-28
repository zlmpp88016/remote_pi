"use client";

/* Read-only viewer for a session that is NOT the live one.
 *
 * This is the whole point of the split: clicking a session in the dock READS it
 * (`session_read`) and shows the transcript here, without changing the
 * workspace Pi's active session. Reading is a pure disk read on the host, so it
 * is instant and safe to do casually, as often as you like.
 *
 * Resuming is the opposite kind of action: it exits the daemon and the
 * supervisor respawns a new Pi onto the target session file, which is why it is
 * ONE explicit button here rather than a control on every row. The button is
 * also the only place that states the consequence before it happens.
 */
import { useEffect, useState } from "react";
import { Icon } from "../core/icons";
import { Markdown } from "../chat/markdown";
import css from "./session-viewer.module.css";
import type { WireSessionEvent } from "@/lib/remote-pi/protocol";
import { sessionLabel, type WireSessionInfo } from "@/lib/remote-pi/sessions";

export interface SessionViewerProps {
  /** The session being read (from `session_list`). */
  session: WireSessionInfo;
  /** Its transcript, oldest-first, or null while the read is in flight. */
  events: readonly WireSessionEvent[] | null;
  /** True while the `session_read` request is in flight. */
  loading: boolean;
  /** Fixed, client-authored failure text, or null. */
  notice: string | null;
  /** Closes the viewer and returns to the live transcript. */
  onClose: () => void;
  /** SWITCHES the live session to this one (the state-changing control). */
  onSwitch: () => void;
  /** True while the switch is in flight (the host is respawning onto it). */
  switchBusy?: boolean;
  /** Host-stated capability; false renders the control inert with a reason. */
  canSwitch?: boolean;
  /** True when this session is ALSO the live one (it cannot be switched to). */
  isLive: boolean;
}

/** One rendered row. Tool calls are summarised, not expanded: this is a
 *  transcript read, not a debugging surface. */
function EventRow({ event }: { event: WireSessionEvent }) {
  if (event.type === "user_input") {
    return (
      <div className={css.userTurn}>
        <div className={css.userBubble}>
          {event.text}
        </div>
      </div>
    );
  }
  if (event.type === "agent_message") {
    return (
      <div className={css.agentTurn}>
        <div className={css.agentHead}>
          <span className={css.agentMark}>
            <Icon name="cpu" size={12} />
          </span>
          <b className={css.agentName} style={{ fontFamily: "var(--ff-display)" }}>
            Pi
          </b>
        </div>
        <div className={css.agentBody}>
          <Markdown text={event.text} />
        </div>
      </div>
    );
  }
  if (event.type === "tool_request") {
    return (
      <div className={css.toolRow}>
        <Icon name="term" size={11} />
        <span className={css.toolName}>{event.tool}</span>
      </div>
    );
  }
  if (event.type === "tool_result") {
    // An `error` is a FLAG: its text is host/tool output and is not rendered.
    return (
      <div className={css.toolResult}>
        <span className={event.error === undefined ? css.ok : css.error}>
          {event.error === undefined ? "ok" : "failed"}
        </span>
      </div>
    );
  }
  return (
    <div className={css.marker}>
      <Icon name="refresh" size={11} />
      <span>context compacted ({event.tokens_before} tokens before)</span>
    </div>
  );
}

export function SessionViewer({
  session,
  events,
  loading,
  notice,
  onClose,
  onSwitch,
  switchBusy = false,
  canSwitch = true,
  isLive,
}: SessionViewerProps) {
  /*
   * Elapsed seconds while resuming.
   *
   * A spinner proves nothing about liveness; a running counter does. Resuming
   * costs a daemon exit, a supervisor respawn and a fresh handshake, which is
   * seconds of real work -- without a number it reads as a dead button, which
   * is exactly how this was reported.
   *
   * The reset happens on click rather than in the effect: the interval is the
   * only writer while busy, so there is no stale value to clear afterwards.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!switchBusy) return undefined;
    const tick = setInterval(() => {
      setElapsed((n) => n + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [switchBusy]);

  const handleResume = (): void => {
    setElapsed(0);
    onSwitch();
  };

  return (
    /* `h-full` is load-bearing: as a plain block child this grid grew to its
     * content height and spilled out of the cell that sizes it, so the inner
     * `minmax(0, 1fr)` row never became the transcript's scroll box and a long
     * history session pushed the whole page taller instead. */
    <div className={css.root}>
      {/* The banner is what makes the read-only nature unmistakable, and it
          carries the ONLY state-changing control. */}
      <div className={css.head}>
        <span className={css.chip}>
          read-only
        </span>
        <span className={css.title}>
          {sessionLabel(session)}
        </span>
        {isLive ? (
          <span className={css.liveBadge}>
            live
          </span>
        ) : (
          /*
           * The label says what the reader gets, not what the protocol does.
           * "switch to this session" described a state change; what a person
           * actually wants to know is whether they can keep talking here.
           */
          <button
            type="button"
            onClick={handleResume}
            disabled={switchBusy || !canSwitch}
            title={
              !canSwitch
                ? "The host has no command context to switch sessions with."
                : switchBusy
                  ? "Switching — the host is restarting its Pi onto this session…"
                  : "Make this the live session, then keep talking in it (affects every paired client)"
            }
            className={`${css.switchButton}${switchBusy ? ` ${css.switchButtonBusy}` : ""}`}
          >
            {switchBusy
              ? elapsed > 0
                ? `Resuming… ${elapsed}s`
                : "Resuming…"
              : "Resume here"}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the read-only session view"
          className={css.refresh}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className={css.scroll}>
        <div className={css.transcript}>
          {notice !== null ? (
            <p role="status" className={css.statusLine}>
              {notice}
            </p>
          ) : loading || events === null ? (
            <p className={css.emptyLine}>Reading this session…</p>
          ) : events.length === 0 ? (
            <p className={css.emptyLine}>
              This session has no messages yet.
            </p>
          ) : (
            events.map((event, index) => (
              <EventRow key={`${event.ts}-${index}`} event={event} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
