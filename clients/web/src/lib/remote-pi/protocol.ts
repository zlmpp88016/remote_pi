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
 *   workspace_restart → workspace_restart_ok | workspace_restart_error (plan 69)
 *   workspace_add     → action_ok | action_error       (plan 68)
 *   workspace_state   ← host PUSH, never a reply: NO id, NO in_reply_to
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
 *
 * Exactly these five keys, in this shape, and nothing else: never reorder the
 * serializer, never add a field. Unknown/duplicate keys are REJECTED (a
 * producer that emits a different payload is not this contract).
 */
export interface PairTarget {
  /**
   * Bearer pairing token (`t`). Its mode is **unknown to the client**: it may
   * be persistent (daemon, reusable until `--rotate`) or ephemeral/single-use
   * with a TTL. The client must never assume one-shot semantics, never cache
   * the assumption and never treat a re-pair as impossible — only the host
   * decides, answering `pair_error{token_expired|token_consumed|token_unknown}`.
   */
  token: string;
  /** Host Pi-key, normalized to canonical standard base64 (with padding). */
  hostEpk: string;
  /** Session/workspace name (`n`) — preview only. */
  name: string;
  /** Room the pair_request must be sent to (`rm`, default "host" — plan 69). */
  roomId: string;
  /** Relay the host is actually connected to (`r`, optional; normalized). */
  relayUrl?: string;
}

/** The frozen parameter set of the pairing URI — `rm` is optional. */
const PAIR_URI_PARAMS: readonly string[] = ["t", "epk", "n", "rm", "r"];

/** `rm` value the host-room web client supports (plan 69: daemon emits
 *  `rm=host`; a web page cannot join an arbitrary workspace room directly). */
export const HOST_WEB_ROOM_ID = "host";

export function parsePairUri(uri: string): PairTarget {
  const trimmed = typeof uri === "string" ? uri.trim() : "";
  if (!trimmed) throw new PairRejectedError("invalid_uri_form");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PairRejectedError("invalid_uri_form");
  }
  if (url.protocol !== "remotepi:" || url.host !== "pair") {
    throw new PairRejectedError("invalid_uri_form");
  }
  // userinfo / port / path / fragment are outside the frozen shape.
  if (url.username || url.password) throw new PairRejectedError("invalid_uri_form");
  if (url.hash) throw new PairRejectedError("invalid_uri_form");
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new PairRejectedError("invalid_uri_form");
  }

  // Duplicate or unknown keys are refused — the payload is frozen.
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!PAIR_URI_PARAMS.includes(key)) throw new PairRejectedError("unknown_key");
    if (seen.has(key)) throw new PairRejectedError("duplicate_key");
    seen.add(key);
    values.set(key, value);
  }

  for (const required of ["t", "epk", "n"]) {
    const value = values.get(required);
    // Missing, empty AND whitespace-only are all "absent": a blank parameter
    // is a malformed payload, not a value.
    if (value === undefined || value.trim() === "") {
      throw new PairRejectedError("missing_field");
    }
  }

  const epkRaw = values.get("epk") as string;
  // Frozen encoding is base64url (URL-safe alphabet, optional padding). The
  // alphabet check runs on the URL-form value so `+`, `/` and `=` are refused
  // as non-canonical rather than silently accepted by the base64 decoder.
  const unpadded = epkRaw.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(unpadded)) {
    throw new PairRejectedError("malformed_epk");
  }
  let epkBytes: Uint8Array;
  try {
    epkBytes = base64ToBytes(base64UrlToBase64(epkRaw));
  } catch {
    throw new PairRejectedError("malformed_epk");
  }
  if (epkBytes.length !== 32) throw new PairRejectedError("invalid_epk_size");
  // Canonical: re-encoding those 32 bytes must reproduce the exact unpadded
  // base64url form. A value whose trailing pad bits are non-zero decodes to the
  // same key through an ALTERNATE encoding — refused, so the URI has exactly
  // one representation per key.
  if (bytesToBase64Url(epkBytes) !== unpadded) throw new PairRejectedError("malformed_epk");

  const roomId = values.get("rm") ?? HOST_WEB_ROOM_ID;
  if (roomId !== HOST_WEB_ROOM_ID) throw new PairRejectedError("unsupported_room");

  const relayRaw = values.get("r");

  return {
    token: values.get("t") as string,
    hostEpk: bytesToBase64(epkBytes),
    name: values.get("n") as string,
    roomId,
    // `r` OMITTED → no relay hint. `r=` PRESENT but empty is a malformed
    // payload (an empty parameter is not an absent one) and is refused.
    relayUrl: relayRaw === undefined ? undefined : normalizeRelayUrl(relayRaw),
  };
}

// ── relay URL normalization (`r=` and the manual relay field) ───────────────

/**
 * Normalizes a relay URL to the `ws(s)://` form `new WebSocket` accepts:
 * trims, accepts and coerces `http(s)://` → `ws(s)://` (the canonical form
 * the daemon publishes in `r=`) and strips trailing slashes. Credentials,
 * query string and fragment are refused — a relay address never carries a
 * secret. Error text is FIXED: the offending value is never echoed back.
 */
export function normalizeRelayUrl(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) throw new PairRejectedError("unsafe_relay_url");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PairRejectedError("unsafe_relay_url");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new PairRejectedError("unsafe_relay_url");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PairRejectedError("unsafe_relay_url");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

// ── pairing rejections (typed, safe, host-owned text) ───────────────────────

/**
 * `pair_error` codes documented in PROTOCOL.md / remote-pi (`PairErrorCode`).
 * Anything else the wire sends is collapsed to `internal_error`.
 */
export type PairErrorCode =
  | "token_expired"
  | "token_consumed"
  | "token_unknown"
  | "internal_error";

/** Local (client-side) URI/relay rejections — never sent on the wire. */
export type PairUriErrorCode =
  | "invalid_uri_form"
  | "missing_field"
  | "duplicate_key"
  | "unknown_key"
  | "malformed_epk"
  | "invalid_epk_size"
  | "unsupported_room"
  | "unsafe_relay_url";

export type PairRejectionCode = PairErrorCode | PairUriErrorCode;

/**
 * Fixed, client-authored messages. The host's `pair_error.message` is NEVER
 * rendered: a hostile/stale host could reflect arbitrary text (paths, tokens,
 * markup) into the UI, so only the typed `code` crosses into the message. Same
 * rule for URI parse failures — the offending input never appears in an error.
 */
export const PAIR_REJECTION_MESSAGES: Readonly<Record<PairRejectionCode, string>> = {
  token_expired: "This pairing code has expired. Generate a new code on the host.",
  token_consumed: "This pairing code was already used.",
  token_unknown: "This pairing code was not issued by this host.",
  internal_error: "The host failed to finish pairing. Try again.",
  invalid_uri_form: "Invalid pairing code: expected remotepi://pair?…",
  missing_field: "Invalid pairing code: incomplete payload.",
  duplicate_key: "Invalid pairing code: repeated parameter.",
  unknown_key: "Invalid pairing code: unknown parameter.",
  malformed_epk: "Invalid pairing code: malformed host key.",
  invalid_epk_size: "Invalid pairing code: wrong host key size.",
  unsupported_room: "This pairing code targets a room this web client cannot join.",
  unsafe_relay_url: "Invalid relay address.",
};

export function isPairErrorCode(value: unknown): value is PairErrorCode {
  return (
    value === "token_expired" ||
    value === "token_consumed" ||
    value === "token_unknown" ||
    value === "internal_error"
  );
}

export function pairRejectionMessage(code: PairRejectionCode): string {
  return PAIR_REJECTION_MESSAGES[code];
}

/**
 * Frozen frame label used as the message prefix. It is a client-authored
 * literal (PROTOCOL.md names the reply `pair_error`), so prefixing with it is
 * NOT reflecting remote text — the code next to it is the validated enum.
 */
export const PAIR_ERROR_FRAME = "pair_error";

/**
 * Typed pairing rejection. The message is `pair_error[<validated code>]:
 * <fixed text>`: both parts come from this module (a frozen label plus an
 * allow-listed code and its fixed text). No host-supplied and no
 * input-supplied string is ever interpolated, so a hostile host cannot inject
 * paths, markup or a token into the diagnostic.
 */
export class PairRejectedError extends Error {
  readonly code: PairRejectionCode;

  constructor(code: PairRejectionCode) {
    super(`${PAIR_ERROR_FRAME}[${code}]: ${PAIR_REJECTION_MESSAGES[code]}`);
    this.name = "PairRejectedError";
    this.code = code;
  }

  /** Builds a rejection from a wire `pair_error`: only `code` is trusted. */
  static fromPairError(message: unknown): PairRejectedError {
    const code = isJsonObject(message) ? message.code : undefined;
    return new PairRejectedError(isPairErrorCode(code) ? code : "internal_error");
  }
}

/**
 * Canonical `pair_request` body (PROTOCOL.md step 3): `{ type, id, token,
 * device_name }` — no `sig`, no `owner_pk`, no `signature`; the token is the
 * authorization. Rebuilt from the typed parts so no stray field leaks in.
 */
export function pairRequest(id: string, token: string, deviceName: string): PairRequest {
  return { type: "pair_request", id, token, device_name: deviceName };
}

