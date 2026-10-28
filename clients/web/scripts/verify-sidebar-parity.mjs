/**
 * Sidebar parity gate — side-by-side against the REAL running DSH web.
 *
 * Why this exists: the previous "visual parity" suite asserted computed CSS
 * values only (this element is #2c2c2e, radius 20px, 14px). A hundred such
 * assertions can all pass while the interface looks nothing like the reference,
 * because the THEME and the INFORMATION ARCHITECTURE were never compared. That
 * is exactly what happened: the whole UI was built on a dark palette while DSH's
 * default web UI is light.
 *
 * So this gate asserts the things that were actually wrong:
 *   1. THEME      — body background/foreground/color-scheme/font stack.
 *   2. GEOMETRY   — sidebar width, background, right border, inner padding.
 *   3. IA ORDER   — the sidebar's blocks in document order, not just counts.
 *   4. ABSENCES   — developer notes and harness test workspaces must NOT be in
 *                   the product UI.
 *
 * It also writes side-by-side screenshots at one viewport so the comparison can
 * be checked by eye, which is the check that was missing.
 *
 * Requirements: DSH must be running:
 *   cd deepseek-harness/apps/cli && node lib/bin.js web --port 3099
 * and print `dsh web: http://127.0.0.1:3099/?token=...` — pass that URL as
 * DSH_URL (the token mints the cookie; afterwards the clean origin works too).
 *
 * Run: node scripts/verify-sidebar-parity.mjs
 */
import { evaluate, shot, sleep, APP_ORIGIN, EVIDENCE } from "./_cdp.mjs";

const VIEWPORT = { width: 1600, height: 945 };
const DSH_URL = process.env.DSH_URL ?? "http://127.0.0.1:3099/";

