/**
 * Capture the pre-migration visual baseline.
 *
 * Run BEFORE any framework change, and again after each migration step to prove
 * the render is unchanged. Byte-identical PNGs are the acceptance evidence: a
 * pixel diff would hide a one-pixel shift, while bytes do not.
 *
 * WHY A FIXED VIEWPORT AND NO ANIMATION: the comparison only means something if
 * every capture is taken under identical conditions. The window size is pinned,
 * the scroll position is reset, and the "settle" wait is generous enough for the
 * fonts and the first paint to finish — a capture taken mid-load differs for
 * reasons that have nothing to do with the code.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN } from "./_cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * Two output directories, and the split is the whole point: the baseline is
 * written ONCE (before a migration) and never again, while each verification run
 * writes to . An earlier version wrote both to the same path,
 * which made every comparison compare the working tree to itself — the diff was
 * always zero and the baseline was silently destroyed.
 *
 *  freezes; anything else (the default) compares.
 */
const MODE = process.env["PARITY_MODE"] === "baseline" ? "baseline"
  : process.env["PARITY_MODE"] === "reference" ? "reference"
  : "current";
const EVIDENCE = join(HERE, "_e2e-evidence", MODE);

/** The surfaces under parity.
 *
 *  `clearStorage` matters: the browser used for the baseline is already paired,
 *  so a plain visit to `/remote-pi/connect` shows the paired shell. To capture
 *  the connection form as its own baseline the pairing has to be removed first.
 *  The paired shot is taken LAST and restores the credential, so the ordering is
 *  load-bearing — moving the paired entry earlier would leave the following
 *  captures looking at a signed-out page. */
const TARGETS = [
  { name: "docs", path: "/remote-pi/docs", settle: 3000 },
  { name: "connect-unauth", path: "/remote-pi/connect", settle: 7000, clearStorage: true },
  { name: "connect-paired", path: "/remote-pi/connect", settle: 11000, selectWorkspace: true, restoreStorage: true },
  /* `/` renders the same client as `/remote-pi/connect` by design (the root IS
     the web client), so it is captured as a ROUTE-PARITY assertion rather than
     a separate design surface: the two shots must match each other. */
  { name: "root-parity", path: "/", settle: 8000 },
];

const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);

async function attach() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(new URL(APP_ORIGIN).host)) ?? list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target on the CDP port");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const resolve = pending.get(msg.id);
    if (resolve) {
      resolve(msg.result);
      pending.delete(msg.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  /**
   * Send one CDP command.
   *
   * EVERY COMMAND IS BOUNDED. A navigation destroys the execution context, and a
   * `Runtime.evaluate` issued in that window never gets a response — without a
   * timeout the whole capture hangs with no output and no error, which reads as
   * "the script exited early" rather than "one call stalled". The timeout turns
   * that into a visible failure naming the method.
   */
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout after 30s: ${method}`));
      }, 30_000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  const { send, close } = await attach();
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

  await send("Page.enable");

  /**
   * Re-applied before EVERY capture.
   *
   * Both emulations are reset by a navigation, so setting them once at the top
   * silently stops applying from the second target onward. That is exactly the
   * bug this comment exists to stop someone re-introducing: the first shot came
   * out stable while the later ones drifted, and the drift looked like a styling
   * regression instead of a harness problem.
   *
   * `prefers-reduced-motion` matters for more than animation: the stylesheet's
   * reduced branch also forces `.reveal { opacity: 1 }`, so without it the docs
   * page captures with every section still faded out.
   */
  const applyEmulation = async () => {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    // The viewport is pinned so the layout solves to the same column widths every
    // time; a different window size would change the responsive branch and make
    // the bytes incomparable.
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
  };
  await applyEmulation();

  const manifest = { capturedAt: new Date().toISOString(), viewport: { width: 1600, height: 1000 }, shots: [] };

  /* The pairing credential is captured once, before anything clears it, so the
     paired shot can put it back. Reading it after the clear would capture an
     empty store and the "restore" would silently do nothing. */
  await send("Page.navigate", { url: APP_ORIGIN + "/remote-pi/connect" });
  await sleep(6000);
  const savedStorage = await evaluate(
    "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))",
  );

  for (const target of TARGETS) {
    const url = APP_ORIGIN + target.path;

    if (target.clearStorage === true) {
      // Navigate first, then clear, then reload: clearing on a page that is
      // already showing the paired shell does not re-render it, so the shot
      // would still show a signed-in UI.
      await send("Page.navigate", { url });
      await applyEmulation();
      await sleep(3000);
      await evaluate("localStorage.clear()");
      await send("Page.reload");
      await applyEmulation();
      await sleep(target.settle);
    } else {
      await send("Page.navigate", { url });
      await applyEmulation();
      await sleep(3000);
      if (target.restoreStorage === true) {
        // Restore then reload: the page already mounted with an empty store, so
        // writing the credential without a reload leaves it looking signed out.
        await evaluate(`(() => {
          const saved = ${JSON.stringify(savedStorage)};
          for (const [k, v] of Object.entries(JSON.parse(saved))) localStorage.setItem(k, v);
        })()`);
        await send("Page.reload");
        await applyEmulation();
      }
      await sleep(target.settle);
    }

    // Reset scroll so a capture taken after the page restored a previous
    // position is not mistaken for a layout change.
    await evaluate("window.scrollTo(0, 0)");
    await sleep(400);

    if (target.selectWorkspace === true) {
      // The paired view needs a workspace open to exercise the three-column
      // shell; without it the capture would only show the empty state.
      await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => (x.getAttribute('title') || '').startsWith('4.1f —'),
        );
        if (b) b.click();
        return b !== undefined;
      })()`);
      await sleep(4000);
    }

    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(data, "base64");
    const file = join(EVIDENCE, `parity-${target.name}.png`);
    writeFileSync(file, buffer);
    const sha256 = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    manifest.shots.push({ name: target.name, path: target.path, file: `parity-${target.name}.png`, bytes: buffer.length, sha256 });
    console.log(`[BASE] ${target.name.padEnd(16)} ${String(buffer.length).padStart(7)} bytes  ${sha256}`);
  }

  writeFileSync(join(EVIDENCE, `parity-${MODE}.json`), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nmanifest: ${join(EVIDENCE, `parity-${MODE}.json`)}`);
  close();
}

await main();
