/**
 * Session wire verification (`session_list` / `session_read` / `session_switch`)
 * for `src/lib/remote-pi/protocol.ts`, its wiring in
 * `src/lib/remote-pi/adapter.ts`, and the pure presentation helpers.
 *
 * The load-bearing property under test is the SPLIT the UI promises:
 *   • reading a session (`session_read`) must be a pure read — it must NOT
 *     switch the live session;
 *   • switching (`session_switch`) is a distinct, explicit action whose refusal
 *     codes map to fixed sentences.
 *
 * Layers, all real code (Node 22 runs the TS):
 *   1. STRICT GUARDS — incl. the field-for-field match with the host's
 *      `SessionHistoryEvent` (an earlier version of this guard rejected real
 *      host frames because `agent_message` was modelled wrong);
 *   2. ADAPTER WIRING — a fake transport (the documented seam) proves each
 *      request is addressed to the workspace room, returns its own correlation
 *      id, and that read and switch are genuinely different frames;
 *   3. PURE HELPERS — relative time, labels, sort order, refusal text.
 *
 * Run: node scripts/verify-web-sessions.mjs
 */

import { RemotePiAdapter } from "../src/lib/remote-pi/adapter.ts";
import {
  isSessionListOk,
  isSessionReadOk,
  isSessionSwitchError,
  isSessionSwitchOk,
  isWireSessionInfo,
} from "../src/lib/remote-pi/protocol.ts";
import {
  previewText,
  relativeTime,
  sessionLabel,
  shortSessionId,
  sortSessions,
  switchErrorText,
} from "../src/lib/remote-pi/sessions.ts";

const HOST_ROOM = "host";
const HOST_EPK = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "pair-token-SECRET";
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

// ── fixtures ────────────────────────────────────────────────────────────────

const row = (over = {}) => ({
  id: "01a0fb75-c2a0-7207-9afa-5d2a61f8ecb1",
  name: "4.1f",
  mtime: 1_760_000_000_000,
  preview: "um problema de doces",
  live: true,
  cwd: "D:\\proj",
  ...over,
});

/** A REAL host event set, copied from a live `session_read_ok` reply. */
const realEvents = () => [
  { ts: 1, type: "tool_request", tool_call_id: "call_1", tool: "bash", args: { command: "ls" } },
  { ts: 2, type: "tool_result", tool_call_id: "call_1", result: "ok" },
  { ts: 3, type: "user_input", id: "e1", text: "oi" },
  { ts: 4, type: "agent_message", in_reply_to: "e1", text: "olá", usage: { input: 10 } },
];

const readOk = (over = {}) => ({
  type: "session_read_ok",
  in_reply_to: "r1",
  session_id: "01a0fb4e-b263-7207-9afa-5d296a973881",
  events: realEvents(),
  eos: true,
  truncated: false,
  older_cursor: null,
  has_older: true,
  ...over,
});

// ── 1. guards ───────────────────────────────────────────────────────────────

