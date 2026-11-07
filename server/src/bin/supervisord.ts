#!/usr/bin/env node
/**
 * `pi-supervisord` — long-running daemon supervisor.
 *
 * Entry point of the `pi-supervisord` binary (plan/26 W2). Run by
 * systemd/launchd in production, or directly during dev:
 *
 *   pnpm build
 *   node dist/bin/supervisord.js
 *
 * Once running, it:
 *   - Reads `~/.pi/remote/daemons.json`
 *   - Spawns `pi --mode rpc -e <server/dist/index.js>` per entry
 *   - Listens on `~/.pi/remote/supervisor.sock` for CLI control requests
 *   - Restarts crashed children with exponential backoff
 *
 * Exits cleanly on SIGTERM/SIGINT (used by `remote-pi-server uninstall`).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Supervisor, SupervisorAlreadyRunningError } from "../daemon/supervisor.js";
import { configureRelayLog, parseRelayLogFlags } from "../log.js";

const HELP_TEXT = `pi-supervisord — Remote Pi daemon supervisor

Usage: pi-supervisord [options]

Runs the long-lived supervisor: reads ~/.pi/remote/daemons.json, spawns one
\`pi --mode rpc\` child per entry, and listens on ~/.pi/remote/supervisor.sock
for control requests from the \`remote-pi\` CLI.

Manage the fleet with:
  remote-pi-server daemon start | stop | restart | status
  remote-pi-server daemons

Options:
  --log <off|summary|full>   Log relay traffic to stderr (default: off).
                             summary = one line per frame; full = + raw JSON.
                             Daemon children inherit the level.
  --log-file <path>          Also append the relay log to a file.
  --direct                   Run a local relay inside this process and point
                             the host stack at it. No community relay, no
                             network egress. The pair command then reports a
                             local address automatically.
  -h, --help                 Show this help and exit.
  -v, --version              Print version and exit.

Environment (equivalent to the flags; flags win):
  REMOTE_PI_LOG, REMOTE_PI_LOG_FILE
  REMOTE_PI_RELAY            Relay address; --direct fills it in when unset.
`;

/**
 * Read `--port <n>` or `--port=<n>` out of the remaining argv.
 *
 * @param rest - arguments left after logging flags were parsed.
 * @returns the port as a string, or `null` when the flag is absent.
 */
function readPortFlag(rest: readonly string[]): string | null {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--port") {
      const next = rest[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) return next;
    }
    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      if (/^\d+$/.test(value)) return value;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write("pi-supervisord (remote-pi-server)\n");
    return;
  }

  // `--log`/`--log-file`/`--direct` are the only accepted arguments. Anything
  // else still aborts: a stray arg used to fall through and start a FULL
  // supervisor (a `pi-supervisord --help` once ran for days), so unknown args
  // must never silently spawn the daemon fleet.
  const logFlags = parseRelayLogFlags(args);
  if (logFlags.error) {
    process.stderr.write(`pi-supervisord: ${logFlags.error}\n`);
    process.exit(2);
  }
  const direct = logFlags.rest.includes("--direct");
  /*
   * `--port <n>` / `--port=<n>` must reach `ensureDirectRelay`, otherwise an
   * operator whose 4124 is taken has NO command-line escape hatch: the CLI
   * would reject the flag and the only remedy would be an undocumented env var.
   */
  const portArg = readPortFlag(logFlags.rest);
  const unexpected = logFlags.rest.filter(
    (arg) => arg !== "--direct" && arg !== "--port" && !arg.startsWith("--port=") && arg !== portArg,
  );
  if (unexpected.length > 0) {
    process.stderr.write(
      `pi-supervisord: unexpected argument(s): ${unexpected.join(" ")}\n` +
      "Run `pi-supervisord --help`.\n",
    );
    process.exit(2);
  }
  // Mirrors the level into process.env so the spawned daemon children inherit
  // it (each child's log.ts reads the env at startup).
  configureRelayLog({ level: logFlags.level, file: logFlags.file });

  // `--direct` — start the in-process relay BEFORE the Supervisor is
  // constructed. `resolveRelayUrl()` is read when the HostBridge connects
  // (`daemon/supervisor.ts:186`) and when the pairing code is built
  // (`_pairView`, `:550`), so the address must already be in the environment
  // by then. Children inherit `process.env` (`daemon/rpc_child.ts:350`), so
  // they resolve the same relay with nothing else to configure.
  let directUrl: string | null = null;
  if (direct) {
    const { ensureDirectRelay } = await import("../direct.js");
    directUrl = await ensureDirectRelay(portArg === null ? {} : { args: ["--port", portArg] });
    process.stderr.write(
      `[pi-supervisord] direct mode — local relay at ${directUrl} (no community relay)\n`,
    );
  }

  // The supervisor needs to point each spawned Pi at the extension
  // entry it's bundled with. We're at `dist/bin/supervisord.js` after
  // build; the extension is the sibling `dist/index.js`.
  const here = fileURLToPath(import.meta.url);
  const distRoot = dirname(dirname(here));  // dist/bin → dist
  const extensionPath = join(distRoot, "index.js");

  const supervisor = new Supervisor({ extensionPath });
  await supervisor.start();
  /*
   * The embedded relay was started before this Supervisor existed, so it could
   * not receive the room catalog at construction time. Hand it over now: the
   * relay reads the provider lazily on every `subscribe_rooms`, which is what
   * lets the app learn each room's `cwd` (and therefore reach its dock).
   */
  if (direct) {
    const { setRoomCatalogProvider } = await import("../direct.js");
    setRoomCatalogProvider(() => supervisor.roomCatalog());
  }
  process.stderr.write(
    `[pi-supervisord] up — UDS: ~/.pi/remote/supervisor.sock, extension: ${extensionPath}\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(`[pi-supervisord] received ${signal}, shutting down\n`);
    await supervisor.stop();
    if (directUrl) {
      const { stopDirectRelay } = await import("../direct.js");
      await stopDirectRelay();
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // "Already running" is a normal, expected condition (systemd/launchd may
  // race a manual start, or the user double-launches) — not a crash. Report
  // it calmly and exit 0 so service managers don't flag a failure loop.
  if (err instanceof SupervisorAlreadyRunningError) {
    process.stderr.write(`[pi-supervisord] ${err.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`[pi-supervisord] fatal: ${String(err)}\n`);
  process.exit(1);
});
