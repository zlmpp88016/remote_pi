"use client";

/* Middle column: workspace header (nav + status), transcript, composer.
 * Visual source: docs/web_app/原型/index.html (.main) + styles.css §7.
 *
 * USER bubbles are plain text nodes (never `dangerouslySetInnerHTML`). The
 * AGENT half goes through `./markdown`, which is the single audited place wire
 * text becomes markup: no raw HTML, protocol-checked links, plain code blocks.
 */
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";

import { Icon } from "./icons";
import { Markdown } from "./markdown";
import { ModelPicker, type ModelOption, type ThinkingLevelId } from "./model-picker";
import { SessionViewer } from "./session-viewer";
import { SlashMenu, filterSkills, slashQueryOf, type SkillOption } from "./slash-menu";
import type { WireSessionEvent } from "@/lib/remote-pi/protocol";
import type { WireSessionInfo } from "@/lib/remote-pi/sessions";
import { EmptyState, StatusPill } from "./states";
import { capability, type ChatItem } from "./view-model";
import type { ChatTool } from "@/lib/remote-pi/chat";

const EMPTY_SKILLS: readonly SkillOption[] = [];

/** Minimal per-turn status the panel may draw. Optional and text-free: it
 *  carries no error code and no wire string, so a turn that did not finish is
 *  reported as such instead of being drawn as a live stream. */
export type ChatItemStatus = "streaming" | "complete" | "failed";

/** `ChatItem` plus that optional status; a plain `ChatItem` stays assignable,
 *  so the existing mapping keeps working unchanged. */
