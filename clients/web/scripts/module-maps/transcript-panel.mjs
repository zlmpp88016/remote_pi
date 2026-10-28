/**
 * The className → semantic-class mapping for
 * `chat/transcript-panel.module.css`.
 *
 * This is the largest component surface, so the mapping doubles as the record of
 * which Tailwind utilities each semantic class replaced. `gen-module-css.mjs`
 * writes the stylesheet from this file and `verify-modules.mjs` re-derives it
 * from the un-pruned bridge, so the two can never drift.
 */
export default {
  file: "src/components/remote-pi/chat/transcript-panel.module.css",
  groups: [
    ["userRow", "flex justify-end py-2"],
    [
      "userBubble",
      "max-w-[88%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-[14px_14px_4px_14px] border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-[14.5px] leading-relaxed text-white",
    ],
    ["agentTurn", "grid gap-2.5 py-2"],
    ["agentHead", "flex items-center gap-2 text-[12px] text-[var(--muted)]"],
    [
      "agentMark",
      "grid size-5 place-items-center rounded-md border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[var(--accent)]",
    ],
    ["agentName", "text-[12px] font-semibold text-[var(--muted)]"],
    ["agentStatus", "font-mono text-[10.5px]"],
    ["agentBody", "min-w-0 break-words [overflow-wrap:anywhere]"],
    ["caret", "ml-0.5 inline-block h-[13px] w-[7px] animate-pulse bg-[var(--accent)] align-[-2px]"],
    [
      "minimap",
      "pointer-events-none absolute inset-y-0 left-1.5 flex w-11 flex-col items-center justify-center gap-[5px]",
    ],
    ["minimapLineActive", "h-[3px] w-[23px] rounded-full bg-[var(--ink-soft)]"],
    ["minimapLine", "h-[3px] w-[14px] rounded-full bg-white/20"],
    ["root", "grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto_auto] bg-transparent"],
    ["header", "flex h-12 min-w-0 items-center gap-2.5 border-b border-white/10 px-3.5"],
    ["headerGroup", "flex min-w-0 items-center gap-2.5"],
    ["sessionName", "max-w-[34ch] truncate text-[14px] font-semibold tracking-[-0.01em] text-white"],
    ["sessionMeta", "max-w-[22ch] truncate font-mono text-[11px] text-[var(--muted)]"],
    ["spacer", "flex-1"],
    ["headerActions", "flex shrink-0 items-center gap-1.5"],
    [
      "viewToggle",
      "flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.045] p-0.5",
    ],
    [
      "viewTabActive",
      "inline-flex h-6 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-[12.5px] font-medium text-white",
    ],
    [
      "viewTabDisabled",
      "inline-flex h-6 cursor-not-allowed items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-[var(--faint)]",
    ],
    ["trajectorySlot", "col-span-1 row-span-3 min-h-0"],
    ["transcriptArea", "relative grid min-h-0 grid-cols-1"],
    [
      "transcriptScroll",
      "min-h-0 overflow-y-auto overflow-x-hidden data-[chat-following-tail]:[overflow-anchor:none]",
    ],
    [
      "transcriptInner",
      "mx-auto grid max-w-[848px] gap-0.5 px-[70px] pb-8 pt-5 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4",
    ],
    [
      "browseButton",
      "inline-flex h-[38px] items-center gap-2 rounded-[14px] border border-white/15 bg-white/[0.045] px-3.5 font-mono text-[12.5px] text-[var(--ink-soft)] transition hover:border-[rgba(79,195,247,0.3)] disabled:cursor-not-allowed disabled:border-white/10 disabled:text-[var(--muted)] disabled:hover:border-white/10",
    ],
    ["jumpLayer", "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"],
    [
      "jumpButton",
      "pointer-events-auto grid size-8 place-items-center rounded-full border border-white/15 bg-[var(--bg-app)]/90 text-[var(--ink-soft)] shadow-lg backdrop-blur transition hover:border-white/25 hover:text-white",
    ],
    ["toolWrap", "px-[70px] max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4"],
    ["toolStrip", "mx-auto flex max-w-[848px] flex-wrap gap-1.5 pb-2"],
    [
      "toolCard",
      "min-w-0 max-w-full flex-1 basis-[260px] rounded-[10px] border border-white/10 bg-white/[0.03] px-2.5 py-1.5",
    ],
    ["toolSummary", "flex cursor-pointer list-none items-center gap-2 text-[12px] text-[var(--ink-soft)]"],
    ["toolIcon", "grid size-[15px] shrink-0 place-items-center text-[var(--accent)]"],
    ["toolName", "truncate font-mono text-[11.5px] text-white"],
    ["toolOutcome", "ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.06em]"],
    ["toolOutcomeIdle", "text-[var(--muted)]"],
    ["toolOutcomeOk", "text-[var(--ok)]"],
    ["toolOutcomeFail", "text-[var(--danger)]"],
    [
      "toolPre",
      "mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-[var(--muted)]",
    ],
    [
      "toolPreStrong",
      "mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-[var(--ink-soft)]",
    ],
    [
      "composerPad",
      "px-[70px] pb-4.5 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4",
    ],
    [
      "noticeBox",
      "mx-auto mb-3 flex max-w-[848px] flex-wrap items-center gap-2 rounded-[14px] border border-white/15 bg-white/[0.03] px-3.5 py-2.5",
    ],
    ["noticeText", "flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-[var(--ink-soft)]"],
    ["noticeActions", "flex shrink-0 items-center gap-2"],
    [
      "retryButton",
      "inline-flex h-[30px] items-center gap-1.5 rounded-[10px] border border-white/15 bg-white/[0.045] px-3 text-[12.5px] font-semibold text-white transition hover:border-[rgba(79,195,247,0.3)]",
    ],
    ["retryWarning", "max-w-[30ch] font-mono text-[10.5px] leading-snug text-[var(--ink-soft)]"],
    [
      "composerForm",
      "relative mx-auto max-w-[848px] rounded-[20px] border border-white/15 bg-[rgba(255,255,255,0.02)] shadow-[0_10px_30px_-18px_rgba(0,0,0,0.45)] transition focus-within:border-[rgba(79,195,247,0.3)]",
    ],
    [
      "composerInput",
      "max-h-[200px] min-h-[44px] w-full max-w-full min-w-0 resize-none bg-transparent px-3.5 pt-3 text-[14.5px] leading-relaxed break-words [overflow-wrap:anywhere] text-white outline-none placeholder:text-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60",
    ],
    ["composerBar", "flex min-w-0 flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-2"],
    ["attachLabel", "inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[12px]"],
    ["attachDisabled", "cursor-not-allowed text-[var(--muted)]"],
    ["attachEnabled", "cursor-pointer text-[var(--ink-soft)] transition hover:bg-white/10"],
    ["skillHint", "font-mono text-[10.5px] text-[var(--ok)] hover:text-white"],
    ["toolsButtonDisabled", "inline-flex h-7 cursor-not-allowed items-center rounded-[10px] border-0 bg-transparent px-2.5 text-[12px] text-[var(--muted)]"],
    [
      "slashButton",
      "inline-flex h-7 items-center rounded-[10px] border-0 bg-transparent px-2.5 text-[12px] text-[var(--ink-soft)] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[var(--muted)] disabled:hover:bg-transparent",
    ],
    [
      "sendButton",
      "inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-[var(--green-ink)] transition hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:opacity-40",
    ],
    ["composerStatus", "mx-auto mt-1.5 max-w-[848px] text-center font-mono text-[11px] text-[var(--muted)]"],
  ],
};
