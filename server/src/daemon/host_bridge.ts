/**
 * Plan/67 — supervisor's always-on relay connection on room `host`.
 *
 * Same Pi-key as workspace daemons; distinct room so the phone can talk
 * to the machine when no TUI/daemon cwd is live.
 *
 * Plan/69 W1 — this bridge is also the daemon-side pairing endpoint: it
 * answers `pair_request` on the host room (validating the token persisted
 * in `~/.pi/remote/pairing.json`), so `remote-pi-server pair` works with zero Pi
 * processes running.
 *
 * Plan/69 W2 — the bridge is also the host_forward/host_message PROXY
 * (spike decision B): the app anchors on room `host` only and forwards
 * child-addressed traffic through here; the bridge re-emits it under the
 * machine's own Pi-key toward the child room and re-wraps the child's
 * own-key replies as `host_message` for the apps. It is likewise the
 * lifecycle channel: the supervisor pushes `workspace_state` mirrors of
 * every ChildSlot transition through `pushWorkspaceState`.
 */

import { hostname, homedir } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "../transport/relay_client.js";
import { getOrCreateEd25519Keypair, listPeers } from "../pairing/storage.js";
import { hostPairing, type HostPairingSession } from "../pairing/host_pairing.js";
import { resolveRelayUrl, toWebSocketUrl } from "../config.js";
import {
  HOST_ROOM_ID,
  type ClientMessage,
  type CronResultWire,
  type ServerMessage,
  type WorkspaceState,
} from "../protocol/types.js";
import {
  handlePairRequest,
  handleWorkspaceAdd,
  handleWorkspaceList,
  handleWorkspaceRemove,
  handleWorkspaceRestart,
  handleWorkspaceStart,
  handleWorkspaceStop,
  type FleetOps,
  type HostReplySender,
} from "./host_control.js";
import { handleFsList, handleFsRead } from "./fs_nav.js";
import { takeChangesSnapshot } from "./changes.js";
import { describeModelsConfig, mutateModelsConfig, type ModelsOp } from "./models_config.js";
import { describeSettingsConfig, mutateSettingsConfig, type SettingsOp } from "./settings_config.js";
import {
  handleScheduleAdd,
  handleScheduleList,
  handleScheduleRemove,
  handleScheduleRunNow,
  handleScheduleSetEnabled,
} from "./schedule_handlers.js";
import { logRelayEvent } from "../log.js";
import { roomIdFor } from "../rooms.js";

export interface HostBridgeOptions {
  fleet: FleetOps;
  /** Injected for tests. */
  relayFactory?: (url: string, keypair: Awaited<ReturnType<typeof getOrCreateEd25519Keypair>>) => RelayClient;
  /** Injected for tests: the peer allow-list source (defaults to `listPeers`). */
  listPeersFn?: () => Promise<Array<{ remote_epk: string }>>;
  /** Plan/69 — pairing-token source for the host-room `pair_request` handler.
   *  Defaults to the process-wide store (`hostPairing`). */
  pairing?: HostPairingSession;
  /**
   * Plan/76 — identity the in-process SSE endpoint dials with.
   *
   * When set, this peer is treated as local: it bypasses the persisted
   * allow-list, because it is the server's OWN loopback connection, not a remote
   * device. Only ever set from `direct.ts`, where the listener is bound to
   * loopback and every non-loopback request has already been refused by the
   * origin/host gate.
   */
  localPeer?: string;
  /**
   * Plan/76 phase two — delivery channel for frames addressed to a browser peer.
   *
   * Defaults to sending the frame over the relay, which is byte-for-byte what
   * this class did before the option existed. A same-origin deployment can supply
   * a direct implementation so browser replies never enter the relay's routing
   * table at all.
   *
   * Child-daemon IPC does NOT go through this sink: `_forwardToChild` keeps using
   * `this.relay` and `_isOwnKeyInbound` keeps its inference. Only the
   * browser-facing direction is redirectable.
   */
  replySink?: ReplySink;
}

/**
 * Delivers one already-encoded frame to a browser peer.
 *
 * `frame` is the inner `ServerMessage` JSON with `ct` already base64-encoded by the
 * caller, so an implementation only has to decide HOW to hand it over, never how
 * to shape it.
 */
export interface ReplySink {
  /**
   * @param peer - destination peer (the browser's public key).
   * @param frame - the encoded envelope to deliver.
   * @returns `true` when this sink owns `peer` and delivered the frame; `false`
   *          to let the caller fall back to the relay. A WebSocket client is not
   *          an SSE stream, so declining is the normal answer for it.
   */
  deliver(peer: string, frame: string): boolean;
}

/**
 * Registry of in-process SSE peers that skip the pairing allow-list.
 *
 * One entry per OPEN stream. Each stream mints its own ephemeral keypair, so
 * this is a SET keyed by public key, not a single "the local peer" value.
 *
 * Why per-stream keys instead of reusing the host's: the relay routes by
 * `(peer, room)` and skips only the SENDING socket. When every stream shared the
 * host's key, tab B received tab A's outbound frames (measured: tabB got 2
 * frames for tabA's 1 request). Per-stream keys give each tab its own routing
 * bucket, so replies land only where they belong.
 */
