/**
 * Same-origin HTTP server for the direct connection (plan/76, phase 1).
 *
 * ## Why this exists
 *
 * Today the web client is served by vite on one port and the embedded relay
 * listens on another, which makes them cross-origin. That works only because the
 * embedded relay performs no origin check at all. The moment an origin allowlist
 * is added — and it must be, see `requestSecurity` below — cross-origin breaks.
 *
 * Serving the built client and the WebSocket from one origin removes the whole
 * problem class: no CORS, no mixed content, and `http://127.0.0.1:PORT` is a
 * secure context so WebCrypto (Ed25519) keeps working. It also lets the browser
 * dial `ws://${location.host}`, so a changed port follows the address bar
 * instead of invalidating a stored pairing.
 *
 * ## What is deliberately small
 *
 * A static handler with an SPA fallback, an origin/host gate, a health endpoint
 * and one `upgrade` hand-off into the existing `EmbeddedRelay`. No framework, no
 * dependency: `node:http` plus `node:fs`. The relay keeps owning every piece of
 * protocol logic, so this file can be reverted without touching the wire.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { logRelayEvent } from "../log.js";
import {
  bootstrapCookie,
  consumeBootstrap,
  issueBootstrapNonce,
} from "./bootstrap.js";
/* The SSE endpoint opens `../transport/sse_endpoint.ts` lazily: importing it
 * eagerly would pull `relay_client.ts` (and the WS stack) into every process that
 * only wants static serving. */
type OpenStream = (
  req: IncomingMessage,
  res: ServerResponse,
  relayUrl: string,
) => Promise<string | null>;
let openStreamModule: Promise<{ openEventStream: OpenStream }> | null = null;

/** Resolve the SSE endpoint module once, on first use. */
function loadSseEndpoint(): Promise<{ openEventStream: OpenStream }> {
  openStreamModule ??= import("./sse_endpoint.js") as Promise<{ openEventStream: OpenStream }>;
  return openStreamModule;
}

/** Content types served for the built client. Anything else is `octet-stream`. */
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
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export interface SameOriginServerOptions {
  /** Directory holding the built web client (`clients/web/dist`). */
  readonly staticDir: string;
  /** Port to bind. 0 asks the OS for a free one. */
  readonly port: number;
  /** Bind address. Defaults to loopback — never exposed by accident. */
  readonly host?: string;
  /** Extra exact hostnames accepted in `Host` (for a proxy or a custom name). */
  readonly allowedHosts?: readonly string[];
  /**
   * Extra origins accepted in `Origin`, e.g. the vite dev server
   * (`http://localhost:3010`). Strict same-origin applies when this is empty.
   */
  readonly allowedOrigins?: readonly string[];
  /** Route a WebSocket upgrade into the embedded relay. */
  readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /**
   * Loopback relay address used by the SSE endpoint to attach one relay client
   * per browser stream, e.g. `ws://127.0.0.1:4124`. When omitted, `/api/events`
   * is not registered (the SSE transport is then simply unavailable).
   *
   * A thunk, because in same-origin mode the relay listens on the very port this
   * server is about to bind — the address does not exist until `listen()`
   * returns.
   */
  readonly relayUrl?: () => string | null;
  /**
   * Supply the pairing credentials for zero-click local pairing.
   *
   * Returns `null` when pairing is not available (no token issued, or the host
   * has not decided yet), in which case `/api/bootstrap` answers 503 and the
   * browser falls back to the manual paste screen.
   *
   * Omitted entirely → `/api/bootstrap` is not registered.
   */
  readonly pairingView?: () => Promise<{ hostEpk: string; token: string; name: string } | null>;
}

