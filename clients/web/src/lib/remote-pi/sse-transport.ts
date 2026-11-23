/**
 * SSE-backed transport for the direct connection (plan/76, phase 1).
 *
 * ## Why an adapter and not a rewrite
 *
 * `RemotePiWebClient` already accepts a `webSocketFactory`, and its whole
 * transport surface is four events (`open`/`message`/`close`/`error`) plus
 * `send`/`close`. A different transport therefore does not need to touch the
 * ~25 protocol methods — it only has to look like a socket. Everything above
 * stays byte-identical, which is what keeps this change reviewable and
 * revertible.
 *
 * ## The shape mismatch, stated plainly
 *
 * SSE is one-way (server → browser). Outbound frames go over a separate `POST`,
 * and the two channels are coordinated here:
 *
 *   - outbound: `POST /api/frame` returns 204, fire-and-forget. A frame sent
 *     while the POST is in flight is queued, preserving order.
 *   - inbound: `EventSource` delivers `message` events; `Last-Event-ID` lets the
 *     server resume after a reconnect.
 *
 * This is the risk the plan names: two channels can desynchronise in a way a
 * single socket cannot. The mitigation is that inbound is ordered by the server
 * (it owns the sequence ids) and outbound stays idempotent only where the
 * protocol already says so — nothing new is invented here.
 *
 * ## Reconnection
 *
 * `EventSource` reconnects on its own, which is the main reason to prefer it:
 * the hand-rolled 800 ms blind retry in `resyncLive` exists precisely because a
 * raw WebSocket does not. A reconnect re-emits `open`, so the caller's
 * hydration path runs unchanged.
 *
 * ## A lossy hop, and the one retry that is safe
 *
 * The outbound POST crosses whatever sits between the browser and the server. On
 * the public lane that includes an HTTP proxy whose idle-connection reclaim is
 * ~4 s: the first POST after a quiet moment reuses a connection the proxy has
 * already closed and comes back as a proxy-generated 502 (measured: no `Date`, no
 * `content-type`, `Keep-Alive: timeout=4`, while the server itself reaps at 5 s).
 * An immediate re-send of the same body succeeded 2/2.
 *
 * So a lost POST is re-sent for a small, explicit set of READ frames — and only
 * for those. See `IDEMPOTENT_READ_FRAMES` for the invariant that separates a
 * harmless re-send from a duplicated side effect.
 *
 * ## Plan 86 P3 — two lanes, and the write barrier
 *
 * Three unrelated facts used to collide in one serial queue:
 *
 *   1. `session_list` and `session_sync` were POSTed one after the other, so
 *      opening a workspace made the second wait for the FIRST one's HTTP 204 —
 *      measured 416–542 ms of pure queueing, and that 204 is not a business
 *      answer.
 *   2. A lost read was re-sent at the HEAD of that queue, so a failing read could
 *      delay an unrelated write.
 *   3. There was no notion of "a write happened, so a read that started before it
 *      describes stale content".
 *
 * The fix is deliberately narrow: an explicit allow-list of host-native HISTORY
 * READS (`history_list` / `history_read` / `history_body`) gets its own lane with
 * at most `HISTORY_MAX_CONCURRENT_POSTS` POSTs in flight, ordered by priority
 * (foreground before prefetch). Every other frame — chat, writes, legacy reads —
 * stays in the original serial lane, order intact.
 *
 * A WRITE in the serial lane now runs a barrier:
 *
 *   - the epoch is bumped IMMEDIATELY (so the application layer knows every
 *     history read launched before this moment is pre-write and must not be
 *     applied);
 *   - already-launched history POSTs are drained;
 *   - the write is POSTed (writes stay serial);
 *   - the history lane stays CLOSED until the write's BUSINESS answer arrives
 *     (any inbound frame correlating to its request id) or the write reaches a
 *     definite terminal (a failed POST — never replayed — or the ack timeout).
 *     A 204 alone is NOT a business answer and never reopens the lane.
 *
 * Nothing here changes the WebSocket path: `send()` behaves exactly as before,
 * and `sendPrioritized()` only exists on this transport.
 */

import { decodeCt } from "./protocol.ts";

