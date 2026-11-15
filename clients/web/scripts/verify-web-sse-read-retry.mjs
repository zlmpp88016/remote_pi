/**
 * Verify the SSE transport's ONE retry rule: a lost READ is re-sent, a lost WRITE
 * is not.
 *
 * ## Why this gate exists
 *
 * The transport's POST crosses the public lane's HTTP proxy, whose idle-connection
 * reclaim is ~4 s. The first POST after a quiet moment therefore reuses a socket
 * the proxy has already reaped and comes back as a proxy-generated 502 — measured:
 * no `Date`, no `content-type`, `Keep-Alive: timeout=4` (the Node server reaps at
 * 5 s and always sends `Date`). One dropped `session_read` used to strand the
 * read-only viewer on `Reading this session…` until `CHAT_TIMEOUT_MS` (600 s),
 * because `pump()` dropped every failed frame and kept the stream open.
 *
 * The fix re-sends a small ALLOW-LIST of read frames. That list is the whole
 * safety argument, so both halves are asserted here:
 *
 *   - a `session_read` / `session_list` / `session_sync` whose POST fails (5xx or
 *     a network reject) is re-sent, byte-identically — same envelope, therefore
 *     the same request id, so a reply to the first attempt still correlates;
 *   - a `user_message` (and every other write) is NOT re-sent, under either
 *     failure shape: the first POST may already have run the turn, and a
 *     duplicated chat message is worse than the timeout the UI explains.
 *
 * It also pins the properties that must survive the change: the budget is
 * bounded, order is preserved, and 409/404 still tears the transport down.
 *
 * Everything runs against fake I/O through the transport's own injected seams
 * (`eventSourceFactory` / `fetchImpl`), so there is no relay, no server and no
 * browser in the loop.
 *
 * Run: node scripts/verify-web-sse-read-retry.mjs
 */

import { encodeCt, encodeOuter, decodeOuter } from "../src/lib/remote-pi/protocol.ts";
import { createSseWebSocketFactory } from "../src/lib/remote-pi/sse-transport.ts";

const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const ROOM = "ws-room";

let checks = 0;
const failures = [];

/**
 * Record one assertion.
 *
 * @param label - what was checked.
 * @param ok - whether it held.
 * @param detail - observed value, shown only on failure.
 */
function check(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(`${label}${detail ? ` :: ${detail}` : ""}`);
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `fn()` holds, or give up (the assertion then reports the truth). */
async function until(fn, ms = 2000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) return false;
    await sleep(10);
  }
  return true;
}

/**
 * The slice of `EventSource` the transport uses, as a controllable fake.
 *
 * The connection id arrives as a NAMED `endpoint` event, exactly as the real
 * stream delivers it — the transport only emits `open` after that id exists, so
 * the fake has to be able to produce it before anything can be POSTed.
 */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.named = new Map();
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
  }

  addEventListener(type, listener) {
    this.named.set(type, [...(this.named.get(type) ?? []), listener]);
  }

  removeEventListener(type, listener) {
    this.named.set(type, (this.named.get(type) ?? []).filter((l) => l !== listener));
  }

  close() {
    this.closed = true;
  }

  /** Deliver the stream's FIRST event: the id every POST must quote. */
  endpoint(id) {
    for (const listener of this.named.get("endpoint") ?? []) {
      listener({ data: JSON.stringify({ id }) });
    }
  }
}

/**
 * One transport over fake I/O, already open.
 *
 * @param respond - `(callIndex) => number | "network_error"`: the verdict for the
 *                  nth POST.
 */
