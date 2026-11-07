"use client";

/* Automations — scheduled tasks the DAEMON runs, shown in the dock.
 *
 * ## What this actually is
 *
 * The host has had a complete scheduled-task engine since plan/39: a durable
 * registry (`~/.pi/remote/cron.json`), croner timers, catch-up after a restart,
 * wake-up of a stopped workspace, and a fire log. The web client had no view of
 * it, so the sidebar rendered "自动化" as a permanently disabled row.
 *
 * This panel is that view — a projection, not a second subsystem. There is one
 * source of truth and it is the daemon's registry; nothing here writes storage
 * of its own.
 *
 * ## Why the cron expression is shown, not a friendly "kind"
 *
 * A cron expression is authoritative; "every 5 minutes" is a LABEL derived from
 * it, and it can be wrong for expressions the presets cannot describe. So the
 * row shows the raw expression when the kind is `custom`, and the derived label
 * otherwise. A derived value that the expression does not imply arrives as
 * `null` from the host and is never rendered as zero.
 *
 * ## Why the fire result is shown verbatim
 *
 * `last_status` is the daemon's own vocabulary. "skipped_busy" and "delivered"
 * look similar in a log but mean opposite things to a user wondering why a task
 * did not appear to run. Mapping them to friendlier words would erase exactly
 * the distinction that matters.
 *
 * ## Drill-down, same contract as Plan and Plugins
 *
 * Three views, exactly one mounted: LIST, DETAIL, CREATE. The dock is 280-600
 * px, so a master-detail split gives ~18 characters per side, and stacking a
 * detail above the list is the off-screen bug that already shipped once here.
 * The rule that prevents both: the root never scrolls; exactly ONE child does.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../core/icons";
import css from "./automations-panel.module.css";

/** One projected task, as the host described it. Mirrors `ScheduleJobView`. */
export interface AutomationRow {
  id: string;
  daemonId: string;
  schedule: string;
  kind: "every_minutes" | "every_hours" | "daily" | "weekly" | "custom";
  everyMinutes: number | null;
  everyHours: number | null;
  time: string | null;
  weekdays: number[] | null;
  tz: string | null;
  prompt: string;
  enabled: boolean;
  skipIfBusy: boolean;
  wake: boolean;
  catchup: boolean;
  createdAt: string;
  lastRun: string | null;
  lastStatus: string | null;
  nextRun: string | null;
  /** Pinned model, or null when this task inherits the session's model. */
  model: { provider: string; id: string; name: string | null } | null;
  /** True when each fire opens its own session instead of the live one. */
  freshSession: boolean;
}

/** A fire the host pushed while this panel was open. Newest first. */
export interface AutomationFire {
  jobId: string;
  result: string;
  firedAt: string;
  promptPreview: string;
}

