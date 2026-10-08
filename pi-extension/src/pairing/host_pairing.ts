import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { TOKEN_TTL_MS } from "./qr.js";

/**
 * Plan/69 W1 — the HOST-side pairing token, issued and consumed by the
 * supervisor (never by a Pi process).
 *
 * Where `QRSession` (qr.ts) keeps the single active token in the RAM of one
 * Pi process, this store persists it to `~/.pi/remote/pairing.json` so
 * `remote-pi pair` works with ZERO Pi processes running and the code
 * survives a supervisor reboot.
 *
 * Two modes:
 *  - **persistent** (default): the code is "predefined on the host" — it
 *    stays valid across restarts and may pair any number of devices until
 *    it is explicitly rotated (`remote-pi pair --rotate`).
 *  - **ephemeral** (`--ephemeral`): short TTL and single-use, reusing the
 *    `QRSession` semantics for callers who prefer them.
 *
 * The URI built from this token (`remotepi://pair?…`) is byte-identical to
 * the one a Pi emits — see `buildQRUri` in qr.ts and the frozen-payload
 * regression test in qr.test.ts.
 */

/** Resolved at call time so tests can override via `REMOTE_PI_HOME` (same
 *  convention as daemons.json / workspaces.json). Prod path is always
 *  `~/.pi/remote/pairing.json`. */
function pairingPathInternal(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  return join(root, ".pi", "remote", "pairing.json");
}

/** One persisted pairing record. Shape is versioned by the file itself; an
 *  unrecognized/corrupt file is treated as "no active code" (never as a
 *  valid token) so a bad write fails closed. */
export interface HostPairingRecord {
  token: string;
  /** `null` → persistent (valid until rotated). Epoch ms → ephemeral expiry. */
  expires_at: number | null;
  persistent: boolean;
  /** Ephemeral single-use bookkeeping — persisted so a supervisor restart
   *  cannot resurrect an already-consumed ephemeral token. */
  consumed: boolean;
  issued_at: string;
}

export type HostTokenStatus = "ok" | "expired" | "consumed" | "unknown";

function _isRecord(value: unknown): value is HostPairingRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.token === "string" &&
    r.token.length > 0 &&
    typeof r.persistent === "boolean" &&
    typeof r.consumed === "boolean" &&
    typeof r.issued_at === "string" &&
    (r.expires_at === null || (typeof r.expires_at === "number" && Number.isFinite(r.expires_at)))
  );
}

export class HostPairingSession {
  /** Serializes read-modify-write cycles so concurrent consume/issue calls
   *  (control op + host-room pair_request) can't interleave on the file. */
  private queue: Promise<unknown> = Promise.resolve();

  private _serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Issues a fresh token, invalidating any previous one (rotate semantics).
   * `ttlMs` is honored verbatim — callers clamp it (see `clampPairTtlMs`).
   */
  async issue(opts: { ephemeral?: boolean; ttlMs?: number } = {}): Promise<HostPairingRecord> {
    const ephemeral = opts.ephemeral === true;
    const record: HostPairingRecord = {
      token: randomBytes(16).toString("base64url"),
      expires_at: ephemeral ? Date.now() + (opts.ttlMs ?? TOKEN_TTL_MS) : null,
      persistent: !ephemeral,
      consumed: false,
      issued_at: new Date().toISOString(),
    };
    await this._serialize(() => this._write(record));
    return record;
  }

  /** Reads the active record, or null when absent/corrupt. Never issues. */
  async show(): Promise<HostPairingRecord | null> {
    return this._serialize(async () => {
      try {
        const raw = await readFile(pairingPathInternal(), "utf8");
        const parsed = JSON.parse(raw) as unknown;
        return _isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    });
  }

  /**
   * Validates a token against the persisted record. Mirrors
   * `QRSession.consumeToken`: an unknown token (rotated away, or issued by
   * another host) is `unknown`; an ephemeral token is single-use and its
   * consumption is persisted; a persistent token stays valid until rotated.
   */
  async consume(token: string): Promise<HostTokenStatus> {
    return this._serialize(async () => {
      const rec = await this._read();
      if (!rec || rec.token !== token) return "unknown";
      if (rec.consumed) return "consumed";
      if (rec.expires_at !== null && Date.now() > rec.expires_at) return "expired";
      if (!rec.persistent) await this._write({ ...rec, consumed: true });
      return "ok";
    });
  }

  private async _read(): Promise<HostPairingRecord | null> {
    try {
      const raw = await readFile(pairingPathInternal(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return _isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async _write(record: HostPairingRecord): Promise<void> {
    const path = pairingPathInternal();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(record, null, 2));
    // Best-effort tighten (the pairing token is a credential until rotated).
    try { await chmod(path, 0o600); } catch { /* not fatal */ }
  }
}

/** Process-wide store shared by the supervisor's control ops and the
 *  HostBridge pair_request handler. */
export const hostPairing = new HostPairingSession();

/** Test-only: the resolved pairing.json path (so tests can assert/cleanup). */
export function pairingPathForTest(): string {
  return pairingPathInternal();
}
