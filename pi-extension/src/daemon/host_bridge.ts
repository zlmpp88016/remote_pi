/**
 * Plan/67 — supervisor's always-on relay connection on room `host`.
 *
 * Same Pi-key as workspace daemons; distinct room so the phone can talk
 * to the machine when no TUI/daemon cwd is live.
 */

import { hostname, homedir } from "node:os";
import { RelayClient } from "../transport/relay_client.js";
import { getOrCreateEd25519Keypair, listPeers } from "../pairing/storage.js";
import { resolveRelayUrl, toWebSocketUrl } from "../config.js";
import { HOST_ROOM_ID, type ClientMessage, type ServerMessage } from "../protocol/types.js";
import {
  handleWorkspaceList,
  handleWorkspaceStart,
  handleWorkspaceStop,
  type FleetOps,
  type HostReplySender,
} from "./host_control.js";

export interface HostBridgeOptions {
  fleet: FleetOps;
  /** Injected for tests. */
  relayFactory?: (url: string, keypair: Awaited<ReturnType<typeof getOrCreateEd25519Keypair>>) => RelayClient;
}

interface OuterEnvelope {
  peer: string;
  room?: string;
  ct: string;
}

export class HostBridge {
  private relay: RelayClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private allowedPeers = new Set<string>();

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
    const { url } = resolveRelayUrl();
    const wsUrl = toWebSocketUrl(url);
    const relay = this.opts.relayFactory
      ? this.opts.relayFactory(wsUrl, keypair)
      : new RelayClient(wsUrl, keypair);
    this.relay = relay;
    const peers = await listPeers();
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
    if (this.allowedPeers.size > 0 && !this.allowedPeers.has(outer.peer)) return;
    let inner: ClientMessage;
    try {
      inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as ClientMessage;
    } catch { return; }
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
      case "ping":
        sender.send({ type: "pong", in_reply_to: inner.id });
        break;
      default:
        break;
    }
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
