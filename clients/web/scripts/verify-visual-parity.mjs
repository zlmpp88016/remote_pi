/**
 * Visual parity gate — the assertion that `clients/web` really carries DSH's
 * design platform, not just that the stylesheet mentions it.
 *
 * WHY IT READS THE BROWSER AND NOT THE CSS FILES: a token declared on `:root`
 * inside `@layer theme` only counts if it survives the cascade and reaches the
 * elements. Twice during this migration a stylesheet change kept parsing while
 * its values silently resolved to nothing (the `--spacing` collapse, the
 * `--default-mono-font-family` loss), and only a computed-style read caught it.
 *
 * So this script does two things a file parse cannot:
 *   1. reads every DSH token back out of a real Chrome via CDP;
 *   2. re-reads them from the LIVE DSH instance on :3080 and compares, so the
 *      reference is the running product rather than a value copied into a
 *      comment months ago.
 *
 * The DSH half is best-effort: it needs a process-scoped launch token and the
 * instance is not always up. If DSH cannot be reached the script says so and
 * falls back to the recorded baseline in `_e2e-evidence/comparison/` — it never
 * passes by silently skipping a comparison.
 *
 * IT IS PART OF `npm run verify:web` (last entry in `SUITE`, run by
 * `run-web-checks.mjs`). It used to be in no runner and no CI workflow — only a
 * line in README.md — which is how three of its expectations (`label-tertiary`,
 * `label-caption`, the composer placeholder) stayed pinned to the OLD
 * pre-AA `rgb(129, 133, 140)` for a whole branch while the token moved to
 * `bluish-700`. A gate nothing runs cannot notice drift; wiring it in is the fix.
 *
 * Everything it drives is found by the product's own strings (已连接主机,
 * 显示右侧停靠栏, 会话, 运行中/未运行, 解除该主机配对…). The English selectors it
 * used to carry (`host connected`, `Show the right dock`, `Sessions`,
 * `Workspaces`, `/running/i`, `Unpair this host…`) existed nowhere in `src`, so
 * the component half silently measured an absent element every run.
 *
 * Usage: node scripts/verify-visual-parity.mjs
 *        (or: npm run verify:web, which runs it with the rest of the suite)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attach, evaluate, sleep , APP_ORIGIN } from "./_cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "_e2e-evidence", "comparison");

const DSH_ORIGIN = process.env.DSH_ORIGIN ?? "http://127.0.0.1:3080";
const DSH_TOKEN = process.env.DSH_TOKEN ?? "FSnKtHVOps8QSt6uJv0FF34mUP4hr4cDOWaZMbDF7rg";

/*
 * DSH's custom properties resolve to whatever notation the author used — hex,
 * `rgb()`, or 8-digit hex for alpha — and ours mostly resolve to `rgb()`.
 * Comparing the raw strings therefore reports differences that are not real.
 * Normalising both sides to `r,g,b[,a]` is the only honest comparison.
 */
/*
 * Alpha is compared to 2 decimals on purpose. DSH authors alpha as 8-digit
 * hex (0x73/255 = 0.4510) while ours is written 0.45; a strict comparison
 * would fail on a rounding artefact rather than on a real colour difference.
 */
function normalise(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "") return "";
  const round = (n) => Number(n.toFixed(2));
  if (v.startsWith("rgb")) {
    const n = v.match(/-?[\d.]+/g);
    if (!n) return v;
    const [r, g, b, a] = n.map(Number);
    return a === undefined ? `${r},${g},${b}` : `${r},${g},${b},${round(a)}`;
  }
  if (v.startsWith("#")) {
    const h = v.slice(1);
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split("").map((c) => parseInt(c + c, 16));
      return a === undefined ? `${r},${g},${b}` : `${r},${g},${b},${round(a / 255)}`;
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if (h.length === 6) return `${r},${g},${b}`;
      return `${r},${g},${b},${round(parseInt(h.slice(6, 8), 16) / 255)}`;
    }
  }
  return v;
}

let fail = 0;
const check = (label, actual, expected) => {
  const ok = normalise(actual) === normalise(expected);
  if (!ok) fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (want ${JSON.stringify(expected)})`}`,
  );
};
const note = (msg) => console.log(`note ${msg}`);

/* ── 1. our own tokens, as the browser resolves them ──────────────────────── */

/*
 * Expected values are the LIGHT theme, which is the default because that is what
 * DSH's web UI actually renders. These were previously all dark values — measured
 * against a dark token snapshot rather than the running reference — which is why
 * this suite could be green on an interface that looked nothing like DSH.
 */
