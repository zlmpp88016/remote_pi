/**
 * Stream coalescing verification for the chat commit path.
 *
 * The defect under test: `agent_chunk` arrives once per model delta — orders of
 * magnitude faster than the display refresh. Committing each delta forces one
 * React render plus a full Markdown re-parse of the accumulated reply, so a
 * streaming answer competes with the composer for the main thread and feels
 * mushy.
 *
 * The fix (connect-client.tsx `dispatchChat`) folds every delta into the state
 * ref IMMEDIATELY — so no delta is ever lost and a same-tick reader already sees
 * the full text — while the React commit is deferred to the next animation
 * frame. One paint = one commit, however many deltas landed in it.
 *
 * This script exercises the REAL reducer (`reduceChat`) and re-implements the
 * commit policy expression-for-expression from `dispatchChat`, because the hook
 * itself is not importable (it lives inside a React component). Every policy
 * claim below is therefore checked twice: against the reducer, which is the
 * source of truth for text, and against the coalescer, which is the source of
 * truth for how often the text is published.
 *
 * Run: node scripts/verify-web-chat-stream.mjs
 */

import {
  canSubmit,
  initialChatState,
  reduceChat,
  visibleChatItems,
} from "../src/lib/remote-pi/chat.ts";

const ROOM = "room-stream";
const ID = "turn-stream";

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
 * Minimal model of the commit policy in `dispatchChat`. It mirrors the real
 * control flow, including the two properties that matter:
 *   • a chunk folds into `state` synchronously and never schedules twice;
 *   • any non-chunk event cancels the queued frame and commits immediately.
 */
function createCoalescer() {
  let state = initialChatState;
  let frameQueued = false;
  let commits = 0;
  const published = [];

  return {
    get state() {
      return state;
    },
    get commits() {
      return commits;
    },
    get frameQueued() {
      return frameQueued;
    },
    /** The text a same-tick reader would see (the ref), not what was painted. */
    currentText() {
      return state.active?.response ?? "";
    },
    /** The text of the turn the UI would draw, whether it is still active or
     *  has already settled into history. `done` archives the turn, so reading
     *  only `active` would look like the text vanished. */
    settledText() {
      const turns = state.active === null ? state.history : [...state.history, state.active];
      return turns.length === 0 ? "" : turns[turns.length - 1].response;
    },
    publishedTexts() {
      return published.slice();
    },
    dispatch(event) {
      const next = reduceChat(state, event);
      if (next === state) return false;
      state = next;
      if (event.type === "chunk" && frameQueued) return true;
      if (event.type === "chunk") {
        frameQueued = true;
      } else {
        frameQueued = false;
        commits += 1;
        published.push(this.settledText());
      }
      return true;
    },
    /** Simulates the animation frame firing. */
    flushFrame() {
      if (!frameQueued) return false;
      frameQueued = false;
      commits += 1;
      published.push(this.settledText());
      return true;
    },
  };
}

const chunk = (delta, id = ID, roomId = ROOM) => ({ type: "chunk", roomId, id, delta });

// ── A. many deltas, one commit ──────────────────────────────────────────────
console.log("\nA. N deltas dentro de um frame = 1 commit");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "go", id: ID, attempt: 1, retryRisk: false });
  c.dispatch({ type: "echo", roomId: ROOM, id: ID });
  const baseline = c.commits; // submit + echo, both synchronous phase edges

  const deltas = ["Hel", "lo", ", ", "wor", "ld", "!", " And", " more", ".", "."];
  for (const d of deltas) c.dispatch(chunk(d));

  check("nenhum delta perdeu texto (ref tem tudo)", c.currentText() === deltas.join(""));
  check("nenhum frame foi publicado ainda", c.commits === baseline);
  check("exatamente 1 frame ficou agendado", c.frameQueued === true);

  c.flushFrame();
  check("o frame publica 1 vez", c.commits === baseline + 1);
  check("o texto publicado é o acumulado completo", c.publishedTexts().at(-1) === deltas.join(""));
  check("o frame não fica re-agendado", c.frameQueued === false);
}

// ── B. a second batch reuses the queued frame ───────────────────────────────
console.log("\nB. um segundo lote no mesmo frame não agenda outro");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "go", id: ID, attempt: 1, retryRisk: false });
  c.dispatch({ type: "echo", roomId: ROOM, id: ID });
  const baseline = c.commits;

  c.dispatch(chunk("a"));
  c.dispatch(chunk("b"));
  const queuedOnce = c.frameQueued;
  c.dispatch(chunk("c"));
  check("o frame continua agendado (não duplica)", queuedOnce === true && c.frameQueued === true);
  check("ainda zero commits extras", c.commits === baseline);

  c.flushFrame();
  check("um único commit para a+b+c", c.commits === baseline + 1);
  check("texto final correto", c.currentText() === "abc");
}

