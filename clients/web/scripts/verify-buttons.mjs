/**
 * REAL-BROWSER acceptance for the four controls this change implements.
 *
 * Runs against the LIVE daemon, not a stub: the daemon serves the built bundle
 * from `clients/web/dist` on its own origin and auto-pairs via `/api/bootstrap`,
 * so the browser is in exactly the state a user reaches by opening the app.
 *
 * Why a browser and not a unit test: every claim here is about what a person
 * can DO — Enter submits, Stop stops, Plugins lists real packages, Stop on a
 * workspace locks the composer. None of that is observable from Node without
 * re-implementing the DOM.
 *
 * Prerequisites:
 *   1. `npm run build` (the daemon serves dist, not src)
 *   2. the direct daemon running on APP_ORIGIN (default http://127.0.0.1:4124)
 *   3. Chrome with --remote-debugging-port=$CDP_PORT
 *
 * Usage: node scripts/verify-buttons.mjs [--cdp=9444] [--origin=http://127.0.0.1:4124]
 */

const CDP_PORT = Number(process.argv.find((a) => a.startsWith("--cdp="))?.slice(6) ?? 9444);
const ORIGIN = (
  process.argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? "http://127.0.0.1:4124"
).replace(/\/$/, "");

let passed = 0;
const failures = [];
function check(label, ok, extra = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

/* -- browser ------------------------------------------------------------- */

async function openTarget() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const host = new URL(ORIGIN).host;
  const page = list.find((t) => t.type === "page" && t.url.includes(host));
  if (!page) {
    throw new Error(`no page target for ${host}; open it in the CDP browser (port ${CDP_PORT})`);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });
  return socket;
}

const ws = await openTarget();
let nextId = 1;
const pending = new Map();
const exceptions = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params?.exceptionDetails;
    exceptions.push((d?.exception?.description ?? d?.text ?? "").slice(0, 300));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const reply = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return reply.result?.result?.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");
/* A wide viewport is REQUIRED: below 1024px the sidebar collapses to a 56px
   rail and below 760px the dock disappears, so every row control this script
   asserts on would be absent for layout reasons rather than code reasons. */
await send("Emulation.setDeviceMetricsOverride", {
  width: 1700,
  height: 1100,
  deviceScaleFactor: 1,
  mobile: false,
});

const SEL = 'textarea[aria-label="发给代理的消息"]';

const fillComposer = (value) => `(()=>{
  const el = document.querySelector(${JSON.stringify(SEL)});
  if (!el) return 'no-composer';
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  return el.value;
})()`;

const keyEnter = async (shift) => {
  const modifiers = shift ? 8 : 0;
  /* `text: "\r"` is passed for BOTH cases on purpose. CDP would otherwise leave
     the insertion to the browser's default action, which does not run for a
     synthetic keyDown — the field would come out unchanged whether or not the
     handler swallowed the key, and the assertion would prove nothing. Supplying
     the text makes the check discriminating: if the handler called
     preventDefault on Shift+Enter, this character would NOT survive. */
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    modifiers,
    text: "\r",
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    modifiers,
  });
};

const buttonTexts = async (scopeExpr) =>
  JSON.parse(
    (await evaluate(
      `JSON.stringify([...(${scopeExpr ?? "document"}).querySelectorAll('button')].map(b => (b.textContent || '').replace(/\\s+/g, ' ').trim()))`,
    )) ?? "[]",
  );

