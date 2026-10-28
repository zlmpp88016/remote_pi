/**
 * The deep-thinking disclosure row — DSH's most recognisable transcript piece.
 *
 * WHY IT EXISTS: a long reasoning trace pushed straight into the reply buries
 * the answer. DSH folds it into a one-line header that shows a preview and
 * expands in place, and — the part that actually matters while a reply streams
 * — pins that header to the top of the scroll container so the user can see
 * "still thinking" without scrolling back up.
 *
 * KEYBOARD/AT CONTRACT: it is a real <button> with `aria-expanded` and
 * `aria-controls`, so it is reachable by Tab, operable by Enter/Space and
 * announced as a disclosure. The summary preview is inside the button, which is
 * why it is aria-hidden: the label already says "thinking", and re-reading the
 * streamed fragment on every frame would make a screen reader unusable.
 *
 * STICKY: `top: 0` plus an OPAQUE background. A transparent sticky header lets
 * the scrolling text show through it, which is the usual way this pattern is
 * done wrong.
 */

import { useId, useState, type ReactNode } from "react";

import css from "./reasoning-row.module.css";

export interface ReasoningRowProps {
  /** The reasoning trace. Rendered verbatim: it is the model's own text. */
  text: string;
  /** True while the trace is still arriving — the header keeps a live hint. */
  live?: boolean;
  /** Open on first paint. Streaming traces usually start open. */
  defaultOpen?: boolean;
}

/** One line, ellipsised: the header must never grow to two lines mid-stream. */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat === "" ? "" : flat;
}

export function ReasoningRow({ text, live = false, defaultOpen = false }: ReasoningRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const preview = previewOf(text);

  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className={css.icon} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M8 1.5a4 4 0 0 0-2.3 7.28c.4.28.6.7.6 1.16v.56h3.4v-.56c0-.46.2-.88.6-1.16A4 4 0 0 0 8 1.5ZM6.3 13h3.4M6.8 14.5h2.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
        <span className={css.label}>{live ? "Thinking…" : "Thought process"}</span>
        {preview === "" ? null : (
          <>
            <span className={css.dot} aria-hidden="true" />
            <span className={css.preview} aria-hidden="true">
              {preview}
            </span>
          </>
        )}
        <svg
          className={`${css.chevron} ${open ? css.chevronOpen : ""}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="M4 6.5 8 10.5l4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div id={bodyId} className={css.body}>
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** Convenience for the transcript: `null` renders nothing at all. */
export function ReasoningRowMaybe({ text, live }: { text: string | null; live?: boolean }): ReactNode {
  if (text === null || text.trim() === "") return null;
  return <ReasoningRow text={text} live={live} defaultOpen={live === true} />;
}
