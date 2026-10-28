/**
 * Server-Sent-Events endpoints for the direct connection (plan/76, phase 1).
 *
 * ## Architecture
 *
 * The browser already speaks the relay protocol. Rather than teach the client a
 * second protocol, each SSE connection gets its OWN `RelayClient` inside the
 * server, dialling the in-process relay over loopback:
 *
 *     browser --SSE--> /api/events --RelayClient(loopback)--> embedded relay
 *     browser --POST-> /api/frame  --same RelayClient---------> embedded relay
 *
 * So the relay stays the single router, the client protocol is unchanged, and
 * this file is a thin adapter. Nothing about addressing, identity rewriting or
 * fan-out is reimplemented.
 *
 * ## Why the SSE channel is one-way but the session is not
 *
 * `EventSource` cannot POST on the same socket, so outbound frames arrive on a
 * separate request. The two are tied together by a per-connection id, which the
 * stream hands back in its first event. A POST without that id is refused: it
 * would otherwise have no relay connection to write to.
 *
 * ## Backpressure
 *
 * A phone with the screen off stops reading while the agent keeps emitting. The
 * queue therefore has a high-water mark (drop events a later event repairs,
 * i.e. streaming deltas) and a hard backlog limit (terminate, so the client
 * reconnects and re-syncs). Without this, one 24 MB tool result pins the memory
 * until a GC the process never asks for.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { RelayClient } from "./relay_client.js";
import { generateEd25519Keypair } from "../pairing/crypto.js";
import { getOrCreateEd25519Keypair } from "../pairing/storage.js";
import { authoriseLocalPeer, deliverLocalInbound, registerSseReplySink } from "../daemon/host_bridge.js";
import { HOST_ROOM_ID } from "../protocol/types.js";
import { logRelayEvent } from "../log.js";

/**
 * Read the host's public key — the destination every browser frame addresses.
 *
 * Cached after the first read: it is written once at install time and never
 * changes, and every stream would otherwise hit the filesystem.
 *
 * @returns the host public key, base64.
 */
let cachedHostPeer: string | null = null;
async function readHostPeer(): Promise<string> {
  if (cachedHostPeer !== null) return cachedHostPeer;
  const keypair = await getOrCreateEd25519Keypair();
  cachedHostPeer = Buffer.from(keypair.publicKey).toString("base64");
  return cachedHostPeer;
}

/** Above this many queued bytes, drop events a later event repairs. */
const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
/** Above this many queued bytes, terminate so the client re-snapshots. */
const BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;
/** Comment-frame interval. Keeps proxies from idling the stream out. */
const HEARTBEAT_MS = 15_000;
/** How long a POST may arrive after its stream opened. */
const SESSION_TTL_MS = 10 * 60_000;

/** Types whose value is superseded by a later event, so dropping one is safe. */
const DROPPABLE_TYPES: ReadonlySet<string> = new Set([
  "assistant_delta",
  "agent_delta",
  "tool_output",
  "streaming_delta",
]);

interface StreamSession {
  readonly id: string;
  readonly res: ServerResponse;
  readonly client: RelayClient;
  readonly heartbeat: NodeJS.Timeout;
  /** Host public key: the DESTINATION every browser frame is addressed to. */
  readonly hostPeer: string;
  /** Withdraws this stream's host-room authorisation; set right after auth. */
  revokeLocal?: () => void;
  /** This stream's own peer key, used to index it for direct reply delivery. */
  peerKey?: string;
  /** Bytes currently queued in the socket but not yet flushed. */
  queuedBytes: number;
  /** Monotonic per-stream sequence, emitted as the SSE `id:` field. */
  seq: number;
  /** Shared backlog + identity that survives a reconnect. */
  resume: ResumableStream;
  /** Buffer key holding this stream's resume state. */
  resumeKey: string;
  closed: boolean;
}

/**
 * How many frames a reconnecting client can have replayed.
 *
 * Chosen to cover a laptop suspend or a brief network drop: 256 frames is a few
 * seconds of streaming. Beyond this the client is told to re-sync instead.
 */
const REPLAY_LIMIT_FRAMES = 256;
/** Byte ceiling for the replay buffer, so one huge frame cannot pin memory. */
const REPLAY_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * State a reconnecting client inherits: its identity, its sequence, its backlog.
 *
 * Deliberately NOT the whole `StreamSession`: that holds a dead `res`, a dead
 * `RelayClient` and a live heartbeat interval. What actually has to survive a
 * reconnect is the KEYPAIR (so replies already in flight still address the same
 * peer) plus enough history to cover the gap.
 */
