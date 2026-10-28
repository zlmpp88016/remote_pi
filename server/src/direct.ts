import type { EmbeddedRelay } from "./transport/embedded_relay.js";
import { startEmbeddedRelay } from "./transport/embedded_relay.js";
import type { SameOriginServer } from "./transport/same_origin_server.js";
import { startSameOriginServer } from "./transport/same_origin_server.js";
import { hostPairing } from "./pairing/host_pairing.js";
import { getOrCreateEd25519Keypair } from "./pairing/storage.js";
import { hostSessionName } from "./daemon/host_control.js";
import { logRelayEvent } from "./log.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `--direct` support: run a local relay inside the process and point the whole
 * host stack at it.
 *
 * ## Why an env var and not a config write
 *
 * `resolveRelayUrl()` has a fixed precedence: `REMOTE_PI_RELAY` env >
 * `~/.pi/remote/config.json` > community default (`server/src/config.ts:51`).
 *
 * The env tier is exactly the "this process and its children, not my saved
 * settings" semantic `--direct` needs:
 *
 *   - `pi-supervisord` and every daemon it spawns inherit `process.env`
 *     (`server/src/daemon/rpc_child.ts:350`), so they all resolve the SAME
 *     local relay without any of them being told separately.
 *   - The pairing code is built from `resolveRelayUrl()` in
 *     `supervisor._pairView()` (`server/src/daemon/supervisor.ts:550`), so its
 *     `r=` parameter becomes the local address automatically.
 *   - The user's saved relay is left untouched: killing the `--direct` process
 *     reverts to the previous behaviour with no cleanup step to forget.
 *
 * Writing `saveConfig({ relay })` instead would silently pin the machine to a
 * port that no longer exists after the process exits — the failure mode is a
 * bare timeout on next boot. Hence: env only.
 *
 * ## Why same-origin, and why a fixed port
 *
 * Two defects made the original `port = 0` direct mode a demo rather than a
 * feature:
 *
 *   1. The OS picked a new port on every start, so the address stored in the
 *      browser (`ws://127.0.0.1:56542`) died on restart and the user had to
 *      re-pair by hand. A fixed port is what makes the stored pairing survive.
 *   2. The web client was served by vite on another port, i.e. cross-origin.
 *      That only worked because the embedded relay checked no origin at all;
 *      adding the check that a loopback listener needs would have broken it.
 *
 * Serving the built client from the same port removes both: the browser dials
 * `ws://${location.host}`, so even if the port does change the address bar
 * follows, and `http://127.0.0.1:PORT` is a secure context, so Ed25519 keeps
 * working without TLS.
 */

/** Env var the embedded relay publishes its address through. */
const DIRECT_ENV = "REMOTE_PI_RELAY";

/** Default port. High enough to miss the common 3000/5173/8080 dev ranges. */
const DEFAULT_DIRECT_PORT = 4124;

let activeRelay: EmbeddedRelay | null = null;
let activeServer: SameOriginServer | null = null;

/** True when the CLI was invoked with `--direct`. */
export function wantsDirect(args: readonly string[]): boolean {
  return args.includes("--direct");
}

/** Where the port/discovery file lives. */
function stateFilePath(): string {
  return join(homedir(), ".pi", "remote", "direct.json");
}

/**
 * Resolve the port to bind: `--port` > `REMOTE_PI_PORT` > saved config > 4124.
 *
 * @param args - remaining CLI args, scanned for `--port <n>` / `--port=<n>`.
 * @returns the port number, or the default when nothing was specified.
 */
export function resolveDirectPort(args: readonly string[] = []): number {
  /*
   * `parsed >= 0`, not `> 0`: 0 is the "give me an ephemeral port" request that
   * the test suite needs so it cannot collide with a live `--direct` server on
   * 4124. Rejecting 0 made the tests un-runnable next to a dev instance.
   */
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port") {
      const next = args[i + 1];
      const parsed = next === undefined ? Number.NaN : Number.parseInt(next, 10);
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  const fromEnv = process.env["REMOTE_PI_PORT"];
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_DIRECT_PORT;
}

/**
 * Locate the built web client to serve.
 *
 * Works from `src` (ts-node/tests), `dist` (this repo's build) and a packaged
 * install, because the relative depth differs by one level and a packaged copy
 * lives somewhere else entirely.
 *
 * Resolution order matters: an explicit operator override wins, then the
 * co-located build, then the two repo-relative guesses. An override that does
 * NOT contain `index.html` is ignored rather than fatal, so a stale env var
 * cannot brick a working install.
 *
 * @returns the directory to serve, or `null` when no build is present.
 */
function resolveWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));

  const override = process.env["REMOTE_PI_WEB_DIST"];
  const candidates: string[] = [];
  if (override !== undefined && override.trim() !== "") {
    candidates.push(resolve(override.trim()));
  }

  candidates.push(
    /* Packaged: assets copied next to the built server (`dist/web-dist`). */
    resolve(here, "web-dist"),
    /* dist → server → repo → clients/web/dist */
    resolve(here, "../clients/web/dist"),
    /* src → server → repo → clients/web/dist */
    resolve(here, "../../clients/web/dist"),
  );

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }

  /*
   * Report every path tried. Without this the operator sees "not found" and has
   * no way to know where the build was expected — which is exactly how the first
   * version wasted a debugging session.
   */
  logRelayEvent(
    `direct mode: no web build found. Tried:\n  ${candidates.join("\n  ")}\n` +
      "Set REMOTE_PI_WEB_DIST to override, or run `cd clients/web && npm run build`.",
  );
  triedWebDistPaths = candidates;
  return null;
}

/**
 * Paths probed by the last failed `resolveWebDist` call.
 *
 * Kept so the startup warning can repeat them on stderr — the relay log is off by
 * default, and an operator who cannot see the candidates cannot fix the problem.
 */
let triedWebDistPaths: readonly string[] = [];

/**
 * Start the direct stack: one same-origin HTTP server that serves the built web
 * client and welds the embedded relay's WebSocket onto the same port, then
 * publish its address through `REMOTE_PI_RELAY`.
 *
 * Idempotent: a second call returns the existing address rather than binding a
 * second port (the daemon re-enters its start path on reconnect).
 *
 * @param options - optional port override; omitted resolves from env/default.
 * @returns the canonical `http://` address in the form `buildQRUri` expects.
 */
export async function ensureDirectRelay(
  options: { port?: number; args?: readonly string[] } = {},
): Promise<string> {
  if (activeRelay !== null) {
    /*
     * Already started. Return whichever address is live: the same-origin server
     * when there is one, else the relay's own listener (the fallback mode).
     * Returning early is what makes a second call cost nothing — the daemon
     * re-enters its start path on every reconnect.
     */
    if (activeServer !== null) return activeServer.url;
    return toHttpUrl(activeRelay.url);
  }

  const port = options.port ?? resolveDirectPort(options.args ?? []);
  const webDist = resolveWebDist();

  /*
   * `noServer` always: the same-origin HTTP server owns the port and forwards
   * upgrades after its own host/origin gate has run. The relay therefore never
   * binds a second listener, which is what makes "one port for everything"
   * possible.
   */
  const relay = await startEmbeddedRelay({ noServer: true });
  activeRelay = relay;

  if (webDist === null) {
    /*
     * No built client.
     *
     * This MUST be loud. The previous version logged only to the relay log (off
     * by default) and still printed "local relay at http://…" to stderr — so an
     * operator on a clean checkout opened that URL, got a bare WebSocket
     * listener answering HTTP 400, and had no way to tell why. Relay-only is
     * still allowed because the vite dev server is a legitimate setup, but the
     * banner has to say so.
     */
    process.stderr.write(
      "[pi-supervisord] WARNING: no web build found — serving WebSocket only.\n" +
        "[pi-supervisord] WARNING: http://127.0.0.1:" +
        String(port) +
        " will NOT serve the web UI.\n" +
        "[pi-supervisord] WARNING: paths tried:\n" +
        triedWebDistPaths.map((path) => `[pi-supervisord] WARNING:   ${path}\n`).join("") +
        "[pi-supervisord] WARNING: fix with `cd clients/web && npm run build`, or set REMOTE_PI_WEB_DIST.\n",
    );
    logRelayEvent("direct mode: no clients/web/dist build found; relay-only listener");
    await relay.close();
    activeRelay = await startEmbeddedRelay({ port });
    const fallbackUrl = toHttpUrl((activeRelay as EmbeddedRelay).url);
    if (!process.env[DIRECT_ENV]) process.env[DIRECT_ENV] = fallbackUrl;
    logRelayEvent(`direct mode: local relay at ${fallbackUrl}`);
    return fallbackUrl;
  }

  const server = await startSameOriginServer({
    staticDir: webDist,
    port,
    allowedHosts: (process.env["REMOTE_PI_ALLOWED_HOSTS"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    /*
     * Origins may differ from hosts: `localhost:3010` is a HOST of the vite dev
     * server, but it arrives as an Origin when that page opens a socket to us.
     * Listing it explicitly is what lets `npm run dev` talk to the same-origin
     * server without relaxing the check for anyone else.
     */
    allowedOrigins: (process.env["REMOTE_PI_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    onUpgrade: (req, socket, head) => {
      relay.handleUpgrade?.(req, socket, head);
    },
    /*
     * The SSE endpoint dials the relay over loopback using the SAME port this
     * server binds. Resolved lazily because that address does not exist until
     * `listen()` has returned — see the thunk comment in same_origin_server.ts.
     */
    relayUrl: () => `ws://127.0.0.1:${activeServer?.port ?? port}`,
    /*
     * Zero-click local pairing. Reads the SAME token `remote-pi-server pair`
     * prints, so a user who already has a code and one who does not both work.
     *
     * Returns null when no token has been issued yet — the browser then falls back
     * to the manual paste screen instead of being told the host is broken.
     */
    pairingView: async () => {
      const record = await hostPairing.show();
      if (record === null) return null;
      const keypair = await getOrCreateEd25519Keypair();
      return {
        hostEpk: Buffer.from(keypair.publicKey).toString("base64"),
        token: record.token,
        name: hostSessionName(),
      };
    },
  });
  activeServer = server;

  const httpUrl = server.url;

  // Only set when the user has not already chosen a relay explicitly. An
  // operator exporting REMOTE_PI_RELAY is making a deliberate statement; the
  // `--direct` flag must not silently override it (that would make the two
  // controls fight with the flag winning by accident of ordering).
  if (!process.env[DIRECT_ENV]) {
    process.env[DIRECT_ENV] = httpUrl;
  }

  await writeStateFile({ pid: process.pid, port: server.port, url: httpUrl });

  logRelayEvent(`direct mode: same-origin at ${httpUrl} (web + websocket, port ${server.port})`);
  return httpUrl;
}

/**
 * Write the discovery file so other tools (Electron shell, CLI) can find the
 * running port without probing.
 *
 * @param state - the values to record.
 */
async function writeStateFile(state: { pid: number; port: number; url: string }): Promise<void> {
  const path = stateFilePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    /* Discovery is a convenience; failing to write it must not block startup. */
  }
}

/**
 * Read the discovery file, if one exists and its process is still the writer.
 *
 * @returns the recorded state, or `null` when absent/unreadable.
 */
export async function readDirectState(): Promise<{ pid: number; port: number; url: string } | null> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown; url?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number" || typeof parsed.url !== "string") {
      return null;
    }
    /*
     * A stale file must not be reported as live.
     *
     * `stopDirectRelay` only unlinks on a graceful exit, so a SIGKILL, a crash or
     * the `SupervisorAlreadyRunningError` path leaves the file behind pointing at
     * a port nobody is listening on. A consumer that trusted it would dial a dead
     * endpoint and report a bare timeout.
     */
    if (!isProcessAlive(parsed.pid)) return null;
    return { pid: parsed.pid, port: parsed.port, url: parsed.url };
  } catch {
    return null;
  }
}

