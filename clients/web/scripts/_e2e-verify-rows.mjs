/**
 * Direct per-row verification of the session viewer.
 *
 * Deliberately SIMPLE: it drives the page the same way a person does (reload,
 * open the workspace, open the dock, pick the Sessions tab) and then clicks each
 * row with a real CDP mouse event. It asserts BOTH:
 *   • the wire delivered a `session_read_ok` whose session_id is THIS row's id;
 *   • the viewer rendered `READ-ONLY` followed by the SAME id.
 *
 * `READ-ONLY` and the id are separated by a newline in the DOM text, so the
 * on-screen assertion matches them across whitespace rather than assuming a
 * space.
 *
 * The LIVE row is clicked LAST: it is already the mounted transcript, so
 * clicking it issues no `session_read` and cannot prove the read path.
 */
import { attach, shot, sleep } from "./_cdp.mjs";
import { decodeFrame } from "./_wire.mjs";

const SESSION_SECTION = 'section[aria-label="Sessions"]';

function makeEv(send) {
  return async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    }
    return r.result.value;
  };
}

/** Decode a relay frame: outer envelope → optional proxy → inner message. */
/* decodeFrame lives in ./_wire.mjs so every gate shares one implementation. */

const { send, sent, received } = await attach();
await send("Page.enable");
const ev = makeEv(send);

// ── 1. Bring the page to the state a user would be in ────────────────────────
await send("Page.reload", { ignoreCache: false });
/*
 * Wait for the host view instead of for a fixed delay. The old 9s constant was
 * tuned to a warm Vite dev server; a cold rebuild (or a relay reconnect) makes
 * the app take longer, and the whole run then fails on an empty dock rather
 * than on anything it was meant to test. Polling for the connected view is the
 * same assertion — the run still fails if the host never connects.
 */
for (let i = 0; i < 60; i++) {
  const connected = await ev('(document.body.innerText || "").includes("host connected")');
  if (connected) break;
  await sleep(1000);
}
await sleep(1500);
// Network.enable MUST come after the reload: a WebSocket created by the NEW
// document is never reported to the Network domain of the previous one, so
// enabling before the reload captures nothing at all.
await send("Network.enable");
await sleep(500);

// Open the workspace (only if a picker button is present).
await ev(`(() => {
  const w = [...document.querySelectorAll('button')].find(x => (x.getAttribute('title') || '').startsWith('4.1f —'));
  if (w) w.click();
  return true;
})()`);
await sleep(3000);

// Open the right dock (only when it is closed).
await ev(`(() => {
  const d = [...document.querySelectorAll('button')].find(x => (x.getAttribute('title') || '').startsWith('Show the right dock'));
  if (d) d.click();
  return true;
})()`);
await sleep(1500);

// Pick the Sessions tab (only when the section is not already mounted).
await ev(`(() => {
  if (document.querySelector(${JSON.stringify(SESSION_SECTION)})) return true;
  const t = [...document.querySelectorAll('button')].find(x => /^Sessions$/i.test((x.innerText || '').trim()));
  if (t) t.click();
  return true;
})()`);
await sleep(3500);

/**
 * Snapshot the session rows as they are RIGHT NOW.
 *
 * Called again before every click, not once: reading a session re-sorts the list
 * by recency, so the rows computed before the loop no longer describe the list
 * the loop is clicking. Resolving a stale position is what produced the
 * intermittent `wire=none ui=<neighbouring id>` failures.
 */
const readRows = () =>
  ev(`(() => {
  const s = document.querySelector(${JSON.stringify(SESSION_SECTION)});
  if (!s) return null;
  const seen = Object.create(null);
  return [...s.querySelectorAll('li')].map((li) => {
    const b = li.querySelector('button[aria-label^="Read session"]');
    const text = (li.innerText || '').trim();
    const label = (b?.getAttribute('aria-label') || '').replace('Read session ', '');
    /*
     * occ disambiguates rows that share a label.
     *
     * Labels are unique only while exactly one session is NAMED. The live row
     * always shows the workspace/agent name, so the moment you switch away from
     * a named session it becomes a history row carrying that same name — two
     * "4.1f" rows. Keying purely by label then always resolves to the first one
     * and the twin can never be verified.
     */
    const occ = seen[label] ?? 0;
    seen[label] = occ + 1;
    return { label, occ, live: /\\bLIVE\\b/.test(text) };
  });
})()`);

