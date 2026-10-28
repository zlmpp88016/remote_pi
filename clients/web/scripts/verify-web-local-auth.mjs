/**
 * Local-auth gate for the `--direct` same-origin server (plan/76 TODO C1).
 *
 * ## What this proves, and why it uses raw sockets
 *
 * The same-origin server refuses requests on three independent grounds: a foreign
 * `Host`, a cross-site `Origin`, and a cross-site `Sec-Fetch-Site`. Each check
 * must be provably load-bearing, so every case here is crafted to be refused by
 * exactly ONE of them — if a request carries both a bad Origin and a bad
 * Fetch-Site header, either check alone would produce a 403 and the test could
 * not tell which one still worked. A browser cannot send these header
 * combinations (they are browser-controlled), so raw HTTP over a socket is the
 * only honest way to exercise them.
 *
 * The `Sec-Fetch-Site` case is the important one: it sends NO `Origin`, so
 * nothing can mask a missing Fetch Metadata check, and it asserts the refusal
 * REASON rather than just the status code — a title-only assertion would stay
 * green if the reason silently changed to a different guard.
 *
 * ## Why it is NOT a browser test
 *
 * This gate is deliberately header-level. The browser-facing half (does a real
 * page actually connect?) lives in `verify-web-sse-transport.mjs`; duplicating a
 * CDP session here would only re-test the same headers with less control.
 */
import { mkdirSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "_e2e-evidence");
mkdirSync(EVIDENCE, { recursive: true });

const PORT = Number(process.env.DIRECT_PORT ?? 4124);
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

const results = [];
/**
 * Record one assertion.
 *
 * @param ok - whether it held.
 * @param label - what was checked.
 * @param detail - observed value for a failure.
 */
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

/**
 * Send one raw HTTP request with the exact headers given.
 *
 * `node:http` is used instead of `fetch` because `fetch` refuses to send a
 * mismatched `Host`, and the foreign-Host case cannot be expressed otherwise.
 *
 * @param options - method, path and headers.
 * @returns status, reason phrase and body.
 */
function raw(options) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: HOST,
        port: PORT,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: options.headers ?? {},
        /* Do not let Node rewrite or validate the Host we asked for. */
        setHost: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, reason: body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body ?? undefined);
  });
}

/* ── 1. The legitimate same-origin request must be served ─────────────────── */
const healthy = await raw({ path: "/healthz", headers: { host: `${HOST}:${PORT}` } });
check(healthy.status === 200, "loopback Host is served", `status ${healthy.status}`);

/* ── 2. A foreign Host must be refused (DNS-rebinding case) ──────────────── */
const foreignHost = await raw({ path: "/healthz", headers: { host: `evil.example:${PORT}` } });
check(
  foreignHost.status === 403,
  "foreign Host is refused",
  `status ${foreignHost.status} body ${foreignHost.reason.slice(0, 40)}`,
);

/* ── 3. `Sec-Fetch-Site: cross-site` with NO Origin ──────────────────────── */
/*
 * No Origin header on purpose: that is what a cross-site navigation or a
 * subresource load looks like, and it means ONLY the Fetch Metadata check can
 * produce the refusal. Assert the reason, not just the status.
 */
const crossSite = await raw({
  path: "/healthz",
  headers: { host: `${HOST}:${PORT}`, "sec-fetch-site": "cross-site" },
});
check(
  crossSite.status === 403 && crossSite.reason.trim() === "Cross-site",
  "cross-site Fetch Metadata is refused by its own check",
  `status ${crossSite.status} reason ${JSON.stringify(crossSite.reason.trim())}`,
);

/* ── 4. A cross-origin Origin header, no Fetch Metadata ──────────────────── */
/*
 * Again isolated: no `sec-fetch-site`, so only the Origin comparison can refuse.
 */
const badOrigin = await raw({
  path: "/healthz",
  headers: { host: `${HOST}:${PORT}`, origin: "http://evil.example" },
});
check(
  badOrigin.status === 403 && badOrigin.reason.trim() === "Origin mismatch",
  "cross-origin Origin is refused by its own check",
  `status ${badOrigin.status} reason ${JSON.stringify(badOrigin.reason.trim())}`,
);

/* ── 5. Bootstrap refuses a caller with no same-origin evidence ──────────── */
const bootstrapAnon = await raw({
  method: "POST",
  path: "/api/bootstrap",
  headers: { host: `${HOST}:${PORT}`, "content-type": "application/json" },
});
check(
  bootstrapAnon.status === 403,
  "bootstrap refuses a request with no cookie and no Fetch Metadata",
  `status ${bootstrapAnon.status}`,
);

/* ── 6. Bootstrap refuses a cross-site caller even with a cookie-shaped value */
const bootstrapCrossSite = await raw({
  method: "POST",
  path: "/api/bootstrap",
  headers: {
    host: `${HOST}:${PORT}`,
    "content-type": "application/json",
    "sec-fetch-site": "cross-site",
    cookie: "pi_bootstrap=1.deadbeef",
  },
});
check(
  bootstrapCrossSite.status === 403,
  "bootstrap refuses a cross-site caller",
  `status ${bootstrapCrossSite.status}`,
);

/* ── 7. The real flow works: index.html sets a cookie, then bootstrap 200s ── */
const page = await raw({ path: "/", headers: { host: `${HOST}:${PORT}` } });
const setCookie = page.headers["set-cookie"];
const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
const cookie = typeof cookieHeader === "string" ? cookieHeader.split(";")[0] : "";
check(cookie.startsWith("pi_bootstrap="), "index.html issues a bootstrap cookie", cookie.slice(0, 24));

if (cookie !== "") {
  const bootstrapOk = await raw({
    method: "POST",
    path: "/api/bootstrap",
    headers: {
      host: `${HOST}:${PORT}`,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
    },
  });
  check(
    bootstrapOk.status === 200 && bootstrapOk.reason.includes("hostEpk"),
    "bootstrap serves credentials to a same-origin page",
    `status ${bootstrapOk.status}`,
  );

  /*
   * Positive control for the cookie: drop it and the same request must fail.
   * Without this, "403 when anonymous" would pass even if the cookie were
   * ignored entirely.
   */
  const bootstrapNoCookie = await raw({
    method: "POST",
    path: "/api/bootstrap",
    headers: { host: `${HOST}:${PORT}`, "content-type": "application/json", "sec-fetch-site": "same-origin" },
  });
  check(
    bootstrapNoCookie.status === 403,
    "bootstrap refuses the same request without the cookie",
    `status ${bootstrapNoCookie.status}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.label).join(", ")}`);
  process.exit(1);
}
