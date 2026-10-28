"use client";

/* Middle column: workspace header (nav + status), transcript, composer.
 * Visual source: docs/web_app/原型/index.html (.main) + styles.css §7.
 *
 * USER bubbles are plain text nodes (never `dangerouslySetInnerHTML`). The
 * AGENT half goes through `./markdown`, which is the single audited place wire
 * text becomes markup: no raw HTML, protocol-checked links, plain code blocks.
 */
import { useCallback, useEffect, memo, useState, type FormEvent, type KeyboardEvent } from "react";

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
 *  reported as such instead of being drawn as a live stream. */
export type ChatItemStatus = "streaming" | "complete" | "failed";

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
  failed: "did not finish",
};

/* Fixed, client-authored composer reasons: a locked composer always says WHY,
   and the text never comes from the host. */
const COMPOSER_BUSY_REASON =
  "A turn is still in flight — wait for it to finish before sending another.";
const COMPOSER_NO_WORKSPACE_REASON = "Select a workspace on the left before sending a message.";

/** Fixed retry warning: retry is explicit and one-shot, so the risk is stated
 *  next to the button instead of being hidden. */
const RETRY_WARNING = "Retry sends a new request and may run the task twice.";

/** Fixed, client-authored reason for an inert empty-state Browse action: below
 *  the dock breakpoint there is no dock to open, so the button states that
 *  instead of dropping the next action silently. */
const BROWSE_UNAVAILABLE_REASON =
  "The file dock is not available at this width — widen the window to browse the host filesystem.";

/** Uniform tail for a disabled composer control's description: the reason says
 *  WHY the surface is absent, this says that the control is inert. Fixed
 *  client text, never host text. */
const DISABLED_CONTROL_SUFFIX = "Disabled — this control is not wired.";

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
  host,
  streaming,
  chat,
  draft,
  onDraftChange,
  onSend,
  chatNotice,
  chatBusy,
  retryAvailable,
  onRetry,
  onBrowseFiles,
  browseFilesAvailable,
  resuming,
  activityStats,
  usageStats,
  tools,
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
  /* Composer lock: the reducer's own busy flag first, then the absence of a
     selected workspace. The reason is fixed client text, never a guess. */
  const composerReason = chatBusy
    ? COMPOSER_BUSY_REASON
    : workspacePath === null
      ? COMPOSER_NO_WORKSPACE_REASON
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

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashOpen) return;
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
      }
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
            {workspaceName ?? "No workspace selected"}
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
              <StatusPill label="streaming" tone="busy" title="A reply is arriving" />
            ) : null}
          </span>
        )}

        {/* Target ring. "Chat" is the only wired target; "Trajectory" is
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
            {compact ? null : "Trajectory"}
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
                title="Reopening this session…"
                detail="The workspace's Pi is restarting to open this session. Its history appears here as soon as it is back — nothing was lost."
              />
            ) : (
              <EmptyState
                icon="cpu"
                title="What should the agent work on?"
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
                    Browse the host filesystem
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
              aria-label="Jump to the latest content"
              title="Jump to the latest content"
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
            aria-label="Chat status"
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
                  Retry
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
            aria-label="Message to the agent"
            aria-describedby="transcript-composer-status"
            title={composerReason ?? undefined}
            /*
             * Keep the placeholder generic and let the status line below carry
             * the lock reason. Repeating the same sentence in both places was
             * showing the identical text twice in one composer.
             */
            placeholder={
              composerEnabled
                ? "Describe a task — the agent works in the session's workspace…"
                : "Message the agent…"
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
                  ? "Attachments — one image is attached"
                  : (attachmentDisabledReason ?? "Attach one image to this message")
              }
              className={`${css.attachLabel} ${attachDisabled ? css.attachDisabled : css.attachEnabled}`}
            >
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Attachments"
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
                  aria-label="Remove the attached image"
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
              aria-label="Tool cards"
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
              aria-label="Slash commands — list this workspace's skills"
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
            <button
              type="submit"
              disabled={!composerEnabled || draft.trim().length === 0}
              aria-describedby="transcript-composer-status"
              title={composerReason ?? "Send the message"}
              className={css.sendButton}
            >
              <Icon name="send" size={15} />
              Send
              <span className="sr-only">Send the message</span>
            </button>
          </div>
          {/* Persistent descriptions for the three disabled composer
              controls above. Kept in the DOM while the buttons are disabled
              (a disabled control is not focusable, so `aria-describedby` is
              how the fixed reason stays reachable for AT). */}
          <span id="composer-capability-upload" className="sr-only">
            {attachmentDisabledReason ??
              "Attach one image to this message inline. Disabled while the selected model does not accept images."}
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
              : "Use Send to submit. Enter/Shift+Enter editing is not wired to the composer yet."}
        </p>
      </div>
        </>
      )}
    </section>
  );
}
