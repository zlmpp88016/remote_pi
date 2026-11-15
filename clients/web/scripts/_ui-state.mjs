/**
 * Shared UI preconditions for the browser-driven Web gates.
 *
 * Several gates measure elements that only exist in a particular UI state: the
 * workspace rows need the sidebar expanded, the session rows live in the right
 * dock's 会话 tab, and the composer dock only exists on the LIVE session. Each
 * gate used to assume that state was already on screen, which held when they
 * were run one at a time against a warm dev tab but NOT inside
 * `npm run verify:web`: an earlier runner navigates the page, so the later gate
 * measured an empty document and reported a product failure.
 *
 * Establishing the fixture is the test's job. Nothing here relaxes an
 * assertion — it only puts the page into the state the assertions describe.
 *
 * THE FIXTURE IS ASSERTED, NOT JUST LOGGED. Every caller used to `console.log`
 * the observed state and carry on, so a fixture that never became ready
 * degraded into a slow, unexplained failure downstream (9 s + up to 60 s + 6×10 s
 * of retries, then an assertion about a document that was never set up). This
 * module RETURNS a parsed state object with `ok` and `reason`, and every caller
 * asserts it via `assertUiReady`. `ok` is false — fail-closed — when the page
 * never landed on `APP_ORIGIN`, when the sidebar stayed collapsed, when the dock
 * is neither open nor reported unavailable by the product, or (for `wantRows`
 * callers) when the session list never populated.
 *
 * THE TOGGLES ARE FOUND BY THE PRODUCT'S OWN TITLE/ARIA STRINGS. The previous
 * `[class*=_toggleRail_]` / `[class*=_dockButtonRail_]` selectors depended on a
 * CSS-module class naming convention: present in the current build, but a naming
 * change would silently match nothing and the fixture would read "already
 * expanded" for a collapsed rail. `title` + `aria-pressed` are part of the
 * shipped UI contract (`workspace-sidebar.tsx:191-208` for the sidebar toggle,
 * `:600-625` for the dock toggle, `right-rail.tsx:479-490` for the collapsed
 * dock's own expander) and they distinguish collapsed from expanded without
 * knowing anything about generated class names.
 *
 * The window must be sized by the browser launch flag (`--window-size`), not by
 * `Emulation.setDeviceMetricsOverride`: an emulation override is per-CDP-session
 * and Chrome reverts it when the calling script detaches.
 */

import { APP_ORIGIN, evaluate, sleep } from "./_cdp.mjs";

/** The EXPANDED right dock. The collapsed rail is `停靠栏（已折叠）`, a different label. */
export const DOCK_OPEN = `document.querySelector('aside[aria-label="停靠栏"]')`;
/** The product's own wording for "the dock cannot open at this width". */
export const DOCK_UNAVAILABLE = "该宽度下右侧停靠栏不可用";
/** The product's own title on whichever control opens the dock. */
export const DOCK_EXPAND_TITLE = "显示右侧停靠栏";
/** The dock's session-list tab label (`right-rail.tsx:59`). */
export const SESSIONS_TAB = "会话";

/**
 * Put the page on the live session with both rails expanded and the session
 * list populated.
 *
 * @param send - CDP send function from `attach()`.
 * @param opts - `{ navigate?: boolean, wantRows?: boolean }`. `navigate` defaults
 *   to true; pass false when the caller already drove the page itself.
 * @returns `{ ok, reason, landed, sidebarExpanded, dockOpen, dockAvailable, sessionRows, ... }`.
 *   Callers MUST assert `ok` with `assertUiReady`; the rest is diagnostic.
 */
