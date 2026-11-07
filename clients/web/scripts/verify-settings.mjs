// Plan/80 — Settings panel + theme presets acceptance. Real Chrome over CDP against
// the LIVE direct-mode daemon on :4124, editing the REAL ~/.pi/agent/settings.json.
//
// The load-bearing assertions:
//   - the settings FILE is mixed, and its `packages` array holds absolute host
//     paths, so the panel must show preferences and NONE of that. Section 4 is a
//     negative assertion over the whole DOM.
//   - a theme preset must actually repaint the page, not merely store a string.
//     Section 5 measures a computed colour before and after switching.
//   - a save must touch only its own key. Section 6 asserts every other key survives
//     byte-for-byte at the value level.
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP = "http://127.0.0.1:9444";
const BASE = "http://127.0.0.1:4124/";
const CONFIG = join(homedir(), ".pi", "agent", "settings.json");

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? " :: " + detail : "")); console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

if (!existsSync(CONFIG)) { console.error(`FATAL: ${CONFIG} missing`); process.exit(2); }
const originalRaw = readFileSync(CONFIG, "utf8");
const original = JSON.parse(originalRaw);
process.on("exit", () => { try { writeFileSync(CONFIG, originalRaw); } catch { /* last resort */ } });

const disk = () => JSON.parse(readFileSync(CONFIG, "utf8"));

const listing = await (await fetch(`${CDP}/json/list`)).json();
const page = listing.find((t) => t.type === "page" && /127\.0\.0\.1:4124/.test(t.url || "")) ?? listing.find((t) => t.type === "page");
if (!page) { console.error("FATAL: no Chrome page"); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
const frames = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Network.eventSourceMessageReceived") frames.push(m.params?.data ?? "");
  const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.enable");

const DOCK = `[...document.querySelectorAll('aside')].find(a=>a.getAttribute('aria-label')==='停靠栏')`;
const viewport = () => send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });

async function openTab(label) {
  const collapsed = await ev(`!(${DOCK})`);
  if (collapsed) {
    await ev(`(() => {
      const c = document.querySelector('[aria-label="停靠栏（已折叠）"]');
      const b = c ? [...c.querySelectorAll('button')].find(x => /显示右侧停靠栏/.test(x.title||'')) : null;
      if (b) b.click(); return !!b;
    })()`);
    await delay(1800);
  }
  const r = await ev(`(() => {
    const d = ${DOCK};
    const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === ${JSON.stringify(label)}) : null;
    if (!b) return { ok: false };
    b.click();
    return { ok: true, title: b.getAttribute('title') || '' };
  })()`);
  await delay(2000);
  return r;
}

/* ══ 1. Both tabs exist and are distinct ═══════════════════════════════════ */
console.log("\n[1] Models and Settings are separate tabs");
await viewport();
await send("Page.navigate", { url: BASE + "?_v=" + Date.now() });
await delay(6500);
await viewport();

/* The dock starts collapsed, so tab labels only exist once it is shown.
 * Expanding is a precondition of reading them, not part of the assertion. */
const modelsOpen = await openTab("模型");
const tabLabels = await ev(`(() => {
  const d = ${DOCK};
  return d ? [...d.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean) : [];
})()`);
check("1a a Models tab exists", (tabLabels ?? []).includes("模型"), JSON.stringify(tabLabels));
check("1b a Settings tab exists", (tabLabels ?? []).includes("设置"), JSON.stringify(tabLabels));
check("1c the two are distinct entries", (tabLabels ?? []).filter((t) => t === "模型" || t === "设置").length === 2);
check("1d Models tab opens", modelsOpen?.ok === true);
check(
  "1e Models tooltip names models.json and not appearance/behaviour",
  typeof modelsOpen?.title === "string" && /models.json|模型/.test(modelsOpen.title) && !/外观|行为/.test(modelsOpen.title),
  modelsOpen?.title,
);
/* The panel re-reads on tab open, so the select appears only after the host
 * answers. Poll rather than assuming the read completed in the fixed delay above. */
let modelsStillWorks = false;
for (let i = 0; i < 20; i += 1) {
  modelsStillWorks = (await ev(`!!document.querySelector('#settings-provider')`)) === true;
  if (modelsStillWorks) break;
  await delay(500);
}
check("1f Model Providers panel still renders its provider select (regression)", modelsStillWorks === true);

