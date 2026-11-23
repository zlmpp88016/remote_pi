/**
 * Plan 86 P2 — generation-scoped body sidecar (disk, not the DB).
 *
 * A body is one payload field of one transcript entry: `text_utf8` (JSON string
 * decoded to UTF-8), `json_utf8` (a complete valid JSON value) or `binary`
 * (base64 image bytes). The index stores only its source spans, decoded byte
 * length and sha256 — never the bytes.
 *
 * The FIRST explicit `history_body` for a field streams those spans ONCE into a
 * file under a generation-scoped directory, hashing while it decodes and
 * refusing to publish when the digest differs from the indexed one. Every later
 * chunk is a `pread` of the sidecar at `offset_bytes`; the source line/file is
 * never re-read or re-parsed.
 *
 * The cache is disposable and bounded:
 *   - total disk budget 256 MiB (approved sidecar budget), LRU eviction;
 *   - a single body larger than the budget answers `body_too_large` (the source
 *     file is preserved; nothing is silently truncated);
 *   - directories are 0700 and files 0600;
 *   - a generation change/delete revokes its directory; a snapshot whose
 *     generation no longer matches is rejected before this module is reached.
 *
 * This module contains no SQL and no SDK import. It runs inside the reader
 * worker only, so a 100 MiB decode never blocks the supervisor control plane.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { HistoryUtf8Decoder, writeUtf8CodePoint } from "./history_utf8.js";
import { basename, join } from "node:path";

// ── Public types ─────────────────────────────────────────────────────────────

export type BodyRepresentation = "text_utf8" | "json_utf8" | "binary";

export interface BodySpan {
  start: number;
  end: number;
}

export interface BodyFieldSpec {
  workspace: string;
  session_id: string;
  generation: string;
  entry_id: string;
  event_id: string;
  field: string;
  representation: BodyRepresentation;
  mime: string | null;
  spans: BodySpan[];
  /** Base64 of synthesized representation bytes when `spans` is empty. */
  synthetic_base64: string | null;
  total_bytes: number;
  digest: string;
}

export interface BodySourceIdentity {
  ino: number;
  birthtime_ms: number;
  size: number;
}

export interface BodyStoreOptions {
  /** `<remote>/.pi/remote/history-v1-bodies`. */
  root: string;
  budgetBytes?: number;
  now?: () => number;
}

export type BodyStoreErrorCode = "body_too_large" | "stale" | "internal";

export interface BodyChunkValue {
  digest: string;
  total_bytes: number;
  offset_bytes: number;
  next_offset_bytes: number;
  data_base64: string;
  /** Bytes read from the transcript source (0 on a cached chunk). */
  source_bytes_read: number;
  /** Bytes read from the sidecar (the chunk size on a cached chunk). */
  sidecar_bytes_read: number;
  cache_hit: boolean;
  /** O(body) first-materialization time; 0 on a cached chunk. */
  decode_ms: number;
  /** True when this call wrote the sidecar. */
  materialized: boolean;
}

export type BodyStoreResult<T> = { ok: true; value: T } | { ok: false; code: BodyStoreErrorCode };

export const BODY_SIDECAR_BUDGET_BYTES = 256 * 1024 * 1024;

