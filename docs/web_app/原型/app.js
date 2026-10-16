/* =====================================================================
   Remote Pi — web app prototype behaviour

   No transport: every interaction runs against the in-memory store in
   data.js. The shell follows DeepSeek Harness — a Workspace → Session
   browser on the left, a Conversation with a target ring in the middle,
   and an edge-anchored dock on the right.
   ===================================================================== */
'use strict';

const S = {
  view:'launcher',            // launcher | app
  rail:false,
  dock:false,
  dockTab:'plan',
  theme:'dark',
  target:'chat',              // chat | trajectory
  active:'s1',
  query:'',
  openGroups:{ w1:true, w2:true, w3:true, w4:true },
  expanded:{},                // "sid:turn:block" -> open
  trajSel:null,
  streaming:null,
  toastSeq:0,
  dragging:null,
};

const TOTAL_IDLE_QUOTA = 5;
const $ = id => document.getElementById(id);
const ESC = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const ses = id => SESSIONS.find(s => s.id === id);
const active = () => ses(S.active);
const wsOf = s => WORKSPACES.find(w => w.id === s.ws);
const isOpen = (t, b) => !!S.expanded[S.active + ':' + t + ':' + b];

/* ---- syntax colouring (deliberately tiny; prototype only) ------------- */
function hi(code, lang) {
  let h = ESC(code);
  if (lang === 'diff') {
    return h.split('\n').map(l =>
      l.startsWith('+') ? '<span class="add">' + l + '</span>'
        : l.startsWith('-') ? '<span class="del">' + l + '</span>' : l).join('\n');
  }
  h = h.replace(/(\/\/[^\n]*)/g, '<span class="c">$1</span>');
  h = h.replace(/(&#39;|&quot;|`)[^&\n]{0,90}?\1/g, m => '<span class="s">' + m + '</span>');
  h = h.replace(/\b(const|let|case|return|await|async|function|export|import|type|interface|null|undefined|if|else|new|as|of|from|pub|fn|else|let|mut|Some|None|Ok|Err)\b/g, '<span class="k">$1</span>');
  h = h.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="n">$1</span>');
  return h;
}

/* ---------------------------------------------------------------------
   Sidebar
   --------------------------------------------------------------------- */
function groupSessions(wsId) {
  const all = SESSIONS.filter(s => s.ws === wsId && !s.archived);
  const pinned = all.filter(s => s.pinned);
  // Pinned rows lead; a pinned running session therefore sits above the
  // ordinary running ones rather than being appended after them.
  const rest = all.filter(s => !s.pinned).sort((a, b) => new Date(b.updated) - new Date(a.updated));
  const running = rest.filter(s => s.status === 'running');
  const idle = rest.filter(s => s.status !== 'running');
  // Running sessions stay visible outside the idle quota.
  const shown = idle.slice(0, Math.max(0, TOTAL_IDLE_QUOTA - running.length));
  return { pinned, running, idle, shown, hidden: idle.length - shown.length,
    visible: pinned.concat(running, shown) };
}

function statusIcon(s) {
  if (s.pending === 'approval') return ic('alert', 'st-warn');
  if (s.pending === 'plan') return ic('book', 'st-warn');
  if (s.status === 'running') return '<span class="spin"></span>';
  if (s.status === 'done') return ic('ok', 'st-done');
  if (s.status === 'error') return ic('x', 'st-error');
  if (s.status === 'warn') return ic('alert', 'st-warn');
  return ic('clock', 'st-idle');
}

/* Pending interaction replaces the trailing update time (§ ui-workspace). */
function trailing(s) {
  if (s.pending === 'approval') return 'Approval';
  if (s.pending === 'plan') return 'Plan review';
  if (s.pending === 'answer') return 'Answer';
  if (s.status === 'running') return 'running';
  const m = Math.max(1, Math.round((Date.now() - new Date(s.updated)) / 60000));
  if (m < 60) return m + 'm';
  if (m < 1440) return Math.round(m / 60) + 'h';
  return Math.round(m / 1440) + 'd';
}

function renderRow(s) {
  const acts =
    '<span class="acts">' +
      '<button class="ibtn" data-act="pin" data-id="' + s.id + '" title="' + (s.pinned ? 'Unpin' : 'Pin') + '">' + ic('pin') + '</button>' +
      '<button class="ibtn" data-act="menu" data-id="' + s.id + '" title="Session actions">' + ic('more') + '</button>' +
    '</span>';
  // A row cannot be a <button>: it nests its own action buttons, which the
  // HTML parser would hoist out of it. It is a div with button semantics.
  return '<div class="srow' + (s.id === S.active ? ' active' : '') + (s.archived ? ' archived' : '') +
    '" role="button" tabindex="0" data-act="open" data-id="' + s.id + '" data-st="' + (s.status === 'running' ? 'run' : s.status === 'done' ? 'done' : '') + '">' +
    '<span class="st">' + statusIcon(s) + '</span>' +
    (s.pinned ? ic('pin', 'pin') : '') +
    '<span class="title">' + ESC(s.title) + '</span>' +
    '<span class="meta">' + trailing(s) + '</span>' + acts + '</div>';
}

function renderSidebar() {
  const el = $('sbScroll');
  const q = S.query.trim().toLowerCase();

  if (q) {
    const hits = SESSIONS.filter(s => !s.archived &&
      (s.title.toLowerCase().includes(q) || wsOf(s).name.toLowerCase().includes(q)));
    el.innerHTML = '<div class="sb-sechead">' + hits.length + ' result' + (hits.length === 1 ? '' : 's') + '</div>' +
      (hits.length
        ? '<div class="ws-rows">' + hits.map(renderRow).join('') + '</div>'
        : '<div class="sb-empty">' + ic('search', 'ico') + 'No session matches “' + ESC(S.query) + '”</div>');
    return;
  }

  const archived = SESSIONS.filter(s => s.archived);
  el.innerHTML = WORKSPACES.map(ws => {
    const g = groupSessions(ws.id);
    const open = S.openGroups[ws.id] !== false;
    const count = g.pinned.length + g.running.length + g.idle.length;
    const total = count || 0;

    if (!total) {
      return '<div class="ws-group"><button class="ws-head" data-act="group" data-id="' + ws.id + '">' +
        ic('chevD', 'chev') + ic('folder') +
        '<span class="fname">' + ws.name + '</span>' +
        '<span class="rpath">' + ws.path + '</span></button></div>';
    }

    // Collapsed group shows pinned + running only; expanded adds the idle quota.
    const rows = open ? g.visible : g.pinned.concat(g.running);

    let extra = '';
    if (open && g.hidden > 0) extra = '<button class="showmore" data-act="more" data-id="' + ws.id + '">Show ' + g.hidden + ' more…</button>';
    else if (open && g.hidden === 0 && count > g.pinned.length + g.running.length) extra = '';
    else if (!open && g.idle.length) extra = '<button class="showmore" data-act="more" data-id="' + ws.id + '">Show ' + g.idle.length + ' more…</button>';

    return '<div class="ws-group' + (open ? '' : ' collapsed') + '">' +
      '<button class="ws-head" data-act="group" data-id="' + ws.id + '">' +
        ic('chevD', 'chev') + ic('folder') +
        '<span class="fname">' + ws.name + '</span>' +
        '<span class="rpath">' + ws.path + '</span>' +
        (g.running.length ? '<span class="badge"></span>' : '') +
        '<span class="cnt">' + total + '</span>' +
      '</button>' +
      '<div class="ws-rows">' + rows.map(renderRow).join('') + '</div>' + extra +
    '</div>';
  }).join('') +
  (archived.length
    ? '<div class="sb-sechead">' + ic('archive') + '<span class="grow">Archived</span></div>' +
      '<div class="ws-rows">' + archived.map(renderRow).join('') + '</div>'
    : '');
}

/* ---------------------------------------------------------------------
   Transcript blocks
   --------------------------------------------------------------------- */
function renderBlock(b, t, i) {
  switch (b.k) {
    case 'md':
      return '<div class="prose">' + b.html + '</div>';

    case 'reason':
      return '<details class="reason"' + (b.open ? ' open' : '') + '>' +
        '<summary>' + ic('chevR', 'chev') + ic('spark', 'spark') + 'Reasoning' +
          '<span style="opacity:.65">· ' + b.text.length + ' chars</span></summary>' +
        '<div class="body">' + ESC(b.text) + '</div></details>';

    case 'code':
      return '<div class="cb"><div class="cb-head"><span class="lang">' + ESC(b.lang) + '</span>' +
        '<span class="spacer"></span><button data-act="copy" title="Copy">' + ic('copy') + '</button></div>' +
        '<pre>' + hi(b.code, b.lang) + '</pre></div>';

    case 'tool': {
      const open = isOpen(t, i);
      const st = b.state === 'running' ? '<span class="spin"></span>running'
        : b.state === 'error' ? 'failed' : 'ok';
      const glyph = b.kind === 'bash' ? 'term' : b.kind === 'edit' ? 'diff'
        : b.kind === 'search' ? 'search' : b.kind === 'write' ? 'file' : 'eye';
      const outCls = b.state === 'error' ? 'err' : 'ok';
      return '<div class="tool' + (open ? ' open' : '') + '">' +
        '<button class="tool-head" data-act="tool" data-t="' + t + '" data-b="' + i + '">' +
          ic('chevR', 'chev') + ic(glyph) +
          '<span class="tname">' + ESC(b.name) + '</span>' +
          '<span class="targ">' + ESC(b.target) + '</span>' +
          '<span class="tstate">' + st + '</span>' +
        '</button>' +
        '<div class="tool-body">' +
          '<div class="tool-sect"><div class="lab">Input</div><pre>' + ESC(b.input) + '</pre></div>' +
          '<div class="tool-sect"><div class="lab">Output</div>' +
            '<pre class="' + outCls + '">' + (b.kind === 'edit' ? hi(b.output, 'diff') : ESC(b.output)) +
            (b.state === 'running' ? '<span class="caret"></span>' : '') + '</pre>' +
          '</div>' +
        '</div></div>';
    }

    case 'ask': {
      const cls = b.state === 'pending' ? '' : b.state === 'done' ? ' done' : ' denied';
      const head = b.state === 'pending' ? ic('alert') + 'Waiting for approval'
        : b.state === 'done' ? ic('ok') + 'Approved' : ic('x') + 'Denied';
      const body = b.state === 'pending'
        ? '<div class="ask-acts">' +
            '<button class="btn btn-sm btn-primary" data-act="approve" data-ok="allow" data-t="' + t + '" data-b="' + i + '">' + ic('check') + 'Allow once</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="approve" data-ok="session" data-t="' + t + '" data-b="' + i + '">Allow for this session</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="approve" data-ok="deny" data-t="' + t + '" data-b="' + i + '">Deny</button>' +
          '</div>'
        : '<div class="ask-note">' + (b.state === 'done'
            ? 'Approved — the tool ran and its result is in the transcript.'
            : 'Denied — the agent asked for a direction instead of proceeding.') + '</div>';
      return '<div class="ask' + cls + '"><div class="ask-head">' + head + '</div>' +
        '<div class="ask-body"><div class="ask-cmd">' + ESC(b.cmd) + '</div>' +
        '<div class="ask-note">' + ESC(b.note) + '</div>' + body + '</div></div>';
    }

    case 'qcard':
      return '<div class="qcard"><div class="qh">' + ESC(b.q) + '</div><div class="qopts">' +
        b.opts.map((o, n) => '<button class="qopt' + (b.chosen === n ? ' sel' : '') + '" data-act="qopt" data-t="' + t + '" data-b="' + i + '" data-n="' + n + '">' +
          '<span class="mk">' + ic('check') + '</span><span><b>' + ESC(o.t) + '</b><small>' + ESC(o.s) + '</small></span></button>').join('') +
        '</div></div>';

    case 'usage':
      return '<div class="tfoot"><span class="rule"></span>' + ESC(b.meta) + '</div>';

    default:
      return '';
  }
}

function renderTranscript() {
  const s = active();
  const box = $('transcript');
  const rail = $('rail');

  if (!s || !s.turns.length) {
    box.innerHTML = '<div class="hero">' +
      '<div class="mark">' + ic('cpu') + '</div>' +
      '<h2>What should the agent work on?</h2>' +
      '<p>This session has no turns yet. Pick a workspace, then describe the task — or start from a prompt below.</p>' +
      '<button class="wspick" data-act="wspick">' + ic('folder') +
        '<span class="k">workspace</span><span>' + ESC(wsOf(s).path) + '</span>' + ic('chevD') + '</button>' +
      '<div class="sugg">' +
        '<button data-act="sugg" data-t="Implement plan 69 W4 — relay Origin allowlist and the minimal web client">Implement plan 69 W4</button>' +
        '<button data-act="sugg" data-t="Review the pairing carve-out I just landed">Review the pairing carve-out</button>' +
        '<button data-act="sugg" data-t="Run the full pi-extension suite and summarize the failures">Run the full suite</button>' +
      '</div></div>';
    rail.innerHTML = '';
    return;
  }

  let html = '';
  s.turns.forEach((turn, t) => {
    html += '<section class="turn" data-turn="' + t + '">' +
      '<div class="msg-user"><div class="bub">' + ESC(turn.prompt) + '</div></div>' +
      '<div class="agent"><div class="who"><span class="av">' + ic('cpu') + '</span><b>Pi</b>' +
        '<span class="t">' + s.model + ' · thinking ' + s.thinking + '</span></div>';
    turn.blocks.forEach((b, i) => { html += renderBlock(b, t, i); });
    html += '</div></section>';
  });

  // The in-flight turn is not part of the session until it settles.
  const st = S.streaming;
  if (st && st.sid === s.id) {
    const t = s.turns.length;
    html += '<section class="turn" data-turn="' + t + '">' +
      '<div class="msg-user"><div class="bub">' + ESC(st.prompt) + '</div></div>' +
      '<div class="agent"><div class="who"><span class="av">' + ic('cpu') + '</span><b>Pi</b>' +
        '<span class="t">' + s.model + ' · thinking ' + s.thinking + '</span></div>';
    st.blocks.forEach((b, i) => { html += renderBlock(b, t, i); });
    if (st.html) html += '<div class="prose">' + st.html + '<span class="caret"></span></div>';
    html += '</div></section>';
  }

  box.innerHTML = html;
  buildRail(s);
  bindScrollSpy();
}

/* ---------------------------------------------------------------------
   Anchor rail — Codex-style short strokes with a hover preview card
   --------------------------------------------------------------------- */
function buildRail(s) {
  $('rail').innerHTML = s.turns.map((_, t) =>
    '<button class="rail-btn" data-rail="' + t + '" aria-label="Go to turn ' + (t + 1) + '"></button>').join('');
}

function bindScrollSpy() {
  const scroller = $('chatScroll');
  if (scroller._spy) scroller.removeEventListener('scroll', scroller._spy);
  const turns = [...document.querySelectorAll('#transcript .turn')];
  const btns = [...$('rail').children];
  if (!turns.length) return;
  const spy = () => {
    let best = 0, bestD = Infinity;
    turns.forEach((el, i) => {
      const d = Math.abs(el.getBoundingClientRect().top - window.innerHeight * 0.34);
      if (d < bestD) { bestD = d; best = i; }
    });
    btns.forEach((b, i) => {
      b.classList.toggle('active', i === best);
      b.classList.toggle('near', Math.abs(i - best) === 1);
    });
  };
  scroller._spy = spy;
  scroller.addEventListener('scroll', spy, { passive: true });
  spy();
}

function railPreview(btn) {
  const t = +btn.dataset.rail;
  const s = active();
  const card = $('railCard');
  const r = btn.getBoundingClientRect();
  card.innerHTML = '<div class="q">' + ESC(s.turns[t].prompt) + '</div>' +
    '<div class="a">' + ESC(summaryOf(s.turns[t])) + '</div>' +
    '<div class="n">Turn ' + (t + 1) + ' of ' + s.turns.length + '</div>';
  card.style.left = (r.right + 13) + 'px';
  card.style.top = Math.max(12, Math.min(window.innerHeight - 110, r.top - 40)) + 'px';
  card.classList.add('on');
}
const hideRailPreview = () => $('railCard').classList.remove('on');

function summaryOf(turn) {
  for (const b of turn.blocks) {
    if (b.k === 'md') return b.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + '…';
    if (b.k === 'code') return 'code · ' + b.lang;
  }
  return 'tool activity';
}

/* ---------------------------------------------------------------------
   Trajectory target
   --------------------------------------------------------------------- */
function trajRows(s) {
  const rows = [];
  let seq = 0, cursor = 0;
  s.turns.forEach((tu, ti) => {
    rows.push({ k:'head', label:'Turn ' + (ti + 1) });
    rows.push({ k:'user', seq:++seq, label:ESC(tu.prompt), ms:120 + ti * 40, at:cursor });
    tu.blocks.forEach((b, bi) => {
      const at = cursor + 180 + bi * 30;
      if (b.k === 'tool') rows.push({ k:'tool', seq:++seq, ref:[ti, bi], ms:b.state === 'running' ? 420 : 180 + bi * 55, at,
        label:'<code>' + ESC(b.name) + '</code> ' + ESC(b.target), state:b.state });
      else if (b.k === 'code') rows.push({ k:'asst', seq:++seq, ref:[ti, bi], ms:90, at, label:'code · ' + b.lang });
      else if (b.k === 'reason') rows.push({ k:'asst', seq:++seq, ref:[ti, bi], ms:210, at, label:'reasoning · ' + b.text.length + ' chars' });
      else if (b.k === 'md') rows.push({ k:'asst', seq:++seq, ref:[ti, bi], ms:140, at, label:'assistant message' });
      else if (b.k === 'ask') rows.push({ k:'tool', seq:++seq, ref:[ti, bi], ms:60, at, label:'approval · ' + ESC(b.cmd), state:b.state });
      else if (b.k === 'usage') rows.push({ k:'sys', seq:++seq, ref:[ti, bi], ms:20, at, label:'turn usage' });
    });
    cursor += 900;
  });
  return { rows, total:cursor || 1 };
}

function renderTrajectory() {
  const s = active();
  if (!s.turns.length) {
    $('traj').innerHTML = '<div class="sb-empty" style="padding-top:90px">' + ic('branch', 'ico') + 'No events recorded yet.</div>';
    return;
  }
  const { rows, total } = trajRows(s);
  const bars = rows.filter(r => r.k !== 'head').map(r => {
    const left = (r.at / total) * 100;
    const w = Math.max(1.4, (r.ms / total) * 100);
    const cls = r.k === 'user' ? 'user' : r.k === 'tool' ? 'tool' : 'asst';
    return '<div class="tbar"><span class="tk">' + r.k + '</span>' +
      '<span class="track"><i class="' + cls + '" style="left:' + left + '%;width:' + w + '%"></i></span>' +
      '<span class="ms">' + r.ms + 'ms</span></div>';
  }).join('');

  const ledger = rows.map((r, i) => {
    if (r.k === 'head') return '<div class="sb-sechead" style="padding-left:9px">' + ESC(r.label) + '</div>';
    const kind = r.k === 'user' ? 'user' : r.k === 'tool' ? 'tool' : 'asst';
    const glyph = r.k === 'user' ? 'msg' : r.k === 'tool'
      ? (r.state === 'error' ? 'alert' : r.state === 'running' ? 'clock' : 'term')
      : r.k === 'sys' ? 'cpu' : 'cpu';
    return '<button class="trow' + (S.trajSel === i ? ' on' : '') + '" data-traject="' + i + '">' +
      '<span class="tseq">#' + (r.seq || '—') + '</span>' +
      '<span class="tkind ' + kind + '">' + ic(glyph) + '</span>' +
      '<span class="tlabel">' + r.label + '</span>' +
      '<span class="tmeta"><span>' + r.ms + ' ms</span>' + (r.state ? '<span>' + r.state + '</span>' : '') + '</span>' +
    '</button>';
  }).join('');

  $('traj').innerHTML = '<h3>Timing overview</h3><div class="timeline">' + bars + '</div>' +
    '<h3>Event ledger</h3>' + ledger +
    (S.trajSel != null && rows[S.trajSel] ? renderInspector(rows[S.trajSel]) : '');
}

function renderInspector(r) {
  if (!r || r.k === 'head') return '';
  const n = r.seq || 1;
  return '<div class="inspector"><div class="g">' +
    '<div class="cell"><span class="k">Record</span><span class="v">#' + (r.seq || '—') + '</span></div>' +
    '<div class="cell"><span class="k">Kind</span><span class="v">' + r.k + '</span></div>' +
    '<div class="cell"><span class="k">Duration</span><span class="v">' + r.ms + ' ms</span></div>' +
    '<div class="cell"><span class="k">State</span><span class="v">' + (r.state || 'settled') + '</span></div>' +
    '<div class="cell"><span class="k">Input tokens</span><span class="v">' + (1200 + n * 137) + '</span></div>' +
    '<div class="cell"><span class="k">Output tokens</span><span class="v">' + (90 + n * 41) + '</span></div>' +
    '</div><div class="tool-sect" style="padding:0"><div class="lab">Recorded label</div>' +
    '<pre>' + String(r.label).replace(/<[^>]+>/g, '') + '</pre></div></div>';
}

/* ---------------------------------------------------------------------
   Header, main, dock
   --------------------------------------------------------------------- */
function renderHeader() {
  const s = active();
  $('mTitle').innerHTML = s
    ? '<b>' + ESC(s.title) + '</b><span class="ws">' + ESC(wsOf(s).path) + '</span>'
    : '<b>New session</b>';
  $('chips').innerHTML = s
    ? '<button class="chip" data-act="noop" title="Model">' + ic('cpu') + ESC(s.model) + '<span class="k">· ' + s.thinking + '</span></button>' +
      '<button class="chip" data-act="noop" title="Context used"><span class="ctxbar"><i style="width:' + Math.max(2, s.ctx) + '%"></i></span>' + s.ctx + '%<span class="k">ctx</span></button>' +
      '<button class="chip" data-act="noop" title="Session cost">' + s.cost + '</button>'
    : '';
  document.querySelectorAll('#ring button').forEach(b => b.classList.toggle('on', b.dataset.target === S.target));
}

function renderMain() {
  const s = active();
  const empty = !s || !s.turns.length;
  $('chatWrap').style.display = (S.target === 'chat') ? 'grid' : 'none';
  $('trajWrap').style.display = (S.target === 'trajectory' && !empty) ? 'block' : 'none';
  $('composerWrap').style.display = (S.target === 'chat') ? 'block' : 'none';
  if (S.target === 'chat') renderTranscript(); else renderTrajectory();
}

function renderDock() {
  const body = $('dockBody');
  if (S.dockTab === 'plan') {
    body.innerHTML = '<pre>' + ESC(PLAN_DOC) + '</pre>';
    $('dockTitle').textContent = 'plan/69-host-first-connection.md';
  } else if (S.dockTab === 'files') {
    const dir = S.dockPath || 'src';
    const list = FILES[dir];
    const items = (dir === 'src')
      ? list.map(f => '<button class="itin" data-act="file" data-n="' + f.n + '" data-d="' + (f.d ? 1 : 0) + '">' +
            (f.d ? ic('folder', 'dir') : ic('file')) + '<span>' + ESC(f.n) + (f.d ? '/' : '') + '</span>' +
            (f.s ? '<span class="sz">' + f.s + '</span>' : '') + '</button>').join('')
      : '<button class="itin" data-act="file" data-n=".." data-d="1">' + ic('folder', 'dir') + '<span>..</span></button>' +
        list.map(f => '<button class="itin" data-act="file" data-n="' + f.n + '" data-d="0">' + ic('file') +
            '<span>' + ESC(f.n) + '</span><span class="sz">' + f.s + '</span></button>').join('');
    body.innerHTML = '<div class="dsec">' + ESC(wsOf(active()).path + '/' + dir) + '</div><div class="dl">' + items + '</div>';
    $('dockTitle').textContent = 'Files';
  } else {
    body.innerHTML = '<div class="dsec">Working tree · 2 files changed</div><pre class="diff">' +
      hi('diff --git a/src/daemon/host_bridge.ts b/src/daemon/host_bridge.ts\n@@ -92,8 +92,14 @@\n-    if (!this.knownPeers.has(peer)) {\n-      // TODO(plan-69): pairing carve-out\n-      return;\n-    }\n+    if (!this.knownPeers.has(peer)) {\n+      // Plan 69 W1: a device nobody knows may still ask to pair.\n+      // Everything else from an unknown peer stays dropped.\n+      if (inner.type === "pair_request") {\n+        return void this.onPairing(peer, inner);\n+      }\n+      return;\n+    }\n\n diff --git a/test/pairing_host_test.ts b/test/pairing_host_test.ts\n@@ -0,0 +1,12 @@\n+it("lets an unknown peer pair", async () => {\n+  const ok = await bridge.receive(UNKNOWN, pairRequest(TOKEN));\n+  expect(ok.type).toBe("pair_ok");\n+});', 'diff') + '</pre>';
    $('dockTitle').textContent = 'Changes';
  }
  document.querySelectorAll('.dock-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === S.dockTab));
}

function renderAll() {
  renderSidebar();
  renderHeader();
  renderMain();
  if (S.dock) renderDock();
  renderComposer();
  $('capHost').textContent = HOST.name + ' · ' + HOST.relay.replace('wss://', '');
  $('sbHostName').textContent = HOST.name;
  $('sbHostMeta').textContent = HOST.relay.replace('wss://', '') + ' · v' + HOST.version;
}

function renderComposer() {
  const b = $('sendBtn');
  const running = !!S.streaming;
  b.classList.toggle('stop', running);
  b.innerHTML = ic(running ? 'stop' : 'send');
  b.title = running ? 'Stop the turn (Esc)' : 'Send (Enter)';
  b.disabled = !running && !$('composerInput').value.trim();
}

/* ---------------------------------------------------------------------
   Chrome
   --------------------------------------------------------------------- */
function syncChrome() {
  document.body.dataset.view = S.view;
  document.body.classList.toggle('sb-rail', S.rail);
  document.body.classList.toggle('dock-open', S.dock);
  if (S.theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
  $('railToggle').setAttribute('aria-pressed', String(S.rail));
  $('dockToggle').setAttribute('aria-pressed', String(S.dock));
  $('themeToggle').innerHTML = ic(S.theme === 'dark' ? 'sun' : 'moon');
  $('themeToggle').title = S.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

function toast(msg, action, onAction, kind) {
  const id = 'toast-' + (++S.toastSeq);
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.innerHTML = '<span class="tdot"></span><span>' + ESC(msg) + '</span>' +
    (action ? '<button data-t="' + id + '">' + ESC(action) + '</button>' : '');
  $('toasts').appendChild(el);
  const kill = () => el.remove();
  if (onAction) el.querySelector('button').onclick = () => { onAction(); kill(); };
  setTimeout(kill, 5600);
}

/* ---------------------------------------------------------------------
   Transitions
   --------------------------------------------------------------------- */
function openApp() {
  S.view = 'app';
  syncChrome();
  requestAnimationFrame(() => document.body.classList.add('app-in'));
  renderAll();
}
function goLauncher() {
  document.body.classList.remove('app-in');
  S.view = 'launcher';
  syncChrome();
}

/* ---------------------------------------------------------------------
   Actions
   --------------------------------------------------------------------- */
function openSession(id) {
  const s = ses(id);
  if (!s) return;
  if (s.archived) { toast('“' + s.title + '” is archived — unarchive it to open', 'Unarchive', () => { s.archived = false; renderAll(); }); return; }
  S.active = id; S.trajSel = null; S.streaming = null;
  renderAll();
}

function toggleTool(t, b) {
  const k = S.active + ':' + t + ':' + b;
  S.expanded[k] = !S.expanded[k];
  renderTranscript();
}

function resolveApproval(t, b, verdict) {
  const turn = active().turns[t];
  const blk = turn.blocks[b];
  const ses_ = active();
  if (verdict === 'deny') {
    blk.state = 'denied';
    ses_.pending = null; ses_.status = 'idle';
    turn.blocks.push({ k:'md', html:'<p>Denied — I will not run the suite. Give me the direction you want and I will rework the tests accordingly.</p>' });
    renderAll();
    toast('Approval denied');
    return;
  }
  blk.state = 'done';
  ses_.pending = null; ses_.status = 'running';
  turn.blocks.push({ k:'tool', name:'bash', target:'pnpm vitest run test/pairing_host_test.ts', kind:'bash', state:'ok',
    input:'pnpm vitest run test/pairing_host_test.ts',
    output:' RUN  v2.1.8  /Users/user/Projects/remote_pi\n\n ✓ test/pairing_host_test.ts (3 tests) 412ms\n   ✓ lets an unknown peer pair\n   ✓ refuses a rotated token\n   ✓ still drops other types from an unknown peer\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)' });
  turn.blocks.push({ k:'md', html:'<p>All three pass. The carve-out is now covered: pairing succeeds, a rotated token is refused with <code>token_invalid</code>, and every other unknown type is still dropped.</p>' });
  turn.blocks.push({ k:'usage', meta:'6 tool calls · 24.1k in / 3.8k out · 45.9k context (19%)' });
  renderAll();
  toast(verdict === 'session' ? 'Allowed for this session' : 'Approved once');
}

function sendMessage(text) {
  const s = active();
  if (!s || S.streaming) return;
  S.streaming = { sid:s.id, prompt:text, blocks:[], html:'', step:0 };
  s.status = 'running'; s.pending = null; s.updated = new Date().toISOString();
  renderAll();
  scrollToEnd();
  streamStep();
}

const STREAM = [
  { t:32, html:'<p>Reading the current state of that area first.</p>' },
  { t:520, html:'<p>Reading the current state of that area first.</p>' },
  { t:760, tool:{ k:'tool', name:'grep', target:'the area you pointed at', kind:'search', state:'running',
      input:'pattern: "…"\npath: <workspace>', output:'' } },
  { t:1250, toolDone:{ k:'tool', name:'grep', target:'the area you pointed at', kind:'search', state:'ok',
      input:'pattern: "…"\npath: <workspace>',
      output:'src/web/client.ts:41\n  // the client anchors on room "host" only\nsrc/web/client.ts:88\n  await this.helloHost(hostEpk, roomId);' } },
  { t:1500, html:'<p>Reading the current state of that area first.</p><p>Three files would carry the change, and one of them owns the invariant that matters. I would start with the smallest of the three so the others can follow it rather than guess.</p>' },
  { t:2100, html:'<p>Reading the current state of that area first.</p><p>Three files would carry the change, and one of them owns the invariant that matters. I would start with the smallest of the three so the others can follow it rather than guess.</p><p>Shall I go ahead with that order?</p>',
    done:{ usage:'4 tool calls · 12.6k in / 1.9k out · 38.4k context (16%)' } },
];

function streamStep() {
  const st = S.streaming;
  if (!st) return;
  const step = STREAM[st.step];
  if (!step) { commitStream(); return; }
  st.step++;

  if (step.tool) {
    st.blocks.push(step.tool);
    renderAll(); scrollToEnd();
    setTimeout(streamStep, 420);
    return;
  }
  if (step.toolDone) {
    st.blocks[st.blocks.length - 1] = step.toolDone;
    renderAll(); scrollToEnd();
    setTimeout(streamStep, 380);
    return;
  }

  st.html = step.html;
  renderAll(); scrollToEnd();
  setTimeout(() => {
    if (step.done) {
      st.blocks.push({ k:'md', html:step.html });
      st.blocks.push({ k:'usage', meta:step.done.usage });
      commitStream(true);
      return;
    }
    streamStep();
  }, 620);
}

function commitStream(done) {
  const st = S.streaming;
  if (!st) return;
  const s = ses(st.sid);
  S.streaming = null;
  if (s) {
    s.turns.push({ prompt:st.prompt, blocks:st.blocks });
    s.status = done ? 'done' : 'idle';
    s.updated = new Date().toISOString();
  }
  renderAll();
  scrollToEnd();
}

function stopStreaming() {
  const st = S.streaming;
  if (!st) return;
  if (st.html) st.blocks.push({ k:'md', html:st.html });
  st.blocks.push({ k:'usage', meta:'interrupted by the user' });
  commitStream(false);
  toast('Stopped the running turn');
}

function scrollToEnd() {
  const el = $('chatScroll');
  if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function newSession() {
  const n = SESSIONS.filter(s => s.id.startsWith('new')).length + 1;
  const id = 'new' + n;
  const ws = active() ? active().ws : 'w1';
  SESSIONS.unshift({ id, ws, title:'New session', turns:[],
    status:'idle', pending:null, updated:new Date().toISOString(), pinned:false, archived:false,
    model:'deepseek-v4-pro', thinking:'high', ctx:0, cost:'$0.00' });
  S.active = id; S.target = 'chat';
  renderAll();
  $('composerInput').focus();
}

function forkSession(id) {
  const src = ses(id);
  if (!src) return;
  const nid = 'fork' + (SESSIONS.length + 1);
  SESSIONS.unshift(Object.assign({}, src, {
    id:nid, title:src.title + ' (2)', pinned:false, updated:new Date().toISOString(),
    turns:src.turns.slice(0, Math.max(1, src.turns.length - 1)),
  }));
  renderAll();
  toast('Forked at the last completed turn', 'Open', () => openSession(nid));
}

function archiveSession(id) {
  const s = ses(id);
  if (!s) return;
  s.archived = true;
  if (S.active === id) S.active = (SESSIONS.find(x => !x.archived) || {}).id;
  renderAll();
  toast('Archived “' + s.title + '”', 'Undo', () => { s.archived = false; renderAll(); });
}

function renameSession(id) {
  const s = ses(id);
  if (!s) return;
  const next = window.prompt('Rename session', s.title);
  if (next == null) return;
  if (!next.trim()) return;
  s.title = next.trim();
  renderAll();
  toast('Renamed');
}

/* ---------------------------------------------------------------------
   Menus
   --------------------------------------------------------------------- */
function openMenu(anchor, html, onPick) {
  const m = $('menu');
  m.innerHTML = html;
  m.classList.add('on');
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
  m.style.top = Math.min(window.innerHeight - h - 8, r.bottom + 6) + 'px';
  m.querySelectorAll('button[data-pick]').forEach(b => {
    b.onclick = () => { closeMenu(); onPick(b.dataset.pick, b); };
  });
}
const closeMenu = () => $('menu').classList.remove('on');

function sessionMenu(anchor, id) {
  const s = ses(id);
  openMenu(anchor,
    '<button data-pick="open">' + ic('msg') + 'Open<kbd>Enter</kbd></button>' +
    '<button data-pick="pin">' + ic('pin') + (s.pinned ? 'Unpin' : 'Pin') + '</button>' +
    '<button data-pick="rename">' + ic('pencil') + 'Rename<kbd>F2</kbd></button>' +
    '<button data-pick="fork">' + ic('fork') + 'Fork from last turn</button>' +
    '<div class="sep"></div>' +
    (s.archived
      ? '<button data-pick="unarchive">' + ic('archive') + 'Unarchive</button>'
      : '<button data-pick="archive" class="danger">' + ic('archive') + 'Archive<kbd>⌫</kbd></button>'),
    pick => {
      if (pick === 'open') openSession(id);
      else if (pick === 'pin') { s.pinned = !s.pinned; renderAll(); }
      else if (pick === 'rename') renameSession(id);
      else if (pick === 'fork') forkSession(id);
      else if (pick === 'archive') archiveSession(id);
      else if (pick === 'unarchive') { s.archived = false; renderAll(); }
    });
}

/* ---------------------------------------------------------------------
   Wiring
   --------------------------------------------------------------------- */
document.addEventListener('click', ev => {
  const t = ev.target;

  /* --- launcher --- */
  if (t.closest('[data-act="recent"]')) { openApp(); return; }

  /* --- chrome --- */
  const railBtn = t.closest('#railToggle'); if (railBtn) { S.rail = !S.rail; syncChrome(); return; }
  const dockBtn = t.closest('#dockToggle');
  if (dockBtn) {
    S.dock = !S.dock;
    syncChrome();
    if (S.dock) {
      // Dock opens at 45% of the viewport, capped at 70%, center keeps 400px.
      const want = Math.round(window.innerWidth * 0.45);
      const max = Math.round(window.innerWidth * 0.70);
      const fit = Math.min(want, Math.max(280, window.innerWidth - 400 - (S.rail ? 56 : 280)));
      document.documentElement.style.setProperty('--rb-w', Math.min(fit, max) + 'px');
      renderDock();
    }
    return;
  }
  const themeBtn = t.closest('#themeToggle');
  if (themeBtn) { S.theme = S.theme === 'dark' ? 'light' : 'dark'; syncChrome(); return; }
  const out = t.closest('#unpair');
  if (out) { goLauncher(); return; }
  const kb = t.closest('#kbdToggle');
  if (kb) { $('kbdHelp').classList.toggle('on'); return; }
  if (t.closest('#kbdHelp')) { $('kbdHelp').classList.remove('on'); return; }

  /* --- target ring --- */
  const ringBtn = t.closest('#ring button');
  if (ringBtn) { S.target = ringBtn.dataset.target; renderMain(); renderHeader(); return; }

  /* --- dock --- */
  const dockTab = t.closest('.dock-tab');
  if (dockTab) { S.dockTab = dockTab.dataset.tab; renderDock(); return; }
  const dclose = t.closest('#dockClose');
  if (dclose) { S.dock = false; syncChrome(); return; }

  /* --- new session --- */
  if (t.closest('#newSession')) { newSession(); return; }
  if (t.closest('[data-act="new"]')) { newSession(); return; }

  /* --- sidebar rows --- */
  const act = t.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;

  if (a === 'open') { openSession(act.dataset.id); return; }
  if (a === 'group') { S.openGroups[act.dataset.id] = S.openGroups[act.dataset.id] === false; renderSidebar(); return; }
  if (a === 'more') { S.openGroups[act.dataset.id] = true; renderSidebar(); return; }
  if (a === 'pin') { const s = ses(act.dataset.id); s.pinned = !s.pinned; renderAll(); return; }
  if (a === 'menu') { ev.stopPropagation(); sessionMenu(act, act.dataset.id); return; }

  /* --- transcript --- */
  if (a === 'tool') { toggleTool(+act.dataset.t, +act.dataset.b); return; }
  if (a === 'approve') {
    resolveApproval(+act.dataset.t, +act.dataset.b, act.dataset.ok === 'deny' ? 'deny' : act.dataset.ok);
    return;
  }
  if (a === 'qopt') {
    const b = active().turns[+act.dataset.t].blocks[+act.dataset.b];
    b.chosen = +act.dataset.n;
    renderAll();
    toast('Answer recorded');
    return;
  }
  if (a === 'copy') {
    const pre = t.closest('.cb').querySelector('pre');
    navigator.clipboard && navigator.clipboard.writeText(pre.innerText);
    toast('Copied to clipboard');
    return;
  }
  if (a === 'sugg') { sendMessage(act.dataset.t); return; }
  if (a === 'wspick') { toast('Workspace picker — not wired in the prototype'); return; }
  if (a === 'file') {
    if (act.dataset.d === '1') {
      S.dockPath = act.dataset.n === '..' ? 'src' : (act.dataset.n === 'daemon' ? 'daemon' : 'src');
      renderDock();
    } else toast('Opening ' + act.dataset.n + ' — not wired in the prototype');
    return;
  }
  if (a === 'noop') { toast('Not wired in the prototype'); return; }

  /* trajectory rows are handled on their own attribute */
});
document.addEventListener('click', ev => {
  const row = ev.target.closest('[data-traject]');
  if (row) { S.trajSel = +row.dataset.traject; renderTrajectory(); return; }
  const railBtn2 = ev.target.closest('[data-rail]');
  if (railBtn2) {
    const t = +railBtn2.dataset.rail;
    const el = document.querySelector('#transcript .turn[data-turn="' + t + '"]');
    if (el) el.scrollIntoView({ block:'start', behavior:'smooth' });
    hideRailPreview();
    return;
  }
  if (!ev.target.closest('#menu') && !ev.target.closest('[data-act="menu"]')) closeMenu();
});

/* rail hover previews */
document.addEventListener('mouseover', ev => {
  const b = ev.target.closest('[data-rail]');
  if (b) railPreview(b);
});
document.addEventListener('mouseout', ev => {
  if (ev.target.closest('[data-rail]')) hideRailPreview();
});
document.addEventListener('scroll', hideRailPreview, true);

/* search */
document.addEventListener('input', ev => {
  if (ev.target.id === 'sbSearch') { S.query = ev.target.value; renderSidebar(); }
});

/* composer */
function wireComposer() {
  const ta = $('composerInput');
  const auto = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', () => {
    auto();
    renderComposer();
  });
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
  });
  $('sendBtn').onclick = () => submit();
  function submit() {
    if (S.streaming) { stopStreaming(); return; }
    const v = ta.value.trim();
    if (!v) return;
    ta.value = ''; auto();
    sendMessage(v);
  }
}

/* dock drag-resize */
function wireDockGrab() {
  const grab = $('dockGrab');
  grab.addEventListener('mousedown', ev => {
    ev.preventDefault();
    S.dragging = true;
    grab.classList.add('on');
    document.body.classList.add('no-anim');
  });
  window.addEventListener('mousemove', ev => {
    if (!S.dragging) return;
    const w = Math.max(280, Math.min(window.innerWidth * 0.70, window.innerWidth - ev.clientX));
    // Protect 400px for the center column.
    const sb = S.rail ? 56 : 280;
    document.documentElement.style.setProperty('--rb-w', Math.min(w, window.innerWidth - sb - 400) + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!S.dragging) return;
    S.dragging = false;
    $('dockGrab').classList.remove('on');
    document.body.classList.remove('no-anim');
    document.body.classList.remove('animating');
  });
}

/* keyboard — registered on window so Escape reaches the app from anywhere */
window.addEventListener('keydown', ev => {
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && ev.key.toLowerCase() === 'b') { ev.preventDefault(); S.rail = !S.rail; syncChrome(); return; }
  if (mod && ev.key.toLowerCase() === 'k') { ev.preventDefault(); $('sbSearch').focus(); $('sbSearch').select(); return; }
  if (mod && ev.key.toLowerCase() === 'j') { ev.preventDefault(); S.dock = !S.dock; syncChrome(); if (S.dock) { document.documentElement.style.setProperty('--rb-w', Math.round(window.innerWidth * 0.45) + 'px'); renderDock(); } return; }
  if (mod && ev.key.toLowerCase() === 'n') { ev.preventDefault(); newSession(); return; }
  if (ev.key === 'Escape') {
    closeMenu(); hideRailPreview();
    $('kbdHelp').classList.remove('on');
    if (S.streaming) stopStreaming();
    return;
  }
  if (ev.key === '?' && !/input|textarea/i.test(document.activeElement.tagName)) { $('kbdHelp').classList.add('on'); return; }
  if (ev.key === 'F2' && active()) { ev.preventDefault(); renameSession(S.active); return; }
  // Rows carry button semantics on a div so they can hold their own actions.
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList && ev.target.classList.contains('srow')) {
    ev.preventDefault();
    openSession(ev.target.dataset.id);
    return;
  }
});

/* auto-collapse below 1024px (dsh-client-ui-layout) */
window.addEventListener('resize', () => {
  if (window.innerWidth < 1024 && !S.rail && !S.autoCollapsed) { S.autoCollapsed = true; }
});

/* launcher */
function wireLauncher() {
  $('lcForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const addr = $('lcAddr').value.trim();
    const code = $('lcCode').value.trim();
    if (!addr || !code) { $('lcErr').classList.add('on'); return; }
    $('lcErr').classList.remove('on');
    openApp();
  });
}

/* boot */
document.addEventListener('DOMContentLoaded', () => {
  syncChrome();
  renderAll();
  wireLauncher();
  wireComposer();
  wireDockGrab();
  $('sendBtn').disabled = true;
  $('lcAddr').value = HOST.relay;
  $('lcCode').value = 'remotepi://pair?t=9f2c…&epk=8f3a91c4…&n=' + HOST.name + '&rm=host';
  document.body.classList.add('ready');
});
