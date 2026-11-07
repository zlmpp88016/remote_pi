/**
 * Capture a computed-style fingerprint of every element on a page.
 *
 * WHY THIS EXISTS: the four parity screenshots only cover the routes and the
 * states they visit. Most of this app's components — the slash menu, the model
 * picker, the session viewer's empty states — never appear in them, so a
 * translation mistake in those files would ship unverified. Screenshots also
 * report only "N pixels differ", which does not name the element at fault.
 *
 * This records, for every element in the rendered tree, the computed value of
 * the properties the migration can affect plus its geometry. Comparing two
 * captures is then an element-level oracle: it says exactly which element changed
 * and in which property, and it covers components the screenshots never reach.
 *
 * Elements are identified by their DOM path (tag names + sibling index), NOT by
 * class name — class names are precisely what the migration rewrites, so keying
 * on them would make every element look new.
 *
 * Usage:
 *   node scripts/capture-style-fingerprint.mjs <out.json> [--state paired]
 */

import { writeFileSync } from "node:fs";
import { attach, sleep , APP_ORIGIN } from "./_cdp.mjs";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: node scripts/capture-style-fingerprint.mjs <out.json> [--state paired|plain]");
  process.exit(2);
}

const stateArg = process.argv.indexOf("--state");
const state = stateArg >= 0 ? process.argv[stateArg + 1] : "plain";

const { send } = await attach();

/*
 * Pin the viewport for every capture.
 *
 * The shell's layout is width-dependent: below 1023px the dock collapses, and
 * below 760px the dock toggle is disabled entirely. Without an explicit
 * emulation the window size comes from whatever the browser was launched with,
 * so the same route can render a 24px toggle as enabled in one run and disabled
 * in the next — a difference in the viewport, not in the CSS. Setting the same
 * metrics the parity screenshots use makes the geometry a constant.
 *
 * `setEmulatedMedia` pins `prefers-reduced-motion: reduce`, matching the parity
 * captures: the app's own reduced-motion branch is the intended static
 * presentation, so it is the fair baseline for a style comparison.
 */
async function applyEmulation() {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
}
await applyEmulation();
const ev = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

/** Properties whose computed value the translation must not change. */
const PROPS = [
  "display", "position", "boxSizing", "width", "height",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderTopColor", "borderBottomColor", "borderLeftColor", "borderRightColor",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
  "backgroundColor", "backgroundImage", "color",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign",
  "textTransform", "textDecorationLine", "whiteSpace", "wordBreak", "overflowWrap", "textOverflow",
  "overflowX", "overflowY", "flexDirection", "flexGrow", "flexShrink", "flexBasis", "flexWrap",
  "justifyContent", "justifyItems", "alignItems", "alignSelf", "gap", "rowGap", "columnGap",
  "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow",
  "zIndex", "opacity", "visibility", "transform", "transition", "boxShadow", "outlineStyle",
  "cursor", "pointerEvents", "objectFit", "aspectRatio", "order", "minWidth", "minHeight",
  "maxWidth", "maxHeight", "top", "right", "bottom", "left", "inset",
];

/** Properties whose computed value is a colour and must be compared as one. */
const COLOUR_PROPS = new Set([
  "backgroundColor", "color", "borderTopColor", "borderRightColor",
  "borderBottomColor", "borderLeftColor", "outlineColor", "textDecorationColor",
  "caretColor", "columnRuleColor", "fill", "stroke",
]);

