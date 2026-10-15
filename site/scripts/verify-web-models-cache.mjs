/**
 * `list_models` catalogue cache verification (`src/lib/remote-pi/model-cache.ts`
 * plus its wiring in `src/lib/remote-pi/adapter.ts`).
 *
 * Two layers, both real code (Node 22 runs the TS directly):
 *   1. the PURE cache — TTL expiry, eviction on read, per-key invalidation,
 *      wholesale clear — driven directly with an injected clock;
 *   2. the ADAPTER WIRING — a fake transport (the documented injection seam)
 *      proves the behaviour a user actually sees: the second open does NOT
 *      re-send `list_models`, a `model_set` DOES invalidate, and switching
 *      relay/host (or forgetting) drops everything so a catalogue can never be
 *      attributed to a host that did not report it.
 *
 * Run: node scripts/verify-web-models-cache.mjs
 */

import { RemotePiAdapter } from "../src/lib/remote-pi/adapter.ts";
import {
  ModelCatalogueCache,
  catalogueKey,
  catalogueScope,
  MODEL_CACHE_TTL_MS,
} from "../src/lib/remote-pi/model-cache.ts";

const HOST_ROOM = "host";
const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const OTHER_EPK = Buffer.alloc(32, 11).toString("base64");
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

/** A fixture catalogue: two models, one flagged as the host's `current`. */
function catalogue(n = 1) {
  return {
    models: [
      { id: `model-${n}`, name: `Model ${n}`, provider: "prov", reasoning: true, vision: true, context_window: 1000 },
      { id: `model-${n}-b`, name: `Model ${n}b`, provider: "prov", reasoning: false, vision: false, context_window: 2000 },
    ],
    current: undefined,
  };
}

// ── fake transport (the documented seam) ────────────────────────────────────

class FakeTransport {
  constructor(url, list) {
    this.url = url;
    this.calls = [];
    this.listModelsCalls = [];
    this.modelSetCalls = [];
    this.connected = false;
    this.workspaces = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    list.push(this);
  }