const localSsePeers = new Set<string>();

/**
 * Authorise one in-process SSE peer to talk to the host room without a pairing
 * code.
 *
 * @param peer - the stream's public key, base64.
 * @returns an idempotent revoker; call it when the stream closes.
 */
export function authoriseLocalPeer(peer: string): () => void {
  localSsePeers.add(peer);
  return () => {
    localSsePeers.delete(peer);
  };
}

/**
 * Plan/76 phase two: the live bridge's local-injection entry point.
 *
 * Set while a `HostBridge` is running, cleared on stop. The SSE endpoint calls it to
 * hand a browser frame straight to the bridge instead of POSTing it back through the
 * relay and waiting for the relay to route it to this same process.
 *
 * A function rather than the instance itself, so a stopped bridge cannot be called
 * through a stale reference.
 */
let localInbound: ((line: string) => boolean) | null = null;

/**
 * Plan/76 phase two: the live SSE endpoint's reply delivery.
 *
 * Registered by `sse_endpoint` on module load and left null in a WebSocket-only
 * run. Keeping it as a registry here (instead of importing `sse_endpoint` from the
 * supervisor) avoids dragging the relay client and its WebSocket stack into every
 * process that merely imports the supervisor.
 */
let sseReplySink: ((peer: string, frame: string) => boolean) | null = null;

/**
 * Register the SSE endpoint's reply delivery.
 *
 * @param sink - delivers an encoded frame to the stream that owns `peer`, or
 *               returns `false` when `peer` is not an SSE stream.
 * @returns a function that unregisters it.
 */
export function registerSseReplySink(
  sink: (peer: string, frame: string) => boolean,
): () => void {
  sseReplySink = sink;
  return () => {
    if (sseReplySink === sink) sseReplySink = null;
  };
}

/**
 * Try to deliver a host reply to a local SSE stream.
 *
 * @param peer - destination peer.
 * @param frame - encoded envelope.
 * @returns `true` only when an SSE stream owned `peer` and took the frame. A
 *          `false` means the caller must use the relay — which is what every
 *          WebSocket client (desktop, mobile, CLI) needs.
 */
export function deliverSseReply(peer: string, frame: string): boolean {
  return sseReplySink === null ? false : sseReplySink(peer, frame);
}

/**
 * Deliver one browser frame directly to the running bridge, bypassing the relay.
 *
 * @param line - the serialized outer envelope, `peer` = this host's public key.
 * @returns `true` when a bridge accepted it; `false` means the caller should fall
 *          back to the relay (no bridge running, or the frame was rejected).
 */
export function deliverLocalInbound(line: string): boolean {
  return localInbound === null ? false : localInbound(line);
}

interface OuterEnvelope {
  peer: string;
  room?: string;
  ct: string;
}

/**
 * Plan/69 — the daemon's own version, read best-effort from the shipped
 * package.json (`dist/daemon/host_bridge.js` → `../../package.json`; the same
 * relative depth holds when running from `src/` under tsx/vitest). Returns
 * `null` when the file cannot be read/parsed — `host_hello_ok` reports the
 * null rather than inventing a version (PROTOCOL.md: never fabricate).
 */
function readDaemonVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The proxied payload's own request id, or null when it cannot be read.
 *
 *  `host_forward` wraps a client message as base64 JSON in `ct`; the child
 *  answers THAT message's `id`, so `in_reply_to` on the reply matches it. The
 *  envelope `id` is a different value and must never be used for correlation. */
function readInnerRequestId(ct: string): string | null {
  try {
    const inner = JSON.parse(Buffer.from(ct, "base64").toString("utf8")) as { id?: unknown };
    return typeof inner.id === "string" && inner.id !== "" ? inner.id : null;
  } catch {
    return null;
  }
}

/** The forwarded payload's own `type`, so an unroutable reply can name the
 *  action the client asked for instead of a generic placeholder. */
function readInnerRequestType(ct: string): string | null {
  try {
    const inner = JSON.parse(Buffer.from(ct, "base64").toString("utf8")) as { type?: unknown };
    return typeof inner.type === "string" && inner.type !== "" ? inner.type : null;
  } catch {
    return null;
  }
}

/** Plan/69 — capabilities this host bridge actually implements. */
const HOST_CAPABILITIES = ["host_pairing", "workspace_state", "host_forward", "fs_nav", "schedule", "changes", "models_config", "settings"] as const;

/**
 * How often the established host-room connection is checked for being ALIVE.
 *
 * This is the outer safety net, independent of the socket-level liveness
 * watchdog: a daemon whose connection died without a `close` event used to sit
 * dead forever while its last log line still read "host room online". 30 s keeps
 * recovery well inside a user's patience without being chatty.
 */
