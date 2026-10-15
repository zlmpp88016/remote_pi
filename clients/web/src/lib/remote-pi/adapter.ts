/**
 * Wave 2 connection adapter (plan 69 W4) — the SINGLE owner of the web
 * client's connection lifecycle. Nothing here renders: the container (Wave 3)
 * subscribes, calls `restore()`/`pair()` and reads a typed snapshot.
 *
 * Invariants this file exists to hold:
 *   • ONE credential is private (`token` + host epk live ONLY here). The
 *     public snapshot carries the phase/counters, a sanitized diagnostic, the
 *     host hello, the workspace catalog, the backend, a FIXED warning and a
 *     pairing summary of NAME + RELAY — never a token, key, pending request or
 *     transcript. Nothing from the wire is echoed: every message is
 *     client-authored and fixed.
 *   • ONE flow per generation: `connect() → pair() → host_hello →
 *     workspace_list → connected` on the HOST room only, for the FIRST pair,
 *     for `restore()` and for EVERY reconnect (an ephemeral key is created per
 *     attempt; the token's mode is unknown, so a restore re-pairs instead of
 *     assuming the old key or a one-shot token).
 *   • A private `sequence` guard makes superseded async inert: a late
 *     signer/pair/save can neither publish a state nor WRITE STORAGE.
 *   • Persistence is strict (the five-field record of `persistence.ts`), read
 *     lazily and never at module scope; a write is only reported as saved when
 *     it landed, and a failed write leaves the connection standing with a
 *     visible unsaved warning.
 *   • TWO pairing views, and only one of them is a storage claim. `paired` is
 *     the LIVE secret-free identity (published by a completed explicit pair,
 *     or for the whole attempt by a restore/retry re-establishing it), used
 *     for host labels/relay runtime. `storedPairing` is the "Stored pairing"
 *     the UI advertises: it exists ONLY after a validated load from storage or
 *     a CONFIRMED save/readback, so a merely ATTEMPTED pair advertises
 *     nothing, an unsaved live pairing stays live-only, and an unrelated
 *     failed attempt keeps the old stored claim. A connect/auth/host/list
 *     failure therefore neither advertises a pairing that was never written
 *     nor removes the record it did not write.
 *   • An unexpected drop of a LIVE connection is the only automatic retry:
 *     finite exponential backoff, full new flow per attempt, budget reset on
 *     success, `retry_exhausted` when spent. Child-room pushes never act.
 *   • `close()` is an explicit forget/unpair (memory first, then storage) and
 *     terminal; `dispose()` releases resources and stops notifying while the
 *     stored pairing stays on disk for the next mount.
 */

import {
  RemotePiWebClient,
  TransportError,
  type TransportCloseCode,
  type TransportDiagnosticCode,
  type TransportTimeouts,
  type WebSocketFactory,
} from "./client.ts";
import type { Ed25519Backend, Ed25519Signer } from "./ed25519.ts";
import {
  ActionRejectedError,
  HOST_WEB_ROOM_ID,
  PairRejectedError,
  isModelsListOk,
  isWorkspaceStatePush,
  normalizeRelayUrl,
  type FsListOk,
  type HostHelloOk,
  type PairOk,
  type PairRejectionCode,
  type PairTarget,
  type ServerMessage,
  type WorkspaceEntry,
  type WorkspaceListOk,
  type WorkspaceRestartOk,
  type WorkspaceStartOk,
  type WorkspaceState,
  type WorkspaceStatePush,
  type ThinkingLevel,
  type WireImage,
  type WireModel,
} from "./protocol.ts";
import {
  SESSION_STORAGE_KEY,
  SessionPersistenceError,
  browserSessionStorage,
  clearStoredSession,
  isSessionPersistenceError,
  loadStoredSession,
  parseStoredSession,
  parseStoredSessionJson,
  saveStoredSession,
  type StorageLike,
  type StoredSession,
} from "./persistence.ts";
import {
  ModelCatalogueCache,
  catalogueKey,
  catalogueScope,
  MODEL_CACHE_TTL_MS,
} from "./model-cache.ts";
import {
  createConnectionState,
  reduceConnectionState,
  type ConnectionEvent,
  type ConnectionPhase,
  type ConnectionState,
  type PublicDiagnostic,
  type PublicDiagnosticCode,
} from "./state.ts";

// ── fixed, client-authored text ────────────────────────────────────────────

/** Fixed, client-authored persistence warnings. `code` is a typed label;
 *  `message` comes from the table below — a storage exception is never echoed. */
export type AdapterWarningCode =
  | "session_unavailable"
  | "session_unreadable"
  | "session_invalid"
  | "session_unsaved"
  | "session_not_cleared";

export interface AdapterWarning {
  code: AdapterWarningCode;
  message: string;
}

const ADAPTER_WARNING_MESSAGES: Readonly<Record<AdapterWarningCode, string>> = {
  session_unavailable: "Local storage is unavailable in this browser.",
  session_unreadable: "Could not read the saved session.",
  session_invalid: "The saved session is invalid and was discarded.",
  session_unsaved: "Could not save the session.",
  session_not_cleared: "Could not delete the saved session.",
};

export type AdapterStateErrorCode =
  | "disabled"
  | "closed"
  | "disposed"
  | "not_connected"
  | "superseded"
  | "relay_unselected";

const ADAPTER_STATE_MESSAGES: Readonly<Record<AdapterStateErrorCode, string>> = {
  disabled: "the web client is disabled on this deployment",
  closed: "the adapter was closed; pair again to reconnect",
  disposed: "the adapter was disposed",
  not_connected: "the adapter is not connected",
  superseded: "a newer connection replaced this one",
  relay_unselected: "no relay address was selected",
};

/** Refusal of a call the lifecycle does not allow right now. */
export class AdapterStateError extends Error {
  readonly code: AdapterStateErrorCode;

  constructor(code: AdapterStateErrorCode) {
    super(ADAPTER_STATE_MESSAGES[code]);
    this.name = "AdapterStateError";
    this.code = code;
  }
}

// ── public snapshot ────────────────────────────────────────────────────────

/**
 * Wave 3 — TYPED PUBLIC projection of the `workspace_state` push.
 *
 * The wire shape (`WorkspaceStatePush`) is deliberately NOT the public shape:
 * view fields and wire fields are separate types here. `last_error` becomes a
 * BOOLEAN flag (`hasError`) because the raw text embeds host paths and is
 * never renderable, and neither `in_reply_to` nor any extra key can exist on
 * this type. `restarts` is mirrored. A malformed push never produces an
 * entry at all — the adapter re-validates and drops it.
 *
 * `live=true` means the host reports `running`. `live=false` is NOT proof of
 * a stopped process: it means "not running" (a `stopped` frame, a `crashed`
 * restart, or a still-`starting` Pi). The wire `state` is kept so a UI that
 * needs the distinction does not have to invent it.
 */
export interface WorkspaceChildState {
  state: WorkspaceState;
  live: boolean;
  hasError: boolean;
  restarts: number;
}

/** What a container may read. Serializable and SECRET-FREE by construction. */
export interface AdapterSnapshot {
  phase: ConnectionPhase;
  /** State-machine generation (a new socket sequence). */
  generation: number;
  /** Attempts used in the current generation (reconnects included). */
  attempt: number;
  since: number;
  /** Fixed code + fixed text, or null. */
  diagnostic: PublicDiagnostic | null;
  /** `host_hello_ok` public fields (version/hostname/platform/capabilities). */
  host: HostHelloOk | null;
  /** Catalog rows (seven documented fields each). `live` here is the state at
   *  LIST time — never a fabricated crash detail. */
  workspaces: WorkspaceEntry[] | null;
  /** Child lifecycle observed since the last catalog list, keyed by the EXACT
   *  canonical cwd of a catalog row. A push for an unknown cwd is dropped and
   *  never invents a row, and a row that re-appears at the SAME cwd under a new
   *  `daemon_id`/`room_id` starts from scratch (the previous generation's
   *  badge is dropped, never inherited). `null` while nothing was observed. */
  workspaceStates: Record<string, WorkspaceChildState> | null;
  backend: Ed25519Backend | null;
  /** LIVE pairing identity — NAME + RELAY only — for host labels and relay
   *  runtime. Published by a COMPLETED explicit pair, or for the whole attempt
   *  by a restore/retry re-establishing what the disk already holds. This is
   *  NOT a storage claim: an unsaved live pairing is still published here. */
  paired: { name: string; relayUrl: string } | null;
  /** The "Stored pairing" the launcher advertises — NAME + RELAY only. Set
   *  ONLY after a validated load from storage or a confirmed save/readback, so
   *  it stays null while an initial explicit pair could not persist and keeps
   *  its old value when a truly unrelated attempt fails. Never a token/key. */
  storedPairing: { name: string; relayUrl: string } | null;
  /** Latest fixed storage warning (e.g. an unsaved pairing) or null. */
  warning: AdapterWarning | null;
}

