"use client";

/* Slash-command menu for the composer — the skills half of Pi's own `/` popup.
 *
 * Native Pi opens a candidate list the moment `/` is typed at the start of the
 * input, filters it as you keep typing, and runs the highlighted entry on
 * Enter. This mirrors that for the part the web client can actually drive:
 * the workspace Pi's INSTALLED SKILLS.
 *
 * Why skills specifically: the host exposes them over a real wire
 * (`pi_surface` → `pi_surface_ok`, then `skill_invoke`), and Pi itself lists
 * every skill as `/skill:<name>`. The SDK's other `/` entries have no remote
 * invocation path — builtin TUI commands (`/export`, `/hotkeys`, …) and
 * interactive pickers — so offering them would be dead controls. The typed
 * actions that DO exist (compact, model, sessions) already have their own
 * controls in this UI.
 *
 * PURELY PRESENTATIONAL, like `model-picker`: the composer owns the `/`
 * detection, the query, the highlight and the keyboard, because it owns the
 * textarea and the draft. This file renders the rows and reports a pick.
 */
import { useEffect, useRef } from "react";

import { Icon } from "./icons";
import type { SkillOption } from "@/lib/remote-pi/slash";

/* The trigger and filter rules live in `@/lib/remote-pi/slash` (no JSX), so
   Node can verify them directly. Re-exported here so callers have one import
   for the whole menu surface. */
export { filterSkills, slashQueryOf } from "@/lib/remote-pi/slash";
export type { SkillOption } from "@/lib/remote-pi/slash";

export interface SlashMenuProps {
  /** Skills of the ACTIVE room; empty until the first `pi_surface_ok`. */
  skills: readonly SkillOption[];
  /** Already filtered by the composer (name hits first, then description). */
  matches: readonly SkillOption[];
  /** True while `pi_surface` is in flight. */
  busy: boolean;
  /** Fixed, client-authored reason the menu cannot run a skill, or null. */
  disabledReason: string | null;
  /** The text after `/` on the composer's first line. */
  query: string;
  /** Highlighted row, 0-based, owned by the composer. */
  activeIndex: number;
  /** Runs one skill the host reported. */
  onPick: (name: string) => void;
  /** Reports the row under the pointer so the composer can move the highlight. */
  onHover: (index: number) => void;
}

const SOURCE_LABEL: Readonly<Record<SkillOption["source"], string>> = {
  user: "user",
  project: "project",
  package: "package",
};

export function SlashMenu({
  skills,
  matches,
  busy,
  disabledReason,
  query,
  activeIndex,
  onPick,
  onHover,
}: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  /* Keep the highlighted row visible when it moves by keyboard. */
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      role="listbox"
      aria-label="Skills"
      ref={listRef}
      className="absolute bottom-[calc(100%+8px)] left-0 z-30 max-h-[320px] w-full overflow-y-auto rounded-[12px] border border-white/15 bg-[#151517] p-1.5 shadow-[0_18px_44px_-12px_rgba(0,0,0,0.7)]"
    >
      {/* The query is echoed back so the user sees what is being filtered; the
          textarea keeps the literal text, this is the menu's own view. */}
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-1 font-mono text-[11px] text-[#a3a3a3]">
        <Icon name="slash" size={12} />
        <span className="truncate">{query === "" ? "skills" : `/skill:${query}`}</span>
        <span className="ml-auto shrink-0">
          {busy ? "loading…" : `${matches.length}/${skills.length}`}
        </span>
      </div>

      {disabledReason !== null ? (
        <p className="px-2.5 py-3 text-center text-[12px] leading-relaxed text-[#a3a3a3]">
          {disabledReason}
        </p>
      ) : skills.length === 0 ? (
        <p className="px-2.5 py-3 text-center text-[12px] leading-relaxed text-[#a3a3a3]">
          {busy
            ? "Asking the host for this workspace's skills…"
            : "The host reported no skills for this workspace."}
        </p>
      ) : matches.length === 0 ? (
        <p className="px-2.5 py-3 text-center text-[12px] leading-relaxed text-[#a3a3a3]">
          No skill matches that — Esc leaves slash mode, then Enter sends it.
        </p>
      ) : (
        matches.map((skill, index) => (
          <button
            key={skill.name}
            type="button"
            role="option"
            id={`slash-option-${index}`}
            aria-selected={index === activeIndex}
            data-index={index}
            /* Pointer-DOWN, not click: a `click` fires after the textarea has
               already blurred, which would close the menu out from under the
               cursor. `preventDefault` keeps focus where it was. */
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(skill.name);
            }}
            onMouseEnter={() => onHover(index)}
            className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
              index === activeIndex ? "bg-white/[0.07]" : "hover:bg-white/10"
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] text-white">
                /skill:{skill.name}
              </span>
              <span className="mt-0.5 block line-clamp-2 text-[11.5px] leading-snug text-[#a3a3a3]">
                {skill.description}
              </span>
            </span>
            <span className="mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-[#5fd38a]">
              {SOURCE_LABEL[skill.source]}
              {skill.explicitOnly ? " ·explicit" : ""}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