export async function ensureUiReady(send, opts = {}) {
  const { navigate = true, wantRows = true } = opts;
  const wantOrigin = new URL(APP_ORIGIN).origin;

  if (navigate) {
    await evaluate(send, `location.href=${JSON.stringify(APP_ORIGIN + "/")}`);
    await sleep(9000);
    // The public lane's RTT plus a cold workspace means the live transcript can
    // take much longer than the initial settle. Measuring before it hydrates
    // makes every state report "not rendered", which is a fixture failure
    // masquerading as a product one.
    for (let i = 0; i < 60; i += 1) {
      const n = await evaluate(send, `document.querySelectorAll('[class*=agentTurn]').length`);
      if (n > 0) break;
      await sleep(1000);
    }
  }

  /*
   * Expand the sidebar if it is collapsed. `aria-pressed` mirrors the product's
   * `rail` flag (true === collapsed), so this is a state query rather than a
   * guess about which class the build emitted.
   */
  await evaluate(
    send,
    `(() => {
      const sb = document.querySelector('aside[aria-label="工作区"]');
      if (!sb) return false;
      const toggle = [...sb.querySelectorAll('button[aria-pressed]')].find((b) => /侧栏/.test(b.getAttribute('title') || ''));
      if (!toggle) return false;
      if (toggle.getAttribute('aria-pressed') === 'true') toggle.click();
      return true;
    })()`,
  );

  /*
   * Open the right dock when it is collapsed. The control that opens it carries
   * the product's `显示右侧停靠栏` title in both layouts; when the viewport is
   * too narrow the product says so on the same control instead, and that is a
   * legitimate state rather than a fixture failure.
   */
  const dockAttempt = await evaluate(
    send,
    `(() => {
      if (${DOCK_OPEN}) return 'already open';
      const buttons = [...document.querySelectorAll('button')];
      const expand = buttons.find((b) => (b.getAttribute('title') || '').startsWith(${JSON.stringify(DOCK_EXPAND_TITLE)}));
      if (expand) { expand.click(); return 'clicked'; }
      if (buttons.some((b) => (b.getAttribute('title') || '').includes(${JSON.stringify(DOCK_UNAVAILABLE)}))) return 'unavailable';
      return 'no toggle';
    })()`,
  );

  await sleep(3500);

  let sessionRows = 0;
  if (wantRows) {
    /*
     * The collapsed rail has no 会话 button, and expansion is not instantaneous.
     * Retry the whole open-and-count step rather than clicking once and hoping:
     * a single attempt left `sessionRows: 0`, which the gates then reported as a
     * product failure.
     */
    sessionRows = await openSessionsTab(send);
  }

  const state = await readState(send);
  const landed = state.origin === wantOrigin;
  const dockAvailable = dockAttempt !== "unavailable";
  const rows = wantRows ? sessionRows : state.sessionRows;
  /*
   * `ok` requires exactly the preconditions the caller asked for, and nothing it
   * did not. `wantRows` callers need the dock (the 会话 tab lives in it); a
   * token-only caller needs the app document and its `:root`, so coupling it to
   * the dock would invent a failure it cannot act on.
   */
  const ok =
    landed &&
    state.sidebarExpanded &&
    (!wantRows || (state.dockOpen || !dockAvailable) && rows > 0);

  return {
    ok,
    reason: ok
      ? null
      : !landed
        ? `page is on ${state.origin || "(unknown)"}, want ${wantOrigin}`
        : !state.sidebarExpanded
          ? "sidebar is still collapsed (its toggle reports aria-pressed=true)"
          : !state.dockOpen && dockAvailable
            ? "right dock never opened (no 显示右侧停靠栏 toggle matched)"
            : "session list never populated (no Read session rows)",
    landed,
    wantOrigin,
    dockAttempt,
    dockAvailable,
    wantRows,
    ...state,
    sessionRows: rows,
  };
}

/**
 * Throw when the fixture did not become ready. A closed gate is a bug in the
 * gate's precondition, never a fact about the document — so it must be loud, and
 * it must name the step that failed rather than grade whatever page was loaded.
 *
 * @param state - value returned by `ensureUiReady`.
 * @param gate - the calling gate's name, used in the error message.
 */
export function assertUiReady(state, gate) {
  if (state.ok) return state;
  throw new Error(
    `${gate}: UI fixture is not ready (${state.reason}); origin=${state.origin || "unknown"} ` +
      `sidebarExpanded=${state.sidebarExpanded} dockOpen=${state.dockOpen} ` +
      `dockAttempt=${state.dockAttempt} sessionRows=${state.sessionRows}`,
  );
}

/**
 * Open the dock's 会话 tab and wait for the session rows it renders.
 * @returns the observed row count (0 when the state could not be reached).
 */
export async function openSessionsTab(send) {
  let rows = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const step = await evaluate(
      send,
      `(() => {
        const dock = ${DOCK_OPEN};
        if (!dock) {
          const expand = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(DOCK_EXPAND_TITLE)}));
          if (expand) { expand.click(); return 'expanding'; }
          return 'no dock';
        }
        const tab = [...dock.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(SESSIONS_TAB)});
        if (tab) { tab.click(); return 'opened'; }
        return 'no sessions tab';
      })()`
    );
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000);
      rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
      if (rows > 0) return rows;
    }
    /* A dock that does not exist at all is not something a retry can fix. */
    if (step === "no dock") return 0;
  }
  return rows;
}

/** Observed document state, as a parsed object (never a stringified blob). */
export function readState(send) {
  return evaluate(
    send,
    `(() => {
      const q = (s) => document.querySelectorAll(s).length;
      const sb = document.querySelector('aside[aria-label="工作区"]');
      const toggle = sb
        ? [...sb.querySelectorAll('button[aria-pressed]')].find((b) => /侧栏/.test(b.getAttribute('title') || ''))
        : null;
      return JSON.stringify({
        origin: location.origin,
        sidebarPresent: !!sb,
        sidebarExpanded: !!toggle && toggle.getAttribute('aria-pressed') === 'false',
        wsActive: q('[class*=wsNameActive]'),
        wsIdle: q('[class*=wsNameIdle]'),
        sessionRows: q('[aria-label^="Read session"]'),
        agentTurns: q('[class*=agentTurn]'),
        dockOpen: !!document.querySelector('aside[aria-label="停靠栏"]'),
        dockCollapsedRail: !!document.querySelector('aside[aria-label="停靠栏（已折叠）"]'),
        width: innerWidth,
      });
    })()`,
  ).then((raw) => JSON.parse(raw));
}
