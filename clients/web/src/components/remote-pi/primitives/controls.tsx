/**
 * The two control primitives the app surfaces actually repeat.
 *
 * Everything else in `recipes.ts` is a class string on purpose: the call sites
 * differ in element (`button` vs `a`), size and one-off overrides, so a
 * component there would need `asChild` plus a size table and still leak
 * `className`. These two earn a component because their STRUCTURE repeats:
 * an icon-only button always needs the same square box, an accessible name, and
 * a title that explains it.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

import {
  CONTROL_GHOST,
  CONTROL_PRIMARY,
  CONTROL_SECONDARY,
  SIZE_MD,
  SIZE_SM,
} from "./recipes";
import css from "./controls.module.css";

/** Merge class strings, dropping falsy entries. */
function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ");
}

export type ControlTone = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual family. `ghost` is the default: most controls here are quiet. */
  tone?: ControlTone;
  /** Leading 14px icon. */
  icon?: ReactNode;
  /** `sm` fits a row or a dock toolbar; `md` fits a panel header. */
  size?: "sm" | "md";
}

/**
 * A labelled action.
 *
 * `type="button"` is forced: every one of these lives inside a form or a
 * clickable row at some point, and an accidental submit is a real bug.
 */
export function Button({ tone = "ghost", icon, size = "sm", className, children, ...rest }: ButtonProps) {
  const base =
    tone === "primary" ? CONTROL_PRIMARY : tone === "secondary" ? CONTROL_SECONDARY : CONTROL_GHOST;
  return (
    <button type="button" className={cx(base, SIZE_SM, size === "md" && SIZE_MD, className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The icon glyph. Sized by the caller; 16px is the house default. */
  children: ReactNode;
  /**
   * Accessible name. REQUIRED: an icon-only control with no name is invisible
   * to a screen reader, and every existing one in this app already carried
   * `aria-label`.
   */
  label: string;
  tone?: ControlTone;
  /** Square size: `xs` 24px (compact rails), `sm` 28px (rows), `md` 32px
   *  (panel headers). These are the three sizes the app already renders; a
   *  fourth would be a new visual decision, not a refactor. */
  size?: "xs" | "sm" | "md";
}

/** An icon-only action.
 *
 *  SIZE AND TONE ARE APPLIED BEFORE `className`, so a caller's own box/hover
 *  classes win. Without that order the recipe's `inline-flex` beat the caller's
 *  `grid`, which silently changed the glyph centring. */
export function IconButton({ label, tone = "ghost", size = "sm", className, children, ...rest }: IconButtonProps) {
  const base =
    tone === "primary" ? CONTROL_PRIMARY : tone === "secondary" ? CONTROL_SECONDARY : CONTROL_GHOST;
  const box = size === "xs" ? css.iconBoxXs : size === "sm" ? css.iconBoxSm : css.iconBoxMd;
  return (
    <button
      type="button"
      aria-label={label}
      title={rest.title ?? label}
      className={cx(base, box, css.iconBox, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
