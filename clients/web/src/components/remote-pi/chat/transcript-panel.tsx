"use client";

/* Middle column: workspace header (nav + status), transcript, composer.
 * Visual source: docs/web_app/原型/index.html (.main) + styles.css §7.
 *
 * USER bubbles are plain text nodes (never `dangerouslySetInnerHTML`). The
 * AGENT half goes through `./markdown`, which is the single audited place wire
 * text becomes markup: no raw HTML, protocol-checked links, plain code blocks.
 */
import { useCallback, useEffect, memo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Icon } from "../core/icons";
import { Slot } from "../core/slots";
import { Markdown } from "./markdown";
import { ModelPicker, type ModelOption, type ThinkingLevelId } from "./model-picker";
import { SessionViewer } from "../sessions/session-viewer";
import { SlashMenu, filterSkills, slashQueryOf, type SkillOption } from "./slash-menu";
import type { WireSessionEvent } from "@/lib/remote-pi/protocol";
import type { WireSessionInfo } from "@/lib/remote-pi/sessions";
import { EmptyState, StatusPill } from "../layout/states";
import { MessageFooter } from "./message-footer";
import { StatsPills, type ActivityStats, type UsageSummaryStats } from "./stats-pills";
import { TurnDivider } from "./turn-divider";
import { capability, type ChatItem } from "../core/view-model";
import { useScrollFollow } from "../core/use-scroll-follow";
import css from "./transcript-panel.module.css";
import type { ChatTool } from "@/lib/remote-pi/chat";

const EMPTY_SKILLS: readonly SkillOption[] = [];

/** Minimal per-turn status the panel may draw. Optional and text-free: it
 *  carries no error code and no wire string, so a turn that did not finish is
 *  reported as such instead of being drawn as a live stream. `cancelled` is
 *  kept separate from `failed`: the user stopped it deliberately. */
export type ChatItemStatus = "streaming" | "complete" | "cancelled" | "failed";

/** `ChatItem` plus that optional status; a plain `ChatItem` stays assignable,
 *  so the existing mapping keeps working unchanged. */
/** Per-turn totals carried alongside the agent item, so the panel can render a
 *  turn divider and a message footer WITHOUT reaching back into the reducer.
 *  Every field is optional: a turn whose host never reported usage keeps
 *  `undefined` and the UI omits that reading instead of printing zero. */
export interface TranscriptTurnStats {
  /** 1-based turn number within the transcript. */
  index: number;
  /** Elapsed milliseconds from the user message to the last assistant reply,
   *  or `null` when the turn never settled. */
  elapsedMs: number | null;
  /** Formatted total tokens for the turn (e.g. `9.3K`), or `null`. */
  totalTokensText: string | null;
  /** Local `YYYY-MM-DD HH:mm:ss` of the last assistant message, or `null`. */
  clock: string | null;
  /** Whether this turn ended in a failure. */
  failed: boolean;
}

export type TranscriptChatItem = ChatItem & {
  status?: ChatItemStatus;
  stats?: TranscriptTurnStats;
};

/** The agent half of the transcript, as the panel draws it. */
type TranscriptAgentItem = Extract<TranscriptChatItem, { kind: "agent" }>;

const CHAT_STATUS_LABEL: Record<ChatItemStatus, string> = {
  streaming: "streaming…",
  complete: "complete",
  cancelled: "stopped by you",
  failed: "did not finish",
};

/* Fixed, client-authored composer reasons: a locked composer always says WHY,
   and the text never comes from the host. */
const COMPOSER_BUSY_REASON =
  "A turn is still in flight — press Stop to end it, or wait for it to finish.";
const COMPOSER_NO_WORKSPACE_REASON = "请先在左侧选择工作区再发送消息。";
/* A running workspace is NOT enough: with no active model the turn opens, the
   user's text appears in the transcript, and no reply can ever stream back. */
const COMPOSER_MODEL_REQUIRED =
  "发送前请先选择模型 — 工作区正在运行，但尚未激活任何模型。";
const COMPOSER_MODELS_PENDING = "正在加载该工作区的模型…";

/** Fixed retry warning: retry is explicit and one-shot, so the risk is stated
 *  next to the button instead of being hidden. */
const RETRY_WARNING = "重试会重新发起请求，任务可能执行两次。";

/** Fixed, client-authored reason for an inert empty-state Browse action: below
 *  the dock breakpoint there is no dock to open, so the button states that
 *  instead of dropping the next action silently. */
