"use client";

/* Plugins (Pi extensions) — list, install, remove, and READ what a package does.
 *
 * ## Drill-down, same as the Plan panel
 *
 * Three views, exactly one at a time: LIST, DETAIL, INSTALL. The dock is 280-600
 * px wide, so a master-detail split is not an option (each side would be ~18
 * characters of text), and stacking a detail view above the list is the bug that
 * already shipped once here — the detail mounted at `top: -2438px`, off-screen.
 *
 * The rule that prevents both: the root never scrolls; exactly ONE child does.
 *
 * ## Why README exists at all
 *
 * A plugin is third-party code. Asking a user to install or keep one without
 * being able to read what it does would make the confirmation checkbox
 * meaningless. The wire carries no description, so the host reads the package's
 * own README from the directory it installed into (`readme` on the wire).
 * `null` is a real answer — "this package ships no README" — and the UI says so
 * rather than drawing an empty box that looks like a loading failure.
 *
 * ## Two-step destructive actions
 *
 * Remove is armed on the first click and executes on the second, matching the
 * app's existing convention (Unpair, workspace Remove). There is no modal
 * primitive confined to this dock, so confirmation is inline.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../core/icons";
import { Markdown } from "../chat/markdown";
import type { PluginSkillRow, WirePackageRow } from "./right-rail";
import css from "./plugins-panel.module.css";

export type PluginScope = "user" | "project";

export interface PluginsPanelProps {
  packages: readonly WirePackageRow[];
  skills: readonly PluginSkillRow[];
  /** Fixed, client-authored reason the surfaces are inert, or null. */
  disabledReason: string | null;
  busy: boolean;
  /** Fixed failure sentence for the last operation, or null. */
  notice: string | null;
  /** Which operation is in flight for a package key, if any. */
  busyKeys: ReadonlySet<string>;
  /** Increments once per CONFIRMED install, so the form can close itself. */
  installedAt: number;
  /**
   * A plugin change has been written to settings but the Pi has not restarted.
   *
   * Surfaced because the change is INVISIBLE until it does: Pi loads extensions,
   * skills, prompts and themes once at startup, so without this line the user
   * installs something, sees nothing, and concludes it failed.
   */
  restartPending: boolean;
  onInstall: (source: string, scope: PluginScope) => void;
  onRemove: (source: string, scope: PluginScope) => void;
  /**
   * Reversible on/off that keeps the code installed.
   *
   * Separate from onRemove because the consequences differ: this leaves the
   * files on disk, remove uninstalls them.
   */
  onSetEnabled: (source: string, scope: PluginScope, enabled: boolean) => void;
  onUpdate: (source: string) => void;
  onSkillToggle: (name: string, enabled: boolean) => void;
  /** Re-read the surface. Optional: an idle fixture may render without it. */
  onRefresh?: () => void;
  /** The panel's own explanation when the host offers nothing. */
  introReason: string;
}

type View =
  | { kind: "list" }
  | { kind: "detail"; key: string }
  | { kind: "install" };

/** Stable identity for one package: the same source can exist in two scopes. */
export function packageKey(pkg: { source: string; scope: PluginScope }): string {
  return `${pkg.scope}:${pkg.source}`;
}

/** The four resource kinds Pi discovers, in the order the panel shows them. */
const RESOURCE_ORDER = ["extensions", "skills", "prompts", "themes"] as const;

