/**
 * End-to-end CHAT latency in a REAL browser against the REAL daemon.
 *
 * This is the measurement the goal actually asks for: pair for real, send a
 * real message, and time how long until the user's own bubble is on screen.
 *
 * The pairing code is read from the host (`remote-pi pair` prints it as a
 * `remotepi://pair?...` URI) and pasted into the real form, exactly like a user
 * would. The pending turn is then submitted and the DOM is polled.
 *
 * Two numbers matter:
 *   • send → own bubble painted. With the optimistic local echo this must be
 *     sub-frame-ish (a few ms + one paint), NOT a relay round trip.
 *   • send → first agent byte. That one legitimately depends on the host and
 *     the model, so it is REPORTED, not asserted against a tight bound.
 *
 * Usage: node scripts/e2e-chat.mjs --uri="remotepi://pair?..." [--message=hi]
 * Requires: browser with --remote-debugging-port (CDP_PORT, default 9333).
 */

const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const URL_ARG = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length)
  ?? "http://localhost:3000/remote-pi/connect";
const PAIR_URI = process.argv.find((a) => a.startsWith("--uri="))?.slice("--uri=".length) ?? "";
const MESSAGE = process.argv.find((a) => a.startsWith("--message="))?.slice("--message=".length)
  ?? "reply with exactly: pong";

