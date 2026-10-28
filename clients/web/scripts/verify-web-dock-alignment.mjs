/**
 * The statistics dock must stay edge-aligned with the composer input at every
 * window width.
 *
 * The bug this guards against is geometric, so it is measured geometrically: the
 * left and right edges of the pill row are compared against the composer's own
 * box at several viewport widths. A visual "it looks fine" check at one width is
 * exactly what missed it the first time.
 */
import { attach, evaluate, sleep } from "./_cdp.mjs";

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}
function ok(msg) {
  console.log("OK:", msg);
}

const { send, ws } = await attach();

/** Read the composer box and the pill row box in the CURRENT viewport. */
const measure = () =>
  evaluate(send, `(function(){
    var form = document.querySelector('form');
    var dock = document.querySelector('[aria-label="Conversation statistics"]');
    if (!form) return { form: null, dock: null };
    var f = form.getBoundingClientRect();
    var d = dock ? dock.getBoundingClientRect() : null;
    return {
      form: { left: Math.round(f.left), right: Math.round(f.right), width: Math.round(f.width) },
      dock: d === null ? null : { left: Math.round(d.left), right: Math.round(d.right), width: Math.round(d.width) },
      viewport: window.innerWidth,
    };
  })()`);

await evaluate(send, `location.href='http://localhost:3010/'`);
await sleep(14_000);

// The dock only exists once the live transcript has hydrated.
for (let i = 0; i < 90; i += 1) {
  await sleep(1_000);
  const ready = await evaluate(send, `document.querySelector('[aria-label="Conversation statistics"]') !== null`);
  if (ready) break;
}
await sleep(1_500);

/*
 * Cover the widths the layout actually branches on: the composerPad breakpoints
 * are 1023 and 760, and DSH's own 860px cap means anything wider is the case
 * where the two boxes can drift apart most.
 */
const WIDTHS = [1600, 1280, 1024, 900, 760, 620];

for (const width of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(700);

  const m = await measure();
  if (m.form === null) {
    fail(`no composer at ${width}px`);
    continue;
  }
  if (m.dock === null) {
    fail(`no statistics dock at ${width}px`);
    continue;
  }

  /*
   * The dock carries the same inner padding as the composer's text, so compare
   * the OUTER boxes: they are expected to match within a pixel or two of
   * rounding, which is what "same width container" means here.
   */
  const leftDelta = Math.abs(m.dock.left - m.form.left);
  const rightDelta = Math.abs(m.dock.right - m.form.right);
  const widthDelta = Math.abs(m.dock.width - m.form.width);

  const detail =
    `form[${m.form.left}..${m.form.right}] ` +
    `dock[${m.dock.left}..${m.dock.right}] ` +
    `Δleft=${leftDelta} Δright=${rightDelta} Δwidth=${widthDelta}`;

  if (leftDelta > 2 || rightDelta > 2 || widthDelta > 2) {
    fail(`the dock is not aligned with the composer at ${width}px — ${detail}`);
  } else {
    ok(`aligned at ${width}px — ${detail}`);
  }
}

// Leave the emulation clean so later gates see the real window.
await send("Emulation.clearDeviceMetricsOverride", {});
console.log(process.exitCode === 1 ? "RESULT: FAIL" : "RESULT: PASS");
ws.close();