// ── Small helpers ────────────────────────────────────────────────────────────

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeUnlink(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* cache cleanup is best-effort */
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

/**
 * Decode the bytes BETWEEN a JSON string's quotes, exactly like
 * `Buffer.from(JSON.parse(rawWithQuotes), "utf8")`:
 *   - escapes `\" \\ \/ \b \f \n \r \t \uXXXX`;
 *   - surrogate pairs combine, unpaired surrogates become U+FFFD;
 *   - raw UTF-8 is decoded statefully, invalid sequences become U+FFFD.
 *
 * Emits into [sink] in bounded runs so a 100 MiB string never becomes one JS
 * string. Returns the number of UTF-8 bytes emitted.
 */
export function decodeJsonStringBody(
  chunks: Iterable<Uint8Array>,
  sink: (bytes: Uint8Array) => void,
): number {
  let emitted = 0;
  let pendingHigh: number | null = null;
  const out = new Uint8Array(16 * 1024);
  let outLength = 0;
  const flush = (): void => {
    if (outLength === 0) return;
    sink(out.subarray(0, outLength));
    emitted += outLength;
    outLength = 0;
  };
  const writeCodePoint = (cp: number): void => {
    outLength += writeUtf8CodePoint(cp, out, outLength);
    if (outLength >= 16 * 1024 - 4) flush();
  };
  const pushCodeUnit = (unit: number): void => {
    if (pendingHigh !== null) {
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        const cp = 0x10000 + ((pendingHigh - 0xd800) << 10) + (unit - 0xdc00);
        pendingHigh = null;
        writeCodePoint(cp);
        return;
      }
      pendingHigh = null;
      writeCodePoint(0xfffd);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      pendingHigh = unit;
      return;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      writeCodePoint(0xfffd);
      return;
    }
    writeCodePoint(unit);
  };

  let hex = "";
  let escape: "none" | "slash" | "u" = "none";
  const utf8 = new HistoryUtf8Decoder();

  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (escape === "slash") {
        utf8.flush(pushCodeUnit);
        switch (byte) {
          case 0x22: pushCodeUnit(0x22); break;
          case 0x5c: pushCodeUnit(0x5c); break;
          case 0x2f: pushCodeUnit(0x2f); break;
          case 0x62: pushCodeUnit(0x08); break;
          case 0x66: pushCodeUnit(0x0c); break;
          case 0x6e: pushCodeUnit(0x0a); break;
          case 0x72: pushCodeUnit(0x0d); break;
          case 0x74: pushCodeUnit(0x09); break;
          case 0x75:
            escape = "u";
            hex = "";
            continue;
          default:
            // A lone backslash is invalid JSON, but a scanner would have
            // rejected the line. Keep the byte to avoid inventing escapes.
            pushCodeUnit(byte);
            break;
        }
        escape = "none";
        continue;
      }
      if (escape === "u") {
        const char = String.fromCharCode(byte);
        if (!/^[0-9a-fA-F]$/u.test(char)) {
          pushCodeUnit(0xfffd);
          escape = "none";
          hex = "";
          if (byte === 0x22) break;
          utf8.push(byte, pushCodeUnit);
          continue;
        }
        hex += char;
        if (hex.length === 4) {
          pushCodeUnit(parseInt(hex, 16));
          escape = "none";
          hex = "";
        }
        continue;
      }
      if (byte === 0x5c) {
        utf8.flush(pushCodeUnit);
        escape = "slash";
        continue;
      }
      utf8.push(byte, pushCodeUnit);
    }
  }
  utf8.flush(pushCodeUnit);
  if (pendingHigh !== null) {
    pendingHigh = null;
    writeCodePoint(0xfffd);
  }
  if (escape !== "none") writeCodePoint(0xfffd);
  flush();
  return emitted;
}

export function decodeBase64Body(chunks: Iterable<Uint8Array>, sink: (bytes: Uint8Array) => void): number {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values = new Map<string, number>();
  for (let index = 0; index < alphabet.length; index += 1) values.set(alphabet[index]!, index);
  let group: string[] = [];
  let padding = 0;
  let emitted = 0;
  const out: number[] = [];
  const flush = (): void => {
    if (out.length === 0) return;
    sink(Uint8Array.from(out));
    emitted += out.length;
    out.length = 0;
  };
  const flushGroup = (final: boolean): void => {
    if (group.length === 0) return;
    if (group.length === 1) {
      group = [];
      return;
    }
    const b0 = values.get(group[0]!) ?? 0;
    const b1 = values.get(group[1]!) ?? 0;
    out.push(((b0 << 2) | (b1 >> 4)) & 0xff);
    if (group.length >= 3) {
      const b2 = values.get(group[2]!) ?? 0;
      out.push(((b1 << 4) | (b2 >> 2)) & 0xff);
      if (group.length >= 4) {
        const b3 = values.get(group[3]!) ?? 0;
        out.push(((b2 << 6) | b3) & 0xff);
      }
    }
    group = [];
    if (final) flush();
  };
  for (const chunk of chunks) {
    for (const byte of chunk) {
      const char = String.fromCharCode(byte);
      if (char === "=") {
        padding += 1;
        if (group.length > 0) flushGroup(true);
        continue;
      }
      if (padding > 0) continue;
      if (!values.has(char)) continue;
      group.push(char);
      if (group.length === 4) {
        flushGroup(false);
        if (out.length >= 8192) flush();
      }
    }
  }
  flushGroup(true);
  flush();
  return emitted;
}

