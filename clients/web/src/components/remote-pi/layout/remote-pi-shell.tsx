"use client";

/* The Remote Pi web shell: caption bar + three-column frame.
 * Visual source: docs/web_app/原型/index.html (#app, .caption, .frame) +
 * styles.css §4/§11 — sidebar 280px (264–420), collapsed rail 56px, top
 * clearance 48px, automatic sidebar collapse below 1024px, dock opening at
 * ~45% of the viewport capped at 70% with 400px kept for the center column.
 *
 * Layout state (rail/dock/tab/width/filter) lives here because the grid
 * template that consumes it lives here; nothing in this component talks to
 * the host. Data and callbacks come from the route's client container.
 *
 * The frame is deliberately two rows (36px caption / 1fr body) and ends with
 * the host view's security disclosures: their rows are `min-w-0`, so the
 * column width, the responsive collapse and the dock's 400px center reserve
 * are all unchanged by them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "../core/icons";
import { Button, Modal } from "../primitives";
import { ConnectionLauncher, type StoredPairingSummary } from "./connection-launcher";
import {
  RAIL_WIDTH,
  SIDEBAR_COLLAPSE_WIDTH,
  clampDockWidth,
  defaultDockWidth,
  frameGeometry,
  resolveSidebarLayout,
  type SidebarMode,
} from "../core/geometry";
import { RightRail, type RightRailProps } from "./right-rail";
import css from "./remote-pi-shell.module.css";
import { Spinner, StatusPill } from "./states";
import { TranscriptPanel, type TranscriptPanelProps } from "../chat/transcript-panel";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar";

export interface RemotePiShellProps {
  view: "launcher" | "host";

  // launcher
  launcher: {
    address: string;
    onAddressChange: (value: string) => void;
    code: string;
    onCodeChange: (value: string) => void;
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    busy: string | null;
    error: string | null;
    resuming: boolean;
    stored: StoredPairingSummary | null;
    onForgetStored: () => void;
  };

  // app window chrome
  host: {
    hostname: string;
    daemonVersion?: string;
    backend?: string;
    relayUrl: string;
    /** host_hello_ok.capabilities — rendered as text, never interpreted. */
    capabilities?: readonly string[];
    /**
     * The socket is open but the host has stopped answering.
     *
     * Distinct from "offline": a stalled session keeps the connection and drops
     * every request, so the pill claiming "host connected" is actively
     * misleading. Reporting it is the whole point of tracking inbound liveness.
     */
    stale?: boolean;
  };
  onUnpair: () => void;
  unpairArmed: boolean;
  /**
   * Feedback for the host view. The previous single-file page surfaced a busy
   * label and a bottom error line; both are routed here instead of being
   * dropped when the launcher is no longer on screen.
   */
  notice: { tone: "busy" | "error"; text: string; onDismiss?: () => void } | null;

  // columns — the shell owns "open the dock on a tab" so the empty-state
  // next action and the dock toggle cannot drift apart.
  sidebar: Omit<
    WorkspaceSidebarProps,
    | "rail"
    | "onToggleRail"
    | "expansionAvailable"
    | "host"
    | "dockOpen"
    | "dockAvailable"
    | "onToggleDock"
  >;
  transcript: Omit<TranscriptPanelProps, "onBrowseFiles" | "browseFilesAvailable">;
  dock: Omit<
    RightRailProps,
    | "tab"
    | "onTabChange"
    | "collapsed"
    | "onToggleCollapse"
    | "width"
    | "onWidthChange"
    | "sidebarRail"
    | "viewportWidth"
  >;
}