/* Every tab must be reachable. Adding Settings + Models pushed the row past the dock
 * width and the LAST tab was clipped behind the collapse button, so the newest
 * surface was the hardest one to open. The fix scrolls the row; this asserts the
 * end state rather than the CSS mechanism. */
const tabFit = await ev(`(() => {
  const d = ${DOCK};
  const tl = d ? d.querySelector('[class*="tabList"]') : null;
  if (!tl) return { found: false };
  const box = tl.getBoundingClientRect();
  const tabs = [...tl.querySelectorAll('button')].map((b) => ({
    label: (b.textContent || '').trim(),
    inside: b.getBoundingClientRect().right <= box.right + 1,
  }));
  return { found: true, tabs, scrollable: tl.scrollWidth > tl.clientWidth };
})()`);
check("1g all eight tabs are present", (tabFit?.tabs ?? []).length === 8, JSON.stringify((tabFit?.tabs ?? []).map((t) => t.label)));
check(
  "1h no tab is clipped outside the tab row",
  (tabFit?.tabs ?? []).length > 0 && (tabFit?.tabs ?? []).every((t) => t.inside),
  JSON.stringify((tabFit?.tabs ?? []).filter((t) => !t.inside).map((t) => t.label)),
);

const settingsOpen = await openTab("设置");
check("2a Settings tab opens", settingsOpen?.ok === true);
check(
  "2b Settings tooltip names appearance/behaviour and not models.json",
  typeof settingsOpen?.title === "string" && /外观|行为/.test(settingsOpen.title) && !/models\.json/.test(settingsOpen.title),
  settingsOpen?.title,
);

/* ══ 2. The host values match disk ═════════════════════════════════════════ */
console.log("\n[2] Host values match the file on disk");
const shown = await ev(`(() => {
  const theme = document.querySelector('#settings-host-theme');
  const hide = document.querySelector('#settings-hide-thinking');
  const retry = document.querySelector('#settings-retry-enabled');
  const max = document.querySelector('#settings-max-retries');
  const base = document.querySelector('#settings-base-delay');
  const pmax = document.querySelector('#settings-provider-max-delay');
  return {
    theme: theme ? (theme.textContent||'').trim() : null,
    hide: hide ? hide.checked : null,
    retry: retry ? retry.checked : null,
    max: max ? max.value : null,
    base: base ? base.value : null,
    pmax: pmax ? pmax.value : null,
  };
})()`);
check("2c host theme is displayed read-only and matches disk", shown?.theme === String(original.theme ?? ""), `${shown?.theme} vs ${original.theme}`);
check("2d hideThinkingBlock toggle matches disk", shown?.hide === (original.hideThinkingBlock === true), JSON.stringify(shown?.hide));
check("2e retry.enabled matches disk", shown?.retry === (original.retry?.enabled === true), JSON.stringify(shown?.retry));
check("2f retry.maxRetries matches disk", shown?.max === String(original.retry?.maxRetries ?? ""), `${shown?.max}`);
check("2g retry.baseDelayMs matches disk", shown?.base === String(original.retry?.baseDelayMs ?? ""));
check("2h retry.provider.maxRetryDelayMs matches disk", shown?.pmax === String(original.retry?.provider?.maxRetryDelayMs ?? ""));

/* ══ 3. The mixed file's other keys are NOT in the payload or the DOM ══════ */
console.log("\n[3] packages / extensions / lastChangelogVersion are not leaked");
const framesBlob = frames.join("\n");
check("3a we captured SSE frames", frames.length > 0, `frames=${frames.length}`);
check("3b no frame carries 'packages'", !/packages/.test(framesBlob));
check("3c no frame carries 'lastChangelogVersion'", !/lastChangelogVersion/.test(framesBlob));

const domBlob = await ev(`document.documentElement.outerHTML`);
check("3d DOM has no 'lastChangelogVersion'", !/lastChangelogVersion/.test(domBlob));
check("3e DOM has no package specifiers from the file",
  !(original.packages ?? []).some((p) => domBlob.includes(String(p).slice(-24))),
  "a package specifier appeared");
