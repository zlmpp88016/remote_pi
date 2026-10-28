/**
 * Session surface state (plan/67 list/switch, plan/71 read-only transcript).
 *
 * Owns every `useState`/`useRef` the sessions dock and the read-only viewer
 * need, plus the in-flight correlation ids for the three session actions.
 *
 * WHY A HOOK AND NOT A GLOBAL STORE: the container still renders one shell and
 * the state is not shared across routes. A hook keeps the dependency graph
 * explicit (`state + request refs` in, `handlers` out) while removing 40+ lines
 * of `useState` noise from the container, which is what made the file hard to
 * navigate. It also keeps React's ownership model intact: no subscription, no
 * tearing, no selector re-render traps.
 *
 * READ vs SWITCH: `viewingId` is the session whose transcript is on screen for
 * READING. It is deliberately separate from the live session (the one the Pi is
 * running), because reading must never switch.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { WireSessionEvent, WireSessionInfo } from "@/lib/remote-pi/protocol";
import { sortSessions } from "@/lib/remote-pi/sessions";

/**
 * How many prefetched transcripts to keep.
 *
 * Each entry is a whole session body, so this is a memory ceiling, not a
 * performance knob: 8 covers a user skimming the visible rows of the sidebar
 * while staying small enough that a 200-session workspace cannot pin hundreds of
 * transcripts in RAM.
 */
const READ_CACHE_MAX = 8;

/** One in-flight `session_list`, correlated by (room + id). */
interface ListRequest {
  id: string;
  room: string;
}

/** One in-flight `session_read`, correlated by (room + id). */
interface ReadRequest {
  id: string;
  room: string;
  sessionId: string;
}

/** One in-flight `session_switch`, correlated by (room + id). */
interface SwitchRequest {
  id: string;
  room: string;
}

/** One in-flight `session_new`, correlated by (room + id). Answered with the
 *  generic `action_ok`/`action_error`, so only the id needs tracking. */
interface NewRequest {
  id: string;
  room: string;
}

export interface SessionState {
  /** Per-room list, exactly as the host reported it (sorted for display). */
  readonly byRoom: Record<string, readonly WireSessionInfo[]>;
  readonly busy: boolean;
  readonly notice: string | null;
  /** The session open for READING, or null. */
  readonly viewingId: string | null;
  readonly viewedEvents: readonly WireSessionEvent[] | null;
  /** True while a `session_read` is in flight (render-safe spinner flag). */
  readonly readLoading: boolean;
  /** True while a `session_switch` is in flight. Render-safe, unlike the
   *  request ref: see the `switchLoading` state comment below. */
  readonly switchLoading: boolean;
  /** "Now" for the rows' relative ages; refreshed on a timer so render stays
   *  pure rather than reading `Date.now()` during it. */
  readonly now: number;
  /** Whether the host can switch the live session. Stated with each listing;
   *  defaults true so an older host keeps its controls. */
  readonly canSwitch: boolean;
  /** Whether the host can start a new session. Same signalling. */
  readonly canNew: boolean;
}