function openTransport(respond) {
  const posts = [];
  const errors = [];
  let closes = 0;
  let source = null;

  const factory = createSseWebSocketFactory({
    baseUrl: "http://origin.test",
    eventSourceFactory: (url) => {
      source = new FakeEventSource(url);
      return source;
    },
    fetchImpl: async (url, init) => {
      const index = posts.length;
      posts.push({ url, body: init.body, at: Date.now() });
      const verdict = respond(index);
      if (verdict === "network_error") throw new TypeError("Failed to fetch");
      return { status: verdict };
    },
  });

  const socket = factory(`ws://origin.test/${ROOM}`, []);
  socket.addEventListener("error", (event) => errors.push(event));
  socket.addEventListener("close", () => {
    closes += 1;
  });
  source.endpoint("stream-1");
  return { socket, posts, errors, source: () => source, closeCount: () => closes };
}

/** `session_read`, enveloped exactly as `client.ts` sends it. */
const readFrame = (id = "r1") =>
  encodeOuter(HOST_EPK, "host", {
    type: "host_forward",
    id: `f-${id}`,
    room: ROOM,
    ct: encodeCt({ type: "session_read", id, session_id: "session-1", limit: 50 }),
  });

/** Same envelope shape, but a frame that CHANGES host state. */
const writeFrame = (id = "w1") =>
  encodeOuter(HOST_EPK, "host", {
    type: "host_forward",
    id: `f-${id}`,
    room: ROOM,
    ct: encodeCt({ type: "user_message", id, text: "hello" }),
  });

/** Any other proxied read kind, to prove the allow-list is a set, not one case. */
const proxiedFrame = (type) =>
  encodeOuter(HOST_EPK, "host", {
    type: "host_forward",
    id: `f-${type}`,
    room: ROOM,
    ct: encodeCt({ type, id: `${type}-id` }),
  });

/**
 * Which frame a POST body carried, read the way the transport reads it.
 *
 * The body is an ENVELOPE whose `ct` is base64, so the kind is not greppable in
 * the raw string — it has to be decoded, exactly as `innermostFrameType` does.
 *
 * @param body - the POST body recorded by the fake fetch.
 * @returns the frame's own inner `type`, or null when it cannot be decoded.
 */
