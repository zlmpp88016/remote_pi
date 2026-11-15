/**
 * Reset the browser to a clean page load, between gates.
 *
 * The browser gates share ONE real Chrome and ONE real host session. Several of
 * them resume a session or start a new one, which permanently changes what the
 * next gate sees — the viewed session, the live transcript, whether a reader is
 * open. Without a reset, running them in sequence produced a different set of
 * failures on every run, which is worse than useless: it looks like a regression
 * and moves each time you look at it.
 *
 * A plain reload is what a user would do, and it is enough: the page reconnects,
 * re-adopts the live room and re-hydrates from the host. The rest of the work —
 * selecting a workspace and opening the dock's 会话 tab, because several gates
 * assert on session ROWS that do not exist until both have happened — is the
 * SAME fixture every gate uses (`_ui-state.mjs`), so it lives there instead of
 * being reimplemented here with its own copy of the selectors.
 *
 * WHY THIS MATTERS: this file used to carry a private copy that waited for
 * `host connected` and clicked a `Sessions` button. Neither string exists in
 * `src` (the pill reads 已连接主机, the tab reads 会话), so the reset always spent
 * its full 40 s + 20 s + 90 s budget and reported "0 session rows" — a reset that
 * never reset anything, while looking like it did.
 */
import { attach } from "./_cdp.mjs";
import { ensureUiReady } from "./_ui-state.mjs";

const { send, ws } = await attach();
const state = await ensureUiReady(send);
ws.close();
console.log(
  `reset: origin=${state.origin} sidebarExpanded=${state.sidebarExpanded} ` +
    `dockOpen=${state.dockOpen} rows=${state.sessionRows}` +
    (state.ok ? "" : ` — NOT READY (${state.reason})`),
);
/*
 * Exit non-zero when the reset could not establish the fixture.
 *
 * `run-web-checks.mjs` treats a failed reset as reported-by-the-gate and keeps
 * going, which is right — the gate that follows re-establishes the fixture and
 * asserts it. Staying silent here is what made "0 session rows" look like a fact
 * about the host rather than a broken reset.
 */
process.exitCode = state.ok ? 0 : 1;