const HOST_CONNECT_WATCHDOG_MS = 30_000;

export class HostBridge {
  private relay: RelayClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Supervises the ESTABLISHED connection (see `_startConnectWatchdog`). */
  private connectWatchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private allowedPeers = new Set<string>();
  /** Plan/69 — this machine's own Pi-key (base64), the identity the bridge
   *  relays under. Needed for the host_forward re-emit (the child shares the
   *  Pi-key) and for own-key inbound detection. */
  private ownPubkey: string | null = null;
  /** Peers that forwarded traffic toward a child room, most recent last.
   *  A child reply cannot say which app asked — the relay rewrites it with the
   *  machine's own key — so a per-request correlation is impossible here. What
   *  IS knowable is the set of peers that currently drive this machine: replies
   *  go there instead of to every device ever paired.
   *
   *  Why this matters: fanning a proxied reply out to `allowedPeers` made the
   *  cost of ONE app action equal to the size of peers.json. With a browser
   *  client that mints a fresh ephemeral App-key on every connect, that file
   *  grows without bound (observed: 246 "Remote Pi Web" records), so a single
   *  `session_read` turned into 246 WS writes and the reply never arrived. */
  private activePeers = new Set<string>();
  /** Bounded so a long-lived machine cannot accumulate peers forever. */
  private static readonly MAX_ACTIVE_PEERS = 32;
  /** Request id → the peer that sent it AND the child room it was addressed
   *  to, for exact reply routing.
   *  A proxied request's `id` and the child's `in_reply_to` are the same value
   *  (verified 46/46 against real traffic), so a reply can be delivered to
   *  exactly one device instead of a guess. Bounded like `activePeers`.
   *
   *  `room` is load-bearing: the relay rewrites a delivered envelope with the
   *  SENDER's (peer, room), so a child reply arrives here with the outer room
   *  set to `host` — NOT the child room the request was addressed to. Re-wrapping
   *  it verbatim produced `host_message{room:"host"}` and every client dropped
   *  it as `unknown_child_room` (client.ts rejects `room === HOST_ROOM`). The
   *  request's own child room is the only correct value. */
  private pendingReplies = new Map<string, { peer: string; room: string }>();
  private static readonly MAX_PENDING_REPLIES = 256;

  constructor(private readonly opts: HostBridgeOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    /* Phase two: expose this bridge for direct local injection while it runs. */
    localInbound = (line: string) => this.deliverFromLocalPeer(line);
    // Must AWAIT the first attempt: `start()` resolving means the host room is
    // wired (message listener attached), which callers and tests rely on.
    await this._connectOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    /* Withdraw the injection point so a stopped bridge cannot be called. */
    localInbound = null;
    this._stopConnectWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.relay?.close();
    this.relay = null;
  }

  private _connect(): void {
    void this._connectOnce();
  }

  private async _connectOnce(): Promise<void> {
    if (this.stopped) return;
    try {
      const keypair = await getOrCreateEd25519Keypair();
      this.ownPubkey = Buffer.from(keypair.publicKey).toString("base64");
      const { url } = resolveRelayUrl();
      const wsUrl = toWebSocketUrl(url);
      const relay = this.opts.relayFactory
        ? this.opts.relayFactory(wsUrl, keypair)
        : new RelayClient(wsUrl, keypair);
      this.relay = relay;
      const peers = await (this.opts.listPeersFn ?? listPeers)();
      this.allowedPeers = new Set(peers.map((p) => p.remote_epk));
      await relay.connect({
        roomId: HOST_ROOM_ID,
        roomMeta: { name: "host", cwd: homedir(), model: hostname() },
      });
      relay.on("message", (line) => this._onLine(line));
      relay.on("close", () => {
        this._stopConnectWatchdog();
        if (!this.stopped) this._scheduleReconnect();
      });
      process.stderr.write(`[pi-supervisord] host room online (${HOST_ROOM_ID})\n`);
      this._startConnectWatchdog(relay);
    } catch (err) {
      process.stderr.write(`[pi-supervisord] host room connect failed: ${String(err)}\n`);
      this._scheduleReconnect();
    }
  }

