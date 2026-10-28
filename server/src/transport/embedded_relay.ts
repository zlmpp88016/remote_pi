import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import { ed25519Verify } from "../pairing/crypto.js";
import { logRelayEvent } from "../log.js";

/**
 * In-process relay for `--direct` (local, no network round-trip through the
 * community relay).
 *
 * ## Why this exists
 *
 * The public relay (`relay/`, Rust) does exactly three things that matter:
 *
 *   1. authenticates each peer with an Ed25519 challenge-response, and
 *   2. routes opaque `{ peer, room, ct }` envelopes to a connected peer,
 *   3. **rewriting the `peer`/`room` fields to the SENDER's identity**.
 *
 * Step 3 is the security property the whole client model rests on: the
 * recipient trusts `peer` precisely because the relay vouched for it. A local
 * relay MUST preserve it, or a client could simply claim any sender identity.
 *
 * The Rust relay's remaining ~1500 production lines are mesh federation
 * (`pi_forward`, `mesh/`), presence subscriptions and room metadata broadcast
 * — all of it only meaningful across multiple machines. A single local host
 * has exactly one Pi per room pair, so none of it applies here.
 *
 * ## Deliberately NOT implemented
 *
 * - `pi_envelope` (Pi-to-Pi across machines) — needs mesh membership.
 * - `subscribe_presence` / `presence_check` / `unsubscribe_presence` — the web
 *   client never sends them (verified by grepping the client for the frame
 *   names); presence exists to discover peers on a shared relay.
 * - `rooms` / `room_update` / `room_meta_updated` — room catalog browsing.
 *
 * Any of those frames arriving here is ignored (with a log line), never
 * silently misinterpreted as an envelope.
 */

/** Mirrors the Rust relay's `HELLO_TIMEOUT_MS`. */
const HELLO_TIMEOUT_MS = 5_000;
/** Mirrors the Rust relay's 25 s keepalive interval. */
const PING_INTERVAL_MS = 25_000;

interface Connection {
  /** Monotonic per-relay connection id. */
  id: number;
  socket: WsSocket;
  /** Authenticated Ed25519 public key, base64 — the identity the relay vouches for. */
  peer: string;
  /** The sender's room, also vouched for. Used to rewrite outbound envelopes. */
  room: string;
}

export interface EmbeddedRelay {
  /** ws:// address the host should dial, e.g. `ws://127.0.0.1:43211`. */
  readonly url: string;
  /** Close the listener and drop every connection. */
  close(): Promise<void>;
  /**
   * Only present when the relay was started in `noServer` mode: hand one HTTP
   * upgrade to the relay so it can own the socket. Absent when the relay owns
   * its own listener (`port` mode).
   */
  handleUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export interface EmbeddedRelayOptions {
  /** Port to bind. 0 (the default) asks the OS for a free port. */
  port?: number;
  /** Bind address. Defaults to loopback only — never exposed to the network. */
  host?: string;
  /**
   * Attach to an EXISTING HTTP server instead of binding a port.
   *
   * Same-origin mode needs the WebSocket and the static assets on one port, so
   * the relay must not own a listener of its own. With `noServer` the caller
   * owns the HTTP server and forwards upgrades through `handleUpgrade`, which
   * is also where the origin/host gate already ran — so the relay inherits a
   * checked socket rather than checking it a second time.
   */
  noServer?: boolean;
}

/**
 * Starts the in-process relay and resolves once it is listening, with the
 * actual address (important when `port: 0` was requested).
 */
export function startEmbeddedRelay(options: EmbeddedRelayOptions = {}): Promise<EmbeddedRelay> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const noServer = options.noServer === true;

  /*
   * `noServer` mode: no listener at all. The caller's HTTP server owns the port
   * and pushes upgrades in, after its own origin/host gate has passed.
   */
  const wss = noServer
    ? new WebSocketServer({ noServer: true })
    : new WebSocketServer({ host, port: requestedPort });

  /** (peer, room) → live connections. Multiple devices per peer are allowed,
   *  matching the Rust relay (`duplicate_room_accepted_and_broadcast`). */
  const routes = new Map<string, Set<Connection>>();
  let nextConnId = 1;

  const routeKey = (peer: string, room: string): string => `${peer}\u0000${room}`;

  const addRoute = (conn: Connection): void => {
    const key = routeKey(conn.peer, conn.room);
    const bucket = routes.get(key);
    if (bucket) bucket.add(conn);
    else routes.set(key, new Set([conn]));
  };

  const removeRoute = (conn: Connection): void => {
    const key = routeKey(conn.peer, conn.room);
    const bucket = routes.get(key);
    if (!bucket) return;
    bucket.delete(conn);
    if (bucket.size === 0) routes.delete(key);
  };

