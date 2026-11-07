/**
 * Server-message dispatcher — the ONE place a wire frame is turned into UI state.
 *
 * Extracted from the connect container, which had grown to ~292 lines of
 * sequential `if (msg.type === ...)` branches inside a `useCallback`. The
 * branches are unchanged; only the ownership moved. Every effect it needs is
 * passed in as a PORT, so the dispatcher is pure over its inputs and the
 * container keeps owning the adapter binding and the refs.
 *
 * ORDERING MATTERS, and is preserved exactly:
 *   1. `models_list` bypasses the room filter, because the prefetch asks EVERY
 *      live workspace and most replies name a room that is not on screen.
 *   2. The room filter: every other reply must belong to the room on screen.
 *   3. Per-surface correlation by (room + in_reply_to) against the id this
 *      client minted. A reply for an unknown/older id is ignored rather than
 *      applied to the current selection.
 *
 * Truthfulness: a fixed, client-authored sentence is used for every refusal;
 * the host's own `message` field is never rendered.
 */

import type {
  ServerMessage,
  WireModel,
  WirePackage,
  WireSessionEvent,
  WireSessionInfo,
  WireSkill,
} from "@/lib/remote-pi/protocol";
import {
  isActionError,
  isCancelledMsg,
  isModelsListOk,
  isPackageOpOk,
  isSkillSetEnabledOk,
  isPiSurfaceOk,
  isSessionListOk,
  isSessionReadOk,
  isSessionSwitchError,
  isSessionSwitchOk,
  isSkillInvokeOk,
  isToolRequestMsg,
  isToolResultMsg,
  wireUsageOf,
} from "@/lib/remote-pi/protocol";
import { sessionActionErrorText, sortSessions, switchErrorText } from "@/lib/remote-pi/sessions";
import { hydrateTurns, type ChatEvent } from "@/lib/remote-pi/chat";
import { PACKAGE_FAILED, MODEL_SET_FAILED, SESSION_NEW_FAILED, SKILL_FAILED, THINKING_SET_FAILED } from "./notices";

/** Structural twin of `ConfirmedModel` (kept local so this module has no cycle). */
export interface ConfirmedModelLike {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}

/** Every capability the dispatcher needs. All refs/state live in the container. */
export interface DispatcherPorts {
  readonly activeRoomRef: { current: string | null };
  readonly modelReqRef: { current: { id: string; room: string; kind: "list" } | null };
  readonly modelSetRef: { current: { id: string; room: string } | null };
  readonly thinkingReqRef: { current: { id: string; room: string } | null };
  readonly skillsReqRef: { current: { id: string; room: string } | null };
  readonly skillInvokeRef: { current: { id: string; room: string } | null };
  /** The in-flight package/skill mutation, acked by the generic action_ok/error. */
  readonly packageReqRef: { current: { id: string; room: string; op?: string } | null };
  /** Called when the host CONFIRMS a package mutation (never on a refusal). */
  readonly onPackageConfirmed: (op: string | undefined) => void;
  readonly sessionsReqRef: { current: { id: string; room: string } | null };
  readonly sessionReadReqRef: {
    current: { id: string; room: string; sessionId: string } | null;
  };
  readonly prefetchReqRef: {
    current: { id: string; room: string; sessionId: string } | null;
  };
  readonly sessionSwitchReqRef: { current: { id: string; room: string } | null };
  readonly sessionNewReqRef: { current: { id: string; room: string } | null };
  readonly pendingModelChoiceRef: { current: ConfirmedModelLike | null };

  readonly setModelBusy: (busy: boolean) => void;
  readonly setModelNotice: (notice: string | null) => void;
  readonly setModelSwitchTo: (target: { name: string; reasoning: boolean } | null) => void;
  readonly setSkillsBusy: (busy: boolean) => void;
  readonly setSkillsNotice: (notice: string | null) => void;
  readonly setSessionsBusy: (busy: boolean) => void;
  readonly setSessionsNotice: (notice: string | null) => void;
  readonly setSessionReadLoading: (loading: boolean) => void;
  readonly setSwitchLoading: (loading: boolean) => void;
  readonly setConfirmedByRoom: (
    update: (prev: Record<string, ConfirmedModelLike>) => Record<string, ConfirmedModelLike>,
  ) => void;
  readonly setSessionsByRoom: (
    update: (
      prev: Record<string, readonly WireSessionInfo[]>,
    ) => Record<string, readonly WireSessionInfo[]>,
  ) => void;
  /** Host session-action capability, stated with each listing. */
  readonly setSessionCaps: (caps: { canSwitch: boolean; canNew: boolean }) => void;

