/* Pure layout geometry for the Remote Pi web shell (wave 1 fix).
 *
 * Source of truth for every frame number: the shell grid, the dock default
 * width and the dock drag handle. The earlier bug was three copies of the same
 * formula drifting apart — the dock was sized once (from `window.innerWidth`
 * at open time) and never re-clamped, so a 648px dock opened at 1440px stayed
 * 648px after the viewport shrank to 1023/760 and overlapped the center
 * column. Consumers now derive from these functions only.
 *
 * Pure: no DOM, no React, no storage. Importable by a plain Node assert script.
 */

export const SIDEBAR_WIDTH = 280;
export const RAIL_WIDTH = 56;
export const DOCK_MIN_WIDTH = 280;
/** The center column keeps at least this much room whenever the frame allows. */
export const CENTER_MIN_WIDTH = 400;
/** Sidebar auto-collapse threshold (prototype styles.css §11). */
export const SIDEBAR_COLLAPSE_WIDTH = 1024;
/** Below this width the dock is not part of the frame at all (prototype §11). */
export const DOCK_HIDE_WIDTH = 760;
/** Dock opens at ~45% of the viewport (approved layout source). */
export const DEFAULT_DOCK_FRACTION = 0.45;
/** Hard ceiling: the dock never takes more than 70% of the viewport. */
export const DOCK_MAX_FRACTION = 0.7;

export interface FrameGeometry {
  /** 0 means "not measured yet" (first paint / SSR placeholder). */
  viewportWidth: number;
  sidebar: number;
  /** Largest width the dock may take; 0 when the dock cannot be shown. */
  dockMax: number;
  /** True only when the viewport is wide enough for a legal dock. */
  dockAvailable: boolean;
}

/** Non-finite or non-positive input collapses to 0 ("unmeasured"). */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Typed sidebar mode owned by the shell. `auto` is the pure width rule;
 * `expanded`/`collapsed` are explicit user overrides written by the toggle.
 * An override never bypasses the frame budget: an `expanded` request that
 * cannot keep CENTER_MIN_WIDTH falls back to the rail instead of squeezing
 * (and so overlapping) the center column.
 */
export type SidebarMode = "auto" | "expanded" | "collapsed";

export interface SidebarLayout {
  mode: SidebarMode;
  /** Column width in px — always SIDEBAR_WIDTH or RAIL_WIDTH. */
  width: number;
  /** True when the column renders the 56px rail (icon-only rows). */
  rail: boolean;
  expanded: boolean;
  /** False when widening to SIDEBAR_WIDTH would starve the center column. */
  expansionAvailable: boolean;
}

/**
 * True only when the frame can host a SIDEBAR_WIDTH column, CENTER_MIN_WIDTH
 * of center, and — when the dock column exists at this width — the collapsed
 * dock rail. Unmeasured viewports report false: nothing to expand into yet.
 */
export function sidebarExpansionAvailable(viewportWidth: number): boolean {
  const width = positive(viewportWidth);
  if (width === 0) return false;
  const reservedDock = width > DOCK_HIDE_WIDTH ? RAIL_WIDTH : 0;
  return width - SIDEBAR_WIDTH - CENTER_MIN_WIDTH >= reservedDock;
}

/**
 * Single source of truth for the sidebar column: the automatic collapse below
 * `SIDEBAR_COLLAPSE_WIDTH` plus the user override. The override can only widen
 * to SIDEBAR_WIDTH while `expansionAvailable` holds, so a narrow frame keeps
 * the rail rather than letting the grid overlap the center column. An
 * unmeasured viewport (0) renders SIDEBAR_WIDTH as the first-paint value, as
 * before.
 */
export function resolveSidebarLayout(viewportWidth: number, mode: SidebarMode): SidebarLayout {
  const width = positive(viewportWidth);
  const expansionAvailable = sidebarExpansionAvailable(width);
  const expanded =
    mode === "expanded"
      ? expansionAvailable
      : mode === "auto"
        ? width === 0 || width >= SIDEBAR_COLLAPSE_WIDTH
        : false;
  return {
    mode,
    width: expanded ? SIDEBAR_WIDTH : RAIL_WIDTH,
    rail: !expanded,
    expanded,
    expansionAvailable,
  };
}

/**
 * Column width of the workspace sidebar. The automatic collapse below
 * `SIDEBAR_COLLAPSE_WIDTH` lives here so the shell and the drag handle agree
 * without either one re-deriving it. Kept as the boolean compatibility entry
 * point while `resolveSidebarLayout` owns the user override.
 */
export function sidebarWidth(viewportWidth: number, rail: boolean): number {
  return resolveSidebarLayout(viewportWidth, rail ? "collapsed" : "auto").width;
}

/**
 * Frame budget for a given viewport and sidebar width.
 * `dockMax` guarantees CENTER_MIN_WIDTH for the center column and caps the
 * dock at DOCK_MAX_FRACTION of the viewport. `dockAvailable` is false below
 * DOCK_HIDE_WIDTH or whenever no width >= DOCK_MIN_WIDTH can satisfy both.
 */
export function frameGeometry(viewportWidth: number, sidebar: number): FrameGeometry {
  const width = positive(viewportWidth);
  const bar = Math.max(0, positive(sidebar));
  if (width === 0) {
    return { viewportWidth: 0, sidebar: bar, dockMax: 0, dockAvailable: false };
  }
  const dockMax = Math.max(
    0,
    Math.min(width * DOCK_MAX_FRACTION, width - bar - CENTER_MIN_WIDTH),
  );
  return {
    viewportWidth: width,
    sidebar: bar,
    dockMax,
    dockAvailable: width > DOCK_HIDE_WIDTH && dockMax >= DOCK_MIN_WIDTH,
  };
}

/**
 * The single clamp used by the default width, the render width and the drag
 * handle: never below DOCK_MIN_WIDTH, never above `dockMax`, never negative.
 * Returns 0 when the dock cannot be shown (caller hides it instead of taking
 * an overlay).
 */
export function clampDockWidth(desired: number, geo: FrameGeometry): number {
  if (!geo.dockAvailable) return 0;
  const wanted = positive(desired);
  return Math.max(DOCK_MIN_WIDTH, Math.min(wanted === 0 ? DOCK_MIN_WIDTH : wanted, geo.dockMax));
}

/** Default dock width on open: ~45% of the viewport, clamped like everything else. */
export function defaultDockWidth(geo: FrameGeometry): number {
  return clampDockWidth(geo.viewportWidth * DEFAULT_DOCK_FRACTION, geo);
}

/**
 * Width of the dock column inside the shell grid. 0 means "no dock column"
 * (closed rail below 760px, or a collapsed dock that only needs RAIL_WIDTH).
 */
export function dockColumnWidth(open: boolean, desired: number, geo: FrameGeometry): number {
  if (!open) return 0;
  return clampDockWidth(desired, geo);
}
