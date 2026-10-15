/**
 * Wave 4 host-forward chat reducer verification for `src/lib/remote-pi/chat.ts`
 * (plan 69 W4): the PURE reducer (`reduceChat`/`canSubmit`) and the UI
 * projection (`visibleChatItems`).
 *
 * Node 22 runs the TypeScript directly. No relay, no socket, no browser, no
 * adapter, no wire: only typed `ChatEvent`s go in and `ChatState` comes out.
 *
 * The regression under test (confirmed bug): a turn the host has NOT echoed
 * yet (`awaiting_echo`) must contribute ZERO items — no optimistic user bubble
 * and no agent placeholder. The user item appears only together with the
 * agent item, after an EXACT echo (same room + id) or a terminal settle.
 *
 * Run: node scripts/verify-web-chat.mjs
 */

import {
  canSubmit,
  initialChatState,
  reduceChat,
  visibleChatItems,
} from "../src/lib/remote-pi/chat.ts";

const ROOM = "room-host-forward";
const OTHER_ROOM = "room-elsewhere";
const ID = "turn-1";
const OTHER_ID = "turn-unknown";

/** Mirrors the private CHAT_HISTORY_LIMIT in chat.ts (contract, not a detail). */
const HISTORY_LIMIT = 100;

let checks = 0;
let failures = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function submitEvent({ roomId = ROOM, id = ID, text = "olá", attempt = 1, retryRisk = false } = {}) {
  return { type: "submit", roomId, text, id, attempt, retryRisk };
}
const echo = (roomId = ROOM, id = ID) => ({ type: "echo", roomId, id });
const chunk = (delta, roomId = ROOM, id = ID) => ({ type: "chunk", roomId, id, delta });
const done = (roomId = ROOM, id = ID) => ({ type: "done", roomId, id });
const error = (code, roomId = ROOM, id = ID) => ({ type: "error", roomId, id, code });
const timeout = (roomId = ROOM, id = ID) => ({ type: "timeout", roomId, id });
const disconnected = (roomId = ROOM, id) =>
  id === undefined ? { type: "disconnected", roomId } : { type: "disconnected", roomId, id };
const RESET = { type: "reset" };

const kinds = (state) => visibleChatItems(state).map((item) => item.kind);
const userItems = (state) => visibleChatItems(state).filter((item) => item.kind === "user");
const agentItems = (state) => visibleChatItems(state).filter((item) => item.kind === "agent");
const ids = (state) => visibleChatItems(state).map((item) => item.id);

/** Replays events from the pristine initial state (or a supplied base). */
function run(events, base = initialChatState) {
  return events.reduce((state, event) => reduceChat(state, event), base);
}

const submitted = reduceChat(initialChatState, submitEvent({ text: "pergunta", attempt: 3, retryRisk: true }));
const streaming = reduceChat(submitted, echo());
const settled = reduceChat(streaming, done());

// ── A. initial state ────────────────────────────────────────────────────────
console.log("\nA. initial state");
check("initialChatState.active é null", initialChatState.active === null);
check("initialChatState.history é vazio", initialChatState.history.length === 0);
check("projeção inicial é vazia", visibleChatItems(initialChatState).length === 0);
check("canSubmit(initial) é true", canSubmit(initialChatState) === true);

// ── B. submit → awaiting_echo é INVISÍVEL (regressão) ───────────────────────
console.log("\nB. submit pendente (awaiting_echo) não emite bolha");
check("submit entra em phase awaiting_echo", submitted.active?.phase === "awaiting_echo");
check("submit preserva roomId exato", submitted.active?.roomId === ROOM);
check("submit preserva id exato", submitted.active?.id === ID);
check("submit preserva text exato", submitted.active?.text === "pergunta");
check("submit preserva attempt", submitted.active?.attempt === 3);
check("submit preserva retryRisk", submitted.active?.retryRisk === true);
check("submit zera echoed", submitted.active?.echoed === false);
check("submit zera response", submitted.active?.response === "");
check("submit zera error", submitted.active?.error === null);
check("NÃO há item user otimista", userItems(submitted).length === 0);
check("NÃO há item agent", agentItems(submitted).length === 0);
check("projeção de await_echo é totalmente vazia", visibleChatItems(submitted).length === 0);
check("canSubmit é false enquanto awaiting_echo", canSubmit(submitted) === false);
check("submit não arquiva nada em history", submitted.history.length === 0);

