"use client";

/**
 * Client boundary of the gated Remote Pi web client route — Wave 2 #7 wiring.
 *
 * The connection LIFECYCLE lives in `@/lib/remote-pi/adapter` (Wave 2): ONE
 * adapter per mount, and the adapter is the single owner of the credential. It
 * owns the socket, the pairing flow, the retry budget and persistence; this
 * file is only the container — it subscribes to the snapshot, forwards host
 * messages, and renders the shell from what the snapshot says. There is no
 * localStorage read here, no token, no private key, no stored-session schema.
 *
 * Truthfulness rules kept from the wave 1 split:
 *   • the phase decides the view — ONLY `connected` shows the app window; the
 *     launcher, `reconnecting`, `reauth_required` and `error` are reported as
 *     what they are (busy label + fixed diagnostic text), never as "connected";
 *   • every error string rendered is a FIXED client-authored string. Raw
 *     exceptions are never interpolated (`String(err)` would leak wire text);
 *   • unpair/forget is a two-click action and the ONLY path that deletes the
 *     stored pairing (`adapter.close()`), and it never runs on unmount —
 *     `dispose()` preserves the stored pairing for the next mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import type { SkillOption } from "@/components/remote-pi/chat";

import { RemotePiAdapter, type AdapterSnapshot } from "@/lib/remote-pi/adapter";
import {
  bootstrapPairUri,
  fetchBootstrapCredentials,
} from "@/lib/remote-pi/bootstrap-client";
import { ActionRejectedError, WorkspaceRestartRejectedError, isWireImage, parsePairUri, type WireModel, type WireSessionEvent, type WireSessionInfo, type WireSkill, type PairTarget, type ServerMessage, type WorkspaceEntry } from "@/lib/remote-pi/protocol";
import {
  RemotePiShell,
  type RemotePiShellProps,
} from "@/components/remote-pi/layout";
import type {
  ModelOption,
  ThinkingLevelId,
} from "@/components/remote-pi/chat";
import type { TranscriptChatItem, TranscriptTurnStats } from "@/components/remote-pi/chat";
import type { ConnectionPhase } from "@/lib/remote-pi/state";
import { canSubmit, visibleChatItems } from "@/lib/remote-pi/chat";
import {
  formatCacheHitPercent,
  formatClock,
  formatTokens,
} from "@/lib/remote-pi/usage-stats";

import { ATTACH_MODEL_REQUIRED, ATTACH_VISION_REQUIRED, CHAT_TIMEOUT_MS, DEVICE_NAME, EMPTY_SESSIONS, EMPTY_SKILLS, FS_FAILED, FS_NAV_UNAVAILABLE, MODELS_FAILED, MODELS_FOR_LIVE_WORKSPACE, MODEL_NOT_CONNECTED, MODEL_SET_FAILED, RESTART_FAILED, REAUTH_REQUIRED, RELAY_REQUIRED, SEND_FAILED, SKILLS_FAILED, SKILL_FAILED, SESSIONS_FAILED, SESSIONS_FOR_LIVE_WORKSPACE, SESSIONS_LIST_TIMEOUT_MS, HOST_STALE_MS, SESSIONS_RELIST_ATTEMPTS, SESSIONS_RELIST_MS, SESSIONS_RETRY_BUDGET, SWITCH_RESPAWN_GRACE_MS, SWITCH_TIMEOUT_MS, SESSION_NEW_FAILED, SESSION_READ_FAILED, START_FAILED, STORAGE_WARNING, SWITCH_FAILED, THINKING_SET_FAILED, WORKSPACES_FAILED, ADD_FAILED, chatItemStatus, chatNoticeForTurn, isSuperseded, pairFailureText, phaseBusyLabel, relayNotice } from "./notices";
import { useAttachmentStore } from "./use-attachment-store";
import { useChatStore } from "./use-chat-store";
import { useConnectionStore } from "./use-connection-store";
import { useFsStore } from "./use-fs-store";
import { useModelStore } from "./use-model-store";
import { useSessionStore } from "./use-session-store";
import { useSkillStore } from "./use-skill-store";
import { useWorkspaceStore } from "./use-workspace-store";
import { dispatchServerMessage, type DispatcherPorts } from "./dispatcher";
import { fileToWireImage } from "./attachment";

/**
 * Project one wire model onto a picker row.
 *
 * One function for both call paths (fresh `models_list` and cache hit): they used to
 * build the row twice, so a field added to one was silently missing from the other.
 * `thinking_levels` is copied as-is — absent stays absent, which is what tells the
 * picker this model has no thinking surface.
 *
 * @param m - the wire model.
 * @param current - the host's current model, used to mark the active row.
 * @returns the picker row.
 */
function projectModelRow(
  m: WireModel,
  current: WireModel | undefined,
): ModelOption {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    reasoning: m.reasoning,
    vision: m.vision,
    contextWindow: m.context_window,
    current: current !== undefined && m.id === current.id && m.provider === current.provider,
    ...(m.thinking_levels === undefined ? {} : { thinkingLevels: [...m.thinking_levels] }),
  };
}

