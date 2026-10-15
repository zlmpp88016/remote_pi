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

import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillOption } from "@/components/remote-pi/slash-menu";
import { sortSessions, switchErrorText } from "@/lib/remote-pi/sessions";
import {
  AdapterStateError,
  RemotePiAdapter,
  type AdapterSnapshot,
} from "@/lib/remote-pi/adapter";
import {
  ActionRejectedError,
  PairRejectedError,
  WorkspaceRestartRejectedError,
  isModelsListOk,
  isPiSurfaceOk,
  isSessionListOk,
  isSessionReadOk,
  isSessionSwitchError,
  isSessionSwitchOk,
  isSkillInvokeOk,
  isToolRequestMsg,
  isToolResultMsg,
  isWireImage,
  parsePairUri,
  type WireImage,
  type WireModel,
  type WireSessionEvent,
  type WireSessionInfo,
  type WireSkill,
  type FsEntry,
  type PairTarget,
  type ServerMessage,
  type WorkspaceEntry,
} from "@/lib/remote-pi/protocol";
import {
  RemotePiShell,
  type RemotePiShellProps,
} from "@/components/remote-pi/remote-pi-shell";
import type {
  ModelOption,
  ThinkingLevelId,
} from "@/components/remote-pi/model-picker";
import type {
  ChatItemStatus,
  TranscriptChatItem,
} from "@/components/remote-pi/transcript-panel";
import type { ConnectionPhase } from "@/lib/remote-pi/state";
import {
  canSubmit,
  initialChatState,
  reduceChat,
  visibleChatItems,
  type ChatEvent,
  type ChatState,
  type ChatTurn,
} from "@/lib/remote-pi/chat";

/** Device label the host sees in `pair_request`. */
const DEVICE_NAME = "Remote Pi Web";

/** A submitted turn the host never finished stays pending at most 30s; the
 *  timeout only ever settles the EXACT turn it was scheduled for. */
const CHAT_TIMEOUT_MS = 30_000;

/* Fixed, client-authored chat notice text: a settled turn is reported by KIND
   and never by echoing a wire payload. The reducer's code decides WHICH fixed
   sentence is used — raw errors are never rendered, so a host `provider_error`
   (whose wire `message` carries raw provider text) is reported through the
   SAME generic failure sentence as any other failed turn. The retry WARNING that
   sits next to the panel's Retry button is owned by the panel itself, which is
   the only place that button is drawn. */
const CHAT_NOTICE_REJECTED = "The host rejected that turn. Nothing else was changed.";
const CHAT_NOTICE_FAILED = "That turn did not finish. Nothing else was changed.";
const CHAT_NOTICE_TIMED_OUT =
  "That turn did not finish in time. It may still be running on the host.";
const CHAT_NOTICE_DISCONNECTED = "The connection dropped before that turn finished.";

/* Fixed, client-authored failure text. Nothing from the wire, no exception
   content: a refusal is reported by KIND, never by echoing a payload. */
const PAIR_CODE_INVALID = "That pairing code could not be read.";
const PAIR_UNAVAILABLE = "This page can no longer pair; reload it and try again.";
const PAIR_FAILED = "Could not reach the host. Check the relay address and the code.";
const RELAY_REQUIRED = "enter the relay address (or use a code carrying &r=…)";
const FS_FAILED = "Could not list that directory.";
const START_FAILED = "The host did not start that workspace.";
const WORKSPACES_FAILED = "Could not read the host catalog.";
const RESTART_FAILED = "The host did not restart that workspace.";
const ADD_FAILED = "The host did not add that directory to the catalog.";
const FS_NAV_UNAVAILABLE =
  "This host did not advertise the fs_nav capability, so the web client has no directory listing.";
const SEND_FAILED = "Could not send that message.";
const RELAY_NOTICE = "The relay connection reported an unexpected frame.";
/* `reauth_required` means the stored credential was refused: the ONLY way out
   is a fresh pairing, so the launcher prompt names that action explicitly
   instead of reusing the generic rejection text. */