let failures = 0;
const fail = (msg, detail) => {
  failures += 1;
  console.log(`FAIL ${msg}${detail === undefined ? "" : `: ${detail}`}`);
};
const ok = (msg, detail) => console.log(`ok   ${msg}${detail === undefined ? "" : `: ${detail}`}`);
const check = (msg, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) ok(msg, JSON.stringify(actual));
  else fail(msg, `want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* ── shared probes ───────────────────────────────────────────────────────── */

/** Theme as the browser actually resolves it. */
const THEME_EXPR = `(() => {
  const b = getComputedStyle(document.body);
  const probe = document.createElement("div");
  probe.style.color = "var(--dsw-alias-label-primary, var(--ink, inherit))";
  document.body.appendChild(probe);
  const primary = getComputedStyle(probe).color;
  probe.remove();
  return JSON.stringify({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    bodyBg: b.backgroundColor,
    bodyColor: b.color,
    font: b.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
    primary,
  });
})()`;

/**
 * Sidebar geometry, located WITHOUT relying on any class name.
 *
 * DSH uses hashed CSS-module classes and we use different ones entirely, so the
 * only thing both sides share is "the full-height column at the left edge that
 * is narrower than a third of the viewport".
 */
const SIDEBAR_EXPR = `(() => {
  const all = [...document.querySelectorAll("*")];
  const cands = all.filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.height < window.innerHeight * 0.9) return false;
    if (r.x > 4) return false;
    if (r.width < 180 || r.width > window.innerWidth / 3) return false;
    // innermost match wins, so nested wrappers do not shadow the real column
    return ![...e.children].some((c) => {
      const cr = c.getBoundingClientRect();
      return cr.height >= window.innerHeight * 0.9 && cr.x <= 4 && cr.width > 180;
    });
  });
  const el = cands[0];
  if (!el) return "null";
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  /*
   * Inner padding lives on the first IN-FLOW box inside the column.
   *
   * The column's direct child can be a display:contents wrapper (0x0 box), which
   * has no padding of its own — descending is required or the reference yields
   * null and the assertion compares nothing.
   */
  const firstBox = (node) => {
    for (const c of node.children) {
      if (getComputedStyle(c).display === "contents") {
        const deep = firstBox(c);
        if (deep) return deep;
        continue;
      }
      if (c.getBoundingClientRect().width > 100) return c;
    }
    return null;
  };
  const inner = firstBox(el);
  const ics = inner ? getComputedStyle(inner) : null;
  return JSON.stringify({
    width: Math.round(r.width),
    bg: cs.backgroundColor,
    borderRightWidth: cs.borderRightWidth,
    borderRightColor: cs.borderRightColor,
    innerPadding: ics ? ics.padding : null,
  });
})()`;

/**
 * The sidebar's top-level blocks in document order, as a coarse label each.
 *
 * Labels are derived from TEXT, not classes, so the same probe is meaningful on
 * both codebases. Unknown blocks are skipped: the assertion is about the relative
 * order of the parts we can name, not about internal wrappers.
 */
const IA_EXPR = `(() => {
  const col = document.querySelector("[class*=sidebarCol]") || (() => {
    const all = [...document.querySelectorAll("*")];
    const cands = all.filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.height < window.innerHeight * 0.9) return false;
      if (r.x > 4) return false;
      if (r.width < 180 || r.width > window.innerWidth / 3) return false;
      return ![...e.children].some((c) => {
        const cr = c.getBoundingClientRect();
        return cr.height >= window.innerHeight * 0.9 && cr.x <= 4 && cr.width > 180;
      });
    });
    return cands[0];
  })();
  if (!col) return "null";
  /*
   * DOM ORDER, not layout order.
   *
   * The sidebar stacks its sections vertically, so document order IS visual
   * order. Using getBoundingClientRect() here was the earlier bug: the column's
   * direct child is a display:contents wrapper with a 0x0 box, so every block
   * looked "unrendered" and the reference produced an empty list — which made
   * the order assertions compare against nothing.
   */
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      const t = (c.textContent || "").replace(/\\s+/g, " ").trim();
      /*
       * Keep only LEAF-ish text nodes.
       *
       * Aggregate wrappers carry the concatenation of every section, so they
       * match every landmark at the same index and make order assertions
       * vacuously true ("workspaces 14 >= session list 14"). A landmark is a
       * short label, so anything long, or any element whose children also carry
       * text, is a container rather than a landmark.
       */
      const hasTextChildren = [...c.children].some((g) => (g.textContent || "").trim());
      if (t && t.length <= 40 && !hasTextChildren && out[out.length - 1] !== t) out.push(t);
      walk(c);
    }
  };
  walk(col);
  return JSON.stringify(out.slice(0, 40));
})()`;

/**
 * Visible text only, with style/script stripped.
 *
 * `sr-only` nodes are excluded on purpose: they are the accessible descriptions
 * this client uses to explain a disabled control to screen readers, and they
 * legitimately mention wire names (`pi_surface`, `host_pairing`). Counting them
 * as "visible" would force us to delete accurate accessibility text just to
 * satisfy the gate. What must not appear is developer prose a SIGHTED user sees.
 */
const VISIBLE_TEXT_EXPR = `(() => {
  const c = document.body.cloneNode(true);
  for (const e of c.querySelectorAll("style,script,noscript,.sr-only")) e.remove();
  return (c.innerText || "").replace(/\\s+/g, " ");
})()`;

/* ── drive the browser ───────────────────────────────────────────────────── */

/*
 * Own ONE tab for the whole run, addressed by its target id.
 *
 * `attach()` picks a page by matching OUR origin, which is unusable here: this
 * gate deliberately navigates the same tab to the DSH origin, so after the run
 * (or on a re-run) no app tab exists and `attach()` throws before any assertion
 * can run. Creating the target up front and connecting to that exact id makes
 * the gate idempotent and keeps both measurements on the same connection.
 */
const CDP = Number(process.env.CDP_PORT ?? 9333);

async function openOwnTab(url) {
  const created = await (
    await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = msg.id && pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, targetId: created.id };
}

const { send } = await openOwnTab("about:blank");
await send("Page.enable");

const goto = async (url) => {
  // Page.navigate is reliable from about:blank and follows 303s, which a
  // document-supplied location.href does not guarantee.
  await send("Page.navigate", { url }).catch(() => {});
  await sleep(3000);
};

/* ── 1. DSH reference ────────────────────────────────────────────────────── */
/*
 * The `?token=` URL answers 303 and mints a cookie, so the useful document only
exists AFTER the redirect settles. Polling for content (rather than sleeping a
 * fixed amount) is what makes the difference between "the reference is
 * unreachable" and "the redirect had not landed yet".
 */
const dshHasToken = /[?&]token=/.test(DSH_URL);
await goto(DSH_URL);
let dshBody = "";
for (let i = 0; i < 60; i++) {
  dshBody = await evaluate(send, VISIBLE_TEXT_EXPR).catch(() => "");
  /*
   * Keep waiting while the page is still 401 but a token was supplied: the 303
   * that mints the cookie has to land and be followed first, and on a cold tab
   * that takes seconds. Giving up after a couple of polls was the bug — it
   * reported "instance restarted" for an instance that was perfectly alive.
   */
  if (/authentication required/i.test(dshBody) && dshHasToken) {
    await sleep(1000);
    continue;
  }
  if (dshBody.length > 30) break;
  await sleep(1000);
}
await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
/*
 * Wait for the SIDEBAR itself, not merely for some text.
 *
 * DSH is a single-page app: its shell paints before the sidebar mounts, so
 * measuring straight after the first non-empty body returned an EMPTY IA list
 * and the order assertions had no reference to compare against.
 */
for (let i = 0; i < 40; i++) {
  const has = await evaluate(
    send,
    '!!document.querySelector("[class*=sidebarCol]") || document.body.innerText.length > 200',
  ).catch(() => false);
  if (has) break;
  await sleep(500);
}
await sleep(2500);

if (/authentication required/i.test(dshBody)) {
  fail(
    "DSH reference reachable",
    dshHasToken
      ? "still 401 with a token — the instance likely restarted and minted a new one"
      : "401 — pass DSH_URL with the ?token= printed by `dsh web`",
  );
  process.exit(1);
}
const dshTheme = JSON.parse(await evaluate(send, THEME_EXPR));
const dshSidebar = JSON.parse(await evaluate(send, SIDEBAR_EXPR));
const dshIaRaw = await evaluate(send, IA_EXPR).catch((e) => `ERR ${e.message}`);
const dshIa = dshIaRaw === "null" ? [] : JSON.parse(dshIaRaw);
if (!Array.isArray(dshIa) || dshIa.length === 0) {
  console.log("  [diag] DSH IA probe returned:", String(dshIaRaw).slice(0, 120));
}
await shot(send, "parity-dsh-reference");

console.log("\n== DSH reference (measured, not hardcoded) ==");
console.log("  theme  :", JSON.stringify(dshTheme));
console.log("  sidebar:", JSON.stringify(dshSidebar));
console.log("  ia     :", JSON.stringify(dshIa).slice(0, 300));

/* ── 2. our client ───────────────────────────────────────────────────────── */
await goto(`${APP_ORIGIN}/remote-pi/connect`);
for (let i = 0; i < 60; i++) {
  if (await evaluate(send, '(document.body.innerText||"").includes("host connected")').catch(() => false)) break;
  await sleep(1000);
}
await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
await sleep(2000);
// The sidebar ships collapsed as a rail on narrow frames; expand it so the
// comparison is like-for-like.
await evaluate(send, `(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /Expand the sidebar|Toggle the sidebar/i.test(x.getAttribute("title") || ""));
  if (b) { b.click(); return "expanded"; }
  return "already-wide";
})()`);
await sleep(1200);

const ourTheme = JSON.parse(await evaluate(send, THEME_EXPR));
const ourSidebar = JSON.parse(await evaluate(send, SIDEBAR_EXPR));
const ourIa = JSON.parse(await evaluate(send, IA_EXPR));
const ourText = await evaluate(send, VISIBLE_TEXT_EXPR).catch(() => "");
await shot(send, "parity-ours");

console.log("\n== our client (measured) ==");
console.log("  theme  :", JSON.stringify(ourTheme));
console.log("  sidebar:", JSON.stringify(ourSidebar));
console.log("  ia     :", JSON.stringify(ourIa).slice(0, 300));

/* ── 3. THEME ────────────────────────────────────────────────────────────── */
console.log("\n== theme ==");
check("color-scheme matches DSH", ourTheme.scheme, dshTheme.scheme);
check("body background matches DSH", ourTheme.bodyBg, dshTheme.bodyBg);
check("body foreground matches DSH", ourTheme.bodyColor, dshTheme.bodyColor);
check("primary label colour matches DSH", ourTheme.primary, dshTheme.primary);
check("font stack starts with the same family", ourTheme.font, dshTheme.font);

/* ── 4. SIDEBAR GEOMETRY ─────────────────────────────────────────────────── */
console.log("\n== sidebar geometry ==");
check("sidebar width matches DSH", ourSidebar.width, dshSidebar.width);
check("sidebar background matches DSH", ourSidebar.bg, dshSidebar.bg);
check("sidebar right border width matches DSH", ourSidebar.borderRightWidth, dshSidebar.borderRightWidth);
check("sidebar right border colour matches DSH", ourSidebar.borderRightColor, dshSidebar.borderRightColor);
check("sidebar inner padding matches DSH", ourSidebar.innerPadding, dshSidebar.innerPadding);

/* ── 5. INFORMATION ARCHITECTURE ─────────────────────────────────────────── */
console.log("\n== information architecture ==");
/*
 * Landmarks, in the order DSH renders them:
 *   brand -> new session -> plugins/automations -> workspaces -> session list -> more
 *
 * Each landmark is matched by a text pattern rather than a class, because the two
 * codebases share no class names. The assertion is deliberately about ORDER and
 * PRESENCE, not exact content: extra rows inside a section are fine, a section in
 * the wrong place (or missing) is the defect this gate exists to catch.
 */
const LANDMARKS = [
  ["brand", /DSH|Remote Pi/i],
  ["new session", /新会话|New session/i],
  ["plugins/automations", /插件|自动化任务|Plugins?|Automations?/i],
  ["workspaces", /工作区|WORKSPACES/i],
  ["session list", /LIVE|running|分钟|小时|分钟前|hours? ago|日|days? ago/i],
  ["more", /更多|More/i],
];

const landmarkPositions = (flat, { skipBrand = false } = {}) =>
  LANDMARKS
    // `brand` is a product name, so it is only comparable within one codebase.
    // Ordering is still checked from "new session" onwards on both sides.
    .map(([name, re], i) => ({ name, idx: flat.findIndex((line) => re.test(line)), required: !(skipBrand && i === 0) }))
    .filter((m) => m.required);

const dshFlat = Array.isArray(dshIa) ? dshIa : [];
const ourFlat = Array.isArray(ourIa) ? ourIa : [];

/* The reference must be self-consistent, or there is nothing to align to. */
const dshMarks = landmarkPositions(dshFlat, { skipBrand: true });
for (const m of dshMarks) {
  if (m.idx === -1) fail(`DSH reference lacks the "${m.name}" landmark`, JSON.stringify(dshFlat).slice(0, 160));
}
const dshFound = dshMarks.filter((m) => m.idx !== -1);
for (let i = 1; i < dshFound.length; i += 1) {
  const a = dshFound[i - 1];
  const b = dshFound[i];
  if (a.idx < b.idx) ok(`DSH order: ${a.name} (${a.idx}) before ${b.name} (${b.idx})`);
  else fail(`DSH order: ${a.name} must precede ${b.name}`, `${a.idx} >= ${b.idx}`);
}

/*
 * Now the same landmarks in our sidebar. A landmark DSH has but we do not is a
 * real information-architecture gap (that is how "plugins" and "automations"
 * were found missing), so a miss here is a failure, not a skipped assertion.
 */
const ourMarks = landmarkPositions(ourFlat, { skipBrand: true });
for (const m of ourMarks) {
  if (m.idx === -1) fail(`our sidebar lacks the "${m.name}" landmark`, JSON.stringify(ourFlat).slice(0, 160));
}
const ourFound = ourMarks.filter((m) => m.idx !== -1);
for (let i = 1; i < ourFound.length; i += 1) {
  const a = ourFound[i - 1];
  const b = ourFound[i];
  if (a.idx < b.idx) ok(`our order: ${a.name} (${a.idx}) before ${b.name} (${b.idx})`);
  else fail(`our order: ${a.name} must precede ${b.name}`, `${a.idx} >= ${b.idx}`);
}

/* ── 6. ABSENCES (the part that was flat-out wrong) ──────────────────────── */
console.log("\n== non-product content must be absent ==");
const FORBIDDEN = [
  ["developer note about the slash menu", /composer lists the workspace Pi's installed skills/i],
  ["harness test workspaces", /rp-live-ws-/],
  ["raw wire identifiers in the UI", /pi_surface_ok|skill_invoke|host_pairing/],
];
for (const [label, re] of FORBIDDEN) {
  if (re.test(ourText)) {
    const at = ourText.search(re);
    const ctx = ourText.slice(Math.max(0, at - 80), at + 80);
    fail(`absent: ${label}`, `found in the rendered page near: "${ctx}"`);
  } else ok(`absent: ${label}`);
}
// Sanity: the same probe must be ABLE to see text, or the absence proves nothing.
if (ourText.length < 40) fail("absence probe is meaningful", `page text too short (${ourText.length})`);

/* ── 7. Side-by-side artefact ────────────────────────────────────────────── */
console.log("\n== screenshots ==");
console.log(`  DSH : ${EVIDENCE}\\parity-dsh-reference.png`);
console.log(`  ours: ${EVIDENCE}\\parity-ours.png`);

console.log(
  failures === 0
    ? "\nsidebar parity: OK"
    : `\nsidebar parity: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