/**
 * One outbound frame awaiting its POST, plus the re-sends it has already spent.
 *
 * The budget lives ON the frame rather than in a parallel table: it has to
 * survive the frame being put back at the head of the queue, and it must die
 * with the frame, so a long-lived tab cannot accumulate counters.
 */
interface QueuedFrame {
  readonly data: string;
  attempts: number;
  /** Serial lane = ordered, one POST at a time. History lane = independent. */
  readonly lane: "serial" | "history";
  /** History lane only: lower runs first (0 = foreground, 1 = prefetch).
   *  Mutable so a CLICK can promote a hover's queued read in place. */
  priority: number;
  /** Monotonic insertion order; keeps FIFO inside one priority. */
  readonly seq: number;
  /** Innermost request id, for the write barrier's business-answer match. */
  readonly requestId: string | null;
  /** True when this frame may change host state (never re-sent). */
  readonly write: boolean;
}

/**
 * How long to wait before each re-send of a read frame (ms, in order).
 *
 * An IMMEDIATE re-send is what the lane measurement proved (2/2 succeeded after a
 * 502), so the first delay only has to leave the reaped socket behind; the rest
 * are short draws, not a backoff ladder, because each one is a fresh chance at
 * the same 4 s reclaim race and none of them costs anything but a duplicate
 * `session_read` on the host.
 *
 * FOUR throws, ~2 s of added latency at worst. That is deliberate: a read that
 * loses every throw is dropped, and its only remaining backstop is the UI's 30 s
 * `SESSION_READ_TIMEOUT_MS`, so the number of throws is what decides whether a
 * lossy hop is survivable at all. Kept small enough that a genuinely silent host
 * is still reported quickly rather than papered over.
 */
const READ_RETRY_DELAYS_MS: readonly number[] = [120, 500, 1_400];

/** At most this many history POSTs may be in flight at once (Plan 86 §4.4). */
export const HISTORY_MAX_CONCURRENT_POSTS = 2;

/**
 * How long the history lane stays closed waiting for a write's business answer.
 *
 * Bounded on purpose: a write whose answer never arrives is UNCERTAIN, and an
 * uncertain write must not freeze history reading forever. On expiry the lane
 * reopens and the write is reported as uncertain — it is never replayed.
 */
export const WRITE_ACK_TIMEOUT_MS = 5_000;

/** History frames that may run in the independent lane (and be re-sent). */
const HISTORY_READ_FRAMES: ReadonlySet<string> = new Set([
  "history_list",
  "history_read",
  "history_body",
]);

/**
 * Frames a lost POST may be re-sent for. An ALLOW-LIST, deliberately so.
 *
 * THE INVARIANT: a re-send is only safe for a frame the host may apply twice and
 * reach the same state. All kinds below are READS — they answer from disk and
 * change nothing — and all of them are fire-and-forget (`_forwardToRoom` in
 * client.ts registers no pending entry) or pure RPCs, so even a DOUBLE delivery
 * (the first POST landed and only its reply was lost) costs nothing more than a
 * second reply that the caller ignores.
 *
 * A write must NEVER be added here. `user_message` is the clearest case: the first
 * POST may already have run the turn, so a re-send runs it TWICE, and a
 * duplicated chat message is worse than the timeout the UI can explain.
 * `session_switch`, `session_new`, `model_set`, `thinking_set`, `models_mutate`,
 * `settings_mutate`, `workspace_*`, `package_*`, `skill_*` and `schedule_*` are
 * the same shape — each changes host state, so a duplicate is a real second side
 * effect. Everything else keeps the drop-once behaviour, and the allow-list
 * direction means a frame kind added later is NOT retried until someone states,
 * here, why it is idempotent.
 */
const IDEMPOTENT_READ_FRAMES: ReadonlySet<string> = new Set([
  "session_read",
  "session_list",
  "session_sync",
  "history_list",
  "history_read",
  "history_body",
]);

/** What the application learns about the write barrier. */
export interface HistoryBarrierEvent {
  /** Monotonic epoch. Every write bumps it. */
  epoch: number;
  /** True when the write reached a definite terminal and the lane reopened. */
  cleared: boolean;
  /** Set on `cleared` when no business answer arrived in time. */
  uncertain?: boolean;
}

