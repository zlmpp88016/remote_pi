/**
 * Does the Sessions panel actually load? — 20 iterations.
 *
 * Each iteration is the full user path, from nothing:
 *   1. kill the daemon, wait for the port to be free
 *   2. start it fresh and wait until it answers
 *   3. reload the page (no cached sessions in memory)
 *   4. select a RUNNING workspace
 *   5. open the Sessions tab and time how long until it reaches a terminal
 *      state: a row list, or an error notice
 *
 * Anything still saying "Asking the host for this workspace's sessions…" at the
 * deadline is a FAILURE, and that is the exact bug being chased.
 *
 * Usage: node scripts/verify-sessions-20x.mjs [iterations]
 */
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";

const REPO = "D:/workspace/git_repo/remote_pi";
const SERVER = `${REPO}/server`;
const CDP = "http://127.0.0.1:9444";
const ORIGIN = "http://127.0.0.1:4124";



const ITERATIONS = Number(process.argv[2] ?? 20);
/** Generous: a cold start imports the SDK. */
const START_TIMEOUT_MS = 60_000;
/** A terminal state must be reached this fast, or the run counts as stuck. */
const TERMINAL_DEADLINE_MS = 30_000;

/* ---------------------------------------------------------------- daemon -- */

function portPids() {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    return [...out.matchAll(/:4124\s+\S+\s+LISTENING\s+(\d+)/g)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

async function stopDaemon() {
  for (const pid of portPids()) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 40; i += 1) {
    if (portPids().length === 0) return true;
    await sleep(250);
  }
  return false;
}

async function startDaemon() {
  stopDaemon();
  const out = spawn("node", ["dist/bin/supervisord.js", "--direct"], {
    cwd: SERVER,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  out.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(400);
    // A plain GET: /api/bootstrap needs a nonce cookie, so probing it would
    // always fail. Any HTTP answer at all proves the listener is up.
    try {
      await fetch(`${ORIGIN}/`, { redirect: "manual" });
      await sleep(1200);
      if (portPids().length > 0) return { ok: true, ms: START_TIMEOUT_MS - (deadline - Date.now()) };
    } catch {
      /* not up yet */
    }
  }
  return { ok: false };
}

/* ------------------------------------------------------------------- CDP -- */

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  /* Prefer the app tab: a stray about:blank or devtools target is also type "page"
   * and would make every probe answer from a blank document. */
  const page =
    targets.find((t) => t.type === "page" && /4124|127.0.0.1/.test(t.url || "")) ??
    targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target in Chrome");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let seq = 1;
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
      exceptions.push(String(msg.params?.exceptionDetails?.exception?.description ?? "").slice(0, 120));
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = seq++;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 160) };
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { ws, send, evaluate, exceptions };
}

const SIDEBAR = `[...document.querySelectorAll('aside')].find(a=>/工作区/.test(a.getAttribute('aria-label')||''))`;
const DOCK = `[...document.querySelectorAll('aside')].find(a=>/^停靠栏/.test(a.getAttribute('aria-label')||''))`;

/** Terminal-state probe for the Sessions panel. */
const PROBE = `(() => {
  const d = ${DOCK};
  if (!d) return { state: 'no-dock' };
  /* textContent, not innerText: this app's font applies ligatures that mangle innerText. */
  const text = d.textContent || '';
  const asking = /正在向主机请求该工作区的会话/.test(text);
  /* Rows are the ONLY proof the list loaded, so they are checked FIRST. Testing
     the sentences first made a loaded list report as 'empty' whenever the
     workspace happened to have zero rows, which hid the difference between
     "the host answered with nothing" and "nothing ever arrived". */
  const rows = [...d.querySelectorAll('li')].length;
  if (rows > 0) return { state: 'rows', rows };
  if (asking) return { state: 'asking' };
  if (/无法加载/.test(text)) return { state: 'error' };
  if (/须正在运行|未运行/.test(text)) return { state: 'not-running' };
  if (/该工作区没有会话/.test(text)) return { state: 'empty' };
  return { state: 'unknown', head: text.split(String.fromCharCode(10)).slice(6, 10).join(' | ') };
})()`;

