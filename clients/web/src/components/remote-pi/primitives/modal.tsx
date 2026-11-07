/**
 * The modal primitive the app surfaces share.
 *
 * WHY THIS IS A COMPONENT AND NOT A CLASS STRING: the structure is the point.
 * A dialog that looks right but leaves focus behind it in the page is broken
 * for keyboard and screen-reader users, and every call site would have to
 * reimplement the same four things (semantics, focus entry, focus return, Esc).
 * Those four are the reason this file exists; the 28px panel is the easy half.
 *
 * WHAT IT DOES ON OPEN:
 *   • `role="dialog"` + `aria-modal="true"` so AT announces a modal, not a div.
 *   • Moves focus into the panel (first focusable, or the panel itself).
 *   • Keeps Tab inside the panel — a focus trap, because `aria-modal` alone
 *     does not stop Tab from walking into the page behind the mask.
 *   • Locks the page scroll, since a scrolling background under a mask reads as
 *     two surfaces moving independently.
 * WHAT IT DOES ON CLOSE: restores focus to whatever was focused before it
 * opened. Without that, dismissing a dialog drops the user at the top of the
 * document.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

import css from "./modal.module.css";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Heading text. Also the dialog's accessible name via aria-labelledby. */
  title: string;
  /** Optional text under the heading. */
  description?: string;
  /** Called for every dismissal path: Esc, mask click, close button. */
  onClose: () => void;
  /** Footer controls (usually secondary + primary, in that visual order). */
  footer?: ReactNode;
  /** `wide` is the settings-sized panel (720px); default is the 440px dialog. */
  size?: "dialog" | "wide";
  children: ReactNode;
}

export function Modal({
  title,
  description,
  onClose,
  footer,
  size = "dialog",
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  /*
   * Capture-on-open, not on every render: the element to restore to is whatever
   * had focus BEFORE the dialog mounted. Reading it in an effect keyed on a
   * changing dependency would eventually capture a node inside the dialog
   * itself, and closing would then focus a node that no longer exists.
   */
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      /* Focus trap: wrap Tab across the panel's own focusable edges. */
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && (active === last || active === panel)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      }
    },
    [onClose],
  );

  return (
    <div className={css.mask} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`${css.panel} ${size === "wide" ? css.panelWide : css.panelDialog}`}
      >
        <div className={css.header}>
          <div className={css.headerText}>
            <h2 id={titleId} className={css.title}>
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descId} className={css.description}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className={css.close}
            aria-label="关闭对话框"
            title="Close"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className={css.body}>{children}</div>

        {footer === undefined ? null : <div className={css.footer}>{footer}</div>}
      </div>
    </div>
  );
}