const clickButton = (exact) =>
  evaluate(`(()=>{
    const b = [...document.querySelectorAll('button')].find(x =>
      (x.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(exact)});
    if (!b) return 'not-found';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);

const rowCount = async () =>
  evaluate(`document.querySelectorAll('[class*=userRow], [class*=agentRow]').length`);

const DOCK_SCOPE = `[...document.querySelectorAll('aside')].find(a => /^停靠栏/.test(a.getAttribute('aria-label') || ''))`;
const SIDEBAR_SCOPE = `[...document.querySelectorAll('aside')].find(a => /工作区/.test(a.getAttribute('aria-label') || ''))`;
/* The composer's Stop and a workspace row's Stop are BOTH labelled "停止"… which
 * is exactly the ambiguity that made the first version of this script press the
 * wrong one and kill the whole workspace instead of the turn. They are scoped
 * explicitly: the composer's lives in the message form, the row's in the
 * sidebar. */
const COMPOSER_STOP =
  `[...document.querySelectorAll('form button')].find(b => /^Stop/.test((b.textContent || '').trim()))`;

const composerStopState = async () =>
  evaluate(`(()=>{const b = ${COMPOSER_STOP}; return b ? (b.disabled ? 'disabled' : 'enabled') : 'absent';})()`);

const clickComposerStop = () =>
  evaluate(`(()=>{const b = ${COMPOSER_STOP}; if (!b) return 'not-found'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';})()`);

/* -- load ---------------------------------------------------------------- */

console.log(`\nverify-buttons - real browser against ${ORIGIN}\n`);
await send("Page.navigate", { url: `${ORIGIN}/remote-pi/connect` });
await sleep(15000);
/* The launcher hands off to the app shell once paired; every control below lives there. */
await send("Page.navigate", { url: `${ORIGIN}/` });
await sleep(6000);
await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
/* Re-apply once more after a beat: the shell reads innerWidth during its own
 * layout effect, and a single override issued in the same tick as navigation can
 * be measured before it lands. */
await sleep(1500);
await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
await sleep(1500);

const connected = /已连接主机|主机无响应/.test((await evaluate(`document.body.textContent`)) ?? "");
check("the app paired with the live host", connected);
if (!connected) {
  console.log("\nThe browser is not paired with the host; every control assertion would be vacuous.");
  ws.close();
  process.exit(1);
}

/* -- ensure a live workspace --------------------------------------------
 * The composer is locked on a workspace that is not running (that lock is itself
 * one of the things this script asserts), so every composer check below needs a
 * LIVE workspace to mean anything. Starting it when it is down also makes this
 * harness IDEMPOTENT: a previous run that ended by stopping the workspace must
 * not leave the next run measuring a disabled textarea. */

console.log("\nSetup - ensure a live workspace");
{
  const startRow = (await buttonTexts(SIDEBAR_SCOPE)).find((t) => t.startsWith('启动 '));
  if (startRow === undefined) {
    check("a workspace is already running", true);
  } else {
    const started = await evaluate(`(()=>{
      const side = ${SIDEBAR_SCOPE};
      const b = [...side.querySelectorAll('button')].find(x =>
        (x.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(startRow)});
      if (!b) return 'not-found';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`);
    check(`started the workspace for the composer checks (${startRow})`, started === "clicked", started);
    /* A cold start brings up a Pi process and then a session mirror; ~25s is the
       observed ceiling before the composer unlocks. */
    await sleep(25000);
  }
}

/* -- ensure a MODEL -----------------------------------------------------
 *
 * A live workspace is necessary but NOT sufficient: the composer now also locks
 * when no model is active, because a turn opened with no model can never stream
 * a reply. This setup step makes the harness independent of whatever the last
 * manual session left selected, exactly like the workspace step above. */

console.log("\nSetup - ensure an active model");
{
  const statusText = (await evaluate(`document.querySelector('#transcript-composer-status')?.textContent`)) ?? "";
  const needsModel = /发送前请先选择模型/.test(statusText);
  if (!needsModel) {
    check("a model is already active", true);
  } else {
    const openedPicker = await evaluate(`(() => {
      const ta = document.querySelector(${JSON.stringify(SEL)});
      const form = ta && ta.closest('form');
      if (!form) return 'no form';
      const b = [...form.querySelectorAll('button')]
        .find((x) => /选择模型|列出该工作区/.test((x.textContent || '') + (x.getAttribute('title') || '')));
      if (!b) return 'no model button';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`);
    check("the model picker opens", openedPicker === "clicked", openedPicker);
    await sleep(6000);

    /* Pick the first offered model. The catalog belongs to the host, so this
       takes whatever is on offer instead of naming one. */
    const picked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('button,[role="option"]')]
        .filter((x) => /·\s*(reasoning|non-reasoning)|\d+k? ctx/i.test(x.textContent || ''));
      if (rows.length === 0) return 'no models listed';
      rows[0].click();
      return (rows[0].textContent || '').trim().split(String.fromCharCode(10))[0];
    })()`);
    check("a model is selected", typeof picked === "string" && picked !== "no models listed", String(picked));
    await sleep(9000);
  }

  check(
    "the composer is unlocked once a model is active",
    (await evaluate(`!document.querySelector(${JSON.stringify(SEL)})?.disabled`)) === true,
  );
}

/* -- A2: Enter sends, Shift+Enter does not ------------------------------- */

console.log("\nA2 - Enter sends / Shift+Enter newlines");

/* Shift+Enter is checked FIRST, while the composer is still idle: a disabled
   composer swallows the keystroke and the newline would never be inserted for a
   reason that has nothing to do with the handler under test. */
const beforeShift = await rowCount();
await evaluate(fillComposer("shift-enter acceptance"));
await sleep(400);
await keyEnter(true);
await sleep(1500);
const afterShift = await rowCount();
const draftAfterShift = await evaluate(`document.querySelector(${JSON.stringify(SEL)})?.value`);
check("Shift+Enter does NOT send", afterShift === beforeShift);
check(
  "Shift+Enter inserts a newline",
  typeof draftAfterShift === "string" && draftAfterShift.endsWith("\n"),
  JSON.stringify(draftAfterShift),
);

const beforeEnter = await rowCount();
await evaluate(fillComposer("enter-key acceptance"));
await sleep(400);
await keyEnter(false);
await sleep(3500);
const afterEnter = await rowCount();
const draftAfterEnter = await evaluate(`document.querySelector(${JSON.stringify(SEL)})?.value`);
check("Enter submits the composer", afterEnter > beforeEnter, `${beforeEnter} -> ${afterEnter} rows`);
check("Enter clears the draft", draftAfterEnter === "", JSON.stringify(draftAfterEnter));

/* Wait for the turn to SETTLE. A fixed sleep is not enough: the turn's length is
   decided by the model, so on a slow reply the next phase would begin while the
   composer is still legitimately locked and every following check would blame
   the wrong thing. This polls the one condition that actually matters. */
const composerUnlocked = async () =>
  (await evaluate(`!document.querySelector(${JSON.stringify(SEL)})?.disabled`)) === true;
for (let i = 0; i < 30; i += 1) {
  if (await composerUnlocked()) break;
  await sleep(2000);
}

const statusLine =
  (await evaluate(`document.querySelector('#transcript-composer-status')?.textContent`)) ?? "";
check("the old 'not wired' status text is gone", !/not wired/i.test(statusLine));

/* -- A1: Stop appears mid-turn and settles the turn --------------------- */

console.log("\nA1 - Stop cancels an in-flight turn");

await evaluate(fillComposer("count slowly from 1 to 400, one number per line"));
await sleep(400);
await keyEnter(false);
await sleep(3000);

check("a Stop control replaces Send while a turn is in flight", (await composerStopState()) === "enabled");

const stopClicked = await clickComposerStop();
check("the composer Stop is clickable", stopClicked === "clicked", stopClicked);
await sleep(6000);
{
  const body = (await evaluate(`document.body.innerText`)) ?? "";
  /* Two acceptable outcomes, both correct: the abort landed (`cancelled`), or it
     raced a turn that had already produced its last token. What must NEVER
     happen is a turn stuck open, which is the bug this control exists to fix. */
  check(
    "the turn is settled, not left streaming",
    /stopped by you/i.test(body) || !/streaming/i.test(body),
  );
  /* The composer's unlock is the REAL assertion: a settled phase is what makes
   `canSubmit` true again. It is polled, not sampled once, because the host may
   answer `cancelled` a few seconds after the click while the model was mid-token
   — and a single sample would report a race as a defect. The failure this guards
   against is a PERMANENTLY locked composer, so the loop gives it a real budget
   before failing. */
let unlocked = await composerUnlocked();
for (let i = 0; i < 10 && !unlocked; i += 1) {
  await sleep(2000);
  unlocked = await composerUnlocked();
}
check("the composer is unlocked again", unlocked);
}

/* -- A4: workspace Stop disables the composer --------------------------- */

console.log("\nA4 - workspace lifecycle + composer live gate");

const rowButtons = await buttonTexts(SIDEBAR_SCOPE);
const stopRow = rowButtons.find((t) => t.startsWith('停止 '));
if (stopRow !== undefined) {
  const clicked = await evaluate(`(()=>{
    const side = ${SIDEBAR_SCOPE};
    const b = [...side.querySelectorAll('button')].find(x =>
      (x.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(stopRow)});
    if (!b) return 'not-found';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  check(`workspace row Stop is clickable (${stopRow})`, clicked === "clicked", clicked);
  await sleep(12000);
  const body = (await evaluate(`document.body.innerText`)) ?? "";
  check("the stopped workspace is no longer reported running", /未运行/.test(body));
  check(
    "the composer states that the workspace is not running",
    /未运行.*启动/.test(body),
  );
  check(
    "the composer is locked on a stopped workspace",
    (await evaluate(`document.querySelector(${JSON.stringify(SEL)})?.disabled`)) === true,
  );
} else {
  check("a running workspace was available to stop", false, "no 'Stop <name>' row control found");
}

/* -- A3: Plugins dock exposes real host data ---------------------------- */

console.log("\nA3 - Plugins dock");

const allLabels = await buttonTexts();
check("the dock has a Plugins tab", allLabels.includes("插件"));

const opened = await evaluate(`(()=>{
  const dock = ${DOCK_SCOPE};
  const scope = dock ?? document;
  const b = [...scope.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '插件');
  if (!b) return 'not-found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`);
check("the Plugins tab opens", opened === "clicked");
await sleep(9000);

const dockText =
  (await evaluate(`(()=>{
    const dock = ${DOCK_SCOPE};
    return dock ? (dock.textContent || '') : '';
  })()`)) ?? "";
/*
 * This section runs AFTER the Stop check above, so the selected workspace is
 * deliberately NOT running. The panel must then be inert, and it is: it states
 * why it cannot answer instead of showing "0 packages", which would be a claim
 * about a host that was never asked.
 *
 * So the assertion accepts either honest state — an inert panel that explains
 * itself, or a live panel with real rows — and rejects only a blank one (which
 * would mean the payload was dropped).
 */
const pluginRows = (await evaluate(`document.querySelectorAll('[data-plugin-row]').length`)) ?? 0;
const inert = /启动该工作区后即可查看和管理其插件/.test(dockText);
check(
  "the panel renders a Packages section",
  inert || pluginRows > 0 || /pi_surface/.test(dockText),
  inert ? "inert (workspace stopped)" : `${pluginRows} row(s)`,
);
check("the panel renders a Skills section", /技能/.test(dockText));
/*
 * The rows must come from the host, so the panel either lists real packages or
 * says the host reported none. A blank panel would mean the payload was
 * dropped.
 *
 * The old version of this check looked for the fixed sentence "no packages
 * configured", which the drill-down panel no longer uses: it now renders one
 * row per package, and the empty state is explained with the host-surface
 * sentence instead — or with the inert reason when no workspace is running.
 * Asserting UI COPY here made the check fail on a correct panel.
 */
check(
  "the panel is populated from the host payload",
  inert || pluginRows > 0 || /pi_surface/.test(dockText),
  inert ? "inert (workspace stopped)" : `${pluginRows} row(s)`,
);

/* The sidebar row must be wired (it used to be permanently disabled). */
const sidebarPlugin = await evaluate(`(()=>{
  const side = [...document.querySelectorAll('aside')].find(a => /工作区/.test(a.getAttribute('aria-label') || ''));
  if (!side) return 'no-sidebar';
  const b = [...side.querySelectorAll('button')].find(x => (x.textContent || '').replace(/\\s+/g, ' ').trim() === '插件');
  if (!b) return 'not-found';
  return b.disabled ? 'disabled' : 'enabled';
})()`);
check("the sidebar Plugins row is wired, not dead", sidebarPlugin === "enabled", sidebarPlugin);

/* -- Plan tab: a real document, and a refusal for a forbidden path -------
 *
 * This section needs a workspace whose cwd actually has a plan/ directory, so
 * it selects one by reading the row titles (each carries its absolute cwd) and
 * picks the first that reports one. Selecting a row is what makes it the
 * "active" workspace, and the active workspace's cwd is the ROOT the host
 * measures its fs_read allowlist against — the whole reason a read can be
 * refused even when the path is spelled correctly.
 */

console.log("\nPlan - the dock reads a real document");

const planRow = await evaluate(`(() => {
  const side = ${SIDEBAR_SCOPE};
  if (!side) return { err: 'no sidebar' };
  const rows = [...side.querySelectorAll('button')]
    .filter((b) => / — / .test(b.getAttribute('title') || ''));
  return { titles: rows.map((b) => b.getAttribute('title') || '') };
})()`);
check("workspace rows expose their cwd", Array.isArray(planRow?.titles) && planRow.titles.length > 0);

/* Prefer the repo the harness is running from: it is the one guaranteed to have
   plan/*.md. */
const PREFERRED_ROOT = "remote_pi";
const rowName = (await evaluate(`(() => {
  const side = ${SIDEBAR_SCOPE};
  const want = ${JSON.stringify(PREFERRED_ROOT)};
  const rows = [...side.querySelectorAll('button')]
    .filter((b) => / — /.test(b.getAttribute('title') || ''));
  const hit = rows.find((b) => (b.getAttribute('title') || '').startsWith(want + ' —'));
  if (!hit) return null;
  hit.click();
  return hit.getAttribute('title');
})()`));
check("a workspace with a plan/ directory is selectable", typeof rowName === "string", String(rowName));
await sleep(6000);

/* Open the Plan tab and wait for it to offer documents. */
const planOpened = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  if (!d) return 'no-dock';
  const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '计划');
  if (!b) return 'not-found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`);
check("the dock still has a Plan tab", planOpened === "clicked", planOpened);

/* The list arrives over fs_list on plan/; poll rather than sleep.
 *
 * Rows are matched by their `data-plan-row` marker, NOT by a `.md` suffix: the
 * label is deliberately the basename without the extension (`76` + `remove-relay`),
 * because in a narrow dock the distinguishing part has to survive truncation. */
let planDocs = [];
for (let i = 0; i < 12; i += 1) {
  planDocs = (await evaluate(`(() => {
    const d = ${DOCK_SCOPE};
    if (!d) return [];
    return [...d.querySelectorAll('button[data-plan-row="true"]')]
      .map((b) => (b.textContent || '').trim());
  })()`)) ?? [];
  if (planDocs.length > 0) break;
  await sleep(2000);
}
check("the Plan tab lists real markdown documents", planDocs.length > 0, `${planDocs.length} docs`);
/* Reading one must render MARKDOWN, not the raw text: real headings prove the
   existing renderer ran, and a leftover leading '#' would prove it did not. */
if (planDocs.length > 0) {
  const target = planDocs[0];
  const read = await evaluate(`(() => {
    const d = ${DOCK_SCOPE};
    const b = [...d.querySelectorAll('button[data-plan-row="true"]')]
      .find((x) => (x.textContent || '').trim() === ${JSON.stringify(target)});
    if (!b) return 'not-found';
    b.click();
    return 'clicked';
  })()`);
  check("a plan document opens", read === "clicked", read);

  let rendered = null;
  for (let i = 0; i < 12; i += 1) {
    rendered = await evaluate(`(() => {
      const d = ${DOCK_SCOPE};
      const body = d && d.querySelector('[class*="planDocBody"]');
      if (!body) return null;
      return {
        headings: body.querySelectorAll('h1,h2,h3,h4').length,
        text: (body.innerText || '').slice(0, 80),
        rawHash: (body.innerText || '').trimStart().startsWith('#'),
      };
    })()`);
    if (rendered) break;
    await sleep(2000);
  }
  check("the document renders inside the dock", rendered !== null);
  check("it renders as MARKDOWN, not raw text", rendered !== null && rendered.headings > 0, JSON.stringify(rendered?.headings));
  check("no raw markdown markers leak through", rendered !== null && rendered.rawHash === false);
}

/* -- the OFF-SCREEN bug this panel was rebuilt to fix -------------------
 *
 * MEASURED BEFORE the rebuild: with the dock scrolled to the bottom of its
 * 90-row document list, clicking a lower document rendered the body at
 * `top: -2438px` — entirely above the viewport. The click worked, the document
 * was there, and the user saw a blank panel.
 *
 * So this is the assertion that matters most: scroll the list to its END, click
 * the LAST row, and require the document to be on screen and at scrollTop 0.
 * The old layout cannot pass it. */

console.log("\nPlan - opening a document from deep in the list");

const deepClick = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  if (!d) return { err: 'no dock' };
  const back = d.querySelector('[class*="planBack"]');
  if (back) back.click();
  return { stepped: 'back-to-list' };
})()`);
await sleep(2500);

const deep = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  const sc = d && d.querySelector('[class*="planListScroll"]');
  if (!sc) return { err: 'no list scroller' };
  sc.scrollTop = sc.scrollHeight;
  const rows = [...d.querySelectorAll('button[data-plan-row="true"]')];
  if (rows.length === 0) return { err: 'no rows' };
  const last = rows[rows.length - 1];
  const label = (last.innerText || '').trim();
  last.click();
  return { rows: rows.length, label, scrolledTo: Math.round(sc.scrollTop) };
})()`);
check("the list scrolls to its last document", (deep?.rows ?? 0) > 0 && deep?.scrolledTo > 0, JSON.stringify(deep?.scrolledTo));

