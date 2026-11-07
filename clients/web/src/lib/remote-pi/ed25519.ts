/**
 * Ed25519 for the browser — capability detection + pure-TS fallback.
 *
 * Context (plan 69, W4): the minimal web client must authenticate against the
 * relay exactly like the clients/mobile/Pi do — the relay handshake is
 * `hello {pubkey} → challenge {nonce} → auth {sig}` with an Ed25519 signature
 * over the raw nonce bytes (relay/src/auth/challenge.rs). The client therefore
 * needs an ephemeral Ed25519 App-key (PROTOCOL.md: "App-key Ed25519 efêmera …
 * RAM do app … por sessão de pareamento").
 *
 * Capability strategy:
 *   1. `webcrypto` — native Ed25519 via SubtleCrypto (`crypto.subtle`).
 *      Chrome/Edge 137+, Safari 17+, Firefox 129+ (also every Node ≥ 18 with
 *      WebCrypto, which is how the Node test harness exercises this path).
 *   2. `pure-ts`  — self-contained RFC 8032 implementation (BigInt field
 *      arithmetic, SHA-512 from SubtleCrypto) for browsers without native
 *      Ed25519.
 *
 * Deviation from the plan wording ("fallback wasm"): the shipped fallback is
 * pure TypeScript, not wasm — zero new dependencies, no wasm toolchain, and
 * the fallback is fully testable in Node against RFC 8032 vectors. Swapping
 * the fallback for an audited wasm artifact later is a drop-in change behind
 * the same `Ed25519Signer` interface (tracked as a follow-up note).
 *
 * SHA-512 always comes from SubtleCrypto (`crypto.subtle.digest`) — it is
 * available in every browser that has SubtleCrypto at all, including the ones
 * that lack Ed25519. Without SubtleCrypto (non-secure context) neither path
 * can run; that is surfaced as a thrown error, never a silent downgrade.
 */

/** Which backend produced a signer. Exposed so the UI and tests can show it. */
export type Ed25519Backend = "webcrypto" | "pure-ts";

export interface Ed25519Signer {
  /** Raw 32-byte Ed25519 public key (the relay peer identity). */
  readonly publicKeyRaw: Uint8Array;
  /** Canonical wire form of the public key: standard base64 WITH padding
   *  (PROTOCOL.md — "Base64 RFC 4648 padrão com padding"). */
  readonly publicKeyBase64: string;
  /** Backend that produced this signer. */
  readonly backend: Ed25519Backend;
  /** Signs `message` (raw bytes) → 64-byte Ed25519 signature. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export class Ed25519UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ed25519UnavailableError";
  }
}

// ── base64 helpers (portable: browser btoa/atob) ───────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // stay well below argument-count limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Normalizes a base64url (possibly unpadded) string to standard base64. */
export function base64UrlToBase64(value: string): string {
  let std = value.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4 !== 0) std += "=";
  return std;
}

// ── SHA-512 (SubtleCrypto when available, pure TS otherwise) ───────────────

type Digest = (bytes: Uint8Array) => Promise<Uint8Array>;

function subtleOrNull(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && c.subtle ? c.subtle : null;
}

function subtle(): SubtleCrypto {
  const api = subtleOrNull();
  if (!api) {
    throw new Ed25519UnavailableError(
      "SubtleCrypto unavailable (insecure context?) — " +
        "the web client needs HTTPS or localhost.",
    );
  }
  return api;
}

/**
 * SHA-512 for both backends.
 *
 * SubtleCrypto first, pure TS second. The fallback is not a nicety: opening the
 * page at `http://192.168.x.x:4124` — which is exactly what "connect from any
 * IP" means — is NOT a secure context, so `crypto.subtle` is `undefined` there
 * and Ed25519 has no hash at all. Without this the LAN path cannot pair.
 */
function sha512Digest(): Digest {
  const api = subtleOrNull();
  if (api) {
    return async (bytes: Uint8Array) =>
      new Uint8Array(await api.digest("SHA-512", bytes as BufferSource));
  }
  return async (bytes: Uint8Array) => sha512Pure(bytes);
}

/*
 * SHA-512 (FIPS 180-4) in plain TypeScript.
 *
 * BigInt rather than 32-bit word pairs: a pairing does a handful of hashes, so
 * the constant-factor cost is irrelevant, while hand-rolled 64-bit carry logic
 * is exactly the kind of code that is subtly wrong and hard to see. The K table
 * is derived from its cube roots instead of pasted as an 80-entry hex blob,
 * so the source stays reviewable.
 */
const MASK64 = (1n << 64n) - 1n;

const SHA512_K: readonly bigint[] = (() => {
  const out: bigint[] = [];
  for (let n = 2; out.length < 80; n += 1) {
    let prime = true;
    for (let d = 2; d * d <= n; d += 1) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    /* floor(frac(cbrt(n)) * 2^64) — computed in BigInt for exactness. */
    const root = bigCbrt(BigInt(n) << 192n);
    out.push(root & MASK64);
  }
  return out;
})();

