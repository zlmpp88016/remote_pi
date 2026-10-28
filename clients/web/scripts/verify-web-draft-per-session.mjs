/**
 * Regression gate: a half-written message must survive a session switch.
 *
 * The draft used to be a single global string cleared by `resetChatState`, which
 * runs on every switch and every new session. Typing, clicking Resume, and losing
 * the text was therefore guaranteed — silently, with no undo.
 *
 * The gate types into the composer, forces a real session change, and then
 * requires the text to still be there. It also asserts the one case where the
 * draft SHOULD clear: after a successful send.
 */
import { attach, evaluate, sleep, shot } from "./_cdp.mjs";

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function ok(msg) { console.log("OK:", msg); }

const { send, ws } = await attach();

const DRAFT = "draft-survives-switch-";

async function composer() {
  return evaluate(send, `(function(){
    var ta=document.querySelector('textarea');
    return {
      present: !!ta,
      value: ta ? ta.value : null,
      rows: document.querySelectorAll('[aria-label^="Read session"]').length,
      live: (function(){
        var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
        for(var i=0;i<rows.length;i++){
          var li=rows[i].closest('li');
          if(li && li.querySelector('[class*=liveBadge]')) return rows[i].getAttribute('aria-label');
        }
        return null;
      })()
    };
  })()`);
}

/** Type into the React-controlled textarea so onChange actually fires. */
async function typeIntoComposer(text) {
  return evaluate(
    send,
    `(function(){
      var ta=document.querySelector('textarea');
      if(!ta) return false;
      var desc=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');
      desc.set.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return ta.value === ${JSON.stringify(text)};
    })()`,
  );
}

// Reach a connected page with the Sessions panel open.
/*
 * Block chat frames from leaving the browser.
 *
 * This gate needs to check "a successful send clears the draft", and the old
 * version clicked submit for real — which sent `draft-survives-switch-<ts>` into
 * whatever session was live and left those strings in that session's transcript
 * AND in the Pi's context. Test runs must not write to the user's real history.
 *
 * The interception is narrow on purpose: only a `send_chat` payload is dropped, so
 * the connection, the handshake and every other request keep working and
 * `handleSend` still runs its full path (including `setDraft("")`).
 */
await send("Page.enable", {});
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(function(){
    window.__blockedSends = [];
    if (window.__chatBlockHooked) return;
    window.__chatBlockHooked = 1;
    var OS = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data){
      try {
        var s = String(data);
        var m = /"ct":"([^"]+)"/.exec(s);
        if (m) {
          var inner = atob(m[1]);
          var inner2 = '';
          var m2 = /"ct":"([^"]+)"/.exec(inner);
          if (m2) { try { inner2 = atob(m2[1]); } catch (e) {} }
          /*
           * A chat payload is wrapped twice (host_forward -> the frame). The wire
           * type for a chat message is "user_message", NOT "send_chat" (that is
           * only the adapter method name) — matching the wrong string meant the
           * interceptor never fired and the test message reached the host.
           */
          if (inner2.indexOf('"user_message"') >= 0 || inner.indexOf('"user_message"') >= 0 || s.indexOf('user_message') >= 0) {
            window.__blockedSends.push(inner2.slice(0, 160));
            return;          // swallowed: nothing reaches the host
          }
        }
      } catch (e) {}
      return OS.call(this, data);
    };
  })()`,
});

await evaluate(send, `location.href='http://localhost:3010/'`);
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  const ready = await evaluate(send, `document.body.innerText.indexOf('host connected') >= 0`);
  if (ready) break;
}
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return 1})()`);
await sleep(3_000);
await evaluate(send, `(function(){
  var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
  if(b)b.click(); return 1})()`);
for (let i = 0; i < 60; i += 1) {
  await sleep(1000);
  const rows = await evaluate(send, `document.querySelectorAll('[aria-label^="Read session"]').length`);
  if (rows > 0) break;
}

