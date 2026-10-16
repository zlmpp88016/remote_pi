/* =====================================================================
   Remote Pi — web app prototype · fake data

   Everything here is in-memory and invented. The shapes mirror what the
   real client would receive from the host: workspaces, sessions, and a
   turn-structured transcript (user prompt + assistant blocks).
   ===================================================================== */
'use strict';

const ICONS = {
  plus:'<path d="M12 5v14M5 12h14"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  columns:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  x:'<path d="M18 6L6 18M6 6l12 12"/>',
  chevR:'<path d="M9 6l6 6-6 6"/>',
  chevD:'<path d="M6 9l6 6 6-6"/>',
  copy:'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  check:'<path d="M20 6L9 17l-5-5"/>',
  send:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
  clip:'<path d="M21.4 11.1l-8.5 8.5a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.3-2.3l7.8-7.8"/>',
  at:'<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.9 7.9"/>',
  slash:'<path d="M17 4L7 20"/>',
  spark:'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  term:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  file:'<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  folder:'<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  branch:'<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-4 3-6 5"/>',
  pin:'<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  pencil:'<path d="M4 20h4l11-11a2.8 2.8 0 00-4-4L4 16z"/>',
  archive:'<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4"/>',
  fork:'<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v3a2 2 0 002 2h8a2 2 0 002-2V7M12 12v5"/>',
  alert:'<path d="M10.3 4.3L2.6 17.6A2 2 0 004.3 20.6h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  ok:'<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  msg:'<path d="M21 12a8 8 0 01-11.6 7.1L4 21l1.9-5.4A8 8 0 1121 12z"/>',
  more:'<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  book:'<path d="M4 5a2 2 0 012-2h13v18H6a2 2 0 01-2-2z"/><path d="M8 7h7M8 11h7"/>',
  cpu:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  plug:'<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 01-12 0z"/><path d="M12 18v3"/>',
  diff:'<path d="M6 3v6a3 3 0 003 3h6a3 3 0 013 3v6"/><circle cx="6" cy="3" r="2"/><circle cx="18" cy="21" r="2"/>',
  eye:'<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
  refresh:'<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>',
  kbd:'<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
};
const ic = (n, cls) =>
  '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';

const HOST = {
  name:'example-mac', label:'MacBook Pro · M3 Pro',
  relay:'wss://relay.remote-pi.dev', version:'0.9.4', commit:'3df5650',
  peer:'ed25519:8f3a91c4…c21e', caps:['host_pairing','workspace_state','fs_nav'],
};

const WORKSPACES = [
  { id:'w1', name:'remote-pi', path:'~/Projects/remote_pi/remote-pi' },
  { id:'w2', name:'app',        path:'~/Projects/remote_pi/app' },
  { id:'w3', name:'relay',      path:'~/Projects/remote_pi/relay' },
  { id:'w4', name:'site',       path:'~/Projects/remote_pi/site' },
];

const NOW = Date.now();
const ago = m => new Date(NOW - m * 60000).toISOString();

/* Transcript blocks:
   md     { html }
   reason { text }
   code   { lang, code }
   tool   { name, target, kind, state, input, output }
   ask    { state, cmd, note }
   qcard  { q, opts:[{t,s}], chosen }
   usage  { meta }                                                       */
