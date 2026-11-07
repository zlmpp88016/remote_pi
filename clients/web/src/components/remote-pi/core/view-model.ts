/* Typed view-model for the Remote Pi web shell (waves 1 + 3).
 *
 * This file owns TWO things and nothing else:
 *   1. the capability spine — one place where every product surface states
 *      whether it is wired, and why not if it is not;
 *   2. the prop and row types the shell components accept, plus the PURE
 *      derivation from adapter/protocol data to what a control may say.
 *
 * It deliberately does NOT own wire shapes: those stay in
 * `src/lib/remote-pi/protocol.ts`, sourced from PROTOCOL.md; the adapter's
 * public projection (`WorkspaceChildState`) is only re-exported. Nothing here
 * mints protocol contracts, reads a file, or performs a network call — the
 * helpers below are total functions over already-received data.
 */
import type { WorkspaceChildState } from "@/lib/remote-pi/adapter";
import type { FsEntry, WorkspaceEntry } from "@/lib/remote-pi/protocol";

// ── capability spine ────────────────────────────────────────────────────────

/**
 * `ready`       — wired to the current implementation and usable now.
 * `disabled`    — the surface exists visually but is intentionally inert
 *                 (no wire, no local state machine). Wave 1 renders these
 *                 collapsed and inert instead of faking the feature.
 * `unavailable` — the host/relay cannot answer this today; shown with the
 *                 reason so the gap is disclosed rather than hidden.
 * `planned`     — assigned to a later wave of the approved plan.
 */
export type CapabilityStatus = "ready" | "disabled" | "unavailable" | "planned";

export interface Capability {
  id: string;
  label: string;
  status: CapabilityStatus;
  /** Human-readable reason — mandatory for anything not `ready`. */
  reason: string;
  /** Wave of the approved plan that owns the follow-up, when applicable. */
  wave?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "pair",
    label: "Pair with a host",
    status: "ready",
    reason: "pair_request on the host room (PROTOCOL.md).",
  },
  {
    id: "host_hello",
    label: "Host hello",
    status: "ready",
    reason: "host_hello → host_hello_ok (plan 69).",
  },
  {
    id: "workspace.list",
    label: "Workspace list",
    status: "ready",
    reason: "workspace_list → workspace_list_ok (plan 67).",
  },
  {
    id: "fs.list",
    label: "Browse the host filesystem",
    status: "ready",
    reason: "fs_list; the host resolves and lists, the client never touches a path.",
  },
  {
    id: "workspace.start",
    label: "Start a Pi in a workspace",
    status: "ready",
    reason: "workspace_start → workspace_start_ok (plan 67/68).",
  },
  {
    id: "workspace.state",
    label: "Workspace lifecycle status",
    status: "ready",
    reason:
      "Unsolicited `workspace_state {cwd, state, last_error, restarts}` pushes (plan 69), projected by the adapter into state/live/hasError/restarts. A row with no observed push keeps the catalog's list-time `live` and says “not running” — never a fabricated crash or stop.",
  },
  {
    id: "workspace.restart",
    label: "Restart a workspace",
    status: "ready",
    reason:
      "workspace_restart {cwd} → workspace_restart_ok | workspace_restart_error (plan 68). Offered only for a lifecycle the host reported as crashed/stopped.",
  },
  {
    id: "workspace.add",
    label: "Add a folder to the catalog",
    status: "ready",
    reason:
      "workspace_add → action_ok | action_error (plan 68). The host answers with no cwd echo, so the new row appears only after the host-driven relist.",
  },
  {
    id: "chat.send",
    label: "Send a chat message",
    status: "ready",
    reason: "host_forward on the host room; replies arrive as host_message (plan 69, decision B).",
  },
  {
    id: "chat.state",
    label: "Chat turn state machine",
    status: "ready",
    reason:
      "Wired to the Wave 4 typed reducer (src/lib/remote-pi/chat.ts): single-flight submit (`canSubmit` locks the composer while a turn is open), an optimistic LOCAL ECHO for the user's own bubble (drawn from the draft before any round trip) with the agent item echo-gated until the host confirms the turn, and terminal error/timed_out/disconnected recovery. Streamed deltas are coalesced to one React commit per animation frame. Retry is explicit and one-shot (`retryRisk` is stated next to the Retry control); there is no automatic resend.",
  },
  {
    id: "trajectory",
    label: "Trajectory",
    status: "disabled",
    reason:
      "Requires per-event records (sequence, timing, state) that the host does not expose today. Listed so the gap is explicit, not silently dropped.",
    wave: "Wave 4",
  },
  {
    id: "approval",
    label: "Tool approval",
    status: "disabled",
    reason: "ToolRequest is dormant in the current protocol and is not revived by the web client.",
  },
  {
    id: "model",
    label: "Model and thinking controls",
    status: "ready",
    /*
     * These `reason` strings are user-visible (control titles) and go into
     * accessible descriptions, so they describe BEHAVIOUR, not the wire. The
     * protocol shape (`list_models` -> `models_list`, `model_set`,
     * `thinking_set`) is deliberately not repeated here: it used to be, and it
     * read as developer notes pasted into the product.
     */
    reason:
      "Choose the model and thinking depth for this workspace. The list comes from the host's Pi, and the thinking control appears only for models that support it.",
  },
  {
    id: "tools",
    label: "Tool cards",
    status: "ready",
    reason:
      "Tool calls and their results appear as plain text in the transcript; an error is flagged without echoing its message.",
  },
  {
    id: "upload",
    label: "Attachments",
    status: "ready",
    reason:
      "Attach one image per message. It is downscaled before sending, and only models that accept images offer it.",
  },
  {
    id: "sessions",
    label: "Session list",
    status: "ready",
    reason:
      "List this workspace's sessions and read one's transcript without touching the live session. Switching is a separate, explicit control because it changes state for every paired client.",
  },
  {
    id: "hosts",
    label: "Multiple hosts",
    status: "disabled",
    reason: "One host per connection by design (host-first). Multi-host is out of scope for the web client.",
  },
  {
    id: "palette",
    label: "Slash commands",
    status: "ready",
    /*
     * User-facing copy only.
     *
     * This string is rendered into the composer's accessible description, so it
     * must read as a hint to a person: the previous text walked through the wire
     * call sequence (`pi_surface` -> `pi_surface_ok`, `skill_invoke`) and named
     * internal mechanisms, which is developer prose leaking into the product.
     * The protocol detail stays in the implementation, where it belongs.
     */
    reason: "Type / in the message box to run one of this workspace's installed skills.",
  },
];