const BROWSE_UNAVAILABLE_REASON =
  "该宽度下文件停靠栏不可用 — 请加宽窗口以浏览主机文件系统。";

/** Uniform tail for a disabled composer control's description: the reason says
 *  WHY the surface is absent, this says that the control is inert. Fixed
 *  client text, never host text. */
const DISABLED_CONTROL_SUFFIX = "已禁用 — 该控件尚未接线。";

/** Fixed label for an agent item: the status wins when supplied, otherwise the
 *  legacy `done` flag. Never wire text. */
function agentStatusLabel(item: TranscriptAgentItem): string {
  if (item.status !== undefined) return CHAT_STATUS_LABEL[item.status];
  return item.done ? "complete" : "streaming…";
}

/** True while an agent item is still arriving (cursor). */
function isLiveItem(item: TranscriptAgentItem): boolean {
  return item.status !== undefined ? item.status === "streaming" : !item.done;
}

/* ── transcript rows ─────────────────────────────────────────────────────
 * One memo component per row kind, keyed by TURN ID (never by array index).
 *
 * Why this matters: a streaming reply commits once per animation frame, and
 * without a memo boundary every commit re-rendered every row in the transcript
 * — and an index-carrying key changed whenever the list shifted, so React also
 * REMOUNTED rows that had not changed, throwing away their DOM and (for the
 * agent row) their parsed Markdown tree. `Markdown` is itself memoised on
 * `text`, so with a stable key a frame that touches turn N now re-renders turn
 * N only and leaves the rest of the transcript untouched.
 */
const USER_ROW = css.userRow;
const USER_BUBBLE = css.userBubble;

const UserRow = memo(function UserRow({ text }: { text: string }) {
  return (
    <div className={USER_ROW}>
      <div className={USER_BUBBLE}>{text}</div>
    </div>
  );
});

const AgentRow = memo(function AgentRow({ item }: { item: TranscriptAgentItem }) {
  return (
    <div className={css.agentTurn}>
      <div className={css.agentHead}>
        <span className={css.agentMark}>
          <Icon name="cpu" size={12} />
        </span>
        <b
          className={css.agentName}
          style={{ fontFamily: "var(--ff-display)" }}
        >
          Pi
        </b>
        <span className={css.agentStatus}>{agentStatusLabel(item)}</span>
      </div>
      <div className={css.agentBody}>
        <Markdown text={item.text} />
        {isLiveItem(item) ? (
          <span className={css.caret} />
        ) : null}
      </div>
      {/*
       * The footer carries this message's own readings. It renders nothing when
       * the host reported neither usage nor a timestamp, so an old turn does not
       * grow a row of dashes.
       */}
      {item.stats !== undefined && !isLiveItem(item) ? (
        <MessageFooter
          totalText={item.stats.totalTokensText}
          clock={item.stats.clock}
          copyText={item.text}
        />
      ) : null}
      {/*
       * The turn divider closes the turn it summarises.
       *
       * DeepSeek Harness draws it as the turn's process HEADER, which in this
       * transcript is the same place: the rule separates a finished round from the
       * next user message below it. Rendering it here keeps the transcript map a
       * plain `item => row` projection, so no index ever reaches a `key`.
       */}
      {item.stats !== undefined && !isLiveItem(item) ? (
        <TurnDivider
          index={item.stats.index}
          elapsedMs={item.stats.elapsedMs}
          failed={item.stats.failed}
          foldable={false}
        />
      ) : null}
    </div>
  );
});