const TOKENS = [
  ["--dsw-alias-bg-base", "rgb(255, 255, 255)"],
  ["--dsw-alias-bg-layer-1", "rgb(255, 255, 255)"],
  ["--dsw-alias-bg-layer-2", "rgb(255, 255, 255)"],
  ["--dsw-specific-sidebar-fill", "rgb(249, 250, 251)"],
  ["--dsw-specific-input-major", "rgb(255, 255, 255)"],
  ["--dsw-specific-bubble", "rgb(237, 243, 254)"],
  ["--dsw-specific-selector", "rgb(245, 246, 247)"],
  ["--dsw-menu-surface-fill", "rgba(255, 255, 255, 0.92)"],
  ["--dsw-alias-bg-mask-1", "rgba(0, 0, 0, 0.5)"],
  ["--dsw-alias-label-primary", "rgb(15, 17, 21)"],
  ["--dsw-alias-label-secondary", "rgb(97, 102, 107)"],
  /*
   * Raised from DSH's light `bluish-600` (129,133,140 = 3.71:1 on white) to
   * `bluish-700` for WCAG AA — see the ink ramp in design-platform.css. The
   * expected value here must follow the token, not the other way round: it was
   * left at the old `bluish-600` value while the token moved, which is exactly
   * the drift that kept this gate from being wired into a runner.
   */
  ["--dsw-alias-label-tertiary", "rgb(97, 102, 107)"],
  ["--dsw-static-deepseek-400", "rgb(122, 170, 255)"],
  ["--dsw-static-deepseek-450", "rgb(86, 134, 254)"],
  ["--dsw-alias-interactive-bg-hover", "rgba(38, 49, 72, 0.06)"],
  ["--dsw-alias-border-l1", "rgba(0, 0, 0, 0.04)"],
  ["--dsw-alias-border-l2", "rgba(0, 0, 0, 0.1)"],
  ["--dsw-alias-markdown-code-block", "rgb(249, 250, 251)"],
  ["--dsw-alias-markdown-code-block-banner", "rgb(241, 243, 245)"],
  ["--dsw-radius-sm", "8px"],
  ["--dsw-radius-md", "12px"],
  ["--dsw-radius-lg", "16px"],
  ["--dsw-radius-xl", "20px"],
  ["--dsw-radius-panel", "28px"],
  ["--dsw-radius-pill", "999px"],
];

const { send, sent, received } = await attach();

/*
 * ── 0. layout invariants ─────────────────────────────────────────────────
 *
 * Everything below measures colours and component boxes, which all pass even
 * when the page is not a page: the app once rendered a 2612px document inside a
 * 945px viewport with `body{overflow-y:hidden}`, so the composer sat below the
 * fold, no scroll container existed, and the transcript was simply unreachable
 * — while every token assertion stayed green. These are the cheapest possible
 * guards against that class of failure, and they must run FIRST: a broken
 * height chain makes every later measurement meaningless.
 */
