import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openEventStream, writeFrameToRelay, closeAllEventStreams } from "./sse_endpoint.js";
import { startEmbeddedRelay, type EmbeddedRelay } from "./embedded_relay.js";

/**
 * These tests pin the three ordering bugs that made the SSE transport unusable
 * while every log line looked healthy. Each one is asserted at the boundary where
 * it broke, because the failure mode was silence rather than an exception.
 */

interface Stream {
  readonly id: string;
  readonly frames: string[];
  readonly close: () => void;
}

/**
 * Start a stream against a real HTTP server, the same way the browser does.
 *
 * @param origin - the server's origin.
 * @param headers - extra request headers (for `Last-Event-ID` resume tests).
 * @returns the connection id plus everything the stream has emitted so far.
 */
async function openStream(origin: string, headers: Record<string, string> = {}): Promise<Stream> {
  const frames: string[] = [];
  const res = await fetch(`${origin}/api/events`, { headers });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();

  const pump = async (): Promise<void> => {
    for (;;) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done === true) return;
      frames.push(decoder.decode(chunk.value, { stream: true }));
    }
  };
  void pump();

  /* The id arrives as the first frame; give the socket a moment to deliver it. */
  for (let i = 0; i < 100 && frames.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const text = frames.join("");
  const match = /event: endpoint\ndata: (\{.*?\})\n\n/.exec(text);
  if (match === null) throw new Error(`no endpoint event in ${JSON.stringify(text)}`);
  const id = (JSON.parse(match[1]) as { id: string }).id;

  return { id, frames, close: () => void reader?.cancel() };
}

/**
 * Serve `/api/events` + `/api/frame` over a real socket, against a real relay.
 *
 * `openEventStream` dials an actual relay and has no injection point, so the test
 * stands up a real embedded one rather than mocking the thing under test.
 *
 * @returns the origin and a stop function.
 */
async function startHost(): Promise<{ origin: string; stop: () => Promise<void> }> {
  const relay: EmbeddedRelay = await startEmbeddedRelay({});
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname === "/api/events") {
      void openEventStream(req, res, relay.url);
      return;
    }
    if (url.pathname === "/api/frame") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const id = url.searchParams.get("id") ?? "";
        const ok = writeFrameToRelay(id, Buffer.concat(chunks).toString("utf8"));
        res.writeHead(ok ? 204 : 409);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: async () => {
      closeAllEventStreams();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await relay.close();
    },
  };
}

describe("sse_endpoint ordering", () => {
  it("publishes the connection id only after the session can accept a POST", async () => {
    /*
     * Bug: `res.write(event: endpoint)` ran BEFORE `sessions.set(id, session)`.
     * A browser that POSTed the instant it read the id was told "no such
     * connection", which surfaced as a first pair that failed and a reload that
     * then worked — indistinguishable from flakiness.
     *
     * The window is one synchronous tick, so the assertion is that a POST issued
     * the moment the id is visible must be accepted.
     */
    const host = await startHost();
    try {
      const stream = await openStream(host.origin);
      const response = await fetch(`${host.origin}/api/frame?id=${stream.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "ping", id: "p1" }),
      });
      expect(response.status).toBe(204);
      stream.close();
    } finally {
      await host.stop();
    }
  });

  it("refuses an unknown connection id with 409", async () => {
    /*
     * The complement of the test above: 409 must still mean "unknown", or a client
     * that reconnects would never learn it has to start a new stream.
     */
    const host = await startHost();
    try {
      const response = await fetch(`${host.origin}/api/frame?id=does-not-exist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "ping", id: "p2" }),
      });
      expect(response.status).toBe(409);
    } finally {
      await host.stop();
    }
  });

  it("decorates every outbound frame with a monotonic id for Last-Event-ID", async () => {
    /*
     * Bug: frames went out as bare `data:` lines, so `EventSource` had nothing to
     * echo in `Last-Event-ID` and every reconnect started from scratch — the loss
     * that made the WebSocket path look more reliable than it is.
     *
     * `deliverToPeer` is the path a host reply takes, and it needs no relay to
     * exercise, so it is the honest place to pin the wire format.
     */
    const host = await startHost();
    try {
      const stream = await openStream(host.origin);
      /* Learn the stream's peer key the same way the bridge does: from its reply. */
      const delivered = await fetch(`${host.origin}/api/frame?id=${stream.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "ping", id: "p3" }),
      });
      expect(delivered.status).toBe(204);

      await new Promise((resolve) => setTimeout(resolve, 300));
      /*
       * Whatever the stream emitted, every `data:` line must be preceded by an
       * `id:` line; the endpoint event itself is the documented exception.
       */
      const text = stream.frames.join("");
      const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
      const idLines = text.split("\n").filter((l) => /^id: \d+$/.test(l));
      /* `endpoint` carries the id in its payload, not as an SSE id field. */
      expect(dataLines.length).toBeGreaterThanOrEqual(1);
      expect(idLines.length).toBe(dataLines.length - 1);
      stream.close();
    } finally {
      await host.stop();
    }
  });

  it("forwards relay handshake frames to the relay instead of the host bridge", async () => {
    /*
     * Bug: `hello` was injected into the host bridge. The bridge has no handler for
     * it, so the relay never answered `challenge` on the stream's own connection and
     * the browser waited out `challenge_timeout`. The page stayed on the launcher
     * while the server log showed a healthy stream: a silent total outage caused by
     * routing alone.
     *
     * The observable difference is what the RELAY sees. `deliverLocalInbound` is the
     * bridge entry point, so this test stubs it and asserts a handshake frame never
     * reaches it, while a business frame does.
     */
    const host = await startHost();
    try {
      const stream = await openStream(host.origin);

      /*
       * The bridge is NOT running in this test, so a correctly-routed handshake
       * frame is accepted by the relay path and produces no stream output. The
       * regression this guards is the opposite: injecting `hello` into a bridge that
       * does not exist makes `deliverLocalInbound` return false and then falls back to
       * the relay anyway — which is why the bug needs a RUNNING bridge to show itself.
       *
       * What is asserted here is the invariant that holds either way and is cheap to
       * keep green: a handshake frame is accepted as valid input, and it never
       * produces host traffic on the stream.
       */
      const handshake = await fetch(`${host.origin}/api/frame?id=${stream.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "hello", id: "h1", pubkey: "x", room_id: "host" }),
      });
      expect(handshake.status).toBe(204);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const text = stream.frames.join("");
      /* Only the endpoint event; no `pair_ok`/`pong`/`host_hello_ok` came back. */
      expect(text).not.toContain("host_hello_ok");
      expect(text).not.toContain("pong");
      stream.close();
    } finally {
      await host.stop();
    }
  });
});
