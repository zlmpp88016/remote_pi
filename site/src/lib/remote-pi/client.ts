/**
 * Minimal web client for the host-room protocol (plan 69 W4).
 *
 * Speaks EXACTLY what PROTOCOL.md documents — no new contracts:
 *   connect   relay WS + hello/challenge/auth (Ed25519, ephemeral App-key)
 *   pair      pair_request on the host room          → pair_ok | pair_error
 *   hello     host_hello                             → host_hello_ok
 *   browse    fs_list (host resolves every path)     → fs_list_ok | action_error
 *   list      workspace_list                         → workspace_list_ok
 *   start     workspace_start                        → workspace_start_ok
 *   restart   workspace_restart                      → workspace_restart_ok
 *                                                     | workspace_restart_error
 *   add       workspace_add                           → action_ok | action_error
 *   state     workspace_state (host PUSH, no id)      → dedicated listener only
 *   chat      host_forward on the host room          → host_message-wrapped
 *                                                       echo + agent_chunk/agent_done
 *
 * Connection model (plan 69, decision B of the room-multiplex spike): the
 * client anchors ONLY on room "host" — a single connection does not sustain
 * room "host" plus workspace rooms, and the app-side demux drops envelopes
 * from a non-active room (spike E2c). Pair + host control-plane messages are
 * addressed to (host Epk, room "host"); chat rides the
 * `host_forward`/`host_message` proxy — the daemon re-emits the payload to
 * the child workspace room and wraps the child's replies back as
 * `host_message{room, ct}`, which this client files by room. A dead Pi never
 * drops the machine connection because that connection lives on room "host".
 *
 * Transport hardening (plan 69 W4, wave 2 — TRANSPORT ONLY, no new wire):
 *  - ONE socket generation per connect. Every timer, socket listener, pending
 *    request and callbacks captured by an `await` carries its generation and
 *    a stale generation is inert (never an error thrown from a dead socket).
 *  - `close()` is terminal and deterministic: it aborts an in-flight connect,
 *    clears every timer, rejects pending requests, detaches every tracked
 *    socket listener, releases the ephemeral key and only then closes the
 *    socket — so a late signer/socket callback can never reopen anything.
 *  - Responses are accepted ONLY from the BOUND host peer, on the host room,
 *    with the reply kind (and for action errors the action) the request
 *    declared. Anything else becomes a FIXED diagnostic code — a raw frame, a
 *    host string or an exception text is never surfaced.
 *  - `host_message` proxy rooms are allow-listed (learned from workspace_list/
 *    workspace_start/sendChat) and can NEVER settle a host request, even with
 *    a matching `in_reply_to`: a child room cannot answer a host RPC.
 */

import {
  createEd25519Signer,
  type Ed25519Backend,
  type Ed25519Signer,
} from "./ed25519.ts";
import {
  ActionRejectedError,
  decodeCtChecked,
  decodeOuterChecked,
  encodeCt,
  encodeOuter,
  isActionError,
  isActionOk,
  isHostHelloOk,
  isHostMessage,
  isFsListOk,
  isJsonObject,
  isPairOk,
  isWorkspaceListOk,
  isWorkspaceRestartError,
  isWorkspaceRestartOk,
  isWorkspaceStartOk,
  isWorkspaceStatePush,
  normalizeRelayUrl,
  pairRequest,
  PairRejectedError,
  ProtocolFrameError,
  WorkspaceRestartRejectedError,
  type ClientMessage,
  type DecodedEnvelope,
  type FsListOk,
  type HostForward,
  type HostHelloOk,
  type PairOk,
  type PairRequest,
  type PairTarget,
  type RelayAuthFrame,
  type ServerMessage,
  type ThinkingLevel,
  type WireImage,
  type WorkspaceListOk,
  type WorkspaceRestartOk,
  type WorkspaceStartOk,
  type WorkspaceStatePush,
} from "./protocol.ts";

/** Subprotocol offered on the WS handshake; the relay echoes the negotiated
 *  one (plan 69 W4 relay prerequisite). Name is a client-side convention —
 *  PROTOCOL.md does not fix it (documented ambiguity). The web client never
 *  REQUESTS it (see `connect`), so this constant is informational only. */
export const WEB_CLIENT_SUBPROTOCOL = "remote-pi.1";

/** Host control-plane room (plan 67/69) — the ONLY room this client
 *  anchors on (decision B: one connection does not sustain host + workspace
 *  rooms; chat is proxied via host_forward/host_message). */
const HOST_ROOM = "host";

/** Child rooms learned from the host; bounded so a hostile host cannot grow
 *  the allow-list without limit. */
const MAX_CHILD_ROOMS = 128;
/** Retired request ids kept only to classify a late/duplicate reply; bounded
 *  so a long-lived socket cannot accumulate one id per request forever. */
const MAX_RETIRED_IDS = 64;

// ── fixed transport diagnostics (never wire content) ───────────────────────

/** Fixed codes for a frame the transport refused. A consumer may branch on
 *  the code; it can never read the offending frame or exception. */
export const TRANSPORT_DIAGNOSTIC_CODES = [
  "malformed_frame",
  "malformed_envelope",
  "malformed_ct",
  "malformed_proxy",
  "malformed_reply",
  "malformed_workspace_state",
  "unexpected_peer",
  "unexpected_room",
  "unknown_child_room",
  "unknown_reply",
  "late_reply",
  "duplicate_reply",
  "wrong_response_kind",
  "wrong_action_error",
] as const;

export type TransportDiagnosticCode = (typeof TRANSPORT_DIAGNOSTIC_CODES)[number];

/** Fixed codes for a transport-level failure (EDGE cases, not host replies). */
export type TransportErrorCode =
  | "closed"
  | "connecting"
  | "already_connected"
  | "connect_timeout"
  | "connect_failed"
  | "challenge_timeout"
  | "malformed_challenge"
  | "auth_rejected"
  | "signer_timeout"
  | "not_connected"
  | "connection_lost"
  | "host_rebind_refused"
  | "request_timeout";

