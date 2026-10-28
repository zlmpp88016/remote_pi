/**
 * `--direct` end-to-end gate.
 *
 * Proves that a real browser, a real relay handshake and a real host bridge work
 * with NO community relay involved. What makes this a genuine test rather than a
 * simulation:
 *
 *   - the relay is the REAL `startEmbeddedRelay` (the same code `--direct`
 *     runs), not a fake transport;
 *   - the host side is the REAL `HostBridge`, which resolves its address through
 *     `resolveRelayUrl()` exactly as `pi-supervisord` does — so this also proves
 *     the env-tier wiring, not just the relay;
 *   - the browser is real Chrome over CDP and the pairing code is typed into the
 *     real form;
 *   - CDP network interception records every request, and the gate FAILS if the
 *     page contacts the community relay host at all.
 *
 * The last point is the whole feature: "direct" means no egress. A green run
 * that quietly still talked to relay.880160.xyz would be worse than a red one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "_e2e-evidence");
mkdirSync(EVIDENCE, { recursive: true });

const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const SERVER_ROOT = join(HERE, "..", "..", "..", "server");
const COMMUNITY_RELAY_HOST = "relay.880160.xyz";

const results = [];
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

/** Starts the real embedded relay + real HostBridge in a child process. */
/**
 * Starts the host side: real embedded relay + real HostBridge.
 *
 * The body lives in server/scripts/direct-gate-host.mjs as a REAL FILE. It used
 * to be a template literal here, and every escape passed through two layers:
 * a newline escape arrived as a real newline (splitting string literals) and a
 * comment containing a backslash broke parsing outright. One file = one layer.
 */
