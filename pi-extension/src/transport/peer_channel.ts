import type { ClientMessage, ServerMessage } from "../protocol/types.js";
import { HOST_ROOM_ID } from "../protocol/types.js";
import type { RelayClient } from "./relay_client.js";

/** Sink for ServerMessage outbound to the remote app. */
export interface PeerChannel {
  send(msg: ServerMessage): void;
}

/**
 * Outer envelope shape forwarded by the relay.
 * { "peer": "<sender_peer_id>", "room"?: "<room_id>", "ct": "<base64 JSON inner>" }
 *
 * Post rollback (plano 06): `ct` is base64(JSON.stringify(inner)) — no cipher,
 * no MAC. Relay continues opaque (never JSON.parses ct).
 *
 * `room` (plano 17): identifies which Pi room sent the envelope. Lets the
 * relay multiplex N peers with the same Ed25519 pubkey but distinct cwds.
 * Optional for backward-compat with single-room relays.
 */
interface OuterEnvelope {
  peer: string;
  room?: string;
  ct: string;
}

/**
 * Plan/69 — host-first (daemon-child) addressing.
 *
 * When present, this channel speaks the supervisor-proxied path:
 *   - OUTBOUND: every reply is addressed `{peer: <own epk>, room: "host"}`.
 *     The relay delivers it on the supervisor's (pi_pk, host) connection,
 *     which re-wraps it as `host_message` and fans it out to the apps.
 *   - INBOUND: envelopes whose `peer` is our OWN Pi-key are host-proxied
 *     traffic (the relay rewrote the supervisor's re-emit with the sender's
 *     identity) and are accepted alongside the direct peer envelopes.
 *
 * `ownPubkey` is the raw 32-byte Ed25519 public key, base64 — the same
 * identity the relay authenticates this connection under.
 */
export interface HostFirstAddressing {
  ownPubkey: string;
}

/**
 * Plaintext PeerChannel backed by a RelayClient WebSocket.
 *
 * Usage (after pair_request handshake completes):
 *   const channel = new PlainPeerChannel(relay, appPeerId, myRoomId, onMsg)
 *   channel.send(serverMessage)          // base64-encodes JSON, routes via relay
 *   // incoming relay messages destined for appPeerId are auto-decoded
 *   // and delivered via onMessage callback
 *
 * `myRoomId` is the *local* Pi's room id — sent on every outbound envelope
 * so the app can correlate which Pi sent it (multi-pi support, plano 17).
 */
export class PlainPeerChannel implements PeerChannel {
  private readonly _unsubscribe: () => void;

  constructor(
    private readonly relay: RelayClient,
    private readonly remotePeerId: string,
    /**
     * This Pi's room id. Currently NOT injected in the outer envelope
     * (defensive — relay/app not yet ready). Kept in the constructor for
     * forward-compat so callers don't need to change again when we re-enable.
     */
    myRoomId: string | undefined,
    private readonly onMessage: (msg: ClientMessage) => void,
    /** Called when this specific peer connection is considered lost. */
    _onDisconnect?: () => void,
    /** Plan/69 — daemon-child host-first mode (see HostFirstAddressing).
     *  Omitted → the legacy direct path, byte-identical to before. */
    private readonly hostFirst?: HostFirstAddressing,
  ) {
    const listener = (line: string) => this._onLine(line);
    relay.on("message", listener);
    this._unsubscribe = () => relay.off("message", listener);
    void _onDisconnect;
    void myRoomId;  // intentionally unused — see send() comment
  }

  // ── PeerChannel interface ──────────────────────────────────────────────────

  send(msg: ServerMessage): void {
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
    // NOTE: `room` removed from the outer envelope until relay (W1.A) + app
    // (W1.C) accept the field. Multi-Pi multiplexing already works via
    // `room_id`/`room_meta` in the WS-level `hello` — outer routing stays by
    // `peer` alone. Re-add the field once downstream is ready.
    //
    // Plan/69 — host-first (daemon child): ALL outbound is addressed to the
    // machine's own Pi-key on room `host`, so the supervisor's HostBridge
    // proxies it to the apps (spike decision B). The direct path below is
    // untouched for TUI/legacy paired clients.
    const outer: OuterEnvelope = this.hostFirst
      ? { peer: this.hostFirst.ownPubkey, room: HOST_ROOM_ID, ct }
      : { peer: this.remotePeerId, ct };
    // Best-effort delivery. The relay WS can be mid-reconnect (idle/NAT drop, or
    // a session_new/session-replacement teardown) when we push a server→app frame
    // — notably the action_ok/action_error ack a handler emits right after
    // newSession. `relay.send` throws "relay: not connected" in that window; since
    // this runs inside an async SDK event callback, letting it propagate becomes an
    // uncaughtException that kills the whole pi process. The relay auto-reconnects
    // and the app re-syncs via session_sync, so a dropped frame is recoverable — a
    // crash is not. Mirrors RelayClient.sendControl's no-op-when-closed policy.
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* relay down — drop this frame; reconnect + session_sync will recover */
    }
  }

  /** Detaches from relay (does not close the relay itself). */
  detach(): void {
    this._unsubscribe();
  }

  // ── Incoming line from relay ────────────────────────────────────────────────

  private _onLine(line: string): void {
    let outer: OuterEnvelope;
    try {
      outer = JSON.parse(line) as OuterEnvelope;
    } catch {
      return; // malformed line
    }

    // Plan/69 — accept BOTH inbound paths on a daemon child: direct
    // envelopes from the paired peer (legacy clients, unchanged) AND
    // own-key envelopes the supervisor proxied (new host-first clients).
    const hostProxied =
      this.hostFirst !== undefined && outer.peer === this.hostFirst.ownPubkey;
    if (!hostProxied && outer.peer !== this.remotePeerId) return;
    if (!outer.ct) return;

    let plaintext: string;
    try {
      plaintext = Buffer.from(outer.ct, "base64").toString("utf8");
    } catch {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(plaintext);
    } catch {
      return;
    }

    if (
      !msg ||
      typeof msg !== "object" ||
      typeof (msg as Record<string, unknown>).type !== "string"
    ) {
      return;
    }

    this.onMessage(msg as ClientMessage);
  }
}
