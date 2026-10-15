/**
 * Opt-in relay traffic logging (ops/debug).
 *
 * OFF by default. Turn it on per process either with a CLI flag:
 *
 *   pi-supervisord --log summary            one line per frame
 *   pi-supervisord --log full               same, plus the raw JSON line
 *   pi-supervisord --log full --log-file /tmp/relay.log
 *
 * or with the equivalent env vars (used by the `remote-pi` one-shots and by
 * daemon children, which inherit them from the supervisor):
 *
 *   REMOTE_PI_LOG=summary|full, REMOTE_PI_LOG_FILE=<path>
 *
 * Writes ONLY to stderr. In RPC daemon children stdout is the JSON-RPC
 * channel — a stray byte there corrupts the protocol, so stdout is never
 * touched. Daemon children already have their stderr prefixed with the cwd
 * by `rpc_child`, which is what makes host-room and child-room traffic
 * distinguishable in one terminal.
 */

import { appendFileSync } from "node:fs";

export type RelayLogLevel = "off" | "summary" | "full";

/** Parsed `--log`/`--log-file` flags. */
export interface RelayLogFlags {
  level?: RelayLogLevel;
  file?: string;
  /** Arguments that were not log flags (caller decides what to do with them). */
  rest: string[];
  /** Set when a flag was present but malformed. */
  error?: string;
}

/** Maps the accepted spellings to a level. Returns null when unrecognised. */
function parseLevel(raw: string): RelayLogLevel | null {
  const v = raw.trim().toLowerCase();
  if (v === "full" || v === "debug" || v === "2") return "full";
  if (v === "summary" || v === "on" || v === "true" || v === "1") return "summary";
  if (v === "off" || v === "false" || v === "0" || v === "none") return "off";
  return null;
}

/**
 * Extracts `--log <level>` / `--log-file <path>` (also `--log=<level>` form)
 * from an argument list, leaving everything else in `rest`.
 */
export function parseRelayLogFlags(argv: string[]): RelayLogFlags {
  const out: RelayLogFlags = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (key !== "--log" && key !== "--log-file") {
      out.rest.push(arg);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") {
      out.error = `${key} requires a value`;
      return out;
    }
    if (key === "--log") {
      const level = parseLevel(value);
      if (level === null) {
        out.error = `invalid --log value '${value}' (expected off|summary|full)`;
        return out;
      }
      out.level = level;
    } else {
      out.file = value;
    }
  }
  return out;
}

// Resolution is lazy so `configureRelayLog()` (called from CLI arg parsing in
// `main()`) wins over the module-load env snapshot.
let configuredLevel: RelayLogLevel | null = null;
let configuredFile: string | undefined;
let envRead = false;

function envLevel(): RelayLogLevel {
  const raw = process.env["REMOTE_PI_LOG"] ?? "";
  return parseLevel(raw) ?? "off";
}

function currentLevel(): RelayLogLevel {
  if (configuredLevel === null) {
    envRead = true;
    configuredLevel = envLevel();
  }
  return configuredLevel;
}

function currentFile(): string | undefined {
  return configuredFile ?? process.env["REMOTE_PI_LOG_FILE"];
}

/**
 * Applies CLI-flag configuration. Also mirrors it into `process.env` so
 * daemon children spawned afterwards inherit the same level (their own
 * `log.ts` reads the env at startup).
 */
export function configureRelayLog(opts: { level?: RelayLogLevel; file?: string; inheritEnv?: boolean }): void {
  if (opts.level !== undefined) {
    configuredLevel = opts.level;
    if (opts.inheritEnv !== false) process.env["REMOTE_PI_LOG"] = opts.level;
  }
  if (opts.file !== undefined) {
    configuredFile = opts.file;
    if (opts.inheritEnv !== false) process.env["REMOTE_PI_LOG_FILE"] = opts.file;
  }
}

const RAW_LIMIT = 2_000;

export function relayLogEnabled(): boolean {
  return currentLevel() !== "off";
}

function write(line: string): void {
  process.stderr.write(line + "\n");
  const file = currentFile();
  if (file) {
    try {
      appendFileSync(file, line + "\n");
    } catch {
      /* best-effort — logging must never break the connection */
    }
  }
}

/** Shortens a base64 peer id for a one-line log. */
function short(peer: string): string {
  return peer.length > 10 ? `${peer.slice(0, 8)}…` : peer;
}

/**
 * Summarises one wire frame. Outer envelopes `{peer, room, ct}` are decoded
 * one level so the log shows the APPLICATION message type (host_forward,
 * agent_chunk, …) instead of an opaque `ct`.
 */
export function describeFrame(raw: string): string {
  try {
    const o = JSON.parse(raw) as { type?: string; peer?: string; room?: string; ct?: string };
    if (typeof o.type === "string") return `type=${o.type}`; // auth/control frame
    if (typeof o.ct === "string") {
      let innerType = "?";
      try {
        const inner = JSON.parse(Buffer.from(o.ct, "base64").toString("utf8")) as { type?: string };
        if (typeof inner.type === "string") innerType = inner.type;
      } catch {
        /* opaque payload — keep the placeholder */
      }
      return `room=${o.room ?? "-"} peer=${o.peer ? short(o.peer) : "-"} type=${innerType}`;
    }
  } catch {
    /* not JSON — fall through to a byte count */
  }
  return `bytes=${raw.length}`;
}

/** Logs one frame in either direction. No-op unless logging is enabled. */
export function logFrame(dir: "tx" | "rx", raw: string): void {
  const level = currentLevel();
  if (level === "off") return;
  const detail = describeFrame(raw);
  const dump = level === "full" ? ` ${raw.length > RAW_LIMIT ? raw.slice(0, RAW_LIMIT) + "…" : raw}` : "";
  write(`[relay ${dir}] ${detail}${dump}`);
}

/** Protocol progression that is not a frame (connect/auth/close). */
export function logRelayEvent(msg: string): void {
  if (currentLevel() === "off") return;
  write(`[relay] ${msg}`);
}

/** Test-only: drop the memoised level so the next call re-reads the env. */
export function _resetRelayLogForTest(): void {
  configuredLevel = null;
  configuredFile = undefined;
  envRead = false;
}

/** True once the level has been resolved from anywhere (test introspection). */
export function _relayLogResolvedFromEnvForTest(): boolean {
  void currentLevel();
  return envRead;
}