const TURNS = {

  pairing: [
    { prompt:'The relay now validates Origin and echoes the subprotocol. What is left is web client pairing through the host room — today it can only talk to a Pi room. How would you close that?',
      blocks:[
        { k:'reason', text:'The client anchors only on room "host" (plan 69, decision B). pair_request has to survive the HostBridge allow-list, otherwise an unknown peer is dropped before the handler is reached. Let me confirm where the cut happens before proposing a shape.' },
        { k:'tool', name:'grep', target:'unknown peer / allow-list', kind:'search', state:'ok',
          input:'pattern: "knownPeers|unknown peer"\npath: src/daemon/host_bridge.ts\ncontext: 4',
          output:'host_bridge.ts:103\n  if (!this.knownPeers.has(peer)) {\n    // drop: no carve-out for pairing yet\n    return;\n  }\n\nsrc/index.ts:1985  (Pi process, for reference)\n  if (inner.type !== "pair_request" && !known) return;' },
        { k:'md', html:
`<p>Three edits, one of them load-bearing:</p>
<table><thead><tr><th>#</th><th>Where</th><th>Change</th></tr></thead><tbody>
<tr><td>1</td><td><code>host_bridge.ts:103</code></td><td>Carve-out: let <code>pair_request</code> through for unknown peers</td></tr>
<tr><td>2</td><td><code>daemon/pairing.ts</code></td><td>Validate the token, <code>addPeer</code>, answer <code>pair_ok</code> / <code>pair_error</code> from the same sender</td></tr>
<tr><td>3</td><td><code>control_protocol.ts</code></td><td><code>pair_show</code> / <code>pair_rotate</code> so the CLI works with zero Pi</td></tr>
</tbody></table>
<p>The carve-out must stay narrower than what the Pi process already does: there it is <code>inner.type !== "pair_request" &amp;&amp; !known</code>, so any other unknown type is still refused.</p>` },
        { k:'code', lang:'ts', code:
`// src/daemon/host_bridge.ts
const isPairing = inner.type === 'pair_request';
if (!this.knownPeers.has(peer) && !isPairing) return;

if (isPairing) {
  const verdict = await this.pairing.accept(inner);   // token -> peer
  return this.send(peer, verdict.ok
    ? { type: 'pair_ok',    in_reply_to: inner.id }
    : { type: 'pair_error', in_reply_to: inner.id, code: verdict.code });
}` },
      ] },

    { prompt:'Good. Implement the carve-out and show me the test.',
      blocks:[
        { k:'reason', text:'The pairing module already exists for the Pi path, so I will reuse it rather than adding a second validator, and keep the persistent token in ~/.pi/remote/pairing.json so it survives a daemon restart.' },
        { k:'tool', name:'read', target:'src/daemon/host_bridge.ts', kind:'read', state:'ok',
          input:'path: src/daemon/host_bridge.ts\noffset: 92\nlimit: 34',
          output:'  92  private handleInner(peer: string, inner: ClientMessage) {\n  93    if (!this.knownPeers.has(peer)) {\n  94      // TODO(plan-69): pairing carve-out\n  95      return;\n  96    }\n  97    switch (inner.type) {\n  98      case "host_hello":      return this.onHello(peer, inner);\n  99      case "workspace_list":  return this.onList(peer, inner);' },
        { k:'tool', name:'edit', target:'src/daemon/host_bridge.ts', kind:'edit', state:'ok',
          input:'replacing the unknown-peer guard with the carve-out',
          output:'diff --git a/src/daemon/host_bridge.ts b/src/daemon/host_bridge.ts\n@@ -92,6 +92,12 @@\n-    if (!this.knownPeers.has(peer)) {\n-      // TODO(plan-69): pairing carve-out\n-      return;\n-    }\n+    if (!this.knownPeers.has(peer)) {\n+      // Plan 69 W1: a device nobody knows may still ask to pair.\n+      // Everything else from an unknown peer stays dropped.\n+      if (inner.type === "pair_request") {\n+        return void this.onPairing(peer, inner);\n+      }\n+      return;\n+    }' },
        { k:'qcard', q:'Where should the pairing token live?', chosen:1,
          opts:[
            { t:'Ephemeral only (60s TTL)', s:'As before — every device re-pairs after a daemon restart' },
            { t:'Persistent, rotatable with --rotate', s:'Predefined code on the host, survives restarts; --ephemeral stays available' },
            { t:'Read from an environment variable', s:'Injected by the supervisor service definition' } ] },
        { k:'md', html:
`<p>Implemented. The persistent token is now the default, with <code>--ephemeral</code> preserved as an option:</p>
<ul>
<li>the guard lets exactly <code>pair_request</code> through — every other unknown type is still dropped;</li>
<li><code>onPairing</code> answers <code>pair_ok</code> / <code>pair_error</code> on the same sender, so the client needs no second connection;</li>
<li>the token is read from <code>~/.pi/remote/pairing.json</code>, so a supervisor restart no longer invalidates a paired device.</li>
</ul>` },
        { k:'usage', meta:'3 tool calls · 18.4k in / 2.1k out · 41.2k context (17%)' },
      ] },

    { prompt:'And the unknown-peer test? I want the rotated-token case too.',
      blocks:[
        { k:'reason', text:'The interesting assertion is not "pairing works" — it is that a rotated token fails while a valid one succeeds, and that the same unknown peer cannot slip any other message through the carve-out.' },
        { k:'tool', name:'write', target:'test/pairing_host_test.ts', kind:'write', state:'ok',
          input:'path: test/pairing_host_test.ts\nlines: 46',
          output:'+  it("lets an unknown peer pair", async () => {\n+    const ok = await bridge.receive(UNKNOWN, pairRequest(TOKEN));\n+    expect(ok.type).toBe("pair_ok");\n+    expect(peers.has(UNKNOWN)).toBe(true);\n+  });\n+\n+  it("refuses a rotated token", async () => {\n+    const err = await bridge.receive(UNKNOWN, pairRequest(OLD_TOKEN));\n+    expect(err).toMatchObject({ type: "pair_error", code: "token_invalid" });\n+  });\n+\n+  it("still drops other types from an unknown peer", async () => {\n+    const res = await bridge.receive(UNKNOWN, { type: "workspace_list" });\n+    expect(res).toBeUndefined();\n+  });' },
        { k:'ask', state:'pending', cmd:'pnpm vitest run test/pairing_host_test.ts',
          note:'Reads the workspace and writes nothing outside the repo.' },
      ] },
  ],

  origin: [
    { prompt:'Relay needs an Origin allowlist before the browser can connect. Configurable, and it must reject everything else.',
      blocks:[
        { k:'tool', name:'read', target:'relay/src/server.rs', kind:'read', state:'ok',
          input:'path: relay/src/server.rs\nsymbol: accept_hdr_async',
          output:' 14  pub async fn accept_hdr_async(\n 15    stream: TcpStream,\n 16    callback: impl FnMut(&Request, Response) -> Result<Response, ErrorResponse>,\n 17  ) -> Result<WebSocketStream<TcpStream>, Error> {' },
        { k:'code', lang:'rust', code:
`// relay/src/origin.rs
pub fn check(headers: &HeaderMap, allow: &[Origin]) -> Result<(), OriginError> {
    let Some(raw) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Err(OriginError::Missing);      // browsers always send it
    };
    if allow.iter().any(|a| a.matches(raw)) {
        Ok(())
    } else {
        Err(OriginError::Rejected(raw.to_owned()))
    }
}` },
        { k:'md', html:'<p>The allowlist is a config list of <code>scheme://host[:port]</code> entries. A missing <code>Origin</code> is a rejection, not a pass — non-browser clients use the peer envelope and never reach this path.</p>' },
      ] },
    { prompt:'Add the subprotocol echo and land both with tests.',
      blocks:[
        { k:'tool', name:'bash', target:'cargo test origin', kind:'bash', state:'ok',
          input:'cargo test origin -- --nocapture',
          output:'running 6 tests\ntest origin::allows_listed        ... ok\ntest origin::rejects_other        ... ok\ntest origin::rejects_missing      ... ok\ntest origin::echoes_subprotocol   ... ok\ntest origin::port_matters         ... ok\ntest origin::wildcard_subdomain   ... ok\n\ntest result: ok. 6 passed; 0 failed' },
        { k:'md', html:'<p>Both landed. <code>cargo test</code> is green on the relay crate (126 passed overall), and the browser path now negotiates <code>remote-pi.v1</code> explicitly.</p>' },
        { k:'usage', meta:'2 tool calls · 9.8k in / 1.4k out' },
      ] },
  ],

  codec: [
    { prompt:'Message ids come from three sources — live turns, local input, history sync. Can we collapse them into one canonical id?',
      blocks:[
        { k:'reason', text:'The three sources produce three shapes: cli_<uuid> for a live assistant message, local_<uuid> for local input, sync_<ts> for history. The dedup key in the app is a band-aid over that. A canonical id has to be derived, not assigned, otherwise the same message still gets two ids.' },
        { k:'md', html:
`<p>Yes — but the id must be <strong>derived from the recorded event</strong>, not minted at delivery time:</p>
<ul>
<li><code>&lt;session&gt;:&lt;seq&gt;</code> as the canonical key — the JSONL is append-only, so <code>seq</code> is already stable;</li>
<li>keep the legacy id as an <em>alias</em> field for one release, so an already-shipped client keeps deduping as it does today;</li>
<li>the app stops inventing ids and keys on the canonical one.</li>
</ul>
<p>The protocol impact is purely additive: one optional field, no existing field changes meaning.</p>` },
      ] },
    { prompt:'What breaks in the already-shipped app if we send the new field?',
      blocks:[
        { k:'tool', name:'grep', target:'dedup key in the app', kind:'search', state:'ok',
          input:'pattern: "role}:\\$\\{msg.id\\}|_dedupeKey"\npath: app/lib/data/sessions/',
          output:'session_catalog.dart:214\n  final key = "$role:${msg.id}";   // uses whatever id arrives\n\nsync_service.dart:88\n  String _dedupeKey(m) => "${m.role}:${m.id}";' },
        { k:'md', html:'<p>Nothing breaks. The app only ever <em>reads</em> <code>msg.id</code>, and the fallback is what it already does when no canonical id is present. Shipping the field first and switching the app afterwards is safe in either order.</p>' },
      ] },
  ],

  cursor: [
    { prompt:'Replace the tail-N mirror with cursor pagination over the Pi JSONL, filtered to the active branch.',
      blocks:[
        { k:'tool', name:'bash', target:'pnpm vitest transcript', kind:'bash', state:'error',
          input:'pnpm vitest run src/transcript',
          output:'FAIL  src/transcript/cursor.test.ts\n  ● pages forward from a cursor\n\n    expected [40, 41, 42] to equal [41, 42, 43]\n\n      at src/transcript/cursor.test.ts:64:5\n\n  ● stops at the branch leaf\n\n    TypeError: Cannot read properties of undefined (reading \'id\')\n\nTest Files  1 failed (1)\n     Tests  2 failed | 5 passed (7)' },
        { k:'md', html:'<p>Two failures, both real:</p><ul><li>the cursor is inclusive where it should be exclusive — the first page repeats its last entry;</li><li>branch filtering walks past the leaf when the active leaf is not the last entry in the file.</li></ul><p>I stopped here instead of patching the assertions; the second one is a genuine walk bug.</p>' },
        { k:'ask', state:'denied', cmd:'edit src/transcript/branch.ts',
          note:'Denied — needs a decision on the walk direction first.' },
      ] },
  ],

  spike: [
    { prompt:'Spike: can one app connection keep room "host" and the workspace rooms alive at the same time?',
      blocks:[
        { k:'md', html:'<p>Yes. The relay already multiplies rooms per connection. Verified against the stub with two simultaneous rooms — <code>_liveRoomIds</code> holds <code>["host","ws-1"]</code> and neither drops when the Pi child is killed.</p>' },
        { k:'usage', meta:'read-only spike · no writes' },
      ] },
  ],
};

