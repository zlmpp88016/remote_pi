// Verificação LIVE do fix: cliente web REAL → relay REAL → supervisor/child REAIS.
// Sobe um workspace fresco (spawna child com o dist/ recém-compilado), pareia,
// manda chat e espera agent_chunk (a resposta do Pi).
//
//   node scripts/e2e/live-chat-probe.mjs "<pair-uri>" [cwd]
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemotePiWebClient } from "../../clients/web/src/lib/remote-pi/client.ts";
import { parsePairUri } from "../../clients/web/src/lib/remote-pi/protocol.ts";

const pairUri = process.argv[2];
if (!pairUri) { console.error("uso: node scripts/e2e/live-chat-probe.mjs \"<remotepi://pair?...>\" [cwd]"); process.exit(2); }
const target = parsePairUri(pairUri);

const cwd = process.argv[3] ?? mkdtempSync(join(tmpdir(), "rp-live-ws-"));
if (process.argv[3]) mkdirSync(cwd, { recursive: true });
console.log(`[live] relay=${target.relayUrl} cwd=${cwd}`);

const client = new RemotePiWebClient({ relayUrl: target.relayUrl, deviceName: "live-probe" });
const seen = [];
client.onServerMessage((msg, room) => {
  seen.push({ type: msg.type, room, in_reply_to: msg.in_reply_to });
  const extra =
    msg.type === "agent_chunk" ? ` delta=${JSON.stringify(String(msg.delta ?? ""))}` :
    msg.type === "error" ? ` message=${JSON.stringify(String(msg.message ?? ""))}` :
    msg.type === "user_message" ? ` text=${JSON.stringify(String(msg.text ?? "").slice(0, 40))}` : "";
  console.log(`[live] << ${msg.type} room=${room ?? "-"} reply=${msg.in_reply_to ?? "-"}${extra}`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await client.connect();
  console.log(`[live] conectado peer=${client.peerId.slice(0, 8)}… backend=${client.backend}`);
  await client.pair(target);
  console.log("[live] pair_ok");
  await client.helloHost(target.hostEpk, target.roomId);

  const started = await client.startWorkspace(target.hostEpk, cwd, target.roomId);
  console.log(`[live] workspace_start_ok room=${started.room_id} — aguardando child...`);
  await sleep(30_000); // child: spawn + auth + SDK boot

  // Envia e, se nada voltar em 20s, reenvia (o child pode ter subido tarde).
  let id = client.sendChat(target.hostEpk, started.room_id, "responda apenas: PONG");
  console.log(`[live] sendChat id=${id}`);
  await sleep(20_000);
  if (!seen.some((m) => m.type === "user_message")) {
    id = client.sendChat(target.hostEpk, started.room_id, "responda apenas: PONG");
    console.log(`[live] reenvio id=${id}`);
  }

  const deadline = Date.now() + 150_000;
  let echo = false, chunks = 0, done = false, err = null;
  while (Date.now() < deadline) {
    echo ||= seen.some((m) => m.type === "user_message");
    chunks = seen.filter((m) => m.type === "agent_chunk").length;
    done ||= seen.some((m) => m.type === "agent_done");
    const e = seen.find((m) => m.type === "error");
    if (e) { err = e; break; }
    if (done) break;
    await sleep(500);
  }
  console.log(`\n[live] RESULTADO: echo=${echo} agent_chunk=${chunks} agent_done=${done} error=${err ? "sim" : "não"}`);
  console.log(`[live] tipos: ${[...new Set(seen.map((m) => m.type))].join(", ")}`);
  const text = seen.filter((m) => m.type === "agent_chunk").map((m) => m.delta ?? "").join("");
  if (text) console.log(`[live] resposta do Pi: ${JSON.stringify(text.slice(0, 200))}`);
} catch (e) {
  console.log(`[live] EXCEÇÃO: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  try { client.close(); } catch { /* noop */ }
}