interface ResumableStream {
  /** Raw keypair, so the new stream presents the same identity. */
  readonly keypair: ReturnType<typeof generateEd25519Keypair>;
  /** That identity, base64 — the key `streamsByPeer` is indexed by. */
  readonly peerKey: string;
  /** Sequence of the last frame written. */
  seq: number;
  /** Recent frames, oldest first. */
  replay: Array<{ seq: number; payload: string }>;
  /** Total bytes in `replay`. */
  replayBytes: number;
}

/**
 * Streams by their resume token, so a reconnect can adopt its predecessor's state.
 *
 * Keyed by the sequence number the browser echoes in `Last-Event-ID`. Bounded and
 * expired: a client that stays away is better served by a full re-sync than by an
 * ever-growing log.
 */
const resumable = new Map<string, ResumableStream>();
/** Expiry for a resume token, refreshed on every write. */
const RESUME_TTL_MS = 5 * 60_000;
/** Wall-clock expiry per token, so an abandoned tab cannot pin memory. */
const resumeExpiry = new Map<string, number>();

const sessions = new Map<string, StreamSession>();

/**
 * Plan/76 phase two: stream lookup by the peer key a reply is addressed to.
 *
 * Each stream mints its own Ed25519 keypair, so a reply naming that key belongs to
 * exactly one browser. Indexing by it lets `deliverToPeer` skip the relay entirely:
 * the host hands the frame over here and it is written straight to the stream.
 *
 * An entry exists only while its stream is open, so a closed tab removes itself and
 * a late reply finds nothing rather than resurrecting a dead response.
 */
const streamsByPeer = new Map<string, StreamSession>();

/**
 * Deliver an encoded envelope to the browser stream that owns `peer`.
 *
 * This is the `ReplySink` implementation handed to `HostBridge` in same-origin
 * mode. It replaces the relay hop for the browser direction only — child-daemon
 * IPC still travels over the relay, because `_forwardToChild` and
 * `_isOwnKeyInbound` are untouched.
 *
 * @param peer - the destination peer key.
 * @param frame - the serialized envelope (`{peer, room, ct}`).
 * @returns whether a live stream accepted it.
 */
export function deliverToPeer(peer: string, frame: string): boolean {
  const target = streamsByPeer.get(peer);
  if (target === undefined) return false;

  if (target.closed) {
    /*
     * The stream is between reconnects. Buffer the frame into the resume record so
     * the reconnecting client receives it in the replay, instead of dropping it and
     * leaving a hole in the transcript. The restamp matches `writeFrame`, since the
     * replayed frame is delivered by the same client-side checks.
     */
    const seq = target.resume.seq + 1;
    target.resume.seq = seq;
    const outgoing = restampFromHost(frame, target.hostPeer);
    rememberForReplay(target.resume, seq, `id: ${seq}\ndata: ${outgoing}\n\n`);
    return true;
  }

  try {
    writeFrame(target, frame);
    return true;
  } catch {
    return false;
  }
}

/*
 * Publish this module's delivery capability where `HostBridge._reply` can reach it.
 *
 * Registration on import (rather than a supervisor-side import of this module) keeps
 * the relay client and its WebSocket stack out of processes that only need the
 * supervisor. Until this module loads, `deliverSseReply` declines and replies take
 * the relay — the pre-existing behaviour.
 */
registerSseReplySink(deliverToPeer);

/**
 * Open the SSE stream for one browser connection.
 *
 * The method returns once the headers are written; the session stays alive until
 * the client disconnects or the backlog limit trips.
 *
 * @param req - the incoming request, used for abort detection.
 * @param res - the response that becomes the event stream.
 * @param relayUrl - the in-process relay to dial, e.g. `ws://127.0.0.1:4124`.
 * @returns the connection id the client must use for its POSTs, or `null` when
 *          the relay could not be reached.
 */
