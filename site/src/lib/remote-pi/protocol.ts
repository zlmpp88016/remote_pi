/**
 * Host-room protocol client core — wire shapes ONLY, all sourced from
 * PROTOCOL.md (repo root). ZERO new protocol contracts are defined here.
 *
 * Transport (PROTOCOL.md "Camadas do protocolo" + plan 69 "O que NÃO muda"):
 *   • WebSocket to the relay; auth handshake `hello → challenge → auth`
 *     (Ed25519 over the raw nonce bytes) — relay/src/auth/challenge.rs.
 *   • After auth, every application message rides the opaque outer envelope
 *     `{ peer, room, ct }` where `ct` = base64(JSON.stringify(inner)).
 *     The relay rewrites `peer`/`room` to the sender's authenticated identity
 *     before forwarding (relay/src/handlers/peer.rs).
 *
 * Application messages used by this minimal client (all from PROTOCOL.md):
 *   pair_request      → pair_ok | pair_error            (room "host", plan 69)
 *   host_hello        → host_hello_ok                   (plan 69)
 *   workspace_list    → workspace_list_ok               (plan 67)
 *   fs_list           → fs_list_ok | action_error       (plan 68)
 *   workspace_start   → workspace_start_ok | action_error (plan 67/68)
 *   user_message      → user_message echo + agent_chunk + agent_done
 *
 * Connection model (plan 69, decision B of the room-multiplex spike): the
 * client anchors ONLY on room "host" — one connection does not sustain room
 * "host" plus workspace rooms (spike E2c). Chat therefore rides the
 * `host_forward`/`host_message` proxy: the client sends
 * `host_forward{room, ct}` on the host room and files the replies that come
 * back as `host_message{room, ct}` by room.
 */

import {
  base64ToBytes,
  base64UrlToBase64,
  bytesToBase64,
} from "./ed25519.ts";

// ── base64url (URI params) ──────────────────────────────────────────────────

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── outer envelope ──────────────────────────────────────────────────────────

/** The relay's opaque routing frame (relay/src/protocol/outer.rs). */
export interface OuterEnvelope {
  peer: string;
  room: string;
  /** base64(JSON.stringify(inner)) — never decrypted by the relay. */
  ct: string;
}

/** base64(JSON.stringify(inner)) — the `ct` payload of an envelope. */
export function encodeCt(inner: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(inner)));
}

export function encodeOuter(peer: string, room: string, inner: unknown): string {
  return JSON.stringify({ peer, room, ct: encodeCt(inner) } satisfies OuterEnvelope);
}

/** Decodes the `ct` payload of an envelope back into its inner message. */
export function decodeCt<T = unknown>(ct: string): T {
  return JSON.parse(new TextDecoder().decode(base64ToBytes(ct))) as T;
}

/** An envelope as delivered by the relay: `peer`/`room` already rewritten to
 *  the sender's authenticated identity, `inner` decoded from `ct`. */
export interface DecodedEnvelope<T = unknown> {
  fromPeer: string;
  fromRoom: string;
  inner: T;
}

export function decodeOuter<T = unknown>(text: string): DecodedEnvelope<T> {
  const outer = JSON.parse(text) as OuterEnvelope;
  if (typeof outer.peer !== "string" || typeof outer.ct !== "string") {
    throw new Error("outer envelope malformed: missing peer/ct");
  }
  const room = typeof outer.room === "string" ? outer.room : "main";
  const innerBytes = base64ToBytes(outer.ct);
  const inner = JSON.parse(new TextDecoder().decode(innerBytes)) as T;
  return { fromPeer: outer.peer, fromRoom: room, inner };
}

// ── pairing code (frozen payload — plan 68/69) ──────────────────────────────

/**
 * `remotepi://pair?t=<token>&epk=<base64url>&n=<nome>[&rm=<roomId>][&r=<relayUrl>]`
 * The payload is a frozen public contract (PROTOCOL.md "Pareamento"); only the
 * issuer changed (daemon, plan 69). The client parses — never rewrites — it.
 */
