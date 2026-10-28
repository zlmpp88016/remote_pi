/**
 * Remote Pi app-surface primitives.
 *
 * Role: the DESIGN SYSTEM for the `/remote-pi` route. Everything here answers
 * "what does a control / a panel / a hint look like", so a visual change is made
 * once. It is deliberately separate from `../` (which holds feature surfaces:
 * transcript, sidebar, dock) and from `@/lib/remote-pi` (protocol + adapter).
 *
 * A class recipe is used where the element varies (`button` vs `a`, one-off
 * sizes); a component is used where the STRUCTURE repeats (icon-only buttons,
 * which always need a square box and an accessible name).
 */

export { Button, IconButton, type ButtonProps, type ControlTone, type IconButtonProps } from "./controls";
export { Modal, type ModalProps } from "./modal";
export {
  CONTROL_BASE,
  CONTROL_DANGER,
  CONTROL_GHOST,
  CONTROL_PRIMARY,
  CONTROL_SECONDARY,
  ERROR_LINE,
  FIELD,
  HAIRLINE,
  HINT,
  PANEL,
  R_CONTROL,
  SIZE_MD,
  SIZE_SM,
} from "./recipes";
