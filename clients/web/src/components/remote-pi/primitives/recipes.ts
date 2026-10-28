/**
 * Shared control recipes for the app surfaces.
 *
 * WHY MODULE CLASS NAMES, NOT COMPONENTS: these surfaces are dense control
 * clusters where every call site needs a different element (`button`, `a`, `div`
 * with a click handler) and a slightly different size. Wrapping them in a
 * component would force an `asChild` prop and a size table, and would still need
 * `className` passthrough for the one-off overrides. Naming the rules keeps the
 * element and the DOM contract at the call site while putting the VISUAL decision
 * in one place.
 *
 * EACH VARIANT IS ONE COMPLETE RULE, not base-plus-modifier. The rules set
 * overlapping properties, and with plain class names the winner is decided by
 * stylesheet order, not by the order of names in the `class` attribute. Emitting
 * a variant as a single rule keeps its declarations in exactly the order the old
 * utility string had, so the same declaration wins.
 *
 * ⚠️ `className` STILL DOES NOT OVERRIDE THESE RECIPES. That was true before (CSS
 * specificity does not follow class-attribute order) and remains true. A call
 * site that needs a genuinely different look must NOT compose a recipe: write its
 * own rule. (`layout/workspace-sidebar.tsx`'s rail toggle is the worked example —
 * it looked like a ghost button, but its 24px box, its `grid` centring and its
 * hover tint are its own.)
 *
 * The declarations are byte-identical to what the components rendered before;
 * this file is a move, not a restyle.
 */

import css from "./recipes.module.css";

/** Join class names, dropping empty entries. */
export function compose(...names: (string | false | null | undefined)[]): string {
  return names.filter((n): n is string => typeof n === "string" && n !== "").join(" ");
}

/** Rounded control radius shared by buttons, inputs and small cards. */
export const R_CONTROL = css.controlBase;

/** The hairline every elevated surface uses. */
export const HAIRLINE = css.hairline;

/** A pressable surface: the base every control variant starts from. */
export const CONTROL_BASE = css.controlBase;

/** The ONE filled action on a surface (Send, Start, primary confirm). */
export const CONTROL_PRIMARY = css.controlPrimary;

/** A bordered action: the default for secondary verbs. */
export const CONTROL_SECONDARY = css.controlSecondary;

/** A borderless action: icon buttons and in-row verbs. */
export const CONTROL_GHOST = css.controlGhost;

/** A destructive action (unpair, discard). Never the filled accent. */
export const CONTROL_DANGER = css.controlDanger;

/** Small control height (rows, dock toolbars). */
export const SIZE_SM = css.sizeSm;

/** Medium control height (panel headers, primary forms). */
export const SIZE_MD = css.sizeMd;

/** A grouped section inside the dock or a panel. */
export const PANEL = compose(css.controlBase, css.panel);

/** The dimmed explanatory line under a control or an empty state. */
export const HINT = css.hint;

/** An inline failure. Fixed text only — never a wire payload. */
export const ERROR_LINE = css.errorLine;

/** A labelled field's shell (the input itself is unstyled inside it). */
export const FIELD = compose(css.controlBase, css.field);