  /**
   * Independent supervision of an ESTABLISHED connection.
   *
   * The per-socket liveness watchdog inside `RelayClient` forces `close` when the
   * socket goes silent — but relying on it alone means a single missed
   * termination (a throw inside the timer, a socket that reports itself OPEN
   * forever, or any future regression in that path) leaves the host room dead
   * with no recovery mechanism at all. This timer is deliberately dumb: it only
   * asks "is the client still open?", and rebuilds the connection when the
   * answer is no. It never races the socket-level watchdog because a healthy
   * connection always reports open.
   */
  private _startConnectWatchdog(relay: RelayClient): void {
    this._stopConnectWatchdog();
    this.connectWatchdog = setInterval(() => {
      if (this.stopped) {
        this._stopConnectWatchdog();
        return;
      }
      // Prefer the traffic-aware probe. `isOpen()` reports a half-open socket as
      // healthy forever (nothing flips `readyState` until a write finally
      // fails), which is precisely how the host room stayed dead while its log
      // still said "online". `isAlive()` applies the same silence bound the
      // in-socket watchdog uses.
      const alive = (relay as { isAlive?: (now?: number) => boolean }).isAlive;
      const open = (relay as { isOpen?: () => boolean }).isOpen;
      let healthy: boolean;
      if (typeof alive === "function") {
        healthy = alive.call(relay);
      } else if (typeof open === "function") {
        healthy = open.call(relay);
      } else {
        // Cannot judge — leave it running. The `close` path still covers it;
        // this watchdog only exists for the case where `close` never fires.
        return;
      }
      if (healthy) return;
      // stderr, not logRelayEvent: the installed service does not set
      // REMOTE_PI_LOG, so relay-scoped logging is silent by default and a
      // recovery would leave no trace in supervisord.log at all.
      process.stderr.write("[pi-supervisord] host room supervision: connection no longer alive — rebuilding\n");      process.stderr.write("[pi-supervisord] host room not open — reconnecting\n");
      this._stopConnectWatchdog();
      // The socket is dead but may never have emitted `close`; drop the
      // reference so `_connectOnce` builds a fresh client instead of reusing
      // this corpse, then reconnect.
      this.relay = null;
      this._scheduleReconnect();
    }, HOST_CONNECT_WATCHDOG_MS);
    if (typeof this.connectWatchdog.unref === "function") this.connectWatchdog.unref();
  }

