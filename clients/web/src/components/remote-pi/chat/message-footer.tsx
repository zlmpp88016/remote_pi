/**
 * Assistant message footer: token usage, local time, and a copy button.
 *
 * Copy of DeepSeek Harness' message IconActions row. Every part is optional and
 * independent: a message whose usage never arrived still shows its clock, and a
 * message without a timestamp still offers copy. Rendering a placeholder for a
 * missing value would claim data the host never sent.
 */
import { memo, useCallback, useState } from "react";
import { Icon } from "../core/icons";
import css from "./message-footer.module.css";

export interface MessageFooterProps {
  /** Formatted total tokens for this message, or `null` when usage was absent. */
  totalText: string | null;
  /** Local `YYYY-MM-DD HH:mm:ss` of the message, or `null` when it carried no timestamp. */
  clock: string | null;
  /** Text the copy button writes to the clipboard. */
  copyText: string;
}

export const MessageFooter = memo(function MessageFooter({
  totalText,
  clock,
  copyText,
}: MessageFooterProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    /*
     * `navigator.clipboard` is unavailable on an insecure origin and in some
     * embedded webviews. The button reports failure by simply not changing its
     * label, which is honest; a fake "Copied" would be worse than no feedback.
     */
    const done = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    };
    if (navigator.clipboard?.writeText !== undefined) {
      void navigator.clipboard.writeText(copyText).then(done).catch(() => {});
      return;
    }
    try {
      const area = document.createElement("textarea");
      area.value = copyText;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      done();
    } catch {
      /* Leave the label unchanged: the copy did not happen. */
    }
  }, [copyText]);

  if (totalText === null && clock === null) return null;

  return (
    <div className={css.row}>
      {totalText !== null && (
        <span className={css.item} data-part="usage">
          <Icon name="database" size={13} />
          <span>{totalText} tok</span>
        </span>
      )}
      {clock !== null && (
        <span className={css.item} data-part="clock">
          <span>{clock}</span>
        </span>
      )}
      <button
        type="button"
        className={css.copy}
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy this message"}
        title={copied ? "Copied" : "Copy this message"}
        data-copied={copied || undefined}
      >
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
});
