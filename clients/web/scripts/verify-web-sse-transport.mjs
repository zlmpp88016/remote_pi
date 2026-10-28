/**
 * SSE transport gate (plan/76 TODO C1).
 *
 * ## What this proves
 *
 * The SSE transport replaced a WebSocket, so the things that can silently break
 * are exactly the things a WebSocket gave for free:
 *
 *   1. the connection id arrives as a NAMED event and is picked up by
 *      `addEventListener`, not `onmessage`;
 *   2. outbound frames actually reach the host and a reply comes back;
 *   3. two tabs are isolated — one tab's traffic never reaches the other;
 *   4. a stale connection id is reported instead of silently dropping frames.
 *
 * ## Why the browser, and why these particular assertions
 *
 * A Node client that reads the raw stream would pass a broken id handshake: it can
 * subscribe to every event, while a browser only calls `onmessage` for unnamed
 * events. That exact gap is what shipped a "connected but every frame vanished"
 * bug, so the handshake is asserted in a real page.
 *
 * The isolation test has a POSITIVE CONTROL on each side. "tabB received nothing"
 * is worthless alone — a tabB whose stream is simply dead also receives nothing.
 * So the gate first proves each tab receives its OWN reply, and only then asserts
 * the cross-talk is zero.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, evaluate, sleep } from "./_cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "_e2e-evidence");
mkdirSync(EVIDENCE, { recursive: true });

const PORT = Number(process.env.DIRECT_PORT ?? 4124);
const APP = process.env.APP_ORIGIN ?? `http://127.0.0.1:${PORT}`;

const results = [];
/**
 * Record one assertion.
 *
 * @param ok - whether it held.
 * @param label - what was checked.
 * @param detail - observed value.
 */
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

const { send, ws } = await attach();

/* Reach the same-origin page so the cookie and origin are real. */
await evaluate(send, `location.href=${JSON.stringify(APP)}`);
await sleep(4000);

/**
 * The browser-side probe, as source text.
 *
 * Kept as a plain string (no template interpolation) so the browser sees exactly
 * the code written here.
 */
const PROBE_SOURCE = `
(async function(){
  var out = {
    endpointId: null,
    unnamedAtHandshake: null,
    replies: [],
    postStatus: null
  };

  /*
   * The envelope peer is the DESTINATION host public key, not the sender. An
   * empty peer makes the relay drop the frame, so the probe learns it the same
   * way the real client does: from the pairing credentials.
   */
  var hostEpk = null;
  try {
    var br = await fetch('/api/bootstrap', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'} });
    if (br.ok) hostEpk = (await br.json()).hostEpk;
  } catch (e) {}
  out.hostEpkPrefix = hostEpk ? hostEpk.slice(0, 10) : null;

  var source = new EventSource('/api/events', { withCredentials: true });

  /*
   * THE TRAP THIS GATE EXISTS FOR: the id arrives as a NAMED event. A client
   * that only set onmessage would never see it, would POST without an id, and
   * every outbound frame would be refused while the UI looked healthy. So the id
   * is read via addEventListener, and unnamed messages are recorded separately.
   */
  source.addEventListener('endpoint', function(ev){
    try { out.endpointId = JSON.parse(ev.data).id; } catch (e) { out.endpointId = 'PARSE_FAIL'; }
  });
  var unnamed = [];
  source.onmessage = function(ev){ unnamed.push(String(ev.data)); };

  for (var i = 0; i < 40 && (out.endpointId === null || hostEpk === null); i++) {
    await new Promise(function(r){ setTimeout(r, 100); });
  }
  if (out.endpointId === null || out.endpointId === 'PARSE_FAIL' || hostEpk === null) {
    source.close();
    out.unnamedAtHandshake = unnamed.length;
    return out;
  }
  /* Freeze the handshake window; later unnamed frames are real replies. */
  out.unnamedAtHandshake = unnamed.length;

  try {
    var requestId = 'gate-' + Math.random().toString(36).slice(2);
    out.requestId = requestId;
    var inner = JSON.stringify({ type:'workspace_list', id: requestId });
    var bytes = new TextEncoder().encode(inner);
    var binary = '';
    for (var k = 0; k < bytes.length; k++) binary += String.fromCharCode(bytes[k]);
    var env = JSON.stringify({ peer: hostEpk, room: 'host', ct: btoa(binary) });
    var res = await fetch('/api/frame?id=' + encodeURIComponent(out.endpointId), {
      method:'POST',
      credentials:'same-origin',
      headers:{'content-type':'application/json'},
      body: env
    });
    out.postStatus = res.status;
  } catch (e) {
    out.postError = String(e).slice(0, 80);
  }

  for (var j = 0; j < 40 && unnamed.length <= out.unnamedAtHandshake; j++) {
    await new Promise(function(r){ setTimeout(r, 100); });
  }
  out.replies = unnamed.slice(out.unnamedAtHandshake);
  source.close();
  return out;
})()
`;

/**
 * Run one SSE probe in the page.
 *
 * @returns the observation record, including the inner type and request id of
 *          every reply, decoded from the envelope's base64 `ct`.
 */
