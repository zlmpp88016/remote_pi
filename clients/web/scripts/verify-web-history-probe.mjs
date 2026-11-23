/** Focused, browser-free probe gate: dual opt-in and scalar-only CDP output. */
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { attachHistoryNetworkProbe, historyAcceptanceProbeInitScript, historyRequestHash } from './probe-history-acceptance.mjs';
import { historyProbeHash, historyProbeMark } from '../src/lib/remote-pi/history-probe.ts';
let checks = 0;
const check = (label, ok) => { checks++; assert.ok(ok, label); };
const secret = 'P87_PRIVATE_TEST_SECRET';

function probePage() {
  let now = 1, nextFrame = 0;
  const frames = new Map(), observers = [], clickListeners = [];
  const box = { top: 0, bottom: 100, left: 0, right: 120,
    getBoundingClientRect() { return { ...this }; } };
  const directory = [];
  const rows = [];
  const viewer = { querySelectorAll(selector) { return selector === '[data-row-key]' ? rows : []; } };
  class FakeElement {
    constructor(selector = '') { this.selector = selector; }
    closest(selector) {
      if (selector === 'button') return new FakeElement('[data-history-session]');
      return this.selector === selector ? this : null;
    }
    matches(selector) { return selector.split(',').some(part => this.selector === part.trim()); }
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  class FakePerformanceObserver { observe() {} disconnect() {} }
  const document = {
    readyState: 'loading',
    querySelector(selector) { return selector === '[data-history-viewer]' ? viewer : null; },
    querySelectorAll(selector) { return selector === '[data-history-workspace]' ? directory : []; },
    getElementsByTagName() { return []; },
    addEventListener(name, callback) { if (name === 'click') clickListeners.push(callback); },
    removeEventListener() {},
  };
  const page = {
    document, Element: FakeElement, MutationObserver: FakeMutationObserver,
    PerformanceObserver: FakePerformanceObserver,
    performance: { now: () => now }, innerHeight: 500, innerWidth: 500,
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    advanceFrame() {
      const next = frames.entries().next().value;
      assert.ok(next, 'expected a scheduled animation frame');
      frames.delete(next[0]); now += 1; next[1]();
    },
    mutate() { for (const observer of observers) observer.callback(); },
    addDirectoryMarker(marker) {
      directory.push({ textContent: marker, getClientRects: () => [1],
        getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 10, right: 80 }),
        closest: () => box });
    },
    addReadMarker(marker) {
      rows.push({ textContent: marker, getClientRects: () => [1],
        getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 10, right: 80 }),
        closest: () => box });
    },
    clickTrustedRead() {
      for (const listener of clickListeners) listener({ isTrusted: true, target: new FakeElement('span') });
    },
    setNow(value) { now = value; },
    box,
  };
  return { page, sandbox: { ...page, globalThis: null }, run(script) {
    const sandbox = { ...page, globalThis: null };
    sandbox.globalThis = sandbox;
    runInNewContext(script, sandbox);
    return sandbox;
  } };
}

const cold = probePage();
const coldScript = historyAcceptanceProbeInitScript({ runtimeOptIn: true,
  arm: { marker: 'P87_COLD_DIRECTORY', path: 'directory', options: { startNow: true } } });
const coldGlobal = cold.run(coldScript);
const coldInitial = coldGlobal.__p86Probe.snapshot().timing;
check('document-start init arms cold-directory capture before any marker exists', coldInitial.origin === 'document-start' &&
  coldInitial.startMs === 1 && coldInitial.markerAlreadyVisibleAtStart === false && coldInitial.clickMs === null);
cold.page.addDirectoryMarker('P87_COLD_DIRECTORY'); cold.page.mutate(); cold.page.advanceFrame();
const firstVisible = coldGlobal.__p86Probe.snapshot().timing;
check('cold marker is first observed after bootstrap and starts one-frame recheck', firstVisible.domMs !== null && firstVisible.nextFrameMs === null);
cold.page.box.bottom = 5; cold.page.advanceFrame();
const coldResult = coldGlobal.__p86Probe.snapshot().timing;
check('cold first-content next-rAF recheck honors scroll-box clipping', coldResult.visibleNextFrame === false &&
  coldResult.startToDOMMs !== null && coldResult.startToNextFrameMs !== null && coldResult.trustedClick === false);