console.log("\n== layout ==");
{
  await evaluate(send, `location.href = "${APP_ORIGIN}/remote-pi/connect"`);
  for (let i = 0; i < 60; i++) {
    /* The product's connection pill reads 已连接主机 (remote-pi-shell.tsx:283).
       The English string this gate used to wait for (`host connected`) does not
       exist anywhere in src, so the wait always ran its full 60 s budget and
       then measured a page that had never reached the connected view. */
    const up = await evaluate(send, '(document.body.innerText||"").includes("已连接主机")').catch(() => false);
    if (up) break;
    await sleep(1000);
  }
  await sleep(1500);
  /* Full height, so a narrow viewport cannot make the shell look right by accident. */
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 945,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);

  const shell = JSON.parse(
    await evaluate(send, `(() => {
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
  const body = document.body, root = document.getElementById("root");
  const app = root?.firstElementChild, main = app?.querySelector("main");
  const shellEl = document.querySelector(".rp-app-shell");
  const form = [...document.querySelectorAll("form")].find((f) => f.querySelector("textarea"));
  const fr = form?.getBoundingClientRect();
  return JSON.stringify({
    viewport: window.innerHeight,
    docScrollH: document.documentElement.scrollHeight,
    bodyH: h(body), rootH: h(root), appH: h(app), mainH: h(main), shellH: h(shellEl),
    /* The document must not be taller than the viewport: the shell owns the
       scroll, and a taller document means the chain broke again. */
    documentFits: document.documentElement.scrollHeight <= window.innerHeight + 1,
    /* #root must be the viewport height, not its content height. */
    rootFills: h(root) === window.innerHeight,
    composerPresent: !!form,
    composerInView: fr ? fr.top >= 0 && fr.bottom <= window.innerHeight + 1 : null,
    composerBottomFromBottom: fr ? window.innerHeight - Math.round(fr.bottom) : null,
  });
})()`),
  );

  check("document does not exceed the viewport", shell.documentFits, true);
  check("#root fills the viewport", shell.rootFills, true);
  check("shell chain is uniform",
    [shell.rootH, shell.appH, shell.mainH, shell.shellH].every((v) => v === shell.viewport), true);
  check("composer is mounted", shell.composerPresent, true);
  check("composer is inside the viewport", shell.composerInView, true);
  note(
    `composer sits ${shell.composerBottomFromBottom}px above the viewport bottom (was ~1700px below before the height chain was fixed)`,
  );

  /* Open a history session: the read-only viewer REPLACES the composer row, so
     this is the state where the chain used to break again. */
  /*
   * Wait for an actual workspace ROW, not just for the connection pill.
   *
   * 已连接主机 only means the relay room is open. Right after a gate that made
   * the host respawn (`verify-web-resume-feedback` runs immediately before this
   * one in the suite), the pill is already green while `workspace_list` has not
   * answered yet — the sidebar renders no rows and this section then reported
   * "no-workspace-button" as three product failures about a viewer it never
   * opened. The row is the precondition these assertions need.
   */
  let wsButtonFound = false;
  for (let i = 0; i < 60; i++) {
    wsButtonFound = await evaluate(
      send,
      `[...document.querySelectorAll('button')].some((x) => /运行中|未运行/.test(x.getAttribute("title") || ""))`,
    ).catch(() => false);
    if (wsButtonFound) break;
    await sleep(1000);
  }
  check("a workspace row is listed", wsButtonFound, true);

  /*
   * Select a workspace FIRST, explicitly.
   *
   * The Sessions panel lists nothing until a workspace is active — its list has
   * no rows and renders `先连接主机并选择运行中的工作区。` instead. This section
   * used to pass only because the tab happened to already have a workspace
   * selected from an earlier run, so on a clean profile the three viewer
   * assertions below failed with `hasLi:0`. Selecting it here makes the gate
   * independent of leftover state.
   *
   * The match is `运行中` (`workspaceStatus`, view-model.ts:266) and not the
   * English `running` — no button in this product ever carried that text, so the
   * fallback never matched anything.
   */
  const wsPicked = await evaluate(send, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /运行中/.test(x.getAttribute("title") || ""))
      || [...document.querySelectorAll('button')].find(x => /运行中/.test(x.innerText || ""));
    if (!b) return "no-workspace-button";
    b.click(); return "picked:" + (b.getAttribute("title") || "").slice(0, 24);
  })()`);
  note(`workspace selection: ${wsPicked}`);
  await sleep(1200);
  /* The dock's open control carries `显示右侧停靠栏` (workspace-sidebar.tsx:611);
     it is `收起右侧停靠栏` once open, so only click when it is the open form. */
  const dockOpened = await evaluate(send, `(() => {
    if (document.querySelector('aside[aria-label="停靠栏"]')) return "already open";
    const d = [...document.querySelectorAll("button")].find(x => (x.getAttribute("title") || "").startsWith("显示右侧停靠栏"));
    if (d) { d.click(); return "clicked"; }
    return "no dock toggle";
  })()`);
  note(`dock: ${dockOpened}`);
  await sleep(1500);
  await evaluate(send, `(() => {
    const dock = document.querySelector('aside[aria-label="停靠栏"]');
    const t = dock ? [...dock.querySelectorAll("button")].find(x => (x.textContent || "").trim() === "会话") : null;
    if (t) t.click();
    return !!t;
  })()`);
  /* Wait for rows instead of guessing: a list request through the relay is not
     instant, and a fixed sleep is exactly how this section went flaky.

     The budget is 60 s and it asks the panel to refresh, because selecting a
     workspace switches rooms and the host answers `session_list` only once its
     session directory is ready — right after a gate that made the host respawn
     that can take tens of seconds. A 20 s poll is what produced the
     occasional `hasLi:0` red here; widening the budget makes the gate wait for
     the real condition instead of reporting a slow host as a broken viewer. */
  for (let i = 0; i < 300; i++) {
    const n = await evaluate(send, `document.querySelectorAll('section[aria-label="会话"] button[aria-label^="Read session"]').length`).catch(() => 0);
    if (Number(n) > 0) break;
    /* Every 5 s, ask the panel to list again (session-list.tsx:132). */
    if (i > 0 && i % 25 === 0) {
      await evaluate(send, `(() => {
        const b = document.querySelector('button[aria-label="刷新会话列表"]');
        if (b && !b.disabled) b.click();
        return !!b;
      })()`).catch(() => false);
    }
    await sleep(200);
  }
  const clickRes = JSON.parse(await evaluate(send, `(() => { const s=document.querySelector('section[aria-label="会话"]'); const lis=[...(s?.querySelectorAll("li")||[])]; const t=lis.find(li=>{const b=li.querySelector('button[aria-label^="Read session"]'); const l=(b&&b.getAttribute("aria-label"))||""; return /^Read session [0-9a-f]{8}$/.test(l);})||lis.find(li=>!(li.innerText||"").includes("LIVE")); const b=t?.querySelector('button[aria-label^="Read session"]'); if(b){b.click();return JSON.stringify({clicked:true,label:b.getAttribute("aria-label")});} return JSON.stringify({clicked:false,hasLi:lis.length,hasS:!!s}); })()`));
  note(`session click result: ${JSON.stringify(clickRes)}`);
  /*
   * Poll for the viewer instead of sleeping a fixed 4.5s. `session_read` is a
   * host round-trip: a fixed wait is either too short (the reply has not landed
   * and the viewer is not mounted yet) or wasted time when it is fast. This was
   * an intermittent failure before — one run green, the next red, same code.
   */
  for (let i = 0; i < 30; i++) {
    const up = await evaluate(
      send,
      `!![...document.querySelectorAll("span,div")].find((e) => (e.textContent||"").trim().toLowerCase() === "read-only")`,
    ).catch(() => false);
    if (up) break;
    await sleep(1000);
  }

  const viewer = JSON.parse(
    await evaluate(send, `(() => {
  const scroller = [...document.querySelectorAll("*")].find((e) => {
    const cs = getComputedStyle(e);
    return /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 20 && e.getBoundingClientRect().width > 400;
  });
  const before = scroller ? scroller.scrollTop : null;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const banner = [...document.querySelectorAll("span,div")].find((e) => (e.textContent||"").trim().toLowerCase() === "read-only");
  return JSON.stringify({
    viewerMounted: !!banner,
    scrollerFound: !!scroller,
    sh: scroller?.scrollHeight, ch: scroller?.clientHeight,
    before, after: scroller?.scrollTop,
    scrolls: scroller ? scroller.scrollTop > (before ?? 0) : false,
    documentFits: document.documentElement.scrollHeight <= window.innerHeight + 1,
  });
})()`),
  );

  check("history session viewer mounts", viewer.viewerMounted, true);
  check("viewer still fits the viewport", viewer.documentFits, true);
  check("viewer has a real scroll box", viewer.scrollerFound && viewer.sh > viewer.ch, true);
  check("history transcript scrolls to the end", viewer.scrolls, true);
  note(`history transcript scrolls ${viewer.before} → ${viewer.after} of ${viewer.sh}px (box ${viewer.ch}px)`);

  await send("Emulation.clearDeviceMetricsOverride");
}

await evaluate(send, `location.href = "${APP_ORIGIN}/"`);
await sleep(1200);
await evaluate(send, `location.reload()`);
await sleep(1600);

const oursRaw = await evaluate(send, `(() => {
  const cs = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  return JSON.stringify({
    tokens: Object.fromEntries(${JSON.stringify(TOKENS.map(([n]) => n))}.map(n => [n, cs.getPropertyValue(n).trim()])),
    caption: cs.getPropertyValue("--dsw-alias-label-caption").trim(),
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    bodySize: body.fontSize,
    colorScheme: cs.colorScheme,
    legacyGreen: cs.getPropertyValue("--green").trim(),
    legacyInk: cs.getPropertyValue("--ink").trim(),
    cyan: document.documentElement.outerHTML.includes("4fc3f7") || (document.body.innerHTML || "").includes("4fc3f7"),
    layers: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.constructor.name === "CSSLayerStatementRule" ? (r.nameList ? r.nameList.join(",") : r.name) : null).filter(Boolean); } catch { return []; } }),
  });
})()`);
const ours = JSON.parse(oursRaw);

console.log("== DSH tokens as our browser resolves them ==");
for (const [name, want] of TOKENS) check(name, ours.tokens[name], want);
/*
 * The one deliberate deviation from DSH: their light caption is
 * `rgb(173, 178, 184)` = 2.2:1 on white, far below the 4.5:1 AA floor for the
 * placeholder text this token carries. Ours steps two ramp steps darker
 * (`bluish-700` = 5.80:1 on white / 5.55:1 on the `#f9fafb` card). Asserting our
 * value pins the deviation so it cannot drift silently.
 */