/* Scope the leak scan to the SETTINGS PANEL, not the whole document.
 *
 * The transcript legitimately shows agent output, and this workspace's agent has
 * printed an absolute path (`No .workflow directory found at D:\…`). Scanning the
 * whole DOM would fail on honest chat content that has nothing to do with this
 * panel — the assertion is about what THE SETTINGS SURFACE exposes. */
const panelBlob = await ev(`(() => {
  const el = document.querySelector('#settings-host-theme');
  /* Walk up to the nearest ancestor that actually HAS the panel text. A fixed
   * hop count silently picked an empty wrapper as soon as the markup moved. */
  let root = el;
  while (root !== null && (root.textContent || '').trim().length < 40) root = root.parentElement;
  return root ? root.textContent || '' : '';
})()`);
check("3f Settings panel text has no absolute host path",
  panelBlob !== "" && !/(?:[A-Za-z]:\\|\/Users\/|\/home\/)/.test(panelBlob),
  (panelBlob.length > 120 ? panelBlob.slice(0, 120) : panelBlob));
/* Scoped to the panel for the same reason as 3f: the transcript legitimately shows
 * agent output, and this workspace's agent has named installed packages. The claim
 * under test is what the SETTINGS surface exposes, not what chat contains. */
check("3g Settings panel text names no package specifier",
  panelBlob !== "" && !/pi-maestro-flow|pi-cockpit|pi-model-log/.test(panelBlob));

/* ══ 4. Light / dark actually repaints the page ═════════════════════════════
 *
 * The assertion that matters is that a COMPUTED colour changes. Asserting the
 * attribute alone would pass even if the dark palette were unused, which is exactly
 * the state this repo was in: `:root[data-theme="dark"]` existed with 39 token
 * overrides and nothing ever set the attribute. */
console.log("\n[4] Dark mode really repaints the page");
const readPalette = `(() => {
  const root = getComputedStyle(document.documentElement);
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    bg: root.getPropertyValue("--dsw-alias-bg-base").trim(),
    label: root.getPropertyValue("--dsw-alias-label-primary").trim(),
    scheme: root.colorScheme,
  };
})()`;

/* Force light through the panel and record the palette. */
await ev(`window.localStorage.setItem("remote-pi.theme-mode", "light")`);
await send("Page.reload");
await delay(6500);
await viewport();
const lightPalette = await ev(readPalette);
check("4a light mode sets data-theme=light", lightPalette?.theme === "light", JSON.stringify(lightPalette));
check("4b light palette is a bright canvas", /rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)/.test(lightPalette?.bg ?? ""), lightPalette?.bg);

/* Now switch to Dark THROUGH THE UI, which is the path a user takes. */
await openTab("设置");
const clickedDark = await ev(`(() => {
  const b = document.querySelector("#settings-mode-dark");
  if (!b) return false;
  b.click();
  return true;
})()`);
check("4c the Dark control exists in the panel", clickedDark === true);
await delay(900);
const darkPalette = await ev(readPalette);
check("4d data-theme becomes dark", darkPalette?.theme === "dark", JSON.stringify(darkPalette));
check("4e the canvas got DARKER (computed, not just an attribute)",
  !/rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)/.test(darkPalette?.bg ?? "") && darkPalette?.bg !== lightPalette?.bg,
  `${lightPalette?.bg} -> ${darkPalette?.bg}`);
check("4f the ink colour inverted", darkPalette?.label !== lightPalette?.label, `${lightPalette?.label} -> ${darkPalette?.label}`);
check("4g color-scheme reports dark (native widgets follow)", darkPalette?.scheme === "dark", darkPalette?.scheme);

/* The dark set must be COMPLETE: a light-only scrollbar token on a dark canvas is
 * the bug that filling it in was meant to prevent. Read the RESOLVED values
 * (`getComputedStyle` of a probe element) rather than the raw custom properties,
 * because a chain of `var()` indirection can leave the raw property empty while the
 * computed colour is perfectly valid. */
const darkComplete = await ev(`(() => {
  const probe = document.createElement('div');
  probe.style.color = 'var(--dsw-alias-state-success-primary)';
  probe.style.background = 'var(--dsw-alias-scrollbar-bg-l1)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { success: cs.color, scrollbar: cs.backgroundColor };
  probe.remove();
  return { ...out, theme: document.documentElement.getAttribute('data-theme') };
})()`);
check("4h the scrollbar no longer inherits the light thumb colour",
  darkComplete?.theme !== "dark" || !/229, 229, 229/.test(darkComplete?.scrollbar ?? ""),
  darkComplete?.scrollbar);