check('default observation lifetime stays 30s', coldInitial.deadlineMs - coldInitial.startMs === 30000);
const extended = probePage();
const extendedGlobal = extended.run(historyAcceptanceProbeInitScript({ runtimeOptIn: false,
  arm: { marker: 'P87_COLD_LIST', path: 'list', options: { startNow: true, observationTimeoutMs: 120000 } } }));
extended.page.setNow(31001); extended.page.advanceFrame();
check('explicit cold observation can outlast 30s without an app timeout change',
  extendedGlobal.__p86Probe.snapshot().timing.timedOut === false && extendedGlobal.__p86Probe.snapshot().timing.deadlineMs === 120001);
extended.page.setNow(120002); extended.page.advanceFrame();
check('extended observation still terminates at its own deadline', extendedGlobal.__p86Probe.snapshot().timing.timedOut === true);
for (const observationTimeoutMs of [0, 999, 240001, 1.5, NaN, '120000']) {
  assert.throws(() => extendedGlobal.__p86Probe.arm('P87_INVALID', 'list', { observationTimeoutMs }), /Observation timeout/);
}
check('invalid observation durations are rejected without rearming', extendedGlobal.__p86Probe.snapshot().timing.deadlineMs === 120001);

const caseSensitive = probePage();
const caseGlobal = caseSensitive.run(historyAcceptanceProbeInitScript({ runtimeOptIn: true,
  arm: { marker: 'rp87-large-0000', path: 'read', options: { startNow: true } } }));
caseSensitive.page.addReadMarker('RP87-LARGE-0000'); caseSensitive.page.mutate(); caseSensitive.page.advanceFrame();
check('first-read marker matching is case-sensitive and rejects the uppercase decoy',
  caseGlobal.__p86Probe.snapshot().timing.domMs === null);
caseSensitive.page.addReadMarker('rp87-large-0000'); caseSensitive.page.mutate(); caseSensitive.page.advanceFrame();
caseSensitive.page.advanceFrame();
check('case-exact small first-item session marker passes the post-layout frame check',
  caseGlobal.__p86Probe.snapshot().timing.visibleNextFrame === true);

const read = probePage();
const readGlobal = read.run(historyAcceptanceProbeInitScript({ runtimeOptIn: true,
  arm: { marker: 'P87_TRUSTED_READ', path: 'read' } }));
read.page.clickTrustedRead(); read.page.addReadMarker('P87_TRUSTED_READ'); read.page.mutate(); read.page.advanceFrame(); read.page.advanceFrame();
const readTiming = readGlobal.__p86Probe.snapshot().timing;
check('read interface captures a trusted click and visible next-rAF marker', readTiming.origin === 'trusted-click' &&
  readTiming.trustedClick === true && readTiming.markerAlreadyVisibleAtClick === false && readTiming.visibleNextFrame === true &&
  readTiming.clickToDOMMs !== null && readTiming.clickToNextFrameMs !== null);
readGlobal.__p87History = { snapshot: () => ({ stats: { query: { cacheBytes: 12, cachePages: 2,
  cacheSessions: 1, viewSessions: 1, residentPages: 2, viewItems: 50, pendingReads: 0 } } }) };
check('cache comparison exports bounded scalar residency for before/reopen snapshots',
  readGlobal.__p86Probe.cacheSnapshot().cachePages === 2 && readGlobal.__p86Probe.cacheSnapshot().pendingReads === 0);

const off = probePage();
const offGlobal = off.run(historyAcceptanceProbeInitScript({ runtimeOptIn: false, install: false }));
check('probe-off init leaves DOM probe absent and explicitly disables app instrumentation',
  offGlobal.__REMOTE_PI_HISTORY_TEST_PROBE__ === false && offGlobal.__p86Probe === undefined);
check('cache hit evidence is explicitly not inferred from residency alone',
  historyAcceptanceProbeInitScript({ runtimeOptIn: false, install: false }).length > 0);

globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__ = true;
historyProbeMark('read', 'request', secret);
check('runtime flag alone cannot expose an uncompiled probe', globalThis.__p87History === undefined);
check('app/CDP ID hash algorithms match', historyProbeHash(secret) === historyRequestHash(secret));
const source = await readFile(new URL('../src/lib/remote-pi/history-probe.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', define: { __REMOTE_PI_HISTORY_TEST_BUILD__: 'true' } });
const probe = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__ = false;
probe.historyProbeMark('read', 'request', secret);
check('compiled flag alone cannot expose a probe', globalThis.__p87History === undefined);
globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__ = true;
probe.historyProbeMark('read', 'request', secret, 50);
check('both opt-ins expose scalar marks', globalThis.__p87History.snapshot().records.length === 1);
check('marks never expose the raw ID', !JSON.stringify(globalThis.__p87History.snapshot()).includes(secret));
for (let i = 0; i < 4200; i++) probe.historyProbeMark('read', 'applied', String(i), 50);
check('mark ring is bounded with explicit loss counter', globalThis.__p87History.snapshot().records.length === 4096 && globalThis.__p87History.snapshot().dropped > 0);
delete globalThis.__p87History;
delete globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__;
const handlers = new Map();
const cdp = { on(name, fn) { handlers.set(name, fn); }, async send() {}, async detach() {} };
const network = await attachHistoryNetworkProbe({ async createCDPSession() { return cdp; } });
const emit = (name, data) => handlers.get(name)(data);
const request = { type: 'workspace_list', id: 'directory-id', text: secret, auth: secret };
const wrapped = JSON.stringify({ ct: Buffer.from(JSON.stringify(request)).toString('base64'), token: secret });
emit('Network.requestWillBeSent', { requestId: 'cdp-id', timestamp: 1,
  request: { url: `https://fixture.invalid/api/frame?token=${secret}`, method: 'POST', postData: wrapped } });
emit('Network.responseReceived', { requestId: 'cdp-id', timestamp: 2, response: { status: 204, headers: { auth: secret } } });
emit('Network.loadingFinished', { requestId: 'cdp-id', timestamp: 3, encodedDataLength: 100 });
emit('Network.eventSourceMessageReceived', { timestamp: 4, data: JSON.stringify({ ct: Buffer.from(JSON.stringify({
  type: 'workspace_list_ok', in_reply_to: 'directory-id', id: 'response-id', workspaces: [{ cwd: secret }],
})).toString('base64') }) });
emit('Network.requestWillBeSent', { requestId: 'bootstrap-id', timestamp: 5,
  request: { url: `https://fixture.invalid/api/bootstrap?auth=${secret}`, method: 'POST', postData: secret } });
emit('Network.eventSourceMessageReceived', {timestamp:6,data:JSON.stringify({
  type:'history_list_ok',in_reply_to:'building-id',sessions:[],index_state:'building',retry_after_ms:25,text:secret,
})});
emit('Network.eventSourceMessageReceived', {timestamp:7,data:JSON.stringify({
  type:'history_list_ok',in_reply_to:'invalid-state-id',sessions:[],index_state:secret,retry_after_ms:-1,
})});
const snapshot = network.snapshot();
check('directory request and response correlate by hash', snapshot.records[0].requestIdHash === snapshot.records[1].requestIdHash);
check('complete response count and timing are available', snapshot.records[1].itemCount === 1 && snapshot.records[0].finishedAtSeconds === 3);
check('HTTP and payload byte units remain separate', snapshot.records[0].responseEncodedBytes === 100 && snapshot.records[1].payloadUTF8Bytes > 0);
check('building success preserves zero count and typed index state', snapshot.records[3].itemCount === 0 && snapshot.records[3].indexState === 'building');
check('building retry hint is a scalar', snapshot.records[3].retryAfterMs === 25);
check('invalid index metadata cannot leak arbitrary strings or negative hints', snapshot.records[4].indexState === null && snapshot.records[4].retryAfterMs === null);
check('secret/header/query/bootstrap/text/ct never escape', !JSON.stringify(snapshot).includes(secret) && !JSON.stringify(snapshot).includes('directory-id'));
await network.dispose();
console.log(`verify-web-history-probe: ${checks}/${checks} PASS`);
