/**
 * Handshake round-trip verification.
 *
 * The connect sequence used to be FOUR strictly serial round trips:
 *
 *   connect (hello → challenge → auth)  →  pair  →  host_hello  →  workspace_list
 *
 * `pair` genuinely must come before the other two: the host room drops every
 * inner type from a peer that is not on its allow-list, and `pair_request` is
 * the only carve-out (server/src/daemon/host_bridge.ts:181-189). But once the
 * peer is paired, `host_hello` and `workspace_list` are INDEPENDENT — separate
 * synchronous handlers on the host (host_bridge.ts:197 and :228) — and the
 * transport correlates replies by id out of a `pending` map
 * (clients/web/src/lib/remote-pi/client.ts:1019-1052). They are therefore sent
 * in ONE flight, which turns 4 serial round trips into 3.
 *
 * This script proves the concurrency at the ADAPTER level, not just by reading
 * the source: it drives the real `RemotePiAdapter` with a fake transport that
 * records the wall-clock order of every outbound request, and it asserts that
 * both reads were in flight simultaneously. It also proves the failure paths
 * still behave: a rejection in one read must not leave the other unhandled.
 *
 * Run: node scripts/verify-web-handshake.mjs
 */

import { RemotePiAdapter } from "../src/lib/remote-pi/adapter.ts";
import {
  encodeCt,
  decodeCt,
} from "../src/lib/remote-pi/protocol.ts";

const HOST_EPK = Buffer.alloc(32, 9).toString("base64");
const ROOM = "host";

/** A `PairTarget` the adapter accepts: the room must be the host-web room (the
 *  adapter refuses anything else with `unsupported_room`) and the epk must pass
 *  the same five-field validator the on-disk record uses. */
const PAIR_TARGET = {
  relayUrl: "ws://relay.test",
  token: "tok",
  name: "h",
  hostEpk: HOST_EPK,
  roomId: ROOM,
};

let passed = 0;
const failures = [];
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    failures.push(label);
    console.log(`  [FAIL] ${label}`);
  }
}

/**
 * A transport double that records the ORDER and the OVERLAP of outbound calls.
 * Every `request`-style method returns a promise that the test settles by hand,
 * so "were two requests in flight at once?" is answered by observation.
 */
function createRecordingTransport(options = {}) {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pending = new Map();

  const begin = (name) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log.push({ name, phase: "send", inFlight });
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    pending.set(name, {
      resolve: (value) => {
        inFlight -= 1;
        log.push({ name, phase: "resolve", inFlight });
        settle.resolve(value);
      },
      reject: (error) => {
        inFlight -= 1;
        log.push({ name, phase: "reject", inFlight });
        settle.reject(error);
      },
    });
    return promise;
  };

  const transport = {
    backend: "fake",
    log,
    get maxInFlight() {
      return maxInFlight;
    },
    get inFlight() {
      return inFlight;
    },
    pending,
    // The adapter subscribes to these on attach; returning a no-op disposer is
    // enough because this double never emits spontaneous frames.
    onClose: () => () => {},
    onServerMessage: () => () => {},
    onWorkspaceState: () => () => {},
    onDiagnostic: () => () => {},
    connect: async () => {
      log.push({ name: "connect", phase: "send", inFlight });
      log.push({ name: "connect", phase: "resolve", inFlight });
    },
    pair: () => begin("pair"),
    helloHost: (peer, room) => {
      if (options.failHello) {
        // Fail synchronously-ish so the OTHER read is still in flight.
        const promise = begin("hello");
        queueMicrotask(() => pending.get("hello")?.reject(new Error("hello_failed")));
        return promise;
      }
      return begin("hello");
    },
    listWorkspaces: () => {
      if (options.failList) {
        const promise = begin("list");
        queueMicrotask(() => pending.get("list")?.reject(new Error("list_failed")));
        return promise;
      }
      return begin("list");
    },
    close: () => {},
    dispose: () => {},
  };

  // Resolve helpers so the test can drive the flow deterministically.
  transport.resolveAll = () => {
    pending.get("pair")?.resolve({ ok: true });
    // The two reads are only requested after pair resolves, so they don't exist
    // yet on the first call; the caller re-invokes after a tick.
  };
  return transport;
}

const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

/** A stored session that `restore()` accepts (so the flow reaches the reads). */
function seedStored(storage) {
  // The adapter validates the record through `loadStoredSession`, so the shape
  // must match what `writeStored` produces. Rather than reverse-engineer it
  // here, drive an explicit `pair()` and let the adapter persist it.
  void storage;
}

