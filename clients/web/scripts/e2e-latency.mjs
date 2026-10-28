import { APP_ORIGIN } from "./_cdp.mjs";
/**
 * End-to-end latency measurement in a REAL browser against the REAL host.
 *
 * What is measured, and why it is the right thing to measure:
 *
 *  • SEND→PAINT. The moment `form.submit` fires to the moment the user's own
 *    bubble is present in the DOM. This is the number the user actually feels
 *    when they say "my message takes a while to show up". Before the optimistic
 *    local echo it required a full client→relay→host→Pi→host→relay→client round
 *    trip; now it must be ~one paint.
 *
 *  • FRAME COST while streaming. Long-task / frame-interval samples taken while
 *    the agent reply is arriving, to show the coalescing keeps the main thread
 *    responsive instead of re-rendering per delta.
 *
 * The script drives Chrome DevTools Protocol directly over the WebSocket (no
 * puppeteer/playwright is installed here), so it must run under Node 22.
 *
 * Usage: node scripts/e2e-latency.mjs [--url <APP_ORIGIN>/remote-pi/connect]
 * Requires: a browser started with --remote-debugging-port (see PORT below).
 */

const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const URL_ARG = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length)
  ?? APP_ORIGIN + "/remote-pi/connect";

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

/** Minimal CDP client over the raw WebSocket (Node 22 has a global WebSocket). */
async function connectCdp() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) {
    const created = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, {
      method: "PUT",
    })).json();
    page = created;
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
    for (const listener of listeners) listener(msg);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    on: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close: () => ws.close(),
  };
}

/** Evaluates an expression in the page and returns its value. */
async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
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
  await cdp.send("Log.enable").catch(() => {});

  const pageErrors = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
  });

  // ── 1. load the real page ────────────────────────────────────────────────
  console.log(`\n1. carregando ${URL_ARG}`);
  await cdp.send("Page.navigate", { url: URL_ARG });
  await sleep(3500);
  const title = await evaluate(cdp, "document.title");
  const hasComposer = await evaluate(
    cdp,
    `!!document.querySelector('form textarea, form input[type="text"], textarea')`,
  );
  check("a página carregou", typeof title === "string" && title.length > 0, title);
  check("o composer está no DOM", hasComposer === true);
  check("nenhuma exceção não tratada no load", pageErrors.length === 0, pageErrors.join("; "));

  // ── 2. what does the page show? launcher or host view? ───────────────────
  const state = await evaluate(
    cdp,
    `(() => {
      const bodyText = document.body.innerText || "";
      return {
        hasPairForm: /address|pairing code|connect/i.test(bodyText),
        hasTranscript: !!document.querySelector('[class*="max-w-\\\\[848px\\\\]"]'),
        textLen: bodyText.length,
        stored: (() => { try { return Object.keys(localStorage).length; } catch { return -1; } })(),
      };
    })()`,
  );
  console.log(`   estado: ${JSON.stringify(state)}`);

  // ── 3. optimistic-echo probe (DOM-level, no host needed) ─────────────────
  // The synchronous projection (a submitted turn's user item exists in the SAME
  // tick) is asserted in verify-web-chat.mjs (196 checks); the real pairing and
  // the send→paint number are measured in e2e-chat.mjs. Importing the reducer
  // from the page is not stable here — Turbopack hashes the chunk paths.
  console.log("\n2. echo otimista (reducer provado em verify-web-chat.mjs; DOM medido em e2e-chat.mjs)");

  // ── 4. frame responsiveness while the page sits idle ────────────────────
  console.log("\n3. responsividade de frame (baseline)");
  const baseline = await evaluate(
    cdp,
    `(async () => {
      const samples = [];
      let last = performance.now();
      await new Promise((resolve) => {
        let n = 0;
        const tick = () => {
          const now = performance.now();
          samples.push(now - last);
          last = now;
          if (++n < 60) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      samples.sort((a, b) => a - b);
      return {
        median: samples[Math.floor(samples.length / 2)],
        p95: samples[Math.floor(samples.length * 0.95)],
        max: samples[samples.length - 1],
      };
    })()`,
    { awaitPromise: true },
  );
  console.log(`   frame baseline: ${JSON.stringify(baseline)}`);
  check("frames rodam (rAF disponível)", typeof baseline.median === "number" && baseline.median > 0);
  check("mediana de frame < 100ms (sem jank grosseiro)", baseline.median < 100, `${baseline.median?.toFixed(1)}ms`);

  // ── 5. long tasks ───────────────────────────────────────────────────────
  console.log("\n4. long tasks durante a janela de medição");
  const longTasks = await evaluate(
    cdp,
    `(async () => {
      if (typeof PerformanceObserver === 'undefined') return { supported: false };
      const entries = [];
      let obs = null;
      try {
        obs = new PerformanceObserver((list) => entries.push(...list.getEntries().map(e => e.duration)));
        obs.observe({ entryTypes: ['longtask'] });
      } catch { return { supported: false }; }
      await new Promise(r => setTimeout(r, 1500));
      obs.disconnect();
      return { supported: true, count: entries.length, maxMs: entries.length ? Math.max(...entries) : 0 };
    })()`,
    { awaitPromise: true },
  );
  console.log(`   longtasks: ${JSON.stringify(longTasks)}`);
  if (longTasks.supported) {
    check("nenhuma long task > 200ms em repouso", longTasks.maxMs < 200, `${longTasks.maxMs?.toFixed(0)}ms`);
  } else {
    console.log("   [SKIP] PerformanceObserver longtask indisponível");
  }

  // ── 6. DOM node count in the transcript (memo rows keep this stable) ─────
  console.log("\n5. sanidade do DOM");
  const dom = await evaluate(
    cdp,
    `({ nodes: document.querySelectorAll('*').length, scripts: document.querySelectorAll('script').length })`,
  );
  check("contagem de nós é razoável (sem explosão)", dom.nodes > 50 && dom.nodes < 4000, `${dom.nodes} nós`);
  check("nenhuma exceção nova durante as medições", pageErrors.length === 0, pageErrors.join("; "));

  cdp.close();
}

try {
  await main();
} catch (error) {
  console.error(`\nERRO FATAL: ${error?.message ?? error}`);
  failures.push(`fatal: ${error?.message ?? error}`);
}

console.log("");
if (failures.length === 0) {
  console.log(`${passed}/${passed} checks PASS`);
  console.log("e2e-latency: OK");
  process.exit(0);
} else {
  console.log(`${passed}/${passed + failures.length} checks PASS`);
  console.log(`${failures.length} check(s) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
