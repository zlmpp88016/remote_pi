import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Where `config.json` lives.
 *
 * Resolved per call, NOT frozen into a module constant, and it honours
 * `REMOTE_PI_HOME` like every other state file (registry, workspaces, pairing,
 * supervisor UDS). It used to be `os.homedir()` captured at import time, which
 * meant a second instance started with a redirected home still read and WROTE
 * the developer's real config — a config write aimed at a staging stack
 * silently rewrote the dev stack's relay. `pairing/storage.ts` documents the
 * same trap; this is the remaining copy of it.
 */
function configFile(): string {
  const home = process.env["REMOTE_PI_HOME"] || os.homedir();
  return path.join(home, ".pi", "remote", "config.json");
}

/**
 * Default community relay. Stored in canonical http(s):// form — conversion
 * to ws(s):// happens at the transport layer (see `toWebSocketUrl`). The
 * community relay's reverse proxy maps `:443 → :3000` (the WS port), so the
 * URL has no explicit port and the WebSocket upgrade rides on the same TLS
 * connection as the HTTPS endpoints used by the mesh client.
 */
export const kDefaultRelayUrl = "https://relay.880160.xyz";

export type RemotePiConfig = {
  relay?: string;
  /**
   * Address PAIRING CODES carry, when it differs from what the host dials
   * (a tunnel in front). Rarely needed now that the server binds every
   * interface: the LAN address is detected automatically.
   */
  publicRelay?: string;
  /** Extra hostnames the same-origin gate accepts. Only for exotic reverse
   *  proxies — a plain LAN address needs nothing. */
  allowedHosts?: string[];
  /** Interface to bind. Default: every interface (reachable from any IP). */
  bind?: string;
  /** Port for the embedded relay + web client. Default 4124. */
  port?: number;
  /** Fixed pairing code, set by the operator. When present it replaces the
   *  generated token and survives restarts — no `pair` run needed. */
  pairingCode?: string;
};

export function loadConfig(): RemotePiConfig {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as RemotePiConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<RemotePiConfig>): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

export type RelayResolution = { url: string; source: "env" | "config" | "lan" | "default" };

/**
 * Resolves the effective relay URL in **canonical http(s):// form**.
 *
 * Precedence:
 *   1. `REMOTE_PI_RELAY` env var (ops/CI escape hatch)
 *   2. `~/.pi/remote/config.json` `relay` field (set via /remote-pi set-relay)
 *   3. `kDefaultRelayUrl` (community default)
 *
 * Any ws(s):// values found (legacy configs or env overrides) are coerced
 * to http(s):// defensively — the canonical form across the codebase is
 * http(s)://, and the transport layer converts to ws(s):// at WS-open time.
 */
export function resolveRelayUrl(): RelayResolution {
  const env = process.env["REMOTE_PI_RELAY"];
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" };
  const cfg = loadConfig();
  if (cfg.relay && cfg.relay.length > 0) return { url: toHttpUrl(cfg.relay), source: "config" };
  return { url: toHttpUrl(kDefaultRelayUrl), source: "default" };
}

/**
 * Resolve the address a CLIENT should dial, which is not always the address this
 * host dials.
 *
 * In the default setup they ARE the same thing: the server binds every
 * interface, so any device can reach `http://<lan-ip>:PORT` and the detector
 * below puts that literal in the pairing code. Nothing to configure.
 *
 * The override exists only for the remaining case — a tunnel or reverse proxy
 * that forwards a NAME (`frp type = http`, nginx `server_name`, cloudflared).
 * Then the literal is not what a phone should dial, and `publicRelay` names it.
 *
 * Precedence: `REMOTE_PI_PUBLIC_RELAY` → config `publicRelay` → the detected
 * LAN literal → `resolveRelayUrl()`.
 */
export function resolvePublicRelayUrl(): RelayResolution {
  const env = process.env["REMOTE_PI_PUBLIC_RELAY"];
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" };
  const cfg = loadConfig();
  if (cfg.publicRelay && cfg.publicRelay.length > 0) {
    return { url: toHttpUrl(cfg.publicRelay), source: "config" };
  }
  /*
   * No override. If this host is reachable on the network, hand out ITS OWN
   * address — that is the whole "any IP, port, pairing code" flow.
   *
   * Bound to LOOPBACK there is no such address: advertising the LAN literal
   * would hand out a URL that refuses the connection, so the previous
   * behaviour (the relay URL, or whatever `--direct` published) applies.
   */
  const bind = resolveBindHost();
  const loopbackOnly = bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
  if (!loopbackOnly) {
    const lan = detectLanAddress();
    if (lan !== null) {
      return { url: `http://${lan}:${resolvePort()}`, source: "lan" };
    }
  }
  return resolveRelayUrl();
}

/** Default port for the embedded relay + web client. */
export const kDefaultPort = 4124;

/**
 * Port the embedded relay and dashboard listen on.
 *
 * Precedence: `REMOTE_PI_PORT` → config `port` → 4124. Argument parsing
 * (`--port <n>`) lives in `direct.ts`, which delegates here for the fallback.
 */
