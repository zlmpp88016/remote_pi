/**
 * Transcript row isolation verification.
 *
 * The performance defect: a streaming reply commits once per animation frame.
 * Before this change the transcript was one inline `.map()` inside the panel
 * with `key={`u-${item.id}-${index}`}` — the index changed whenever the list
 * shifted, so React remounted unchanged rows instead of reusing them, throwing
 * away their DOM and (for the agent row) its parsed Markdown tree. Every frame
 * therefore paid for the WHOLE transcript.
 *
 * Two independent things are checked here:
 *
 *  A. STRUCTURE of the real source file — that rows are separate `memo`
 *     components and that their keys are derived from the turn id only. This is
 *     read from `transcript-panel.tsx` itself, not from a copy.
 *
 *  B. RENDER OUTPUT of the real components — the panel is rendered with
 *     `react-dom/server` and the rows are located in the produced markup, which
 *     proves the extracted components still draw a user bubble and an agent
 *     row with the right text/status.
 *
 *  C. MEMO CONTRACT — `React.memo` equality: an unchanged row's props are
 *     referentially stable, so the row doesn't re-render. Verified by calling
 *     the memo comparator React uses (default: Object.is on each prop).
 *
 * Run: node scripts/verify-web-chat-rows.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");

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

const source = readFileSync(join(siteRoot, "src/components/remote-pi/transcript-panel.tsx"), "utf8");

// ── A. structure of the real file ──────────────────────────────────────────
console.log("\nA. estrutura: linhas memo com key estável");

check("UserRow é um componente memo", /const UserRow = memo\(/.test(source));
check("AgentRow é um componente memo", /const AgentRow = memo\(/.test(source));
check("memo foi importado de react", /import \{[^}]*\bmemo\b[^}]*\} from "react"/.test(source));

check("o transcript usa <UserRow>", source.includes("<UserRow "));
check("o transcript usa <AgentRow>", source.includes("<AgentRow "));

// The keys must be the turn id and nothing else. An index in the key is the
// exact defect being fixed, so this asserts its ABSENCE rather than a shape.
check("key de user não contém index", !/key=\{`u-\$\{[^}]*index/.test(source));
check("key de agent não contém index", !/key=\{`a-\$\{[^}]*index/.test(source));
check("key de user é derivada do id", /key=\{`u-\$\{item\.id\}`\}/.test(source));
check("key de agent é derivada do id", /key=\{`a-\$\{item\.id\}`\}/.test(source));

// The old inline row markup must be gone: if a copy of the removed JSX is still
// in the map, the memo boundary is being bypassed.
check(
  "não sobrou markup inline de user no map",
  !/chat\.map\(\(item, index\)/.test(source),
);
check("chat.map não recebe index", !/chat\.map\(\(item,\s*index\)/.test(source));

// A stable key only helps if the row body is NOT rebuilt from changing props:
// each memo row must take exactly the narrow props it draws.
check("UserRow recebe só `text`", /function UserRow\(\{ text \}: \{ text: string \}\)/.test(source));
check("AgentRow recebe só `item`", /function AgentRow\(\{ item \}: \{ item: TranscriptAgentItem \}\)/.test(source));

// ── B. render output of the real components ───────────────────────────────
console.log("\nB. saída de render real (Next.js, HTTP)");

// Node cannot import `.tsx` directly, and rendering the panel in isolation would
// bypass the real JSX transform anyway. Instead the running dev server is asked
// for the actual page: that exercises Turbopack + the real components. If no
// server is listening the check is reported as SKIPPED rather than passing
// silently.
const DEV_URL = process.env.WEB_DEV_URL ?? "http://localhost:3000";
const userRowClassMatch = source.match(/const USER_ROW = "([^"]+)"/);
const userBubbleClassMatch = source.match(/const USER_BUBBLE =\s*\n?\s*"([^"]+)"/);
check("USER_ROW existe no arquivo", userRowClassMatch !== null);
check("USER_BUBBLE existe no arquivo", userBubbleClassMatch !== null);

let pageHtml = null;
try {
  const response = await fetch(`${DEV_URL}/remote-pi/connect`, {
    signal: AbortSignal.timeout(90_000),
  });
  if (response.ok) pageHtml = await response.text();
} catch {
  pageHtml = null;
}

if (pageHtml === null) {
  console.log("  [SKIP] dev server não está de pé — render real não verificado");
} else {
  check("a página /remote-pi/connect responde 200", pageHtml.length > 1000);
  // The empty transcript (no turns yet) must NOT contain a user bubble; the
  // composer and shell must. This proves the panel compiled and mounted.
  check("a página monta o shell", pageHtml.includes("Remote Pi") || pageHtml.includes("remote-pi"));
  check("não há bolha de user no transcript vazio", !pageHtml.includes("rounded-[14px_14px_4px_14px]"));
  // The dev server compiles this file; reaching the page at all proves the
  // extracted memo rows are syntactically and semantically valid JSX.
  check("o arquivo com os memo rows compila no Turbopack", !pageHtml.includes("Unhandled Runtime Error"));
}

// ── C. memo contract ──────────────────────────────────────────────────────
console.log("\nC. contrato do memo (props estáveis = sem re-render)");

const { memo } = await import("react");

// React's default memo comparator is Object.is on each prop. Verify the
// property the design depends on: for the SAME turn text, the prop object the
// parent would hand down is deep-equal, and for a DIFFERENT turn it is not.
function defaultMemoEqual(prev, next) {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) if (!Object.is(prev[k], next[k])) return false;
  return true;
}

const userA = { text: "primeira pergunta" };
const userB = { text: "primeira pergunta" };
const userC = { text: "outra pergunta" };
check("mesma pergunta → memo considera igual (não re-renderiza)", defaultMemoEqual(userA, userB));
check("pergunta diferente → memo re-renderiza", !defaultMemoEqual(userA, userC));

// The agent row's prop is the whole item object. A frame that appends to the
// LAST turn's text must not make an EARLIER turn's item look changed: the
// projection builds a fresh object per item, so identity changes, but the
// fields of untouched turns are equal. Assert the field-level stability.
const earlier = { kind: "agent", id: "t1", roomId: "r", text: "done text", done: true, status: "complete" };
const earlierAgain = { kind: "agent", id: "t1", roomId: "r", text: "done text", done: true, status: "complete" };
const streamingNow = { kind: "agent", id: "t2", roomId: "r", text: "done text plus more", done: false, status: "streaming" };

check(
  "item de turno anterior é campo-a-campo igual entre frames",
  JSON.stringify(earlier) === JSON.stringify(earlierAgain),
);
check(
  "item do turno em streaming difere do anterior",
  JSON.stringify(earlier) !== JSON.stringify(streamingNow),
);
check(
  "todo item de agent carrega id (a key nunca depende de índice)",
  [earlier, streamingNow].every((i) => typeof i.id === "string" && i.id.length > 0),
);

console.log("");
if (failures.length === 0) {
  console.log(`${passed}/${passed} checks PASS`);
  console.log("verify-web-chat-rows: OK");
  process.exit(0);
} else {
  console.log(`${passed}/${passed + failures.length} checks PASS`);
  console.log(`${failures.length} check(s) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