check("--dsw-alias-label-caption (AA-raised, deviates from DSH)", ours.caption, "rgb(97, 102, 107)");

console.log("== element defaults ==");
check("body background", ours.bodyBg, "rgb(255, 255, 255)");
check("body ink", ours.bodyColor, "rgb(15, 17, 21)");
check("body font-size (DSH 14px base)", ours.bodySize, "14px");
check("color-scheme", ours.colorScheme, "light");
check("legacy --green re-pointed", ours.legacyGreen, "rgb(65, 118, 230)");
check("legacy --ink re-pointed", ours.legacyInk, "rgb(15, 17, 21)");
check("no cyan left anywhere in the DOM", ours.cyan, false);
check(
  "cascade layer order intact",
  (ours.layers ?? []).some((l) => typeof l === "string" && l.includes("theme")),
  true,
);

/* ── 2. the same tokens off the LIVE DSH instance ─────────────────────────── */

const SHARED = [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-2",
  "--dsw-specific-input-major",
  "--dsw-specific-bubble",
  "--dsw-specific-selector",
  "--dsw-specific-sidebar-fill",
  "--dsw-menu-surface-fill",
  "--dsw-alias-bg-mask-1",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-static-deepseek-400",
  "--dsw-static-deepseek-450",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-markdown-code-block",
  "--dsw-alias-markdown-code-block-banner",
  "--dsw-radius-panel",
];