// ── C. echo ─────────────────────────────────────────────────────────────────
console.log("\nC. echo exato → user + agent");
check("echo com room errada é no-op", reduceChat(submitted, echo(OTHER_ROOM)).active?.phase === "awaiting_echo");
check("echo com id errado é no-op", reduceChat(submitted, echo(ROOM, OTHER_ID)).active?.phase === "awaiting_echo");
check("echo exato vira phase streaming", streaming.active?.phase === "streaming");
check("echo exato marca echoed", streaming.active?.echoed === true);
check("canSubmit é false durante streaming", canSubmit(streaming) === false);
check("após echo a projeção tem exatamente 2 itens", visibleChatItems(streaming).length === 2);
check("ordem é user→agent", kinds(streaming).join(",") === "user,agent");
check("item user carrega o texto submetido", userItems(streaming)[0]?.text === "pergunta");
check("item user carrega o id exato", userItems(streaming)[0]?.id === ID);
check("item agent carrega a room exata", agentItems(streaming)[0]?.roomId === ROOM);
check("item agent está em phase streaming", agentItems(streaming)[0]?.phase === "streaming");
check("item agent começa com texto vazio", agentItems(streaming)[0]?.text === "");
check("echo duplicado é no-op (sem 3º item)", visibleChatItems(reduceChat(streaming, echo())).length === 2);
check("echo repetido não reabre awaiting_echo", reduceChat(streaming, echo()).active?.phase === "streaming");
check("echo não arquiva em history", streaming.history.length === 0);

// ── D. chunk ────────────────────────────────────────────────────────────────
console.log("\nD. chunk (somente depois do echo)");
check("chunk antes do echo é ignorado", reduceChat(submitted, chunk("x")).active?.response === "");
const chunked = run([submitEvent(), echo(), chunk("a"), chunk("b")]);
check("chunk acumula primeiro delta", reduceChat(streaming, chunk("a")).active?.response === "a");
check("chunk acumula concatenando exato", chunked.active?.response === "ab");
check("chunks idênticos são preservados (sem dedup)", reduceChat(run([submitEvent(), echo(), chunk("same")]), chunk("same")).active?.response === "samesame");
check("chunk com room errada é ignorado", reduceChat(streaming, chunk("z", OTHER_ROOM)).active?.response === "");
check("chunk com id errado é ignorado", reduceChat(streaming, chunk("z", ROOM, OTHER_ID)).active?.response === "");
check("chunk não altera a phase", reduceChat(streaming, chunk("z")).active?.phase === "streaming");
check("chunk aparece no item agent", agentItems(reduceChat(streaming, chunk("oi")))[0]?.text === "oi");

// ── E. done ─────────────────────────────────────────────────────────────────
console.log("\nE. done");
check("done com room errada é no-op", reduceChat(streaming, done(OTHER_ROOM)).active?.phase === "streaming");
check("done com id errado é no-op", reduceChat(streaming, done(ROOM, OTHER_ID)).active?.phase === "streaming");
check("done exato encerra o ativo", settled.active === null);
check("done exato arquiva em history", settled.history.length === 1);
check("done exato vira phase completed", settled.history[0]?.phase === "completed");
check("done preserva a resposta acumulada", run([submitEvent(), echo(), chunk("ab"), done()]).history[0]?.response === "ab");
check("done antes do echo é ignorado", reduceChat(submitted, done()).active?.phase === "awaiting_echo");
check("done antes do echo não arquiva", reduceChat(submitted, done()).history.length === 0);
check("done duplicado é no-op", reduceChat(settled, done()).history.length === 1);
check("chunk após done é no-op", run([submitEvent(), echo(), done(), chunk("late")]).history[0]?.response === "");
check("canSubmit volta a true após done", canSubmit(settled) === true);
check("projeção após done é user+agent", kinds(settled).join(",") === "user,agent");
check("item agent após done está completed", agentItems(settled)[0]?.phase === "completed");
check("item agent após done tem error null", agentItems(settled)[0]?.error === null);

