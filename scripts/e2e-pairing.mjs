// E2E: Pi <-> relay <-> App na camada de protocolo, contra o relay REAL.
// Diagnostico de pareamento ponta-a-ponta (Pi <-> relay <-> App) na camada de
// protocolo. Roda contra um relay REAL usando a propria implementacao de
// transporte da extensao instalada (npm:remote-pi), para nao duplicar protocolo.
//
// Uso:
//   node scripts/e2e-pairing.mjs
//   E2E_RELAY=wss://relay.880160.xyz/ node scripts/e2e-pairing.mjs
//
// Resolve o pacote instalado via PI_REMOTE_PI_PKG (default: install global do Pi).
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const pkgRoot = process.env.PI_REMOTE_PI_PKG ||
  join(homedir(), ".pi", "agent", "npm", "node_modules", "remote-pi");
if (!existsSync(join(pkgRoot, "dist", "transport", "relay_client.js"))) {
  console.error("[e2e] pacote remote-pi nao encontrado em " + pkgRoot);
  console.error("[e2e] defina PI_REMOTE_PI_PKG=/caminho/para/remote-pi");
  process.exit(2);
}
const { RelayClient } = await import(pathToFileURL(join(pkgRoot, "dist", "transport", "relay_client.js")).href);
const { generateEd25519Keypair } = await import(pathToFileURL(join(pkgRoot, "dist", "pairing", "crypto.js")).href);
import { randomBytes } from "node:crypto";

const RELAY = process.env.E2E_RELAY || "wss://relay.880160.xyz/";
const WRONG_RELAY = "wss://relay-rp1.jacobmoura.work/";
const ROOM = process.env.E2E_ROOM || "H2E6llkN71e5";
const OTHER_ROOM = "G_O9FHmyTGS9";

const results = [];
const log = (n, ok, d = "") => { results.push({ n, ok, d }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

// ── Mini QRSession (mesma semantica de pi-extension/src/pairing/qr.ts) ───────
class QRSession {
  constructor() { this.active = null; }
  issue(ttlMs = 60_000) {
    const token = randomBytes(16).toString("base64url");
    this.active = { token, expiresAt: Date.now() + ttlMs, consumed: false };
    return token;
  }
  consume(token) {
    if (!this.active || this.active.token !== token) return "unknown";
    if (this.active.consumed) return "consumed";
    if (Date.now() > this.active.expiresAt) return "expired";
    this.active.consumed = true;
    return "ok";
  }
}

// ── Pi simulado: desafio/auth via RelayClient, escuta e responde ─────────────
async function startPi({ room, qr }) {
  const kp = generateEd25519Keypair();
  const rc = new RelayClient(RELAY, kp);
  await rc.connect({ roomId: room, roomMeta: { name: "e2e-pi", cwd: "D:\ws" } });
  const seen = [];
  rc.on("message", (line) => {
    let outer; try { outer = JSON.parse(line); } catch { return; }
    if (!outer.ct || !outer.peer) return;
    const inner = unb64(outer.ct);
    if (inner.type !== "pair_request") return;
    seen.push(inner);
    const st = qr.consume(inner.token);
    const reply = st === "ok"
      ? { type: "pair_ok", in_reply_to: inner.id, session_name: "e2e session", room_id: room, harness: { name: "Pi coding agent", version: "e2e" }, hostname: "E2E-PC" }
      : { type: "pair_error", in_reply_to: inner.id, code: `token_${st}`, message: `stub ${st}` };
    // Real Pi replies WITHOUT a room (see _handlePairRequest sendInner);
    // the relay then delivers to the app's own registered room.
    rc.send(JSON.stringify({ peer: outer.peer, ct: b64(reply) }));
  });
  return { rc, kp, seen, peerId: Buffer.from(kp.publicKey).toString("base64") };
}

// ── App simulado: pair_request enderecado a (piPeer, room) ───────────────────
async function appSendPairRequest({ targetPeerId, room, token, wantReply = true, url = RELAY }) {
  const kp = generateEd25519Keypair();
  const rc = new RelayClient(url, kp);
  await rc.connect({ roomId: "main", roomMeta: { name: "e2e-app", cwd: "/m" } });
  const inbox = [];
  rc.on("message", (l) => inbox.push(l));
  const id = "e2e-" + Date.now();
  rc.send(JSON.stringify({ peer: targetPeerId, room, ct: b64({ type: "pair_request", id, token, device_name: "E2E Phone" }) }));
  if (wantReply) {
    await Promise.race([new Promise((res) => rc.on("message", res)), sleep(6000)]);
  } else {
    await sleep(6000);
  }
  await rc.close();
  const replies = inbox.map((l) => { try { const o = JSON.parse(l); return o.ct ? unb64(o.ct) : o; } catch { return l; } });
  return { id, replies };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`relay=${RELAY}  room=${ROOM}\n`);

// 1) Caminho feliz: token valido + room correto -> pair_ok
{
  const qr = new QRSession();
  const pi = await startPi({ room: ROOM, qr });
  const token = qr.issue();
  const { id, replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: ROOM, token });
  const ok = replies.find((r) => r.type === "pair_ok" && r.in_reply_to === id);
  log("1. pair_request(token valido, room correto) -> pair_ok", !!ok, ok ? `room_id=${ok.room_id}` : `replies=${JSON.stringify(replies).slice(0,120)}`);
  log("1b. pair_ok devolve room_id correto (app persiste o room)", ok?.room_id === ROOM, `esperado=${ROOM} obtido=${ok?.room_id}`);
  await pi.rc.close();
}

// 2) Room errado (o QR antigo mandava 'main') -> sem resposta
{
  const qr = new QRSession();
  const pi = await startPi({ room: ROOM, qr });
  const token = qr.issue();
  const { replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: "main", token });
  log("2. room errado -> nenhuma resposta (dest not found)", replies.length === 0, `replies=${replies.length}`);
  await pi.rc.close();
}

