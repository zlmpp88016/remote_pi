"use client";

/* Model + thinking picker for the composer toolbar.
 *
 * Both surfaces are wired to the REAL host wire (PROTOCOL.md "App actions"):
 *   • `list_models` → `models_list {models, current}` — the picker rows and the
 *     highlighted current model come from the workspace Pi itself.
 *   • `model_set {provider, model_id}` → `action_ok{action:"model_set"}` |
 *     `action_error` — the selection echoes back the provider/id the Pi
 *     reported; the client never invents one.
 *   • `thinking_set {level}` — the fixed enum, offered only for a model whose
 *     `reasoning` flag is true.
 *
 * Everything here is presentation + selection intent. The container owns the
 * requests, the reply correlation and the state; this file renders what it is
 * given and reports clicks. No wire shape is minted here.
 */
import { useEffect, useRef, useState } from "react";

import { Icon } from "../core/icons";
import css from "./model-picker.module.css";

/** One row of the picker — already validated/projected by the container. */
export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  /** Plan/30: the model accepts image input — gates the attach control. */
  vision: boolean;
  contextWindow: number;
  /** True for the model the Pi reported as current. */
  current: boolean;
  /**
   * Thinking levels this model honours, in picker order.
   *
   * Absent means the model has no thinking surface. Present means it is
   * authoritative: the control renders exactly these, because offering a level the
   * model maps to `null` produced a switch that silently fell back to a neighbour —
   * the user picked `high` and got something else without any signal.
   */
  thinkingLevels?: ThinkingLevelId[];
}

export type ThinkingLevelId = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LABELS: Readonly<Record<ThinkingLevelId, string>> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export interface ModelPickerProps {
  /** Rows to show; empty while the first `models_list` is in flight. */
  options: readonly ModelOption[];
  /** True while a `list_models` request is in flight (nothing to show yet). */
  busy: boolean;
  /** The model a `model_set` is switching to, or null. The rows are already
   *  known, so this does NOT lock the picker — it only labels what is in
   *  flight, so a user who changes their mind can pick again immediately.
   *  `reasoning` comes from the clicked row, letting the thinking control
   *  reflect the PICKED model before the host confirms. */
  switchTo: { name: string; reasoning: boolean } | null;
  /** Fixed, client-authored reason shown when the picker cannot open. */
  disabledReason: string | null;
  /** A successful/failed action's fixed notice (never host text). */
  notice: string | null;
  onOpen: () => void;
  onSelect: (provider: string, modelId: string) => void;
  /** Current thinking level, or null when the host has not reported one. */
  thinking: ThinkingLevelId | null;
  /** True when the selected model supports the thinking surface. */
  thinkingAvailable: boolean;
  /**
   * Levels the SELECTED model honours, in picker order.
   *
   * The container passes the current model's list. Falls back to the full set only
   * when the model declared no per-level metadata (an older host), so a missing field
   * degrades to yesterday's behaviour instead of hiding working options.
   */
  thinkingLevels?: readonly ThinkingLevelId[];
  onThinkingChange: (level: ThinkingLevelId) => void;
}

/** Truncated context window for the row subtitle (e.g. 200000 → "200k"). */
function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function ModelPicker({
  options,
  busy,
  switchTo,
  disabledReason,
  notice,
  onOpen,
  onSelect,
  thinking,
  thinkingAvailable,
  thinkingLevels,
  onThinkingChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /*
   * The levels this control may offer.
   *
   * `thinkingLevels` is the selected model's own list. When it is absent the model
   * reported no per-level metadata, so every level is offered as before. An EMPTY
   * list is honoured rather than widened: it means the model declared reasoning but
   * honours nothing, and showing a switch there would be a lie.
   */
  const levels: readonly ThinkingLevelId[] = thinkingLevels ?? (Object.keys(THINKING_LABELS) as ThinkingLevelId[]);

  /* Only a real blocker (no workspace, not connected) or an in-flight LIST
     disables the control. A `model_set` in flight does NOT: the rows are
     already known and the user may want to pick a different one instead of
     waiting out the round trip. An empty list is shown as an empty popup,
     never as a dead button (that was a chicken-and-egg bug: the control could
     never trigger its own first load). */
  const disabled = disabledReason !== null || busy;
  const current = options.find((option) => option.current) ?? null;
  /* While a switch is in flight the Pi has not confirmed yet, but the target
     is known — showing it (with an ellipsis) is what makes the control look
     responsive instead of frozen on the old name. */
  const label =
    switchTo !== null
      ? `${switchTo.name}…`
      : current
        ? current.name
        : busy
          ? "loading models…"
          : "select a model";

  /* Close on outside click / Escape — a picker that traps focus or refuses to
     close is worse than no picker. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    const next = !open;
    setOpen(next);
    if (next) onOpen();
  };

  const reason =
    disabledReason ??
    (busy ? "A model request is still in flight." : null);

  return (
    <div ref={rootRef} className={css.root}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        title={reason ?? "Choose the model this workspace's Pi uses"}
        className={`${css.trigger} ${disabled ? css.triggerDisabled : css.triggerIdle}`}
      >
        <Icon name="cpu" size={15} />
        <span className={css.triggerLabel}>{label}</span>
      </button>

      {thinkingAvailable && !disabled && levels.length > 0 ? (
        <label
          className={css.thinking}
          title="Thinking level for the selected model"
        >
          <span className="sr-only">Thinking level</span>
          <select
            /*
             * Fall back to the first SUPPORTED level, not to a fixed `medium`.
             * A model honouring only `high` would otherwise render a value the
             * `<select>` has no option for, leaving the control blank while the
             * daemon ran some other level.
             */
            value={thinking !== null && levels.includes(thinking) ? thinking : levels[0]}
            onChange={(event) => onThinkingChange(event.target.value as ThinkingLevelId)}
            className={css.thinkingSelect}
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {THINKING_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {open ? (
        <div
          role="listbox"
          aria-label="Available models"
          className={css.menu}
        >
          {options.length === 0 ? (
            <p className={css.note}>
              {busy
                ? "Asking the host for this workspace's models…"
                : "The host reported no models for this workspace."}
            </p>
          ) : (
            options.map((option) => (
            <button
              key={`${option.provider}/${option.id}`}
              type="button"
              role="option"
              aria-selected={option.current}
              onClick={() => {
                setOpen(false);
                onSelect(option.provider, option.id);
              }}
              className={`${css.row} ${option.current ? css.rowCurrent : ""}`}
            >
              <span className={css.rowText}>
                <span className={css.rowName}>{option.name}</span>
                <span className={css.rowMeta}>
                  {option.provider} · {formatContext(option.contextWindow)} ctx
                  {option.reasoning ? " · reasoning" : ""}
                </span>
              </span>
              {option.current ? (
                <span className={css.rowBadge}>
                  current
                </span>
              ) : null}
            </button>
          ))
          )}
        </div>
      ) : null}

      {notice !== null ? (
        <span className="sr-only" role="status">
          {notice}
        </span>
      ) : null}
    </div>
  );
}