const ROUTES = [
  { name: "docs", url: APP_ORIGIN + "/remote-pi/docs" },
  // The `connect` route is paired here, so it renders the connected shell; it is
  // captured to assert that `/remote-pi/connect` and the shell states agree.
  { name: "connect", url: APP_ORIGIN + "/remote-pi/connect" },
  /*
   * The connection launcher.
   *
   * A paired client never shows it — the shell replaces it the moment a
   * credential is present — so this is the one state that needs the credential
   * REMOVED rather than restored. It is captured because the launcher is where a
   * first-time user lands: it holds the pairing form, the stored-pairing card and
   * the security disclosures, and none of that would be covered otherwise.
   */
  { name: "launcher", url: APP_ORIGIN + "/remote-pi/connect", unpaired: true, expectsConnection: false },
  // The not-found route is not reachable from the site nav, so it would go
  // unverified if only the linked routes were captured.
  { name: "not-found", url: APP_ORIGIN + "/no-such-page" },
  /*
   * The shell's INTERIOR, which the three route captures never reach.
   *
   * The connect route renders the launcher until a workspace is chosen; the
   * transcript, session list, dock, model picker and slash menu only exist after
   * interacting. Those components are exactly the ones being translated, so
   * leaving them out would mean translating their CSS with no oracle at all —
   * the failures would be invisible until someone used the app.
   *
   * Each entry names a state and the clicks that reach it. The clicks mirror what
   * a person does and are deliberately tolerant ("only if present"): the goal is
   * to arrive at the state, not to re-test the interaction itself, which the
   * row-by-row E2E already does.
   */
  {
    name: "shell-workspace",
    url: APP_ORIGIN + "/remote-pi/connect",
    settle: 11000,
    setup: "selectWorkspace",
  },
  {
    name: "shell-dock-sessions",
    url: APP_ORIGIN + "/remote-pi/connect",
    settle: 11000,
    setup: "openSessionsPanel",
    /*
     * The composer's two popups.
     *
     * The slash menu and the model picker live in the composer, and the composer
     * exists in the dock state — once a session is OPENED FOR READING the
     * transcript replaces it. So these are captured here, from the same
     * connection, with no extra relay handshake.
     *
     * They matter for correctness, not just coverage: both are styled through a
     * `@media (hover: hover)` plus `@supports` chain, whose failure mode is a
     * silently missing colour rather than a broken layout, so a screenshot review
     * would not catch it.
     *
     * `marker` is the DOM the variant must produce. Without it a variant that
     * failed to open its popup would be recorded as a second copy of the base
     * state — which compares clean against itself and hides the missing coverage.
     */
    variants: [
      {
        name: "shell-slash-menu",
        setup: "openSlashMenu",
        marker: `document.querySelector('[role="listbox"][aria-label="Skills"]')`,
      },
      {
        name: "shell-model-picker",
        setup: "openModelPicker",
        marker: `document.querySelector('button[aria-label^="Model: "][aria-expanded="true"]')`,
      },
    ],
  },
  {
    name: "shell-session-read",
    url: APP_ORIGIN + "/remote-pi/connect",
    settle: 12000,
    setup: "openSessionsPanelAndReadFirst",
  },
];

/**
 * Wait until the DOM stops changing.
 *
 * The shell fills in asynchronously: the host sends the workspace list, then the
 * session list, then a model catalogue that is cached to localStorage. Capturing
 * after a fixed sleep therefore samples an arbitrary point in that sequence, and
 * two captures of "the same" state differ by hundreds of elements. Waiting for
 * the element count to hold still for several consecutive samples makes the
 * capture reproducible, which is the only thing that makes the comparison
 * meaningful.
 *
 * Bounded by a deadline: a page that never settles must not hang the run, and a
 * timeout is reported rather than silently producing a half-loaded capture.
 */
async function waitForStableDom({ timeoutMs = 15_000, samples = 4, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const count = await ev(`document.querySelectorAll("body *").length`);
    if (count === last) {
      stable++;
      if (stable >= samples) return count;
    } else {
      stable = 0;
      last = count;
    }
    await sleep(intervalMs);
  }
  console.log(`    (DOM did not stabilise within ${String(timeoutMs)}ms; last count ${String(last)})`);
  return last;
}

/**
 * Wait until the app has finished its connection handshake AND stayed finished.
 *
 * Clearing storage drops the cached catalogue, so the client re-fetches from the
 * host and spends a while on "Restoring the stored pairing…". Capturing during
 * that window yields the launcher while capturing after it yields the shell —
 * the same route, two different screens.
 *
 * A single "not busy" sample is not enough: the launcher's `resuming` flag flips
 * false for a moment before the workspace list arrives, so a one-shot check
 * passes during a gap and the capture lands on the launcher. The check therefore
 * requires several consecutive settled samples.
 */
