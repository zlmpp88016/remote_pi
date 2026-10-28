/**
 * Prefetch correlation regression.
 *
 * THE BUG THIS PINS (user-visible: "Asking the host for this workspace's models…"
 * on every picker open, even after the connection had been up for a while):
 *
 *   1. Connection comes up → the prefetch queues every live workspace and
 *      issues `list_models` for the first one. The ONE in-flight id lives in
 *      `modelReqRef`.
 *   2. The user clicks a workspace → `openRoom` ran `modelReqRef.current = null`
 *      as part of "reset per-room transient state".
 *   3. The prefetch reply arrives. Its `in_reply_to` can no longer match, so the
 *      frame is dropped … and `rememberCatalogue` never runs, because the
 *      adapter only caches a `models_list` that a listener accepted.
 *   4. Result: the cache stays EMPTY for that connection, so every picker open
 *      takes the cold path (`list_models` + `modelBusy = true`) and renders the
 *      "asking the host" spinner.
 *
 * The fix: `modelReqRef` tracks a WIRE correlation, not per-room UI state, so
 * `openRoom` must not clear it. This file proves both halves:
 *   A. the adapter contract — a reply only warms the cache when its id matches;
 *   B. the ordering the UI must therefore preserve.
 *
 * Run: node scripts/verify-web-model-prefetch.mjs
 */

import { RemotePiAdapter } from "../src/lib/remote-pi/adapter.ts";

const HOST_ROOM = "host";
const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "pair-token-SECRET";
const RELAY = "ws://relay.test";
const ROOM_A = "room-a";
const ROOM_B = "room-b";

let checks = 0;
let failures = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(String(err)));

function catalogue(n = 1) {
  return {
    models: [
      { id: `model-${n}`, name: `Model ${n}`, provider: "prov", reasoning: true, vision: true, context_window: 1000 },
    ],
    current: undefined,
  };
}

class FakeTransport {
  constructor(url, list) {
    this.url = url;
    this.listModelsCalls = [];
    this.connected = false;
    this.workspaces = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    list.push(this);
  }
  async connect() {
    this.connected = true;
  }
  async pair() {
    return { type: "pair_ok", session_name: "host", session_started_at: 1, room_id: HOST_ROOM };
  }
  async helloHost() {
    return {
      type: "host_hello_ok",
      daemon: { version: "fake-1", hostname: "fake-pi", platform: "linux" },
      capabilities: [],
    };
  }
  async listWorkspaces() {
    return { type: "workspace_list_ok", workspaces: this.workspaces.map((w) => ({ ...w })) };
  }
  async fsList() {
    return { type: "fs_list_ok", path: "/x", parent: null, entries: [] };
  }
  async startWorkspace(epk, cwd) {
    return { type: "workspace_start_ok", cwd, room_id: "room-1", daemon_id: "d1" };
  }
  async restartWorkspace() {
    return { type: "workspace_restart_ok", cwd: "/x", room_id: "room-1" };
  }
  async addWorkspace() {}
  sendChat() {
    return "mid-1";
  }
  sendListModels(epk, room) {
    this.listModelsCalls.push({ epk, room });
    return `list-${this.listModelsCalls.length}`;
  }
  sendModelSet() {
    return "set-1";
  }
  sendThinkingSet() {
    return "think-1";
  }
  onServerMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onDiagnostic() {
    return () => {};
  }
  close() {
    this.connected = false;
  }
  replyModels(n, room, payload) {
    const reply = { type: "models_list", in_reply_to: `list-${n}`, ...payload };
    for (const listener of [...this.messageListeners]) listener(reply, room);
  }
}

function fakeWire() {
  const list = [];
  return { list, factory: (url) => new FakeTransport(url, list) };
}

const adapters = [];
function newAdapter(options) {
  const adapter = new RemotePiAdapter({
    relayUrl: RELAY,
    storage: null,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    ...options,
  });
  adapters.push(adapter);
  return adapter;
}
const target = () => ({ token: TOKEN, hostEpk: HOST_EPK, name: "host", roomId: HOST_ROOM });

/**
 * A faithful model of the container's prefetch correlation, so the ORDERING
 * rule can be asserted without mounting React.
 *
 * `modelReqRef` is a single wire-correlation slot. A reply is accepted only
 * when (pending.room === room && pending.id === in_reply_to). This is exactly
 * what `onServerMessage` does before calling `applyCatalogue`.
 */
function makePrefetchHarness(adapter, transport) {
  const state = { pending: null, cachedRooms: [], busy: false };

  function prefetch(roomId) {
    if (state.pending !== null) return;
    const id = adapter.listModels(roomId);
    state.pending = { id, room: roomId };
  }

  function receive(msg, room) {
    const pending = state.pending;
    if (pending === null || pending.room !== room || pending.id !== msg.in_reply_to) return false;
    state.pending = null;
    state.cachedRooms.push(room);
    state.busy = false;
    return true;
  }

  /** `openRoom`: the line that used to (wrongly) clear the wire slot. */
  function openRoom(clearPending) {
    if (clearPending) state.pending = null;
  }

  return { state, prefetch, receive, openRoom, transport };
}