const TRANSPORT_ERROR_MESSAGES: Readonly<Record<TransportErrorCode, string>> = {
  closed: "the client is closed",
  connecting: "a connection attempt is already in flight",
  already_connected: "the client is already connected",
  connect_timeout: "the relay did not accept the connection in time",
  connect_failed: "could not connect to the relay",
  challenge_timeout: "the relay did not send a challenge in time",
  malformed_challenge: "the relay sent a malformed challenge",
  auth_rejected: "the relay closed the connection after auth",
  signer_timeout: "the Ed25519 signer did not answer in time",
  not_connected: "the client is not connected — call connect() first",
  connection_lost: "the relay connection dropped",
  host_rebind_refused: "this client is already bound to another host",
  request_timeout: "the host did not reply in time",
};

/** Transport failure with a FIXED message and a machine-readable code. */
export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode) {
    super(TRANSPORT_ERROR_MESSAGES[code]);
    this.name = "TransportError";
    this.code = code;
  }
}

/** Fixed codes for an UNEXPECTED connection loss (the adapter's signal; an
 *  explicit `close()` never notifies — that one is client-initiated). */
export type TransportCloseCode = "relay_dropped";

/** Maps a validated frame refusal onto the fixed diagnostic code. */
function frameDiagnostic(err: unknown): TransportDiagnosticCode {
  if (err instanceof ProtocolFrameError) {
    if (err.code === "malformed_frame" || err.code === "malformed_envelope" || err.code === "malformed_ct") {
      return err.code;
    }
  }
  return "malformed_frame";
}

// ── socket surface (browser WebSocket + test doubles) ──────────────────────

type SocketEventType = "open" | "message" | "close" | "error";

/** Handshake stage the socket is in. It decides how an unexpected close is
 *  classified: the post-`auth` grace window means a rejected signature
 *  (`auth_rejected`), anything earlier is a failed connect. */
type HandshakePhase = "open" | "challenge" | "sign" | "grace";

/** A failure gate armed for a whole handshake: `promise` rejects on an
 *  unexpected close/error, `release` detaches its socket listeners once the
 *  handshake is installed (the permanent listeners go on before the release). */
interface HandshakeFailureGate {
  promise: Promise<never>;
  release: () => void;
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: SocketEventType, listener: (event: unknown) => void): void;
  removeEventListener(type: SocketEventType, listener: (event: unknown) => void): void;
  readonly protocol?: string;
};

/** Browser default. Injected in tests so the Origin header can be set. */
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

const browserWebSocketFactory: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

/** Every async boundary of the handshake is bounded; a test may shorten it. */
export interface TransportTimeouts {
  openMs: number;
  challengeMs: number;
  authGraceMs: number;
  requestMs: number;
  signerMs: number;
}

export const DEFAULT_TRANSPORT_TIMEOUTS: Readonly<TransportTimeouts> = {
  openMs: 10_000,
  challengeMs: 5_000, // relay HELLO_TIMEOUT_MS
  authGraceMs: 300, // grace window after `auth` (immediate close = failure)
  requestMs: 10_000,
  signerMs: 10_000,
};

export interface RemotePiWebClientOptions {
  /** Relay URL — `ws(s)://` (servido em `/`). Valores `http(s)://` são
   * aceitos e coeridos para ws(s)://: é a forma canônica que o daemon
   * publica no URI de pareamento (`r=`). */
  relayUrl: string;
  webSocketFactory?: WebSocketFactory;
  /** Force an Ed25519 backend (tests/diagnostics only). */
  forceBackend?: Ed25519Backend;
  /** Device name announced in pair_request (`device_name`). */
  deviceName?: string;
  /** Test/diagnostic injection of the handshake timeouts (ms). */
  timeouts?: Partial<TransportTimeouts>;
  /** Test/diagnostic injection of the signer (defaults to the Ed25519
   *  factory below, which keeps the native + pure-ts backends). */
  signerFactory?: () => Promise<Ed25519Signer>;
}

/** What a request accepts as its OWN reply: the success kinds, the error kind
 *  the protocol defines for it, and (for `action_error`) the action it must
 *  name. Anything else is a wrong-kind reply, never an answer. */
interface RequestSpec {
  peer: string;
  room: string;
  inner: ClientMessage;
  accepts: readonly string[];
  acceptsError?: "action_error" | "pair_error" | "workspace_restart_error";
  expectedAction?: string;
}