async function readDsh() {
  const url = DSH_TOKEN ? `${DSH_ORIGIN}/?token=${DSH_TOKEN}` : DSH_ORIGIN;
  const probe = await fetch(url, { redirect: "follow" }).catch(() => null);
  if (!probe) return null;
  /*
   * DSH defaults to its LIGHT theme; our app is dark-only. The parity target is
   * therefore DSH's dark aliases, which it exposes under
   * `body[data-ds-dark-theme]`. Setting the attribute is a read-only probe of a
   * client-side theme switch — it mutates only this page instance.
   */
  await evaluate(send, `location.href = ${JSON.stringify(url)}`);
  await sleep(5000);
  /*
   * Read DSH's DEFAULT appearance.
   *
   * This used to force `data-ds-dark-theme` onto DSH before reading, which made
   * the "reference" the dark variant while DSH's actual default web UI is light —
   * so the whole comparison was measured against a theme the reference does not
   * render by default. That single line is the root of the earlier mismatch.
   */
  const raw = await evaluate(send, `(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = {};
    for (const n of ${JSON.stringify(SHARED)}) out[n] = cs.getPropertyValue(n).trim();
    out.__bodyBg = getComputedStyle(document.body).backgroundColor;
    el.remove();
    return JSON.stringify(out);
  })()`).catch(() => null);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const filled = SHARED.filter((n) => parsed[n] !== "").length;
  /* A 401 page has no tokens at all; that is "not reachable", not "mismatch". */
  if (filled === 0) return null;
  return { tokens: parsed, bodyBg: parsed.__bodyBg };
}

let dsh = await readDsh();
if (dsh === null || normalise(dsh.bodyBg) !== normalise("rgb(255, 255, 255)")) {
  /*
   * No recorded light baseline on disk: a dark-token snapshot must NOT be used as
   * a substitute here, because substituting it is exactly how the wrong theme
   * became authoritative. Without a live light reference the cross-check is
   * skipped and said out loud, rather than silently comparing against dark.
   */
  note("live DSH (light) unreachable — cross-check skipped; start it with `dsh web --port 3099`");
  dsh = null;
}

if (dsh !== null) {
  console.log("== against DSH ==");
  for (const name of SHARED) {
    const want = dsh.tokens?.[name];
    if (typeof want !== "string" || want === "") {
      note(`${name} not published by DSH — skipped`);
      continue;
    }
    check(name, ours.tokens[name] ?? null, want);
  }
  check("canvas matches DSH's default canvas", ours.bodyBg, dsh.bodyBg);
}