  private _stopConnectWatchdog(): void {
    if (this.connectWatchdog !== null) {
      clearInterval(this.connectWatchdog);
      this.connectWatchdog = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, 3_000);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  private _onLine(line: string): void {
    let outer: OuterEnvelope;
    try { outer = JSON.parse(line) as OuterEnvelope; } catch { return; }
    if (!outer.ct || !outer.peer) return;

    // Plan/69 — host-proxied child reply. The relay rewrites every delivered
    // envelope with the SENDER's (peer, room): a daemon child answers
    // addressed to the machine's own Pi-key on room `host`, so it lands on
    // THIS connection rewritten as {peer: <own pubkey>, room: <childRoom>}.
    // Re-wrap as `host_message` and fan out to every allow-listed peer.
    // Checked BEFORE the allow-list: the machine's own key is a relay
    // identity, not a paired peer, and `ct` rides through opaquely (the
    // child already produced it).
    if (this._isOwnKeyInbound(outer)) {
      // Deliver to the ONE peer that asked when the child's reply names its
      // request (`in_reply_to`), otherwise to the peers driving this machine.
      // Never to every peer ever paired — see `activePeers`/`pendingReplies`.
      const asked = this._replyTargetFor(outer.ct);
      const targets = asked ? [asked.peer] : this._replyTargets();
      // The outer `host_message` must carry the CHILD room the request was
      // addressed to, never `outer.room` (the relay sets that to `host` for a
      // reply addressed to our own key). Clients reject `room === "host"`.
      const replyRoom = asked?.room ?? outer.room!;
      logRelayEvent(
        `proxy ← child room=${replyRoom} outerRoom=${outer.room} asked=${asked ? "hit" : "MISS"} (host_message to ${targets.length} peer(s))`,
      );
      const frame: ServerMessage = { type: "host_message", room: replyRoom, ct: outer.ct };
      for (const peer of targets) this._reply(peer, frame);
      return;
    }

    let inner: ClientMessage;
    try {
      inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ClientMessage;
    } catch { return; }
    // Plan/69 — allow-list carve-out: the host room only accepts peers in
    // the persisted allow-list, EXCEPT a `pair_request` — the pairing
    // bootstrap has no allow-list entry by definition. Every other inner
    // type from an unknown peer is still dropped here.
    //
    // Plan/76 — an in-process SSE stream carries no pairing code because there is
    // no browser to paste one. It is authorised by construction: the key was
    // minted inside this process, never left it, and the stream is only reachable
    // through a loopback request that already passed the origin/host gate. Any
    // OTHER unknown peer is still dropped here — that is the whole point of the
    // allow-list, and a remote client cannot forge `outer.peer` because the relay
    // rewrites it to the authenticated identity.
    const isLocal =
      (this.opts.localPeer !== undefined && outer.peer === this.opts.localPeer) ||
      localSsePeers.has(outer.peer);
    if (
      this.allowedPeers.size > 0 &&
      !this.allowedPeers.has(outer.peer) &&
      !isLocal &&
      inner.type !== "pair_request"
    ) {
      logRelayEvent(`host room: dropped ${inner.type} from unpaired peer ${outer.peer.slice(0, 8)}…`);
      return;
    }
    logRelayEvent(`host room ← ${inner.type} from ${outer.peer.slice(0, 8)}…`);
    const sender: HostReplySender = {
      send: (msg) => this._reply(outer.peer, msg),
    };
    switch (inner.type) {
      case "workspace_list":
        handleWorkspaceList(this.opts.fleet, sender, inner);
        break;
      /* Automations — the scheduled-task surface (plan/39 cron). Handlers live
       * in schedule_handlers so this dispatcher stays storage-agnostic. */
      case "schedule_list":
        handleScheduleList(this.opts.fleet.schedule, sender, inner);
        break;
      case "schedule_add":
        handleScheduleAdd(this.opts.fleet.schedule, sender, inner);
        break;
      case "schedule_remove":
        handleScheduleRemove(this.opts.fleet.schedule, sender, inner);
        break;
      case "schedule_set_enabled":
        handleScheduleSetEnabled(this.opts.fleet.schedule, sender, inner);
        break;
      case "schedule_run_now":
        void handleScheduleRunNow(this.opts.fleet.schedule, sender, inner);
        break;
      case "workspace_start":
        handleWorkspaceStart(this.opts.fleet, sender, inner);
        break;
      case "workspace_stop":
        void handleWorkspaceStop(this.opts.fleet, sender, inner);
        break;
      // Plan/68 — host filesystem navigation + explicit workspace catalog.
      case "fs_list":
        handleFsList(sender, inner);
        break;
      // Plan/77 — allowlisted text read for the web Plan viewer.
      case "fs_read":
        handleFsRead(sender, inner);
        break;
      // Plan/78 — Changes tab: git working-tree STATUS for the requested
      // workspace root. The root comes from the wire because the daemon's own
      // cwd is wherever the supervisor started it, not a workspace.
      case "changes_snapshot":
        void takeChangesSnapshot(inner.root).then((result) => {
          if (result.ok) {
            sender.send({
              type: "changes_snapshot_ok",
              in_reply_to: inner.id,
              snapshot: result.snapshot,
            });
          } else {
            sender.send({
              type: "changes_snapshot_unavailable",
              in_reply_to: inner.id,
              reason: result.reason,
            });
          }
        });
        break;
      // Plan/79 — the host's own models.json. Note there is NO path parameter to
      // validate: the target is resolved host-side, which is a stronger fence than
      // an allowlist because there is nothing the client could point elsewhere.
      case "models_describe": {
        const result = describeModelsConfig();
        if (result.ok) {
          sender.send({
            type: "models_describe_ok",
            in_reply_to: inner.id,
            revision: result.value.revision,
            file: result.value.file,
            config: result.value.config,
            secrets: result.value.secrets,
          });
        } else {
          sender.send({ type: "models_error", in_reply_to: inner.id, reason: result.reason });
        }
        break;
      }
      case "models_mutate": {
        void mutateModelsConfig(inner.ops as ModelsOp[], inner.revision).then((result) => {
          if (result.ok) {
            sender.send({
              type: "models_mutate_ok",
              in_reply_to: inner.id,
              revision: result.value.revision,
            });
          } else {
            sender.send({ type: "models_error", in_reply_to: inner.id, reason: result.reason });
          }
        });
        break;
      }
      // Plan/80 — the host's own settings.json, projected through a positive
      // whitelist. `packages` (which carries absolute host paths), `extensions` and
      // changelog bookkeeping have no representation in the reply.
      case "settings_describe": {
        const result = describeSettingsConfig();
        if (result.ok) {
          sender.send({
            type: "settings_describe_ok",
            in_reply_to: inner.id,
            revision: result.value.revision,
            file: result.value.file,
            appearance: result.value.appearance,
            behaviour: result.value.behaviour,
          });
        } else {
          sender.send({ type: "settings_error", in_reply_to: inner.id, reason: result.reason });
        }
        break;
      }
      case "settings_mutate": {
        const result = mutateSettingsConfig(inner.ops as SettingsOp[], inner.revision);
        if (result.ok) {
          sender.send({
            type: "settings_mutate_ok",
            in_reply_to: inner.id,
            revision: result.value.revision,
          });
        } else {
          sender.send({ type: "settings_error", in_reply_to: inner.id, reason: result.reason });
        }
        break;
      }
      case "workspace_add":
        handleWorkspaceAdd(this.opts.fleet, sender, inner);
        break;
      case "workspace_remove":
        handleWorkspaceRemove(this.opts.fleet, sender, inner);
        break;
      // Plan/69 — daemon-side pairing (zero Pi processes running).
      case "pair_request":
        void this._onPairRequest(outer.peer, inner, sender);
        break;
      case "ping":
        sender.send({ type: "pong", in_reply_to: inner.id });
        break;
      // Plan/69 — host-first handshake: real version/hostname/platform,
      // null when a field genuinely cannot be determined.
      case "host_hello":
        sender.send({
          type: "host_hello_ok",
          in_reply_to: inner.id,
          daemon: {
            version: readDaemonVersion(),
            hostname: hostname(),
            platform: process.platform,
          },
          capabilities: [...HOST_CAPABILITIES],
        });
        break;
      // Plan/69 — proxy (spike decision B): re-emit the child-addressed
      // payload on THIS connection under the machine's own Pi-key, so the
      // relay delivers it on the child's (pi_pk, childRoom) connection.
      case "host_forward":
        this._forwardToChild(inner, outer.peer);
        break;
      // Plan/69 — idempotent workspace restart (see handleWorkspaceRestart).
      case "workspace_restart":
        void handleWorkspaceRestart(this.opts.fleet, sender, inner);
        break;
      default:
        break;
    }
  }

  /**
   * Plan/69 — true when `outer` is a child reply proxied back through us:
   * the relay rewrote it with the SENDER's identity, so `peer` is our own
   * Pi-key and `room` is the child's room (never the host room — that would
   * be our own outbound traffic echoing back).
   */
  private _isOwnKeyInbound(outer: OuterEnvelope): boolean {
    return (
      this.ownPubkey !== null &&
      outer.peer === this.ownPubkey &&
      outer.room !== undefined &&
      outer.room !== HOST_ROOM_ID
    );
  }

  /**
   * Plan/69 — re-emit a `host_forward` payload toward the child room. Same
   * Pi-key, same relay connection: the relay routes {peer: own, room: child}
   * to the child's connection and rewrites the delivered envelope with our
   * (peer, room) — which the child recognizes as host-proxied.
   */
  private _forwardToChild(inner: Extract<ClientMessage, { type: "host_forward" }>, from?: string): void {
    if (!this.relay || this.ownPubkey === null) return;
    /*
     * A `host_forward` addressed to the host room has no child to reach: the
     * bridge would re-emit it to `(own, "host")`, which is this very
     * connection, and the relay drops it as `dest not found`. The client then
     * waits out its request timeout with no answer and no reason.
     *
     * This is not a hypothetical: `pair_ok` reports `room_id: "host"` (that is
     * the room the CONTROL plane answers on), the app persists it, and every
     * subsequent child-addressed request went to `host`. Symptom on the phone
     * was "every session times out".
     *
     * Resolve the intended workspace from the fleet instead of silently
     * dropping: exactly one live room → that room; none → a typed reason the
     * client can show. Guessing among SEVERAL live rooms is refused on purpose
     * — routing a command to the wrong workspace is worse than an error.
     */
    if (inner.room === HOST_ROOM_ID || inner.room === "" ) {
      const resolved = this._resolveChildRoomForHostRoom();
      if (typeof resolved === "string") {
        if (from) {
          const pendingId = readInnerRequestId(inner.ct) ?? inner.id;
          /*
           * Record the RESOLVED room, not the `host` the client asked for.
           *
           * Both shipping clients reject a `host_message` whose `room` is the
           * host room: web's `proxyRoomFor` refuses `HOST_ROOM` outright, and
           * the app's `demuxInbound` drops any frame whose room is not its
           * `activeRoom` (which the fixed build sets to a real workspace).
           * Echoing the request's room here would therefore re-break the very
           * clients this routing exists to serve.
           *
           * Consequence, stated plainly: a build that still pins `activeRoom`
           * to `host` cannot consume this reply. The routing fix is what stops
           * the SILENCE; such a build needs the client-side half of the fix.
           */
          this._rememberPendingRequest(pendingId, from, resolved);
        }
        logRelayEvent(`proxy → child room=${resolved} (host_forward asked for the host room; only live workspace)`);
        const outer: OuterEnvelope = { peer: this.ownPubkey, room: resolved, ct: inner.ct };
        try {
          this.relay.send(JSON.stringify(outer));
        } catch {
          /* reconnect will recover */
        }
        return;
      }
      this._rejectUnroutableForward(inner, from, resolved.error);
      return;
    }
    if (from) {
      this._rememberActivePeer(from);
      // Record the INNER request id, not `inner.id`.
      //
      // `host_forward` carries two ids: the envelope's own `id` (minted by
      // `_forwardToRoom`) and the proxied payload's `id` (minted by the
      // `build(id)` callback). The child answers the PAYLOAD id, so its
      // `in_reply_to` matches the payload id only — keying the table by the
      // envelope id made every lookup MISS and fell back to broadcasting on
      // the host room, which clients then discard as `unknown_child_room`.
      const pendingId = readInnerRequestId(inner.ct) ?? inner.id;
      this._rememberPendingRequest(pendingId, from, inner.room);
    }
    logRelayEvent(`proxy → child room=${inner.room}`);
    const outer: OuterEnvelope = { peer: this.ownPubkey, room: inner.room, ct: inner.ct };
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* reconnect will recover */
    }
  }

