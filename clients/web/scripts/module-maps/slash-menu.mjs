/**
 * The className → semantic-class mapping for `chat/slash-menu.module.css`.
 *
 * Kept beside the verification script rather than inside the component: it is
 * evidence about the translation, so it has to survive independently of the
 * component's own style. Each entry is `[semanticName, "<the utilities that
 * class replaced>"]`, exactly as passed to `css-for-classnames.mjs`.
 */
export default {
  file: "src/components/remote-pi/chat/slash-menu.module.css",
  groups: [
    [
      "menu",
      "absolute bottom-[calc(100%+8px)] left-0 z-30 max-h-[320px] w-full overflow-y-auto rounded-[12px] border border-white/15 bg-[var(--bg-app)] p-1.5 shadow-[0_18px_44px_-12px_rgba(0,0,0,0.7)]",
    ],
    ["head", "flex items-center gap-2 px-2.5 pb-1.5 pt-1 font-mono text-[11px] text-[var(--muted)]"],
    ["query", "truncate"],
    ["count", "ml-auto shrink-0"],
    ["note", "px-2.5 py-3 text-center text-[12px] leading-relaxed text-[var(--muted)]"],
    ["row", "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition"],
    ["rowActive", "bg-white/[0.07]"],
    ["rowHover", "hover:bg-white/10"],
    ["rowText", "min-w-0 flex-1"],
    ["rowName", "block truncate font-mono text-[13px] text-white"],
    ["rowDesc", "mt-0.5 block line-clamp-2 text-[11.5px] leading-snug text-[var(--muted)]"],
    ["rowSource", "mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ok)]"],
  ],
};
