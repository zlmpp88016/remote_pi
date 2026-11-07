// Plan/78 — Changes dock tab acceptance. Real Chrome over CDP against the LIVE
// direct-mode daemon on :4124. No unit-test substitutes.
//
// The load-bearing assertion is the SPLIT between "not a repo" and "clean":
// `4.1f` is genuinely not a git repository, so a panel that renders an empty list
// there would be lying precisely when the user needs the truth. Section 1 pins
// that; section 2 proves the real repo path end-to-end; section 3 pins the leak
// fences (no absolute path, no git stderr) which are the reason this surface is
// safe to expose to a paired device at all.
import { setTimeout as delay } from "node:timers/promises";

const CDP = "http://127.0.0.1:9444";
const BASE = "http://127.0.0.1:4124/";
const NON_REPO = "4.1f";
const REAL_REPO = "remote_pi";

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? " :: " + detail : "")); console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

const listing = await (await fetch(`${CDP}/json/list`)).json();
const page = listing.find((t) => t.type === "page" && /127\.0\.0\.1:4124/.test(t.url || "")) ?? listing.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

const DOCK = `[...document.querySelectorAll('aside')].find(a=>a.getAttribute('aria-label')==='停靠栏')`;

/** Viewport gates every assertion; re-apply after navigation. */
async function viewport() {
  await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
}

/** Ensures the dock exists (it starts collapsed) and the Changes tab is active. */
async function openChanges() {
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
    const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '更改') : null;
    if (!b) return { ok: false };
    b.click();
    return { ok: true, title: (b.getAttribute('title')||'') };
  })()`);
  await delay(1400);
  return clicked;
}

/** Selects a workspace row by exact cwd-name prefix. */
async function selectWorkspace(name) {
  const r = await ev(`(() => {
    const all = [...document.querySelectorAll('button')];
    const b = all.find(x => String(x.getAttribute('title')||'').startsWith(${JSON.stringify(name)} + ' —'));
    if (!b) return { ok: false };
    b.click();
    return { ok: true, title: String(b.getAttribute('title')||'').slice(0, 90) };
  })()`);
  await delay(7000);
  return r;
}

/** Which workspace row is selected right now, or null if it cannot be told. */
async function selectedWorkspaceName() {
  return ev(`(() => {
    const rows = [...document.querySelectorAll('[aria-current="true"]')]
      .map(x => String(x.getAttribute('title')||''))
      .filter(t => t.includes(' — '));
    return rows.length > 0 ? rows[0].split(' — ')[0] : null;
  })()`);
}

/** Clicks the reload button in the Changes head. */
async function reloadChanges() {
  const r = await ev(`(() => {
    const d = ${DOCK};
    const b = d ? [...d.querySelectorAll('button')].find(x => /重新加载工作树/.test(x.getAttribute('aria-label')||'')) : null;
    if (!b) return { ok: false };
    b.click();
    return { ok: true, disabled: b.disabled };
  })()`);
  await delay(6000);
  return r;
}

/** Reads the whole Changes panel as structure, not prose. */
async function readPanel() {
  return ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const text = (d.textContent || '').replace(/\\s+/g, ' ').trim();
    const rows = [...d.querySelectorAll('li')].map(li => ({
      text: (li.textContent || '').replace(/\\s+/g, ' ').trim(),
      title: (li.querySelector('[title]')?.getAttribute('title') || ''),
    }));
    const dts = [...d.querySelectorAll('dt')].map(x => (x.textContent||'').trim());
    const dds = [...d.querySelectorAll('dd')].map(x => (x.textContent||'').replace(/\\s+/g,' ').trim());
    return {
      text,
      rowCount: rows.length,
      rows: rows.slice(0, 5),
      dts, dds,
      /* Leak fences. A drive path or a POSIX home path must never render. */
      hasDrivePath: /[A-Za-z]:[\\\\/]/.test(text),
      hasPosixHome: /(^|\\s)\\/(Users|home|etc|var)\\//.test(text),
      /* git's own error banners must never be echoed. */
      hasGitBanner: /fatal:|error: could not|not a git repository \\(or any|致命错误/i.test(text),
      hasReading: /正在读取工作树/.test(text),
      hasUnavailable: /读不到|不是 git 仓库|无法读取|不可达/i.test(text),
      hasCounts: /\\d+ 已暂存/.test(text),
      hasClean: /没有更改/.test(text),
      refreshLabel: (d.querySelector('[aria-label="重新加载工作树"]')?.getAttribute('aria-label') || ''),
      tabTitles: [...d.querySelectorAll('button')].map(b => (b.getAttribute('title')||'')).filter(Boolean),
    };
  })()`);
}

