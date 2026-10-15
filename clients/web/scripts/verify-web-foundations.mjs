/**
 * Focused verification of the Wave 2 foundations (plan 69 W4):
 *   • frozen `remotepi://pair?…` parsing + relay URL normalization (protocol.ts)
 *   • typed pair rejections with safe, fixed text (protocol.ts)
 *   • runtime guards / validated transport decode (protocol.ts, client.ts)
 *   • pure connection-phase state machine (state.ts)
 *   • strict stored-session persistence (persistence.ts)
 *
 * These are UNIT-level checks: no relay, no socket, no browser. They assert the
 * security properties that the WebSocket end-to-end script cannot (duplicate /
 * unknown params, epk size, corrupt storage, secret leakage in error text).
 *
 * Run: node scripts/verify-web-foundations.mjs     (Node 22)
 */

import {
  ActionRejectedError,
  HOST_WEB_ROOM_ID,
  PairRejectedError,
  ProtocolFrameError,
  decodeCt,
  decodeOuterChecked,
  encodeCt,
  encodeOuter,
  isActionError,
  isFsListOk,
  isHostHelloOk,
  isHostMessage,
  isOuterEnvelope,
  isPairError,
  isPairOk,
  isPairRequest,
  isRelayAuthFrame,
  isSafeActionName,
  isServerMessage,
  isWorkspaceListOk,
  normalizeRelayUrl,
  pairRejectionMessage,
  pairRequest,
  parsePairUri,
} from "../src/lib/remote-pi/protocol.ts";
import {
  canTransition,
  createConnectionState,
  isPublicDiagnosticCode,
  isTerminalPhase,
  isUsablePhase,
  publicDiagnostic,
  reduceConnectionState,
} from "../src/lib/remote-pi/state.ts";
import {
  SESSION_STORAGE_KEY,
  SessionPersistenceError,
  browserSessionStorage,
  clearStoredSession,
  loadStoredSession,
  parseStoredSession,
  saveStoredSession,
  serializeStoredSession,
} from "../src/lib/remote-pi/persistence.ts";

const SECRET_TOKEN = "SYNTHETIC-TOKEN-9f3a";
const REMOTE_EVIL = "REMOTE-EVIL-TEXT-<script>alert(1)</script>";

let checks = 0;
let failures = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code ?? "(no code)";
  }
  return "(no throw)";
}

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return String(err.message);
  }
  return "(no throw)";
}

/** Every string a caller could render off an exception — used to prove that
 *  no wire-supplied value survives on it (message, code, action, enumerable
 *  fields, stack). */
function dumpOf(err) {
  return [err?.message, err?.name, err?.code, err?.action, err?.safeMessage, JSON.stringify({ ...err }), String(err?.stack).split("\n")[0]].join("|");
}

const EPK = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // 32 bytes, canonical
const EPK_URL = Buffer.from(EPK, "base64").toString("base64url");
const base = (extra = "") =>
  `remotepi://pair?t=${SECRET_TOKEN}&epk=${EPK_URL}&n=host-sessao${extra}`;

// ── synthetic storage ───────────────────────────────────────────────────────

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

const throwingStorage = (mode) => ({
  getItem() {
    if (mode === "read" || mode === "all") throw new Error(`raw:${REMOTE_EVIL}`);
    return null;
  },
  setItem() {
    if (mode === "write" || mode === "all") throw new Error(`raw:${REMOTE_EVIL}`);
  },
  removeItem() {
    if (mode === "remove" || mode === "all") throw new Error(`raw:${REMOTE_EVIL}`);
  },
});