// ── minimal inner message shapes (subset of remote-pi ClientMessage /
//    ServerMessage — see server/src/protocol/types.ts) ─────────────────

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

/** Plan/77 — one allowlisted text file.
 *
 * `content` is whatever the host returned and is rendered as MARKDOWN, never as
 * HTML: the fence lives on the host, so nothing here re-validates the path.
 * `truncated` means `content` is the head of a larger file; `bytes` is the real
 * size, so the UI can say how much was withheld instead of pretending the
 * document ended there. */
export interface FsReadOk extends ServerMessage {
  type: "fs_read_ok";
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

/*
 * Plan/78 — Changes snapshot.
 *
 * STATUS only: paths are repo-relative and there is no file body anywhere in
 * this shape. A diff verb was considered and rejected, because a diff IS the
 * content of arbitrary worktree files and would widen a pairing token's grant
 * from "a few allowlisted documents" to "everything you ever edited" — the
 * exact hole `fs_read`'s allowlist exists to keep closed.
 */
export interface ChangesEntryWire {
  /** Repo-relative, forward-slashed. Never absolute. */
  rel: string;
  /** Index column from `git status --porcelain` (`.MADRCU?!`). */
  x: string;
  /** Worktree column, same vocabulary. */
  y: string;
  renamed: boolean;
}

export interface ChangesSnapshotWire {
  is_repo: true;
  branch: string | null;
  head: { sha7: string; subject: string } | null;
  ahead: number | null;
  behind: number | null;
  entries: ChangesEntryWire[];
  total: { staged: number; unstaged: number; untracked: number; conflicted: number };
  truncated: boolean;
}

export interface ChangesSnapshotOk extends ServerMessage {
  type: "changes_snapshot_ok";
  snapshot: ChangesSnapshotWire;
}

/* ── Plan/79 — host models.json ────────────────────────────────────────────────
 *
 * Mirrors the server contract as a deliberate subset with its own strict guards.
 * The single most important property here is NEGATIVE: no credential may appear in
 * any of these shapes, and the guard below asserts that rather than trusting the
 * host to have stripped it.
 */

/** Path segments address the JSON structure, never a filesystem path. */
export type ModelsOpWire =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "insert"; path: (string | number)[]; value: unknown }
  | { op: "remove"; path: (string | number)[] }
  | { op: "unset"; path: (string | number)[] };

export interface ModelsFileState {
  exists: boolean;
  parseable: boolean;
  writable: boolean;
  /** Owner-only permissions. Plaintext keys live in this file. */
  mode_safe: boolean;
}

/** Existence only: no value, no mask, no length. */
export type ModelsSecrets = Record<string, { has_key: boolean }>;

export interface ModelsDescribeOk extends ServerMessage {
  type: "models_describe_ok";
  revision: string;
  file: ModelsFileState;
  config: Record<string, unknown>;
  secrets: ModelsSecrets;
}

export interface ModelsMutateOk extends ServerMessage {
  type: "models_mutate_ok";
  revision: string;
}

/** Closed set. The client owns the sentence, so no errno or stack reaches the UI. */
export type ModelsErrorReason =
  | "not_found"
  | "corrupted"
  | "permission"
  | "conflict"
  | "invalid"
  | "verify_failed"
  | "unsupported";

export interface ModelsError extends ServerMessage {
  type: "models_error";
  reason: ModelsErrorReason;
}

/* ── Plan/80 — host settings.json ─────────────────────────────────────────────
 *
 * A POSITIVE whitelist mirrored on both sides. `packages` on the real machine
 * contains absolute host paths, so it has no type here at all: the client could not
 * render it even if a host bug sent it.
 */

export type SettingsField =
  | "theme"
  | "hideThinkingBlock"
  | "retry.enabled"
  | "retry.maxRetries"
  | "retry.baseDelayMs"
  | "retry.provider.maxRetryDelayMs";

export type SettingsOpWire =
  | { op: "set"; path: SettingsField | string[]; value: unknown }
  | { op: "unset"; path: SettingsField | string[] };

export interface SettingsFileState {
  exists: boolean;
  parseable: boolean;
  writable: boolean;
}

export interface SettingsAppearance {
  /** Read-only here: selects a pi TUI theme. The browser-local visual presets are
   *  a different concept and never write this value. */
  theme: string | null;
  hide_thinking_block: boolean | null;
}

export interface SettingsBehaviour {
  retry_enabled: boolean | null;
  retry_max_retries: number | null;
  retry_base_delay_ms: number | null;
  retry_provider_max_retry_delay_ms: number | null;
}

export interface SettingsDescribeOk extends ServerMessage {
  type: "settings_describe_ok";
  revision: string;
  file: SettingsFileState;
  appearance: SettingsAppearance;
  behaviour: SettingsBehaviour;
}

export interface SettingsMutateOk extends ServerMessage {
  type: "settings_mutate_ok";
  revision: string;
}

export type SettingsErrorReason =
  | "not_found"
  | "corrupted"
  | "permission"
  | "conflict"
  | "invalid"
  | "invalid_field"
  | "unsupported"
  | "verify_failed";

export interface SettingsError extends ServerMessage {
  type: "settings_error";
  reason: SettingsErrorReason;
}

/** Why a snapshot could not be taken. Closed set — the client owns the wording,
 *  so no host text ever reaches the screen. `unreadable` means the repository IS
 *  there and could not be read (permissions, dubious owner, locked index, corrupt
 *  store); it is deliberately distinct from `not_a_repo`, because telling a user
 *  their folder is not a repository when it is one is a lie about their own
 *  workspace. */
export type ChangesUnavailableReason =
  | "not_a_repo"
  | "git_missing"
  | "timeout"
  /** The workspace folder itself is gone (deleted, or an unmounted network drive).
   *  Distinct from `git_missing`: git may be fine, there is nothing at that path. */
  | "workspace_missing"
  /** The repository exists but could not be read: permissions, dubious owner, a
   *  locked index, a corrupt store. Distinct from `not_a_repo` because telling a
   *  user their folder is not a repository when it is one is a lie. */
  | "unreadable";

export interface ChangesSnapshotUnavailable extends ServerMessage {
  type: "changes_snapshot_unavailable";
  reason: ChangesUnavailableReason;
}
export interface WorkspaceStartOk extends ServerMessage {
  type: "workspace_start_ok";
  cwd: string;
  room_id: string;
  daemon_id: string;
}

/** Plan/69 — lifecycle vocabulary of the `workspace_state` push. CLOSED: an
 *  unknown state is a malformed push (the client has no rendering for it and
 *  must not guess). Same union as remote-pi `WorkspaceState`
 *  (daemon/control_protocol.ts). */
export const WORKSPACE_STATES = ["running", "starting", "crashed", "stopped"] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/**
 * `workspace_state` — an UNSOLICITED host push (remote-pi
 * daemon/host_bridge.ts `pushWorkspaceState`). It carries NO `id`, NO
 * `in_reply_to`, NO `daemon_id`, NO `room_id` and NO version: it can never be
 * correlated to a request and is routed by its `cwd` alone. `last_error` is
 * RAW host text (validated as a string or null) and is NEVER rendered — the
 * adapter collapses it to a boolean; `restarts` is the supervisor's counter.
 */
export interface WorkspaceStatePush {
  type: "workspace_state";
  cwd: string;
  state: WorkspaceState;
  last_error: string | null;
  restarts: number;
}

/**
 * Automations — one scheduled task as the host described it.
 *
 * The derived fields (`kind`, `time`, `weekdays`, `every_*`) come from the host's
 * projection of the AUTHORITATIVE `schedule` expression and are `null` when the
 * expression does not imply them. Rendering `null` as zero would describe a rule
 * the host never stored, so the type keeps the distinction visible.
 */
export interface WireScheduleTask {
  id: string;
  daemon_id: string;
  schedule: string;
  kind: string;
  every_minutes: number | null;
  every_hours: number | null;
  time: string | null;
  weekdays: number[] | null;
  tz: string | null;
  prompt: string;
  enabled: boolean;
  skip_if_busy: boolean;
  wake: boolean;
  catchup: boolean;
  created_at: string;
  last_run: string | null;
  last_status: string | null;
  next_run: string | null;
  /** Pinned model, or null when the task inherits the session's model. */
  model: { provider: string; id: string; name: string | null } | null;
  /** True when each fire opens its own session instead of the live one. */
  fresh_session: boolean;
}

/** `schedule_list_ok`, and the base for the other three OK replies. */
export interface ScheduleListOk {
  type: "schedule_list_ok";
  in_reply_to: string;
  tasks: WireScheduleTask[];
  workspace_names: Record<string, string>;
}

/**
 * Validates one task row.
 *
 * Strict on the six fields the UI cannot render without (`id`, `daemon_id`,
 * `schedule`, `prompt`, `enabled`), and lenient on the derived/optional ones: a
 * host that omits `next_run` is telling us it does not know, which is a fact
 * worth keeping rather than a frame worth rejecting.
 */