export function resolvePort(): number {
  const env = process.env["REMOTE_PI_PORT"];
  if (env !== undefined && env.trim() !== "") {
    const parsed = Number.parseInt(env, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const cfg = loadConfig();
  if (typeof cfg.port === "number" && Number.isInteger(cfg.port) && cfg.port >= 0) return cfg.port;
  return kDefaultPort;
}

/**
 * This machine's address on the local network, or `null` when it has none.
 *
 * IPv4 only, because that is what a phone will type and what the pairing code
 * carries: an mDNS name is not resolvable everywhere and an IPv6 literal needs
 * brackets in a URL. `internal` (loopback) and `169.254.x.x` (link-local, the
 * "no DHCP" fallback that never routes) are skipped — neither is an address
 * another device can dial.
 *
 * Order is whatever the OS reports, which is what we want: the primary
 * interface is normally first, and VMs/adapters come after.
 */
export function detectLanAddress(): string | null {
  const override = process.env["REMOTE_PI_ADVERTISE"];
  if (override !== undefined && override.trim() !== "") return override.trim();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      return entry.address;
    }
  }
  return null;
}

/**
 * Interface the embedded relay and web server bind.
 *
 * EVERY interface by default. The whole point of the pairing code is that a
 * phone on the same network pastes it and connects; binding loopback made that
 * impossible without a tunnel, an env var and a hostname allowlist — three
 * steps for what should be one paste.
 *
 * What still protects the port:
 *   - pairing: the host refuses `pair_request` without the token, so a stranger
 *     on the network gets a socket and nothing else;
 *   - the same-origin gate: on a non-loopback bind it admits IP-literal and
 *     configured hosts but still refuses cross-site requests, which is what
 *     stops a malicious web page from driving the daemon.
 *
 * Set `bind` (config) or `REMOTE_PI_BIND` to `127.0.0.1` to keep it private.
 */
export function resolveBindHost(): string {
  const env = process.env["REMOTE_PI_BIND"];
  if (env !== undefined && env.trim() !== "") return env.trim();
  const cfg = loadConfig();
  if (typeof cfg.bind === "string" && cfg.bind.trim() !== "") return cfg.bind.trim();
  return "0.0.0.0";
}

/**
 * The operator's fixed pairing code, or `null` when none is configured.
 *
 * A predefined code is what makes "install it and connect" work across
 * restarts without re-running `pair`: the same code keeps working until the
 * operator changes it. Generated codes (random, persisted) remain the default
 * so nothing changes for anyone who does not set one.
 */
export function resolveFixedPairingCode(): string | null {
  const env = process.env["REMOTE_PI_PAIRING_CODE"];
  if (env !== undefined && env.trim() !== "") return env.trim();
  const cfg = loadConfig();
  if (typeof cfg.pairingCode === "string" && cfg.pairingCode.trim() !== "") {
    return cfg.pairingCode.trim();
  }
  return null;
}

/**
 * Hostnames the same-origin gate must accept beyond loopback and IP literals.
 *
 * The gate exists so a `Host` header from a foreign page cannot drive the
 * daemon; it is not meant to block the operator's OWN tunnel. A tunneler that
 * forwards a NAME (frp `type = http`, nginx `server_name`, cloudflared) makes
 * every request arrive as `Host: pi.example.com`, which the gate rejects with
 * 403 unless the name is listed — and since `boundIp` stays `127.0.0.1`, nothing
 * about the bind address reveals this.
 *
 * Precedence: `REMOTE_PI_ALLOWED_HOSTS` (comma-separated) → config
 * `allowedHosts` → empty. Read together so a tunnel name survives a restart
 * instead of living only in the shell that started the process.
 */
export function resolveAllowedHosts(): string[] {
  const env = process.env["REMOTE_PI_ALLOWED_HOSTS"];
  if (env !== undefined && env.trim() !== "") {
    return env
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
  return (loadConfig().allowedHosts ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Strict validator for **user-provided** relay URLs (via `/remote-pi
 * set-relay` or `/remote-pi relay url`).
 *
 * Only accepts `http://` and `https://`. `ws://`/`wss://` are deliberately
 * **rejected** — the canonical form stored in config is http(s):// and the
 * extension converts to ws(s):// internally when opening the WebSocket.
 * Forcing a single scheme at the user boundary avoids two-form drift.
 */
export function isValidRelayUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  try { new URL(url); return true; } catch { return false; }
}

/**
 * Returns true if the URL uses ws:// or wss:// scheme — for emitting a
 * targeted error message when the user pastes a WebSocket URL by mistake.
 */
export function isWebSocketScheme(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("ws://") || lower.startsWith("wss://");
}

/**
 * Converts an http(s):// URL to the corresponding ws(s):// form. Used by
 * the transport layer right before opening the WebSocket — config storage
 * and the mesh HTTP client both stay on http(s)://.
 *
 *   https://host  → wss://host
 *   http://host   → ws://host
 *   ws(s)://host  → pass-through (defensive — env overrides or legacy
 *                   configs may still carry ws(s)://)
 */
export function toWebSocketUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (lower.startsWith("http://"))  return "ws://"  + url.slice("http://".length);
  return url;
}

/**
 * Inverse of `toWebSocketUrl`. Used by `resolveRelayUrl` to coerce any
 * ws(s):// values back to canonical http(s):// before returning them to
 * the rest of the codebase.
 */
export function toHttpUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("wss://")) return "https://" + url.slice("wss://".length);
  if (lower.startsWith("ws://"))  return "http://"  + url.slice("ws://".length);
  return url;
}