/** Innermost `type` + request `id` of an outbound frame. */
interface FrameIdentity {
  type: string | null;
  id: string | null;
}

/**
 * Peel the `ct` layers of an outbound frame.
 *
 * An outbound client request travels as `{peer, room, ct}` → optionally
 * `host_forward{room, ct}` → the real message. The inner `id` is what replies
 * correlate with, so it is the LAST one found.
 */
function innermostFrame(frame: string): FrameIdentity {
  let current: unknown;
  try {
    current = JSON.parse(frame);
  } catch {
    return { type: null, id: null };
  }
  let type: string | null = null;
  let id: string | null = null;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const candidateType = (current as { type?: unknown }).type;
    if (typeof candidateType === "string") type = candidateType;
    const candidateId = (current as { id?: unknown }).id;
    if (typeof candidateId === "string" && candidateId !== "") id = candidateId;
    const inner = (current as { ct?: unknown }).ct;
    if (typeof inner !== "string") break;
    try {
      current = decodeCt<unknown>(inner);
    } catch {
      break;
    }
  }
  return { type, id };
}

/** Every object in an inbound frame's `ct` chain, outermost first. */
function inboundChain(text: string): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown;
  try {
    current = JSON.parse(text);
  } catch {
    return chain;
  }
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    chain.push(current as Record<string, unknown>);
    const inner = (current as { ct?: unknown }).ct;
    if (typeof inner !== "string") break;
    try {
      current = decodeCt<unknown>(inner);
    } catch {
      break;
    }
  }
  return chain;
}

/** Wait, with no new dependency and no timer bookkeeping to leak. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Minimal surface `RemotePiWebClient` needs from a socket. */
type SocketEventType = "open" | "message" | "close" | "error";

interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: SocketEventType, listener: (event: unknown) => void): void;
  removeEventListener(type: SocketEventType, listener: (event: unknown) => void): void;
  readonly protocol?: string;
}

/** The slice of `EventSource` this transport uses. */
interface EventSourceLike {
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

/**
 * Subscribe to a NAMED SSE event.
 *
 * `onmessage` only fires for unnamed events, so a control event such as
 * `event: endpoint` needs `addEventListener`. Kept as a helper so the nullable
 * capability is handled in one place instead of at each call site.
 *
 * @param source - the event source (typed loosely because the DOM type is not
 *                 available in this module's build target).
 * @param type - the event name.
 * @param listener - invoked for each occurrence.
 */
function addNamedListener(
  source: EventSourceLike,
  type: string,
  listener: (event: { data?: unknown }) => void,
): void {
  const withAdd = source as unknown as {
    addEventListener?: (name: string, fn: (event: unknown) => void) => void;
  };
  withAdd.addEventListener?.(type, listener as (event: unknown) => void);
}

export interface SseTransportOptions {
  /** Origin serving both the stream and the POST endpoint, e.g. `http://127.0.0.1:4124`. */
  readonly baseUrl: string;
  /** Endpoint accepting one outbound frame. Defaults to `/api/frame`. */
  readonly framePath?: string;
  /** Endpoint streaming inbound frames. Defaults to `/api/events`. */
  readonly eventsPath?: string;
  /** Injected in tests. Defaults to the global `EventSource`. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The lane-aware socket this transport additionally exposes. */
export interface PrioritizedSocketLike extends SocketLike {
  /** Queue a history read in the independent lane, ordered by priority. */
  sendPrioritized(data: string, priority: "foreground" | "prefetch"): void;
  /**
   * Promote a QUEUED history read to foreground (Plan 86 P3 click-joins-hover).
   *
   * Only frames still waiting in the lane can be promoted; one already POSTed is
   * in flight and keeps its slot. Returns true when a frame was found.
   */
  reprioritize?(requestId: string, priority: "foreground" | "prefetch"): boolean;
  /** Subscribe to write-barrier epochs (Plan 86 P3). */
  onHistoryBarrier(listener: (event: HistoryBarrierEvent) => void): () => void;
}

/**
 * Build a `webSocketFactory` that speaks SSE instead of WebSocket.
 *
 * The returned factory matches the signature `RemotePiWebClient` already
 * expects, so it can be passed through `adapter.ts` with no other change.
 *
 * @param options - endpoints and test seams.
 * @returns a factory the client calls to obtain a socket-like object.
 */
export function createSseWebSocketFactory(
  options: SseTransportOptions,
): (url: string, protocols: string[]) => PrioritizedSocketLike {
  const eventsPath = options.eventsPath ?? "/api/events";
  const framePath = options.framePath ?? "/api/frame";
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const makeSource =
    options.eventSourceFactory ??
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);