export interface AutomationsPanelProps {
  tasks: readonly AutomationRow[];
  /** Fires observed since the panel opened; newest first. */
  fires: readonly AutomationFire[];
  /** `null` when the host serves automations; a sentence when it cannot. */
  disabledReason: string | null;
  /** A transient failure notice (create/delete/toggle failed). */
  notice: string | null;
  busy: boolean;
  /** Human-readable workspace names, keyed by daemon id. Never a host path. */
  workspaceNames: ReadonlyMap<string, string>;
  onCreate: (input: {
    schedule: string;
    prompt: string;
    tz: string | null;
    skipIfBusy: boolean;
    wake: boolean;
    catchup: boolean;
    daemonId: string | null;
    /** Null means inherit the session's model. */
    model: { provider: string; id: string } | null;
    /** Each fire opens its own session instead of appending to the live one. */
    freshSession: boolean;
  }) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onRunNow: (id: string) => void;
  onRefresh: () => void;
  /** The workspace the user is currently looking at, used as the create default. */
  activeDaemonId: string | null;
  /** Models the workspace can run, from the same catalog the composer uses. */
  modelOptions: readonly { id: string; name: string; provider: string }[];
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Presets the create form can build.
 *
 * `expr` is a 5-field cron; `null` means "the user types their own". Keeping the
 * presets as literal expressions (rather than a kind + fields that get compiled
 * later) means what the user picks is exactly what the host receives.
 */
const PRESETS: readonly { id: string; label: string; expr: string | null }[] = [
  { id: "5m", label: "每 5 分钟", expr: "*/5 * * * *" },
  { id: "15m", label: "每 15 分钟", expr: "*/15 * * * *" },
  { id: "1h", label: "每小时", expr: "0 * * * *" },
  { id: "daily9", label: "每天 09:00", expr: "0 9 * * *" },
  { id: "daily23", label: "每天 23:00", expr: "0 23 * * *" },
  { id: "weekdays9", label: "工作日 09:00", expr: "0 9 * * 1-5" },
  { id: "custom", label: "自定义 cron 表达式", expr: null },
];

/** Renders a derived label, or the raw expression when there is no honest label. */
/**
 * Stable key for a model option.
 *
 * `provider` and `id` are both needed: the same id can exist under two providers,
 * and `set_model` takes them as separate arguments. `\u0000` is the separator
 * because it cannot appear in either half.
 */
function modelKeyOf(m: { provider: string; id: string }): string {
  return `${m.provider}\u0000${m.id}`;
}

/** Human label for a pinned model, without inventing one for an inherit task. */
function describeModel(
  model: { provider: string; id: string; name: string | null } | null,
): string {
  if (model === null) return "inherit the session's model";
  const label = model.name !== null && model.name !== "" ? model.name : model.id;
  return `${label} (${model.provider})`;
}

function describeSchedule(row: AutomationRow): string {
  switch (row.kind) {
    case "every_minutes":
      return row.everyMinutes === null ? row.schedule : `每 ${row.everyMinutes} 分钟`;
    case "every_hours":
      return row.everyHours === null ? row.schedule : `每 ${row.everyHours} 小时`;
    case "daily":
      return row.time === null ? row.schedule : `Daily at ${row.time}`;
    case "weekly": {
      if (row.time === null) return row.schedule;
      const days = row.weekdays === null
        ? ""
        : ` on ${row.weekdays.map((d) => WEEKDAY_LABELS[d - 1] ?? String(d)).join(", ")}`;
      return `Weekly at ${row.time}${days}`;
    }
    case "custom":
    default:
      return row.schedule;
  }
}

/**
 * Formats an instant for display, or `null` when it cannot be read.
 *
 * The wire carries ISO strings. Parsing failure must not print "Invalid Date"
 * into the UI, so it degrades to the raw string — which is ugly but true,
 * where a fabricated time would be worse.
 */
function formatInstant(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

function relative(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const delta = ms - nowMs;
  const abs = Math.abs(delta);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const magnitude = abs >= day
    ? `${Math.round(abs / day)}d`
    : abs >= hour
      ? `${Math.round(abs / hour)}h`
      : abs >= minute
        ? `${Math.round(abs / minute)}m`
        : `${Math.round(abs / 1000)}s`;
  return delta >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

export function AutomationsPanel(props: AutomationsPanelProps) {
  const {
    tasks,
    fires,
    disabledReason,
    notice,
    busy,
    workspaceNames,
    onCreate,
    onSetEnabled,
    onRemove,
    onRunNow,
    onRefresh,
    activeDaemonId,
    modelOptions,
  } = props;

  const [view, setView] = useState<{ kind: "list" } | { kind: "detail"; id: string } | { kind: "create" }>(
    { kind: "list" },
  );
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  const [preset, setPreset] = useState("daily9");
  const [expr, setExpr] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [tz, setTz] = useState("");
  const [skipIfBusy, setSkipIfBusy] = useState(true);
  const [wake, setWake] = useState(false);
  const [catchup, setCatchup] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  /**
   * Pinned model id, or "" for INHERIT.
   *
   * Empty string rather than null because a `<select>` value must be a string;
   * "inherit" is a real, first-class choice here, not the absence of one, so it
   * gets its own option rather than an empty placeholder.
   */
  const [modelKey, setModelKey] = useState("");
  /**
   * Whether each fire opens its own session.
   *
   * Defaults to TRUE, unlike the daemon's default, because the honest question is
   * "should a scheduled job write into the conversation I am having?" — and for a
   * job that fires on a timer the answer is usually no. The daemon keeps false so
   * an existing `cron add` CLI job behaves exactly as before.
   */
  const [freshSession, setFreshSession] = useState(true);

  /*
   * Adopt the host's default target once it becomes known.
   *
   * `useState` reads `activeDaemonId` exactly once — at mount, when the workspace
   * list may still be empty. Without this the form kept `target === null` even
   * after workspaces arrived, and Create silently refused to submit.
   */
  /* Derived, not stored: the effective target is whatever the user picked, or the
   * host default when they have not picked yet. Keeping it in state required an
   * effect that copied the default in on the next render — a cascading render for
   * a value that is pure computed output. */
  const effectiveTarget = target ?? activeDaemonId;
  /*
   * The relative-time anchor ("next in 4m") must not be computed during render —
   * reading the clock there is an impure render, and it also meant the label
   * froze until some unrelated state changed. A once-a-second tick keeps it
   * honest and cheap (the list is short and the text is the only thing moving).
   */
  /*
   * The panel is mounted fresh each time its tab is selected, so this is the
   * natural point to ask the host for the current list. Without it the initial
   * render sat on "正在与主机通信…" forever: the only refresh trigger was
   * a mutation, and there is no mutation before the first listing.
   */
  useEffect(() => {
    onRefresh();
    // Intentionally mount-only: a re-render must not re-request the whole list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);

  /*
   * A task can vanish under a detail view (deleted from another client, or by a
   * successful delete here). Derive the detail from the live list instead of
   * trusting the stored id, so a stale key degrades to the list rather than
   * rendering an empty detail that looks like a load failure.
   */
  const selected = useMemo(() => {
    if (view.kind !== "detail") return null;
    return tasks.find((t) => t.id === view.id) ?? null;
  }, [tasks, view]);

  const effectiveView = view.kind === "detail" && selected === null ? { kind: "list" as const } : view;

  /* One scroll container per view: the previous view's offset must never leak
   * into the next one, or a freshly opened detail starts scrolled to the bottom. */
  useLayoutEffect(() => {
    if (scrollerRef.current !== null) scrollerRef.current.scrollTop = 0;
  }, [effectiveView.kind, effectiveView.kind === "detail" ? effectiveView.id : ""]);

  /* Focus the back control on drill-down so keyboard users are not stranded at
   * the bottom of a view they cannot see the top of. */
  useLayoutEffect(() => {
    if (effectiveView.kind !== "list") backRef.current?.focus();
  }, [effectiveView.kind]);

  const backToList = useCallback(() => setView({ kind: "list" }), []);

  const applyPreset = useCallback((id: string) => {
    setPreset(id);
    const found = PRESETS.find((p) => p.id === id);
    if (found?.expr != null) setExpr(found.expr);
  }, []);

  const isInert = disabledReason !== null;
  const canCreate = !isInert && !busy && expr.trim() !== "" && prompt.trim() !== "";

  /*
   * Model key -> wire pin. `""` means inherit.
   *
   * A key of `provider \u0000 id` because a bare model id is not unique across
   * providers, and the daemon needs BOTH halves to switch (`set_model` takes
   * provider and modelId separately). Resolving back through the same catalog
   * keeps the picker and the wire in sync.
   */
  const resolveModel = useCallback(
    (key: string): { provider: string; id: string } | null => {
      if (key === "") return null;
      const found = modelOptions.find((m) => modelKeyOf(m) === key);
      if (found === undefined) return null;
      return { provider: found.provider, id: found.id };
    },
    [modelOptions],
  );

  const submitCreate = useCallback(() => {
    if (!canCreate) return;
    onCreate({
      schedule: expr.trim(),
      prompt: prompt.trim(),
      tz: tz.trim() === "" ? null : tz.trim(),
      skipIfBusy,
      wake,
      catchup,
      daemonId: effectiveTarget,
      model: resolveModel(modelKey),
      freshSession,
    });
  }, [canCreate, expr, prompt, tz, skipIfBusy, wake, catchup, effectiveTarget, modelKey, freshSession, resolveModel, onCreate]);

  /*
   * Return to the list once the create is done.
   *
   * `onCreate` is fire-and-forget: the host answers later and the panel re-lists.
   * Without this the user was left staring at the filled form with no visible
   * confirmation that anything happened — the new task existed and was simply
   * never shown.
   *
   * The signal is "not busy any more while the create view is mounted". Busy is
   * what the panel sets for the whole mutation plus re-list, so a transition
   * busy → idle means the round-trip finished either way, and the list (or the
   * notice) already reflects the outcome.
   */
  const sawBusyRef = useRef(false);
  useEffect(() => {
    if (effectiveView.kind !== "create") {
      sawBusyRef.current = false;
      return;
    }
    if (busy) {
      sawBusyRef.current = true;
      return;
    }
    if (sawBusyRef.current) {
      sawBusyRef.current = false;
      setView({ kind: "list" });
    }
  }, [busy, effectiveView.kind]);

  /* ── CREATE ───────────────────────────────────────────────────────────── */
  if (effectiveView.kind === "create") {
    return (
      <div className={css.root}>
        <div className={css.head}>
          <button ref={backRef} type="button" className={css.back} onClick={backToList} title="返回自动化">
            <Icon name="chevR" size={12} className={css.backIcon} />
            <span>全部自动化</span>
          </button>
          <span className={css.headTitle}>新建自动化</span>
        </div>
        {notice !== null ? <p className={css.error} role="alert">{notice}</p> : null}
        {disabledReason !== null ? <p className={css.intro}>{disabledReason}</p> : null}

        <div className={css.scroller} ref={scrollerRef}>
          <label className={css.fieldLabel} htmlFor="auto-preset">计划</label>
          <select
            id="auto-preset"
            className={css.input}
            value={preset}
            disabled={isInert}
            onChange={(e) => applyPreset(e.currentTarget.value)}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>

          <label className={css.fieldLabel} htmlFor="auto-expr">
            Cron expression{preset === "custom" ? "" : " (edit to fine-tune)"}
          </label>
          <input
            id="auto-expr"
            className={css.input}
            value={expr}
            disabled={isInert}
            spellCheck={false}
            onChange={(e) => setExpr(e.currentTarget.value)}
          />
          <p className={css.hint}>分 时 日 月 星期。主机强制最小 60 秒。</p>

          <label className={css.fieldLabel} htmlFor="auto-prompt">让代理做什么？</label>
          <textarea
            id="auto-prompt"
            className={css.textarea}
            value={prompt}
            disabled={isInert}
            rows={4}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />

          <label className={css.fieldLabel} htmlFor="auto-tz">时区（可选）</label>
          <input
            id="auto-tz"
            className={css.input}
            value={tz}
            disabled={isInert}
            placeholder="America/Sao_Paulo"
            spellCheck={false}
            onChange={(e) => setTz(e.currentTarget.value)}
          />
          <p className={css.hint}>留空则使用主机自身时区。</p>

          {target !== null && workspaceNames.size > 0 ? (
            <>
              <label className={css.fieldLabel} htmlFor="auto-target">运行于</label>
              <select
                id="auto-target"
                className={css.input}
                value={target}
                disabled={isInert}
                onChange={(e) => setTarget(e.currentTarget.value)}
              >
                {[...workspaceNames.entries()].map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </>
          ) : null}

          {/*
            * Model and session are presented together because they answer the
            * same question: "what exactly runs when this fires?". Both default to
            * the least surprising choice (inherit / own session) and both state
            * that choice in words rather than leaving it to be inferred.
            */}
          <label className={css.fieldLabel} htmlFor="auto-model">模型</label>
          <select
            id="auto-model"
            className={css.input}
            value={modelKey}
            disabled={isInert}
            onChange={(e) => setModelKey(e.currentTarget.value)}
          >
            <option value="">沿用会话的模型</option>
            {modelOptions.map((m) => (
              <option key={modelKeyOf(m)} value={modelKeyOf(m)}>
                {m.name || m.id} ({m.provider})
              </option>
            ))}
          </select>
          <p className={css.hint}>
            {modelKey === ""
              ? "Uses whatever model this workspace has at fire time — it changes if you switch models in the composer."
              : "该任务每次触发会切换到所选模型，随后切回。"}
          </p>

          <label className={css.fieldLabel} htmlFor="auto-session">会话</label>
          <select
            id="auto-session"
            className={css.input}
            value={freshSession ? "fresh" : "live"}
            disabled={isInert}
            onChange={(e) => setFreshSession(e.currentTarget.value === "fresh")}
          >
            <option value="fresh">每次触发开新会话</option>
            <option value="live">追加到我正在用的会话</option>
          </select>
          <p className={css.hint}>
            {freshSession
              ? "每次触发都有自己的历史，不会把当前对话撑满或弄乱。"
              : "指令会落到你正在读的这个会话，与它共用同一个上下文窗口。"}
          </p>

          <fieldset className={css.flags}>
            <label className={css.check}>
              <input type="checkbox" checked={skipIfBusy} disabled={isInert} onChange={(e) => setSkipIfBusy(e.currentTarget.checked)} />
              <span>代理忙时跳过（推荐）</span>
            </label>
            <label className={css.check}>
              <input type="checkbox" checked={wake} disabled={isInert} onChange={(e) => setWake(e.currentTarget.checked)} />
              <span>工作区已停止时启动它</span>
            </label>
            <label className={css.check}>
              <input type="checkbox" checked={catchup} disabled={isInert} onChange={(e) => setCatchup(e.currentTarget.checked)} />
              <span>主机停机期间错过的触发，恢复后补跑一次</span>
            </label>
          </fieldset>

          <button type="button" className={css.primary} disabled={!canCreate} onClick={submitCreate}>
            {busy ? "正在创建…" : "创建自动化"}
          </button>
        </div>
      </div>
    );
  }

  /* ── DETAIL ───────────────────────────────────────────────────────────── */
  if (effectiveView.kind === "detail" && selected !== null) {
    const nextText = formatInstant(selected.nextRun);
    const lastText = formatInstant(selected.lastRun);
    return (
      <div className={css.root}>
        <div className={css.head}>
          <button ref={backRef} type="button" className={css.back} onClick={backToList} title="返回自动化">
            <Icon name="chevR" size={12} className={css.backIcon} />
            <span>全部自动化</span>
          </button>
          <span className={css.headTitle} title={selected.schedule}>{describeSchedule(selected)}</span>
        </div>
        {notice !== null ? <p className={css.error} role="alert">{notice}</p> : null}

        <div className={css.scroller} ref={scrollerRef}>
          <dl className={css.facts}>
            <dt>Cron</dt>            <dd><code className={css.mono}>{selected.schedule}</code></dd>
            <dt>运行于</dt>
            <dd>{workspaceNames.get(selected.daemonId) ?? selected.daemonId}</dd>
            <dt>时区</dt>
            <dd>{selected.tz ?? "主机时区"}</dd>
            <dt>模型</dt>
            <dd>{describeModel(selected.model)}</dd>
            <dt>会话</dt>
            <dd>
              {selected.freshSession
                ? "每次触发新建会话"
                : "当前使用的会话"}
            </dd>
            <dt>下次运行</dt>
            <dd>{nextText === null ? "未排定" : `${nextText} (${relative(selected.nextRun, nowMs) ?? "?"})`}</dd>
            <dt>上次运行</dt>
            <dd>{lastText === null ? "从未" : `${lastText} (${relative(selected.lastRun, nowMs) ?? "?"})`}</dd>
            <dt>上次结果</dt>
            <dd>
              {selected.lastStatus === null
                ? "从未触发"
                : <span className={selected.lastStatus === "delivered" || selected.lastStatus === "woke_and_delivered" ? css.ok : css.warn}>{selected.lastStatus}</span>}
            </dd>
            {selected.skipIfBusy ? <><dt>空档处理</dt><dd>代理忙时跳过</dd></> : null}
            {selected.wake ? <><dt>空档处理</dt><dd>工作区停止时启动它</dd></> : null}
            {selected.catchup ? <><dt>空档处理</dt><dd>主机停机后补跑一次</dd></> : null}
          </dl>

          <h3 className={css.sectionTitle}>指令</h3>
          <pre className={css.promptBox}>{selected.prompt}</pre>

          <div className={css.actions}>
            <button type="button" className={css.action} disabled={busy || isInert} onClick={() => onRunNow(selected.id)}>
              立即运行
            </button>
            <button type="button" className={css.action} disabled={busy || isInert} onClick={() => onSetEnabled(selected.id, !selected.enabled)}>
              {selected.enabled ? "禁用" : "启用"}
            </button>
            <button
              type="button"
              className={armedRemove === selected.id ? css.dangerArmed : css.danger}
              disabled={busy || isInert}
              onClick={() => {
                if (armedRemove === selected.id) {
                  setArmedRemove(null);
                  onRemove(selected.id);
                } else {
                  setArmedRemove(selected.id);
                }
              }}
              onBlur={() => setArmedRemove(null)}
              title={armedRemove === selected.id ? "再次点击即删除这条自动化" : "删除这条自动化"}
            >
              {armedRemove === selected.id ? "确认删除" : "删除"}
            </button>
          </div>
          <p className={css.hint}>删除后不再触发。已发送到对话里的消息不会被收回。</p>
        </div>
      </div>
    );
  }

  /* ── LIST ─────────────────────────────────────────────────────────────── */
  return (
    <div className={css.root}>
      <div className={css.head}>
        <span className={css.headTitle}>自动化</span>
        <button type="button" className={css.refresh} disabled={busy} onClick={onRefresh} title="重新加载任务列表">
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" className={css.new} disabled={busy || isInert} onClick={() => setView({ kind: "create" })}>
          新建
        </button>
      </div>

      {notice !== null ? <p className={css.error} role="alert">{notice}</p> : null}
      {disabledReason !== null ? <p className={css.intro}>{disabledReason}</p> : null}

      {disabledReason === null && busy && tasks.length === 0 ? (
        <div className={css.status}><span>正在与主机通信…</span></div>
      ) : null}

      <div className={css.scroller} ref={scrollerRef}>
        {fires.length > 0 ? (
          <section className={css.fireLog} aria-label="最近触发记录">
            <h3 className={css.sectionTitle}>最近触发</h3>
            <ul className={css.fireList}>
              {fires.slice(0, 5).map((f) => (
                <li key={`${f.jobId}:${f.firedAt}`} className={css.fireRow}>
                  <Icon name="clock" size={11} className={css.fireIcon} />
                  <span className={f.result === "delivered" || f.result === "woke_and_delivered" ? css.ok : css.warn}>{f.result}</span>
                  <span className={css.fireTime}>{formatInstant(f.firedAt) ?? f.firedAt}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {disabledReason === null && tasks.length === 0 && !busy ? (
          <p className={css.empty}>还没有自动化。新建一个即可按计划运行提示词。</p>
        ) : null}

        <ul className={css.list}>
          {tasks.map((t) => {
            const rel = relative(t.nextRun, nowMs);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={css.row}
                  data-automation-row={t.id}
                  onClick={() => setView({ kind: "detail", id: t.id })}
                >
                  <span className={css.rowTop}>
                    <span className={t.enabled ? css.rowTitle : css.rowTitleOff}>{describeSchedule(t)}</span>
                    {t.enabled ? null : <span className={css.badgeOff}>关闭</span>}
                  </span>
                  <span className={css.rowMeta}>
                    {t.enabled
                      ? (rel === null ? "未排定" : `Next ${rel}`)
                      : "disabled"}
                    {t.lastStatus === null ? null : <span className={css.rowStatus}> · {t.lastStatus}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
