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

import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell as electronShell } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, stat as statFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_IPC } from "./ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The scheme the packaged app is served from. Must be registered as privileged
 *  before `app.ready`, which is why it is a module constant and not a call. */
const SCHEME = "app";
const APP_ORIGIN = `${SCHEME}://app`;

/**
 * Content Security Policy for the packaged app.
 * Allows local app assets, WebSockets to relay, and HTTP(S) API / image / style connections.
 */
const CSP_HEADER =
  "default-src 'self' app://app; connect-src 'self' app://app ws: wss: http: https:; img-src 'self' app://app data: blob: https:; script-src 'self' 'unsafe-inline' app://app; style-src 'self' 'unsafe-inline' app://app;";

/** Permissions explicitly allowed for the renderer session. All other permissions are rejected. */
const ALLOWED_PERMISSIONS = new Set<string>([
  "clipboard-sanitized-write",
  "clipboard-read",
  "notifications",
]);

function getLogPath(): string {
  try {
    return join(app.getPath("userData"), "logs", "shell.log");
  } catch {
    return join(process.cwd(), "logs", "shell.log");
  }
}

function writeLog(level: "INFO" | "WARN" | "ERROR", message: string, detail?: unknown): void {
  try {
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const timestamp = new Date().toISOString();
    const detailStr =
      detail instanceof Error
        ? `\n  ${detail.stack ?? detail.message}`
        : detail !== undefined
          ? `\n  ${String(detail)}`
          : "";
    appendFileSync(logPath, `[${timestamp}] [${level}] ${message}${detailStr}\n`, "utf8");
  } catch (err) {
    console.error(`Failed to write log: ${String(err)}`);
  }
}

process.on("uncaughtException", (error) => {
  writeLog("ERROR", `uncaughtException: ${error.message}`, error);
  console.error("uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  writeLog("ERROR", `unhandledRejection: ${String(reason)}`, reason);
  console.error("unhandledRejection:", reason);
});

/** Where the built web client is expected:
 *  - Packaged: `join(process.resourcesPath, "dist-shell")`
 *  - Source: `clients/web/dist-shell`, resolved relative to THIS FILE
 *    (`clients/shell/dist/main.js`), so it is `../../` — up from `dist` to `shell`,
 *    up again to `clients`, then `web/dist-shell`.
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
function getWebExportDir(): string {
  if (app.isPackaged) {
    return resolve(join(process.resourcesPath, "dist-shell"));
  }
  return resolve(fileURLToPath(new URL("../../web/dist-shell/", import.meta.url)));
}

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
  const exportDir = getWebExportDir();
  const file = fileForRequest(exportDir, pathname);
  if (file !== null) {
    try {
      const stat = await statFile(file);
      if (stat.isFile()) {
        const body = await readFile(file);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": contentTypeFor(file),
            "content-security-policy": CSP_HEADER,
          },
        });
      }
    } catch (err) {
      // Missing file: fall through to the SPA shell below.
      writeLog("WARN", `Static file check failed for ${pathname} (${file}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // SPA fallback. A request whose last segment looks like a file (`app.css`,
  // `logo.svg`) is a missing asset and must 404 rather than silently receive
  // HTML — otherwise a stale bundle reference would render as a blank page
  // instead of an obvious error.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (/\.[a-z0-9]+$/i.test(lastSegment)) {
    writeLog("WARN", `Protocol 404 (missing asset): ${pathname}`);
    return new Response("Not found", { status: 404 });
  }

  const shellFile = fileForRequest(exportDir, "/index.html");
  if (shellFile === null) {
    writeLog("ERROR", `Protocol 404: failed to resolve index.html for ${pathname}`);
    return new Response("Not found", { status: 404 });
  }
  try {
    const body = await readFile(shellFile);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP_HEADER,
      },
    });
  } catch (err) {
    writeLog("ERROR", `Protocol 404: failed to read SPA shell (${shellFile}) for ${pathname}: ${err instanceof Error ? err.message : String(err)}`);
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showErrorPage(targetWindow: BrowserWindow, title: string, code: string | number): void {
  if (targetWindow.isDestroyed()) return;
  const safeTitle = escapeHtml(String(title));
  const safeCode = escapeHtml(String(code));
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    body {
      background-color: #151517;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    h1 { margin-bottom: 8px; font-size: 20px; }
    p { margin-top: 0; margin-bottom: 24px; color: #888; font-size: 14px; font-family: monospace; }
    button {
      padding: 8px 16px;
      font-size: 14px;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>Error: ${safeCode}</p>
  <button onclick="location.reload()">Retry</button>
</body>
</html>`;
  void targetWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/**
 * Security: verify that the IPC call originates from the trusted app origin.
 * In production this must be app://app; in development devUrl origin is also permitted.
 */
function validateSenderOrigin(event: Electron.IpcMainInvokeEvent): void {
  const origin = event.senderFrame?.origin;
  const isAllowed = origin === "app://app" || (devUrl !== null && origin === new URL(devUrl).origin);
  if (!isAllowed) {
    throw new Error(`Unauthorized IPC call from origin: ${origin ?? "unknown"}`);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_IPC.openExternal, async (event, url: unknown) => {
    validateSenderOrigin(event);
    if (typeof url !== "string") {
      throw new TypeError("Expected url to be a string");
    }
    await electronShell.openExternal(url);
  });

  ipcMain.handle(DESKTOP_IPC.getPlatform, (event) => {
    validateSenderOrigin(event);
    return process.platform;
  });

  ipcMain.handle(DESKTOP_IPC.getVersion, (event) => {
    validateSenderOrigin(event);
    return app.getVersion();
  });

  ipcMain.handle(DESKTOP_IPC.openUserDataLog, async (event) => {
    validateSenderOrigin(event);
    const logsDir = join(app.getPath("userData"), "logs");
    mkdirSync(logsDir, { recursive: true });
    return await electronShell.openPath(logsDir);
  });
}

/**
 * Pull a `remotepi://pair?...` URI out of a process argument list.
 *
 * Only the pairing scheme is accepted. Anything else is ignored rather than
 * forwarded: an argv entry on Windows can come from a file association, a
 * shortcut, or a wrapper script, and the renderer must never be handed a URL
 * this app did not opt into.
 */
function findPairUri(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("remotepi://pair")) return arg;
  }
  return null;
}