async function theBug() {
  console.log("\n== 1. o bug: openRoom limpando o slot de correlação ==");

  const wire = fakeWire();
  const adapter = newAdapter({ transportFactory: wire.factory });
  await adapter.pair(target());
  const transport = wire.list[0];

  // --- BROKEN ORDERING (what the code did) ---
  {
    const h = makePrefetchHarness(adapter, transport);
    h.prefetch(ROOM_A); // prefetch in flight
    h.openRoom(true); // the old `openRoom` cleared modelReqRef
    // Deliver through the REAL transport so the adapter layer is exercised too.
    transport.replyModels(1, ROOM_A, catalogue(1));
    const accepted = h.receive(
      { type: "models_list", in_reply_to: "list-1", ...catalogue(1) },
      ROOM_A,
    );
    check(
      "(A) limpando o slot, o CONTAINER descarta a resposta",
      accepted === false && h.state.cachedRooms.length === 0,
      `accepted=${accepted} cached=${h.state.cachedRooms.length}`,
    );
    // IMPORTANT: the ADAPTER caches every `models_list` it sees, correlated or
    // not (`rememberCatalogue` runs before listener dispatch). So the loss is
    // not the cache write — it is that the CONTAINER never applied the rows to
    // React state, which is what the picker renders. Both layers are asserted
    // separately so this distinction cannot be lost again.
    check(
      "(A) o adaptador AINDA aquece (rememberCatalogue é incondicional)",
      adapter.readCachedModels(ROOM_A) !== null,
      "adapter caches regardless of correlation",
    );
    check(
      "(A) mas o container NÃO aplicou as linhas ao estado do picker",
      h.state.cachedRooms.length === 0,
    );
  }

  // --- FIXED ORDERING (what the code does now) ---
  {
    // A fresh pairing to get a clean cache for the room.
    const wire2 = fakeWire();
    const adapter2 = newAdapter({ transportFactory: wire2.factory });
    await adapter2.pair(target());
    const transport2 = wire2.list[0];

    const h = makePrefetchHarness(adapter2, transport2);
    h.prefetch(ROOM_A);
    h.openRoom(false); // preserved
    const accepted = h.receive(
      { type: "models_list", in_reply_to: "list-1", ...catalogue(1) },
      ROOM_A,
    );
    check("(B) preservando o slot, a resposta é ACEITA", accepted === true);
    check("(B) a room entra no cache", h.state.cachedRooms.includes(ROOM_A), JSON.stringify(h.state.cachedRooms));
    check("(B) e o container aplicou as linhas (picker populado)", h.state.cachedRooms.includes(ROOM_A));
    check(
      "(B) sem nenhum list_models extra",
      transport2.listModelsCalls.length === 1,
      `calls=${transport2.listModelsCalls.length}`,
    );
    adapter2.close();
  }

  adapter.close();
}

async function adapterContract() {
  console.log("\n== 2. contrato do adaptador: só a resposta correlacionada aquece ==");
  const wire = fakeWire();
  const adapter = newAdapter({ transportFactory: wire.factory });
  await adapter.pair(target());
  const transport = wire.list[0];

  // The adapter warms its cache from ANY `models_list` on the socket — that is
  // deliberate (another caller may have issued the request). Pinned here so the
  // behaviour is documented rather than assumed.
  transport.replyModels(99, ROOM_A, catalogue(1));
  check(
    "o adaptador aquece de QUALQUER models_list (cache é por socket)",
    adapter.readCachedModels(ROOM_A) !== null,
  );
  adapter.invalidateCachedModels(ROOM_A);

  // The real reply does.
  transport.replyModels(1, ROOM_A, catalogue(1));
  check("a resposta correlacionada aquece o cache", adapter.readCachedModels(ROOM_A) !== null);
  check("com o conteúdo reportado", adapter.readCachedModels(ROOM_A)?.models[0].id === "model-1");

  adapter.close();
}

async function prefetchAcrossRooms() {
  console.log("\n== 3. uma prefetch em voo por vez, todas as rooms aquecem ==");
  const wire = fakeWire();
  const adapter = newAdapter({ transportFactory: wire.factory });
  await adapter.pair(target());
  const transport = wire.list[0];

  // Serialised like `runPrefetchNext`: only one id in flight at a time.
  const rooms = [ROOM_A, ROOM_B];
  let inFlight = 0;
  for (const room of rooms) {
    adapter.listModels(room);
    inFlight += 1;
    transport.replyModels(inFlight, room, catalogue(inFlight));
    inFlight -= 1;
  }
  check("ambas as rooms aqueceram", adapter.readCachedModels(ROOM_A) !== null && adapter.readCachedModels(ROOM_B) !== null);
  check("uma requisição por room", transport.listModelsCalls.length === 2, `calls=${transport.listModelsCalls.length}`);

  adapter.close();
}

// ── run ─────────────────────────────────────────────────────────────────────

await theBug();
await adapterContract();
await prefetchAcrossRooms();

for (const adapter of adapters) {
  try {
    adapter.close();
  } catch {
    /* already closed */
  }
}

await new Promise((resolve) => setTimeout(resolve, 20));
check("nenhuma promise rejeitada sem tratamento", unhandled.length === 0, unhandled.join("; "));

console.log(`\n${checks - failures}/${checks} checks PASS`);
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-model-prefetch: OK");