export interface SessionActions {
  /** Records a `session_list_ok` for `room`. */
  readonly applyList: (room: string, sessions: readonly WireSessionInfo[]) => void;
  readonly setBusy: (busy: boolean) => void;
  readonly setNotice: (notice: string | null) => void;
  /** Records a `session_read_ok`: opens the viewer for READING only. */
  readonly applyRead: (sessionId: string, events: readonly WireSessionEvent[]) => void;
  /** Opens the viewer IMPLICITLY at click time for the given session, showing
   *  the loading state, so a slow or lost reply cannot look like a dead click. */
  readonly beginRead: (sessionId: string) => void;
  readonly clearViewer: () => void;
  /** Stores a prefetched transcript for `sessionId`, evicting the stalest entry. */
  readonly cacheRead: (sessionId: string, events: readonly WireSessionEvent[]) => void;
  /** Consumes a prefetched transcript (removing it), or null when not cached. */
  readonly takeRead: (sessionId: string) => readonly WireSessionEvent[] | null;
  /** True when a prefetched transcript is cached. Never consumes it. */
  readonly hasRead: (sessionId: string) => boolean;
  readonly clearReadCache: () => void;
  readonly setReadLoading: (loading: boolean) => void;
  /** Render-safe switch spinner, accompanying `switchReq`. */
  readonly setSwitchLoading: (loading: boolean) => void;
  /** Drops the transient request/viewer state of a room being left, without
   *  touching any other room's cache. */
  readonly resetRoom: () => void;
  readonly listReq: React.MutableRefObject<ListRequest | null>;
  readonly readReq: React.MutableRefObject<ReadRequest | null>;
  readonly prefetchReq: React.MutableRefObject<ReadRequest | null>;
  readonly switchReq: React.MutableRefObject<SwitchRequest | null>;
  readonly newReq: React.MutableRefObject<NewRequest | null>;
  /** Raw per-room setter, for the container's projection step. */
  /** Records the capability the host stated with its listing. */
  readonly setCaps: (caps: { canSwitch: boolean; canNew: boolean }) => void;
  readonly setByRoom: (
    update: (
      prev: Record<string, readonly WireSessionInfo[]>,
    ) => Record<string, readonly WireSessionInfo[]>,
  ) => void;
}

export interface SessionStore {
  readonly state: SessionState;
  readonly actions: SessionActions;
}

/** The rows to show for `room`, or an empty list when it has none yet. */
export function sessionsFor(
  state: SessionState,
  room: string | null,
  empty: readonly WireSessionInfo[],
): readonly WireSessionInfo[] {
  return room === null ? empty : (state.byRoom[room] ?? empty);
}

/**
 * The session open for READING, resolved from the CURRENT list.
 *
 * A row the host no longer reports closes the viewer instead of showing a stale
 * transcript, so this is a lookup (not a stored copy).
 */
export function viewingSessionFor(
  state: SessionState,
  sessions: readonly WireSessionInfo[],
): WireSessionInfo | null {
  return state.viewingId === null ? null : (sessions.find((s) => s.id === state.viewingId) ?? null);
}

