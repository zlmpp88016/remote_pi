/**
 * The className → semantic-class mapping for `sessions/session-list.module.css`.
 *
 * Evidence that the translation is a pure refactor: the same `[name, utilities]`
 * pairs that were handed to `css-for-classnames.mjs` are re-run against the full
 * Tailwind bridge and compared declaration by declaration.
 *
 * `group` is deliberately absent: it was a bare marker with no declarations of
 * its own, kept only so `group-hover` variants could reach it — and this file has
 * no `group-hover`, so it carried no styling and was dropped.
 */
export default {
  file: "src/components/remote-pi/sessions/session-list.module.css",
  groups: [
    ["root", "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-1.5"],
    ["head", "flex items-center gap-2 px-2"],
    ["title", "font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--faint)]"],
    [
      "refresh",
      "ml-auto grid size-6 place-items-center rounded-md border border-white/10 text-[var(--faint)] transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50",
    ],
    ["scroll", "min-h-0 overflow-y-auto"],
    ["scrollX", "min-h-0 overflow-y-auto overflow-x-hidden"],
    ["note", "px-2 py-1.5 text-[12px] leading-relaxed text-[var(--faint)]"],
    ["list", "grid gap-1"],
    ["row", "grid gap-1 rounded-[10px] border px-2.5 py-2 transition"],
    ["rowViewing", "border-[rgba(79,195,247,0.35)] bg-[rgba(79,195,247,0.07)]"],
    ["rowIdle", "border-white/10 bg-white/[0.03] hover:border-white/20"],
    ["readButton", "grid min-w-0 gap-0.5 text-left"],
    ["rowHead", "flex min-w-0 items-center gap-1.5"],
    ["rowName", "truncate text-[13px] font-medium text-white"],
    [
      "liveBadge",
      "shrink-0 rounded border border-[rgba(95,211,138,0.3)] px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-[var(--ok)]",
    ],
    ["age", "ml-auto shrink-0 font-mono text-[10px] text-[var(--faint)]"],
    ["preview", "truncate font-mono text-[10.5px] text-[var(--ink-quiet)]"],
    [
      "switchButton",
      "justify-self-start rounded-md border border-white/15 px-2 py-0.5 font-mono text-[10.5px] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]",
    ],
    ["notice", "px-2 text-[11.5px] leading-relaxed text-[var(--amber-ink)]"],
  ],
};