// ── transport seam (real client by default, a double in tests) ─────────────

/** The slice of `RemotePiWebClient` the adapter drives. Structural, so a test
 *  double is a legal implementation; the default factory builds the real one. */
export interface RemotePiTransport {
  connect(): Promise<void>;
  pair(target: PairTarget): Promise<PairOk>;
  helloHost(hostEpk: string, roomId?: string): Promise<HostHelloOk>;
  listWorkspaces(hostEpk: string, roomId?: string): Promise<WorkspaceListOk>;
  fsList(
    hostEpk: string,
    path: string,
    options?: { showHidden?: boolean; roomId?: string },
  ): Promise<FsListOk>;
  startWorkspace(hostEpk: string, cwd: string, roomId?: string): Promise<WorkspaceStartOk>;
  restartWorkspace(hostEpk: string, cwd: string, roomId?: string): Promise<WorkspaceRestartOk>;
  addWorkspace(hostEpk: string, path: string, roomId?: string): Promise<void>;
  /** OPTIONAL: the real client routes `workspace_state` pushes here. A double
   *  that omits it simply receives no lifecycle state. */
  onWorkspaceState?(listener: (push: WorkspaceStatePush) => void): () => void;
  sendChat(hostEpk: string, roomId: string, text: string, images?: readonly WireImage[]): string;
  /** Model surface (PROTOCOL.md "App actions"), proxied like chat: the
   *  request is addressed to the child room and the reply arrives through
   *  `onServerMessage` with that room. Each returns the inner request id. */
  sendListModels(hostEpk: string, roomId: string): string;
  sendModelSet(hostEpk: string, roomId: string, provider: string, modelId: string): string;
  sendThinkingSet(hostEpk: string, roomId: string, level: ThinkingLevel): string;
  /** Plan/68 Pi surface: `pi_surface` → `pi_surface_ok`, `skill_invoke` →
   *  `skill_invoke_ok` | `action_error`. Proxied to the child room like chat. */
  sendPiSurface(hostEpk: string, roomId: string): string;
  sendSkillInvoke(hostEpk: string, roomId: string, name: string, args?: string): string;
  /** Plan/67 + 71 sessions: `session_list` → `session_list_ok`, and
   *  `session_read` → `session_read_ok` (read-only, no switch). */
  sendSessionList(hostEpk: string, roomId: string): string;
  sendSessionRead(
    hostEpk: string,
    roomId: string,
    sessionId: string,
    options?: { limit?: number; before?: string },
  ): string;
  sendSessionSwitch(hostEpk: string, roomId: string, sessionId: string): string;
  onServerMessage(listener: (msg: ServerMessage, room: string) => void): () => void;
  onClose(listener: (code: TransportCloseCode) => void): () => void;
  /** OPTIONAL: the real client has it; a structural double may omit it. The
   *  adapter forwards these fixed codes and never reads a payload from them. */
  onDiagnostic?(listener: (code: TransportDiagnosticCode) => void): () => void;
  close(): void;
  readonly connected: boolean;
  readonly backend: Ed25519Backend;
}

export type TransportFactory = (relayUrl: string) => RemotePiTransport;

// ── retry policy ───────────────────────────────────────────────────────────

/** Finite budget for an unexpected drop of a LIVE connection. */
export interface RetryPolicy {
  /** Retry attempts allowed after one drop (0 disables reconnecting). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

// ── options ────────────────────────────────────────────────────────────────

export interface RemotePiAdapterOptions {
  /** Default relay. OPTIONAL: empty/absent means "no relay selected" — the
   *  constructor performs NO I/O and `pair()` then needs an override or a
   *  code `r=`; without one it refuses with a fixed error instead of dialing
   *  a hardcoded host. */
  relayUrl?: string;
  /** Route gate (plan 69 W4): `false` pins the phase at `disabled` and every
   *  lifecycle call is refused — the adapter cannot bypass the gate. */
  enabled?: boolean;
  deviceName?: string;
  timeouts?: Partial<TransportTimeouts>;
  webSocketFactory?: WebSocketFactory;
  forceBackend?: Ed25519Backend;
  signerFactory?: () => Promise<Ed25519Signer>;
  /** Injected persistence. `undefined` (default) resolves browser storage
   *  LAZILY on first use — never in the constructor, never at module scope. */
  storage?: StorageLike | null;
  /** Test/diagnostic client injection (defaults to the real client). */
  transportFactory?: TransportFactory;
  retry?: Partial<RetryPolicy>;
  now?: () => number;
}

/** Phases from which `restore()` may start a sequence. */
const RESTORABLE_PHASES: readonly ConnectionPhase[] = ["idle", "error"];

const TOKEN_REJECTION_CODES: readonly PairRejectionCode[] = [
  "token_unknown",
  "token_expired",
  "token_consumed",
];

const MAX_CHILD_STATES = 256;

/** Separator for the internal identity key. `daemon_id`/`room_id` are opaque
 *  host strings, so a separator that cannot appear in either keeps
 *  `("a","b\u0000c")` distinct from `("a\u0000b","c")`. */
const CHILD_IDENTITY_SEPARATOR = "\u0000";

/** Internal observation record: the four PUBLIC view fields PLUS the identity
 *  of the catalog row (`daemon_id` + `room_id`) it was observed against. It
 *  lives in the SAME map as the view on purpose — every path that clears or
 *  prunes the map therefore clears the identity bookkeeping too, so a new
 *  daemon/room generation at one cwd can never inherit an old badge, and
 *  nothing observed on a previous socket survives a new generation. The
 *  identity field is NEVER projected into a snapshot. */
interface ObservedChildState extends WorkspaceChildState {
  readonly identity: string;
}

/** Outcome of a NON-destructive read of the current stored record. */
type CurrentStoredRecord =
  | { readonly state: "record"; readonly raw: string; readonly session: StoredSession }
  | { readonly state: "absent" }
  | { readonly state: "unknown" };

/** Identity of a catalog row: exactly the two fields the host uses to name a
 *  child lifecycle at a given cwd. */
function childIdentityOf(row: WorkspaceEntry): string {
  return `${row.daemon_id}${CHILD_IDENTITY_SEPARATOR}${row.room_id}`;
}

/** Coalescing window for a push-driven catalog invalidation: a burst of
 *  lifecycle frames (spawn → running, exit → crashed → spawn) becomes ONE
 *  relist. It is a timer, never a loop: a push schedules at most one pending
 *  refresh and a later push reuses it. */
const CATALOG_INVALIDATE_MS = 250;

function warningOf(err: unknown): AdapterWarningCode {
  if (!isSessionPersistenceError(err)) return "session_unavailable";
  switch (err.code) {
    case "storage_read_failed":
      return "session_unreadable";
    case "invalid_record":
      return "session_invalid";
    case "storage_write_failed":
      return "session_unsaved";
    case "storage_remove_failed":
      return "session_not_cleared";
    default:
      return "session_unavailable";
  }
}