  return (url: string): PrioritizedSocketLike => {
    /*
     * The client passes a `ws://`/`wss://` relay URL. In direct mode the stream
     * lives at the origin that served the page, so the URL only carries the room
     * identity, never the host.
     */
    const room = roomFromUrl(url);
    const query = room === null ? "" : `?room=${encodeURIComponent(room)}`;

    const listeners: Record<SocketEventType, Set<(event: unknown) => void>> = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };
    const barrierListeners = new Set<(event: HistoryBarrierEvent) => void>();
    let closed = false;
    /** Serial lane: every write and every non-history frame, in order. */
    const serialOutbox: QueuedFrame[] = [];
    /** History lane: host-native reads, at most 2 POSTs in flight. */
    const historyOutbox: QueuedFrame[] = [];
    let pumpingSerial = false;
    let pumpingHistory = false;
    let historyActive = 0;
    let drainWaiters: Array<() => void> = [];
    let sequence = 0;
    /** Current write epoch; bumped the moment a write is queued. */
    let epoch = 0;
    /**
     * Set between "a write was queued" and "the write's business answer (or a
     * definite terminal) arrived". While non-null the history lane is CLOSED.
     */
    let pendingWrite: { id: string | null; epoch: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

    const emit = (type: SocketEventType, event: unknown): void => {
      for (const listener of listeners[type]) listener(event);
    };
    const emitBarrier = (event: HistoryBarrierEvent): void => {
      for (const listener of [...barrierListeners]) listener(event);
    };

    const source = makeSource(`${baseUrl}${eventsPath}${query}`);

    /*
     * `open` is deferred until the stream hands out its connection id.
     *
     * `EventSource` fires `open` as soon as the response headers arrive, which is
     * BEFORE any frame — including the `endpoint` event that carries the id every
     * POST must quote. Emitting `open` there let the client believe the connection
     * was usable, send `pair_request` immediately, and watch it queue forever in
     * `preIdOutbox` while `connect()` had already resolved: the page reported
     * "the connection to the relay dropped" and never paired.
     *
     * So `open` is emitted from the `endpoint` handler instead. Nothing can be sent
     * before the id exists, which makes that the only honest moment to say the
     * socket is open.
     */
    let openEmitted = false;

    /** Connection id handed out by the stream in its FIRST event. */
    let connectionId: string | null = null;
    /** Frames produced before the id arrives must wait, not be dropped. */
    const preIdOutbox: QueuedFrame[] = [];

    /* Named-event listener: `onmessage` never sees `event: endpoint`. */
    addNamedListener(source, "endpoint", (event: { data?: unknown }) => {
      if (closed) return;
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as { id?: unknown };
        if (typeof parsed.id !== "string" || parsed.id === "") return;
        connectionId = parsed.id;
      } catch {
        return;
      }
      if (!openEmitted) {
        openEmitted = true;
        emit("open", {});
      }
      /* Release anything queued while we waited for the id. */
      while (preIdOutbox.length > 0) {
        publish(preIdOutbox.shift() as QueuedFrame);
      }
      void pumpSerial();
      void pumpHistory();
    });

    /**
     * Offer one frame to the correct lane.
     *
     * Called for frames produced after the connection id exists. Kept separate
     * from `send()` so the pre-id queue can reuse it verbatim.
     */
    const publish = (frame: QueuedFrame): void => {
      if (frame.lane === "history") historyOutbox.push(frame);
      else serialOutbox.push(frame);
    };

    source.onmessage = (event) => {
      if (closed) return;
      /*
       * `data` reaches the client as the raw frame string. A comment/heartbeat
       * line never becomes a `message` event, so nothing needs filtering:
       * `EventSource` already discards it.
       */
      settleWriteFromInbound(event.data);
      emit("message", { data: event.data });
    };

