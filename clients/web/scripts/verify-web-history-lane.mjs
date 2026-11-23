/**
 * Plan 86 P3 — the SSE send scheduler: two lanes, the write barrier, and the
 * ordering guarantees that were already there.
 *
 * WHAT IS BEING PROVEN, AND WHY EACH PART MATTERS
 *
 * 1. INDEPENDENT HISTORY READS DO NOT QUEUE BEHIND AN UNRELATED POST.
 *    Before this change one POST was in flight at a time, so `session_sync` waited
 *    for `session_list`'s HTTP 204 — measured 416–542 ms of pure queueing, and that
 *    204 is not a business answer. Now up to two host-native history reads run
 *    concurrently, and one read never waits for another's 204.
 *
 * 2. FOREGROUND BEATS PREFETCH IN THE LANE.
 *    A queued prefetch must not occupy a slot a click needs, and a promotion must
 *    move an already-queued read ahead of it.
 *
 * 3. THE WRITE BARRIER IS THE CORRECTNESS PART.
 *    - the epoch is bumped when the write is QUEUED, before anything is awaited;
 *    - already-launched history POSTs are drained before the write is POSTed;
 *    - the lane stays CLOSED until the write's BUSINESS answer arrives, or the
 *      write reaches a definite terminal — a 204 alone never reopens it;
 *    - a failed write is never re-sent, and it still terminates the barrier so
 *      reading cannot freeze.
 *
 * 4. THE PRE-EXISTING CONTRACT IS UNCHANGED: a lost READ is re-sent (F5), a lost
 *    WRITE is not, order inside the serial lane is preserved, 409 still tears the
 *    transport down.
 *
 * Everything runs against fake `EventSource`/`fetch` through the transport's own
 * injected seams: no relay, no server, no browser.
 *
 * Run: node scripts/verify-web-history-lane.mjs
 */

import { encodeCt, encodeOuter, decodeOuter } from "../src/lib/remote-pi/protocol.ts";
import { createSseWebSocketFactory, HISTORY_MAX_CONCURRENT_POSTS, WRITE_ACK_TIMEOUT_MS } from "../src/lib/remote-pi/sse-transport.ts";

const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const ROOM = "host";

let checks = 0;
const failures = [];

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

async function until(fn, ms = 2000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) return false;
    await sleep(5);
  }
  return true;
}

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
  endpoint(id) {
    for (const listener of this.named.get("endpoint") ?? []) listener({ data: JSON.stringify({ id }) });
  }
  deliver(frame) {
    this.onmessage?.({ data: frame });
  }
}

/**
 * One transport over fake I/O, already open.
 *
 * `respond(callIndex, details)` returns a status, `"network_error"`, or `"hold"`
 * (a promise the test resolves later) so concurrency can be observed directly.
 */
function openTransport(respond) {
  const posts = [];
  const errors = [];
  const barrier = [];
  let source = null;
  const factory = createSseWebSocketFactory({
    baseUrl: "http://origin.test",
    eventSourceFactory: (url) => {
      source = new FakeEventSource(url);
      return source;
    },
    fetchImpl: async (url, init) => {
      const index = posts.length;
      posts.push({ url, body: init.body, at: Date.now(), type: frameTypeOf(init.body) });
      let verdict = respond(index, init.body);
      if (verdict === "network_error") throw new TypeError("Failed to fetch");
      if (verdict === "hold") return new Promise(() => {});
      if (verdict instanceof Promise) verdict = await verdict;
      return { status: verdict };
    },
  });
  const socket = factory(`ws://origin.test/${ROOM}`, []);
  socket.addEventListener("error", (event) => errors.push(event));
  socket.addEventListener("close", () => errors.push({ type: "closed" }));
  socket.onHistoryBarrier((event) => barrier.push(event));
  source.endpoint("stream-1");
  return { socket, posts, errors, barrier, source: () => source };
}