/** Storage that accepts writes and silently drops them (quota/private mode). */
const swallowingStorage = () => ({
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

// ── 1. frozen pairing URI ───────────────────────────────────────────────────

console.log("\n== 1. URI de pareamento congelada (parse) ==");
{
  const target = parsePairUri(`${base("&rm=host&r=https://relay.example/")}`);
  check("parse canônico (5 params)", target.token === SECRET_TOKEN && target.name === "host-sessao");
  check("epk normalizado p/ base64 padrão com padding", target.hostEpk === EPK);
  check("rm=host preservado", target.roomId === HOST_WEB_ROOM_ID);
  check("r normalizado http→ws", target.relayUrl === "wss://relay.example", String(target.relayUrl));
  check(
    "PairTarget tem exatamente 5 chaves, sem campo novo",
    Object.keys(target).sort().join(",") === "hostEpk,name,relayUrl,roomId,token",
    Object.keys(target).sort().join(","),
  );

  const noRm = parsePairUri(base());
  check("rm omitido → host", noRm.roomId === "host" && noRm.relayUrl === undefined);
  // `r` OMITTED is fine; `r=` PRESENT and empty is a malformed payload.
  const noR = parsePairUri(base());
  check("r omitido → relayUrl undefined", noR.relayUrl === undefined);
  check("r= vazio → unsafe_relay_url (presente ≠ ausente)", codeOf(() => parsePairUri(base("&r="))) === "unsafe_relay_url");
  check("r=host válido normalizado", parsePairUri(base("&r=wss://relay.example")).relayUrl === "wss://relay.example");

  check("rm=child → unsupported_room", codeOf(() => parsePairUri(base("&rm=workspace-x"))) === "unsupported_room");
  check("rm=host explícito aceito", codeOf(() => parsePairUri(base("&rm=host"))) === "(no throw)");

  check("chave duplicada (t) → duplicate_key", codeOf(() => parsePairUri(`remotepi://pair?t=a&t=b&epk=${EPK_URL}&n=x`)) === "duplicate_key");
  check("chave duplicada (epk) → duplicate_key", codeOf(() => parsePairUri(`remotepi://pair?epk=${EPK_URL}&epk=${EPK_URL}&t=a&n=x`)) === "duplicate_key");
  check("chave desconhecida → unknown_key", codeOf(() => parsePairUri(`${base("&zz=1")}`)) === "unknown_key");
  check("campo faltando (t) → missing_field", codeOf(() => parsePairUri(`remotepi://pair?epk=${EPK_URL}&n=x`)) === "missing_field");
  check("campo vazio (n) → missing_field", codeOf(() => parsePairUri(`remotepi://pair?t=${SECRET_TOKEN}&epk=${EPK_URL}&n=`)) === "missing_field");
  check("campo só espaços (n) → missing_field", codeOf(() => parsePairUri(`remotepi://pair?t=${SECRET_TOKEN}&epk=${EPK_URL}&n=%20%20`)) === "missing_field");

  check("epk 31 bytes → invalid_epk_size", codeOf(() => parsePairUri(`remotepi://pair?t=a&epk=${Buffer.alloc(31, 7).toString("base64url")}&n=x`)) === "invalid_epk_size");
  // 32 bytes whose trailing pad bits are non-zero: decodes to a valid key via
  // an ALTERNATE base64url spelling → refused so the URI has one canonical form.
  const nonCanonicalEpk = (() => {
    const bytes = Buffer.alloc(32, 7);
    const std = bytes.toString("base64");
    const last = std[std.length - 2]; // second-to-last char carries pad bits
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = alphabet[(alphabet.indexOf(last) & 0b110000) | 0b000001];
    return (std.slice(0, -2) + bumped).replace(/=+$/, "");
  })();
  check(
    "epk com bits de padding não-canônicos → malformed_epk",
    codeOf(() => parsePairUri(`remotepi://pair?t=a&epk=${nonCanonicalEpk}&n=x`)) === "malformed_epk",
  );
  check("epk canônico segue aceito", codeOf(() => parsePairUri(base())) === "(no throw)");
  check("epk alfabeto não-base64url ('+') → malformed_epk", codeOf(() => parsePairUri(`remotepi://pair?t=a&epk=${encodeURIComponent(Buffer.alloc(32, 251).toString("base64"))}&n=x`)) === "malformed_epk");
  check("epk não-decodificável → malformed_epk", codeOf(() => parsePairUri("remotepi://pair?t=a&epk=!!!!&n=x")) === "malformed_epk");

  check("userinfo → invalid_uri_form", codeOf(() => parsePairUri(`remotepi://u:p@pair?t=a&epk=${EPK_URL}&n=x`)) === "invalid_uri_form");
  check("path → invalid_uri_form", codeOf(() => parsePairUri(`remotepi://pair/extra?t=a&epk=${EPK_URL}&n=x`)) === "invalid_uri_form");
  check("hash → invalid_uri_form", codeOf(() => parsePairUri(`${base()}#x`)) === "invalid_uri_form");
  check("host errado → invalid_uri_form", codeOf(() => parsePairUri(`remotepi://other?t=a&epk=${EPK_URL}&n=x`)) === "invalid_uri_form");
  check("não-URI → invalid_uri_form", codeOf(() => parsePairUri("nao sou uri")) === "invalid_uri_form");

  const leaked = [
    messageOf(() => parsePairUri(base("&zz=1"))),
    messageOf(() => parsePairUri(`remotepi://pair?t=LEAKME&t=x&epk=${EPK_URL}&n=x`)),
    messageOf(() => parsePairUri(`remotepi://pair?t=${SECRET_TOKEN}&epk=BADBAD&n=x`)),
    messageOf(() => parsePairUri(`remotepi://pair?t=${SECRET_TOKEN}&epk=${EPK_URL}&n=x&r=wss://u:p@relay/`)),
  ];
  check(
    "mensagens de rejeição não vazam token/input",
    leaked.every((m) => !m.includes(SECRET_TOKEN) && !m.includes("LEAKME") && !m.includes("BADBAD") && !m.includes("u:p@")),
    leaked.join(" | "),
  );
}

// ── 2. relay URL normalization ──────────────────────────────────────────────

console.log("\n== 2. normalizeRelayUrl ==");
{
  check("http→ws", normalizeRelayUrl("http://127.0.0.1:9000") === "ws://127.0.0.1:9000");
  check("https→wss + trim de barras", normalizeRelayUrl("  https://relay.example/// ") === "wss://relay.example");
  check("ws preservado", normalizeRelayUrl("ws://host:1") === "ws://host:1");
  check("wss preservado", normalizeRelayUrl("wss://host") === "wss://host");
  check("path preservado (relay sob subcaminho)", normalizeRelayUrl("https://relay.example/pi/") === "wss://relay.example/pi");
  check(
    "credenciais/query/hash/esquema inválido recusados",
    ["wss://u:p@relay/", "wss://relay/?x=1", "wss://relay/#f", "ftp://relay", "", "não é url"]
      .every((bad) => codeOf(() => normalizeRelayUrl(bad)) === "unsafe_relay_url"),
  );
  check(
    "erro de relay não ecoa o valor recusado",
    !messageOf(() => normalizeRelayUrl("wss://usuario:SEGREDO@relay/")).includes("SEGREDO"),
  );
}

// ── 3. typed pair errors + canonical pair_request ───────────────────────────

console.log("\n== 3. PairRejectedError / pair_request canônico ==");
{
  const expired = PairRejectedError.fromPairError({ type: "pair_error", code: "token_expired", message: REMOTE_EVIL });
  check(
    "pair_error token_expired → código tipado",
    expired.code === "token_expired",
  );
  check("texto do host NUNCA refletido", !expired.message.includes("REMOTE-EVIL") && !expired.message.includes("<script>"));
  check("mensagem de pair_error é em inglês", expired.message.includes("This pairing code has expired"));
  const actionErr = new ActionRejectedError("fs_list", REMOTE_EVIL);
  check("action_error desconhecido usa texto genérico", actionErr.message === "fs_list rejected: The host rejected this action.");
  check(
    "action_error desconhecido não reflete texto do host",
    !actionErr.message.includes("REMOTE-EVIL") && !dumpOf(actionErr).includes("REMOTE-EVIL"),
    dumpOf(actionErr),
  );
  check("`error` desconhecido → code fixo \"unknown\" (nada cru retido)", actionErr.code === "unknown", actionErr.code);
  check("ação allow-listed preservada no campo `action`", actionErr.action === "fs_list" && isSafeActionName("fs_list"));
  check("ação fora da allow-list → rótulo genérico \"action\"", new ActionRejectedError(REMOTE_EVIL, REMOTE_EVIL).action === "action");
  const broad = new ActionRejectedError(SECRET_TOKEN, SECRET_TOKEN);
  check(
    "ActionRejectedError(actionToken, errorToken) não vaza token em NENHUM campo",
    broad.code === "unknown" && broad.action === "action" &&
      broad.message === "action rejected: The host rejected this action." &&
      !dumpOf(broad).includes(SECRET_TOKEN),
    dumpOf(broad),
  );
  check(
    "action_error allow-listed (not_found) tem texto fixo",
    new ActionRejectedError("fs_list", "not_found").message === "fs_list rejected: Path not found.",
  );
  check(
    "action_error allow-listed (spawn_failed) tem texto fixo",
    new ActionRejectedError("workspace_start", "spawn_failed").message === "workspace_start rejected: The host could not start this workspace.",
  );
  check(
    "mensagem = rótulo congelado + código validado + texto fixo",
    expired.message.endsWith(pairRejectionMessage("token_expired")) &&
      expired.message.includes("pair_error[token_expired]"),
    expired.message,
  );
  check(
    "códigos de wire válidos preservados",
    ["token_expired", "token_consumed", "token_unknown", "internal_error"].every(
      (code) => PairRejectedError.fromPairError({ code }).code === code,
    ),
  );
  check("código desconhecido → internal_error", PairRejectedError.fromPairError({ code: "boom" }).code === "internal_error");
  check(
    "código hostil não entra na mensagem",
    !PairRejectedError.fromPairError({ code: REMOTE_EVIL }).message.includes("REMOTE-EVIL"),
  );
  check("resposta não-objeto → internal_error", PairRejectedError.fromPairError(null).code === "internal_error");

  const req = pairRequest("id-1", SECRET_TOKEN, "Remote Pi Web");
  check(
    "pair_request = {type,id,token,device_name} sem sig/owner_pk",
    JSON.stringify(req) === JSON.stringify({ type: "pair_request", id: "id-1", token: SECRET_TOKEN, device_name: "Remote Pi Web" }),
  );
  check("isPairRequest aceita o canônico", isPairRequest(req));
  check("isPairRequest recusa sig extra-shaped", !isPairRequest({ type: "pair_request", id: "1", token: "t" }));
}

// ── 4. runtime guards / validated transport ─────────────────────────────────

console.log("\n== 4. guards de runtime + decode validado ==");
{
  check("envelope estrito aceito", isOuterEnvelope({ peer: "p", room: "host", ct: "e30=" }));
  check("envelope sem room recusado", !isOuterEnvelope({ peer: "p", ct: "e30=" }));
  check("envelope com chave extra recusado", !isOuterEnvelope({ peer: "p", room: "host", ct: "e30=", x: 1 }));
  check("envelope com ct não-string recusado", !isOuterEnvelope({ peer: "p", room: "host", ct: null }));

  const frame = encodeOuter("peer-x", "host", { type: "pair_ok", in_reply_to: "1", session_name: "s", session_started_at: 1, room_id: "host" });
  const decoded = decodeOuterChecked(frame);
  check("decodeOuterChecked: frame válido", decoded.fromPeer === "peer-x" && decoded.fromRoom === "host" && decoded.inner.type === "pair_ok");
  check("decodeOuterChecked: ação_error tipado", isActionError(decodeOuterChecked(encodeOuter("p", "host", { type: "action_error", in_reply_to: "1", action: "fs_list", error: "not_found" })).inner));

  check("JSON inválido → malformed_frame", codeOf(() => decodeOuterChecked("{")) === "malformed_frame");
  check("envelope solto → malformed_envelope", codeOf(() => decodeOuterChecked(JSON.stringify({ peer: "p", ct: "e30=" }))) === "malformed_envelope");
  check("envelope null → malformed_envelope", codeOf(() => decodeOuterChecked("null")) === "malformed_envelope");
  check("ct não-JSON → malformed_ct", codeOf(() => decodeOuterChecked(JSON.stringify({ peer: "p", room: "host", ct: Buffer.from("nao-json").toString("base64") }))) === "malformed_ct");
  check("ct = null literal → malformed_ct", codeOf(() => decodeOuterChecked(JSON.stringify({ peer: "p", room: "host", ct: Buffer.from("null").toString("base64") }))) === "malformed_ct");
  check("erro de frame não vaza conteúdo", !messageOf(() => decodeOuterChecked(JSON.stringify({ peer: "p", room: "host", ct: Buffer.from(REMOTE_EVIL).toString("base64") }))).includes("REMOTE-EVIL"));

  check("host_message sem ct recusado (sem cast)", !isHostMessage({ type: "host_message", room: "r" }));
  check("host_message com ct válido aceito", isHostMessage({ type: "host_message", room: "r", ct: "e30=" }));
  check("guards não estouram com null/string/array", [isServerMessage(null), isHostMessage("x"), isPairOk(null), isPairError([1]), isHostHelloOk(null), isWorkspaceListOk("x"), isFsListOk(null), isRelayAuthFrame(null)].every((v) => v === false));
  check("auth de relay sem id aceito", isRelayAuthFrame({ type: "auth", sig: "AA==" }));
  check("auth com id recusado (id não existe no frame de relay)", !isRelayAuthFrame({ type: "auth", sig: "AA==", id: "1" }));
  check("guard host_hello_ok valida daemon/capabilities", isHostHelloOk({ type: "host_hello_ok", daemon: { version: "1", hostname: "h", platform: "linux" }, capabilities: ["fs_nav"] }) && !isHostHelloOk({ type: "host_hello_ok", daemon: { version: "1" }, capabilities: [] }));
  check("guard pair_ok exige session_started_at numérico", isPairOk({ type: "pair_ok", session_name: "s", session_started_at: 0, room_id: "host" }) && !isPairOk({ type: "pair_ok", session_name: "s", room_id: "host" }));

  // ── closed enums + optional-field typing (ROOT guard asserts) ─────────────
  const wsEntry = (over = {}) => ({
    cwd: "/ws", daemon_id: "d", room_id: "r", name: "n",
    live: true, daemon: false, source: "added", ...over,
  });
  const wsList = (entry) => ({ type: "workspace_list_ok", in_reply_to: "1", workspaces: [entry] });
  check("workspace source inválido ('not-a-source') recusado", !isWorkspaceListOk(wsList(wsEntry({ source: "not-a-source" }))));
  check("workspace source daemon aceito", isWorkspaceListOk(wsList(wsEntry({ source: "daemon" }))));
  check("live não-booleano ('true') recusado", !isWorkspaceListOk(wsList(wsEntry({ live: "true" }))));
  check("daemon não-booleano (1) recusado", !isWorkspaceListOk(wsList(wsEntry({ daemon: 1 }))));

  const fsOk = (entries) => ({ type: "fs_list_ok", in_reply_to: "1", path: "/p", parent: null, entries });
  check("FsEntry kind inválido ('not-a-kind') recusado", !isFsListOk(fsOk([{ name: "a", kind: "not-a-kind" }])));
  check("FsEntry kind dir aceito", isFsListOk(fsOk([{ name: "a", kind: "dir" }])));
  check("is_repo 'wrong' (não-booleano) recusado", !isFsListOk(fsOk([{ name: "a", kind: "dir", is_repo: "wrong" }])));
  check("is_repo booleano aceito e opcional", isFsListOk(fsOk([{ name: "a", kind: "dir", is_repo: true }, { name: "b", kind: "file" }])));

  check("in_reply_to não-string recusado", !isServerMessage({ type: "pair_ok", in_reply_to: 7 }) && !isServerMessage({ type: "pair_ok", in_reply_to: null }));
  check("in_reply_to ausente permitido", isServerMessage({ type: "pair_ok" }) && isServerMessage({ type: "pair_ok", in_reply_to: "1" }));
  check("pair_ok hostname opcional string", isPairOk({ type: "pair_ok", session_name: "s", session_started_at: 1, room_id: "host", hostname: "h" }) && !isPairOk({ type: "pair_ok", session_name: "s", session_started_at: 1, room_id: "host", hostname: 3 }));
  check("pair_ok session_started_at NaN/Infinity recusado", !isPairOk({ type: "pair_ok", session_name: "s", session_started_at: NaN, room_id: "host" }) && !isPairOk({ type: "pair_ok", session_name: "s", session_started_at: Infinity, room_id: "host" }));
  check("malformed server message com in_reply_to inválido é recusado no decode", (() => {
    const bad = JSON.stringify({ peer: "p", room: "host", ct: encodeCt({ type: "pair_ok", in_reply_to: 42 }) });
    return codeOf(() => decodeOuterChecked(bad)) === "malformed_ct";
  })());
  check("decodeCt segue genérico (API existente intacta)", decodeCt(encodeCt({ type: "x", n: 1 })).n === 1);
  check("ProtocolFrameError tem texto fixo", new ProtocolFrameError("malformed_ct").message === "malformed protocol frame");
}

// ── 5. connection state machine ─────────────────────────────────────────────

console.log("\n== 5. state.ts (pura, sem token) ==");
{
  const s0 = createConnectionState();
  check("estado inicial idle/0/0", s0.phase === "idle" && s0.generation === 0 && s0.attempt === 0 && s0.diagnostic === null);
  check(
    "estado não carrega token/chave privada",
    Object.keys(s0).sort().join(",") === "attempt,diagnostic,generation,phase,since",
    Object.keys(s0).sort().join(","),
  );

  let s = reduceConnectionState(s0, { type: "connect" }, 10);
  check("connect → relay_authenticating (generation+1, attempt 1)", s.phase === "relay_authenticating" && s.generation === 1 && s.attempt === 1 && s.since === 10);
  // Real host-first path: relay auth → pair → hello/catalog → connected.
  s = reduceConnectionState(s, { type: "pairing" }, 10.5);
  check("relay_authenticating → pairing é legal", s.phase === "pairing");
  s = reduceConnectionState(s, { type: "pair_accepted" }, 11);
  check("pair_accepted → host_authenticating (caminho real relay→pair→hello)", s.phase === "host_authenticating");
  s = reduceConnectionState(s, { type: "host_authenticated" }, 12);
  check("host_authenticated → connected", s.phase === "connected" && isUsablePhase(s.phase));
  s = reduceConnectionState(s, { type: "connection_lost", code: "connection_lost" }, 13);
  check("queda → reconnecting (attempt+1, diagnóstico sanitizado)", s.phase === "reconnecting" && s.attempt === 2 && s.diagnostic?.code === "connection_lost");
  s = reduceConnectionState(s, { type: "retry_exhausted" }, 14);
  check("orçamento esgotado → error", s.phase === "error" && s.diagnostic?.message.includes("reconnect"));

  const event = { type: "host_authenticated" };
  const before = JSON.stringify(reduceConnectionState(createConnectionState(), { type: "connect" }, 1));
  const base0 = reduceConnectionState(createConnectionState(), { type: "connect" }, 1);
  const snapshot = JSON.stringify(base0);
  reduceConnectionState(base0, event, 2);
  check("reducer não muta o estado de entrada", JSON.stringify(base0) === snapshot && before === snapshot);

  const outOfOrder = reduceConnectionState(createConnectionState(), { type: "host_authenticated" }, 5);
  check("evento fora de ordem é ignorado, não estoura", outOfOrder.phase === "idle");

  check("disabled → idle com connect", reduceConnectionState(createConnectionState({ phase: "disabled" }), { type: "connect" }, 1).phase === "idle");
  check("close → closing → closed (terminal)", reduceConnectionState(reduceConnectionState(s0, { type: "close" }, 1), { type: "closed" }, 2).phase === "closed");
  check(
    "transições ilegais recusadas",
    !canTransition("pairing", "relay_authenticated") &&
      !canTransition("disabled", "connected") &&
      !canTransition("pairing", "idle") &&
      !canTransition("closing", "reconnecting"),
  );
  // ROOT-asserted legality: the pair phase sits between relay auth and the
  // host handshake, so these two edges MUST hold.
  check("ROOT: relay_authenticating → pairing é legal", canTransition("relay_authenticating", "pairing"));
  check("ROOT: pairing → host_authenticating é legal", canTransition("pairing", "host_authenticating"));
  // A rejected/expired token is possible in BOTH phases → reauth from both.
  check("ROOT: pairing → reauth_required é legal", canTransition("pairing", "reauth_required"));
  check("ROOT: host_authenticating → reauth_required é legal", canTransition("host_authenticating", "reauth_required"));

  // Retry counter is NOT reset while retrying (generation DOES advance).
  let r = reduceConnectionState(createConnectionState(), { type: "connect" }, 20);
  r = reduceConnectionState(r, { type: "connection_lost" }, 21);
  r = reduceConnectionState(r, { type: "relay_authenticating" }, 22);
  r = reduceConnectionState(r, { type: "connection_lost" }, 23);
  r = reduceConnectionState(r, { type: "relay_authenticating" }, 24);
  check(
    "retry preserva o contador de tentativas (attempt 3, generation 3)",
    r.phase === "relay_authenticating" && r.attempt === 3 && r.generation === 3,
    `phase=${r.phase} attempt=${r.attempt} generation=${r.generation}`,
  );
  // A sequence that ends (closed) and starts again resets it to 1.
  let fresh = reduceConnectionState(createConnectionState(), { type: "connect" }, 30);
  fresh = reduceConnectionState(fresh, { type: "close" }, 31);
  fresh = reduceConnectionState(fresh, { type: "closed" }, 32);
  fresh = reduceConnectionState(fresh, { type: "relay_authenticating" }, 33);
  check("nova sequência após closed → attempt 1", fresh.attempt === 1, `attempt=${fresh.attempt}`);

  // Stale-generation guard: a reply from a dead socket cannot move state.
  const staleBase = reduceConnectionState(createConnectionState(), { type: "relay_authenticating" }, 40);
  const staleLost = reduceConnectionState(staleBase, { type: "connection_lost" }, 41);
  const staleReconnect = reduceConnectionState(staleLost, { type: "relay_authenticating" }, 42);
  const guarded = reduceConnectionState(staleReconnect, { type: "relay_authenticated", generation: 1 }, 43);
  check(
    "evento de geração velha é descartado (guarda opcional)",
    guarded.phase === "relay_authenticating" && guarded.generation === 2,
    `phase=${guarded.phase}`,
  );
  const guardedOk = reduceConnectionState(staleReconnect, { type: "relay_authenticated", generation: 2 }, 43);
  check("evento da geração atual passa pela guarda", guardedOk.phase === "host_authenticating");

  const diag = publicDiagnostic("relay_auth_failed");
  check("diagnóstico público = código + texto fixo", diag.code === "relay_auth_failed" && typeof diag.message === "string" && diag.message.length > 0);
  check("código de diagnóstico arbitrário recusado", !isPublicDiagnosticCode("RELATED-SECRET") && !isPublicDiagnosticCode(REMOTE_EVIL));
  check("estado nunca contém string de wire", !JSON.stringify(s).includes(REMOTE_EVIL) && !JSON.stringify(s).includes(SECRET_TOKEN));
  check("isTerminalPhase cobre closed/disabled", isTerminalPhase("closed") && isTerminalPhase("disabled") && !isTerminalPhase("reconnecting"));
}

// ── 6. persistence ──────────────────────────────────────────────────────────

console.log("\n== 6. persistence.ts ==");
{
  const record = {
    relayUrl: "wss://relay.example",
    hostEpk: EPK,
    name: "host-sessao",
    roomId: "host",
    token: SECRET_TOKEN,
  };

  const storage = memoryStorage();
  saveStoredSession(storage, record);
  const rawStored = storage.map.get(SESSION_STORAGE_KEY);
  check("chave exata remote-pi-web-session-v1", storage.map.has("remote-pi-web-session-v1"));
  check("serialização tem exatamente 5 campos", Object.keys(JSON.parse(rawStored)).sort().join(",") === "hostEpk,name,relayUrl,roomId,token");
  const loaded = loadStoredSession(storage);
  check("roundtrip válido", JSON.stringify(loaded) === JSON.stringify(record));

  const withExtras = { ...record, privateKey: "SEGREDO", pending: [1], transcript: "x" };
  check(
    "serializer só grava os 5 campos (sem private/pending/transcript)",
    Object.keys(JSON.parse(serializeStoredSession(withExtras))).length === 5 &&
      !serializeStoredSession(withExtras).includes("SEGREDO"),
  );

  const cases = [
    ["JSON inválido", "{not json"],
    ["chave extra", JSON.stringify({ ...record, extra: 1 })],
    ["epk 31 bytes", JSON.stringify({ ...record, hostEpk: Buffer.alloc(31, 1).toString("base64") })],
    ["epk base64url (não canônico)", JSON.stringify({ ...record, hostEpk: EPK_URL })],
    ["epk vazio", JSON.stringify({ ...record, hostEpk: "" })],
    ["roomId filho", JSON.stringify({ ...record, roomId: "workspace-x" })],
    ["relayUrl com credenciais", JSON.stringify({ ...record, relayUrl: "wss://u:p@relay.example" })],
    ["campo não-string", JSON.stringify({ ...record, name: 42 })],
    ["nome só espaços", JSON.stringify({ ...record, name: "   " })],
    ["token só espaços", JSON.stringify({ ...record, token: " \t " })],
    ["token vazio", JSON.stringify({ ...record, token: "" })],
    ["array no lugar do objeto", "[1,2]"],
  ];
  for (const [label, value] of cases) {
    const store = memoryStorage({ [SESSION_STORAGE_KEY]: value });
    const result = loadStoredSession(store);
    check(
      `registro inválido removido (${label})`,
      result === null && store.map.has(SESSION_STORAGE_KEY) === false,
    );
  }
  check("parseStoredSession recusa inválido com código tipado", codeOf(() => parseStoredSession({ ...record, roomId: "x" })) === "invalid_record");
  // Exactly the five schema fields, each an OWN value: an object that only
  // “inherits” a field (prototype) is not a stored session.
  const protoRecord = Object.create({ relayUrl: "wss://relay.example" });
  Object.assign(protoRecord, { hostEpk: EPK, name: "n", roomId: "host", token: SECRET_TOKEN });
  check("chave herdada do protótipo não satisfaz o schema", codeOf(() => parseStoredSession(protoRecord)) === "invalid_record");
  check("campo só-espaços recusado no parse direto", codeOf(() => parseStoredSession({ ...record, name: "  " })) === "invalid_record");
  check("serializer recusa sessão inválida em vez de gravá-la", codeOf(() => serializeStoredSession({ ...record, token: "  " })) === "invalid_record");

  const empty = memoryStorage();
  check("sem registro → null (e nenhum erro)", loadStoredSession(empty) === null);

  const corrupt = memoryStorage({ [SESSION_STORAGE_KEY]: "{corrompido" });
  clearStoredSession(corrupt);
  check("clear explícito funciona mesmo com storage corrompido", corrupt.map.has(SESSION_STORAGE_KEY) === false);

  check("falha de leitura → storage_read_failed", codeOf(() => loadStoredSession(throwingStorage("read"))) === "storage_read_failed");
  check("falha de escrita → storage_write_failed", codeOf(() => saveStoredSession(throwingStorage("write"), record)) === "storage_write_failed");
  check("escrita engolida em silêncio → storage_write_failed (nunca falso sucesso)", codeOf(() => saveStoredSession(swallowingStorage(), record)) === "storage_write_failed");
  check("falha de remoção → storage_remove_failed", codeOf(() => clearStoredSession(throwingStorage("remove"))) === "storage_remove_failed");
  check(
    "remoção do registro corrompido que falha fica visível",
    codeOf(() => loadStoredSession({ getItem: () => "{corrompido", setItem() {}, removeItem() { throw new Error("denied"); } })) === "storage_remove_failed",
  );

  const secretBearing = memoryStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ ...record, extra: REMOTE_EVIL }) });
  const before = secretBearing.map.get(SESSION_STORAGE_KEY);
  loadStoredSession(secretBearing);
  check("registro inválido não fica pela metade no disco", before.includes("REMOTE-EVIL") && !secretBearing.map.has(SESSION_STORAGE_KEY));

  const errors = [
    codeOf(() => loadStoredSession(throwingStorage("read"))),
    messageOf(() => loadStoredSession(throwingStorage("read"))),
    messageOf(() => saveStoredSession(throwingStorage("write"), record)),
    messageOf(() => clearStoredSession(throwingStorage("remove"))),
    messageOf(() => parseStoredSession({ ...record, token: SECRET_TOKEN, relayUrl: REMOTE_EVIL })),
  ];
  check(
    "erros de persistência não vazam exceção crua nem token/texto remoto",
    errors.every((e) => !e.includes("REMOTE-EVIL") && !e.includes(SECRET_TOKEN) && !e.includes("raw:")),
    errors.join(" | "),
  );
  check(
    "erros de persistência têm texto fixo (inglês)",
    messageOf(() => loadStoredSession(throwingStorage("read"))) === "Could not read the saved session.",
  );
  check("SessionPersistenceError tipado", new SessionPersistenceError("invalid_record").code === "invalid_record");

  // module scope never touches window: importing already succeeded in Node.
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { return undefined; } });
  check("browserSessionStorage() → null sem localStorage (SSR)", browserSessionStorage() === null);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error(`denied:${REMOTE_EVIL}`); },
  });
  const unavailable = codeOf(() => browserSessionStorage());
  check("acesso negado ao localStorage → storage_unavailable", unavailable === "storage_unavailable");
  check("erro de storage indisponível não ecoa exceção", !messageOf(() => browserSessionStorage()).includes("denied:"));
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete globalThis.localStorage;
}

console.log(`\n${checks - failures}/${checks} checks PASS`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-foundations: OK");