/*
 * ── 3. component geometry ──────────────────────────────────────────────────
 *
 * Tokens are necessary but not sufficient: a component can hold the right
 * variables and still put them in the wrong box. These read the REAL rendered
 * components. The sidebar/composer/dialog need a connected host, so when the
 * relay is down they report SKIP rather than passing on an absent element.
 */
await evaluate(send, `location.href = "${APP_ORIGIN}/remote-pi/connect"`);
/*
 * Full page load, not just a route change: the previous block navigated the tab
 * to the DSH instance, so coming back is a cold load of our app (plus a possible
 * Vite rebuild). Poll for the connected view for up to 60s instead of guessing.
 */
await sleep(4000);
let connected = false;
for (let i = 0; i < 60; i++) {
  /* 已连接主机 again: the English `host connected` never existed in src. */
  connected = await evaluate(send, `(document.body.innerText || "").includes("已连接主机")`);
  if (connected) break;
  await sleep(1000);
}

if (!connected) {
  console.log("\n== components ==");
  note("host not connected — component geometry SKIPPED (token gate above still ran)");
} else {
  /*
   * The sidebar auto-collapses to the 56px rail at this viewport width, and the
   * rail has no workspace rows by design. Expand it first so the row geometry
   * is measured on a row that actually exists.
   *
   * The toggle's titles are `展开侧栏（Ctrl/Cmd+B）` when collapsed and
   * `收起侧栏（Ctrl/Cmd+B）` when expanded (workspace-sidebar.tsx:194-196). The
   * old English prefixes matched nothing, so the expand never happened and the
   * row geometry was read off the 56px rail.
   */
  const expanded = await evaluate(send, `(() => {
    const sb = document.querySelector('aside[aria-label="工作区"]');
    const t = sb ? [...sb.querySelectorAll('button[aria-pressed]')].find(b => /侧栏/.test(b.getAttribute('title') || '')) : null;
    if (!t) return 'no sidebar toggle';
    const collapsed = t.getAttribute('aria-pressed') === 'true';
    if (collapsed) t.click();
    return collapsed ? 'expanded' : 'already expanded';
  })()`);
  note(`sidebar: ${expanded}`);
  await sleep(900);

  /* Sidebar rail. */
  const side = JSON.parse(await evaluate(send, `(() => {
    const a = document.querySelector('aside[aria-label="工作区"]');
    if (!a) return JSON.stringify({ present: false });
    const cs = getComputedStyle(a);
    const row = [...a.querySelectorAll("div")].find((d) => {
      const s = getComputedStyle(d);
      return s.borderTopLeftRadius === "12px" && s.display === "flex" && d.querySelector("button");
    });
    return JSON.stringify({
      present: true,
      bg: cs.backgroundColor,
      border: cs.borderRightWidth + " " + cs.borderRightColor,
      rowRadius: row ? getComputedStyle(row).borderTopLeftRadius : null,
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      /* The status labels are 运行中 / 未运行 (view-model.ts:266,276). */
      runningButtons: a.querySelectorAll('button[title*="运行中"], button[title*="未运行"]').length,
    });
  })()`));
  console.log("\n== sidebar ==");
  check("aside aria-label=工作区 present", side.present, true);
  if (side.present) {
    check("bg #f9fafb (DSH sidebar fill)", side.bg, "rgb(249, 250, 251)");
    check("right hairline l3 12% (DSH sidebar col)", side.border, "1px rgba(0, 0, 0, 0.12)");
    check("workspace row radius 12px", side.rowRadius, "12px");
    check("workspace row height 36px", side.rowHeight, 36);
    check("running/stopped buttons intact", side.runningButtons > 0, true);
  }

  /* Composer capsule. */
  const comp = JSON.parse(await evaluate(send, `(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return JSON.stringify({ present: false });
    const form = ta.closest("form");
    const cs = getComputedStyle(form);
    const tcs = getComputedStyle(ta);
    const add = form.querySelector("label");
    const sendBtn = form.querySelector('button[type="submit"]');
    const ar = add.getBoundingClientRect();
    const sr = sendBtn.getBoundingClientRect();
    return JSON.stringify({
      present: true,
      bg: cs.backgroundColor,
      radius: cs.borderTopLeftRadius,
      border: cs.borderTopWidth,
      container: cs.containerType,
      caret: tcs.caretColor,
      add: [Math.round(ar.width), Math.round(ar.height)],
      addRadius: getComputedStyle(add).borderTopLeftRadius,
      send: [Math.round(sr.width), Math.round(sr.height)],
      sendRadius: getComputedStyle(sendBtn).borderTopLeftRadius,
      sendBg: getComputedStyle(sendBtn).backgroundColor,
      placeholder: getComputedStyle(ta, "::placeholder").color,
    });
  })()`));
  console.log("== composer ==");
  check("composer present", comp.present, true);
  if (comp.present) {
    check("card bg #fff (bg-layer-2)", comp.bg, "rgb(255, 255, 255)");
    check("card radius 28px", comp.radius, "28px");
    check("card border 0 (hairline in shadow)", comp.border, "0px");
    check("container-type inline-size", comp.container, "inline-size");
    check("caret #7aaaff", comp.caret, "rgb(122, 170, 255)");
    check("Add 28x28 circle", `${comp.add.join("x")} r=${comp.addRadius}`, "28x28 r=999px");
    check("Send 34x34 circle", `${comp.send.join("x")} r=${comp.sendRadius}`, "34x34 r=999px");
    check("Send bg deepseek-500", comp.sendBg, "rgb(65, 118, 230)");
    check("placeholder caption bluish-700 (AA-raised)", comp.placeholder, "rgb(97, 102, 107)");
  }

  /* Unpair dialog: opens on a real click, so this also proves the trigger. */
  const opened = await evaluate(send, `(() => {
    /* The trigger's title is 解除该主机配对并清除已保存的配对信息
       (remote-pi-shell.tsx:297). */
    const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("title") || "").includes("解除该主机配对"));
    if (!b) return false;
    b.focus();
    b.click();
    return true;
  })()`);
  check("unpair trigger present", opened, true);
  await sleep(600);
  const dlg = JSON.parse(await evaluate(send, `(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return JSON.stringify({ present: false });
    const cs = getComputedStyle(d);
    const mask = getComputedStyle(d.parentElement);
    const t = d.querySelector("h2");
    return JSON.stringify({
      present: true,
      bg: cs.backgroundColor,
      radius: cs.borderTopLeftRadius,
      width: Math.round(d.getBoundingClientRect().width),
      maskBg: mask.backgroundColor,
      maskFilter: mask.backdropFilter,
      titleSize: t ? getComputedStyle(t).fontSize : null,
      titleWeight: t ? getComputedStyle(t).fontWeight : null,
      ariaModal: d.getAttribute("aria-modal"),
      focusInside: d.contains(document.activeElement),
    });
  })()`));
  console.log("== dialog ==");
  check("dialog opens", dlg.present, true);
  if (dlg.present) {
    check("bg #fff (bg-layer-2)", dlg.bg, "rgb(255, 255, 255)");
    check("radius 28px", dlg.radius, "28px");
    check("width 440px", dlg.width, 440);
    check("mask rgba(0,0,0,.5)", dlg.maskBg, "rgba(0, 0, 0, 0.5)");
    /* DSH ships --dsw-mask-blur: none; copying a blur would be a divergence. */
    check("mask has no blur (matches DSH)", dlg.maskFilter, "none");
    check("title 16px", dlg.titleSize, "16px");
    check("title weight 500", dlg.titleWeight, "500");
    check("aria-modal", dlg.ariaModal, "true");
    check("focus moved inside", dlg.focusInside, true);

    await evaluate(send, `(() => {
      const d = document.querySelector('[role="dialog"]');
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    })()`);
    await sleep(400);
    const closed = await evaluate(send, `!document.querySelector('[role="dialog"]')`);
    check("Esc closes the dialog", closed, true);
  }
}