  /**
   * Which child room a host-room-addressed forward should reach.
   *
   * Returns the room id when the answer is unambiguous, otherwise
   * `{error}` describing why routing was refused — the caller turns that into
   * a typed reply so the client stops waiting.
   *
   * Unambiguous means exactly ONE live workspace. Zero live is a real state
   * (everything stopped), and several live is exactly the case where picking
   * one would silently drive the wrong workspace.
   */
  private _resolveChildRoomForHostRoom(): string | { error: string } {
    let entries;
    try {
      entries = this.opts.fleet.list();
    } catch {
      return { error: "no_workspace" };
    }
    const live = entries.filter((e) => e.live);
    if (live.length === 1) return roomIdFor(live[0].cwd, live[0].name);
    if (live.length === 0) {
      // Fall back to a single registered (not running) workspace ONLY when it
      // is the sole entry: the app may be about to start it, and addressing the
      // deterministic room id is what `workspace_start` would produce anyway.
      if (entries.length === 1) return roomIdFor(entries[0].cwd, entries[0].name);
      return { error: "no_live_workspace" };
    }
    return { error: "ambiguous_workspace" };
  }

  /**
   * Answer a `host_forward` that cannot be routed, instead of dropping it.
   *
   * Silence is the reason this bug was invisible for so long: the client sat on
   * a 12 s timeout with nothing to show the user. A typed reply costs one frame
   * and turns "every session is broken" into a sentence.
   *
   * Deliberately `action_error` rather than a new message type: it already
   * carries `in_reply_to` + `action`, every client decodes it, and the request's
   * own type is recoverable from the forwarded payload.
   */
  private _rejectUnroutableForward(
    inner: Extract<ClientMessage, { type: "host_forward" }>,
    from: string | undefined,
    reason: string,
  ): void {
    const requestId = readInnerRequestId(inner.ct) ?? inner.id;
    const action = readInnerRequestType(inner.ct) ?? "host_forward";
    logRelayEvent(`proxy ✗ room=${inner.room} reason=${reason} (answered, not dropped)`);
    if (!from) return;
    this._reply(from, {
      type: "action_error",
      in_reply_to: requestId,
      action: action as never,
      error: reason,
    });
  }