export interface SameOriginServer {
  /** `http://host:port` — the canonical address clients store. */
  readonly url: string;
  /** The port actually bound (differs from the request when 0 was passed). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the same-origin server.
 *
 * @param options - static root, port and the upgrade hand-off.
 * @returns the listening server plus its canonical URL.
 */
export async function startSameOriginServer(
  options: SameOriginServerOptions,
): Promise<SameOriginServer> {
  const host = options.host ?? "127.0.0.1";
  const staticRoot = resolve(options.staticDir);
  const allowedHosts = new Set(
    (options.allowedHosts ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
  );

  // Resolved after `listen()`; requests cannot arrive before that, so the
  // closure always observes the real bound address.
  let boundIp: string | null = null;

  const server = createServer((req, res) => {
    void handleRequest(
      req,
      res,
      staticRoot,
      allowedHosts,
      allowedOrigins,
      options.relayUrl ?? null,
      options.pairingView ?? null,
      () => boundIp !== null && isLoopbackAddress(boundIp),
    );
  });

  /*
   * The upgrade path goes through exactly the same gate as a normal request: a
   * WebSocket from a foreign page must be refused BEFORE it becomes a socket,
   * otherwise the check is decorative.
   */
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const verdict = checkRequest(req, allowedHosts, allowedOrigins, boundIp === null || isLoopbackAddress(boundIp));
    if (!verdict.ok) {
      logRelayEvent(`same-origin: refused upgrade (${verdict.reason})`);
      socket.write(`HTTP/1.1 ${verdict.status} ${verdict.reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    options.onUpgrade(req, socket, head);
  });

  await new Promise<void>((done, fail) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      fail(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, host);
  });

  const address = server.address();
  if (typeof address === "object" && address !== null) boundIp = address.address;
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  const url = `http://${host}:${port}`;
  logRelayEvent(`same-origin: serving ${staticRoot} at ${url}`);

  return {
    url,
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        /* Drop keep-alive sockets so close() cannot hang on an idle connection. */
        server.closeAllConnections?.();
      }),
  };
}

type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/**
 * Host + Origin + Fetch-Metadata gate.
 *
 * Three independent checks, because each alone is bypassable:
 *
 *  - `Host`: only loopback, an IP literal, or an operator-chosen name. An IP
 *    literal cannot be DNS-rebound because the browser keeps the literal in the
 *    header.
 *  - `Origin`: when present it must match the request origin. A browser always
 *    sends it on a cross-origin request, so a mismatch is an attack, not a typo.
 *  - `Sec-Fetch-Site`: `cross-site` is refused outright. This is the check that
 *    stops any random web page from opening a socket to the loopback port, which
 *    is the actual drive-by risk once the listener is reachable.
 *
 * @param req - the incoming request or upgrade.
 * @param allowedHosts - operator-configured extra hostnames.
 * @returns whether the request may proceed.
 */
function checkRequest(
  req: IncomingMessage,
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
  boundToLoopback: boolean,
): Verdict {
  const hostHeader = req.headers.host;
  const hostname = hostHeader === undefined ? null : hostnameOf(hostHeader);
  if (hostname === null) return { ok: false, status: 400, reason: "Bad Host" };

  const knownHost = isLoopback(hostname) || isIpLiteral(hostname) || allowedHosts.has(hostname);
  if (!knownHost) return { ok: false, status: 403, reason: "Untrusted Host" };

  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return { ok: false, status: 403, reason: "Cross-site" };

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    /*
     * Strict same-origin by default. An operator running the vite dev server on
     * another port must list that origin explicitly — a wildcard here would
     * reinstate exactly the drive-by exposure this check exists to close.
     */
    const isSameOrigin = authorityOf(origin) === hostnameWithPort(hostHeader as string);
    if (!isSameOrigin && !allowedOrigins.has(origin.toLowerCase()) && !isDesktopShellOrigin(origin, boundToLoopback)) {
      return { ok: false, status: 403, reason: "Origin mismatch" };
    }
  }

  return { ok: true };
}

/**
 * The Electron shell's origin: `app://app`.
 *
 * Trusted ONLY when the server itself is bound to loopback, because that is the
 * case the shell exists for — a desktop app driving the daemon on the same
 * machine. On a routable bind it stays untrusted and the operator has to opt in
 * with `REMOTE_PI_ALLOWED_ORIGINS`, exactly as before.
 *
 * This does not weaken the same-origin check it sits beside. That check defends
 * against a *web page* on another site driving the daemon: the browser stamps
 * `Origin` itself and page script cannot change it. `app://app` is only
 * producible by a privileged local process (the shell's main process), and any
 * such process could forge `Origin: http://127.0.0.1:PORT` just as easily while
 * keeping the real browser defence intact. Refusing it bought no security and
 * cost every desktop user a manual environment variable.
 */
/**
 * True when the server is bound to a loopback interface.
 *
 * MUST be derived from the address the server actually listened on, never from
 * the request's `Host` header: that header is supplied by the client, so a
 * daemon bound to `0.0.0.0` and reached from another machine would still see a
 * loopback `Host` if the caller wrote one. Trusting the header there would
 * re-open exactly the exposure this gate exists to close.
 */
function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isDesktopShellOrigin(origin: string, boundToLoopback: boolean): boolean {
  if (origin.toLowerCase() !== "app://app") return false;
  return boundToLoopback;
}

/** Serve one file, or the SPA shell for an unknown path. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  staticRoot: string,
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
  relayUrlThunk: (() => string | null) | null,
  pairingView: (() => Promise<{ hostEpk: string; token: string; name: string } | null>) | null,
  boundToLoopback: () => boolean,
): Promise<void> {
  /*
   * Resolve the relay address at request time, not at construction: in
   * same-origin mode the relay listens on the port this very server binds, so the
   * address only exists once `listen()` has returned. A request can only arrive
   * after that, which is why a thunk is enough.
   */
  const relayUrl = relayUrlThunk === null ? null : relayUrlThunk();
  const verdict = checkRequest(req, allowedHosts, allowedOrigins, boundToLoopback());
  if (!verdict.ok) {
    res.writeHead(verdict.status, { "content-type": "text/plain; charset=utf-8" });
    res.end(verdict.reason);
    return;
  }