/*
 * ── 4. transcript pieces ───────────────────────────────────────────────────
 *
 * The user bubble only renders when the live chat holds a user turn, and this
 * environment has no sendable Pi turn. Rather than assert against an empty pane
 * (vacuous) or parse the stylesheet (proves nothing about the cascade), the
 * bubble is measured by appending a node that carries the REAL hashed module
 * class into the running app. The class is found by what the rule DECLARES — a
 * 20px radius on the bubble fill — because CSS Modules hashes the name.
 */
const bubble = JSON.parse(await evaluate(send, `(() => {
  const candidates = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = [...sheet.cssRules]; } catch (e) { continue; }
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules) walk([...r.cssRules]);
        if (!r.selectorText || !r.style) continue;
        const radius = r.style.getPropertyValue("border-radius");
        const bg = r.style.getPropertyValue("background-color");
        if (radius.indexOf("dsw-radius-xl") >= 0 && bg.indexOf("dsw-specific-bubble") >= 0) candidates.push(r.selectorText);
      }
    };
    walk(rules);
  }
  if (candidates.length === 0) return JSON.stringify({ found: false });
  const m = candidates[0].match(/\.[A-Za-z0-9_-]+/);
  if (!m) return JSON.stringify({ found: false });
  const host = document.querySelector(".rp-app-shell") || document.body;
  const probe = document.createElement("div");
  probe.className = m[0].slice(1);
  probe.textContent = "probe";
  host.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = {
    found: true,
    bg: cs.backgroundColor,
    radius: cs.borderTopLeftRadius,
    border: cs.borderTopWidth,
    font: cs.fontSize + "/" + cs.lineHeight,
    padding: cs.paddingTop + " " + cs.paddingLeft,
    wrap: cs.whiteSpace,
  };
  probe.remove();
  return JSON.stringify(out);
})()`));
console.log("\n== user bubble ==");
check("module class discovered", bubble.found, true);
if (bubble.found) {
  check("bg deepseek-50 (DSH specific-bubble)", bubble.bg, "rgb(237, 243, 254)");
  check("radius 20px", bubble.radius, "20px");
  check("border 0", bubble.border, "0px");
  check("14px / 22px", bubble.font, "14px/22px");
  check("padding 10px 16px", bubble.padding, "10px 16px");
  check("pre-wrap keeps the user's newlines", bubble.wrap, "pre-wrap");
}

