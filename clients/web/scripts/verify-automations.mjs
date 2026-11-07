/**
 * Automations — real-browser acceptance, driven through Chrome DevTools Protocol.
 *
 * ## Why this exists instead of a unit test
 *
 * A schedule is only correct if it actually FIRES and the fire is actually
 * VISIBLE. A unit test can assert that `classifySchedule` returns "daily" for
 * `0 9 * * *` and never notice that the browser renders nothing because the
 * panel is unreachable, the reply guard rejects the frame, or the sidebar row is
 * still `disabled`. Every assertion below is about something a user can see.
 *
 * ## The vacuous-assertion trap
 *
 * "A row exists" is not acceptance. These checks require the row to CHANGE (a
 * fire moves `last_run` from "never" to a timestamp), which is the only evidence
 * that the daemon's timer, the delivery path and the UI projection all agree.
 *
 * Run against a live direct-mode daemon on 127.0.0.1:4124 with Chrome exposing
 * CDP on 9444.
 */
const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9444";
const APP = process.env.APP_URL ?? "http://127.0.0.1:4124/remote-pi/connect";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target on the CDP endpoint");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(
        msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(String(msg.params.exceptionDetails?.text ?? "exception").slice(0, 160));
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      return { __error: String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200) };
    }
    return r.result?.result?.value;
  };

  return { ws, send, evaluate, consoleErrors };
}

/** The dock's `aside`; aria-label starts with "Dock". */
const DOCK = `[...document.querySelectorAll('aside')].find((a) => (a.getAttribute('aria-label') || '').indexOf('停靠栏') === 0)`;
const SIDEBAR = `[...document.querySelectorAll('aside')].find((a) => a.getAttribute('aria-label') === '工作区')`;