export interface TranscriptPanelProps {
  workspaceName: string | null;
  workspacePath: string | null;
  /**
   * Whether the model surface is ready to send with.
   *
   * `modelPending` distinguishes "the catalog is still arriving" from "the
   * catalog arrived and nothing is active": the first is a wait, the second is a
   * choice the user still has to make. Both block the composer.
   */
  modelPending: boolean;
  modelSelected: boolean;
  /** True when the selected workspace has a live Pi that can answer a message.
   *  The composer is locked otherwise: sending into a stopped workspace left the
   *  turn open forever, because the process that would have echoed it was gone. */
  workspaceLive: boolean;
  /** Fixed reason shown when `workspaceLive` is false. */
  workspaceNotRunningReason: string;
  host: { hostname: string; daemonVersion?: string; backend?: string };
  streaming: boolean;
  chat: readonly TranscriptChatItem[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  /**
   * Fixed, client-authored notice for the SETTLED turn of the room on screen
   * (a rejected action, a timeout or a dropped connection). Never host text.
   */
  chatNotice: string | null;
  /** True while the reducer owns an open turn: the composer is locked. */
  chatBusy: boolean;
  /** True when an open turn exists that a Stop control can abort. */
  cancelAvailable: boolean;
  /** Stops the open turn. The transcript settles only when the host confirms. */
  onCancel: () => void;
  /** True when the latest settled turn may be re-sent as a NEW request. */
  retryAvailable: boolean;
  /** Explicit, user-driven retry. There is no automatic resend anywhere. */
  onRetry: () => void;
  /** Opens the right dock on the file browser (empty-state next action). */
  onBrowseFiles: () => void;
  /**
   * True when the file dock is part of the frame at this viewport width
   * (`geometry.dockAvailable`). When false the empty-state Browse action is
   * inert and states the fixed reason instead of opening a dock that cannot
   * exist at this width.
   */
  browseFilesAvailable: boolean;
  /**
   * True while a resume is in flight.
   *
   * A `session_switch` restarts the workspace's Pi process, and while it starts
   * the transcript is genuinely empty — the history arrives a `session_history`
   * later. Without this flag that window renders the normal empty state ("What
   * should the agent work on?"), which reads as "this session has no history"
   * exactly when the user just asked to see it. Measured window: ~14s.
   */
  resuming: boolean;
  /**
   * Whole-session readings for the composer dock, already reduced from the same
   * turns the transcript shows. `null` readings inside them mean "the host
   * reported nothing", and the pill drops that part instead of printing zero.
   */
  activityStats: ActivityStats;
  usageStats: UsageSummaryStats;
  /**
   * True when the shell frame is narrow (viewport <= 1023px). The center
   * column padding is handled by CSS breakpoints; this flag only drops the
   * secondary header labels that would otherwise collide with each other.
   */
  /** Open tool calls are rendered as cards between the transcript and the
   *  composer: `tool_start`/`tool_end` as Pi reported them, args and result
   *  as PLAIN TEXT (never interpreted, never HTML). */
  tools: readonly ChatTool[];

  // ── attachments (plan/30 inline image) ────────────────────────────────────
  /** True when the ACTIVE model accepts images (`vision: true`). */
  attachmentAllowed: boolean;
  /** Fixed, client-authored reason the attach control is inert, or null. */
  attachmentDisabledReason: string | null;
  /** The pending image, for the preview chip; null when none is attached. */
  attachment: { data: string; mime: string } | null;
  /** Fixed failure text for the last attachment attempt, or null. */
  attachmentNotice: string | null;
  /** Receives the picked file (or null when the user dismisses the picker). */
  onAttach: (file: File | null) => void;
  onRemoveAttachment: () => void;
  compact?: boolean;

  // ── model / thinking (real wire: list_models / model_set / thinking_set) ──
  /** Rows for the model picker, as reported by the workspace Pi. */
  modelOptions: readonly ModelOption[];
  /** True while a model list/set request is in flight. */
  modelBusy: boolean;
  /** Model a `model_set` is switching to, or null. Rows are already known, so
   *  the picker stays usable while this is set. */
  modelSwitchTo: { name: string; reasoning: boolean } | null;
  /** Fixed, client-authored reason the picker cannot open, or null. */
  modelDisabledReason: string | null;
  /** Fixed notice for the last model action (never host text), or null. */
  modelNotice: string | null;
  /** Asks the workspace Pi for its models (opens the picker). */
  onModelOpen: () => void;
  /** Selects a model the Pi reported; provider/id are echoed back verbatim. */
  onModelSelect: (provider: string, modelId: string) => void;
  /** Current thinking level as the container tracks it, or null. */
  thinking: ThinkingLevelId | null;
  onThinkingChange: (level: ThinkingLevelId) => void;

  // ── read-only session view (plan/71) ─────────────────────────────────────
  /** When set, the transcript area shows THIS session's history read-only
   *  instead of the live conversation. Reading never changes the live session. */
  viewingSession: {
    session: WireSessionInfo;
    events: readonly WireSessionEvent[] | null;
    loading: boolean;
    notice: string | null;
    isLive: boolean;
    switchBusy: boolean;
    canSwitch: boolean;
  } | null;
  onCloseSessionView: () => void;
  onSwitchToViewedSession: () => void;

  // ── skills (real wire: pi_surface / skill_invoke) ─────────────────────────
  /** Installed skills of the ACTIVE room, as the workspace Pi reported them. */
  skills: readonly SkillOption[];
  /** True while the `pi_surface` request is in flight. */
  skillsBusy: boolean;
  /** Fixed, client-authored reason the slash menu cannot run a skill, or null. */
  skillsDisabledReason: string | null;
  /** Asks the workspace Pi for its skills (first time `/` opens the menu). */
  onSkillsOpen: () => void;
  /** Runs one skill the host reported. */
  onSkillPick: (name: string) => void;
}

/** Codex-style anchor rail: one stroke per turn, scroll-spy driven. */
function AnchorRail({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div
      aria-hidden="true"
      className={css.minimap}
    >
      {Array.from({ length: Math.min(count, 24) }, (_, index) => (
        <span
          key={index}
          className={
            index === count - 1 ? css.minimapLineActive : css.minimapLine
          }
        />
      ))}
    </div>
  );
}

export function TranscriptPanel({
  workspaceName,
  workspacePath,
  modelPending,
  modelSelected,
  workspaceLive,
  workspaceNotRunningReason,
  host,
  streaming,
  chat,
  draft,
  onDraftChange,
  onSend,
  chatNotice,
  chatBusy,
  cancelAvailable,
  onCancel,
  retryAvailable,
  onRetry,
  onBrowseFiles,
  browseFilesAvailable,
  resuming,
  activityStats,
  usageStats,
  attachmentAllowed,
  attachmentDisabledReason,
  attachment,
  attachmentNotice,
  onAttach,
  onRemoveAttachment,
  compact = false,
  modelOptions,
  modelBusy,
  modelSwitchTo,
  modelDisabledReason,
  modelNotice,
  onModelOpen,
  onModelSelect,
  thinking,
  onThinkingChange,
  viewingSession,
  onCloseSessionView,
  onSwitchToViewedSession,
  skills,
  skillsBusy,
  skillsDisabledReason,
  onSkillsOpen,
  onSkillPick,
}: TranscriptPanelProps) {
  const hasTurns = chat.length > 0;
  const userTurns = chat.filter((item) => item.kind === "user").length;
  /* Composer lock, in order of what the user must fix first:
     busy turn -> no workspace -> workspace not running -> no model.
     The reason is fixed client text, never a guess.

     A MODEL IS REQUIRED. Without this step a running workspace with no active
     model left the composer unlocked, so the message posted, the transcript
     showed the user's text, and the turn sat there forever: there was no model
     to stream a reply from. The workspace being live is necessary but NOT
     sufficient to send. */
  const composerReason = chatBusy
    ? COMPOSER_BUSY_REASON
    : workspacePath === null
      ? COMPOSER_NO_WORKSPACE_REASON
      : !workspaceLive
        ? workspaceNotRunningReason
        : modelPending
          ? COMPOSER_MODELS_PENDING
          : !modelSelected
            ? COMPOSER_MODEL_REQUIRED
            : null;
  const composerEnabled = composerReason === null;
  const showRetry = retryAvailable && !chatBusy;
  /* The attach control is inert unless the ACTIVE model accepts images; the
     fixed reason is what it states, so the control never silently does
     nothing. */
  const attachDisabled = !attachmentAllowed;
  /* One region for the settled-turn notice; the retry stays a separate,
     explicit control, and the locked-composer reason is announced by the
     composer's own status line (`aria-describedby`). */
  const showNotice = chatNotice !== null || showRetry;

  /* The transcript is a stream: follow new content only while the reader is
     already at the bottom. `data-chat-following-tail` carries that decision to
     CSS (it turns off `overflow-anchor` so the browser does not fight the
     programmatic scroll), and the same flag shows the jump-to-latest button. */
  const follow = useScrollFollow();
  /* The composer form, so a keypress can dispatch the SAME submit path the Send
     button uses instead of a second copy of the send logic. */
  const composerFormRef = useRef<HTMLFormElement | null>(null);

  /* ── slash menu ───────────────────────────────────────────────────────────
     The composer owns the trigger because it owns the draft text. A `/` at the
     very start opens the skill list; typing on filters it; Enter runs the
     highlighted one INSTEAD of sending. Once the draft contains a space (the
     user is typing args) or no row matches, the menu closes and the composer
     falls back to sending plain text — so a `/` never traps the input. */
  const [slashActiveRaw, setSlashActiveRaw] = useState(0);
  const slashQuery = slashQueryOf(draft);
  const slashMatches = slashQuery === null ? EMPTY_SKILLS : filterSkills(skills, slashQuery);
  /* The menu is open for the WHOLE slash line, including while the list is
     still arriving and when nothing matches — that is what lets it explain
     itself instead of silently vanishing. */
  const slashOpen = slashQuery !== null && composerEnabled;
  /* The list is CLAMPED AT RENDER rather than stored: filtering can shrink the
     list below the stored index, and fixing that up in an effect would cause a
     cascading render for something derivable. */
  const slashActive =
    slashMatches.length === 0 ? 0 : Math.min(slashActiveRaw, slashMatches.length - 1);

  /* Any edit restarts the highlight — the user is narrowing the list, so the
     previous row is no longer the one they were looking at. Doing this in the
     change handler (not an effect) keeps the render pure. */
  const updateDraft = useCallback(
    (value: string) => {
      setSlashActiveRaw(0);
      onDraftChange(value);
    },
    [onDraftChange],
  );

  /* The list is fetched LAZILY, the first time the menu opens: typing `/` is
     the user's own statement that they want it. */
  useEffect(() => {
    if (slashOpen) onSkillsOpen();
  }, [slashOpen, onSkillsOpen]);

  /** Runs the highlighted skill and reports whether the key was consumed. */
  function commitSkill(): boolean {
    if (skillsDisabledReason !== null || slashMatches.length === 0) return false;
    const picked = slashMatches[slashActive];
    if (picked === undefined) return false;
    onSkillPick(picked.name);
    setSlashActiveRaw(0);
    return true;
  }

  /* Enter sends, Shift+Enter inserts a newline.
   *
   * The submit goes through the FORM's own `onSubmit` (`requestSubmit`), never a
   * second copy of the send logic: `handleSend` owns the single-flight guard,
   * the local echo, the timeout and the draft clear, and duplicating any of it
   * here would let the two paths disagree.
   *
   * A disabled Send button is the same statement the user already sees, so the
   * key is swallowed rather than silently doing nothing — and `requestSubmit`
   * is skipped entirely while the composer is locked, because it would
   * otherwise fire the submit handler on a form the user was told is closed. */
  function submitFromKeyboard(): void {
    const form = composerFormRef.current;
    if (form === null || !composerEnabled) return;
    form.requestSubmit();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashOpen) {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submitFromKeyboard();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (slashMatches.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSlashActiveRaw((slashActive + delta + slashMatches.length) % slashMatches.length);
      return;
    }
    if (event.key === "Escape") {
      // Leave slash mode WITHOUT losing the draft, by appending a space: the
      // line is then no longer a slash query, so Enter sends it as text.
      event.preventDefault();
      updateDraft(`${draft} `);
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      if (commitSkill()) {
        event.preventDefault();
        return;
      }
      /* Nothing runnable yet. While the list is still ARRIVING, Enter is
         swallowed: the user is mid-command and sending `/team-rev` to the
         model as literal text is never what they meant. Once a real list is
         present and simply does not match, Enter falls through and sends —
         the menu has said so. */
      if (skillsBusy && skills.length === 0 && skillsDisabledReason === null) {
        event.preventDefault();
        return;
      }
      /* A real list is present but does not match the query: the menu has said
         so, and the user pressed Enter meaning to send. Fall through to the
         normal send path (Tab keeps its list-navigation meaning and stops). */
      if (event.key === "Tab") return;
      event.preventDefault();
      submitFromKeyboard();
    }
  }

  return (
    <section className={css.root}>
      {/* ── header ───────────────────────────────────────────────────────── */}
      <header className={css.header}>
        <div className={css.headerGroup}>
          <b
            className={css.sessionName}
            style={{ fontFamily: "var(--ff-display)" }}
          >
            {workspaceName ?? "未选择工作区"}
          </b>
          {/* Secondary label: dropped when the frame is compact so the header
              never stacks into an unreadable sliver. */}
          {workspacePath && !compact ? (
            <span className={css.sessionMeta}>
              {workspacePath}
            </span>
          ) : null}
        </div>

        <span className={css.spacer} />

        {compact ? null : (
          <span className={css.headerActions}>
            <StatusPill
              label={host.daemonVersion ? `host ${host.daemonVersion}` : "host"}
              tone="ok"
              title={`Connected to the host room${host.backend ? ` · Ed25519: ${host.backend}` : ""}`}
            />
            {streaming ? (
              <StatusPill label="streaming" tone="busy" title="回复正在到达" />
            ) : null}
          </span>
        )}

        {/* Target ring. "Chat" is the only wired target; "轨迹" is
            declared and inert because the host exposes no per-event records. */}
        <span className={css.viewToggle}>
          <span className={css.viewTabActive}>
            <Icon name="msg" size={14} />
            Chat
          </span>
          <button
            type="button"
            disabled
            title={`Trajectory — ${capability("trajectory").reason}`}
            className={css.viewTabDisabled}
          >
            <Icon name="branch" size={14} />
            {compact ? null : "轨迹"}
            <span className="sr-only">{capability("trajectory").reason}</span>
          </button>
        </span>
      </header>

      {/* ── read-only session view ────────────────────────────────────────
           Takes the transcript area when a session was opened for READING.
           The live conversation is untouched underneath — closing this restores
           it exactly as it was, because reading never wrote to `chatState`. */}
      {viewingSession !== null ? (
        /* The section grid has FOUR rows (auto / 1fr / auto / auto). The header
         * owns row 1, so the viewer spans the remaining three: the transcript
         * area, the notice row and the composer row. Unused rows collapse
         * because the viewer paints all of its own surface. */
        <div className={css.trajectorySlot}>
          <SessionViewer
            session={viewingSession.session}
            events={viewingSession.events}
            loading={viewingSession.loading}
            notice={viewingSession.notice}
            isLive={viewingSession.isLive}
            switchBusy={viewingSession.switchBusy}
            canSwitch={viewingSession.canSwitch}
            onClose={onCloseSessionView}
            onSwitch={onSwitchToViewedSession}
          />
        </div>
      ) : (
        <>
      {/* ── transcript ───────────────────────────────────────────────────── */}
      <div className={css.transcriptArea}>
        <div
          ref={follow.ref}
          onScroll={follow.onScroll}
          data-chat-following-tail={follow.following ? "" : undefined}
          className={css.transcriptScroll}
        >
          <AnchorRail count={userTurns} />
          <Slot name="chat.banner" />
          {/* Center padding from CSS breakpoints (matches the grid frame):
              >1023 → 70px, <=1023 → 52/24, <=760 → 38/16. */}
          <div className={css.transcriptInner}>
            {hasTurns ? (
              chat.map((item) =>
                item.kind === "user" ? (
                  <UserRow key={`u-${item.id}`} text={item.text} />
                ) : (
                  <AgentRow key={`a-${item.id}`} item={item} />
                ),
              )
            ) : resuming ? (
              /*
               * The resume window, said out loud.
               *
               * The workspace Pi is restarting to reopen this session; its
               * history arrives once the new process re-reads the file. Showing
               * the generic empty state here claimed the session was empty while
               * the user was waiting for exactly that history.
               */
              <EmptyState
                icon="cpu"
                title="正在重新打开该会话…"
                detail="该工作区的 Pi 正在重启以打开此会话。恢复后历史会立即显示 — 没有丢失任何内容。"
              />
            ) : (
              <EmptyState
                icon="cpu"
                title="让代理做什么？"
                detail={`This workspace has no turns yet. Pick a workspace on the left, or browse the host filesystem in the right dock and start a Pi in a directory. The host is ${host.hostname}.`}
                action={
                  <button
                    type="button"
                    onClick={onBrowseFiles}
                    disabled={!browseFilesAvailable}
                    title={browseFilesAvailable ? undefined : BROWSE_UNAVAILABLE_REASON}
                    className={css.browseButton}
                  >
                    <Icon name="folder" size={15} />
                    浏览主机文件系统
                    {browseFilesAvailable ? null : (
                      <span className="sr-only"> — {BROWSE_UNAVAILABLE_REASON}</span>
                    )}
                  </button>
                }
              />
            )}
          </div>
          <Slot name="chat.afterTranscript" />
        </div>
        {/* The jump-to-latest affordance appears ONLY while the reader has
            scrolled away from the newest content. It is positioned over the
            scroller rather than inside it, so it never scrolls away itself. */}
        {follow.following ? null : (
          <div className={css.jumpLayer}>
            <button
              type="button"
              onClick={follow.toBottom}
              aria-label="跳到最新内容"
              title="跳到最新内容"
              className={css.jumpButton}
            >
              <Icon name="chevD" size={15} />
            </button>
          </div>
        )}
      </div>

      {/* ── composer ─────────────────────────────────────────────────────── */}
      <div className={css.composerPad}>
        {/* Fixed chat notice for a settled turn + the explicit retry, when the
            reducer offers one. No automatic resend is wired here. */}
        {showNotice ? (
          <div
            role="note"
            aria-label="对话状态"
            className={css.noticeBox}
          >
            {chatNotice !== null ? (
              <span className={css.noticeText}>
                <Icon name="alert" size={15} />
                {chatNotice}
              </span>
            ) : (
              <span className={css.spacer} />
            )}
            {showRetry ? (
              <span className={css.noticeActions}>
                <button
                  type="button"
                  onClick={onRetry}
                  aria-describedby="transcript-retry-warning"
                  title={RETRY_WARNING}
                  className={css.retryButton}
                >
                  <Icon name="refresh" size={14} />
                  重试
                </button>
                <span
                  id="transcript-retry-warning"
                  className={css.retryWarning}
                >
                  {RETRY_WARNING}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className={css.composerForm}
        >
          {slashOpen ? (
            <div id="composer-slash-menu">
              <SlashMenu
                skills={skills}
                matches={slashMatches}
                busy={skillsBusy}
                disabledReason={skillsDisabledReason}
                query={slashQuery ?? ""}
                activeIndex={slashActive}
                onPick={onSkillPick}
                onHover={setSlashActiveRaw}
              />
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            role="combobox"
            aria-expanded={slashOpen}
            aria-controls={slashOpen ? "composer-slash-menu" : undefined}
            aria-activedescendant={slashOpen && slashMatches.length > 0 ? `slash-option-${slashActive}` : undefined}
            rows={1}
            disabled={!composerEnabled}
            aria-disabled={!composerEnabled}
            aria-label="发给代理的消息"
            aria-describedby="transcript-composer-status"
            title={composerReason ?? undefined}
            /*
             * Keep the placeholder generic and let the status line below carry
             * the lock reason. Repeating the same sentence in both places was
             * showing the identical text twice in one composer.
             */
            placeholder={
              composerEnabled
                ? "描述任务 — 代理会在会话所属工作区中执行…"
                : "给代理发消息…"
            }
            spellCheck={false}
            className={css.composerInput}
          />
          {/* The toolbar wraps instead of overflowing when the labels and the
              Send action no longer fit on one line. */}
          <div className={css.composerBar}>
            {/* Three disabled native buttons instead of icon spans: a button
                carries an accessible name + description for AT browsing. They
                are `disabled` and have no handler, so a native button is not
                tabbable and nothing can be triggered — the name and the fixed
                reason exist for assistive technology, not for focusability.
                The reason lives in a persistent sr-only element that also
                exists as the tooltip, so it is never title-only. */}
            {/* Attachments: a REAL file input (plan/30 inline image). Enabled
                only when the active model reports `vision: true`; otherwise
                the fixed reason is what the control states. */}
            <label
              title={
                attachment !== null
                  ? "附件 — 已附加一张图片"
                  : (attachmentDisabledReason ?? "为此消息附加一张图片")
              }
              className={`${css.attachLabel} ${attachDisabled ? css.attachDisabled : css.attachEnabled}`}
            >
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="附件"
                aria-describedby="composer-capability-upload"
                disabled={attachDisabled}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  onAttach(file);
                  // Allow re-picking the SAME file after an error.
                  event.target.value = "";
                }}
              />
              <Icon name="clip" size={15} />
              {attachment !== null ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="移除已附加的图片"
                  onClick={(event) => {
                    event.preventDefault();
                    onRemoveAttachment();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRemoveAttachment();
                    }
                  }}
                  className={css.skillHint}
                >
                  1 image ×
                </span>
              ) : null}
            </label>
            <button
              type="button"
              disabled
              aria-label="工具卡片"
              aria-describedby="composer-capability-tools"
              title={`Tool cards — ${capability("tools").reason}`}
              className={css.toolsButtonDisabled}
            >
              <Icon name="at" size={15} />
            </button>
            <button
              type="button"
              /* The / button now has something to do: it puts the composer into
                 slash mode. Keeping it as a real control (instead of a dead
                 icon) is what makes the skills menu discoverable. */
              disabled={!composerEnabled || draft !== ""}
              onClick={() => onDraftChange("/")}
              aria-label="斜杠命令 — 列出该工作区的技能"
              aria-describedby="composer-capability-palette"
              title={`Slash commands — ${capability("palette").reason}`}
              className={css.slashButton}
            >
              <Icon name="slash" size={15} />
            </button>
            <span className={css.spacer} />
            <ModelPicker
              options={modelOptions}
              busy={modelBusy}
              switchTo={modelSwitchTo}
              disabledReason={modelDisabledReason}
              notice={modelNotice}
              onOpen={onModelOpen}
              onSelect={onModelSelect}
              thinking={thinking}
              thinkingAvailable={
                modelSwitchTo !== null
                  ? modelSwitchTo.reasoning ||
                    modelOptions.some((o) => o.current && o.reasoning)
                  : modelOptions.some((option) => option.current && option.reasoning)
              }
              /* The SELECTED model's own levels. Read from the row that is current,
                 or from the row being switched to, so the control never offers a
                 level the model maps to `null`.

                 Falls back to the first row that HAS levels rather than to `options[0]`:
                 the catalogue starts with non-reasoning models, so `options[0]` would
                 report `undefined` and hide the control entirely. */
              thinkingLevels={
                modelOptions.find((option) => option.current)?.thinkingLevels ??
                modelOptions.find((option) => option.thinkingLevels !== undefined)
                  ?.thinkingLevels
              }
              onThinkingChange={onThinkingChange}
            />
            {/* The primary action is ONE slot that swaps identity with the turn
                state: Stop while a turn is open, Send otherwise. Keeping them
                in the same position means the control the user reaches for is
                always where they left it, and it removes the previous dead end
                where an in-flight turn could only be escaped by reloading.
                Stop carries no confirmation: re-sending is one keystroke. */}
            {cancelAvailable ? (
              <button
                type="button"
                onClick={onCancel}
                aria-describedby="transcript-composer-status"
                title="停止这轮对话 — 代理停止生成，已产出的回复会保留。"
                className={css.stopButton}
              >
                <Icon name="stop" size={15} />
                停止
                <span className="sr-only">停止当前回合</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!composerEnabled || draft.trim().length === 0}
                aria-describedby="transcript-composer-status"
                title={composerReason ?? "发送消息"}
                className={css.sendButton}
              >
                <Icon name="send" size={15} />
                发送
                <span className="sr-only">发送消息</span>
              </button>
            )}
          </div>
          {/* Persistent descriptions for the three disabled composer
              controls above. Kept in the DOM while the buttons are disabled
              (a disabled control is not focusable, so `aria-describedby` is
              how the fixed reason stays reachable for AT). */}
          <span id="composer-capability-upload" className="sr-only">
            {attachmentDisabledReason ??
              "为此消息附加一张图片。所选模型不支持图片时不可用。"}
          </span>
          <span id="composer-capability-tools" className="sr-only">
            {capability("tools").reason} {DISABLED_CONTROL_SUFFIX}
          </span>
          <span id="composer-capability-palette" className="sr-only">
            {capability("palette").reason}
          </span>
        </form>
        {/*
         * Statistics sit between the input and the status line, exactly where
         * DeepSeek Harness puts them. They are derived from the same turns the
         * transcript renders, so a reading here can never disagree with a bubble.
         *
         * The dock is wrapped in the SAME width constraint as the input above it.
         * Without it the pills filled `composerPad` instead: the composer stayed
         * centred at max 860px while the readings stretched the full column, so
         * they visibly drifted left of the input as the window widened.
         */}
        <div className={css.composerDock}>
          <StatsPills activity={activityStats} usage={usageStats} />
        </div>
        {/* The composer always states its state: a locked composer reports the
            fixed reason, an enabled one reports what is still not wired. */}
        <p
          id="transcript-composer-status"
          className={css.composerStatus}
        >
          {attachmentNotice !== null
            ? attachmentNotice
            : composerReason !== null
              ? composerReason
              : "回车发送 · Shift+回车换行。回复会流式写入上方记录。"}
        </p>
      </div>
        </>
      )}
    </section>
  );
}
