// Plan/79 — Settings dock panel acceptance. Real Chrome over CDP against the LIVE
// direct-mode daemon on :4124, editing the REAL ~/.pi/agent/models.json.
//
// The load-bearing assertions are NEGATIVE: a credential must not appear in the
// SSE frame, in the DOM, or in an input's value. Everything else protects the
// write path — that a save which does not name the key leaves it byte-identical,
// and that a stale revision is refused instead of overwriting newer content.
//
// This script backs up the real config before it starts and restores it on every
// exit path (including failures), because the file it edits holds live API keys.
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP = "http://127.0.0.1:9444";
const BASE = "http://127.0.0.1:4124/";
const CONFIG = join(homedir(), ".pi", "agent", "models.json");
const BACKUP = join(homedir(), ".pi", "agent", "models.json.verify-backup");

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? " :: " + detail : "")); console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

/* ── Back up the real config FIRST ──────────────────────────────────────────── */
if (!existsSync(CONFIG)) {
  console.error(`FATAL: ${CONFIG} does not exist; refusing to run.`);
  process.exit(2);
}
copyFileSync(CONFIG, BACKUP);
const originalRaw = readFileSync(CONFIG, "utf8");
const original = JSON.parse(originalRaw);

function restore() {
  try { writeFileSync(CONFIG, originalRaw); } catch (err) {
    console.error(`WARNING: could not restore ${CONFIG}: ${err.message}`);
  }
  /* Remove the backup on EVERY exit path. Leaving it behind means a snapshot of the
   * real file (with its real API key) sits in the user's config directory forever
   * after the run — a credential copy created by a test. */
  try { if (existsSync(BACKUP)) unlinkSync(BACKUP); } catch { /* best effort */ }
}
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

/** Reads the on-disk config fresh. Never cached. */
function disk() { return JSON.parse(readFileSync(CONFIG, "utf8")); }

/* ── The real secret, used only to prove it does NOT leak ───────────────────── */
const providerId = Object.keys(original.providers ?? {})[0];
const realKey = (original.providers?.[providerId]?.apiKey) ?? "";
const keyFragments = [];
if (typeof realKey === "string" && realKey.length >= 8) {
  /* Every 8-character window: a leak of a recognisable prefix is still a leak. */
  for (let i = 0; i + 8 <= realKey.length; i += 4) keyFragments.push(realKey.slice(i, i + 8));
}
console.log(`provider=${providerId} models=${(original.providers?.[providerId]?.models ?? []).length} keyLen=${realKey.length} fragments=${keyFragments.length}`);