let onScreen = null;
for (let i = 0; i < 12; i += 1) {
  onScreen = await evaluate(`(() => {
    const d = ${DOCK_SCOPE};
    const sc = d && d.querySelector('[class*="planDocScroll"]');
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      scrollTop: Math.round(sc.scrollTop),
      height: sc.clientHeight,
    };
  })()`);
  if (onScreen) break;
  await sleep(2000);
}
check("the document opens on screen, not above the viewport", onScreen !== null && onScreen.top >= 0, `top=${onScreen?.top}px`);
check("the document starts at its own top", onScreen !== null && onScreen.scrollTop === 0, `scrollTop=${onScreen?.scrollTop}`);
check("the document uses the dock's height", (onScreen?.height ?? 0) > 600, `${onScreen?.height}px`);

/* Exactly ONE scroll container: the old layout had the panel scrolling AND the
   58vh-capped body scrolling inside it. */
const scrollerCount = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  if (!d) return -1;
  return [...d.querySelectorAll('*')].filter((el) => {
    const st = getComputedStyle(el);
    return (st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4;
  }).length;
})()`);
check("only one scroll container is active", scrollerCount === 1, `${scrollerCount} scrollers`);

/* -- row labels must fit a narrow dock ------------------------------- */

const labels = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  const back = d && d.querySelector('[class*="planBack"]');
  if (back) back.click();
  return 'ok';
})()`);
await sleep(2500);

