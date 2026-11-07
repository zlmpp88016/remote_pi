/**
 * Plan/80 — the Settings dock panel.
 *
 * ## What this panel is, and what the previous one was not
 *
 * The first version of this file was named `Settings` and only edited
 * `models.json`. That was a copy-vs-behaviour defect of exactly the kind
 * `BUTTON-AUDIT.md` §7 exists to catch: the label promised preferences and the
 * panel delivered one file. Model providers now live in their own dock tab
 * (`ModelProvidersPanel`), and this panel holds actual settings.
 *
 * ## The two layers, kept visibly separate
 *
 * 1. **This browser** — visual preset. Purely local: written to `localStorage`,
 *    never sent to the host. It is the one setting that cannot live on the host,
 *    because it describes the client's own appearance.
 * 2. **This host** — `hideThinkingBlock` and the retry policy, read from and written
 *    to the host's `settings.json` through a positive whitelist.
 *
 * pi's own `theme` value is displayed READ-ONLY. It selects a terminal theme for the
 * TUI, and this panel does not offer to change it — a web colour picker silently
 * rewriting a TUI theme would be a surprise across machines.
 */
import { useMemo, useState } from "react";

import { EmptyState, Spinner } from "./states";
import type { SettingsDescribeOk, SettingsOpWire } from "@/lib/remote-pi/protocol";
import { THEME_PRESETS, presetById, type ThemePreset } from "@/lib/theme-presets";
import { THEME_MODES, type ResolvedMode, type ThemeMode } from "@/lib/theme-mode";
import css from "./settings-panel.module.css";

export type SettingsPhase = "idle" | "loading" | "saving";

export interface SettingsPanelProps {
  data: SettingsDescribeOk | null;
  phase: SettingsPhase;
  error: string | null;
  saved: string | null;
  disabledReason: string | null;
  hostName: string | null;
  /** Plan/81 — which palette is in effect. Selects light vs dark. */
  themeMode: ThemeMode;
  /** The concrete palette, so "跟随系统" can say what it resolved to. */
  resolvedMode: ResolvedMode;
  onModeChange: (mode: ThemeMode) => void;
  /** The active browser-local accent preset. */
  presetId: string;
  onPresetChange: (preset: ThemePreset) => void;
  onReload: () => void;
  onSave: (ops: SettingsOpWire[]) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const {
    data, phase, error, saved, disabledReason, hostName,
    themeMode, resolvedMode, onModeChange, presetId, onPresetChange, onReload, onSave,
  } = props;

  /* Draft edits, seeded lazily from the host payload (same reasoning as the model
   * panel: a setState inside an effect cascades renders). */
  const [draft, setDraft] = useState<null | {
    hideThinkingBlock: boolean | null;
    retryEnabled: boolean | null;
    maxRetries: number | null;
    baseDelayMs: number | null;
    providerMaxDelayMs: number | null;
  }>(null);

  const seeded = useMemo(() => {
    if (data === null) return null;
    return {
      hideThinkingBlock: data.appearance.hide_thinking_block,
      retryEnabled: data.behaviour.retry_enabled,
      maxRetries: data.behaviour.retry_max_retries,
      baseDelayMs: data.behaviour.retry_base_delay_ms,
      providerMaxDelayMs: data.behaviour.retry_provider_max_retry_delay_ms,
    };
  }, [data]);

  const active = draft ?? seeded;
  const activePreset = presetById(presetId);

  const inert = disabledReason !== null;
  const readOnly = data !== null && (!data.file.parseable || !data.file.writable);
  const busy = phase === "loading" || phase === "saving";

