"use client";

/* Read-only viewer for a session that is NOT the live one.
 *
 * This is the whole point of the split: clicking a session in the sidebar
 * READS it (`session_read`) and shows the transcript here, without changing
 * the workspace Pi's active session. The banner says so, and the only control
 * that changes state is the explicit "Switch" button, which lives in the
 * sidebar next to each row.
 */
import { Icon } from "./icons";
import { Markdown } from "./markdown";
import type { WireSessionEvent } from "@/lib/remote-pi/protocol";
import type { WireSessionInfo } from "@/lib/remote-pi/sessions";

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
  /** True when this session is ALSO the live one (it cannot be switched to). */
  isLive: boolean;
}

/** One rendered row. Tool calls are summarised, not expanded: this is a
 *  transcript read, not a debugging surface. */
function EventRow({ event }: { event: WireSessionEvent }) {
  if (event.type === "user_input") {
    return (
      <div className="flex justify-end py-2">
        <div className="max-w-[88%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-[14px_14px_4px_14px] border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-[14.5px] leading-relaxed text-white">
          {event.text}
        </div>
      </div>
    );
  }
  if (event.type === "agent_message") {
    return (
      <div className="grid gap-2.5 py-2">
        <div className="flex items-center gap-2 text-[12px] text-[#a3a3a3]">
          <span className="grid size-5 place-items-center rounded-md border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[#4fc3f7]">
            <Icon name="cpu" size={12} />
          </span>
          <b className="text-[12px] font-semibold text-[#a3a3a3]" style={{ fontFamily: "var(--ff-display)" }}>
            Pi
          </b>
        </div>
        <div className="min-w-0 break-words [overflow-wrap:anywhere]">
          <Markdown text={event.text} />
        </div>
      </div>
    );
  }
  if (event.type === "tool_request") {
    return (
      <div className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-[#8a8a8a]">
        <Icon name="term" size={11} />
        <span className="truncate">{event.tool}</span>
      </div>
    );
  }
  if (event.type === "tool_result") {
    // An `error` is a FLAG: its text is host/tool output and is not rendered.
    return (
      <div className="flex items-center gap-2 py-0.5 pl-4 font-mono text-[11px]">
        <span className={event.error === undefined ? "text-[#5fd38a]" : "text-[#f25a5a]"}>
          {event.error === undefined ? "ok" : "failed"}
        </span>
      </div>
    );
  }
  return (
    <div className="my-2 flex items-center gap-2 font-mono text-[11px] text-[#a3a3a3]">
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
  isLive,
}: SessionViewerProps) {
  return (
    <div className="grid min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]">
      {/* The banner is what makes the read-only nature unmistakable, and it
          carries the ONLY state-changing control. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3.5 py-2">
        <span className="rounded border border-white/15 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-[#a3a3a3]">
          read-only
        </span>
        <span className="min-w-0 truncate text-[13px] text-white">
          {session.name?.trim() || session.id.split("-")[0]}
        </span>
        {isLive ? (
          <span className="rounded border border-[rgba(95,211,138,0.3)] px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-[#5fd38a]">
            live
          </span>
        ) : (
          <button
            type="button"
            onClick={onSwitch}
            title="Make this the workspace's live session (affects every paired client)"
            className="rounded-md border border-white/15 px-2 py-0.5 font-mono text-[10.5px] text-[#a3a3a3] transition hover:border-[#4fc3f7] hover:text-[#4fc3f7]"
          >
            switch to this session
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the read-only session view"
          className="ml-auto grid size-6 place-items-center rounded-md border border-white/10 text-[#6b6b6b] transition hover:border-white/20 hover:text-white"
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto grid max-w-[848px] gap-0.5 px-[70px] pb-8 pt-5 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4">
          {notice !== null ? (
            <p role="status" className="py-3 text-[13px] text-[#f0a35e]">
              {notice}
            </p>
          ) : loading || events === null ? (
            <p className="py-3 text-[13px] text-[#a3a3a3]">Reading this session…</p>
          ) : events.length === 0 ? (
            <p className="py-3 text-[13px] text-[#a3a3a3]">
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
