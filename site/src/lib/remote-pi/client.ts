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
 */

import {
  createEd25519Signer,
  type Ed25519Backend,
  type Ed25519Signer,
} from "./ed25519.ts";
import {
  ActionRejectedError,
  decodeCt,
  decodeOuter,
  encodeCt,
  encodeOuter,
  type ActionError,
  type ClientMessage,
  type FsListOk,
  type HostForward,
  type HostHelloOk,
  type HostMessage,
  type PairOk,
  type PairTarget,
  type ServerMessage,
  type WorkspaceListOk,
  type WorkspaceStartOk,
} from "./protocol.ts";

/** Subprotocol offered on the WS handshake; the relay echoes the negotiated
 *  one (plan 69 W4 relay prerequisite). Name is a client-side convention —
 *  PROTOCOL.md does not fix it (documented ambiguity). */
export const WEB_CLIENT_SUBPROTOCOL = "remote-pi.1";

/** Host control-plane room (plan 67/69) — the ONLY room this client
 *  anchors on (decision B: one connection does not sustain host + workspace
 *  rooms; chat is proxied via host_forward/host_message). */
const HOST_ROOM = "host";

const REQUEST_TIMEOUT_MS = 10_000;
const HANDSHAKE_CHALLENGE_TIMEOUT_MS = 5_000; // relay HELLO_TIMEOUT_MS
/** Grace window after `auth` to observe an immediate close (auth failure). */
const AUTH_GRACE_MS = 300;

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  readonly protocol?: string;
};

/** Browser default. Injected in tests so the Origin header can be set. */
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

const browserWebSocketFactory: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

export interface RemotePiWebClientOptions {
  /** Relay URL, e.g. `wss://relay.example` (WS is served at `/`). */
  relayUrl: string;
  webSocketFactory?: WebSocketFactory;
  /** Force an Ed25519 backend (tests/diagnostics only). */
  forceBackend?: Ed25519Backend;
  /** Device name announced in pair_request (`device_name`). */
  deviceName?: string;
}

interface PendingRequest {
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
  private readonly forceBackend?: Ed25519Backend;
  private socket: WebSocketLike | null = null;
  private _signer: Ed25519Signer | null = null;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(msg: ServerMessage, room: string) => void>();
  private handshakeDone = false;
  private closed = false;