// ── F. turno desconhecido ───────────────────────────────────────────────────
console.log("\nF. eventos de turno desconhecido");
check("echo desconhecido é no-op sem ativo", reduceChat(initialChatState, echo(ROOM, OTHER_ID)) === initialChatState);
check("chunk desconhecido é no-op sem ativo", reduceChat(initialChatState, chunk("z", ROOM, OTHER_ID)) === initialChatState);
check("done desconhecido é no-op sem ativo", reduceChat(initialChatState, done(ROOM, OTHER_ID)) === initialChatState);
check("error desconhecido é no-op sem ativo", reduceChat(initialChatState, error("unknown_turn", ROOM, OTHER_ID)) === initialChatState);
check("timeout desconhecido é no-op sem ativo", reduceChat(initialChatState, timeout(ROOM, OTHER_ID)) === initialChatState);
check("disconnected desconhecido é no-op sem ativo", reduceChat(initialChatState, disconnected(ROOM, OTHER_ID)) === initialChatState);
check("echo de outro id não perturba o ativo", reduceChat(streaming, echo(ROOM, OTHER_ID)).active?.echoed === true);
check("done de outro id não encerra o ativo", reduceChat(streaming, done(ROOM, OTHER_ID)).active !== null);
check("error de outra room não encerra o ativo", reduceChat(streaming, error("busy", OTHER_ROOM)).active !== null);
check("history nunca ganha item de turno desconhecido", reduceChat(streaming, done(ROOM, OTHER_ID)).history.length === 0);

// ── G. busy / um-por-vez ────────────────────────────────────────────────────
console.log("\nG. busy (um in-flight)");
const busyWhilePending = reduceChat(submitted, submitEvent({ id: "turn-2", text: "segunda" }));
check("submit durante awaiting_echo é rejeitado", busyWhilePending === submitted);
check("submit durante awaiting_echo mantém o id original", busyWhilePending.active?.id === ID);
const busyWhileStreaming = reduceChat(streaming, submitEvent({ id: "turn-2", text: "segunda" }));
check("submit durante streaming é rejeitado", busyWhileStreaming === streaming);
check("submit durante streaming não altera history", busyWhileStreaming.history.length === 0);
check("canSubmit é false durante awaiting_echo", canSubmit(submitted) === false);
check("canSubmit é false durante streaming", canSubmit(streaming) === false);
check("submit pendente rejeitado não emite bolha extra", visibleChatItems(busyWhilePending).length === 0);

// ── H. error ────────────────────────────────────────────────────────────────
console.log("\nH. error");
const errored = reduceChat(streaming, error("action_rejected"));
check("error exato encerra o ativo", errored.active === null);
check("error exato arquiva 1 turno", errored.history.length === 1);
check("error exato grava phase error", errored.history[0]?.phase === "error");
check("error exato preserva o código", errored.history[0]?.error === "action_rejected");
check("error visível emite user+agent", kinds(errored).join(",") === "user,agent");
check("item agent expõe o código de erro", agentItems(errored)[0]?.error === "action_rejected");
check("error antes do echo liquida e fica visível", visibleChatItems(reduceChat(submitted, error("not_connected"))).length === 2);
check("error antes do echo mantém phase de status fixa", agentItems(reduceChat(submitted, error("not_connected")))[0]?.phase === "error");
check("error antes do echo preserva o texto do user", userItems(reduceChat(submitted, error("not_connected")))[0]?.text === "pergunta");
check("error após completed é no-op", reduceChat(settled, error("action_rejected")).history[0]?.phase === "completed");
check("error duplicado não duplica history", reduceChat(errored, error("action_rejected")).history.length === 1);
check("canSubmit true após error", canSubmit(errored) === true);

// ── I. timeout ──────────────────────────────────────────────────────────────
console.log("\nI. timeout");
const timedOut = reduceChat(streaming, timeout());
check("timeout exato encerra o ativo", timedOut.active === null);
check("timeout grava phase timed_out", timedOut.history[0]?.phase === "timed_out");
check("timeout grava o código timeout", timedOut.history[0]?.error === "timeout");
check("timeout visível emite user+agent", kinds(timedOut).join(",") === "user,agent");
check("timeout antes do echo fica visível", visibleChatItems(reduceChat(submitted, timeout())).length === 2);
check("timeout antes do echo usa phase fixa timed_out", agentItems(reduceChat(submitted, timeout()))[0]?.phase === "timed_out");
check("timeout não altera a resposta acumulada", run([submitEvent(), echo(), chunk("ab"), timeout()]).history[0]?.response === "ab");
check("canSubmit true após timeout", canSubmit(timedOut) === true);
check("timeout duplicado é no-op", reduceChat(timedOut, timeout()).history.length === 1);