export function isWireScheduleTask(value: unknown): value is WireScheduleTask {
  if (!isJsonObject(value)) return false;
  if (typeof value.id !== "string" || value.id === "") return false;
  if (typeof value.daemon_id !== "string" || value.daemon_id === "") return false;
  if (typeof value.schedule !== "string" || value.schedule === "") return false;
  if (typeof value.prompt !== "string") return false;
  if (typeof value.enabled !== "boolean") return false;
  /* Nullable-but-present-when-known fields: each must be the right type or null. */
  const maybeString = (v: unknown): boolean => v === null || v === undefined || typeof v === "string";
  const maybeNumber = (v: unknown): boolean => v === null || v === undefined || (typeof v === "number" && Number.isFinite(v));
  if (!maybeString(value.next_run) || !maybeString(value.last_run) || !maybeString(value.last_status)) return false;
  if (!maybeString(value.tz) || !maybeString(value.time) || !maybeString(value.kind)) return false;
  if (!maybeNumber(value.every_minutes) || !maybeNumber(value.every_hours)) return false;
  if (value.weekdays !== null && value.weekdays !== undefined) {
    if (!Array.isArray(value.weekdays)) return false;
    if (!value.weekdays.every((d) => typeof d === "number")) return false;
  }
  /*
   * Model pin: strictly validated, because a half-read pin would render as
   * "inherits" while the daemon actually pinned something — the user would see
   * the wrong cost story on their own screen.
   *
   * Absent is tolerated (an older daemon simply does not send it) and means
   * inherit, which is also what `null` means.
   */
  const model = value.model;
  if (model !== null && model !== undefined) {
    if (!isJsonObject(model)) return false;
    if (typeof model.provider !== "string" || model.provider === "") return false;
    if (typeof model.id !== "string" || model.id === "") return false;
    if (model.name !== null && model.name !== undefined && typeof model.name !== "string") return false;
  }
  if (value.fresh_session !== undefined && typeof value.fresh_session !== "boolean") return false;
  return true;
}

export function isScheduleListOk(value: unknown): value is ScheduleListOk {
  if (!isServerMessage(value)) return false;
  if (value.type !== "schedule_list_ok") return false;
  const rec = value as unknown as Record<string, unknown>;
  if (typeof rec.in_reply_to !== "string") return false;
  if (!Array.isArray(rec.tasks)) return false;
  if (!rec.tasks.every(isWireScheduleTask)) return false;
  if (!isJsonObject(rec.workspace_names)) return false;
  return true;
}

/**
 * Automations — the outcome vocabulary of one scheduled fire.
 *
 * CLOSED, and verified against the host's own records. A frame carrying anything
 * outside this set is REFUSED rather than displayed: the host only ever writes
 * these six values, so an unknown one means the frame is malformed or from a
 * host we do not understand — and inventing a label for it would tell the user
 * something that is not true.
 */
export const SCHEDULE_RESULTS = [
  "delivered",
  "deliver_failed",
  "woke_and_delivered",
  "skipped_busy",
  "skipped_down",
  "skipped_disabled",
] as const;

export type ScheduleResult = (typeof SCHEDULE_RESULTS)[number];

/**
 * `schedule_fired` — an UNSOLICITED host push. Like `workspace_state` it has no
 * `id` and no `in_reply_to`: nobody requested this occurrence.
 *
 * `prompt_preview` is host-truncated and is only an identifier; the full prompt
 * lives in the task row and the transcript. It is deliberately NOT rendered as
 * the reminder body.
 */
export interface ScheduleFiredPush {
  type: "schedule_fired";
  job_id: string;
  daemon_id: string;
  result: ScheduleResult;
  fired_at: string;
  prompt_preview: string;
}

/** `workspace_restart {id, cwd}` — request body (remote-pi types.ts:254). */
export interface WorkspaceRestartRequest extends ClientMessage {
  type: "workspace_restart";
  cwd: string;
}

/** `workspace_stop {id, cwd}` — shut down a live workspace (remote-pi
 *  types.ts:248). A supervisor verb: answered on the HOST room. */
export interface WorkspaceStopRequest extends ClientMessage {
  type: "workspace_stop";
  cwd: string;
}

/** `workspace_stop_ok {in_reply_to, cwd, daemon_id}` — the host's own success
 *  frame (NOT the generic `action_ok`), naming what it actually stopped. */
export interface WorkspaceStopOk extends ServerMessage {
  type: "workspace_stop_ok";
  cwd: string;
  daemon_id: string;
}

/** Strict guard for `workspace_stop_ok`: both echoed fields are mandatory, so a
 *  malformed frame cannot be mistaken for a completed stop. */
export function isWorkspaceStopOk(value: unknown): value is WorkspaceStopOk {
  if (!isServerMessage(value) || value.type !== "workspace_stop_ok") return false;
  const v = value as Record<string, unknown>;
  return typeof v.cwd === "string" && typeof v.daemon_id === "string";
}

/** `workspace_remove {id, path}` — drop a path from the host catalog. */
export interface WorkspaceRemoveRequest extends ClientMessage {
  type: "workspace_remove";
  path: string;
}

/** `workspace_restart_ok {in_reply_to, cwd, daemon_id}` — deliberately NO
 *  `room_id`: the caller must relist the catalog to learn the room identity. */
export interface WorkspaceRestartOk extends ServerMessage {
  type: "workspace_restart_ok";
  cwd: string;
  daemon_id: string;
}

/** `workspace_restart_error {in_reply_to, code, message}` — `code` is a
 *  CLOSED enum; `message` is RAW host text (it embeds the cwd) that must
 *  never be rendered. */
export interface WorkspaceRestartError extends ServerMessage {
  type: "workspace_restart_error";
  code: string;
  message: string;
}

export const WORKSPACE_RESTART_ERROR_CODES = ["not_found", "spawn_failed"] as const;

export type WorkspaceRestartErrorCode = (typeof WORKSPACE_RESTART_ERROR_CODES)[number];

/** Fixed client-authored text per allow-listed restart code. */
export const WORKSPACE_RESTART_ERROR_MESSAGES: Readonly<Record<WorkspaceRestartErrorCode, string>> = {
  not_found: "No workspace is registered at that folder.",
  spawn_failed: "The host could not start this workspace.",
};

/** Text used for a `workspace_restart_error` code outside the allow-list. */
export const WORKSPACE_RESTART_ERROR_FALLBACK = "The host could not restart this workspace.";

/** `action_ok {in_reply_to, action}` — success counterpart of `action_error`
 *  (plan 68). `workspace_add` answers with this and NOTHING else: no cwd echo,
 *  no `added` flag, so the canonical cwd is only learnable through a
 *  subsequent `workspace_list`. */
export interface ActionOk extends ServerMessage {
  type: "action_ok";
  action: string;
}

export interface ActionError extends ServerMessage {
  type: "action_error";
  action: string;
  error: string;
}

// ── model / thinking surface (PROTOCOL.md "App actions") ───────────────────

/**
 * One entry of `models_list.models` / `models_list.current`. Mirrors the
 * daemon's `WireModel` (server/src/protocol/types.ts), which is derived
 * from the SDK's live ModelRegistry (`pi.registerProvider` included). These
 * strings come from the host/Pi and are RENDERED AS TEXT — never interpreted,
 * never used to build a request other than echoing `provider` + `id` back.
 */
export interface WireModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  context_window: number;
  /** Plan/30: the model accepts image input (SDK `Model.input` has `image`). */
  vision: boolean;
  /**
   * Thinking levels THIS model honours, in picker order (server-derived from
   * `Model.thinkingLevelMap`).
   *
   * Absent means the model is not a reasoning model, which is what lets the picker
   * hide the control instead of showing a six-way switch that silently resolves to a
   * neighbour. When present it is authoritative: render exactly these.
   */
  thinking_levels?: ThinkingLevel[];
}

/** `list_models {id}` — ask the workspace Pi for its available models. */
export interface ListModelsRequest extends ClientMessage {
  type: "list_models";
}

/** `model_set {id, provider, model_id}` — switch the workspace Pi's model. */
export interface ModelSetRequest extends ClientMessage {
  type: "model_set";
  provider: string;
  model_id: string;
}

/** The fixed thinking enum (PROTOCOL.md "Thinking levels"). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** `thinking_set {id, level}` — set the workspace Pi's thinking level. */
export interface ThinkingSetRequest extends ClientMessage {
  type: "thinking_set";
  level: ThinkingLevel;
}

/**
 * `models_list {in_reply_to, models, current?}` — reply to `list_models`.
 * `current` is the model the Pi is using right now, so a picker can highlight
 * a row without a second round-trip.
 */
export interface ModelsListOk extends ServerMessage {
  type: "models_list";
  models: WireModel[];
  current?: WireModel;
}

/** Strict per-entry check: the six documented fields, correct types, non-blank
 *  strings. Unknown extra keys are tolerated (never projected) because the
 *  daemon owns the shape and may add fields; the six below are the contract. */
export function isWireModel(value: unknown): value is WireModel {
  if (!isJsonObject(value)) return false;
  if (!(
    typeof value.id === "string" && value.id !== "" &&
    typeof value.name === "string" && value.name !== "" &&
    typeof value.provider === "string" && value.provider !== "" &&
    typeof value.reasoning === "boolean" &&
    typeof value.context_window === "number" && Number.isFinite(value.context_window) &&
    typeof value.vision === "boolean"
  )) return false;
  /*
   * `thinking_levels` is optional, but when present it must be a list of KNOWN
   * levels: a typo'd level would render a button the daemon cannot apply.
   */
  const levels = (value as { thinking_levels?: unknown }).thinking_levels;
  if (levels === undefined) return true;
  return Array.isArray(levels) && levels.every((level) => isThinkingLevel(level));
}

