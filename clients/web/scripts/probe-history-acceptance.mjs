/** Root-owned real-browser helpers. No launch, interception or fake replies.
 * Export only scalar timing/counts/hashes. Never log raw Network events, DOM
 * text, URL queries, auth, ct, bootstrap bodies or protocol tokens. */
import { createHash } from 'node:crypto';

/** Install with page.evaluate or evaluateOnNewDocument. Polling/layout reads
 * exist only during an armed measurement and stop after the first visible rAF.
 * The app counters additionally require the test build + runtime opt-in. */
export function installHistoryAcceptanceProbe() {
  globalThis.__p86Probe?.dispose();
  let arm = null, frame = 0, observer = null;
  const samples = [], longTasks = [], observers = [];
  const viewer = () => document.querySelector('[data-history-viewer]');
  const rows = () => [...(viewer()?.querySelectorAll('[data-row-key]') ?? [])];
  const nodesFor = path => path === 'directory' ? [...document.querySelectorAll('[data-history-workspace]')]
    : path === 'list' ? [...document.querySelectorAll('[data-history-session]')] : rows();
  const visible = node => {
    const rect = node.getBoundingClientRect();
    if (!node.getClientRects().length || getComputedStyle(node).visibility !== 'visible') return false;
    const box = node.closest('[data-history-scroll], [data-history-list]')?.getBoundingClientRect();
    return Math.min(rect.bottom, innerHeight, box?.bottom ?? innerHeight) > Math.max(rect.top, 0, box?.top ?? 0) &&
      Math.min(rect.right, innerWidth, box?.right ?? innerWidth) > Math.max(rect.left, 0, box?.left ?? 0);
  };
  const hasMarker = active => nodesFor(active.path).some(node => node.textContent.includes(active.marker) && visible(node));
  const stop = () => { cancelAnimationFrame(frame); frame = 0; observer?.disconnect(); observer = null; };
  const tick = () => {
    frame = 0;
    const active = arm;
    if (!active || active.startMs === null || active.nextFrameMs !== null) return;
    if (performance.now() > active.deadlineMs) { active.timedOut = true; stop(); return; }
    if (active.domMs === null && hasMarker(active)) {
      active.domMs = performance.now();
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (arm !== active) return;
        active.nextFrameMs = performance.now();
        active.visibleNextFrame = hasMarker(active);
        stop();
      });
    } else if (active.domMs === null) schedule();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(tick); };
  const start = (trusted, origin) => {
    if (!arm || arm.startMs !== null) return;
    arm.startMs = performance.now(); arm.origin = origin;
    arm.clickMs = origin === 'trusted-click' ? arm.startMs : null;
    arm.trustedClick = origin === 'trusted-click' && trusted;
    arm.markerAlreadyVisibleAtStart = hasMarker(arm);
    arm.markerAlreadyVisibleAtClick = origin === 'trusted-click' ? arm.markerAlreadyVisibleAtStart : null;
    observer = new MutationObserver(() => {
      // MutationObserver runs before layout/paint. It only wakes the rAF loop;
      // keep geometry reads inside requestAnimationFrame.
      if (arm?.domMs === null && arm?.startMs !== null) schedule();
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true });
    schedule();
  };
  const onClick = event => {
    if (!arm || arm.clickMs !== null) return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const selector = arm.path === 'read' ? '[data-history-session], [data-history-action]'
      : arm.path === 'list' ? '[data-history-workspace], button[aria-label="刷新会话列表"]'
      : '[data-history-directory-refresh]';
    if (button?.matches(selector)) start(event.isTrusted, 'trusted-click');
  };
  document.addEventListener('click', onClick, true);
  try {
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) longTasks.push({ startMs: e.startTime, durationMs: e.duration });
      if (longTasks.length > 2000) longTasks.splice(0, longTasks.length - 2000);
    });
    po.observe({ type: 'longtask', buffered: false }); observers.push(po);
  } catch { /* Explicit support flag below. */ }
  const api = {
    arm(marker, path = 'read', options = {}) {
      if (typeof marker !== 'string' || !/^(?:RP8[67]|P8[67])[_A-Z0-9-]{1,100}$/i.test(marker)) throw Error('Synthetic P86/P87 fixture marker required');
      if (!['directory', 'list', 'read'].includes(path)) throw Error('Unknown measurement path');
      // Observation lifetime only: does not change app request deadlines or
      // performance gates. Whole-workspace cold indexing may exceed 30s.
      const observationTimeoutMs = options.observationTimeoutMs ?? 30000;
      if (!Number.isSafeInteger(observationTimeoutMs) || observationTimeoutMs < 1000 || observationTimeoutMs > 240000) {
        throw Error('Observation timeout must be an integer in 1000..240000 ms');
      }
      stop();
      arm = { marker, path, origin: 'armed', startMs: null, clickMs: null, domMs: null, nextFrameMs: null,
        markerAlreadyVisibleAtStart: false, visibleNextFrame: false, trustedClick: false, markerAlreadyVisibleAtClick: null,
        timedOut: false, deadlineMs: performance.now() + observationTimeoutMs };
      const alreadyVisible = hasMarker(arm);
      const startOrigin = document.readyState === 'loading' ? 'document-start' : 'immediate';
      if (options.startNow === true) start(false, startOrigin);
      return { armed: true, markerAlreadyVisible: alreadyVisible,
        origin: options.startNow === true ? startOrigin : 'armed' };
    },
    sample(pageNumber = 0) {
      if (!Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber > 10000) throw Error('Numeric page label required');
      const root = viewer(), scroll = root?.querySelector('[data-history-scroll]');
      const result = { pageNumber, atMs: performance.now(), mountedRows: rows().length,
        visibleRows: rows().filter(visible).length, domNodes: document.getElementsByTagName('*').length,
        olderAvailable: !!root?.querySelector('[data-history-action="older"]'),
        olderBusy: root?.querySelector('[data-history-action="older"]')?.disabled ?? false,
        newerAvailable: !!root?.querySelector('[data-history-action="newer"]'),
        pageStart: Number(root?.getAttribute('data-page-start') ?? 0),
        pageEnd: Number(root?.getAttribute('data-page-end') ?? 0),
        scrollTop: scroll?.scrollTop ?? 0,
        stats: globalThis.__p87History?.snapshot().stats ?? null };
      samples.push(result); if (samples.length > 1000) samples.shift();
      return result;
    },
    /** Cache-residency scalars for before/after comparisons. Residency alone
     * is not a hit: correlate a deliberate reopen with zero new read requests. */
    cacheSnapshot() {
      const query = globalThis.__p87History?.snapshot().stats?.query;
      if (!query) return null;
      const fields = ['cacheBytes', 'cachePages', 'cacheSessions', 'viewSessions',
        'residentPages', 'viewItems', 'pendingReads'];
      return Object.fromEntries(fields.map(key => [key,
        typeof query[key] === 'number' && Number.isFinite(query[key]) ? query[key] : null]));
    },
    snapshot() {
      const { marker: _marker, ...timing } = arm ?? {};
      return { timing: { ...timing,
        startToDOMMs: arm?.domMs == null || arm?.startMs == null ? null : arm.domMs - arm.startMs,
        startToNextFrameMs: arm?.nextFrameMs == null || arm?.startMs == null ? null : arm.nextFrameMs - arm.startMs,
        clickToDOMMs: arm?.domMs == null || arm?.clickMs == null ? null : arm.domMs - arm.clickMs,
        clickToNextFrameMs: arm?.nextFrameMs == null || arm?.clickMs == null ? null : arm.nextFrameMs - arm.clickMs },
        longTaskSupported: observers.length > 0, longTasks: [...longTasks], samples: [...samples],
        app: globalThis.__p87History?.snapshot() ?? null,
        maxMountedRows: Math.max(0, ...samples.map(s => s.mountedRows)),
        measurement: 'Visible synthetic DOM marker then next rAF; full-page is separately the matching app applied-page mark, never physical paint or full DOM mount.' };
    },
    stop,
    dispose() { stop(); document.removeEventListener('click', onClick, true); observers.forEach(o => o.disconnect()); delete globalThis.__p86Probe; },
  };
  globalThis.__p86Probe = api;
  return { installed: true, longTaskSupported: observers.length > 0, appTestProbe: globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__ === true };
}