let passed = 0;
const failures = [];
const notes = [];
function check(label, ok, extra = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

async function connectCdp() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) {
    page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    for (const l of listeners) l(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, on: (fn) => (listeners.add(fn), () => listeners.delete(fn)), close: () => ws.close() };
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cdp = await connectCdp();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const pageErrors = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
  });

  console.log(`\n1. abrindo ${URL_ARG}`);
  await cdp.send("Page.navigate", { url: URL_ARG });
  // A cold profile needs much longer than a warm one: the first load compiles
  // the route and fetches every chunk. Poll for the form instead of sleeping a
  // fixed amount, or the pairing-code field is not there yet and the run fails
  // with "expected 2 fields, got 0".
  let formReady = false;
  const formDeadline = Date.now() + 90_000;
  while (Date.now() < formDeadline) {
    const ready = await evaluate(
      cdp,
      `(() => document.querySelectorAll('input, textarea').length >= 2)()`,
    ).catch(() => false);
    if (ready) { formReady = true; break; }
    await sleep(500);
  }
  check("o formulário de pareamento montou", formReady === true);

  if (PAIR_URI === "") {
    console.log("   [SKIP] nenhum --uri fornecido; medindo só o lado do DOM");
  } else {
    // ── pair for real, through the real form ─────────────────────────────
    console.log("\n2. pareando pelo formulário real");
    // The launcher is an address + code pair, NOT a single URI field:
    // field 1 is "Relay address" (placeholder wss://…) and field 2 is
    // "Pairing code" (placeholder remotepi://pair?…). Filling the URI into the
    // first field makes the client read it as a relay address and the submit
    // fails with "That pairing code could not be read".
    const filled = await evaluate(
      cdp,
      `(() => {
        const uri = ${JSON.stringify(PAIR_URI)};
        const inputs = [...document.querySelectorAll('input, textarea')]
          .filter(i => !i.disabled && !i.readOnly);
        if (inputs.length < 2) return { ok: false, reason: 'expected 2 fields, got ' + inputs.length };
        const set = (el, value) => {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // The pairing code carries its own relay in \`r=\`, so the address field
        // is left as the user found it (the adapter prefers the code's relay).
        set(inputs[1], uri);
        return { ok: true, fields: inputs.length, code: inputs[1].value.slice(0, 32) };
      })()`,
    );
    check("o campo de pairing code foi preenchido", filled?.ok === true, JSON.stringify(filled));

    const submitted = await evaluate(
      cdp,
      `(() => {
        const form = document.querySelector('form');
        if (!form) return { ok: false, reason: 'no form' };
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return { ok: true };
      })()`,
    );
    check("o formulário foi submetido", submitted?.ok === true, JSON.stringify(submitted));

    // Wait for the host view (transcript + composer) to replace the launcher.
    let connected = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const phase = await evaluate(
        cdp,
        `(() => {
          const body = document.body.innerText || '';
          return {
            hasComposer: !!document.querySelector('textarea'),
            hasTranscript: /max-w-\\[848px\\]/.test(document.body.innerHTML),
            busy: /restoring|connecting|pairing|authenticating/i.test(body),
            // Full sentences only: a bare /failed/ also matches the still-present
            // launcher copy, which produced dozens of bogus "error" notes.
            err: (body.match(/[A-Z][^.!?\\n]*(?:could not be read|Pairing failed|refused)[^.!?\\n]*/i) || [])[0] || null,
          };
        })()`,
      );
      if (phase.hasComposer && phase.hasTranscript) { connected = true; break; }
      if (phase.err) { notes.push(`launcher: ${phase.err.trim()}`); }
      await sleep(500);
    }
    check("pareou e o host view montou", connected === true, connected ? "" : notes.slice(-2).join("; "));

    if (connected) {
      // ── select a RUNNING workspace ────────────────────────────────────
      // The composer is disabled until a workspace is selected (the empty state
      // says "Pick a workspace on the left"), so sending before this point is a
      // silent no-op — which is exactly what made the first measurement read
      // `appeared:false`.
      console.log("\n2b. selecionando um workspace que está rodando");
      // The rail collapses below 1024px; force a desktop viewport so the
      // workspace list is reachable.
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(1200);

      const picked = await evaluate(
        cdp,
        `(() => {
          const buttons = [...document.querySelectorAll('button')];
          // The row reads like "4.1frunning" (name + status, no separator).
          const running = buttons.find(b => /running/i.test(b.textContent || '') && !/start|restart/i.test(b.textContent || ''));
          if (!running) return { ok: false, reason: 'no running workspace row', seen: buttons.map(b => (b.textContent||'').trim().slice(0,24)).filter(Boolean).slice(0,12) };
          running.click();
          return { ok: true, name: (running.textContent||'').trim().slice(0,32) };
        })()`,
      );
      check("um workspace running foi selecionado", picked?.ok === true, JSON.stringify(picked));

      // Wait for the composer to actually enable.
      let composerReady = false;
      const readyDeadline = Date.now() + 20_000;
      while (Date.now() < readyDeadline) {
        const enabled = await evaluate(
          cdp,
          `(() => { const t = document.querySelector('textarea'); return !!t && !t.disabled; })()`,
        );
        if (enabled) { composerReady = true; break; }
        await sleep(300);
      }
      check("o composer ficou habilitado", composerReady === true);

      if (composerReady) {
      // ── measure send → own bubble ─────────────────────────────────────
      console.log("\n3. medindo send → própria bolha (echo otimista)");
      const timing = await evaluate(
        cdp,
        `(async () => {
          const text = ${JSON.stringify(MESSAGE)};
          const area = document.querySelector('textarea');
          if (!area) return { ok: false, reason: 'no textarea' };
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(area, text);
          area.dispatchEvent(new Event('input', { bubbles: true }));

          // The bubble is the rounded user pill; match on the exact text so a
          // stale bubble from a previous turn cannot be mistaken for this one.
          const bubbleWith = () => [...document.querySelectorAll('div')]
            .find(el => el.className.includes('14px_14px_4px_14px') && el.textContent.trim() === text);

          const before = !!bubbleWith();
          const t0 = performance.now();
          const form = area.closest('form');
          form.requestSubmit();
          // Poll on rAF: this is the same clock the browser paints on, so the
          // number is "paints until visible", not "arbitrary timer resolution".
          let elapsed = null;
          for (let frame = 0; frame < 120; frame += 1) {
            await new Promise(r => requestAnimationFrame(r));
            if (!before && bubbleWith()) { elapsed = performance.now() - t0; break; }
          }
          return { ok: true, elapsed, appeared: !!bubbleWith(), before };
        })()`,
        { awaitPromise: true },
      );
      console.log(`   resultado: ${JSON.stringify(timing)}`);
      check("a própria bolha apareceu", timing?.appeared === true, JSON.stringify(timing));
      if (typeof timing?.elapsed === "number") {
        console.log(`   SEND→PAINT = ${timing.elapsed.toFixed(1)}ms`);
        // One frame at 60Hz is ~16.7ms. Allow a generous multiple for the dev
        // server's first-paint cost, but a relay round trip would be far worse.
        check(
          "SEND→PAINT é sub-segundo (não espera round trip)",
          timing.elapsed < 1000,
          `${timing.elapsed.toFixed(1)}ms`,
        );
      }

      // ── first agent byte ─────────────────────────────────────────────
      console.log("\n4. send → primeiro byte do agente");
      const firstByte = await evaluate(
        cdp,
        `(async () => {
          const t0 = performance.now();
          const agentText = () => {
            // The agent row is the one under the "Pi" header; measure any growth
            // of the markdown container as "a byte arrived".
            const rows = [...document.querySelectorAll('div')].filter(
              el => el.className.includes('min-w-0 break-words')
            );
            return rows.reduce((n, el) => n + el.textContent.length, 0);
          };
          const start = agentText();
          for (let i = 0; i < 2400; i += 1) {
            await new Promise(r => setTimeout(r, 50));
            if (agentText() > start) return { arrived: true, elapsed: performance.now() - t0 };
          }
          return { arrived: false, elapsed: performance.now() - t0 };
        })()`,
        { awaitPromise: true },
      );
      console.log(`   resultado: ${JSON.stringify(firstByte)}`);
      if (firstByte?.arrived) {
        console.log(`   FIRST BYTE = ${(firstByte.elapsed / 1000).toFixed(2)}s`);
        notes.push(`first byte: ${(firstByte.elapsed / 1000).toFixed(2)}s`);
      } else {
        notes.push("nenhum byte de agente em 120s (host pode estar ocupado)");
      }
      // Reported, not asserted: the host and the model own this number.
      }
    }
  }

  check("nenhuma exceção não tratada na página", pageErrors.length === 0, pageErrors.slice(0, 3).join("; "));
  cdp.close();
}

try {
  await main();
} catch (error) {
  console.error(`\nERRO FATAL: ${error?.message ?? error}`);
  failures.push(`fatal: ${error?.message ?? error}`);
}

console.log("");
for (const n of notes) console.log(`   nota: ${n}`);
if (failures.length === 0) {
  console.log(`${passed}/${passed} checks PASS`);
  console.log("e2e-chat: OK");
  process.exit(0);
} else {
  console.log(`${passed}/${passed + failures.length} checks PASS`);
  console.log(`${failures.length} check(s) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