export async function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  relayUrl: string,
): Promise<string | null> {
  const id = randomUUID();

  /*
   * Resume support: `EventSource` reconnects on its own and echoes the last `id:`
   * it saw. Without honouring that header every reconnect starts a fresh stream and
   * every frame produced during the gap is lost — the laptop-suspend case that made
   * the WebSocket path look more reliable than it is.
   */
  const resumeToken = readLastEventId(req);
  const resumeFrom = resumeToken === null ? null : findResumable(resumeToken);

  /*
   * The HOST's public key, which is the envelope's DESTINATION.
   *
   * The relay routes an envelope to `(peer, room)` — `peer` is who you are
   * ADDRESSING, not who you are. Sending an empty value makes the relay log
   * `dest peer= room=host not found` and drop the frame, so every browser command
   * would vanish with no error at either end.
   */
  const hostPeer = await readHostPeer();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    /* Stops nginx-style buffering from defeating the whole point. */
    "x-accel-buffering": "no",
  });
  /* The client needs the id before it can POST, so it goes out first. */

  /*
   * A FRESH keypair per stream, NOT the host's identity.
   *
   * Reusing the host key was the first design and it leaked frames between tabs:
   * the relay routes by `(peer, room)` and skips only the SENDING socket, so
   * every other stream sharing that identity received the frame. With a distinct
   * key per stream each tab gets its own routing bucket and replies land exactly
   * where they belong.
   *
   * Authorisation is therefore explicit, not identity-based: the key is minted
   * here, never leaves this process, and is registered with the host bridge via
   * `authoriseLocalPeer` for exactly as long as the stream is open. That is what
   * makes local usage need no pairing code without opening a hole for a remote
   * peer — a remote cannot forge `peer`, because the relay rewrites it to the
   * identity it authenticated.
   *
   * On a RESUME the previous stream's keypair is adopted instead of minting a new
   * one. Replies already addressed to it therefore keep landing in this stream,
   * which is the whole reason a reconnect is survivable: a new identity would leave
   * every in-flight reply pointing at a peer that no longer exists.
   */
  const keypair = resumeFrom?.keypair ?? generateEd25519Keypair();
  const peerKey = Buffer.from(keypair.publicKey).toString("base64");
  const resume: ResumableStream = resumeFrom ?? {
    keypair,
    peerKey,
    seq: 0,
    replay: [],
    replayBytes: 0,
  };
  const resumeKey = String(resume.seq);
  const client = new RelayClient(relayUrl, keypair);
  let established = false;
  try {
    /* The host room: this connection represents the BROWSER, which always talks
     * to the host room. Per-workspace rooms belong to the child daemons. */
    await client.connect({ roomId: HOST_ROOM_ID });
    established = true;
  } catch (err) {
    logRelayEvent(`sse: relay connect failed: ${(err as Error).message}`);
    res.end();
    return null;
  }
  if (!established) {
    res.end();
    return null;
  }

  const session: StreamSession = {
    id,
    res,
    client,
    hostPeer,
    queuedBytes: 0,
    seq: resume.seq,
    resume,
    resumeKey,
    closed: false,
    heartbeat: setInterval(() => {
      if (session.closed) return;
      /* A comment line is a legal no-op frame that EventSource discards. */
      res.write(`: keepalive\n\n`);
    }, HEARTBEAT_MS),
  };
  /*
   * `unref()` so an idle stream cannot pin the event loop. Without it a single
   * open stream kept the process alive forever, because nothing else ever called
   * `closeAllEventStreams` — the suite then hung until SIGKILL.
   */
  session.heartbeat.unref();

  /*
   * Authorise this stream's key for the lifetime of the stream. The revoker is
   * kept on the session so `closeSession` can withdraw it — leaving a dead key in
   * the set would slowly widen the bypass for no reason.
   */
  session.revokeLocal = authoriseLocalPeer(peerKey);
  /* Phase two: index this stream by its peer so replies can skip the relay. */
  streamsByPeer.set(peerKey, session);
  session.peerKey = peerKey;

  /*
   * Every frame the relay forwards for this connection goes straight out. The
   * relay already rewrote `peer`/`room` to the vouched identity, so this layer
   * never inspects or trusts the payload.
   *
   * The try/catch is load-bearing: `writeFrame` touches the response socket, and an
   * unguarded throw inside an EventEmitter callback becomes an uncaught exception
   * that takes the whole server down — one browser closing a tab could kill the
   * agent process serving it.
   */
  client.on("message", (line: string) => {
    if (session.closed) return;
    try {
      writeFrame(session, line);
    } catch (err) {
      logRelayEvent(`sse: write failed id=${id.slice(0, 8)} (${(err as Error).message})`);
      closeSession(session, "write failed");
    }
  });

  client.on("close", () => {
    closeSession(session, "relay closed");
  });

  req.on("close", () => {
    closeSession(session, "client disconnected");
  });

  /*
   * `ServerResponse` is an EventEmitter: an `error` with no listener is rethrown as
   * an uncaught exception. A dropped TCP connection (EPIPE / ECONNRESET) therefore
   * crashed the process instead of just ending one stream.
   */
  res.on("error", () => {
    closeSession(session, "response error");
  });

  sessions.set(id, session);

  /*
   * The connection id goes out only NOW that `sessions` can answer a POST.
   *
   * Publishing it before `sessions.set` left a window where the browser could read
   * the id, POST `pair_request` in the same tick, and be told "no such connection"
   * — a 409 that surfaced as a failed first pair which a manual reload then fixed,
   * the classic look of a flaky race rather than a missing line of ordering.
   *
   * Replay follows the id for the same reason: a replayed frame that arrives before
   * the client knows its connection id cannot be acknowledged and is simply lost.
   */
  res.write(`event: endpoint\ndata: ${JSON.stringify({ id })}\n\n`);

  /*
   * Replay whatever the client missed while it was away.
   *
   * `Last-Event-ID` names the last frame it saw; everything newer is still in the
   * buffer. Only the frames AFTER that point are resent, so a reconnect costs the
   * gap and nothing more.
   */
  if (resumeFrom !== null) {
    const since = Number(resumeToken);
    let replayed = 0;
    for (const entry of resume.replay) {
      if (entry.seq <= since) continue;
      res.write(entry.payload);
      replayed += 1;
    }
    logRelayEvent(`sse: resumed id=${id.slice(0, 8)} replayed=${replayed} since=${since}`);
  }

  const ttl = setTimeout(() => closeSession(session, "session ttl"), SESSION_TTL_MS);
  ttl.unref();

  logRelayEvent(`sse: stream opened id=${id.slice(0, 8)}`);
  return id;
}

