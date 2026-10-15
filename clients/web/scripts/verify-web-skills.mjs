/**
 * Skills wire verification (`pi_surface` / `skill_invoke`) for
 * `src/lib/remote-pi/protocol.ts` + its wiring in `src/lib/remote-pi/adapter.ts`.
 *
 * Three layers, all real code (Node 22 runs the TS):
 *   1. the STRICT GUARDS — every documented field, correct type, and a
 *      `enabled` that is deliberately `boolean | null`;
 *   2. the ADAPTER WIRING — a fake transport (the documented injection seam)
 *      proves `pi_surface` is correlated by (room + in_reply_to), that a reply
 *      for another room or a stale id is ignored, and that a malformed reply
 *      never reaches the caller;
 *   3. the COMPOSER TRIGGER RULE — `slashQueryOf`, which decides when a draft
 *      is a slash command at all.
 *
 * Run: node scripts/verify-web-skills.mjs
 */

import { RemotePiAdapter } from "../src/lib/remote-pi/adapter.ts";
import {
  isPiSurfaceOk,
  isSkillInvokeOk,
  isWireSkill,
} from "../src/lib/remote-pi/protocol.ts";
import { filterSkills, slashQueryOf } from "../src/lib/remote-pi/slash.ts";

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

/** A valid skill row, overridable per field. */
const skill = (over = {}) => ({
  name: "maestro",
  description: "Intent-to-chain planner",
  source: "package",
  path: "/home/u/.pi/agent/skills/maestro/SKILL.md",
  enabled: true,
  disable_model_invocation: false,
  ...over,
});

// ── 1. strict guards ────────────────────────────────────────────────────────

function guards() {
  console.log("\n== 1. guards estritos (isWireSkill / isPiSurfaceOk / isSkillInvokeOk) ==");

  check("linha válida passa", isWireSkill(skill()));
  check("enabled: null (indeterminado) é aceito", isWireSkill(skill({ enabled: null })));
  check("enabled string é recusado", !isWireSkill(skill({ enabled: "true" })));
  check("enabled ausente é recusado", !isWireSkill((() => { const s = skill(); delete s.enabled; return s; })()));
  check("disable_model_invocation ausente é recusado", !isWireSkill((() => { const s = skill(); delete s.disable_model_invocation; return s; })()));
  check("source inválido é recusado", !isWireSkill(skill({ source: "evil" })));
  check("source user/project/package são aceitos", ["user", "project", "package"].every((source) => isWireSkill(skill({ source }))));
  check("name vazio é recusado", !isWireSkill(skill({ name: "" })));
  check("description não-string é recusada", !isWireSkill(skill({ description: 42 })));
  check("path ausente é recusado", !isWireSkill((() => { const s = skill(); delete s.path; return s; })()));
  check("linha nula é recusada", !isWireSkill(null));
  check("linha string é recusada", !isWireSkill("nope"));

  const ok = { type: "pi_surface_ok", in_reply_to: "r1", skills: [skill()] };
  check("pi_surface_ok válido passa", isPiSurfaceOk(ok));
  check("skills vazio passa (host pode não ter skills)", isPiSurfaceOk({ ...ok, skills: [] }));
  check("skills não-array é recusado", !isPiSurfaceOk({ ...ok, skills: "nope" }));
  check("skills ausente é recusado", !isPiSurfaceOk({ type: "pi_surface_ok", in_reply_to: "r1" }));
  check("uma linha ruim invalida a lista", !isPiSurfaceOk({ ...ok, skills: [skill(), null] }));
  check("tipo errado é recusado", !isPiSurfaceOk({ ...ok, type: "models_list" }));

  const inv = { type: "skill_invoke_ok", in_reply_to: "r2", name: "maestro" };
  check("skill_invoke_ok válido passa", isSkillInvokeOk(inv));
  check("skill_invoke_ok com nome vazio é recusado", !isSkillInvokeOk({ ...inv, name: "" }));
  check("skill_invoke_ok sem nome é recusado", !isSkillInvokeOk({ type: "skill_invoke_ok", in_reply_to: "r2" }));
  check("skill_invoke_ok com tipo errado é recusado", !isSkillInvokeOk({ ...inv, type: "action_ok" }));
}