const rowLabels = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  if (!d) return { err: 'no dock' };
  const rows = [...d.querySelectorAll('button[data-plan-row="true"]')];
  return {
    count: rows.length,
    texts: rows.slice(0, 5).map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim()),
    anyAbsolute: rows.some((r) => /^[A-Za-z]:/.test((r.innerText || '').trim())),
  };
})()`);
check("the list shows the documents again", (rowLabels?.count ?? 0) > 0, `${rowLabels?.count} rows`);
check(
  "rows do NOT repeat the absolute path",
  rowLabels !== null && rowLabels.anyAbsolute === false,
  JSON.stringify(rowLabels?.texts?.slice(0, 2)),
);

/* -- the filter ------------------------------------------------------ */

const filterable = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  const i = d && d.querySelector('input[type="search"]');
  if (!i) return { err: 'no filter input' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(i, '76');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return { value: i.value };
})()`);
check("the Plan list has a filter", filterable?.value === "76", JSON.stringify(filterable));
await sleep(900);

const filtered = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  return {
    rows: d.querySelectorAll('button[data-plan-row="true"]').length,
    indicator: (d.querySelector('[class*="planCount"]') || {}).innerText || '',
  };
})()`);
check(
  "the filter narrows the list",
  (filtered?.rows ?? 0) >= 1 && (filtered?.rows ?? 0) < 10,
  `${filtered?.rows} rows (${filtered?.indicator})`,
);

/* Leave the filter empty for the next run. */
await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  const i = d && d.querySelector('input[type="search"]');
  if (!i) return 'none';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(i, '');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return 'cleared';
})()`);
await sleep(500);