async function oneIteration(n) {
  const started = await startDaemon();
  if (!started.ok) return { n, phase: "daemon", ok: false, detail: "daemon never answered" };

  const { ws, send, evaluate, exceptions } = await connect();
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${ORIGIN}/remote-pi/connect` });

    /* Wait for pairing, then for the workspace rows to arrive. */
    const bootDeadline = Date.now() + 40_000;
    let paired = false;
    while (Date.now() < bootDeadline) {
      await sleep(1000);
      const body = await evaluate(`document.body.innerText`);
      if (typeof body === "string" && /已连接主机|主机无响应/.test(body)) {
        paired = true;
        break;
      }
    }
    if (!paired) return { n, phase: "pair", ok: false, detail: "never paired" };

    /* The connect page hands off to the app shell once the pairing is stored.
     * Navigating explicitly is what makes the SIDEBAR and the DOCK exist at all —
     * without it every probe ran against the launcher, which has neither. */
    await send("Page.navigate", { url: `${ORIGIN}/` });
    await sleep(5000);
    await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1100, deviceScaleFactor: 1, mobile: false });

    /* Pick a workspace the catalog reports as running: a stopped one is gated by
       `disabledReason` and would never exercise the list at all. */
    const picked = await evaluate(`(() => {
      const side = ${SIDEBAR};
      if (!side) return 'no sidebar';
      const rows = [...side.querySelectorAll('button')]
        .filter((b) => (b.getAttribute('title') || '').includes(' · 运行中'));
      if (rows.length === 0) return 'no running workspace';
      // Prefer the workspace that actually HAS sessions on disk: an empty
      // workspace would let an empty list masquerade as a successful load.
      const preferred = rows.find((b) => /remote_pi/.test(b.getAttribute('title') || '')) ?? rows[0];
      preferred.click();
      return (preferred.getAttribute('title') || '').split('\\n')[0].slice(0, 60);
    })()`);
    if (typeof picked !== "string" || /^no /.test(picked)) {
      return { n, phase: "select", ok: false, detail: String(picked) };
    }

    await sleep(3000);
    /*
     * Wait for the CHOSEN workspace to actually be live before opening the tab.
     *
     * The daemon was just restarted, so every workspace has to come back up. A
     * fixed 3s sleep was measuring the tail of that startup: the tab was opened
     * while the room had no list yet, so the panel legitimately showed its empty
     * state and the iteration looked like a failure that had nothing to do with
     * the thing under test. Poll the sidebar for this workspace's live marker
     * instead of guessing a duration.
     */
    const liveDeadline = Date.now() + 45_000;
    let live = false;
    while (Date.now() < liveDeadline) {
      await sleep(1000);
      live = (await evaluate(`(() => {
        const side = ${SIDEBAR};
        if (!side) return false;
        const b = [...side.querySelectorAll('button')]
          .find((x) => (x.getAttribute('title') || '').includes(${JSON.stringify(String(picked).slice(0, 40))}));
        if (!b) return false;
        return /· 运行中/.test(b.getAttribute('title') || '');
      })()`)) === true;
      if (live) break;
    }
    if (!live) return { n, phase: "live", ok: false, detail: "workspace never went live", workspace: picked };
    const opened = await evaluate(`(() => {
      const d = ${DOCK};
      if (!d) return 'no dock';
      const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '会话');
      if (!b) return 'no sessions tab';
      b.click();
      return 'opened';
    })()`);
    if (opened !== "opened") return { n, phase: "open", ok: false, detail: String(opened) };

    const t0 = Date.now();
    let last = { state: "asking" };
    let sawEmpty = false;
    while (Date.now() - t0 < TERMINAL_DEADLINE_MS) {
      await sleep(400);
      last = (await evaluate(PROBE)) ?? { state: "probe-failed" };
      /*
       * An EMPTY list is NOT terminal for this measurement.
       *
       * Right after a daemon restart the workspace's Pi is up (the catalog says
       * "running") but its session index has not been rebuilt yet, so the first
       * `session_list` legitimately answers with zero rows and the panel shows
       * "No sessions in this workspace yet.". Treating that as the end state
       * recorded ~2s and reported a broken panel, when the same workspace shows
       * 11 rows a moment later. Keep waiting through it and remember that it
       * happened: a run that ends on `empty` after the full deadline is a real
       * miss, a run that ends on `rows` is a pass.
       */
      if (last.state === "empty") {
        sawEmpty = true;
        continue;
      }
      if (last.state !== "asking") break;
    }
    const ms = Date.now() - t0;

    /* ROWS is the only state that proves the list actually loaded. "empty" and
       "error" are terminal too, but an empty workspace would let a broken list
       pass as a success, so they are reported separately and counted as a
       miss for the purpose of this measurement. */
    const ok = last.state === "rows";
    return {
      n,
      phase: "done",
      ok,
      ms,
      state: last.state,
      probe: JSON.stringify(last).slice(0, 200),
      rows: last.rows ?? 0,
      workspace: picked,
      head: last.head ?? null,
      daemonMs: started.ms ?? null,
      exceptions: exceptions.length,
      sawEmpty,
    };
  } finally {
    ws.close();
  }
}

/* ------------------------------------------------------------------ main -- */

const results = [];
for (let i = 1; i <= ITERATIONS; i += 1) {
  let r;
  try {
    r = await oneIteration(i);
  } catch (err) {
    r = { n: i, ok: false, phase: "exception", detail: String(err).slice(0, 120) };
  }
  results.push(r);
  const tag = r.ok === true ? "OK  " : "FAIL";
  console.log(
    `${tag} #${String(i).padStart(2)} ${r.ok === true ? `${String(r.ms).padStart(5)}ms ${r.state}${r.rows ? ` (${r.rows} rows)` : ""}` : `${r.phase}: ${r.detail ?? r.state} rows=${r.rows} head=${JSON.stringify(r.head)}`}`,
  );
}

const passed = results.filter((r) => r.ok === true).length;
const stuck = results.filter((r) => r.state === "asking");
const times = results.filter((r) => typeof r.ms === "number").map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => (times.length === 0 ? 0 : times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]);

console.log(`\n${passed}/${results.length} iterations reached a terminal state`);
if (times.length > 0) {
  console.log(`time to sessions: min ${times[0]}ms · median ${pct(50)}ms · p90 ${pct(90)}ms · max ${times[times.length - 1]}ms`);
}
console.log(`stuck on "Asking…": ${stuck.length}`);
writeFileSync("/tmp/sessions-20x.json", JSON.stringify(results, null, 2));
if (passed !== results.length) process.exit(1);