const REAUTH_REQUIRED =
  "This pairing has expired or is no longer valid. Enter a new pairing code.";
/* A storage deletion that FAILED must stay visible in the launcher: it is a
   snapshot STATE warning, not a per-action failure, so it may not be shadowed
   by whichever prompt the phase owns. Both sentences are fixed and
   client-authored. */
const STORAGE_WARNING =
  "Could not delete the saved session. It may still be paired on this device.";

/* Fixed, client-authored model-surface text. The host's own `action_error`
   string is never rendered: a refusal is reported by KIND, with a fixed
   sentence, exactly like the workspace actions. */
const MODELS_FAILED = "Could not read this workspace's models.";
const MODEL_SET_FAILED = "The host did not switch the model.";
const THINKING_SET_FAILED = "The host did not change the thinking level.";
const MODEL_NOT_CONNECTED = "Connect to a host and pick a running workspace first.";
const EMPTY_SKILLS: readonly SkillOption[] = [];
const EMPTY_SESSIONS: readonly WireSessionInfo[] = [];
/** A model the Pi acknowledged via `action_ok` — never optimistic. */
interface ConfirmedModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}
const MODELS_FOR_LIVE_WORKSPACE = "List the workspace's models; it must be running.";
/** Fixed sentence for a `session_switch` that never left the client. */
const SWITCH_FAILED = "Could not ask the host to switch sessions.";
/** Attachment control reasons (fixed, client-authored). */
const ATTACH_MODEL_REQUIRED =
  "Select a model first — image support depends on the active model.";
const ATTACH_VISION_REQUIRED =
  "The selected model does not accept images. Pick a vision model to attach one.";

/** A reply that belongs to an older connection/action is NOT a user-facing
 *  failure: it must never become a UI error. */
function isSuperseded(err: unknown): boolean {
  return err instanceof AdapterStateError && err.code === "superseded";
}

function pairFailureText(err: unknown): string {
  if (err instanceof PairRejectedError) return PAIR_CODE_INVALID;
  if (err instanceof AdapterStateError) return PAIR_UNAVAILABLE;
  return PAIR_FAILED;
}

/** Minimal, text-free status for the panel: a settled turn that did not
 *  complete must not keep drawing as a live stream. No error code, no wire
 *  string, and no retry risk is exposed here. */
function chatItemStatus(phase: ChatTurn["phase"]): ChatItemStatus {
  switch (phase) {
    case "completed":
      return "complete";
    case "error":
    case "timed_out":
    case "disconnected":
      return "failed";
    default:
      return "streaming";
  }
}

/** Fixed notice sentence for the room's latest SETTLED turn, or null when
 *  there is nothing to report. `action_rejected` gets the safe generic text;
 *  `provider_error` (a failed provider turn) and every other error code get
 *  the same generic failure text — a payload is never echoed. */
function chatNoticeForTurn(turn: ChatTurn | null): string | null {
  if (turn === null) return null;
  switch (turn.phase) {
    case "error":
      return turn.error === "action_rejected" ? CHAT_NOTICE_REJECTED : CHAT_NOTICE_FAILED;
    case "timed_out":
      return CHAT_NOTICE_TIMED_OUT;
    case "disconnected":
      return CHAT_NOTICE_DISCONNECTED;
    default:
      return null;
  }
}

/** Busy label for the phases that are actually in flight. */
function phaseBusyLabel(phase: ConnectionPhase): string | null {
  switch (phase) {
    case "relay_authenticating":
      return "connecting…";
    case "pairing":
      return "pairing…";
    case "host_authenticating":
      return "reading host…";
    case "reconnecting":
      return "reconnecting…";
    default:
      return null;
  }
}