/** Script for Playwright addInitScript / Puppeteer evaluateOnNewDocument.
 * It installs before app bootstrap, so directory cold-start capture cannot
 * inherit an already-rendered marker. Set install:false for probe-off runs. */
export function historyAcceptanceProbeInitScript({ runtimeOptIn, install = true, arm = null } = {}) {
  if (runtimeOptIn !== undefined && typeof runtimeOptIn !== 'boolean') throw Error('runtimeOptIn must be boolean');
  if (arm !== null && (typeof arm.marker !== 'string' || !['directory', 'list', 'read'].includes(arm.path ?? 'read'))) {
    throw Error('A synthetic marker and known probe path are required');
  }
  const setup = [];
  if (runtimeOptIn !== undefined) setup.push(`globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__=${JSON.stringify(runtimeOptIn)};`);
  if (install) {
    setup.push(`(${installHistoryAcceptanceProbe.toString()})();`);
    if (arm !== null) setup.push(`globalThis.__p86Probe.arm(${JSON.stringify(arm.marker)},${JSON.stringify(arm.path ?? 'read')},${JSON.stringify(arm.options ?? {})});`);
  }
  return setup.join('\n');
}

/** Same scalar correlation hash as the disabled-by-default app test probe. */
export function historyRequestHash(id) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    a = Math.imul(a ^ id.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ id.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Passive Puppeteer CDP listener; attach BEFORE navigation. */
export async function attachHistoryNetworkProbe(page) {
  const cdp = await page.createCDPSession();
  const records = [], requests = new Map();
  const sha = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
  const allowed = new Set(['workspace_list', 'workspace_list_ok', 'history_list', 'history_read', 'history_body',
    'history_list_ok', 'history_read_ok', 'history_body_ok', 'history_error', 'session_read']);
  let dropped = 0;
  const add = entry => { if (records.length < 20000) records.push(entry); else dropped++; };
  const identity = raw => {
    try {
      let obj = JSON.parse(raw);
      for (let depth = 0; depth < 4; depth++) {
        if (!obj || typeof obj !== 'object') break;
        if (allowed.has(obj.type)) {
          const requestId = typeof obj.in_reply_to === 'string' ? obj.in_reply_to : obj.id;
          return { frameType: obj.type,
            requestIdHash: typeof requestId === 'string' ? historyRequestHash(requestId) : null,
            requestIdSHA256: typeof requestId === 'string' ? sha(requestId) : null,
            responseIdHash: typeof obj.in_reply_to === 'string' && typeof obj.id === 'string' ? historyRequestHash(obj.id) : null,
            itemCount: Array.isArray(obj.items) ? obj.items.length : Array.isArray(obj.sessions) ? obj.sessions.length : Array.isArray(obj.workspaces) ? obj.workspaces.length : null,
            indexState: ['ready','building','unavailable'].includes(obj.index_state) ? obj.index_state : null,
            retryAfterMs: Number.isSafeInteger(obj.retry_after_ms) && obj.retry_after_ms >= 0 ? obj.retry_after_ms : null,
            hasOlder: typeof obj.has_older === 'boolean' ? obj.has_older : null,
            hasMore: typeof obj.has_more === 'boolean' ? obj.has_more : null };
        }
        if (typeof obj.ct !== 'string') break;
        obj = JSON.parse(Buffer.from(obj.ct, 'base64').toString('utf8'));
      }
    } catch { /* Opaque/unrecognised payloads stay opaque. */ }
    return { frameType: 'other', requestIdHash: null };
  };
  cdp.on('Network.requestWillBeSent', ({ requestId, timestamp, request }) => {
    let url; try { url = new URL(request.url); } catch { return; }
    if (!['/api/frame', '/api/events', '/api/bootstrap'].includes(url.pathname)) return;
    const entry = { kind: 'http', atSeconds: timestamp, path: url.pathname, method: request.method,
      requestIdHash: null, frameType: 'other', requestBodyBytes: 0, responseEncodedBytes: null,
      responseAtSeconds: null, finishedAtSeconds: null, status: null };
    if (url.pathname === '/api/frame' && typeof request.postData === 'string') {
      Object.assign(entry, identity(request.postData)); entry.requestBodyBytes = Buffer.byteLength(request.postData);
    }
    requests.set(requestId, entry); add(entry);
  });
  cdp.on('Network.responseReceived', ({ requestId, timestamp, response }) => {
    const entry = requests.get(requestId); if (entry) { entry.status = response.status; entry.responseAtSeconds = timestamp; }
  });
  cdp.on('Network.loadingFinished', ({ requestId, timestamp, encodedDataLength }) => {
    const entry = requests.get(requestId); if (entry) { entry.responseEncodedBytes = encodedDataLength; entry.finishedAtSeconds = timestamp; }
    requests.delete(requestId);
  });
  cdp.on('Network.loadingFailed', ({ requestId, timestamp }) => {
    const entry = requests.get(requestId); if (entry) { entry.failed = true; entry.finishedAtSeconds = timestamp; }
    requests.delete(requestId);
  });
  for (const [event, kind] of [['Network.webSocketFrameSent', 'ws-sent'], ['Network.webSocketFrameReceived', 'ws-received']]) {
    cdp.on(event, ({ timestamp, response }) => {
      if (response.opcode !== 1) return;
      add({ kind, atSeconds: timestamp, payloadUTF8Bytes: Buffer.byteLength(response.payloadData), ...identity(response.payloadData) });
    });
  }
  cdp.on('Network.eventSourceMessageReceived', ({ timestamp, data }) => {
    add({ kind: 'sse-received', atSeconds: timestamp, payloadUTF8Bytes: Buffer.byteLength(data), ...identity(data) });
  });
  await cdp.send('Network.enable');
  return {
    snapshot: () => ({ records: records.map(r => ({ ...r })), dropped,
      httpRequests: records.filter(r => r.kind === 'http').length,
      historyOutbound: records.filter(r => (r.kind === 'ws-sent' || (r.kind === 'http' && r.path === '/api/frame')) && r.frameType.startsWith('history_')).length,
      directoryOutbound: records.filter(r => (r.kind === 'ws-sent' || (r.kind === 'http' && r.path === '/api/frame')) && r.frameType === 'workspace_list').length,
      limits: 'No URL query/ct/body/header/text. requestIdHash correlates app marks; SHA256 is an additional opaque ID. HTTP encoded bytes and WS/SSE UTF8 payload bytes are distinct units. Calibrate CDP/performance clocks before subtracting.' }),
    dispose: () => cdp.detach(),
  };
}
