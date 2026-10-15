/**
 * Pure logic behind the composer's slash menu.
 *
 * Separated from `slash-menu.tsx` on purpose: this half has no JSX and no
 * React, so Node can execute it directly and the trigger/filter rules are
 * verifiable without a browser — the same split `model-cache.ts` uses.
 */

/** One installed skill, already validated/projected by the container. */
export interface SkillOption {
  name: string;
  description: string;
  source: "user" | "project" | "package";
  /**
   * `disable_model_invocation: true` means the skill is explicit-invocation
   * only — which is exactly what this menu IS, so it stays runnable. Surfaced
   * so the two kinds are distinguishable in the list.
   */
  explicitOnly: boolean;
}

/**
 * The slash query a draft currently represents, or `null` when the draft is
 * NOT a slash command.
 *
 * Only a `/` at the very START counts, mirroring Pi: a `/` mid-sentence is
 * ordinary text. A space or newline after the command name means the user has
 * moved on to ARGS (`/skill:x do the thing`), so the menu closes and Enter
 * sends — which is also the documented way out (`Esc` appends a space).
 */
export function slashQueryOf(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const body = draft.slice(1);
  if (body.includes("\n") || body.includes(" ")) return null;
  return body;
}

/**
 * Case-insensitive match on the name FIRST, then the description, so typing
 * `/maestro` puts `maestro` above anything that merely mentions it.
 */
export function filterSkills(
  skills: readonly SkillOption[],
  query: string,
): readonly SkillOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") return skills;
  const byName: SkillOption[] = [];
  const byDescription: SkillOption[] = [];
  for (const skill of skills) {
    if (skill.name.toLowerCase().includes(q)) byName.push(skill);
    else if (skill.description.toLowerCase().includes(q)) byDescription.push(skill);
  }
  return [...byName, ...byDescription];
}
