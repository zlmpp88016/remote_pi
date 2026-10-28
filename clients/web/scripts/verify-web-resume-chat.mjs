/**
 * Regression gate: after `Resume here`, the resumed session must be USABLE and
 * must show THAT session's history.
 *
 * Three defects this locks down, all of which shipped:
 *
 *  1. The composer was not in the DOM. `TranscriptPanel` swaps the read-only
 *     viewer for the transcript+composer, so leaving the viewer mounted after a
 *     resume produced history the user could read but not reply to.
 *  2. The client never sent `session_sync` and never handled `session_history`,
 *     so the resumed transcript was blank.
 *  3. Even with both wired, the transport DISCARDED `session_history`: it
 *     arrived carrying the `in_reply_to` of a fire-and-forget request that
 *     registers no pending entry, so it was filed as `unknown_reply`. The host
 *     had answered with 33 events; the client threw them away.
 *
 * The assertion is deliberately specific: the live transcript must contain the
 * resumed session's own FIRST MESSAGE, read from its row label. A generic
 * "turns > 0" check passed even with the transcript dropped, because a leftover
 * turn from the previous session satisfied it.
 *
 * Real browser, real host, real click. No fake transport.
 */
import { attach, evaluate, sleep, shot } from "./_cdp.mjs";

const RESUME_TIMEOUT_MS = 120_000;
const HYDRATE_TIMEOUT_MS = 150_000;

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function ok(msg) { console.log("OK:", msg); }

const { send, ws } = await attach();

async function state() {
  return evaluate(send, `(function(){
    var t=document.body.innerText;
    return {
      turns: document.querySelectorAll('[class*=userRow],[class*=agentRow]').length,
      len: t.length,
      empty: t.indexOf('no turns yet') >= 0,
      hasComposer: !!document.querySelector('textarea'),
      hasViewer: !!document.querySelector('[aria-label="Close the read-only session view"]'),
      hasResume: [...document.querySelectorAll('button')].some(function(x){return (x.textContent||'').indexOf('Resume here')>=0}),
      text: t
    };
  })()`);
}

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await state();
    if (pred(last)) return { ok: true, state: last, ms: Date.now() - start };
    await sleep(1000);
  }
  return { ok: false, state: last, ms: Date.now() - start, label };
}

async function openSessions() {
  await evaluate(send, `(function(){
    var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim()==='Sessions'});
    if(b){b.click(); return 1} return 0})()`);
}

// --- Known-good starting point.
await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(16000);
await evaluate(send, `(function(){var b=document.querySelector('[class*=wsButton]');if(b)b.click();return !!b})()`);
await sleep(4000);
await openSessions();
// A reader left open from an earlier run replaces the pane the dock needs.
await evaluate(send, `(function(){
  var c=document.querySelector('[aria-label="Close the read-only session view"]');
  if(c)c.click(); return !!c})()`);
await sleep(2500);
await openSessions();

// The list can come back as "Could not load this workspace's sessions" while the
// host is mid-respawn. Retrying is what a user does; it is not the defect here.
let rows = 0;
for (let attempt = 0; attempt < 5 && rows === 0; attempt += 1) {
  rows = await evaluate(send, `document.querySelectorAll('[aria-label^=\"Read session\"]').length`);
  if (rows === 0) {
    await evaluate(send, `(function(){
      var b=[...document.querySelectorAll('button')].find(function(x){return /refresh the session list/i.test(x.getAttribute('aria-label')||'')});
      if(b){b.click(); return 1} return 0})()`);
    await sleep(4000);
    await openSessions();
  }
}