export function PluginsPanel({
  packages,
  skills,
  disabledReason,
  busy,
  notice,
  busyKeys,
  installedAt,
  restartPending,
  onInstall,
  onRemove,
  onSetEnabled,
  onUpdate,
  onSkillToggle,
  onRefresh,
  introReason,
}: PluginsPanelProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  /** Armed remove: the key of the package whose Remove was clicked once. */
  const [armed, setArmed] = useState<string | null>(null);

  /* INSTALL form state. Kept in the panel (not the form) so returning from a
   * failed install does not silently discard what the user typed. */
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("project");
  const [acknowledged, setAcknowledged] = useState(false);

  /*
   * Leave the Install view when the host CONFIRMS, not when the user guesses.
   *
   * The container counts successes (`installedAt`), so this is an explicit
   * signal rather than an inference from the busy flag. On a new value the form
   * has done its job: go back to the list, where the new row is, and clear
   * itself. A FAILED install must not do this — the source and the
   * acknowledgement stay put so the user can correct and retry instead of
   * retyping.
   *
   * Derived in render (React's supported reset-on-prop-change pattern) because a
   * `setState` inside an effect is both a cascading-render lint error and one
   * visible frame of the stale view.
   */
  const [seenInstalledAt, setSeenInstalledAt] = useState(installedAt);
  const justInstalled = installedAt !== seenInstalledAt;
  if (justInstalled) {
    setSeenInstalledAt(installedAt);
    if (view.kind === "install") {
      setView({ kind: "list" });
      setInstallSource("");
      setAcknowledged(false);
    }
  }

  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const listTopRef = useRef(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return packages;
    return packages.filter(
      (p) => p.source.toLowerCase().includes(q) || p.scope.includes(q),
    );
  }, [packages, query]);

  const selected = useMemo(() => {
    if (view.kind !== "detail") return null;
    return packages.find((p) => packageKey(p) === view.key) ?? null;
  }, [packages, view]);

  /*
   * A removed package closes its own detail view — in RENDER, not in an effect.
   *
   * The detail branch only renders when `selected` resolves, so falling through
   * already shows the list. But `view` would still say "detail", and that stale
   * kind is observable: Escape would run the back path (and restore a scroll
   * offset that no longer applies) and the scroll-reset effect would keep firing
   * for a view that is not on screen.
   *
   * Adjusting state during render is React's supported pattern for derived-state
   * resets, and it commits before paint, so there is no empty frame. An effect
   * would render the inconsistent state first AND trip the cascading-render rule.
   */
  /*
   * A detail view with no resolvable package IS the list.
   *
   * Derived rather than stored, so the first paint after a removal already
   * shows the list — no empty frame.
   *
   * The state stays `{kind:"detail"}` on purpose: writing to it here would be a
   * `setState` in render, which is only sanctioned for the reset-on-prop-change
   * pattern. The stale key is harmless because EVERY read of the view goes
   * through `effectiveView` — `selected`, the render branches and the Escape
   * handler all use it — so nothing can act on a view that is not on screen.
   * A package that reappears under the same key therefore re-opens its detail
   * only if the user opens it again: `openDetail` is what sets that key, and
   * nothing else re-derives it.
   *
   * Memoised because the object identity feeds effect/callback dependency
   * arrays: a fresh literal each render made them look unstable.
   */
  const effectiveView: View = useMemo(
    () => (view.kind === "detail" && selected === null ? { kind: "list" } : view),
    [view, selected],
  );

  /*
   * Every view swap: scroll the new view to its top and move focus to Back,
   * BEFORE paint. `useLayoutEffect` because a post-paint reset flashes the
   * previous scroll offset; focusing Back is what makes the swap visible to a
   * keyboard or screen-reader user.
   */
  const activeScroll = effectiveView.kind === "list" ? listScrollRef : detailScrollRef;
  useLayoutEffect(() => {
    if (effectiveView.kind === "list") return;
    const el = activeScroll.current;
    if (el !== null) el.scrollTop = 0;
    backRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveView.kind, effectiveView.kind === "detail" ? effectiveView.key : ""]);

  const openDetail = useCallback((key: string) => {
    listTopRef.current = listScrollRef.current?.scrollTop ?? 0;
    setArmed(null);
    setView({ kind: "detail", key });
  }, []);

  const backToList = useCallback(() => {
    setArmed(null);
    setView({ kind: "list" });
    requestAnimationFrame(() => {
      const el = listScrollRef.current;
      if (el !== null) el.scrollTop = listTopRef.current;
    });
  }, []);

  const onEscape = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      /* Escape first disarms a half-armed Remove, then leaves the view. Doing
       * both at once would let a user escape a confirmation they meant to make
       * AND lose their place at the same time. */
      if (armed !== null) {
        event.stopPropagation();
        setArmed(null);
        return;
      }
      if (effectiveView.kind !== "list") {
        event.stopPropagation();
        backToList();
      }
    },
    [armed, effectiveView, backToList],
  );

  /*
   * The surface cannot answer at all (no connection, or no live workspace).
   *
   * Named so the FORM CONTROLS can honour it too, not just the submit button:
   * they used to check only `busy`, so with a stopped workspace a user could
   * type a full source, tick the acknowledgement, and still face a permanently
   * disabled button — the reason was rendered elsewhere but the inputs did not
   * act like the form was closed, which reads as a broken button rather than a
   * stopped workspace.
   */
  const isInert = disabledReason !== null;

  /* `!busy` is part of the gate, not decoration: while a mutation is in flight
   * the button must not fire a second one. Without it the label changed to
   * "正在安装…" but stayed clickable, so an impatient user queued duplicate
   * installs of the same source. */
  const canInstall =
    installSource.trim() !== "" && acknowledged && disabledReason === null && !busy;

  const submitInstall = useCallback(() => {
    if (!canInstall) return;
    onInstall(installSource.trim(), installScope);
  }, [canInstall, installSource, installScope, onInstall]);

  /* ---------------- install view ---------------- */
  if (effectiveView.kind === "install") {
    return (
      <div className={css.root} onKeyDown={onEscape}>
        <div className={css.head}>
          <button ref={backRef} type="button" className={css.back} onClick={backToList} title="返回全部插件（Esc）">
            <Icon name="chevR" size={12} className={css.backIcon} />
            <span>全部插件</span>
          </button>
          <span className={css.headTitle}>安装</span>
        </div>

        {restartPending ? (
          <p className={css.restart} role="status">
            <Icon name="refresh" size={12} className={css.restartIcon} />
            <span>Restart this workspace&apos;s Pi for the change to take effect.</span>
          </p>
        ) : null}

        {notice !== null ? (
          <p className={css.error} role="alert">
            {notice}
          </p>
        ) : null}

        <div ref={detailScrollRef} className={css.docScroll}>
          <label className={css.field}>
            <span className={css.fieldLabel}>包来源</span>
            <input
              type="text"
              className={css.input}
              value={installSource}
              onChange={(e) => setInstallSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitInstall();
                }
              }}
              placeholder="npm:@scope/pkg  or  a local path"
              aria-label="软件包源"
              spellCheck={false}
              autoComplete="off"
              disabled={busy || isInert}
            />
            <span className={css.hint}>npm 规格，或主机能访问到的路径。</span>
          </label>

          <fieldset className={css.field}>
            <legend className={css.fieldLabel}>安装到</legend>
            <div className={css.scopeRow}>
              {(["project", "user"] as const).map((s) => (
                <label key={s} className={css.scopeChoice}>
                  <input
                    type="radio"
                    name="plugin-scope"
                    value={s}
                    checked={installScope === s}
                    onChange={() => setInstallScope(s)}
                    disabled={busy || isInert}
                  />
                  <span>{s === "project" ? "本项目" : "所有项目"}</span>
                </label>
              ))}
            </div>
            <span className={css.hint}>
              {installScope === "project"
                ? "写入该工作区的 .pi/settings.json；需要项目已被信任。"
                : "写入用户设置，所有工作区都可见。"}
            </span>
          </fieldset>

          {/* The warning is a REQUIRED gate, not a footnote: the primary button
              stays disabled until it is acknowledged. Installing runs code. */}
          <div className={`${css.warnCard} ${acknowledged ? css.warnCardAcked : ""}`}>
            <span className={css.warnTitle}>
              <Icon name="alert" size={13} />
              Third-party code
            </span>
            <p className={css.warnBody}>
              A plugin is code. Installing it runs that code on the host as you, and it can
              read your files and make network calls. Only install a source you trust.
            </p>
            <label className={css.ackRow}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={busy || isInert}
              />
              <span>I understand this runs third-party code on the host.</span>
            </label>
          </div>

          <div className={css.actions}>
            <button type="button" className={css.primary} disabled={!canInstall} onClick={submitInstall}>
              {busy ? "正在安装…" : "安装插件"}
            </button>
          </div>

          {disabledReason !== null ? <p className={css.intro}>{disabledReason}</p> : null}
        </div>
      </div>
    );
  }

  /* ---------------- detail view ---------------- */
  if (effectiveView.kind === "detail" && selected !== null) {
    const key = packageKey(selected);
    const isBusy = busyKeys.has(key);
    const isArmed = armed === key;
    /* A zero-byte or whitespace-only README is indistinguishable from none as
     * far as the reader is concerned, and rendering it produced an empty box
     * that looks like a broken panel. Normalise it to null. */
    const rawReadme = selected.readme ?? null;
    const readme = rawReadme === null || rawReadme.trim() === "" ? null : rawReadme;
    const kinds = RESOURCE_ORDER.filter((k) => selected.resources.includes(k));

    return (
      <div className={css.root} onKeyDown={onEscape}>
        <div className={css.head}>
          <button ref={backRef} type="button" className={css.back} onClick={backToList} title="返回插件（Esc）">
            <Icon name="chevR" size={12} className={css.backIcon} />
            <span>全部插件</span>
          </button>
          <span className={css.headTitle} title={selected.source}>
            {selected.source}
          </span>
        </div>

        {restartPending ? (
          <p className={css.restart} role="status">
            <Icon name="refresh" size={12} className={css.restartIcon} />
            <span>Restart this workspace&apos;s Pi for the change to take effect.</span>
          </p>
        ) : null}

        {notice !== null ? (
          <p className={css.error} role="alert">
            {notice}
          </p>
        ) : null}

        <div ref={detailScrollRef} className={css.docScroll}>
          <div className={css.metaRow}>
            <Icon name="plug" size={13} className={css.rowIcon} />
            <span className={css.metaSource}>{selected.source}</span>
            <span className={css.badge}>{selected.scope}</span>
          </div>

          <div className={css.actions}>
            <button
              type="button"
              className={css.secondary}
              disabled={isBusy || busy || disabledReason !== null}
              onClick={() => onUpdate(selected.source)}
              title="请主机重新同步该软件包。"
            >
              <Icon name="refresh" size={11} />
              更新
            </button>
            <button
              type="button"
              className={isArmed ? css.dangerArmed : css.secondary}
              disabled={isBusy || busy || disabledReason !== null}
              onClick={() => {
                if (!isArmed) {
                  setArmed(key);
                  return;
                }
                setArmed(null);
                onRemove(selected.source, selected.scope);
              }}
              title={isArmed ? "再次点击以移除该软件包。" : "从主机设置中移除该软件包。"}
            >
              <Icon name="x" size={11} />
              {isArmed ? "确认移除" : "移除"}
            </button>
          </div>

          <span className={css.sectionLabel}>声明的资源</span>
          {kinds.length === 0 ? (
            <p className={css.intro}>
              该软件包没有声明任何主机可见的扩展、技能、提示词或主题。
            </p>
          ) : (
            <ul className={css.kindList}>
              {kinds.map((k) => (
                <li key={k} className={css.kindPill}>
                  {k}
                </li>
              ))}
            </ul>
          )}

          <span className={css.sectionLabel}>文档</span>
          {readme === null ? (
            /* Honest degradation: the host looked and found nothing. Saying so
               is more useful than an empty box, which reads as a broken panel. */
            <div className={css.emptyDoc}>
              <Icon name="book" size={12} />
              <span>This package ships no README the host could read.</span>
            </div>
          ) : (
            <>
              <div className={css.docBody}>
                <Markdown text={readme} />
              </div>
              {selected.readmeTruncated ? (
                <p className={css.notice}>This README is larger than the host's cap, so only its beginning is shown.</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  /* ---------------- list view ---------------- */
  return (
    <div className={css.root} onKeyDown={onEscape}>
      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <Icon name="search" size={12} className={css.searchIcon} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query !== "") {
                e.stopPropagation();
                setQuery("");
              }
              if (e.key === "Enter" && filtered.length === 1 && filtered[0] !== undefined) {
                e.preventDefault();
                openDetail(packageKey(filtered[0]));
              }
            }}
            placeholder={
              disabledReason !== null ? "没有运行中的工作区" : `Filter ${packages.length} plugins…`
            }
            disabled={disabledReason !== null}
            aria-label="筛选插件"
            className={css.search}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className={css.installBtn}
          onClick={() => {
            /* Record the offset here as well: coming back from Install must
             * land where the user was, not at a stale position. */
            listTopRef.current = listScrollRef.current?.scrollTop ?? 0;
            setArmed(null);
            setView({ kind: "install" });
          }}
          disabled={busy || disabledReason !== null}
          title={disabledReason ?? "从源安装插件。"}
        >
          <Icon name="plus" size={11} />
          安装
        </button>
      </div>

      {/*
       * The restart notice sits ABOVE the failure line and outside the scroll
       * region, because it is a consequence of something that SUCCEEDED — it
       * must not look like an error, and it must not scroll out of view while
       * the user is still changing plugins.
       */}
      {restartPending ? (
        <p className={css.restart} role="status">
          <Icon name="refresh" size={12} className={css.restartIcon} />
          <span>Restart this workspace&apos;s Pi for the change to take effect.</span>
        </p>
      ) : null}

      {notice !== null ? (
        <p className={css.error} role="alert">
          {notice}
        </p>
      ) : null}
      {disabledReason !== null ? <p className={css.intro}>{disabledReason}</p> : null}
      {disabledReason === null && busy && packages.length === 0 ? (
        <div className={css.status}>
          <Spinner />
          <span>Talking to the host…</span>
        </div>
      ) : null}

      <div ref={listScrollRef} className={css.listScroll}>
        {/*
         * Inert surface: do NOT render an active search box and an empty list.
         * "筛选 0 个插件…" and "reports no installed skills" are both CLAIMS
         * about the host, and when no workspace is live the host was never asked.
         * The panel says why it cannot answer instead of inventing an answer.
         */}
        {disabledReason !== null ? null : packages.length === 0 ? (
          <p className={css.intro}>{introReason}</p>
        ) : filtered.length === 0 ? (
          <p className={css.intro}>No plugin matches “{query}”.</p>
        ) : (
          <ul className={css.list}>
            {filtered.map((pkg) => {
              const key = packageKey(pkg);
              const isBusy = busyKeys.has(key);
              const isArmed = armed === key;
              return (
                <li key={key} className={css.card}>
                  <button
                    type="button"
                    data-plugin-row={key}
                    className={css.cardHead}
                    onClick={() => openDetail(key)}
                    title={`${pkg.source} — open its details`}
                  >
                    <Icon name="plug" size={13} className={css.rowIcon} />
                    <span className={pkg.enabled === false ? css.rowTitleOff : css.rowTitle}>
                      {pkg.source}
                    </span>
                    <span className={css.badge}>{pkg.scope}</span>
                    {/* Only claim "off" when the host said so. `null` means it
                        did not report the field at all, and drawing that as
                        disabled would invent a state the host never asserted. */}
                    {pkg.enabled === false ? (
                      <span className={css.badgeOff}>off</span>
                    ) : null}
                  </button>
                  <div className={css.cardActions} aria-busy={isBusy}>
                    {isBusy ? (
                      <span className={css.rowBusy}>
                        <Spinner />
                        Working…
                      </span>
                    ) : (
                      <>
                        {/* Reversible switch, distinct from Remove below it:
                            this keeps the code on disk, Remove uninstalls it. The
                            label says what the click DOES, not the current state. */}
                        <button
                          type="button"
                          className={css.secondary}
                          disabled={busy || disabledReason !== null || pkg.enabled === null}
                          onClick={() => onSetEnabled(pkg.source, pkg.scope, !(pkg.enabled === true))}
                          title={
                            pkg.enabled === null
                              ? "主机未报告该软件包是否启用。"
                              : pkg.enabled === true
                                ? "停止加载该软件包，但保留安装。"
                                : "重新加载该软件包。"
                          }
                        >
                          {pkg.enabled === false ? "启用" : "禁用"}
                        </button>
                        <button
                          type="button"
                          className={css.secondary}
                          disabled={busy || disabledReason !== null}
                          onClick={() => onUpdate(pkg.source)}
                          title="请主机重新同步该软件包。"
                        >
                          更新
                        </button>
                        <button
                          type="button"
                          className={isArmed ? css.dangerArmed : css.secondary}
                          disabled={busy || disabledReason !== null}
                          onClick={() => {
                            if (!isArmed) {
                              setArmed(key);
                              return;
                            }
                            setArmed(null);
                            onRemove(pkg.source, pkg.scope);
                          }}
                          title={isArmed ? "再次点击以移除该软件包。" : "从主机设置中移除该软件包。"}
                        >
                          {isArmed ? "确认移除" : "移除"}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className={css.skillsSection}>
          <span className={css.sectionLabel}>技能</span>
          {disabledReason !== null ? null : skills.length === 0 ? (
            <p className={css.intro}>This workspace&apos;s Pi reports no installed skills.</p>
          ) : (
            <ul className={css.list}>
              {skills.map((skill) => (
                <li key={skill.name} className={css.skillRow}>
                  <Icon name="spark" size={12} className={css.rowIcon} />
                  <span className={css.rowTitle}>{skill.name}</span>
                  <span className={css.badge}>{skill.source}</span>
                  <label className={css.toggle} title={`Enable or disable ${skill.name}`}>
                    <input
                      type="checkbox"
                      checked={skill.enabled === true}
                      disabled={busy || skill.enabled === null || disabledReason !== null}
                      onChange={(e) => onSkillToggle(skill.name, e.target.checked)}
                      aria-label={`${skill.enabled === true ? "禁用" : "启用"} ${skill.name}`}
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={css.footer}>
        <button
          type="button"
          className={css.ghost}
          onClick={() => onRefresh?.()}
          disabled={busy || disabledReason !== null}
          title={disabledReason ?? "请主机重新读取该工作区的插件。"}
        >
          <Icon name="refresh" size={11} />
          刷新
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return <span className={css.spinner} aria-hidden="true" />;
}
