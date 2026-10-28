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
    ? "Expand the sidebar to reach the workspace filter and the Start and Restart actions."
    : "The sidebar stays collapsed at this width; the workspace filter and the Start and Restart actions need a wider frame.";

  return (
    <aside
      className={css.root}
      style={{ gridTemplateRows: "auto minmax(0,1fr) auto" }}
      aria-label="Workspaces"
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
                  ? "Expand the sidebar (Ctrl/Cmd+B)"
                  : "The sidebar cannot expand at this width"
                : "Collapse the sidebar (Ctrl/Cmd+B)"
            }
            className={
              rail ? css.toggleRail : css.toggleFull
            }
          >
            <Icon name="panel" size={15} />
            <span className="sr-only">
              {rail
                ? `Toggle the sidebar. ${expandHint}`
                : "Toggle the sidebar"}
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
            aria-label="New session"
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
                ? "New session — the host has no command context for this action."
                : newSessionBusy
                  ? "New session — starting…"
                  : "Start a fresh session in this workspace (Ctrl+N)"
            }
            className={css.newSession}
          >
            <Icon name="plus" size={14} />
            <span className={css.newSessionLabel}>New session</span>
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
         * Both surfaces are genuinely absent from the web client, so they render
         * as inert rows that state why rather than pretending to be clickable.
         */}
        {rail ? null : (
          <div className={css.panelList}>
            <button
              type="button"
              disabled
              title="Plugins — the host exposes no plugin surface to the web client yet."
              className={css.panelRow}
            >
              <Icon name="plug" size={16} className={css.panelGlyph} />
              <span className={css.panelTitle}>Plugins</span>
              <span className="sr-only">
                Disabled — the host exposes no plugin surface to the web client yet.
              </span>
            </button>
            <button
              type="button"
              disabled
              title="Automations — the host exposes no automation surface to the web client yet."
              className={css.panelRow}
            >
              <Icon name="clock" size={16} className={css.panelGlyph} />
              <span className={css.panelTitle}>Automations</span>
              <span className="sr-only">
                Disabled — the host exposes no automation surface to the web client yet.
              </span>
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
            <span className={css.sectionTitle}>Workspaces</span>
            <label className={css.searchInline}>
              <Icon name="search" size={13} className={css.searchIcon} />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                aria-label="Filter workspaces"
                placeholder="Filter"
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
                  ? `Refresh — relist the host catalog. ${refreshCap.reason}`
                  : workspacesBusy
                    ? "Refresh — another workspace action is still running."
                    : "Refresh — the catalog is already being listed."
              }
              className={css.refreshSmall}
            >
              <Icon name="refresh" size={12} />
              <span className="sr-only">Refresh the workspace catalog</span>
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
                  ? `Refresh — relist the host catalog. ${refreshCap.reason}`
                  : "Refresh — a workspace action is still running."
              }
              className={css.railButton}
            >
              <Icon name="refresh" size={15} />
              <span className="sr-only">Refresh the workspace catalog</span>
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
                    : "No workspaces reported yet — browse the host filesystem in the dock and start a Pi."
                }
                className={css.railIdle}
              >
                <Icon name="folder" size={15} />
                <span className="sr-only">
                  {needle
                    ? `No workspace matches “${query.trim()}”. Clear the filter to see every workspace this host returned.`
                    : "No workspaces reported yet. Browse the host filesystem in the right dock and start a Pi to create one."}
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
              const { start, restart } = workspaceControls(ws, {
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
                        title={`Start — ${start.reason}`}
                        className={css.startButton}
                      >
                        <Icon name="spark" size={12} />
                        <span className="sr-only">Start {ws.name}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!restart.enabled}
                        onClick={() => onRestart(ws.cwd)}
                        title={`Restart — ${restart.reason}`}
                        className={css.restartButton}
                      >
                        <Icon name="refresh" size={12} />
                        <span className="sr-only">Restart {ws.name}</span>
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
            title="More — no further surfaces are exposed to the web client yet."
            className={css.moreRow}
          >
            <Icon name="more" size={16} className={css.panelGlyph} />
            <span className={css.panelTitle}>More</span>
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
              ? "The right dock is not available at this width (below 760px)."
              : dockOpen
                ? "Hide the right dock (Ctrl/Cmd+J)"
                : "Show the right dock (Ctrl/Cmd+J)"
          }
          className={
            rail ? css.dockButtonRail : css.dockButtonFull
          }
        >
          <Icon name="columns" size={16} />
          {rail ? null : (
            <>
              <span>Right dock</span>
              <kbd className={css.shortcut}>⌘J</kbd>
            </>
          )}
          <span className="sr-only">Toggle the right dock</span>
        </button>

        <button
          type="button"
          disabled
          title="Settings — no settings surface is exposed to the web client yet."
          className={
            rail ? css.settingsButtonRail : css.settingsButtonFull
          }
        >
          <Icon name="settings" size={16} />
          {rail ? null : <span>Settings</span>}
          <span className="sr-only">
            Disabled — no settings surface is exposed to the web client yet.
          </span>
        </button>
      </div>
    </aside>
  );
}