  /* Path of the request, resolved once: every route below branches on it. */
  const pathname = pathnameOf(req.url ?? "/");

  if (relayUrl !== null && pathname === "/api/bootstrap") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    await handleBootstrap(req, res, allowedOrigins, pairingView);
    return;
  }

  /*
   * The SSE pair runs BEFORE the GET/HEAD guard, because `/api/frame` is a POST.
   *
   * `/api/events` is the inbound stream; `/api/frame` is the outbound one-shot.
   * Both are registered only when a relay address was supplied, so a
   * same-origin deployment that does not want the SSE transport simply does not
   * expose it.
   */
  if (relayUrl !== null && pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    const { openEventStream } = await loadSseEndpoint();
    await openEventStream(req, res, relayUrl);
    return;
  }
  if (relayUrl !== null && pathname === "/api/frame") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    await handleFramePost(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const target = resolveTarget(req.url ?? "/", staticRoot);
  if (target === null) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  /*
   * A directory request or a client-side route (`/remote-pi/connect`) has no file
   * behind it. Falling back to `index.html` is what makes the SPA routable at all;
   * it is not a 404-hiding trick — every real asset path resolves to a file first.
   */
  const file = (await fileOrNull(target)) ?? (await fileOrNull(join(staticRoot, "index.html")));
  if (file === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const type = CONTENT_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    "content-length": String(file.size),
    /* The shell must never be cached across a deploy, or a stale bundle sticks. */
    "cache-control": file.path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  };
  /*
   * Hand a bootstrap nonce to any same-origin page load.
   *
   * The browser will not let a cross-site page read this cookie, and
   * `SameSite=Strict` keeps it off cross-site requests entirely. That pair of
   * properties is what lets `POST /api/bootstrap` trust the cookie as evidence of
   * "this browser loaded OUR page", without ever handing out the pairing token to
   * an unauthenticated caller.
   */
  if (file.path.endsWith("index.html")) {
    headers["set-cookie"] = bootstrapCookie(issueBootstrapNonce());
  }
  res.writeHead(200, headers);

  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file.path).pipe(res);
}