// ── J. disconnected ─────────────────────────────────────────────────────────
console.log("\nJ. disconnected");
const dropped = reduceChat(streaming, disconnected(ROOM, ID));
check("disconnected com id exato encerra o ativo", dropped.active === null);
check("disconnected grava phase disconnected", dropped.history[0]?.phase === "disconnected");
check("disconnected grava o código disconnected", dropped.history[0]?.error === "disconnected");
const droppedNoId = reduceChat(streaming, disconnected());
check("disconnected sem id liquida o ativo da room", droppedNoId.active === null);
check("disconnected sem id arquiva 1 turno", droppedNoId.history.length === 1);
check("disconnected antes do echo fica visível", visibleChatItems(reduceChat(submitted, disconnected())).length === 2);
check("disconnected antes do echo usa phase fixa", agentItems(reduceChat(submitted, disconnected()))[0]?.phase === "disconnected");
check("disconnected com room errada é no-op", reduceChat(streaming, disconnected(OTHER_ROOM, ID)) === streaming);
check("canSubmit true após disconnected", canSubmit(dropped) === true);

// ── K. reset ────────────────────────────────────────────────────────────────
console.log("\nK. reset");
const afterReset = reduceChat(settled, RESET);
check("reset zera o ativo", afterReset.active === null);
check("reset zera o history", afterReset.history.length === 0);
check("reset deixa a projeção vazia", visibleChatItems(afterReset).length === 0);
check("reset em pending zera também", reduceChat(submitted, RESET).history.length === 0);
check("reset não muta o estado anterior", settled.history.length === 1 && settled.active === null);
check("canSubmit true após reset", canSubmit(afterReset) === true);

// ── L. cap do history ───────────────────────────────────────────────────────
console.log("\nL. cap do history (100)");
const many = Array.from({ length: HISTORY_LIMIT + 1 }, (_, index) => [
  submitEvent({ id: `t-${index}`, text: `msg-${index}` }),
  echo(ROOM, `t-${index}`),
  chunk("x", ROOM, `t-${index}`),
  done(ROOM, `t-${index}`),
]).flat();
const capped = run(many);
check(`history satura em ${HISTORY_LIMIT}`, capped.history.length === HISTORY_LIMIT);
check("o turno mais antigo é descartado", capped.history[0]?.id === "t-1");
check("o turno mais novo é preservado", capped.history.at(-1)?.id === `t-${HISTORY_LIMIT}`);
check(`projeção do cap tem ${HISTORY_LIMIT * 2} itens`, visibleChatItems(capped).length === HISTORY_LIMIT * 2);
check("projeção do cap alterna user/agent", visibleChatItems(capped)[0]?.kind === "user" && visibleChatItems(capped)[1]?.kind === "agent");
check("projeção do cap não repete ids", new Set(ids(capped)).size === HISTORY_LIMIT);
check("cap sobrevive a um novo submit pendente (invisível)", visibleChatItems(reduceChat(capped, submitEvent({ id: "t-final" }))).length === HISTORY_LIMIT * 2);
check("submit após done não duplica o turno já arquivado", reduceChat(settled, submitEvent({ id: "t-2" })).history.length === 1);
check("turno arquivado mantém phase completed", reduceChat(settled, submitEvent({ id: "t-2" })).history[0]?.phase === "completed");
check("submit terminal mantém só o novo ativo", reduceChat(settled, submitEvent({ id: "t-2" })).active?.id === "t-2");

// ── M. provider_error (turno falho reportado pelo host) ─────────────────────
//
// F1 regression: the host reports a FAILED turn as
// `{type:'error', code:'provider_error', in_reply_to:<turnId>}` (see
// remote-pi/src/index.ts `message_end`). The reducer must settle the EXACT
// correlated turn as a distinct, safe failure kind — before OR after the echo
// — and a `done`/`timeout` that arrives afterwards must NOT turn the failed
// turn back into a success.
console.log("\nM. provider_error");

