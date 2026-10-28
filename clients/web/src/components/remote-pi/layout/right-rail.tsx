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

const TABS: readonly { id: DockTabId; label: string; icon: "book" | "folder" | "branch" | "msg" }[] = [
  { id: "sessions", label: "Sessions", icon: "msg" },
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
  onStart,
  onAdd,
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
        aria-label="Dock (collapsed)"
      >
        <div className={css.collapsedHead}>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Show the right dock"
            className={css.iconButton}
          >
            <Icon name="chevR" size={15} className={css.iconFlipped} />
            <span className="sr-only">Show the right dock</span>
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
          title="Collapse the dock (Ctrl/Cmd+J)"
          className={css.collapseButton}
        >
          <Icon name="x" size={15} />
          <span className="sr-only">Collapse the dock</span>
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
      ) : (
        <div className={css.panel}>
          {tab === "files" ? (
          <div className={css.panelStack}>
            <div className={css.row}>
              <input
                value={fsPath}
                onChange={(event) => onFsPathChange(event.target.value)}
                aria-label="Remote directory path to list"
                title="Remote directory path to list"
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
                List
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
                title={`Add to catalog — ${controls.add.reason} ${addCap.reason}`}
                className={css.secondaryButton}
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
                className={css.accentButton}
              >
                <Icon name="spark" size={13} />
                Start Pi here
                <span className="sr-only">Start a Pi in the current directory</span>
              </button>
            </div>

            <label
              className={`${css.checkboxRow} ${fs.available ? css.checkboxAvailable : css.checkboxUnavailable}`}
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
                className={css.checkbox}
              />
              <span>Show hidden entries</span>
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
                <span className={css.loadingText}>Listing…</span>
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
            icon={tab === "plan" ? "book" : "branch"}
            title={tab === "plan" ? "No plan document yet" : "No changes reported"}
            detail={tabReason(tab)}
          />
        )}
        </div>
      )}
    </aside>
  );
}

/** One reason string per tab body, sourced from the capability spine. */
function tabReason(tab: DockTabId): string {
  if (tab === "sessions") return "This workspace's AgentSessions, newest first.";
  if (tab === "files") return capability("fs.list").reason;
  if (tab === "plan") {
    return "The host protocol exposes no plan/document API, so the dock cannot read one. Declared here so the surface is not silently missing.";
  }
  return "The host protocol exposes no diff/working-tree API, so there is nothing to report. Declared here so the surface is not silently missing.";
}