/** Integer cube root of a non-negative BigInt (Newton). */
function bigCbrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 3) + 1);
  for (;;) {
    const next = (2n * x + value / (x * x)) / 3n;
    if (next >= x) break;
    x = next;
  }
  return x;
}

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function sha512Pure(message: Uint8Array): Uint8Array {
  const bitLen = BigInt(message.length) * 8n;
  const padded = Math.ceil((message.length + 17) / 128) * 128;
  const buf = new Uint8Array(padded);
  buf.set(message);
  buf[message.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(padded - 16, 0n, false);
  dv.setBigUint64(padded - 8, bitLen, false);

  let h0 = 0x6a09e667f3bcc908n, h1 = 0xbb67ae8584caa73bn;
  let h2 = 0x3c6ef372fe94f82bn, h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n, h5 = 0x9b05688c2b3e6c1fn;
  let h6 = 0x1f83d9abfb41bd6bn, h7 = 0x5be0cd19137e2179n;

  const w = new Array<bigint>(80);
  for (let off = 0; off < padded; off += 128) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getBigUint64(off + i * 8, false);
    for (let i = 16; i < 80; i += 1) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }

    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 80; i += 1) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & g & MASK64);
      const t1 = (h + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      h = g; g = f; f = e;
      e = (d + t1) & MASK64;
      d = c; c = b; b = a;
      a = (t1 + t2) & MASK64;
    }
    h0 = (h0 + a) & MASK64; h1 = (h1 + b) & MASK64;
    h2 = (h2 + c) & MASK64; h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64; h5 = (h5 + f) & MASK64;
    h6 = (h6 + g) & MASK64; h7 = (h7 + h) & MASK64;
  }

  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setBigUint64(i * 8, v, false));
  return out;
}

/** Exposed for the test suite: the constant table must match FIPS 180-4. */
export function sha512PureForTest(bytes: Uint8Array): Uint8Array {
  return sha512Pure(bytes);
}

// ── capability detection ────────────────────────────────────────────────────

/**
 * Probes native Ed25519 support. Never throws: an unsupported algorithm or a
 * missing SubtleCrypto resolves to the fallback backend.
 */
export async function detectEd25519Support(): Promise<Ed25519Backend> {
  try {
    await subtle().generateKey("Ed25519", false, ["sign"]);
    return "webcrypto";
  } catch {
    return "pure-ts";
  }
}

/**
 * Creates an ephemeral Ed25519 signer. `forceBackend` exists for tests and
 * diagnostics — production code must let detection decide.
 */
export async function createEd25519Signer(
  forceBackend?: Ed25519Backend,
): Promise<Ed25519Signer> {
  const backend = forceBackend ?? (await detectEd25519Support());
  if (backend === "webcrypto") return createWebCryptoSigner();
  return createPureTsSigner();
}

async function createWebCryptoSigner(): Promise<Ed25519Signer> {
  const api = subtle();
  let keyPair: CryptoKeyPair;
  try {
    keyPair = await api.generateKey("Ed25519", false, ["sign"]);
  } catch (err) {
    throw new Ed25519UnavailableError(
      `WebCrypto Ed25519 unavailable: ${String(err)}`,
    );
  }
  const publicKeyRaw = new Uint8Array(await api.exportKey("raw", keyPair.publicKey));
  return {
    publicKeyRaw,
    publicKeyBase64: bytesToBase64(publicKeyRaw),
    backend: "webcrypto",
    sign: async (message: Uint8Array) =>
      new Uint8Array(await api.sign("Ed25519", keyPair.privateKey, message as BufferSource)),
  };
}

// ── pure-TS Ed25519 (RFC 8032) ──────────────────────────────────────────────
//
// Field arithmetic in extended twisted-Edwards coordinates with BigInt.
// Straightforward double-and-add scalar multiplication; correctness is proven
// by the RFC 8032 §7.1 test vectors in scripts/verify-ed25519.mjs.

const P = (1n << 255n) - 19n; // 2^255 - 19
const L = (1n << 252n) + 27742317777372353535851937790883648493n; // group order
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n; // 2^((p-1)/4) mod p

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modL(a: bigint): bigint {
  const r = a % L;
  return r < 0n ? r + L : r;
}
function invert(a: bigint): bigint {
  // Fermat: a^(p-2) mod p
  let base = mod(a);
  let result = 1n;
  let exponent = P - 2n;
  while (exponent > 0n) {
    if (exponent & 1n) result = mod(result * base);
    base = mod(base * base);
    exponent >>= 1n;
  }
  return result;
}

const D = mod(-121665n * invert(121666n));

interface Point {
  X: bigint;
  Y: bigint;
  Z: bigint;
  T: bigint;
}