let st = await composer();
if (!st.present) {
  fail("no composer to type into: cannot test draft preservation");
} else {
  const marker = `${DRAFT}${Date.now()}`;
  const typed = await typeIntoComposer(marker);
  if (typed !== true) {
    fail("the composer did not accept the typed text");
  } else {
    ok(`typed ${marker.length} chars into the composer`);

    /*
     * Force a real session change. Both paths run `resetChatState` — the exact
     * function that used to wipe the draft.
     *
     * Prefer switching to a non-live row (that is the resume path the user
     * reports), and fall back to New session when the workspace has only a live
     * session to offer.
     */
    const switched = await evaluate(send, `(function(){
      var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
      for(var i=0;i<rows.length;i++){
        var li=rows[i].closest('li');
        if(li && !li.querySelector('[class*=liveBadge]')){ rows[i].click(); return 1; }
      }
      return 0;
    })()`);
    if (switched !== 1) {
      console.log("   (no non-live row — using New session to force the change)");
      await evaluate(send, `(function(){
        var b=document.querySelector('[aria-label="New session"]');
        if(b) b.click(); return 1})()`);
      ok("triggered a session change via New session");
    } else {
      // Wait for the resume affordance and click it when it appears.
      let resumed = false;
      for (let i = 0; i < 30; i += 1) {
        await sleep(500);
        const clicked = await evaluate(send, `(function(){
          var b=[...document.querySelectorAll('button')].find(function(x){return /resume here/i.test(x.textContent||'')});
          if(b){ b.click(); return 1 } return 0})()`);
        if (clicked === 1) { resumed = true; break; }
      }
      if (!resumed) {
        console.log("   (no Resume here — using New session to force the change)");
        await evaluate(send, `(function(){
          var b=document.querySelector('[aria-label="New session"]');
          if(b) b.click(); return 1})()`);
        ok("triggered a session change via New session");
      } else {
        ok("triggered a session change via Resume here");
      }
    }

    /*
     * THE actual assertion, reached on BOTH paths.
     *
     * It used to live inside the `else` arm, so the New-session path fell through
     * to PASS without ever checking the draft — a green gate that verified
     * nothing. Structure matters as much as the assertion.
     *
     * The host respawns on a session change, so this polls generously: what is
     * being asserted is that the text comes back, not how quickly.
     */
    let seen = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000);
      const now = await composer();
      if (now.present && now.value !== null && now.value.indexOf(marker) >= 0) {
        seen = { ms: (i + 1) * 1000 };
        break;
      }
    }

    if (seen === null) {
      const now = await composer();
      fail(
        `the draft was lost across the session change ` +
          `(composer=${now.present ? JSON.stringify(now.value) : "absent"})`,
      );
    } else {
      ok(`the draft survived the session change (${seen.ms}ms)`);

      /*
       * The one case where the draft MUST clear: a successful send.
       *
       * The message itself is BLOCKED at the socket (see the interceptor above),
       * so nothing is written to the user's session while `handleSend` still runs
       * its real path. Asserting that a `send_chat` was attempted is what proves
       * the send actually happened in the app — without it, a draft that merely
       * cleared itself would pass this check for the wrong reason.
       */
      const sendable = await evaluate(send, `(function(){
        var b=document.querySelector('button[type=submit]');
        return b ? !b.disabled : false;
      })()`);
      if (sendable !== true) {
        console.log("   (submit is disabled here; skipping the clear-after-send check)");
      } else {
        await evaluate(send, `(function(){
          var b=document.querySelector('button[type=submit]'); if(b) b.click(); return 1})()`);
        let cleared = false;
        for (let i = 0; i < 20; i += 1) {
          await sleep(500);
          const now = await composer();
          if (now.value === "") { cleared = true; break; }
        }
        const blocked = await evaluate(send, `(window.__blockedSends || []).length`);
        if (blocked === 0) {
          fail(
            "no send_chat was intercepted, so the send never happened — " +
              "the cleared draft would prove nothing",
          );
        } else if (!cleared) {
          fail("the draft did not clear after a successful send (it would resend forever)");
        } else {
          ok(`the draft clears after a successful send (${blocked} send_chat frame(s) blocked at the socket)`);
        }
      }
    }
    await shot(send, "gate-draft-per-session");
  }
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