  const authConnection = (socket: WsSocket): void => {
    let settled = false;
    let conn: Connection | null = null;

    const helloTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logRelayEvent("embedded relay: no hello received, closing");
      socket.close();
    }, HELLO_TIMEOUT_MS);

    // One-shot listeners for the two handshake steps. Registered before any
    // await so a message arriving between steps cannot be lost.
    let step: "hello" | "auth" = "hello";
    let nonce: Buffer | null = null;
    let claimedPeer: string | null = null;
    let claimedRoom = "main";

    const onMessage = (raw: unknown): void => {
      const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);

      if (step === "hello") {
        let hello: { type?: string; pubkey?: string; room_id?: string };
        try {
          hello = JSON.parse(text) as typeof hello;
        } catch {
          logRelayEvent("embedded relay: invalid json in hello, closing");
          socket.close();
          return;
        }
        if (hello.type !== "hello" || typeof hello.pubkey !== "string") {
          logRelayEvent("embedded relay: expected hello, closing");
          socket.close();
          return;
        }
        claimedPeer = hello.pubkey;
        if (typeof hello.room_id === "string" && hello.room_id.length > 0) {
          claimedRoom = hello.room_id;
        }
        nonce = randomBytes(32);
        step = "auth";
        socket.send(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }));
        return;
      }

      // step === "auth"
      let authMsg: { type?: string; sig?: string };
      try {
        authMsg = JSON.parse(text) as typeof authMsg;
      } catch {
        logRelayEvent("embedded relay: invalid json in auth, closing");
        socket.close();
        return;
      }
      if (authMsg.type !== "auth" || typeof authMsg.sig !== "string" || nonce === null) {
        logRelayEvent("embedded relay: expected auth, closing");
        socket.close();
        return;
      }

      let peer: string;
      let ok = false;
      try {
        const pk = Buffer.from(claimedPeer ?? "", "base64");
        const sig = Buffer.from(authMsg.sig, "base64");
        ok = pk.length === 32 && sig.length === 64 && ed25519Verify(pk, nonce, sig);
        peer = Buffer.from(pk).toString("base64");
      } catch {
        ok = false;
        peer = "";
      }
      if (!ok) {
        logRelayEvent("embedded relay: invalid signature, closing");
        socket.close();
        return;
      }

      settled = true;
      clearTimeout(helloTimer);
      socket.off("message", onMessage);

      conn = { id: nextConnId++, socket, peer, room: claimedRoom };
      addRoute(conn);
      logRelayEvent(
        `embedded relay: authenticated peer=${peer.slice(-8)} room=${claimedRoom} (${routes.size} route(s))`,
      );

      // Keepalive: the Rust relay pings every 25 s, and the host's liveness
      // watchdog expects inbound traffic at that cadence.
      const ping = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.ping();
      }, PING_INTERVAL_MS);

      socket.on("message", (data: unknown) => onRoutedFrame(conn as Connection, data));
      socket.on("close", () => {
        clearInterval(ping);
        if (conn) {
          removeRoute(conn);
          logRelayEvent(`embedded relay: peer=${peer.slice(-8)} room=${claimedRoom} disconnected`);
        }
      });
    };

    socket.on("message", onMessage);
    socket.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(helloTimer);
      }
    });
  };

  /**
   * Post-auth frame handling. Mirrors `relay/src/handlers/peer.rs`: a frame
   * with a top-level `type` is a control frame (handled here or ignored), and
   * anything else is an opaque outer envelope to route.
   */
  const onRoutedFrame = (conn: Connection, raw: unknown): void => {
    const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      logRelayEvent("embedded relay: invalid json, dropping");
      return;
    }

    if (typeof frame["type"] === "string") {
      // Control frames the local mode does not implement. Ignored explicitly
      // rather than routed, so a control frame can never be mistaken for an
      // envelope (which would be a silent corruption).
      logRelayEvent(`embedded relay: ignoring control frame type=${frame["type"]}`);
      return;
    }

    const destPeer = frame["peer"];
    const destRoom = typeof frame["room"] === "string" ? frame["room"] : "main";
    const ct = frame["ct"];
    if (typeof destPeer !== "string" || typeof ct !== "string") {
      logRelayEvent("embedded relay: envelope missing peer/ct, dropping");
      return;
    }

    const bucket = routes.get(routeKey(destPeer, destRoom));
    if (!bucket || bucket.size === 0) {
      logRelayEvent(
        `embedded relay: dest peer=${destPeer.slice(-8)} room=${destRoom} not found, dropping`,
      );
      return;
    }

    // THE security invariant: rewrite peer/room to the SENDER's authenticated
    // identity. The recipient trusts these fields because the relay vouched.
    const forwarded = JSON.stringify({ peer: conn.peer, room: conn.room, ct });

    for (const target of bucket) {
      // Skip the sender's own connection so a multi-device owner does not
      // receive an echo of its own outbound frame.
      if (target.id === conn.id) continue;
      if (target.socket.readyState !== WebSocket.OPEN) continue;
      target.socket.send(forwarded);
    }
  };

  wss.on("connection", authConnection);

  const closeRoutes = (): Promise<void> =>
    new Promise<void>((done) => {
      for (const bucket of routes.values()) {
        for (const c of bucket) {
          try {
            c.socket.close();
          } catch {
            /* already gone */
          }
        }
      }
      routes.clear();
      wss.close(() => done());
    });

  /*
   * `noServer` mode never emits `listening`: the caller owns the port. Resolve
   * immediately and hand back the upgrade entry point instead of a listener
   * address. `url` is supplied by the caller, who knows the real origin.
   */
  if (noServer) {
    logRelayEvent("embedded relay: attached to caller HTTP server (noServer)");
    return Promise.resolve({
      url: "",
      close: closeRoutes,
      handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      },
    });
  }

  return new Promise<EmbeddedRelay>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    wss.once("error", onError);

    wss.once("listening", () => {
      wss.off("error", onError);
      const address = wss.address();
      if (address === null || typeof address === "string") {
        reject(new Error("embedded relay: unexpected listen address"));
        return;
      }
      const url = `ws://${host}:${address.port}`;
      logRelayEvent(`embedded relay: listening on ${url}`);

      resolve({
        url,
        close: closeRoutes,
      });
    });
  });
}