/** Reply guard for `models_list`: every entry must satisfy `isWireModel`, and
 *  `current` — when present — must too. A malformed list is refused whole
 *  rather than partially rendered. */
export function isModelsListOk(value: unknown): value is ModelsListOk {
  if (!isServerMessage(value) || value.type !== "models_list") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.models) || !v.models.every(isWireModel)) return false;
  return v.current === undefined || isWireModel(v.current);
}

/** Typed refusal for a `model_set` / `thinking_set` — the host's free-text
 *  `error` is kept for branching but a FIXED sentence is what the UI shows. */
export class ModelActionRejectedError extends Error {
  readonly action: string;

  constructor(action: string) {
    super("the host rejected the model action");
    this.name = "ModelActionRejectedError";
    this.action = action;
  }
}

// ── sessions (plan/67 list/switch, plan/71 read-only transcript) ─────────

/** One AgentSession of the workspace cwd, as the host listed it. */
export interface WireSessionInfo {
  id: string;
  name?: string;
  mtime: number;
  /** First-message excerpt, truncated host-side. */
  preview?: string;
  /** True for the session the workspace Pi is currently running. */
  live: boolean;
  cwd?: string;
}

/** `session_list {id}` — list the workspace cwd's AgentSessions. */
export interface SessionListRequest extends ClientMessage {
  type: "session_list";
}

/**
 * `session_new {id}` — start a fresh AgentSession in the workspace.
 *
 * Answered with the generic `action_ok` / `action_error` pair (the host runs it
 * through `runAsync`, and `session_new` is an `ActionName`), NOT a dedicated
 * `session_new_ok`: there is no payload beyond success. A failure carries the
 * host's text (e.g. "newSession unavailable (no command ctx yet)", or
 * "cancelled by extension hook") in `action_error.error`.
 */
export interface SessionNewRequest extends ClientMessage {
  type: "session_new";
}

export interface SessionListOk extends ServerMessage {
  type: "session_list_ok";
  current_id: string | null;
  sessions: WireSessionInfo[];
  /**
   * Whether this host can switch the live session / start a new one.
   *
   * Both need a command-capable context that an RPC-mode daemon never
   * captures, and the client has no other way to know. Absent on an older
   * host, which is why the readers default to `true` — a control that used to
   * work must not disappear just because the host does not announce it.
   */
  can_switch?: boolean;
  can_new?: boolean;
}

/**
 * `session_read {id, session_id, limit?, before?}` — READ one session's
 * transcript WITHOUT switching the live session.
 *
 * `session_id` must be an id the host reported in `session_list_ok`; the host
 * resolves it to a file itself and refuses a path, so this cannot be used as an
 * arbitrary-file-read.
 */
export interface SessionReadRequest extends ClientMessage {
  type: "session_read";
  session_id: string;
  limit?: number;
  before?: string;
}

/**
 * Narrow an unknown wire value into a `WireUsage`.
 *
 * Host frames are not type-checked at the boundary — `ServerMessage` carries an
 * open index signature — so every numeric field is re-validated here. A malformed
 * usage degrades to `undefined` (no reading rendered) rather than becoming NaN in
 * the composer.
 *
 * @param value - the raw `usage` member of a frame.
 * @returns a validated usage, or `undefined` when the value is unusable.
 */
export function wireUsageOf(value: unknown): WireUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const input = num("input_tokens");
  const output = num("output_tokens");
  if (input === undefined && output === undefined) return undefined;
  const usage: WireUsage = { input_tokens: input ?? 0, output_tokens: output ?? 0 };
  const cacheRead = num("cache_read_tokens");
  if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
  const cacheWrite = num("cache_write_tokens");
  if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite;
  const reasoning = num("reasoning_tokens");
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  const total = num("total_tokens");
  if (total !== undefined) usage.total_tokens = total;
  return usage;
}

/** Token accounting for one assistant message. Mirrors the host's `Usage` in
 *  `server/src/protocol/types.ts` FIELD FOR FIELD — the SDK reports all of these
 *  and the client bills its stats from them, so a missing field silently breaks
 *  the cache-hit share rather than failing loudly. */
export interface WireUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

/** One transcript event. Mirrors the host's `SessionHistoryEvent`
 *  (`server/src/protocol/types.ts`) FIELD FOR FIELD: a mismatch here is not
 *  a stricter guard, it is a guard that rejects real host frames. */
interface SessionEventBase {
  ts: number;
}
export type WireSessionEvent =
  | (SessionEventBase & { type: "user_input"; id: string; text: string })
  | (SessionEventBase & {
      type: "agent_message";
      in_reply_to: string;
      text: string;
      usage?: WireUsage;
    })
  | (SessionEventBase & {
      type: "tool_request";
      tool_call_id: string;
      tool: string;
      args: Record<string, unknown>;
    })
  | (SessionEventBase & {
      type: "tool_result";
      tool_call_id: string;
      result?: unknown;
      error?: string;
    })
  | (SessionEventBase & {
      type: "compaction";
      summary: string;
      tokens_before: number;
    });

/**
 * `session_read_ok {in_reply_to, session_id, events, eos, truncated,
 * older_cursor?, has_older?}` — same event vocabulary as `session_history`, so a
 * read-only view renders with the same code path.
 */
export interface SessionReadOk extends ServerMessage {
  type: "session_read_ok";
  session_id: string;
  events: WireSessionEvent[];
  eos: boolean;
  truncated: boolean;
  older_cursor?: string | null;
  has_older?: boolean;
}

/**
 * `session_history` — an UNSOLICITED host fan-out of the live session's
 * transcript. The host sends it on connect and again whenever its mirror is
 * replaced (a resumed session, a `/new`), so it is the only signal that the
 * fresh process has a transcript to show. The client used to drop this frame
 * entirely, which is why a resumed session rendered as a brand-new empty
 * conversation even though the file on disk held months of history.
 */
export interface SessionHistoryFrame extends ServerMessage {
  type: "session_history";
  session_started_at: number;
  events: WireSessionEvent[];
  eos: boolean;
  truncated: boolean;
  older_cursor?: string | null;
  has_older?: boolean;
}

/** `session_switch {id, session_id}` — make another session the LIVE one.
 *  A real state change for every paired client, hence a separate action from
 *  the read-only `session_read`. */
export interface SessionSwitchRequest extends ClientMessage {
  type: "session_switch";
  session_id: string;
}

/** The host's refusal codes. Each maps to a real SDK outcome:
 *  `locked` = the TUI holds it, `unknown` = it vanished, `no_sdk` = no command
 *  context (typical of a daemon without `--resume`). */
export type SessionSwitchErrorCode = "locked" | "unknown" | "no_sdk";

export interface SessionSwitchOk extends ServerMessage {
  type: "session_switch_ok";
  session_id: string;
  session_started_at: number;
}

export interface SessionSwitchError extends ServerMessage {
  type: "session_switch_error";
  code: SessionSwitchErrorCode;
  message: string;
}

export function isSessionSwitchOk(value: unknown): value is SessionSwitchOk {
  if (!isServerMessage(value) || value.type !== "session_switch_ok") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.session_id === "string" &&
    v.session_id !== "" &&
    typeof v.session_started_at === "number" &&
    Number.isFinite(v.session_started_at)
  );
}

/** The three codes are a closed set, so an unexpected one is NOT accepted as a
 *  framing detail — it would be shown to the user as a wrong reason. */
export function isSessionSwitchError(value: unknown): value is SessionSwitchError {
  if (!isServerMessage(value) || value.type !== "session_switch_error") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.code === "locked" || v.code === "unknown" || v.code === "no_sdk") &&
    typeof v.message === "string"
  );
}

/** Strict per-row check for a listed session: `name`/`preview`/`cwd` are
 *  optional, `id`/`mtime`/`live` are not. */
export function isWireSessionInfo(value: unknown): value is WireSessionInfo {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.id === "string" && value.id !== "" &&
    typeof value.mtime === "number" && Number.isFinite(value.mtime) &&
    typeof value.live === "boolean" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.preview === undefined || typeof value.preview === "string") &&
    (value.cwd === undefined || typeof value.cwd === "string")
  );
}

export function isSessionListOk(value: unknown): value is SessionListOk {
  if (!isServerMessage(value) || value.type !== "session_list_ok") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.current_id === null || typeof v.current_id === "string") &&
    Array.isArray(v.sessions) &&
    v.sessions.every(isWireSessionInfo)
  );
}

/** A transcript event is only the fields the renderer reads, so an unknown
 *  extra key is tolerated but a wrong/missing type is not. `compaction` is
 *  accepted because the host emits it in a replay. */