export function RemotePiShell({
  view,
  launcher,
  host,
  onUnpair,
  unpairArmed,
  notice,
  sidebar,
  transcript,
  dock,
}: RemotePiShellProps) {
  /* Sidebar column state (wave 5): `auto` is the pure width rule, the toggle
     writes an explicit `expanded`/`collapsed` override. resolveSidebarLayout
     re-derives the clamped layout on every viewport change, so an override can
     never bypass the frame budget. */
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("auto");
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<RightRailProps["tab"]>("files");
  /*
   * Three dock surfaces load LAZILY and nothing was asking for them on tab open:
   * Plan (fs_list over plan/), Plugins (pi_surface) and Changes (git status). Each
   * rendered from an empty cache and looked broken until an unrelated action
   * happened to populate it. The trigger belongs to the tab change, not to the
   * panel that mounts after it.
   */
  const handleDockTabChange = useCallback(
    (tab: RightRailProps["tab"]) => {
      setDockTab(tab);
      if (tab === "plan") dock.onPlanTabOpen?.();
      if (tab === "plugins") dock.onPluginsRefresh?.();
      if (tab === "changes") dock.onChangesRefresh?.();
      /* Models and Settings read their own files (models.json / settings.json).
       * Neither was re-read on tab open, so the panel rendered whatever the last
       * fetch left behind — or its error state, when the first fetch predated the
       * host surface being announced. */
      if (tab === "models") dock.onModelsReload?.();
      if (tab === "settings") dock.onSettingsReload?.();
    },
    [dock],
  );
  const [dockWidth, setDockWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);

  /* Viewport width drives only layout (auto-collapse + dock ceiling); it never
     reads storage, credentials or the network. */
  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  /* Every layout number below comes from ./geometry.ts (pure): the sidebar
     threshold, the user override, the dock ceiling and the single width
     clamp. */
  const sidebarLayout = useMemo(
    () => resolveSidebarLayout(viewportWidth, sidebarMode),
    [viewportWidth, sidebarMode],
  );
  const sidebarPx = sidebarLayout.width;
  const geo = useMemo(() => frameGeometry(viewportWidth, sidebarPx), [viewportWidth, sidebarPx]);
  const effectiveRail = sidebarLayout.rail;
  const toggleSidebar = useCallback(
    () => setSidebarMode(sidebarLayout.rail ? "expanded" : "collapsed"),
    [sidebarLayout.rail],
  );

  /* Dock default: one clamp in ./geometry.ts (~45% of the viewport, never
     below 280px, never more than viewport - sidebar - 400px). */
  const openDock = useCallback(
    (tab?: RightRailProps["tab"]) => {
      if (tab) handleDockTabChange(tab);
      setDockOpen(true);
      setDockWidth(defaultDockWidth(geo));
    },
    [geo, handleDockTabChange],
  );

  const toggleDock = useCallback(() => {
    if (dockOpen) {
      setDockOpen(false);
      return;
    }
    openDock();
  }, [dockOpen, openDock]);

  /*
   * Keyboard map — only the bindings the shell really implements.
   *
   * Every binding is suppressed while a text field has focus. The composer is a
   * `<textarea>`, and Ctrl+B / Ctrl+J / Ctrl+N are all ordinary editing keys
   * there; firing a layout change mid-sentence would be a data-loss bug, not a
   * shortcut. This guard was missing, so Ctrl+J in the composer toggled the dock.
   */
  useEffect(() => {
    const isTextField = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (el === null) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (key === "j") {
        event.preventDefault();
        toggleDock();
        return;
      }
      /*
       * Ctrl/Cmd+N — start a new session, matching DSH.
       *
       * Routed through the SAME `onNewSession` the sidebar button uses, so the
       * shortcut cannot drift from the button: both hit one handler that already
       * owns the busy flag, the notice and the request correlation.
       */
      if (key === "n" && !isTextField(event.target) && sidebar.onNewSession !== undefined) {
        event.preventDefault();
        sidebar.onNewSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleDock, toggleSidebar, sidebar.onNewSession]);

  /* The rendered dock width re-clamps on every viewport change, so shrinking
     from 1440 to 1023/760 re-clamps instead of keeping the width measured at
     open time (the old overlap bug). */
  const renderDockWidth = clampDockWidth(dockWidth, geo);
  const showDock = dockOpen && geo.dockAvailable;

  const gridTemplate = useMemo(() => {
    const sidebarColumn = `${geo.sidebar}px`;
    // Without a usable dock the frame is two columns: no reserved rail column
    // and no overlay — the dock simply leaves the frame (§11).
    if (!geo.dockAvailable) return `${sidebarColumn} minmax(0,1fr)`;
    const dockColumn = showDock ? `${renderDockWidth}px` : `${RAIL_WIDTH}px`;
    return `${sidebarColumn} minmax(0,1fr) ${dockColumn}`;
  }, [geo, showDock, renderDockWidth]);

  /**
   * The unpair confirmation is a real dialog rather than the old
   * arm-then-click inline button: a destructive irreversible action should not
   * be dismissible by clicking anywhere else, and it needs a focus trap so a
   * keyboard user cannot Tab into the app behind it.
   */
  const [confirmingUnpair, setConfirmingUnpair] = useState(false);

  return (
    <div
      className={`rp-app-shell ${css.shell}`}
      style={{ fontFamily: "var(--ff-body)" }}
    >
      {/* ── host identity / connection state ─────────────────────────────── */}
      <div className={css.titlebar}>
        <span className={css.titleGroup}>
          <b
            className={css.hostName}
            style={{ fontFamily: "var(--ff-display)" }}
          >
            Remote Pi
          </b>
        </span>
        <span className={css.titleActions}>
          <StatusPill
            label={
              view !== "host"
                ? "离线"
                : host.stale === true
                  ? "主机无响应"
                  : "已连接主机"
            }
            tone={view !== "host" ? "idle" : host.stale === true ? "warn" : "ok"}
            title={
              view !== "host"
                ? "No relay connection is open."
                : host.stale === true
                  ? `中继 ${host.relayUrl} · 连接已打开，但主机已超过一分钟没有应答。读取、切换和对话看起来会像没有反应。`
                  : `中继 ${host.relayUrl} · 房间 "host"${host.backend ? ` · Ed25519: ${host.backend}` : ""}`
            }
          />
          {view === "host" ? (
            <button
              type="button"
              onClick={() => setConfirmingUnpair(true)}
              title="解除该主机配对并清除已保存的配对信息"
              className={`${css.unpair} ${unpairArmed ? css.unpairArmed : css.unpairIdle}`}
            >
              <Icon name="plug" size={14} />
              {unpairArmed ? "确认解除" : "解除配对"}
            </button>
          ) : null}
        </span>
      </div>

      {view === "launcher" ? (
        <div className={css.mainScroll}>
          <ConnectionLauncher {...launcher} />
        </div>
      ) : (
        <div className={css.bodyGrid} style={{ gridTemplateColumns: gridTemplate }}>
          <WorkspaceSidebar
            {...sidebar}
            rail={effectiveRail}
            onToggleRail={toggleSidebar}
            expansionAvailable={sidebarLayout.expansionAvailable}
            host={host}
            dockOpen={showDock}
            dockAvailable={geo.dockAvailable}
            onToggleDock={toggleDock}
            /*
             * These four rows are the sidebar's door into the dock. They were
             * declared, rendered and PERMANENTLY DISABLED because nothing ever
             * passed a handler — a dead control that explained itself with a
             * width message the user could not act on at any width.
             */
            onOpenPlugins={geo.dockAvailable ? () => openDock("plugins") : undefined}
            onOpenAutomations={geo.dockAvailable ? () => openDock("automations") : undefined}
            onOpenModels={geo.dockAvailable ? () => openDock("models") : undefined}
            onOpenSettings={geo.dockAvailable ? () => openDock("settings") : undefined}
          />

          {/* Center cell: the transcript stretches and the fixed security
              disclosures sit under it as this cell's own footer row. Wrapping
              here (instead of adding a row to the frame grid) keeps the
              transcript's internal scroll and leaves the frame's column
              widths, the responsive collapse and the dock's 400px center
              reserve exactly as they were. */}
          <div className={css.transcriptColumn}>
            <TranscriptPanel
              {...transcript}
              compact={viewportWidth > 0 && viewportWidth < SIDEBAR_COLLAPSE_WIDTH}
              browseFilesAvailable={geo.dockAvailable}
              onBrowseFiles={() => openDock("files")}
            />
          </div>

          {showDock ? (
            <RightRail
              {...dock}
              tab={dockTab}
              onTabChange={handleDockTabChange}
              collapsed={false}
              onToggleCollapse={() => setDockOpen(false)}
              width={renderDockWidth}
              onWidthChange={setDockWidth}
              sidebarRail={effectiveRail}
              viewportWidth={viewportWidth}
            />
          ) : geo.dockAvailable ? (
            <RightRail
              {...dock}
              tab={dockTab}
              onTabChange={handleDockTabChange}
              collapsed
              onToggleCollapse={toggleDock}
              width={RAIL_WIDTH}
              onWidthChange={setDockWidth}
              sidebarRail={effectiveRail}
              viewportWidth={viewportWidth}
            />
          ) : null}
        </div>
      )}

      {notice ? (
        <div className={css.toastLayer}>
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`${css.toast} ${notice.tone === "error" ? css.toastError : css.toastInfo}`}
          >
            {notice.tone === "busy" ? (
              <Spinner />
            ) : (
              <span className={css.toastDot} />
            )}
            <span className={css.toastText}>{notice.text}</span>
            {notice.onDismiss ? (
              <button
                type="button"
                onClick={notice.onDismiss}
                title="Dismiss"
                className={css.toastDismiss}
              >
                <Icon name="x" size={13} />
                <span className="sr-only">Dismiss</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {confirmingUnpair ? (
        <Modal
          title="解除该主机配对？"
          description={`这将清除 ${host.hostname} 在 ${host.relayUrl} 上已保存的配对。主机只有在用新的配对码重新配对后才能再次访问。`}
          onClose={() => setConfirmingUnpair(false)}
          footer={
            <>
              <Button tone="secondary" onClick={() => setConfirmingUnpair(false)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                onClick={() => {
                  setConfirmingUnpair(false);
                  onUnpair();
                }}
              >
                解除配对
              </Button>
            </>
          }
        >
          <p>
            所有已配对的客户端会一直工作到当前连接断开；本设备会立即忘掉令牌。
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