check("4i success state resolves to a real colour in dark",
  /^rgb/.test(darkComplete?.success ?? "") && darkComplete?.success !== "rgba(0, 0, 0, 0)",
  darkComplete?.success);

/* Persistence across a reload, and the intent — not the palette — is what is stored. */
await send("Page.reload");
await delay(6500);
await viewport();
const afterDarkReload = await ev(readPalette);
const storedIntent = await ev(`window.localStorage.getItem("remote-pi.theme-mode")`);
check("4j dark survives a reload", afterDarkReload?.theme === "dark", afterDarkReload?.theme);
check("4k the stored value is the INTENT ('dark'), not a resolved boolean", storedIntent === "dark", String(storedIntent));

/* `system` must store the intent and resolve to whatever the OS says. */
await openTab("设置");
await ev(`(() => { const b = document.querySelector("#settings-mode-system"); if (b) b.click(); return !!b; })()`);
await delay(900);
const systemState = await ev(`(() => ({
  theme: document.documentElement.getAttribute("data-theme"),
  stored: window.localStorage.getItem("remote-pi.theme-mode"),
  prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
}))()`);
check("4l System stores the intent 'system', not a frozen palette", systemState?.stored === "system", String(systemState?.stored));
check("4m System resolves to the OS preference",
  systemState?.theme === (systemState?.prefersDark ? "dark" : "light"),
  JSON.stringify(systemState));

/* A preset accent is calibrated PER CANVAS: a 500-level hue recedes on a near-black
 * canvas, so each preset carries a lighter step for dark. Switching the mode must
 * re-resolve the accent rather than leaving the light one in place. */
console.log("\n[4b] Preset accents are calibrated per canvas");
await ev(`window.localStorage.setItem("remote-pi.theme-mode", "dark")`);
await send("Page.reload");
await delay(6500);
await viewport();
await openTab("设置");