export function ConnectClient() {
  /* ── stores: one hook per business domain ────────────────────────────────
     Each domain owns its state AND the in-flight correlation refs for the
     actions it issues. The container below only wires them together; it holds
     no  of its own except the binding refs that must exist exactly
     once per mount. */
  const conn = useConnectionStore();
  const chatStore = useChatStore();
  const workspace = useWorkspaceStore();
  const fsStore = useFsStore();
  const modelStore = useModelStore(conn.state.activeRoom);
  const skillStore = useSkillStore();
  const sessionStore = useSessionStore();
  const attach = useAttachmentStore();

  /* ── destructured views: keeps every downstream handler readable ───────── */
  const { snapshot, address, code, actionBusy, localError, unpairArmed, activeRoom } = conn.state;
  const setSnapshot = conn.actions.setSnapshot;
  const setAddress = conn.actions.setAddress;
  const setCode = conn.actions.setCode;
  const setActionBusy = conn.actions.setActionBusy;
  const setLocalError = conn.actions.setLocalError;
  const setUnpairArmed = conn.actions.setUnpairArmed;
  const setActiveRoom = conn.actions.setActiveRoom;
  const pairSeqRef = conn.actions.pairSeq;

  const { chatState, draft } = chatStore.state;
  const setDraft = chatStore.actions.setDraft;
  const setDraftKey = chatStore.actions.setDraftKey;
  const dispatchChat = chatStore.actions.dispatchChat;

  
  const chatStateRef = chatStore.actions.chatStateRef;

  const { query, error: workspacesError, busy: workspacesBusy } = workspace.state;
  const setQuery = workspace.actions.setQuery;
  const setWorkspacesError = workspace.actions.setError;
  const setWorkspacesBusy = workspace.actions.setBusy;
  const workspaceSeqRef = workspace.actions.seq;

  const { path: fsPath, entries: fsEntries, parent: fsParent, loading: fsLoading, error: fsError, loaded: fsLoaded, showHidden } = fsStore.state;
  const setFsPath = fsStore.actions.setPath;
  const setFsParent = fsStore.actions.setParent;
  const setFsLoading = fsStore.actions.setLoading;
  const setFsError = fsStore.actions.setError;
  const setShowHidden = fsStore.actions.setShowHidden;
  const setFsEntries = fsStore.actions.setEntries;
  const setFsLoaded = fsStore.actions.setLoaded;
  const fsListSeqRef = fsStore.actions.seq;

  const modelBusy = modelStore.state.busy;
  const modelSwitchTo = modelStore.state.switchTo;
  const modelNotice = modelStore.state.notice;
  const setModelBusy = modelStore.actions.setBusy;
  const setModelSwitchTo = modelStore.actions.setSwitchTo;
  const setModelNotice = modelStore.actions.setNotice;
  const modelOptions = modelStore.state.options;
  const thinking = modelStore.state.thinking;
  const confirmedModel = modelStore.state.confirmed;
  
  const modelReqRef = modelStore.actions.listReq;
  const modelSetRef = modelStore.actions.setReq;
  const thinkingReqRef = modelStore.actions.thinkingReq;
  const modelPrefetchQueueRef = modelStore.actions.prefetchQueue;
  const pendingModelChoiceRef = modelStore.actions.pendingChoice;
  const setModelOptionsByRoom = modelStore.actions.setOptionsByRoom;
  const setThinkingByRoom = modelStore.actions.setThinkingByRoom;
  const setConfirmedByRoom = modelStore.actions.setConfirmedByRoom;

  const skillsByRoom = skillStore.state.byRoom;
  const skillsBusy = skillStore.state.busy;
  const skillsNotice = skillStore.state.notice;
  const setSkillsBusy = skillStore.actions.setBusy;
  const setSkillsNotice = skillStore.actions.setNotice;
  
  const skillsReqRef = skillStore.actions.surfaceReq;
  const skillInvokeRef = skillStore.actions.invokeReq;
  const skillsFetchedRef = skillStore.actions.fetched;
  const setSkillsByRoom = skillStore.actions.setByRoom;

  const sessionsByRoom = sessionStore.state.byRoom;
  const sessionsBusy = sessionStore.state.busy;
  const sessionsNotice = sessionStore.state.notice;
  /** Host-stated capability: false when it has no command context to switch
   *  with (an RPC-mode daemon never captures one). */
  const sessionCanSwitch = sessionStore.state.canSwitch;
  /** Same capability contract for `session_new`. */
  const sessionCanNew = sessionStore.state.canNew;
  const viewingId = sessionStore.state.viewingId;
  const viewedEvents = sessionStore.state.viewedEvents;
  const sessionReadLoading = sessionStore.state.readLoading;
  const sessionClockRef = sessionStore.state.now;
  const setSessionsBusy = sessionStore.actions.setBusy;
  const setSessionsNotice = sessionStore.actions.setNotice;
  const applyRead = sessionStore.actions.applyRead;
  const beginRead = sessionStore.actions.beginRead;
  const clearViewer = sessionStore.actions.clearViewer;
  const cacheRead = sessionStore.actions.cacheRead;
  const takeRead = sessionStore.actions.takeRead;
  const hasRead = sessionStore.actions.hasRead;
  /** Opens the viewer for READING. Written as ONE store call: two separate
   *  setters that read each other's state would overwrite one another, because
   *  the second call closes over the pre-update value. */
  const openViewer = useCallback(
    (sessionId: string, events: readonly WireSessionEvent[]) => {
      applyRead(sessionId, events);
    },
    [applyRead],
  );
  const setViewingId = (id: string | null) => {
    if (id === null) clearViewer();
  };
  const setViewedEvents = (_events: readonly WireSessionEvent[] | null) => {
    /* intentionally only clears: opening is `openViewer` above */
    if (_events === null) clearViewer();
  };
  const setSessionReadLoading = sessionStore.actions.setReadLoading;
  const setSwitchLoading = sessionStore.actions.setSwitchLoading;
  const switchLoading = sessionStore.state.switchLoading;
  /*
   * True while a resume's history is still being re-read from disk.
   *
   * Distinct from `switchLoading` on purpose: that flag clears when the switch is
   * ACKNOWLEDGED, which is before the Pi has actually restarted. This one stays
   * set until the transcript is genuinely hydrated, so the panel can say
   * "Reopening this session…" for the whole window instead of showing an empty
   * state that claims the session has no history.
   */
  const [resumingSession, setResumingSession] = useState(false);
  const sessionsReqRef = sessionStore.actions.listReq;
  /*
   * Retry budget for a timed-out `session_list`, and a stable handle to the
   * requester so the timeout callback does not capture a stale closure.
   *
   * `requestSessions` is defined below and referenced by the timer, so it is kept
   * behind a ref that is assigned right after its definition.
   */
  const sessionsRetryLeftRef = useRef(SESSIONS_RETRY_BUDGET);
  const requestSessionsRef = useRef<(adapterOverride?: RemotePiAdapter, isRetry?: boolean) => void>(() => {});
  const sessionReadReqRef = sessionStore.actions.readReq;
  const prefetchReqRef = sessionStore.actions.prefetchReq;
  const sessionSwitchReqRef = sessionStore.actions.switchReq;
  const sessionNewReqRef = sessionStore.actions.newReq;
  const setSessionsByRoom = sessionStore.actions.setByRoom;

  const attachment = attach.state.attachment;
  const attachmentError = attach.state.error;
  const setAttachment = attach.actions.setAttachment;
  const setAttachmentError = attach.actions.setError;

  const bindingRef = useRef<{ adapter: RemotePiAdapter; unsubs: (() => void)[] } | null>(null) as MutableRefObject<{ adapter: RemotePiAdapter; unsubs: (() => void)[] } | null>;
  /** Room the transcript is showing, readable from the message listener
   *  without re-subscribing on every room switch. */
  const activeRoomRef = useRef<string | null>(null) as MutableRefObject<string | null>;
  /** Latest sessions-per-room, readable from a timer without re-creating it.
   *  Used only to detect that a re-list actually LANDED (identity changes when
   *  the store applies a new listing). */
  const byRoomRef = useRef<Record<string, readonly unknown[]>>({}) as MutableRefObject<Record<string, readonly unknown[]>>;
  // Mirrored for the re-list timer, which must see the CURRENT store value
  // without being re-created on every listing.
  byRoomRef.current = sessionStore.state.byRoom;
  /** Same mirror, for the post-resume re-read: it must observe the viewer's
   *  CURRENT content to know when the history has actually arrived. */
  const viewerRef = useRef<{ viewingId: string | null; viewedEvents: readonly unknown[] | null }>({
    viewingId: null,
    viewedEvents: null,
  });
  viewerRef.current = {
    viewingId: sessionStore.state.viewingId,
    viewedEvents: sessionStore.state.viewedEvents,
  };
  /** Pending turn timer, bounded to the EXACT turn it was scheduled for:
   *  room + turn id + binding generation + adapter identity. A late firing for
   *  any other room/turn/generation/binding is ignored, and any room switch,
   *  reset or unmount clears it. */
  const chatTimerRef = chatStore.actions.timerRef;
  /** Last published snapshot: phase/generation edges are detected here so a
   *  dropped connection invalidates every in-flight async owner. */
  const lastSnapshotRef = useRef<AdapterSnapshot | null>(null) as MutableRefObject<AdapterSnapshot | null>;

  /* Frame + timer primitives come from the chat store; these aliases keep the
     call sites below unchanged. */
  const cancelChatFrame = chatStore.actions.cancelFrame;
  const clearChatTimer = chatStore.actions.clearTimer;

  /** Arms the pending-turn timeout for one EXACT turn (adapter + generation +
   *  room + id). On firing it re-checks every part of that binding before it
   *  may settle anything: a turn that already moved on is left alone. */
  const scheduleChatTimeout = useCallback(
    (adapter: RemotePiAdapter, roomId: string, id: string): void => {
      clearChatTimer();
      const generation = adapter.getSnapshot().generation;
      const handle = setTimeout(() => {
        const pending = chatTimerRef.current;
        if (pending === null || pending.handle !== handle) return;
        chatTimerRef.current = null;
        if (bindingRef.current?.adapter !== adapter) return;
        if (adapter.getSnapshot().generation !== generation) return;
        if (activeRoomRef.current !== roomId) return;
        const active = chatStateRef.current.active;
        if (active === null || active.id !== id || active.roomId !== roomId) return;
        dispatchChat({ type: "timeout", roomId, id });
      }, CHAT_TIMEOUT_MS);
      chatTimerRef.current = { handle, roomId, id, generation, adapter };
    },
    [clearChatTimer, dispatchChat],
  );

  /** A session transcript read is cheap, so the first page is a generous size. */
  const SESSION_READ_LIMIT = 50;

  /** `session_list` for the room on screen. Declared before the message
   *  listener that the `session_switch_ok` path re-lists through. */
  /** `session_list` for the room on screen. Declared before the message
   *  listener that the `session_switch_ok` path re-lists through.
   *
   *  `adapterOverride` exists for the one caller that runs DURING binding: the
   *  catalog-arrival snapshot that auto-selects a workspace can fire while the
   *  binding is still being assembled. Passing the adapter explicitly removes
   *  that ordering hazard instead of silently dropping the request. */
  const requestSessions = useCallback((adapterOverride?: RemotePiAdapter, isRetry?: boolean) => {
    /*
     * Only a real adapter may be honoured here.
     *
     * `adapterOverride` exists for the one caller that runs DURING binding. It is
     * optional, so any DOM handler wired as `onClick={requestSessions}` would
     * pass a MouseEvent into it and this would then call `getSnapshot()` on an
     * event — a TypeError thrown before anything visible happens. Rejecting
     * non-adapters keeps such a wiring mistake from silently killing the panel.
     */
    const override = adapterOverride && typeof adapterOverride.getSnapshot === "function"
      ? adapterOverride
      : undefined;
    const adapter = override ?? bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null || adapter.getSnapshot().phase !== "connected") {
      return false;
    }
    if (sessionsReqRef.current !== null) return false;
    /*
     * A retry consumes the existing budget; only a FRESH request refills it.
     *
     * `SESSIONS_RETRY_BUDGET` exists to carry ONE logical attempt across the
     * host's respawn window. Refilling on every call made the budget unspendable:
     * each retry reset it, so the loop never surfaced a failure and the panel sat
     * on "Asking…" forever with nothing on screen.
     *
     * `isRetry` is how the timeout path distinguishes itself from a click.
     */
    if (isRetry !== true) sessionsRetryLeftRef.current = SESSIONS_RETRY_BUDGET;
    try {
      const id = adapter.listSessions(roomId);
      sessionsReqRef.current = { id, room: roomId };
      setSessionsBusy(true);
      setSessionsNotice(null);
      /*
       * A lost reply must not freeze the panel forever.
       *
       * `sessionsReqRef` is what stops this from firing twice, so leaving it set
       * when no reply arrives makes the whole Sessions panel inert: every later
       * request — the Refresh control included — returns at the guard above and
       * nothing visibly happens. That is the exact "clicking does nothing"
       * failure the READ path already fixed by clearing its ref on a timer; the
       * LIST path never got the same treatment.
       *
       * It matters most right after a `session_switch`: the host respawns its Pi
       * to reopen the target session (see the daemon `--session` path), so the
       * re-list fired on ACK races a host that is going down, and its reply is
       * simply never produced.
       *
       * Only clear the ref if it still holds THIS request, so a reply that did
       * arrive (and already nulled it) is never clobbered by a late timer.
       */
      const timeout = setTimeout(() => {
        const pending = sessionsReqRef.current;
        if (pending === null || pending.id !== id) return;
        sessionsReqRef.current = null;
        setSessionsBusy(false);
        /*
         * Retry before giving up.
         *
         * `session_list` has a real, known failure window that has nothing to do
         * with the user: a `session_switch` respawns the workspace Pi, and for
         * the ~15s it takes to start the host answers nothing at all. The old
         * behaviour was to surface `Could not load this workspace's sessions.`
         * on the FIRST timeout and then stop — so the panel sat on that sentence
         * until the user manually pressed refresh, possibly several times, even
         * though the host was about to be perfectly healthy.
         *
         * The retry budget is deliberately bounded and the notice stays off while
         * retries remain, so the panel keeps saying "Asking…" (the truthful
         * state) instead of claiming a failure that is about to stop being true.
         */
        if (sessionsRetryLeftRef.current > 0) {
          sessionsRetryLeftRef.current -= 1;
          setTimeout(() => {
            if (sessionsReqRef.current !== null) return;
            requestSessionsRef.current(undefined, true);
          }, SESSIONS_RELIST_MS);
          return;
        }
        setSessionsNotice(SESSIONS_FAILED);
      }, SESSIONS_LIST_TIMEOUT_MS);
      void timeout;
      return true;
    } catch {
      setSessionsNotice(SESSIONS_FAILED);
      setSessionsBusy(false);
      return false;
    }
  }, []);
  /*
   * Keep the retry timer pointed at the CURRENT requester.
   *
   * The timeout callback is created inside `requestSessions`, which is a
   * `useCallback`; reading it directly there would capture whichever closure
   * existed when the callback was built. A ref assignment after definition keeps
   * the timer using the live function without adding it to the dependency list
   * (which would rebuild the callback on every render).
   */
  requestSessionsRef.current = requestSessions;

  /** `session_read` — READ one session's transcript. Never switches. */
  const handleSessionRead = useCallback((sessionId: string) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    /*
     * Consume a prefetched transcript when one is waiting.
     *
     * This is the whole point of prefetching: the round trip already happened
     * while the pointer was over the row, so the click can render immediately
     * instead of showing a spinner. Without this branch the prefetch would only
     * warm an unused cache.
     */
    const cached = takeRead(sessionId);
    if (cached !== null) {
      openViewer(sessionId, cached);
      return;
    }
    /*
     * Mount the viewer BEFORE the request goes out.
     *
     * `setSessionReadLoading(true)` alone was invisible: the viewer only mounts
     * from `applyRead`, which runs when the reply arrives, so during the wait
     * there was nothing on screen consuming the loading flag. Clicking a session
     * therefore produced no visible change at all until the host answered --
     * seconds of nothing, or forever if the room had dropped.
     */
    beginRead(sessionId);
    try {
      const id = adapter.readSession(roomId, sessionId, { limit: SESSION_READ_LIMIT });
      sessionReadReqRef.current = { id, room: roomId, sessionId };
      setSessionReadLoading(true);
      setSessionsNotice(null);

      /*
       * Give up on a reply that never arrives.
       *
       * Chat has had this (`scheduleChatTimeout`) from the start; session reads
       * did not, and the difference is visible: the relay drops a frame, the host
       * replies into a room nobody is subscribed to, and `sessionReadReqRef` is
       * left holding a request that will never settle. From then on the viewer
       * ignores every later read — it compares each new `in_reply_to` against the
       * stale id and returns — so the panel freezes on whichever session was open
       * and clicking other sessions looks like it does nothing at all. That is
       * exactly the intermittent `ui=<previous id>` the E2E kept reporting.
       *
       * The guard mirrors the chat timer: only clear the ref if it still holds
       * THIS request, so a reply that did arrive (and already nulled it) is never
       * overwritten by a late timeout.
       */
      const readTimeout = setTimeout(() => {
        const pending = sessionReadReqRef.current;
        if (pending === null || pending.id !== id) return;
        sessionReadReqRef.current = null;
        setSessionReadLoading(false);
        setSessionsNotice(SESSION_READ_FAILED);
      }, CHAT_TIMEOUT_MS);
      // The handle is intentionally not stored: unlike the chat timer there is no
      // "supersede the previous turn" case here. The ref comparison above is the
      // only guard needed, and it makes a stale timer a no-op on its own.
      void readTimeout;
    } catch {
      setSessionsNotice(SESSION_READ_FAILED);
    }
  }, [openViewer, takeRead]);

  /**
   * Prefetch a transcript without opening the viewer.
   *
   * Deliberately separate from `handleSessionRead`: pointing at a row must not
   * mount the read-only viewer or steal the composer, or the panel would flip
   * under the pointer. Only the reply is wanted, and it is stored for the later
   * click.
   *
   * Guarded three ways, because hover fires far more often than clicks:
   *  - the caller debounces, and this refuses while a prefetch is already in
   *    flight for the same session or when the transcript is already cached;
   *  - only ONE prefetch is outstanding at a time, so sweeping the pointer down
   *    11 rows cannot launch 11 requests;
   *  - a cached session is never re-fetched.
   */
  const handleSessionPrefetch = useCallback(
    (sessionId: string) => {
      const adapter = bindingRef.current?.adapter ?? null;
      const roomId = activeRoomRef.current;
      if (adapter === null || roomId === null) return;
      if (hasRead(sessionId)) return;
      if (prefetchReqRef.current !== null) return;
      try {
        const id = adapter.readSession(roomId, sessionId, { limit: SESSION_READ_LIMIT });
        prefetchReqRef.current = { id, room: roomId, sessionId };
      } catch {
        /* A failed prefetch is silently ignored: it is an optimisation, and the
           click path still performs the real read. */
      }
    },
    [hasRead],
  );

  /**
   * Re-list after a switch, RETRYING.
   *
   * The host answers `session_switch_ok` and then respawns its Pi pointed at the
   * target session (daemon `--session` path), so for a second or two there is no
   * host room to serve `session_list`. A single re-list fired on ACK therefore
   * lands in that gap and its reply never exists — which makes a switch that
   * genuinely happened look like a dead button, because the LIVE badge keeps
   * pointing at the old session.
   *
   * So: keep asking until a request is actually in flight. `requestSessions`
   * guards both the in-flight case and the disconnected case, so retries cost
   * nothing while the host is down, and its own timeout releases the ref if a
   * reply is lost — otherwise this loop would spin against a stuck guard.
   */
  const relistAfterSwitch = useCallback(() => {
    const roomId = activeRoomRef.current;
    if (roomId === null) return;
    /*
     * STOP CONDITION: the list for this room actually CHANGED.
     *
     * Stopping as soon as a request was merely SENT is not enough: the first
     * attempt lands while the host is respawning its Pi to reopen the target, so
     * the request goes out and no reply is ever produced. Retrying until the
     * listing itself changes is what makes the new LIVE badge appear.
     *
     * The first attempt is DELAYED on purpose. It used to fire immediately on
     * `session_switch_ok`, which is the exact moment the host starts exiting — so
     * that request was guaranteed to be lost, and it then held `sessionsReqRef`
     * for the whole list timeout, blocking every retry behind the in-flight
     * guard. Waiting out the known exit window means the first request actually
     * reaches a process that can answer it.
     */
    const before = byRoomRef.current[roomId];
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      if (byRoomRef.current[roomId] !== before) return;  // refreshed
      if (attempts > SESSIONS_RELIST_ATTEMPTS) return;
      requestSessions();
      setTimeout(tick, SESSIONS_RELIST_MS);
    };
    setTimeout(tick, SWITCH_RESPAWN_GRACE_MS);
  }, [requestSessions]);

  /**
   * Re-sync the LIVE transcript after a resume.
   *
   * `session_switch_ok` means the host reopened the target, but the new process
   * has an EMPTY in-memory mirror: it replays the session file on its own
   * schedule, and the client only learns the result from a `session_history`
   * frame. The host never pushes that unprompted — it answers `session_sync` —
   * so without this call the transcript stays blank and the user has no history
   * to continue from.
   *
   * It retries because the ACK arrives BEFORE the respawn finishes: for a second
   * or two nothing serves the request. Each retry first checks whether turns
   * have already arrived, so a successful sync stops the loop immediately.
   */
  const resyncLive = useCallback(() => {
    let attempts = 0;
    /*
     * Mark the reopening window explicitly.
     *
     * `switchLoading` is cleared the moment `session_switch_ok` lands, but the
     * respawn has only just STARTED at that point and the transcript stays empty
     * for ~14s more. Binding the empty state to `switchLoading` therefore covered
     * almost none of that window, and the panel showed the generic "What should
     * the agent work on?" — which reads as "this session has no history" right
     * after the user asked to see it.
     */
    setResumingSession(true);
    const tick = () => {
      attempts += 1;
      if (attempts > SESSIONS_RELIST_ATTEMPTS) {
        setResumingSession(false);
        return;
      }
      const adapter = bindingRef.current?.adapter ?? null;
      const roomId = activeRoomRef.current;
      if (adapter === null || roomId === null) {
        setResumingSession(false);
        return;
      }
      if (chatStateRef.current.history.length > 0) {
        setResumingSession(false);
        return;  // already hydrated
      }
      try {
        adapter.syncSession(roomId);
      } catch {
        /* Room is mid-respawn; retry below. */
      }
      setTimeout(tick, SESSIONS_RELIST_MS);
    };
    setTimeout(tick, SESSIONS_RELIST_MS * 2);
  }, []);

  /** `session_switch` — the ONLY control that changes the live session. */
  const handleSessionSwitch = useCallback((sessionId: string) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    /*
     * Set the render-safe flag FIRST, before the request goes out.
     *
     * `switchBusy` used to read `sessionSwitchReqRef.current !== null` directly.
     * A ref mutation does not re-render, so the button produced no visible
     * change on click; it only picked up the busy state when some unrelated
     * state change happened to repaint, which is why the elapsed counter
     * appeared seconds later instead of immediately.
     */
    setSwitchLoading(true);
    /*
     * Invalidate any read-only transcript request still in flight.
     *
     * Clicking a row issues `session_read`, and the user can press Resume here
     * before its reply lands. That late reply would then call `openViewer` and
     * silently re-open the read-only pane AFTER the resume has already closed
     * it — putting the viewer back over the composer. The session is live now,
     * so the pending read is stale by definition: dropping the reference makes
     * its reply fail the correlation check and get ignored.
     */
    sessionReadReqRef.current = null;
    setSessionReadLoading(false);
    try {
      const id = adapter.switchSession(roomId, sessionId);
      sessionSwitchReqRef.current = { id, room: roomId };
      setSessionsNotice(null);
      /*
       * A switch that never settles must not hang forever.
       *
       * Only the `_ok` / `_error` frames cleared the request ref, so a lost reply
       * (the host exits for its respawn before answering, or the room drops in
       * that gap) left the button reading "Resuming…" indefinitely. The read
       * PATH has had this guard from the start; switching did not.
       *
       * The ref-identity check makes a late timeout a no-op when the reply did
       * arrive, exactly like the chat and read timers.
       */
      setTimeout(() => {
        const pending = sessionSwitchReqRef.current;
        if (pending === null || pending.id !== id) return;
        sessionSwitchReqRef.current = null;
        setSwitchLoading(false);
        setSessionsNotice(SWITCH_FAILED);
        /*
         * Hand the pane back to the live transcript even on failure.
         *
         * `clearViewer()` used to run only on `session_switch_ok`, so a switch
         * that never answered left the read-only viewer mounted forever — the
         * composer stayed OUT OF THE DOM and the only way out was a reload. A
         * failed resume must leave the user with a usable composer.
         */
        clearViewer();
      }, SWITCH_TIMEOUT_MS);
    } catch {
      setSwitchLoading(false);
      setSessionsNotice(SWITCH_FAILED);
    }
  }, [setSwitchLoading, setSessionsNotice]);

  /**
   * `session_new` — start a fresh AgentSession in a workspace.
   *
   * Success carries no payload: the host fans out an empty `session_history`
   * and the transcript clears on its own. All this does is mark the surface
   * busy and hold the request id so the reply can be claimed.
   *
   * A room id is REQUIRED by the wire (`session_new` carries a cwd), but the
   * caller does not have to have opened that room yet: DSH offers "New session"
   * in the sidebar before any transcript is on screen, and gating it on an
   * already-active room meant the row never rendered. When nothing is open the
   * first listed workspace is used, and opening it is left to the host's
   * `session_history` fan-out.
   */
  const handleSessionNew = useCallback(
    (roomId: string) => {
      const adapter = bindingRef.current?.adapter ?? null;
      if (adapter === null || roomId === "") return;
      try {
        const id = adapter.newSession(roomId);
        sessionNewReqRef.current = { id, room: roomId };
        setSessionsBusy(true);
        setSessionsNotice(null);
      } catch {
        setSessionsNotice(SESSION_NEW_FAILED);
      }
    },
    [sessionNewReqRef, setSessionsBusy, setSessionsNotice],
  );

  /** Opening a room starts a NEW transcript: reducer reset (active + history)
   *  and no pending timer from the previous room. */
  const openRoom = useCallback(
    (roomId: string, adapterOverride?: RemotePiAdapter) => {
      activeRoomRef.current = roomId;
      setActiveRoom(roomId);
      dispatchChat({ type: "reset" });
      // Model state is already per room (see `modelOptionsByRoom`), so nothing
      // is cleared here: each room keeps its own catalogue, confirmed pick and
      // thinking level, and the picker re-lists on open (from the cache for
      // this exact room when it is still fresh). Only the transient request
      // bookkeeping is dropped — a reply for the previous room must not be
      // applied to the room that just opened.
      setModelNotice(null);
      setModelBusy(false);
      setModelSwitchTo(null);
      // `modelReqRef` is deliberately NOT cleared here. It tracks the ONE
      // in-flight `list_models` on the wire — which may be a PREFETCH for a
      // different room, issued when the connection came up. Clearing it made
      // that prefetch reply arrive with no pending id, so it was dropped and
      // the catalogue was never cached: the picker then fell back to a fresh
      // round trip and showed "asking the host…" on every open. Per-room UI
      // state is already per room (above); the in-flight correlation is not.
      modelSetRef.current = null;
      thinkingReqRef.current = null;
      // Sessions belong to the room too: drop the transient request/derived
      // state so the previous room's list, viewer and notice never label the
      // room that just opened, then load THIS room's list. Loading here (an
      // event) rather than in a render effect keeps the render pure.
      setViewingId(null);
      setViewedEvents(null);
      setSessionReadLoading(false);
      setSessionsNotice(null);
      setSessionsBusy(false);
      sessionsReqRef.current = null;
      sessionReadReqRef.current = null;
      sessionSwitchReqRef.current = null;
      requestSessions(adapterOverride);
      /*
       * Ask for the LIVE transcript as soon as the room opens.
       *
       * The host never pushes `session_history` on its own: it answers
       * `session_sync`. Without this call the live transcript stayed EMPTY
       * forever on a fresh page load — the user saw "this workspace has no
       * turns yet" while the host's session file held a full conversation.
       * That also made `New session` look like a no-op, because there was
       * nothing on screen for it to clear.
       */
      const syncAdapter = adapterOverride ?? bindingRef.current?.adapter ?? null;
      try {
        syncAdapter?.syncSession(roomId);
      } catch {
        /* The room may still be coming up; the reconnect path re-opens it. */
      }
      // Adopt the already-prefetched catalogue for THIS room right away, so the
      // picker opens populated instead of showing "asking the host…". Read
      // straight from the adapter cache (no React state dependency, no TDZ on
      // `applyCatalogue`); a miss is fine — `requestModels` covers it on open.
      const adapter = adapterOverride ?? bindingRef.current?.adapter ?? null;
      const cached = adapter?.readCachedModels(roomId) ?? null;
      if (cached !== null) {
        const rows = cached.models.map((m) => projectModelRow(m, cached.current));
        setModelOptionsByRoom((prev) => ({ ...prev, [roomId]: rows }));
      }
    },
    [dispatchChat, requestSessions],
  );

  /** Projects a catalogue onto the picker state. Shared by the wire reply and
   *  the cache hit, so both paths mark `current` identically. */
  const applyCatalogue = useCallback(
    (roomId: string, models: readonly WireModel[], current: WireModel | undefined) => {
      const rows = models.map((m) => projectModelRow(m, current));
      setModelOptionsByRoom((prev) => ({ ...prev, [roomId]: rows }));
      // A model WITHOUT the thinking surface forces `off`; a model with it
      // keeps whatever this room already had (the host applies its own
      // fallback). Left untouched when the host reports no `current`, since
      // nothing is known about the active model then.
      if (current === undefined) return;
      if (!current.reasoning) setThinkingByRoom((prev) => ({ ...prev, [roomId]: "off" }));
    },
    [],
  );

  /** Moves the `current` marker to one row of a room's rendered catalogue.
   *  Used after `action_ok` so the label reflects the confirmed switch without
   *  a re-list. A model not in the list is left alone — the next real
   *  `models_list` is the authority, and inventing a row would fabricate one. */
  const markRowCurrent = useCallback((roomId: string, provider: string, modelId: string) => {
    setModelOptionsByRoom((prev) => {
      const rows = prev[roomId];
      if (rows === undefined) return prev;
      return {
        ...prev,
        [roomId]: rows.map((row) => ({
          ...row,
          current: row.provider === provider && row.id === modelId,
        })),
      };
    });
  }, []);

  /** Projects a `pi_surface_ok` skill list onto the menu rows. */
  const applySkills = useCallback((roomId: string, rows: readonly WireSkill[]) => {
    setSkillsByRoom((prev) => ({
      ...prev,
      [roomId]: rows.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        explicitOnly: s.disable_model_invocation,
      })),
    }));
  }, []);

  /** Drops the chat transcript COMPLETELY: reducer reset (active + history),
   *  the pending turn timer, the draft and the in-panel query. Used where no
   *  transcript may survive — a workspace that no longer exists, or a session
   *  switch (the host reset its mirror for the new session). Declared BEFORE
   *  the listeners that use it so no ref indirection is needed. */
  /** Drain ONE entry from the prefetch queue, if the wire is free.
   *
   *  The wire correlates a `models_list` reply by a SINGLE pending id, so
   *  requests are serialised: enqueue everything, then let each reply pump the
   *  next one. Entries are re-checked on the way out, because a room may have
   *  been filled by the cold path (`requestModels`) in the meantime.
   *
   *  Declared as a plain function assigned to a ref (NOT a `useCallback` whose
   *  ref is wired by a later `useEffect`): the connection's first snapshot
   *  arrives DURING mount, before any effect that would assign the ref has run.
   *  Assigning it inline is what makes the prefetch actually happen on connect
   *  instead of silently calling a no-op placeholder. */
  const runPrefetchNext = useCallback(() => {
    const adapter = bindingRef.current?.adapter ?? null;
    if (adapter === null || adapter.getSnapshot().phase !== "connected") {
      modelPrefetchQueueRef.current = [];
      return;
    }
    if (modelReqRef.current !== null) return;
    while (modelPrefetchQueueRef.current.length > 0) {
      const roomId = modelPrefetchQueueRef.current.shift()!;
      // Already remembered for this connection: never re-ask.
      if (adapter.readCachedModels(roomId) !== null) continue;
      try {
        const id = adapter.listModels(roomId);
        modelReqRef.current = { id, room: roomId, kind: "list" };
        return;
      } catch {
        // Silent by design: a prefetch must not raise UI for a picker the user
        // never opened. Keep draining so one bad room does not block the rest.
      }
    }
  }, []);

  /** Queue every live workspace for prefetch.
   *
   *  Runs when the catalog arrives (a connection coming up, or a workspace being
   *  added/started), which is exactly when the set of catalogues that CAN be
   *  read becomes known. A workspace that is not live has no Pi to answer
   *  `list_models`, so it is skipped rather than queued to fail. */
  const runPrefetchModels = useCallback((workspaces: readonly WorkspaceEntry[]) => {
    const queued = new Set(modelPrefetchQueueRef.current);
    for (const ws of workspaces) {
      if (!ws.live || queued.has(ws.room_id)) continue;
      queued.add(ws.room_id);
      modelPrefetchQueueRef.current.push(ws.room_id);
      // Make the active room's catalogue available IMMEDIATELY: it is the one
      // the user is looking at, so it must not wait behind other workspaces in
      // the queue (the picker would show "asking the host…" meanwhile).
      if (ws.room_id === activeRoomRef.current) {
        modelPrefetchQueueRef.current.unshift(modelPrefetchQueueRef.current.pop()!);
      }
    }
    runPrefetchNext();
  }, [runPrefetchNext]);

  const resetChatState = useCallback(() => {
    clearChatTimer();
    dispatchChat({ type: "reset" });
    /*
     * Deliberately does NOT clear the draft.
     *
     * This runs on every switch and new session. Clearing here is what silently
     * destroyed half-written messages: the user typed, clicked, and the text was
     * gone with no undo. The draft belongs to the session, so leaving it keyed is
     * what makes "switch away and back" recover it.
     *
     * A draft is cleared only when it is SENT (handleSend) or when the user
     * empties the field themselves.
     */
    setQuery("");
  }, [clearChatTimer, dispatchChat]);

  /** Room-filtered transcript listener. Types are checked field by field; an
   *  unexpected shape is ignored rather than coerced into the transcript. */
  /** One wire frame in, UI state out. The 292 branches live in `./dispatcher`;
     this only assembles the ports they act on, so the container stays a
     wiring layer instead of a second implementation.

     STABLE IDENTITY IS LOAD-BEARING: `ensureAdapter` lists this in its deps, and
     the mount effect lists `ensureAdapter`. A callback that changed identity on
     every render therefore tore down and rebuilt the adapter's subscriptions on
     every render — which dropped the `session_read_ok` reply between the click
     and its handler. The ports are read through a ref that is refreshed after
     each commit, so the callback itself never changes. */
  const portsRef = useRef<DispatcherPorts | null>(null) as MutableRefObject<DispatcherPorts | null>;
  portsRef.current = {
    activeRoomRef,
    modelReqRef,
    modelSetRef,
    thinkingReqRef,
    skillsReqRef,
    skillInvokeRef,
    sessionsReqRef,
    sessionReadReqRef,
    prefetchReqRef,
    sessionSwitchReqRef,
    sessionNewReqRef,
    pendingModelChoiceRef,
    setModelBusy,
    setModelNotice,
    setModelSwitchTo,
    setSkillsBusy,
    setSkillsNotice,
    setSessionsBusy,
    setSessionsNotice,
    setSessionReadLoading,
    setSwitchLoading,
    setConfirmedByRoom,
    setSessionsByRoom,
    setSessionCaps: sessionStore.actions.setCaps,
    applyCatalogue,
    applySkills,
    markRowCurrent,
    confirmCachedModel: (room2, provider, modelId) =>
      bindingRef.current?.adapter.confirmCachedModel(room2, provider, modelId),
    openViewer,
    cacheRead,
    clearViewer,
    relistAfterSwitch,
    resyncLive,
    resetChatState,
    runPrefetchNext,
    dispatchChat,
  };

  const onServerMessage = useCallback((msg: ServerMessage, room: string) => {
    const ports = portsRef.current;
    if (ports === null) return;
    dispatchServerMessage(msg, room, ports);
  }, []);

  /** Releases the current binding's subscriptions (idempotent). */
  const releaseBinding = useCallback(() => {
    const binding = bindingRef.current;
    bindingRef.current = null;
    // A new adapter starts a fresh snapshot history: the first immediate
    // snapshot of the next binding is not an "edge".
    // NOTE: this ONLY unsubscribes. An explicit unpair/forget must first
    // capture the adapter's closed snapshot while the state subscription is
    // STILL attached (see `handleUnpair`), which is the only way to read the
    // fixed storage warning `close()` reports synchronously.
    lastSnapshotRef.current = null;
    if (binding === null) return null;
    for (const off of binding.unsubs) {
      try {
        off();
      } catch {
        /* already released */
      }
    }
    return binding.adapter;
  }, []);

  /** Drops the chat transcript COMPLETELY: reducer reset (active + history),
   *  the pending turn timer, the draft and the in-panel query. Used where no
   *  transcript may survive — a workspace that no longer exists. A same-room
   *  catalog push never calls this, so the Wave4 recovery history for a room
   *  that is STILL listed keeps rendering exactly as the reducer left it. */
  /** Snapshot listener: on a phase LEAVING `connected` or a generation change
   *  every pending fs/workspace owner is fenced off and its transient UI is
   *  dropped; a same-connection push only re-checks the selected room against
   *  the catalog (child-state pushes never clear the transcript). */
  const onSnapshot = useCallback((next: AdapterSnapshot) => {
    const prev = lastSnapshotRef.current;
    lastSnapshotRef.current = next;
    setSnapshot(next);
    const dropped =
      prev !== null &&
      (prev.generation !== next.generation ||
        (prev.phase === "connected" && next.phase !== "connected"));
    if (dropped) {
      fsListSeqRef.current += 1;
      workspaceSeqRef.current += 1;
      setFsLoading(false);
      setWorkspacesBusy(false);
      setActionBusy(null);
      // A dropped connection (or a new generation) settles the in-flight turn
      // as `disconnected` for the EXACT room/id it was opened on.
      if (activeRoomRef.current !== null) {
        dispatchChat({
          type: "disconnected",
          roomId: activeRoomRef.current,
          id: chatStateRef.current.active?.id,
        });
      }
      setFsEntries([]);
      setFsParent(null);
      setFsLoaded(false);
      setFsError(null);
      setWorkspacesError(null);
      setLocalError(null);
      // Every pending request of the OLD connection is now orphaned: the socket
      // that would have answered it is gone. Leaving these refs populated is
      // what makes a reconnect look broken — the transport reports the stale
      // reply as `unknown_reply` (surfaced as "unexpected frame") and the
      // prefetch slot stays occupied so no catalogue is ever warmed again.
      modelReqRef.current = null;
      modelSetRef.current = null;
      thinkingReqRef.current = null;
      modelPrefetchQueueRef.current = [];
      setModelBusy(false);
      setModelSwitchTo(null);
      setModelNotice(null);
      sessionsReqRef.current = null;
      sessionReadReqRef.current = null;
      sessionSwitchReqRef.current = null;
      setSessionsBusy(false);
      setSessionReadLoading(false);
      setSessionsNotice(null);
      setViewedEvents(null);
      setViewingId(null);
      skillsReqRef.current = null;
      skillInvokeRef.current = null;
      setSkillsBusy(false);
      setSkillsNotice(null);
      return;
    }
    // A FRESH CONNECTION (or the first catalog of one) means nothing is
    // remembered: the adapter already dropped its catalogue cache when the
    // pairing scope changed, so prefetch every live workspace now. This is the
    // whole point of the design — the model picker never triggers a round trip
    // by itself; the catalog arriving does it once.
    if (next.phase === "connected" && next.workspaces !== null) {
      runPrefetchModels(next.workspaces);
    }
    // The catalog is authoritative: a selected room the host no longer lists
    // stops being selected (only while connected, against a real list).
    if (
      next.phase === "connected" &&
      next.workspaces !== null &&
      activeRoomRef.current !== null &&
      !next.workspaces.some((ws) => ws.room_id === activeRoomRef.current)
    ) {
      // The room is gone from the catalog: dropping ONLY the selection would
      // leave the old transcript, timer and draft pointing at a workspace that
      // no longer exists under the "no workspace" panel. Clear both.
      activeRoomRef.current = null;
      setActiveRoom(null);
      resetChatState();
    }
    // Auto-select the ONE running workspace when nothing is selected yet.
    //
    // Everything room-scoped — the session list, the model picker, the
    // transcript — is gated on `activeRoom`, and `activeRoom` used to be set
    // ONLY by an explicit Start/Restart click. A user who simply connects to a
    // host whose Pi is already running therefore saw an empty, permanently
    // "must be running" Sessions panel for a workspace the sidebar was
    // simultaneously reporting as `running`. Adopting the single live room on
    // catalog arrival removes that dead-end without guessing: with two or more
    // live workspaces the choice stays the user's.
    if (
      next.phase === "connected" &&
      next.workspaces !== null &&
      activeRoomRef.current === null
    ) {
      const live = next.workspaces.filter((ws) => ws.live);
      if (live.length === 1) openRoom(live[0]!.room_id);
    }
    // A same-connection child push (`workspace_state`) is NOT a chat edge: the
    // transcript is left exactly as the reducer left it.
  }, [dispatchChat, resetChatState, runPrefetchModels, openRoom]);

  /** Settle every in-flight request that can no longer be answered.
   *
   *  When a request times out the host never replies, so none of the
   *  `*_ok` / `action_error` handlers run and the busy flags they would have
   *  cleared stay `true` forever — the panel spins indefinitely with no way
   *  back short of a reload. A diagnostic (timeout, dropped connection) is the
   *  only signal that arrives in that case, so clearing here is what turns an
   *  endless spinner into an actionable message. */
  const settlePendingRequests = useCallback(() => {
    modelReqRef.current = null;
    modelSetRef.current = null;
    thinkingReqRef.current = null;
    modelPrefetchQueueRef.current = [];
    setModelBusy(false);
    setModelSwitchTo(null);
    sessionsReqRef.current = null;
    sessionReadReqRef.current = null;
    sessionSwitchReqRef.current = null;
    setSessionsBusy(false);
    setSessionReadLoading(false);
    skillsReqRef.current = null;
    skillInvokeRef.current = null;
    setSkillsBusy(false);
    setWorkspacesBusy(false);
    setFsLoading(false);
  }, []);

  /** ONE adapter per mount; a fresh one only after an explicit forget. */
  const ensureAdapter = useCallback((): RemotePiAdapter => {
    const current = bindingRef.current;
    if (current !== null) return current.adapter;
    /*
     * `directAuto` lets the transport follow the relay URL: a relay that is this
     * page's own origin means the direct server is serving both sides, so the SSE
     * endpoints exist and HTTP is cheaper than a socket. A remote relay keeps the
     * WebSocket automatically.
     */
    const adapter = new RemotePiAdapter({ deviceName: DEVICE_NAME, directAuto: true });
    // Bind BEFORE subscribing. `subscribe` delivers the current snapshot
    // synchronously, and that snapshot can select a workspace, which asks the
    // adapter for the room's sessions and catalogue. If `bindingRef` were still
    // null at that instant those calls found no adapter and silently returned,
    // leaving an empty transcript and a spinner that never resolved.
    bindingRef.current = { adapter, unsubs: [] };
    const unsubs = [
      adapter.subscribe(onSnapshot),
      adapter.onServerMessage(onServerMessage),
      adapter.onDiagnostic((code) => {
        // A timeout means no reply is coming: release the spinners the reply
        // would have cleared, then surface the fixed sentence.
        settlePendingRequests();
        setLocalError(relayNotice(code));
      }),
    ];
    bindingRef.current = { adapter, unsubs };
    return adapter;
  }, [onServerMessage, onSnapshot, settlePendingRequests]);

  /** Mount: subscribe, restore a stored pairing (the adapter reads storage
   *  itself), and on unmount release every subscription and dispose — the
   *  stored pairing stays on disk, and the socket is never "closed" as a
   *  side effect of navigating away. */
  useEffect(() => {
    const adapter = ensureAdapter();
    // `restore()` reports through the snapshot; an in-flight phase is what the
    // launcher renders as "restoring". No state is set synchronously here.
    void adapter.restore().then(async () => {
      /*
       * Zero-click local pairing (plan/76 A1).
       *
       * Runs only after `restore()` has settled, and only when nothing was
       * restored: a stored pairing must always win, or a user who paired against a
       * remote relay would be silently re-pointed at localhost.
       *
       * Every failure path leaves `null` and keeps the paste screen, so a dev
       * server, an older host, or a refused request all degrade to today's
       * behaviour instead of breaking the launcher.
       */
      if (bindingRef.current?.adapter !== adapter) return;
      if (adapter.getSnapshot().phase === "connected") return;
      /*
       * Capture the pairing sequence BEFORE the await.
       *
       * `pairSeqRef` is bumped by the manual paste flow (and by forget). If it moved
       * while bootstrap was in flight the user is pairing something themselves — very
       * possibly a DIFFERENT machine — and silently re-pointing them at localhost
       * would discard their attempt without a word.
       */
      const pairSeqBefore = pairSeqRef.current;
      const credentials = await fetchBootstrapCredentials();
      if (credentials === null) return;
      if (bindingRef.current?.adapter !== adapter) return;
      if (pairSeqRef.current !== pairSeqBefore) return;
      if (adapter.getSnapshot().phase !== "idle") return;
      try {
        /*
         * The relay IS this origin in direct mode, so the override is the page's
         * own origin rewritten to the ws scheme. Without it `pair` reports
         * RELAY_REQUIRED and bootstrap would look like a no-op.
         */
        const relay = location.origin.replace(/^http/, "ws");
        await adapter.pair(parsePairUri(bootstrapPairUri(credentials)), relay);
      } catch {
        /* Refused or timed out: the manual paste screen is still there. */
      }
    });
    return () => {
      // Fence every pending action reply before the binding goes away: an
      // answer that lands after unmount must not touch a dead tree.
      fsListSeqRef.current += 1;
      workspaceSeqRef.current += 1;
      pairSeqRef.current += 1;
      clearChatTimer();
      // Drop a queued stream frame too: its callback calls setChatState, which
      // must not fire into an unmounted tree. The text itself is not lost — it
      // lives in `chatStateRef` and the reset below discards it deliberately.
      cancelChatFrame();
      dispatchChat({ type: "reset" });
      const live = releaseBinding();
      live?.dispose();
    };
  }, [cancelChatFrame, clearChatTimer, dispatchChat, ensureAdapter, releaseBinding]);

  // ── derived from the adapter snapshot (never from local guesses) ─────────

  const phase: ConnectionPhase = snapshot?.phase ?? "idle";
  const connected = phase === "connected";
  /*
   * Is the host still ANSWERING?
   *
   * `connected` only reports that the socket is open. A silent stall — the page
   * says "host connected" while every request goes unanswered — was invisible
   * for exactly that reason, and the user could describe it only as "nothing
   * works and nothing says why". Sampling the age of the last inbound frame
   * turns it into something the UI can state.
   *
   * The threshold is well above the relay's ~25s keepalive so an idle-but-healthy
   * session never trips it, and well below the point where a user has already
   * concluded the app is broken.
   */
  const [hostStale, setHostStale] = useState(false);
  useEffect(() => {
    if (!connected) return;
    const tick = () => {
      const age = bindingRef.current?.adapter.lastInboundAgeMs() ?? null;
      setHostStale(age !== null && age > HOST_STALE_MS);
    };
    /*
     * The first sample is deferred by one interval instead of running inline:
     * a synchronous setState in an effect body re-renders during mount, which
     * the lint rules reject for good reason. Waiting 5s is harmless here — the
     * condition it reports takes a minute to become true.
     */
    const handle = setInterval(tick, 5_000);
    return () => clearInterval(handle);
  }, [connected]);
  /* Not-connected outranks stale: "offline" is the accurate label then, and the
   * stale flag is only meaningful while a connection claims to be up. */
  const effectiveStale = connected && hostStale;
  const host = connected ? snapshot?.host ?? null : null;
  const backend = snapshot?.backend ?? "";
  const paired = snapshot?.paired ?? null;
  /** The "Stored pairing" the launcher advertises. It comes from the adapter's
   *  storage claim — a validated load or a CONFIRMED save — never from the live
   *  pairing, so an unsaved pair plus a drop/retry cannot advertise a stored
   *  record that does not exist. `paired` above stays the live identity used
   *  for the host labels and the relay runtime. */
  const storedPairing = snapshot?.storedPairing ?? null;
  const workspaces: WorkspaceEntry[] = snapshot?.workspaces ?? [];
  /** Observed `workspace_state` pushes. PUSH-DRIVEN: read from the snapshot
   *  only, so it can never flip the phase, the view or the transcript. */
  const workspaceStates = snapshot?.workspaceStates ?? null;
  const connectionError = snapshot?.diagnostic?.message ?? snapshot?.warning?.message ?? null;

  const view: "launcher" | "host" = connected ? "host" : "launcher";
  const phaseBusy = phaseBusyLabel(phase);
  /** Something is in flight on the launcher (restore or an explicit pair). */
  const resuming = !connected && phaseBusy !== null;
  const busy = actionBusy ?? (connected ? null : phaseBusy);
  /** The fixed storage warning the adapter last reported (`close()` speaks
   *  through the SAME field), already fixed text — never a raw exception. An
   *  empty message falls back to this file's own fixed sentence. */
  const storageWarning =
    snapshot?.warning === null || snapshot?.warning === undefined
      ? null
      : snapshot.warning.message !== ""
        ? snapshot.warning.message
        : STORAGE_WARNING;

  /** Launcher prompt. `reauth_required` owns its prompt (a phase, not a
   *  per-action failure: a stale local error must not shadow the way out of
   *  the phase), but it is COMPOSED with the storage warning instead of
   *  replacing it — otherwise "the saved session was NOT deleted" would be
   *  hidden behind the re-pair prompt. Both parts are fixed sentences. */
  const error =
    phase === "reauth_required"
      ? storageWarning !== null && storageWarning !== REAUTH_REQUIRED
        ? `${REAUTH_REQUIRED} ${storageWarning}`
        : REAUTH_REQUIRED
      : localError ?? connectionError;

  const activeWorkspace = workspaces.find((ws) => ws.room_id === activeRoom) ?? null;

  /* The dock is the only consumer of `fs_nav`; it receives a boolean plus a
     FIXED reason, never the raw capability list. */
  const fsAvailable = host?.capabilities?.includes("fs_nav") === true;
  const fsAvailableReason = fsAvailable ? null : FS_NAV_UNAVAILABLE;

  const resetUi = useCallback(() => {
    activeRoomRef.current = null;
    setActiveRoom(null);
    clearChatTimer();
    dispatchChat({ type: "reset" });
    setDraft("");
    setQuery("");
    setWorkspacesError(null);
    setWorkspacesBusy(false);
    setActionBusy(null);
    setShowHidden(false);
    fsListSeqRef.current += 1;
    workspaceSeqRef.current += 1;
    pairSeqRef.current += 1;
    setFsEntries([]);
    setFsParent(null);
    setFsLoaded(false);
    setFsLoading(false);
    setFsPath("~");
    setFsError(null);
    setLocalError(null);
    setUnpairArmed(false);
  }, [clearChatTimer, dispatchChat]);

  /** Captures the binding + generation an action started on; `current()` is
   *  the post-await fence (same adapter, same generation, still connected) and
   *  must guard every success, catch and finally after an await. */
  const makeOwner = useCallback((adapter: RemotePiAdapter) => {
    const generation = adapter.getSnapshot().generation;
    return {
      adapter,
      current(): boolean {
        if (bindingRef.current?.adapter !== adapter) return false;
        const live = adapter.getSnapshot();
        return live.generation === generation && live.phase === "connected";
      },
    };
  }, []);

  // ── actions (all of them route through the adapter) ──────────────────────

  async function handlePair(event: React.FormEvent) {
    event.preventDefault();
    try {
      setLocalError(null);
      let target: PairTarget;
      try {
        target = parsePairUri(code);
      } catch (err) {
        setLocalError(pairFailureText(err));
        return;
      }
      const override = address.trim();
      if (!override && !target.relayUrl) {
        setLocalError(RELAY_REQUIRED);
        return;
      }
      setActionBusy("connecting…");
      // `pair` runs off `connected`, so the owner fence is identity + sequence:
      // a forget during the attempt must not clear the NEWER action's busy.
      const token = ++pairSeqRef.current;
      const adapter = ensureAdapter();
      try {
        await adapter.pair(target, override || undefined);
      } catch (err) {
        if (token !== pairSeqRef.current || bindingRef.current?.adapter !== adapter) return;
        setLocalError(pairFailureText(err));
      } finally {
        if (token === pairSeqRef.current && bindingRef.current?.adapter === adapter) {
          setActionBusy(null);
        }
      }
    } finally {
      // The pairing code is single-use: drop it (and the relay override) once
      // the attempt settles, on parse failure, rejection or success alike.
      // Never logged or rendered — the inputs are simply emptied.
      setCode("");
      setAddress("");
    }
  }

  async function handleFsList(path: string, hidden: boolean = showHidden) {
    const adapter = bindingRef.current?.adapter;
    if (!adapter) return;
    const owner = makeOwner(adapter);
    const token = ++fsListSeqRef.current;
    setFsError(null);
    setFsLoading(true);
    // The path being listed is NOT yet confirmed: drop whatever the previous
    // directory left on screen so a stale listing is never shown as the new one.
    setFsEntries([]);
    setFsParent(null);
    setFsLoaded(false);
    try {
      const list = await adapter.fsList(path, { showHidden: hidden });
      if (token !== fsListSeqRef.current || !owner.current()) return;
      setFsEntries(list.entries);
      setFsPath(list.path);
      setFsParent(list.parent);
      setFsLoaded(true);
    } catch (err) {
      if (token !== fsListSeqRef.current || !owner.current() || isSuperseded(err)) return;
      // A failure is NOT a loaded directory: the dock keeps its empty state.
      setFsEntries([]);
      setFsParent(null);
      setFsLoaded(false);
      setFsError(err instanceof ActionRejectedError ? err.safeMessage : FS_FAILED);
    } finally {
      if (token === fsListSeqRef.current && owner.current()) setFsLoading(false);
    }
  }

  /** Manual path entry: the typed value is only a REQUEST. It never becomes
   *  the host-canonical path on its own — the rows, the parent and the loaded
   *  flag are dropped, any in-flight reply is fenced off, and only the next
   *  `fs_list` reply may confirm the path. */
  function handleFsPathChange(next: string) {
    fsListSeqRef.current += 1;
    setFsPath(next);
    setFsEntries([]);
    setFsParent(null);
    setFsLoaded(false);
    setFsLoading(false);
    setFsError(null);
  }

  /** Switching the hidden-entry flag invalidates the rows fetched under the
   *  other mode: the listing is dropped, any in-flight reply is fenced off,
   *  and a directory already on screen is re-read with the new flag. */
  function handleShowHiddenChange(value: boolean) {
    if (!fsAvailable) return;
    fsListSeqRef.current += 1;
    setShowHidden(value);
    setFsLoading(false);
    setFsError(null);
    setFsEntries([]);
    setFsParent(null);
    setFsLoaded(false);
    if (fsLoaded) void handleFsList(fsPath, value);
  }

  /** Relist the host catalog. The adapter owns the catalog; this only reports
   *  the outcome, and a superseded reply is silently dropped. */
  async function handleRefresh() {
    const adapter = bindingRef.current?.adapter;
    if (!adapter) return;
    const owner = makeOwner(adapter);
    const token = ++workspaceSeqRef.current;
    setWorkspacesError(null);
    setWorkspacesBusy(true);
    try {
      await adapter.refreshWorkspaces();
      if (token !== workspaceSeqRef.current || !owner.current()) return;
    } catch (err) {
      if (token !== workspaceSeqRef.current || !owner.current() || isSuperseded(err)) return;
      setWorkspacesError(
        err instanceof ActionRejectedError ? err.safeMessage : WORKSPACES_FAILED,
      );
    } finally {
      if (token === workspaceSeqRef.current && owner.current()) setWorkspacesBusy(false);
    }
  }

  /** Persist the current host-canonical directory, then relist: the host
   *  echoes no canonical cwd, so only the refresh makes the row visible. */
  async function handleAdd(path: string) {
    const adapter = bindingRef.current?.adapter;
    if (!adapter) return;
    const owner = makeOwner(adapter);
    const token = ++workspaceSeqRef.current;
    setLocalError(null);
    setWorkspacesBusy(true);
    try {
      await adapter.addWorkspace(path);
      // Fence BETWEEN the mutation and the relist: a drop or a new flow in
      // between must not let the refresh run against a dead binding.
      if (token !== workspaceSeqRef.current || !owner.current()) return;
      await adapter.refreshWorkspaces();
      if (token !== workspaceSeqRef.current || !owner.current()) return;
    } catch (err) {
      if (token !== workspaceSeqRef.current || !owner.current() || isSuperseded(err)) return;
      setLocalError(err instanceof ActionRejectedError ? err.safeMessage : ADD_FAILED);
    } finally {
      if (token === workspaceSeqRef.current && owner.current()) setWorkspacesBusy(false);
    }
  }

  /** Revive a crashed/stopped workspace in place. The ok carries no room, so
   *  the transcript is NOT switched here — only the catalog is relisted. */
  async function handleRestart(cwd: string) {
    const adapter = bindingRef.current?.adapter;
    if (!adapter) return;
    const owner = makeOwner(adapter);
    const token = ++workspaceSeqRef.current;
    setWorkspacesError(null);
    setWorkspacesBusy(true);
    try {
      await adapter.restartWorkspace(cwd);
      if (token !== workspaceSeqRef.current || !owner.current()) return;
      await adapter.refreshWorkspaces();
      if (token !== workspaceSeqRef.current || !owner.current()) return;
    } catch (err) {
      if (token !== workspaceSeqRef.current || !owner.current() || isSuperseded(err)) return;
      setWorkspacesError(
        err instanceof WorkspaceRestartRejectedError || err instanceof ActionRejectedError
          ? err.safeMessage
          : RESTART_FAILED,
      );
    } finally {
      if (token === workspaceSeqRef.current && owner.current()) setWorkspacesBusy(false);
    }
  }

  async function handleStart(cwd: string) {
    const adapter = bindingRef.current?.adapter;
    if (!adapter) return;
    const owner = makeOwner(adapter);
    const token = ++workspaceSeqRef.current;
    setLocalError(null);
    setActionBusy("starting Pi…");
    setWorkspacesBusy(true);
    try {
      const started = await adapter.startWorkspace(cwd);
      if (token !== workspaceSeqRef.current || !owner.current()) return;
      const catalog = await adapter.refreshWorkspaces();
      if (token !== workspaceSeqRef.current || !owner.current()) return;
      // The room is opened ONLY when the REFRESHED catalog confirms the exact
      // row the host returned (same cwd AND same daemon_id) — never a guess,
      // and never the room_id from the start reply itself.
      const confirmed = catalog.find(
        (ws) => ws.cwd === started.cwd && ws.daemon_id === started.daemon_id,
      );
      if (confirmed) {
        openRoom(confirmed.room_id);
        // A Pi that just started has no catalogue yet: prefetch it now so the
        // picker for this brand-new workspace is populated instead of showing
        // "asking the host…". The connection-time prefetch could not know about
        // it — the workspace did not exist then.
        runPrefetchModels([confirmed]);
      } else setLocalError(START_FAILED);
    } catch (err) {
      if (token !== workspaceSeqRef.current || !owner.current() || isSuperseded(err)) return;
      setLocalError(err instanceof ActionRejectedError ? err.safeMessage : START_FAILED);
    } finally {
      if (token === workspaceSeqRef.current && owner.current()) {
        setActionBusy(null);
        setWorkspacesBusy(false);
      }
    }
  }

  /** Submit one turn. The user's own bubble is drawn IMMEDIATELY from the
   *  local draft (the reducer renders an `awaiting_echo` turn's user item
   *  optimistically), so the text appears before any network round trip; only
   *  the agent item waits for the host's exact echo. The draft is cleared ONLY
   *  after the send was accepted (a synchronous throw keeps the text in place
   *  and reports a fixed failure). */
  function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoom;
    const text = draft.trim();
    const image = attachment;
    // An image alone is a valid message (plan/30 sends `text` plus the image);
    // only an empty draft WITH no attachment is a no-op.
    if (adapter === null || roomId === null || (text === "" && image === null) || !connected) return;
    if (!canSubmit(chatStateRef.current)) return;
    let id: string;
    try {
      id = image === null ? adapter.sendChat(roomId, text) : adapter.sendChat(roomId, text, [image]);
    } catch {
      setLocalError(SEND_FAILED);
      return;
    }
    if (typeof id !== "string" || id === "") return;
    dispatchChat({ type: "submit", roomId, text, id, attempt: 1, retryRisk: false });
    scheduleChatTimeout(adapter, roomId, id);
    setDraft("");
    setAttachment(null);
  }

  /** Two-click unpair: the ONLY place the stored pairing is deleted.
   *
   *  `close()` deletes memory first and then DISK, and it reports a failed
   *  deletion only through the snapshot. So the adapter is closed while THIS
   *  binding's state subscription is still attached, and the snapshot the
   *  close produced is CAPTURED before anything is released; if that deletion
   *  failed the launcher keeps the fixed warning instead of silently looking
   *  "forgotten". The subscriptions are always released. */
  function handleUnpair() {
    if (!unpairArmed) {
      setUnpairArmed(true);
      return;
    }
    const adapter = bindingRef.current?.adapter ?? null;
    if (adapter === null) {
      // Nothing to close: another flow already released this binding.
      setSnapshot(null);
      resetUi();
      setAddress("");
      setCode("");
      return;
    }
    adapter.close();
    // Read the snapshot the close produced BEFORE releasing: the fixed
    // "could not delete the saved session" warning only exists there.
    const closed = adapter.getSnapshot();
    releaseBinding();
    resetUi();
    setSnapshot(closed);
    setAddress("");
    setCode("");
  }

  /** Launcher "forget": the same explicit close, staying on the launcher. */
  function handleForgetStored() {
    const adapter = bindingRef.current?.adapter ?? null;
    if (adapter === null) {
      setSnapshot(null);
      resetUi();
      return;
    }
    adapter.close();
    const closed = adapter.getSnapshot();
    releaseBinding();
    resetUi();
    setSnapshot(closed);
  }

  /** The panel keeps its existing contract: a plain `ChatItem[]` plus a
   *  boolean. The user item is verbatim; the agent item maps its settled phase
   *  onto the old `done` flag (ONLY `completed` counts as done) plus a minimal
   *  text-free `status`, so a failed turn stops drawing as a live stream and
   *  no error code ever reaches the UI. `streaming` is the reducer's own phase. */
  /*
   * Per-turn stats, keyed by the turn's id so each agent item can carry its own
   * readings to the panel. Built from the reducer's turns, which already hold the
   * host's usage (see `hydrateTurns`) — nothing is recomputed from prose here.
   */
  const statsByTurn = new Map<string, TranscriptTurnStats>();
  const roomTurnList = chatState.history.filter((turn) => turn.roomId === activeRoom);
  roomTurnList.forEach((turn, index) => {
    const s = turn.stats;
    if (s === undefined) return;
    const total = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
    statsByTurn.set(turn.id, {
      index: index + 1,
      elapsedMs: s.elapsedMs,
      totalTokensText: total > 0 ? formatTokens(total) : null,
      clock: s.lastAgentTs !== null ? formatClock(s.lastAgentTs) : null,
      failed: turn.phase === "error" || turn.phase === "timed_out",
    });
  });

  const chat: TranscriptChatItem[] = visibleChatItems(chatState).map(
    (item): TranscriptChatItem => {
      if (item.kind === "user") return { kind: "user", id: item.id, text: item.text };
      const stats = statsByTurn.get(item.id);
      return {
        kind: "agent",
        id: item.id,
        text: item.text,
        done: item.phase === "completed",
        status: chatItemStatus(item.phase),
        ...(stats !== undefined ? { stats } : {}),
      };
    },
  );

  /**
   * Whole-session readings for the composer dock.
   *
   * Summed over the SAME turns the transcript shows, so the pill and the bubbles
   * can never disagree.
   *
   * SPEED is decode speed, not wall-clock throughput: a turn's `elapsedMs` spans
   * tool calls, thinking and queueing, so dividing by it reports ~17 tok/s for a
   * session whose model actually decoded at hundreds. DSH makes the same
   * distinction (`decodeMs`/`decodeTokens`), and the honest figure for "how fast
   * did it generate" is output tokens over the time actually spent generating.
   *
   * The per-turn gap is not recorded yet, so the reading is derived from the
   * steps that reported usage against the turn's reply time. When no turn carries
   * that, the speed is `null` and the pill omits it.
   */
  const aggregate = roomTurnList.reduce(
    (acc, turn) => {
      const s = turn.stats;
      if (s === undefined) return acc;
      acc.steps += 1;
      acc.inputTokens += s.inputTokens;
      acc.outputTokens += s.outputTokens;
      acc.cacheReadTokens += s.cacheReadTokens;
      acc.cacheWriteTokens += s.cacheWriteTokens;
      if (s.decodeMs !== null && s.decodeMs > 0 && s.outputTokens > 0) {
        acc.decodeMs += s.decodeMs;
        acc.decodeTokens += s.outputTokens;
      }
      return acc;
    },
    {
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      decodeMs: 0,
      decodeTokens: 0,
    },
  );
  const promptTokens =
    aggregate.inputTokens + aggregate.cacheReadTokens + aggregate.cacheWriteTokens;
  const grandTotal = promptTokens + aggregate.outputTokens;
  const activityStats = {
    turns: roomTurnList.filter((t) => t.stats !== undefined).length,
    steps: aggregate.steps,
    tokensPerSecond:
      aggregate.decodeMs > 0 && aggregate.decodeTokens > 0
        ? (aggregate.decodeTokens * 1000) / aggregate.decodeMs
        : null,
  };
  const usageStats = {
    totalText: formatTokens(grandTotal),
    cacheHitPercent: formatCacheHitPercent(aggregate.cacheReadTokens, promptTokens),
  };
  const streaming = chatState.active?.phase === "streaming";

  /* Chat affordances, derived from the reducer alone (never from a local guess)
     and handed to the panel: `chatBusy` locks the composer, `chatNotice` is the
     fixed sentence for the room's latest settled turn, and `retryAvailable`
     offers the ONE explicit retry. */
  const chatBusy = !canSubmit(chatState);
  const roomTurns = chatState.history.filter((turn) => turn.roomId === activeRoom);
  const latestTurn = roomTurns.length > 0 ? roomTurns[roomTurns.length - 1] : null;
  const retryableTurn =
    !chatBusy &&
    connected &&
    activeRoom !== null &&
    latestTurn !== null &&
    (latestTurn.phase === "timed_out" ||
      latestTurn.phase === "error" ||
      latestTurn.phase === "disconnected")
      ? latestTurn
      : null;
  const retryAvailable = retryableTurn !== null;
  // While a NEW turn is in flight the composer status owns the message; the
  // notice belongs to a settled turn, so it is not stacked on top of it.
  const chatNotice = chatBusy ? null : chatNoticeForTurn(latestTurn);

  /* ── model surface: state the picker needs ────────────────────────────────
     The picker is offered only for a workspace that can answer: a live
     connection plus a selected room. Everything else states the fixed reason
     instead of opening a picker with nothing behind it. */
  const modelDisabledReason = !connected
    ? MODEL_NOT_CONNECTED
    : activeRoom === null
      ? MODELS_FOR_LIVE_WORKSPACE
      : // A workspace that is NOT live has no Pi to answer `list_models`, so a
        // picker opened on it would wait forever. State the reason instead.
        (activeWorkspace?.live ?? false)
        ? null
        : MODELS_FOR_LIVE_WORKSPACE;

  /* What the picker shows as the active model. The Pi's own `current` wins;
     when the workspace Pi has no active session ctx it reports none, so the
     HOST-CONFIRMED selection (`action_ok`) is marked instead. Marking — not
     appending — matters: the confirmed model is normally already a row, so
     returning the list untouched would leave nothing selected. */
  const pickerOptions: readonly ModelOption[] = (() => {
    const hostCurrent = modelOptions.find((o) => o.current);
    const effective = hostCurrent ?? confirmedModel;
    if (effective === null) return modelOptions;
    const fromHost = hostCurrent !== undefined;
    let marked = false;
    const rows = modelOptions.map((o) => {
      const isEffective =
        effective.provider === o.provider && effective.id === o.id;
      if (!isEffective) return fromHost ? o : { ...o, current: false };
      marked = true;
      return { ...o, current: true };
    });
    if (marked) return rows;
    // A confirmed pick the host did not list (e.g. the list has not returned
    // yet): show it as the first row so the control never loses the choice.
    return [
      {
        id: effective.id,
        name: effective.name,
        provider: effective.provider,
        reasoning: effective.reasoning,
        vision: effective.vision,
        contextWindow: 0,
        current: true,
      },
      ...rows,
    ];
  })();

  /** The model the controls treat as active: the Pi's report, else the
   *  host-confirmed pick. Drives the thinking control and image support. */
  const activeModel =
    modelOptions.find((o) => o.current) ??
    (confirmedModel === null
      ? null
      : {
          id: confirmedModel.id,
          name: confirmedModel.name,
          provider: confirmedModel.provider,
          reasoning: confirmedModel.reasoning,
          vision: confirmedModel.vision,
          contextWindow: 0,
          current: true,
        });

  /* Attachments need a model that accepts images (plan/30 `vision`). Without a
     known model the control states that instead of guessing — the host never
     reported either way. */
  const attachmentDisabledReason = !connected
    ? MODEL_NOT_CONNECTED
    : activeRoom === null || !(activeWorkspace?.live ?? false)
      ? MODELS_FOR_LIVE_WORKSPACE
      : activeModel === null
        ? ATTACH_MODEL_REQUIRED
        : activeModel.vision
          ? null
          : ATTACH_VISION_REQUIRED;
  const attachmentAllowed = attachmentDisabledReason === null;

  /* ── skills (plan/68) ─────────────────────────────────────────────────────
     Same gating as the model surface: a workspace that is not live has no Pi
     to answer `pi_surface`, so the menu states the reason instead of opening
     onto a list that can never arrive. */
  const skills: readonly SkillOption[] =
    activeRoom === null ? EMPTY_SKILLS : (skillsByRoom[activeRoom] ?? EMPTY_SKILLS);
  const skillsDisabledReason = !connected
    ? MODEL_NOT_CONNECTED
    : activeRoom === null || !(activeWorkspace?.live ?? false)
      ? MODELS_FOR_LIVE_WORKSPACE
      : skillsNotice;

  /* ── sessions (plan/67 + plan/71) ──────────────────────────────────────────
     Same gating as the skills surface. Reading a session needs a live Pi (it
     is the Pi that owns the transcript files), and switching needs one even
     more so. */
  const sessions: readonly WireSessionInfo[] =
    activeRoom === null ? EMPTY_SESSIONS : (sessionsByRoom[activeRoom] ?? EMPTY_SESSIONS);
  /*
   * Point the composer at THIS session's draft.
   *
   * Without this the draft is global, so resuming, switching or starting a
   * session discards whatever was typed. Keyed by the live session id, falling
   * back to the room before any session is known: switching away and back
   * restores the text instead of losing it.
   */
  const liveSessionKey = sessions.find((s) => s.live)?.id ?? activeRoom ?? "";
  useEffect(() => {
    setDraftKey(liveSessionKey);
  }, [liveSessionKey, setDraftKey]);
  const sessionsDisabledReason = !connected
    ? MODEL_NOT_CONNECTED
    : activeRoom === null
      ? SESSIONS_FOR_LIVE_WORKSPACE
      : // Same gate the model picker uses: a workspace that is not live has no Pi
        // to answer `session_list`, so asking would leave the panel spinning.
        (activeWorkspace?.live ?? false)
        ? null
        : SESSIONS_FOR_LIVE_WORKSPACE;
  /** The session open for READING, or null. Resolved from the CURRENT list, so
   *  a row the host no longer reports closes the viewer instead of showing a
   *  stale transcript. */
  const viewingSession =
    viewingId === null ? null : (sessions.find((s) => s.id === viewingId) ?? null);

  /** `list_models` for the room on screen. Fire-and-forget like chat; the
   *  reply is correlated by (room + id) in `onServerMessage`.
   *
   *  The catalogue is PREFETCHED when the connection comes up (see
   *  `prefetchModels`), so a click on the picker normally hits the cache and
   *  sends nothing at all. The wire request below is therefore only the cold
   *  path: a workspace that appeared after the prefetch, or a prefetch that was
   *  refused. A still-fresh catalogue for this exact source is adopted WITHOUT
   *  wire traffic, so reopening the picker never repeats the round trip. A
   *  confirmed `model_set` corrects the cached entry in place
   *  (`confirmCachedModel`), so the cache stays accurate without a re-list. */
  const requestModels = useCallback(() => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null || adapter.getSnapshot().phase !== "connected") {
      return;
    }
    const cached = adapter.readCachedModels(roomId);
    if (cached !== null) {
      applyCatalogue(roomId, cached.models, cached.current);
      setModelBusy(false);
      setModelNotice(null);
      return;
    }
    try {
      const id = adapter.listModels(roomId);
      modelReqRef.current = { id, room: roomId, kind: "list" };
      setModelBusy(true);
      setModelNotice(null);
    } catch {
      setModelNotice(MODELS_FAILED);
      setModelBusy(false);
    }
  }, [applyCatalogue]);

  /** `model_set` — provider/id were reported by the Pi, so they are echoed
   *  back verbatim. The picker closes immediately and the reply either clears
   *  the notice (and re-lists) or shows the fixed failure sentence. */
  const handleModelSelect = (provider: string, modelId: string) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    const picked = modelOptions.find((o) => o.provider === provider && o.id === modelId);
    try {
      const id = adapter.setModel(roomId, provider, modelId);
      modelSetRef.current = { id, room: roomId };
      pendingModelChoiceRef.current = picked
        ? { provider, id: modelId, name: picked.name, reasoning: picked.reasoning, vision: picked.vision }
        : { provider, id: modelId, name: modelId, reasoning: false, vision: false };
      // NOT `modelBusy`: the rows are already known, so the picker stays
      // usable while the Pi applies the switch — a user who changes their mind
      // can pick again instead of waiting out the round trip.
      setModelSwitchTo(picked ?? { name: modelId, reasoning: false });
      setModelNotice(null);
    } catch {
      pendingModelChoiceRef.current = null;
      setModelNotice(MODEL_SET_FAILED);
      setModelSwitchTo(null);
    }
  };

  /** `thinking_set` — the fixed enum; only offered for a reasoning model. */
  const handleThinkingChange = (level: ThinkingLevelId) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    const previous = thinking;
    setThinkingByRoom((prev) => ({ ...prev, [roomId]: level }));
    try {
      const id = adapter.setThinking(roomId, level);
      thinkingReqRef.current = { id, room: roomId };
      // The control already shows the new level (reverted below on failure),
      // so nothing here locks the picker for a thinking round trip.
      setModelNotice(null);
    } catch {
      // Keep the UI honest: a request that never left the client must not
      // leave the control showing a value the host never received.
      setThinkingByRoom((prev) =>
        previous === null
          ? Object.fromEntries(Object.entries(prev).filter(([r]) => r !== roomId))
          : { ...prev, [roomId]: previous },
      );
      setModelNotice(THINKING_SET_FAILED);
    }
  };

  /** `pi_surface` for the room on screen — the installed skills. Fetched ONCE
   *  per room: the install list does not change while a skill runs, so the
   *  menu never re-fetches just because it was reopened. */
  const requestSkills = useCallback(() => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null || adapter.getSnapshot().phase !== "connected") {
      return;
    }
    if (skillsFetchedRef.current.has(roomId)) return;
    if (skillsReqRef.current !== null) return;
    try {
      const id = adapter.listSkills(roomId);
      skillsReqRef.current = { id, room: roomId };
      skillsFetchedRef.current.add(roomId);
      setSkillsBusy(true);
      setSkillsNotice(null);
    } catch {
      // Never recorded as fetched, so the next `/` retries.
      skillsFetchedRef.current.delete(roomId);
      setSkillsNotice(SKILLS_FAILED);
      setSkillsBusy(false);
    }
  }, []);

  /** `skill_invoke` — runs a skill the host reported. The provider/name came
   *  from `pi_surface_ok`, so it is echoed verbatim. The draft is cleared here
   *  because the composer handed over to a command, not a message; the skill's
   *  output arrives through the normal chat channels. */
  const handleSkillInvoke = useCallback((name: string) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    try {
      const id = adapter.invokeSkill(roomId, name);
      skillInvokeRef.current = { id, room: roomId };
      setSkillsNotice(null);
      setDraft("");
    } catch {
      setSkillsNotice(SKILL_FAILED);
    }
  }, []);

  const ATTACH_TOO_LARGE = "That image is too large. Pick one under 8 MB.";
  const ATTACH_NOT_IMAGE = "That file is not an image.";
  const ATTACH_READ_FAILED = "Could not read that image.";

  /**
   * Downscale + re-encode a picked file in the browser so the inline base64
   * stays reasonable (the wire carries the bytes inside `ct`). Falls back to
   * the original bytes when the canvas path is unavailable, and never throws:
   * a failure is reported with a fixed sentence.
   */

  const handleAttach = useCallback(
    (file: File | null) => {
      setAttachmentError(null);
      if (file === null) return;
      if (!file.type.startsWith("image/")) {
        setAttachmentError(ATTACH_NOT_IMAGE);
        return;
      }
      const MAX_BYTES = 8 * 1024 * 1024;
      if (file.size > MAX_BYTES) {
        setAttachmentError(ATTACH_TOO_LARGE);
        return;
      }
      void fileToWireImage(file)
        .then((image) => {
          if (!isWireImage(image)) {
            setAttachmentError(ATTACH_READ_FAILED);
            return;
          }
          setAttachment(image);
        })
        .catch(() => setAttachmentError(ATTACH_READ_FAILED));
    },
    [],
  );

  /** Retry the latest SETTLED turn of the current room. Only a turn the host
   *  may already have seen is offered (`timed_out` / `error` / `disconnected`),
   *  it is sent exactly ONCE as a NEW turn, and the new turn is flagged
   *  `retryRisk` because the host might already have answered the first one.
   *  There is no automatic resend anywhere. */
  const handleRetry = () => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    const turn = retryableTurn;
    if (adapter === null || roomId === null || turn === null || !connected) return;
    if (!canSubmit(chatStateRef.current)) return;
    let id: string;
    try {
      id = adapter.sendChat(roomId, turn.text);
    } catch {
      setLocalError(SEND_FAILED);
      return;
    }
    if (typeof id !== "string" || id === "") return;
    dispatchChat({
      type: "submit",
      roomId,
      text: turn.text,
      id,
      attempt: turn.attempt + 1,
      retryRisk: true,
    });
    scheduleChatTimeout(adapter, roomId, id);
  };

  /**
   * Stable `session_new` trigger for the sidebar.
   *
   * Created outside the `shellProps` object literal so the props object does not
   * have to build a closure during render: an inline arrow there re-creates a
   * new function identity every render AND makes the surrounding object literal
   * a ref-reading expression, which the hooks lint rules flag on the neighbouring
   * prop lines.
   */
  const sidebarNewSession = useMemo<(() => void) | undefined>(() => {
    if (workspaces.length === 0) return undefined;
    const roomId = activeRoom ?? workspaces[0]?.room_id ?? "";
    return () => handleSessionNew(roomId);
  }, [workspaces, activeRoom, handleSessionNew]);

  const shellProps: RemotePiShellProps = {
    view,
    launcher: {
      address,
      onAddressChange: setAddress,
      code,
      onCodeChange: setCode,
      onSubmit: handlePair,
      busy: busy ?? null,
      error,
      resuming,
      stored: storedPairing ? { name: storedPairing.name, relayUrl: storedPairing.relayUrl } : null,
      onForgetStored: handleForgetStored,
    },
    host: {
      hostname: host?.daemon.hostname ?? paired?.name ?? "host",
      daemonVersion: host?.daemon.version,
      backend: backend || undefined,
      relayUrl: paired?.relayUrl ?? "",
      capabilities: host?.capabilities,
      stale: effectiveStale,
    },
    onUnpair: handleUnpair,
    unpairArmed,
    notice:
      actionBusy !== null
        ? { tone: "busy", text: actionBusy }
        : error
          ? {
              tone: "error",
              text: error,
              ...(localError !== null ? { onDismiss: () => setLocalError(null) } : {}),
            }
          : null,
    sidebar: {
      workspaces,
      activeRoom,
      onOpenWorkspace: openRoom,
      query,
      onQueryChange: setQuery,
      workspacesLoading: resuming || workspacesBusy,
      workspacesError,
      workspaceStates,
      workspacesBusy,
      onRefresh: () => void handleRefresh(),
      onStart: (cwd) => void handleStart(cwd),
      onRestart: (cwd) => void handleRestart(cwd),
      /*
       * Offered whenever the host listed at least one workspace.
       *
       * `session_new` needs a cwd, so it resolves to the open room when there is
       * one and the first listed workspace otherwise. Gating the row on an
       * already-open room (the previous behaviour) meant it never rendered on a
       * fresh connection, while DSH shows "New session" there unconditionally.
       */
      onNewSession: sidebarNewSession,
      canNewSession: sessionCanNew,
      newSessionBusy: sessionsBusy,
    },
    transcript: {
      workspaceName: activeWorkspace?.name ?? host?.daemon.hostname ?? null,
      workspacePath: activeWorkspace?.cwd ?? null,
      host: {
        hostname: host?.daemon.hostname ?? paired?.name ?? "host",
        daemonVersion: host?.daemon.version,
        backend: backend || undefined,
      },
      streaming,
      chat,
      /*
       * A resume empties the transcript until the restarted Pi re-reads the
       * session file (measured ~14s). The panel must say so instead of claiming
       * the workspace has no turns.
       */
      resuming: resumingSession && chat.length === 0,
      activityStats,
      usageStats,
      chatBusy,
      chatNotice,
      retryAvailable,
      onRetry: handleRetry,
      draft,
      onDraftChange: setDraft,
      onSend: handleSend,
      tools: chatState.tools,
      attachmentAllowed,
      attachmentDisabledReason,
      attachment,
      attachmentNotice: attachmentError,
      onAttach: handleAttach,
      onRemoveAttachment: () => setAttachment(null),
      modelOptions: pickerOptions,
      modelBusy,
      modelSwitchTo,
      modelDisabledReason,
      modelNotice,
      onModelOpen: () => requestModels(),
      onModelSelect: handleModelSelect,
      thinking,
      onThinkingChange: handleThinkingChange,
      skills,
      skillsBusy,
      skillsDisabledReason,
      onSkillsOpen: requestSkills,
      onSkillPick: handleSkillInvoke,
      viewingSession:
        viewingSession === null
          ? null
          : {
              session: viewingSession,
              events: viewedEvents,
              loading: sessionReadLoading,
              notice: sessionsNotice,
              isLive: viewingSession.live,
              switchBusy: switchLoading,
              canSwitch: sessionCanSwitch,
            },
      onCloseSessionView: () => {
        setViewingId(null);
        setViewedEvents(null);
      },
      onSwitchToViewedSession: () => {
        if (viewingId !== null) handleSessionSwitch(viewingId);
      },
    },
    dock: {
      fsPath,
      onFsPathChange: handleFsPathChange,
      fsParent,
      fsEntries,
      fsLoading,
      fsError,
      fsLoaded,
      onList: (path) => void handleFsList(path),
      onStart: (cwd) => void handleStart(cwd),
      onAdd: (cwd) => void handleAdd(cwd),
      showHidden,
      onShowHiddenChange: handleShowHiddenChange,
      fsAvailable,
      fsAvailableReason,
      busy: busy !== null || workspacesBusy,
      sessions,
      sessionsBusy,
      sessionsDisabledReason,
      sessionViewingId: viewingId,
      sessionLiveId: sessions.find((s) => s.live)?.id ?? null,
      sessionsNotice,
      onSessionsRefresh: requestSessions,
      onSessionRead: handleSessionRead,
      onSessionPrefetch: handleSessionPrefetch,
      now: sessionClockRef,
    },
  };

  return <RemotePiShell {...shellProps} />;
}