if (rows === 0) {
  fail("no session rows: cannot exercise Resume here");
} else {
  ok(`session list rendered (${rows} rows)`);

  // --- Choose a NON-live row: the row carrying the live badge is already the
  //     running session and has no `Resume here` control.
  let target = null;
  const count = Math.min(rows, 12);
  for (let i = count - 1; i >= 0 && target === null; i -= 1) {
    const probe = await evaluate(send, `(function(){
      var r=[...document.querySelectorAll('[aria-label^="Read session"]')];
      var el=r[${i}]; if(!el) return null;
      var li=el.closest('li');
      return {live: !!(li && li.querySelector('[class*=liveBadge]')),
              label: (el.getAttribute('aria-label')||'').replace('Read session ','')};
    })()`);
    if (probe === null || probe.live) continue;
    // The label is the session's own first message — the fingerprint the live
    // transcript has to reproduce once it hydrates.
    if (!probe.label || probe.label.length < 12) continue;
    await evaluate(send, `(function(){
      var r=[...document.querySelectorAll('[aria-label^="Read session"]')];
      if(r[${i}])r[${i}].click(); return 1})()`);
    const read = await waitFor(s => s.hasViewer && s.hasResume, 30_000, "read");
    if (read.ok) target = { index: i, label: probe.label.slice(0, 40) };
  }

  if (target === null) {
    fail("no non-live session could be opened for resume");
  } else {
    ok(`picked row ${target.index}: "${target.label}"`);

    const clicked = await evaluate(send, `(function(){
      var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').indexOf('Resume here')>=0});
      if(!b) return 'missing';
      if(b.disabled) return 'disabled';
      b.click(); return 'clicked';
    })()`);

    if (clicked !== "clicked") {
      fail(`Resume here control was ${clicked}`);
    } else {
      const composer = await waitFor(s => s.hasComposer && !s.hasViewer, RESUME_TIMEOUT_MS, "composer");
      if (!composer.ok) {
        fail(`composer never appeared after Resume here (hasComposer=${composer.state?.hasComposer}, hasViewer=${composer.state?.hasViewer})`);
      } else {
        ok(`composer is in the DOM (${composer.ms}ms) and the viewer is gone`);

        // The transcript must hydrate with THIS session's content. Without the
        // correlation fix the host's answer is dropped and this never matches.
        const fingerprint = target.label.slice(0, 24);
        const hydrated = await waitFor(
          s => s.turns > 0 && !s.empty && s.text.indexOf(fingerprint) >= 0,
          HYDRATE_TIMEOUT_MS,
          "hydrate",
        );
        if (!hydrated.ok) {
          fail(`resumed transcript never showed this session's history (turns=${hydrated.state?.turns}, empty=${hydrated.state?.empty}, containsFingerprint=${hydrated.state ? hydrated.state.text.indexOf(fingerprint) >= 0 : "n/a"})`);
        } else {
          ok(`transcript hydrated with this session's own history: ${hydrated.state.turns} turns, ${hydrated.state.len} chars (${hydrated.ms}ms)`);

          /*
           * The point of resuming is to CONTINUE the conversation, so a
           * transcript you can read but not reply to is not a fix. Actually
           * type into the composer and submit.
           */
          const marker = `resume-gate-${Date.now()}`;
          const typed = await evaluate(send, `(function(){
            var ta=document.querySelector('textarea');
            if(!ta) return 'no textarea';
            var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
            setter.call(ta, ${JSON.stringify(`Reply with exactly: ${marker}`)});
            ta.dispatchEvent(new Event('input',{bubbles:true}));
            return 'typed';
          })()`);
          if (typed !== "typed") {
            fail(`could not type into the resumed composer (${typed})`);
          } else {
            await sleep(500);
            const submitted = await evaluate(send, `(function(){
              var b=document.querySelector('button[type=submit]');
              if(!b) return 'no submit';
              if(b.disabled) return 'submit disabled';
              b.click(); return 'sent';
            })()`);
            if (submitted !== "sent") {
              fail(`resumed composer could not submit (${submitted})`);
            } else {
              const echoed = await waitFor(s => s.text.indexOf(marker) >= 0, 60_000, "echo");
              if (!echoed.ok) {
                fail(`the message never appeared in the resumed transcript (${marker})`);
              } else {
                ok(`the resumed session accepted a message (${echoed.ms}ms)`);

                /*
                 * Appearing on screen only proves the client optimistically
                 * echoed it. Re-reading the session from disk proves it was
                 * actually PERSISTED into the session the user resumed, which is
                 * what "you can talk in this session now" has to mean.
                 */
                /*
                 * The list is re-fetched after a switch, so the live badge may not
                 * be painted yet. Re-clicking is what issues a fresh
                 * `session_read`; the host may also not have flushed the turn to
                 * disk at the instant of the first attempt, so a single read can
                 * legitimately miss a message that IS stored.
                 */
                let reread = "no live row";
                for (let attempt = 0; attempt < 12 && reread !== "clicked"; attempt += 1) {
                  reread = await evaluate(send, `(function(){
                    var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
                    if(!rows.length) return 'no rows';
                    for(var i=0;i<rows.length;i++){
                      var li=rows[i].closest('li');
                      if(li && li.querySelector('[class*=liveBadge]')){ rows[i].click(); return 'clicked'; }
                    }
                    return 'no live row';
                  })()`);
                  if (reread !== "clicked") {
                    await evaluate(send, `(function(){
                      var b=[...document.querySelectorAll('button')].find(function(x){return /refresh the session list/i.test(x.getAttribute('aria-label')||'')});
                      if(b){b.click(); return 1} return 0})()`);
                    await sleep(2000);
                  }
                }
                if (reread !== "clicked") {
                  fail(`could not re-read the session to verify persistence (${reread})`);
                } else {
                  let persisted = null;
                  for (let attempt = 0; attempt < 10 && persisted === null; attempt += 1) {
                    if (attempt > 0) {
                      await evaluate(send, `(function(){
                        var c=document.querySelector('[aria-label="Close the read-only session view"]');
                        if(c) c.click();
                        return 1})()`);
                      await sleep(1500);
                      await evaluate(send, `(function(){
                        var rows=[...document.querySelectorAll('[aria-label^="Read session"]')];
                        for(var i=0;i<rows.length;i++){
                          var li=rows[i].closest('li');
                          if(li && li.querySelector('[class*=liveBadge]')){ rows[i].click(); return 1; }
                        }
                        return 0})()`);
                    }
                    const hit = await waitFor(s => s.text.indexOf(marker) >= 0, 12_000, "persist");
                    if (hit.ok) persisted = hit;
                  }
                  if (persisted === null) {
                    fail(`the message was not persisted into the session file (${marker})`);
                  } else {
                    ok(`the message survived a re-read from disk (${persisted.ms}ms)`);
                  }
                }
              }
            }
          }
        }
      }
    }
    await shot(send, "gate-resume-chat");
  }
}

ws.close();
console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