const BY_ID: ReadonlyMap<string, Capability> = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function capability(id: string): Capability {
  const found = BY_ID.get(id);
  if (!found) {
    // A missing entry must not silently look "ready".
    return {
      id,
      label: id,
      status: "unavailable",
      reason: "No capability entry declares this surface.",
    };
  }
  return found;
}

// ── connection phase ────────────────────────────────────────────────────────

/**
 * The subset of phases the wave 1 shell actually renders. Wave 2 owns the full
 * state machine (disabled/idle/pairing/relay_authenticating/
 * host_authenticating/connected/reconnecting/reauth_required/closing/closed/
 * error); mapping richer phases into these two views happens there, not here.
 */
export type ShellView = "launcher" | "host";

// ── shell view model ────────────────────────────────────────────────────────

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string; done: boolean };

export type DockTabId = "plan" | "files" | "changes" | "sessions" | "plugins" | "automations" | "models" | "settings";

// ── workspace lifecycle (wave 3) ───────────────────────────────────────────

/** The closed lifecycle vocabulary the host pushes (`WorkspaceState`), reused
 *  so a caller never spells it out and never invents a fifth value. */
export type WorkspaceLifecycle = WorkspaceChildState["state"];

/**
 * Rendering tone for a workspace row. `not_running` is deliberately NOT
 * `stopped`: it is what a row shows when the host has NOT pushed a lifecycle
 * state and the catalog merely omitted `live`. Saying "stopped" there would
 * claim a report nobody made.
 */
export type WorkspaceTone =
  | "running"
  | "starting"
  | "crashed"
  | "stopped"
  | "not_running";

export interface WorkspaceStatusText {
  tone: WorkspaceTone;
  /** Short row label ("running", "not running", …). */
  label: string;
  /** Fixed, client-authored sentence — never host text. */
  detail: string;
  /** True when an observed `workspace_state` push supplied the label. */
  observed: boolean;
  /** Report count from the observed push, else 0. */
  restarts: number;
  /** The observed push carried a non-null `last_error` (text is never kept). */
  hasError: boolean;
}

