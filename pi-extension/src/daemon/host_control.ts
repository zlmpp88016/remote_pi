/**
 * Plan/67 — pure host-room handlers (no WS). Supervisor injects fleet ops.
 */

import { roomIdFor } from "../rooms.js";
import { daemonIdForCwd } from "./id.js";
import type { ServerMessage } from "../protocol/types.js";

export interface FleetEntry {
  id: string;
  cwd: string;
  name: string;
  live: boolean;
}

export interface FleetOps {
  list(): FleetEntry[];
  start(id: string): { ok: true; started: boolean } | { ok: false; error: string };
  stop(id: string): Promise<{ ok: true; stopped: boolean } | { ok: false; error: string }>;
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
    daemon: true,
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

export function handleWorkspaceStart(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string; cwd?: string; daemon_id?: string },
): void {
  const entry = resolveEntry(ops, msg.cwd, msg.daemon_id);
  if (!entry) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "workspace_start",
      error: "not_registered",
    });
    return;
  }
  const result = ops.start(entry.id);
  if (!result.ok) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "workspace_start",
      error: result.error,
    });
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