// M.1 — falha ANTES do echo: o turno correlacionado fica visível e settle-ado.
const failedBeforeEcho = reduceChat(submitted, error("provider_error"));
check("provider_error antes do echo encerra o ativo", failedBeforeEcho.active === null);
check("provider_error antes do echo arquiva 1 turno", failedBeforeEcho.history.length === 1);
check("provider_error antes do echo grava phase error", failedBeforeEcho.history[0]?.phase === "error");
check(
  "provider_error antes do echo grava o código distinto",
  failedBeforeEcho.history[0]?.error === "provider_error",
);
check("provider_error antes do echo emite user+agent", kinds(failedBeforeEcho).join(",") === "user,agent");
check(
  "provider_error antes do echo preserva o texto do user",
  userItems(failedBeforeEcho)[0]?.text === "pergunta",
);
check("provider_error antes do echo não acumula resposta", agentItems(failedBeforeEcho)[0]?.text === "");
check("canSubmit volta a true após provider_error", canSubmit(failedBeforeEcho) === true);

// M.2 — falha DEPOIS do echo: preserva os chunks já recebidos.
const failedAfterEcho = run([submitEvent(), echo(), chunk("parcial"), error("provider_error")]);
check("provider_error após o echo encerra o ativo", failedAfterEcho.active === null);
check("provider_error após o echo grava phase error", failedAfterEcho.history[0]?.phase === "error");
check("provider_error após o echo preserva o código", failedAfterEcho.history[0]?.error === "provider_error");
check(
  "provider_error após o echo preserva os chunks já acumulados",
  failedAfterEcho.history[0]?.response === "parcial",
);
check("canSubmit volta a true após falha tardia", canSubmit(failedAfterEcho) === true);

// M.3 — correlação: room/id errados NÃO podem liquidar o turno ativo.
check("provider_error de outra room é no-op", reduceChat(streaming, error("provider_error", OTHER_ROOM)) === streaming);
check("provider_error de outro id é no-op", reduceChat(streaming, error("provider_error", ROOM, OTHER_ID)) === streaming);
check(
  "provider_error de outro id não arquiva nada",
  reduceChat(streaming, error("provider_error", ROOM, OTHER_ID)).history.length === 0,
);
check(
  "provider_error de outra room mantém o ativo em streaming",
  reduceChat(streaming, error("provider_error", OTHER_ROOM)).active?.phase === "streaming",
);
check(
  "provider_error sem turno ativo é no-op no estado inicial",
  reduceChat(initialChatState, error("provider_error", ROOM, OTHER_ID)) === initialChatState,
);

// M.4 — o código é DISTINTO de action_rejected e os dois não se confundem.
check(
  "provider_error e action_rejected são códigos distintos",
  reduceChat(streaming, error("provider_error")).history[0]?.error === "provider_error" &&
    reduceChat(streaming, error("action_rejected")).history[0]?.error === "action_rejected",
);
check(
  "o código da falha sobrevive à projeção",
  agentItems(failedAfterEcho)[0]?.error === "provider_error",
);

// M.5 — um `done`/`timeout` POSTERIOR não pode tornar o turno falho bem-sucedido.
const lateDone = run([submitEvent(), echo(), error("provider_error"), done()]);
check("done após provider_error não reabre o ativo", lateDone.active === null);
check("done após provider_error não arquiva um 2º turno", lateDone.history.length === 1);
check("done após provider_error mantém phase error", lateDone.history[0]?.phase === "error");
check("done após provider_error mantém o código de falha", lateDone.history[0]?.error === "provider_error");
check("done após provider_error não duplica a projeção", visibleChatItems(lateDone).length === 2);
check(
  "provider_error duplicado não duplica history",
  reduceChat(failedAfterEcho, error("provider_error")).history.length === 1,
);
const lateTimeoutAfterFailure = run([submitEvent(), error("provider_error"), timeout()]);
check("timeout após provider_error não reabre o ativo", lateTimeoutAfterFailure.active === null);
check("timeout após provider_error mantém phase error", lateTimeoutAfterFailure.history[0]?.phase === "error");
check("timeout após provider_error mantém o código provider_error", lateTimeoutAfterFailure.history[0]?.error === "provider_error");
check("timeout após provider_error não arquiva um 2º turno", lateTimeoutAfterFailure.history.length === 1);
check("canSubmit true após a sequência falha+done", canSubmit(lateDone) === true);
check("canSubmit true após a sequência falha+timeout", canSubmit(lateTimeoutAfterFailure) === true);