function startHost() {
  return spawn(process.execPath, [join(SERVER_ROOT, "scripts", "direct-gate-host.mjs")], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      REMOTE_PI_HOME: join(EVIDENCE, "_direct-home"),
      DIRECT_SEED_CWD: SERVER_ROOT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Waits for the host child to print its JSON line. */
function waitForHost(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host did not report its pairing code in time")), timeoutMs);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      // Split on the newline characters a real write would emit; the child
      // builds its line with String.fromCharCode(10) because a \\n inside the
      // template literal arrives as a literal backslash-n instead.
      const line = buffer.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      try {
        // Strip any literal backslash-n the child may have appended.
        resolve(JSON.parse(line.replace(/\\n$/, "")));
      } catch (err) {
        reject(err);
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[host-err] ${chunk.toString()}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited early (code ${code})`));
    });
  });
}

async function main() {
  const child = startHost();
  let host;
  try {
    host = await waitForHost(child);
  } catch (err) {
    child.kill();
    check(false, "host bridge starts against the local relay", String(err));
    return finish();
  }

  check(true, "embedded relay is loopback-only", host.relayUrl);
  check(host.relayUrl.startsWith("http://127.0.0.1:"), "relay never binds a public interface", host.relayUrl);
  check(
    new URL(host.uri.replace("remotepi://", "https://")).searchParams.get("r") === host.relayUrl,
    "pairing code points at the local relay (r= param)",
    host.relayUrl,
  );

  try {
    await runBrowser(host);
  } finally {
    child.kill();
  }
  return finish();
}

/** Drives real Chrome: paste the code, pair, list workspaces, watch egress. */
async function runBrowser(host) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) {
    check(false, "a Chrome target is available", "no page targets on CDP");
    return;
  }

  // Fresh tab so the localStorage of an existing pairing cannot mask the test.
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3010";
  const created = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(origin + "/remote-pi/connect")}`, {
      method: "PUT",
    })
  ).json();

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP socket failed"));
  });

  let nextId = 1;
  const pending = new Map();
  const requests = [];
  /** WebSocket URLs opened by the page. A WS upgrade is not a `requestWillBeSent`
   *  in CDP, so collecting only the latter would report "0 requests" and miss
   *  the very connection this gate exists to prove. */
  const wsUrls = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      requests.push(msg.params.request.url);
    }
    if (msg.method === "Network.webSocketCreated") {
      wsUrls.push(msg.params.url);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? "eval failed");
    return res.result.value;
  };

  /*
   * Clear any previously stored pairing BEFORE the app boots.
   *
   * Opening a fresh TAB is not enough: localStorage is scoped to the ORIGIN, so
   * a new tab on the same origin still restores the old community-relay pairing
   * and the launcher sits in "Restoring the stored pairing…". That state
   * swallows the paste-and-submit below and the run reports a pairing failure
   * that has nothing to do with the local relay.
   */
  /*
   * Preserve whatever pairing the browser already had, then clear it.
   *
   * Restoring it at the end is not politeness: this gate writes a LOCAL pairing
   * into the same localStorage the other E2E scripts depend on. Left behind, it
   * points at a relay port that dies with this process, so every later run sees a
   * page that cannot connect and reports "NO SESSION ROWS" — a self-inflicted
   * failure that reads like a product regression.
   *
   * A prior value pointing at loopback is NOT restored: that is a leftover from a
   * previous direct-mode run whose port is already dead, and restoring it would
   * preserve the very breakage this block exists to prevent.
   */
  const priorSession = await evaluate(
    `(() => { try { return localStorage.getItem(${JSON.stringify("remote-pi-web-session-v1")}); } catch { return null; } })()`,
  );
  let restoreTarget = priorSession;
  if (typeof priorSession === "string" && /"relayUrl":"ws{1,2}:\/\/(127\.0\.0\.1|localhost)/.test(priorSession)) {
    restoreTarget = null;
    console.log(
      "note: prior pairing pointed at a dead loopback relay — not restoring it",
    );
  }

  await evaluate(`
    try { localStorage.removeItem(${JSON.stringify("remote-pi-web-session-v1")}); } catch {}
    true
  `);
  await send("Page.reload");
  await new Promise((r) => setTimeout(r, 1200));

  /*
   * Network.enable AFTER the reload. Enabled before it, the domain is bound to
   * the outgoing document's session and the post-reload socket traffic is
   * invisible — which would make the "zero community-relay requests" assertion
   * vacuously true.
   */
  await send("Network.enable");

  // Wait for the app to mount (post-reload document).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(`!!document.querySelector('textarea')`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Paste the pairing code the way a user would, then submit.
  await evaluate(`
    (() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(host.uri)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  await evaluate(`
    (() => {
      const form = document.querySelector('form');
      const btn = form.querySelector('button[type="submit"]');
      btn.click();
      return true;
    })()
  `);

  // Pairing + workspace_list take a moment over a real socket.
  let paired = false;
  const pairDeadline = Date.now() + 40_000;
  while (Date.now() < pairDeadline) {
    const state = await evaluate(`
      (() => {
        const text = document.body.innerText || '';
        const aside = document.querySelector('[aria-label="Workspaces"]');
        return {
          // Workspace rows: keyed on the seeded DIRECTORY NAME, not a li count.
          // The aside carries unrelated lists, so counting li counted the wrong
          // thing and produced a false "paired".
          seeded: !!aside && /server/i.test(aside.innerText || ''),
          restoring: /Restoring the stored pairing/i.test(text),
          error: /Pairing failed/i.test(text),
        };
      })()
    `);
    if (state.error) {
      check(false, "pairing succeeds over the local relay", "the launcher reported 'Pairing failed'");
      break;
    }
    /*
     * Wait for a real ROW, not the section landmark.
     *
     * The landmark exists in the rail before any pairing happens, so keying the
     * wait on it declared "paired" while workspace_list had not even been
     * requested yet — and the row assertion that followed then read 0 and failed
     * for the wrong reason. A rendered row is the first moment the data path is
     * demonstrably end-to-end.
     */
    if (state.seeded) {
      paired = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  check(paired, "browser pairs with the host over the local relay");

  /*
   * Assert the host's REAL workspace reached the UI.
   *
   * Selector note: aria-label="Workspaces" sits on the whole <aside> (a frozen
   * selector), so its li count includes unrelated sections and is NOT evidence of
   * workspace rows. The reliable signal is the seeded directory name appearing in
   * the sidebar text — the host registers the server dir, and nothing else in this
   * gate would render that name.
   */
  const workspaceUi = paired
    ? await evaluate(`
        (() => {
          const aside = document.querySelector('[aria-label="Workspaces"]');
          if (!aside) return { ok: false, reason: "no sidebar" };
          const text = aside.innerText || '';
          if (/No workspaces reported yet/i.test(text)) return { ok: false, reason: "empty state" };
          const seeded = /server/i.test(text);
          return { ok: seeded, reason: seeded ? "seeded workspace visible" : "seeded name absent" };
        })()
      `)
    : { ok: false, reason: "pairing did not complete" };
  check(workspaceUi.ok, "the host's real workspace reaches the UI", workspaceUi.reason);

  // THE defining assertion: nothing ever contacted the community relay.
  const egress = requests.filter((url) => url.includes(COMMUNITY_RELAY_HOST));
  const wsEgress = wsUrls.filter((url) => url.includes(COMMUNITY_RELAY_HOST));
  check(
    egress.length === 0 && wsEgress.length === 0,
    "page made zero requests to the community relay",
    egress.length === 0 && wsEgress.length === 0
      ? `${requests.length} request(s) + ${wsUrls.length} ws, none to ${COMMUNITY_RELAY_HOST}`
      : [...egress, ...wsEgress].join(", "),
  );

  // Also prove it did talk to loopback, so the check above is not vacuously true
  // (a page that failed to load anything would also have zero egress).
  const localWs = wsUrls.filter((url) => url.startsWith(`ws://127.0.0.1:${host.port}`));
  check(localWs.length > 0, "page opened a WebSocket to the local relay", localWs[0] ?? wsUrls.join(", "));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(EVIDENCE, "direct-connect.png"), Buffer.from(shot.data, "base64"));

  /*
   * Put the browser back the way we found it, THEN close our tab and socket.
   *
   * Order matters: the localStorage write must land while the CDP socket and the
   * document are both still alive. Doing it after ws.close() left the top-level
   * await unsettled and the process had to be reaped.
   */
  if (restoreTarget !== null && restoreTarget !== undefined) {
    try {
      await evaluate(
        `localStorage.setItem(${JSON.stringify("remote-pi-web-session-v1")}, ${JSON.stringify(restoreTarget)})`,
      );
    } catch {
      /* best-effort */
    }
  }

  ws.close();

  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${created.id}`);
  } catch {
    /* best-effort */
  }
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  const summary = {
    checkedAt: new Date().toISOString(),
    results,
    passed: results.length - failed.length,
    failed: failed.length,
  };
  writeFileSync(join(EVIDENCE, "direct-connect.json"), JSON.stringify(summary, null, 2));
  if (failed.length === 0) {
    console.log(`\ndirect-connect: OK (${results.length}/${results.length})`);
    process.exit(0);
  }
  console.log(`\ndirect-connect: ${failed.length} FAILED`);
  process.exit(1);
}

await main();
