/* Shared state primitives for the Remote Pi web shell.
 *
 * The shell is presentational: it renders whatever a typed view-model says and
 * never invents host data. When there is nothing to show it must say WHY and
 * what the next action is (plan 69, wave 1 acceptance) — hence three explicit
 * components instead of one generic "empty" box.
 *
 * All three are plain server-safe components (no hooks/state).
 */
import type { ReactNode } from "react";

import { Icon, type IconName } from "../core/icons";

import css from "./states.module.css";

export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <span
      className={css.spinner}
      style={{ width: size, height: size }}
      role="status"
      aria-label="加载中"
    />
  );
}

/** Loading with a guaranteed terminus — `label` is the state, not decoration. */
export function Loading({
  label,
  detail,
  boxed = false,
}: {
  label: string;
  detail?: string;
  boxed?: boolean;
}) {
  return (
    <div className={boxed ? css.loadingBoxed : css.loadingInline} aria-busy="true">
      <Spinner />
      <p className={css.loadingLabel}>{label}</p>
      {detail ? <p className={css.loadingDetail}>{detail}</p> : null}
    </div>
  );
}

/** Empty state: always explains the reason and, when one exists, the action. */
export function EmptyState({
  icon = "folder",
  title,
  detail,
  action,
  compact = false,
}: {
  icon?: IconName;
  title: string;
  detail?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <p className={css.emptyCompact}>
        {title}
        {detail ? <span className={css.emptyCompactDetail}>{detail}</span> : null}
      </p>
    );
  }
  return (
    <div className={css.emptyBox}>
      <span className={css.emptyIcon}>
        <Icon name={icon} size={22} />
      </span>
      <h3 className={css.emptyTitle} style={{ fontFamily: "var(--ff-display)" }}>
        {title}
      </h3>
      {detail ? <p className={css.emptyDetail}>{detail}</p> : null}
      {action}
    </div>
  );
}

/** Error state. `detail` is rendered as plain text — never as markup. */
export function ErrorState({
  title = "出错了",
  detail,
  code,
  action,
}: {
  title?: string;
  detail: string;
  code?: string;
  action?: ReactNode;
}) {
  return (
    <div role="alert" className={css.errorBox}>
      <p className={css.errorHead}>
        <Icon name="alert" size={14} />
        {title}
        {code ? <code className={css.errorCode}>{code}</code> : null}
      </p>
      <p className={css.errorDetail}>{detail}</p>
      {action}
    </div>
  );
}

/**
 * Small inline chip used for the connection phase (never a fake state).
 *
 * The tone only changes two colours, so the tone is applied as a modifier class
 * alongside the shared `pill` rule rather than as a second full recipe.
 */
export function StatusPill({
  label,
  tone = "idle",
  title,
}: {
  label: string;
  tone?: "ok" | "warn" | "error" | "idle" | "busy";
  title?: string;
}) {
  const dot =
    tone === "ok"
      ? css.pillDotOk
      : tone === "warn"
        ? css.pillDotWarn
        : tone === "error"
          ? css.pillDotError
          : tone === "busy"
            ? css.pillDotBusy
            : css.pillDotIdle;
  const text =
    tone === "error"
      ? css.pillTextError
      : tone === "warn"
        ? css.pillTextWarn
        : tone === "ok"
          ? css.pillTextOk
          : css.pillTextIdle;
  return (
    <span title={title} className={`${css.pill} ${text}`}>
      <span className={`${css.pillDot} ${dot}`} />
      {label}
    </span>
  );
}
