/**
 * Per-turn divider with a collapsed summary.
 *
 * Copy of DeepSeek Harness' `TurnProcessNodeView`: a hairline rule above the
 * turn, its label in tertiary text, and a chevron that rotates when the turn's
 * process is expanded. The label reports what actually happened — `已完成，用时
 * 10秒` for a settled turn, `处理失败` for a failed one — so the rule carries
 * information instead of being decoration.
 *
 * The rule is 0.5px on purpose. A 1px border reads as a section boundary in this
 * UI; 0.5px keeps it a turn marker, which is what it is.
 */
import { memo, useState } from "react";
import { Icon } from "../core/icons";
import css from "./turn-divider.module.css";

export interface TurnDividerProps {
  /** 1-based turn number, shown when the label alone would be ambiguous. */
  index: number;
  /** Elapsed milliseconds for a settled turn, or `null` when it never finished. */
  elapsedMs: number | null;
  /** True when the turn ended in an error rather than completing. */
  failed: boolean;
  /** Whether this turn has any process content to unfold. */
  foldable: boolean;
  children?: React.ReactNode;
}

/** Compact duration: `10秒` / `1分20秒`. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

export const TurnDivider = memo(function TurnDivider({
  index,
  elapsedMs,
  failed,
  foldable,
  children,
}: TurnDividerProps) {
  const [open, setOpen] = useState(false);

  /*
   * The label states the OUTCOME first. A failed turn must not read as a
   * completion with a duration, and a turn that never settled has no duration to
   * report at all — it says so rather than showing a misleading 0秒.
   */
  const label = failed
    ? "处理失败"
    : elapsedMs === null
      ? "已完成"
      : `已完成，用时 ${formatElapsed(elapsedMs)}`;

  const row = (
    <>
      <span className={css.label}>{label}</span>
      {foldable && (
        <span className={css.chevron} data-open={open || undefined} aria-hidden>
          <Icon name="chevD" size={14} />
        </span>
      )}
    </>
  );

  return (
    <div className={css.turn} data-turn={index}>
      {foldable ? (
        <button
          type="button"
          className={css.root}
          data-open={open || undefined}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Turn ${index}: ${label}. ${open ? "折叠" : "Expand"} its process.`}
        >
          {row}
        </button>
      ) : (
        <div className={css.root} data-static="">{row}</div>
      )}
      {foldable && open && <div className={css.process}>{children}</div>}
    </div>
  );
});