const SESSIONS = [
  { id:'s1', ws:'w1', title:'Web client: host-first pairing', turns:TURNS.pairing,
    status:'running', pending:'approval', updated:ago(2), pinned:true, archived:false,
    model:'deepseek-v4-pro', thinking:'high', ctx:17, cost:'$0.42' },
  { id:'s2', ws:'w3', title:'Relay: Origin allowlist + subprotocol', turns:TURNS.origin,
    status:'done', pending:null, updated:ago(38), pinned:false, archived:false,
    model:'deepseek-v4-pro', thinking:'medium', ctx:9, cost:'$0.18' },
  { id:'s3', ws:'w1', title:'Codec: canonical message ids', turns:TURNS.codec,
    status:'idle', pending:null, updated:ago(96), pinned:false, archived:false,
    model:'deepseek-v4-flash', thinking:'medium', ctx:6, cost:'$0.07' },
  { id:'s4', ws:'w1', title:'Transcript cursor pagination', turns:TURNS.cursor,
    status:'warn', pending:null, updated:ago(190), pinned:false, archived:false,
    model:'deepseek-v4-pro', thinking:'xhigh', ctx:23, cost:'$0.31' },
  { id:'s5', ws:'w2', title:'Mirror cache: offline transcripts', turns:[],
    status:'idle', pending:null, updated:ago(1420), pinned:false, archived:false,
    model:'deepseek-v4-flash', thinking:'low', ctx:0, cost:'$0.00' },
  { id:'s6', ws:'w4', title:'Landing page: Cockpit 2.0 announce', turns:[],
    status:'idle', pending:null, updated:ago(2600), pinned:false, archived:false,
    model:'deepseek-v4-flash', thinking:'low', ctx:0, cost:'$0.00' },
  { id:'s7', ws:'w2', title:'Spike: room multiplex for the app', turns:TURNS.spike,
    status:'done', pending:null, updated:ago(4300), pinned:false, archived:true,
    model:'deepseek-v4-pro', thinking:'high', ctx:11, cost:'$0.09' },
];

