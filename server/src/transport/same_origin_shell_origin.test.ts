/**
 * The Electron shell's `app://app` origin, and the loopback-only rule that
 * gates it.
 *
 * WHY THIS EXISTS: the desktop app loads the web client from a custom scheme, so
 * every page request and every WebSocket upgrade carries `Origin: app://app`
 * while the server is `http://127.0.0.1:PORT`. Strict same-origin comparison
 * refuses that, which made pairing impossible until the operator discovered
 * `REMOTE_PI_ALLOWED_ORIGINS=app://app` — an environment variable demanded of
 * every desktop user for a flow the desktop app is supposed to make effortless.
 *
 * The trust is deliberately narrow: loopback binds only. On a routable bind the
 * origin stays untrusted and the operator must opt in, because there the daemon
 * is reachable by other machines and the usual same-origin reasoning applies.
 */

import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startSameOriginServer, type SameOriginServer } from "./same_origin_server.js";

let staticDir: string;
let server: SameOriginServer | null = null;

beforeEach(() => {
  staticDir = mkdtempSync(join(tmpdir(), "rp-origin-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
});

afterEach(async () => {
  if (server !== null) {
    await server.close();
    server = null;
  }
  rmSync(staticDir, { recursive: true, force: true });
});

/** Fire a bare HTTP request carrying a chosen `Origin`, and report the status. */
function statusFor(port: number, origin: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = createRequest(
      {
        port,
        path: "/index.html",
        headers: origin === null ? {} : { origin },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Thin wrapper so the test does not repeat the node:http plumbing. */
function createRequest(
  options: { port: number; path: string; headers: Record<string, string> },
  onResponse: (res: import("node:http").IncomingMessage) => void,
): import("node:http").ClientRequest {
  return httpRequest(
    {
      host: "127.0.0.1",
      port: options.port,
      path: options.path,
      method: "GET",
      headers: options.headers,
    },
    onResponse,
  );
}

describe("app://app origin", () => {
  it("is accepted on a loopback bind without any operator configuration", async () => {
    server = await startSameOriginServer({ host: "127.0.0.1", staticDir });
    const port = server.port;
    expect(await statusFor(port, "app://app")).toBe(200);
  });

  it("is still refused for a foreign web origin", async () => {
    server = await startSameOriginServer({ host: "127.0.0.1", staticDir });
    const port = server.port;
    // The whole point: opening the loopback door to the desktop shell must not
    // open it to an arbitrary site that talks to the daemon from a browser tab.
    expect(await statusFor(port, "https://evil.example")).toBe(403);
  });

  it("is NOT trusted when the server is bound to a routable address", async () => {
    // Binding to all interfaces stands in for "reachable by other machines".
    // `app://app` must fall back to requiring an explicit allow-list entry.
    server = await startSameOriginServer({ host: "0.0.0.0", staticDir });
    const port = server.port;
    expect(await statusFor(port, "app://app")).toBe(403);
  });

  it("honours an explicit allow-list entry regardless of bind address", async () => {
    server = await startSameOriginServer({
      host: "0.0.0.0",
      staticDir,
      allowedOrigins: ["app://app"],
    });
    const port = server.port;
    expect(await statusFor(port, "app://app")).toBe(200);
  });
});
