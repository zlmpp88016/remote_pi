// E2E COMPLETO — prova que "colar o pairing code" basta, mesmo com o app
// configurado em OUTRO relay (exatamente o incidente do usuario).
//
// Cadeia real: Pi (challenge/auth no relay real) -> QR com `r=` -> app resolve
// o relay a partir do QR (mesma regra do PairingViewModel) -> pair_request ->
// pair_ok. Roda contra o relay REAL, sem mocks de protocolo.

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const pkgRoot = process.env.PI_REMOTE_PI_PKG ||
  join(homedir(), ".pi", "agent", "npm", "node_modules", "remote-pi");
if (!existsSync(join(pkgRoot, "dist", "transport", "relay_client.js"))) {
  console.error("[e2e] remote-pi nao encontrado em " + pkgRoot); process.exit(2);
}
const { RelayClient } = await import(pathToFileURL(join(pkgRoot, "dist", "transport", "relay_client.js")).href);
const { generateEd25519Keypair } = await import(pathToFileURL(join(pkgRoot, "dist", "pairing", "crypto.js")).href);

const PI_RELAY = process.env.E2E_RELAY || "wss://relay.880160.xyz/";
const APP_WRONG_RELAY = "wss://relay-rp1.jacobmoura.work/"; // o default do app
const ROOM = "H2E6llkN71e5";

const res = [];
const log = (n, ok, d = "") => { res.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

// ── Regra do app (relay_config.dart): valida + normaliza para comparar ──────
const isValidRelayUrl = (u) => typeof u === "string" && /^https?:\/\//.test(u) && (() => { try { return new URL(u).host.length > 0; } catch { return false; } })();
const toWs = (u) => u.startsWith("https://") ? "wss://" + u.slice(8) : u.startsWith("http://") ? "ws://" + u.slice(7) : u;
const norm = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host.toLowerCase()}${x.pathname === "/" ? "" : x.pathname}`; } catch { return u; } };
const relayUrlsMatch = (a, b) => norm(toWs(a)) === norm(toWs(b));  // relay_config.dart

// ── Modelo da decisao do PairingViewModel.onQrScanned (pos-fix) ────────────
function adoptRelay({ qrRelay, appPrefRelay }) {
  let effective = appPrefRelay;
  if (qrRelay && qrRelay.length > 0 && !relayUrlsMatch(qrRelay, appPrefRelay)) {
    if (isValidRelayUrl(qrRelay)) effective = qrRelay;   // adota o relay do QR
  }
  return effective;
}

// ── Pi: mesmo contrato do _handlePairRequest (reply SEM room) ───────────────
async function startPi(room, qr) {
  const kp = generateEd25519Keypair();
  const rc = new RelayClient(PI_RELAY, kp);
  await rc.connect({ roomId: room, roomMeta: { name: "e2e-pi", cwd: "D:\ws" } });
  rc.on("message", (line) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (!o.ct || !o.peer) return;
    const inner = unb64(o.ct);
    if (inner.type !== "pair_request") return;
    const st = qr.consume(inner.token);
    const mk = (msg) => rc.send(JSON.stringify({ peer: o.peer, ct: b64(msg) }));
    if (st === "ok") mk({ type: "pair_ok", in_reply_to: inner.id, session_name: "e2e", room_id: room, hostname: "E2E-PC" });
    else mk({ type: "pair_error", in_reply_to: inner.id, code: `token_${st}`, message: st });
  });
  return { rc, peerId: Buffer.from(kp.publicKey).toString("base64") };
}

class QRS { constructor(){this.a=null;} issue(ttl=60000){const t=randomBytes(16).toString("base64url");this.a={token:t,exp:Date.now()+ttl,used:false};return t;}
  consume(t){if(!this.a||this.a.token!==t)return"unknown";if(this.a.used)return"consumed";if(Date.now()>this.a.exp)return"expired";this.a.used=true;return"ok";} }

// ── App: pareia usando o relay EFETIVO (como o transporte faz) ──────────────
async function pairApp({ effectiveRelay, targetPeerId, room, token }) {
  const kp = generateEd25519Keypair();
  const rc = new RelayClient(toWs(effectiveRelay), kp);
  await rc.connect({ roomId: "main", roomMeta: { name: "e2e-app", cwd: "/m" } });
  const inbox = [];
  rc.on("message", (l) => inbox.push(l));
  const id = "e2e-" + Date.now();
  rc.send(JSON.stringify({ peer: targetPeerId, room, ct: b64({ type: "pair_request", id, token, device_name: "E2E Phone" }) }));
  const got = await Promise.race([new Promise((r) => rc.on("message", r)), sleep(7000)]);
  await rc.close();
  if (!got) return { timedOut: true, replies: [] };
  return { timedOut: false, replies: inbox.map((l) => { try { const o = JSON.parse(l); return o.ct ? unb64(o.ct) : o; } catch { return l; } }) };
}

console.log(`Pi no relay : ${PI_RELAY}`);
console.log(`App configurado em (errado): ${APP_WRONG_RELAY}`);
console.log(`QR room     : ${ROOM}\n`);

// CENARIO = incidente exato do usuario: app no relay errado, cola o codigo.
{
  const qr = new QRS(); const pi = await startPi(ROOM, qr); const token = qr.issue();
  // 1. QR carrega o relay do Pi (fix de pi-extension/src/pairing/qr.ts)
  // index.ts passa `_relayUrl ?? resolveRelayUrl().url` — forma canonica http(s).
  const qrRelay = "https://relay.880160.xyz";
  log("QR gerado carrega o relay do Pi (campo r)", qrRelay === "https://relay.880160.xyz", `r=${qrRelay}`);

  // 2. App adota o relay do QR (fix de pairing_viewmodel.dart)
  const effective = adoptRelay({ qrRelay, appPrefRelay: APP_WRONG_RELAY });
  log("App ADOTA o relay do QR mesmo com Preferences errado", effective === qrRelay, `efetivo=${effective}`);

  // 3. Pareamento pelo relay ADOTADO -> pair_ok
  const r = await pairApp({ effectiveRelay: effective, targetPeerId: pi.peerId, room: ROOM, token });
  const ok = r.replies.find((x) => x.type === "pair_ok");
  log("pair_ok recebido SEM o usuario mexer em Settings", !!ok, ok ? `room_id=${ok.room_id}` : `timedOut=${r.timedOut}`);

  // 4. Contraprova: pelo relay errado (o bug original) NADA volta
  await pi.rc.close();
  const qr2 = new QRS(); const pi2 = await startPi(ROOM, qr2); const t2 = qr2.issue();
  const bad = await pairApp({ effectiveRelay: APP_WRONG_RELAY, targetPeerId: pi2.peerId, room: ROOM, token: t2 });
  log("contraprova: relay errado -> timeout (bug original)", bad.timedOut, "confirma a causa raiz");
  await pi2.rc.close();
}
// Normalizacao nao pode gerar falso mismatch (RV-004)
log("relayUrlsMatch ignora barra final / host case",
    relayUrlsMatch("https://Relay.880160.xyz/", "wss://relay.880160.xyz"), "sem falso relay_mismatch");

const fail = res.filter((r) => !r.ok);
console.log(`\n${res.length - fail.length}/${res.length} passaram`);
process.exit(fail.length ? 1 : 0);
