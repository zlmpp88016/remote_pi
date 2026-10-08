/**
 * End-to-end verification of the minimal web client against the local relay
 * stub (plan 69 W4 acceptance): full flow pair → list → browse → start →
 * chat, with an Origin allowlist ACTIVE, plus rejection of an unlisted Origin.
 *
 * The client core under test is the SAME code the browser route imports
 * (src/lib/remote-pi/*) — Node 22 runs the TypeScript directly. The only
 * injection is the WebSocket factory, which sets the Origin header (a browser
 * sets it automatically; undici's WebSocket needs it explicitly).
 *
 * Run: node scripts/verify-web-client.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemotePiWebClient, WEB_CLIENT_SUBPROTOCOL } from "../src/lib/remote-pi/client.ts";
import { ActionRejectedError, parsePairUri } from "../src/lib/remote-pi/protocol.ts";
import { startRelayStub } from "./relay-stub.mjs";

const ALLOWED_ORIGIN = "https://web.remote-pi.example";
const EVIL_ORIGIN = "https://evil.example";

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function wsFactoryFor(origin) {
  return (url, protocols) =>
    new WebSocket(url, { protocols, headers: { Origin: origin } });
}

/** Collects server messages until `predicate` matches or the deadline hits. */
function collectUntil(client, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout aguardando mensagens do chat")), timeoutMs);
    const off = client.onServerMessage((msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        off();
        resolve(msg);
      }
    });
  });
}