function isWireSessionEvent(value: unknown): value is WireSessionEvent {
  if (!isJsonObject(value)) return false;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return false;
  switch (value.type) {
    case "user_input":
      return typeof value.id === "string" && value.id !== "" && typeof value.text === "string";
    case "agent_message":
      // `in_reply_to` is REQUIRED by the host (it is the id of the user entry
      // this message answers), so it is required here too.
      return (
        typeof value.in_reply_to === "string" &&
        value.in_reply_to !== "" &&
        typeof value.text === "string" &&
        (value.usage === undefined || isJsonObject(value.usage))
      );
    case "tool_request":
      return (
        typeof value.tool_call_id === "string" &&
        value.tool_call_id !== "" &&
        typeof value.tool === "string" &&
        isJsonObject(value.args)
      );
    case "tool_result":
      return (
        typeof value.tool_call_id === "string" &&
        value.tool_call_id !== "" &&
        (value.error === undefined || typeof value.error === "string")
      );
    case "compaction":
      return typeof value.summary === "string" && typeof value.tokens_before === "number";
    default:
      // An event kind this client does not render is NOT a valid frame: the
      // caller must not silently drop part of a transcript it is displaying.
      return false;
  }
}

export function isSessionReadOk(value: unknown): value is SessionReadOk {
  if (!isServerMessage(value) || value.type !== "session_read_ok") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.session_id === "string" &&
    v.session_id !== "" &&
    Array.isArray(v.events) &&
    v.events.every(isWireSessionEvent) &&
    typeof v.eos === "boolean" &&
    typeof v.truncated === "boolean" &&
    (v.older_cursor === undefined || v.older_cursor === null || typeof v.older_cursor === "string") &&
    (v.has_older === undefined || typeof v.has_older === "boolean")
  );
}

// ── skills (plan/68 `pi_surface` + `skill_invoke`) ───────────────────────

/**
 * `pi_surface {id}` — ask the workspace Pi what it has installed. Proxied to
 * the child room exactly like chat; the reply arrives on the same room.
 */
export interface PiSurfaceRequest extends ClientMessage {
  type: "pi_surface";
}

/** Where a discovered skill came from (SDK `sourceInfo.scope`). */
export type SkillSource = "user" | "project" | "package";

/** One installed skill, as the host reported it. */
export interface WireSkill {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  /** `null` when the host could not determine it — never guessed. */
  enabled: boolean | null;
  /** `disable-model-invocation: true` — explicit `/skill:<name>` only. Those
   *  are exactly the ones a slash menu MUST offer, so this flag is kept. */
  disable_model_invocation: boolean;
}

/** One installed Pi package, as the host reported it (`pi_surface_ok.packages`).
 *  `source` is the configured source string (an npm spec or a path); `scope` is
 *  which settings file it came from; `resources` lists the resource kinds the
 *  package contributes. Nothing here is interpreted — the rows are rendered as
 *  text and only `source`/`scope` are ever sent back.
 *
 *  `readme` is the package's own documentation, read by the host from the
 *  directory it installed the package into. It is OPTIONAL because an older
 *  host omits it, and `null` is meaningful: the package ships no README. The
 *  UI distinguishes "not provided" from an empty document. */
export interface WirePackage {
  source: string;
  scope: "user" | "project";
  resources: string[];
  readme?: string | null;
  readme_path?: string | null;
  readme_truncated?: boolean;
  /**
   * Whether this package's resources will actually load.
   *
   * Absent is NOT "disabled": an older host does not report it, and a package
   * whose state cannot be determined must not be drawn as switched off.
   */
  enabled?: boolean;
}

/**
 * `pi_surface_ok {in_reply_to, runtime, skills, packages}` — reply to
 * `pi_surface`.
 *
 * `packages` and `runtime` are OPTIONAL by design, not by accident: the host
 * sends all four fields, but an older/other host may omit them, and treating
 * "absent" as "invalid" would throw away the skills list that IS present. A
 * missing list is read as empty by the consumers, never as a parse failure.
 */
export interface PiSurfaceOk extends ServerMessage {
  type: "pi_surface_ok";
  skills: WireSkill[];
  packages?: WirePackage[];
  runtime?: Record<string, unknown>;
}

/** One package row, validated field by field.
 *
 *  The README fields are validated LENIENTLY and never required: a host that
 *  does not send them is still a valid host, and one malformed README must not
 *  discard the rest of the row (which carries `source`/`scope`, the only fields
 *  anything is ever sent back to the host with). */
export function isWirePackage(value: unknown): value is WirePackage {
  if (!isJsonObject(value)) return false;
  if (
    !(
      typeof value.source === "string" && value.source !== "" &&
      (value.scope === "user" || value.scope === "project") &&
      Array.isArray(value.resources) &&
      value.resources.every((r) => typeof r === "string")
    )
  ) {
    return false;
  }
  if (value.readme !== undefined && value.readme !== null && typeof value.readme !== "string") return false;
  if (value.readme_path !== undefined && value.readme_path !== null && typeof value.readme_path !== "string") return false;
  if (value.readme_truncated !== undefined && typeof value.readme_truncated !== "boolean") return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  return true;
}

/** `skill_invoke {id, name, args?}` — run one installed skill. */
export interface SkillInvokeRequest extends ClientMessage {
  type: "skill_invoke";
  name: string;
  args?: string;
}

/**
 * `skill_invoke_ok {in_reply_to, name}` — the skill was DISPATCHED. Its output
 * arrives through the normal chat channels, so this only confirms dispatch.
 */
export interface SkillInvokeOk extends ServerMessage {
  type: "skill_invoke_ok";
  name: string;
}

/**
 * `cancel {id, target_id}` — stop the in-flight turn in a workspace.
 *
 * Addressed to the CHILD room (the Pi process that is generating), proxied with
 * the same `host_forward` envelope as chat. `target_id` names the turn, which is
 * the id the client already holds for its active turn.
 */
export interface CancelRequest extends ClientMessage {
  type: "cancel";
  target_id: string;
}

/**
 * `cancelled {in_reply_to, target_id}` — the abort landed.
 *
 * The two ids are NOT interchangeable: `in_reply_to` is the `cancel` request's
 * own id, while `target_id` is the turn that was stopped. Only `target_id`
 * matches the turn the client is tracking, so a consumer that correlates on
 * `in_reply_to` finds nothing and the turn stays open forever.
 */
export interface CancelledMsg extends ServerMessage {
  type: "cancelled";
  target_id: string;
}

/** Strict guard for `cancelled`: a non-blank `target_id` is mandatory, because
 *  an uncorrelatable abort is indistinguishable from a turn that never stopped. */
export function isCancelledMsg(value: unknown): value is CancelledMsg {
  if (!isServerMessage(value) || value.type !== "cancelled") return false;
  const v = value as Record<string, unknown>;
  return typeof v.target_id === "string" && v.target_id !== "";
}

/** `skill_set_enabled {id, name, enabled}` — persist a skill's enabled state by
 *  writing an exclusion pattern, so the app and `pi config` share one source of
 *  truth. Answered with `skill_set_enabled_ok`. */
export interface SkillSetEnabledRequest extends ClientMessage {
  type: "skill_set_enabled";
  name: string;
  enabled: boolean;
}

/** `skill_set_enabled_ok {in_reply_to, name, enabled}` — the pattern was written. */
export interface SkillSetEnabledOk extends ServerMessage {
  type: "skill_set_enabled_ok";
  name: string;
  enabled: boolean;
}

/** `package_remove {id, source, scope?}` / `package_update {id, source?}`.
 *  `package_install` is deliberately NOT modelled: it sends third-party code
 *  into the host's Pi and requires `confirm_third_party`, so the web client
 *  does not offer it rather than offering it half-safely. */
export interface PackageRemoveRequest extends ClientMessage {
  type: "package_remove";
  source: string;
  scope?: "user" | "project";
}

export interface PackageUpdateRequest extends ClientMessage {
  type: "package_update";
  source?: string;
}

/** `package_op_ok {in_reply_to, op, source, scope}` — one shared ack for the
 *  three package operations. */
export interface PackageOpOk extends ServerMessage {
  type: "package_op_ok";
  op: "install" | "remove" | "update" | "set_enabled";
  source: string;
  scope: "user" | "project" | null;
}

/** Guard for `skill_set_enabled_ok`: both echoed fields are mandatory. */
export function isSkillSetEnabledOk(value: unknown): value is SkillSetEnabledOk {
  if (!isServerMessage(value) || value.type !== "skill_set_enabled_ok") return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && v.name !== "" && typeof v.enabled === "boolean";
}

/** Guard for `package_op_ok`: the op must be one of the closed vocabulary. */
export function isPackageOpOk(value: unknown): value is PackageOpOk {
  if (!isServerMessage(value) || value.type !== "package_op_ok") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "install" || v.op === "remove" || v.op === "update" || v.op === "set_enabled") &&
    typeof v.source === "string" &&
    (v.scope === "user" || v.scope === "project" || v.scope === null)
  );
}

/** Strict per-entry check for a skill row: every documented field, correct
 *  type. `enabled` is deliberately `boolean | null` (null = undetermined, not
 *  false). */
export function isWireSkill(value: unknown): value is WireSkill {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.name === "string" && value.name !== "" &&
    typeof value.description === "string" &&
    typeof value.path === "string" &&
    (value.source === "user" || value.source === "project" || value.source === "package") &&
    (typeof value.enabled === "boolean" || value.enabled === null) &&
    typeof value.disable_model_invocation === "boolean"
  );
}