async function waitForSettledApp(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let settled = 0;
  let lastShape = "";
  while (Date.now() < deadline) {
    const busy = await ev(
      `/Restoring the stored pairing|Connecting|Asking the host/.test(document.body.innerText || "")`,
    );
    // Track the SHAPE of the page, not just the absence of a loading label.
    // The connect route swaps the launcher for the shell once the workspace list
    // arrives, and both render without a loading label for a moment in between,
    // so "not busy" alone alternates between the two screens. Requiring the same
    // shape across consecutive samples is what pins the capture to one of them.
    const shape = await ev(
      `(document.querySelector(".rp-app-shell") ? "shell" : "launcher") + ":" + document.querySelectorAll("body *").length`,
    );
    if (busy === false && shape === lastShape) {
      settled++;
      if (settled >= 4) return true;
    } else {
      settled = 0;
    }
    lastShape = shape;
    await sleep(500);
  }
  console.log("    (app still reporting a connection phase at timeout)");
  return false;
}

/**
 * Wait until an expression yields a truthy value.
 *
 * Setup steps depend on controls that appear asynchronously (the workspace
 * picker needs the host's workspace list). Clicking on a fixed delay races that
 * and silently does nothing when the control is late, so every step that depends
 * on host data waits for its target instead.
 */
async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await ev(`Boolean(${expression})`);
    if (ok === true) return true;
    await sleep(400);
  }
  console.log(`    (timed out waiting for ${expression.slice(0, 60)}…)`);
  return false;
}

/**
 * Drive the shell into the state a route entry asks for.
 *
 * Every step is conditional on the control being present. Re-clicking a toggle
 * that is already in the wanted state would move AWAY from it, and the captures
 * run against a live app whose state persists across navigations, so the checks
 * are what make the setup idempotent rather than order-dependent.
 */