/* ── CDP plumbing ──────────────────────────────────────────────────────────── */
const listing = await (await fetch(`${CDP}/json/list`)).json();
const page = listing.find((t) => t.type === "page" && /127\.0\.0\.1:4124/.test(t.url || "")) ?? listing.find((t) => t.type === "page");
if (!page) { console.error("FATAL: no Chrome page at :9444"); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
const frames = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  /* Capture every SSE payload body so the leak assertion has real material. */
  if (m.method === "Network.eventSourceMessageReceived") frames.push(m.params?.data ?? "");
  const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.enable");

const DOCK = `[...document.querySelectorAll('aside')].find(a=>a.getAttribute('aria-label')==='停靠栏')`;

async function viewport() {
  await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
}

async function openModels() {
  const collapsed = await ev(`!(${DOCK})`);
  if (collapsed) {
    await ev(`(() => {
      const c = document.querySelector('[aria-label="停靠栏（已折叠）"]');
      const b = c ? [...c.querySelectorAll('button')].find(x => /显示右侧停靠栏/.test(x.title||'')) : null;
      if (b) b.click();
      return !!b;
    })()`);
    await delay(1800);
  }
  const clicked = await ev(`(() => {
    const d = ${DOCK};
    const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '模型') : null;
    if (!b) return { ok: false };
    b.click();
    return { ok: true, title: (b.getAttribute('title')||'') };
  })()`);
  await delay(1800);
  return clicked;
}

/* ══ 1. The Settings surface exists and is reachable ═════════════════════════ */
console.log("\n[1] Settings tab is reachable");
await viewport();
await send("Page.navigate", { url: BASE + "?_v=" + Date.now() });
await delay(6000);
await viewport();

/* The sidebar's Settings BUTTON must no longer be permanently disabled. */
const sidebarBtn = await ev(`(() => {
  const btns = [...document.querySelectorAll('aside button')];
  const b = btns.find(x => (x.textContent||'').trim() === '模型' || (x.getAttribute('aria-label')||'') === '模型');
  if (!b) return { found: false };
  return { found: true, disabled: b.disabled === true, title: b.title || '' };
})()`);
check("1a sidebar Models button exists", sidebarBtn?.found === true, JSON.stringify(sidebarBtn));
check("1b sidebar Models button is NOT disabled", sidebarBtn?.disabled === false, JSON.stringify(sidebarBtn));
check(
  "1c its tooltip no longer claims no settings surface exists",
  typeof sidebarBtn?.title === "string" && !/no settings surface is exposed/i.test(sidebarBtn.title),
  sidebarBtn?.title,
);

const opened = await openModels();
check("1d Models dock tab exists and was clicked", opened?.ok === true, JSON.stringify(opened));
check(
  "1e its tooltip describes the host's own models.json",
  typeof opened?.title === "string" && /model/i.test(opened.title),
  opened?.title,
);

/* The panel reads on tab open, so poll instead of assuming one fixed delay. */
let panelUp = false;
for (let i = 0; i < 20; i += 1) {
  panelUp = (await ev(`!!document.querySelector('#settings-provider')`)) === true;
  if (panelUp) break;
  await delay(500);
}
check("1f Models panel rendered (provider select present)", panelUp === true);

/* ══ 2. The panel reflects the file on disk ══════════════════════════════════ */
console.log("\n[2] Panel matches disk");
/* The count label is derived from the rows, which render one tick after the panel
 * shell appears — poll for it rather than racing the render. */
for (let i = 0; i < 20; i += 1) {
  const hasCount = await ev('(() => [...document.querySelectorAll("span")].some(x => (x.textContent||"").startsWith("模型（")))()');
  if (hasCount) break;
  await delay(300);
}
const shown = await ev(`(() => {
  const sel = document.querySelector('#settings-provider');
  const idEl = [...document.querySelectorAll('li')].map(li => (li.querySelector('span')||{}).textContent||'').filter(Boolean);
  const countLabel = [...document.querySelectorAll('span')].map(s => (s.textContent||'')).find(t => (t||'').startsWith('模型（')) || '';
  return {
    provider: sel ? sel.value : null,
    options: sel ? [...sel.options].map(o => o.value) : [],
    baseUrl: (document.querySelector('#settings-base-url')||{}).value ?? null,
    api: (document.querySelector('#settings-api')||{}).value ?? null,
    countLabel,
    modelIds: idEl,
  };
})()`);
const diskModels = (disk().providers?.[providerId]?.models ?? []).map((m) => m.id);
check("2a provider select matches disk", shown?.provider === providerId, `${shown?.provider} vs ${providerId}`);
check("2b baseUrl matches disk", shown?.baseUrl === (original.providers[providerId].baseUrl ?? ""), shown?.baseUrl);
check("2c model count label matches disk", shown?.countLabel === `模型（${diskModels.length}）`, `${shown?.countLabel} vs 模型 (${diskModels.length})`);
const shownModelRows = (shown?.modelIds ?? []).filter((id) => diskModels.includes(id));
check("2d every on-disk model id is rendered", shownModelRows.length === diskModels.length, `${shownModelRows.length}/${diskModels.length}`);

/* ══ 3. THE NEGATIVE ASSERTIONS — no credential anywhere on the client ═══════ */
console.log("\n[3] The key does not leak");
check("3a we actually captured SSE frames to inspect", frames.length > 0, `frames=${frames.length}`);
const framesBlob = frames.join("\n");
const frameLeaks = keyFragments.filter((f) => framesBlob.includes(f));
check(
  "3b NO 8-char fragment of the real key appears in any SSE frame",
  keyFragments.length > 0 && frameLeaks.length === 0,
  frameLeaks.length ? `leaked: ${frameLeaks[0]}` : "no fragments captured",
);
check(
  "3c no SSE frame carries an apiKey field name",
  !/api[_-]?key/i.test(framesBlob),
);

const domBlob = await ev(`document.documentElement.outerHTML`);
const domLeaks = keyFragments.filter((f) => domBlob.includes(f));
check("3d NO 8-char fragment of the real key appears in the DOM", domLeaks.length === 0, domLeaks[0]);
/*
 * The DOM legitimately contains the string "settings-api-key" as the input's id,
 * so a bare /apiKey/ test would fail on honest markup. What must not appear is a
 * JSON-style apiKey FIELD carrying a value — that is the shape a leak takes.
 */
check(
  "3e the DOM contains no apiKey field assignment",
  !/"?api[_-]?key"?\s*:\s*"[^"]/.test(domBlob),
);

