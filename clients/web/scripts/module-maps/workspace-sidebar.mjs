/**
 * The className → semantic-class mapping for
 * `layout/workspace-sidebar.module.css`.
 *
 * Several classes exist in a rail/full pair rather than as a base plus modifier.
 * That is deliberate: the two variants set different padding, alignment and
 * margins on the same element, and two separate complete rules keep each
 * variant's declarations in one place instead of relying on the order two
 * overlapping class names happen to be written in.
 *
 * `sr-only` is not mapped: it stays a Tailwind class until every file that uses
 * it has been translated.
 */
export default {
  file: "src/components/remote-pi/layout/workspace-sidebar.module.css",
  groups: [
    ["root", "grid min-h-0 min-w-0 border-r border-white/10 bg-[rgba(255,255,255,0.02)]"],
    ["brandRail", "grid gap-2.5 px-2 py-2.5"],
    ["brandFull", "grid gap-2.5 px-3 pb-2 pt-3"],
    ["brandRowRail", "flex justify-center"],
    ["brandRowFull", "flex items-center gap-2.5 px-0.5"],
    [
      "mark",
      "grid size-6 shrink-0 place-items-center rounded-[7px] border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[var(--accent)]",
    ],
    ["brandName", "text-[14px] font-semibold tracking-[-0.01em] text-white"],
    ["versionChip", "rounded border border-white/10 bg-white/[0.045] px-1.5 py-px font-mono text-[10px] text-[var(--faint)]"],
    ["spacer", "flex-1"],
    [
      "toggleRail",
      "grid size-6 place-items-center rounded-md text-[var(--faint)] transition hover:bg-white/10 hover:text-white",
    ],
    [
      "toggleFull",
      "ml-auto grid size-6 place-items-center rounded-md text-[var(--faint)] transition hover:bg-white/10 hover:text-white",
    ],
    [
      "searchBox",
      "flex h-8 items-center gap-2 rounded-[10px] border border-white/10 bg-white/[0.045] px-2.5 transition focus-within:border-[var(--accent)]",
    ],
    ["searchIcon", "shrink-0 text-[var(--faint)]"],
    ["searchInput", "min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-[var(--faint)]"],
    ["scroll", "min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-3.5"],
    [
      "sectionHead",
      "flex items-center gap-1.5 px-2 pb-1 pt-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--faint)]",
    ],
    ["sectionTitle", "flex-1"],
    [
      "refreshSmall",
      "inline-flex items-center gap-1 rounded-md px-1 py-px normal-case tracking-normal transition enabled:hover:bg-white/10 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[var(--ink-off)]",
    ],
    ["railCenter", "grid justify-items-center gap-2 px-1 py-2.5"],
    [
      "railButton",
      "grid size-7 place-items-center rounded-md text-[var(--faint)] transition enabled:hover:bg-white/10 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[var(--ink-off)]",
    ],
    [
      "railError",
      "grid size-7 place-items-center rounded-md border border-[rgba(242,90,90,0.35)] text-[var(--danger)]",
    ],
    ["railIdle", "grid size-7 place-items-center rounded-md text-[var(--faint)]"],
    ["railPad", "px-2 py-3"],
    ["errorText", "px-2 py-3 text-[12.5px] leading-relaxed text-[var(--danger)]"],
    ["railList", "grid gap-px"],
    [
      "railItemActive",
      "grid size-9 w-full place-items-center rounded-md border border-white/10 bg-white/10 text-white",
    ],
    [
      "railItemIdle",
      "grid size-9 w-full place-items-center rounded-md border border-transparent text-[var(--muted)] transition hover:bg-white/[0.06] hover:text-white",
    ],
    ["listItem", "grid gap-0.5"],
    [
      "wsRowActive",
      "relative flex min-h-[34px] w-full items-center gap-2 rounded-md border border-white/10 bg-white/10 px-2 py-1",
    ],
    [
      "wsRowIdle",
      "relative flex min-h-[34px] w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 transition hover:bg-white/[0.06]",
    ],
    ["activeMarker", "absolute -left-1.5 top-2 bottom-2 w-0.5 rounded-full bg-[var(--accent)]"],
    ["wsButton", "flex min-w-0 flex-1 items-center gap-2 text-left"],
    ["wsToneIcon", "grid size-3.5 shrink-0 place-items-center"],
    ["wsTextCol", "min-w-0 flex-1"],
    ["wsNameActive", "block truncate font-mono text-[12.5px] text-white"],
    ["wsNameIdle", "block truncate font-mono text-[12.5px] text-[var(--ink-soft)]"],
    ["wsStatus", "shrink-0 font-mono text-[10.5px]"],
    ["wsActions", "flex shrink-0 items-center gap-0.5"],
    [
      "startButton",
      "grid size-5 place-items-center rounded text-[var(--ok)] transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[var(--ink-off)]",
    ],
    [
      "restartButton",
      "grid size-5 place-items-center rounded text-[var(--amber)] transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[var(--ink-off)]",
    ],
    ["wsWarning", "flex items-start gap-1 px-2 pb-0.5 text-[10.5px] leading-snug text-[var(--amber)]"],
    ["wsWarningIcon", "mt-px shrink-0"],
    ["railHint", "px-2 pt-3 text-[11.5px] leading-relaxed text-[var(--faint)]"],
    ["footer", "grid gap-0.5 border-t border-white/10 p-2"],
    ["hostRowRail", "grid justify-items-center py-1.5"],
    ["hostRowFull", "flex min-w-0 items-center gap-2.5 rounded-[10px] px-2 py-1.5"],
    ["hostDot", "size-2 shrink-0 rounded-full bg-[var(--ok)] ring-4 ring-[rgba(95,211,138,0.16)]"],
    ["hostText", "min-w-0"],
    ["hostName", "block truncate text-[12.5px] text-white"],
    ["hostMeta", "block truncate font-mono text-[10.5px] text-[var(--faint)]"],
    [
      "dockButtonRail",
      "grid w-full justify-items-center rounded-[10px] py-1.5 text-[var(--muted)] transition enabled:hover:bg-white/[0.06] enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[var(--faint)]",
    ],
    [
      "dockButtonFull",
      "flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13px] text-[var(--muted)] transition enabled:hover:bg-white/[0.06] enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[var(--faint)]",
    ],
    ["shortcut", "ml-auto font-mono text-[10.5px] text-[var(--faint)]"],
    [
      "settingsButtonRail",
      "grid w-full justify-items-center rounded-[10px] py-1.5 text-[var(--faint)] disabled:cursor-not-allowed",
    ],
    [
      "settingsButtonFull",
      "flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13px] text-[var(--faint)] disabled:cursor-not-allowed",
    ],
  ],
};