/* -- back affordance ------------------------------------------------- */

const backWorks = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  const rows = [...d.querySelectorAll('button[data-plan-row="true"]')];
  if (rows.length === 0) return { err: 'no rows' };
  rows[0].click();
  return { opened: true };
})()`);
await sleep(4000);

const backResult = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  const back = d && d.querySelector('[class*="planBack"]');
  if (!back) return { err: 'no back control' };
  const before = d.querySelectorAll('button[data-plan-row="true"]').length;
  back.click();
  return { before };
})()`);
await sleep(2500);

const afterBack = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  return { rows: d.querySelectorAll('button[data-plan-row="true"]').length };
})()`);
check("a back control returns to the list", (afterBack?.rows ?? 0) > 0, `${afterBack?.rows} rows`);

/* SECURITY: the Plan tab can only ever name a path the HOST listed.
 *
 * A browser test cannot prove the server-side allowlist (that is
 * `server/src/daemon/fs_read_77.test.ts`, 21 cases). What it CAN prove is the
 * property that closes the loop here: every row comes from the host's own
 * `fs_list` reply under the selected workspace, so the UI has no way to name an
 * arbitrary file in the first place. */
const offered = await evaluate(`(() => {
  const d = ${DOCK_SCOPE};
  if (!d) return { err: 'no dock' };
  return {
    texts: [...d.querySelectorAll('button[data-plan-row="true"]')]
      .map((b) => (b.textContent || '').trim()),
    inputs: d.querySelectorAll('input').length,
  };
})()`);
const forbidden = (offered?.texts ?? []).filter((t) => /\.\.|\.ssh|peers\.json|\.env\b/.test(t));
check(
  "no row names a forbidden target",
  forbidden.length === 0,
  JSON.stringify(forbidden.slice(0, 3)),
);
check(
  "the only input in the Plan view is the filter, not a path field",
  (offered?.inputs ?? 99) <= 1,
  `${offered?.inputs} input(s)`,
);

/* -- the reported bug: a fresh session with NO model must not send -------
 *
 * Reported from real use: a new session had no model selected, yet the composer
 * unlocked as soon as the workspace was running, so the message posted — the
 * user's text landed in the transcript and the turn could never stream a reply,
 * because there was no model behind it.
 *
 * The invariant is narrow and testable: the composer's own status line must state
 * the model requirement whenever no model is active, and a locked composer must
 * keep the keystroke out of the transcript. This deliberately does NOT depend on
 * being able to drive the picker into a "nothing selected" state (the auto-pick
 * may have already chosen one) — it asserts the ARITHMETIC the fix introduced:
 * composer unlocked  <=>  a model is active. */

console.log("\nModel gate - the composer is locked without a model");

{
  const gate = await evaluate(`(() => {
    const ta = document.querySelector(${JSON.stringify(SEL)});
    if (!ta) return { err: 'no composer' };
    const form = ta.closest('form');
    const status = document.querySelector('#transcript-composer-status');
    const statusText = status ? (status.textContent || '') : '';
    const modelBtn = form
      ? [...form.querySelectorAll('button')].find((b) =>
          /model/i.test((b.textContent || '') + (b.getAttribute('title') || '')))
      : null;
    const modelLabel = modelBtn ? (modelBtn.innerText || '').trim().split(String.fromCharCode(10))[0] : '';
    return {
      composerDisabled: ta.disabled,
      statusText,
      modelLabel,
      saysModelRequired: /发送前请先选择模型/.test(statusText),
      saysNormal: /回车发送/.test(statusText),
      saysNotRunning: /未运行|请先启动/.test(statusText),
      saysBusy: /这轮对话|正在进行/.test(statusText),
      unselected: /select a model/i.test(modelLabel),
    };
  })()`);

  /* The gate must be consistent with the state the UI is actually in. Three
     combinations are legal, because the composer reason chain is prioritised:
     a turn in flight, a workspace that is not running, or no model. Only the
     fourth combination — OPEN while a blocking condition holds — is the bug. */
  const lockedWithoutModel = gate?.composerDisabled === true && gate?.saysModelRequired === true;
  const lockedForOtherReason = gate?.composerDisabled === true && (gate?.saysNotRunning === true || gate?.saysBusy === true);
  const openWithModel = gate?.composerDisabled === false && gate?.saysNormal === true && gate?.unselected === false;
  const openWithNoBlocker =
    gate?.composerDisabled === false && gate?.saysNotRunning === false && gate?.saysBusy === false;
  /* An unlocked composer is only acceptable when NOTHING is blocking, and a
     model is active. That is the exact invariant the reported bug broke. */
  const legal = lockedWithoutModel || lockedForOtherReason || (openWithModel && openWithNoBlocker);
  check(
    "the composer gate agrees with the model state",
    legal,
    JSON.stringify({ disabled: gate?.composerDisabled, label: gate?.modelLabel, status: String(gate?.statusText).slice(0, 60) }),
  );

  /* Whichever state we are in, a keystroke must never open a turn that has no
     model behind it. When the composer is locked this is trivially true, and
     asserting it here is what would have caught the original report. */
  if (gate?.composerDisabled === true) {
    const before = await rowCount();
    await evaluate(fillComposer("blocked: no model"));
    await sleep(400);
    await keyEnter(false);
    await sleep(2500);
    const after = await rowCount();
    const draft = await evaluate(`document.querySelector(${JSON.stringify(SEL)})?.value`);
    check("a locked composer keeps the keystroke out of the transcript", after === before, `${before} -> ${after}`);
    check("a locked composer keeps the draft", typeof draft === "string" && draft.length > 0, JSON.stringify(draft));
    await evaluate(`(() => {
      const ta = document.querySelector(${JSON.stringify(SEL)});
      if (!ta) return 'none';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'cleared';
    })()`);
  }
}

/* -- regression: the previously-live controls still work ---------------- */

console.log("\nRegression - the controls that already worked");

const finalLabels = await buttonTexts();
for (const expected of ["解除配对", "新建会话", "刷新工作区目录", "右侧停靠栏"]) {
  check(`"${expected}" still renders`, finalLabels.some((t) => t.startsWith(expected)));
}

console.log(
  "\nNo uncaught console exceptions:",
  exceptions.length === 0 ? "yes" : exceptions.join(" | "),
);
if (exceptions.length > 0) failures.push("console exceptions");

ws.close();

console.log(`\n${passed}/${passed + failures.length} checks PASS`);
if (failures.length > 0) {
  console.log("FAILED:", failures.join("; "));
  process.exit(1);
}
console.log("verify-buttons: OK");