/** `pi_surface_ok` guard: the reply type plus an all-valid skill list.
 *  `packages` is validated only when PRESENT — see `PiSurfaceOk`. */
export function isPiSurfaceOk(value: unknown): value is PiSurfaceOk {
  if (!isServerMessage(value) || value.type !== "pi_surface_ok") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.skills) || !v.skills.every(isWireSkill)) return false;
  if (v.packages !== undefined) {
    if (!Array.isArray(v.packages) || !v.packages.every(isWirePackage)) return false;
  }
  return true;
}

/** `skill_invoke_ok` guard: the echoed skill name must be a non-blank string. */
export function isSkillInvokeOk(value: unknown): value is SkillInvokeOk {
  if (!isServerMessage(value) || value.type !== "skill_invoke_ok") return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && v.name !== "";
}

// ── tool cards (Pi broadcasts these; host fans out as host_message) ───────

/**
 * `tool_request {tool_call_id, tool, args}` — Pi announcing a tool call it is
 * about to run. `args` is host/Pi-supplied and therefore RENDERED AS TEXT
 * (JSON.stringify) and never interpreted, never spread into a component.
 */
export interface ToolRequestMsg extends ServerMessage {
  type: "tool_request";
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** `tool_result {tool_call_id, result?, error?}` — the matching outcome. The
 *  raw `result` is untrusted and is shown as text at most; `error` is a flag
 *  for the UI, and its text is never rendered verbatim. */
export interface ToolResultMsg extends ServerMessage {
  type: "tool_result";
  tool_call_id: string;
  result?: unknown;
  error?: string;
}

/** Strict guards: a tool frame is accepted only with the documented fields of
 *  the right types. `args` must be a plain object (never an array/primitive),
 *  so the UI cannot be handed something it would have to coerce. */
export function isToolRequestMsg(value: unknown): value is ToolRequestMsg {
  if (!isServerMessage(value) || value.type !== "tool_request") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tool_call_id === "string" &&
    v.tool_call_id !== "" &&
    typeof v.tool === "string" &&
    v.tool !== "" &&
    isJsonObject(v.args)
  );
}

export function isToolResultMsg(value: unknown): value is ToolResultMsg {
  if (!isServerMessage(value) || value.type !== "tool_result") return false;
  const v = value as Record<string, unknown>;
  return typeof v.tool_call_id === "string" && v.tool_call_id !== "";
}

// ── inline image attachment (plan/30) ──────────────────────────────────────

/** `WireImage {data, mime}` — base64 bytes inline in `user_message`. */
export interface WireImage {
  data: string;
  mime: string;
}

export function isWireImage(value: unknown): value is WireImage {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.data === "string" &&
    value.data !== "" &&
    typeof value.mime === "string" &&
    value.mime.startsWith("image/")
  );
}

/** Inline images per message: the plan/30 wire allows a list, the shipped app
 *  sends one. The client keeps the same bound so a hostile host cannot make it
 *  render an unbounded number of images from one echo. */
export const MAX_INLINE_IMAGES = 1;

/** Typed guard for the `images` field of a `user_message` echo. */
export function isWireImageList(value: unknown): value is WireImage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_INLINE_IMAGES &&
    value.every(isWireImage)
  );
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

/** `action_error` codes documented in PROTOCOL.md (plan 68 errors table).
 *  These are the codes with a FIXED client-authored message. The host does
 *  also emit free-text `error` values (e.g. a wrapped exception); those keep
 *  their `code` for programmatic branching but NEVER reach the message. */
export type FsErrorCode =
  | "not_found"
  | "not_a_directory"
  | "permission_denied"
  | "spawn_failed"
  /* plan/77 — fs_read refusals. `not_allowed` is the allowlist fence saying no;
     `not_a_file` is a directory where a document was expected. */
  | "not_allowed"
  | "not_a_file";

/** Fixed text per allow-listed `action_error` code. */
export const ACTION_ERROR_MESSAGES: Readonly<Record<FsErrorCode, string>> = {
  not_found: "Path not found.",
  not_a_directory: "Path is not a directory.",
  permission_denied: "The host cannot read this path.",
  spawn_failed: "The host could not start this workspace.",
  not_allowed: "The host refused to read this file.",
  not_a_file: "That path is not a file.",
};

/** Text used for any `action_error` code outside the allow-list. */
export const ACTION_ERROR_FALLBACK = "The host rejected this action.";

export function isFsErrorCode(value: unknown): value is FsErrorCode {
  return (
    value === "not_found" || value === "not_a_directory" ||
    value === "permission_denied" || value === "spawn_failed" ||
    value === "not_allowed" || value === "not_a_file"
  );
}

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  return typeof value === "string" && (WORKSPACE_STATES as readonly string[]).includes(value);
}