function guards() {
  console.log("\n== 1. guards estritos ==");

  check("linha de sessão válida passa", isWireSessionInfo(row()));
  check("name/preview/cwd são opcionais", isWireSessionInfo({ id: "a", mtime: 1, live: false }));
  check("live ausente é recusado", !isWireSessionInfo({ id: "a", mtime: 1 }));
  check("live string é recusada", !isWireSessionInfo(row({ live: "true" })));
  check("mtime não-numérico é recusado", !isWireSessionInfo(row({ mtime: "x" })));
  check("id vazio é recusado", !isWireSessionInfo(row({ id: "" })));
  check("name não-string é recusado", !isWireSessionInfo(row({ name: 42 })));

  const listOk = { type: "session_list_ok", in_reply_to: "r", current_id: "x", sessions: [row()] };
  check("session_list_ok válido passa", isSessionListOk(listOk));
  check("current_id null é aceito", isSessionListOk({ ...listOk, current_id: null }));
  check("sessions vazio passa", isSessionListOk({ ...listOk, sessions: [] }));
  check("uma linha ruim invalida a lista", !isSessionListOk({ ...listOk, sessions: [row(), null] }));
  check("sessions não-array é recusado", !isSessionListOk({ ...listOk, sessions: "x" }));
  check("tipo errado é recusado", !isSessionListOk({ ...listOk, type: "session_read_ok" }));

  // The shape that matters: field-for-field with the host.
  console.log("\n  -- session_read_ok: casar com o host, campo a campo --");
  check("reply real do host passa", isSessionReadOk(readOk()));
  check("events vazio passa", isSessionReadOk(readOk({ events: [] })));
  check("events não-array é recusado", !isSessionReadOk(readOk({ events: "x" })));
  check("session_id vazio é recusado", !isSessionReadOk(readOk({ session_id: "" })));
  check("eos não-booleano é recusado", !isSessionReadOk(readOk({ eos: "yes" })));
  check("has_older ausente é aceito", isSessionReadOk((() => { const r = readOk(); delete r.has_older; return r; })()));
  check("older_cursor null é aceito", isSessionReadOk(readOk({ older_cursor: null })));

  // agent_message: the host REQUIRES `in_reply_to` and allows `usage` with NO
  // `id`. Modelling it as `{id}` (an earlier bug) rejected real frames.
  check(
    "agent_message como o host manda (in_reply_to + usage, sem id) passa",
    isSessionReadOk(readOk({ events: [{ ts: 1, type: "agent_message", in_reply_to: "e1", text: "t", usage: { a: 1 } }] })),
  );
  check(
    "agent_message sem in_reply_to é recusado",
    !isSessionReadOk(readOk({ events: [{ ts: 1, type: "agent_message", text: "t" }] })),
  );
  check(
    "compaction com summary/tokens_before passa",
    isSessionReadOk(readOk({ events: [{ ts: 1, type: "compaction", summary: "s", tokens_before: 10 }] })),
  );
  check(
    "compaction sem tokens_before é recusada",
    !isSessionReadOk(readOk({ events: [{ ts: 1, type: "compaction", summary: "s" }] })),
  );
  check(
    "evento de tipo desconhecido é recusado (não some silenciosamente)",
    !isSessionReadOk(readOk({ events: [{ ts: 1, type: "mystery" }] })),
  );
  check(
    "tool_result com error string passa",
    isSessionReadOk(readOk({ events: [{ ts: 1, type: "tool_result", tool_call_id: "c", error: "boom" }] })),
  );

  console.log("\n  -- session_switch --");
  check("switch_ok válido passa", isSessionSwitchOk({ type: "session_switch_ok", in_reply_to: "r", session_id: "a", session_started_at: 1 }));
  check("switch_ok sem session_id é recusado", !isSessionSwitchOk({ type: "session_switch_ok", in_reply_to: "r", session_started_at: 1 }));
  check("cada código de recusa é aceito", ["locked", "unknown", "no_sdk"].every((code) => isSessionSwitchError({ type: "session_switch_error", in_reply_to: "r", code, message: "m" })));
  check("código desconhecido é recusado", !isSessionSwitchError({ type: "session_switch_error", in_reply_to: "r", code: "weird", message: "m" }));
  check("sem message é recusado", !isSessionSwitchError({ type: "session_switch_error", in_reply_to: "r", code: "locked" }));
}

// ── 2. adapter wiring ───────────────────────────────────────────────────────