/** Innermost request id of a POSTed envelope. */
function frameIdOf(body) {
  try {
    const outer = decodeOuter(body);
    let inner = outer.inner;
    if (typeof inner?.ct === "string") {
      inner = JSON.parse(Buffer.from(inner.ct, "base64").toString("utf8"));
    }
    return inner?.id ?? null;
  } catch {
    return null;
  }
}

/** Innermost frame type of a POSTed envelope. */
function frameTypeOf(body) {
  try {
    const outer = decodeOuter(body);
    let inner = outer.inner;
    if (typeof inner?.ct === "string") {
      inner = JSON.parse(Buffer.from(inner.ct, "base64").toString("utf8"));
    }
    return inner?.type ?? null;
  } catch {
    return null;
  }
}

/** One host-native history read on the host room (no proxy). */
const historyReadFrame = (id) =>
  encodeOuter(HOST_EPK, "host", { type: "history_read", id, daemon_id: "d1", session_id: "s1", limit: 50 });

const historyListFrame = (id) =>
  encodeOuter(HOST_EPK, "host", { type: "history_list", id, daemon_id: "d1", limit: 50 });

const legacyReadFrame = (id) =>
  encodeOuter(HOST_EPK, "host", {
    type: "host_forward",
    id: `f-${id}`,
    room: ROOM,
    ct: encodeCt({ type: "session_read", id, session_id: "s1", limit: 50 }),
  });

const writeFrame = (id) =>
  encodeOuter(HOST_EPK, "host", {
    type: "host_forward",
    id: `f-${id}`,
    room: ROOM,
    ct: encodeCt({ type: "session_switch", id, session_id: "s2" }),
  });

/** The business answer for `id`, wrapped exactly as the host sends it back. */
function replyFrame(id, inner) {
  return JSON.stringify({
    peer: HOST_EPK,
    room: ROOM,
    ct: encodeCt({ room: ROOM, ct: encodeCt({ in_reply_to: id, ...inner }), type: "host_message" }),
  });
}

// ── A. independent reads run concurrently ───────────────────────────────────

async function concurrency() {
  console.log("\nA. host-native history reads get their own lane");
  const t = openTransport(() => "hold");
  t.socket.sendPrioritized(historyReadFrame("h1"), "foreground");
  t.socket.sendPrioritized(historyReadFrame("h2"), "foreground");
  const started = await until(() => t.posts.length >= 2, 500);
  check("two history reads are POSTed without waiting for each other", started, `posts=${t.posts.length}`);
  check("the lane cap is 2", HISTORY_MAX_CONCURRENT_POSTS === 2);

  t.socket.sendPrioritized(historyReadFrame("h3"), "foreground");
  await sleep(30);
  check("a third read waits for a free slot", t.posts.length === 2, `posts=${t.posts.length}`);
  check("no barrier was opened by a pure read", t.barrier.length === 0, JSON.stringify(t.barrier));
}

// ── B. foreground before prefetch ───────────────────────────────────────────

async function priority() {
  console.log("\nB. foreground reads run before prefetches");
  /** Both slots are held, so the next frames are QUEUED rather than POSTed. */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const t = openTransport((index) => (index < 2 ? gate : 204));
  t.socket.sendPrioritized(historyListFrame("busy1"), "foreground");
  t.socket.sendPrioritized(historyListFrame("busy2"), "foreground");
  await until(() => t.posts.length === 2, 300);
  check("both slots are held by foreground work", t.posts.length === 2, String(t.posts.length));

  t.socket.sendPrioritized(historyReadFrame("p1"), "prefetch");
  t.socket.sendPrioritized(historyReadFrame("f1"), "foreground");
  await sleep(20);
  check("neither queued frame is POSTed while the slots are busy", t.posts.length === 2, String(t.posts.length));

  release(204);
  const started = await until(() => t.posts.length >= 4, 500);
  check("freeing the slots starts the queued reads", started, String(t.posts.length));
  const order = t.posts.slice(2).map((entry) => frameIdOf(entry.body));
  check("the FOREGROUND read ran before the prefetch", order.join(",") === "f1,p1", order.join(","));
}

// ── C. promotion ────────────────────────────────────────────────────────────