  const ops = useMemo<SettingsOpWire[]>(() => {
    if (data === null || seeded === null || active === null) return [];
    const out: SettingsOpWire[] = [];
    if (active.hideThinkingBlock !== seeded.hideThinkingBlock && active.hideThinkingBlock !== null) {
      out.push({ op: "set", path: "hideThinkingBlock", value: active.hideThinkingBlock });
    }
    if (active.retryEnabled !== seeded.retryEnabled && active.retryEnabled !== null) {
      out.push({ op: "set", path: "retry.enabled", value: active.retryEnabled });
    }
    if (active.maxRetries !== seeded.maxRetries && active.maxRetries !== null) {
      out.push({ op: "set", path: "retry.maxRetries", value: active.maxRetries });
    }
    if (active.baseDelayMs !== seeded.baseDelayMs && active.baseDelayMs !== null) {
      out.push({ op: "set", path: "retry.baseDelayMs", value: active.baseDelayMs });
    }
    if (active.providerMaxDelayMs !== seeded.providerMaxDelayMs && active.providerMaxDelayMs !== null) {
      out.push({ op: "set", path: "retry.provider.maxRetryDelayMs", value: active.providerMaxDelayMs });
    }
    return out;
  }, [data, seeded, active]);

  if (inert) {
    return <EmptyState icon="settings" title="设置不可用" detail={disabledReason} />;
  }
  if (phase === "loading" && data === null) {
    return (
      <div className={css.loading}>
        <Spinner />
        <span>正在读取该主机的设置…</span>
      </div>
    );
  }

  const patch = (next: Partial<NonNullable<typeof active>>) => {
    if (seeded === null) return;
    setDraft({ ...(active ?? seeded), ...next });
  };