const FILES = {
  src: [
    { n:'daemon', d:true }, { n:'pairing', d:true }, { n:'protocol', d:true }, { n:'transcript', d:true },
    { n:'index.ts', d:false, s:'118 KB' }, { n:'package.json', d:false, s:'1.9 KB' }, { n:'tsconfig.json', d:false, s:'612 B' },
  ],
  daemon: [
    { n:'host_bridge.ts', d:false, s:'41 KB' }, { n:'host_control.ts', d:false, s:'22 KB' },
    { n:'pairing.ts', d:false, s:'8.4 KB' }, { n:'supervisor.ts', d:false, s:'19 KB' },
  ],
};

const PLAN_DOC = [
'# Plan 69 — Host-first connection',
'',
'Status: APPROVED (2026-10-08) — execute without a new round.',
'',
'## Contracts',
'',
'- The canonical connection is the **host** (resident daemon); app, web and pc',
'  connect to the host, never to a Pi process.',
'- Pairing works with **no Pi running**: address + pairing code. The code is',
'  predefined on the host, persistent, rotatable with `--rotate`.',
'- The payload `remotepi://pair?…` stays byte-identical — only the emitter and',
'  the consumer change.',
'',
'## Waves',
'',
'| # | Scope | State |',
'|---|---|---|',
'| W0 | Reconciliation + contract | done |',
'| W1 | Pairing without Pi (daemon-side) | done |',
'| W2 | Host-primary connection + Pi lifecycle | done |',
'| W3 | Pc (Cockpit + app windows) | done |',
'| W4 | Web — relay Origin, browser Ed25519, minimal client | **in progress** |',
'',
'## W4 — Web',
'',
'- Relay: configurable Origin allowlist + WS subprotocol echo.',
'- Browser: Ed25519 with capability detection and a wasm fallback.',
'- Minimal client: pair (address + code) → browse fs → start Pi → chat.',
'',
'**Acceptance:** the web client pairs and talks against the relay stub with the',
'Origin allowlist active; an origin outside the list is rejected; message parity',
'with the app (same PROTOCOL.md).',
].join('\n');