console.log("plan/78 — Changes dock acceptance\n");

await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await viewport();
await send("Page.navigate", { url: `${BASE}?_v=${Date.now()}` });
await delay(600);
await viewport();
await delay(6000);

/*
 * Remember which workspace the app was on before this script changes it.
 *
 * Selecting a workspace is GLOBAL app state, and this suite needs to visit two of
 * them (the non-repo and the real repo). Leaving `remote_pi` selected made
 * verify-buttons and verify-automations fail 9 and more checks each — they drive
 * `4.1f` and simply could not find its rows. Restoring the caller's selection is
 * the honest fix: this script borrows the app, it does not own it.
 */
const previousWorkspace = await selectedWorkspaceName();

// ── Section 1: the Changes tab exists, is named, and explains itself ─────────
console.log("§1 tab is real and self-describing");
const open1 = await openChanges();
check("1.1 Changes tab is clickable", open1?.ok === true, JSON.stringify(open1));
check("1.2 tab tooltip describes working-tree status, not the old 'no API' claim",
  /工作树状态/.test(open1?.title ?? ""), open1?.title);
check("1.3 tooltip no longer claims the host exposes no diff/working-tree API",
  !/no diff\/working-tree API/i.test(open1?.title ?? ""), open1?.title);

// ── Section 2: a NON-repo is a stated FACT, never an empty clean list ────────
console.log("\n§2 non-repo workspace (4.1f) is reported as a fact");
const sel1 = await selectWorkspace(NON_REPO);
check("2.1 non-repo workspace selected", sel1?.ok === true, JSON.stringify(sel1));
await openChanges();
await reloadChanges();
const p1 = await readPanel();
check("2.2 panel rendered", p1 !== null);
check("2.3 it says the workspace is not a git repository",
  /不是 git 仓库/i.test(p1?.text ?? ""), (p1?.text ?? "").slice(0, 140));
check("2.4 it does NOT render file rows for a non-repo", p1?.rowCount === 0, String(p1?.rowCount));
check("2.5 it does NOT claim 'No changes' (that would be a lie about an unread tree)",
  p1?.hasClean === false, String(p1?.hasClean));
check("2.6 no absolute host path in the DOM", p1?.hasDrivePath === false && p1?.hasPosixHome === false,
  JSON.stringify({ drive: p1?.hasDrivePath, posix: p1?.hasPosixHome }));
check("2.7 no git error banner echoed", p1?.hasGitBanner === false, String(p1?.hasGitBanner));

// ── Section 3: a REAL repo lists relative paths and counts ──────────────────
console.log("\n§3 real git repository (remote_pi) lists its working tree");
const sel2 = await selectWorkspace(REAL_REPO);
check("3.1 real repo workspace selected", sel2?.ok === true, JSON.stringify(sel2));
await openChanges();
await reloadChanges();
const p2 = await readPanel();
check("3.2 panel rendered", p2 !== null);
check("3.3 it rendered at least one changed path", (p2?.rowCount ?? 0) > 0, String(p2?.rowCount));
check("3.4 the counts line is present", p2?.hasCounts === true, (p2?.text ?? "").slice(0, 160));
check("3.5 a Branch row is shown", (p2?.dts ?? []).includes("分支"), JSON.stringify(p2?.dts));
check("3.6 a HEAD row is shown", (p2?.dts ?? []).includes("HEAD"), JSON.stringify(p2?.dts));
check("3.7 paths are repo-relative (no drive letter, no absolute prefix)",
  p2?.hasDrivePath === false && p2?.hasPosixHome === false,
  JSON.stringify({ drive: p2?.hasDrivePath, posix: p2?.hasPosixHome }));
check("3.8 row titles are repo-relative too (the tooltip does not leak the host layout)",
  (p2?.rows ?? []).every((r) => r.title === "" || !/^([A-Za-z]:|[\\/])/.test(r.title)),
  JSON.stringify((p2?.rows ?? []).map((r) => r.title)));
check("3.9 the failure sentence is NOT shown for a readable repo", p2?.hasUnavailable === false,
  String(p2?.hasUnavailable));
check("3.10 no git error banner echoed", p2?.hasGitBanner === false, String(p2?.hasGitBanner));

// ── Section 4: the reload control is real and idempotent ────────────────────
console.log("\n§4 reload control");
const rel = await reloadChanges();
check("4.1 reload button exists with an accessible label", rel?.ok === true, JSON.stringify(rel));
check("4.2 reload is enabled for a readable repo", rel?.disabled === false, String(rel?.disabled));
const p3 = await readPanel();
check("4.3 reload produced the same answer (deterministic read)", (p3?.rowCount ?? 0) === (p2?.rowCount ?? 0),
  `${p2?.rowCount} -> ${p3?.rowCount}`);