/** Maps a transport/flow failure onto a FIXED public diagnostic code. */
function mapTransportFailure(err: unknown): PublicDiagnosticCode {
  if (err instanceof TransportError) {
    switch (err.code) {
      case "connect_timeout":
      case "connect_failed":
      case "challenge_timeout":
        return "relay_unreachable";
      case "malformed_challenge":
      case "auth_rejected":
      case "signer_timeout":
        return "relay_auth_failed";
      case "request_timeout":
        return "host_timeout";
      case "connection_lost":
        return "connection_lost";
      default:
        return "unexpected";
    }
  }
  if (err instanceof ActionRejectedError) return "host_refused";
  return "unexpected";
}

/** Field-by-field identity of two stored credentials: host epk, room, relay
 *  AND token. The NAME is display-only, so a re-typed/renamed paste of the same
 *  host+token+relay is the SAME identity. Compared here, inside the adapter:
 *  the token never leaves this class through any projection. */
function sameStoredIdentity(a: StoredSession, b: StoredSession): boolean {
  return (
    a.hostEpk === b.hostEpk &&
    a.roomId === b.roomId &&
    a.relayUrl === b.relayUrl &&
    a.token === b.token
  );
}

function pairTargetOf(credential: StoredSession): PairTarget {
  return {
    token: credential.token,
    hostEpk: credential.hostEpk,
    name: credential.name,
    roomId: HOST_WEB_ROOM_ID,
  };
}

/** Field-by-field projection of the host hello. A raw passthrough (or a
 *  spread) would carry extra WIRE fields — a canary such as `token` injected by
 *  a hostile/misbehaving host — into the public snapshot; exactly the four
 *  documented fields cross. */
function projectHello(hello: HostHelloOk): HostHelloOk {
  return {
    type: "host_hello_ok",
    daemon: {
      version: hello.daemon.version,
      hostname: hello.daemon.hostname,
      platform: hello.daemon.platform,
    },
    capabilities: [...hello.capabilities],
  };
}

/** Same rule for a catalog entry: exactly the seven documented fields, so an
 *  untrusted extra key (`privateKey`, `token`, …) cannot ride along. */
function projectWorkspace(entry: WorkspaceEntry): WorkspaceEntry {
  return {
    cwd: entry.cwd,
    daemon_id: entry.daemon_id,
    room_id: entry.room_id,
    name: entry.name,
    live: entry.live,
    daemon: entry.daemon,
    source: entry.source,
  };
}

/** A Wave 3 call bound to the flow + transport + host it started on: `await`
 *  boundaries use it to refuse a reply that a newer connection superseded. */
interface LiveBinding {
  flow: number;
  transport: RemotePiTransport;
  credential: StoredSession;
  hostEpk: string;
}

/**
 * The one controller. Construct it, `subscribe()`, then `restore()` or
 * `pair()`. Terminal states: `close()` (forget) and `dispose()` (unmount).
 */
export class RemotePiAdapter {
  /** The credential — the ONLY holder of the token. Never in a snapshot. */
  private credential: StoredSession | null = null;
  /** Public mirror of the LIVE pairing identity (name + relay only). An
   *  EXPLICIT `pair()` sets it only when the flow completed, while
   *  `restore()`/a retry re-establish an identity that this flow READ from
   *  disk, so it is published for the whole attempt. It is NOT a storage
   *  claim — see `storedPairing`. */
  private paired: { name: string; relayUrl: string } | null = null;
  /** The "Stored pairing" the launcher advertises. Set ONLY after a validated
   *  load from storage or a confirmed `saveStoredSession`, so the live pairing
   *  can never advertise itself as stored merely because a retry started. */
  private storedPairing: { name: string; relayUrl: string } | null = null;
  /** The FULL stored credential — the only other holder of the token besides
   *  `credential`, kept so a refused credential can be compared against the
   *  validated stored identity FIELD BY FIELD inside this class. It is never
   *  projected into a snapshot, a log or the UI. */
  private storedCredential: StoredSession | null = null;

  private transport: RemotePiTransport | null = null;
  /** `list_models` catalogues, keyed per (relay, host, room). Cleared whenever
   *  the pairing identity changes — see `applyCatalogueCacheScope`. */
  private readonly modelCache = new ModelCatalogueCache<WireModel, WireModel>(
    MODEL_CACHE_TTL_MS,
  );
  /** Identity triple the cache currently belongs to, so a change in ANY of
   *  relay/host/room is detected even when the phase never left `connected`. */
  private cacheScope: string | null = null;
  private state: ConnectionState;
  private host: HostHelloOk | null = null;
  private workspaces: WorkspaceEntry[] | null = null;
  /** Child lifecycle keyed by the EXACT canonical cwd of a catalog row, each
   *  entry carrying the row identity it was observed against. Cleared whole on
   *  close/dispose/new generation, so identity bookkeeping never outlives the
   *  connection (or catalog) it was observed on. */
  private childStates: Map<string, ObservedChildState> | null = null;
  private backend: Ed25519Backend | null = null;
  private warning: AdapterWarning | null = null;

  /** Adapter-local guard, SEPARATE from the state machine's `generation`
   *  (which is public and serializable): a superseded continuation compares
   *  this and stays inert — no publish, no storage write. */
  private sequence = 0;
  /** FLOW identity: bumped by an explicit `pair()`/`restore()`/`close()`/
   *  `dispose()` — NEVER by a retry. The retry loop owns its flow id, so a
   *  superseding pair cannot let the old loop restart or spend the new
   *  flow's budget. */
  private flowId = 0;
  private retries = 0;
  private delaySlot: { timer: ReturnType<typeof setTimeout>; cancel: () => void } | null = null;
  /** What the attributes below represent. `flow` while a socket sequence is
   *  being wired; `null` once nothing is bound. */
  private bound: { flow: number; transport: RemotePiTransport } | null = null;
  /** Unsubscribe handles of the CURRENT transport binding. Released BEFORE a
   *  socket is closed so a close-notification callback can never write. */
  private unbindTransport: (() => void)[] = [];

  /** Fixed transport codes, forwarded verbatim (no payload crosses). */
  private readonly diagnosticListeners = new Set<(code: TransportDiagnosticCode) => void>();
  private readonly stateListeners = new Set<(snapshot: AdapterSnapshot) => void>();
  private readonly messageListeners = new Set<(msg: ServerMessage, room: string) => void>();
  /** Coalesced catalog invalidation requested by a `workspace_state` push. It
   *  owns its flow id, so a timer armed before a newer pair can never relist
   *  on the new connection. */
  private catalogTimer: { timer: ReturnType<typeof setTimeout>; flow: number } | null = null;
  /** Monotonic ownership of catalog refreshes: the LATEST refresh that
   *  STARTED is the only writer. Two overlapping `workspace_list` replies in
   *  the SAME flow could otherwise install the older catalog over the newer
   *  one. Refusal (not just completion) of a superseded refresh is reported as
   *  the fixed `superseded` error. */
  private refreshOwner = 0;

  /** Normalized default relay, or `null` when nothing was selected. */
  private readonly relayUrl: string | null;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly retryPolicy: RetryPolicy;
  private readonly transportFactory: TransportFactory;
  /** `undefined` = not resolved yet (lazy browser storage). */
  private storage: StorageLike | null | undefined;

  private disposed = false;
  private closed = false;

  constructor(options: RemotePiAdapterOptions) {
    // An absent/blank relay stays `null` (no selection, no I/O, no default
    // host invented); a non-empty but invalid one is refused here, safely.
    const raw = typeof options.relayUrl === "string" ? options.relayUrl.trim() : "";
    this.relayUrl = raw === "" ? null : normalizeRelayUrl(raw);
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? Date.now;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.storage = options.storage === undefined ? undefined : options.storage;
    this.state = createConnectionState({ phase: this.enabled ? "idle" : "disabled", now: this.now() });

    const injected = options.transportFactory;
    this.transportFactory =
      injected ??
      ((relayUrl) =>
        new RemotePiWebClient({
          relayUrl,
          ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
          ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
          ...(options.webSocketFactory === undefined
            ? {}
            : { webSocketFactory: options.webSocketFactory }),
          ...(options.forceBackend === undefined ? {} : { forceBackend: options.forceBackend }),
          ...(options.signerFactory === undefined ? {} : { signerFactory: options.signerFactory }),
        }));
  }

  // ── public reads ─────────────────────────────────────────────────────────