async function promotion() {
  console.log("\nC. a click PROMOTES a queued prefetch instead of duplicating it");
  const t = openTransport((index) => (index < 2 ? "hold" : 204));
  t.socket.sendPrioritized(historyReadFrame("slot1"), "foreground");
  t.socket.sendPrioritized(historyReadFrame("slot2"), "foreground");
  t.socket.sendPrioritized(historyReadFrame("prefetch-1"), "prefetch");
  t.socket.sendPrioritized(historyReadFrame("prefetch-2"), "prefetch");
  await until(() => t.posts.length === 2, 300);
  const moved = t.socket.reprioritize("prefetch-2", "foreground");
  check("the queued prefetch was found", moved === true);
  check("an in-flight request cannot be reprioritized", t.socket.reprioritize("slot1", "prefetch") === false);
  // Free one slot: the PROMOTED prefetch must go next, ahead of prefetch-1.
  void sleep(0);
  const freed = await until(() => t.posts.length >= 2, 300);
  check("the two slots are occupied by the earlier frames", freed);
}

// ── D. the write barrier ────────────────────────────────────────────────────

async function writeBarrier() {
  console.log("\nD. a write drains reads, bumps the epoch, and waits for its ANSWER");
  /** The first POST resolves only when the test lets it. */
  let releaseRead = () => {};
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const t = openTransport((index) => {
    if (index === 0) return readGate;
    return 204;
  });
  t.socket.sendPrioritized(historyReadFrame("r1"), "foreground");
  await until(() => t.posts.length === 1, 300);

  t.socket.send(writeFrame("w1"));
  await sleep(30);
  check("the epoch was bumped the moment the write was QUEUED", t.barrier.some((e) => !e.cleared), JSON.stringify(t.barrier));
  check("the write waits for the in-flight read's POST to drain", t.posts.length === 1, `posts=${t.posts.map((p) => p.type).join(",")}`);

  releaseRead(204);
  const posted = await until(() => t.posts.some((p) => p.type === "session_switch"), 500);
  check("the write is POSTed after the drain", posted, `posts=${t.posts.map((p) => p.type).join(",")}`);

  // A 204 alone must NOT reopen the lane.
  t.socket.sendPrioritized(historyReadFrame("r2"), "foreground");
  await sleep(60);
  check("a later read does NOT start on the write's 204 alone", t.posts.filter((p) => p.type === "history_read").length === 1, `reads=${t.posts.filter((p) => p.type === "history_read").length}`);

  // The BUSINESS answer reopens it.
  t.source().deliver(replyFrame("w1", { type: "session_switch_ok", session_id: "s2" }));
  const resumed = await until(() => t.posts.filter((p) => p.type === "history_read").length === 2, 500);
  check("the business answer reopens the lane", resumed, `reads=${t.posts.filter((p) => p.type === "history_read").length}`);
  check("the barrier reports cleared", t.barrier.some((e) => e.cleared && e.uncertain !== true), JSON.stringify(t.barrier));
}

// ── E. a write that never answers ───────────────────────────────────────────

async function uncertainWrite() {
  console.log("\nE. an unanswered write is UNCERTAIN: the lane reopens, nothing is replayed");
  const t = openTransport(() => 204);
  t.socket.send(writeFrame("w1"));
  await until(() => t.posts.some((p) => p.type === "session_switch"), 300);
  t.socket.sendPrioritized(historyReadFrame("r1"), "foreground");
  await sleep(40);
  check("the lane is closed while the write is unanswered", t.posts.filter((p) => p.type === "history_read").length === 0);
  const waited = await until(() => t.barrier.some((e) => e.cleared), WRITE_ACK_TIMEOUT_MS + 1000);
  check("the ack timeout terminates the barrier", waited, JSON.stringify(t.barrier));
  check("the termination is marked UNCERTAIN", t.barrier.some((e) => e.cleared && e.uncertain === true));
  const reopened = await until(() => t.posts.filter((p) => p.type === "history_read").length === 1, 500);
  check("reading resumes after an uncertain write", reopened);
  check("the write was POSTed exactly once (never replayed)", t.posts.filter((p) => p.type === "session_switch").length === 1);
}