class FakeTransport {
  constructor(url, list) {
    this.url = url;
    this.calls = [];
    this.listCalls = [];
    this.readCalls = [];
    this.switchCalls = [];
    this.connected = false;
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    list.push(this);
  }
  async connect() {
    this.calls.push("connect");
    this.connected = true;
  }
  async pair() {
    return { type: "pair_ok", session_name: "host", session_started_at: 1, room_id: HOST_ROOM };
  }
  async helloHost() {
    return { type: "host_hello_ok", daemon: { version: "v", hostname: "h", platform: "l" }, capabilities: [] };
  }
  async listWorkspaces() {
    return { type: "workspace_list_ok", workspaces: [] };
  }
  async fsList() {
    return { type: "fs_list_ok", path: "/x", parent: null, entries: [] };
  }
  async startWorkspace(epk, cwd) {
    return { type: "workspace_start_ok", cwd, room_id: "r", daemon_id: "d" };
  }
  async restartWorkspace() {
    return { type: "workspace_restart_ok", cwd: "/x", room_id: "r" };
  }
  async addWorkspace() {}
  sendChat() {
    return "c";
  }
  sendListModels() {
    return "lm";
  }
  sendModelSet() {
    return "ms";
  }
  sendThinkingSet() {
    return "ts";
  }
  sendPiSurface() {
    return "ps";
  }
  sendSkillInvoke() {
    return "si";
  }
  sendSessionList(epk, room) {
    this.listCalls.push({ epk, room });
    return `list-${this.listCalls.length}`;
  }
  sendSessionRead(epk, room, sessionId, options) {
    this.readCalls.push({ epk, room, sessionId, options });
    return `read-${this.readCalls.length}`;
  }
  sendSessionSwitch(epk, room, sessionId) {
    this.switchCalls.push({ epk, room, sessionId });
    return `sw-${this.switchCalls.length}`;
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
    relayUrl: "ws://relay.test",
    storage: null,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    ...options,
  });
  adapters.push(adapter);
  return adapter;
}
const target = () => ({ token: TOKEN, hostEpk: HOST_EPK, name: "host", roomId: HOST_ROOM });

async function adapterWiring() {
  console.log("\n== 2. adapter: list/read/switch são frames DISTINTOS ==");
  const wire = fakeWire();
  const adapter = newAdapter({ transportFactory: wire.factory });
  await adapter.pair(target());
  const transport = wire.list[0];
  const seen = [];
  adapter.onServerMessage((msg, room) => seen.push({ msg, room }));

  const listId = adapter.listSessions(ROOM_A);
  check("listSessions usa o epk do host", transport.listCalls[0].epk === HOST_EPK);
  check("listSessions endereça a room do workspace", transport.listCalls[0].room === ROOM_A);
  check("listSessions devolve o id interno", listId === "list-1");

  const readId = adapter.readSession(ROOM_A, "sess-1", { limit: 50 });
  check("readSession endereça a room do workspace", transport.readCalls[0].room === ROOM_A);
  check("readSession manda o session_id", transport.readCalls[0].sessionId === "sess-1");
  check("readSession manda o limit", transport.readCalls[0].options.limit === 50);
  check("readSession NÃO inventa `before`", transport.readCalls[0].options.before === undefined);
  check("readSession devolve o id interno", readId === "read-1");

  const swId = adapter.switchSession(ROOM_A, "sess-1");
  check("switchSession manda o session_id", transport.switchCalls[0].sessionId === "sess-1");
  check("switchSession devolve o id interno", swId === "sw-1");

  // THE property: read and switch are different requests, and a read must not
  // have produced a switch on the wire.
  check(
    "ler NÃO gera switch no fio",
    transport.switchCalls.length === 1 && transport.readCalls.length === 1,
    `reads=${transport.readCalls.length} switches=${transport.switchCalls.length}`,
  );

  // Every request has its OWN id, so replies cannot be crossed.
  check(
    "list/read/switch têm ids distintos",
    new Set([listId, readId, swId]).size === 3,
  );

  // Replies are forwarded with their room tag intact (the container correlates).
  seen.length = 0;
  transport.push({ type: "session_read_ok", in_reply_to: readId, session_id: "sess-1", events: realEvents(), eos: true, truncated: false }, ROOM_A);
  check(
    "session_read_ok casa (room + in_reply_to) e passa a guarda",
    seen.length === 1 && seen[0].room === ROOM_A && seen[0].msg.in_reply_to === readId && isSessionReadOk(seen[0].msg),
  );

  seen.length = 0;
  transport.push({ type: "session_switch_ok", in_reply_to: swId, session_id: "sess-1", session_started_at: 7 }, ROOM_A);
  check("session_switch_ok casa e passa a guarda", seen.length === 1 && isSessionSwitchOk(seen[0].msg));

  // A refusal is a REAL outcome and must reach the caller so the UI can report
  // the fixed sentence for the code.
  seen.length = 0;
  const badId = adapter.switchSession(ROOM_A, "sess-2");
  transport.push({ type: "session_switch_error", in_reply_to: badId, code: "locked", message: "diagnostic detail" }, ROOM_A);
  check("recusa chega como session_switch_error", seen.length === 1 && seen[0].msg.code === "locked");
  check("e o texto exibido é o FIXO, não o do host", switchErrorText(seen[0].msg.code) !== "diagnostic detail");

  // Two rooms stay independent.
  seen.length = 0;
  const a = adapter.readSession(ROOM_A, "s1");
  const b = adapter.readSession(ROOM_B, "s1");
  check("leituras em rooms diferentes têm ids distintos", a !== b);
  check("cada leitura foi para sua room", transport.readCalls.at(-1).room === ROOM_B && transport.readCalls.at(-2).room === ROOM_A);

  adapter.close();
}

