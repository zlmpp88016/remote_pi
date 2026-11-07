"use client";

/* Right edge dock: tab strip + body, drag-resizable.
 * Visual source: docs/web_app/原型/index.html (.dock) + styles.css §8.
 *
 * Wave 1 ships the Files tab against the real `fs_list` wire and keeps the
 * other tabs declared-but-inert (Plan/Changes have no host contract yet), so
 * the intent is visible without faking content. The dock can also be collapsed
 * to a 56px rail, which is the useful state on narrow screens.
 */
import {
  useCallback,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { FsEntry, ModelsDescribeOk, ModelsOpWire, SettingsDescribeOk, SettingsOpWire } from "@/lib/remote-pi/protocol";
import { DEFAULT_PRESET_ID, type ThemePreset } from "@/lib/theme-presets";
import type { ResolvedMode, ThemeMode } from "@/lib/theme-mode";
import type { WireSessionInfo } from "@/lib/remote-pi/sessions";

import {
  RAIL_WIDTH,
  DOCK_MIN_WIDTH as GEOMETRY_DOCK_MIN_WIDTH,
  CENTER_MIN_WIDTH,
  clampDockWidth,
  frameGeometry,
} from "../core/geometry";
import { Icon } from "../core/icons";
import { Slot } from "../core/slots";
import { joinRemotePath } from "@/lib/remote-pi/remote-path";
import { EmptyState, ErrorState, Spinner } from "./states";
import css from "./right-rail.module.css";
import { SessionList } from "../sessions/session-list";
import { PlanPanel } from "./plan-panel";
import { AutomationsPanel, type AutomationFire, type AutomationRow } from "./automations-panel";
import { SettingsPanel, type SettingsPhase } from "./settings-panel";
import { ModelProvidersPanel, type SettingsPhase as ModelsPhase } from "./model-providers-panel";
import { PluginsPanel } from "./plugins-panel";
import { ChangesPanel } from "./changes-panel";
import type { ChangesSnapshotWire, ChangesUnavailableReason } from "@/lib/remote-pi/protocol";
import { capability, fsControls, fsAvailability, type DockTabId } from "../core/view-model";


/* Geometry values come from ./geometry.ts — the single clamp used by the
   default width, the shell grid column and this drag handle. Re-exported so
   existing importers keep working without a second copy of the numbers. */
export const DOCK_RAIL_WIDTH = RAIL_WIDTH;
export const DOCK_MIN_WIDTH = GEOMETRY_DOCK_MIN_WIDTH;
export const DOCK_MIN_CENTER = CENTER_MIN_WIDTH;

/* Keyboard resize steps for the focusable separator. Local constants: the
   handler only ever hands `onWidthChange` a clamped px number. */
const DOCK_KEY_STEP = 16;
const DOCK_KEY_STEP_LARGE = 64;

const TABS: readonly { id: DockTabId; label: string; icon: "book" | "folder" | "branch" | "msg" | "plug" | "clock" | "cpu" | "settings" }[] = [
  { id: "sessions", label: "会话", icon: "msg" },
  { id: "plan", label: "计划", icon: "book" },
  { id: "files", label: "文件", icon: "folder" },
  { id: "changes", label: "更改", icon: "branch" },
  { id: "plugins", label: "插件", icon: "plug" },
  { id: "automations", label: "自动化", icon: "clock" },
  { id: "models", label: "模型", icon: "cpu" },
  { id: "settings", label: "设置", icon: "settings" },
];

/* Stable fallbacks for the Automations panel.
 *
 * Defined at module scope, not inline in the JSX: a fresh Map/closure on every
 * render would defeat the panel's memoised derive and, worse, make a caller that
 * forgot to pass a handler look like it re-subscribed on every keystroke.
 * A NO-OP here is honest — the panel disables its controls when the host reports
 * no automations surface, so these only run for a caller that wired the tab
 * without wiring the data. */
const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();
/** Stable empty catalog so the model picker does not remount every render while
 *  the host has not answered yet. */
const EMPTY_MODELS: readonly { id: string; name: string; provider: string }[] = [];
const NOOP_VOID = (): void => undefined;
const NOOP_OPS = (): void => undefined;
const NOOP_OPS_SETTINGS = (): void => undefined;
const NOOP_PRESET = (): void => undefined;
const NOOP_MODE = (): void => undefined;
const NOOP_ID = (_id: string): void => undefined;
const NOOP_ENABLED = (_id: string, _enabled: boolean): void => undefined;
const NOOP_CREATE = (_input: {
  schedule: string;
  prompt: string;
  tz: string | null;
  skipIfBusy: boolean;
  wake: boolean;
  catchup: boolean;
  daemonId: string | null;
  model: { provider: string; id: string } | null;
  freshSession: boolean;
}): void => undefined;

/** One package row as the dock renders it. `key` is `source`+`scope` so the
 *  same source configured at both scopes stays two distinct rows. */
export interface WirePackageRow {
  source: string;
  scope: "user" | "project";
  resources: readonly string[];
  /** The package README the host read, or null when it ships none. */
  readme: string | null;
  readmePath: string | null;
  readmeTruncated: boolean;
  /**
   * Whether the package's resources will load.
   *
   * `null` means the host did not say (an older host omits the field). It must
   * not be drawn as "off": a package whose state is unknown is not disabled.
   */
  enabled: boolean | null;
}

/** One installed skill, with the `enabled` tri-state the host reports
 *  (`null` = it could not determine the state, which is NOT `false`). */
export interface PluginSkillRow {
  name: string;
  description: string;
  source: "user" | "project" | "package";
  enabled: boolean | null;
}

export interface RightRailProps {
  tab: DockTabId;
  onTabChange: (tab: DockTabId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Current dock width in px (owned by the shell so the grid can match). */
  width: number;
  onWidthChange: (width: number) => void;
  sidebarRail: boolean;
  /** Live viewport width, so a drag clamps against the current frame. */
  viewportWidth: number;
  fsPath: string;
  onFsPathChange: (path: string) => void;
  fsParent: string | null;
  fsEntries: readonly FsEntry[];
  fsLoading: boolean;
  fsError: string | null;
  /** Distinguishes "never listed" from "listed and empty" in the body. */
  fsLoaded: boolean;
  onList: (path: string) => void;
  onStart: (cwd: string) => void;
  /**
   * Wave 3: add the CURRENT host-canonical directory to the host catalog
   * (`workspace_add`). Enabled only after a successful list (`fsLoaded`), so
   * the path handed to the host is one the host itself returned.
   */
  onAdd: (cwd: string) => void;
  /**
   * Wave 4: drop the CURRENT host-canonical directory from the host catalog
   * (`workspace_remove`). Gated exactly like `onAdd` — the path must be one the
   * host itself returned — so a removal can never name a path the client typed.
   */
  onRemove: (path: string) => void;
  /**
   * Plugins tab (`pi_surface_ok.packages` + the installed skills).
   *
   * Both lists come straight from the host — the dock never guesses what is
   * installed. `packagesBusy` disables the per-row actions while a mutation is
   * in flight, so a double click cannot queue two writes to the same settings
   * entry.
   */
  packages: readonly WirePackageRow[];
  pluginSkills: readonly PluginSkillRow[];
  packagesBusy: boolean;
  packagesReason: string | null;
  /** Per-package in-flight operations, keyed by `scope:source`. */
  packagesBusyKeys: ReadonlySet<string>;
  /** Fixed failure sentence for the last plugin operation, or null. */
  packagesNotice: string | null;
  onPackageInstall: (source: string, scope: "user" | "project") => void;
  onPackageSetEnabled: (source: string, scope: "user" | "project", enabled: boolean) => void;
  /** Called when the Plugins tab becomes active, and by its Refresh control.
   *  Optional so a test fixture can render the dock idle. */
  onPluginsRefresh?: () => void;
  /** Increments once per confirmed install; lets the Install form close itself. */
  pluginsInstalledAt?: number;
  /** A plugin change is written but the Pi has not restarted to load it yet. */
  pluginsRestartPending?: boolean;
  /** Automations — the projected task list (daemon cron, plan/39). */
  automations?: readonly AutomationRow[];
  /** Automations — fires pushed while the client was connected, newest first. */
  automationFires?: readonly AutomationFire[];
  automationReason?: string | null;
  automationNotice?: string | null;
  automationsBusy?: boolean;
  /** daemon id -> human workspace name. Never a host path. */
  automationWorkspaceNames?: ReadonlyMap<string, string>;
  /** Plan/78 — Changes tab state. `snapshot` null + `busy` means still asking;
   *  `unavailable` non-null is a FAILURE (non-repo, git missing), which is a
   *  different fact from a clean worktree and must not render as one. */
  changesSnapshot?: ChangesSnapshotWire | null;
  changesBusy?: boolean;
  /** Plan/79 — Model Providers tab state. `modelsData` is the host's models config
   *  with every credential REMOVED; the error/saved strings are client-authored. */
  modelsData?: ModelsDescribeOk | null;
  modelsPhase?: ModelsPhase;
  modelsError?: string | null;
  modelsSaved?: string | null;
  modelsDisabledReason?: string | null;
  modelsHostName?: string | null;
  onModelsReload?: () => void;
  onModelsSave?: (ops: ModelsOpWire[]) => void;
  /** Plan/80 — Settings tab state: the host settings.json whitelist projection. */
  settingsData?: SettingsDescribeOk | null;
  settingsPhase?: SettingsPhase;
  settingsError?: string | null;
  settingsSaved?: string | null;
  settingsDisabledReason?: string | null;
  settingsHostName?: string | null;
  onSettingsReload?: () => void;
  onSettingsSave?: (ops: SettingsOpWire[]) => void;
  /** Plan/81 — light/dark/system. Selects the palette. */
  themeMode?: ThemeMode;
  resolvedMode?: ResolvedMode;
  onThemeModeChange?: (mode: ThemeMode) => void;
  /** Plan/80 — the active browser-local accent preset. */
  themePresetId?: string;
  onThemePresetChange?: (preset: ThemePreset) => void;
  changesUnavailable?: ChangesUnavailableReason | null;
  changesReason?: string | null;
  onChangesRefresh?: () => void;
  changesDisabledReason?: string | null;
  automationActiveDaemonId?: string | null;
  automationModelOptions?: readonly { id: string; name: string; provider: string }[];
  onAutomationCreate?: (input: {
    schedule: string;
    prompt: string;
    tz: string | null;
    skipIfBusy: boolean;
    wake: boolean;
    catchup: boolean;
    daemonId: string | null;
    model: { provider: string; id: string } | null;
    freshSession: boolean;
  }) => void;
  onAutomationSetEnabled?: (id: string, enabled: boolean) => void;
  onAutomationRemove?: (id: string) => void;
  onAutomationRunNow?: (id: string) => void;
  onAutomationsRefresh?: () => void;
  onPackageUpdate: (source: string) => void;
  onPackageRemove: (source: string, scope: "user" | "project") => void;
  onSkillToggle: (name: string, enabled: boolean) => void;
  /**
   * Plan tab (`fs_read`, plan/77).
   *
   * `planDoc` is null until a read succeeds; `planError` is a FIXED
   * client-authored sentence, never host prose. `planFile` is the path the
   * viewer asked for, so the empty state can name what it looked at instead of
   * claiming the protocol is incapable.
   */
  /** Absolute paths of the workspace plan documents the host listed. Owned by
   *  the container: the dock renders what the host returned and never builds a
   *  path of its own. */
  planFiles: readonly string[];
  planDoc: { path: string; content: string; truncated: boolean; bytes: number } | null;
  planLoading: boolean;
  planError: string | null;
  planTruncatedNotice: string;
  onReadPlan: (path: string) => void;
  /** Clears the open document so the panel returns to its list. */
  onClosePlan: () => void;
  /** Called when the Plan tab becomes active: the container lists plan/ for
   *  this workspace. Optional so a test fixture can render the dock idle. */
  onPlanTabOpen?: () => void;
  /** Hidden entries are opt-in on the wire (`fs_list {show_hidden}`). */
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  /**
   * `host_hello_ok.capabilities` includes `fs_nav`. The dock is the only
   * consumer, so the value arrives as a boolean plus an optional fixed reason
   * — never as an undefined host string the UI would have to interpret.
   */
  fsAvailable: boolean;
  fsAvailableReason?: string | null;
  busy: boolean;

  // ── sessions (the dock's Sessions tab) ─────────────────────────────────
  /** The active workspace's AgentSessions, newest first. */
  sessions: readonly WireSessionInfo[];
  sessionsBusy: boolean;
  /** Fixed, client-authored reason sessions cannot load, or null. */
  sessionsDisabledReason: string | null;
  /** Session currently open for READING (read-only; not the live one). */
  sessionViewingId: string | null;
  /** The LIVE session id, as the host reported it. */
  sessionLiveId: string | null;
  /** Fixed sentence for the last failed session action, or null. */
  sessionsNotice: string | null;
  /** "Now" for relative ages, passed in so this render stays pure. */
  now: number;
  onSessionsRefresh: () => void;
  onSessionRead: (id: string) => void;
  onSessionPrefetch?: ((id: string) => void) | undefined;
}

export function RightRail({
  tab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  width,
  onWidthChange,
  sidebarRail,
  viewportWidth,
  fsPath,
  onFsPathChange,
  fsParent,
  fsEntries,
  fsLoading,
  fsError,
  fsLoaded,
  onList,
  planFiles,
  planDoc,
  planLoading,
  planError,
  planTruncatedNotice,
  onReadPlan,
  onClosePlan,
  onStart,
  onAdd,
  onRemove,
  packages,
  pluginSkills,
  packagesBusy,
  packagesReason,
  packagesNotice,
  packagesBusyKeys,
  onPackageInstall,
  onPackageSetEnabled,
  onPluginsRefresh,
  pluginsInstalledAt,
  pluginsRestartPending,
  automations,
  automationFires,
  automationReason,
  automationNotice,
  automationsBusy,
  automationWorkspaceNames,
  automationActiveDaemonId,
  automationModelOptions,
  changesSnapshot,
  changesBusy,
  changesUnavailable,
  changesReason,
  onChangesRefresh,
  changesDisabledReason,
  modelsData,
  modelsPhase = "idle",
  modelsError = null,
  modelsSaved = null,
  modelsDisabledReason = null,
  modelsHostName = null,
  onModelsReload,
  onModelsSave,
  settingsData,
  settingsPhase = "idle",
  settingsError = null,
  settingsSaved = null,
  settingsDisabledReason = null,
  settingsHostName = null,
  onSettingsReload,
  onSettingsSave,
  themeMode = "system",
  resolvedMode = "light",
  onThemeModeChange,
  themePresetId,
  onThemePresetChange,
  onAutomationCreate,
  onAutomationSetEnabled,
  onAutomationRemove,
  onAutomationRunNow,
  onAutomationsRefresh,
  onPackageUpdate,
  onPackageRemove,
  onSkillToggle,
  showHidden,
  onShowHiddenChange,
  fsAvailable,
  fsAvailableReason,
  busy,
  sessions,
  sessionsBusy,
  sessionsDisabledReason,
  sessionViewingId,
  sessionLiveId,
  sessionsNotice,
  now,
  onSessionsRefresh,
  onSessionRead,
  onSessionPrefetch,
}: RightRailProps) {
  const [dragging, setDragging] = useState(false);

  const onGrabDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [],
  );

  const onGrabMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      // Same clamp as open/render: `room` is what the pointer left over, then
      // clampDockWidth enforces the min, the 70% ceiling and the 400px center.
      const geo = frameGeometry(viewportWidth, sidebarRail ? RAIL_WIDTH : 280);
      onWidthChange(clampDockWidth(window.innerWidth - event.clientX, geo));
    },
    [dragging, sidebarRail, viewportWidth, onWidthChange],
  );

  const onGrabUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }, []);

  /* Keyboard-only resize. Reads the same pure geometry as the pointer path,
   * clamps with `clampDockWidth`, and passes the caller a plain px number —
   * no host value, path or capability string crosses this boundary. */
  const onGrabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const geo = frameGeometry(viewportWidth, sidebarRail ? RAIL_WIDTH : 280);
      if (!geo.dockAvailable) return;
      const step = event.shiftKey ? DOCK_KEY_STEP_LARGE : DOCK_KEY_STEP;
      let next: number;
      switch (event.key) {
        case "ArrowLeft":
          next = width + step;
          break;
        case "ArrowRight":
          next = width - step;
          break;
        case "Home":
          next = DOCK_MIN_WIDTH;
          break;
        case "End":
          next = geo.dockMax;
          break;
        default:
          return;
      }
      event.preventDefault();
      onWidthChange(clampDockWidth(next, geo));
    },
    [width, sidebarRail, viewportWidth, onWidthChange],
  );

  /* Frame geometry for the separator's ARIA range. Pure local arithmetic —
   * never a value reported by the host. */
  const geo = frameGeometry(viewportWidth, sidebarRail ? RAIL_WIDTH : 280);
  const dockNow = clampDockWidth(width, geo) || DOCK_MIN_WIDTH;
  const dockMax = Math.max(DOCK_MIN_WIDTH, geo.dockMax);

  const filesCap = capability("fs.list");
  const startCap = capability("workspace.start");
  const addCap = capability("workspace.add");
  const fs = fsAvailability(fsAvailable, fsAvailableReason);
  const controls = fsControls({ ...fs, busy, fsLoading, fsLoaded });

  /* The host's `parent` is authoritative, including a `null` root: the browser
   *  resolves nothing and never guesses a parent from the path text. */
  const parent = fsParent;

  if (collapsed) {
    return (
      <aside
        className={css.railCollapsed}
        aria-label="停靠栏（已折叠）"
      >
        <div className={css.collapsedHead}>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="显示右侧停靠栏"
            className={css.iconButton}
          >
            <Icon name="chevR" size={15} className={css.iconFlipped} />
            <span className="sr-only">显示右侧停靠栏</span>
          </button>
        </div>
        {/* Rail body: icons only (the label lives in `title` + `sr-only`).
            No list text here — the rail is 56px wide and stacked words used to
            wrap into a one-character column. */}
        <div className={css.railTabs}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                onTabChange(entry.id);
                onToggleCollapse();
              }}
              title={entry.label}
              className={css.railTabButton}
            >
              <Icon name={entry.icon} size={15} />
              <span className="sr-only">{entry.label}</span>
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={css.rail}
      style={{ width }}
      aria-label="停靠栏"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整停靠栏宽度"
        title="拖动，或聚焦后用左右方向键（按住 Shift 步长更大，Home/End 到最小/最大）"
        tabIndex={0}
        aria-valuemin={DOCK_MIN_WIDTH}
        aria-valuemax={dockMax}
        aria-valuenow={dockNow}
        aria-valuetext={`${dockNow} pixels wide`}
        onKeyDown={onGrabKeyDown}
        onPointerDown={onGrabDown}
        onPointerMove={onGrabMove}
        onPointerUp={onGrabUp}
        onPointerCancel={onGrabUp}
        className={`${css.resizer} ${dragging ? css.resizerDragging : css.resizerIdle}`}
      />

      <div className={css.head}>
        <div className={css.tabList}>
          <Slot name="dock.tabs" />
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onTabChange(entry.id)}
              aria-current={tab === entry.id ? "true" : undefined}
              title={`${entry.label} — ${tabReason(entry.id)}`}
              className={
                tab === entry.id ? css.tabActive : css.tabIdle
              }
            >
              <Icon name={entry.icon} size={14} />
              <span className={css.tabLabel}>{entry.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="收起停靠栏（Ctrl/Cmd+J）"
          className={css.collapseButton}
        >
          <Icon name="x" size={15} />
          <span className="sr-only">收起停靠栏</span>
        </button>
      </div>

      {tab === "sessions" ? (
        /* Sessions owns the whole cell height: the list inside has its own
         * scroll box, so a workspace with hundreds of sessions scrolls here
         * and never grows the page. `overflow-hidden` (not `auto`) keeps this
         * wrapper from becoming a second scrollbar. */
        <div className={css.panelHidden}>
          <SessionList
            sessions={sessions}
            busy={sessionsBusy}
            disabledReason={sessionsDisabledReason}
            viewingId={sessionViewingId}
            liveId={sessionLiveId}
            notice={sessionsNotice}
            now={now}
            onOpen={onSessionsRefresh}
            onRead={onSessionRead}
            onPrefetch={onSessionPrefetch}
          />
        </div>
      ) : tab === "plan" ? (
        /* Plan owns the whole cell height, like Sessions. The panel itself is
         * `overflow:auto`, which is precisely the container that scrolled a
         * freshly opened document off the top; giving Plan its own
         * `overflow:hidden` wrapper removes that scroll context entirely. */
        <div className={css.panelHidden}>
          <PlanPanel
            planFiles={planFiles}
            planDoc={planDoc}
            planLoading={planLoading}
            planError={planError}
            planTruncatedNotice={planTruncatedNotice}
            onReadPlan={onReadPlan}
            onClosePlan={onClosePlan}
            introReason={tabReason("plan")}
          />
        </div>
      ) : tab === "plugins" ? (
        /* Plugins owns the whole cell height, like Sessions and Plan. It must
         * NOT sit inside `.panel`, whose `overflow: auto` would become a second
         * scroll container around the panel own scroller and could push a
         * freshly opened detail view off-screen — the exact failure that moved
         * Plan out of `.panel` earlier. */
        <div className={css.panelHidden}>
          <PluginsPanel
            packages={packages}
            skills={pluginSkills}
            disabledReason={packagesReason}
            busy={packagesBusy}
            notice={packagesNotice}
            busyKeys={packagesBusyKeys}
            installedAt={pluginsInstalledAt ?? 0}
            restartPending={pluginsRestartPending === true}
            onSetEnabled={onPackageSetEnabled}
            onInstall={onPackageInstall}
            onRemove={onPackageRemove}
            onUpdate={onPackageUpdate}
            onSkillToggle={onSkillToggle}
            onRefresh={onPluginsRefresh}
            introReason={tabReason("plugins")}
          />
        </div>
      ) : tab === "automations" ? (
        /* Same placement rule as Plugins: outside `.panel`, owning the whole
         * cell height, so its single scroller is the only one. */
        <div className={css.panelHidden}>
          <AutomationsPanel
            tasks={automations ?? []}
            fires={automationFires ?? []}
            disabledReason={automationReason ?? null}
            notice={automationNotice ?? null}
            busy={automationsBusy === true}
            workspaceNames={automationWorkspaceNames ?? EMPTY_NAMES}
            activeDaemonId={automationActiveDaemonId ?? null}
            modelOptions={automationModelOptions ?? EMPTY_MODELS}
            onCreate={onAutomationCreate ?? NOOP_CREATE}
            onSetEnabled={onAutomationSetEnabled ?? NOOP_ENABLED}
            onRemove={onAutomationRemove ?? NOOP_ID}
            onRunNow={onAutomationRunNow ?? NOOP_ID}
            onRefresh={onAutomationsRefresh ?? NOOP_VOID}
          />
        </div>
      ) : tab === "changes" ? (
        /* Owns the whole cell height like Plugins/Automations, so its single
         * scroller is the only one in this tab (plan/78). */
        <div className={css.panelHidden}>
          <ChangesPanel
            snapshot={changesSnapshot ?? null}
            busy={changesBusy === true}
            unavailable={changesUnavailable ?? null}
            unavailableText={changesReason ?? null}
            onRefresh={onChangesRefresh ?? NOOP_VOID}
            disabledReason={changesDisabledReason ?? null}
          />
        </div>
      ) : tab === "models" ? (
        /* Plan/80 — model providers moved OUT of Settings. Owns the whole cell
         * height like the other full-bleed panels. */
        <div className={css.panelHidden}>
          <ModelProvidersPanel
            data={modelsData ?? null}
            phase={modelsPhase}
            error={modelsError}
            saved={modelsSaved}
            disabledReason={modelsDisabledReason}
            hostName={modelsHostName}
            onReload={onModelsReload ?? NOOP_VOID}
            onSave={onModelsSave ?? NOOP_OPS}
          />
        </div>
      ) : tab === "settings" ? (
        /* Owns the whole cell height like Plugins/Automations/Changes, so its
         * single scroller is the only one in this tab. */
        <div className={css.panelHidden}>
          <SettingsPanel
            data={settingsData ?? null}
            phase={settingsPhase}
            error={settingsError}
            saved={settingsSaved}
            disabledReason={settingsDisabledReason}
            hostName={settingsHostName}
            themeMode={themeMode}
            resolvedMode={resolvedMode}
            onModeChange={onThemeModeChange ?? NOOP_MODE}
            presetId={themePresetId ?? DEFAULT_PRESET_ID}
            onPresetChange={onThemePresetChange ?? NOOP_PRESET}
            onReload={onSettingsReload ?? NOOP_VOID}
            onSave={onSettingsSave ?? NOOP_OPS_SETTINGS}
          />
        </div>
      ) : (
        <div className={css.panel}>
          {tab === "files" ? (
          <div className={css.panelStack}>
            <div className={css.row}>
              <input
                value={fsPath}
                onChange={(event) => onFsPathChange(event.target.value)}
                aria-label="要列出的远程目录路径"
                title="要列出的远程目录路径"
                placeholder="~/projects"
                autoComplete="off"
                spellCheck={false}
                className={css.textInput}
              />
              <button
                type="button"
                disabled={fsLoading || !fs.available}
                onClick={() => onList(fsPath)}
                title={fs.available ? filesCap.reason : fs.reason}
                className={css.primaryButton}
              >
                列出
              </button>
            </div>

            {/* Both wave-3 controls stay rendered and INERT with a fixed
                reason when unavailable: a control that vanishes cannot explain
                itself, and disabling here is what keeps “Add to catalog” from
                ever sending a path the host did not canonicalize. */}
            <div className={css.buttonRow}>
              <button
                type="button"
                disabled={!controls.add.enabled}
                onClick={() => onAdd(fsPath)}
                title={`加入目录 — ${controls.add.reason} ${addCap.reason}`}
                className={css.secondaryButton}
              >
                <Icon name="plus" size={13} />
                加入目录
                <span className="sr-only">将当前目录加入主机目录</span>
              </button>
              <button
                type="button"
                disabled={!controls.start.enabled}
                onClick={() => onStart(fsPath)}
                title={`在此启动 Pi — ${controls.start.reason}`}
                className={css.accentButton}
              >
                <Icon name="spark" size={13} />
                在此启动 Pi
                <span className="sr-only">在当前目录启动 Pi</span>
              </button>
              {/* Removal sits beside Add because the two are inverses of the
                  same catalog entry, and disabled with the same fixed reason:
                  once a path is canonical and loaded, either is legal. */}
              <button
                type="button"
                disabled={!controls.remove.enabled}
                onClick={() => onRemove(fsPath)}
                title={`从目录中移除 — ${controls.remove.reason}`}
                className={css.secondaryButton}
              >
                <Icon name="x" size={13} />
                移除
                <span className="sr-only">从主机目录移除当前目录</span>
              </button>
            </div>

            <label
              className={`${css.checkboxRow} ${fs.available ? css.checkboxAvailable : css.checkboxUnavailable}`}
              title={
                fs.available
                  ? "让主机在列表中包含点文件和隐藏项。"
                  : fs.reason
              }
            >
              <input
                type="checkbox"
                checked={showHidden}
                disabled={!fs.available}
                onChange={(event) => onShowHiddenChange(event.target.checked)}
                className={css.checkbox}
              />
              <span>显示隐藏项</span>
            </label>

            <div className={css.pathRow}>
              <span className={css.pathText} title={fsPath}>
                {parent ?? "root"}
              </span>
              {parent ? (
                <button
                  type="button"
                  disabled={!fs.available || fsLoading}
                  onClick={() => onList(parent)}
                  className={css.linkButton}
                >
                  <Icon name="chevR" size={12} className={css.iconFlipped} />
                  up one level
                </button>
              ) : null}
            </div>

            {!fs.available ? (
              <p className={css.reasonText}>{fs.reason}</p>
            ) : null}

            {fsLoading ? (
              <div className={css.listingRow}>
                <Spinner />
                <span className={css.loadingText}>正在列出…</span>
              </div>
            ) : null}

            {fsError ? <ErrorState title="文件系统列表失败" detail={fsError} /> : null}

            {!fsLoading && !fsError && fsEntries.length === 0 ? (
              <EmptyState
                compact
                title={fsLoaded ? "该目录为空。" : "尚未列出任何内容。"}
                detail={
                  filesCap.status === "ready"
                    ? "在上方输入路径（如 ~/projects）后点「列出」。目录可以打开，也可以作为 Pi 工作区启动。"
                    : filesCap.reason
                }
              />
            ) : null}

            {fsEntries.length > 0 ? (
              <ul className={css.entryList}>
                {fsEntries.map((entry) => {
                  /* DIRECT children only, joined with the host-canonical
                     directory via the pure helper: the row never edits the
                     typed path, and the host re-canonicalizes on the next
                     list. No filesystem call happens here. */
                  const child = joinRemotePath(fsPath, entry.name);
                  const rowBusy = busy || fsLoading || !fs.available;
                  return (
                    <li
                      key={`${entry.kind}:${entry.name}`}
                      className={css.entryRow}
                    >
                      <Icon
                        name={entry.kind === "dir" ? "folder" : "file"}
                        size={13}
                        className={entry.kind === "dir" ? css.entryDirIcon : css.entryFileIcon}
                      />
                      {entry.kind === "dir" ? (
                        <button
                          type="button"
                          disabled={!fs.available || fsLoading}
                          onClick={() => {
                            onFsPathChange(child);
                            onList(child);
                          }}
                          className={css.entryNameButton}
                        >
                          {entry.name}/
                        </button>
                      ) : (
                        <span className={css.entryNameText}>{entry.name}</span>
                      )}
                      {entry.is_repo ? (
                        <span className={css.entryBadge}>
                          repo
                        </span>
                      ) : null}
                      {entry.kind === "dir" ? (
                        <>
                          <button
                            type="button"
                            disabled={rowBusy}
                            onClick={() => onAdd(child)}
                            title={
                              rowBusy
                                ? "Add to catalog — a workspace action is still running."
                                : `Add to catalog — ${addCap.reason}`
                            }
                            className={css.entryAdd}
                          >
                            Add
                            <span className="sr-only">{` add ${entry.name} to the host catalog`}</span>
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy}
                            onClick={() => onStart(child)}
                            title={
                              rowBusy
                                ? "Start Pi — a workspace action is still running."
                                : startCap.reason
                            }
                            className={css.entryStart}
                          >
                            Start Pi
                            <span className="sr-only">{` in ${entry.name}`}</span>
                          </button>
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : (
          <EmptyState
            icon="branch"
            title="没有报告更改"
            detail={tabReason(tab)}
          />
        )}
        </div>
      )}
    </aside>
  );
}

/**
 * One reason string per tab body.
 *
 * Every tab gets an EXPLICIT branch. This used to end in a bare `return` that
 * described the Changes tab, so `automations` fell through into "the host
 * exposes no diff/working-tree API" — a tooltip claiming the surface could not
 * work while the tab right next to it could create, disable, delete and fire
 * scheduled tasks. A fallthrough here is a lie waiting for the next tab to be
 * added, so the Changes text is now attached to Changes by name and the
 * unreachable default is explicit about being a bug rather than a description.
 */
function tabReason(tab: DockTabId): string {
  switch (tab) {
    case "sessions":
      return "该工作区的会话列表，最新的在前。";
    case "files":
      return capability("fs.list").reason;
    case "plugins":
      return "该工作区的 Pi 通过 pi_surface 上报的软件包和技能，可在此启用开关并执行软件包维护操作。";
    case "plan":
      return "打开该工作区 plan/ 目录中的计划文档。由主机读取，停靠栏负责渲染 Markdown。";
    case "changes":
      return "该工作区的工作树状态：相对当前分支，哪些路径已暂存、已修改、未跟踪或存在冲突。";
    case "automations":
      /* The real thing, and deliberately NOT the Changes sentence: these tasks
       * are created, enabled, disabled, deleted and fired from this tab. */
      return "主机按计划运行的提示词 — 可新建、开关、立即运行或删除。";
    case "models":
      /* Names the HOST, because that is the fact a user must not get wrong: this
       * edits the machine's own models.json, not a copy in the workspace. */
      return "该主机的 Pi 从自身的 models.json 加载的模型提供方和模型 — 无需登录机器即可在此编辑。";
    case "settings":
      /* Deliberately NOT the Models sentence: this tab holds real preferences. An
       * earlier version of this code put a models editor behind the "Settings"
       * label, which is the copy-vs-behaviour defect §7 exists to catch. */
      return "本浏览器和该主机的外观与行为 — 本地主题预设、思考块显示、重试策略。";
    default:
      /* Unreachable by type, but a fallthrough here is exactly the defect this
       * function was fixed for, so it fails loudly in dev instead of silently
       * borrowing another tab's description. */
      return `未知的停靠栏标签页：${String(tab)}`;
  }
}