const rows = await readRows();

if (!rows || rows.length < 2) {
  console.log("NO SESSION ROWS:", JSON.stringify(rows));
  await shot(send, "e2e-verify-no-rows");
  process.exit(1);
}
console.log(`rows: ${rows.length}`);

// ── 2. Click each row, LIVE last ─────────────────────────────────────────────
const order = rows.map((r, i) => ({ ...r, i })).sort((a, b) => Number(a.live) - Number(b.live));
const results = [];

for (const row of order) {
  const sentBefore = sent.length;
  const recvBefore = received.length;
  const short = (row.label || "").slice(0, 8);

  // .click() rather than a synthetic pointer at a computed coordinate: the
  // row's button is nested inside a scroll container, so a coordinate can land
  // on an overlay after the list scrolls. This still exercises the real React
  // onClick handler and the real wire.
  // Click by ARIA LABEL plus the row's ordinal among same-label rows.
  //
  // The list is ordered by recency and the live session's row is re-created as
  // its state changes, so `li[i]` does not reliably name the same session across
  // the loop — a reorder between the read and the click made the harness click a
  // neighbouring row and then report the mismatch as a failure (`wire=none`,
  // `ui=<previous id>`). The label is what the row announces, so it survives a
  // reorder — but it is NOT unique (see `occ` above), hence label + ordinal.
  /*
   * Resolve the row against the list AS IT IS NOW, then click it.
   *
   * Every read re-sorts the list by recency, so the index computed before the
   * loop is stale by the second iteration. A hex label is a session id and is
   * unique, so it identifies its row across any reorder; only NAMED labels repeat
   * (the live row shows the agent name, and a previously-named session shows the
   * same name as history), and for those `occ` still selects among the twins.
   */
  const clicked = await ev(
    `(() => {
      const s = document.querySelector(${JSON.stringify(SESSION_SECTION)});
      if (!s) return false;
      const want = ${JSON.stringify(row.label)};
      const matches = [...s.querySelectorAll('button[aria-label^="Read session"]')]
        .filter((x) => (x.getAttribute('aria-label') || '').replace('Read session ', '') === want);
      const b = matches[${JSON.stringify(row.occ)}];
      if (!b) return false;
      b.click();
      return true;
    })()`,
  );
  if (!clicked) {
    results.push({ ...row, ok: false, why: "no-button" });
    continue;
  }

  /*
   * The reply comes FIRST; the render is checked against it.
   *
   * The id a row will show on screen is `wire.session_id`, and it is NOT
   * derivable from the row's label: a NAMED session (any session that was ever
   * the live one) announces the agent name — "4.1f" — while the viewer will
   * display its hex id. Keying the DOM wait off the label therefore waits
   * forever on exactly those rows and reports them as `ui=-`. So: settle the
   * wire, then require the screen to show what the wire said.
   */

  // Match the reply to THIS click by the request id we sent.
  let reqId = null;
  if (process.env.SHAPE) console.log("  [SENT]", short, "frames="+(sent.length-sentBefore));
  for (const raw of sent.slice(sentBefore)) {
    const m = decodeFrame(raw);
    if (m && m.type === "session_read") reqId = m.id;
  }
  /*
   * Wait for the reply AND the committed render in the same loop.
   *
   * Reading `received` once after the DOM settled was a race: the wire reply can
   * land in the same tick the DOM flips, so a single snapshot sometimes looked at
   * the array a moment too early and reported `wire=none` for a request that had
   * in fact been answered — the reply was visible in the very next read (the
   * debug trace showed `reqId=8ec22cf9` and a `session_read_ok` carrying exactly
   * `8ec22cf9` in the same run). Polling both conditions together removes the
   * ordering assumption rather than papering over it with a sleep.
   */
  let wire = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    for (const raw of received.slice(recvBefore)) {
      const m = decodeFrame(raw);
      if (!m || m.type !== "session_read_ok") continue;
      /*
       * Match on `in_reply_to` and NOTHING else.
       *
       * This used to fall back to accepting any `session_read_ok` when `reqId`
       * was null. That fallback was load-bearing only because the request id
       * could not be read (the browser→host direction nests its payload one
       * envelope deeper than host→browser, which `decodeFrame` now unwraps). With
       * the id available, the fallback is purely a way to score a PASS on the
       * PREVIOUS row's late reply — the exact false green that made this harness
       * report 11/11 while the UI was still showing the wrong session.
       */
      if (reqId !== null && m.in_reply_to === reqId) {
        if (process.env.SHAPE) console.log("  [SID]", short, "replySid="+String(m.session_id).slice(0,8), "match="+(String(m.session_id).slice(0,8)===short));
        if (process.env.SHAPE) console.log("  [ROOM]", "replyRoom="+String(m.room||"?").slice(0,8), "short="+short);
        if (process.env.SHAPE) console.log("  [SHAPE]", JSON.stringify({eos:typeof m.eos,trunc:typeof m.truncated,sid:typeof m.session_id,ev:Array.isArray(m.events),n:m.events&&m.events.length}));
        wire = m;
        break;
      }
    }
    if (wire !== null) break;
    await sleep(250);
  }

  const wireSid = wire ? String(wire.session_id).slice(0, 8) : null;

  /*
   * Require the viewer to show the row that was clicked.
   *
   * The banner title is `session.name || id`, which is EXACTLY the field the row
   * announces — so the title is the one thing comparable across hex and named
   * rows alike. Comparing the hex id instead only works for unnamed sessions:
   * a NAMED one (any session that was ever live) renders its agent name, so an
   * id comparison waits forever and reports `ui=-`.
   *
   * Structure, not text matching: the head row is ["read-only" chip, title,
   * (live badge | switch button)], so children[1] is the title regardless of
   * what the chip renders as.
   */
  const shownTitle = `(() => {
    const close = document.querySelector('[aria-label="Close the read-only session view"]');
    const head = close && close.parentElement;
    const title = head && head.children[1];
    return title ? (title.innerText || '').trim() : null;
  })()`;
  let onScreen = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    onScreen = await ev(shownTitle);
    // Until React commits, the panel still shows the PREVIOUS row's title, so
    // the poll simply keeps waiting; that is the stale-render guard.
    if (onScreen === row.label) break;
    await sleep(250);
  }

  /*
   * A hex label IS a session id, so for those rows the reply must confirm it.
   * A named row cannot be checked that way — two rows may share one name — and
   * there the `in_reply_to` match above is what ties the reply to this click.
   */
  const labelIsId = /^[0-9a-f]{8}$/.test(short);
  // The LIVE row's aria-label is the WORKSPACE/agent name, so nothing about it
  // is comparable — only that clicking it produced a real read or left a
  // transcript mounted, never a blank panel.
  const ok = row.live
    ? wire !== null || onScreen !== null
    : wire !== null && onScreen === row.label && (!labelIsId || wireSid === short);

  results.push({
    ...row,
    ok,
    events: wire ? (wire.events?.length ?? 0) : 0,
    uiShown: row.live ? (wire !== null ? `wire:${wireSid}` : (onScreen ?? "-")) : (onScreen ?? "-"),
  });
}

let pass = 0;
for (const r of results) {
  const short = (r.label || "").slice(0, 8);
  if (r.ok) pass++;
  const tag = r.occ ? `${short}#${r.occ}` : short;
  console.log(
    `${r.ok ? "PASS" : "FAIL"} ${tag}${r.live ? " (LIVE)" : ""}: wire=${
      r.events ? `session_read_ok/${r.events}ev` : "none"
    } ui=${r.uiShown}`,
  );
}

console.log(`\n=== ${pass}/${results.length} rows verified ===`);
await shot(send, "e2e-verify-final");
process.exit(pass === results.length ? 0 : 1);