export function isWorkspaceRestartErrorCode(value: unknown): value is WorkspaceRestartErrorCode {
  return typeof value === "string" &&
    (WORKSPACE_RESTART_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Typed restart rejection. BOTH parts are client-authored: `code` is an
 * allow-listed `workspace_restart_error` code (or `"unknown"`) and the
 * message pairs the frozen label with the fixed text for that code. The
 * host's raw `message` — which embeds the cwd — is never stored on the
 * exception nor interpolated anywhere, mirroring `ActionRejectedError`.
 */
export class WorkspaceRestartRejectedError extends Error {
  readonly code: WorkspaceRestartErrorCode | "unknown";
  /** Client-authored text — never derived from the host's `message`. */
  readonly safeMessage: string;

  constructor(error: unknown) {
    const code: WorkspaceRestartErrorCode | "unknown" =
      isWorkspaceRestartErrorCode(error) ? error : "unknown";
    const safe =
      code === "unknown" ? WORKSPACE_RESTART_ERROR_FALLBACK : WORKSPACE_RESTART_ERROR_MESSAGES[code];
    super(`workspace_restart rejected: ${safe}`);
    this.name = "WorkspaceRestartRejectedError";
    this.code = code;
    this.safeMessage = safe;
  }

  /** Builds a rejection from a wire `workspace_restart_error`: only `code` is
   *  trusted (the raw `message` is dropped on the floor). */
  static fromRestartError(message: unknown): WorkspaceRestartRejectedError {
    return new WorkspaceRestartRejectedError(isJsonObject(message) ? message.code : undefined);
  }
}

/** `code` kept on an `ActionRejectedError`: a documented code, or the fixed
 *  `unknown` label for anything else. Consumers render `.code` (the container
 *  does), so the host's raw string is NEVER retained there. */
export type ActionErrorCode = FsErrorCode | "unknown";

/** Actions this client can legitimately address an `action_error` to. Only
 *  these names may appear in the message: a hostile host naming its own
 *  action (or smuggling a token/path there) gets the generic label. */
export const SAFE_ACTION_NAMES = [
  "fs_list",
  "fs_read",
  "workspace_list",
  "workspace_start",
  "workspace_add",
  "workspace_restart",
  "host_hello",
] as const;

export type SafeActionName = (typeof SAFE_ACTION_NAMES)[number];

export function isSafeActionName(value: unknown): value is SafeActionName {
  return typeof value === "string" && (SAFE_ACTION_NAMES as readonly string[]).includes(value);
}

/**
 * Typed action rejection. BOTH parts are client-authored: `code` is an
 * allow-listed `action_error` code (or `"unknown"`) and the message pairs an
 * allow-listed action with the fixed text for that code. A host echoing a
 * path, a token or markup into `error` — or naming its own `action` — cannot
 * reach the UI through the message or through `code`: nothing from the wire
 * is stored on the exception.
 */
export class ActionRejectedError extends Error {
  readonly code: ActionErrorCode;
  /** Allow-listed action the rejection is attributed to, or `"action"`. */
  readonly action: SafeActionName | "action";
  /** Client-authored text — never derived from the host's `error` string. */
  readonly safeMessage: string;

  constructor(action: unknown, error: unknown) {
    const safeAction: SafeActionName | "action" = isSafeActionName(action) ? action : "action";
    const code: ActionErrorCode = isFsErrorCode(error) ? error : "unknown";
    const safe = code === "unknown" ? ACTION_ERROR_FALLBACK : ACTION_ERROR_MESSAGES[code];
    super(`${safeAction} rejected: ${safe}`);
    this.name = "ActionRejectedError";
    this.code = code;
    this.action = safeAction;
    this.safeMessage = safe;
  }
}

/** Canonical `pair_request` (PROTOCOL.md step 3) — `{type, id, token,
 *  device_name}`. No `sig`/`owner_pk`/`signature`: the token authorizes. */
export interface PairRequest extends ClientMessage {
  type: "pair_request";
  token: string;
  device_name: string;
}

/** `pair_error` as sent by the host (server/src/protocol/types.ts). */
export interface PairError extends ServerMessage {
  type: "pair_error";
  code: string;
  message: string;
}

// ── runtime guards (no cast crashes on hostile/unknown payloads) ────────────
//
// A wire frame is untrusted input: `JSON.parse(...) as T` turns a null, a
// string or a missing field into a crash somewhere far from the boundary. The
// transport validates with these guards instead — a failed guard is a refusal,
// never a property access.

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

/** A field that may be ABSENT, but when present must be a string. A wrong
 *  type on an optional field is a malformed frame, not a value to ignore. */
function optionalString(value: Record<string, unknown>, field: string): boolean {
  return !(field in value) || typeof value[field] === "string";
}

/** `Date.now()`-style epoch: a finite number (`NaN`/`±Infinity` refused). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const WORKSPACE_SOURCES: readonly string[] = ["daemon", "added"];
const FS_ENTRY_KINDS: readonly string[] = ["dir", "file"];

/** Strict outer envelope: EXACTLY `{peer, room, ct}`, all strings. */
export function isOuterEnvelope(value: unknown): value is OuterEnvelope {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  return keys.every((key) => key === "peer" || key === "room" || key === "ct") &&
    hasStringFields(value, ["peer", "room", "ct"]);
}

/** Relay auth frame `{type: "auth", sig}` — NO `id` (relay/src/auth). */
export interface RelayAuthFrame {
  type: "auth";
  sig: string;
}

export function isRelayAuthFrame(value: unknown): value is RelayAuthFrame {
  if (!isJsonObject(value)) return false;
  return value.type === "auth" && typeof value.sig === "string" && !("id" in value);
}

/** Minimal acceptance for any inner message: an object with a string `type`
 *  and an `in_reply_to` that is either absent or a string (a numeric/null
 *  correlation id can never be matched, so the frame is refused here). */
export function isServerMessage(value: unknown): value is ServerMessage {
  return isJsonObject(value) && typeof value.type === "string" &&
    optionalString(value, "in_reply_to");
}

export function isClientMessage(value: unknown): value is ClientMessage {
  return isJsonObject(value) && typeof value.type === "string" && typeof value.id === "string";
}

/** `host_message {room, ct}` — proxy envelope, both fields required strings. */
export function isHostMessage(value: unknown): value is HostMessage {
  return isServerMessage(value) && value.type === "host_message" &&
    hasStringFields(value as Record<string, unknown>, ["room", "ct"]);
}

export function isPairRequest(value: unknown): value is PairRequest {
  return isJsonObject(value) && value.type === "pair_request" &&
    hasStringFields(value, ["id", "token", "device_name"]);
}

export function isPairOk(value: unknown): value is PairOk {
  if (!isServerMessage(value) || value.type !== "pair_ok") return false;
  const v = value as Record<string, unknown>;
  return hasStringFields(v, ["session_name", "room_id"]) &&
    isFiniteNumber(v.session_started_at) &&
    (!("hostname" in v) || typeof v.hostname === "string");
}

export function isPairError(value: unknown): value is PairError {
  return isServerMessage(value) && value.type === "pair_error" &&
    hasStringFields(value as Record<string, unknown>, ["code", "message"]);
}

export function isHostHelloOk(value: unknown): value is HostHelloOk {
  if (!isServerMessage(value) || value.type !== "host_hello_ok") return false;
  const v = value as Record<string, unknown>;
  return isJsonObject(v.daemon) &&
    hasStringFields(v.daemon, ["version", "hostname", "platform"]) &&
    Array.isArray(v.capabilities) && v.capabilities.every((c) => typeof c === "string");
}

/** Workspace entries: the `source` discriminator is a CLOSED enum (an
 *  unknown source is not a workspace this client can reason about), and the
 *  two booleans must be booleans — `"true"`/`1` are refused. */
export function isWorkspaceListOk(value: unknown): value is WorkspaceListOk {
  if (!isServerMessage(value) || value.type !== "workspace_list_ok") return false;
  const workspaces = (value as Record<string, unknown>).workspaces;
  return Array.isArray(workspaces) && workspaces.every((entry) =>
    isJsonObject(entry) &&
    hasStringFields(entry, ["cwd", "daemon_id", "room_id", "name"]) &&
    typeof entry.source === "string" && WORKSPACE_SOURCES.includes(entry.source) &&
    typeof entry.live === "boolean" && typeof entry.daemon === "boolean",
  );
}

/** FS entries: `kind` is a CLOSED enum (`dir`/`file`), and the optional
 *  `is_repo` hint must be a boolean when present. */
export function isFsListOk(value: unknown): value is FsListOk {
  if (!isServerMessage(value) || value.type !== "fs_list_ok") return false;
  const v = value as Record<string, unknown>;
  const parentOk = v.parent === null || typeof v.parent === "string";
  return typeof v.path === "string" && parentOk && Array.isArray(v.entries) &&
    v.entries.every((entry) =>
      isJsonObject(entry) && typeof entry.name === "string" &&
      typeof entry.kind === "string" && FS_ENTRY_KINDS.includes(entry.kind) &&
      (!("is_repo" in entry) || typeof entry.is_repo === "boolean"),
    );
}

export function isFsReadOk(value: unknown): value is FsReadOk {
  if (!isServerMessage(value) || value.type !== "fs_read_ok") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    typeof v.content === "string" &&
    typeof v.truncated === "boolean" &&
    typeof v.bytes === "number" &&
    Number.isFinite(v.bytes)
  );
}

/**
 * Validates a Changes snapshot before it can reach the panel.
 *
 * Strict on purpose: the whole point of this surface is that it tells the truth
 * about a worktree, so a malformed entry must fail closed rather than render a
 * half-understood row. `rel` is additionally refused when it looks absolute —
 * that is the one field that could leak the host's directory layout, and catching
 * it here means a host bug cannot turn into a path disclosure.
 */
export function isChangesSnapshotOk(value: unknown): value is ChangesSnapshotOk {
  if (!isServerMessage(value) || value.type !== "changes_snapshot_ok") return false;
  /* The payload lives under `snapshot`, NOT on the envelope. Reading the
   * envelope as if it were the snapshot silently rejects every real frame
   * (measured: the panel showed "could not read" while the host was
   * answering correctly on every field). */
  const snap = (value as Record<string, unknown>).snapshot;
  if (!isJsonObject(snap)) return false;
  if (snap.is_repo !== true) return false;
  const maybeString = (x: unknown): boolean => x === null || typeof x === "string";
  const maybeNum = (x: unknown): boolean => x === null || (typeof x === "number" && Number.isFinite(x));
  if (!maybeString(snap.branch) || !maybeNum(snap.ahead) || !maybeNum(snap.behind)) return false;
  if (snap.head !== null) {
    if (!isJsonObject(snap.head)) return false;
    if (typeof snap.head.sha7 !== "string" || typeof snap.head.subject !== "string") return false;
  }
  if (typeof snap.truncated !== "boolean") return false;
  const total = snap.total;
  if (!isJsonObject(total)) return false;
  for (const k of ["staged", "unstaged", "untracked", "conflicted"]) {
    const n = total[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false;
  }
  if (!Array.isArray(snap.entries)) return false;
  return snap.entries.every((e) => {
    if (!isJsonObject(e)) return false;
    if (typeof e.rel !== "string" || e.rel === "") return false;
    /* Refuse an absolute or drive-qualified path outright: `rel` is the one
     * field that could disclose the host's directory layout, so a host bug
     * cannot turn into a path leak. */
    if (e.rel.startsWith("/") || /^[A-Za-z]:/.test(e.rel) || e.rel.startsWith("\\")) return false;
    /* `..` is harmless while this path is only ever RENDERED, but this guard is
     * the gate any future "open this file" or "show this diff" action must pass
     * through. Rejecting traversal here means such a feature cannot be added by
     * accident without clearing this fence first. A NUL is refused because it
     * truncates paths in most native layers. */
    if (e.rel.includes("\u0000")) return false;
    if (e.rel.split("/").includes("..")) return false;
    if (typeof e.x !== "string" || e.x.length !== 1) return false;
    if (typeof e.y !== "string" || e.y.length !== 1) return false;
    if (typeof e.renamed !== "boolean") return false;
    return true;
  });
}
/** Validates the failure frame. The reason must be one of the closed set, so an
 *  unknown value cannot smuggle host prose into a client-authored sentence. */
export function isChangesSnapshotUnavailable(value: unknown): value is ChangesSnapshotUnavailable {
  if (!isServerMessage(value) || value.type !== "changes_snapshot_unavailable") return false;
  const reason = (value as Record<string, unknown>).reason;
  return reason === "not_a_repo" || reason === "git_missing" || reason === "timeout" ||
    reason === "workspace_missing" || reason === "unreadable";
}

/**
 * Validates the models-config describe payload — and REFUSES any frame that
 * carries a credential.
 *
 * The negative assertion is the point of this function. The host strips secrets
 * before serialising, but a guard that only checks shape would happily accept a
 * frame where that stripping regressed, and the key would land in the browser, the
 * DOM, and every devtools session. Re-checking here means a host-side bug cannot
 * become a client-side disclosure: the frame is rejected instead of rendered.
 *
 * `apiKey` is matched in every casing because the host's own predicate is
 * case-insensitive, so accepting a `ApiKey`-shaped field would be a gap.
 */
export function isModelsDescribeOk(value: unknown): value is ModelsDescribeOk {
  if (!isServerMessage(value) || value.type !== "models_describe_ok") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.revision !== "string" || v.revision === "") return false;
  if (!isJsonObject(v.file)) return false;
  for (const k of ["exists", "parseable", "writable", "mode_safe"]) {
    if (typeof v.file[k] !== "boolean") return false;
  }
  if (!isJsonObject(v.config)) return false;
  if (!isJsonObject(v.secrets)) return false;
  for (const entry of Object.values(v.secrets)) {
    if (!isJsonObject(entry) || typeof entry.has_key !== "boolean") return false;
  }
  /*
   * The negative fence. Serialising the config is the cheapest way to inspect every
   * nesting level at once, which is exactly what a per-field check would miss.
   *
   * It inspects `config` ONLY. An earlier version serialised the whole frame, and
   * the `secrets` keys are path strings like `providers.my-newapi.apiKey` — so the
   * honest payload matched the pattern and every real frame was rejected, leaving
   * the panel permanently empty while the host answered correctly. The fence must
   * guard the payload that could carry a VALUE, not the index that names where one
   * lives.
   */
  const wire = JSON.stringify(v.config);
  if (/api[_-]?key|"token"|"secret"|"password"/i.test(wire)) return false;
  return true;
}

export function isModelsMutateOk(value: unknown): value is ModelsMutateOk {
  if (!isServerMessage(value) || value.type !== "models_mutate_ok") return false;
  const v = value as Record<string, unknown>;
  return typeof v.revision === "string" && v.revision !== "";
}

const MODELS_ERROR_REASONS: readonly ModelsErrorReason[] = [
  "not_found", "corrupted", "permission", "conflict", "invalid", "verify_failed", "unsupported",
];

export function isModelsError(value: unknown): value is ModelsError {
  if (!isServerMessage(value) || value.type !== "models_error") return false;
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === "string" && (MODELS_ERROR_REASONS as readonly string[]).includes(reason);
}

/**
 * Validates the settings describe payload.
 *
 * The negative assertion here guards a different leak than the models one: the
 * settings FILE contains `packages` with absolute host paths and `extensions`. The
 * host projects a whitelist, but if that projection regressed the frame would carry
 * the user's directory layout. So any payload that serialises to something
 * resembling those keys, or to a path, is refused rather than rendered.
 */
export function isSettingsDescribeOk(value: unknown): value is SettingsDescribeOk {
  if (!isServerMessage(value) || value.type !== "settings_describe_ok") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.revision !== "string" || v.revision === "") return false;
  if (!isJsonObject(v.file)) return false;
  for (const k of ["exists", "parseable", "writable"]) {
    if (typeof v.file[k] !== "boolean") return false;
  }
  if (!isJsonObject(v.appearance)) return false;
  const theme = v.appearance.theme;
  if (theme !== null && typeof theme !== "string") return false;
  const hide = v.appearance.hide_thinking_block;
  if (hide !== null && typeof hide !== "boolean") return false;
  if (!isJsonObject(v.behaviour)) return false;
  for (const k of [
    "retry_enabled",
    "retry_max_retries",
    "retry_base_delay_ms",
    "retry_provider_max_retry_delay_ms",
  ]) {
    const f = v.behaviour[k];
    if (f !== null && typeof f !== "boolean" && typeof f !== "number") return false;
  }
  /* The negative fence. `packages`/`extensions` are arrays of host paths in the real
   * file; a projection regression must yield a dropped frame, not a leak. */
  const wire = JSON.stringify({ appearance: v.appearance, behaviour: v.behaviour });
  if (/packages|extensions|lastChangelogVersion/i.test(wire)) return false;
  if (/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(wire)) return false;
  return true;
}