interface PendingRequest {
  generation: number;
  peer: string;
  room: string;
  accepts: readonly string[];
  acceptsError: "action_error" | "pair_error" | "workspace_restart_error" | null;
  expectedAction: string | null;
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Deterministic-ish fallback for exotic environments.
  return `web-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export class RemotePiWebClient {
  readonly deviceName: string;

  private readonly relayUrl: string;
  private readonly factory: WebSocketFactory;
  private readonly signerFactory: () => Promise<Ed25519Signer>;
  private readonly timeouts: TransportTimeouts;

  private socket: WebSocketLike | null = null;
  private _signer: Ed25519Signer | null = null;
  private pending = new Map<string, PendingRequest>();
  private retired = new Map<string, "settled" | "expired">();
  private childRooms = new Set<string>();
  private listeners = new Set<(msg: ServerMessage, room: string) => void>();
  /** Dedicated `workspace_state` sink — lifecycle pushes never enter the
   *  generic message stream (and therefore never reach chat forwarding). */
  private workspaceStateListeners = new Set<(push: WorkspaceStatePush) => void>();
  private closeListeners = new Set<(code: TransportCloseCode) => void>();
  private diagnosticListeners = new Set<(code: TransportDiagnosticCode) => void>();
  /** Every timer the transport owns; `close()` clears all of them. */
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Every listener attached to the current socket, so it can be detached. */
  private socketListeners: Array<{ type: SocketEventType; listener: (event: unknown) => void }> = [];

  /** Monotonic socket generation. Bumped by connect/teardown/close, so a
   *  captured generation goes stale and every stale callback becomes inert. */
  private generation = 0;
  private connecting = false;
  private handshakeDone = false;
  /** Stage of the in-flight handshake (see `HandshakePhase`). */
  private handshakePhase: HandshakePhase = "open";
  private closed = false;
  /** Rejects the in-flight connect when `close()` arrives mid-handshake. */
  private abortConnect: ((err: Error) => void) | null = null;
  private abortPromise: Promise<never> | null = null;
  /** The one host this client is allowed to talk to (bound on first use). */
  private expectedHostPeer: string | null = null;

  constructor(options: RemotePiWebClientOptions) {
    // O daemon publica o relay na forma canônica http(s):// (a mesma em todo
    // o remote-pi) e o URI de pareamento carrega esse valor em `r=`. Quem
    // cola o URI — ou simplesmente digita o que vê — entrega https:// aqui, e
    // `new WebSocket` rejeita qualquer scheme que não seja ws/wss. Coerce na
    // fronteira (mesma normalização do `r=`/persistência): o WebSocket só é
    // aberto com ws(s)://.
    // `normalizeRelayUrl` is the SAME normalization the `r=` parameter and the
    // persisted session use (one rule, no drift): trim, `http(s)` → `ws(s)`,
    // trailing slashes dropped, credentials/query/fragment refused with fixed
    // text. A malformed value fails here, before a socket exists.
    this.relayUrl = normalizeRelayUrl(options.relayUrl);
    this.factory = options.webSocketFactory ?? browserWebSocketFactory;
    this.signerFactory = options.signerFactory ?? (() => createEd25519Signer(options.forceBackend));
    this.timeouts = { ...DEFAULT_TRANSPORT_TIMEOUTS, ...options.timeouts };
    this.deviceName = options.deviceName ?? "Remote Pi Web";
  }

  /** Relay identity of this client = its ephemeral App-key (base64 std). */
  get peerId(): string {
    return this.requireSigner().publicKeyBase64;
  }

  get signer(): Ed25519Signer {
    return this.requireSigner();
  }

  /** Backend used for Ed25519 — surfaced in the UI (capability detection). */
  get backend(): Ed25519Backend {
    return this.requireSigner().backend;
  }

  /** Relay URL actually dialed (normalized `ws(s)://`). */
  get relayPeerUrl(): string {
    return this.relayUrl;
  }

  get connected(): boolean {
    return this.handshakeDone && !this.closed;
  }

  /** The host peer this client is bound to (null until the first operation). */
  get boundHostPeer(): string | null {
    return this.expectedHostPeer;
  }

  private requireSigner(): Ed25519Signer {
    if (!this._signer) throw new TransportError("not_connected");
    return this._signer;
  }