/**
 * Write one relay frame to the stream, applying backpressure rules.
 *
 * @param session - the target stream.
 * @param line - the raw relay frame.
 */
function writeFrame(session: StreamSession, line: string): void {
  const seq = session.seq + 1;
  session.seq = seq;
  /*
   * Present the frame as coming FROM the host.
   *
   * The browser client anchors on exactly one peer: `onFrame` rejects any envelope
   * whose `peer` differs from `expectedHostPeer`, which it learned from pairing. A
   * reply that leaves the bridge still carries this STREAM's key (`peerKey`), because
   * that is what lets the bridge tell a browser command from a child-daemon reply.
   * Forwarding it unchanged therefore made every reply look like a stranger's and be
   * dropped in silence — the page saw no `pair_ok` at all.
   *
   * The stream key is an internal routing detail, so it is rewritten back to the host
   * identity on the way out.
   */
  const payload = `id: ${seq}\ndata: ${restampFromHost(line, session.hostPeer)}\n\n`;
  const size = Buffer.byteLength(payload);

  if (session.queuedBytes + size > BACKLOG_LIMIT_BYTES) {
    /*
     * A client that has stopped reading cannot be caught up event-by-event. Cut
     * it loose: `EventSource` reconnects, the client re-syncs, and the memory
     * comes back now instead of at an unbounded later time.
     */
    logRelayEvent(`sse: backlog ${session.queuedBytes}B exceeded, terminating stream`);
    closeSession(session, "backlog limit");
    return;
  }

  if (session.queuedBytes + size > STREAM_HIGH_WATER_MARK_BYTES && isDroppable(line)) {
    /* Superseded by a later event of the same kind; safe to lose. */
    return;
  }

  /*
   * Buffer for replay BEFORE writing, so a client that reconnects a millisecond
   * after this frame still finds it. The `id:` above is what it will echo back.
   */
  rememberForReplay(session.resume, seq, payload);

  session.queuedBytes += size;
  try {
    session.res.write(payload, () => {
      session.queuedBytes = Math.max(0, session.queuedBytes - size);
    });
  } catch {
    /* A destroyed response rejects the write; end the stream instead of crashing. */
    closeSession(session, "write threw");
  }
}