// ── Sidecar meta ─────────────────────────────────────────────────────────────

interface SidecarMeta {
  digest: string;
  total_bytes: number;
  ino: number;
  birthtime_ms: number;
  source_size: number;
  last_used: number;
}

function parseMeta(raw: string): SidecarMeta | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record["digest"] !== "string") return null;
    if (typeof record["total_bytes"] !== "number") return null;
    return {
      digest: record["digest"],
      total_bytes: record["total_bytes"],
      ino: typeof record["ino"] === "number" ? record["ino"] : 0,
      birthtime_ms: typeof record["birthtime_ms"] === "number" ? record["birthtime_ms"] : 0,
      source_size: typeof record["source_size"] === "number" ? record["source_size"] : 0,
      last_used: typeof record["last_used"] === "number" ? record["last_used"] : 0,
    };
  } catch {
    return null;
  }
}

function writeMeta(file: string, meta: SidecarMeta): void {
  try {
    fs.writeFileSync(file, JSON.stringify(meta), { mode: 0o600 });
  } catch {
    /* meta is an optimization; a missing one re-materializes */
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

interface MaterializeResult {
  path: string;
  meta: SidecarMeta;
  sourceBytesRead: number;
  decodeMs: number;
}

export class HistoryBodyStore {
  private readonly root: string;
  private readonly budgetBytes: number;
  private readonly now: () => number;
  private usageBytes: number | null = null;
  private readonly known = new Map<string, { bytes: number; lastUsed: number }>();
  private tempCounter = 0;

  constructor(options: BodyStoreOptions) {
    this.root = options.root;
    this.budgetBytes = Math.max(1, Math.floor(options.budgetBytes ?? BODY_SIDECAR_BUDGET_BYTES));
    this.now = options.now ?? (() => Date.now());
  }

  /** Revoke every sidecar of one generation (rewrite/delete/superseded). */
  revokeGeneration(generation: string): number {
    const dir = this.generationDir(generation);
    const removed = this.usageOfDir(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    for (const key of [...this.known.keys()]) {
      if (key.startsWith(dir)) this.known.delete(key);
    }
    if (this.usageBytes !== null) this.usageBytes = Math.max(0, this.usageBytes - removed);
    return removed;
  }

  dispose(): void {
    this.known.clear();
    this.usageBytes = null;
  }

  /**
   * Return `[offset, offset+chunk)` of the field's representation, materializing
   * the sidecar first when needed. Throws-free: typed refusal instead.
   */
  chunk(
    field: BodyFieldSpec,
    sourceFile: string,
    identity: BodySourceIdentity,
    offsetBytes: number,
    chunkBytes: number,
    options: { trustedAppend: boolean } = { trustedAppend: false },
  ): BodyStoreResult<BodyChunkValue> {
    if (field.total_bytes > this.budgetBytes) return { ok: false, code: "body_too_large" };
    const finalPath = this.sidecarPath(field);
    const metaPath = `${finalPath}.json`;
    let meta = this.readMeta(finalPath, metaPath);
    let sourceBytesRead = 0;
    let decodeMs = 0;
    let materialized = false;

    if (meta !== null && !this.metaMatches(meta, field, identity, options.trustedAppend)) {
      safeUnlink(finalPath);
      safeUnlink(metaPath);
      this.forget(finalPath);
      meta = null;
    }

    if (meta === null || !fs.existsSync(finalPath)) {
      const built = this.materialize(field, sourceFile, identity);
      if (!built.ok) return built;
      meta = built.value.meta;
      sourceBytesRead = built.value.sourceBytesRead;
      decodeMs = built.value.decodeMs;
      materialized = true;
    }

    const total = meta.total_bytes;
    const offset = Math.min(Math.max(0, Math.floor(offsetBytes)), total);
    const length = Math.min(Math.max(0, Math.floor(chunkBytes)), total - offset);
    let data = Buffer.alloc(0);
    let sidecarBytesRead = 0;
    if (length > 0) {
      try {
        const fd = fs.openSync(finalPath, "r");
        try {
          data = Buffer.allocUnsafe(length);
          sidecarBytesRead = fs.readSync(fd, data, 0, length, offset);
          data = data.subarray(0, sidecarBytesRead);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // The file disappeared between stat and read: materialize once more.
        safeUnlink(finalPath);
        safeUnlink(metaPath);
        this.forget(finalPath);
        const rebuilt = this.materialize(field, sourceFile, identity);
        if (!rebuilt.ok) return rebuilt;
        meta = rebuilt.value.meta;
        sourceBytesRead += rebuilt.value.sourceBytesRead;
        decodeMs += rebuilt.value.decodeMs;
        materialized = true;
        const fd = fs.openSync(finalPath, "r");
        try {
          data = Buffer.allocUnsafe(length);
          sidecarBytesRead = fs.readSync(fd, data, 0, length, offset);
          data = data.subarray(0, sidecarBytesRead);
        } finally {
          fs.closeSync(fd);
        }
      }
      this.touch(finalPath, meta);
    }

    return {
      ok: true,
      value: {
        digest: meta.digest,
        total_bytes: total,
        offset_bytes: offset,
        next_offset_bytes: offset + data.length,
        data_base64: data.toString("base64"),
        source_bytes_read: sourceBytesRead,
        sidecar_bytes_read: sidecarBytesRead,
        cache_hit: !materialized,
        decode_ms: decodeMs,
        materialized,
      },
    };
  }

  /** Materialize without returning data (single-flight warm-up / eager=false). */
  warm(
    field: BodyFieldSpec,
    sourceFile: string,
    identity: BodySourceIdentity,
    trustedAppend: boolean,
  ): BodyStoreResult<{ sourceBytesRead: number; decodeMs: number; materialized: boolean }> {
    const chunk = this.chunk(field, sourceFile, identity, 0, 0, { trustedAppend });
    if (!chunk.ok) return chunk;
    return {
      ok: true,
      value: {
        sourceBytesRead: chunk.value.source_bytes_read,
        decodeMs: chunk.value.decode_ms,
        materialized: chunk.value.materialized,
      },
    };
  }

  sidecarPath(field: BodyFieldSpec): string {
    const key = sha256Hex(
      `${field.workspace}|${field.session_id}|${field.entry_id}|${field.event_id}|${field.field}|${field.representation}`,
    ).slice(0, 32);
    return join(this.generationDir(field.generation), `${key}.bin`);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private generationDir(generation: string): string {
    const safe = /^[A-Za-z0-9_-]{1,128}$/u.test(generation) ? generation : sha256Hex(generation).slice(0, 32);
    return join(this.root, `g-${safe}`);
  }

  private readMeta(finalPath: string, metaPath: string): SidecarMeta | null {
    try {
      return parseMeta(fs.readFileSync(metaPath, "utf8"));
    } catch {
      if (!fs.existsSync(finalPath)) return null;
      // A sidecar without meta cannot be trusted to carry the indexed bytes.
      return null;
    }
  }

  private metaMatches(
    meta: SidecarMeta,
    field: BodyFieldSpec,
    identity: BodySourceIdentity,
    trustedAppend: boolean,
  ): boolean {
    if (meta.digest !== field.digest || meta.total_bytes !== field.total_bytes) return false;
    if (meta.ino !== 0 && identity.ino !== 0 && meta.ino !== identity.ino) return false;
    if (meta.birthtime_ms !== 0 && identity.birthtime_ms !== 0 && meta.birthtime_ms !== identity.birthtime_ms) {
      return false;
    }
    if (identity.size < meta.source_size) return false;
    if (identity.size > meta.source_size && !trustedAppend) return false;
    return true;
  }

  private materialize(
    field: BodyFieldSpec,
    sourceFile: string,
    identity: BodySourceIdentity,
  ): BodyStoreResult<MaterializeResult> {
    if (field.total_bytes > this.budgetBytes) return { ok: false, code: "body_too_large" };
    const started = this.now();
    const dir = this.generationDir(field.generation);
    const finalPath = this.sidecarPath(field);
    const metaPath = `${finalPath}.json`;
    const tempPath = `${finalPath}.tmp-${process.pid}-${this.tempCounter++}`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return { ok: false, code: "internal" };
    }

    const hash = createHash("sha256");
    let written = 0;
    let sourceBytesRead = 0;
    let outFd: number | null = null;
    try {
      outFd = fs.openSync(tempPath, "w", 0o600);
      const write = (bytes: Uint8Array): void => {
        hash.update(bytes);
        written += bytes.length;
        if (bytes.length > 0) fs.writeSync(outFd as number, bytes, 0, bytes.length);
      };

      if (field.synthetic_base64 !== null) {
        write(Buffer.from(field.synthetic_base64, "base64"));
      } else if (field.spans.length > 0) {
        const fd = fs.openSync(sourceFile, "r");
        try {
          for (const span of field.spans) {
            if (span.end < span.start || span.end > identity.size) {
              throw Object.assign(new Error("span out of range"), { code: "stale" });
            }
            switch (field.representation) {
              case "text_utf8":
                sourceBytesRead += this.readTextSpan(fd, span, write);
                break;
              case "json_utf8":
                sourceBytesRead += this.readRawSpan(fd, span, write);
                break;
              case "binary":
                sourceBytesRead += this.readBase64Span(fd, span, write);
                break;
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.closeSync(outFd);
      outFd = null;

      const digest = hash.digest("hex");
      if (digest !== field.digest || written !== field.total_bytes) {
        safeUnlink(tempPath);
        return { ok: false, code: "stale" };
      }

      // Make room BEFORE publishing the sidecar so the budget is never exceeded.
      this.evictUntil(field.total_bytes, finalPath);
      fs.renameSync(tempPath, finalPath);
      const meta: SidecarMeta = {
        digest,
        total_bytes: written,
        ino: identity.ino,
        birthtime_ms: identity.birthtime_ms,
        source_size: identity.size,
        last_used: this.now(),
      };
      writeMeta(metaPath, meta);
      this.noteAdded(finalPath, written, meta.last_used);
      return {
        ok: true,
        value: { path: finalPath, meta, sourceBytesRead, decodeMs: Math.max(0, this.now() - started) },
      };
    } catch (error) {
      if (outFd !== null) {
        try {
          fs.closeSync(outFd);
        } catch {
          /* already closed */
        }
      }
      safeUnlink(tempPath);
      const code = (error as { code?: unknown }).code;
      if (code === "stale") return { ok: false, code: "stale" };
      if (isNotFound(error)) return { ok: false, code: "stale" };
      return { ok: false, code: "internal" };
    }
  }

  private readRawSpan(fd: number, span: BodySpan, write: (bytes: Uint8Array) => void): number {
    let read = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = span.start;
    while (position < span.end) {
      const length = Math.min(buffer.length, span.end - position);
      const count = fs.readSync(fd, buffer, 0, length, position);
      if (count <= 0) break;
      write(buffer.subarray(0, count));
      position += count;
      read += count;
    }
    return read;
  }

  private readBase64Span(fd: number, span: BodySpan, write: (bytes: Uint8Array) => void): number {
    let read = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = function* (): Generator<Uint8Array> {
      let position = span.start;
      while (position < span.end) {
        const length = Math.min(buffer.length, span.end - position);
        const count = fs.readSync(fd, buffer, 0, length, position);
        if (count <= 0) break;
        position += count;
        read += count;
        yield buffer.subarray(0, count);
      }
    };
    decodeBase64Body(decoder(), write);
    return read;
  }

  private readTextSpan(fd: number, span: BodySpan, write: (bytes: Uint8Array) => void): number {
    let read = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = function* (): Generator<Uint8Array> {
      let position = span.start;
      while (position < span.end) {
        const length = Math.min(buffer.length, span.end - position);
        const count = fs.readSync(fd, buffer, 0, length, position);
        if (count <= 0) break;
        position += count;
        read += count;
        yield buffer.subarray(0, count);
      }
    };
    decodeJsonStringBody(decoder(), write);
    return read;
  }

  private touch(path: string, meta: SidecarMeta): void {
    const known = this.known.get(path);
    if (known !== undefined) known.lastUsed = meta.last_used;
    if (meta.last_used === 0) return;
    // The meta file's mtime is the persisted LRU key on restart.
    try {
      fs.utimesSync(`${path}.json`, new Date(), new Date());
    } catch {
      /* the in-memory LRU still works */
    }
  }

  private noteAdded(path: string, bytes: number, lastUsed: number): void {
    const previous = this.known.get(path);
    if (previous !== undefined) {
      if (this.usageBytes !== null) this.usageBytes = Math.max(0, this.usageBytes - previous.bytes);
      this.known.delete(path);
    }
    this.known.set(path, { bytes, lastUsed });
    if (this.usageBytes !== null) this.usageBytes += bytes;
  }

  private forget(path: string): void {
    const previous = this.known.get(path);
    if (previous === undefined) return;
    this.known.delete(path);
    if (this.usageBytes !== null) this.usageBytes = Math.max(0, this.usageBytes - previous.bytes);
  }

  private usageOfDir(dir: string): number {
    let total = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          const stat = fs.statSync(join(dir, name));
          if (stat.isFile()) total += stat.size;
        } catch {
          /* raced with eviction */
        }
      }
    } catch {
      return 0;
    }
    return total;
  }

  /** Recompute the cache usage once, then keep it in memory. */
  private ensureUsageLoaded(): number {
    if (this.usageBytes !== null) return this.usageBytes;
    let total = 0;
    try {
      for (const dirName of fs.readdirSync(this.root)) {
        if (!dirName.startsWith("g-")) continue;
        const dir = join(this.root, dirName);
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith(".bin")) continue;
          const file = join(dir, name);
          try {
            const stat = fs.statSync(file);
            total += stat.size;
            let lastUsed = stat.mtimeMs;
            try {
              const meta = parseMeta(fs.readFileSync(`${file}.json`, "utf8"));
              if (meta !== null) lastUsed = meta.last_used;
            } catch {
              /* no meta: use mtime */
            }
            this.known.set(file, { bytes: stat.size, lastUsed });
          } catch {
            /* raced */
          }
        }
      }
    } catch {
      /* no cache directory yet */
    }
    this.usageBytes = total;
    return total;
  }

  private evictUntil(needed: number, keepPath: string): void {
    let usage = this.ensureUsageLoaded();
    if (usage + needed <= this.budgetBytes) return;
    const candidates = [...this.known.entries()]
      .filter(([path]) => path !== keepPath)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [path, value] of candidates) {
      if (usage + needed <= this.budgetBytes) break;
      safeUnlink(path);
      safeUnlink(`${path}.json`);
      this.known.delete(path);
      usage = Math.max(0, usage - value.bytes);
    }
    this.usageBytes = usage;
  }

  /** Test/diagnostic: current tracked sidecar bytes. */
  cacheBytes(): number {
    return this.ensureUsageLoaded();
  }

  /** Test/diagnostic: list sidecar files (basename only, no host path leaks). */
  listSidecars(): string[] {
    const out: string[] = [];
    try {
      for (const dirName of fs.readdirSync(this.root)) {
        if (!dirName.startsWith("g-")) continue;
        const dir = join(this.root, dirName);
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith(".bin")) out.push(`${dirName}/${basename(name)}`);
        }
      }
    } catch {
      /* empty */
    }
    return out;
  }
}

/** Exported for tests that need the exact sidecar directory rule. */
export function bodyGenerationDir(root: string, generation: string): string {
  const safe = /^[A-Za-z0-9_-]{1,128}$/u.test(generation) ? generation : sha256Hex(generation).slice(0, 32);
  return join(root, `g-${safe}`);
}