const RUNNING_DETAIL = "主机报告该工作区的 Pi 正在运行。";
const STARTING_DETAIL =
  "主机报告该工作区正在启动，生命周期尚未落定。";
const CRASHED_DETAIL =
  "主机报告该工作区已崩溃。崩溃的工作区会提供重启操作。";
const STOPPED_DETAIL = "主机报告该工作区的 Pi 已停止。";
const NOT_RUNNING_DETAIL =
  "目录未将该工作区列为在线，也未观察到生命周期推送 — 这并不代表它已停止。";

/**
 * Row status for a catalog entry, observed push first and catalog `live`
 * second. Total: a missing/thin push never produces a crash or a stop claim.
 */
export function workspaceStatus(
  entry: Pick<WorkspaceEntry, "live">,
  state?: WorkspaceChildState | null,
): WorkspaceStatusText {
  const restarts = state?.restarts ?? 0;
  const hasError = state?.hasError ?? false;
  switch (state?.state) {
    case "running":
      return { tone: "running", label: "运行中", detail: RUNNING_DETAIL, observed: true, restarts, hasError };
    case "starting":
      return { tone: "starting", label: "启动中", detail: STARTING_DETAIL, observed: true, restarts, hasError };
    case "crashed":
      return { tone: "crashed", label: "已崩溃", detail: CRASHED_DETAIL, observed: true, restarts, hasError };
    case "stopped":
      return { tone: "stopped", label: "已停止", detail: STOPPED_DETAIL, observed: true, restarts, hasError };
    default:
      return entry.live
        ? { tone: "running", label: "运行中", detail: "The catalog listed this workspace as live; no lifecycle push has been observed since.", observed: false, restarts, hasError }
        : { tone: "not_running", label: "未运行", detail: NOT_RUNNING_DETAIL, observed: false, restarts, hasError };
  }
}

/** ONE control's state: whether it may be pressed, and the fixed reason why. */
export interface ControlState {
  enabled: boolean;
  /** Fixed client-authored text — always set, used as `title`/`sr-only`. */
  reason: string;
}

export interface WorkspaceControlInput {
  /** Any workspace action (start/restart/list/add) is in flight. */
  busy: boolean;
  /** The observed lifecycle, or null/undefined when nothing was pushed. */
  state?: WorkspaceChildState | null;
}

const BUSY_REASON = "另一个工作区操作仍在进行。";
const ALREADY_RUNNING = "主机报告该工作区已在运行。";
const STARTING_REASON = "该工作区正在启动；等待主机报告其生命周期。";
const USE_RESTART = "主机报告该工作区已崩溃或已停止 — 请使用重启。";
const START_WHEN_NOT_RUNNING = "启动该工作区：目录未将其列为在线。";
const STOP_WHEN_RUNNING = "请求主机关闭该工作区的 Pi。";
const STOP_NOT_RUNNING = "该工作区没有可停止的 Pi 进程。";

/**
 * Start/Restart/Stop for one catalog row.
 *
 *   • `running`             → Stop only. Restart is ALSO offered: the server
 *                             documents it as idempotent ("an already-running
 *                             workspace answers `workspace_restart_ok` without
 *                             respawning", protocol/types.ts:259), so it is the
 *                             recovery path for a workspace that is running but
 *                             wedged. Withholding it left a stuck workspace with
 *                             no way out from the web client.
 *   • `crashed` / `stopped` → Restart (the documented revive path).
 *   • `starting`            → Stop only, until the host settles the lifecycle.
 *   • no push + live=false  → Start ("not running").
 *   • no push + live=true   → treated exactly as running.
 *
 * An unknown lifecycle never enables Restart on its own: the host has not said
 * the child crashed, so claiming it needs revival would be a guess.
 */
