/**
 * Composer statistics pills.
 *
 * Two readings, mirroring DeepSeek Harness' composer dock:
 *
 *  - activity: `3 轮 3 步 · 174 tok/s`
 *  - usage:    `9.3K tok · 缓存命中 33%`
 *
 * A pill renders ONLY when the host actually reported the numbers behind it.
 * That rule is the whole point of this component: a `0 tok/s` or a `缓存命中 0%`
 * would look like a measured reading while really meaning "nothing arrived yet".
 */
import { memo } from "react";
import { Icon } from "../core/icons";
import css from "./stats-pills.module.css";

export interface ActivityStats {
  turns: number;
  steps: number;
  /** Decode speed, or `null` when no step carried usable timing. */
  tokensPerSecond: number | null;
}

export interface UsageSummaryStats {
  /** Display total, already formatted (e.g. `9.3K`). */
  totalText: string;
  /** Cache-hit share as whole-percent text, or `null` when nothing was prompted. */
  cacheHitPercent: string | null;
}

interface Props {
  activity: ActivityStats;
  usage: UsageSummaryStats;
  /**
   * Compact keeps only the two headline readings (speed and cache hit).
   * The composer hides secondary counts at narrow widths, matching DSH.
   */
  compact?: boolean;
}

/** Join the parts of one pill's label, dropping the ones that are absent. */
function joined(parts: readonly (string | null)[]): string {
  return parts.filter((p): p is string => p !== null && p !== "").join(" · ");
}

export const StatsPills = memo(function StatsPills({ activity, usage, compact = false }: Props) {
  const speed = activity.tokensPerSecond === null
    ? null
    : `${activity.tokensPerSecond >= 10
        ? String(Math.round(activity.tokensPerSecond))
        : String(Math.round(activity.tokensPerSecond * 10) / 10)} tok/s`;

  const counts = compact ? null : `${activity.turns} 轮 ${activity.steps} 步`;
  const activityLabel = joined([counts, speed]);

  const totalPart = compact ? null : `${usage.totalText} tok`;
  const cachePart = usage.cacheHitPercent === null ? null : `缓存命中 ${usage.cacheHitPercent}%`;
  const usageLabel = joined([totalPart, cachePart]);

  /*
   * Nothing measured means nothing shown. The host sends no usage at all for a
   * turn that never settled, and rendering a zero would misreport that as a
   * measured value.
   */
  if (activityLabel === "" && usageLabel === "") return null;

  return (
    <div className={css.row} aria-label="Conversation statistics">
      {activityLabel !== "" && (
        <span className={css.pill} data-stat="activity">
          <Icon name="gauge" size={13} />
          <span className={css.label}>{activityLabel}</span>
        </span>
      )}
      {usageLabel !== "" && (
        <span className={css.pill} data-stat="usage">
          <Icon name="database" size={13} />
          <span className={css.label}>{usageLabel}</span>
        </span>
      )}
    </div>
  );
});