export type TranscriptChatItem = ChatItem & { status?: ChatItemStatus };

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
      className="pointer-events-none absolute inset-y-0 left-1.5 flex w-11 flex-col items-center justify-center gap-[5px]"
    >
      {Array.from({ length: Math.min(count, 24) }, (_, index) => (
        <span
          key={index}
          className={
            index === count - 1
              ? "h-[3px] w-[23px] rounded-full bg-[#d4d4d4]"
              : "h-[3px] w-[14px] rounded-full bg-white/20"
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
    <section className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto_auto] bg-transparent">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <header className="flex h-12 min-w-0 items-center gap-2.5 border-b border-white/10 px-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <b
            className="max-w-[34ch] truncate text-[14px] font-semibold tracking-[-0.01em] text-white"
            style={{ fontFamily: "var(--ff-display)" }}
          >
            {workspaceName ?? "No workspace selected"}
          </b>
          {/* Secondary label: dropped when the frame is compact so the header
              never stacks into an unreadable sliver. */}
          {workspacePath && !compact ? (
            <span className="max-w-[22ch] truncate font-mono text-[11px] text-[#a3a3a3]">
              {workspacePath}
            </span>
          ) : null}
        </div>

        <span className="flex-1" />

        {compact ? null : (
          <span className="flex shrink-0 items-center gap-1.5">
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
        <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.045] p-0.5">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-[12.5px] font-medium text-white">
            <Icon name="msg" size={14} />
            Chat
          </span>
          <button
            type="button"
            disabled
            title={`Trajectory — ${capability("trajectory").reason}`}
            className="inline-flex h-6 cursor-not-allowed items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-[#6b6b6b]"
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
        <div className="col-span-1 row-span-3 min-h-0">
          <SessionViewer
            session={viewingSession.session}
            events={viewingSession.events}
            loading={viewingSession.loading}
            notice={viewingSession.notice}
            isLive={viewingSession.isLive}
            onClose={onCloseSessionView}
            onSwitch={onSwitchToViewedSession}
          />
        </div>
      ) : (
        <>
      {/* ── transcript ───────────────────────────────────────────────────── */}
      <div className="relative grid min-h-0 grid-cols-1">
        <div className="min-h-0 overflow-y-auto overflow-x-hidden">
          <AnchorRail count={userTurns} />
          {/* Center padding from CSS breakpoints (matches the grid frame):
              >1023 → 70px, <=1023 → 52/24, <=760 → 38/16. */}
          <div className="mx-auto grid max-w-[848px] gap-0.5 px-[70px] pb-8 pt-5 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4">
            {hasTurns ? (
              chat.map((item, index) =>
                item.kind === "user" ? (
                  <div key={`u-${item.id}-${index}`} className="flex justify-end py-2">
                    <div className="max-w-[88%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-[14px_14px_4px_14px] border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-[14.5px] leading-relaxed text-white">
                      {item.text}
                    </div>
                  </div>
                ) : (
                  <div key={`a-${item.id}-${index}`} className="grid gap-2.5 py-2">
                    <div className="flex items-center gap-2 text-[12px] text-[#a3a3a3]">
                      <span className="grid size-5 place-items-center rounded-md border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[#4fc3f7]">
                        <Icon name="cpu" size={12} />
                      </span>
                      <b
                        className="text-[12px] font-semibold text-[#a3a3a3]"
                        style={{ fontFamily: "var(--ff-display)" }}
                      >
                        Pi
                      </b>
                      <span className="font-mono text-[10.5px]">
                        {agentStatusLabel(item)}
                      </span>
                    </div>
                    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                      <Markdown text={item.text} />
                      {isLiveItem(item) ? (
                        <span className="ml-0.5 inline-block h-[13px] w-[7px] animate-pulse bg-[#4fc3f7] align-[-2px]" />
                      ) : null}
                    </div>
                  </div>
                ),
              )
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
                    className="inline-flex h-[38px] items-center gap-2 rounded-[14px] border border-white/15 bg-white/[0.045] px-3.5 font-mono text-[12.5px] text-[#d4d4d4] transition hover:border-[rgba(79,195,247,0.3)] disabled:cursor-not-allowed disabled:border-white/10 disabled:text-[#a3a3a3] disabled:hover:border-white/10"
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
        </div>
      </div>

      {/* ── tool cards ─────────────────────────────────────────────────────
           Pi's `tool_request`/`tool_result` stream, as reported. Args and
           result are plain text (JSON.stringify / the raw string); nothing is
           interpreted or injected as HTML. */}
      {tools.length > 0 ? (
        <div className="px-[70px] max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4">
          <div className="mx-auto flex max-w-[848px] flex-wrap gap-1.5 pb-2">
            {tools.map((tool) => (
              <details
                key={tool.id}
                className="group min-w-0 max-w-full flex-1 basis-[260px] rounded-[10px] border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] text-[#d4d4d4]">
                  <span className="grid size-[15px] shrink-0 place-items-center text-[#4fc3f7]">
                    <Icon name="term" size={12} />
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-white">{tool.tool}</span>
                  <span
                    className={`ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] ${
                      tool.outcome === null
                        ? "text-[#a3a3a3]"
                        : tool.outcome.ok
                          ? "text-[#5fd38a]"
                          : "text-[#f25a5a]"
                    }`}
                  >
                    {tool.outcome === null ? "running" : tool.outcome.ok ? "done" : "failed"}
                  </span>
                </summary>
                {tool.argsText !== "" ? (
                  <pre className="mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-[#a3a3a3]">
                    {tool.argsText}
                  </pre>
                ) : null}
                {tool.outcome !== null && tool.outcome.ok && tool.outcome.resultText !== "" ? (
                  <pre className="mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-[#d4d4d4]">
                    {tool.outcome.resultText}
                  </pre>
                ) : null}
              </details>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── composer ─────────────────────────────────────────────────────── */}
      <div className="px-[70px] pb-4.5 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4">
        {/* Fixed chat notice for a settled turn + the explicit retry, when the
            reducer offers one. No automatic resend is wired here. */}
        {showNotice ? (
          <div
            role="note"
            aria-label="Chat status"
            className="mx-auto mb-3 flex max-w-[848px] flex-wrap items-center gap-2 rounded-[14px] border border-white/15 bg-white/[0.03] px-3.5 py-2.5"
          >
            {chatNotice !== null ? (
              <span className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-[#d4d4d4]">
                <Icon name="alert" size={15} />
                {chatNotice}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {showRetry ? (
              <span className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  aria-describedby="transcript-retry-warning"
                  title={RETRY_WARNING}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-[10px] border border-white/15 bg-white/[0.045] px-3 text-[12.5px] font-semibold text-white transition hover:border-[rgba(79,195,247,0.3)]"
                >
                  <Icon name="refresh" size={14} />
                  Retry
                </button>
                <span
                  id="transcript-retry-warning"
                  className="max-w-[30ch] font-mono text-[10.5px] leading-snug text-[#d4d4d4]"
                >
                  {RETRY_WARNING}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
        <form
          onSubmit={onSend}
          className="relative mx-auto max-w-[848px] rounded-[20px] border border-white/15 bg-[rgba(255,255,255,0.02)] shadow-[0_10px_30px_-18px_rgba(0,0,0,0.45)] transition focus-within:border-[rgba(79,195,247,0.3)]"
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
            placeholder={
              composerEnabled
                ? "Describe a task — the agent works in the session's workspace…"
                : (composerReason ?? undefined)
            }
            spellCheck={false}
            className="max-h-[200px] min-h-[44px] w-full max-w-full min-w-0 resize-none bg-transparent px-3.5 pt-3 text-[14.5px] leading-relaxed break-words [overflow-wrap:anywhere] text-white outline-none placeholder:text-[#a3a3a3] disabled:cursor-not-allowed disabled:opacity-60"
          />
          {/* The toolbar wraps instead of overflowing when the labels and the
              Send action no longer fit on one line. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-2">
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
              className={`inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] ${
                attachDisabled
                  ? "cursor-not-allowed text-[#a3a3a3]"
                  : "cursor-pointer text-[#d4d4d4] transition hover:bg-white/10"
              }`}
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
                  className="font-mono text-[10.5px] text-[#5fd38a] hover:text-white"
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
              className="inline-flex h-7 cursor-not-allowed items-center rounded-[10px] border-0 bg-transparent px-2.5 text-[12px] text-[#a3a3a3]"
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
              className="inline-flex h-7 items-center rounded-[10px] border-0 bg-transparent px-2.5 text-[12px] text-[#d4d4d4] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[#a3a3a3] disabled:hover:bg-transparent"
            >
              <Icon name="slash" size={15} />
            </button>
            <span className="flex-1" />
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
              onThinkingChange={onThinkingChange}
            />
            <button
              type="submit"
              disabled={!composerEnabled || draft.trim().length === 0}
              aria-describedby="transcript-composer-status"
              title={composerReason ?? "Send the message"}
              className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] bg-[#4fc3f7] px-3 text-[12.5px] font-semibold text-[#04222e] transition hover:bg-[#7ad4fa] disabled:cursor-not-allowed disabled:opacity-40"
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
        {/* The composer always states its state: a locked composer reports the
            fixed reason, an enabled one reports what is still not wired. */}
        <p
          id="transcript-composer-status"
          className="mx-auto mt-1.5 max-w-[848px] text-center font-mono text-[11px] text-[#a3a3a3]"
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