/**
 * Hand a pairing URI to the renderer.
 *
 * Delivered as a `CustomEvent` on `window` rather than by navigating: the web
 * client keeps its own state machine and can accept the URI at any time, while a
 * navigation would throw away an already-connected session. The page listens for
 * `remote-pi:pair-uri`; when nothing is listening yet (cold start, the bundle has
 * not mounted), the URI is held and replayed on `did-finish-load`.
 */
function deliverPairUri(argv: readonly string[]): void {
  const uri = findPairUri(argv);
  if (uri === null) return;
  const target = BrowserWindow.getAllWindows()[0];
  if (target === undefined || target.isDestroyed()) {
    pendingPairUri = uri;
    return;
  }
  const send = () => {
    target.webContents
      .executeJavaScript(
        `window.dispatchEvent(new CustomEvent("remote-pi:pair-uri", { detail: ${JSON.stringify(uri)} }));`,
        true,
      )
      .catch((err: unknown) => writeLog("ERROR", `pair-uri delivery failed: ${String(err)}`));
  };
  void target.webContents
    .executeJavaScript("Boolean(window.__remotePiPairListener)", true)
    .then((ready: boolean) => {
      if (ready) {
        send();
        return;
      }
      target.webContents.once("did-finish-load", send);
    })
    .catch(() => {
      target.webContents.once("did-finish-load", send);
    });
  writeLog("INFO", `pair-uri delivered (${uri.slice(0, 40)}…)`);
}