  /** Secret-free snapshot. Every untrusted value is PROJECTED field by field
   *  (a raw spread would carry a canary such as `host.token` into the UI) and
   *  the mutable copies are deep copies, so a caller's mutation of a snapshot
   *  never reaches adapter state. */
  getSnapshot(): AdapterSnapshot {
    return {
      phase: this.state.phase,
      generation: this.state.generation,
      attempt: this.state.attempt,
      since: this.state.since,
      diagnostic:
        this.state.diagnostic === null
          ? null
          : { code: this.state.diagnostic.code, message: this.state.diagnostic.message },
      host: this.host === null ? null : projectHello(this.host),
      workspaces: this.workspaces === null ? null : this.workspaces.map(projectWorkspace),
      workspaceStates: this.projectChildStates(),
      backend: this.backend,
      paired: this.paired === null ? null : { name: this.paired.name, relayUrl: this.paired.relayUrl },
      storedPairing:
        this.storedPairing === null
          ? null
          : { name: this.storedPairing.name, relayUrl: this.storedPairing.relayUrl },
      warning: this.warning === null ? null : { code: this.warning.code, message: this.warning.message },
    };
  }

  /** Immediate snapshot on subscribe; the returned function unsubscribes. */
  subscribe(listener: (snapshot: AdapterSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.stateListeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Stable forward of host-room CHAT + proxied child-room messages. This is
   * the chat path, so the adapter CONSUMES the lifecycle push here first: a
   * `workspace_state` frame is validated, projected onto the catalog (exact
   * cwd match only) and NEVER forwarded to a listener — chat forwarding must
   * not see host lifecycle traffic.
   */
  onServerMessage(listener: (msg: ServerMessage, room: string) => void): () => void {
    if (this.disposed) return () => undefined;
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** Forward of the transport's FIXED diagnostic codes (no payload ever
   *  crosses: only the allow-listed code reaches the listener). */
  onDiagnostic(listener: (code: TransportDiagnosticCode) => void): () => void {
    if (this.disposed) return () => undefined;
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  // ── public lifecycle ─────────────────────────────────────────────────────

  /** Re-pairs from the stored five-field record. No record → stays `idle`; a
   *  storage failure is visible and never a false success. */
  async restore(): Promise<AdapterSnapshot> {
    this.assertUsable();
    if (!RESTORABLE_PHASES.includes(this.state.phase)) return this.getSnapshot();

    let stored: StoredSession | null = null;
    let storage: StorageLike | null;
    try {
      storage = this.requireStorage();
    } catch (err) {
      // Browser storage refused the access itself (typed by persistence.ts).
      this.setWarning(warningOf(err));
      this.notify();
      return this.getSnapshot();
    }

    if (storage !== null) {
      let raw: string | null;
      try {
        raw = storage.getItem(SESSION_STORAGE_KEY);
      } catch {
        // A raw storage exception on READ is an unreadable session.
        this.setWarning("session_unreadable");
        this.notify();
        return this.getSnapshot();
      }
      if (raw !== null) {
        try {
          stored = loadStoredSession(storage);
        } catch (err) {
          this.setWarning(warningOf(err));
          this.notify();
          return this.getSnapshot();
        }
        // A record existed and is gone: `loadStoredSession` removed a corrupt
        // one — report the discard instead of looking like "nothing saved".
        this.setWarning(stored === null ? "session_invalid" : null);
      } else {
        this.setWarning(null);
      }
    }

    // The validated record — or its confirmed absence — is the ONLY source of
    // a stored claim. A loaded identity is published for the whole attempt a
    // restore re-establishes it, and finding nothing on disk clears a stale
    // claim instead of advertising an identity storage no longer holds.
    this.storedCredential = stored;
    this.storedPairing =
      stored === null ? null : { name: stored.name, relayUrl: stored.relayUrl };

    if (stored === null) {
      this.notify();
      return this.getSnapshot();
    }
    const seq = this.openFlow();
    return this.attempt(seq, stored.relayUrl, stored, false, false);
  }

  /** Explicit pairing from a parsed code. `relayOverride` wins over the code's
   *  `r=` and the adapter default. Persists ONLY after a complete flow, and the
   *  public pairing summary is published with that success — a failed attempt
   *  advertises nothing and touches no record. */
  async pair(target: PairTarget, relayOverride?: string): Promise<AdapterSnapshot> {
    this.assertUsable();
    const credential = this.buildCredential(target, relayOverride);
    const seq = this.openFlow();
    return this.attempt(seq, credential.relayUrl, credential, false, true);
  }

  /** Terminal explicit FORGET/UNPAIR: cancels everything, clears the stored
   *  credential (memory first, then disk) before any listener runs, then
   *  emits `closing → closed`. Never reconnects. */
  close(): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    this.sequence += 1;
    this.flowId += 1;
    this.cancelDelay();
    this.cancelCatalogRefresh();
    this.closeTransport();
    this.credential = null;
    this.paired = null;
    this.storedPairing = null;
    this.storedCredential = null;
    this.host = null;
    this.workspaces = null;
    this.childStates = null;
    this.backend = null;
    this.retries = 0;
    // The connection is gone: no catalogue may survive into a later one.
    this.modelCache.clear();
    this.cacheScope = null;
    this.clearStored();
    this.state =
      this.state.phase === "disabled"
        ? { ...this.state, phase: "closing", since: this.now(), diagnostic: null }
        : reduceConnectionState(this.state, { type: "close" }, this.now());
    this.notify();
    this.state = reduceConnectionState(this.state, { type: "closed" }, this.now());
    this.notify();
  }

  /** Unmount. Releases resources and stops notifying; the stored pairing is
   *  PRESERVED so a fresh adapter can `restore()` it. Terminal for this
   *  instance (ReactStrictMode creates one adapter per mount). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence += 1;
    this.flowId += 1;
    this.cancelDelay();
    this.cancelCatalogRefresh();
    this.closeTransport();
    this.credential = null;
    this.paired = null;
    // In-memory cache only: the record on disk stays for the next adapter.
    this.storedPairing = null;
    this.storedCredential = null;
    this.host = null;
    this.workspaces = null;
    this.childStates = null;
    this.backend = null;
    this.state = { ...this.state, phase: "closed", since: this.now(), diagnostic: null };
    this.stateListeners.clear();
    this.messageListeners.clear();
    this.diagnosticListeners.clear();
  }

  // ── Wave 3 hooks: require a LIVE connection ──────────────────────────────

  /** Relists the catalog. The call is bound to the flow AND the transport that
   *  started it: a reply that arrives after a newer pair (or after the
   *  connection dropped) is REFUSED with a fixed `superseded` error and never
   *  overwrites the newer catalog. Within ONE flow the call is ALSO bound to
   *  the monotonically newest refresh: two overlapping `workspace_list` replies
   *  can no longer let the older one install a stale catalog. An explicit
   *  refresh cancels the scheduled coalesced invalidation, since it already
   *  performs the relist that timer would have requested. */
  async refreshWorkspaces(): Promise<WorkspaceEntry[]> {
    const live = this.requireLive();
    this.refreshOwner += 1;
    const owner = this.refreshOwner;
    this.cancelCatalogRefresh();
    let list: WorkspaceListOk;
    try {
      list = await live.transport.listWorkspaces(live.credential.hostEpk, HOST_WEB_ROOM_ID);
    } catch (err) {
      // The fence runs on the FAILURE path too: a stale flow's error must not
      // surface as if the current connection had produced it, and an older
      // refresh that already lost ownership is refused the same way.
      this.assertCurrent(live);
      if (owner !== this.refreshOwner) throw new AdapterStateError("superseded");
      throw err;
    }
    this.assertCurrent(live);
    if (owner !== this.refreshOwner) throw new AdapterStateError("superseded");
    this.setCatalog(list.workspaces);
    this.notify();
    return this.workspaces === null ? [] : this.workspaces.map(projectWorkspace);
  }

  async fsList(
    path: string,
    options: { showHidden?: boolean } = {},
  ): Promise<FsListOk> {
    const live = this.requireLive();
    try {
      const result = await live.transport.fsList(live.credential.hostEpk, path, {
        showHidden: options.showHidden ?? false,
        roomId: HOST_WEB_ROOM_ID,
      });
      this.assertCurrent(live);
      return result;
    } catch (err) {
      this.assertCurrent(live);
      throw err;
    }
  }

  async startWorkspace(cwd: string): Promise<WorkspaceStartOk> {
    const live = this.requireLive();
    try {
      const result = await live.transport.startWorkspace(live.credential.hostEpk, cwd, HOST_WEB_ROOM_ID);
      this.assertCurrent(live);
      return result;
    } catch (err) {
      this.assertCurrent(live);
      throw err;
    }
  }

  /**
   * Revives a workspace by cwd. BOUND to the flow + transport that started it:
   * a reply arriving after a newer pair (or after a drop) is refused with the
   * fixed `superseded` error rather than applied to the new connection. The ok
   * carries no `room_id`, so a caller needing the room must call
   * `refreshWorkspaces()` afterwards.
   */
  async restartWorkspace(cwd: string): Promise<WorkspaceRestartOk> {
    const live = this.requireLive();
    try {
      const result = await live.transport.restartWorkspace(
        live.credential.hostEpk,
        cwd,
        HOST_WEB_ROOM_ID,
      );
      this.assertCurrent(live);
      return result;
    } catch (err) {
      // The fence runs on the FAILURE path too, so a stale flow's error never
      // surfaces as if this connection produced it.
      this.assertCurrent(live);
      throw err;
    }
  }

  /**
   * Persists `path` in the host catalog. The host echoes no canonical cwd, so
   * the adapter does NOT touch the local catalog here — the push-driven
   * coalesced refresh (or an explicit `refreshWorkspaces()`) is what makes the
   * new row visible, with the cwd the host actually chose.
   */
  async addWorkspace(path: string): Promise<void> {
    const live = this.requireLive();
    try {
      await live.transport.addWorkspace(live.credential.hostEpk, path, HOST_WEB_ROOM_ID);
      this.assertCurrent(live);
      this.scheduleCatalogRefresh();
    } catch (err) {
      this.assertCurrent(live);
      throw err;
    }
  }

  sendChat(roomId: string, text: string, images?: readonly WireImage[]): string {
    const { transport, credential } = this.requireLive();
    return transport.sendChat(credential.hostEpk, roomId, text, images);
  }

  /** `list_models` for a workspace room. The reply (`models_list`) arrives via
   *  `onServerMessage` tagged with `roomId` — proxied replies never settle a
   *  host-room RPC, so correlation is (room + in_reply_to), same as chat.
   *
   *  A still-fresh catalogue for this source is answered from the cache with an
   *  EMPTY id and no wire traffic; see `readCachedModels`. */
  listModels(roomId: string): string {
    const { transport, credential } = this.requireLive();
    return transport.sendListModels(credential.hostEpk, roomId);
  }

  /**
   * The cached catalogue for `roomId` on the ACTIVE pairing, or null. The
   *  identity is re-derived here, so a caller can never read a catalogue that a
   *  different host reported.
   */
  readCachedModels(
    roomId: string,
  ): { models: readonly WireModel[]; current: WireModel | undefined } | null {
    if (this.credential === null || this.cacheScope === null) return null;
    return this.modelCache.get(catalogueKey(this.cacheScope, roomId));
  }

  /** Drops ONE room's cached catalogue: this client changed the active model
   *  there, so the remembered `current` is known-stale. Kept for callers that
   *  must genuinely re-read the host; the `model_set` path uses
   *  `confirmCachedModel` instead, which corrects the entry in place. */
  invalidateCachedModels(roomId: string): void {
    if (this.cacheScope === null) return;
    this.modelCache.invalidate(catalogueKey(this.cacheScope, roomId));
  }

  /**
   * Records a model switch the HOST CONFIRMED (`action_ok`) in the cached
   *  catalogue for this room, so the remembered `current` matches the Pi's new
   *  active model WITHOUT a second round trip.
   *
   *  `action_ok` means `pi.setModel` succeeded, so the active model IS this one:
   *  writing it here is accuracy, not optimism. A cache miss is a no-op — there
   *  is nothing remembered to correct, and the next `models_list` reports the
   *  real `current` anyway.
   */
  confirmCachedModel(roomId: string, provider: string, modelId: string): void {
    if (this.cacheScope === null) return;
    const key = catalogueKey(this.cacheScope, roomId);
    const entry = this.modelCache.get(key);
    if (entry === null) return;
    const current = entry.models.find((m) => m.provider === provider && m.id === modelId);
    this.modelCache.set(key, { models: entry.models, current });
  }

  /** `model_set` for a workspace room. `provider`/`model_id` are echoed back
   *  exactly as `models_list` reported them — the client never invents one. */
  setModel(roomId: string, provider: string, modelId: string): string {
    const { transport, credential } = this.requireLive();
    return transport.sendModelSet(credential.hostEpk, roomId, provider, modelId);
  }

  /** `thinking_set` for a workspace room (fixed enum from the protocol). */
  setThinking(roomId: string, level: ThinkingLevel): string {
    const { transport, credential } = this.requireLive();
    return transport.sendThinkingSet(credential.hostEpk, roomId, level);
  }

  /** `pi_surface` for a workspace room — the installed skills. The reply
   *  (`pi_surface_ok`) arrives via `onServerMessage` tagged with `roomId`. */
  listSkills(roomId: string): string {
    const { transport, credential } = this.requireLive();
    return transport.sendPiSurface(credential.hostEpk, roomId);
  }

  /** `skill_invoke` for a workspace room. `name` must be one the host reported
   *  (it refuses anything else); `args` is appended verbatim. */
  invokeSkill(roomId: string, name: string, args?: string): string {
    const { transport, credential } = this.requireLive();
    return transport.sendSkillInvoke(credential.hostEpk, roomId, name, args);
  }

  /** `session_list` for a workspace room — its AgentSessions. */
  listSessions(roomId: string): string {
    const { transport, credential } = this.requireLive();
    return transport.sendSessionList(credential.hostEpk, roomId);
  }

  /** `session_read` — one session's transcript, WITHOUT switching the live
   *  session. The reply arrives via `onServerMessage` tagged with `roomId`. */
  readSession(
    roomId: string,
    sessionId: string,
    options: { limit?: number; before?: string } = {},
  ): string {
    const { transport, credential } = this.requireLive();
    return transport.sendSessionRead(credential.hostEpk, roomId, sessionId, options);
  }

  /** `session_switch` — make another session the LIVE one. Distinct from
   *  `readSession` because it changes state for every paired client. */
  switchSession(roomId: string, sessionId: string): string {
    const { transport, credential } = this.requireLive();
    return transport.sendSessionSwitch(credential.hostEpk, roomId, sessionId);
  }

  // ── internals: catalogue cache ───────────────────────────────────────────

  /**
   * Rebinds the catalogue cache to a (relay, host) source, CLEARING it whenever
   *  that identity changes. Both sides are normalised the same way the wire
   *  normalises the relay URL, so a re-pair to the same host on the same relay
   *  keeps its catalogue while switching either one drops every entry — a
   *  catalogue is never attributed to a host that did not report it.
   */
  private applyCatalogueCacheScope(relayUrl: string, hostEpk: string): void {
    let normalized: string;
    try {
      normalized = normalizeRelayUrl(relayUrl);
    } catch {
      // An unusable relay URL cannot index a cache; treat it as its own scope
      // so nothing is ever reused across it.
      normalized = `raw:${relayUrl}`;
    }
    const scope = catalogueScope(normalized, hostEpk);
    if (scope !== this.cacheScope) this.modelCache.clear();
    this.cacheScope = scope;
  }

  /** Stores a `models_list` reply under the CURRENT identity. A frame that is
   *  not a valid catalogue, or that arrives with no credential yet, is ignored
   *  rather than cached under the wrong source. */
  private rememberCatalogue(msg: ServerMessage, room: string): void {
    if (this.cacheScope === null) return;
    if (!isModelsListOk(msg)) return;
    this.modelCache.set(catalogueKey(this.cacheScope, room), {
      models: msg.models,
      current: msg.current,
    });
  }

  // ── internals: guards ────────────────────────────────────────────────────

  private assertUsable(): void {
    if (this.disposed) throw new AdapterStateError("disposed");
    if (this.closed) throw new AdapterStateError("closed");
    if (!this.enabled) throw new AdapterStateError("disabled");
  }

  /** HOST room only, strict five-field schema (the SAME validator the on-disk
   *  record uses): a bad epk, blank token/name or unsafe relay URL is refused
   *  before a socket exists. */
  private buildCredential(target: PairTarget, relayOverride?: string): StoredSession {
    if (target.roomId !== HOST_WEB_ROOM_ID) throw new PairRejectedError("unsupported_room");
    // Explicit override > the code's `r=` > the adapter default. No relay
    // selected anywhere is a FIXED refusal — no host is ever invented.
    const selected = relayOverride ?? target.relayUrl ?? this.relayUrl ?? undefined;
    if (selected === undefined || selected.trim() === "") {
      throw new AdapterStateError("relay_unselected");
    }
    const relayUrl = normalizeRelayUrl(selected);
    return parseStoredSession({
      relayUrl,
      hostEpk: target.hostEpk,
      name: target.name,
      roomId: HOST_WEB_ROOM_ID,
      token: target.token,
    });
  }

  /** A connected binding, captured BEFORE the await so a post-await check can
   *  prove the same flow/transport/host is still current. */
  private requireLive(): LiveBinding {
    if (this.disposed) throw new AdapterStateError("disposed");
    if (this.closed) throw new AdapterStateError("closed");
    const transport = this.transport;
    const credential = this.credential;
    const bound = this.bound;
    if (
      this.state.phase !== "connected" ||
      transport === null ||
      credential === null ||
      bound === null ||
      bound.transport !== transport ||
      !transport.connected
    ) {
      throw new AdapterStateError("not_connected");
    }
    return { flow: bound.flow, transport, credential, hostEpk: credential.hostEpk };
  }

  /** Post-await fence: the binding must still be the CURRENT flow with the
   *  CURRENT transport AND still connected. Anything else — a newer pair, a
   *  drop, a close — is refused with the fixed `superseded` error, so a stale
   *  reply can neither return old data nor overwrite the newer catalog. */
  private assertCurrent(live: LiveBinding): void {
    if (this.disposed || this.closed) throw new AdapterStateError("superseded");
    const bound = this.bound;
    if (
      live.flow !== this.flowId ||
      bound === null ||
      bound.flow !== live.flow ||
      bound.transport !== live.transport ||
      this.transport !== live.transport ||
      this.state.phase !== "connected"
    ) {
      throw new AdapterStateError("superseded");
    }
  }

  /** True when `seq` was superseded (new flow, close or dispose). */
  private stale(seq: number): boolean {
    return seq !== this.sequence || this.disposed || this.closed;
  }

  /** True when the retry loop that owns `flow` was superseded by an explicit
   *  pair/restore/close/dispose. */
  private flowStale(flow: number): boolean {
    return flow !== this.flowId || this.disposed || this.closed;
  }

  // ── internals: the flow ──────────────────────────────────────────────────

  /** Opens a NEW flow: bumps `flowId` (the ownership token a retry loop
   *  carries) and `sequence` (the stale-continuation guard), then releases
   *  the previous flow's timer, subscriptions and socket. */
  private openFlow(): number {
    this.sequence += 1;
    this.flowId += 1;
    this.cancelDelay();
    this.cancelCatalogRefresh();
    this.closeTransport();
    return this.sequence;
  }

  private startGeneration(
    relayUrl: string,
    credential: StoredSession,
    isRetry: boolean,
    persist: boolean,
  ): void {
    this.credential = credential;
    this.applyCatalogueCacheScope(relayUrl, credential.hostEpk);
    // Explicit pair: the summary waits for the write (see `paired`). Restore
    // AND retry: this flow re-establishes the identity the record on disk
    // already carries, so it is published for the whole attempt — a failed
    // reconnect of an existing pairing must not hide it while it stays on disk.
    if (!persist || isRetry) this.paired = { name: credential.name, relayUrl };
    this.host = null;
    this.workspaces = null;
    // New generation: the observed child states AND their row identities go
    // together (same map), so no observation from the previous socket can be
    // attributed to a row of the new one.
    this.childStates = null;
    this.backend = null;
    // A RETRY re-enters through the `relay_authenticating` event so the state
    // machine carries the attempt counter (the backoff budget) forward; an
    // explicit pair/restore uses `connect` and starts a FRESH sequence at 1.
    this.advance(isRetry ? { type: "relay_authenticating" } : { type: "connect" });
  }

  /** ONE full flow: connect → pair → host_hello → workspace_list → connected.
   *  Returns without publishing when superseded. */
  private async attempt(
    seq: number,
    relayUrl: string,
    credential: StoredSession,
    isRetry: boolean,
    persist: boolean,
  ): Promise<AdapterSnapshot> {
    const flow = this.flowId;
    this.startGeneration(relayUrl, credential, isRetry, persist);
    try {
      const transport = this.transportFactory(relayUrl);
      this.attachTransport(transport, seq, flow);

      await transport.connect();
      if (this.stale(seq)) return this.getSnapshot();
      this.advance({ type: "pairing" });
      await transport.pair(pairTargetOf(credential));
      if (this.stale(seq)) return this.getSnapshot();
      this.advance({ type: "pair_accepted" });
      const hello = await transport.helloHost(credential.hostEpk, HOST_WEB_ROOM_ID);
      if (this.stale(seq)) return this.getSnapshot();
      const list = await transport.listWorkspaces(credential.hostEpk, HOST_WEB_ROOM_ID);
      if (this.stale(seq)) return this.getSnapshot();

      this.host = projectHello(hello);
      this.setCatalog(list.workspaces);
      this.backend = transport.backend;
      this.retries = 0; // success resets the reconnect budget
      if (persist) {
        // The one publication point for an explicit pair: it appears together
        // with `connected` and BEFORE the write, so a FAILED write still
        // advertises the live pairing plus the fixed "unsaved" warning
        // (`writeStored`) instead of denying a pairing that exists in memory.
        this.paired = { name: credential.name, relayUrl };
      }
      this.advance({ type: "host_authenticated" });
      if (persist) this.writeStored(credential, seq);
      return this.getSnapshot();
    } catch (err) {
      if (this.stale(seq)) return this.getSnapshot();
      this.failFlow(err, credential, isRetry, persist);
      return this.getSnapshot();
    }
  }

  /**
   * Classifies a failed flow. The refused-identity branch compares the flow's
   * own `credential` with the VALIDATED stored identity (field by field,
   * token included, name display-only): only WHEN THEY ARE THE SAME is the
   * record the disk holds proven dead and dropped. `persist` marks an EXPLICIT
   * pair (which wrote nothing yet) so the LIVE `paired` publication is
   * withdrawn exactly as before; it no longer decides the destructive branch.
   */
  private failFlow(
    err: unknown,
    credential: StoredSession,
    isRetry: boolean,
    persist: boolean,
  ): void {
    if (err instanceof PairRejectedError) {
      if (TOKEN_REJECTION_CODES.includes(err.code)) {
        // The identity was refused (mode unknown): drop the memory credential
        // and stop at `reauth_required` for an explicit new code.
        this.credential = null;
        this.host = null;
        this.workspaces = null;
        this.childStates = null;
        this.backend = null;
        // Disk + STORED summary are cleared ONLY when this flow's credential
        // IS the identity the storage holds RIGHT NOW — a restore/retry
        // re-establishing the record it READ, or an explicit pair whose paste
        // matches the CURRENT record (name aside). That identity is proven
        // dead and must not linger. An explicit pair of a genuinely DIFFERENT
        // identity (other hostEpk/room/relay/token) wrote nothing, so the
        // record and the summary advertising it stay untouched. A dead record
        // left behind by such a foreign attempt is self-healing: the next
        // `restore()` loads it and hits this same branch.
        const current = this.adoptCurrentStoredRecord();
        if (current.state === "record" && sameStoredIdentity(current.session, credential)) {
          // Re-read immediately before the removal: the record is dropped ONLY
          // when its RAW text is still byte-identical to the one just
          // classified as refused, so a replacement written between
          // classification and removal (another tab/process) survives. This is
          // NOT a cross-process CAS — `localStorage` has no transaction — it
          // only narrows the window.
          const beforeRemoval = this.adoptCurrentStoredRecord();
          if (beforeRemoval.state === "record" && beforeRemoval.raw === current.raw) {
            // Memory first (the summary stops advertising the dead identity
            // even when the removal below fails), then disk.
            this.storedPairing = null;
            this.storedCredential = null;
            this.clearStored();
          }
        }
        if (!persist) this.paired = null;
        this.advance({ type: "reauth_required" });
      } else {
        // `internal_error`: terminal, fixed text, NO automatic retry.
        this.advance({ type: "fail", code: "pair_rejected" });
      }
      this.closeTransport();
      return;
    }
    const code = mapTransportFailure(err);
    if (isRetry) {
      // Inside the budget: back to `reconnecting`; the loop decides between
      // another attempt and `retry_exhausted`.
      this.advance({ type: "connection_lost", code });
      this.closeTransport();
      return;
    }
    this.advance({ type: "fail", code });
    this.closeTransport();
  }

  // ── internals: unexpected drop + finite backoff ──────────────────────────

  private onTransportDrop(): void {
    if (this.disposed || this.closed) return;
    // A drop BEFORE `connected` is owned by the attempt's own failure path;
    // handling it here as well would run a second loop.
    if (this.state.phase !== "connected" || this.credential === null) return;
    const credential = this.credential;
    const flow = this.flowId;
    this.retries = 0;
    this.advance({ type: "connection_lost", code: "connection_lost" });
    void this.retryLoop(flow, credential.relayUrl, credential);
  }

  private async retryLoop(flow: number, relayUrl: string, credential: StoredSession): Promise<void> {
    for (;;) {
      // The loop owns `flow`: once an explicit pair/restore/close/dispose
      // replaced it, this loop must neither reconnect nor spend budget —
      // even if the phase happens to read `reconnecting` again.
      if (this.flowStale(flow)) return;
      if (this.retries >= this.retryPolicy.maxRetries) {
        this.advance({ type: "retry_exhausted" });
        return;
      }
      this.retries += 1;
      const waitMs = Math.min(
        this.retryPolicy.maxDelayMs,
        this.retryPolicy.baseDelayMs * 2 ** (this.retries - 1),
      );
      if (await this.delay(waitMs)) return; // cancelled: close/dispose/new pair
      if (this.flowStale(flow)) return;

      await this.attempt(this.sequence, relayUrl, credential, true, false);
      if (this.flowStale(flow)) return;
      if (this.state.phase === "connected") return; // budget already reset
      if (this.state.phase !== "reconnecting") return; // reauth/error/superseded
    }
  }

  // ── internals: transport wiring ──────────────────────────────────────────

  /** Binds the CURRENT flow to `transport` and registers its listeners. The
   *  unsubscribe handles are kept so `closeTransport()` can RELEASE them
   *  BEFORE closing the socket: a close-notification callback fired during
   *  `close()` can therefore never run a late write on a dead connection. */
  private attachTransport(transport: RemotePiTransport, seq: number, flow: number): void {
    this.transport = transport;
    this.bound = { flow, transport };
    const unsubscribers: (() => void)[] = [
      transport.onClose(() => {
        if (this.stale(seq) || this.flowStale(flow)) return;
        this.onTransportDrop();
      }),
      transport.onServerMessage((msg, room) => {
        if (this.stale(seq)) return;
        // Host lifecycle is consumed FIRST — but ONLY on the HOST room: a
        // proxied child-room frame can never mutate the host state map,
        // whatever it claims to be.
        if (this.consumeWorkspaceState(msg, room)) return;
        // Warm the catalogue cache from EVERY `models_list` that crosses this
        // socket, so the picker's next open is free even when another caller
        // issued the request.
        this.rememberCatalogue(msg, room);
        // Pushes (including proxied child-room traffic) NEVER touch the phase.
        for (const listener of [...this.messageListeners]) listener(msg, room);
      }),
    ];
    if (typeof transport.onWorkspaceState === "function") {
      unsubscribers.push(
        transport.onWorkspaceState((push) => {
          if (this.stale(seq)) return;
          // Defense-in-depth on the injectable-transport seam: the dedicated
          // sink is HOST-only, so a frame that fails the strict push guard (or
          // that is not a push at all) is dropped instead of merged.
          if (!isWorkspaceStatePush(push)) return;
          this.applyWorkspaceState(push);
        }),
      );
    }
    if (typeof transport.onDiagnostic === "function") {
      unsubscribers.push(
        transport.onDiagnostic((code) => {
          if (this.stale(seq)) return;
          for (const listener of [...this.diagnosticListeners]) listener(code);
        }),
      );
    }
    this.unbindTransport = unsubscribers;
  }

  /**
   * Consumes a HOST-room lifecycle push if `msg` is one. The frame is
   * re-validated here with the strict guard (no `id`/`in_reply_to`, closed
   * state enum, string|null `last_error`, integer `restarts`) AND the room is
   * re-checked: only `HOST_WEB_ROOM_ID` traffic can reach the child-state map,
   * so a malformed push or a proxied child frame is NOT consumed and only ever
   * falls through to the ordinary chat filtering. Returns true when the frame
   * was consumed.
   */
  private consumeWorkspaceState(msg: ServerMessage, room: string): boolean {
    if (room !== HOST_WEB_ROOM_ID) return false;
    if (msg.type !== "workspace_state") return false;
    if (!isWorkspaceStatePush(msg)) return false;
    this.applyWorkspaceState(msg);
    return true;
  }

  /**
   * Merges one validated push into the child-state map. A cwd that matches NO
   * current catalog row is REFUSED (`unknownCwd`): a hostile host cannot mint
   * a fictitious workspace row, and the client never guesses one. The push
   * ALWAYS invalidates the catalog (coalesced) — both for a known row (its
   * `live` flag just changed) and for an unknown one (the row may be brand new
   * on the host, e.g. right after `workspace_add`).
   */
  private applyWorkspaceState(push: WorkspaceStatePush): void {
    // Anchored on an exact byte-equal cwd, not on a case-folded or normalized
    // form: the catalog IS the allow-list, so a near-match is a different row.
    let matched: WorkspaceEntry | null = null;
    const rows = this.workspaces;
    if (rows !== null) {
      for (const row of rows) {
        if (row.cwd === push.cwd) {
          matched = row;
          break;
        }
      }
    }
    if (matched !== null) {
      if (this.childStates === null) this.childStates = new Map();
      const identity = childIdentityOf(matched);
      const previous = this.childStates.get(push.cwd);
      // Same cwd, DIFFERENT daemon/room generation: a new child was observed
      // here, so the old badge is dropped instead of being merged field by
      // field into a lifecycle it does not belong to.
      if (previous !== undefined && previous.identity !== identity) {
        this.childStates.delete(push.cwd);
      }
      this.childStates.set(push.cwd, {
        state: push.state,
        live: push.state === "running",
        hasError: push.last_error !== null,
        restarts: push.restarts,
        identity,
      });
      // Bounded: a long-lived session cannot grow the map per cwd forever.
      while (this.childStates.size > MAX_CHILD_STATES) {
        const oldest = this.childStates.keys().next();
        if (oldest.done) break;
        this.childStates.delete(oldest.value);
      }
    }
    this.scheduleCatalogRefresh();
    this.notify();
  }

  /** Projects the child-state map into a fresh plain object (deep copy: the
   *  caller never holds a reference into adapter state). Only the four public
   *  fields cross — never the raw `last_error` text, never the internal row
   *  identity. */
  private projectChildStates(): Record<string, WorkspaceChildState> | null {
    if (this.childStates === null || this.childStates.size === 0) return null;
    const out: Record<string, WorkspaceChildState> = {};
    for (const [cwd, view] of this.childStates) {
      out[cwd] = {
        state: view.state,
        live: view.live,
        hasError: view.hasError,
        restarts: view.restarts,
      };
    }
    return out;
  }

  /**
   * Installs a fresh catalog. Child states are PRUNED to the rows the host
   * reports (a workspace removed on the host must not keep a stale badge), so
   * the observed map is always a subset of the catalog. A row that comes back
   * at the SAME cwd with a DIFFERENT `daemon_id`/`room_id` is a new child
   * generation: its old observation is dropped, not carried over. The list
   * response is applied regardless of what pushed in the meantime: it is the
   * newer authority on catalog MEMBERSHIP and row identity, while the pushes
   * only ever touched the per-row lifecycle view (never the array).
   */
  private setCatalog(entries: readonly WorkspaceEntry[]): void {
    this.workspaces = entries.map(projectWorkspace);
    if (this.childStates === null || this.childStates.size === 0) return;
    const identityByCwd = new Map<string, string>();
    for (const row of this.workspaces) identityByCwd.set(row.cwd, childIdentityOf(row));
    for (const [cwd, observed] of [...this.childStates]) {
      const identity = identityByCwd.get(cwd);
      // Gone from the host, or re-spawned under a new daemon/room at the same
      // cwd: either way the stored observation no longer belongs to this row.
      if (identity === undefined || identity !== observed.identity) {
        this.childStates.delete(cwd);
      }
    }
    if (this.childStates.size === 0) this.childStates = null;
  }

  /** Arms the coalesced catalog invalidation (at most ONE timer). The timer
   *  carries the flow it was armed on, so a refresh scheduled before a newer
   *  pair can never relist on the new connection. A `refreshWorkspaces()` that
   *  lands first still supersedes it harmlessly (`assertCurrent` fences it). */
  private scheduleCatalogRefresh(): void {
    if (this.closed || this.disposed) return;
    if (this.catalogTimer !== null) return;
    const flow = this.flowId;
    const timer = setTimeout(() => {
      if (this.catalogTimer !== null && this.catalogTimer.timer === timer) {
        this.catalogTimer = null;
      }
      if (this.flowStale(flow)) return;
      void this.refreshWorkspaces().catch(() => {
        // A failed/refused invalidation is not a connection failure: the last
        // good catalog and the observed states stay; the next push retries.
      });
    }, CATALOG_INVALIDATE_MS);
    this.catalogTimer = { timer, flow };
  }

  /** Cancels the pending invalidation (close/dispose/new flow). There is no
   *  recursive push loop: a push can only ever arm ONE timer. */
  private cancelCatalogRefresh(): void {
    const slot = this.catalogTimer;
    if (slot === null) return;
    this.catalogTimer = null;
    clearTimeout(slot.timer);
  }

  /** Releases the current binding: subscriptions FIRST (no callback can run
   *  afterwards), then the socket. Idempotent. */
  private closeTransport(): void {
    const unsubscribe = this.unbindTransport;
    this.unbindTransport = [];
    for (const off of unsubscribe) {
      try {
        off();
      } catch {
        /* already released */
      }
    }
    this.bound = null;
    const transport = this.transport;
    this.transport = null;
    if (transport !== null) {
      try {
        transport.close();
      } catch {
        /* already gone */
      }
    }
  }

  // ── internals: storage ───────────────────────────────────────────────────

  /** Lazily resolves persistence (browser storage unless injected). Cached
   *  after the first call; a throwing access surfaces as a typed error. */
  private requireStorage(): StorageLike | null {
    if (this.storage === undefined) this.storage = browserSessionStorage();
    return this.storage;
  }

  /** Persist AFTER the flow only. A failed write never becomes a false
   *  success: the connection stands and the snapshot warns "unsaved". */
  private writeStored(credential: StoredSession, seq: number): void {
    if (this.stale(seq)) return;
    let storage: StorageLike | null;
    try {
      storage = this.requireStorage();
    } catch (err) {
      this.setWarning(warningOf(err));
      this.notify();
      return;
    }
    if (storage === null) {
      this.setWarning("session_unavailable");
      this.notify();
      return;
    }
    try {
      saveStoredSession(storage, credential);
      // CONFIRMED (the save re-reads the record): only NOW is this identity
      // stored. A write that throws never reaches here, so the previous stored
      // claim (still on disk) is kept and no new one is invented.
      this.storedCredential = credential;
      this.storedPairing = { name: credential.name, relayUrl: credential.relayUrl };
      this.setWarning(null);
    } catch (err) {
      // The connection STANDS; the snapshot says the pairing is unsaved.
      this.setWarning(err instanceof SessionPersistenceError ? "session_unsaved" : warningOf(err));
    }
    this.notify();
  }

  /** Reads the record storage holds RIGHT NOW without destroying anything: the
   *  raw text plus its validated session, `absent` when storage confirms there
   *  is no record, `unknown` when access/read/parse failed. `loadStoredSession`
   *  is deliberately NOT used — its corrupt-record removal is a restore-time
   *  cleanup, and a refusal path may never delete what it cannot read. */
  private readCurrentStored(): CurrentStoredRecord {
    let storage: StorageLike | null;
    try {
      storage = this.requireStorage();
    } catch {
      // Access refused (typed by persistence.ts): unknown state.
      return { state: "unknown" };
    }
    if (storage === null) return { state: "unknown" };
    let raw: string | null;
    try {
      raw = storage.getItem(SESSION_STORAGE_KEY);
    } catch {
      // Unreadable: unknown, so there is nothing to compare or delete.
      return { state: "unknown" };
    }
    if (raw === null) return { state: "absent" };
    try {
      return { state: "record", raw, session: parseStoredSessionJson(raw) };
    } catch {
      return { state: "unknown" };
    }
  }

  /** The identity a refusal is compared against: the record storage holds
   *  RIGHT NOW, freshly read and validated — NEVER the in-memory cache, which
   *  is stale whenever another context replaced the record. Trusting the cache
   *  made a refusal of X delete a live Y, violating preservation of an
   *  unrelated identity.
   *
   *  The read also SYNCS the cached stored claim: a readable record replaces it
   *  (disk is the only source of a stored claim) and a CONFIRMED absence
   *  withdraws it in memory (disk untouched). An `unknown` read (access/read/
   *  parse failure) compares nothing, deletes nothing and leaves the cache as
   *  it was. Returns the raw outcome so the caller can re-read and require byte
   *  identity before removing anything.
   */
  private adoptCurrentStoredRecord(): CurrentStoredRecord {
    const current = this.readCurrentStored();
    if (current.state === "record") {
      this.storedCredential = current.session;
      this.storedPairing = { name: current.session.name, relayUrl: current.session.relayUrl };
    } else if (current.state === "absent") {
      this.storedCredential = null;
      this.storedPairing = null;
    }
    return current;
  }

  private clearStored(): void {
    let storage: StorageLike | null;
    try {
      storage = this.requireStorage();
    } catch (err) {
      this.setWarning(warningOf(err));
      return;
    }
    if (storage === null) return;
    try {
      clearStoredSession(storage);
      this.setWarning(null);
    } catch (err) {
      this.setWarning(warningOf(err));
    }
  }

  private setWarning(code: AdapterWarningCode | null): void {
    this.warning = code === null ? null : { code, message: ADAPTER_WARNING_MESSAGES[code] };
  }

  // ── internals: state plumbing ────────────────────────────────────────────

  private advance(event: ConnectionEvent): void {
    this.state = reduceConnectionState(this.state, event, this.now());
    this.notify();
  }

  private notify(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.stateListeners]) listener(snapshot);
  }

  private delay(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.delaySlot = null;
        resolve(false);
      }, ms);
      this.delaySlot = { timer, cancel: () => resolve(true) };
    });
  }

  /** Cancels a pending backoff, resolving `delay()` with `true`. */
  private cancelDelay(): void {
    const slot = this.delaySlot;
    if (slot === null) return;
    this.delaySlot = null;
    clearTimeout(slot.timer);
    slot.cancel();
  }
}