/**
 * Rewrite an envelope's `peer` to the host's own identity.
 *
 * See `writeFrame` for why: the browser only trusts frames from the peer it paired
 * with, and the bridge addresses replies by stream key.
 *
 * @param line - a serialized outer envelope.
 * @param hostPeer - the host's public key (base64).
 * @returns the frame with `peer` replaced, or the input when it is not an envelope.
 */
function restampFromHost(line: string, hostPeer: string): string {
  try {
    const outer = JSON.parse(line) as { peer?: unknown; room?: unknown; ct?: unknown };
    if (typeof outer.ct !== "string") return line;
    return JSON.stringify({ peer: hostPeer, room: HOST_ROOM_ID, ct: outer.ct });
  } catch {
    return line;
  }
}

/**
 * True when losing this frame cannot corrupt client state.
 *
 * @param line - the raw relay frame.
 * @returns whether the frame is a superseded delta.
 */
function isDroppable(line: string): boolean {
  try {
    const outer = JSON.parse(line) as { ct?: unknown };
    if (typeof outer.ct !== "string") return false;
    const inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as {
      type?: unknown;
    };
    return typeof inner.type === "string" && DROPPABLE_TYPES.has(inner.type);
  } catch {
    /* An unparseable frame is never dropped: silence would hide a real fault. */
    return false;
  }
}

/**
 * Types that belong to the RELAY's own handshake rather than to the host protocol.
 *
 * The relay answers `hello` with `challenge` and validates `auth`; the host bridge
 * has no handler for either and would drop them silently.
 */
const RELAY_HANDSHAKE_TYPES: ReadonlySet<string> = new Set(["hello", "auth"]);

/**
 * Whether a parsed client frame is relay-handshake rather than host traffic.
 *
 * @param parsed - the decoded frame.
 * @returns `true` for `hello` / `auth`.
 */
function isRelayHandshakeFrame(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && RELAY_HANDSHAKE_TYPES.has(type);
}

/**
 * Forward one client frame to the relay, supplying the envelope when absent.
 *
 * The real browser client ALREADY sends a complete `{peer, room, ct}` envelope —
 * `client.ts` `rawSend` builds it with `encodeOuter(peer, room, inner)`, where
 * `peer` is the host's public key. Enveloped frames are injected into the running
 * bridge; bare relay-handshake frames go to the relay.
 *
 * @param connectionId - the stream the frame belongs to.
 * @param innerJson - the request body, a serialized frame.
 * @returns `false` when no stream owns that id.
 */