// ── 3. pure helpers ─────────────────────────────────────────────────────────

function helpers() {
  console.log("\n== 3. helpers de apresentação ==");
  check("shortSessionId corta no primeiro hífen", shortSessionId("01a0fb4e-b263-7207") === "01a0fb4e");
  check("shortSessionId sem hífen devolve o id", shortSessionId("abc") === "abc");

  check("sessionLabel usa o name", sessionLabel(row({ name: "meu" })) === "meu");
  check("sessionLabel sem name cai no id curto", sessionLabel(row({ name: undefined })) === "01a0fb75");
  check("sessionLabel com só espaços cai no id curto", sessionLabel(row({ name: "   " })) === "01a0fb75");

  const now = 1_760_000_000_000;
  check("just now", relativeTime(now, now) === "just now");
  check("minutos", relativeTime(now - 5 * 60_000, now) === "5m ago");
  check("horas", relativeTime(now - 3 * 3_600_000, now) === "3h ago");
  check("dias", relativeTime(now - 2 * 86_400_000, now) === "2d ago");
  check("meses", relativeTime(now - 90 * 86_400_000, now) === "3mo ago");
  check("anos", relativeTime(now - 400 * 86_400_000, now) === "1y ago");
  check("mtime futuro não gera idade negativa", relativeTime(now + 60_000, now) === "just now");

  const list = [row({ id: "old", mtime: 1 }), row({ id: "new", mtime: 3 }), row({ id: "mid", mtime: 2 })];
  check("sortSessions ordena do mais novo ao mais antigo", sortSessions(list).map((s) => s.id).join(",") === "new,mid,old");
  check("sortSessions não muta a entrada", list.map((s) => s.id).join(",") === "old,new,mid");

  check("previewText colapsa espaços", previewText(row({ preview: "a\n\n  b " })) === "a b");
  check("previewText sem preview é vazio", previewText(row({ preview: undefined })) === "");

  console.log("\n  -- textos FIXOS de recusa --");
  check("locked tem sentença própria", switchErrorText("locked").includes("Pi terminal"));
  check("unknown tem sentença própria", switchErrorText("unknown").includes("no longer exists"));
  check("no_sdk tem sentença própria", switchErrorText("no_sdk").includes("cannot switch sessions"));
  check("código desconhecido cai num texto honesto", switchErrorText("weird") === "The host did not switch to that session.");
  check(
    "os três textos são distintos entre si",
    new Set(["locked", "unknown", "no_sdk"].map(switchErrorText)).size === 3,
  );
}

// ── run ─────────────────────────────────────────────────────────────────────

guards();
await adapterWiring();
helpers();

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
console.log("verify-web-sessions: OK");