  /**
   * Plan/69 — broadcast a ServerMessage to EVERY allow-listed peer on the
   * host room (plan/23 fan-out semantics). Used by `host_message` (proxied
   * child traffic) and `workspace_state` (lifecycle pushes): both are
   * machine-level, not addressed to one device.
   */
  private _fanOut(msg: ServerMessage): void {
    for (const peer of this._replyTargets()) {
      this._reply(peer, msg);
    }
  }

  /**
   * Who a machine-level push is delivered to.
   *
   * `activePeers` when it is non-empty (peers that recently drove this
   * machine), otherwise the whole allow-list so a freshly connected device
   * still receives lifecycle pushes before it has sent anything.
   */
  private _replyTargets(): string[] {
    if (this.activePeers.size > 0) return [...this.activePeers];
    return [...this.allowedPeers];
  }

  /** Remembers `requestId → {peer, room}` so the child's reply can be unicast
   *  to the asking peer on the child room the request was addressed to. */
  private _rememberPendingRequest(requestId: string, peer: string, room: string): void {
    if (!requestId) return;
    this.pendingReplies.delete(requestId);
    this.pendingReplies.set(requestId, { peer, room });
    while (this.pendingReplies.size > HostBridge.MAX_PENDING_REPLIES) {
      const oldest = this.pendingReplies.keys().next();
      if (oldest.done) break;
      this.pendingReplies.delete(oldest.value);
    }
  }

  /**
   * Which peer asked for the reply in `ct`, or null when it cannot be told.
   *
   * The proxied payload is base64 JSON in practice (`_forwardToChild` re-emits
   * the app's `ct` verbatim), so its `in_reply_to` is readable here without any
   * session key. A hit is one-shot: reply ids are never reused.
   */
  private _replyTargetFor(ct: string): { peer: string; room: string } | null {
    if (this.pendingReplies.size === 0) return null;
    let inner: { in_reply_to?: unknown };
    try {
      inner = JSON.parse(Buffer.from(ct, "base64").toString("utf8")) as { in_reply_to?: unknown };
    } catch {
      return null;
    }
    const replyTo = inner.in_reply_to;
    if (typeof replyTo !== "string" || replyTo === "") return null;
    const asked = this.pendingReplies.get(replyTo);
    if (!asked) return null;
    this.pendingReplies.delete(replyTo);
    return asked;
  }

  /** Records that `peer` is driving this machine, evicting the oldest entry
   *  once the bound is reached (insertion-ordered Set). */
  private _rememberActivePeer(peer: string): void {
    if (!peer) return;
    this.activePeers.delete(peer);
    this.activePeers.add(peer);
    while (this.activePeers.size > HostBridge.MAX_ACTIVE_PEERS) {
      const oldest = this.activePeers.values().next();
      if (oldest.done) break;
      this.activePeers.delete(oldest.value);
    }
  }

