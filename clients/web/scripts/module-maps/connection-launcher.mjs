/**
 * The className → semantic-class mapping for
 * `layout/connection-launcher.module.css`.
 *
 * Evidence that the translation is a pure refactor: the same `[name, utilities]`
 * pairs that were handed to `css-for-classnames.mjs` are re-run against the full
 * Tailwind bridge and compared declaration by declaration.
 *
 * The two text inputs keep the shared `FIELD` recipe and add a local class
 * instead of folding the extra declarations into the recipe. The recipe is used
 * by other screens, so changing it would change those screens too; `fieldTall`
 * and `pairField` carry only the height and the monospace pairing this screen
 * wants on top of it.
 */
export default {
  file: "src/components/remote-pi/layout/connection-launcher.module.css",
  groups: [
    ["page", "grid min-h-full place-items-center px-4 py-12"],
    ["column", "w-full min-w-0 max-w-[462px]"],
    ["brandRow", "mb-7 flex items-center gap-3"],
    [
      "brandMark",
      "grid size-[38px] place-items-center rounded-[11px] border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[var(--accent)]",
    ],
    ["brandName", "text-[18px] font-semibold tracking-[-0.01em] text-white"],
    ["eyebrow", "font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--faint)]"],
    ["lede", "mb-2 text-[30px] font-semibold leading-[1.14] tracking-[-0.02em] text-white"],
    ["body", "mb-6 text-[14.5px] leading-relaxed break-words [overflow-wrap:anywhere] text-[var(--muted)]"],
    ["inlineCode", "font-mono text-[12.5px] text-[var(--ink-soft)]"],
    ["form", "grid gap-3.5"],
    ["fieldGroup", "grid gap-[7px]"],
    ["fieldLabel", "text-[12.5px] font-medium text-[var(--muted)]"],
    ["fieldTall", "h-10"],
    ["pairField", "min-h-[74px] resize-y py-2.5 font-mono text-[12.5px] leading-6"],
    ["errorLine", "break-words text-[12px] text-[var(--muted)]"],
    [
      "submit",
      "inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[var(--accent)] px-4 text-[14px] font-semibold text-[var(--green-ink)] transition hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:opacity-45",
    ],
    ["disclosures", "mt-6"],
    ["storedBox", "mt-6 grid gap-1.5 border-t border-white/10 pt-4"],
    ["storedTitle", "font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--faint)]"],
    ["storedRow", "flex items-center gap-2.5 rounded-[10px] border border-white/10 px-2.5 py-2"],
    ["storedDot", "size-[7px] shrink-0 rounded-full bg-[var(--ok)]"],
    ["storedText", "min-w-0 flex-1"],
    ["storedName", "block truncate text-[13.5px] text-white"],
    ["storedMeta", "block truncate font-mono text-[11px] text-[var(--faint)]"],
    [
      "unpairButton",
      "inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-white/15 px-2.5 text-[12.5px] text-[var(--muted)] transition hover:bg-white/5 hover:text-white",
    ],
    ["storedNote", "break-words text-[11.5px] leading-relaxed text-[var(--muted)]"],
  ],
};