export function writeFrameToRelay(connectionId: string, innerJson: string): boolean {
  const session = sessions.get(connectionId);
  if (session === undefined || session.closed) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(innerJson);
  } catch {
    return false;
  }

  const isEnveloped =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { ct?: unknown }).ct === "string" &&
    typeof (parsed as { type?: unknown }).type !== "string";

  const frame = isEnveloped
    ? innerJson
    : JSON.stringify({
        peer: session.hostPeer,
        room: HOST_ROOM_ID,
        ct: Buffer.from(innerJson, "utf8").toString("base64"),
      });

  /*
   * A bare RELAY-HANDSHAKE frame must go to the relay, never to the bridge.
   *
   * `hello` and `auth` are relay-protocol messages: the relay answers `hello` with
   * `challenge`, and only the relay can validate `auth`. Injecting them into the
   * host bridge produced no `challenge` at all, so the client spun until
   * `challenge_timeout` while the server log showed an opened, healthy stream — the
   * exact failure that kept the page on the launcher once SSE was enabled.
   */
  if (!isEnveloped && isRelayHandshakeFrame(parsed)) {
    try {
      session.client.send(frame);
      return true;
    } catch (err) {
      logRelayEvent(`sse: relay write failed: ${(err as Error).message}`);
      return false;
    }
  }

  /*
   * Phase two: hand an ENVELOPED frame straight to the running bridge.
   *
   * The relay REWRITES an envelope's `peer` to the SENDER's identity while
   * forwarding (that is how the host tells a browser command apart from a
   * child-daemon reply — `_isOwnKeyInbound` compares `peer` against the host's own
   * key). Injecting without reproducing that rewrite would make every browser
   * command look like a child reply and be misrouted.
   *
   * So: re-stamp `peer` with THIS stream's key before injecting, exactly as the
   * relay would have done, then fall back to the relay when no bridge is running.
   */
  let directLine = frame;
  try {
    const parsedFrame = JSON.parse(frame) as { peer?: unknown; room?: unknown; ct?: unknown };
    if (typeof parsedFrame.ct === "string") {
      directLine = JSON.stringify({
        peer: session.peerKey ?? parsedFrame.peer,
        room: typeof parsedFrame.room === "string" ? parsedFrame.room : HOST_ROOM_ID,
        ct: parsedFrame.ct,
      });
    }
  } catch {
    /* Not an envelope after all; let the relay reject it. */
  }

  if (deliverLocalInbound(directLine)) {
    logRelayEvent(`sse: frame injected directly (peer=${(session.peerKey ?? "?").slice(0, 8)}…)`);
    return true;
  }

  try {
    session.client.send(frame);
    return true;
  } catch (err) {
    logRelayEvent(`sse: relay send failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Read `Last-Event-ID`, which `EventSource` sets on reconnect.
 *
 * @param req - the reconnecting request.
 * @returns the raw header value, or `null` when this is a first connection.
 */
function readLastEventId(req: IncomingMessage): string | null {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
  return value;
}

/**
 * Find a still-valid resume record for a token.
 *
 * @param token - the sequence number the client echoed.
 * @returns the record, or `null` when it expired (the caller then starts fresh).
 */
function findResumable(token: string): ResumableStream | null {
  pruneResumable();
  return resumable.get(token) ?? null;
}

/** Drop resume records past their TTL so an abandoned tab cannot pin memory. */
function pruneResumable(): void {
  const now = Date.now();
  for (const [key, expiry] of resumeExpiry) {
    if (expiry > now) continue;
    resumeExpiry.delete(key);
    resumable.delete(key);
  }
}

/**
 * Keep a frame for replay and publish it under its sequence number.
 *
 * Takes the resume record rather than the session so a frame produced while the
 * client is between reconnects (no live session) can still be buffered.
 *
 * @param resume - the record to append to.
 * @param seq - the frame's sequence number.
 * @param payload - the fully formatted SSE frame, already carrying `id:`.
 */
function rememberForReplay(resume: ResumableStream, seq: number, payload: string): void {
  resume.seq = seq;
  resume.replay.push({ seq, payload });
  resume.replayBytes += Buffer.byteLength(payload);

  while (resume.replay.length > REPLAY_LIMIT_FRAMES || resume.replayBytes > REPLAY_LIMIT_BYTES) {
    const dropped = resume.replay.shift();
    if (dropped === undefined) break;
    resume.replayBytes -= Buffer.byteLength(dropped.payload);
  }

  /*
   * Re-key by the newest sequence so `Last-Event-ID: <newest>` resolves. Older
   * tokens stay registered until the TTL sweeps them, which is what lets a client
   * that missed several frames resume at the exact point it stopped.
   */
  resumable.set(String(seq), resume);
  resumeExpiry.set(String(seq), Date.now() + RESUME_TTL_MS);
}

/**
 * Close one stream and release everything it holds.
 *
 * @param session - the stream to close.
 * @param reason - logged, so a dropped stream says why.
 */
function closeSession(session: StreamSession, reason: string): void {
  if (session.closed) return;
  session.closed = true;
  clearInterval(session.heartbeat);
  sessions.delete(session.id);
  /*
   * NOTE: `streamsByPeer` is deliberately NOT cleared here.
   *
   * A reconnect adopts `session.resume` and re-registers the same peer key, so the
   * entry is reused. Clearing it would make every reply produced during the gap
   * undeliverable, which is exactly the loss this resume support exists to prevent.
   * The entry is swept by `pruneResumable` once the TTL passes.
   */
  session.revokeLocal?.();
  try {
    session.client.close();
  } catch {
    /* Already gone. */
  }
  try {
    session.res.end();
  } catch {
    /* Already gone. */
  }
  logRelayEvent(`sse: stream closed id=${session.id.slice(0, 8)} (${reason})`);
}

/**
 * Close every open stream.
 *
 * Exported for tests and for a clean shutdown: without it an open stream keeps the
 * process alive through its heartbeat interval.
 *
 * @returns how many streams were closed.
 */
export function closeAllEventStreams(): number {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    const session = sessions.get(id);
    if (session !== undefined) closeSession(session, "shutdown");
  }
  return ids.length;
}
