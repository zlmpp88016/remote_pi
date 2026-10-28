/**
 * Zero-click local pairing for `--direct` (plan/76 phase 1, TODO A1).
 *
 * ## The problem this solves, and the one it must not create
 *
 * Today a local user must run `remote-pi-server pair`, read a code off the
 * terminal, and paste it into the browser. That is friction for no security
 * benefit on the SAME machine.
 *
 * But loopback is a MACHINE-level concept, not a user-level one: any other OS
 * account on the box can also reach `127.0.0.1:4124`. A `/api/bootstrap` that
 * handed out the pairing token to whoever asked would give every local account
 * shell access through the agent. So bootstrap does not trust "the request came
 * from loopback"; it requires evidence that the caller loaded THIS origin's page
 * in a browser, which is what the cookie below represents.
 *
 * ## Why the nonce is signed rather than stored
 *
 * The first design kept issued nonces in a Map. That dies with the process: after
 * a `--direct` restart every tab still held the previous cookie, the map was
 * empty, and bootstrap answered 403 until the user cleared site data — a bug an
 * ordinary reload reproduces immediately.
 *
 * A signed timestamp needs no storage, survives a restart within its window, and
 * cannot be forged without the process key. A restart does invalidate the key,
 * which is correct: a stale tab re-fetches the page and re-earns the cookie.
 *
 * ## What this does NOT defend against
 *
 * Another OS account on the same machine can load the same origin and obtain the
 * cookie, because a browser cannot present an OS-identity proof. That is a
 * property of every loopback listener and is recorded in plan/76 §7 rather than
 * papered over here.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Cookie name carrying the bootstrap nonce. */
const BOOTSTRAP_COOKIE = "pi_bootstrap";

/** Bucket width. A nonce is accepted for the bucket it was minted in and the next. */
const WINDOW_MS = 60_000;

/**
 * Process-wide signing key.
 *
 * `randomBytes` per process: a restart invalidates every outstanding nonce, so a
 * tab from before the restart must reload (and re-earn the cookie) instead of
 * presenting a credential the new process never issued.
 */
const SIGNING_KEY = randomBytes(32);

/**
 * Mint a nonce for one page load.
 *
 * @returns `"<bucket>.<hmac>"` — self-describing and verifiable without storage.
 */
export function issueBootstrapNonce(): string {
  const bucket = Math.floor(Date.now() / WINDOW_MS);
  return `${bucket}.${sign(bucket)}`;
}

/**
 * Sign one time bucket.
 *
 * @param bucket - the bucket number.
 * @returns the hex HMAC.
 */
function sign(bucket: number): string {
  return createHmac("sha256", SIGNING_KEY).update(String(bucket)).digest("hex");
}

/**
 * Read one cookie value out of a request.
 *
 * @param req - the incoming request.
 * @param name - the cookie name.
 * @returns the value, or `null` when absent or malformed.
 */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build the `Set-Cookie` value that hands a nonce to the browser.
 *
 * `SameSite=Strict` is what makes the cookie useless to a cross-site request.
 * `HttpOnly` is intentionally NOT set: the client reads `document.cookie` in
 * diagnostics, and a cross-origin page cannot read it regardless.
 *
 * @param nonce - the value from `issueBootstrapNonce`.
 * @returns the header value, valid for two windows.
 */
export function bootstrapCookie(nonce: string): string {
  return `${BOOTSTRAP_COOKIE}=${encodeURIComponent(nonce)}; Path=/; Max-Age=180; SameSite=Strict`;
}

/**
 * Validate a bootstrap attempt.
 *
 * Three independent conditions, because each alone is bypassable:
 *
 *   1. a `SameSite=Strict` cookie this process signed (proves a same-origin load),
 *   2. `Sec-Fetch-Site: same-origin` (a browser-set header a page cannot forge),
 *   3. `Origin` absent or matching the request host (defence in depth).
 *
 * @param req - the incoming request.
 * @param hostHeader - the value of the request's `Host` header.
 * @param allowedOrigins - operator-configured extra origins.
 * @returns whether bootstrap may proceed.
 */
export function consumeBootstrap(
  req: IncomingMessage,
  hostHeader: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (hostHeader === undefined) return false;

  if (req.headers["sec-fetch-site"] !== "same-origin") return false;

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    let originHost: string;
    let requestHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
      requestHost = new URL(`http://${hostHeader}`).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost !== requestHost && !allowedOrigins.has(origin.toLowerCase())) return false;
  }

  const cookie = readCookie(req, BOOTSTRAP_COOKIE);
  if (cookie === null) return false;
  return verifyNonce(cookie);
}

/**
 * Verify a nonce's signature and age.
 *
 * Accepts the current bucket and the previous one, so a page loaded a moment
 * before a window boundary still works.
 *
 * @param nonce - `"<bucket>.<hmac>"` as issued.
 * @returns whether it is authentic and fresh.
 */
function verifyNonce(nonce: string): boolean {
  const dot = nonce.indexOf(".");
  if (dot <= 0) return false;
  const bucketText = nonce.slice(0, dot);
  if (!/^\d{1,15}$/.test(bucketText)) return false;
  const bucket = Number(bucketText);

  const current = Math.floor(Date.now() / WINDOW_MS);
  if (bucket > current) return false;
  /*
   * Three buckets, not two.
   *
   * The cookie is valid for `Max-Age=180`, so the signature must stay
   * verifiable for the same span: with only `current` and `current - 1`
   * accepted, a page loaded just before a boundary could be refused a moment
   * later while the browser still considered the cookie fresh. That mismatch
   * produced intermittent 403s on an ordinary reload.
   */
  if (current - bucket > 2) return false;

  const expected = sign(bucket);
  const provided = nonce.slice(dot + 1);
  /* Constant-time compare: a length mismatch is a plain reject. */
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reset hook for tests.
 *
 * Signing is stateless, so there is nothing to clear; the export exists so a test
 * that reasons about "no outstanding nonce" has a name to call.
 */
export function clearBootstrapNonces(): void {
  /* Stateless by design — see the module comment. */
}
