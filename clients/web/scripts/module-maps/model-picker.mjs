/**
 * The className → semantic-class mapping for `chat/model-picker.module.css`.
 *
 * Evidence that the translation is a pure refactor: the same `[name, utilities]`
 * pairs that were handed to `css-for-classnames.mjs` are re-run against the full
 * Tailwind bridge and compared declaration by declaration.
 */
export default {
  file: "src/components/remote-pi/chat/model-picker.module.css",
  groups: [
    ["root", "relative flex min-w-0 items-center gap-1"],
    [
      "trigger",
      "inline-flex h-7 min-w-0 max-w-[24ch] items-center gap-1.5 rounded-[10px] border-0 bg-transparent px-2.5 text-[12px] transition",
    ],
    ["triggerDisabled", "cursor-not-allowed text-[var(--muted)]"],
    ["triggerIdle", "text-[var(--ink-soft)] hover:bg-white/10 hover:text-white"],
    ["triggerLabel", "truncate"],
    [
      "thinking",
      "inline-flex h-7 shrink-0 items-center gap-1 rounded-[10px] px-1.5 text-[12px] text-[var(--muted)]",
    ],
    [
      "thinkingSelect",
      "h-6 rounded-md border border-white/15 bg-[var(--bg-app)] px-1 text-[11.5px] text-[var(--ink-soft)] outline-none",
    ],
    [
      "menu",
      "absolute bottom-[calc(100%+8px)] right-0 z-30 max-h-[320px] w-[min(92vw,380px)] overflow-y-auto rounded-[12px] border border-white/15 bg-[var(--bg-app)] p-1.5 shadow-[0_18px_44px_-12px_rgba(0,0,0,0.7)]",
    ],
    ["note", "px-2.5 py-3 text-center text-[12px] leading-relaxed text-[var(--muted)]"],
    ["row", "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/10"],
    ["rowCurrent", "bg-white/[0.07]"],
    ["rowText", "min-w-0 flex-1"],
    ["rowName", "block truncate text-[13px] text-white"],
    ["rowMeta", "block truncate font-mono text-[10.5px] text-[var(--muted)]"],
    ["rowBadge", "shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ok)]"],
  ],
};