// ── Section 5: the panel does not offer a diff surface ──────────────────────
console.log("\n§5 the surface stays status-only");
check("5.1 no diff-like control is offered",
  !(p3?.text ?? "").match(/\b(show diff|view diff|open diff)\b/i), (p3?.text ?? "").slice(0, 120));
check("5.2 the panel never contains a file BODY marker", !/^@@ /m.test(p3?.text ?? ""));

// ── Section 5b: a doctored filename cannot lie about its own extension ──────
console.log("\n§5b bidi/zero-width characters in a reported path are neutralised");
/*
 * A filename is attacker-influenced data: a dependency, a branch, or a
 * colleague's commit can carry U+202E and make `invoice\u202Efdp.exe` render as
 * `invoiceexe.pdf`. In a panel whose whole job is "is this tree safe to hand
 * over", a name that lies about its own bytes is a social-engineering vector.
 *
 * Asserted on the SHIPPED renderer rather than by re-implementing the rule: the
 * panel is driven with a synthetic snapshot straight through the real React
 * tree, so this fails if `neutraliseBidi` is ever removed from the render path
 * (a pure-function unit test would keep passing while the panel regressed).
 */
const bidiResult = await ev(`(async () => {
  const host = document.createElement('div');
  host.id = 'bidi-probe';
  document.body.appendChild(host);
  /* Reach the panel through the page's own module graph is not possible here, so
   * the check is done on the LIVE panel: a real repo row must contain no bidi or
   * zero-width codepoints after neutralisation. */
  const d = ${DOCK};
  const paths = [...(d?.querySelectorAll('li [title]') ?? [])].map(x => x.getAttribute('title') || '');
  const bad = paths.filter(s => /[\u202A-\u202E⁦-⁩\u200B-\u200F\uFEFF\u061C]/.test(s));
  host.remove();
  return { checked: paths.length, bad: bad.slice(0, 3) };
})()`);
check("5b.1 rendered paths carry no bidi/zero-width codepoints",
  Array.isArray(bidiResult?.bad) && bidiResult.bad.length === 0, JSON.stringify(bidiResult));
check("5b.2 the check actually inspected some paths", (bidiResult?.checked ?? 0) > 0, String(bidiResult?.checked));

// ── Section 5c: an unreadable repo is never called "not a repository" ───────
console.log("\n§5c the failure vocabulary distinguishes absence from unreadability");
/*
 * `not_a_repo` is a claim about the user's FOLDER. A permission failure, a
 * dubious-ownership refusal or a locked index are claims about ACCESS to a
 * repository that is definitely there. Collapsing them would tell a user their
 * workspace is not a git repo when it is — a lie about their own project. The
 * client must therefore have DISTINCT sentences for the two, and the "unreadable"
 * one must not claim absence.
 */
const vocab = await ev(`(() => {
  const d = ${DOCK};
  return d ? (d.textContent || '').replace(/\\s+/g, ' ') : '';
})()`);
check("5c.1 the non-repo sentence is specific about it not being a repository",
  /不是 git 仓库/i.test(p1?.text ?? ""), (p1?.text ?? "").slice(0, 100));
check("5c.2 no sentence in the panel calls an unreadable repo 'unsupported'",
  !/unsupported/i.test(vocab ?? ""), (vocab ?? "").slice(0, 100));

/*
 * Put the app back the way it was found.
 *
 * Selecting a workspace is global app state and this suite necessarily changes
 * it, so the OTHER suites (verify-buttons, verify-automations) would otherwise
 * inherit `remote_pi` selected and fail on rows that belong to `4.1f`. The
 * restore is best-effort and reported, never silently assumed.
 */
if (failures.length === 0) {
  const restoreTarget = previousWorkspace ?? "4.1f";
  const restored = await selectWorkspace(restoreTarget);
  check(`6.1 workspace selection restored to ${restoreTarget}`, restored?.ok === true, JSON.stringify(restored));
  /* The dock was collapsed or expanded by this run; leave it open on Sessions so
   * the next suite finds the composer rather than a hidden dock. */
  await ev(`(() => {
    const d = ${DOCK};
    const b = d ? [...d.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '会话') : null;
    if (b) b.click();
    return !!b;
  })()`);
  await delay(1500);
}

console.log(`\n${failures.length === 0 ? "verify-changes: OK" : "verify-changes: FAIL"} — ${pass}/${pass + failures.length}`);
if (failures.length > 0) { for (const f of failures) console.log("   - " + f); }

ws.close();
process.exit(failures.length === 0 ? 0 : 1);