function pointAdd(a: Point, b: Point): Point {
  // Extended coordinates, a = -1 twisted Edwards (RFC 8032 §5.1.4).
  const A = mod(mod(b.Y - b.X) * mod(a.Y - a.X));
  const B = mod(mod(b.Y + b.X) * mod(a.Y + a.X));
  const C = mod(mod(2n * D) * mod(a.T * b.T));
  const Dd = mod(mod(2n * a.Z) * b.Z);
  const E = mod(B - A);
  const F = mod(Dd - C);
  const G = mod(Dd + C);
  const H = mod(B + A);
  return { X: mod(E * F), Y: mod(G * H), T: mod(E * H), Z: mod(F * G) };
}

function scalarMult(point: Point, scalar: bigint): Point {
  let result: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n }; // neutral element
  let acc = point;
  let n = scalar;
  while (n > 0n) {
    if (n & 1n) result = pointAdd(result, acc);
    acc = pointAdd(acc, acc);
    n >>= 1n;
  }
  return result;
}

/** Canonical base point B, encoded per RFC 8032 (y = 4/5, x odd). */
const B_BYTES = new Uint8Array([
  0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
  0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
]);
const BASE_POINT = decodePoint(B_BYTES) as Point;

function decodePoint(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  let yInt = 0n;
  for (let i = 31; i >= 0; i -= 1) yInt = (yInt << 8n) | BigInt(bytes[i]);
  const sign = (bytes[31] & 0x80) !== 0;
  yInt &= (1n << 255n) - 1n; // clear the sign bit
  if (yInt >= P) return null;
  const y = mod(yInt);
  const y2 = mod(y * y);
  // x² = (y² - 1) / (d·y² + 1)
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x = mod(u * invert(v));
  let candidate = modPow(x, (P + 3n) / 8n);
  if (mod(candidate * candidate) !== x) {
    candidate = mod(candidate * SQRT_M1);
    if (mod(candidate * candidate) !== x) return null;
  }
  if (candidate === 0n && sign) return null;
  if ((candidate & 1n) !== (sign ? 1n : 0n)) candidate = mod(P - candidate);
  return { X: candidate, Y: y, Z: 1n, T: mod(candidate * y) };
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function encodePoint(point: Point): Uint8Array {
  const zInv = invert(point.Z);
  const x = mod(point.X * zInv);
  const y = mod(point.Y * zInv);
  const out = new Uint8Array(32);
  let n = y;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  out[31] |= (x & 1n) === 1n ? 0x80 : 0x00;
  return out;
}

function leInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function leBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(out);
    return out;
  }
  throw new Ed25519UnavailableError(
    "crypto.getRandomValues unavailable — cannot generate the App-key.",
  );
}

async function createPureTsSigner(): Promise<Ed25519Signer> {
  const digest = sha512Digest();
  const secretKey = randomBytes(32); // ephemeral, RAM only

  // a = clamp(SHA-512(sk)[0..32]); public A = [a]B
  const h = await digest(secretKey);
  const a = (leInt(h.subarray(0, 32)) & ~7n) | (1n << 254n);
  const A = encodePoint(scalarMult(BASE_POINT, a));

  return {
    publicKeyRaw: A,
    publicKeyBase64: bytesToBase64(A),
    backend: "pure-ts",
    sign: async (message: Uint8Array): Promise<Uint8Array> => {
      const prefix = h.subarray(32, 64);
      const r = modL(leInt(await digest(concatBytes(prefix, message))));
      const R = encodePoint(scalarMult(BASE_POINT, r));
      const k = modL(leInt(await digest(concatBytes(R, A, message))));
      const S = modL(r + k * a);
      return concatBytes(R, leBytes(S, 32));
    },
  };
}

/** Pure-TS verification — used by tests to cross-check both backends. */
export async function pureTsVerify(
  publicKeyRaw: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64) return false;
  const digest = sha512Digest();
  const S = leInt(signature.subarray(32, 64));
  if (S >= L) return false;
  const A = decodePoint(publicKeyRaw);
  const R = decodePoint(signature.subarray(0, 32));
  if (!A || !R) return false;
  const k = modL(leInt(await digest(concatBytes(signature.subarray(0, 32), publicKeyRaw, message))));
  const lhs = scalarMult(BASE_POINT, S);
  const rhs = pointAdd(R, scalarMult(A, k));
  return bytesToBase64(encodePoint(lhs)) === bytesToBase64(encodePoint(rhs));
}

/** Native verification helper (WebCrypto) — used by tests to cross-check. */
export async function webcryptoVerify(
  publicKeyRaw: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const api = subtle();
  const key = await api.importKey("raw", publicKeyRaw as BufferSource, "Ed25519", false, ["verify"]);
  return api.verify("Ed25519", key, signature as BufferSource, message as BufferSource);
}