    source.onerror = (event) => {
      if (closed) return;
      /*
       * `EventSource` reports BOTH a transient drop (it will retry by itself)
       * and a fatal failure through this same handler. Surface it as `error`
       * only — never as `close` — so the client's reconnect path stays the only
       * thing that decides to close, exactly as it does for a dropped socket.
       */
      emit("error", event);
    };

    /**
     * The write's business answer landed (or its timeout expired).
     *
     * Correlation accepts the three shapes a host uses for "this is about your
     * request": `in_reply_to` (every RPC reply), `id` (the `user_message` echo)
     * and `target_id` (a `cancelled` frame). Checking the WHOLE `ct` chain means
     * a proxied reply (`host_message{ct}`) correlates exactly like a direct one.
     */
    const settleWriteFromInbound = (text: string): void => {
      if (pendingWrite === null || pendingWrite.id === null) return;
      const id = pendingWrite.id;
      for (const entry of inboundChain(text)) {
        if (entry["in_reply_to"] === id || entry["id"] === id || entry["target_id"] === id) {
          clearWriteBarrier(false);
          return;
        }
      }
    };

    const clearWriteBarrier = (uncertain: boolean): void => {
      if (pendingWrite === null) return;
      const current = pendingWrite;
      pendingWrite = null;
      if (current.timer !== null) clearTimeout(current.timer);
      emitBarrier({ epoch: current.epoch, cleared: true, ...(uncertain ? { uncertain: true } : {}) });
      void pumpHistory();
    };

    /** Drain resolvers waiting for in-flight history POSTs to finish. */
    const releaseDrainWaiters = (): void => {
      if (historyActive > 0) return;
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    };

