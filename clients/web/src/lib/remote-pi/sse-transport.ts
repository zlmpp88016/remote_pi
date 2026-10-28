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
 */

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
): (url: string, protocols: string[]) => SocketLike {
  const eventsPath = options.eventsPath ?? "/api/events";
  const framePath = options.framePath ?? "/api/frame";
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const makeSource =
    options.eventSourceFactory ??
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);

  return (url: string): SocketLike => {
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
    let closed = false;
    /** Outbound frames awaiting the in-flight POST, in order. */
    const outbox: string[] = [];
    let pumping = false;

    const emit = (type: SocketEventType, event: unknown): void => {
      for (const listener of listeners[type]) listener(event);
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
    const preIdOutbox: string[] = [];

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
        outbox.push(preIdOutbox.shift() as string);
      }
      void pump();
    });

    source.onmessage = (event) => {
      if (closed) return;
      /*
       * `data` reaches the client as the raw frame string. A comment/heartbeat
       * line never becomes a `message` event, so nothing needs filtering:
       * `EventSource` already discards it.
       */
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

    /** Drain the outbox in order, one POST at a time. */
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (outbox.length > 0 && !closed) {
          /* Cannot POST without an id: the server has no stream to write to. */
          if (connectionId === null) return;
          const frame = outbox.shift() as string;
          let status = 0;
          try {
            const res = await fetchImpl(
              `${baseUrl}${framePath}?id=${encodeURIComponent(connectionId)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: frame,
                /* Same-origin cookies must ride along for the remote-password case. */
                credentials: "same-origin",
              },
            );
            status = res.status;
          } catch {
            /*
             * A network failure is DROPPED, not retried: every frame in this
             * protocol either carries a request id the caller times out on, or is
             * a push the host re-sends after a re-sync. Retrying blindly would
             * duplicate a chat message, far worse than a timeout the UI explains.
             */
            continue;
          }

          /*
           * `fetch` only rejects on a NETWORK failure — a 4xx/5xx resolves
           * normally. Ignoring the status meant a stale connection id was
           * discovered by nobody: the server answered `409 no such connection`,
           * the frame was dropped, and the user's message vanished with the UI
           * still looking healthy. That is the laptop-sleep scenario, where the
           * session TTL expires while the tab is suspended.
           *
           * The fix is to tear the transport down so the client's own reconnect
           * path runs (and re-hydrates) instead of pretending the frame landed.
           */
          if (status === 409 || status === 404) {
            /*
             * Tearing down is the only honest move: the server no longer knows
             * this connection, so every further frame would be refused too. An
             * `error` event lets the client surface it; `close` drives its
             * reconnect path, which re-hydrates from scratch.
             */
            emit("error", { type: "transport_gone", status });
            closed = true;
            source.close();
            outbox.length = 0;
            preIdOutbox.length = 0;
            emit("close", {});
            return;
          }
          if (status >= 500) {
            /* Server-side fault: surface it, but keep the stream open. */
            emit("error", { type: "post_failed", status });
          }
        }
      } finally {
        pumping = false;
      }
    };

    return {
      protocol: "sse",
      send(data: string): void {
        if (closed) return;
        /* Unreachable once `open` waits for the id, but a frame must never be dropped if it ever races. */
        if (connectionId === null) {
          preIdOutbox.push(data);
          return;
        }
        outbox.push(data);
        void pump();
      },
      close(): void {
        if (closed) return;
        closed = true;
        source.close();
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
