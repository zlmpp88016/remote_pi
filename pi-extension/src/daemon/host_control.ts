/**
 * Plan/67–68 — pure host-room handlers (no WS). Supervisor injects fleet ops.
 *
 * The catalog is { registered daemons } ∪ { explicitly added workspaces }
 * (plan/68 — still **no** recursive disk scan). A catalog row carries
 * `source` so the app can tell a supervised daemon from a folder the user
 * picked by navigating the host filesystem.
 */

import { roomIdFor } from "../rooms.js";
import { daemonIdForCwd } from "./id.js";
import type { ServerMessage, ActionName } from "../protocol/types.js";

export interface FleetEntry {
  id: string;
  cwd: string;
  name: string;
  live: boolean;
  source: "daemon" | "added";
}

export interface FleetOps {
  list(): FleetEntry[];
  /** Ensures a cwd has a fleet slot (registering it when new). Returns the
   *  resolved identity, or an error string (e.g. a bad path). */
  ensure(cwd: string): { ok: true; id: string; cwd: string; name: string } | { ok: false; error: string };
  start(id: string): { ok: true; started: boolean } | { ok: false; error: string };
  stop(id: string): Promise<{ ok: true; stopped: boolean } | { ok: false; error: string }>;
  /** Plan/68 — persist an explicitly added workspace (idempotent). */
  addWorkspace(cwd: string): { ok: true; cwd: string; added: boolean } | { ok: false; error: string };
  /** Plan/68 — drop an explicitly added workspace. Never touches daemons. */
  removeWorkspace(cwd: string): { ok: true; cwd: string; removed: boolean } | { ok: false; error: string };
}

export interface HostReplySender {
  send(msg: ServerMessage): void;
}

function resolveEntry(
  ops: FleetOps,
  cwd?: string,
  daemonId?: string,
): FleetEntry | undefined {
  const fleet = ops.list();
  if (daemonId) return fleet.find((e) => e.id === daemonId);
  if (!cwd) return undefined;
  const id = daemonIdForCwd(cwd);
  return fleet.find((e) => e.id === id || e.cwd === cwd);
}

function workspaceRow(e: FleetEntry) {
  return {
    cwd: e.cwd,
    daemon_id: e.id,
    room_id: roomIdFor(e.cwd, e.name),
    name: e.name,
    live: e.live,
    daemon: e.source === "daemon",
    source: e.source,
  };
}

export function handleWorkspaceList(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string },
): void {
  sender.send({
    type: "workspace_list_ok",
    in_reply_to: msg.id,
    workspaces: ops.list().map(workspaceRow),
  });
}

/**
 * Plans/67–68 — start a workspace.
 *
 * Accepts either a `daemon_id` or a `cwd`. A cwd that is neither registered in
 * `daemons.json` nor present in `workspaces.json` is registered on the fly
 * (plan/68 replaced the old `not_registered` error): "choose any folder, like
 * SSH". Unresolvable path → typed `not_found`; a spawn failure → `spawn_failed`.
 */
export function handleWorkspaceStart(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string; cwd?: string; daemon_id?: string },
): void {
  const action: ActionName = "workspace_start";
  let entry = resolveEntry(ops, msg.cwd, msg.daemon_id);

  // Plan/68 — unknown cwd: register it first (this is the fix for "no
  // workspace outside daemons.json"), then start it.
  if (!entry && msg.cwd) {
    const ensured = ops.ensure(msg.cwd);
    if (!ensured.ok) {
      sender.send({
        type: "action_error",
        in_reply_to: msg.id,
        action,
        error: ensured.error,
      });
      return;
    }
    entry = resolveEntry(ops, ensured.cwd, ensured.id);
  }

  if (!entry) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action,
      error: "not_found",
    });
    return;
  }

  const result = ops.start(entry.id);
  if (!result.ok) {
    // A failed spawn is its own typed error; anything else is surfaced raw.
    const error = /spawn|ENOENT|EACCES/i.test(result.error) ? "spawn_failed" : result.error;
    sender.send({ type: "action_error", in_reply_to: msg.id, action, error });
    return;
  }
  sender.send({
    type: "workspace_start_ok",
    in_reply_to: msg.id,
    cwd: entry.cwd,
    room_id: roomIdFor(entry.cwd, entry.name),
    daemon_id: entry.id,
  });
}

export async function handleWorkspaceStop(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string; cwd?: string; daemon_id?: string },
): Promise<void> {
  const entry = resolveEntry(ops, msg.cwd, msg.daemon_id);
  if (!entry) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "workspace_stop",
      error: "not_registered",
    });
    return;
  }
  const result = await ops.stop(entry.id);
  if (!result.ok) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "workspace_stop",
      error: result.error,
    });
    return;
  }
  sender.send({
    type: "workspace_stop_ok",
    in_reply_to: msg.id,
    cwd: entry.cwd,
    daemon_id: entry.id,
  });
}

/** Plan/68 — persist a workspace the app added by navigating the host. */
export function handleWorkspaceAdd(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string; path: string },
): void {
  const result = ops.addWorkspace(msg.path);
  if (!result.ok) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "workspace_add",
      error: result.error,
    });
    return;
  }
  sender.send({ type: "action_ok", in_reply_to: msg.id, action: "workspace_add" });
}

/** Plan/68 — drop an added workspace (never a registered daemon). */
export function handleWorkspaceRemove(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string; path: string },
): void {
  const result = ops.removeWorkspace(msg.path);
  if (!result.ok) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "workspace_remove",
      error: result.error,
    });
    return;
  }
  sender.send({ type: "action_ok", in_reply_to: msg.id, action: "workspace_remove" });
}