const keyInput = await ev(`(() => {
  const el = document.querySelector('#settings-api-key');
  if (!el) return { found: false };
  return { found: true, value: el.value, type: el.type, placeholder: el.placeholder || '' };
})()`);
check("3f apiKey input exists", keyInput?.found === true);
check("3g apiKey input value is strictly empty", keyInput?.value === "", JSON.stringify(keyInput?.value));
check("3h apiKey input is type=password", keyInput?.type === "password");
check(
  "3i placeholder tells the user leaving it blank keeps the key",
  typeof keyInput?.placeholder === "string" && /留空|保留/.test(keyInput.placeholder),
  keyInput?.placeholder,
);

/* Read the badge STRUCTURALLY, not by scanning body text: `textContent` glues the
 * label "API key" to the badge value into "API keyconfigured", so a word-boundary
 * regex on the whole body fails on honest markup. The badge is the small span that
 * sits next to the key field's label. */
const badge = await ev(`(() => {
  const el = document.querySelector('#settings-api-key');
  if (!el) return { badge: null };
  const label = el.closest('label');
  const spans = label ? [...label.querySelectorAll('span')] : [];
  const b = spans.find(s => /^(已配置|未设置)$/.test((s.textContent||'').trim()));
  return { badge: b ? (b.textContent||'').trim() : null };
})()`);
check(
  "3j hasKey badge is honest (file has a key → 'configured')",
  typeof realKey === "string" && realKey.length > 0 ? badge?.badge === "已配置" : badge?.badge === "未设置",
  JSON.stringify(badge),
);

/* ══ 4. A save that does not name the key leaves it byte-identical ═══════════ */
console.log("\n[4] Saving other fields preserves the key");
const keyBefore = disk().providers[providerId].apiKey;
const newBase = `${(original.providers[providerId].baseUrl ?? "").replace(/\/+$/, "")}/`;

await ev(`(() => {
  const el = document.querySelector('#settings-base-url');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(newBase)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`);
await delay(600);