  readonly applyCatalogue: (
    roomId: string,
    models: readonly WireModel[],
    current: WireModel | undefined,
  ) => void;
  readonly applySkills: (roomId: string, rows: readonly WireSkill[], packages: readonly WirePackage[]) => void;
  readonly markRowCurrent: (roomId: string, provider: string, modelId: string) => void;
  readonly confirmCachedModel: (roomId: string, provider: string, modelId: string) => void;
  readonly openViewer: (sessionId: string, events: readonly WireSessionEvent[]) => void;
  /** Stores a prefetched transcript without rendering it. */
  readonly cacheRead: (sessionId: string, events: readonly WireSessionEvent[]) => void;
  readonly clearViewer: () => void;
  /** Re-list after a switch, retrying across the host respawn gap. */
  readonly relistAfterSwitch: () => void;
  /** Re-read the session that was just resumed, so the viewer keeps showing its
   *  real history instead of the empty pane a `clearViewer()` used to leave. */
  /** Re-request the LIVE transcript after a resume (`session_sync`). */
  readonly resyncLive: () => void;
  readonly resetChatState: () => void;
  readonly runPrefetchNext: () => void;
  readonly dispatchChat: (event: ChatEvent) => void;
  /** Asks the ACTIVE room for a fresh `pi_surface` after a mutation, so the
   *  rows show what the host actually persisted instead of a local guess. */
  readonly refreshSurface: (force?: boolean) => void;
}