export function useSessionStore(): SessionStore {
  const [byRoom, setByRoom] = useState<Record<string, readonly WireSessionInfo[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewedEvents, setViewedEvents] = useState<readonly WireSessionEvent[] | null>(null);
  const [readLoading, setReadLoading] = useState(false);
  /** True while a `session_switch` is in flight. A REF alone cannot drive the
   *  UI: mutating `switchReq.current` does not re-render, so the Resume button
   *  stayed visually idle until some unrelated state change happened to repaint
   *  it -- which is exactly the reported "no reaction, then seconds later it
   *  starts counting". */
  const [switchLoading, setSwitchLoading] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [canSwitch, setCanSwitch] = useState(true);
  const [canNew, setCanNew] = useState(true);

  const listReq = useRef<ListRequest | null>(null);
  const readReq = useRef<ReadRequest | null>(null);
  /*
   * The single outstanding PREFETCH, if any.
   *
   * Kept apart from `readReq` on purpose: a prefetch must never be mistaken for
   * the click-driven read, and capping it at one is what stops a pointer swept
   * down the session list from launching a request per row.
   */
  const prefetchReq = useRef<ReadRequest | null>(null);
  const switchReq = useRef<SwitchRequest | null>(null);
  const newReq = useRef<NewRequest | null>(null);

  // Relative ages ("2d ago") must not be computed during render: that reads the
  // clock, which makes the component impure. A one-minute tick is enough for
  // every unit the rows display.
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);

  const applyList = useCallback((room: string, sessions: readonly WireSessionInfo[]) => {
    setByRoom((prev) => ({ ...prev, [room]: sortSessions(sessions) }));
    setBusy(false);
    setNotice(null);
  }, []);

  const applyRead = useCallback((sessionId: string, events: readonly WireSessionEvent[]) => {
    // READ-ONLY: this populates the viewer and never touches the live chat, so
    // the running session and its transcript are both left alone.
    setViewingId(sessionId);
    setViewedEvents(events);
    setReadLoading(false);
    setNotice(null);
  }, []);

  /*
   * Open the viewer the moment the user clicks, before the host answers.
   *
   * The viewer used to mount only from `applyRead`, i.e. after
   * `session_read_ok` arrived. If that reply was slow -- and it can be seconds
   * when the host is respawning, or forever if the room dropped -- the click
   * changed absolutely nothing on screen: no spinner, no banner, no selection
   * change. That is indistinguishable from a dead button, which is precisely
   * how it was reported. Mounting immediately with empty events and the loading
   * flag makes the click visibly land, and the reply then fills it in.
   */
  const beginRead = useCallback((sessionId: string) => {
    setViewingId(sessionId);
    setViewedEvents(null);
    setReadLoading(true);
    setNotice(null);
  }, []);

  const clearViewer = useCallback(() => {
    setViewingId(null);
    setViewedEvents(null);
    setReadLoading(false);
    setSwitchLoading(false);
  }, []);

  /*
   * Prefetched transcripts, keyed by session id.
   *
   * Pointing at a row used to be free but useless: the `session_read` only went
   * out on click, so the viewer mounted empty and the user read a spinner for a
   * full round trip. Prefetching on hover/focus moves that round trip behind the
   * pointer, so clicking usually has content ready.
   *
   * A ref (not state) because nothing renders from it: it is consumed
   * imperatively at click time and must never trigger a re-render of 11 rows.
   * Bounded because this holds whole transcripts: without a cap, browsing a
   * long workspace would accumulate every session body in memory.
   */
  const prefetchCache = useRef<Map<string, readonly WireSessionEvent[]>>(new Map());

  const cacheRead = useCallback((sessionId: string, events: readonly WireSessionEvent[]) => {
    const cache = prefetchCache.current;
    // Re-insert to keep Map order as recency, so eviction drops the stalest.
    cache.delete(sessionId);
    cache.set(sessionId, events);
    while (cache.size > READ_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }, []);

  /** Returns the cached transcript and REMOVES it: a viewer consumes it once. */
  const takeRead = useCallback((sessionId: string): readonly WireSessionEvent[] | null => {
    const cache = prefetchCache.current;
    const hit = cache.get(sessionId);
    if (hit === undefined) return null;
    cache.delete(sessionId);
    return hit;
  }, []);

  const clearReadCache = useCallback(() => {
    prefetchCache.current.clear();
  }, []);

  const hasRead = useCallback(
    (sessionId: string): boolean => prefetchCache.current.has(sessionId),
    [],
  );

  /** Host-stated capability from `session_list_ok`. */
  const setCaps = useCallback((caps: { canSwitch: boolean; canNew: boolean }) => {
    setCanSwitch(caps.canSwitch);
    setCanNew(caps.canNew);
  }, []);

  const resetRoom = useCallback(() => {
    listReq.current = null;
    readReq.current = null;
    switchReq.current = null;
    newReq.current = null;
    setBusy(false);
    setNotice(null);
    setViewingId(null);
    setViewedEvents(null);
    setReadLoading(false);
    setSwitchLoading(false);
  }, []);

  return {
    state: { byRoom, busy, notice, viewingId, viewedEvents, readLoading, switchLoading, now, canSwitch, canNew },
    actions: {
      applyList,
      setBusy,
      setNotice,
      applyRead,
      beginRead,
      clearViewer,
      cacheRead,
      takeRead,
      hasRead,
      clearReadCache,
      setReadLoading,
      setSwitchLoading,
      resetRoom,
      listReq,
      readReq,
      prefetchReq,
      switchReq,
      newReq,
      setCaps,
      setByRoom,
    },
  };
}
