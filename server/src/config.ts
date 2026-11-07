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
 * the developer's real config — `set-public-relay` aimed at a staging stack
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

export type RemotePiConfig = { relay?: string; publicRelay?: string; allowedHosts?: string[] };

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

export type RelayResolution = { url: string; source: "env" | "config" | "default" };

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
 * `resolveRelayUrl()` answers "where does the host stack connect". Behind a
 * tunneler (frp, cloudflared, nginx, an SSH `-L`) those two answers differ: the
 * host still connects to `127.0.0.1:PORT`, while a phone on another network must
 * be handed the public address and nothing else.
 *
 * Overloading `REMOTE_PI_RELAY` for both cannot express that. Setting it to the
 * public address makes the host loop out over the internet to reach itself — and
 * fail when the tunnel is down or the name only resolves for the outside world.
 * `--direct` makes it worse: it fills `REMOTE_PI_RELAY` with the loopback
 * address, so every pairing code carries `http://127.0.0.1:PORT` and a remote
 * phone dials its own localhost.
 *
 * Precedence: `REMOTE_PI_PUBLIC_RELAY` → config `publicRelay` → `resolveRelayUrl()`.
 * The last step keeps every untunnelled setup working unchanged.
 */
export function resolvePublicRelayUrl(): RelayResolution {
  const env = process.env["REMOTE_PI_PUBLIC_RELAY"];
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" };
  const cfg = loadConfig();
  if (cfg.publicRelay && cfg.publicRelay.length > 0) {
    return { url: toHttpUrl(cfg.publicRelay), source: "config" };
  }
  return resolveRelayUrl();
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