export function ConnectClient() {
  const [snapshot, setSnapshot] = useState<AdapterSnapshot | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [unpairArmed, setUnpairArmed] = useState(false);

  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  /** Transcript state lives in the Wave4 reducer. `chatState` drives the
   *  render; `chatStateRef` mirrors it so the message listener never reads a
   *  stale closure. Both are written ONLY through `dispatchChat`. */
  const [chatState, setChatState] = useState<ChatState>(initialChatState);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [workspacesBusy, setWorkspacesBusy] = useState(false);
  /** Hidden entries are opt-in on the wire (`fs_list {show_hidden}`); the dock
   *  owns the checkbox and this is the only place the flag is stored. */
  const [showHidden, setShowHidden] = useState(false);

  const [fsPath, setFsPath] = useState("~");
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsParent, setFsParent] = useState<string | null>(null);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const [fsLoaded, setFsLoaded] = useState(false);

  /** ── model surface (PROTOCOL.md "App actions") ───────────────────────────
   *  Real wire: `list_models` → `models_list`, `model_set` → `action_ok` |
   *  `action_error`, `thinking_set`. The rows come from the workspace Pi; the
   *  client echoes back the provider/id it reported and never invents one. */
  const [modelBusy, setModelBusy] = useState(false);
  /** The model being switched TO, or null. Separate from `modelBusy`:
   *  `modelBusy` means a `list_models` round trip is in flight (the picker has
   *  nothing to show yet), while THIS means a `model_set` is in flight — the
   *  rows are already known, so the picker stays usable and only shows which
   *  model is being switched to. Collapsing the two is what made picking a
   *  model look like a freeze.
   *
   *  `reasoning` rides along so the thinking control reflects the model the user
   *  PICKED, not the one being replaced: that flag comes from the row they
   *  clicked, so it is known immediately rather than after the round trip. */
  const [modelSwitchTo, setModelSwitchTo] = useState<{
    name: string;
    reasoning: boolean;
  } | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  /** ── skills (plan/68 `pi_surface` + `skill_invoke`) ───────────────────────
   *  Real wire: `pi_surface` → `pi_surface_ok{skills}` (proxied to the child
   *  room like chat, correlated by room + in_reply_to), and `skill_invoke` →
   *  `skill_invoke_ok` | `action_error`. Per room, like the model catalogue:
   *  two workspaces are two different Pi installs. */
  const [skillsByRoom, setSkillsByRoom] = useState<Record<string, readonly SkillOption[]>>({});
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsNotice, setSkillsNotice] = useState<string | null>(null);
  /** Rooms already asked, so reopening `/` does not re-fetch on every render.
   *  The install list does not change when a skill RUNS, so the fetch stays
   *  once per room. */
  const skillsFetchedRef = useRef<Set<string>>(new Set());

  /** ── sessions (plan/67 list/switch, plan/71 read-only transcript) ────────
   *  Per room, like every other workspace-scoped surface. `viewingId` is the
   *  session whose transcript is on screen for READING — it is deliberately
   *  separate from `liveId` (the session the Pi is running), because reading
   *  never switches. */
  const [sessionsByRoom, setSessionsByRoom] = useState<Record<string, readonly WireSessionInfo[]>>({});
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [sessionsNotice, setSessionsNotice] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewedEvents, setViewedEvents] = useState<readonly WireSessionEvent[] | null>(null);
  /** True while a `session_read` is in flight. STATE, not a ref read during
   *  render, so the viewer's spinner is render-safe. */
  const [sessionReadLoading, setSessionReadLoading] = useState(false);
  const sessionsReqRef = useRef<{ id: string; room: string } | null>(null);
  const sessionReadReqRef = useRef<{ id: string; room: string; sessionId: string } | null>(null);
  const sessionSwitchReqRef = useRef<{ id: string; room: string } | null>(null);
  /** "Now" for the session rows' relative ages. Held in state and refreshed
   *  on a timer rather than read during render, which keeps the render pure. */
  const [sessionClockRef, setSessionClock] = useState<number>(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setSessionClock(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);
  /** The ONE pending inline image (plan/30 allows one per message). Held as
   *  the wire shape (`data` base64 + `mime`) so send and the preview use the
   *  exact bytes that will travel. */
  const [attachment, setAttachment] = useState<WireImage | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /** Model state is PER ROOM, because the wire is: `list_models`, `model_set`
   *  and `thinking_set` all address ONE workspace Pi, so its catalogue,
   *  confirmed pick and thinking level must be keyed by that room. A single
   *  shared value would label the room you switched to with the previous
   *  room's model — and clearing it instead would lose a pick you already
   *  made. */
  const [modelOptionsByRoom, setModelOptionsByRoom] = useState<
    Record<string, readonly ModelOption[]>
  >({});
  const [thinkingByRoom, setThinkingByRoom] = useState<Record<string, ThinkingLevelId>>({});
  /** The last selection the HOST ACKNOWLEDGED with `action_ok`, per room. It is
   *  not a guess and not optimistic: it exists only after the Pi confirmed the
   *  switch. It covers the case the wire leaves open — `models_list.current`
   *  is `undefined` while the workspace Pi has no active session ctx — so the
   *  picker can still show what the user chose without inventing host state.
   *  A host-reported `current` always wins over it. */
  const [confirmedByRoom, setConfirmedByRoom] = useState<Record<string, ConfirmedModel>>({});
  /** The ACTIVE room's views into the per-room maps above. Declared after the
   *  state they read, and before any handler that closes over them. */
  const modelOptions: readonly ModelOption[] =
    activeRoom === null ? [] : (modelOptionsByRoom[activeRoom] ?? []);
  const thinking: ThinkingLevelId | null =
    activeRoom === null ? null : (thinkingByRoom[activeRoom] ?? null);
  const confirmedModel: ConfirmedModel | null =
    activeRoom === null ? null : (confirmedByRoom[activeRoom] ?? null);
  /** In-flight request ids, so a reply is matched to the action that asked for
   *  it. Proxied replies never settle a host-room RPC (they arrive through the
   *  child room), so correlation is explicit and local. */
  const modelReqRef = useRef<{ id: string; room: string; kind: "list" } | null>(null);
  const modelSetRef = useRef<{ id: string; room: string } | null>(null);
  const thinkingReqRef = useRef<{ id: string; room: string } | null>(null);
  /** Plan/68 skills: in-flight `pi_surface` / `skill_invoke` ids, correlated
   *  by (room + in_reply_to) exactly like the model surface. */
  const skillsReqRef = useRef<{ id: string; room: string } | null>(null);
  const skillInvokeRef = useRef<{ id: string; room: string } | null>(null);
  /** Latest `requestModels` closure, so a `model_set` success can re-list
   *  without depending on the callback identity inside the listener. */
  /** The row the user just picked, held until the Pi answers `action_ok`; only
   *  then does it become the confirmed selection shown by the picker. */
  const pendingModelChoiceRef = useRef<{
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    vision: boolean;
  } | null>(null);

  /** The one binding of THIS mount: adapter + its subscription handles. */
  const bindingRef = useRef<{ adapter: RemotePiAdapter; unsubs: (() => void)[] } | null>(null);
  /** Room the transcript is showing, readable from the message listener
   *  without re-subscribing on every room switch. */
  const activeRoomRef = useRef<string | null>(null);
  /** Mirror of `chatState` read by the message listener (same binding for the
   *  whole mount: no re-subscribe per turn). */
  const chatStateRef = useRef<ChatState>(initialChatState);
  /** Pending turn timer, bounded to the EXACT turn it was scheduled for:
   *  room + turn id + binding generation + adapter identity. A late firing for
   *  any other room/turn/generation/binding is ignored, and any room switch,
   *  reset or unmount clears it. */
  const chatTimerRef = useRef<{
    handle: ReturnType<typeof setTimeout>;
    roomId: string;
    id: string;
    generation: number;
    adapter: RemotePiAdapter;
  } | null>(null);
  /** Last published snapshot: phase/generation edges are detected here so a
   *  dropped connection invalidates every in-flight async owner. */
  const lastSnapshotRef = useRef<AdapterSnapshot | null>(null);
  /** Monotonic tokens: a superseded fs.list / workspace reply must not touch
   *  UI. `workspaceSeqRef` is SHARED by start/refresh/add/restart — they all
   *  write the same busy flag, so only the newest owner may clear it. */
  const fsListSeqRef = useRef(0);
  const workspaceSeqRef = useRef(0);
  const pairSeqRef = useRef(0);

  /** Drops the pending turn timer (idempotent). */
  const clearChatTimer = useCallback((): void => {
    const pending = chatTimerRef.current;
    chatTimerRef.current = null;
    if (pending !== null) clearTimeout(pending.handle);
  }, []);

  /** Synchronous reducer forwarder: ref first (so a same-tick reader sees the
   *  new state), React state second. A settled turn cancels the pending timer. */
  const dispatchChat = useCallback(
    (event: ChatEvent): void => {
      const next = reduceChat(chatStateRef.current, event);
      if (next === chatStateRef.current) return;
      chatStateRef.current = next;
      setChatState(next);
      const phase = next.active?.phase;
      const settled =
        next.active === null ||
        phase === "completed" ||
        phase === "error" ||
        phase === "timed_out" ||
        phase === "disconnected";
      if (settled) clearChatTimer();
    },
    [clearChatTimer],
  );

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

  /** Fixed session notices — never host text. */
  const SESSIONS_FAILED = "Could not read this workspace's sessions.";
  const SESSION_READ_FAILED = "Could not read that session.";
  /** A session transcript read is cheap, so the first page is a generous size. */
  const SESSION_READ_LIMIT = 50;

  /** `session_list` for the room on screen. Declared before the message
   *  listener that the `session_switch_ok` path re-lists through. */
  const requestSessions = useCallback(() => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null || adapter.getSnapshot().phase !== "connected") {
      return;
    }
    if (sessionsReqRef.current !== null) return;
    try {
      const id = adapter.listSessions(roomId);
      sessionsReqRef.current = { id, room: roomId };
      setSessionsBusy(true);
      setSessionsNotice(null);
    } catch {
      setSessionsNotice(SESSIONS_FAILED);
      setSessionsBusy(false);
    }
  }, []);

  /** `session_read` — READ one session's transcript. Never switches. */
  const handleSessionRead = useCallback((sessionId: string) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    try {
      const id = adapter.readSession(roomId, sessionId, { limit: SESSION_READ_LIMIT });
      sessionReadReqRef.current = { id, room: roomId, sessionId };
      setSessionReadLoading(true);
      setSessionsNotice(null);
    } catch {
      setSessionsNotice(SESSION_READ_FAILED);
    }
  }, []);

  /** `session_switch` — the ONLY control that changes the live session. */
  const handleSessionSwitch = useCallback((sessionId: string) => {
    const adapter = bindingRef.current?.adapter ?? null;
    const roomId = activeRoomRef.current;
    if (adapter === null || roomId === null) return;
    try {
      const id = adapter.switchSession(roomId, sessionId);
      sessionSwitchReqRef.current = { id, room: roomId };
      setSessionsNotice(null);
    } catch {
      setSessionsNotice(SWITCH_FAILED);
    }
  }, []);

  /** Opening a room starts a NEW transcript: reducer reset (active + history)
   *  and no pending timer from the previous room. */
  const openRoom = useCallback(
    (roomId: string) => {
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
      modelReqRef.current = null;
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
      requestSessions();
    },
    [dispatchChat, requestSessions],
  );

  /** Projects a catalogue onto the picker state. Shared by the wire reply and
   *  the cache hit, so both paths mark `current` identically. */
  const applyCatalogue = useCallback(
    (roomId: string, models: readonly WireModel[], current: WireModel | undefined) => {
      const rows = models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        reasoning: m.reasoning,
        vision: m.vision,
        contextWindow: m.context_window,
        current: current !== undefined && m.id === current.id && m.provider === current.provider,
      }));
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

  /** Fixed skill notices — never host text. */
  const SKILLS_FAILED = "Could not read this workspace's skills.";
  const SKILL_FAILED = "The host did not run that skill.";

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
  const resetChatState = useCallback(() => {
    clearChatTimer();
    dispatchChat({ type: "reset" });
    setDraft("");
    setQuery("");
  }, [clearChatTimer, dispatchChat]);

  /** Room-filtered transcript listener. Types are checked field by field; an
   *  unexpected shape is ignored rather than coerced into the transcript. */
  const onServerMessage = useCallback((msg: ServerMessage, room: string) => {
    if (room !== activeRoomRef.current) return;

    /* ── model surface replies ────────────────────────────────────────────
       These arrive through the SAME proxied child room as chat, so they are
       correlated by (room + in_reply_to) against the ids this container
       minted. A reply for an unknown/older id is ignored rather than applied
       to the current selection. */
    if (msg.type === "models_list") {
      const pending = modelReqRef.current;
      if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
      if (!isModelsListOk(msg)) return;
      modelReqRef.current = null;
      applyCatalogue(room, msg.models, msg.current);
      setModelBusy(false);
      setModelNotice(null);
      return;
    }

    if (msg.type === "pi_surface_ok") {
      const pending = skillsReqRef.current;
      if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
      if (!isPiSurfaceOk(msg)) return;
      skillsReqRef.current = null;
      applySkills(room, msg.skills);
      setSkillsBusy(false);
      setSkillsNotice(null);
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
      setSessionsBusy(false);
      setSessionsNotice(null);
      return;
    }

    if (msg.type === "session_read_ok") {
      const pending = sessionReadReqRef.current;
      if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
      if (!isSessionReadOk(msg)) return;
      sessionReadReqRef.current = null;
      // READ-ONLY: this populates the viewer and never touches `chatState`, so
      // the live session and the live transcript are both left alone.
      setViewingId(msg.session_id);
      setViewedEvents(msg.events);
      setSessionReadLoading(false);
      setSessionsNotice(null);
      return;
    }

    if (msg.type === "session_switch_ok") {
      const pending = sessionSwitchReqRef.current;
      if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
      if (!isSessionSwitchOk(msg)) return;
      sessionSwitchReqRef.current = null;
      // The host reset its mirror for the new session, so the live transcript
      // is gone: clear ours too and re-list so the new `live` badge is right.
      setSessionsNotice(null);
      setViewedEvents(null);
      setViewingId(null);
      setSessionReadLoading(false);
      resetChatState();
      requestSessions();
      return;
    }

    if (msg.type === "session_switch_error") {
      const pending = sessionSwitchReqRef.current;
      if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return;
      if (!isSessionSwitchError(msg)) return;
      sessionSwitchReqRef.current = null;
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
            bindingRef.current?.adapter.confirmCachedModel(room, chosen.provider, chosen.id);
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

    // No optimistic echo: the reducer only reveals a turn once the host
    // confirms it, and only when room+id match the ACTIVE turn exactly —
    // anything else is ignored rather than merged into the transcript.
    if (msg.type === "user_message") {
      if (typeof msg.id !== "string") return;
      dispatchChat({ type: "echo", roomId: room, id: msg.id });
      return;
    }
    if (msg.type === "agent_chunk") {
      if (typeof msg.in_reply_to !== "string" || typeof msg.delta !== "string") return;
      dispatchChat({ type: "chunk", roomId: room, id: msg.in_reply_to, delta: msg.delta });
      return;
    }
    if (msg.type === "agent_done") {
      if (typeof msg.in_reply_to !== "string") return;
      dispatchChat({ type: "done", roomId: room, id: msg.in_reply_to });
      return;
    }
    if (msg.type === "action_error") {
      if (typeof msg.in_reply_to !== "string") return;
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
  }, [applyCatalogue, applySkills, dispatchChat, markRowCurrent, requestSessions, resetChatState]);

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
      return;
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
    // A same-connection child push (`workspace_state`) is NOT a chat edge: the
    // transcript is left exactly as the reducer left it.
  }, [dispatchChat, resetChatState]);

  /** ONE adapter per mount; a fresh one only after an explicit forget. */
  const ensureAdapter = useCallback((): RemotePiAdapter => {
    const current = bindingRef.current;
    if (current !== null) return current.adapter;
    const adapter = new RemotePiAdapter({ deviceName: DEVICE_NAME });
    const unsubs = [
      adapter.subscribe(onSnapshot),
      adapter.onServerMessage(onServerMessage),
      adapter.onDiagnostic(() => setLocalError(RELAY_NOTICE)),
    ];
    bindingRef.current = { adapter, unsubs };
    return adapter;
  }, [onServerMessage, onSnapshot]);

  /** Mount: subscribe, restore a stored pairing (the adapter reads storage
   *  itself), and on unmount release every subscription and dispose — the
   *  stored pairing stays on disk, and the socket is never "closed" as a
   *  side effect of navigating away. */
  useEffect(() => {
    const adapter = ensureAdapter();
    // `restore()` reports through the snapshot; an in-flight phase is what the
    // launcher renders as "restoring". No state is set synchronously here.
    void adapter.restore();
    return () => {
      // Fence every pending action reply before the binding goes away: an
      // answer that lands after unmount must not touch a dead tree.
      fsListSeqRef.current += 1;
      workspaceSeqRef.current += 1;
      pairSeqRef.current += 1;
      clearChatTimer();
      dispatchChat({ type: "reset" });
      const live = releaseBinding();
      live?.dispose();
    };
  }, [clearChatTimer, dispatchChat, ensureAdapter, releaseBinding]);

  // ── derived from the adapter snapshot (never from local guesses) ─────────

  const phase: ConnectionPhase = snapshot?.phase ?? "idle";
  const connected = phase === "connected";
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
      if (confirmed) openRoom(confirmed.room_id);
      else setLocalError(START_FAILED);
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

  /** Submit one turn. No optimistic echo: the reducer hides the turn until the
   *  host confirms it with an exact echo, so nothing is drawn from the draft.
   *  The draft is cleared ONLY after the send was accepted (a synchronous throw
   *  keeps the text in place and reports a fixed failure). */
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
  const chat: TranscriptChatItem[] = visibleChatItems(chatState).map(
    (item): TranscriptChatItem => {
      if (item.kind === "user") return { kind: "user", id: item.id, text: item.text };
      return {
        kind: "agent",
        id: item.id,
        text: item.text,
        done: item.phase === "completed",
        status: chatItemStatus(item.phase),
      };
    },
  );
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
  const sessionsDisabledReason = !connected
    ? MODEL_NOT_CONNECTED
    : activeRoom === null || !(activeWorkspace?.live ?? false)
      ? MODELS_FOR_LIVE_WORKSPACE
      : null;
  /** The session open for READING, or null. Resolved from the CURRENT list, so
   *  a row the host no longer reports closes the viewer instead of showing a
   *  stale transcript. */
  const viewingSession =
    viewingId === null ? null : (sessions.find((s) => s.id === viewingId) ?? null);

  /** `list_models` for the room on screen. Fire-and-forget like chat; the
   *  reply is correlated by (room + id) in `onServerMessage`.
   *
   *  A still-fresh catalogue for this exact source is adopted WITHOUT wire
   *  traffic, so reopening the picker does not repeat the round trip. A
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
  const fileToWireImage = useCallback(async (file: File): Promise<WireImage> => {
    const rawBase64 = async (): Promise<WireImage> => {
      const buffer = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return { data: btoa(binary), mime: file.type };
    };
    if (typeof document === "undefined") return rawBase64();
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode failed"));
        el.src = url;
      });
      const MAX_EDGE = 1568; // Anthropic's recommended long-edge bound
      const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (ctx === null) return rawBase64();
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) return rawBase64();
      return { data: dataUrl.slice(comma + 1), mime: "image/jpeg" };
    } catch {
      return rawBase64();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);

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
    [fileToWireImage],
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
      sessions,
      sessionsBusy,
      sessionsDisabledReason,
      sessionViewingId: viewingId,
      sessionLiveId: sessions.find((s) => s.live)?.id ?? null,
      sessionsNotice,
      onSessionsRefresh: requestSessions,
      onSessionRead: handleSessionRead,
      onSessionSwitch: handleSessionSwitch,
      now: sessionClockRef,
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
    },
  };

  return <RemotePiShell {...shellProps} />;
}