export function workspaceControls(
  entry: Pick<WorkspaceEntry, "live">,
  { busy, state }: WorkspaceControlInput,
): { start: ControlState; restart: ControlState; stop: ControlState } {
  if (busy) {
    return {
      start: { enabled: false, reason: BUSY_REASON },
      restart: { enabled: false, reason: BUSY_REASON },
      stop: { enabled: false, reason: BUSY_REASON },
    };
  }
  switch (state?.state) {
    case "running":
      return {
        start: { enabled: false, reason: ALREADY_RUNNING },
        restart: { enabled: true, reason: "Ask the host to restart this workspace." },
        stop: { enabled: true, reason: STOP_WHEN_RUNNING },
      };
    case "starting":
      return {
        start: { enabled: false, reason: STARTING_REASON },
        restart: { enabled: false, reason: STARTING_REASON },
        /* A process exists while it starts; stopping it is the sane abort. */
        stop: { enabled: true, reason: STOP_WHEN_RUNNING },
      };
    case "crashed":
    case "stopped":
      return {
        start: { enabled: false, reason: USE_RESTART },
        restart: { enabled: true, reason: "Ask the host to restart this workspace." },
        stop: { enabled: false, reason: STOP_NOT_RUNNING },
      };
    default:
      return entry.live
        ? {
            start: { enabled: false, reason: ALREADY_RUNNING },
            restart: { enabled: true, reason: "Ask the host to restart this workspace." },
            stop: { enabled: true, reason: STOP_WHEN_RUNNING },
          }
        : {
            start: { enabled: true, reason: START_WHEN_NOT_RUNNING },
            restart: { enabled: false, reason: STOP_NOT_RUNNING },
            stop: { enabled: false, reason: STOP_NOT_RUNNING },
          };
  }
}

/** Fixed, client-authored note for a status, or null when there is nothing to
 *  say. The host's raw `last_error` text is NEVER part of it: `hasError` is
 *  the only thing the adapter exposes, so the note states THAT an error was
 *  reported instead of echoing host paths.
 */
export function workspaceNote(status: WorkspaceStatusText): string | null {
  const parts: string[] = [];
  if (status.hasError) parts.push("The host reported an error for this workspace.");
  if (status.restarts > 0) {
    parts.push(
      `The host's supervisor restarted this workspace ${status.restarts} ${status.restarts === 1 ? "time" : "times"}.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Availability of the host's `fs_nav` surface, from `host_hello_ok`.
 *  `reason` is mandatory whenever `available` is false. */
export interface FsAvailability {
  available: boolean;
  reason: string;
}

const NO_FS_NAV =
  "This host did not advertise the fs_nav capability, so the web client has no directory listing.";

export function fsAvailability(
  fsAvailable: boolean,
  reason?: string | null,
): FsAvailability {
  if (fsAvailable) {
    return { available: true, reason: reason ?? "The host advertised fs_nav; the dock can list directories." };
  }
  return { available: false, reason: reason ?? NO_FS_NAV };
}

export interface FsControlInput extends FsAvailability {
  busy: boolean;
  /** An `fs_list` for the current directory is in flight. */
  fsLoading: boolean;
  /** A directory has been listed, so the current path is host-canonical. */
  fsLoaded: boolean;
}

/** Add/Start for the CURRENT directory. Both need a host-canonical path, so
 *  neither is offered before a successful list, while listing, while another
 *  action runs, or without `fs_nav`. */
export function fsControls({
  available,
  reason,
  busy,
  fsLoading,
  fsLoaded,
}: FsControlInput): { add: ControlState; start: ControlState; remove: ControlState } {
  if (!available) {
    return {
      add: { enabled: false, reason },
      start: { enabled: false, reason },
      remove: { enabled: false, reason },
    };
  }
  if (busy) {
    return {
      add: { enabled: false, reason: BUSY_REASON },
      start: { enabled: false, reason: BUSY_REASON },
      remove: { enabled: false, reason: BUSY_REASON },
    };
  }
  if (fsLoading) {
    const why = "A directory listing is still in flight.";
    return {
      add: { enabled: false, reason: why },
      start: { enabled: false, reason: why },
      remove: { enabled: false, reason: why },
    };
  }
  if (!fsLoaded) {
    const why = "List a directory first — the host's own canonical path is required.";
    return {
      add: { enabled: false, reason: why },
      start: { enabled: false, reason: why },
      remove: { enabled: false, reason: why },
    };
  }
  return {
    add: { enabled: true, reason: "Add this directory to the host catalog as a workspace." },
    start: { enabled: true, reason: "Start a Pi in this directory." },
    /* Removing an unlisted path is a no-op the host would reject, so this is
       offered on the same footing as Add: the path is canonical and loaded. */
    remove: { enabled: true, reason: "Drop this directory from the host catalog." },
  };
}

export type { FsEntry, WorkspaceEntry, WorkspaceChildState };