  /**
   * Plan/69 — push a workspace lifecycle transition to all allow-listed
   * peers. Called by the supervisor on child exit/restart/start/stop; the
   * payload mirrors the ChildSlot verbatim (never fabricated).
   */
  pushWorkspaceState(state: {
    cwd: string;
    state: WorkspaceState;
    last_error: string | null;
    restarts: number;
  }): void {
    this._fanOut({ type: "workspace_state", ...state });
  }

  /**
   * Automations — push one completed fire to every allow-listed peer.
   *
   * Same fan-out as `workspace_state`: it is machine-level news, not a reply to
   * whoever happens to have a request in flight, so it carries no `in_reply_to`.
   *
   * Called AFTER the daemon has recorded the outcome (last_status + JSONL), so
   * a client that reacts by re-listing tasks reads the settled state rather than
   * racing the write.
   */
  pushScheduleFired(fired: {
    job_id: string;
    daemon_id: string;
    result: CronResultWire;
    fired_at: string;
    prompt_preview: string;
  }): void {
    this._fanOut({ type: "schedule_fired", ...fired });
  }

  /**
   * Plan/69 — host-room pairing. Validates the persisted token, persists
   * the peer, answers `pair_ok`/`pair_error`. On success the new peer joins
   * the allow-list so its subsequent host-room traffic (workspace_list,
   * fs_list, …) passes the same check as any paired device.
   */
  private async _onPairRequest(
    peer: string,
    inner: Extract<ClientMessage, { type: "pair_request" }>,
    sender: HostReplySender,
  ): Promise<void> {
    const paired = await handlePairRequest(
      this.opts.pairing ?? hostPairing,
      sender,
      peer,
      inner,
    );
    if (paired) this.allowedPeers.add(peer);
  }

  private _reply(peer: string, msg: ServerMessage): void {
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
    const outer: OuterEnvelope = { peer, room: HOST_ROOM_ID, ct };
    const frame = JSON.stringify(outer);

    /*
     * Plan/76 phase two: a caller-supplied sink gets first refusal, so a
     * same-origin deployment can hand the frame straight to the browser's SSE
     * stream.
     *
     * The sink MUST be able to decline. Not every peer is an SSE stream — a
     * WebSocket client (desktop, mobile, CLI) has no entry in the stream index —
     * and returning early for those would black-hole every reply they receive.
     * A `false` therefore falls through to the relay exactly as before.
     */
    const sink = this.opts.replySink;
    if (sink !== undefined) {
      let delivered = false;
      try {
        delivered = sink.deliver(peer, frame);
      } catch {
        /* A dead sink must not take the bridge down with it. */
        delivered = false;
      }
      if (delivered) return;
    }

    if (!this.relay) return;
    try {
      this.relay.send(frame);
    } catch {
      /* reconnect will recover */
    }
  }

  /**
   * Inject one locally-originated frame as if it arrived from a browser peer.
   *
   * This is the phase-two entry point: the SSE endpoint already owns the browser's
   * connection, so it can hand the frame over directly instead of re-encoding it,
   * pushing it through the relay, and having the relay route it back to this same
   * process.
   *
   * The frame must be an outer envelope whose `peer` is the SENDER's identity — the
   * stream's own key, which `sse_endpoint` stamps before calling here. That is
   * deliberately NOT the host's public key: `_isOwnKeyInbound` reads
   * "`peer` == own pubkey" as a CHILD-DAEMON reply, so stamping the host key would
   * make every browser command be rerouted to the child as if it were IPC traffic.
   * The relay performs the same rewrite when it forwards a WebSocket frame, and this
   * entry point reproduces it so both transports look identical downstream.
   *
   * @param line - the serialized outer envelope.
   * @returns `true` when the frame was accepted for processing.
   */
  deliverFromLocalPeer(line: string): boolean {
    if (this.stopped) return false;

    /*
     * Guard against DOUBLE DELIVERY, which the relay fallback would otherwise cause.
     *
     * `_onLine` can run a long way before throwing — `host_forward` reaches
     * `_forwardToChild`, which already sent the frame to the child and recorded a
     * pending reply. Reporting `false` at that point makes the caller re-send the
     * same frame over the relay, so the child executes it twice.
     *
     * Once `_onLine` has been entered the frame has been consumed, so a throw is
     * reported as `true` ("handled, do not retry") and only logged. A frame that was
     * never consumed — wrong shape, unknown sender — is rejected before entry and
     * honestly reports `false`.
     */
    let outer: { ct?: unknown; peer?: unknown };
    try {
      outer = JSON.parse(line) as { ct?: unknown; peer?: unknown };
    } catch {
      return false;
    }
    if (typeof outer.ct !== "string" || typeof outer.peer !== "string") return false;
    if (outer.ct === "" || outer.peer === "") return false;

    try {
      this._onLine(line);
    } catch (err) {
      logRelayEvent(`local inbound threw after arrival (${(err as Error).message})`);
    }
    /* Consumed either way: never let the caller replay it through the relay. */
    return true;
  }
}