export function isSettingsMutateOk(value: unknown): value is SettingsMutateOk {
  if (!isServerMessage(value) || value.type !== "settings_mutate_ok") return false;
  const v = value as Record<string, unknown>;
  return typeof v.revision === "string" && v.revision !== "";
}

const SETTINGS_ERROR_REASONS: readonly SettingsErrorReason[] = [
  "not_found", "corrupted", "permission", "conflict", "invalid", "invalid_field", "unsupported", "verify_failed",
];

export function isSettingsError(value: unknown): value is SettingsError {
  if (!isServerMessage(value) || value.type !== "settings_error") return false;
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === "string" && (SETTINGS_ERROR_REASONS as readonly string[]).includes(reason);
}

export function isWorkspaceStartOk(value: unknown): value is WorkspaceStartOk {
  return isServerMessage(value) && value.type === "workspace_start_ok" &&
    hasStringFields(value as Record<string, unknown>, ["cwd", "room_id", "daemon_id"]);
}

/** `action_ok`: the success counterpart of `action_error`. Only the
 *  allow-listed `action` label is ever read; nothing here is projected. */
export function isActionOk(value: unknown): value is ActionOk {
  return isServerMessage(value) && value.type === "action_ok" &&
    typeof (value as Record<string, unknown>).action === "string";
}

export function isWorkspaceRestartOk(value: unknown): value is WorkspaceRestartOk {
  return isServerMessage(value) && value.type === "workspace_restart_ok" &&
    hasStringFields(value as Record<string, unknown>, ["cwd", "daemon_id"]);
}

export function isWorkspaceRestartError(value: unknown): value is WorkspaceRestartError {
  return isServerMessage(value) && value.type === "workspace_restart_error" &&
    hasStringFields(value as Record<string, unknown>, ["code", "message"]);
}

/**
 * Strict `workspace_state` PUSH guard. A push is a frame with NO correlation:
 *  • a present `id` or `in_reply_to` key — of ANY type — is REFUSED, because a
 *    push that names a request could otherwise settle a host RPC;
 *  • `cwd` is a non-empty string, `state` is the CLOSED lifecycle enum,
 *    `last_error` is `null` or a string, `restarts` a non-negative integer;
 *  • unknown extra keys are tolerated (they are never projected) — the five
 *    documented fields are the contract.
 */
export function isWorkspaceStatePush(value: unknown): value is WorkspaceStatePush {
  if (!isJsonObject(value)) return false;
  if (value.type !== "workspace_state") return false;
  if ("id" in value || "in_reply_to" in value) return false;
  if (typeof value.cwd !== "string" || value.cwd === "") return false;
  if (!isWorkspaceState(value.state)) return false;
  if (value.last_error !== null && typeof value.last_error !== "string") return false;
  return typeof value.restarts === "number" && Number.isInteger(value.restarts) && value.restarts >= 0;
}

/**
 * Strict `schedule_fired` PUSH guard.
 *
 * Mirrors `isWorkspaceStatePush` for the same reason: a push that carried an
 * `id`/`in_reply_to` could settle a pending host RPC it has nothing to do with.
 * Beyond that it enforces the two facts the UI would otherwise render wrong —
 * a result inside the closed vocabulary, and a preview that is actually a
 * string (an absent preview must not become the literal "undefined").
 */
export function isScheduleFiredPush(value: unknown): value is ScheduleFiredPush {
  if (!isJsonObject(value)) return false;
  if (value.type !== "schedule_fired") return false;
  if ("id" in value || "in_reply_to" in value) return false;
  if (typeof value.job_id !== "string" || value.job_id === "") return false;
  if (typeof value.daemon_id !== "string" || value.daemon_id === "") return false;
  if (typeof value.result !== "string") return false;
  if (!(SCHEDULE_RESULTS as readonly string[]).includes(value.result)) return false;
  if (typeof value.fired_at !== "string" || value.fired_at === "") return false;
  return typeof value.prompt_preview === "string";
}

export function isActionError(value: unknown): value is ActionError {
  return isServerMessage(value) && value.type === "action_error" &&
    hasStringFields(value as Record<string, unknown>, ["action", "error"]);
}

/** Decodes a relay frame into a validated outer envelope + inner message.
 *  Rejects `{peer,ct}` with an extra/missing key, a non-object body, or a `ct`
 *  that does not base64-decode to a JSON object. Error text is fixed. */
export function decodeOuterChecked(text: string): DecodedEnvelope<ServerMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolFrameError("malformed_frame");
  }
  if (!isOuterEnvelope(raw)) throw new ProtocolFrameError("malformed_envelope");
  const inner = decodeCtChecked(raw.ct);
  return { fromPeer: raw.peer, fromRoom: raw.room, inner };
}

/** Validated counterpart of `decodeCt` (which stays the generic primitive):
 *  the `ct` payload must decode to an object carrying a string `type`. */
export function decodeCtChecked(ct: string): ServerMessage {
  if (typeof ct !== "string" || ct === "") throw new ProtocolFrameError("malformed_ct");
  let inner: unknown;
  try {
    inner = decodeCt<unknown>(ct);
  } catch {
    throw new ProtocolFrameError("malformed_ct");
  }
  if (!isServerMessage(inner)) throw new ProtocolFrameError("malformed_ct");
  return inner;
}

/** Fixed-text transport refusal — never carries wire content. */
export type ProtocolFrameErrorCode =
  | "malformed_frame"
  | "malformed_envelope"
  | "malformed_ct"
  | "unexpected_reply";

export class ProtocolFrameError extends Error {
  readonly code: ProtocolFrameErrorCode;

  constructor(code: ProtocolFrameErrorCode) {
    super(code === "unexpected_reply" ? "unexpected reply from host" : "malformed protocol frame");
    this.name = "ProtocolFrameError";
    this.code = code;
  }
}
