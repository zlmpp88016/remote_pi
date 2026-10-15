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

import type { FsEntry } from "@/lib/remote-pi/protocol";

import {
  RAIL_WIDTH,
  DOCK_MIN_WIDTH as GEOMETRY_DOCK_MIN_WIDTH,
  CENTER_MIN_WIDTH,
  clampDockWidth,
  frameGeometry,
} from "./geometry";
import { Icon } from "./icons";
import { joinRemotePath } from "@/lib/remote-pi/remote-path";
import { EmptyState, ErrorState, Spinner } from "./states";
import { capability, fsControls, fsAvailability, type DockTabId } from "./view-model";

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

const TABS: readonly { id: DockTabId; label: string; icon: "book" | "folder" | "branch" }[] = [
  { id: "plan", label: "Plan", icon: "book" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "changes", label: "Changes", icon: "branch" },
];

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
  onStart,
  onAdd,
  showHidden,
  onShowHiddenChange,
  fsAvailable,
  fsAvailableReason,
  busy,
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
        className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-white/10 bg-[rgba(255,255,255,0.02)]"
        aria-label="Dock (collapsed)"
      >
        <div className="flex h-12 min-w-0 items-center justify-center border-b border-white/10">
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Show the right dock"
            className="grid size-6 place-items-center rounded-md text-[#6b6b6b] transition hover:bg-white/10 hover:text-white"
          >
            <Icon name="chevR" size={15} className="rotate-180" />
            <span className="sr-only">Show the right dock</span>
          </button>
        </div>
        {/* Rail body: icons only (the label lives in `title` + `sr-only`).
            No list text here — the rail is 56px wide and stacked words used to
            wrap into a one-character column. */}
        <div className="grid content-start justify-items-center gap-2 pt-2">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                onTabChange(entry.id);
                onToggleCollapse();
              }}
              title={entry.label}
              className="grid size-7 shrink-0 place-items-center rounded-md text-[#6b6b6b] transition hover:bg-white/10 hover:text-white"
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
      className="relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-white/10 bg-[rgba(255,255,255,0.02)]"
      style={{ width }}
      aria-label="Dock"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the dock"
        title="Drag, or focus and use Left/Right (Shift for larger steps, Home/End for min/max)"
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
        className={`absolute -left-1 top-0 bottom-0 z-[7] w-[7px] cursor-col-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4fc3f7] ${
          dragging ? "bg-[#4fc3f7]/60" : "hover:bg-[#4fc3f7]/40"
        }`}
      />

      <div className="flex h-12 items-center gap-1.5 border-b border-white/10 pl-3 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onTabChange(entry.id)}
              aria-current={tab === entry.id ? "true" : undefined}
              title={`${entry.label} — ${tabReason(entry.id)}`}
              className={
                tab === entry.id
                  ? "inline-flex h-7 max-w-[150px] items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-[12.5px] text-white"
                  : "inline-flex h-7 max-w-[150px] items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-[#6b6b6b] transition hover:bg-white/[0.06] hover:text-[#d4d4d4]"
              }
            >
              <Icon name={entry.icon} size={14} />
              <span className="truncate">{entry.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Collapse the dock (Ctrl/Cmd+J)"
          className="grid size-6 shrink-0 place-items-center rounded-md text-[#6b6b6b] transition hover:bg-white/10 hover:text-white"
        >
          <Icon name="x" size={15} />
          <span className="sr-only">Collapse the dock</span>
        </button>
      </div>

      <div className="min-h-0 overflow-auto p-3">
        {tab === "files" ? (
          <div className="grid gap-2.5">
            <div className="flex gap-1.5">
              <input
                value={fsPath}
                onChange={(event) => onFsPathChange(event.target.value)}
                aria-label="Remote directory path to list"
                title="Remote directory path to list"
                placeholder="~/projects"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-[10px] border border-white/15 bg-white/[0.045] px-2.5 py-1.5 font-mono text-[12.5px] text-white outline-none transition placeholder:text-[#8f8f8f] focus:border-[#4fc3f7]"
              />
              <button
                type="button"
                disabled={fsLoading || !fs.available}
                onClick={() => onList(fsPath)}
                title={fs.available ? filesCap.reason : fs.reason}
                className="inline-flex h-[30px] shrink-0 items-center rounded-[10px] bg-[#4fc3f7] px-3 text-[12.5px] font-semibold text-[#04222e] transition hover:bg-[#7ad4fa] disabled:cursor-not-allowed disabled:opacity-45"
              >
                List
              </button>
            </div>

            {/* Both wave-3 controls stay rendered and INERT with a fixed
                reason when unavailable: a control that vanishes cannot explain
                itself, and disabling here is what keeps “Add to catalog” from
                ever sending a path the host did not canonicalize. */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!controls.add.enabled}
                onClick={() => onAdd(fsPath)}
                title={`Add to catalog — ${controls.add.reason} ${addCap.reason}`}
                className="inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-white/15 bg-white/[0.045] px-2 text-[12px] font-medium text-[#d4d4d4] transition enabled:hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:text-[#6b6b6b]"
              >
                <Icon name="plus" size={13} />
                Add to catalog
                <span className="sr-only">Add the current directory to the host catalog</span>
              </button>
              <button
                type="button"
                disabled={!controls.start.enabled}
                onClick={() => onStart(fsPath)}
                title={`Start Pi here — ${controls.start.reason}`}
                className="inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-[#4fc3f7] px-2 text-[12px] font-semibold text-[#04222e] transition enabled:hover:bg-[#7ad4fa] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Icon name="spark" size={13} />
                Start Pi here
                <span className="sr-only">Start a Pi in the current directory</span>
              </button>
            </div>

            <label
              className={`flex items-center gap-2 rounded-md px-1 py-0.5 text-[11.5px] ${fs.available ? "text-[#a3a3a3]" : "text-[#9a9a9a]"}`}
              title={
                fs.available
                  ? "Ask the host to include dotfiles and hidden entries in the listing."
                  : fs.reason
              }
            >
              <input
                type="checkbox"
                checked={showHidden}
                disabled={!fs.available}
                onChange={(event) => onShowHiddenChange(event.target.checked)}
                className="size-3.5 shrink-0 accent-[#4fc3f7] disabled:cursor-not-allowed"
              />
              <span>Show hidden entries</span>
            </label>

            <div className="flex items-center gap-2 font-mono text-[11px] text-[#9a9a9a]">
              <span className="min-w-0 flex-1 truncate" title={fsPath}>
                {parent ?? "root"}
              </span>
              {parent ? (
                <button
                  type="button"
                  disabled={!fs.available || fsLoading}
                  onClick={() => onList(parent)}
                  className="inline-flex items-center gap-1 text-[#4fc3f7] transition enabled:hover:text-[#7ad4fa] disabled:cursor-not-allowed disabled:text-[#6b6b6b]"
                >
                  <Icon name="chevR" size={12} className="rotate-180" />
                  up one level
                </button>
              ) : null}
            </div>

            {!fs.available ? (
              <p className="text-[11.5px] leading-relaxed text-[#9a9a9a]">{fs.reason}</p>
            ) : null}

            {fsLoading ? (
              <div className="flex items-center gap-2 py-2">
                <Spinner />
                <span className="text-[12.5px] text-[#9a9a9a]">Listing…</span>
              </div>
            ) : null}

            {fsError ? <ErrorState title="Filesystem list failed" detail={fsError} /> : null}

            {!fsLoading && !fsError && fsEntries.length === 0 ? (
              <EmptyState
                compact
                title={fsLoaded ? "This directory is empty." : "Nothing listed yet."}
                detail={
                  filesCap.status === "ready"
                    ? "Enter a path above (for example ~/projects) and press List. Directories can be opened or started as a Pi workspace."
                    : filesCap.reason
                }
              />
            ) : null}

            {fsEntries.length > 0 ? (
              <ul className="grid gap-0.5">
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
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[12.2px] text-[#a3a3a3] transition hover:bg-white/[0.06]"
                    >
                      <Icon
                        name={entry.kind === "dir" ? "folder" : "file"}
                        size={13}
                        className={entry.kind === "dir" ? "text-[#4fc3f7]" : "text-[#6b6b6b]"}
                      />
                      {entry.kind === "dir" ? (
                        <button
                          type="button"
                          disabled={!fs.available || fsLoading}
                          onClick={() => {
                            onFsPathChange(child);
                            onList(child);
                          }}
                          className="min-w-0 flex-1 truncate text-left text-[#d4d4d4] transition enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[#6b6b6b]"
                        >
                          {entry.name}/
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      )}
                      {entry.is_repo ? (
                        <span className="shrink-0 rounded border border-white/10 px-1 text-[10px] text-[#6b6b6b]">
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
                            className="shrink-0 rounded-md border border-white/15 px-2 py-0.5 text-[11px] font-medium text-[#d4d4d4] transition enabled:hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:text-[#6b6b6b]"
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
                            className="shrink-0 rounded-md bg-[#4fc3f7] px-2 py-0.5 text-[11px] font-semibold text-[#04222e] transition enabled:hover:bg-[#7ad4fa] disabled:cursor-not-allowed disabled:opacity-45"
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
            icon={tab === "plan" ? "book" : "branch"}
            title={tab === "plan" ? "No plan document yet" : "No changes reported"}
            detail={tabReason(tab)}
          />
        )}
      </div>
    </aside>
  );
}

/** One reason string per tab body, sourced from the capability spine. */
function tabReason(tab: DockTabId): string {
  if (tab === "files") return capability("fs.list").reason;
  if (tab === "plan") {
    return "The host protocol exposes no plan/document API, so the dock cannot read one. Declared here so the surface is not silently missing.";
  }
  return "The host protocol exposes no diff/working-tree API, so there is nothing to report. Declared here so the surface is not silently missing.";
}