// M.6 — um NOVO turno continua possível depois da falha (retry é explícito).
const retriedAfterFailure = reduceChat(failedAfterEcho, submitEvent({ id: "turn-2", text: "de novo" }));
check("novo submit após provider_error abre novo ativo", retriedAfterFailure.active?.id === "turn-2");
check(
  "novo submit após provider_error mantém a falha no history",
  retriedAfterFailure.history[0]?.error === "provider_error",
);
check("canSubmit false no novo turno pendente", canSubmit(retriedAfterFailure) === false);

// ── N. retryRisk / attempt ──────────────────────────────────────────────────
console.log("\nN. retryRisk e attempt");
check("retryRisk true é preservado no submetido", submitted.active?.retryRisk === true);
check("retryRisk false é o default do evento", reduceChat(initialChatState, submitEvent()).active?.retryRisk === false);
check("retryRisk aparece no item agent", agentItems(streaming)[0]?.retryRisk === true);
check("attempt aparece no item agent", agentItems(streaming)[0]?.attempt === 3);
check("retryRisk sobrevive ao timeout", run([submitEvent({ retryRisk: true }), echo(), timeout()]).history[0]?.retryRisk === true);
check("retryRisk sobrevive ao error", run([submitEvent({ retryRisk: true }), echo(), error("action_rejected")]).history[0]?.retryRisk === true);
check("retryRisk sobrevive ao disconnected", run([submitEvent({ retryRisk: true }), echo(), disconnected()]).history[0]?.retryRisk === true);
check("retryRisk do arquivado mantém true", reduceChat(settled, submitEvent({ id: "t-2" })).history[0]?.retryRisk === true);
check("projeção do retry pendente mostra só o turno arquivado", visibleChatItems(reduceChat(settled, submitEvent({ id: "t-2" }))).length === 2);
const retried = run([submitEvent({ attempt: 1, retryRisk: true }), echo(), timeout(), submitEvent({ attempt: 2, retryRisk: false })]);
check("retry usa novo attempt", retried.active?.attempt === 2);
check("retry usa novo retryRisk", retried.active?.retryRisk === false);
check("retry mantém a tentativa falha no history", retried.history[0]?.attempt === 1);

// ── O. pureza, sem wire, sem segredo ────────────────────────────────────────
console.log("\nO. pureza / sem wire / sem segredo");
const before = JSON.stringify(initialChatState);
check("reduceChat não muta o estado de entrada", JSON.stringify(initialChatState) === before && initialChatState.active === null);
const eventSnapshot = JSON.stringify(submitEvent());
check("reduceChat não muta o evento", JSON.stringify(submitEvent()) === eventSnapshot);
check("estado tem exatamente as chaves active/history/tools", Object.keys(submitted).sort().join(",") === "active,history,tools");
check("turno não carrega campos extras de wire", Object.keys(submitted.active).sort().join(",") === "attempt,echoed,error,id,phase,response,retryRisk,roomId,text");
check("item user carrega só campos de projeção", Object.keys(userItems(streaming)[0]).sort().join(",") === "id,kind,roomId,text");
check("item agent carrega status fixo", Object.keys(agentItems(streaming)[0]).sort().join(",") === "attempt,error,id,kind,phase,retryRisk,roomId,text");
check("texto pendente não vaza na projeção", !JSON.stringify(visibleChatItems(submitted)).includes("pergunta"));
check("texto pendente vaza só após echo", JSON.stringify(visibleChatItems(streaming)).includes("pergunta"));
check("nenhum segredo/token na projeção", !/token|secret|password|epk|pair/i.test(JSON.stringify(visibleChatItems(capped))));
check("sem dedup: ids iguais geram itens distintos", visibleChatItems(run([submitEvent({ id: "dup" }), echo(ROOM, "dup"), done(ROOM, "dup"), submitEvent({ id: "dup" }), echo(ROOM, "dup"), done(ROOM, "dup")])).length === 4);
check("sem dedup: history mantém os dois turnos de id igual", run([submitEvent({ id: "dup" }), echo(ROOM, "dup"), done(ROOM, "dup"), submitEvent({ id: "dup" }), echo(ROOM, "dup"), done(ROOM, "dup")]).history.length === 2);
check("evento default é no-op", reduceChat(settled, { type: "bogus" }) === settled);
check("todos os estados derivados são objetos novos", streaming !== submitted && settled !== streaming);
check(
  "o turno falho não carrega nenhum campo de wire",
  Object.keys(failedAfterEcho.history[0]).sort().join(",") ===
    "attempt,echoed,error,id,phase,response,retryRisk,roomId,text",
);
// M.7 — a projeção do turno falho é EXATAMENTE a esperada: nenhum campo de
// wire, nenhum texto de provider, nenhum código bruto. (Reconstruído a partir
// do mesmo `submitted` compartilhado: texto/attempt/retryRisk exatos.)
const failedFromSubmitted = run([submitEvent(), echo(), chunk("parcial"), error("provider_error")], submitted);
check(
  "a projeção da falha não vaza texto de provider",
  JSON.stringify(visibleChatItems(failedFromSubmitted)) ===
    JSON.stringify([
      { kind: "user", id: ID, roomId: ROOM, text: "pergunta" },
      {
        kind: "agent",
        id: ID,
        roomId: ROOM,
        text: "parcial",
        phase: "error",
        error: "provider_error",
        retryRisk: true,
        attempt: 3,
      },
    ]),
);