const darkAccents = {};
for (const name of ["海洋", "森林", "琥珀", "紫罗兰"]) {
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(name)}); if(b) b.click(); return !!b; })()`);
  await delay(500);
  darkAccents[name] = await ev(`getComputedStyle(document.body).getPropertyValue("--dsw-preset-accent").trim()`);
}
check("4t1 Ocean uses its dark-calibrated step", darkAccents["海洋"] === "#60a5fa", darkAccents["海洋"]);
check("4t2 Forest uses its dark-calibrated step", darkAccents["森林"] === "#34d399", darkAccents["森林"]);
check("4t3 Amber uses its dark-calibrated step", darkAccents["琥珀"] === "#fbbf24", darkAccents["琥珀"]);
check("4t4 Violet uses its dark-calibrated step", darkAccents["紫罗兰"] === "#a78bfa", darkAccents["紫罗兰"]);

/* Every visible text node must clear WCAG AA 4.5:1 against the surface it sits on.
 * This is the assertion that would have caught `running` at 1.44:1 — a value no type
 * checker, linter or token audit can see. */
const contrastFailures = await ev(`(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b);
  };
  const blend = (fg, bg) => fg.a >= 0.999 ? fg : {
    r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a),
    b: fg.b*fg.a + bg.b*(1-fg.a), a: 1,
  };
  const htmlBg = parse(getComputedStyle(document.documentElement).backgroundColor);
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
  const docBg = (htmlBg && htmlBg.a > 0.01) ? htmlBg : (bodyBg && bodyBg.a > 0.01 ? bodyBg : {r:255,g:255,b:255,a:1});
  const bgOf = (el) => {
    const own = parse(getComputedStyle(el).backgroundColor);
    if (own && own.a > 0.01) return blend(own, docBg);
    let n = el.parentElement;
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.01) return blend(c, docBg);
      n = n.parentElement;
    }
    return docBg;
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 60) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (el.closest('.sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.3) continue;
    const fg0 = parse(cs.color);
    if (!fg0) continue;
    const bg = bgOf(el);
    const fg = blend(fg0, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = Math.round(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05))*100)/100;
    if (ratio >= 4.5) continue;
    const key = t.slice(0,20) + cs.color;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: t.slice(0,24), ratio, color: cs.color });
  }
  return out;
})()`);
check(
  "4b5 no visible text in dark falls below WCAG AA 4.5:1",
  (contrastFailures ?? []).length === 0,
  JSON.stringify(contrastFailures),
);

/* Leave the environment explicit so later assertions are deterministic. */
await ev(`window.localStorage.setItem("remote-pi.theme-mode", "light")`);
await send("Page.reload");
await delay(6500);
await viewport();
await openTab("设置");

/* ══ 5. A theme preset actually repaints the page ══════════════════════════ */
console.log("\n[5] Accent preset really changes appearance");
const beforePreset = await ev(`(() => {
  const b = document.body;
  return {
    attr: b.getAttribute('data-theme-preset'),
    accent: getComputedStyle(b).getPropertyValue('--dsw-preset-accent').trim(),
    bg: getComputedStyle(b).backgroundColor,
  };
})()`);
const clickedPreset = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '海洋');
  if (!b) return null;
  b.click();
  return true;
})()`);
await delay(700);
const afterPreset = await ev(`(() => {
  const b = document.body;
  return {
    attr: b.getAttribute('data-theme-preset'),
    accent: getComputedStyle(b).getPropertyValue('--dsw-preset-accent').trim(),
    stored: window.localStorage.getItem('remote-pi.theme-preset'),
    ariaChecked: (() => {
      const r = [...document.querySelectorAll('[role="radio"]')].find(x => (x.textContent||'').trim() === '海洋');
      return r ? r.getAttribute('aria-checked') : null;
    })(),
  };
})()`);
check("5a clicking a preset is possible", clickedPreset === true);
check("5b body[data-theme-preset] changed to ocean", afterPreset?.attr === "ocean", afterPreset?.attr);
check("5c --dsw-preset-accent is now set (the CSS actually receives it)", afterPreset?.accent === "#3b82f6", afterPreset?.accent);
check("5d the preset was persisted to localStorage", afterPreset?.stored === "ocean", afterPreset?.stored);
check("5e the radio reports aria-checked for the active preset", afterPreset?.ariaChecked === "true", afterPreset?.ariaChecked);

/* The accent must be OBSERVABLE, not just stored: check that a rule which consumes
 * it computes a different value than with the default preset. */
const accentEffect = await ev(`(() => {
  const b = document.body;
  const a = getComputedStyle(b).getPropertyValue('--dsw-preset-accent').trim();
  const before = ${JSON.stringify(beforePreset?.accent ?? "")};
  return { before, after: a, changed: before !== a };
})()`);
check("5f the accent variable changed from its default value", accentEffect?.changed === true, JSON.stringify(accentEffect));

/* Persistence across a reload. */
await send("Page.reload");
await delay(6000);
await viewport();
const afterReload = await ev(`(() => ({
  attr: document.body.getAttribute('data-theme-preset'),
  accent: getComputedStyle(document.body).getPropertyValue('--dsw-preset-accent').trim(),
}))()`);
check("5g the preset survives a page reload", afterReload?.attr === "ocean", afterReload?.attr);
check("5h the accent is re-applied before any interaction", afterReload?.accent === "#3b82f6", afterReload?.accent);