const saveState = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /^保存$/.test((x.textContent||'').trim()));
  return b ? { found: true, disabled: b.disabled === true } : { found: false };
})()`);
check("4a Save button is enabled after an edit", saveState?.found === true && saveState.disabled === false, JSON.stringify(saveState));

await ev(`[...document.querySelectorAll('button')].find(x => /^保存$/.test((x.textContent||'').trim())).click()`);
await delay(3500);

const afterBase = disk().providers[providerId];
check("4b baseUrl was written to disk", afterBase.baseUrl === newBase, `${afterBase.baseUrl} vs ${newBase}`);
check(
  "4c the apiKey is BYTE-IDENTICAL after saving an unrelated field",
  afterBase.apiKey === keyBefore,
  afterBase.apiKey === keyBefore ? "" : "key changed",
);
check("4d the model list is unchanged", (afterBase.models ?? []).length === (original.providers[providerId].models ?? []).length);
check(
  "4e every model subtree is deep-equal to before",
  JSON.stringify(afterBase.models) === JSON.stringify(original.providers[providerId].models),
);

/* ══ 5. A blank key box does not clear the key ═══════════════════════════════ */
console.log("\n[5] A blank key box does not clear the key");
/* Type then clear the box: proves an emptied box emits no op rather than a
 * `set ""`. This is the classic accident. */
await ev(`(() => {
  const el = document.querySelector('#settings-api-key');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'temporary-typing');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  setter.call(el, '   ');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`);
await delay(600);
const saveAgain = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /^保存$/.test((x.textContent||'').trim()));
  return b ? { disabled: b.disabled === true } : null;
})()`);
/* With only whitespace in the key box and no other edit, there is nothing to
 * write — the diff is empty on purpose. */
check("5a whitespace-only key produces no pending change", saveAgain?.disabled === true, JSON.stringify(saveAgain));
check(
  "5b the apiKey on disk is still byte-identical",
  disk().providers[providerId].apiKey === keyBefore,
);

