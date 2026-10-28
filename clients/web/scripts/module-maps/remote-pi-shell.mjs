/**
 * The className → semantic-class mapping for `layout/remote-pi-shell.module.css`.
 *
 * Evidence that the translation is a pure refactor: the same `[name, utilities]`
 * pairs that were handed to `css-for-classnames.mjs` are re-run against the full
 * Tailwind bridge and compared declaration by declaration.
 *
 * The light dots keep `light` as a shared base plus a colour modifier rather than
 * three self-contained rules: `.light` carries only geometry and the modifiers
 * only a background, so no declaration is overridden between them and the split
 * cannot change which value wins.
 */
export default {
  file: "src/components/remote-pi/layout/remote-pi-shell.module.css",
  groups: [
    ["shell", "relative z-10 grid grid-rows-[36px_minmax(0,1fr)] text-white"],
    [
      "titlebar",
      "flex items-center gap-3 border-b border-white/10 bg-[#060606] px-3 text-[12.5px] text-[var(--faint)]",
    ],
    ["lights", "flex gap-2"],
    ["light", "block size-[11px] rounded-full"],
    ["lightClose", "bg-[var(--light-close)]"],
    ["lightMin", "bg-[var(--light-min)]"],
    ["lightMax", "bg-[var(--light-max)]"],
    ["titleGroup", "flex min-w-0 items-center gap-2 text-[var(--muted)]"],
    ["hostName", "text-[12.5px] font-semibold text-white"],
    ["separator", "text-[var(--faint)]"],
    ["machine", "truncate font-mono text-[11.5px] text-[var(--muted)]"],
    ["titleActions", "ml-auto flex items-center gap-1.5"],
    [
      "unpair",
      "inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[12px] transition hover:bg-white/10",
    ],
    ["unpairArmed", "text-[var(--danger)]"],
    ["unpairIdle", "text-[var(--faint)] hover:text-white"],
    ["mainScroll", "min-h-0 overflow-y-auto"],
    ["bodyGrid", "grid min-h-0 min-w-0"],
    ["transcriptColumn", "grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]"],
    [
      "composerPad",
      "px-[70px] pb-4 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4",
    ],
    ["composerBox", "mx-auto max-w-[848px]"],
    ["toastLayer", "pointer-events-none absolute bottom-5 left-1/2 z-20 -translate-x-1/2"],
    [
      "toast",
      "pointer-events-auto flex items-center gap-2.5 rounded-[14px] border px-3.5 py-2.5 text-[13px] shadow-[0_12px_32px_-8px_rgba(15,17,21,0.6)]",
    ],
    ["toastError", "border-[rgba(242,90,90,0.4)] bg-[var(--bg-app)] text-[var(--danger)]"],
    ["toastInfo", "border-white/15 bg-[var(--bg-app)] text-[var(--ink-soft)]"],
    ["toastDot", "size-[7px] shrink-0 rounded-full bg-[var(--danger)]"],
    ["toastText", "whitespace-pre-wrap"],
    [
      "toastDismiss",
      "ml-1 grid size-5 place-items-center rounded text-[var(--muted)] transition hover:bg-white/10 hover:text-white",
    ],
  ],
};