/**
 * Whether a pid is running, using the portable signal-0 probe.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. The three outcomes are all meaningful and are handled distinctly:
 *
 *   - no throw       → the process exists and we may signal it.
 *   - `EPERM`        → it exists but belongs to someone else. ALIVE: on Windows
 *                      this is what a live-but-protected pid reports, so treating
 *                      EPERM as dead would discard valid state.
 *   - `ESRCH`        → no such process. DEAD.
 *
 * Any other errno is treated as "cannot prove it is dead", so the state is kept:
 * deleting a live instance's discovery file is worse than returning a stale one.
 *
 * @param pid - the process id to probe.
 * @returns whether the process should be considered alive.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    /* EPERM (or anything unrecognised): the pid is in use, so keep the state. */
    return true;
  }
}

/** Stops the same-origin server and the embedded relay, if this process started them. */
export async function stopDirectRelay(): Promise<void> {
  const server = activeServer;
  const relay = activeRelay;
  activeServer = null;
  activeRelay = null;

  /*
   * Close streams FIRST, then the relay, then the HTTP server.
   *
   * Order matters: each stream owns a RelayClient, and an open stream keeps a
   * heartbeat timer and a socket alive. Closing the HTTP server first would tear
   * the socket out from under those clients (`ECONNRESET` instead of a clean
   * end), and would never run their teardown at all.
   */
  try {
    const { closeAllEventStreams } = await import("./transport/sse_endpoint.js");
    closeAllEventStreams();
  } catch {
    /* The SSE module was never loaded — nothing to close. */
  }

  /* Relay before server: the relay's sockets live on the server's port. */
  if (relay !== null) await relay.close();
  if (server !== null) await server.close();

  try {
    await unlink(stateFilePath());
  } catch {
    /* Nothing to clean up. */
  }
}

/** `ws://host:port` → `http://host:port` (the canonical stored form). */
function toHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice("ws://".length);
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
  return wsUrl;
}