// ── P. tool cards (Pi tool_request / tool_result) ─────────────────────────
console.log("\nP. tool cards");
/** A turn that is open (echoed + streaming) — the state a tool frame may join. */
const stateWithOpenTurn = () => run([submitEvent(), echo()], initialChatState);
const toolStart = (toolCallId = "tc-1", tool = "Bash", argsText = '{"cmd":"ls"}', roomId = ROOM) => ({
  type: "tool_start",
  roomId,
  toolCallId,
  tool,
  argsText,
});
const toolEnd = (toolCallId = "tc-1", ok = true, resultText = "ok", roomId = ROOM) => ({
  type: "tool_end",
  roomId,
  toolCallId,
  ok,
  resultText,
});

// A tool frame with NO open turn is not this transcript's business.
const toolNoTurn = reduceChat(initialChatState, toolStart());
check("tool_start sem turno ativo é no-op", toolNoTurn.tools.length === 0);
// Another room's tool frame is ignored.
const toolOtherRoom = reduceChat(stateWithOpenTurn(), toolStart("tc-x", "Bash", "{}", OTHER_ROOM));
check("tool_start de outra room não entra", toolOtherRoom.tools.length === 0);
// The active turn's room adopts it.
const withTool = reduceChat(stateWithOpenTurn(), toolStart());
check("tool_start do turno ativo registra 1 cartão", withTool.tools.length === 1);
check("cartão preserva id/tool/args exatos", withTool.tools[0].id === "tc-1" && withTool.tools[0].tool === "Bash" && withTool.tools[0].argsText === '{"cmd":"ls"}');
check("cartão começa sem desfecho", withTool.tools[0].outcome === null);
// A re-announced id does not duplicate.
const dupTool = reduceChat(withTool, toolStart());
check("tool_start repetido não duplica", dupTool.tools.length === 1);
// Outcome lands on the matching id.
const doneTool = reduceChat(withTool, toolEnd("tc-1", true, "saída"));
check("tool_end exato grava sucesso", doneTool.tools[0].outcome?.ok === true && doneTool.tools[0].outcome?.resultText === "saída");
// A failure outcome keeps the card and marks it failed.
const failTool = reduceChat(withTool, toolEnd("tc-1", false));
check("tool_end com erro marca falha (sem texto host)", failTool.tools[0].outcome?.ok === false);
// An end for an unknown id is a no-op.
const strayEnd = reduceChat(withTool, toolEnd("tc-unknown", true));
check("tool_end de id desconhecido é no-op", strayEnd === withTool);
// A new submit (after the previous turn settled) resets the tool list.
const newTurn = reduceChat(
  reduceChat(doneTool, { type: "done", roomId: ROOM, id: ID }),
  submitEvent({ id: "turn-2" }),
);
check("novo submit zera a lista de tools", newTurn.tools.length === 0);
// reset clears them too.
const resetTools = reduceChat(withTool, { type: "reset" });
check("reset limpa tools", resetTools.tools.length === 0 && resetTools.active === null);
// The list is bounded.
let manyTools = withTool;
for (let i = 0; i < 60; i += 1) manyTools = reduceChat(manyTools, toolStart(`tc-${i}`, "Bash", "{}"));
check("lista de tools é limitada", manyTools.tools.length <= 50);

console.log(`\n${checks - failures}/${checks} checks PASS`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-chat: OK");
