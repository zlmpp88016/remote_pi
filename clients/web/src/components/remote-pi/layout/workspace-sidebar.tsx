"use client";

/* Left column of the Remote Pi web shell: brand head, workspace list, host
 * footer. Visual source: docs/web_app/原型/index.html (.sidebar) +
 * styles.css §5.
 *
 * The workspace rows are real (workspace_list) — no fixture. Entries the
 * protocol cannot serve yet (session list/switch, settings, command palette)
 * are rendered inert and explain why, so nothing is silently dropped and no
 * button performs an action the client does not know.
 */
import type { WorkspaceChildState } from "@/lib/remote-pi/adapter";
import type { WorkspaceEntry } from "@/lib/remote-pi/protocol";

import { Icon, RemotePiMark } from "../core/icons";
import css from "./workspace-sidebar.module.css";
import { EmptyState, Spinner } from "./states";
import { capability, workspaceControls, workspaceNote, workspaceStatus, type WorkspaceTone } from "../core/view-model";

/** Row tone → text colour. One map so the icon and the label never disagree. */
const TONE_TEXT: Readonly<Record<WorkspaceTone, string>> = {
  running: css.toneOk,
  starting: css.toneAccent,
  crashed: css.toneDanger,
  stopped: css.toneFaint,
  not_running: css.toneFaint,
};

export interface WorkspaceSidebarProps {
  rail: boolean;
  onToggleRail: () => void;
  /**
   * Wave 5: false when widening to 280px would starve the center column, so
   * the Toggle button states that instead of silently doing nothing.
   */
  expansionAvailable: boolean;
  workspaces: readonly WorkspaceEntry[];
  /** Active workspace room (the conversation in the main column). */
  activeRoom: string | null;
  onOpenWorkspace: (roomId: string) => void;
  /** Client-side filter over the workspace rows. */
  query: string;
  onQueryChange: (value: string) => void;
  workspacesLoading: boolean;
  workspacesError: string | null;
  /**
   * Wave 3: adapter `workspaceStates` — observed `workspace_state` pushes keyed
   * by the host's canonical cwd (the same string as `WorkspaceEntry.cwd`).
   * `null` means nothing was observed, which is NOT a stopped workspace.
   */
  workspaceStates: Record<string, WorkspaceChildState> | null;
  /** Any workspace action (start/restart/refresh) is in flight. */
  workspacesBusy: boolean;
  /** Relist the host's workspace catalog (`workspace_list`). */
  onRefresh: () => void;
  /** Ask the host to start a Pi in this cwd (`workspace_start`). */
  onStart: (cwd: string) => void;
  /** Revive a crashed/stopped workspace by cwd (`workspace_restart`). */
  onRestart: (cwd: string) => void;
  /** Shut down a running workspace's Pi by cwd (`workspace_stop`). */
  onStop: (cwd: string) => void;
  /** Opens the dock on the Plugins tab. Omitted at rail width (no dock). */
  onOpenPlugins?: (() => void) | undefined;
  /** Opens the dock on the Automations tab. Absent when the host serves none. */
  onOpenAutomations?: (() => void) | undefined;
  /**
   * Opens the dock on the Settings tab (plan/79).
   *
   * Omitted in exactly two cases, and the row's tooltip names which: the dock is
   * unavailable at this width, or the host does not advertise `models_config`.
   */
  onOpenSettings?: (() => void) | undefined;
  /** False keeps the row disabled even at a width that has a dock, and changes the
   *  reason shown from "width" to "this host serves no settings surface". */
  settingsAvailable?: boolean;
  /** Opens the dock on the Models tab (plan/80 — split out of Settings). */
  onOpenModels?: (() => void) | undefined;
  modelsAvailable?: boolean;
  /**
   * Start a fresh AgentSession (`session_new`).
   *
   * Omitted only when the host listed no workspace at all, since the host action
   * needs a cwd. It is NOT gated on an already-open room: DSH shows this row as
   * soon as a workspace exists.
   */
  onNewSession?: (() => void) | undefined;
  /** Host-stated capability for `session_new`; false renders the row inert. */
  canNewSession?: boolean;
  /** True while a `session_new` is in flight (the control renders busy). */
  newSessionBusy?: boolean;

