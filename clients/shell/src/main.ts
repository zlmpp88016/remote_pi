/**
 * Remote Pi desktop shell — Electron main process.
 *
 * WHAT THIS IS: a window, a menu, and a loader for the Remote Pi WEB CLIENT.
 * There is no UI code here. The web client at `/remote-pi/connect` is the whole
 * product surface, and the shell exists only to give it a desktop frame
 * (window, menu, keyboard shortcuts, remembered bounds).
 *
 * WHY SOURCE IS SHARED RATHER THAN VENDORED (this is the decision under test):
 * the alternative is what `clients/desktop` did — a second Flutter implementation
 * of the same protocol (protocol model 797 lines, relay client 535 lines, host
 * page 806 lines) that has to be kept in step with the web one by hand. One
 * implementation cannot drift from itself, so a protocol change is made once and
 * both surfaces are correct. The cost is that anything the shell cannot do in a
 * web view must be added to the web client, not to a parallel native UI.
 *
 * TWO MODES, because the web client is served two different ways:
 *   • DEV  — `REMOTE_PI_WEB_URL` is set (the `next dev` server). The window
 *            navigates straight to it. Hot reload works because the renderer is
 *            an ordinary browser page pointed at the dev server.
 *   • PROD — the same URL scheme as deepseek-harness: a custom `app://` protocol
 *            serves the static export from disk. A `file://` page cannot be used
 *            because the web client's WebSocket and fetch calls need a real
 *            origin, and `file://` has none.
 *
 * SECURITY POSTURE: the renderer is remote content as far as Electron is
 * concerned, so context isolation stays on, node integration stays off, and
 * navigation away from the app origin is refused. Nothing here exposes an IPC
 * surface yet; when one is needed it goes through a preload with an explicit,
 * minimal channel list — never `nodeIntegration: true`.
 */