  onServerMessage(listener: (msg: ServerMessage, room: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** UNEXPECTED connection loss only (a future adapter's signal). An explicit
   *  `close()` never notifies. */
  onClose(listener: (code: TransportCloseCode) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Fixed-code notices for frames the transport refused. */
  onDiagnostic(listener: (code: TransportDiagnosticCode) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  /**
   * Opens the relay WS and runs hello → challenge → auth. Resolves once the
   * auth frame is sent and the socket is still alive after a short grace
   * window (the relay closes immediately on auth failure and says nothing on
   * success). A fresh ephemeral key is created for every successful connect;
   * a failed handshake releases it.
   */
  async connect(): Promise<void> {
    if (this.closed) throw new TransportError("closed");
    if (this.connecting) throw new TransportError("connecting");
    if (this.handshakeDone) throw new TransportError("already_connected");
    this.connecting = true;
    this.handshakePhase = "open";

    // Everything this attempt captures is bound to this generation; `close()`
    // bumps it (and rejects the abort promise) so no late callback reopens.
    const generation = ++this.generation;
    const abort = new Promise<never>((_, reject) => {
      this.abortConnect = (err) => reject(err);
    });
    abort.catch(() => {
      /* the race below owns the outcome; keep a late abort from bubbling */
    });
    this.abortPromise = abort;

    try {
      const signer = await this.wait(generation, this.timeouts.signerMs, "signer_timeout", this.signerFactory());
      if (generation !== this.generation) throw new TransportError("closed");
      this._signer = signer;

      // O subprotocolo `remote-pi.1` é OPCIONAL — o relay ecoa quando
      // pedido, e clientes nativos (remote-pi, app, Cockpit) nunca o pedem.
      // Clientes de NAVEGADOR não podem: o edge do Cloudflare, na frente do
      // túnel, engole o header `Sec-WebSocket-Protocol` da resposta 101, e o
      // browser então fecha a conexão por spec (RFC 6455 — pediu subprotocolo,
      // não recebeu echo → falha obrigatória). Atrás de CF o handshake só
      // passa SEM o pedido. Conexão direta ao relay segue podendo negociar.
      const socket = this.factory(this.relayUrl, []);
      this.socket = socket;

      // A handshake step that let an unexpected close/error slip through
      // would let `connect()` resolve on a DEAD socket: a real WebSocket
      // silently discards `send` once closing, so the `auth` frame would
      // never leave and no reply would ever come. ONE failure gate therefore
      // stays armed from socket creation until the handshake is installed,
      // and EVERY step races it — there is no handler-free gap between the
      // steps (e.g. while the signer signs).
      const failureGate = this.awaitHandshakeFailure(generation, socket);
      const handshakeFailed = failureGate.promise;
      handshakeFailed.catch(() => {
        /* the races below own the outcome; keep a late failure handled */
      });

      // Each handshake step registers handlers for the duration of that step
      // only; once it settles they are detached (a resolved handshake step
      // must not stay subscribed to the live socket).
      const openStep = this.socketListeners.length;
      await this.wait(generation, this.timeouts.openMs, "connect_timeout",
        new Promise<void>((resolve, reject) => {
          this.track(socket, "open", () => resolve());
          this.track(socket, "error", () => reject(new TransportError("connect_failed")));
          this.track(socket, "close", () => reject(new TransportError("connect_failed")));
        }), handshakeFailed);
      this.releaseSince(openStep);

      const hello: ClientMessage = {
        type: "hello",
        id: newId(),
        pubkey: signer.publicKeyBase64,
        room_id: HOST_ROOM,
      };
      // The challenge listener is armed BEFORE `hello` goes out: a relay that
      // answers within the same tick must not be able to answer into the void.
      this.handshakePhase = "challenge";
      const challengeStep = this.socketListeners.length;
      const challengePromise = this.awaitChallenge(generation, socket);
      socket.send(JSON.stringify(hello));

      const challenge = await this.wait(generation, this.timeouts.challengeMs, "challenge_timeout",
        challengePromise, handshakeFailed);
      this.releaseSince(challengeStep);

      let nonceBytes: Uint8Array;
      try {
        nonceBytes = Uint8Array.from(atob(challenge), (ch) => ch.charCodeAt(0));
      } catch {
        throw new TransportError("malformed_challenge");
      }

      this.handshakePhase = "sign";
      const signature = await this.wait(generation, this.timeouts.signerMs, "signer_timeout", signer.sign(nonceBytes), handshakeFailed);
      if (generation !== this.generation) throw new TransportError("closed");
      const sigB64 = btoa(String.fromCharCode(...signature));
      // Grace window: the relay closes at once when auth fails, and says
      // nothing on success. The close listener is armed BEFORE `auth` goes
      // out; an explicit close() still aborts the wait.
      this.handshakePhase = "grace";
      const graceStep = this.socketListeners.length;
      const gracePromise = this.awaitAuthGrace(generation, socket);
      // `auth` carries NO id — it is a relay handshake frame, not an inner
      // message (relay/src/auth/challenge.rs).
      socket.send(JSON.stringify({ type: "auth", sig: sigB64 } satisfies RelayAuthFrame));
      await this.raceAbort(generation, gracePromise, handshakeFailed);
      this.releaseSince(graceStep);

      if (generation !== this.generation) throw new TransportError("closed");

      // From here on, every frame is a relay-forwarded inner message. Frames
      // are UNTRUSTED: they are validated (strict outer envelope, decodable
      // `ct`) before any property is read, and only a frame that matches this
      // generation, the bound host peer and the host room is acted on.
      this.track(socket, "message", (event: unknown) => {
        if (generation !== this.generation || this.closed) return;
        const text = (event as { data?: unknown }).data;
        if (typeof text !== "string") return;
        this.onFrame(text);
      });
      this.track(socket, "close", () => {
        if (generation !== this.generation || this.closed) return;
        this.onDropped();
      });

      // Handshake installed: retire the failure gate, so a later loss is the
      // drop signal instead of a handshake failure.
      failureGate.release();
      this.handshakeDone = true;
    } catch (err) {
      // A rejected handshake never leaves a socket, a key or a timer behind.
      this.teardown();
      throw err;
    } finally {
      this.connecting = false;
      this.abortConnect = null;
      this.abortPromise = null;
    }
  }

  // ── protocol operations ───────────────────────────────────────────────────

  /** pair_request on the host room (carve-out for unknown peers — plan 69).
   *  A `pair_error` reply becomes a typed, safe `PairRejectedError`: the
   *  host's free-text `message` is NEVER surfaced (only its typed `code`). */
  async pair(target: PairTarget): Promise<PairOk> {
    const reply = await this.request({
      peer: target.hostEpk,
      room: target.roomId,
      inner: pairRequest(newId(), target.token, this.deviceName) satisfies PairRequest,
      accepts: ["pair_ok"],
      acceptsError: "pair_error",
    });
    if (reply.type === "pair_error") {
      throw PairRejectedError.fromPairError(reply);
    }
    if (!isPairOk(reply)) throw new ProtocolFrameError("unexpected_reply");
    return reply;
  }

  /** host_hello — host version/hostname + capabilities (plan 69). */
  async helloHost(hostEpk: string, roomId: string = HOST_ROOM): Promise<HostHelloOk> {
    const reply = await this.request({
      peer: hostEpk,
      room: roomId,
      inner: { type: "host_hello", id: newId() },
      accepts: ["host_hello_ok"],
      acceptsError: "action_error",
    });
    if (!isHostHelloOk(reply)) throw new ProtocolFrameError("unexpected_reply");
    return reply;
  }

  /** workspace_list — registered daemons ∪ workspaces added by clients.
   *  Its `room_id`s are the only child rooms this client will accept a proxied
   *  payload from (plus rooms it started or chatted on itself). */
  async listWorkspaces(hostEpk: string, roomId: string = HOST_ROOM): Promise<WorkspaceListOk> {
    const reply = await this.request({
      peer: hostEpk,
      room: roomId,
      inner: { type: "workspace_list", id: newId() },
      accepts: ["workspace_list_ok"],
      acceptsError: "action_error",
      expectedAction: "workspace_list",
    });
    if (!isWorkspaceListOk(reply)) throw new ProtocolFrameError("unexpected_reply");
    for (const entry of reply.workspaces) this.rememberRoom(entry.room_id);
    return reply;
  }

  /** fs_list — the host resolves and lists; the client never touches a path. */
  async fsList(
    hostEpk: string,
    path: string,
    options: { showHidden?: boolean; roomId?: string } = {},
  ): Promise<FsListOk> {
    const reply = await this.request({
      peer: hostEpk,
      room: options.roomId ?? HOST_ROOM,
      inner: {
        type: "fs_list",
        id: newId(),
        path,
        show_hidden: options.showHidden ?? false,
      },
      accepts: ["fs_list_ok"],
      acceptsError: "action_error",
      expectedAction: "fs_list",
    });
    if (!isFsListOk(reply)) throw new ProtocolFrameError("unexpected_reply");
    return reply;
  }

  /** workspace_start — spawn (or adopt) a Pi in `cwd`; returns its room. */
  async startWorkspace(hostEpk: string, cwd: string, roomId: string = HOST_ROOM): Promise<WorkspaceStartOk> {
    const reply = await this.request({
      peer: hostEpk,
      room: roomId,
      inner: { type: "workspace_start", id: newId(), cwd },
      accepts: ["workspace_start_ok"],
      acceptsError: "action_error",
      expectedAction: "workspace_start",
    });
    if (!isWorkspaceStartOk(reply)) throw new ProtocolFrameError("unexpected_reply");
    this.rememberRoom(reply.room_id);
    return reply;
  }

  /**
   * workspace_restart — start/revive a workspace by cwd; idempotent while it
   * is already live. Rides the SAME pending registry as every other request:
   * only a `workspace_restart_ok` (or a `workspace_restart_error` naming this
   * request) settles it, so a `workspace_state` push or a proxied child frame
   * can never answer it. The ok carries NO `room_id` — callers must relist the
   * catalog to learn the room identity.
   */
  async restartWorkspace(
    hostEpk: string,
    cwd: string,
    roomId: string = HOST_ROOM,
  ): Promise<WorkspaceRestartOk> {
    const reply = await this.request({
      peer: hostEpk,
      room: roomId,
      inner: { type: "workspace_restart", id: newId(), cwd },
      accepts: ["workspace_restart_ok"],
      acceptsError: "workspace_restart_error",
    });
    if (reply.type === "workspace_restart_error") {
      // Only the closed `code` crosses; the raw `message` (which embeds the
      // cwd) is dropped by the typed error.
      throw WorkspaceRestartRejectedError.fromRestartError(reply);
    }
    if (!isWorkspaceRestartOk(reply)) throw new ProtocolFrameError("unexpected_reply");
    return reply;
  }

  /**
   * workspace_add — persist `path` in the host catalog. The only reply is
   * `action_ok{action:"workspace_add"}` or `action_error`; the host does NOT
   * echo a canonical cwd, so a caller that needs one must relist and match by
   * the value the catalog reports (never fabricate it from the request).
   */
  async addWorkspace(hostEpk: string, path: string, roomId: string = HOST_ROOM): Promise<void> {
    const reply = await this.request({
      peer: hostEpk,
      room: roomId,
      inner: { type: "workspace_add", id: newId(), path },
      accepts: ["action_ok"],
      acceptsError: "action_error",
      expectedAction: "workspace_add",
    });
    if (reply.type !== "action_ok" || reply.action !== "workspace_add") {
      throw new ProtocolFrameError("unexpected_reply");
    }
  }

  /**
   * Dedicated sink for the `workspace_state` PUSH (no `id`/`in_reply_to`), so
   * a lifecycle frame can never reach the generic `onServerMessage` stream —
   * and therefore never reaches the chat forwarding path. Frames are validated
   * BEFORE any field is read. Returns the unsubscribe function.
   */
  onWorkspaceState(listener: (push: WorkspaceStatePush) => void): () => void {
    this.workspaceStateListeners.add(listener);
    return () => this.workspaceStateListeners.delete(listener);
  }

  /**
   * Sends a chat message into a workspace THROUGH the host proxy (plan 69,
   * decision B): the client anchors only on room "host", so the user_message
   * rides inside `host_forward{room, ct}` addressed to the host. The echo
   * (`user_message`) and the stream (`agent_chunk`/`agent_done`) come back
   * as `host_message{room, ct}` — unwrapped and filed by room, they reach
   * onServerMessage listeners as plain inner messages (second argument is
   * the workspace room). Fire-and-forget by design; returns the inner
   * user_message id, which the echo and the stream reference.
   */
  sendChat(hostEpk: string, roomId: string, text: string, images?: readonly WireImage[]): string {
    const id = newId();
    const inner: ClientMessage =
      images !== undefined && images.length > 0
        ? { type: "user_message", id, text, images: [...images] }
        : { type: "user_message", id, text };
    const forward: HostForward = {
      type: "host_forward",
      id: newId(),
      room: roomId,
      ct: encodeCt(inner),
    };
    this.rawSend(hostEpk, HOST_ROOM, forward);
    // Chatting on a room is the client's own statement that the room exists:
    // its (room-scoped) pushes are accepted from then on.
    this.rememberRoom(roomId);
    return id;
  }

  /**
   * Asks the workspace Pi for its available models (`list_models`). Rides the
   * SAME host_forward proxy as chat: the request is addressed to the child
   * room and the `models_list` reply comes back as a `host_message` filed by
   * that room, reaching onServerMessage listeners with the room as the second
   * argument. Returns the inner request id so the caller can correlate the
   * reply (a proxied reply never settles a host-room RPC).
   */
  sendListModels(hostEpk: string, roomId: string): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({ type: "list_models", id }));
  }

  /** Switches the workspace Pi's model (`model_set`). Same proxy + correlation
   *  contract as `sendListModels`; the reply is `action_ok{action:"model_set"}`
   *  or `action_error`. */
  sendModelSet(hostEpk: string, roomId: string, provider: string, modelId: string): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({
      type: "model_set",
      id,
      provider,
      model_id: modelId,
    }));
  }

  /** Sets the workspace Pi's thinking level (`thinking_set`). */
  sendThinkingSet(hostEpk: string, roomId: string, level: ThinkingLevel): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({ type: "thinking_set", id, level }));
  }

  /** Asks the workspace Pi for its installed skills (`pi_surface`). Rides the
   *  same proxy as chat: the reply (`pi_surface_ok`) arrives on this room. */
  sendPiSurface(hostEpk: string, roomId: string): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({ type: "pi_surface", id }));
  }

  /** Runs ONE installed skill (`skill_invoke`). The host refuses a name it does
   *  not have — it never passes a literal `/skill:<name>` through to the model.
   *  The skill's output arrives on the normal chat channels. */
  sendSkillInvoke(hostEpk: string, roomId: string, name: string, args?: string): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({
      type: "skill_invoke",
      id,
      name,
      ...(args === undefined || args === "" ? {} : { args }),
    }));
  }

  /** Asks the workspace Pi for its AgentSessions (`session_list`). */
  sendSessionList(hostEpk: string, roomId: string): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({ type: "session_list", id }));
  }

  /** Reads ONE session's transcript (`session_read`) WITHOUT switching it.
   *  `sessionId` must be one the host listed; a path is refused host-side. */
  sendSessionRead(
    hostEpk: string,
    roomId: string,
    sessionId: string,
    options: { limit?: number; before?: string } = {},
  ): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({
      type: "session_read",
      id,
      session_id: sessionId,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.before === undefined ? {} : { before: options.before }),
    }));
  }

  /** Makes another session the LIVE one (`session_switch`). This is a real
   *  state change for every paired client — the read-only path is
   *  `sendSessionRead`. */
  sendSessionSwitch(hostEpk: string, roomId: string, sessionId: string): string {
    return this._forwardToRoom(hostEpk, roomId, (id) => ({
      type: "session_switch",
      id,
      session_id: sessionId,
    }));
  }

  /** ONE host_forward sender shared by the typed actions above: mint the inner
   *  id, wrap the inner message, send on the host room and remember the room
   *  (addressing a room is the client's own statement that it exists). */
  private _forwardToRoom(
    hostEpk: string,
    roomId: string,
    build: (id: string) => ClientMessage,
  ): string {
    const id = newId();
    const forward: HostForward = {
      type: "host_forward",
      id: newId(),
      room: roomId,
      ct: encodeCt(build(id)),
    };
    this.rawSend(hostEpk, HOST_ROOM, forward);
    this.rememberRoom(roomId);
    return id;
  }

  /** Terminal. Cancels everything this client owns, in an order in which no
   *  callback can resurrect the connection. Never notifies onClose. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new TransportError("closed");
    this.abortConnect?.(err);
    this.abortConnect = null;
    this.abortPromise = null;
    this.rejectPending(err);
    this.teardown();
  }

  // ── internals: lifecycle ──────────────────────────────────────────────────

  /** Bumps the generation and releases every resource of the current socket:
   *  timers, socket listeners, the socket itself and the ephemeral key. Never
   *  throws (a dead socket already closing is normal). */
  private teardown(): void {
    this.generation += 1;
    this.handshakeDone = false;
    this.handshakePhase = "open";
    this.clearTimers();
    this.detachAll();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* the socket is already gone */
      }
    }
    this._signer = null;
  }

  private track(socket: WebSocketLike, type: SocketEventType, listener: (event: unknown) => void): void {
    socket.addEventListener(type, listener);
    this.socketListeners.push({ type, listener });
  }

  private untrack(socket: WebSocketLike, type: SocketEventType, listener: (event: unknown) => void): void {
    socket.removeEventListener(type, listener);
    this.socketListeners = this.socketListeners.filter(
      (entry) => entry.type !== type || entry.listener !== listener,
    );
  }

  /** Detaches the handlers a COMPLETED handshake step registered, so only the
   *  permanent post-handshake listeners stay subscribed to the live socket. */
  private releaseSince(index: number): void {
    const socket = this.socket;
    const stale = this.socketListeners.slice(index);
    this.socketListeners = this.socketListeners.slice(0, index);
    if (socket) {
      for (const { type, listener } of stale) socket.removeEventListener(type, listener);
    }
  }

  private detachAll(): void {
    const socket = this.socket;
    if (socket) {
      for (const { type, listener } of this.socketListeners) {
        socket.removeEventListener(type, listener);
      }
    }
    this.socketListeners = [];
  }

  private setTimer(fire: () => void, ms: number): ReturnType<typeof setTimeout> | null {
    if (this.closed) {
      fire();
      return null;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fire();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Bounded wait: races `work` against a fixed deadline, the abort signal of
   * an explicit `close()` and the generation. The timer is always cleared.
   */
  private async wait<T>(
    generation: number,
    ms: number,
    timeoutCode: TransportErrorCode,
    work: Promise<T>,
    extra?: Promise<unknown>,
  ): Promise<T> {
    let expire: (() => void) | null = null;
    const deadline = new Promise<never>((_, reject) => {
      expire = () => reject(new TransportError(timeoutCode));
    });
    deadline.catch(() => undefined);
    const timer = this.setTimer(() => expire?.(), ms);
    try {
      return await this.raceAbort(generation, Promise.race([work, deadline]) as Promise<T>, extra);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    }
  }

  /** Races `work` against an explicit `close()`, a stale generation and the
   *  handshake failure gate (`extra`, armed for a whole handshake) only. */
  private raceAbort<T>(generation: number, work: Promise<T>, extra?: Promise<unknown>): Promise<T> {
    if (generation !== this.generation || this.closed) return Promise.reject(new TransportError("closed"));
    // The race owns the outcome; keep a late rejection of the loser handled.
    work.catch(() => undefined);
    extra?.catch(() => undefined);
    const racers: Promise<unknown>[] = [work];
    if (this.abortPromise) racers.push(this.abortPromise);
    if (extra) racers.push(extra);
    return Promise.race(racers) as Promise<T>;
  }

  /** Fails the handshake the moment the socket closes or errors. Armed for
   *  the WHOLE handshake — every step races it — so a loss landing between
   *  two steps (e.g. while the signer signs) rejects the connect instead of
   *  being swallowed. An immediate close after `auth` is a rejected
   *  signature (`auth_rejected`); any other loss is a failed connect. A stale
   *  generation (or an explicit `close()`) is inert here: that outcome
   *  belongs to the abort, and the handler never throws from a callback. */
  private awaitHandshakeFailure(generation: number, socket: WebSocketLike): HandshakeFailureGate {
    let rejectWith: (code: TransportErrorCode) => void = () => {};
    const promise = new Promise<never>((_, reject) => {
      rejectWith = (code) => {
        if (generation !== this.generation || this.closed) return;
        reject(new TransportError(code));
      };
    });
    // An immediate close after `auth` is the relay REJECTING the signature;
    // any other loss — a close earlier in the handshake or an error event at
    // any point — is a failed connect.
    const onClose = () => rejectWith(this.handshakePhase === "grace" ? "auth_rejected" : "connect_failed");
    const onError = () => rejectWith("connect_failed");
    this.track(socket, "close", onClose);
    this.track(socket, "error", onError);
    return {
      promise,
      release: () => {
        this.untrack(socket, "close", onClose);
        this.untrack(socket, "error", onError);
      },
    };
  }

  private awaitChallenge(generation: number, socket: WebSocketLike): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onMessage = (event: unknown) => {
        if (generation !== this.generation) return;
        const text = (event as { data?: unknown }).data;
        if (typeof text !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return; // not ours (relay control frames are plain text)
        }
        // Untrusted frame: `null`, primitives and arrays are not a challenge
        // (a bare `parsed.type` would throw from inside the socket callback).
        if (!isJsonObject(parsed)) return;
        if (parsed.type === "challenge" && typeof parsed.nonce === "string") {
          this.untrack(socket, "message", onMessage);
          resolve(parsed.nonce);
        }
      };
      this.track(socket, "message", onMessage);
      this.track(socket, "close", () => reject(new TransportError("connect_failed")));
    });
  }

  /** Grace window after `auth`: resolve when it elapses, fail if the relay
   *  dropped us first (an immediate close after `auth` = rejected signature). */
  private awaitAuthGrace(generation: number, socket: WebSocketLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.track(socket, "close", () => reject(new TransportError("auth_rejected")));
      const timer = this.setTimer(() => resolve(), this.timeouts.authGraceMs);
      if (timer === null) resolve();
      if (generation !== this.generation) reject(new TransportError("closed"));
    });
  }

  // ── internals: outbound ───────────────────────────────────────────────────

  private rawSend(peer: string, room: string, inner: ClientMessage): void {
    if (this.closed) throw new TransportError("closed");
    if (!this.socket || !this.handshakeDone) throw new TransportError("not_connected");
    this.bindHost(peer);
    this.socket.send(encodeOuter(peer, room, inner));
  }

  /** The client is bound to ONE host peer from its first operation on; a
   *  second host can never take over the session or its listeners. */
  private bindHost(peer: string): void {
    if (this.expectedHostPeer === null) {
      this.expectedHostPeer = peer;
      return;
    }
    if (this.expectedHostPeer !== peer) throw new TransportError("host_rebind_refused");
  }

  private request(spec: RequestSpec): Promise<ServerMessage> {
    if (this.closed) return Promise.reject(new TransportError("closed"));
    if (!this.socket || !this.handshakeDone) return Promise.reject(new TransportError("not_connected"));
    try {
      this.bindHost(spec.peer);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new TransportError("not_connected"));
    }
    const generation = this.generation;
    return new Promise<ServerMessage>((resolve, reject) => {
      const id = spec.inner.id;
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        this.retire(id, "expired");
        reject(new TransportError("request_timeout"));
      }, this.timeouts.requestMs);
      if (timer === null) {
        reject(new TransportError("closed"));
        return;
      }
      const entry: PendingRequest = {
        generation,
        peer: spec.peer,
        room: spec.room,
        accepts: spec.accepts,
        acceptsError: spec.acceptsError ?? null,
        expectedAction: spec.expectedAction ?? null,
        resolve,
        reject,
        timer,
      };
      this.pending.set(id, entry);
      try {
        this.rawSend(spec.peer, spec.room, spec.inner);
      } catch (err) {
        this.dropEntry(id, entry);
        reject(err instanceof Error ? err : new TransportError("not_connected"));
      }
    });
  }

  // ── internals: inbound ────────────────────────────────────────────────────

  /** One inbound frame: validated first, then dispatched by kind. */
  private onFrame(text: string): void {
    let decoded: DecodedEnvelope<ServerMessage>;
    try {
      decoded = decodeOuterChecked(text);
    } catch (err) {
      this.diagnose(frameDiagnostic(err));
      return;
    }
    // The client anchors on the host room and on ONE host peer: an envelope
    // from anywhere else is not part of this session, whatever it carries.
    if (decoded.fromRoom !== HOST_ROOM) {
      this.diagnose("unexpected_room");
      return;
    }
    if (this.expectedHostPeer === null || decoded.fromPeer !== this.expectedHostPeer) {
      this.diagnose("unexpected_peer");
      return;
    }
    const msg = decoded.inner;
    if (msg.type === "host_message") {
      this.onProxy(msg);
      return;
    }
    // `workspace_state` is the ONE host-room PUSH. It is split off BEFORE the
    // reply correlation path: it carries no `id`/`in_reply_to`, and even if a
    // hostile/wrong host attached one, the strict push guard refuses the frame
    // instead of letting it settle an RPC.
    if (msg.type === "workspace_state") {
      this.onWorkspaceStateFrame(msg);
      return;
    }
    this.onHostFrame(msg);
  }

  /**
   * Host-room lifecycle push. Validated first (`isWorkspaceStatePush`), then
   * fanned out ONLY to the dedicated sink: it never touches the pending
   * registry, so it cannot settle a request, and it never reaches
   * `emitMessage`, so it cannot be mistaken for chat traffic. ANY frame that
   * fails the guard — malformed, OR carrying `id`/`in_reply_to` — is diagnosed
   * as `malformed_workspace_state` and DROPPED here: a `workspace_state` never
   * settles an RPC and never reaches the chat forwarding path, whatever
   * correlation it claims.
   */
  private onWorkspaceStateFrame(msg: ServerMessage): void {
    if (!isWorkspaceStatePush(msg)) {
      this.diagnose("malformed_workspace_state");
      return;
    }
    // Re-checked through the guard: only the five documented fields are read.
    const push: WorkspaceStatePush = {
      type: "workspace_state",
      cwd: msg.cwd,
      state: msg.state,
      last_error: msg.last_error,
      restarts: msg.restarts,
    };
    for (const listener of [...this.workspaceStateListeners]) listener(push);
  }

  /** Host-room message: `in_reply_to` settles the request that declared this
   *  id, nothing else. A reply that matches no live request is NOT a push. */
  private onHostFrame(msg: ServerMessage): void {
    const id = typeof msg.in_reply_to === "string" ? msg.in_reply_to : null;
    if (id === null) {
      this.emitMessage(msg, HOST_ROOM);
      return;
    }
    const entry = this.pending.get(id);
    if (!entry) {
      const retired = this.retired.get(id);
      if (retired === "settled") this.diagnose("duplicate_reply");
      else if (retired === "expired") this.diagnose("late_reply");
      else this.diagnose("unknown_reply");
      return;
    }
    this.settle(entry, msg);
  }

  /** `host_message{room, ct}` from the host: a CHILD room push. It is filed by
   *  room for the listeners and can never settle a host request — its
   *  `in_reply_to`, however well-formed, belongs to another room's exchange. */
  private onProxy(msg: ServerMessage): void {
    if (!isHostMessage(msg)) {
      this.diagnose("malformed_proxy");
      return;
    }
    const room = msg.room;
    if (room === HOST_ROOM || !this.childRooms.has(room)) {
      this.diagnose("unknown_child_room");
      return;
    }
    let inner: ServerMessage;
    try {
      inner = decodeCtChecked(msg.ct);
    } catch (err) {
      this.diagnose(frameDiagnostic(err));
      return;
    }
    if (inner.type === "host_message") {
      this.diagnose("malformed_proxy"); // no nested proxies
      return;
    }
    // A proxied child frame is CHILD-room traffic even when it names
    // `workspace_state`: the host state of this machine never travels inside
    // a host_message, so it is filed here and can never alter host state.
    this.emitMessage(inner, room);
  }

  /** A live request's own reply: the kind must be the one the request
   *  declared (and an action error must name the action it was sent for),
   *  otherwise nothing settles — the request keeps waiting and a fixed
   *  diagnostic is emitted instead. */
  private settle(entry: PendingRequest, msg: ServerMessage): void {
    const expectedError = entry.acceptsError;
    const kindOk =
      entry.accepts.includes(msg.type) ||
      (expectedError !== null && msg.type === expectedError);
    if (!kindOk) {
      this.diagnose("wrong_response_kind");
      return;
    }
    const id = typeof msg.in_reply_to === "string" ? msg.in_reply_to : null;
    if (id === null) {
      this.diagnose("malformed_reply");
      return;
    }
    if (msg.type === "action_error") {
      if (!isActionError(msg)) {
        this.diagnose("malformed_reply");
        return;
      }
      if (entry.expectedAction !== null && msg.action !== entry.expectedAction) {
        this.diagnose("wrong_action_error");
        return;
      }
      this.dropEntry(id, entry);
      this.retire(id, "settled");
      // `ActionRejectedError` re-derives BOTH the action label and the
      // message from allow-lists: neither the host's raw `error` string nor
      // a hostile `action` value survives on the exception.
      entry.reject(new ActionRejectedError(msg.action, msg.error));
      return;
    }
    if (msg.type === "action_ok") {
      if (!isActionOk(msg)) {
        this.diagnose("malformed_reply");
        return;
      }
      // Symmetric with `action_error`: an ok that names ANOTHER action is
      // refused WITHOUT settling, so the request keeps waiting for its own
      // valid reply instead of resolving on a mismatched success.
      if (entry.expectedAction !== null && msg.action !== entry.expectedAction) {
        this.diagnose("wrong_action_error");
        return;
      }
    }
    if (msg.type === "workspace_restart_error") {
      if (!isWorkspaceRestartError(msg)) {
        this.diagnose("malformed_reply");
        return;
      }
      this.dropEntry(id, entry);
      this.retire(id, "settled");
      // Only the closed `code` survives; the raw `message` is dropped.
      entry.reject(WorkspaceRestartRejectedError.fromRestartError(msg));
      return;
    }
    this.dropEntry(id, entry);
    this.retire(id, "settled");
    entry.resolve(msg);
  }

  private onDropped(): void {
    this.teardown();
    this.rejectPending(new TransportError("connection_lost"));
    if (!this.closed) {
      for (const listener of [...this.closeListeners]) listener("relay_dropped");
    }
  }

  private emitMessage(msg: ServerMessage, room: string): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(msg, room);
  }

  private diagnose(code: TransportDiagnosticCode): void {
    if (this.closed) return;
    for (const listener of [...this.diagnosticListeners]) listener(code);
  }

  // ── internals: bookkeeping ────────────────────────────────────────────────

  private dropEntry(id: string, entry: PendingRequest): void {
    clearTimeout(entry.timer);
    this.timers.delete(entry.timer);
    this.pending.delete(id);
  }

  /** Remembers a retired id only to classify a late/duplicate reply; the map
   *  is bounded (oldest evicted) so a long-lived socket cannot grow it. */
  private retire(id: string, reason: "settled" | "expired"): void {
    this.retired.delete(id);
    this.retired.set(id, reason);
    while (this.retired.size > MAX_RETIRED_IDS) {
      const oldest = this.retired.keys().next();
      if (oldest.done) break;
      this.retired.delete(oldest.value);
    }
  }

  private rememberRoom(room: string): void {
    if (!room || room === HOST_ROOM) return;
    this.childRooms.delete(room);
    this.childRooms.add(room);
    while (this.childRooms.size > MAX_CHILD_ROOMS) {
      const oldest = this.childRooms.values().next();
      if (oldest.done) break;
      this.childRooms.delete(oldest.value);
    }
  }

  private rejectPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.timers.delete(pending.timer);
      this.pending.delete(id);
      this.retire(id, "expired");
      pending.reject(err);
    }
    this.pending.clear();
  }
}
