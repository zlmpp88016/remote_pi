/**
 * The className → semantic-class mapping for
 * `sessions/session-viewer.module.css`.
 */
export default {
  file: "src/components/remote-pi/sessions/session-viewer.module.css",
  groups: [
    ["userTurn", "flex justify-end py-2"],
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
    ["agentBody", "min-w-0 break-words [overflow-wrap:anywhere]"],
    ["toolRow", "flex items-center gap-2 py-0.5 font-mono text-[11px] text-[var(--ink-quiet)]"],
    ["toolName", "truncate"],
    ["toolResult", "flex items-center gap-2 py-0.5 pl-4 font-mono text-[11px]"],
    ["ok", "text-[var(--ok)]"],
    ["error", "text-[var(--danger)]"],
    ["marker", "my-2 flex items-center gap-2 font-mono text-[11px] text-[var(--muted)]"],
    ["root", "grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]"],
    ["head", "flex flex-wrap items-center gap-2 border-b border-white/10 px-3.5 py-2"],
    [
      "chip",
      "rounded border border-white/15 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--muted)]",
    ],
    ["title", "min-w-0 truncate text-[13px] text-white"],
    [
      "liveBadge",
      "rounded border border-[rgba(95,211,138,0.3)] px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-[var(--ok)]",
    ],
    [
      "switchButton",
      "rounded-md border border-white/15 px-2 py-0.5 font-mono text-[10.5px] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]",
    ],
    [
      "refresh",
      "ml-auto grid size-6 place-items-center rounded-md border border-white/10 text-[var(--faint)] transition hover:border-white/20 hover:text-white",
    ],
    ["scroll", "min-h-0 overflow-y-auto overflow-x-hidden"],
    [
      "transcript",
      "mx-auto grid max-w-[848px] gap-0.5 px-[70px] pb-8 pt-5 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4",
    ],
    ["statusLine", "py-3 text-[13px] text-[var(--amber-ink)]"],
    ["emptyLine", "py-3 text-[13px] text-[var(--muted)]"],
  ],
};