import { app, BrowserWindow, Menu, protocol, shell as electronShell } from "electron";
import { readFile, stat as statFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The scheme the packaged app is served from. Must be registered as privileged
 *  before `app.ready`, which is why it is a module constant and not a call. */
const SCHEME = "app";
const APP_ORIGIN = `${SCHEME}://app`;

/** Where the built web client is expected: `clients/web/dist-shell`. Resolved
 *  relative to THIS FILE (`clients/shell/dist/main.js`), so it is `../../` — up
 *  from `dist` to `shell`, up again to `clients`, then `web/dist-shell`.
 *
 *  The shell build is a separate output on purpose: it is the same app built with
 *  `base: "./"` instead of `"/"`, so its asset URLs are relative and resolve
 *  under the `app://` protocol rather than being fetched from an origin that does
 *  not exist. `dist` (absolute base) is what the browser build serves.
 *
 *  Normalised through `resolve` because the traversal check below compares it
 *  against another `resolve` result: on Windows one side would otherwise be
 *  `D:/…` (forward slashes, as `fileURLToPath` returns) and the other `D:\\…`,
 *  so EVERY request would look like an escape and 404. */
const WEB_EXPORT_DIR = resolve(fileURLToPath(new URL("../../web/dist-shell/", import.meta.url)));

/** Dev server URL; when present the shell loads it instead of the static export. */
/* Dev mode:  points at the  server so hot reload
 * works. A flag would need argument plumbing on both sides; the env var is one
 * line and matches how the build script already passes its mode. */
/* Dev mode: point at the `next dev` server so hot reload works — the renderer is
 * then an ordinary browser page, not the static export. Set via env rather than a
 * CLI flag because the value is a URL that changes per machine. */
const devUrl = process.env["REMOTE_PI_WEB_URL"] ?? null;

/**
 * The packaged page must be treated as a secure origin, otherwise the WebSocket
 * to the relay is blocked as mixed content when the relay is `wss://`.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/** Content types for the export's file kinds. Anything else is served as a
 *  binary octet-stream, which is safe: the browser sniffs nothing it is told
 *  not to sniff. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request path to a file inside the export, refusing anything that escapes
 * it. A traversal attempt is a 404 rather than an error, so a malformed link
 * cannot reveal whether the target exists.
 */
function fileForRequest(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const candidate = resolve(root, `.${relative}`);
  // `resolve` collapses `..`, so the containment check is a prefix test on the
  // normalized absolute path — with a separator appended so `/root-evil` cannot
  // pass as a child of `/root`.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function serveStatic(pathname: string): Promise<Response> {
  /*
   * Resolve one request against Vite's output.
   *
   * Vite emits a SINGLE `index.html` plus hashed assets under `assets/`; there is
   * no file per route, because the router is client-side. So the only two cases
   * are "a real file exists at this path" and "this is a router path, hand the
   * SPA shell back and let the router decide".
   *
   * The old Next export needed three candidates (`/x.html`, `/x/index.html`,
   * `/x`), and the file-vs-directory ambiguity that went with it — `/x.html`
   * could sit next to a `/x/` directory, so existence alone was not enough and
   * `readFile` could fail with EISDIR. That whole class of problem is gone here:
   * the fallback is unconditional and always the same file.
   */
  const file = fileForRequest(WEB_EXPORT_DIR, pathname);
  if (file !== null) {
    try {
      const stat = await statFile(file);
      if (stat.isFile()) {
        const body = await readFile(file);
        return new Response(body, {
          status: 200,
          headers: { "content-type": contentTypeFor(file) },
        });
      }
    } catch {
      // Missing file: fall through to the SPA shell below.
    }
  }

  // SPA fallback. A request whose last segment looks like a file (`app.css`,
  // `logo.svg`) is a missing asset and must 404 rather than silently receive
  // HTML — otherwise a stale bundle reference would render as a blank page
  // instead of an obvious error.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (/\.[a-z0-9]+$/i.test(lastSegment)) {
    return new Response("Not found", { status: 404 });
  }

  const shellFile = fileForRequest(WEB_EXPORT_DIR, "/index.html");
  if (shellFile === null) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(shellFile);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/** Remembered window bounds, so the app reopens where the user left it. */
interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const BOUNDS_FILE = "window-bounds.json";

function boundsPath(): string {
  return join(app.getPath("userData"), BOUNDS_FILE);
}

async function loadBounds(): Promise<WindowBounds> {
  try {
    const raw = await readFile(boundsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { width: 1440, height: 900 };
    const record = parsed as Partial<WindowBounds>;
    const width = typeof record.width === "number" && record.width >= 640 ? record.width : 1440;
    const height = typeof record.height === "number" && record.height >= 480 ? record.height : 900;
    const bounds: WindowBounds = { width, height };
    if (typeof record.x === "number") bounds.x = record.x;
    if (typeof record.y === "number") bounds.y = record.y;
    if (record.maximized === true) bounds.maximized = true;
    return bounds;
  } catch {
    // First run, or a corrupted file: fall back to the default size rather than
    // failing to start. A window that cannot open is worse than a window at the
    // wrong size.
    return { width: 1440, height: 900 };
  }
}

async function saveBounds(window: BrowserWindow): Promise<void> {
  try {
    const bounds = window.getNormalBounds();
    const payload: WindowBounds = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized(),
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(boundsPath(), JSON.stringify(payload), "utf8");
  } catch {
    // Bounds are a convenience; losing them must not surface to the user.
  }
}

function appUrl(path: string): string {
  if (devUrl !== null) return new URL(path, devUrl).toString();
  return `${APP_ORIGIN}${path}`;
}

/**
 * Is `target` inside the app the shell is hosting? Used to keep the window from
 * navigating somewhere else; external links open in the user's browser instead.
 */
function isInternal(target: string): boolean {
  try {
    const url = new URL(target);
    if (devUrl !== null) {
      return url.origin === new URL(devUrl).origin;
    }
    return url.protocol === `${SCHEME}:` && url.hostname === "app";
  } catch {
    return false;
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const bounds = await loadBounds();
  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#151517",
    // The web client draws its own title strip, so the native one is hidden. On
    // macOS the traffic lights stay visible; on Windows/Linux the strip is the
    // window chrome and the frame is removed.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The client stores its pairing in localStorage and talks to a relay over
      // WebSocket; both need the page's own origin, which the custom scheme gives
      // it. No preload is installed because the app needs no native calls yet.
      webSecurity: true,
    },
  });

  if (bounds.maximized === true) window.maximize();

  // A new window (target=_blank, or `window.open`) is never wanted: the product
  // is a single surface. External URLs go to the browser, internal ones load in
  // place.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      void window.loadURL(url);
    } else {
      void electronShell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    void electronShell.openExternal(url);
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("close", () => {
    void saveBounds(window);
  });

  const target = appUrl("/remote-pi/connect");
  await window.loadURL(target);
  return window;
}

/**
 * Menu with the shortcuts a desktop app is expected to have. The web client
 * already binds Cmd/Ctrl+B (sidebar) and Cmd/Ctrl+K (search) on the page; the
 * menu only carries the OS-level ones and the standard edit/view roles, so there
 * is exactly one owner per shortcut.
 */
function buildMenu(): Menu {
  const isMac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(isMac
      ? ([{ role: "appMenu" }] as Electron.MenuItemConstructorOptions[])
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
}

async function main(): Promise<void> {
  // One instance only: two windows would fight over the same pairing state in
  // localStorage's backing store, and the second window shows a stale view.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  // Only register the protocol in packaged mode; in dev the renderer loads the
  // dev server directly and the scheme is unused.
  if (devUrl === null) {
    protocol.handle(SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "app") return Promise.resolve(new Response("Not found", { status: 404 }));
      return serveStatic(url.pathname);
    });
  }

  Menu.setApplicationMenu(buildMenu());

  let window = await createWindow();

  app.on("second-instance", () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on("activate", () => {
    // macOS: clicking the dock icon with no window open reopens it.
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().then((created) => {
        window = created;
      });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

void main();
