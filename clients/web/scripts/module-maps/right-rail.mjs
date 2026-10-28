/**
 * The className → semantic-class mapping for `layout/right-rail.module.css`.
 *
 * `rotate-180` and `sr-only` are not in the mapping: they are still applied as
 * Tailwind classes to the `<Icon>` children and the screen-reader spans, so they
 * remain in the bridge until every file that uses them is translated.
 */
export default {
  file: "src/components/remote-pi/layout/right-rail.module.css",
  groups: [
    [
      "railCollapsed",
      "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-white/10 bg-[rgba(255,255,255,0.02)]",
    ],
    ["collapsedHead", "flex h-12 min-w-0 items-center justify-center border-b border-white/10"],
    [
      "iconButton",
      "grid size-6 place-items-center rounded-md text-[var(--faint)] transition hover:bg-white/10 hover:text-white",
    ],
    ["railTabs", "grid content-start justify-items-center gap-2 pt-2"],
    [
      "railTabButton",
      "grid size-7 shrink-0 place-items-center rounded-md text-[var(--faint)] transition hover:bg-white/10 hover:text-white",
    ],
    [
      "rail",
      "relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-white/10 bg-[rgba(255,255,255,0.02)]",
    ],
    [
      "resizer",
      "absolute -left-1 top-0 bottom-0 z-[7] w-[7px] cursor-col-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    ],
    ["resizerDragging", "bg-[var(--accent)]/60"],
    ["resizerIdle", "hover:bg-[var(--accent)]/40"],
    ["head", "flex h-12 items-center gap-1.5 border-b border-white/10 pl-3 pr-2"],
    ["tabList", "flex min-w-0 flex-1 items-center gap-0.5"],
    [
      "tabActive",
      "inline-flex h-7 max-w-[150px] items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-[12.5px] text-white",
    ],
    [
      "tabIdle",
      "inline-flex h-7 max-w-[150px] items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-[var(--faint)] transition hover:bg-white/[0.06] hover:text-[var(--ink-soft)]",
    ],
    ["tabLabel", "truncate"],
    [
      "collapseButton",
      "grid size-6 shrink-0 place-items-center rounded-md text-[var(--faint)] transition hover:bg-white/10 hover:text-white",
    ],
    ["panelHidden", "min-h-0 overflow-hidden p-3"],
    ["panel", "min-h-0 overflow-auto p-3"],
    ["panelStack", "grid gap-2.5"],
    ["row", "flex gap-1.5"],
    [
      "textInput",
      "min-w-0 flex-1 rounded-[10px] border border-white/15 bg-white/[0.045] px-2.5 py-1.5 font-mono text-[12.5px] text-white outline-none transition placeholder:text-[#8f8f8f] focus:border-[var(--accent)]",
    ],
    [
      "primaryButton",
      "inline-flex h-[30px] shrink-0 items-center rounded-[10px] bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-[var(--green-ink)] transition hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:opacity-45",
    ],
    ["buttonRow", "flex items-center gap-1.5"],
    [
      "secondaryButton",
      "inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-white/15 bg-white/[0.045] px-2 text-[12px] font-medium text-[var(--ink-soft)] transition enabled:hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:text-[var(--faint)]",
    ],
    [
      "accentButton",
      "inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-[var(--accent)] px-2 text-[12px] font-semibold text-[var(--green-ink)] transition enabled:hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:opacity-45",
    ],
    ["checkboxRow", "flex items-center gap-2 rounded-md px-1 py-0.5 text-[11.5px]"],
    ["checkboxAvailable", "text-[var(--muted)]"],
    ["checkboxUnavailable", "text-[var(--ink-dim)]"],
    ["checkbox", "size-3.5 shrink-0 accent-[var(--accent)] disabled:cursor-not-allowed"],
    ["pathRow", "flex items-center gap-2 font-mono text-[11px] text-[var(--ink-dim)]"],
    ["pathText", "min-w-0 flex-1 truncate"],
    [
      "linkButton",
      "inline-flex items-center gap-1 text-[var(--accent)] transition enabled:hover:text-[var(--accent-2)] disabled:cursor-not-allowed disabled:text-[var(--faint)]",
    ],
    ["reasonText", "text-[11.5px] leading-relaxed text-[var(--ink-dim)]"],
    ["listingRow", "flex items-center gap-2 py-2"],
    ["loadingText", "text-[12.5px] text-[var(--ink-dim)]"],
    ["entryList", "grid gap-0.5"],
    [
      "entryRow",
      "flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[12.2px] text-[var(--muted)] transition hover:bg-white/[0.06]",
    ],
    ["entryDirIcon", "text-[var(--accent)]"],
    ["entryFileIcon", "text-[var(--faint)]"],
    [
      "entryNameButton",
      "min-w-0 flex-1 truncate text-left text-[var(--ink-soft)] transition enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[var(--faint)]",
    ],
    ["entryNameText", "min-w-0 flex-1 truncate"],
    ["entryBadge", "shrink-0 rounded border border-white/10 px-1 text-[10px] text-[var(--faint)]"],
    [
      "entryAdd",
      "shrink-0 rounded-md border border-white/15 px-2 py-0.5 text-[11px] font-medium text-[var(--ink-soft)] transition enabled:hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:text-[var(--faint)]",
    ],
    [
      "entryStart",
      "shrink-0 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--green-ink)] transition enabled:hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:opacity-45",
    ],
  ],
};
