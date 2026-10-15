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

import { Icon } from "./icons";
import { ConnectionLauncher, type StoredPairingSummary } from "./connection-launcher";
import {
  RAIL_WIDTH,
  SIDEBAR_COLLAPSE_WIDTH,
  clampDockWidth,
  defaultDockWidth,
  frameGeometry,
  resolveSidebarLayout,
  type SidebarMode,
} from "./geometry";
import { RightRail, type RightRailProps } from "./right-rail";
import { SecurityDisclosures } from "./security-disclosures";
import { Spinner, StatusPill } from "./states";
import { TranscriptPanel, type TranscriptPanelProps } from "./transcript-panel";
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
      if (tab) setDockTab(tab);
      setDockOpen(true);
      setDockWidth(defaultDockWidth(geo));
    },
    [geo],
  );

  const toggleDock = useCallback(() => {
    if (dockOpen) {
      setDockOpen(false);
      return;
    }
    openDock();
  }, [dockOpen, openDock]);

  /* Keyboard map — only the bindings the shell really implements. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (mod && key === "j") {
        event.preventDefault();
        toggleDock();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleDock, toggleSidebar]);

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

  return (
    <div
      className="relative z-10 grid min-h-[calc(100vh-70px)] grid-rows-[36px_minmax(0,1fr)] text-white"
      style={{ fontFamily: "var(--ff-body)" }}
    >
      {/* ── caption / window chrome ─────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-[#060606] px-3 text-[12.5px] text-[#6b6b6b]">
        <span className="flex gap-2" aria-hidden="true">
          <i className="block size-[11px] rounded-full bg-[#ff5f57]" />
          <i className="block size-[11px] rounded-full bg-[#febc2e]" />
          <i className="block size-[11px] rounded-full bg-[#28c840]" />
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[#a3a3a3]">
          <b
            className="text-[12.5px] font-semibold text-white"
            style={{ fontFamily: "var(--ff-display)" }}
          >
            Remote Pi
          </b>
          <span className="text-[#6b6b6b]">·</span>
          <span className="truncate font-mono text-[11.5px] text-[#a3a3a3]">
            {view === "host" ? host.hostname : "not connected"}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <StatusPill
            label={view === "host" ? "host connected" : "offline"}
            tone={view === "host" ? "ok" : "idle"}
            title={
              view === "host"
                ? `Relay ${host.relayUrl} · room "host"${host.backend ? ` · Ed25519: ${host.backend}` : ""}`
                : "No relay connection is open."
            }
          />
          {view === "host" ? (
            <button
              type="button"
              onClick={onUnpair}
              title="Unpair this host and clear the stored pairing"
              className={`inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[12px] transition hover:bg-white/10 ${
                unpairArmed ? "text-[#f25a5a]" : "text-[#6b6b6b] hover:text-white"
              }`}
            >
              <Icon name="plug" size={14} />
              {unpairArmed ? "Confirm unpair" : "Unpair"}
            </button>
          ) : null}
        </span>
      </div>

      {view === "launcher" ? (
        <div className="min-h-0 overflow-y-auto">
          <ConnectionLauncher {...launcher} />
        </div>
      ) : (
        <div className="grid min-h-0 min-w-0" style={{ gridTemplateColumns: gridTemplate }}>
          <WorkspaceSidebar
            {...sidebar}
            rail={effectiveRail}
            onToggleRail={toggleSidebar}
            expansionAvailable={sidebarLayout.expansionAvailable}
            host={host}
            dockOpen={showDock}
            dockAvailable={geo.dockAvailable}
            onToggleDock={toggleDock}
          />

          {/* Center cell: the transcript stretches and the fixed security
              disclosures sit under it as this cell's own footer row. Wrapping
              here (instead of adding a row to the frame grid) keeps the
              transcript's internal scroll and leaves the frame's column
              widths, the responsive collapse and the dock's 400px center
              reserve exactly as they were. */}
          <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
            <TranscriptPanel
              {...transcript}
              compact={viewportWidth > 0 && viewportWidth < SIDEBAR_COLLAPSE_WIDTH}
              browseFilesAvailable={geo.dockAvailable}
              onBrowseFiles={() => openDock("files")}
            />
            {/* Static client text — never host text, never tied to the
                transient `notice` line below, so the limits stay readable
                even while the connection is healthy. */}
            <div className="px-[70px] pb-4 max-[1023px]:pl-[52px] max-[1023px]:pr-6 max-[760px]:pl-[38px] max-[760px]:pr-4">
              <div className="mx-auto max-w-[848px]">
                <SecurityDisclosures id="host-security-disclosures" />
              </div>
            </div>
          </div>

          {showDock ? (
            <RightRail
              {...dock}
              tab={dockTab}
              onTabChange={setDockTab}
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
              onTabChange={setDockTab}
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
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-20 -translate-x-1/2">
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-center gap-2.5 rounded-[14px] border px-3.5 py-2.5 text-[13px] shadow-[0_12px_32px_-8px_rgba(15,17,21,0.6)] ${
              notice.tone === "error"
                ? "border-[rgba(242,90,90,0.4)] bg-[#151517] text-[#f25a5a]"
                : "border-white/15 bg-[#151517] text-[#d4d4d4]"
            }`}
          >
            {notice.tone === "busy" ? (
              <Spinner />
            ) : (
              <span className="size-[7px] shrink-0 rounded-full bg-[#f25a5a]" />
            )}
            <span className="whitespace-pre-wrap">{notice.text}</span>
            {notice.onDismiss ? (
              <button
                type="button"
                onClick={notice.onDismiss}
                title="Dismiss"
                className="ml-1 grid size-5 place-items-center rounded text-[#a3a3a3] transition hover:bg-white/10 hover:text-white"
              >
                <Icon name="x" size={13} />
                <span className="sr-only">Dismiss</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
