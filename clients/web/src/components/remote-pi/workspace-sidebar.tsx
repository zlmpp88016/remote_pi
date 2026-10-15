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
import type { WireSessionInfo } from "@/lib/remote-pi/sessions";

import { Icon, RemotePiMark } from "./icons";
import { SessionList } from "./session-list";
import { EmptyState, Spinner } from "./states";
import { capability, workspaceControls, workspaceNote, workspaceStatus, type WorkspaceTone } from "./view-model";

/** Row tone → text colour. One map so the icon and the label never disagree. */
const TONE_TEXT: Readonly<Record<WorkspaceTone, string>> = {
  running: "text-[#5fd38a]",
  starting: "text-[#4fc3f7]",
  crashed: "text-[#f25a5a]",
  stopped: "text-[#6b6b6b]",
  not_running: "text-[#6b6b6b]",
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

  // ── sessions (plan/67 list/switch, plan/71 read-only read) ────────────────
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
  /** SWITCHES the live session — the only state-changing session control. */
  onSessionSwitch: (id: string) => void;
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
  host,
  dockOpen,
  dockAvailable,
  onToggleDock,
  sessions,
  sessionsBusy,
  sessionsDisabledReason,
  sessionViewingId,
  sessionLiveId,
  sessionsNotice,
  onSessionsRefresh,
  onSessionRead,
  onSessionSwitch,
  now,
}: WorkspaceSidebarProps) {
  const palette = capability("palette");
  const refreshCap = capability("workspace.list");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? workspaces.filter(
        (ws) =>
          ws.name.toLowerCase().includes(needle) || ws.cwd.toLowerCase().includes(needle),
      )
    : workspaces;
  const refreshEnabled = !workspacesBusy && !workspacesLoading;
  /* Rail-only guidance: the 56px column hides the filter, Start/Restart and
     the row names, so screen readers need to be told where they went. */
  const expandHint = expansionAvailable
    ? "Expand the sidebar to reach the workspace filter and the Start and Restart actions."
    : "The sidebar stays collapsed at this width; the workspace filter and the Start and Restart actions need a wider frame.";

  return (
    <aside
      className="grid min-h-0 min-w-0 border-r border-white/10 bg-[rgba(255,255,255,0.02)]"
      style={{ gridTemplateRows: "auto minmax(0,1fr) auto" }}
      aria-label="Workspaces"
    >
      {/* ── head ─────────────────────────────────────────────────────────── */}
      <div className={rail ? "grid gap-2.5 px-2 py-2.5" : "grid gap-2.5 px-3 pb-2 pt-3"}>
        <div className={rail ? "flex justify-center" : "flex items-center gap-2.5 px-0.5"}>
          <span className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-[rgba(79,195,247,0.3)] bg-[rgba(79,195,247,0.13)] text-[#4fc3f7]">
            <RemotePiMark size={14} />
          </span>
          {rail ? null : (
            <>
              <span
                className="text-[14px] font-semibold tracking-[-0.01em] text-white"
                style={{ fontFamily: "var(--ff-display)" }}
              >
                Remote Pi
              </span>
              {host.daemonVersion ? (
                <span className="rounded border border-white/10 bg-white/[0.045] px-1.5 py-px font-mono text-[10px] text-[#6b6b6b]">
                  {host.daemonVersion}
                </span>
              ) : null}
              <span className="flex-1" />
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
              rail
                ? "grid size-6 place-items-center rounded-md text-[#6b6b6b] transition hover:bg-white/10 hover:text-white"
                : "ml-auto grid size-6 place-items-center rounded-md text-[#6b6b6b] transition hover:bg-white/10 hover:text-white"
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

        {/* Sessions of the ACTIVE workspace. Replaces the old disabled
            placeholder: the list is real and the two actions are distinct
            (read is read-only; switch changes the live session). */}
        {rail ? null : (
          <div className="pb-1">
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
              onSwitch={onSessionSwitch}
              rail={rail}
            />
          </div>
        )}

        {rail ? null : (
          <label className="flex h-8 items-center gap-2 rounded-[10px] border border-white/10 bg-white/[0.045] px-2.5 transition focus-within:border-[#4fc3f7]">
            <Icon name="search" size={15} className="shrink-0 text-[#6b6b6b]" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              aria-label="Filter workspaces"
              placeholder="Filter workspaces"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-[#6b6b6b]"
            />
          </label>
        )}
      </div>

      {/* ── workspace list ────────────────────────────────────────────────── */}
      <div className="min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-3.5">
        {rail ? null : (
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#6b6b6b]">
            <span className="flex-1">Workspaces</span>
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
              className="inline-flex items-center gap-1 rounded-md px-1 py-px normal-case tracking-normal transition enabled:hover:bg-white/10 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[#4a4a4a]"
            >
              <Icon name="refresh" size={12} />
              <span className="sr-only">Refresh the workspace catalog</span>
            </button>
            <span>{visible.length}</span>
          </div>
        )}

        {rail ? (
          <div className="grid justify-items-center gap-2 px-1 py-2.5">
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
              className="grid size-7 place-items-center rounded-md text-[#6b6b6b] transition enabled:hover:bg-white/10 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[#4a4a4a]"
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
                className="grid size-7 place-items-center rounded-md border border-[rgba(242,90,90,0.35)] text-[#f25a5a]"
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
                className="grid size-7 place-items-center rounded-md text-[#6b6b6b]"
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
          <div className="px-2 py-3">
            <Spinner />
          </div>
        ) : workspacesError ? (
          <p className="px-2 py-3 text-[12.5px] leading-relaxed text-[#f25a5a]">{workspacesError}</p>
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
          <ul className="grid gap-px">
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
                        current
                          ? "grid size-9 w-full place-items-center rounded-md border border-white/10 bg-white/10 text-white"
                          : "grid size-9 w-full place-items-center rounded-md border border-transparent text-[#a3a3a3] transition hover:bg-white/[0.06] hover:text-white"
                      }
                    >
                      <Icon name="folder" size={15} />
                      <span className="sr-only">{`${ws.name} — ${ws.cwd} (${status.label}). ${status.detail}${note ? ` ${note}` : ""}`}</span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={`${ws.daemon_id}:${ws.room_id}`} className="grid gap-0.5">
                  <div
                    className={
                      current
                        ? "relative flex min-h-[34px] w-full items-center gap-2 rounded-md border border-white/10 bg-white/10 px-2 py-1"
                        : "relative flex min-h-[34px] w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 transition hover:bg-white/[0.06]"
                    }
                  >
                    {current ? (
                      <span className="absolute -left-1.5 top-2 bottom-2 w-0.5 rounded-full bg-[#4fc3f7]" />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onOpenWorkspace(ws.room_id)}
                      aria-current={current ? "true" : undefined}
                      title={`${ws.name} — ${ws.cwd} · ${status.label}`}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className={`grid size-3.5 shrink-0 place-items-center ${TONE_TEXT[status.tone]}`}
                      >
                        <Icon name="folder" size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate font-mono text-[12.5px] ${current ? "text-white" : "text-[#d4d4d4]"}`}
                        >
                          {ws.name}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[10.5px] ${TONE_TEXT[status.tone]}`}
                      >
                        {status.label}
                      </span>
                    </button>

                    {/* Always-rendered action pair: an inert button states its
                        fixed reason instead of disappearing, so the surface
                        never implies a control that does not exist. */}
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        disabled={!start.enabled}
                        onClick={() => onStart(ws.cwd)}
                        title={`Start — ${start.reason}`}
                        className="grid size-5 place-items-center rounded text-[#5fd38a] transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[#4a4a4a]"
                      >
                        <Icon name="spark" size={12} />
                        <span className="sr-only">Start {ws.name}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!restart.enabled}
                        onClick={() => onRestart(ws.cwd)}
                        title={`Restart — ${restart.reason}`}
                        className="grid size-5 place-items-center rounded text-[#f2b45a] transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[#4a4a4a]"
                      >
                        <Icon name="refresh" size={12} />
                        <span className="sr-only">Restart {ws.name}</span>
                      </button>
                    </span>
                  </div>

                  {note ? (
                    <p className="flex items-start gap-1 px-2 pb-0.5 text-[10.5px] leading-snug text-[#f2b45a]">
                      <Icon name="alert" size={11} className="mt-px shrink-0" />
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
          <p className="px-2 pt-3 text-[11.5px] leading-relaxed text-[#6b6b6b]">
            {palette.reason}
          </p>
        )}
      </div>

      {/* ── footer ───────────────────────────────────────────────────────── */}
      <div className="grid gap-0.5 border-t border-white/10 p-2">
        <div
          className={
            rail
              ? "grid justify-items-center py-1.5"
              : "flex min-w-0 items-center gap-2.5 rounded-[10px] px-2 py-1.5"
          }
          title={host.hostname}
        >
          <span className="size-2 shrink-0 rounded-full bg-[#5fd38a] ring-4 ring-[rgba(95,211,138,0.16)]" />
          {rail ? null : (
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] text-white">{host.hostname}</span>
              <span className="block truncate font-mono text-[10.5px] text-[#6b6b6b]">
                {host.relayUrl} · host room
              </span>
              {host.capabilities && host.capabilities.length > 0 ? (
                <span
                  className="block truncate font-mono text-[10.5px] text-[#6b6b6b]"
                  title={host.capabilities.join(", ")}
                >
                  {host.capabilities.join(" · ")}
                </span>
              ) : null}
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
            rail
              ? "grid w-full justify-items-center rounded-[10px] py-1.5 text-[#a3a3a3] transition enabled:hover:bg-white/[0.06] enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[#6b6b6b]"
              : "flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13px] text-[#a3a3a3] transition enabled:hover:bg-white/[0.06] enabled:hover:text-white disabled:cursor-not-allowed disabled:text-[#6b6b6b]"
          }
        >
          <Icon name="columns" size={16} />
          {rail ? null : (
            <>
              <span>Right dock</span>
              <kbd className="ml-auto font-mono text-[10.5px] text-[#6b6b6b]">⌘J</kbd>
            </>
          )}
          <span className="sr-only">Toggle the right dock</span>
        </button>

        <button
          type="button"
          disabled
          title="Settings — no settings surface is exposed to the web client yet."
          className={
            rail
              ? "grid w-full justify-items-center rounded-[10px] py-1.5 text-[#6b6b6b] disabled:cursor-not-allowed"
              : "flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13px] text-[#6b6b6b] disabled:cursor-not-allowed"
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