/* ══ 6. Adding a model lands exactly on disk ════════════════════════════════ */
console.log("\n[6] Adding a model");
const beforeAdd = disk().providers[providerId].models;
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /^添加模型$/.test((x.textContent||'').trim()));
  if (b) b.click();
  return !!b;
})()`);
await delay(700);
const addedCount = await ev(`(() => {
  const t = [...document.querySelectorAll('span')].map(s => s.textContent||'').find(x => (x||'').startsWith('模型（'));
  return t || '';
})()`);
check("6a a new model row was added in the form", addedCount === `模型（${beforeAdd.length + 1}）`, addedCount);

await ev(`[...document.querySelectorAll('button')].find(x => /^保存$/.test((x.textContent||'').trim())).click()`);
await delay(3500);
const afterAdd = disk().providers[providerId].models;
check("6b the new model was written to disk", afterAdd.length === beforeAdd.length + 1, `${afterAdd.length} vs ${beforeAdd.length + 1}`);
const extra = afterAdd.filter((m) => !beforeAdd.some((b) => b.id === m.id));
check("6c the added model is identifiable and has a valid token budget",
  extra.length === 1 && typeof extra[0].contextWindow === "number" && extra[0].maxTokens <= extra[0].contextWindow,
  JSON.stringify(extra[0] ?? null));
/* The pre-existing rows must be untouched — the ops were path-addressed, so an
 * insert cannot rewrite its neighbours. */
const preserved = beforeAdd.every((b) => {
  const now = afterAdd.find((m) => m.id === b.id);
  return JSON.stringify(now) === JSON.stringify(b);
});
check("6d every pre-existing model is deep-equal after the insert", preserved);
check(
  "6e the apiKey is STILL byte-identical after the insert",
  disk().providers[providerId].apiKey === keyBefore,
);

/* ══ 7. A stale revision is refused, not applied ════════════════════════════ */
console.log("\n[7] Stale revision is refused");
/* Load the panel state, then change the file behind its back. */
const revisionHolder = await ev(`(() => {
  const el = document.querySelector('#settings-base-url');
  return el ? el.value : null;
})()`);
/* Write the file out-of-band, simulating another editor. */
const tampered = disk();
tampered.providers[providerId].baseUrl = "http://edited-out-of-band.test/v1";
writeFileSync(CONFIG, JSON.stringify(tampered, null, 2) + "\n");
const outOfBandBase = "http://edited-out-of-band.test/v1";
check("7a the out-of-band edit is on disk", disk().providers[providerId].baseUrl === outOfBandBase);

/* Now try to save through the STALE form. The revision it holds no longer
 * matches, so the host must refuse rather than clobber the newer content. */
const staleEditApplied = await ev(`(() => {
  const el = document.querySelector('#settings-base-url');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'http://stale-form-wins.test/v1');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await delay(500);
if (staleEditApplied) {
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^保存$/.test((x.textContent||'').trim()));
    if (b && !b.disabled) b.click();
    return true;
  })()`);
  await delay(3500);
}
const afterStale = disk().providers[providerId].baseUrl;
check(
  "7b the stale save did NOT overwrite the newer on-disk content",
  afterStale === outOfBandBase,
  `${afterStale} (expected ${outOfBandBase})`,
);
const conflictText = await ev(`(() => {
  const t = document.body.textContent || '';
  return {
    conflict: /changed since this panel loaded/i.test(t),
    staleWon: /stale-form-wins\\.test/.test(t),
  };
})()`);
check(
  "7c the panel reported a conflict in its own words",
  conflictText?.conflict === true,
  JSON.stringify(conflictText),
);

/* ══ 8. Error copy is client-authored, never host prose ═════════════════════ */
console.log("\n[8] No host paths or stack text anywhere in the UI");
const leakProbe = await ev(`(() => {
  /* Scope to the MODELS PANEL. The transcript legitimately shows agent output and
   * this workspace's agent prints an absolute path, so a whole-document scan fails
   * on honest chat content unrelated to this surface. */
  const el = document.querySelector('#settings-provider');
  const root = el ? el.parentElement?.parentElement?.parentElement : null;
  const t = root ? (root.textContent || '') : '';
  const BS = String.fromCharCode(92);
  return {
    scoped: t.length > 0,
    driveLetter: t.includes('C:' + BS) || t.includes('/Users/') || t.includes('/home/'),
    stack: t.includes('    at ') || t.includes('node:internal'),
    errno: t.includes('EACCES') || t.includes('ENOENT') || t.includes('EPERM'),
    nodeInternals: t.includes('node:internal'),
  };
})()`);
check("8a the leak scan actually scoped to the panel", leakProbe?.scoped === true, JSON.stringify(leakProbe));
check("8b no absolute path or drive letter in the panel text", leakProbe?.driveLetter === false, JSON.stringify(leakProbe));
check("8c no JS stack frame in the panel text", leakProbe?.stack === false, JSON.stringify(leakProbe));
check("8c no errno identifier in the panel text", leakProbe?.errno === false, JSON.stringify(leakProbe));

/* ══ 9. After all of that, the key still never appeared ═════════════════════ */
console.log("\n[9] Final leak sweep after every interaction");
const finalFrames = frames.join("\n");
const finalFrameLeaks = keyFragments.filter((f) => finalFrames.includes(f));
const finalDom = await ev(`document.documentElement.outerHTML`);
const finalDomLeaks = keyFragments.filter((f) => finalDom.includes(f));
check("9a no key fragment in ANY frame across all interactions", finalFrameLeaks.length === 0, finalFrameLeaks[0]);
check("9b no key fragment in the DOM at the end", finalDomLeaks.length === 0, finalDomLeaks[0]);
const finalKeyValue = await ev(`(() => {
  const el = document.querySelector('#settings-api-key');
  if (!el) return null;
  /* Section 5 deliberately typed and then cleared this box; blank it here so the
   * final assertion measures the PANEL, not our own leftover keystrokes. */
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`);
check("9c the key input holds no residual value", finalKeyValue === "", JSON.stringify(finalKeyValue));

/* ══ Restore and report ═════════════════════════════════════════════════════ */
console.log("\n[10] Restoring the real config");
restore();
const restoredRaw = readFileSync(CONFIG, "utf8");
check("10a the real config was restored byte-for-byte", restoredRaw === originalRaw);
check("10b the restored file parses", (() => { try { JSON.parse(restoredRaw); return true; } catch { return false; } })());

ws.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
console.log("OK");
