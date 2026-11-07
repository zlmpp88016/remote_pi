/**
 * Plan/79 — the Settings dock panel: edit the HOST's `~/.pi/agent/models.json`.
 *
 * ## The one rule this panel exists to honour
 *
 * The key is write-only. It arrives here as `has_key: boolean` and never as a
 * value, a mask, or a length. Three states are therefore kept lexically distinct
 * and cannot be confused by the form:
 *
 *   untouched  → the user did not touch the box        → NO op is emitted
 *   typed      → the user entered a new key            → a `set` op with that value
 *   cleared    → the user pressed "移除" explicitly  → an `unset` op, behind a
 *                                                        separate destructive
 *                                                        confirmation
 *
 * The classic accident is a form that pre-fills nothing, renders an empty password
 * box, and submits the whole object on save — turning "I did not type anything"
 * into "set the key to the empty string". That is why saving here emits a
 * path-addressed DIFF rather than a document, and why an untouched key produces no
 * op at all. The host independently refuses a blank secret `set`, so even a client
 * bug cannot destroy the credential.
 *
 * Host prose, absolute paths, errno and stack text are never rendered: every
 * sentence below is authored here.
 */
import { useCallback, useMemo, useState } from "react";

import { EmptyState, Spinner } from "./states";
import type { ModelsDescribeOk, ModelsOpWire } from "@/lib/remote-pi/protocol";
import css from "./model-providers-panel.module.css";

/** What the panel is currently doing. */
export type SettingsPhase = "idle" | "loading" | "saving";

export interface ModelProvidersPanelProps {
  data: ModelsDescribeOk | null;
  phase: SettingsPhase;
  /** Client-authored sentence for the last failure, or null. */
  error: string | null;
  /** Client-authored sentence for a successful save, or null. */
  saved: string | null;
  /** Set when the surface cannot be used at all (host lacks the capability, etc.). */
  disabledReason: string | null;
  /** Host device name — never an absolute path. */
  hostName: string | null;
  onReload: () => void;
  onSave: (ops: ModelsOpWire[]) => void;
}

interface ModelRow {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  thinkingLevelMap: Record<string, string | null>;
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Projects one wire model into the shape the form edits. */
function toRow(raw: unknown): ModelRow {
  const m = asRecord(raw);
  const tlm = asRecord(m["thinkingLevelMap"]);
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    const v = tlm[level];
    map[level] = typeof v === "string" ? v : null;
  }
  const input = Array.isArray(m["input"]) ? m["input"].filter((x): x is string => typeof x === "string") : ["text"];
  return {
    id: str(m["id"], ""),
    name: str(m["name"], str(m["id"], "")),
    contextWindow: num(m["contextWindow"], 128_000),
    maxTokens: num(m["maxTokens"], 16_384),
    reasoning: m["reasoning"] === true,
    input,
    thinkingLevelMap: map,
  };
}

function providerIdsOf(data: ModelsDescribeOk | null): string[] {
  if (data === null) return [];
  const providers = asRecord(data.config["providers"]);
  return Object.keys(providers).sort();
}

function modelsOf(data: ModelsDescribeOk | null, providerId: string | null): ModelRow[] {
  if (data === null || providerId === null) return [];
  const providers = asRecord(data.config["providers"]);
  const p = asRecord(providers[providerId]);
  const models = Array.isArray(p["models"]) ? p["models"] : [];
  return models.map(toRow);
}

function providerField(data: ModelsDescribeOk | null, providerId: string | null, field: string): string {
  if (data === null || providerId === null) return "";
  const providers = asRecord(data.config["providers"]);
  return str(asRecord(providers[providerId])[field], "");
}

