/**
 * Plan/67 — supervisor's always-on relay connection on room `host`.
 *
 * Same Pi-key as workspace daemons; distinct room so the phone can talk
 * to the machine when no TUI/daemon cwd is live.
 *
 * Plan/69 W1 — this bridge is also the daemon-side pairing endpoint: it
 * answers `pair_request` on the host room (validating the token persisted
 * in `~/.pi/remote/pairing.json`), so `remote-pi pair` works with zero Pi
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
import { handleFsList } from "./fs_nav.js";

export interface HostBridgeOptions {
  fleet: FleetOps;
  /** Injected for tests. */
  relayFactory?: (url: string, keypair: Awaited<ReturnType<typeof getOrCreateEd25519Keypair>>) => RelayClient;
  /** Injected for tests: the peer allow-list source (defaults to `listPeers`). */
  listPeersFn?: () => Promise<Array<{ remote_epk: string }>>;
  /** Plan/69 — pairing-token source for the host-room `pair_request` handler.
   *  Defaults to the process-wide store (`hostPairing`). */
  pairing?: HostPairingSession;
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

/** Plan/69 — capabilities this host bridge actually implements. */
const HOST_CAPABILITIES = ["host_pairing", "workspace_state", "host_forward", "fs_nav"] as const;

export class HostBridge {
  private relay: RelayClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private allowedPeers = new Set<string>();
  /** Plan/69 — this machine's own Pi-key (base64), the identity the bridge
   *  relays under. Needed for the host_forward re-emit (the child shares the
   *  Pi-key) and for own-key inbound detection. */
  private ownPubkey: string | null = null;

  constructor(private readonly opts: HostBridgeOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this._connect();
    } catch (err) {
      process.stderr.write(`[pi-supervisord] host room start failed: ${String(err)}\n`);
      this._scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.relay?.close();
    this.relay = null;
  }

  private async _connect(): Promise<void> {
    if (this.stopped) return;
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
    try {
      await relay.connect({
        roomId: HOST_ROOM_ID,
        roomMeta: { name: "host", cwd: homedir(), model: hostname() },
      });
    } catch (err) {
      process.stderr.write(`[pi-supervisord] host room connect failed: ${String(err)}\n`);
      this._scheduleReconnect();
      return;
    }
    relay.on("message", (line) => this._onLine(line));
    relay.on("close", () => {
      if (!this.stopped) this._scheduleReconnect();
    });
    process.stderr.write(`[pi-supervisord] host room online (${HOST_ROOM_ID})\n`);
  }

  private _scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._connect();
    }, 3_000);
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
      this._fanOut({ type: "host_message", room: outer.room!, ct: outer.ct });
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
    if (
      this.allowedPeers.size > 0 &&
      !this.allowedPeers.has(outer.peer) &&
      inner.type !== "pair_request"
    ) {
      return;
    }
    const sender: HostReplySender = {
      send: (msg) => this._reply(outer.peer, msg),
    };
    switch (inner.type) {
      case "workspace_list":
        handleWorkspaceList(this.opts.fleet, sender, inner);
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
        this._forwardToChild(inner);
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
  private _forwardToChild(inner: Extract<ClientMessage, { type: "host_forward" }>): void {
    if (!this.relay || this.ownPubkey === null) return;
    const outer: OuterEnvelope = { peer: this.ownPubkey, room: inner.room, ct: inner.ct };
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* reconnect will recover */
    }
  }

  /**
   * Plan/69 — broadcast a ServerMessage to EVERY allow-listed peer on the
   * host room (plan/23 fan-out semantics). Used by `host_message` (proxied
   * child traffic) and `workspace_state` (lifecycle pushes): both are
   * machine-level, not addressed to one device.
   */
  private _fanOut(msg: ServerMessage): void {
    for (const peer of this.allowedPeers) {
      this._reply(peer, msg);
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
    if (!this.relay) return;
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
    const outer: OuterEnvelope = { peer, room: HOST_ROOM_ID, ct };
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* reconnect will recover */
    }
  }
}