async function applySetup(name) {
  const click = async (description, selector) => {
    const result = await ev(`(() => {
      const el = ${selector};
      if (!el) return "absent";
      el.click();
      return "clicked";
    })()`);
    console.log(`    ${description}: ${String(result)}`);
    return result;
  };

  if (name === "selectWorkspace" || name === "openSessionsPanel" || name === "openSessionsPanelAndReadFirst") {
    // Wait for the shell to finish connecting before looking for the picker.
    // Clearing localStorage drops the cached model catalogue, so the client
    // re-fetches it and sits on "Restoring the stored pairing…" for a while; the
    // workspace list only arrives after that.
    await waitFor(`/host connected/.test(document.body.innerText || "")`, 40_000);
    await waitFor(
      `[...document.querySelectorAll("button")].find((x) => (x.getAttribute("title") || "").startsWith("4.1f —"))`,
      30_000,
    );
    await click(
      "select workspace",
      `[...document.querySelectorAll("button")].find((x) => (x.getAttribute("title") || "").startsWith("4.1f —"))`,
    );
    await sleep(3000);
  }

  if (name === "openSessionsPanel" || name === "openSessionsPanelAndReadFirst") {
    // The dock toggle only exists while the dock is closed.
    await click(
      "open dock",
      `[...document.querySelectorAll("button")].find((x) => (x.getAttribute("title") || "").startsWith("Show the right dock"))`,
    );
    await sleep(1500);
    await waitFor(
      `document.querySelector('section[aria-label="Sessions"]') || [...document.querySelectorAll("button")].find((x) => /^会话$/i.test((x.innerText || "").trim()))`,
    );
    await click(
      "sessions tab",
      `document.querySelector('section[aria-label="Sessions"]') ? null : [...document.querySelectorAll("button")].find((x) => /^会话$/i.test((x.innerText || "").trim()))`,
    );
    await sleep(3500);
    // Confirm the panel is really open before returning.
    //
    // Re-running this for a variant is not the same as running it once: the dock
    // is already open, so the toggle is absent and the step is a no-op — which is
    // correct, but it means a closed dock would go unnoticed and the read below
    // would then click a button that is not on screen.
    const panelOpen = await waitFor(`document.querySelector('section[aria-label="Sessions"]')`, 8_000);
    if (panelOpen === false) console.log("    (sessions panel did not open)");
  }

  if (name === "openSessionsPanelAndReadFirst") {
    await waitFor(`document.querySelector('section[aria-label="Sessions"] button[aria-label^="Read session"]')`);
    // The FIRST row, deliberately.
    //
    // The baseline was captured with this row, and the transcript is rendered per
    // session, so reading a different row changes the element count and makes the
    // comparison meaningless. Reading the live row would also add the composer,
    // but that state is captured by the dock-state popups instead.
    await click(
      "read first session",
      `document.querySelector('section[aria-label="Sessions"] button[aria-label^="Read session"]')`,
    );
    await sleep(3500);
  }

  if (name === "openSlashMenu") {
    // Typing `/` at the start of an EMPTY composer is what the composer watches
    // for. A raw value assignment would not fire React's onChange, so the input
    // event is dispatched explicitly — the same thing a keystroke does.
    await waitFor(`document.querySelector("textarea")`, 8_000);
    await ev(`(() => {
      const t = document.querySelector("textarea");
      if (!t) return false;
      t.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(t, "/");
      t.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(`document.querySelector('[role="listbox"][aria-label="Skills"]')`, 15_000);
    await sleep(1200);
  }

  if (name === "openModelPicker") {
    // The trigger carries an explicit `aria-label` (`Model: <name>`), which is a
    // steadier handle than matching the model id in its text: the label also
    // appears in the transcript and in the workspace picker, so a text match can
    // click the wrong control. `aria-expanded` is checked rather than assumed,
    // because the picker closes on an outside mousedown and would otherwise be
    // dismissed by its own click if it were already open.
    await waitFor(`document.querySelector('button[aria-label^="Model: "]')`, 20_000);
    await ev(`(() => {
      const b = document.querySelector('button[aria-label^="Model: "]');
      if (b && b.getAttribute("aria-expanded") !== "true") b.click();
      return true;
    })()`);
    await waitFor(`document.querySelector('button[aria-label^="Model: "][aria-expanded="true"]')`, 10_000);
    await sleep(1500);
  }
}

const result = { state, capturedAt: new Date().toISOString(), routes: {} };

/*
 * Snapshot the pairing credential once, and restore exactly it before each
 * route.
 *
 * The app persists more than the pairing: the selected workspace, the open dock,
 * the fetched model catalogue. Capturing a route after an interactive one
 * therefore inherits its UI state, so "the same" route yields the launcher in one
 * run and the full shell in the next — hundreds of elements apart, and the
 * comparison then says nothing about styles.
 *
 * The credential is taken from a page that is CONNECTED, not merely loaded:
 * the session record is written asynchronously once the relay handshake
 * completes, so reading it immediately after navigation yields null and every
 * later route would then start unpaired. Everything else is cleared, which is
 * what makes each route's starting state reproducible.
 */
await send("Page.navigate", { url: APP_ORIGIN + "/remote-pi/connect" });
await sleep(3000);
for (let i = 0; i < 40; i++) {
  const credential = await ev(`localStorage.getItem("remote-pi-web-session-v1")`);
  if (typeof credential === "string" && credential !== "") break;
  await sleep(500);
}
const sessionCredential = await ev(`localStorage.getItem("remote-pi-web-session-v1")`);
if (typeof sessionCredential !== "string" || sessionCredential === "") {
  console.error("not paired: no stored session credential, so the shell states cannot be captured");
  process.exit(1);
}

for (const route of ROUTES) {
  // The relay occasionally drops a handshake when many routes reconnect in quick
  // succession, leaving the app on the launcher. Re-navigating is the fix, so
  // the route is attempted twice before its launcher capture is accepted.
  let captured = null;
  for (let attempt = 1; attempt <= 2 && captured === null; attempt++) {
    captured = await captureRoute(route, attempt);
    // Give the relay a moment between routes. Navigating immediately after a
    // teardown reconnects while the previous socket is still closing, and the
    // relay drops that handshake — the next route then sits on the launcher with
    // no workspace list. A short pause is what keeps eight consecutive captures
    // reliable.
    if (captured === null) await sleep(4000);
  }
  result.routes[route.name] = captured;
  await sleep(2500);

  /*
   * Capture the route's extra states from the connection just established.
   *
   * No navigation happens here: the popups are opened on the page that is
   * already connected, so they add no relay handshake and cannot fail for
   * connectivity reasons.
   *
   * Between variants the composer is returned to a known state — draft cleared
   * and any open popup dismissed — because the slash menu and the model picker
   * are mutually exclusive views of the same toolbar. Leaving one open would
   * make the next variant a capture of the previous one.
   */
  for (const variant of route.variants ?? []) {
    let capturedVariant = null;
    for (let attempt = 1; attempt <= 3 && capturedVariant === null; attempt++) {
      await resetComposer();
      await applySetup(variant.setup);
      await waitForStableDom();
      await waitForStableDom();
      // Only accept the capture once the popup the variant is about actually
      // exists. Opening the model picker asks the host for the catalogue, so a
      // relay hiccup leaves the button collapsed and the capture would silently
      // become a duplicate of the base state.
      const open = await waitFor(variant.marker, 12_000);
      if (open === false) {
        console.log(`    (${variant.name}: popup did not open, attempt ${String(attempt)})`);
        continue;
      }
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
      await sleep(300);
      capturedVariant = await fingerprintCurrent();
    }
    if (capturedVariant === null) {
      throw new Error(`${variant.name}: popup never opened after 3 attempts`);
    }
    result.routes[variant.name] = capturedVariant;
    console.log(`${variant.name}: ${String(capturedVariant.length)} elements`);
  }
}

/**
 * Return the composer to its resting state: empty draft, no popup open.
 *
 * The draft is set through React's own value setter and an `input` event rather
 * than by assigning `.value`. Assigning directly updates the DOM but not React's
 * state, so the composer would still believe text is present and the slash menu
 * would reopen on the next keystroke.
 *
 * Dismissing the popups is done by pressing Escape ON THE TEXTAREA, not by
 * clicking the page background. A background click bubbles to the shell's
 * click-outside handler, which closes the dock as well — the variant then
 * captures the dock state instead of the composer.
 */
async function resetComposer() {
  await ev(`(() => {
    const t = document.querySelector("textarea");
    if (!t) return true;
    t.focus();
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, "");
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
}

async function captureRoute(route, attempt) {
  // Reset to a known storage state so both captures see the same app state:
  // pairing kept, every other persisted UI decision dropped.
  //
  // `route.unpaired` clears the credential instead, which is the only way to
  // reach the connection launcher: it renders when no pairing is stored, and the
  // shell replaces it as soon as one is.
  await ev(`(() => {
    localStorage.clear();
    ${route.unpaired === true ? "" : `localStorage.setItem("remote-pi-web-session-v1", ${JSON.stringify(sessionCredential)});`}
    return true;
  })()`);
  // Navigate to a blank document first, then to the route.
  //
  // `Page.navigate` to the URL the page is already on is a no-op, so the app's
  // in-memory state survives and the next route inherits it — the same route
  // then reports the shell in one run and the launcher in the next. Going
  // through `about:blank` tears the app down, so each route starts from the
  // storage state above and nothing else.
  await send("Page.navigate", { url: "about:blank" });
  await sleep(500);
  await send("Page.navigate", { url: route.url });
  // Re-apply after navigation: a navigation resets emulation, and the first
  // route would otherwise be measured at the browser's own window size.
  await applyEmulation();
  await sleep(route.settle ?? 9000);

  if (route.setup !== undefined) {
    await applySetup(route.setup);
  }

  // Wait for the app to actually CONNECT before reading styles.
  //
  // "Not busy" is not the same as "connected": the launcher also sits idle while
  // the relay handshake is still in flight, and it looks identical whether the
  // handshake is about to succeed or has already failed. Capturing then yields
  // the launcher in one run and the shell in the next.
  //
  // The `connect` route is exempt: it deliberately renders the launcher, so
  // waiting for "host connected" there would wait for a screen it never shows.
  let connected = true;
  if (state === "paired" && route.expectsConnection !== false) {
    connected = await waitFor(`/host connected/.test(document.body.innerText || "")`, 60_000);
  }
  await waitForStableDom();
  await waitForSettledApp();
  await waitForStableDom();

  // A route that never connected captured the launcher, not the state that was
  // asked for. Returning null lets the caller re-navigate instead of recording a
  // capture that would compare against a different screen.
  if (connected === false && route.setup !== undefined && attempt < 2) {
    console.log(`    (${route.name}: never connected, retrying)`);
    return null;
  }

  // Park the pointer in a corner before reading styles.
  //
  // The pointer keeps whatever position the previous route left it in, and any
  // `:hover` rule under it changes computed styles. That made a single session
  // row report a different background between two runs — a difference in where
  // the mouse happened to be, not in the CSS. Moving it off the content removes
  // the variable.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await sleep(300);

  const fingerprint = await fingerprintCurrent();
  console.log(`${route.name}: ${String(fingerprint.length)} elements`);
  return fingerprint;
}

/**
 * Read the computed styles of every element on the current page.
 *
 * Split out of the route loop so a route's extra states can be fingerprinted
 * from the connection already open, without navigating again.
 */
async function fingerprintCurrent() {
  return await ev(`(() => {
    const props = ${JSON.stringify(PROPS)};
    const colourProps = ${JSON.stringify([...COLOUR_PROPS])};

    /*
     * Reduce any CSS colour to one canonical string.
     *
     * The browser returns different notations for the same colour depending on
     * how it was produced (oklab() from color-mix(), rgba() from a literal), so
     * the string form is not comparable. Painting the colour onto a canvas and
     * reading the pixel back gives one representation for all of them, including
     * alpha, which is what makes the comparison about the colour rather than
     * about its spelling.
     */
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const cache = new Map();
    const canonColour = (value) => {
      if (cache.has(value)) return cache.get(value);
      let result = value;
      try {
        // Paint over black and over white: alpha only shows up when the backdrop
        // differs, so a single pass cannot distinguish transparent from black.
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const onBlack = [...ctx.getImageData(0, 0, 1, 1).data].join(",");
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const onWhite = [...ctx.getImageData(0, 0, 1, 1).data].join(",");
        result = onBlack + "|" + onWhite;
      } catch {
        result = value;
      }
      cache.set(value, result);
      return result;
    };

    const out = [];
    const pathOf = (el) => {
      const parts = [];
      let node = el;
      while (node && node !== document.body) {
        const parent = node.parentElement;
        if (parent === null) break;
        const idx = Array.prototype.indexOf.call(parent.children, node);
        parts.unshift(node.tagName + "[" + idx + "]");
        node = parent;
      }
      return parts.join("/");
    };
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const values = {};
      for (const p of props) values[p] = cs[p];
      // Colours are also recorded in a CANONICAL form. The browser serialises a
      // colour as oklab(...) when it came from color-mix() and as rgba(...)
      // when it came from a literal, and the two are the same colour. Comparing
      // raw strings would report those as differences and bury the real ones.
      for (const p of colourProps) values["~" + p] = cs[p] === "" ? "" : canonColour(cs[p]);
      // Round geometry: sub-pixel noise from font rasterisation is not a style
      // change, and would otherwise bury real differences in false positives.
      out.push({
        path: pathOf(el),
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        values,
      });
    }
    return out;
  })()`);
}

writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
console.log(`written: ${out}`);
process.exit(0);