/** Waits until `predicate()` is true (bounded), yielding to the event loop. */
async function until(predicate, label, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ── 1. the two reads overlap ───────────────────────────────────────────────
console.log("\n1. host_hello e workspace_list estão em voo ao mesmo tempo");
{
  const transport = createRecordingTransport();
  const adapter = new RemotePiAdapter({
    storage: fakeStorage(),
    transportFactory: () => transport,
    timeouts: { openMs: 2000, challengeMs: 2000, requestMs: 2000, signerMs: 2000, authGraceMs: 50 },
    retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 20 },
  });

  const run = adapter.pair(PAIR_TARGET).catch(() => {});
  await until(() => transport.pending.has("pair"), "pair enviado");
  transport.pending.get("pair").resolve({ ok: true });

  await until(() => transport.pending.has("hello") || transport.pending.has("list"), "um dos reads enviado");
  // Both should have been requested in the same tick, before either settles.
  const helloOrListAt = transport.log.filter((e) => e.name === "hello" || e.name === "list").length;
  check("os dois reads foram enviados antes de qualquer um resolver", helloOrListAt >= 2);
  check("overlap máximo observado é 2 (não 1)", transport.maxInFlight >= 2);
  check(
    "os dois reads ficaram pendentes simultaneamente",
    transport.pending.has("hello") && transport.pending.has("list"),
  );

  // Settle them so the flow can finish and no promise is left dangling.
  transport.pending.get("hello")?.resolve({
    type: "host_hello_ok",
    in_reply_to: "x",
    daemon: { version: "1", hostname: "h", platform: "linux" },
    capabilities: [],
  });
  transport.pending.get("list")?.resolve({ type: "workspace_list_ok", in_reply_to: "y", workspaces: [] });
  await run;

  const order = transport.log.map((e) => `${e.name}:${e.phase}`);
  const pairIdx = order.indexOf("pair:resolve");
  const helloIdx = order.indexOf("hello:send");
  const listIdx = order.indexOf("list:send");
  check("pair resolve antes dos reads serem enviados", pairIdx >= 0 && helloIdx > pairIdx && listIdx > pairIdx);
  check("não há gap serial entre os dois reads (ambos partem do mesmo ponto)", Math.abs(helloIdx - listIdx) === 1);
}

// ── 2. a rejected read does not leave the other unhandled ──────────────────
console.log("\n2. rejeição de um read não deixa o outro sem handler");
{
  const transport = createRecordingTransport();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const adapter = new RemotePiAdapter({
    storage: fakeStorage(),
    transportFactory: () => transport,
    timeouts: { openMs: 2000, challengeMs: 2000, requestMs: 2000, signerMs: 2000, authGraceMs: 50 },
    retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 20 },
  });

  const run = adapter.pair(PAIR_TARGET).catch(() => {});
  await until(() => transport.pending.has("pair"), "pair enviado");
  transport.pending.get("pair").resolve({ ok: true });
  await until(() => transport.pending.has("hello") && transport.pending.has("list"), "ambos os reads enviados");

  // Reject hello FIRST, leave list in flight for a while, then resolve it.
  transport.pending.get("hello").reject(new Error("hello_failed"));
  await new Promise((r) => setTimeout(r, 20));
  transport.pending.get("list").resolve({ type: "workspace_list_ok", in_reply_to: "y", workspaces: [] });

  await run;
  // Let any stray rejection surface.
  await new Promise((r) => setTimeout(r, 30));
  process.off("unhandledRejection", onUnhandled);

  check("nenhuma promise rejeitada sem handler", unhandled.length === 0);
}

// ── 3. the flow still fails when the FIRST read rejects ────────────────────
console.log("\n3. falha do primeiro read ainda derruba o fluxo");
{
  const transport = createRecordingTransport();
  const adapter = new RemotePiAdapter({
    storage: fakeStorage(),
    transportFactory: () => transport,
    timeouts: { openMs: 2000, challengeMs: 2000, requestMs: 2000, signerMs: 2000, authGraceMs: 50 },
    retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 20 },
  });

  // Start the flow WITHOUT awaiting it: the doubles only settle when this test
  // says so, so awaiting first would deadlock.
  const run = adapter.pair(PAIR_TARGET).catch(() => null);

  await until(() => transport.pending.has("pair"), "pair enviado");
  transport.pending.get("pair").resolve({ ok: true });
  await until(() => transport.pending.has("hello") && transport.pending.has("list"), "ambos enviados");

  // Reject the FIRST read while the second is still in flight.
  transport.pending.get("hello").reject(new Error("hello_failed"));
  transport.pending.get("list").resolve({ type: "workspace_list_ok", in_reply_to: "y", workspaces: [] });

  await run;
  await new Promise((r) => setTimeout(r, 20));
  const snap = adapter.getSnapshot();
  check("o adapter não fica connected após falha", snap.phase !== "connected");
  check("a falha foi registrada como erro (não sucesso silencioso)", snap.phase === "error" || snap.warning !== null || snap.workspaces === null);
}

console.log("");
if (failures.length === 0) {
  console.log(`${passed}/${passed} checks PASS`);
  console.log("verify-web-handshake: OK");
  process.exit(0);
} else {
  console.log(`${passed}/${passed + failures.length} checks PASS`);
  console.log(`${failures.length} check(s) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