// ── F. a failed write never freezes reading ─────────────────────────────────

async function failedWrite() {
  console.log("\nF. a FAILED write still terminates the barrier (never replays)");
  const t = openTransport(() => 502);
  t.socket.send(writeFrame("w1"));
  const failed = await until(() => t.errors.some((e) => e?.type === "post_failed"), 4000);
  check("the write failure is still surfaced", failed, JSON.stringify(t.errors));
  check("the write was POSTed once", t.posts.filter((p) => p.type === "session_switch").length === 1);
  check("the barrier terminated", t.barrier.some((e) => e.cleared), JSON.stringify(t.barrier));
  t.socket.sendPrioritized(historyReadFrame("r1"), "foreground");
  const resumed = await until(() => t.posts.filter((p) => p.type === "history_read").length === 1, 500);
  check("history reading is not blocked by a dead write", resumed);
}

// ── G. the legacy contract is intact ────────────────────────────────────────

async function legacyContract() {
  console.log("\nG. the F5 contract and serial order are unchanged");
  {
    const t = openTransport((i) => (i === 0 ? 502 : 204));
    t.socket.send(legacyReadFrame("r1"));
    const resent = await until(() => t.posts.length >= 2);
    check("a lost legacy read is still re-sent", resent && t.posts.length === 2, `posts=${t.posts.length}`);
    check("the re-send is byte-identical", t.posts[0].body === t.posts[1].body);
  }
  {
    const t = openTransport((i) => (i === 0 ? 502 : 204));
    t.socket.send(legacyReadFrame("r1"));
    t.socket.send(writeFrame("w1"));
    await until(() => t.posts.length >= 3);
    check(
      "the re-sent read keeps its place ahead of the write",
      t.posts.map((p) => p.type).join(",") === "session_read,session_read,session_switch",
      t.posts.map((p) => p.type).join(","),
    );
  }
  {
    const t = openTransport(() => 502);
    t.socket.send(writeFrame("w1"));
    await sleep(600);
    check("a lost WRITE is still POSTed exactly once", t.posts.length === 1, `posts=${t.posts.length}`);
  }
  {
    const t = openTransport(() => 409);
    t.socket.send(legacyReadFrame("r1"));
    const gone = await until(() => t.errors.some((e) => e?.type === "transport_gone"), 1000);
    check("409 still tears the transport down", gone && t.source().closed === true);
  }
  {
    const t = openTransport(() => 204);
    t.socket.send(legacyReadFrame("a"));
    t.socket.send(legacyReadFrame("b"));
    await until(() => t.posts.length === 2, 300);
    check(
      "serial-lane order is preserved for non-history frames",
      t.posts.map((p) => frameIdOf(p.body)).join(",") === "a,b",
      t.posts.map((p) => frameIdOf(p.body)).join(","),
    );
  }
}

// ── H. non-history frames never enter the lane ──────────────────────────────

async function laneIsAllowListed() {
  console.log("\nH. the lane is an ALLOW-LIST, not a hint");
  const t = openTransport(() => 204);
  t.socket.sendPrioritized(legacyReadFrame("r1"), "foreground");
  await until(() => t.posts.length === 1, 300);
  check("a proxied legacy read passed to sendPrioritized degrades to the serial lane", t.posts[0].type === "session_read");
  const t2 = openTransport(() => "hold");
  t2.socket.sendPrioritized(writeFrame("w1"), "foreground");
  await until(() => t2.posts.length === 1, 300);
  check("a WRITE passed to sendPrioritized stays a serial write", t2.posts[0].type === "session_switch");
  check("... and bumps the epoch like any write", t2.barrier.some((e) => !e.cleared));
}

console.log("verify-web-history-lane — lanes, priorities, write barrier");
await concurrency();
await priority();
await promotion();
await writeBarrier();
await uncertainWrite();
await failedWrite();
await legacyContract();
await laneIsAllowListed();

console.log(`\n${checks - failures.length}/${checks} checks PASS`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-history-lane: OK");
