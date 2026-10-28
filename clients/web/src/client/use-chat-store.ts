/**
 * Chat surface state: the reducer-backed transcript, the composer draft, the
 * pending turn timer and the coalescing animation frame.
 *
 * The transcript itself is owned by the pure reducer in `@/lib/remote-pi/chat`.
 * This hook adds only what the container needs around it:
 *   • `chatStateRef` — a mirror the message listener reads, so it never closes
 *     over a stale `chatState` and never needs to re-subscribe per turn;
 *   • `dispatchChat` — the ONE writer, so the mirror and the render state can
 *     never drift;
 *   • `frameRef` — coalesces streamed chunks into one render per animation
 *     frame;
 *   • `timerRef` — bounds a pending turn to the EXACT turn it was scheduled for
 *     (room + id + generation + adapter), so a late firing for any other
 *     room/turn/generation/binding is ignored.
 *
 * STREAM COALESCING (kept from the original container): `agent_chunk` arrives
 * once per SSE-style delta, far faster than the display refresh. Committing each
 * one forces a React render (and a Markdown re-parse of the whole accumulated
 * reply) per token, which made a streaming answer feel mushy and stole the main
 * thread from the composer. Chunks are therefore folded into the ref
 * IMMEDIATELY (no delta is ever lost, and a same-tick reader already sees the
 * full text) while the React commit is deferred to the next animation frame.
 * One paint = one render, regardless of how many deltas landed in it.
 *
 * Everything else (submit/echo/done/error/tool/reset/timeout) commits
 * synchronously: those are phase edges the user is waiting on, and there are at
 * most a few per turn.
 */

import { useCallback, useRef, useState } from "react";

import {
  initialChatState,
  reduceChat,
  type ChatEvent,
  type ChatState,
} from "@/lib/remote-pi/chat";
import type { RemotePiAdapter } from "@/lib/remote-pi/adapter";

/** The pending-turn timer, bounded to the turn it was scheduled for. */
export interface PendingTurnTimer {
  handle: ReturnType<typeof setTimeout>;
  roomId: string;
  id: string;
  generation: number;
  adapter: RemotePiAdapter;
}

export interface ChatStateSurface {
  readonly chatState: ChatState;
  readonly draft: string;
}

export interface ChatActions {
  readonly setDraft: (draft: string) => void;
  /**
   * Points the composer at a session's own draft.
   *
   * Called when the LIVE session changes, so text typed for one session is not
   * shown — or discarded — while another is active. Switching away and back
   * restores what was there.
   */
  readonly setDraftKey: (key: string) => void;
  /** Applies one reducer event and refreshes the listener mirror. */
  readonly dispatchChat: (event: ChatEvent) => void;
  /** Drops the transcript back to its initial state (room switch / unbind). */
  readonly resetChat: () => void;
  /** Schedules ONE frame; falls back to a microtask where rAF is absent. */
  readonly scheduleFrame: (publish: () => void) => number;
  /** Drops a queued frame. The text itself is not lost: it already lives in the
   *  ref, so the next commit publishes it. */
  readonly cancelFrame: () => void;
  /** Clears the pending-turn timer (does not settle the turn). */
  readonly clearTimer: () => void;
  /** The mirror the message listener reads. */
  readonly chatStateRef: React.MutableRefObject<ChatState>;
  /** Coalescing animation frame for streamed text. */
  readonly frameRef: React.MutableRefObject<number | null>;
  /** The bounded pending-turn timer. */
  readonly timerRef: React.MutableRefObject<PendingTurnTimer | null>;
}

export interface ChatStore {
  readonly state: ChatStateSurface;
  readonly actions: ChatActions;
}

export function useChatStore(): ChatStore {
  const [chatState, setChatState] = useState<ChatState>(initialChatState);
  /*
   * Drafts are keyed by session, not global.
   *
   * A single `draft` meant that resuming, switching or starting a session wiped
   * whatever the user had typed — the text was never stored anywhere else. The
   * loss was silent and unrecoverable, which is the worst combination for a text
   * field.
   *
   * Keyed by the LIVE session id (falling back to the room when no session is
   * live yet), so each session keeps its own half-written message.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftKey, setDraftKey] = useState<string>("");
  const draft = drafts[draftKey] ?? "";
  const chatStateRef = useRef<ChatState>(initialChatState);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<PendingTurnTimer | null>(null);

  const scheduleFrame = useCallback((publish: () => void): number => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(publish);
    }
    return setTimeout(publish, 0) as unknown as number;
  }, []);

  const cancelFrame = useCallback((): void => {
    const handle = frameRef.current;
    if (handle === null) return;
    frameRef.current = null;
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(handle);
      return;
    }
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }, []);

  const clearTimer = useCallback((): void => {
    const pending = timerRef.current;
    if (pending === null) return;
    timerRef.current = null;
    clearTimeout(pending.handle);
  }, []);

  /** Synchronous reducer forwarder: ref first (so a same-tick reader sees the
   *  new state), React state second. A settled turn cancels the pending timer. */
  const dispatchChat = useCallback(
    (event: ChatEvent): void => {
      const next = reduceChat(chatStateRef.current, event);
      if (next === chatStateRef.current) return;
      chatStateRef.current = next;
      // A pending frame already scheduled by an earlier chunk publishes THIS
      // state when it fires, because it reads the ref, not a captured value.
      if (event.type === "chunk" && frameRef.current !== null) return;
      if (event.type === "chunk") {
        frameRef.current = scheduleFrame(() => {
          frameRef.current = null;
          setChatState(chatStateRef.current);
        });
      } else {
        cancelFrame();
        setChatState(next);
      }
      const phase = next.active?.phase;
      const settled =
        next.active === null ||
        phase === "completed" ||
        phase === "error" ||
        phase === "timed_out" ||
        phase === "disconnected";
      if (settled) clearTimer();
    },
    [cancelFrame, clearTimer, scheduleFrame],
  );

  const resetChat = useCallback(() => {
    chatStateRef.current = initialChatState;
    setChatState(initialChatState);
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      setDrafts((prev) => {
        if ((prev[draftKey] ?? "") === text) return prev;
        return { ...prev, [draftKey]: text };
      });
    },
    [draftKey],
  );

  return {
    state: { chatState, draft },
    actions: {
      setDraft,
      setDraftKey,
      dispatchChat,
      resetChat,
      scheduleFrame,
      cancelFrame,
      clearTimer,
      chatStateRef,
      frameRef,
      timerRef,
    },
  };
}