export interface PairTarget {
  /** One-shot pairing token (`t`). */
  token: string;
  /** Host Pi-key, normalized to canonical standard base64 (with padding). */
  hostEpk: string;
  /** Session/workspace name (`n`) — preview only. */
  name: string;
  /** Room the pair_request must be sent to (`rm`, default "host" — plan 69). */
  roomId: string;
  /** Relay the host is actually connected to (`r`, optional). */
  relayUrl?: string;
}

export function parsePairUri(uri: string): PairTarget {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error("código de pareamento inválido: não é uma URI");
  }
  if (url.protocol !== "remotepi:" || url.host !== "pair") {
    throw new Error("código de pareamento inválido: esperado remotepi://pair?…");
  }
  const token = url.searchParams.get("t");
  const epk = url.searchParams.get("epk");
  const name = url.searchParams.get("n");
  if (!token || !epk || !name) {
    throw new Error("código de pareamento inválido: faltam t/epk/n");
  }
  const epkBytes = base64ToBytes(base64UrlToBase64(epk));
  if (epkBytes.length !== 32) {
    throw new Error("código de pareamento inválido: epk não tem 32 bytes");
  }
  const relay = url.searchParams.get("r");
  return {
    token,
    hostEpk: bytesToBase64(epkBytes),
    name,
    roomId: url.searchParams.get("rm") ?? "host",
    relayUrl: relay ?? undefined,
  };
}

// ── minimal inner message shapes (subset of pi-extension ClientMessage /
//    ServerMessage — see pi-extension/src/protocol/types.ts) ─────────────────

export interface ClientMessage {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface ServerMessage {
  type: string;
  in_reply_to?: string;
  [key: string]: unknown;
}

export interface PairOk extends ServerMessage {
  type: "pair_ok";
  session_name: string;
  session_started_at: number;
  room_id: string;
  hostname?: string;
}

export interface HostHelloOk extends ServerMessage {
  type: "host_hello_ok";
  daemon: { version: string; hostname: string; platform: string };
  capabilities: string[];
}

export interface WorkspaceEntry {
  cwd: string;
  daemon_id: string;
  room_id: string;
  name: string;
  live: boolean;
  daemon: boolean;
  source: "daemon" | "added";
}

export interface WorkspaceListOk extends ServerMessage {
  type: "workspace_list_ok";
  workspaces: WorkspaceEntry[];
}

export interface FsEntry {
  name: string;
  kind: "dir" | "file";
  is_repo?: boolean;
}

export interface FsListOk extends ServerMessage {
  type: "fs_list_ok";
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface WorkspaceStartOk extends ServerMessage {
  type: "workspace_start_ok";
  cwd: string;
  room_id: string;
  daemon_id: string;
}

export interface ActionError extends ServerMessage {
  type: "action_error";
  action: string;
  error: string;
}

/**
 * `host_forward` — proxy envelope sent on the host room (plan 69, decision B):
 * the daemon re-emits `ct` to the child workspace room named in `room`.
 * PROTOCOL.md "Proxy host_forward/host_message".
 */
export interface HostForward extends ClientMessage {
  type: "host_forward";
  /** Child (workspace) room the payload must reach. */
  room: string;
  /** base64(JSON.stringify(inner ClientMessage)) — opaque to the host. */
  ct: string;
}

/**
 * `host_message` — proxy envelope the host sends back: `ct` carries the
 * ServerMessage produced in the child room named in `room`. The client files
 * replies by `room`. PROTOCOL.md "Proxy host_forward/host_message".
 */
export interface HostMessage extends ServerMessage {
  type: "host_message";
  /** Child (workspace) room the payload came from. */
  room: string;
  /** base64(JSON.stringify(inner ServerMessage)). */
  ct: string;
}

/** `action_error` codes documented in PROTOCOL.md (plan 68 errors table). */
export type FsErrorCode =
  | "not_found"
  | "not_a_directory"
  | "permission_denied"
  | "spawn_failed";

export class ActionRejectedError extends Error {
  readonly code: string;
  constructor(action: string, error: string) {
    super(`${action} rejeitado: ${error}`);
    this.name = "ActionRejectedError";
    this.code = error;
  }
}