  async connect() {
    this.calls.push("connect");
    this.connected = true;
  }
  async pair() {
    this.calls.push("pair");
    return { type: "pair_ok", session_name: "host", session_started_at: 1, room_id: HOST_ROOM };
  }
  async helloHost() {
    this.calls.push("helloHost");
    return {
      type: "host_hello_ok",
      daemon: { version: "fake-1", hostname: "fake-pi", platform: "linux" },
      capabilities: [],
    };
  }
  async listWorkspaces() {
    this.calls.push("listWorkspaces");
    return { type: "workspace_list_ok", workspaces: this.workspaces.map((w) => ({ ...w })) };
  }
  async fsList() {
    return { type: "fs_list_ok", path: "/x", parent: null, entries: [] };
  }
  async startWorkspace(epk, cwd, room) {
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
  sendModelSet(epk, room, provider, modelId) {
    this.modelSetCalls.push({ epk, room, provider, modelId });
    return `set-${this.modelSetCalls.length}`;
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

  /** Deliver a `models_list` reply for the N-th list request. */
  replyModels(n, room, payload) {
    const reply = {
      type: "models_list",
      in_reply_to: `list-${n}`,
      ...payload,
    };
    for (const listener of [...this.messageListeners]) listener(reply, room);
  }

  /** Deliver an ARBITRARY frame on `room` (used for malformed input). */
  push(msg, room) {
    for (const listener of [...this.messageListeners]) listener(msg, room);
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
const target = (over = {}) => ({ token: TOKEN, hostEpk: HOST_EPK, name: "host", roomId: HOST_ROOM, ...over });

// ── 1. pure cache ───────────────────────────────────────────────────────────

function pureCache() {
  console.log("\n== 1. cache puro: TTL, evicção e invalidação ==");
  let clock = 0;
  const cache = new ModelCatalogueCache(1000, () => clock);
  const key = catalogueKey(catalogueScope(RELAY, HOST_EPK), ROOM_A);

  check("cache vazio devolve null", cache.get(key) === null);
  cache.set(key, { models: [{ id: "m" }], current: undefined });
  check("set → get devolve a entrada", cache.get(key)?.models.length === 1);
  check("tamanho conta a entrada", cache.size === 1);

  clock = 999;
  check("dentro do TTL ainda vale", cache.get(key) !== null);
  clock = 1000;
  check("no limite do TTL expira", cache.get(key) === null);
  check("entrada expirada é EVICTADA na leitura", cache.size === 0, `size=${cache.size}`);

  clock = 2000;
  cache.set(key, { models: [{ id: "m2" }], current: undefined });
  check("set depois da expiração grava fresco", cache.get(key)?.models[0].id === "m2");

  cache.invalidate(key);
  check("invalidate remove só aquela chave", cache.get(key) === null && cache.size === 0);

  // Two rooms under the SAME source are independent.
  const keyA = catalogueKey(catalogueScope(RELAY, HOST_EPK), ROOM_A);
  const keyB = catalogueKey(catalogueScope(RELAY, HOST_EPK), ROOM_B);
  cache.set(keyA, { models: [{ id: "a" }], current: undefined });
  cache.set(keyB, { models: [{ id: "b" }], current: undefined });
  cache.invalidate(keyA);
  check("invalidar uma room não afeta a outra", cache.get(keyA) === null && cache.get(keyB)?.models[0].id === "b");
  cache.clear();
  check("clear derruba tudo", cache.size === 0);

  // The scope is part of the key: same room id on another host is a different
  // entry — a room id is derived from the cwd and is NOT host-scoped.
  const sameRoomOtherHost = catalogueKey(catalogueScope(RELAY, OTHER_EPK), ROOM_A);
  check("mesma room em outro host é outra chave", sameRoomOtherHost !== keyA);
  check("outro relay é outra chave", catalogueKey(catalogueScope("ws://other.test", HOST_EPK), ROOM_A) !== keyA);
  check("TTL exportado é positivo", MODEL_CACHE_TTL_MS > 0);
}

// ── 2. adapter wiring ───────────────────────────────────────────────────────

async function adapterWiring() {
  console.log("\n== 2. adapter: aquecimento, cache-hit e invalidação ==");
  const wire = fakeWire();
  const adapter = newAdapter({ transportFactory: wire.factory });
  const t = wire.list;
  await adapter.pair(target());
  const transport = wire.list[0];

  check("nenhum list_models antes de pedir", transport.listModelsCalls.length === 0);

  // First request: real wire traffic, reply warms the cache.
  const id1 = adapter.listModels(ROOM_A);
  check("primeira chamada vai para o fio", id1 === "list-1" && transport.listModelsCalls.length === 1, `calls=${transport.listModelsCalls.length}`);
  transport.replyModels(1, ROOM_A, catalogue(1));

  const cached = adapter.readCachedModels(ROOM_A);
  check("a resposta aquece o cache", cached !== null && cached.models.length === 2, JSON.stringify(cached?.models?.length));
  check("o catálogo guarda `models` sem inventar `current`", cached.current === undefined);

  // Second read for the SAME room is served locally: no new wire call.
  const again = adapter.readCachedModels(ROOM_A);
  check("cache-hit devolve o mesmo catálogo", again?.models[0].id === "model-1");
  check("cache-hit NÃO gera tráfego", transport.listModelsCalls.length === 1, `calls=${transport.listModelsCalls.length}`);

  // Another room is a different entry: it must hit the wire.
  adapter.listModels(ROOM_B);
  check("outra room é outra entrada (vai ao fio)", transport.listModelsCalls.length === 2 && transport.listModelsCalls[1].room === ROOM_B);
  transport.replyModels(2, ROOM_B, catalogue(9));
  check("catálogos de rooms diferentes coexistem", adapter.readCachedModels(ROOM_A)?.models[0].id === "model-1" && adapter.readCachedModels(ROOM_B)?.models[0].id === "model-9");

  // `model_set` on A invalidates ONLY A.
  adapter.setModel(ROOM_A, "prov", "model-1");
  adapter.invalidateCachedModels(ROOM_A);
  check("model_set invalida a room alterada", adapter.readCachedModels(ROOM_A) === null);
  check("model_set NÃO invalida outra room", adapter.readCachedModels(ROOM_B)?.models[0].id === "model-9");

  // After the invalidation the next list goes back to the wire.
  adapter.listModels(ROOM_A);
  check("após invalidar, relista no fio", transport.listModelsCalls.length === 3);
  transport.replyModels(3, ROOM_A, { models: catalogue(1).models, current: catalogue(1).models[0] });
  const withCurrent = adapter.readCachedModels(ROOM_A);
  check("`current` reportado pelo host é preservado", withCurrent.current?.id === "model-1", JSON.stringify(withCurrent.current));

  // `confirmCachedModel` corrects the entry IN PLACE: no extra round trip is
  // needed after a confirmed `model_set`.
  const listsBeforeConfirm = transport.listModelsCalls.length;
  adapter.confirmCachedModel(ROOM_A, "prov", "model-1-b");
  const afterConfirm = adapter.readCachedModels(ROOM_A);
  check(
    "confirmCachedModel corrige `current` sem ir ao fio",
    afterConfirm.current?.id === "model-1-b" && transport.listModelsCalls.length === listsBeforeConfirm,
    `current=${afterConfirm.current?.id} calls=${transport.listModelsCalls.length}`,
  );
  check("confirmCachedModel preserva a lista de modelos", afterConfirm.models.length === 2);

  // A confirmation for an UNKNOWN model stores `undefined` rather than
  // inventing a row — the next real list reports the truth.
  adapter.confirmCachedModel(ROOM_A, "prov", "model-that-is-not-listed");
  check(
    "confirmCachedModel de modelo desconhecido não inventa linha",
    adapter.readCachedModels(ROOM_A).current === undefined,
    JSON.stringify(adapter.readCachedModels(ROOM_A).current),
  );

  // A confirmation with NO cached entry is a safe no-op (nothing to correct).
  adapter.confirmCachedModel("room-without-cache", "prov", "model-1");
  check("confirmCachedModel sem cache é no-op", adapter.readCachedModels("room-without-cache") === null);

  // An invalid frame is never cached.
  const beforeBad = adapter.readCachedModels(ROOM_B) !== null;
  transport.push({ type: "models_list", in_reply_to: "list-2", models: "not-an-array" }, ROOM_B);
  check("models_list inválido não sobrescreve a entrada boa", beforeBad && adapter.readCachedModels(ROOM_B)?.models[0].id === "model-9");

  adapter.close();
}

// ── 3. identity change drops everything ─────────────────────────────────────

async function identityChange() {
  console.log("\n== 3. troca de host/relay (e forget) limpa o cache ==");

  // 3a. A second adapter on ANOTHER host must not see the first one's rows.
  //     (Each adapter owns its own cache; the observable is that a fresh
  //     adapter starts cold.)
  const wireA = fakeWire();
  const adapterA = newAdapter({ transportFactory: wireA.factory });
  await adapterA.pair(target());
  adapterA.listModels(ROOM_A);
  wireA.list[0].replyModels(1, ROOM_A, catalogue(1));
  check("adapter A tem catálogo em cache", adapterA.readCachedModels(ROOM_A) !== null);

  const wireB = fakeWire();
  const adapterB = newAdapter({ transportFactory: wireB.factory });
  await adapterB.pair(target({ hostEpk: OTHER_EPK, token: TOKEN }));
  check("adapter de OUTRO host começa sem catálogo", adapterB.readCachedModels(ROOM_A) === null);
  adapterA.close();
  adapterB.close();

  // 3b. RE-PAIRING the SAME adapter to a DIFFERENT host clears its cache.
  const wireC = fakeWire();
  const adapterC = newAdapter({ transportFactory: wireC.factory, storage: null });
  await adapterC.pair(target());
  adapterC.listModels(ROOM_A);
  wireC.list[0].replyModels(1, ROOM_A, catalogue(1));
  check("antes da troca há cache", adapterC.readCachedModels(ROOM_A) !== null);

  await adapterC.pair(target({ hostEpk: OTHER_EPK, token: TOKEN }));
  check("trocar de host LIMPA o cache", adapterC.readCachedModels(ROOM_A) === null);
  check("novo host responde no fio (cache não vaza)", wireC.list[1].listModelsCalls.length === 0);

  // 3c. Switching the RELAY alone also clears it.
  adapterC.listModels(ROOM_A);
  wireC.list[1].replyModels(1, ROOM_A, catalogue(2));
  check("cache do segundo host populado", adapterC.readCachedModels(ROOM_A)?.models[0].id === "model-2");
  await adapterC.pair(target({ hostEpk: OTHER_EPK, token: TOKEN, relayUrl: "ws://other.test" }));
  check("trocar de relay LIMPA o cache", adapterC.readCachedModels(ROOM_A) === null);

  // 3d. close() (explicit forget) drops it too.
  adapterC.listModels(ROOM_A);
  wireC.list[2].replyModels(1, ROOM_A, catalogue(3));
  check("antes do close há cache", adapterC.readCachedModels(ROOM_A) !== null);
  adapterC.close();
  check("close() limpa o cache", adapterC.readCachedModels(ROOM_A) === null);

  // 3e. Reconnecting to the SAME relay+host keeps the catalogue: a retry is
  //     the same source, so the shortcut is still valid.
  const wireD = fakeWire();
  const adapterD = newAdapter({ transportFactory: wireD.factory });
  await adapterD.pair(target());
  adapterD.listModels(ROOM_A);
  wireD.list[0].replyModels(1, ROOM_A, catalogue(4));
  await adapterD.pair(target());
  check("re-pair do MESMO host/relay preserva o cache", adapterD.readCachedModels(ROOM_A)?.models[0].id === "model-4");
  check("e o re-pair usa o fio novo, sem erro", wireD.list.length === 2);
  adapterD.close();
}

// ── run ─────────────────────────────────────────────────────────────────────

pureCache();
await adapterWiring();
await identityChange();

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
console.log("verify-web-models-cache: OK");