/** A URI that arrived before any window existed (cold start via the link). */
let pendingPairUri: string | null = null;

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
      // MUST be a CommonJS bundle. `package.json` sets `"type": "module"`, so a
      // `.js` file here is loaded as ESM — and Electron's sandboxed preload
      // runtime only executes CommonJS. It fails silently: the page loads, but
      // `window.remotePi` is never defined. `tsconfig.preload.json` compiles
      // `preload.ts` to CJS and the build renames it to `.cjs`.
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  window.webContents.on("will-frame-navigate", (event) => {
    if (isInternal(event.url)) return;
    event.preventDefault();
    void electronShell.openExternal(event.url);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeLog(
      "ERROR",
      `did-fail-load: code=${errorCode} description="${errorDescription}" url=${validatedURL} isMainFrame=${isMainFrame}`,
    );
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith("data:")) return;
    showErrorPage(window, "Failed to load page", `${errorDescription} (${errorCode})`);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    writeLog("ERROR", `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    showErrorPage(window, "Renderer process crashed", `${details.reason} (${details.exitCode})`);
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("close", () => {
    void saveBounds(window);
  });

  const target = appUrl("/remote-pi/connect");
  try {
    await window.loadURL(target);
  } catch (err) {
    writeLog("ERROR", `Failed to load initial URL ${target}: ${String(err)}`);
  }
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
  const showDevTools = !app.isPackaged || Boolean(process.env["REMOTE_PI_DEBUG"]);
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
        ...(showDevTools
          ? ([{ role: "toggleDevTools" }] as Electron.MenuItemConstructorOptions[])
          : []),
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

  app.on("certificate-error", (event, _webContents, url, error, _certificate, callback) => {
    if (process.env["REMOTE_PI_ALLOW_INSECURE"] === "1") {
      console.warn(`[security] Allowing insecure certificate for ${url}: ${error} (REMOTE_PI_ALLOW_INSECURE=1)`);
      writeLog("WARN", `Allowing insecure certificate for ${url}: ${error} (REMOTE_PI_ALLOW_INSECURE=1)`);
      event.preventDefault();
      callback(true);
    } else {
      console.error(
        `[security] Certificate verification failed for ${url}: ${error}. ` +
          `Set REMOTE_PI_ALLOW_INSECURE=1 to bypass.`,
      );
      writeLog(
        "ERROR",
        `Certificate verification failed for ${url}: ${error}. Set REMOTE_PI_ALLOW_INSECURE=1 to bypass.`,
      );
      event.preventDefault();
      callback(false);
    }
  });

  await app.whenReady();
  writeLog("INFO", `Shell ready: isPackaged=${app.isPackaged}, webExportDir=${getWebExportDir()}`);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) {
      writeLog("WARN", `Permission denied: ${permission}`);
    }
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // Only register the protocol in packaged mode; in dev the renderer loads the
  // dev server directly and the scheme is unused.
  if (devUrl === null) {
    protocol.handle(SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "app") {
        writeLog("WARN", `Protocol 404: invalid hostname "${url.hostname}" in ${request.url}`);
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      return serveStatic(url.pathname);
    });
  }

  Menu.setApplicationMenu(buildMenu());

  registerIpcHandlers();

  // `remotepi://pair?...` deep link. Registration must happen before the window
  // is created so a link clicked while the app is closed is routed to us.
  // Electron only honours the second argument as the default-protocol client on
  // packaged builds; in dev it is registered with the electron binary instead.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("remotepi");
  }
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverPairUri([url]);
  });

  // macOS delivers the URL through `open-url` even on a cold start, but Windows
  // and Linux pass it as argv to the FIRST instance, so look there too.
  const coldUri = findPairUri(process.argv);
  if (coldUri !== null) pendingPairUri = coldUri;

  let window = await createWindow();

  // A URI that arrived before the window existed is replayed once the renderer
  // is ready to receive it.
  if (pendingPairUri !== null) {
    const uri = pendingPairUri;
    pendingPairUri = null;
    // `createWindow()` awaits `loadURL`, so `did-finish-load` has ALREADY fired by
    // the time we get here — waiting for it again never resolves, and the URI is
    // silently dropped (the page just sits on the empty connect form). Poll for
    // the listener flag instead: the bundle mounts a few ticks after the load
    // event, and the flag is the only signal that a receiver exists.
    void (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (window.isDestroyed()) return;
        try {
          const ready = await window.webContents.executeJavaScript(
            "Boolean(window.__remotePiPairListener)",
            true,
          );
          if (ready === true) {
            deliverPairUri([uri]);
            return;
          }
        } catch {
          // Page still navigating; retry.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      writeLog("ERROR", "pair-uri dropped: renderer listener never appeared");
    })();
  }

  app.on("second-instance", (_event, argv) => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
    // Windows/Linux deliver a `remotepi://` activation as an argv entry on the
    // second instance, not as an event: the OS starts a new process, the single
    // instance lock makes it quit, and this callback is the only place the URL
    // survives. macOS uses `open-url` instead (registered below).
    deliverPairUri(argv);
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