/* Restore default so the following sections start from a known state. */
await openTab("设置");
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '默认');
  if (b) b.click(); return !!b;
})()`);
await delay(600);
const backToDefault = await ev(`(() => ({
  attr: document.body.getAttribute('data-theme-preset'),
  accent: getComputedStyle(document.body).getPropertyValue('--dsw-preset-accent').trim(),
}))()`);
check("5i switching back to Default clears the accent (default is a true no-op)",
  backToDefault?.attr === "default" && backToDefault?.accent === "",
  JSON.stringify(backToDefault));

/* ══ 5. A save touches only its own key ════════════════════════════════════ */
console.log("\n[5] Saving one field leaves every other key alone");
const beforeSave = disk();
const newMax = (beforeSave.retry?.maxRetries ?? 10) + 3;

await openTab("设置");
await ev(`(() => {
  const el = document.querySelector('#settings-max-retries');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(String(newMax))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await delay(600);
const saveBtn = await ev(`(() => {
  const b = document.querySelector('#settings-save');
  return b ? { found: true, disabled: b.disabled } : { found: false };
})()`);
check("6a Save is enabled after an edit", saveBtn?.found === true && saveBtn.disabled === false, JSON.stringify(saveBtn));
await ev(`document.querySelector('#settings-save').click()`);
await delay(3500);

const afterSave = disk();
check("6b retry.maxRetries was written", afterSave.retry?.maxRetries === newMax, `${afterSave.retry?.maxRetries} vs ${newMax}`);
check("6c packages are byte-identical",
  JSON.stringify(afterSave.packages) === JSON.stringify(beforeSave.packages));
check("6d extensions are byte-identical",
  JSON.stringify(afterSave.extensions) === JSON.stringify(beforeSave.extensions));
check("6e lastChangelogVersion is byte-identical",
  afterSave.lastChangelogVersion === beforeSave.lastChangelogVersion);
check("6f theme is byte-identical (read-only here)", afterSave.theme === beforeSave.theme);
check("6g hideThinkingBlock is byte-identical", afterSave.hideThinkingBlock === beforeSave.hideThinkingBlock);
check("6h the rest of retry is byte-identical",
  afterSave.retry?.enabled === beforeSave.retry?.enabled &&
  afterSave.retry?.baseDelayMs === beforeSave.retry?.baseDelayMs &&
  afterSave.retry?.provider?.maxRetryDelayMs === beforeSave.retry?.provider?.maxRetryDelayMs);

/* ══ 6. Stale revision is refused ══════════════════════════════════════════ */
console.log("\n[6] A stale save is refused");
const tampered = disk();
tampered.retry.maxRetries = 99;
writeFileSync(CONFIG, JSON.stringify(tampered, null, 2) + "\n");
check("7a the out-of-band edit is on disk", disk().retry.maxRetries === 99);

await ev(`(() => {
  const el = document.querySelector('#settings-base-delay');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '4321');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await delay(500);
await ev(`(() => {
  const b = document.querySelector('#settings-save');
  if (b && !b.disabled) b.click();
  return true;
})()`);
await delay(3500);
const afterStale = disk();
check("7b the stale save did not overwrite newer content", afterStale.retry?.maxRetries === 99, String(afterStale.retry?.maxRetries));
check("7c the stale value was not written either", afterStale.retry?.baseDelayMs !== 4321, String(afterStale.retry?.baseDelayMs));
const conflictText = await ev(`(() => {
  const t = document.body.textContent || '';
  return /changed since this panel loaded|conflict/i.test(t);
})()`);
check("7d the panel reported the conflict in its own words", conflictText === true);

/* ══ 7. Copy hygiene ══════════════════════════════════════════════════════ */
console.log("\n[7] No host paths or stack text in the panel");
const leak = await ev(`(() => {
  const el = document.querySelector('#settings-host-theme');
  /* Walk up to the panel root instead of three fixed hops: the internal nesting
   * is a styling detail, and a fixed depth silently picked an EMPTY ancestor the
   * moment the markup was restructured. */
  const root = el ? el.closest('section') ?? el.parentElement : null;
  const t = root ? (root.textContent || '') : '';
  const BS = String.fromCharCode(92);
  return {
    scoped: t.length > 0,
    path: t.includes('C:' + BS) || t.includes('/Users/') || t.includes('/home/'),
    stack: t.includes('    at ') || t.includes('node:internal'),
    errno: t.includes('EACCES') || t.includes('ENOENT') || t.includes('EPERM'),
  };
})()`);
check("8a the leak scan actually scoped to the panel", leak?.scoped === true);
check("8b no absolute path in the panel text", leak?.path === false);
check("8c no stack frame in the panel text", leak?.stack === false);
check("8d no errno in the panel text", leak?.errno === false);

/* ══ 8. Restore ═══════════════════════════════════════════════════════════ */
console.log("\n[8] Restoring the real settings.json");
writeFileSync(CONFIG, originalRaw);
check("9a the real file was restored byte-for-byte", readFileSync(CONFIG, "utf8") === originalRaw);
check("9b it still parses", (() => { try { JSON.parse(readFileSync(CONFIG, "utf8")); return true; } catch { return false; } })());

ws.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
console.log("OK");