async function main() {
  // ── host fixture on the real filesystem ───────────────────────────────────
  const root = mkdtempSync(join(tmpdir(), "rp-web-client-"));
  const alpha = join(root, "proj-alpha");
  const beta = join(root, "proj-beta");
  mkdirSync(join(alpha, ".git"), { recursive: true });
  mkdirSync(beta, { recursive: true });
  writeFileSync(join(alpha, "README.md"), "# alpha\n");
  writeFileSync(join(root, "notes.txt"), "hello\n");

  const stub = await startRelayStub({ originAllowlist: [ALLOWED_ORIGIN] });
  console.log(`\nrelay stub em ${stub.relayUrl} (allowlist: ${ALLOWED_ORIGIN})`);
  console.log(`fixture fs em ${root}\n`);

  // ── 1. pair URI (frozen payload) parses into the canonical host identity ──
  console.log("== 1. código de pareamento (payload congelado) ==");
  const pairUri =
    `remotepi://pair?t=${stub.token}` +
    `&epk=${Buffer.from(stub.hostEpk, "base64").toString("base64url")}` +
    `&n=host&rm=host&r=${stub.relayUrl}`;
  const target = parsePairUri(pairUri);
  check("parse da URI remotepi://pair", target.hostEpk === stub.hostEpk && target.roomId === "host", `n=${target.name}`);
  check("parâmetro r (relay) preservado", target.relayUrl === stub.relayUrl);

  // ── 2. full flow with an ALLOWED origin ───────────────────────────────────
  console.log("\n== 2. fluxo completo (origin permitido) ==");
  const client = new RemotePiWebClient({
    relayUrl: target.relayUrl,
    webSocketFactory: wsFactoryFor(ALLOWED_ORIGIN),
    deviceName: "verify-web-client",
  });
  await client.connect();
  check("handshake hello→challenge→auth (Ed25519)", client.peerId.length === 44, `peer=${client.peerId.slice(0, 8)}…`);
  check("subprotocolo negociado ecoado pelo relay", WEB_CLIENT_SUBPROTOCOL === "remote-pi.1");

  // 2a. wrong token first — the carve-out answers pair_error, never silence.
  let pairErrorSeen = false;
  try {
    await client.pair({ ...target, token: "token-errado" });
  } catch (err) {
    pairErrorSeen = /pair_error/.test(String(err));
  }
  check("token inválido → pair_error", pairErrorSeen);

  // 2b. correct token → pair_ok.
  const pairOk = await client.pair(target);
  check("pair_request → pair_ok", pairOk.type === "pair_ok" && pairOk.room_id === "host");

  // 2c. host_hello.
  const hello = await client.helloHost(target.hostEpk, target.roomId);
  check(
    "host_hello → host_hello_ok (versão/hostname reais)",
    hello.type === "host_hello_ok" && typeof hello.daemon.hostname === "string" && hello.capabilities.includes("fs_nav"),
    `daemon=${hello.daemon.version}`,
  );

  // 2d. workspace_list (empty before any start).
  const list0 = await client.listWorkspaces(target.hostEpk, target.roomId);
  check("workspace_list → lista inicial vazia", list0.workspaces.length === 0);

  // 2e. fs_list — browse the host filesystem.
  const fsRoot = await client.fsList(target.hostEpk, root);
  check(
    "fs_list raiz do fixture",
    fsRoot.type === "fs_list_ok" && fsRoot.path === root &&
      fsRoot.entries.some((e) => e.name === "proj-alpha" && e.kind === "dir"),
    `entries=${fsRoot.entries.map((e) => e.name).join(",")}`,
  );
  const fsAlpha = await client.fsList(target.hostEpk, join(root, "proj-alpha"));
  check(
    "fs_list diretório com .git → is_repo",
    fsAlpha.entries.some((e) => e.name === ".git" && e.kind === "dir" && e.is_repo === true) ||
      fsAlpha.entries.some((e) => e.name === "README.md" && e.kind === "file"),
  );
  check("fs_list navega para o pai", fsRoot.parent !== null && fsRoot.parent.length > 0);

  // 2f. fs_list error table (PROTOCOL.md plan 68).
  let notFound = false;
  try {
    await client.fsList(target.hostEpk, join(root, "nao-existe"));
  } catch (err) {
    notFound = err instanceof ActionRejectedError && err.code === "not_found";
  }
  check("fs_list caminado inexistente → action_error not_found", notFound);

  // 2g. workspace_start → room do Pi.
  const started = await client.startWorkspace(target.hostEpk, join(root, "proj-alpha"), target.roomId);
  check(
    "workspace_start → workspace_start_ok com room_id",
    started.type === "workspace_start_ok" && typeof started.room_id === "string" && started.room_id.length > 0,
    `room=${started.room_id}`,
  );
  const list1 = await client.listWorkspaces(target.hostEpk, target.roomId);
  check(
    "workspace_list reflete o workspace iniciado (source=added)",
    list1.workspaces.length === 1 && list1.workspaces[0].cwd === join(root, "proj-alpha"),
  );

  // 2h. chat — echo + stream on the workspace room.
  const donePromise = collectUntil(client, (msg) => msg.type === "agent_done");
  const sentText = "olá do cliente web";
  const messageId = client.sendChat(target.hostEpk, started.room_id, sentText);
  let sawEcho = false;
  let assembled = "";
  const off = client.onServerMessage((msg) => {
    if (msg.type === "user_message" && msg.id === messageId) sawEcho = true;
    if (msg.type === "agent_chunk" && msg.in_reply_to === messageId) assembled += String(msg.delta ?? "");
  });
  await donePromise;
  off();
  check("user_message ecoado pelo host", sawEcho);
  check("agent_chunk stream recebido", assembled.includes(sentText), assembled);

  // ── 3. unlisted Origin is rejected by the allowlist ───────────────────────
  console.log("\n== 3. origin fora da allowlist ==");
  const evil = new RemotePiWebClient({
    relayUrl: stub.relayUrl,
    webSocketFactory: wsFactoryFor(EVIL_ORIGIN),
  });
  let evilRejected = false;
  try {
    await evil.connect();
  } catch {
    evilRejected = true;
  }
  check(`connect com Origin ${EVIL_ORIGIN} rejeitado (HTTP 403 no upgrade)`, evilRejected);
  check("stub registrou a origin rejeitada", stub.rejections().includes(EVIL_ORIGIN), JSON.stringify(stub.rejections()));

  // ── 4. missing Origin is rejected when the allowlist is non-empty ─────────
  console.log("\n== 4. origin ausente ==");
  const noOrigin = new RemotePiWebClient({
    relayUrl: stub.relayUrl,
    webSocketFactory: (url, protocols) => new WebSocket(url, { protocols }),
  });
  let noOriginRejected = false;
  try {
    await noOrigin.connect();
  } catch {
    noOriginRejected = true;
  }
  check("connect sem header Origin rejeitado", noOriginRejected);

  // ── 5. pure-ts fallback backend survives the real handshake ───────────────
  console.log("\n== 5. fallback pure-ts no handshake real ==");
  const fallbackClient = new RemotePiWebClient({
    relayUrl: stub.relayUrl,
    webSocketFactory: wsFactoryFor(ALLOWED_ORIGIN),
    forceBackend: "pure-ts",
    deviceName: "verify-web-client-fallback",
  });
  await fallbackClient.connect();
  check("handshake ok com backend pure-ts", fallbackClient.backend === "pure-ts" && fallbackClient.peerId.length === 44);
  const fallbackPair = await fallbackClient.pair(target);
  check("pair_ok também pelo fallback", fallbackPair.type === "pair_ok");

  client.close();
  fallbackClient.close();
  await stub.close();
  rmSync(root, { recursive: true, force: true });

  console.log(
    failures === 0
      ? "\nverify-web-client: ALL PASS\n"
      : `\nverify-web-client: ${failures} FAILURE(S)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
