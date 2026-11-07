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

import { Icon } from "../core/icons";
import css from "./slash-menu.module.css";
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
      aria-label="技能"
      ref={listRef}
      className={css.menu}
    >
      {/* The query is echoed back so the user sees what is being filtered; the
          textarea keeps the literal text, this is the menu's own view. */}
      <div className={css.head}>
        <Icon name="slash" size={12} />
        <span className={css.query}>{query === "" ? "skills" : `/skill:${query}`}</span>
        <span className={css.count}>
          {busy ? "loading…" : `${matches.length}/${skills.length}`}
        </span>
      </div>

      {disabledReason !== null ? (
        <p className={css.note}>
          {disabledReason}
        </p>
      ) : skills.length === 0 ? (
        <p className={css.note}>
          {busy
            ? "正在向主机询问该工作区的技能…"
            : "主机报告该工作区没有可用技能。"}
        </p>
      ) : matches.length === 0 ? (
        <p className={css.note}>
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
            className={`${css.row} ${index === activeIndex ? css.rowActive : css.rowHover}`}
          >
            <span className={css.rowText}>
              <span className={css.rowName}>
                /skill:{skill.name}
              </span>
              <span className={css.rowDesc}>
                {skill.description}
              </span>
            </span>
            <span className={css.rowSource}>
              {SOURCE_LABEL[skill.source]}
              {skill.explicitOnly ? " ·explicit" : ""}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
