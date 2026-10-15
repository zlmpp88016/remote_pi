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

import { Icon, type IconName } from "./icons";

export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <span
      className="inline-block shrink-0 animate-spin rounded-full border-[1.6px] border-white/25 border-t-[#4fc3f7]"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
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
    <div
      className={boxed ? "flex flex-col items-center gap-3 px-6 py-14 text-center" : "flex items-center gap-2"}
      aria-busy="true"
    >
      <Spinner />
      <p className="text-[13px] text-[#a3a3a3]">{label}</p>
      {detail ? <p className="font-mono text-[11px] text-[#a3a3a3]">{detail}</p> : null}
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
      <p className="px-2 py-3 text-[12.5px] leading-relaxed text-[#a3a3a3]">
        {title}
        {detail ? <span className="mt-1 block">{detail}</span> : null}
      </p>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-[15px] border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[#4fc3f7]">
        <Icon name={icon} size={22} />
      </span>
      <h3
        className="text-[16px] font-semibold tracking-[-0.01em] text-white"
        style={{ fontFamily: "var(--ff-display)" }}
      >
        {title}
      </h3>
      {detail ? <p className="max-w-[46ch] text-[13px] leading-relaxed text-[#a3a3a3]">{detail}</p> : null}
      {action}
    </div>
  );
}

/** Error state. `detail` is rendered as plain text — never as markup. */
export function ErrorState({
  title = "Something failed",
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
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-[10px] border border-[rgba(242,90,90,0.35)] bg-[rgba(242,90,90,0.08)] px-3 py-2.5"
    >
      <p className="flex items-center gap-2 text-[12.5px] font-medium text-[#f25a5a]">
        <Icon name="alert" size={14} />
        {title}
        {code ? <code className="font-mono text-[11px] text-[#f25a5a]/80">{code}</code> : null}
      </p>
      <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[#a3a3a3]">{detail}</p>
      {action}
    </div>
  );
}

/** Small inline chip used for the connection phase (never a fake state). */
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
      ? "bg-[#5fd38a]"
      : tone === "warn"
        ? "bg-[#f7ad31]"
        : tone === "error"
          ? "bg-[#f25a5a]"
          : tone === "busy"
            ? "bg-[#4fc3f7]"
            : "bg-[#7f8287]";
  const text =
    tone === "error"
      ? "text-[#f25a5a]"
      : tone === "warn"
        ? "text-[#f7ad31]"
        : tone === "ok"
          ? "text-[#d4d4d4]"
          : "text-[#a3a3a3]";
  return (
    <span
      title={title}
      className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.045] px-2.5 font-mono text-[11px] ${text}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