function frameTypeOf(body) {
  try {
    return decodeOuter(body).inner?.ct === undefined
      ? null
      : JSON.parse(Buffer.from(decodeOuter(body).inner.ct, "base64").toString("utf8")).type;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- the fix -- */

async function readIsResentAfter5xx() {
  console.log("\nA. a lost READ is re-sent (the 502 the proxy produces)");
  const t = openTransport((i) => (i === 0 ? 502 : 204));
  t.socket.send(readFrame());
  const resent = await until(() => t.posts.length >= 2);

  check("the read is POSTed twice (once re-sent)", resent && t.posts.length === 2, `posts=${t.posts.length}`);
  check(
    "the re-send is BYTE-IDENTICAL — same envelope, so the same request id",
    t.posts[1]?.body === t.posts[0]?.body,
  );
  check("the re-send lands on the same endpoint id", t.posts[1]?.url === t.posts[0]?.url);
  check("no `post_failed` is emitted once the re-send landed", t.errors.length === 0, JSON.stringify(t.errors));
  check("the stream stays open", t.source().closed === false && t.closeCount() === 0);
}

async function readIsResentAfterNetworkError() {
  console.log("\nB. a read whose POST rejects (no status at all) is re-sent too");
  const t = openTransport((i) => (i === 0 ? "network_error" : 204));
  t.socket.send(readFrame());
  const resent = await until(() => t.posts.length >= 2);

  check("the read is re-sent after a network reject", resent && t.posts.length === 2, `posts=${t.posts.length}`);
  check("no error is surfaced for a read that recovered", t.errors.length === 0, JSON.stringify(t.errors));
}

async function everyReadKindIsReSent() {
  console.log("\nC. the allow-list is a SET of reads, not one hardcoded kind");
  for (const type of ["session_read", "session_list", "session_sync"]) {
    const t = openTransport((i) => (i === 0 ? 502 : 204));
    t.socket.send(proxiedFrame(type));
    const resent = await until(() => t.posts.length >= 2);
    check(`${type} is re-sent`, resent && t.posts.length === 2, `posts=${t.posts.length}`);
  }
}

/* --------------------------------------------------- the safety argument -- */

async function writeIsNeverResent() {
  console.log("\nD. a lost WRITE is dropped exactly as before (no duplicate side effect)");
  const fiveXx = openTransport(() => 502);
  fiveXx.socket.send(writeFrame());
  await sleep(800);
  check("`user_message` is POSTed ONCE after a 502", fiveXx.posts.length === 1, `posts=${fiveXx.posts.length}`);
  check(
    "the write failure is still surfaced as `post_failed`",
    fiveXx.errors.length === 1 && fiveXx.errors[0]?.type === "post_failed" && fiveXx.errors[0]?.status === 502,
    JSON.stringify(fiveXx.errors),
  );
  check("the stream stays open after a write failure", fiveXx.source().closed === false && fiveXx.closeCount() === 0);

  const network = openTransport(() => "network_error");
  network.socket.send(writeFrame());
  await sleep(800);
  check("`user_message` is NOT re-sent after a network reject", network.posts.length === 1, `posts=${network.posts.length}`);
  check(
    "a write that vanished stays silent (unchanged behaviour)",
    network.errors.length === 0 && network.closeCount() === 0,
    JSON.stringify(network.errors),
  );
}

async function unreadableFrameIsNotResent() {
  console.log("\nE. a frame whose kind cannot be read FAILS CLOSED");
  const t = openTransport((i) => (i === 0 ? "network_error" : 204));
  t.socket.send("not-an-envelope");
  await sleep(800);
  check("an unparsable frame is not re-sent", t.posts.length === 1, `posts=${t.posts.length}`);
}

async function budgetIsBounded() {
  console.log("\nF. the re-send budget is small and bounded");
  const t0 = Date.now();
  const t = openTransport(() => 502);
  t.socket.send(readFrame());
  await until(() => t.errors.length > 0, 4000);
  const elapsed = Date.now() - t0;

  check("a permanently failing read stops after 1 + 3 attempts", t.posts.length === 4, `posts=${t.posts.length}`);
  check(
    "the exhausted budget surfaces ONE `post_failed`",
    t.errors.length === 1 && t.errors[0]?.type === "post_failed",
    JSON.stringify(t.errors),
  );
  check("the stream stays open when the budget is spent", t.source().closed === false && t.closeCount() === 0);
  check("the whole budget costs well under two seconds of waiting", elapsed < 2500, `${elapsed}ms`);
}

async function orderIsPreserved() {
  console.log("\nG. a re-sent frame goes back to the HEAD of the queue");
  const t = openTransport((i) => (i === 0 ? 502 : 204));
  t.socket.send(readFrame("r1"));
  t.socket.send(writeFrame("w1"));
  await until(() => t.posts.length >= 3);
  const order = t.posts.map((p) => frameTypeOf(p.body));
  check(
    "the read keeps its place ahead of the write",
    JSON.stringify(order) === '["session_read","session_read","user_message"]',
    JSON.stringify(order),
  );
}

async function staleConnectionStillTearsDown() {
  console.log("\nH. 409/404 still tears the transport down (unchanged)");
  const t = openTransport(() => 409);
  t.socket.send(readFrame());
  await until(() => t.closeCount() > 0, 2000);
  check("a 409 is not re-sent", t.posts.length === 1, `posts=${t.posts.length}`);
  check("`transport_gone` is reported", t.errors.some((e) => e?.type === "transport_gone" && e?.status === 409));
  check("the socket is closed so the client reconnects", t.source().closed === true && t.closeCount() === 1);
}

/* ------------------------------------------------------------------ main -- */

console.log("verify-web-sse-read-retry — reads are re-sent, writes are not");
await readIsResentAfter5xx();
await readIsResentAfterNetworkError();
await everyReadKindIsReSent();
await writeIsNeverResent();
await unreadableFrameIsNotResent();
await budgetIsBounded();
await orderIsPreserved();
await staleConnectionStillTearsDown();

console.log(`\n${checks - failures.length}/${checks} checks PASS`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-sse-read-retry: OK");