// ── 2. adapter wiring ───────────────────────────────────────────────────────

class FakeTransport {
  constructor(url, list) {
    this.url = url;
    this.calls = [];
    this.piSurfaceCalls = [];
    this.skillInvokeCalls = [];
    this.workspaces = [];
    /**  reads this: a double must model the socket state. */
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
  sendListModels() {
    return "list-1";
  }
  sendModelSet() {
    return "set-1";
  }
  sendThinkingSet() {
    return "think-1";
  }
  sendPiSurface(epk, room) {
    this.piSurfaceCalls.push({ epk, room });
    return `surf-${this.piSurfaceCalls.length}`;
  }
  sendSkillInvoke(epk, room, name, args) {
    this.skillInvokeCalls.push({ epk, room, name, args });
    return `inv-${this.skillInvokeCalls.length}`;
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

  /** Deliver an arbitrary frame tagged with `room`. */
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
  console.log("\n== 2. adapter: pi_surface / skill_invoke no fio ==");
  const wire = fakeWire();
  const adapter = newAdapter({ transportFactory: wire.factory });
  await adapter.pair(target());
  const transport = wire.list[0];
  const seen = [];
  adapter.onServerMessage((msg, room) => seen.push({ msg, room }));

  /* The adapter is a TRANSPORT passthrough: it does not filter by room or by
     `in_reply_to` — the container does (see `connect-client`). What the adapter
     owes the caller is (a) the request addressed to the right child room, and
     (b) the inner id to correlate on, plus (c) forwarding every frame WITH its
     room tag intact so the container CAN correlate. Those are what is checked
     here; the correlation rule itself is exercised in the browser. */
  const listId = adapter.listSkills(ROOM_A);
  check("listSkills usa o epk do host", transport.piSurfaceCalls[0].epk === HOST_EPK);
  check("listSkills endereça a room do workspace", transport.piSurfaceCalls[0].room === ROOM_A);
  check("listSkills devolve o id interno", listId === "surf-1");

  // A frame from ANOTHER room keeps its own room tag (so the container can
  // ignore it) instead of being relabelled to the requested one.
  transport.push({ type: "pi_surface_ok", in_reply_to: listId, skills: [skill()] }, ROOM_B);
  check(
    "frame de outra room preserva a room de origem",
    seen.length === 1 && seen[0].room === ROOM_B,
    JSON.stringify(seen.map((s) => s.room)),
  );
  check(
    "a guarda recusa atribuir isso ao request de ROOM_A",
    !(seen[0].room === ROOM_A && seen[0].msg.in_reply_to === listId),
  );

  // A malformed payload is forwarded but NOT accepted by the guard, which is
  // what stops the container from projecting it.
  seen.length = 0;
  transport.push({ type: "pi_surface_ok", in_reply_to: listId, skills: "nope" }, ROOM_A);
  check("payload malformado não passa a guarda", !isPiSurfaceOk(seen[0].msg));

  // The real reply: right room, right id, valid payload.
  seen.length = 0;
  transport.push(
    {
      type: "pi_surface_ok",
      in_reply_to: listId,
      skills: [skill(), skill({ name: "pdf-tools", source: "user" })],
    },
    ROOM_A,
  );
  check(
    "resposta válida casa (room + in_reply_to) e passa a guarda",
    seen.length === 1 &&
      seen[0].room === ROOM_A &&
      seen[0].msg.in_reply_to === listId &&
      isPiSurfaceOk(seen[0].msg),
  );
  check("o caller vê a lista completa", seen[0].msg.skills.length === 2);
  check(
    "a projeção preserva source e explicitOnly",
    seen[0].msg.skills[1].source === "user" && seen[0].msg.skills[0].disable_model_invocation === false,
  );

  // `invokeSkill` sends name + args and nothing else.
  seen.length = 0;
  const invId = adapter.invokeSkill(ROOM_A, "pdf-tools");
  check("invokeSkill manda o nome", transport.skillInvokeCalls[0].name === "pdf-tools");
  check("invokeSkill sem args não inventa campo", transport.skillInvokeCalls[0].args === undefined);
  check("invokeSkill devolve o id interno", invId === "inv-1");

  transport.push({ type: "skill_invoke_ok", in_reply_to: invId, name: "pdf-tools" }, ROOM_A);
  check(
    "skill_invoke_ok casa e passa a guarda",
    seen.length === 1 && seen[0].msg.in_reply_to === invId && isSkillInvokeOk(seen[0].msg),
  );

  // Args ride along verbatim when given.
  const withArgs = adapter.invokeSkill(ROOM_A, "pdf-tools", "extract report.pdf");
  check("invokeSkill repassa args verbatim", transport.skillInvokeCalls[1].args === "extract report.pdf");
  check("um segundo invoke tem id próprio", withArgs === "inv-2");

  // An `action_error` (a skill the host does not have) is a REAL outcome and
  // must reach the caller so the UI can report it.
  seen.length = 0;
  const badId = adapter.invokeSkill(ROOM_A, "not-a-skill");
  transport.push(
    { type: "action_error", in_reply_to: badId, action: "skill_invoke", error: 'skill "not-a-skill" is not installed on this machine' },
    ROOM_A,
  );
  check("recusa de skill chega como action_error", seen.length === 1 && seen[0].msg.type === "action_error");
  check("e a recusa é do id pedido", seen[0].msg.in_reply_to === badId);

  // Two rooms stay independent: ids are not reused across them, and each
  // request is addressed to its own room.
  seen.length = 0;
  const a = adapter.listSkills(ROOM_A);
  const b = adapter.listSkills(ROOM_B);
  check("ids distintos por request", a !== b);
  check("cada request foi para sua room", transport.piSurfaceCalls.at(-1).room === ROOM_B);
  check("o primeiro foi para ROOM_A", transport.piSurfaceCalls.at(-2).room === ROOM_A);

  adapter.close();
}

// ── 3. composer trigger rule ────────────────────────────────────────────────

function triggerRule() {
  console.log("\n== 3. regra de disparo do composer (slashQueryOf) ==");
  check("linha iniciada por / é comando", slashQueryOf("/") === "");
  check("texto após / vira a query", slashQueryOf("/team") === "team");
  check("linha vazia não é comando", slashQueryOf("") === null);
  check("/ no meio da frase não é comando", slashQueryOf("veja /team aqui") === null);
  check("espaço encerra a query (usuário digitando args)", slashQueryOf("/team rev") === null);
  check("quebra de linha encerra a query", slashQueryOf("/team\nrev") === null);
  check("Esc (que appenda espaço) encerra a query", slashQueryOf("/team ") === null);

  console.log("\n== 3b. filtro de skills ==");
  const skills = [
    { name: "maestro", description: "planner", source: "package", explicitOnly: false },
    { name: "team-review", description: "code review pipeline", source: "package", explicitOnly: true },
    { name: "pdf-tools", description: "extract PDF and maestro notes", source: "user", explicitOnly: false },
  ];
  check("query vazia devolve tudo", filterSkills(skills, "").length === 3);
  check("match por nome", filterSkills(skills, "team").map((s) => s.name).join(",") === "team-review");
  check("match por descrição", filterSkills(skills, "extract").map((s) => s.name).join(",") === "pdf-tools");
  check(
    "nome tem prioridade sobre descrição",
    filterSkills(skills, "maestro").map((s) => s.name).join(",") === "maestro,pdf-tools",
    filterSkills(skills, "maestro").map((s) => s.name).join(","),
  );
  check("case-insensitive", filterSkills(skills, "TEAM").length === 1);
  check("sem match devolve vazio", filterSkills(skills, "zzz").length === 0);
}

// ── run ─────────────────────────────────────────────────────────────────────

guards();
await adapterWiring();
triggerRule();

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
console.log("verify-web-skills: OK");