// ── C. a phase edge cancels the frame and commits everything ───────────────
console.log("\nC. done ANTES do frame: o texto pendente não se perde");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "go", id: ID, attempt: 1, retryRisk: false });
  c.dispatch({ type: "echo", roomId: ROOM, id: ID });
  const baseline = c.commits;

  for (const d of ["par", "tial"]) c.dispatch(chunk(d));
  check("frame agendado com texto pendente", c.frameQueued === true);
  check("ref já tem o texto pendente", c.currentText() === "partial");

  c.dispatch({ type: "done", roomId: ROOM, id: ID });
  check("done cancela o frame", c.frameQueued === false);
  check("done publica imediatamente", c.commits === baseline + 1);
  check("o commit do done carrega o texto pendente", c.publishedTexts().at(-1) === "partial");
  check("flush posterior é no-op", c.flushFrame() === false);
  check("nenhum commit extra após o cancelamento", c.commits === baseline + 1);
}

// ── D. chunks for another turn/room stay inert ─────────────────────────────
console.log("\nD. chunk de outro turno/room não agenda frame");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "go", id: ID, attempt: 1, retryRisk: false });
  c.dispatch({ type: "echo", roomId: ROOM, id: ID });

  const before = c.commits;
  const acceptedWrongId = c.dispatch(chunk("nope", "other-turn"));
  const acceptedWrongRoom = c.dispatch(chunk("nope", ID, "other-room"));

  check("chunk de id errado é descartado pelo reducer", acceptedWrongId === false);
  check("chunk de room errada é descartado pelo reducer", acceptedWrongRoom === false);
  check("nenhum frame foi agendado", c.frameQueued === false);
  check("nenhum commit extra", c.commits === before);
  check("texto intacto", c.currentText() === "");
}

// ── E. chunk before echo stays inert (agent not open yet) ──────────────────
console.log("\nE. chunk antes do echo não abre o agent");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "go", id: ID, attempt: 1, retryRisk: false });
  const accepted = c.dispatch(chunk("early"));
  check("chunk em awaiting_echo é descartado", accepted === false);
  check("sem frame agendado", c.frameQueued === false);
  check("a projeção ainda não tem agent", visibleChatItems(c.state).every((i) => i.kind !== "agent"));
}

// ── F. the projection is correct at every publish point ───────────────────
console.log("\nF. a projeção publicada é sempre consistente");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "pergunta", id: ID, attempt: 1, retryRisk: false });
  check("antes do echo: 1 user, 0 agent", (() => {
    const items = visibleChatItems(c.state);
    return items.length === 1 && items[0].kind === "user" && items[0].text === "pergunta";
  })());

  c.dispatch({ type: "echo", roomId: ROOM, id: ID });
  c.dispatch(chunk("resposta"));
  check("após echo+chunk: 2 itens user,agent", visibleChatItems(c.state).length === 2);
  check("o agent carrega o delta mesmo sem frame publicado", (() => {
    const agent = visibleChatItems(c.state).find((i) => i.kind === "agent");
    return agent?.text === "resposta";
  })());

  c.flushFrame();
  c.dispatch({ type: "done", roomId: ROOM, id: ID });
  const settled = visibleChatItems(c.state);
  check("após done: 2 itens, agent completed", settled.length === 2 && settled[1].kind === "agent" && settled[1].phase === "completed");
  check("canSubmit volta a true", canSubmit(c.state) === true);
}

// ── G. ordering: text is never published out of order ────────────────────
console.log("\nG. publicação nunca fica atrás do ref");
{
  const c = createCoalescer();
  c.dispatch({ type: "submit", roomId: ROOM, text: "go", id: ID, attempt: 1, retryRisk: false });
  c.dispatch({ type: "echo", roomId: ROOM, id: ID });

  let monotonic = true;
  let last = "";
  for (let i = 0; i < 30; i += 1) {
    c.dispatch(chunk(String(i % 10)));
    if (i % 7 === 0) {
      c.flushFrame();
      const published = c.publishedTexts().at(-1) ?? "";
      if (!published.startsWith(last)) monotonic = false;
      if (published !== c.currentText() && c.currentText().length > published.length) {
        // published may legitimately lag the ref between frames, but it must
        // never be AHEAD of it nor lose a prefix.
        if (!c.currentText().startsWith(published)) monotonic = false;
      }
      last = published;
    }
  }
  c.flushFrame();
  check("toda publicação é prefixo do ref (sem perda, sem reordenação)", monotonic);
  check("o último publish bate com o ref", c.publishedTexts().at(-1) === c.currentText());
  check("30 deltas produziram muito menos commits", c.commits < 30 + 2);
}

// ── summary ────────────────────────────────────────────────────────────────
console.log("");
if (failures.length === 0) {
  console.log(`${passed}/${passed} checks PASS`);
  console.log("verify-web-chat-stream: OK");
  process.exit(0);
} else {
  console.log(`${passed}/${passed + failures.length} checks PASS`);
  console.log(`${failures.length} check(s) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