/**
 * Handle one outbound frame from the browser.
 *
 * The body IS the relay frame (the client sends the same JSONL line it would have
 * written to a WebSocket). The connection id selects which stream's relay client
 * writes it, because a POST carries no socket of its own.
 *
 * @param req - the POST request.
 * @param res - the response; 204 on success.
 */
/**
 * Answer a zero-click local pairing request.
 *
 * Returns the credentials the browser needs to run `pair_request`, but ONLY to a
 * caller that proved it loaded our page from this origin (see `consumeBootstrap`).
 * The nonce is a signed time bucket, reusable within its window: burning it would
 * break an ordinary reload (see bootstrap.ts), so replay protection comes from the
 * `SameSite=Strict` cookie and the Fetch Metadata check instead.
 *
 * @param req - the POST request.
 * @param res - the response.
 * @param allowedOrigins - operator-configured extra origins.
 * @param pairingView - credential source, or `null` when bootstrap is disabled.
 */
async function handleBootstrap(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
  pairingView: (() => Promise<{ hostEpk: string; token: string; name: string } | null>) | null,
): Promise<void> {
  if (pairingView === null) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bootstrap disabled" }));
    return;
  }

  if (!consumeBootstrap(req, req.headers.host, allowedOrigins)) {
    /*
     * One uniform refusal. Distinguishing "no cookie" from "bad cookie" would
     * tell an attacker which half of the check they cleared.
     */
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "untrusted request" }));
    return;
  }

  let view: { hostEpk: string; token: string; name: string } | null;
  try {
    view = await pairingView();
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "pairing unavailable" }));
    return;
  }
  if (view === null) {
    /* No token issued yet: the browser falls back to the manual paste screen. */
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no pairing token" }));
    return;
  }

  /* Bootstrap credentials must never be cached by a proxy or the browser. */
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(view));
}

async function handleFramePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = new URL(req.url ?? "/", "http://placeholder").searchParams.get("id");
  if (id === null || id === "") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing connection id" }));
    return;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    /* A relay frame is small; a huge body means something else is talking. */
    if (total > 4 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(buf);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  const { writeFrameToRelay } = await import("./sse_endpoint.js");
  if (!writeFrameToRelay(id, body)) {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such connection" }));
    return;
  }

  res.writeHead(204);
  res.end();
}

/**
 * Path component of a request URL, without query or hash.
 *
 * @param rawUrl - the raw `req.url`.
 * @returns the pathname, defaulting to `/`.
 */
function pathnameOf(rawUrl: string): string {
  const cut = rawUrl.split(/[?#]/, 1)[0] ?? "/";
  return cut === "" ? "/" : cut;
}

/**
 * Map a URL path onto a file inside the static root, refusing traversal.
 *
 * @param rawUrl - the request URL.
 * @param staticRoot - absolute root directory.
 * @returns the absolute path, or `null` when it escapes the root.
 */
function resolveTarget(rawUrl: string, staticRoot: string): string | null {
  const withoutQuery = rawUrl.split("?", 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  const joined = normalize(join(staticRoot, decoded));
  const rootWithSep = staticRoot.endsWith(sep) ? staticRoot : staticRoot + sep;
  if (joined !== staticRoot && !joined.startsWith(rootWithSep)) return null;
  return joined;
}

/** Stat a path, returning `null` unless it is a readable regular file. */
async function fileOrNull(path: string): Promise<{ path: string; size: number } | null> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  return info.isFile() ? { path, size: info.size } : null;
}

/** `host:port` → lowercase hostname. */
function hostnameOf(hostHeader: string): string | null {
  if (/[\s/@\\]/.test(hostHeader)) return null;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** `host:port` → `host:port` normalized, for comparing against an Origin. */
function hostnameWithPort(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return hostHeader.toLowerCase();
  }
}

/** `http://host:port` → `host:port`, or `null` when unparseable. */
function authorityOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isIpLiteral(hostname: string): boolean {
  return /^\[?[0-9a-f:.]+\]?$/i.test(hostname) && /[0-9]/.test(hostname);
}

export type { Server };