  host: { hostname: string; daemonVersion?: string; relayUrl: string; capabilities?: readonly string[] };
  dockOpen: boolean;
  /** False below 760px, where the dock is not part of the frame at all. */
  dockAvailable: boolean;
  onToggleDock: () => void;
}

export function WorkspaceSidebar({
  rail,
  onToggleRail,
  expansionAvailable,
  workspaces,
  activeRoom,
  onOpenWorkspace,
  query,
  onQueryChange,
  workspacesLoading,
  workspacesError,
  workspaceStates,
  workspacesBusy,
  onRefresh,
  onStart,
  onRestart,
  onStop,
  onOpenPlugins,
  onOpenAutomations,
  onOpenSettings,
  settingsAvailable = true,
  onOpenModels,
  modelsAvailable = true,
  onNewSession,
  canNewSession = true,
  newSessionBusy = false,
  host,
  dockOpen,
  dockAvailable,
  onToggleDock,
}: WorkspaceSidebarProps) {
  const refreshCap = capability("workspace.list");
  const needle = query.trim().toLowerCase();
  /*
   * Hide harness test workspaces.
   *
   * The E2E suites register throwaway workspaces named `rp-live-ws-<8 random
   * chars>` on the host daemon and never unregister them, so they accumulate and
   * pollute the product list ("rp-live-ws-wymGFe — not running"). They carry no
   * flag distinguishing them from a real workspace, so the suite's documented
   * naming prefix is the contract. `VITE_SHOW_TEST_WORKSPACES=1` brings them back
   * when debugging the suites themselves.
   */
  const showTestWorkspaces = import.meta.env["VITE_SHOW_TEST_WORKSPACES"] === "1";
  const productWorkspaces = showTestWorkspaces
    ? workspaces
    : workspaces.filter((ws) => !/^rp-live-ws-/.test(ws.name) && !/rp-live-ws-/.test(ws.cwd));
  const visible = needle
    ? productWorkspaces.filter(
        (ws) =>
          ws.name.toLowerCase().includes(needle) || ws.cwd.toLowerCase().includes(needle),
      )
    : productWorkspaces;
  const refreshEnabled = !workspacesBusy && !workspacesLoading;
  /* Rail-only guidance: the 56px column hides the filter, Start/Restart and
     the row names, so screen readers need to be told where they went. */
  const expandHint = expansionAvailable
    ? "展开侧栏后即可使用工作区筛选和启动、重启操作。"
    : "该宽度下侧栏保持折叠；工作区筛选和启动、重启操作需要更宽的窗口。";

  return (
    <aside
      className={css.root}
      style={{ gridTemplateRows: "auto minmax(0,1fr) auto" }}
      aria-label="工作区"
    >
      {/* ── head ─────────────────────────────────────────────────────────── */}
      <div className={rail ? css.brandRail : css.brandFull}>
        <div className={rail ? css.brandRowRail : css.brandRowFull}>
          <span className={css.mark}>
            <RemotePiMark size={14} />
          </span>
          {rail ? null : (
            <>
              <span
                className={css.brandName}
                style={{ fontFamily: "var(--ff-display)" }}
              >
                Remote Pi
              </span>
              {host.daemonVersion ? (
                <span className={css.versionChip}>
                  {host.daemonVersion}
                </span>
              ) : null}
              <span className={css.spacer} />
            </>
          )}
          <button
            type="button"
            onClick={onToggleRail}
            aria-pressed={rail}
            title={
              rail
                ? expansionAvailable
                  ? "展开侧栏（Ctrl/Cmd+B）"
                  : "该宽度下侧栏无法展开"
                : "收起侧栏（Ctrl/Cmd+B）"
            }
            className={
              rail ? css.toggleRail : css.toggleFull
            }
          >
            <Icon name="panel" size={15} />
            <span className="sr-only">
              {rail
                ? `切换侧栏. ${expandHint}`
                : "切换侧栏"}
            </span>
          </button>
        </div>

        {/*
         * NOTE: the workspace filter is NOT here.
         *
         * DSH keeps search/filter/new inside the "工作区" section header row, not
         * as a full-width input under the brand. A standalone box there pushed the
         * whole list down and read as a different product. It now lives in the
         * section header below.
         */}

        {/*
         * New session — DSH's 38px row, directly under the brand and above any
         * list. Omitted only in the rail (no room for the label) or when the host
         * reported no workspace at all (the wire action needs a cwd).
         */}
        {rail || onNewSession === undefined ? null : (
          <button
            type="button"
            onClick={onNewSession}
            disabled={newSessionBusy || !canNewSession}
            aria-label="新建会话"
            /*
             * Advertised the way DSH does it: `aria-keyshortcuts` for assistive
             * tech and automation, plus a visible `<kbd>` in the hint so a
             * sighted user can discover it. Both describe the Ctrl/Cmd+N handler
             * in remote-pi-shell.tsx; Ctrl+N is the Windows/Linux spelling and
             * `aria-keyshortcuts` accepts it cross-platform.
             */
            aria-keyshortcuts="Control+N"
            title={
              !canNewSession
                ? "新建会话 — 主机没有可用于该操作的命令上下文。"
                : newSessionBusy
                  ? "新建会话 — 正在启动…"
                  : "在该工作区新建会话（Ctrl+N）"
            }
            className={css.newSession}
          >
            <Icon name="plus" size={14} />
            <span className={css.newSessionLabel}>新建会话</span>
            <span className={css.newSessionKbd} aria-hidden="true">
              Ctrl+N
            </span>
          </button>
        )}

        {/*
         * Panel rows — DSH's "插件" (plugins) and "自动化任务" (automations).
         *
         * DSH places these two 36px rows between the new-session row and the
         * workspace region, and they are part of its default information
         * architecture: their absence is what made our sidebar read as a
         * different product even with matching colours.
         *
         * BOTH are real surfaces now, so a disabled row must never claim the
         * host lacks the capability: the only reason either callback is absent is
         * that the dock itself is not available at the current width. Saying "the
         * host exposes no automation surface" was outright false — the host ships
         * `schedule` in HOST_CAPABILITIES and the tab works.
         */}
        {rail ? null : (
          <div className={css.panelList}>
            {/* Plugins is a REAL surface: the host reports installed packages
                and skills in `pi_surface_ok`, so this row opens that dock tab. */}
            <button
              type="button"
              disabled={onOpenPlugins === undefined}
              onClick={onOpenPlugins}
              title={
                onOpenPlugins === undefined
                  ? "插件 — 打开右侧停靠栏以查看该工作区已安装的软件包和技能。该宽度下停靠栏不可用（低于 760px）。"
                  : "插件 — 该工作区已安装的软件包和技能。"
              }
              className={css.panelRow}
            >
              <Icon name="plug" size={16} className={css.panelGlyph} />
              <span className={css.panelTitle}>插件</span>
              {onOpenPlugins === undefined ? (
                <span className="sr-only">
                  已禁用 — 该宽度下右侧停靠栏不可用（低于 760px）。插件会在该停靠栏中打开。
                </span>
              ) : null}
            </button>
            <button
              type="button"
              disabled={onOpenAutomations === undefined}
              onClick={onOpenAutomations}
              title={
                onOpenAutomations === undefined
                  ? "自动化 — 打开右侧停靠栏以管理主机按计划运行的提示词。该宽度下停靠栏不可用（低于 760px）。"
                  : "自动化 — 主机按计划运行的提示词。"
              }
              className={css.panelRow}
            >
              <Icon name="clock" size={16} className={css.panelGlyph} />
              <span className={css.panelTitle}>自动化</span>
              {onOpenAutomations === undefined ? (
                <span className="sr-only">
                  已禁用 — 该宽度下右侧停靠栏不可用（低于 760px）。自动化会在该停靠栏中打开。
                </span>
              ) : null}
            </button>
          </div>
        )}
      </div>

      {/* ── workspace list ────────────────────────────────────────────────── */}
      <div className={css.scroll}>
        {rail ? null : (
          /*
           * Section header — DSH's "工作区" row.
           *
           * DSH puts the label on the left and the search / filter / new controls
           * inline on the right, all on one 32px line. The filter used to be a
           * full-width input above this row, which is why our sidebar had two
           * stacked control rows where the reference has one.
           */
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>工作区</span>
            <label className={css.searchInline}>
              <Icon name="search" size={13} className={css.searchIcon} />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                aria-label="筛选工作区"
                placeholder="筛选"
                autoComplete="off"
                spellCheck={false}
                className={css.searchInput}
              />
            </label>
            <button
              type="button"
              disabled={!refreshEnabled}
              onClick={onRefresh}
              title={
                refreshEnabled
                  ? `刷新 — 重新列出主机目录。${refreshCap.reason}`
                  : workspacesBusy
                    ? "刷新 — 另一个工作区操作仍在进行。"
                    : "刷新 — 目录正在列出中。"
              }
              className={css.refreshSmall}
            >
              <Icon name="refresh" size={12} />
              <span className="sr-only">刷新工作区目录</span>
            </button>
            <span>{visible.length}</span>
          </div>
        )}

        {rail ? (
          <div className={css.railCenter}>
            <p className="sr-only">{expandHint}</p>
            <button
              type="button"
              disabled={!refreshEnabled}
              onClick={onRefresh}
              title={
                refreshEnabled
                  ? `刷新 — 重新列出主机目录。${refreshCap.reason}`
                  : "刷新 — 有工作区操作仍在进行。"
              }
              className={css.railButton}
            >
              <Icon name="refresh" size={15} />
              <span className="sr-only">刷新工作区目录</span>
            </button>
            {workspacesLoading ? (
              <Spinner />
            ) : workspacesError ? (
              /* 56px rail: an icon plus a title/sr-only reason. A paragraph
                 here used to wrap into a one-character column. */
              <span
                title={workspacesError}
                className={css.railError}
              >
                <Icon name="alert" size={15} />
                <span className="sr-only">{`Workspace list failed: ${workspacesError}`}</span>
              </span>
            ) : visible.length === 0 ? (
              <span
                title={
                  needle
                    ? `No workspace matches “${query.trim()}”.`
                    : "尚未报告任何工作区 — 在停靠栏中浏览主机文件系统并启动一个 Pi。"
                }
                className={css.railIdle}
              >
                <Icon name="folder" size={15} />
                <span className="sr-only">
                  {needle
                    ? `No workspace matches “${query.trim()}”. Clear the filter to see every workspace this host returned.`
                    : "尚未报告任何工作区。在右侧停靠栏中浏览主机文件系统并启动 Pi 即可创建。"}
                </span>
              </span>
            ) : null}
          </div>
        ) : workspacesLoading ? (
          <div className={css.railPad}>
            <Spinner />
          </div>
        ) : workspacesError ? (
          <p className={css.errorText}>{workspacesError}</p>
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            title={
              needle
                ? `No workspace matches “${query.trim()}”.`
                : "No workspaces reported yet."
            }
            detail={
              needle
                ? "Clear the filter to see every workspace this host returned."
                : "Browse the host filesystem in the right dock and start a Pi to create one."
            }
          />
        ) : (
          <ul className={css.railList}>
            {visible.map((ws) => {
              const current = activeRoom === ws.room_id;
              const state = workspaceStates?.[ws.cwd] ?? null;
              const status = workspaceStatus(ws, state);
              const { start, restart, stop } = workspaceControls(ws, {
                busy: workspacesBusy,
                state,
              });
              const note = workspaceNote(status);
              if (rail) {
                /* Icon-only row: the rail is 56px wide, so the name and the
                   status label live in `title` + `sr-only`. */
                return (
                  <li key={`${ws.daemon_id}:${ws.room_id}`}>
                    <button
                      type="button"
                      onClick={() => onOpenWorkspace(ws.room_id)}
                      aria-current={current ? "true" : undefined}
                      title={`${ws.name} — ${ws.cwd} · ${status.label}${note ? ` · ${note}` : ""}`}
                      className={
                        current ? css.railItemActive : css.railItemIdle
                      }
                    >
                      <Icon name="folder" size={15} />
                      <span className="sr-only">{`${ws.name} — ${ws.cwd} (${status.label}). ${status.detail}${note ? ` ${note}` : ""}`}</span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={`${ws.daemon_id}:${ws.room_id}`} className={css.listItem}>
                  <div
                    className={
                      current ? css.wsRowActive : css.wsRowIdle
                    }
                  >
                    {current ? (
                      <span className={css.activeMarker} />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onOpenWorkspace(ws.room_id)}
                      aria-current={current ? "true" : undefined}
                      title={`${ws.name} — ${ws.cwd} · ${status.label}`}
                      className={css.wsButton}
                    >
                      <span
                        className={`${css.wsToneIcon} ${TONE_TEXT[status.tone]}`}
                      >
                        <Icon name="folder" size={14} />
                      </span>
                      <span className={css.wsTextCol}>
                        <span
                          className={current ? css.wsNameActive : css.wsNameIdle}
                        >
                          {ws.name}
                        </span>
                      </span>
                      <span
                        className={`${css.wsStatus} ${TONE_TEXT[status.tone]}`}
                      >
                        {status.label}
                      </span>
                    </button>

                    {/* Always-rendered action pair: an inert button states its
                        fixed reason instead of disappearing, so the surface
                        never implies a control that does not exist. */}
                    <span className={css.wsActions}>
                      <button
                        type="button"
                        disabled={!start.enabled}
                        onClick={() => onStart(ws.cwd)}
                        title={`启动 — ${start.reason}`}
                        className={css.startButton}
                      >
                        <Icon name="spark" size={12} />
                        <span className="sr-only">启动 {ws.name}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!restart.enabled}
                        onClick={() => onRestart(ws.cwd)}
                        title={`重启 — ${restart.reason}`}
                        className={css.restartButton}
                      >
                        <Icon name="refresh" size={12} />
                        <span className="sr-only">重启 {ws.name}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!stop.enabled}
                        onClick={() => onStop(ws.cwd)}
                        title={`停止 — ${stop.reason}`}
                        className={css.stopWorkspaceButton}
                      >
                        <Icon name="stop" size={12} />
                        <span className="sr-only">停止 {ws.name}</span>
                      </button>
                    </span>
                  </div>

                  {note ? (
                    <p className={css.wsWarning}>
                      <Icon name="alert" size={11} className={css.wsWarningIcon} />
                      <span>{note}</span>
                    </p>
                  ) : null}
                  <span className="sr-only">
                    {`${ws.name}: ${status.detail}`}
                    {` Source: ${ws.source === "daemon" ? "reported by the host daemon" : "added to the host catalog"}.`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {rail ? null : (
          /*
           * DSH's foot area: a single "更多" (More) row pinned under the list.
           * It is not the host/settings block below — it is the last item of the
           * scrollable column, which is why it participates in the IA order.
           */
          <button
            type="button"
            disabled
            title="更多 — 目前未向 Web 客户端开放其他界面。"
            className={css.moreRow}
          >
            <Icon name="more" size={16} className={css.panelGlyph} />
            <span className={css.panelTitle}>更多</span>
            <span className="sr-only">
              Disabled — no further surfaces are exposed to the web client yet.
            </span>
          </button>
        )}
      </div>

      {/* ── footer ───────────────────────────────────────────────────────── */}
      <div className={css.footer}>
        <div
          className={
            rail ? css.hostRowRail : css.hostRowFull
          }
          title={host.hostname}
        >
          <span className={css.hostDot} />
          {rail ? null : (
            <span className={css.hostText}>
              {/**
               * The hostname is NOT shown. It is the machine's own name (`lei` on this
               * box), which tells the user nothing they did not already know — they
               * are sitting at the machine — while costing the widest line in a
               * narrow rail. The address below is the part that is actually
               * actionable.
               */}
              <span className={css.hostMeta}>
                {host.relayUrl} · host room
              </span>
              {/*
               * The negotiated wire message NAMES and their count are diagnostics,
               * not product copy — `host_pairing · workspace_state · host_forward ·
               * fs_nav` tells a user nothing actionable. They are deliberately not
               * painted into the sidebar (this file's own comment already said so)
               * and are no longer reachable on hover either.
               */}
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={!dockAvailable}
          onClick={onToggleDock}
          aria-pressed={dockOpen}
          title={
            !dockAvailable
              ? "该宽度下右侧停靠栏不可用（低于 760px）。"
              : dockOpen
                ? "收起右侧停靠栏（Ctrl/Cmd+J）"
                : "显示右侧停靠栏（Ctrl/Cmd+J）"
          }
          className={
            rail ? css.dockButtonRail : css.dockButtonFull
          }
        >
          <Icon name="columns" size={16} />
          {rail ? null : (
            <>
              <span>右侧停靠栏</span>
              <kbd className={css.shortcut}>⌘J</kbd>
            </>
          )}
          <span className="sr-only">切换右侧停靠栏</span>
        </button>

        {/*
         * Plan/80 — Models is its own row. It was previously the whole of
         * "Settings", which was a copy-vs-behaviour defect: the label promised
         * preferences and the panel delivered one file. Settings now holds real
         * preferences, and this row edits model providers.
         */}
        <button
          type="button"
          disabled={onOpenModels === undefined}
          onClick={onOpenModels}
          title={
            onOpenModels === undefined
              ? modelsAvailable
                ? "模型 — 打开右侧停靠栏以编辑该主机的模型提供方和模型。该宽度下停靠栏不可用（低于 760px）。"
                : "模型 — 该主机未向此客户端提供模型配置界面。"
              : "模型 — 该主机的模型提供方和模型，保存回它自己的 models.json。"
          }
          className={rail ? css.settingsButtonRail : css.settingsButtonFull}
        >
          <Icon name="cpu" size={16} />
          {rail ? null : <span>模型</span>}
          {onOpenModels === undefined ? (
            <span className="sr-only">
              已禁用 —{" "}
              {modelsAvailable
                ? "该宽度下右侧停靠栏不可用（低于 760px）。模型会在该停靠栏中打开。"
                : "该主机未向此客户端提供模型配置界面。"}
            </span>
          ) : null}
        </button>

        {/*
         * Plan/80 — Settings is now genuinely settings: appearance and behaviour.
         * The row is disabled only when there is nothing to open, and the tooltip
         * names the actual cause — width, or a host with no settings surface.
         */}
        <button
          type="button"
          disabled={onOpenSettings === undefined}
          onClick={onOpenSettings}
          title={
            onOpenSettings === undefined
              ? settingsAvailable
                ? "设置 — 打开右侧停靠栏以调整外观与行为。该宽度下停靠栏不可用（低于 760px）。"
                : "设置 — 该主机未向此客户端提供设置界面。"
              : "设置 — 本浏览器与该主机的外观和行为。"
          }
          className={rail ? css.settingsButtonRail : css.settingsButtonFull}
        >
          <Icon name="settings" size={16} />
          {rail ? null : <span>设置</span>}
          {onOpenSettings === undefined ? (
            <span className="sr-only">
              已禁用 —{" "}
              {settingsAvailable
                ? "该宽度下右侧停靠栏不可用（低于 760px）。设置会在该停靠栏中打开。"
                : "该主机未向此客户端提供设置界面。"}
            </span>
          ) : null}
        </button>
      </div>
    </aside>
  );
}