// 3) REGRESSAO DO BUG: relay errado -> silencio total (= timeout do app)
{
  const qr = new QRSession();
  const pi = await startPi({ room: ROOM, qr });      // Pi em RELAY
  const token = qr.issue();
  const { replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: ROOM, token, url: WRONG_RELAY });
  log("3. REGRESSAO: app no relay ERRADO -> silencio (timeout)", replies.length === 0, `replies=${replies.length} (era o bug original)`);
  await pi.rc.close();
}

// 4) Token expirado -> token_expired
{
  const qr = new QRSession();
  const pi = await startPi({ room: ROOM, qr });
  const token = qr.issue(50);            // expira em 50ms
  await sleep(120);
  const { replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: ROOM, token });
  const e = replies.find((r) => r.type === "pair_error");
  log("4. token expirado -> pair_error(token_expired)", e?.code === "token_expired", `code=${e?.code}`);
  await pi.rc.close();
}

// 5) Token reutilizado -> token_consumed
{
  const qr = new QRSession();
  const pi = await startPi({ room: ROOM, qr });
  const token = qr.issue();
  await appSendPairRequest({ targetPeerId: pi.peerId, room: ROOM, token });
  const { replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: ROOM, token });
  const e = replies.find((r) => r.type === "pair_error");
  log("5. token reutilizado -> pair_error(token_consumed)", e?.code === "token_consumed", `code=${e?.code}`);
  await pi.rc.close();
}

// 6) Token desconhecido -> token_unknown
{
  const qr = new QRSession();
  const pi = await startPi({ room: ROOM, qr });
  const { replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: ROOM, token: "nao-e-meu-token-000000" });
  const e = replies.find((r) => r.type === "pair_error");
  log("6. token desconhecido -> pair_error(token_unknown)", e?.code === "token_unknown", `code=${e?.code}`);
  await pi.rc.close();
}

// 7) Pi com DOIS rooms (plan/41): o outro room tambem e alcancavel
{
  const qr = new QRSession();
  const pi = await startPi({ room: OTHER_ROOM, qr });
  const token = qr.issue();
  const { replies } = await appSendPairRequest({ targetPeerId: pi.peerId, room: OTHER_ROOM, token });
  const ok = replies.find((r) => r.type === "pair_ok");
  log("7. room alternativo do mesmo Pi tambem responde", !!ok);
  await pi.rc.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passaram`);
process.exit(failed.length ? 1 : 0);
