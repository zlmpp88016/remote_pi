/**
 * Regression gate: `New session` must be reachable from the keyboard, the way
 * DSH exposes it.
 *
 * DSH advertises Ctrl+N through `aria-keyshortcuts` and renders a `<kbd>` hint
 * (ui-sidebar `sidebar-root.client.spec.tsx:105`). We had the button and nothing
 * else, which is the one real behavioural gap left against DSH on this surface.
 *
 * Three things are asserted, and the third is the one that protects users:
 *
 *  1. `aria-keyshortcuts="Control+N"` is present and a `<kbd>` hint is rendered.
 *  2. Ctrl+N actually starts a session.
 *  3. Ctrl+N is IGNORED while the composer has focus.
 *
 * (3) matters because the composer is a textarea and Ctrl+N is an ordinary
 * editing key there. Before this gate the shell had NO focus guard at all, so
 * Ctrl+J in the composer toggled the dock — a layout change mid-sentence.
 *
 * Real browser, real dispatched key events. No synthetic handler calls.
 */
import { attach, evaluate, sleep, shot } from "./_cdp.mjs";

const SETTLE_MS = 90_000;

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function ok(msg) { console.log("OK:", msg); }

const { send, ws } = await attach();

async function state() {
  return evaluate(send, `(function(){
    var b=document.querySelector('[aria-label="New session"]');
    var kbd=b ? b.querySelector('[class*=newSessionKbd]') : null;
    var ta=document.querySelector('textarea');
    return {
      hasButton: !!b,
      disabled: b ? b.disabled : null,
      shortcuts: b ? b.getAttribute('aria-keyshortcuts') : null,
      title: b ? b.getAttribute('title') : null,
      kbdText: kbd ? kbd.textContent.trim() : null,
      kbdVisible: kbd ? kbd.offsetWidth > 0 : false,
      hasComposer: !!ta,
      composerFocused: ta ? document.activeElement === ta : false
    };
  })()`);
}

// --- Reach a connected page with a workspace selected.
await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16_000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return !!b})()`);
await sleep(4_000);

let st = await state();
if (!st.hasButton) {
  fail("the New session button is not rendered: cannot test its shortcut");
} else {
  /*
   * Wait for the button to be IDLE before inspecting it.
   *
   * Its tooltip and label change while a session is starting ("New session —
   * starting…"), and a previous gate can leave it mid-start. Asserting on the
   * busy label would fail on leftover state rather than on the feature.
   */
  for (let i = 0; i < 90 && st.disabled === true; i += 1) {
    await sleep(1000);
    st = await state();
  }

  // --- 1. Advertised the way DSH does it.
  if (st.shortcuts !== "Control+N") {
    fail(`aria-keyshortcuts must be "Control+N", got ${JSON.stringify(st.shortcuts)}`);
  } else {
    ok('aria-keyshortcuts="Control+N" is present');
  }
  if (st.kbdText !== "Ctrl+N" || !st.kbdVisible) {
    fail(`the <kbd> hint must be rendered and visible (text=${JSON.stringify(st.kbdText)}, visible=${st.kbdVisible})`);
  } else {
    ok("the Ctrl+N hint is rendered in the button");
  }
  if (!/Ctrl\+N/.test(st.title ?? "")) {
    fail(`the tooltip must mention the shortcut, got ${JSON.stringify(st.title)}`);
  } else {
    ok("the tooltip names the shortcut");
  }

  // --- 2. Ctrl+N must actually start a session.
  // The button is already idle here — the wait happens before the assertions.

  const pressed = await evaluate(send, `(function(){
    var ev=new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,bubbles:true,cancelable:true});
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`);
  if (pressed !== true) {
    fail("Ctrl+N was not handled: nothing called preventDefault, so no binding ran");
  } else {
    await sleep(400);
    const busy = await state();
    if (busy.disabled !== true) {
      fail(`Ctrl+N did not start a session (button stayed enabled, title=${JSON.stringify(busy.title)})`);
    } else {
      ok(`Ctrl+N started a session ("${busy.title}")`);

      // Let it settle so the focus test starts from a usable page.
      let settled = false;
      for (let i = 0; i < SETTLE_MS / 1000 && !settled; i += 1) {
        await sleep(1000);
        const s = await state();
        if (s.disabled === false) settled = true;
      }
      if (!settled) fail("the session never settled after Ctrl+N; cannot test the focus guard");
    }
  }

  // --- 3. The focus guard.
  st = await state();
  if (!st.hasComposer) {
    fail("no composer to focus: cannot verify that the shortcut is suppressed while typing");
  } else {
    const inField = await evaluate(send, `(function(){
      var ta=document.querySelector('textarea');
      ta.focus();
      var ev=new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,bubbles:true,cancelable:true});
      ta.dispatchEvent(ev);
      return {prevented: ev.defaultPrevented, focused: document.activeElement===ta};
    })()`);
    await sleep(500);
    const after = await state();
    if (inField.prevented === true) {
      fail("Ctrl+N was claimed while the composer had focus: the binding must not run there");
    } else if (after.disabled === true) {
      fail("Ctrl+N started a session while the composer had focus: the guard is missing");
    } else if (inField.focused !== true) {
      fail("the composer lost focus, so the guard was not exercised as intended");
    } else {
      ok("Ctrl+N is ignored while the composer has focus, and the caret stays put");
    }
  }
  await shot(send, "gate-ctrl-n");
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