export function ModelProvidersPanel(props: ModelProvidersPanelProps) {
  const { data, phase, error, saved, disabledReason, hostName, onReload, onSave } = props;

  const providers = useMemo(() => providerIdsOf(data), [data]);
  const [providerId, setProviderId] = useState<string | null>(null);
  /** The key box is ALWAYS empty: there is no value to pre-fill and pre-filling a
   *  mask is the accident this design refuses. */
  const [newKey, setNewKey] = useState("");
  const [pendingRemoveKey, setPendingRemoveKey] = useState(false);

  /*
   * Draft state is a SINGLE object keyed by provider, and it is seeded lazily
   * rather than in an effect. Two effects that mirrored `data` into local state
   * caused a synchronous setState during render, which React flags as a cascading
   * render; deriving the draft on first read avoids that entirely and is also more
   * correct — a payload for a DIFFERENT provider must not seed this one's draft.
   */
  const [draft, setDraft] = useState<null | {
    providerId: string;
    baseUrl: string;
    api: string;
    rows: ModelRow[];
  }>(null);

  const effectiveProviderId = providerId ?? (providers.length > 0 ? providers[0]! : null);
  const seeded = useMemo(() => {
    if (data === null || effectiveProviderId === null) return null;
    return {
      providerId: effectiveProviderId,
      baseUrl: providerField(data, effectiveProviderId, "baseUrl"),
      api: providerField(data, effectiveProviderId, "api"),
      rows: modelsOf(data, effectiveProviderId),
    };
  }, [data, effectiveProviderId]);

  /* The draft wins only while it belongs to the provider being shown AND the
   * payload revision it was seeded from is still the one on screen. A save or a
   * reload replaces `data`, which invalidates the draft by identity. */
  const active = draft !== null && seeded !== null && draft.providerId === seeded.providerId ? draft : seeded;
  const baseUrl = active?.baseUrl ?? "";
  const api = active?.api ?? "";
  /* Memoised so `buildOps` below does not see a new array identity each render. */
  const rows = useMemo<ModelRow[]>(() => active?.rows ?? [], [active]);
  const setBaseUrl = (v: string) => {
    if (seeded === null) return;
    setDraft({ ...seeded, ...(active ?? {}), providerId: seeded.providerId, baseUrl: v });
  };
  const setApi = (v: string) => {
    if (seeded === null) return;
    setDraft({ ...seeded, ...(active ?? {}), providerId: seeded.providerId, api: v });
  };
  const setRows = (next: (prev: ModelRow[]) => ModelRow[]) => {
    if (seeded === null) return;
    const base = active ?? seeded;
    setDraft({ ...base, providerId: seeded.providerId, rows: next(base.rows) });
  };

  const hasKey = useMemo(() => {
    /* MUST use the DERIVED id: the raw state is null until the user picks a
     * provider, which would report every key as absent on first render. */
    if (data === null || effectiveProviderId === null) return false;
    return data.secrets[`providers.${effectiveProviderId}.apiKey`]?.has_key === true;
  }, [data, effectiveProviderId]);

  const inert = disabledReason !== null;
  const readOnly = data !== null && (!data.file.parseable || !data.file.writable);
  const busy = phase === "loading" || phase === "saving";

  /** Builds the diff. An untouched key contributes nothing — the whole point. */
  const buildOps = useCallback((): ModelsOpWire[] => {
    if (data === null || effectiveProviderId === null) return [];
    const ops: ModelsOpWire[] = [];
    const base: (string | number)[] = ["providers", effectiveProviderId];

    if (baseUrl !== providerField(data, effectiveProviderId, "baseUrl")) {
      ops.push({ op: "set", path: [...base, "baseUrl"], value: baseUrl });
    }
    if (api !== providerField(data, effectiveProviderId, "api")) {
      ops.push({ op: "set", path: [...base, "api"], value: api });
    }

    /* Key: three-way, never conflated. */
    if (pendingRemoveKey) {
      ops.push({ op: "unset", path: [...base, "apiKey"] });
    } else if (newKey.trim() !== "") {
      ops.push({ op: "set", path: [...base, "apiKey"], value: newKey.trim() });
    }

    const original = modelsOf(data, effectiveProviderId);
    const originalById = new Map(original.map((r) => [r.id, r]));

    /* Removals first, by id, so a later insert of the same id is unambiguous. */
    for (const o of original) {
      if (!rows.some((r) => r.id === o.id)) {
        ops.push({ op: "remove", path: [...base, "models", o.id] });
      }
    }
    for (const row of rows) {
      const prev = originalById.get(row.id);
      if (prev === undefined) {
        ops.push({
          op: "insert",
          path: [...base, "models", -1],
          value: {
            id: row.id,
            name: row.name,
            reasoning: row.reasoning,
            api,
            thinkingLevelMap: row.thinkingLevelMap,
            input: row.input,
            contextWindow: row.contextWindow,
            maxTokens: row.maxTokens,
          },
        });
        continue;
      }
      /* Per-field sets, so two models never overwrite each other's untouched
       * fields. */
      if (row.name !== prev.name) ops.push({ op: "set", path: [...base, "models", row.id, "name"], value: row.name });
      if (row.contextWindow !== prev.contextWindow) {
        ops.push({ op: "set", path: [...base, "models", row.id, "contextWindow"], value: row.contextWindow });
      }
      if (row.maxTokens !== prev.maxTokens) {
        ops.push({ op: "set", path: [...base, "models", row.id, "maxTokens"], value: row.maxTokens });
      }
      if (row.reasoning !== prev.reasoning) {
        ops.push({ op: "set", path: [...base, "models", row.id, "reasoning"], value: row.reasoning });
      }
      if (row.input.join(",") !== prev.input.join(",")) {
        ops.push({ op: "set", path: [...base, "models", row.id, "input"], value: row.input });
      }
      for (const level of THINKING_LEVELS) {
        if (row.thinkingLevelMap[level] !== prev.thinkingLevelMap[level]) {
          ops.push({
            op: "set",
            path: [...base, "models", row.id, "thinkingLevelMap", level],
            value: row.thinkingLevelMap[level],
          });
        }
      }
    }
    return ops;
  }, [data, effectiveProviderId, baseUrl, api, newKey, pendingRemoveKey, rows]);

  const ops = buildOps();
  const canSave = !inert && !readOnly && !busy && ops.length > 0;

  if (inert) {
    return <EmptyState icon="settings" title="设置不可用" detail={disabledReason} />;
  }
  if (phase === "loading" && data === null) {
    return (
      <div className={css.loading}>
        <Spinner />
        <span>正在读取该主机的模型配置…</span>
      </div>
    );
  }
  if (data === null) {
    return <EmptyState icon="alert" title="模型配置无法读取" detail={error ?? "无法读取该主机的模型配置。"} />;
  }

  return (
    <div className={css.root}>
      <div className={css.head}>
        <button
          type="button"
          className={css.reload}
          disabled={busy}
          onClick={onReload}
          aria-label="重新加载模型配置"
          title="重新读取该主机的 models.json。"
        >
          重新加载
        </button>
        <span className={css.headTitle}>
          {hostName === null ? "该主机上的模型" : `${hostName} 上的模型`}
        </span>
      </div>

      <div className={css.scroller}>
        {!data.file.parseable ? (
          <p className={css.warn}>
            该主机的模型配置无法解析，所以此处只能查看。请在主机上修好文件后重新加载。
          </p>
        ) : null}
        {data.file.parseable && !data.file.writable ? (
          <p className={css.warn}>
            主机上的模型配置文件对守护进程不可写，因此无法保存。
          </p>
        ) : null}
        {data.file.exists && !data.file.mode_safe ? (
          <p className={css.warn}>
            该文件可被主机上的其他用户读取。它保存了 API 密钥，建议把权限收紧到仅所有者。
          </p>
        ) : null}

        {providers.length === 0 ? (
          <p className={css.muted}>该主机未配置任何提供方。</p>
        ) : (
          <>
            <label className={css.field}>
              <span className={css.label}>提供方</span>
              <select
                id="settings-provider"
                className={css.select}
                value={effectiveProviderId ?? ""}
                disabled={busy || readOnly}
                onChange={(e) => {
                  /* A different provider is a different document subtree: keeping
                   * the previous draft would write its fields into this one. */
                  setProviderId(e.target.value);
                  setDraft(null);
                  setNewKey("");
                  setPendingRemoveKey(false);
                }}
              >
                {providers.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>

            <label className={css.field}>
              <span className={css.label}>基础 URL</span>
              <input
                id="settings-base-url"
                className={css.input}
                type="text"
                value={baseUrl}
                disabled={busy || readOnly}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>

            <label className={css.field}>
              <span className={css.label}>API 风格</span>
              <input
                id="settings-api"
                className={css.input}
                type="text"
                value={api}
                disabled={busy || readOnly}
                onChange={(e) => setApi(e.target.value)}
              />
            </label>

            {/*
             * The key box. `value` is bound to `newKey`, which starts empty and is
             * never seeded from the host — there is nothing to seed it with. The
             * placeholder states the two facts a user needs: whether a key exists,
             * and that leaving it alone preserves it.
             */}
            <label className={css.field}>
              <span className={css.label}>
                API 密钥
                <span className={hasKey ? css.badgeOn : css.badgeOff}>
                  {hasKey ? "已配置" : "未设置"}
                </span>
              </span>
              <input
                id="settings-api-key"
                className={css.input}
                type="password"
                autoComplete="off"
                value={newKey}
                disabled={busy || readOnly || pendingRemoveKey}
                placeholder={hasKey ? "留空则保留当前密钥" : "输入密钥以设置"}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </label>

            {hasKey ? (
              pendingRemoveKey ? (
                <div className={css.dangerRow}>
                  <span className={css.dangerText}>
                    The stored key will be removed when you save.
                  </span>
                  <button
                    type="button"
                    className={css.linkButton}
                    disabled={busy}
                    onClick={() => setPendingRemoveKey(false)}
                  >
                    保留密钥
                  </button>
                </div>
              ) : (
                <div className={css.dangerRow}>
                  <button
                    type="button"
                    className={css.removeButton}
                    disabled={busy || readOnly}
                    onClick={() => setPendingRemoveKey(true)}
                    title="移除已保存的 API 密钥。保存后生效。"
                  >
                    移除密钥
                  </button>
                </div>
              )
            ) : null}

            <div className={css.modelsHead}>
              <span className={css.label}>{`模型（${rows.length}）`}</span>
              <button
                type="button"
                className={css.addButton}
                disabled={busy || readOnly}
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    {
                      /* A placeholder id that the user must replace; saving with a
                       * duplicate id is refused by the host's validation. */
                      id: `new-model-${prev.length + 1}`,
                      name: `new-model-${prev.length + 1}`,
                      contextWindow: 128_000,
                      maxTokens: 16_384,
                      reasoning: false,
                      input: ["text"],
                      thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
                    },
                  ])
                }
              >
                添加模型
              </button>
            </div>

            <ul className={css.modelList}>
              {rows.map((row, index) => (
                <li key={`${row.id}-${index}`} className={css.modelRow}>
                  <div className={css.modelTop}>
                    <span className={css.modelId}>{row.id}</span>
                    <button
                      type="button"
                      className={css.removeButton}
                      disabled={busy || readOnly}
                      aria-label={`Remove ${row.id}`}
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      移除
                    </button>
                  </div>
                  <div className={css.modelGrid}>
                    <label className={css.smallField}>
                      <span className={css.smallLabel}>上下文</span>
                      <input
                        className={css.input}
                        type="number"
                        value={row.contextWindow}
                        disabled={busy || readOnly}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setRows((prev) => prev.map((r, i) => (i === index ? { ...r, contextWindow: v } : r)));
                        }}
                      />
                    </label>
                    <label className={css.smallField}>
                      <span className={css.smallLabel}>上限</span>
                      <input
                        className={css.input}
                        type="number"
                        value={row.maxTokens}
                        disabled={busy || readOnly}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setRows((prev) => prev.map((r, i) => (i === index ? { ...r, maxTokens: v } : r)));
                        }}
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {error !== null ? <p className={css.error}>{error}</p> : null}
        {saved !== null ? <p className={css.saved}>{saved}</p> : null}
      </div>

      <div className={css.footer}>
        <button
          type="button"
          className={css.save}
          disabled={!canSave}
          onClick={() => onSave(ops)}
          title={
            readOnly
              ? "该文件无法在此编辑。"
              : ops.length === 0
                ? "没有需要保存的更改。"
                : "将这些更改写入该主机的 models.json。"
          }
        >
          {phase === "saving" ? "Saving…" : "保存"}
        </button>
        <span className={css.muted}>
          {ops.length === 0
            ? "没有待保存的改动"
            : `${ops.length} 处待保存改动`}
        </span>
      </div>
    </div>
  );
}