  return (
    <div className={css.root}>
      <div className={css.head}>
        <button
          type="button"
          className={css.reload}
          disabled={busy}
          onClick={onReload}
          aria-label="重新加载该主机的设置"
          title="重新读取该主机的 settings.json。"
        >
          重新加载
        </button>
        <span className={css.headTitle}>
          {hostName === null ? "设置" : `设置 · ${hostName}`}
        </span>
      </div>

      <div className={css.scroller}>
        {/* ── This browser ─────────────────────────────────────────────────── */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>本浏览器</h3>
          <p className={css.sectionNote}>
            仅对当前浏览器生效，不会发送到主机。
          </p>

          {/*
           * Appearance mode comes FIRST because it selects the palette; the preset
           * below only adds an accent on top of it. Two axes, stated separately so
           * "I picked Dark and it is still white" cannot happen silently.
           */}
          <div className={css.field}>
            <span className={css.label}>外观</span>
            <div className={css.presetGrid} role="radiogroup" aria-label="外观">
              {THEME_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === themeMode}
                  className={m.id === themeMode ? css.presetActive : css.preset}
                  id={`settings-mode-${m.id}`}
                  onClick={() => onModeChange(m.id)}
                >
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
            <span className={css.presetDetail}>
              {THEME_MODES.find((m) => m.id === themeMode)?.detail ?? ""}
              {themeMode === "system" ? ` 当前为${resolvedMode}。` : ""}
            </span>
          </div>

          <div className={css.field}>
            <span className={css.label}>强调色预设</span>
            <div className={css.presetGrid} role="radiogroup" aria-label="强调色预设">
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === activePreset.id}
                  className={p.id === activePreset.id ? css.presetActive : css.preset}
                  onClick={() => onPresetChange(p)}
                >
                  <span
                    className={css.swatch}
                    style={p.accent === "" ? undefined : { background: p.accent }}
                    data-preset={p.id}
                  />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <span className={css.presetDetail}>{activePreset.detail}</span>
          </div>
        </section>

        {/* ── This host ────────────────────────────────────────────────────── */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>该主机</h3>
          <p className={css.sectionNote}>
            从该主机自己的设置文件读取，并保存回该文件。
          </p>

          {data === null ? (
            <p className={css.muted}>
              {error ?? "无法读取该主机的设置。"}
            </p>
          ) : (
            <>
              {!data.file.parseable ? (
                <p className={css.warn}>
                  该主机的设置文件无法解析，因此在此为只读。请在主机上修复后重新加载。
                </p>
              ) : null}
              {data.file.parseable && !data.file.writable ? (
                <p className={css.warn}>
                  守护进程无法写入该主机的设置文件，因此保存已禁用。
                </p>
              ) : null}

              <div className={css.field}>
                <span className={css.label}>终端主题（只读）</span>
                <span className={css.readonlyValue} id="settings-host-theme">
                  {data.appearance.theme ?? "该主机未设置"}
                </span>
                <span className={css.hint}>
                  选择 pi 的终端外观。请用 pi CLI 修改；在此展示是为了避免混淆两套主题概念。
                </span>
              </div>

              <label className={css.toggleRow}>
                <input
                  type="checkbox"
                  id="settings-hide-thinking"
                  checked={active?.hideThinkingBlock === true}
                  disabled={busy || readOnly}
                  onChange={(e) => patch({ hideThinkingBlock: e.target.checked })}
                />
                <span>隐藏思考块</span>
              </label>

              <label className={css.toggleRow}>
                <input
                  type="checkbox"
                  id="settings-retry-enabled"
                  checked={active?.retryEnabled === true}
                  disabled={busy || readOnly}
                  onChange={(e) => patch({ retryEnabled: e.target.checked })}
                />
                <span>重试失败的提供方调用</span>
              </label>

              <div className={css.numberGrid}>
                <label className={css.smallField}>
                  <span className={css.smallLabel}>最大重试次数</span>
                  <input
                    className={css.input}
                    id="settings-max-retries"
                    type="number"
                    min={0}
                    max={100}
                    value={active?.maxRetries ?? ""}
                    disabled={busy || readOnly}
                    onChange={(e) => patch({ maxRetries: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
                <label className={css.smallField}>
                  <span className={css.smallLabel}>基础延迟（毫秒）</span>
                  <input
                    className={css.input}
                    id="settings-base-delay"
                    type="number"
                    min={0}
                    max={600000}
                    value={active?.baseDelayMs ?? ""}
                    disabled={busy || readOnly}
                    onChange={(e) => patch({ baseDelayMs: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
                <label className={css.smallField}>
                  <span className={css.smallLabel}>最大延迟（毫秒）</span>
                  <input
                    className={css.input}
                    id="settings-provider-max-delay"
                    type="number"
                    min={0}
                    max={600000}
                    value={active?.providerMaxDelayMs ?? ""}
                    disabled={busy || readOnly}
                    onChange={(e) =>
                      patch({ providerMaxDelayMs: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                </label>
              </div>
            </>
          )}

          {error !== null && data !== null ? <p className={css.error}>{error}</p> : null}
          {saved !== null ? <p className={css.saved}>{saved}</p> : null}
        </section>

        {/* ── Edited elsewhere ─────────────────────────────────────────────── */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>在别处编辑</h3>
          <ul className={css.elsewhereList}>
            <li>
              <strong>模型提供方和模型</strong> — 本停靠栏的 <em>模型</em> 标签页。
            </li>
            <li>
              <strong>软件包和技能</strong> — <em>插件</em> 标签页，有独立的安装和启用流程。
            </li>
            <li>
              <strong>快捷键</strong> — 主机上的独立文件，无法在此编辑。
            </li>
          </ul>
        </section>
      </div>

      <div className={css.footer}>
        <button
          type="button"
          className={css.save}
          id="settings-save"
          disabled={inert || readOnly || busy || ops.length === 0}
          onClick={() => onSave(ops)}
          title={
            readOnly
              ? "该主机的设置无法在此编辑。"
              : ops.length === 0
                ? "没有需要保存的更改。"
                : "将这些更改写入该主机的设置。"
          }
        >
          {phase === "saving" ? "正在保存…" : "保存"}
        </button>
        <span className={css.muted}>
          {ops.length === 0 ? "无待保存的更改" : `${ops.length} 项待保存`}
        </span>
      </div>
    </div>
  );
}
