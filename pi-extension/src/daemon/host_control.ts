/**
 * Plan/67–68 — pure host-room handlers (no WS). Supervisor injects fleet ops.
 *
 * The catalog is { registered daemons } ∪ { explicitly added workspaces }
 * (plan/68 — still **no** recursive disk scan). A catalog row carries
 * `source` so the app can tell a supervised daemon from a folder the user
 * picked by navigating the host filesystem.
 */

import { hostname } from "node:os";
import { roomIdFor } from "../rooms.js";
import { daemonIdForCwd } from "./id.js";
import { addPeer } from "../pairing/storage.js";
import { HOST_ROOM_ID, type ServerMessage, type ActionName, type PairErrorCode } from "../protocol/types.js";
import type { HostTokenStatus } from "../pairing/host_pairing.js";

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

/**
 * Plan/69 — display name of the machine-level host session.
 *
 * The daemon has no Pi session to name, so the pairing URI (`n`) and the
 * `pair_ok.session_name` echo identify the MACHINE — which is exactly what
 * the app needs to tell two paired PCs apart when nicknames collide.
 */
export function hostSessionName(): string {
  return hostname();
}

/** Plan/69 — pairing-token source for the host-room `pair_request` handler.
 *  `HostPairingSession` (src/pairing/host_pairing.ts) is the production
 *  implementation; tests inject a stub. */
export interface PairingOps {
  consume(token: string): Promise<HostTokenStatus>;
}

const _PAIR_ERROR_MESSAGES: Record<Exclude<HostTokenStatus, "ok">, { code: PairErrorCode; message: string }> = {
  expired: {
    code: "token_expired",
    message: "Ephemeral token expired. Generate a new code with `remote-pi pair`.",
  },
  consumed: {
    code: "token_consumed",
    message: "Token already consumed by another pair_request.",
  },
  unknown: {
    code: "token_unknown",
    message: "Token was not issued by this host.",
  },
};

/**
 * Plan/69 W1 — `pair_request` on the host room, handled by the supervisor
 * (zero Pi processes involved).
 *
 * Mirrors the Pi-side `_handlePairRequest` (src/index.ts) flow: validate the
 * token, persist the peer via `addPeer`, answer with the typed
 * `pair_ok`/`pair_error`. The URI payload itself is unchanged, so an app
 * that paired against an old Pi-issued code pairs against the host with the
 * same paste step.
 *
 * Returns true when a peer was persisted, so the caller can add it to the
 * host-room allow-list (subsequent non-pair traffic from the new device
 * must pass the same check as any paired peer).
 */
export async function handlePairRequest(
  pairing: PairingOps,
  sender: HostReplySender,
  peer: string,
  inner: { id: string; token: string; device_name: string },
): Promise<boolean> {
  const sendError = (code: PairErrorCode, message: string): void => {
    sender.send({ type: "pair_error", in_reply_to: inner.id, code, message });
  };

  const status = await pairing.consume(inner.token);
  if (status !== "ok") {
    const { code, message } = _PAIR_ERROR_MESSAGES[status];
    sendError(code, message);
    return false;
  }

  try {
    await addPeer({
      name: inner.device_name,
      remote_epk: peer,
      paired_at: new Date().toISOString(),
    });
  } catch (err) {
    sendError("internal_error", `Failed to persist peer: ${String(err)}`);
    return false;
  }

  sender.send({
    type: "pair_ok",
    in_reply_to: inner.id,
    session_name: hostSessionName(),
    session_started_at: Date.now(),
    // The app addresses every subsequent inner to the host room.
    room_id: HOST_ROOM_ID,
    // Plan/27 Wave A fields — let the app render a meaningful device row.
    hostname: hostSessionName(),
  });
  return true;
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

/**
 * Plan/69 — restart a workspace by cwd (host room).
 *
 * Idempotent by contract (PROTOCOL.md): a workspace that is already running
 * answers `workspace_restart_ok` WITHOUT respawning — a double-tap or a
 * reconnecting client must not recycle a healthy Pi. A stopped/crashed
 * workspace is started again (the recovery path). An unknown cwd is a typed
 * `not_found`; a failed spawn is `spawn_failed`.
 */
export async function handleWorkspaceRestart(
  ops: FleetOps,
  sender: HostReplySender,
  msg: { id: string; cwd: string },
): Promise<void> {
  const entry = resolveEntry(ops, msg.cwd, undefined);
  if (!entry) {
    sender.send({
      type: "workspace_restart_error",
      in_reply_to: msg.id,
      code: "not_found",
      message: `no workspace registered for cwd ${msg.cwd}`,
    });
    return;
  }

  // Already live → idempotent ok, no respawn.
  if (entry.live) {
    sender.send({
      type: "workspace_restart_ok",
      in_reply_to: msg.id,
      cwd: entry.cwd,
      daemon_id: entry.id,
    });
    return;
  }

  const result = ops.start(entry.id);
  if (!result.ok) {
    // The error code enum is closed (`spawn_failed` | `not_found`); a start
    // failure that is not a missing workspace IS a spawn failure from the
    // client's perspective. The real reason rides in `message`.
    sender.send({ type: "workspace_restart_error", in_reply_to: msg.id, code: "spawn_failed", message: result.error });
    return;
  }
  sender.send({
    type: "workspace_restart_ok",
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