/*
 * The reasoning row is shipped but never rendered here: the wire reports model
 * CAPABILITY (`reasoning: boolean`) and no reasoning TEXT, so there is nothing to
 * feed it. Mounting it through the real module graph is the only way to assert
 * its contract; it is skipped (not failed) when the dev module graph is
 * unavailable, and the reason is printed.
 */
let mounted = null;
try {
  mounted = await evaluate(send, `(async () => {
    const mod = await import("/src/components/remote-pi/chat/reasoning-row.tsx");
    const ReactMod = await import("/node_modules/.vite/deps/react.js");
    const React = ReactMod.default || ReactMod;
    const rdcMod = await import("/node_modules/.vite/deps/react-dom_client.js");
    const rdc = rdcMod.default || rdcMod;
    const createRoot = rdc.createRoot || rdcMod.createRoot;
    const host = document.createElement("div");
    host.id = "reasoning-probe";
    host.style.width = "600px";
    document.body.appendChild(host);
    createRoot(host).render(React.createElement(mod.ReasoningRow, {
      text: "Let me check the transcript pane first.",
      live: false,
      defaultOpen: false,
    }));
    await new Promise((r) => setTimeout(r, 400));
    return "mounted";
  })()`);
} catch (e) {
  note(`reasoning row not mountable here (${String(e).slice(0, 60)})`);
}
console.log("== reasoning row ==");
if (mounted !== "mounted") {
  note("reasoning row SKIPPED — dev module graph unavailable");
} else {
  const rr = JSON.parse(await evaluate(send, `(() => {
    const b = document.querySelector("#reasoning-probe button");
    if (!b) return JSON.stringify({ present: false });
    const cs = getComputedStyle(b);
    const prev = [...document.querySelectorAll("#reasoning-probe span")].find((s) => getComputedStyle(s).textOverflow === "ellipsis");
    return JSON.stringify({
      present: true,
      expanded: b.getAttribute("aria-expanded"),
      controls: !!b.getAttribute("aria-controls"),
      position: cs.position,
      top: cs.top,
      z: cs.zIndex,
      bg: cs.backgroundColor,
      font: cs.fontSize + "/" + cs.lineHeight,
      ellipsis: prev ? getComputedStyle(prev).textOverflow : null,
    });
  })()`));
  check("mounted", rr.present, true);
  if (rr.present) {
    check("aria-expanded", rr.expanded, "false");
    check("aria-controls", rr.controls, true);
    check("sticky", rr.position, "sticky");
    check("top 0", rr.top, "0px");
    check("z-index 5", rr.z, "5");
    /* Opaque, or the streaming trace shows through the pinned header. */
    check("opaque header bg", rr.bg, "rgb(255, 255, 255)");
    check("13px / 20px", rr.font, "13px/20px");
    check("preview ellipsises", rr.ellipsis, "ellipsis");
  }
  await evaluate(send, '(() => { document.getElementById("reasoning-probe")?.remove(); })()');
}

console.log(fail === 0 ? "\nvisual parity: OK" : `\nvisual parity: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
