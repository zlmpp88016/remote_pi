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
      "Wired to the Wave 4 typed reducer (src/lib/remote-pi/chat.ts): single-flight submit (`canSubmit` locks the composer while a turn is open), echo-gated user/agent items (`visibleChatItems` hides an un-echoed turn), and terminal error/timed_out/disconnected recovery. Retry is explicit and one-shot (`retryRisk` is stated next to the Retry control); there is no automatic resend.",
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
    reason:
      "Wired to the real host wire: `list_models` → `models_list {models, current}`, `model_set {provider, model_id}` → `action_ok | action_error`, and `thinking_set {level}`. Requests ride the host_forward proxy to the workspace room; the provider/id selected are echoed back exactly as the Pi reported them. The thinking control is offered only for a model whose `reasoning` flag is true.",
  },
  {
    id: "tools",
    label: "Tool cards",
    status: "ready",
    reason:
      "Wired to Pi's `tool_request`/`tool_result`, which already reach the client through the host proxy. Args and results render as plain text (never interpreted, never HTML); an `error` is a flag, its text is never shown.",
  },
  {
    id: "upload",
    label: "Attachments",
    status: "ready",
    reason:
      "One inline image per message (plan/30 `user_message.images`), downscaled in the browser before base64. Offered only when the active model reports `vision: true`.",
  },
  {
    id: "sessions",
    label: "Session list",
    status: "ready",
    reason:
      "Lists the workspace's AgentSessions (`session_list`) and READS one's transcript (`session_read`, plan/71) without touching the live session. Switching is a separate, explicit control because it changes state for every paired client.",
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
    reason:
      "Typing `/` in the composer lists the workspace Pi's installed skills (real wire: `pi_surface` → `pi_surface_ok`, run with `skill_invoke`), matching Pi's own `/skill:<name>` entries. Pi's other `/` entries have no remote invocation path, so they are not offered.",
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

export type DockTabId = "plan" | "files" | "changes";

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

const RUNNING_DETAIL = "The host reported this workspace's Pi as running.";
const STARTING_DETAIL =
  "The host reported this workspace as starting; its lifecycle is still in flight.";
const CRASHED_DETAIL =
  "The host reported this workspace as crashed. Restart is offered for a crashed workspace.";
const STOPPED_DETAIL = "The host reported this workspace's Pi as stopped.";
const NOT_RUNNING_DETAIL =
  "The catalog did not list this workspace as live and no lifecycle push has been observed — this is not a report that it stopped.";

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
      return { tone: "running", label: "running", detail: RUNNING_DETAIL, observed: true, restarts, hasError };
    case "starting":
      return { tone: "starting", label: "starting", detail: STARTING_DETAIL, observed: true, restarts, hasError };
    case "crashed":
      return { tone: "crashed", label: "crashed", detail: CRASHED_DETAIL, observed: true, restarts, hasError };
    case "stopped":
      return { tone: "stopped", label: "stopped", detail: STOPPED_DETAIL, observed: true, restarts, hasError };
    default:
      return entry.live
        ? { tone: "running", label: "running", detail: "The catalog listed this workspace as live; no lifecycle push has been observed since.", observed: false, restarts, hasError }
        : { tone: "not_running", label: "not running", detail: NOT_RUNNING_DETAIL, observed: false, restarts, hasError };
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

const BUSY_REASON = "Another workspace action is still running.";
const ALREADY_RUNNING = "The host reports this workspace as already running.";
const STARTING_REASON = "This workspace is starting; wait for the host to report its lifecycle.";
const USE_RESTART = "The host reported this workspace as crashed or stopped — use Restart.";
const RESTART_ONLY_CRASHED = "Restart is offered only when the host reported this workspace as crashed or stopped.";
const START_WHEN_NOT_RUNNING = "Start this workspace: the catalog does not list it as live.";

/**
 * Start/Restart for one catalog row.
 *
 *   • `crashed` / `stopped` → Restart (the documented revive path).
 *   • `running`             → neither.
 *   • `starting`            → neither until the host settles the lifecycle.
 *   • no push + live=false  → Start ("not running").
 *   • no push + live=true   → neither, treated exactly as running.
 *
 * An unknown lifecycle never enables Restart: the host has not said the child
 * crashed, so claiming it needs revival would be a guess.
 */
export function workspaceControls(
  entry: Pick<WorkspaceEntry, "live">,
  { busy, state }: WorkspaceControlInput,
): { start: ControlState; restart: ControlState } {
  if (busy) {
    return {
      start: { enabled: false, reason: BUSY_REASON },
      restart: { enabled: false, reason: BUSY_REASON },
    };
  }
  switch (state?.state) {
    case "running":
      return {
        start: { enabled: false, reason: ALREADY_RUNNING },
        restart: { enabled: false, reason: RESTART_ONLY_CRASHED },
      };
    case "starting":
      return {
        start: { enabled: false, reason: STARTING_REASON },
        restart: { enabled: false, reason: STARTING_REASON },
      };
    case "crashed":
    case "stopped":
      return {
        start: { enabled: false, reason: USE_RESTART },
        restart: { enabled: true, reason: "Ask the host to restart this workspace." },
      };
    default:
      return entry.live
        ? {
            start: { enabled: false, reason: ALREADY_RUNNING },
            restart: { enabled: false, reason: RESTART_ONLY_CRASHED },
          }
        : {
            start: { enabled: true, reason: START_WHEN_NOT_RUNNING },
            restart: { enabled: false, reason: RESTART_ONLY_CRASHED },
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
}: FsControlInput): { add: ControlState; start: ControlState } {
  if (!available) {
    return { add: { enabled: false, reason }, start: { enabled: false, reason } };
  }
  if (busy) {
    return { add: { enabled: false, reason: BUSY_REASON }, start: { enabled: false, reason: BUSY_REASON } };
  }
  if (fsLoading) {
    const why = "A directory listing is still in flight.";
    return { add: { enabled: false, reason: why }, start: { enabled: false, reason: why } };
  }
  if (!fsLoaded) {
    const why = "List a directory first — the host's own canonical path is required.";
    return { add: { enabled: false, reason: why }, start: { enabled: false, reason: why } };
  }
  return {
    add: { enabled: true, reason: "Add this directory to the host catalog as a workspace." },
    start: { enabled: true, reason: "Start a Pi in this directory." },
  };
}

export type { FsEntry, WorkspaceEntry, WorkspaceChildState };