    const drainHistoryPosts = (): Promise<void> => {
      if (historyActive === 0) return Promise.resolve();
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
      });
    };

    /**
     * May this frame be POSTed again rather than dropped?
     *
     * `true` only when the frame's own kind is in `IDEMPOTENT_READ_FRAMES` AND its
     * re-send budget is unspent. Everything else keeps the drop-once behaviour,
     * which is what a write frame requires.
     */
    const mayResend = (queued: QueuedFrame): boolean => {
      if (queued.attempts >= READ_RETRY_DELAYS_MS.length) return false;
      const { type } = innermostFrame(queued.data);
      return type !== null && IDEMPOTENT_READ_FRAMES.has(type);
    };

    /**
     * One POST.
     *
     * Returns the verdict the caller's retry rules need. `gone` means the server
     * no longer knows this connection — the transport must tear down instead of
     * retrying anything.
     */
    const postFrame = async (
      queued: QueuedFrame,
    ): Promise<{ kind: "ok" | "lost" | "server_error" | "gone"; status: number }> => {
      if (connectionId === null) return { kind: "lost", status: 0 };
      let status = 0;
      try {
        const res = await fetchImpl(
          `${baseUrl}${framePath}?id=${encodeURIComponent(connectionId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: queued.data,
            /* Same-origin cookies must ride along for the remote-password case. */
            credentials: "same-origin",
          },
        );
        status = res.status;
      } catch {
        return { kind: "lost", status: 0 };
      }
      if (status === 409 || status === 404) return { kind: "gone", status };
      if (status >= 500) return { kind: "server_error", status };
      return { kind: "ok", status };
    };

    /** Tear the transport down: the server does not know this connection. */
    const teardownGone = (status: number): void => {
      emit("error", { type: "transport_gone", status });
      closed = true;
      source.close();
      serialOutbox.length = 0;
      historyOutbox.length = 0;
      preIdOutbox.length = 0;
      if (pendingWrite !== null) {
        const current = pendingWrite;
        pendingWrite = null;
        if (current.timer !== null) clearTimeout(current.timer);
        emitBarrier({ epoch: current.epoch, cleared: true, uncertain: true });
      }
      emit("close", {});
    };

    /**
     * Open the write barrier, then wait for in-flight history POSTs.
     *
     * The EPOCH is bumped before anything is awaited: the application layer must
     * learn that every history read which started before this moment is
     * pre-write, and it must learn it now — not after the POST completes.
     */
    const beginWriteBarrier = async (frame: QueuedFrame): Promise<void> => {
      // A previous write's ACK timer must not survive into this barrier: it would
      // clear THIS barrier early and let a read run between two writes.
      if (pendingWrite !== null && pendingWrite.timer !== null) clearTimeout(pendingWrite.timer);
      epoch += 1;
      pendingWrite = { id: frame.requestId, epoch, timer: null };
      emitBarrier({ epoch, cleared: false });
      await drainHistoryPosts();
    };

    /** The write POST returned: now wait for its BUSINESS answer, not its 204. */
    const awaitWriteAnswer = (frame: QueuedFrame): void => {
      if (pendingWrite === null) return;
      if (frame.requestId === null || pendingWrite.id !== frame.requestId) {
        // Nothing in the envelope could correlate an answer: treat the write as
        // settled so history reading is not blocked on an unobservable edge.
        clearWriteBarrier(true);
        return;
      }
      pendingWrite.timer = setTimeout(() => {
        // No business answer: the write is UNCERTAIN. Reopen the lane (an
        // uncertain write must not freeze reading forever) but never replay it.
        clearWriteBarrier(true);
      }, WRITE_ACK_TIMEOUT_MS);
    };

    /** Serial lane: every write and every non-history frame, one POST at a time. */
    const pumpSerial = async (): Promise<void> => {
      if (pumpingSerial) return;
      pumpingSerial = true;
      try {
        while (serialOutbox.length > 0 && !closed) {
          /* Cannot POST without an id: the server has no stream to write to. */
          if (connectionId === null) return;
          const queued = serialOutbox[0] as QueuedFrame;
          if (queued.write) {
            await beginWriteBarrier(queued);
            if (closed) return;
          }
          const head = serialOutbox.shift() as QueuedFrame;
          const verdict = await postFrame(head);

          if (verdict.kind === "gone") {
            teardownGone(verdict.status);
            return;
          }
          /*
           * The two shapes a lost frame takes here: the request never produced a
           * status (`lost` — the proxy reset a connection it had already reaped),
           * or the hop in front of the server refused it (5xx — measured as a 502
           * carrying the proxy's own `Keep-Alive: timeout=4` and no `Date`, which
           * the Node server never sends).
           */
          if (verdict.kind === "lost" || verdict.kind === "server_error") {
            if (mayResend(head)) {
              /* Head of the queue, not the tail: order is this transport's contract. */
              const wait = READ_RETRY_DELAYS_MS[head.attempts];
              head.attempts += 1;
              serialOutbox.unshift(head);
              await delay(wait);
              continue;
            }
            /*
             * Out of budget, or not a kind that may be re-sent.
             *
             * A WRITE that never reached the host stays silent, exactly as before —
             * but it is a DEFINITE terminal for the barrier: nothing will answer it,
             * so history reading must not stay closed. It is never replayed.
             */
            if (verdict.kind === "server_error") {
              /* Server-side fault: surfaced for reads AND writes — a write the
               * hop refused is a real failure the user must be able to see. It is
               * still never replayed. */
              emit("error", { type: "post_failed", status: verdict.status });
            }
            if (head.write) clearWriteBarrier(true);
            continue;
          }
          if (head.write) awaitWriteAnswer(head);
        }
      } finally {
        pumpingSerial = false;
      }
    };

    /** History lane: at most 2 POSTs, foreground before prefetch. */
    const pumpHistory = async (): Promise<void> => {
      if (pumpingHistory) return;
      pumpingHistory = true;
      try {
        while (!closed && historyOutbox.length > 0 && connectionId !== null) {
          if (pendingWrite !== null) break;
          if (historyActive >= HISTORY_MAX_CONCURRENT_POSTS) break;
          historyOutbox.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
          const queued = historyOutbox.shift() as QueuedFrame;
          historyActive += 1;
          void runHistoryPost(queued);
        }
      } finally {
        pumpingHistory = false;
      }
    };

    /** One history POST, including its bounded re-send budget. */
    const runHistoryPost = async (queued: QueuedFrame): Promise<void> => {
      try {
        for (;;) {
          const verdict = await postFrame(queued);
          if (verdict.kind === "gone") {
            teardownGone(verdict.status);
            return;
          }
          if (verdict.kind === "ok") return;
          if (mayResend(queued)) {
            const wait = READ_RETRY_DELAYS_MS[queued.attempts];
            queued.attempts += 1;
            // Re-send budget spent in place: the lane re-sorts by priority, so a
            // re-sent foreground read still runs before any prefetch.
            await delay(wait);
            continue;
          }
          if (verdict.kind === "server_error") {
            emit("error", { type: "post_failed", status: verdict.status });
          }
          return;
        }
      } finally {
        historyActive -= 1;
        releaseDrainWaiters();
        void pumpHistory();
      }
    };

    return {
      protocol: "sse",
      send(data: string): void {
        if (closed) return;
        const identity = innermostFrame(data);
        const frame: QueuedFrame = {
          data,
          attempts: 0,
          lane: "serial",
          priority: 1,
          seq: (sequence += 1),
          requestId: identity.id,
          write: identity.type === null || !IDEMPOTENT_READ_FRAMES.has(identity.type),
        };
        /* Unreachable once `open` waits for the id, but a frame must never be dropped if it ever races. */
        if (connectionId === null) {
          preIdOutbox.push(frame);
          return;
        }
        publish(frame);
        void pumpSerial();
      },
      /**
       * Queue one HOST-NATIVE HISTORY READ in the independent lane.
       *
       * The lane assignment is re-checked here rather than trusted: a caller that
       * passes a non-history frame gets the serial lane, so this method can never
       * become a way to run a write out of order.
       */
      sendPrioritized(data: string, priority: "foreground" | "prefetch"): void {
        if (closed) return;
        const identity = innermostFrame(data);
        const historyRead = identity.type !== null && HISTORY_READ_FRAMES.has(identity.type);
        const frame: QueuedFrame = {
          data,
          attempts: 0,
          lane: historyRead ? "history" : "serial",
          priority: priority === "foreground" ? 0 : 1,
          seq: (sequence += 1),
          requestId: identity.id,
          write: !historyRead,
        };
        if (connectionId === null) {
          preIdOutbox.push(frame);
          return;
        }
        publish(frame);
        if (historyRead) void pumpHistory();
        else void pumpSerial();
      },
      reprioritize(requestId: string, priority: "foreground" | "prefetch"): boolean {
        let found = false;
        for (const frame of historyOutbox) {
          if (frame.requestId !== requestId) continue;
          frame.priority = priority === "foreground" ? 0 : 1;
          found = true;
        }
        if (found) void pumpHistory();
        return found;
      },
      onHistoryBarrier(listener: (event: HistoryBarrierEvent) => void): () => void {
        barrierListeners.add(listener);
        return () => barrierListeners.delete(listener);
      },
      close(): void {
        if (closed) return;
        closed = true;
        source.close();
        if (pendingWrite !== null) {
          const current = pendingWrite;
          pendingWrite = null;
          if (current.timer !== null) clearTimeout(current.timer);
        }
        serialOutbox.length = 0;
        historyOutbox.length = 0;
        preIdOutbox.length = 0;
        releaseDrainWaiters();
        emit("close", {});
      },
      addEventListener(type: SocketEventType, listener: (event: unknown) => void): void {
        listeners[type].add(listener);
      },
      removeEventListener(type: SocketEventType, listener: (event: unknown) => void): void {
        listeners[type].delete(listener);
      },
    };
  };
}

/**
 * Extract the room from the URL the client would have dialled.
 *
 * The WebSocket client encodes the room in the query or the path depending on
 * the relay form. `null` means "no room", and the endpoints are then called
 * without a query, which the server treats as the host room.
 *
 * @param url - the `ws(s)://` URL the client asked for.
 * @returns the room segment, or `null` when the URL carries none.
 */
function roomFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const fromQuery = parsed.searchParams.get("room");
    if (fromQuery !== null && fromQuery !== "") return fromQuery;
    const path = parsed.pathname.replace(/^\/+/, "");
    return path === "" ? null : path;
  } catch {
    return null;
  }
}