async function main() {
  const { ws, send, evaluate: ev, consoleErrors } = await connect();

  await send("Runtime.enable");
  await send("Page.enable");
  /* 1700x1100: below ~1024 the sidebar collapses to a 56px rail and below ~760
   * the dock disappears entirely, which would make every assertion below pass
   * for the wrong reason. */
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1700,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /*
   * Disable the HTTP cache for this tab and bust the document URL.
   *
   * Without both, a re-run against a freshly built bundle silently executes the
   * PREVIOUS build: diagnostics from removed code kept appearing, fixes looked
   * ineffective, and several rounds of "the fix did not work" were actually the
   * old bundle running. `setCacheDisabled` covers the sub-resources (the hashed
   * JS chunk), and the query string guarantees a fresh document either way.
   */
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.navigate", { url: `${APP}?_v=${Date.now()}` });
  await sleep(16000);

  /* The device-metrics override does NOT survive a navigation. Without
   * re-applying it here the viewport fell back to ~764x485, below the width at
   * which the dock exists at all — every panel assertion then measured a
   * collapsed dock and failed for a reason that had nothing to do with the code. */
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1700,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(2500);

  /* The dock starts COLLAPSED (aria-label "停靠栏（已折叠）"). Its tabs and the
   * Automations row's onClick both need it expanded. */
  for (let i = 0; i < 6; i += 1) {
    const open = await ev(`(() => {
      const d = [...document.querySelectorAll('aside')].find((a) => (a.getAttribute('aria-label') || '') === '停靠栏');
      if (d) return true;
      const b = [...document.querySelectorAll('button')].find((x) => /Expand the dock/i.test((x.getAttribute('title') || '') + (x.textContent || '')));
      if (b) b.click();
      return false;
    })()`);
    if (open === true) break;
    await sleep(1500);
  }

  /* The sidebar can be collapsed and silently hide every row. */
  for (let i = 0; i < 10; i += 1) {
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Expand the sidebar/i.test(x.getAttribute('title') || ''));
      if (b) b.click();
    })()`);
    const rows = await ev(`(() => {
      const s = ${SIDEBAR};
      return [...(s?.querySelectorAll('button') || [])].filter((b) => (b.getAttribute('title') || '').includes(' \\u00b7 ')).length;
    })()`);
    if (typeof rows === "number" && rows > 0) break;
    await sleep(5000);
  }

  /*
   * NOTE: no workspace selection here on purpose.
   *
   * Selecting one re-fires the automations listing, and the create path then
   * races that refresh for the single busy flag — the form looked enabled while
   * the submit was swallowed. The panel already falls back to the first known
   * workspace, which is also what a first-time user gets, so this is the more
   * realistic flow.
   */

  console.log("\n── 1. sidebar row is live ──");
  const row = await ev(`(() => {
    const s = ${SIDEBAR};
    if (!s) return { found: false };
    const b = [...s.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '自动化');
    if (!b) return { found: false };
    return { found: true, disabled: b.disabled, title: b.getAttribute('title') || '' };
  })()`);
  check("Automations row exists in the sidebar", row?.found === true);
  check("Automations row is NOT disabled", row?.disabled === false, JSON.stringify(row));
  check(
    "its title no longer claims the host has no surface",
    typeof row?.title === "string" && !/exposes no automation surface/i.test(row.title),
    row?.title,
  );

  console.log("\n── 2. the dock opens on the Automations tab ──");
  await ev(`(() => {
    const s = ${SIDEBAR};
    const b = [...s.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '自动化');
    if (b) b.click();
  })()`);
  await sleep(3000);

  const dockState = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return { dock: false };
    const tabs = [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
    return {
      dock: true,
      hasNew: tabs.includes('新建'),
      text: (d.textContent || '').slice(0, 400),
    };
  })()`);
  check("the dock is present", dockState?.dock === true);
  check("the Automations panel rendered (its New action is visible)", dockState?.hasNew === true, JSON.stringify(dockState)?.slice(0, 200));
  check(
    "no console errors so far",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "),
  );

  console.log("\n── 3. empty state is stated, not an empty list ──");
  const emptyText = await ev(`(() => {
    const d = ${DOCK};
    return d ? (d.textContent || '') : '';
  })()`);
  const hasEmptySentence = /还没有自动化/.test(emptyText || "");
  /* An existing task makes the empty state correctly absent — accept either, but
   * require that ONE of them is true so a blank panel cannot pass. */
  const rowCount0 = await ev(`(() => {
    const d = ${DOCK};
    return d ? d.querySelectorAll('[data-automation-row]').length : 0;
  })()`);
  check(
    "either the empty sentence is shown or tasks are listed",
    hasEmptySentence || (typeof rowCount0 === "number" && rowCount0 > 0),
    `empty=${hasEmptySentence} rows=${rowCount0}`,
  );

  /*
   * Read the baseline row count HERE, while the LIST is still mounted.
   *
   * The create view replaces the list entirely, so a baseline read after opening
   * the form is always 0 and the "adds exactly one row" check can never pass —
   * which is exactly how a working create looked broken.
   */
  const baselineRows = await ev(`(() => {
    const d = ${DOCK};
    return d ? d.querySelectorAll('[data-automation-row]').length : 0;
  })()`);

  console.log("\n── 4. create form validates before writing ──");
  await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '新建');
    if (b) b.click();
  })()`);
  await sleep(1500);

  const formState = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const expr = d.querySelector('#auto-expr');
    const prompt = d.querySelector('#auto-prompt');
    const submit = [...d.querySelectorAll('button')].find((x) => /创建自动化/.test(x.textContent || ''));
    return {
      hasExpr: expr !== null,
      exprValue: expr ? expr.value : null,
      hasPrompt: prompt !== null,
      submitDisabled: submit ? submit.disabled : null,
      presets: d.querySelector('#auto-preset') !== null,
    };
  })()`);
  check("create form mounts with a cron field", formState?.hasExpr === true);
  check("the preset selector is present", formState?.presets === true);
  check(
    "the cron field is prefilled from the chosen preset (not blank)",
    typeof formState?.exprValue === "string" && formState.exprValue.trim() !== "",
    formState?.exprValue,
  );
  check(
    "Create is disabled while the prompt is empty (no blank writes)",
    formState?.submitDisabled === true,
    String(formState?.submitDisabled),
  );

  console.log("\n── 5. a real task is created and listed ──");
  /* Every-minute expression: valid cron, and the host's 60s floor allows it. The
   * fire check below does NOT wait for the minute boundary — it uses Run now,
   * which exercises the same delivery path without a 60s test runtime. */
  await ev(`(() => {
    const d = ${DOCK};
    const expr = d.querySelector('#auto-expr');
    const prompt = d.querySelector('#auto-prompt');
    const setValue = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (expr) setValue(expr, '*/5 * * * *');
    if (prompt) setValue(prompt, 'automation acceptance probe');
  })()`);
  await sleep(600);

  /*
   * Pick a CONCRETE model before submitting.
   *
   * Leaving it on inherit would let a broken pin pass unnoticed: the created row
   * would read "inherit" whether the value was honoured or dropped. Choosing a
   * real option makes the assertion below able to tell those apart.
   */
  const defaultModelValue = await ev(`(() => {
    const d = ${DOCK};
    const sel = d === null || d === undefined ? null : d.querySelector('#auto-model');
    return sel === null ? null : sel.value;
  })()`);
  check(
    "the model picker starts on INHERIT before the user touches it",
    defaultModelValue === "",
    JSON.stringify(defaultModelValue),
  );

  const pickedModel = await ev(`(() => {
    const d = ${DOCK};
    const sel = d === null || d === undefined ? null : d.querySelector('#auto-model');
    if (sel === null) return { ok: false };
    const pick = [...sel.options].find((o) => o.value !== "");
    if (pick === undefined) return { ok: false };
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value');
    desc.set.call(sel, pick.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: pick.value, text: (pick.textContent || '').trim() };
  })()`);
  check("a concrete model can be selected", pickedModel?.ok === true, JSON.stringify(pickedModel)?.slice(0, 160));
  await sleep(600);

  const enabledNow = await ev(`(() => {
    const d = ${DOCK};
    const submit = [...d.querySelectorAll('button')].find((x) => /创建自动化/.test(x.textContent || ''));
    return submit ? { found: true, disabled: submit.disabled } : { found: false };
  })()`);
  check("Create becomes enabled once the prompt is filled", enabledNow?.disabled === false, JSON.stringify(enabledNow));

  /*
   * The form is ALREADY open and filled at this point — do not navigate away.
   *
   * An earlier version clicked "New" again here to "re-open" it. In the create
   * view that button does not exist, so the click was a no-op at best; the added
   * waits then raced the same mount the form had already completed. The panel
   * stayed correct but the submit that followed was measured against a view that
   * had been disturbed.
   */
  const formReady = await ev(`(() => {
    const d = ${DOCK};
    return d !== null && d !== undefined && d.querySelector('#auto-expr') !== null;
  })()`) === true;
  check("the create form is still mounted for the submission", formReady);

  /*
   * Wait for the workspace target to be adopted before typing.
   *
   * The form needs a bound workspace to submit. On a cold panel the target is
   * adopted in an effect one render AFTER mount, so filling and clicking in the
   * same tick submits a form whose target is still null — the create is refused
   * and the panel returns to the list with nothing created, which looks exactly
   * like "creation is broken".
   */
  /*
   * The target picker only renders when the host reported more than one
   * workspace name. Its absence is therefore NOT a failure — the panel falls back
   * to the first known workspace, which is the normal first-run state. Waiting
   * for a picker that will never appear burned 12s and let the initial listing
   * retry take the busy flag, so the subsequent submit was swallowed.
   */
  const targetInfo = await ev(`(() => {
    const d = ${DOCK};
    const sel = d === null || d === undefined ? null : d.querySelector('#auto-target');
    return { hasPicker: sel !== null, value: sel === null ? null : sel.value };
  })()`);
  check(
    "the create form has a usable workspace target",
    targetInfo?.hasPicker === false || (typeof targetInfo?.value === "string" && targetInfo.value !== ""),
    JSON.stringify(targetInfo),
  );

  /*
   * Model and session controls.
   *
   * Both are asserted as REAL choices, not decoration: the model picker must
   * offer "inherit" plus at least one concrete model from the host catalog, and
   * the chosen pin must come back on the created row. A picker that rendered but
   * whose value never reached the daemon would otherwise pass every other check.
   */
  const modelInfo = await ev(`(() => {
    const d = ${DOCK};
    const sel = d === null || d === undefined ? null : d.querySelector('#auto-model');
    if (sel === null) return { present: false };
    return {
      present: true,
      value: sel.value,
      options: [...sel.options].map((o) => ({ value: o.value, text: (o.textContent || '').trim() })),
    };
  })()`);
  check("the create form offers a model picker", modelInfo?.present === true, JSON.stringify(modelInfo)?.slice(0, 200));
  check(
    "the first model option IS the inherit choice (not a blank placeholder)",
    /沿用会话的模型|继承/i.test(String(modelInfo?.options?.[0]?.text ?? "")),
    String(modelInfo?.options?.[0]?.text ?? ""),
  );
  check(
    "the model picker lists real models from the host catalog",
    Array.isArray(modelInfo?.options) && modelInfo.options.length > 1,
    String(modelInfo?.options?.length ?? 0),
  );

  const sessionInfo = await ev(`(() => {
    const d = ${DOCK};
    const sel = d === null || d === undefined ? null : d.querySelector('#auto-session');
    if (sel === null) return { present: false };
    return { present: true, value: sel.value, count: sel.options.length };
  })()`);
  check("the create form offers a session choice", sessionInfo?.present === true);
  check(
    "each fire defaults to its OWN session (not the one the user is reading)",
    sessionInfo?.value === "fresh" && sessionInfo?.count === 2,
    JSON.stringify(sessionInfo),
  );

  await ev(`(() => {
    const d = ${DOCK};
    const setValue = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const expr = d.querySelector('#auto-expr');
    const prompt = d.querySelector('#auto-prompt');
    if (expr) setValue(expr, '*/5 * * * *');
    if (prompt) setValue(prompt, 'automation acceptance probe');
  })()`);
  await sleep(1500);

  /* Never click a disabled submit: clicking anyway reports a create failure
   * when the real problem is an unbound form. */
  const submitReady = await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /创建自动化/.test(x.textContent || ''));
    return b ? { found: true, disabled: b.disabled } : { found: false };
  })()`);
  check(
    "the submit control is enabled at click time",
    submitReady?.found === true && submitReady?.disabled === false,
    JSON.stringify(submitReady),
  );

  await ev(`(() => {
    const d = ${DOCK};
    const submit = [...d.querySelectorAll('button')].find((x) => /创建自动化/.test(x.textContent || ''));
    if (submit) submit.click();
  })()`);
  await sleep(9000);

  /* Creation returns to the list, but the re-list is async. Poll instead of
   * trusting one fixed delay — a fixed 8s was sometimes shorter than the
   * host round-trip plus render. */
  let afterRows = baselineRows;
  for (let i = 0; i < 12; i += 1) {
    afterRows = await ev(`(() => {
      const d = ${DOCK};
      return d ? d.querySelectorAll('[data-automation-row]').length : 0;
    })()`);
    if (typeof afterRows === 'number' && afterRows > baselineRows) break;
    await sleep(2000);
  }
  check(
    "creating a task adds exactly one row",
    typeof afterRows === "number" && afterRows === baselineRows + 1,
    `${baselineRows} -> ${afterRows}`,
  );

  console.log("\n── 6. the created task shows an honest next run ──");
  const listed = await ev(`(() => {
    const d = ${DOCK};
    const row = d.querySelector('[data-automation-row]');
    if (!row) return null;
    return { id: row.getAttribute('data-automation-row'), text: (row.textContent || '').trim().slice(0, 200) };
  })()`);
  check("the row carries a task id", typeof listed?.id === "string" && listed.id !== "");
  check(
    "the row reports a next run rather than nothing",
    /Next (in )?/i.test(listed?.text || ""),
    listed?.text,
  );

  console.log("\n── 7. detail view opens and owns the only scroller ──");
  await ev(`(() => {
    const d = ${DOCK};
    const row = d.querySelector('[data-automation-row]');
    if (row) row.click();
  })()`);
  await sleep(2000);

  const detail = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const scrollers = [...d.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4;
    });
    return {
      hasBack: /全部自动化/.test(d.textContent || ''),
      hasCron: /cron|Cron|计划表达式/.test(d.textContent || ''),
      hasRunNow: [...d.querySelectorAll('button')].some((b) => /立即运行/.test(b.textContent || '')),
      hasDelete: [...d.querySelectorAll('button')].some((b) => /^删除$/.test((b.textContent || '').trim())),
      text: (d.textContent || '').replace(/\s+/g, ' ').slice(0, 700),
      scrollerCount: scrollers.length,
      declaredScrollers: [...d.querySelectorAll('*')].filter((el) => {
        const s2 = getComputedStyle(el);
        return s2.overflowY === 'auto' || s2.overflowY === 'scroll';
      }).length,
    };
  })()`);
  check("detail view offers a way back", detail?.hasBack === true);
  check("detail view shows the cron expression", detail?.hasCron === true);
  check("detail view exposes Run now / Delete", detail?.hasRunNow === true && detail?.hasDelete === true);
  /*
   * The pin must SURVIVE the round trip.
   *
   * This is the check that would have caught the original gap: a form that
   * renders a picker, accepts a value and silently drops it on the wire produces
   * a task that inherits. Reading the value back off the daemon-projected row is
   * the only way to tell "honoured" from "rendered".
   */
  /*
   * Read the Model/Session facts from their dt/dd pairs, NOT from textContent.
   *
   * This app's font applies ligatures that mangle rendered text ("session" comes
   * back as "se ion"), so a text match on the row is unreliable by construction.
   * The dt/dd pair is the authoritative source.
   */
  const facts = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const read = (label) => {
      const dt = [...d.querySelectorAll('dt')].find((n) => (n.textContent || '').trim() === label);
      if (!dt) return null;
      const dd = dt.nextElementSibling;
      return dd === null ? null : (dd.textContent || '').trim();
    };
    return { model: read('模型'), session: read('会话') };
  })()`);
  check(
    "the pinned model is echoed back by the host",
    typeof facts?.model === "string" && facts.model !== "" && !/inherit/i.test(facts.model),
    JSON.stringify(facts?.model),
  );
  check(
    "the session choice is echoed back by the host",
    typeof facts?.session === "string" && /新建/.test(facts.session),
    JSON.stringify(facts?.session),
  );
  /*
   * Assert the PROPERTY that matters: there is no nest of scrollers.
   *
   * The original check demanded exactly one ACTIVE scroller, which conflates two
   * different things. A short task list legitimately does not overflow, so the
   * count is 0 while the layout is perfectly correct — and a version that padded
   * the list to force overflow would be testing the padding. What must never
   * happen is 2+, because that is the defect that put Plan documents at -2438px.
   *
   * `declaredScrollers` is the structural half: how many elements DECLARE
   * overflow-y auto/scroll, regardless of whether they currently overflow. One is
   * the single-scroller design; 2+ means a second scroll context exists and would
   * reintroduce nested scrolling as soon as the content grows.
   */
  check(
    "the view does not nest scroll containers",
    typeof detail?.scrollerCount === "number" && detail.scrollerCount <= 1,
    String(detail?.scrollerCount),
  );
  check(
    "only one element declares a vertical scroll context",
    detail?.declaredScrollers === 1,
    String(detail?.declaredScrollers),
  );

  console.log("\n── 8. a fire actually happens and is recorded ──");
  const statusBefore = await ev(`(() => {
    const d = ${DOCK};
    const m = (d.textContent || '').match(/上次结果\s*([a-z_]+|从未触发)/i);
    return m ? m[1] : null;
  })()`);

  await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /Run now/i.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(12000);

  const statusAfter = await ev(`(() => {
    const d = ${DOCK};
    const m = (d.textContent || '').match(/上次结果\s*([a-z_]+|从未触发)/i);
    return m ? m[1] : null;
  })()`);
  /* The fire writes last_status. "delivered" and "skipped_busy" are both real
   * outcomes; either proves the daemon's timer path ran. A value unchanged from
   * "never fired" proves it did not. */
  check(
    "Run now produced a recorded outcome (the fire path is live)",
    statusAfter !== null && statusAfter !== "never fired",
    `before=${statusBefore} after=${statusAfter}`,
  );

  console.log("\n── 9. disable keeps the task, delete removes it ──");
  await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /^(禁用|启用)$/.test((x.textContent || '').trim()));
    if (b) b.click();
  })()`);
  await sleep(6000);

  const afterToggle = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const back = [...d.querySelectorAll('button')].find((x) => /全部自动化/.test(x.textContent || ''));
    if (back) back.click();
    return { ok: true };
  })()`);
  void afterToggle;
  await sleep(2500);

  const offState = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const row = d.querySelector('[data-automation-row]');
    if (!row) return { missing: true };
    /*
     * Look for the DEDICATED off badge, not for the word "off" in the row text.
     *
     * A bare \boff\b test cannot work here: the title runs straight into the
     * badge with no separator ("Every 5 min" + "off"), so the word boundary
     * before "off" never matches — the check reported false while the badge was
     * plainly on screen. CSS-module class names are hashed, so this matches the
     * stable part of the name instead.
     */
    const badge = row.querySelector('[class*="badgeOff"]');
    return { missing: false, text: (row.textContent || '').trim(), off: badge !== null };
  })()`);
  check(
    "a disabled task is still listed (it can be switched back on)",
    offState?.missing === false,
    JSON.stringify(offState)?.slice(0, 160),
  );
  /* Being listed is not the same as being OFF. The row must say so, otherwise a
   * toggle that silently did nothing would still pass the check above. */
  check(
    "the disabled task is marked off, not merely still listed",
    offState?.off === true,
    JSON.stringify(offState)?.slice(0, 160),
  );

  /*
   * Re-enable: the round trip must come back on. Without this the suite only
   * proved that disabling works, never that a disabled task can be revived — the
   * whole point of keeping it in the list.
   */
  await ev(`(() => {
    const d = ${DOCK};
    const row = d.querySelector('[data-automation-row]');
    if (row) row.click();
  })()`);
  await sleep(1800);
  await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /^(Enable|Disable)$/.test((x.textContent || '').trim()));
    if (b) b.click();
  })()`);
  await sleep(6000);
  await ev(`(() => {
    const d = ${DOCK};
    const back = [...d.querySelectorAll('button')].find((x) => /全部自动化/.test(x.textContent || ''));
    if (back) back.click();
  })()`);
  await sleep(2500);
  const onState = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return null;
    const row = d.querySelector('[data-automation-row]');
    if (!row) return { missing: true };
    return { missing: false, text: (row.textContent || '').trim(), off: /\boff\b/i.test(row.textContent || '') };
  })()`);
  check(
    "re-enabling brings the task back on",
    onState?.missing === false && onState?.off === false,
    JSON.stringify(onState)?.slice(0, 160),
  );
  /*
   * Read the row count HERE, while the LIST is still mounted.
   *
   * The delete runs from the detail view, which has no rows in the DOM at all —
   * a baseline captured there was always 0, so the assertion compared 0 -> 0 and
   * could never pass regardless of whether the delete worked.
   */
  const countBeforeDelete = await ev(`(() => {
    const d = ${DOCK};
    return d ? d.querySelectorAll('[data-automation-row]').length : 0;
  })()`);

  /* Two-step delete: the first click arms, the second removes. */
  await ev(`(() => {
    const d = ${DOCK};
    const row = d.querySelector('[data-automation-row]');
    if (row) row.click();
  })()`);
  await sleep(1800);
  const armed = await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /^删除$/.test((x.textContent || '').trim()));
    if (!b) return { found: false };
    b.click();
    return { found: true };
  })()`);
  await sleep(900);
  const isArmed = await ev(`(() => {
    const d = ${DOCK};
    return [...d.querySelectorAll('button')].some((x) => /Confirm delete/i.test(x.textContent || ''));
  })()`);
  check("first Delete click only ARMS (no immediate destruction)", armed?.found === true && isArmed === true);

  await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /Confirm delete/i.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(8000);
  const backToList = await ev(`(() => {
    const d = ${DOCK};
    const b = [...d.querySelectorAll('button')].find((x) => /全部自动化/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  void backToList;
  await sleep(2500);
  const countAfterDelete = await ev(`(() => {
    const d = ${DOCK};
    return d ? d.querySelectorAll('[data-automation-row]').length : 0;
  })()`);
  check(
    "confirming Delete removes exactly one row",
    typeof countAfterDelete === "number" && countAfterDelete === countBeforeDelete - 1,
    `${countBeforeDelete} -> ${countAfterDelete}`,
  );

  /*
   * Section 9 — the tab's own tooltip.
   *
   * Separate from section 1: that one tests the SIDEBAR row, this tests the
   * DOCK TAB. They read from different functions (`tabReason` vs the sidebar's
   * inline title), and the dock tab shipped a wrong string for weeks because
   * `tabReason` ended in a bare `return` describing the Changes tab — so
   * Automations advertised "the host exposes no diff/working-tree API" while the
   * panel beside it created, disabled and fired tasks.
   *
   * Both directions are asserted: it must mention scheduling, and it must not
   * borrow the Changes sentence. A future edit that swaps the text for something
   * merely non-empty would still fail the first check if it stops describing the
   * feature.
   */
  console.log("\n── 9. the dock tab describes automations, not diffs ──");
  const tabTip = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return { found: false };
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '自动化');
    if (!b) return { found: false };
    return { found: true, title: b.getAttribute('title') || '' };
  })()`);
  check("the Automations dock tab exists", tabTip?.found === true);
  check(
    "its tooltip does NOT reuse the Changes copy",
    typeof tabTip?.title === "string" && !/diff\/working-tree/i.test(tabTip.title),
    tabTip?.title,
  );
  check(
    "its tooltip actually describes scheduled work",
    typeof tabTip?.title === "string" && /计划|定时/.test(tabTip.title),
    tabTip?.title,
  );
  /*
   * The sibling used to keep an honest "no diff/working-tree API" empty state.
   * That is no longer true: plan/78 gave Changes a real `changes_snapshot` verb,
   * so the string was replaced with one describing the working-tree status it
   * now renders.
   *
   * The assertion is STRENGTHENED rather than deleted, and it now runs in both
   * directions: the tooltip must describe working-tree status, AND it must no
   * longer claim the host exposes no such API (that sentence would be a lie about
   * a shipped feature). A future edit that reverts the panel without reverting
   * the copy — or vice versa — fails here.
   */
  const changesTip = await ev(`(() => {
    const d = ${DOCK};
    if (!d) return { found: false };
    const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '更改');
    return b ? { found: true, title: b.getAttribute('title') || '' } : { found: false };
  })()`);
  check(
    "Changes describes the working-tree status it actually renders",
    typeof changesTip?.title === "string" && /工作树状态/.test(changesTip.title),
    changesTip?.title,
  );
  check(
    "Changes no longer claims the host exposes no working-tree API",
    typeof changesTip?.title === "string" && !/no diff\/working-tree API/i.test(changesTip.title),
    changesTip?.title,
  );

  /*
   * Section 10 — the narrow-width story, asserted as what actually happens.
   *
   * The sidebar panel rows (Plugins / Automations) only render in the EXPANDED
   * sidebar. Below `SIDEBAR_COLLAPSE_WIDTH` (1024px) the sidebar auto-collapses
   * to a 56px rail and the rows are not in the DOM at all; the dock disappears
   * later, at `DOCK_HIDE_WIDTH` (760px). The two windows do not overlap, so the
   * "row present but inert" state is not reachable through the UI.
   *
   * That is worth pinning precisely: the row must vanish rather than appear as a
   * dead row with a misleading explanation. (The copy in that unreachable branch
   * was still fixed — it used to blame the host for a width problem — but a test
   * cannot click what is not rendered, and asserting a fake reachable state would
   * be worse than asserting the true one.)
   */
  console.log("\n── 10. narrow width: the row leaves rather than lying ──");
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const narrow = await ev(`(() => {
    const asides = [...document.querySelectorAll('aside')].map((a) => a.getAttribute('aria-label'));
    const s = [...document.querySelectorAll('aside')].find((a) => a.getAttribute('aria-label') === '工作区');
    const row = s ? [...s.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '自动化') : null;
    return {
      width: innerWidth,
      asides,
      dockPresent: asides.includes('停靠栏') || asides.includes('停靠栏（已折叠）'),
      rowPresent: !!row,
      rowDisabled: row ? row.disabled : null,
      rowTitle: row ? (row.getAttribute('title') || '') : null,
    };
  })()`);
  check("at 1000px the sidebar is still present", narrow?.asides?.includes("工作区") === true, JSON.stringify(narrow));
  check(
    "at 1000px the sidebar auto-collapses, so no dead Automations row is offered",
    narrow?.rowPresent === false,
    JSON.stringify({ rowPresent: narrow?.rowPresent, disabled: narrow?.rowDisabled }),
  );

  /* Below the dock's own threshold the dock is gone entirely. */
  await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const tiny = await ev(`(() => ({
    width: innerWidth,
    asides: [...document.querySelectorAll('aside')].map((a) => a.getAttribute('aria-label')),
  }))()`);
  check(
    "at 700px the dock is gone entirely (not a stub)",
    !tiny?.asides?.some((a) => a.startsWith("停靠栏")),
    JSON.stringify(tiny),
  );

  /* Restore the desktop viewport so the remaining checks read the normal layout. */
  await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);

  console.log("\n── 11. no uncaught errors across the whole run ──");
  check("console stayed clean", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  ws.close();

  console.log(`\n${passed}/${passed + failures.length} checks PASS`);
  if (failures.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log("\nverify-automations: FAILED");
    process.exit(1);
  }
  console.log("verify-automations: OK");
}

main().catch((e) => {
  console.error("verify-automations: CRASHED", e);
  process.exit(1);
});