  constructor(options: RemotePiWebClientOptions) {
    this.relayUrl = options.relayUrl;
    this.factory = options.webSocketFactory ?? browserWebSocketFactory;
    this.forceBackend = options.forceBackend;
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

  private requireSigner(): Ed25519Signer {
    if (!this._signer) throw new Error("signer não inicializado — chame connect() antes");
    return this._signer;
  }

  onServerMessage(listener: (msg: ServerMessage, room: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Opens the relay WS and runs hello → challenge → auth. Resolves once the
   * auth frame is sent and the socket is still alive after a short grace
   * window (the relay closes immediately on auth failure and says nothing on
   * success).
   */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("client já fechado");
    const signer = await createEd25519Signer(this.forceBackend);
    this._signer = signer;

    const socket = this.factory(this.relayUrl, [WEB_CLIENT_SUBPROTOCOL]);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
      };
      const fail = (err: Error) => {
        if (settled) return; // undici re-fires error on close(); never loop
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          /* socket already closing */
        }
        reject(err);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onClose = () => fail(new Error("conexão fechada durante o handshake"));
      socket.addEventListener("error", () =>
        fail(new Error(`falha ao conectar no relay ${this.relayUrl}`)),
      );
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onClose);
    });

    const hello: ClientMessage = {
      type: "hello",
      id: newId(),
      pubkey: signer.publicKeyBase64,
      room_id: HOST_ROOM,
    };
    socket.send(JSON.stringify(hello));

    // ── challenge ──
    const challenge = await new Promise<{ nonce: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timeout: relay não enviou challenge")),
        HANDSHAKE_CHALLENGE_TIMEOUT_MS,
      );
      const onMessage = (event: unknown) => {
        const text = (event as { data?: unknown }).data;
        if (typeof text !== "string") return;
        let parsed: { type?: string; nonce?: string };
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed.type === "challenge" && typeof parsed.nonce === "string") {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          resolve({ nonce: parsed.nonce });
        }
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("conexão fechada antes do challenge"));
      });
    });

    const nonceBytes = Uint8Array.from(atob(challenge.nonce), (ch) => ch.charCodeAt(0));
    const signature = await signer.sign(nonceBytes);
    const sigB64 = btoa(String.fromCharCode(...signature));
    socket.send(JSON.stringify({ type: "auth", sig: sigB64 } satisfies ClientMessage));

    // Grace window: the relay closes at once when auth fails.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener("close", onClose);
        resolve();
      }, AUTH_GRACE_MS);
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error("relay fechou a conexão — assinatura de auth rejeitada?"));
      };
      socket.addEventListener("close", onClose);
    });

    // From here on, every frame is a relay-forwarded inner message.
    socket.addEventListener("message", (event: unknown) => {
      const text = (event as { data?: unknown }).data;
      if (typeof text !== "string") return;
      let decoded: ReturnType<typeof decodeOuter<ServerMessage>>;
      try {
        decoded = decodeOuter<ServerMessage>(text);
      } catch {
        return; // relay control frames / malformed lines are not ours
      }
      const msg = decoded.inner;
      // Proxy demux (plan 69, decision B): workspace traffic arrives wrapped
      // in host_message{room, ct}. Unwrap and file the inner message by room;
      // everything else (host control plane) is already on the host room.
      if (msg.type === "host_message") {
        const wrapped = msg as unknown as HostMessage;
        let inner: ServerMessage;
        try {
          inner = decodeCt<ServerMessage>(wrapped.ct);
        } catch {
          return; // malformed proxy payload — not ours
        }
        this.dispatch(inner, wrapped.room);
        return;
      }
      this.dispatch(msg, decoded.fromRoom);
    });
    socket.addEventListener("close", () => this.failAll(new Error("conexão com o relay caiu")));

    this.handshakeDone = true;
  }

  // ── protocol operations ───────────────────────────────────────────────────

  /** pair_request on the host room (carve-out for unknown peers — plan 69). */
  async pair(target: PairTarget): Promise<PairOk> {
    const reply = await this.request(target.hostEpk, target.roomId, {
      type: "pair_request",
      id: newId(),
      token: target.token,
      device_name: this.deviceName,
    });
    if (reply.type !== "pair_ok") {
      throw new Error(`pareamento falhou: ${reply.type}`);
    }
    return reply as PairOk;
  }

  /** host_hello — host version/hostname + capabilities (plan 69). */
  async helloHost(hostEpk: string, roomId: string = HOST_ROOM): Promise<HostHelloOk> {
    const reply = await this.request(hostEpk, roomId, { type: "host_hello", id: newId() });
    return reply as HostHelloOk;
  }

  /** workspace_list — registered daemons ∪ workspaces added by clients. */
  async listWorkspaces(hostEpk: string, roomId: string = HOST_ROOM): Promise<WorkspaceListOk> {
    const reply = await this.request(hostEpk, roomId, { type: "workspace_list", id: newId() });
    return reply as WorkspaceListOk;
  }

  /** fs_list — the host resolves and lists; the client never touches a path. */
  async fsList(
    hostEpk: string,
    path: string,
    options: { showHidden?: boolean; roomId?: string } = {},
  ): Promise<FsListOk> {
    const reply = await this.request(hostEpk, options.roomId ?? HOST_ROOM, {
      type: "fs_list",
      id: newId(),
      path,
      show_hidden: options.showHidden ?? false,
    });
    return reply as FsListOk;
  }

  /** workspace_start — spawn (or adopt) a Pi in `cwd`; returns its room. */
  async startWorkspace(hostEpk: string, cwd: string, roomId: string = HOST_ROOM): Promise<WorkspaceStartOk> {
    const reply = await this.request(hostEpk, roomId, {
      type: "workspace_start",
      id: newId(),
      cwd,
    });
    return reply as WorkspaceStartOk;
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
  sendChat(hostEpk: string, roomId: string, text: string): string {
    const id = newId();
    const forward: HostForward = {
      type: "host_forward",
      id: newId(),
      room: roomId,
      ct: encodeCt({ type: "user_message", id, text } satisfies ClientMessage),
    };
    this.rawSend(hostEpk, HOST_ROOM, forward);
    return id;
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("client fechado"));
    this.socket?.close();
    this.socket = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private rawSend(peer: string, room: string, inner: ClientMessage): void {
    if (!this.socket || !this.handshakeDone) {
      throw new Error("client não conectado — chame connect() antes");
    }
    this.socket.send(encodeOuter(peer, room, inner));
  }

  private request(peer: string, room: string, inner: ClientMessage): Promise<ServerMessage> {
    if (!this.socket || !this.handshakeDone) {
      return Promise.reject(new Error("client não conectado — chame connect() antes"));
    }
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(inner.id);
        reject(new Error(`timeout: sem resposta para ${inner.type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(inner.id, { resolve, reject, timer });
      try {
        this.rawSend(peer, room, inner);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(inner.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Files one inbound message: a pending request reply (matched by
   * `in_reply_to`) settles its promise; everything else — including
   * host_message-unwrapped workspace traffic — goes to the listeners tagged
   * with the room it belongs to.
   */
  private dispatch(msg: ServerMessage, room: string): void {
    const id = typeof msg.in_reply_to === "string" ? msg.in_reply_to : null;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.type === "action_error") {
        const err = msg as unknown as ActionError;
        pending.reject(new ActionRejectedError(err.action ?? "action", err.error ?? "unknown"));
      } else {
        pending.resolve(msg);
      }
      return;
    }
    for (const listener of this.listeners) listener(msg, room);
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