/** Applies one host frame. Every effect is a port call; nothing is returned. */
export function dispatchServerMessage(
  msg: ServerMessage,
  room: string,
  p: DispatcherPorts,
): void {
  const {
    activeRoomRef, modelReqRef, modelSetRef, thinkingReqRef,
    skillsReqRef, skillInvokeRef, packageReqRef, onPackageConfirmed, sessionsReqRef, sessionReadReqRef, sessionNewReqRef,
    sessionSwitchReqRef, pendingModelChoiceRef, prefetchReqRef,
    setModelBusy, setModelNotice, setModelSwitchTo,
    setSkillsBusy, setSkillsNotice,
    setSessionsBusy, setSessionsNotice, setSessionReadLoading, setSwitchLoading,
    setConfirmedByRoom, setSessionsByRoom, setSessionCaps,
    applyCatalogue, applySkills, markRowCurrent, confirmCachedModel,
    openViewer, clearViewer, relistAfterSwitch, resyncLive, resetChatState,
    runPrefetchNext, dispatchChat, cacheRead, refreshSurface,
  } = p;

  /* ── catalogue replies bypass the room filter ──────────────────────────
     The prefetch asks EVERY live workspace for its catalogue when the
     connection comes up, so most `models_list` replies name a room that is
     NOT on screen. Dropping them at the filter below would make the prefetch
     useless (and leave the queue stuck, since its pump continues on reply).
     They are still correlated by (room + in_reply_to) against the id this
     container minted, so this admits a reply it asked for and nothing else. */
  if (msg.type === "models_list") {
    const pending = modelReqRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isModelsListOk(msg)) return;
    modelReqRef.current = null;
    applyCatalogue(room, msg.models, msg.current);
    // Only the ACTIVE room may move the picker's own transient state.
    if (room === activeRoomRef.current) {
      setModelBusy(false);
      setModelNotice(null);
    }
    // One prefetch at a time: this reply frees the slot, so continue with the
    // next workspace that still has no catalogue for this connection.
    runPrefetchNext();
    return;
  }

  if (room !== activeRoomRef.current) return;

  /* ── model surface replies ────────────────────────────────────────────
     These arrive through the SAME proxied child room as chat, so they are
     correlated by (room + in_reply_to) against the ids this container
     minted. A reply for an unknown/older id is ignored rather than applied
     to the current selection. */

  if (msg.type === "pi_surface_ok") {
    const pending = skillsReqRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isPiSurfaceOk(msg)) return;
    skillsReqRef.current = null;
    /* `packages` is OPTIONAL on the wire: an absent list is read as empty, so a
       host that only reports skills still populates the slash menu. */
    applySkills(room, msg.skills, msg.packages ?? []);
    setSkillsBusy(false);
    setSkillsNotice(null);
    return;
  }

  /* A package/skill mutation landed. The HOST is the authority on the resulting
     install state, so the reply is not applied optimistically: the surface is
     asked again and the rows are replaced with what the host reports. */
  if (msg.type === "skill_set_enabled_ok" || msg.type === "package_op_ok") {
    if (!isSkillSetEnabledOk(msg) && !isPackageOpOk(msg)) return;
    /*
     * The SUCCESS path is a dedicated frame, not `action_ok`, so it has to be
     * correlated here too. Missing this made the ref survive a successful
     * mutation: a later refusal could then be attributed to an operation that
     * had already finished, and the Install form had no way to know it should
     * close.
     */
    const done = packageReqRef.current;
    const isThisOp = done !== null && done.room === room && done.id === msg.in_reply_to;
    /*
     * Only the reply that answers the PENDING request may end the busy state.
     * A stale or unrelated `package_op_ok` (a duplicate, or one belonging to a
     * mutation already abandoned by a forced refresh) must not clear the flag
     * while a different operation is still running — otherwise the panel would
     * look idle and accept a second write.
     */
    if (!isThisOp && done !== null) return;
    if (isThisOp) packageReqRef.current = null;
    setSkillsBusy(false);
    setSkillsNotice(null);
    if (isThisOp) onPackageConfirmed(done.op);
    /* Force: the reply proves the install state CHANGED, so any listing already
     * in flight describes the state before the change and must not be waited
     * on. Without this a stale pending request made the refresh a silent no-op
     * and the panel sat on its busy text forever. */
    refreshSurface(true);
    return;
  }

  if (msg.type === "skill_invoke_ok") {
    const pending = skillInvokeRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isSkillInvokeOk(msg)) return;
    skillInvokeRef.current = null;
    // Dispatch only: the skill's OUTPUT arrives as chat chunks, so nothing is
    // rendered from this reply beyond clearing the notice.
    setSkillsNotice(null);
    return;
  }

  if (msg.type === "session_list_ok") {
    const pending = sessionsReqRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isSessionListOk(msg)) return;
    sessionsReqRef.current = null;
    setSessionsByRoom((prev) => ({ ...prev, [room]: sortSessions(msg.sessions) }));
    // Default to TRUE when the host is older and does not announce these.
    setSessionCaps({ canSwitch: msg.can_switch !== false, canNew: msg.can_new !== false });
    setSessionsBusy(false);
    setSessionsNotice(null);
    return;
  }

  if (msg.type === "session_read_ok") {
    /*
     * A prefetch reply is stored, never rendered.
     *
     * Checked FIRST because a prefetch and a click-driven read share the frame
     * type: routing a prefetch reply into `openViewer` would mount the read-only
     * viewer (and hide the composer) merely because the pointer crossed a row.
     */
    const prefetch = prefetchReqRef.current;
    if (prefetch !== null && prefetch.room === room && prefetch.id === msg.in_reply_to) {
      prefetchReqRef.current = null;
      if (isSessionReadOk(msg)) cacheRead(msg.session_id, msg.events);
      return;
    }
    const pending = sessionReadReqRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isSessionReadOk(msg)) return;
    sessionReadReqRef.current = null;
    // READ-ONLY: this populates the viewer and never touches `chatState`, so
    // the live session and the live transcript are both left alone.
    openViewer(msg.session_id, msg.events);
    setSessionReadLoading(false);
    setSessionsNotice(null);
    return;
  }

  if (msg.type === "session_switch_ok") {
    const pending = sessionSwitchReqRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isSessionSwitchOk(msg)) return;
    sessionSwitchReqRef.current = null;
    setSwitchLoading(false);
    /*
     * The host reopened that session and reset its mirror.
     *
     * DO NOT clear the viewer here. It already holds the transcript we just
     * read from that exact session file, so it is still the truthful content
     * for the session the user asked to resume. Clearing it was the reason
     * "Resume here" appeared to open a brand-new EMPTY session while the
     * read-only view had shown the full history a second earlier: the code
     * wiped the only copy of that history and never put anything back (the
     * chat reducer has no "hydrate from session file" action).
     *
     * Keeping it mounted is both simpler and more honest: the history stays on
     * screen while the new process starts, and the re-read below confirms it
     * from disk rather than from a guess.
     */
    const resumedId = msg.session_id;
    setSessionsNotice(null);
    setSessionReadLoading(false);
    resetChatState();
    relistAfterSwitch();
    /*
     * CLOSE the read-only viewer now that the session is live.
     *
     * The viewer and the live transcript are mutually exclusive in the layout:
     * `TranscriptPanel` renders either the viewer OR the transcript + composer.
     * Leaving it open therefore kept the composer OUT OF THE DOM, so after a
     * successful resume the user could read the history but had no way to type
     * into the session they had just resumed. Closing it hands the pane to the
     * live transcript, which `session_history` then hydrates with the same
     * history the viewer was showing.
     */
    clearViewer();
    if (typeof resumedId === "string" && resumedId !== "") {
      resyncLive();
    }
    return;
  }

  if (msg.type === "session_switch_error") {
    const pending = sessionSwitchReqRef.current;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
    if (!isSessionSwitchError(msg)) return;
    sessionSwitchReqRef.current = null;
    setSwitchLoading(false);
    // The host's `message` is diagnostic detail; the UI shows the FIXED
    // sentence for the refusal code instead.
    setSessionsNotice(switchErrorText(msg.code));
    return;
  }

  if (msg.type === "action_ok" || msg.type === "action_error") {
    const setPending = modelSetRef.current;
    const thinkPending = thinkingReqRef.current;
    const isModelSet =
      setPending !== null && setPending.room === room && setPending.id === msg.in_reply_to;
    const isThinking =
      thinkPending !== null && thinkPending.room === room && thinkPending.id === msg.in_reply_to;
    const skillPending = skillInvokeRef.current;
    const isSkillInvoke =
      skillPending !== null && skillPending.room === room && skillPending.id === msg.in_reply_to;
    /*
     * `session_new` is answered with this generic pair, so it must be claimed
     * here or the frame is dropped: the host fans out an empty `session_history`
     * on success, and the ONLY thing the client has to do is stop showing the
     * control as busy. On failure the fixed sentence goes to the sessions
     * notice — a refused new-session is a real outcome (no command ctx, or an
     * extension hook vetoed it), not something to swallow.
     */
    const newPending = sessionNewReqRef.current;
    const isSessionNew =
      newPending !== null && newPending.room === room && newPending.id === msg.in_reply_to;
    if (isSessionNew) {
      sessionNewReqRef.current = null;
      setSessionsBusy(false);
      setSessionsNotice(msg.type === "action_ok" ? null : SESSION_NEW_FAILED);
      return;
    }
    /*
     * A package/skill mutation was refused or accepted.
     *
     * This MUST be correlated before the generic early-return below: the host
     * answers these with the plain action_ok/action_error, so without this block
     * a refusal (untrusted project, npm failure, bad source) matched nothing,
     * left `busy` true forever, and — because the panel disables every control
     * while busy — trapped the user with no way to retry short of a reload.
     */
    const mutation = packageReqRef.current;
    if (mutation !== null && mutation.room === room && mutation.id === msg.in_reply_to) {
      packageReqRef.current = null;
      setSkillsBusy(false);
      if (msg.type === "action_error") {
        setSkillsNotice(PACKAGE_FAILED);
        return;
      }
      /* Accepted: the HOST is the authority on the resulting state, so re-read
       * the surface rather than assuming what changed. Forced, because the reply
       * proves the old listing is stale. */
      setSkillsNotice(null);
      /* Passed explicitly: the ref is cleared one line above. */
      onPackageConfirmed(mutation.op);
      refreshSurface(true);
      return;
    }
    if (!isModelSet && !isThinking && !isSkillInvoke) return;
    if (isModelSet) modelSetRef.current = null;
    if (isThinking) thinkingReqRef.current = null;
    if (isSkillInvoke) {
      // A refused skill is a REAL outcome worth reporting (the host refuses a
      // name it does not have rather than passing `/skill:<name>` to the
      // model), so the fixed sentence goes to the skills notice.
      skillInvokeRef.current = null;
      setSkillsNotice(msg.type === "action_ok" ? null : SKILL_FAILED);
      return;
    }
    if (isModelSet) setModelSwitchTo(null);
    if (msg.type === "action_ok") {
      setModelNotice(null);
      // The Pi acknowledged the switch. Record it as a HOST-CONFIRMED
      // selection (never optimistic) and CORRECT the cached catalogue in
      // place so the remembered `current` matches the Pi's new active model.
      //
      // Deliberately NO forced `list_models` here: re-listing re-locked the
      // composer for a whole extra round trip (measured ~3.4s), which is what
      // made the thinking control look frozen after picking a model.
      // `action_ok` already proves `pi.setModel` succeeded, so the new
      // `current` is known without asking again; the next real
      // `models_list` still supersedes it.
      if (isModelSet) {
        const chosen = pendingModelChoiceRef.current;
        pendingModelChoiceRef.current = null;
        if (chosen !== null) {
          setConfirmedByRoom((prev) => ({ ...prev, [room]: chosen }));
          // Move the `current` marker in BOTH places the picker reads: the
          // cached catalogue (so a reopen is correct) AND the rendered rows
          // (so the label updates now). Correcting only the cache left the
          // stale row marked `current`, and since a host-reported `current`
          // outranks the confirmed pick, the label snapped BACK to the
          // previous model until the next real `models_list`.
          confirmCachedModel(room, chosen.provider, chosen.id);
          markRowCurrent(room, chosen.provider, chosen.id);
        }
      }
      return;
    }
    setModelNotice(isModelSet ? MODEL_SET_FAILED : THINKING_SET_FAILED);
    return;
  }

  if (msg.type === "tool_request") {
    if (!isToolRequestMsg(msg)) return;
    // `args` is host/Pi-supplied: stringified as TEXT and never interpreted.
    let argsText = "";
    try {
      argsText = JSON.stringify(msg.args);
    } catch {
      argsText = "";
    }
    dispatchChat({
      type: "tool_start",
      roomId: room,
      toolCallId: msg.tool_call_id,
      tool: msg.tool,
      argsText,
    });
    return;
  }
  if (msg.type === "session_history") {
    /*
     * The host fanned out the live session's transcript.
     *
     * This is the frame that makes a resumed session usable: resuming spawns a
     * FRESH process whose in-memory mirror is empty, so without hydrating from
     * these events the UI showed a blank new conversation -- and the user had
     * no history to continue from.
     *
     * An EMPTY `events` is meaningful and must be honoured: a `/new` really does
     * mean "no turns", so this clears the transcript rather than being skipped.
     */
    if (!Array.isArray(msg.events)) return;
    dispatchChat({
      type: "hydrate",
      roomId: room,
      turns: hydrateTurns(msg.events),
    });
    return;
  }

  if (msg.type === "tool_result") {
    if (!isToolResultMsg(msg)) return;
    let resultText: string | undefined;
    if (msg.result !== undefined && msg.result !== null) {
      try {
        resultText = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
      } catch {
        resultText = undefined;
      }
    }
    dispatchChat({
      type: "tool_end",
      roomId: room,
      toolCallId: msg.tool_call_id,
      // `error` presence is the failure signal; its TEXT is never rendered,
      // so only the boolean crosses into the reducer.
      ok: typeof msg.error !== "string",
      ...(resultText === undefined ? {} : { resultText }),
    });
    return;
  }

  // The host's exact echo promotes the turn from `awaiting_echo` to
  // `streaming`, which is what reveals the AGENT item. The user bubble is
  // already on screen from the local send, so nothing is withheld here.
  if (msg.type === "user_message") {
    if (typeof msg.id !== "string") return;
    dispatchChat({ type: "echo", roomId: room, id: msg.id });
    return;
  }
  /*
   * The user stopped the turn.
   *
   * Correlated on `target_id`, NOT `in_reply_to`: the host answers
   * `cancelled {in_reply_to: <cancel request id>, target_id: <turn id>}`
   * (server/src/index.ts:4661), while the reducer's `matches()` compares against
   * the TURN id. Using `in_reply_to` here would silently match nothing and leave
   * the turn stuck open — the exact bug this control exists to fix.
   */
  if (msg.type === "cancelled") {
    if (!isCancelledMsg(msg)) return;
    dispatchChat({ type: "cancelled", roomId: room, id: msg.target_id });
    return;
  }
  if (msg.type === "agent_chunk") {
    if (typeof msg.in_reply_to !== "string" || typeof msg.delta !== "string") return;
    dispatchChat({ type: "chunk", roomId: room, id: msg.in_reply_to, delta: msg.delta });
    return;
  }
  if (msg.type === "agent_done") {
    if (typeof msg.in_reply_to !== "string") return;
    /*
     * `agent_done` is where the live path learns the turn's token usage — the
     * only frame that carries it for a turn the user is actually watching.
     */
    const usage = wireUsageOf(msg.usage);
    dispatchChat({
      type: "done",
      roomId: room,
      id: msg.in_reply_to,
      ...(usage !== undefined ? { usage } : {}),
    });
    return;
  }
  if (msg.type === "action_error") {
    if (typeof msg.in_reply_to !== "string") return;
    // Session requests settle HERE, before the chat fallback: the host refuses
    // `session_read` / `session_switch` / `session_list` with this same generic
    // frame (unknown id, no cwd yet, no SDK). Without this branch the pending
    // ref was never cleared and `sessionReadLoading` stayed true forever, so
    // clicking a session looked like it did nothing at all.
    //
    // Two independent signals are accepted, because they cover different
    // races: the pending ref proves WE asked (exact room + in_reply_to), and
    // `action` still classifies the refusal when the ref was already dropped
    // by a superseded attempt. Either one keeps the frame out of the chat
    // path — it never belonged to a turn.
    const pendingSessionAction =
      sessionReadReqRef.current !== null &&
      sessionReadReqRef.current.room === room &&
      sessionReadReqRef.current.id === msg.in_reply_to
        ? "session_read"
        : sessionSwitchReqRef.current !== null &&
              sessionSwitchReqRef.current.room === room &&
              sessionSwitchReqRef.current.id === msg.in_reply_to
          ? "session_switch"
          : sessionsReqRef.current !== null &&
                sessionsReqRef.current.room === room &&
                sessionsReqRef.current.id === msg.in_reply_to
            ? "session_list"
            : null;
    const sessionAction = pendingSessionAction ?? (isActionError(msg) ? msg.action : null);
    const sessionText =
      sessionAction === null ? null : sessionActionErrorText(sessionAction);
    if (sessionText !== null) {
      if (sessionAction === "session_read") {
        sessionReadReqRef.current = null;
        setSessionReadLoading(false);
      } else if (sessionAction === "session_switch") {
        sessionSwitchReqRef.current = null;
      } else {
        sessionsReqRef.current = null;
        setSessionsBusy(false);
      }
      setSessionsNotice(sessionText);
      return;
    }
    dispatchChat({
      type: "error",
      roomId: room,
      id: msg.in_reply_to,
      code: "action_rejected",
    });
    return;
  }
  // `provider_error` is the host reporting a FAILED turn (the provider
  // aborted mid-turn). It is recognized by its exact closed wire code and is
  // still correlated by room+id: only a string `in_reply_to` is accepted, and
  // the reducer matches it against the ACTIVE turn. The wire `message` (raw
  // provider text) is deliberately never read: the failure is reported as a
  // distinct KIND, and `provider_error` maps onto the same fixed failure
  // sentence as any other provider-side failure. Unknown codes, malformed
  // frames, another room's frame and an id that is not the active turn all
  // stay inert — there is no automatic retry here.
  if (msg.type === "error") {
    if (msg.code !== "provider_error") return;
    if (typeof msg.in_reply_to !== "string") return;
    dispatchChat({
      type: "error",
      roomId: room,
      id: msg.in_reply_to,
      code: "provider_error",
    });
  }
}