async function probeOnce() {
  const raw = await evaluate(send, PROBE_SOURCE);
  /*
   * Decode `ct`. The outer envelope is only `{peer, room, ct}` — `in_reply_to` and
   * `id` live INSIDE the base64 payload. Reading them off the envelope (as the
   * first version did) always yields nothing, which made the isolation check pass
   * on two empty sets and prove exactly zero.
   */
  const inner = [];
  for (const text of Array.isArray(raw.replies) ? raw.replies : []) {
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof envelope.ct !== "string") continue;
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(envelope.ct, "base64").toString("utf8"));
    } catch {
      continue;
    }
    inner.push({
      type: typeof decoded.type === "string" ? decoded.type : "?",
      id: typeof decoded.in_reply_to === "string" ? decoded.in_reply_to : null,
    });
  }
  return { ...raw, inner };
}

/* ── 1. Handshake happens through addEventListener ───────────────────────── */
const first = await probeOnce();
check(
  typeof first.endpointId === "string" && first.endpointId.length > 8,
  "endpoint id arrives via addEventListener (not onmessage)",
  String(first.endpointId).slice(0, 20),
);
check(
  first.unnamedAtHandshake === 0,
  "the named endpoint event never fires onmessage (proves the trap is real)",
  `onmessage saw ${first.unnamedAtHandshake} unnamed message(s) before the id`,
);
check(first.postStatus === 204, "POST /api/frame with the id is accepted", `status ${first.postStatus}`);
check(
  first.inner.some((frame) => frame.type === "workspace_list_ok"),
  "a real workspace_list_ok comes back over the stream",
  `inner types: ${first.inner.map((f) => f.type).join(",") || "none"}`,
);

/* ── 2. Multi-tab isolation, with a positive control on each side ────────── */
const [tabA, tabB] = await Promise.all([probeOnce(), probeOnce()]);
check(
  Array.isArray(tabA.replies) && tabA.replies.length > 0,
  "tab A receives its own reply (positive control)",
  `${Array.isArray(tabA.replies) ? tabA.replies.length : 0} reply(ies)`,
);
check(
  Array.isArray(tabB.replies) && tabB.replies.length > 0,
  "tab B receives its own reply (positive control)",
  `${Array.isArray(tabB.replies) ? tabB.replies.length : 0} reply(ies)`,
);

/*
 * `workspace_list_ok` is a plain response, not a correlated reply — it carries no
 * `in_reply_to`. So the positive control is "this tab received a workspace_list_ok",
 * and ownership is proved by the cross-talk check below rather than by request ids.
 */
const hasWorkspaceListOk = (probe) => probe.inner.some((frame) => frame.type === "workspace_list_ok");

check(
  hasWorkspaceListOk(tabA),
  "tab A received a workspace_list_ok (positive control)",
  `inner types: ${tabA.inner.map((f) => f.type).join(",") || "none"}`,
);
check(
  hasWorkspaceListOk(tabB),
  "tab B received a workspace_list_ok (positive control)",
  `inner types: ${tabB.inner.map((f) => f.type).join(",") || "none"}`,
);

/*
 * Ownership. The probe's request carries a unique id; a reply that names the OTHER
 * tab's id, or a tab receiving more than one workspace_list_ok for its single
 * request, is leakage. With per-stream identities each tab sees exactly one.
 */
const aIds = new Set(tabA.inner.map((frame) => frame.id).filter((id) => id !== null));
const bIds = new Set(tabB.inner.map((frame) => frame.id).filter((id) => id !== null));
const leakedToB = [...bIds].filter((id) => id === tabA.requestId);
const leakedToA = [...aIds].filter((id) => id === tabB.requestId);
check(
  leakedToB.length === 0 && leakedToA.length === 0,
  "no cross-tab leakage (each tab sees only its own request id)",
  `A saw B's: ${leakedToA.length}, B saw A's: ${leakedToB.length}`,
);

/*
 * The shared-identity regression measured directly: both tabs in one relay bucket
 * each receive BOTH replies, so the workspace_list_ok count doubles.
 */
const countOk = (probe) => probe.inner.filter((frame) => frame.type === "workspace_list_ok").length;
check(
  countOk(tabA) === 1 && countOk(tabB) === 1,
  "each tab received exactly one workspace_list_ok (shared identity would give 2)",
  `A: ${countOk(tabA)}, B: ${countOk(tabB)}`,
);

/* ── 3. A stale connection id must be refused so the client can reconnect ── */
const stale = await evaluate(
  send,
  `(async function(){
     var res = await fetch('/api/frame?id=00000000-0000-0000-0000-000000000000', {
       method:'POST', credentials:'same-origin',
       headers:{'content-type':'application/json'},
       body: JSON.stringify({ type:'workspace_list', id:'stale-probe' })
     });
     return res.status;
   })()`,
);
check(
  stale === 409,
  "a stale connection id is refused with 409 (so the client can reconnect)",
  `status ${stale}`,
);

ws.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.label).join(", ")}`);
  process.exit(1);
}
