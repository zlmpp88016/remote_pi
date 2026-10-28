/**
 * Zero-click local pairing for the direct connection (plan/76, TODO A1).
 *
 * ## What it does
 *
 * When the client is served by the same origin that also serves the WebSocket —
 * i.e. the `--direct` server, not the vite dev server talking to a remote relay —
 * there is no reason for the user to copy a pairing code out of a terminal. This
 * module asks the server for the credentials it would have printed, builds the
 * same `PairTarget` the paste-based flow builds, and hands it to the adapter.
 *
 * ## Why it cannot be used to take over someone else's host
 *
 * The server refuses `POST /api/bootstrap` unless the request carries the
 * `SameSite=Strict` bootstrap cookie it planted on the app's own HTML, arrives
 * with `Sec-Fetch-Site: same-origin`, and names a loopback Host. A page on any
 * other origin fails the first two conditions and can neither read the cookie
 * nor set the header. The nonce is single-use, so a captured request cannot be
 * replayed.
 *
 * ## When it silently does nothing
 *
 * Everything here is best-effort on purpose. A dev server, a remote relay, an
 * older server without the endpoint, or a server with no pairing token issued
 * all produce the SAME outcome: `null`, and the caller keeps the manual paste
 * screen. Auto-pairing must never be able to make the app unusable.
 */

/** Credentials the server hands out for a same-origin bootstrap. */
export interface BootstrapCredentials {
  readonly hostEpk: string;
  readonly token: string;
  readonly name: string;
}

export interface BootstrapOptions {
  /** Endpoint path. Defaults to `/api/bootstrap`. */
  readonly bootstrapPath?: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Ask the same-origin server for local pairing credentials.
 *
 * @param options - endpoint override and test seam.
 * @returns the credentials, or `null` when bootstrap is unavailable for any
 *          reason (not same-origin, not the direct server, no token, refusal).
 */
export async function fetchBootstrapCredentials(
  options: BootstrapOptions = {},
): Promise<BootstrapCredentials | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const path = options.bootstrapPath ?? "/api/bootstrap";

  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: "POST",
      /* No body: the proof is the cookie plus Fetch Metadata, not a payload. */
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { hostEpk?: unknown }).hostEpk !== "string" ||
    typeof (parsed as { token?: unknown }).token !== "string" ||
    typeof (parsed as { name?: unknown }).name !== "string"
  ) {
    return null;
  }

  const view = parsed as BootstrapCredentials;
  if (view.hostEpk === "" || view.token === "") return null;
  return { hostEpk: view.hostEpk, token: view.token, name: view.name };
}

/**
 * Build the `remotepi://pair?…` URI a bootstrap result represents.
 *
 * Reusing the URI form (instead of a bespoke object) means the client runs the
 * SAME `parsePairUri` + `adapter.pair` path as a pasted code, so there is only
 * one pairing implementation to keep correct.
 *
 * @param credentials - the values from `fetchBootstrapCredentials`.
 * @returns a pairing URI with no `r=` (the relay is this origin).
 */
export function bootstrapPairUri(credentials: BootstrapCredentials): string {
  const params = new URLSearchParams({
    t: credentials.token,
    epk: credentials.hostEpk,
    n: credentials.name,
    rm: "host",
  });
  return `remotepi://pair?${params.toString()}`;
}
