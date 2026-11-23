/**
 * Plan 86 P2 — bounded streaming tokenizer for ONE Pi session JSONL line.
 *
 * WHY THIS EXISTS
 *
 * A Pi transcript line can be 100 MiB (one giant assistant text or tool
 * result). The P1 worker read the whole file, split it into lines and
 * `JSON.parse`d each line: memory and time scale with the line, and a giant
 * line can stall the worker. P2 needs metadata, body field SOURCE SPANS,
 * bounded previews and streaming digests WITHOUT ever materializing the line.
 *
 * This tokenizer walks the file with a 64 KiB window and a schema-directed
 * recursive scanner. It never builds a JS string larger than a preview
 * (≤4 KiB per field), never calls `JSON.parse` on the line, and reports:
 *
 *   - Pi metadata (type/id/parentId/timestamp/role/usage/tool ids/...);
 *   - projected events (user_input/agent_message/tool_request/tool_result/
 *     compaction) with bounded previews;
 *   - for every payload field: raw source spans, representation, decoded byte
 *     length and sha256 over the decoded bytes.
 *
 * The body sidecar later reads only those spans and must reproduce the exact
 * same bytes/digest; the shared decode helpers in `history_body_store.ts` are
 * used for multi-span concatenation and base64 so the two cannot drift.
 *
 * Escape/UTF-8 handling matches `Buffer.from(JSON.parse(raw),"utf8")`:
 * `\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX`, surrogate pairs combine, unpaired
 * surrogates become U+FFFD, raw UTF-8 is decoded statefully across windows.
 */

import { createHash } from "node:crypto";
import { decodeBase64Body, decodeJsonStringBody } from "./history_body_store.js";
import { HistoryUtf8Decoder, writeUtf8CodePoint } from "./history_utf8.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type HistoryScannedRepresentation = "text_utf8" | "json_utf8" | "binary";

export interface HistoryScannedSpan {
  start: number;
  end: number;
}

export interface HistoryScannedField {
  /** Wire field name: "text" | "args" | "result" | "error" | "summary" | "images.<n>". */
  field: string;
  representation: HistoryScannedRepresentation;
  mime: string | null;
  /** Raw source spans in absolute file bytes, in output order.
   *  text_utf8: bytes BETWEEN the JSON string quotes (JSON-escaped content).
   *  json_utf8: the raw JSON value bytes.
   *  binary: bytes BETWEEN the JSON string quotes (base64 text). */
  spans: HistoryScannedSpan[];
  /** Base64 of synthesized representation bytes when `spans` is empty. */
  synthetic_base64: string | null;
  /** Decoded representation byte length. */
  total_bytes: number;
  /** sha256 hex over the decoded representation bytes, in span order. */
  digest: string;
  /** Bounded preview: decoded text / raw JSON / base64 prefix. */
  preview: string;
  preview_truncated: boolean;
}

export interface HistoryScannedUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

export type HistoryScannedEventType =
  | "user_input"
  | "agent_message"
  | "tool_request"
  | "tool_result"
  | "compaction";

export interface HistoryScannedEvent {
  index: number;
  type: HistoryScannedEventType;
  fields: HistoryScannedField[];
  /** Full decoded text when not truncated; bounded prefix when truncated. */
  text: string | null;
  text_truncated: boolean;
  tool_call_id?: string;
  tool_name?: string;
  is_error?: boolean;
  tokens_before?: number;
  usage?: HistoryScannedUsage;
}

export interface HistoryScannedEntry {
  id: string;
  parent_id: string | null;
  timestamp: string | null;
  role: string;
  events: HistoryScannedEvent[];
  message_timestamp_ms: number | null;
}

export interface HistoryScannedSession {
  id: string | null;
  timestamp: string | null;
  cwd: string | null;
}

export interface HistoryScannedLine {
  kind: "session" | "session_info" | "message" | "other";
  session?: HistoryScannedSession;
  name?: string;
  entry?: HistoryScannedEntry;
  /** First user text preview (UTF-8 <= preview_bytes). */
  user_preview?: string | null;
  bad?: 0;
}

export interface HistoryTokenizerOptions {
  /** Preview budget in UTF-8 bytes for text/json; binary uses floor(*3/4) decoded bytes. */
  preview_bytes?: number;
}

export interface HistoryTokenizerStats {
  bytes_read: number;
  max_buffer_bytes: number;
  chunks: number;
}

export interface HistoryTokenizerSource {
  size(): number;
  /** Read exactly `length` bytes at `offset` (within size). */
  read(offset: number, length: number): Buffer;
}

export const HISTORY_TOKENIZER_DEFAULT_PREVIEW_BYTES = 4096;

// ── Cursor ───────────────────────────────────────────────────────────────────

class JsonSyntaxError extends Error {
  constructor() {
    super("invalid JSON");
    this.name = "JsonSyntaxError";
  }
}

const WINDOW_BYTES = 64 * 1024;

class Cursor {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private index = 0;
  private absolute: number;
  private readonly end: number;
  private readonly stats: HistoryTokenizerStats;

  constructor(
    private readonly source: HistoryTokenizerSource,
    start: number,
    end: number,
    stats: HistoryTokenizerStats,
  ) {
    this.absolute = start;
    this.end = end;
    this.stats = stats;
  }

  offset(): number {
    return this.absolute;
  }

  /** Next byte without consuming, or -1 at the end of the line. */
  peek(): number {
    if (this.index >= this.buffer.length) this.fill();
    return this.index < this.buffer.length ? this.buffer[this.index]! : -1;
  }

  next(): number {
    const byte = this.peek();
    if (byte >= 0) {
      this.index += 1;
      this.absolute += 1;
    }
    return byte;
  }

  /** A view over one bounded plain-ASCII run inside the current window. */
  takeAsciiRun(): Buffer | null {
    if (this.index >= this.buffer.length) this.fill();
    const start = this.index;
    let end = start;
    while (end < this.buffer.length) {
      const byte = this.buffer[end]!;
      if (byte < 0x20 || byte >= 0x80 || byte === 0x22 || byte === 0x5c) break;
      end += 1;
    }
    if (end === start) return null;
    this.index = end;
    this.absolute += end - start;
    return this.buffer.subarray(start, end);
  }

  expect(byte: number): void {
    if (this.next() !== byte) throw new JsonSyntaxError();
  }

  private fill(): void {
    if (this.absolute >= this.end) return;
    const length = Math.min(WINDOW_BYTES, this.end - this.absolute);
    const chunk = this.source.read(this.absolute, length);
    if (chunk.length !== length) throw new Error("history tokenizer: short read");
    this.buffer = chunk;
    this.index = 0;
    this.stats.bytes_read += chunk.length;
    this.stats.chunks += 1;
    this.stats.max_buffer_bytes = Math.max(this.stats.max_buffer_bytes, chunk.length + 8192);
  }
}

function skipWhitespace(cursor: Cursor): void {
  for (;;) {
    const byte = cursor.peek();
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      cursor.next();
      continue;
    }
    return;
  }
}

// ── String scanning ──────────────────────────────────────────────────────────

interface TextScan {
  span: HistoryScannedSpan;
  preview: string;
  totalBytes: number;
  digest: string;
  truncated: boolean;
}

interface ScalarScan {
  text: string;
  truncated: boolean;
}

interface RawScan {
  span: HistoryScannedSpan;
  preview: string;
  totalBytes: number;
  digest: string;
  truncated: boolean;
}

/**
 * Consume one JSON string and decode it. Two budgets:
 *   previewBytes > 0 → content text mode (UTF-8 byte budget, digest);
 *   maxChars > 0     → scalar mode (UTF-16 unit budget, no digest).
 */
function consumeText(
  cursor: Cursor,
  options: { previewBytes?: number; maxChars?: number; hash: boolean },
): TextScan {
  cursor.expect(0x22);
  const start = cursor.offset();
  const previewBytes = Math.max(0, options.previewBytes ?? 0);
  const maxChars = options.maxChars !== undefined ? Math.max(0, options.maxChars) : null;
  const hash = options.hash ? createHash("sha256") : null;
  let total = 0;
  let preview = "";
  let previewUsed = 0;
  let truncated = false;

  // Scalar keys/ids never hash; plain ASCII hashes directly from its window.
  // Allocate an encoding buffer only when a hashed field needs decoded bytes.
  let out: Buffer | null = null;
  let outLength = 0;
  const flushHash = (): void => {
    if (hash !== null && out !== null && outLength > 0) hash.update(out.subarray(0, outLength));
    outLength = 0;
  };

  const appendPreview = (cp: number, bytes: number): void => {
    if (maxChars !== null) {
      if (preview.length >= maxChars) {
        truncated = true;
        return;
      }
      const text = String.fromCodePoint(cp);
      if (preview.length + text.length <= maxChars) preview += text;
      else preview += text.slice(0, maxChars - preview.length);
      if (preview.length >= maxChars) truncated = true;
      return;
    }
    if (previewBytes <= 0) return;
    if (previewUsed + bytes <= previewBytes) {
      preview += String.fromCodePoint(cp);
      previewUsed += bytes;
    } else {
      truncated = true;
    }
  };

  const emitCodePoint = (cp: number): void => {
    const length = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (hash !== null) {
      out ??= Buffer.allocUnsafe(16 * 1024);
      writeUtf8CodePoint(cp, out, outLength);
      outLength += length;
    }
    total += length;
    appendPreview(cp, length);
    if (outLength >= 16 * 1024 - 4) flushHash();
  };

  let pendingHigh: number | null = null;
  const pushUnit = (unit: number): void => {
    if (pendingHigh !== null) {
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        const cp = 0x10000 + ((pendingHigh - 0xd800) << 10) + (unit - 0xdc00);
        pendingHigh = null;
        emitCodePoint(cp);
        return;
      }
      pendingHigh = null;
      emitCodePoint(0xfffd);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      pendingHigh = unit;
      return;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      emitCodePoint(0xfffd);
      return;
    }
    emitCodePoint(unit);
  };

  const utf8 = new HistoryUtf8Decoder();
  let escape: "none" | "slash" | "u" = "none";
  let hex = "";
  for (;;) {
    if (escape === "none") {
      const run = cursor.takeAsciiRun();
      if (run !== null) {
        // Preserve the same replacement and surrogate order at a raw-run
        // boundary as feeding its first ASCII byte through the decoder.
        utf8.flush(pushUnit);
        if (pendingHigh !== null) {
          pendingHigh = null;
          emitCodePoint(0xfffd);
        }
        flushHash();
        hash?.update(run);
        total += run.length;
        if (maxChars !== null) {
          const length = Math.min(run.length, Math.max(0, maxChars - preview.length));
          if (length > 0) preview += run.toString("ascii", 0, length);
          if (preview.length >= maxChars) truncated = true;
        } else if (previewBytes > 0) {
          const length = Math.min(run.length, previewBytes - previewUsed);
          if (length > 0) preview += run.toString("ascii", 0, length);
          previewUsed += length;
          if (length < run.length) truncated = true;
        }
        continue;
      }
    }
    const byte = cursor.next();
    if (byte < 0) throw new JsonSyntaxError();
    if (escape === "slash") {
      utf8.flush(pushUnit);
      flushHash();
      switch (byte) {
        case 0x22: pushUnit(0x22); break;
        case 0x5c: pushUnit(0x5c); break;
        case 0x2f: pushUnit(0x2f); break;
        case 0x62: pushUnit(0x08); break;
        case 0x66: pushUnit(0x0c); break;
        case 0x6e: pushUnit(0x0a); break;
        case 0x72: pushUnit(0x0d); break;
        case 0x74: pushUnit(0x09); break;
        case 0x75:
          escape = "u";
          hex = "";
          continue;
        default:
          pushUnit(0xfffd);
          break;
      }
      escape = "none";
      continue;
    }
    if (escape === "u") {
      const char = String.fromCharCode(byte);
      if (!/^[0-9a-fA-F]$/u.test(char)) {
        pushUnit(0xfffd);
        escape = "none";
        hex = "";
        if (byte === 0x22) break;
        utf8.push(byte, pushUnit);
        continue;
      }
      hex += char;
      if (hex.length === 4) {
        pushUnit(parseInt(hex, 16));
        escape = "none";
        hex = "";
      }
      continue;
    }
    if (byte === 0x5c) {
      utf8.flush(pushUnit);
      flushHash();
      escape = "slash";
      continue;
    }
    if (byte === 0x22) break;
    utf8.push(byte, pushUnit);
  }
  utf8.flush(pushUnit);
  if (pendingHigh !== null) {
    pendingHigh = null;
    emitCodePoint(0xfffd);
  }
  if (escape !== "none") emitCodePoint(0xfffd);
  flushHash();
  const end = cursor.offset() - 1;
  if (total > previewBytes && maxChars === null) truncated = true;
  return {
    span: { start, end },
    preview,
    totalBytes: total,
    digest: hash === null ? "" : hash.digest("hex"),
    truncated,
  };
}

/** Scalar string with a hard character cap (ids, timestamps, roles, keys...). */
function consumeScalar(cursor: Cursor, maxChars: number): ScalarScan {
  const scan = consumeText(cursor, { maxChars, hash: false });
  return { text: scan.preview, truncated: scan.truncated };
}

function optionalScalar(cursor: Cursor, maxChars: number): string | null {
  const first = cursor.peek();
  if (first === 0x22) {
    const scan = consumeScalar(cursor, maxChars);
    return scan.truncated ? null : scan.text;
  }
  skipValue(cursor);
  return null;
}

// ── Raw JSON values ──────────────────────────────────────────────────────────

class RawSink {
  private readonly buffer = Buffer.allocUnsafe(16 * 1024);
  private length = 0;
  private readonly hash: ReturnType<typeof createHash> | null;
  total = 0;
  private readonly previewBytes: number;
  private readonly preview: number[] = [];
  private previewTruncated = false;

  constructor(hash: boolean, previewBytes: number) {
    this.hash = hash ? createHash("sha256") : null;
    this.previewBytes = Math.max(0, previewBytes);
  }

  push(byte: number): void {
    this.buffer[this.length] = byte;
    this.length += 1;
    this.total += 1;
    if (this.length >= this.buffer.length) this.flush();
    if (this.preview.length < this.previewBytes) this.preview.push(byte);
    else this.previewTruncated = true;
  }

  finish(): { totalBytes: number; digest: string; preview: string; truncated: boolean } {
    this.flush();
    let preview = Buffer.from(this.preview).toString("utf8");
    // Cut the decoded preview on a code-point boundary within the byte budget.
    if (Buffer.byteLength(preview, "utf8") > this.previewBytes) {
      let used = 0;
      let out = "";
      for (const char of preview) {
        const size = Buffer.byteLength(char, "utf8");
        if (used + size > this.previewBytes) break;
        out += char;
        used += size;
      }
      preview = out;
      this.previewTruncated = true;
    }
    return {
      totalBytes: this.total,
      digest: this.hash === null ? "" : this.hash.digest("hex"),
      preview,
      truncated: this.previewTruncated,
    };
  }

  private flush(): void {
    if (this.length === 0) return;
    this.hash?.update(this.buffer.subarray(0, this.length));
    this.length = 0;
  }
}

/** Skip whitespace while recording it in a raw sink (span-exact digest). */
function skipWhitespaceRaw(cursor: Cursor, sink: RawSink | null): void {
  for (;;) {
    const byte = cursor.peek();
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      cursor.next();
      if (sink !== null) sink.push(byte);
      continue;
    }
    return;
  }
}

/** Consume one JSON value, optionally hashing raw bytes + a bounded preview. */
function consumeRawValue(cursor: Cursor, sink: RawSink | null): void {
  skipWhitespaceRaw(cursor, sink);
  const first = cursor.peek();
  if (first < 0) throw new JsonSyntaxError();
  if (first === 0x22) {
    consumeRawString(cursor, sink);
    return;
  }
  if (first === 0x7b) {
    cursor.next();
    if (sink !== null) sink.push(0x7b);
    skipWhitespaceRaw(cursor, sink);
    if (cursor.peek() === 0x7d) {
      cursor.next();
      if (sink !== null) sink.push(0x7d);
      return;
    }
    for (;;) {
      skipWhitespaceRaw(cursor, sink);
      consumeRawString(cursor, sink);
      skipWhitespaceRaw(cursor, sink);
      cursor.expect(0x3a);
      if (sink !== null) sink.push(0x3a);
      consumeRawValue(cursor, sink);
      skipWhitespaceRaw(cursor, sink);
      const separator = cursor.next();
      if (separator < 0) throw new JsonSyntaxError();
      if (sink !== null) sink.push(separator);
      if (separator === 0x7d) break;
      if (separator !== 0x2c) throw new JsonSyntaxError();
    }
    return;
  }
  if (first === 0x5b) {
    cursor.next();
    if (sink !== null) sink.push(0x5b);
    skipWhitespaceRaw(cursor, sink);
    if (cursor.peek() === 0x5d) {
      cursor.next();
      if (sink !== null) sink.push(0x5d);
      return;
    }
    for (;;) {
      consumeRawValue(cursor, sink);
      skipWhitespaceRaw(cursor, sink);
      const separator = cursor.next();
      if (separator < 0) throw new JsonSyntaxError();
      if (sink !== null) sink.push(separator);
      if (separator === 0x5d) break;
      if (separator !== 0x2c) throw new JsonSyntaxError();
    }
    return;
  }
  // number / true / false / null: consume until a structural delimiter.
  for (;;) {
    const byte = cursor.peek();
    if (byte < 0) break;
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      break;
    }
    cursor.next();
    if (sink !== null) sink.push(byte);
  }
}

function consumeRawString(cursor: Cursor, sink: RawSink | null): void {
  cursor.expect(0x22);
  if (sink !== null) sink.push(0x22);
  for (;;) {
    const byte = cursor.next();
    if (byte < 0) throw new JsonSyntaxError();
    if (byte === 0x5c) {
      if (sink !== null) sink.push(byte);
      const escaped = cursor.next();
      if (escaped < 0) throw new JsonSyntaxError();
      if (sink !== null) sink.push(escaped);
      continue;
    }
    if (sink !== null) sink.push(byte);
    if (byte === 0x22) return;
  }
}

function skipValue(cursor: Cursor): void {
  consumeRawValue(cursor, null);
}

function consumeRaw(cursor: Cursor, previewBytes: number): RawScan {
  const start = cursor.offset();
  const sink = new RawSink(true, previewBytes);
  consumeRawValue(cursor, sink);
  const end = cursor.offset();
  const result = sink.finish();
  return {
    span: { start, end },
    preview: result.preview,
    totalBytes: result.totalBytes,
    digest: result.digest,
    truncated: result.totalBytes > previewBytes || result.truncated,
  };
}

// ── Object scaffolding ───────────────────────────────────────────────────────

function consumeObject(cursor: Cursor, handler: (key: string) => void): void {
  cursor.expect(0x7b);
  skipWhitespace(cursor);
  if (cursor.peek() === 0x7d) {
    cursor.next();
    return;
  }
  for (;;) {
    skipWhitespace(cursor);
    const key = consumeScalar(cursor, 256);
    skipWhitespace(cursor);
    cursor.expect(0x3a);
    skipWhitespace(cursor);
    handler(key.text);
    skipWhitespace(cursor);
    const separator = cursor.next();
    if (separator < 0) throw new JsonSyntaxError();
    if (separator === 0x7d) return;
    if (separator !== 0x2c) throw new JsonSyntaxError();
  }
}

function consumeArray(cursor: Cursor, handler: () => void): void {
  cursor.expect(0x5b);
  skipWhitespace(cursor);
  if (cursor.peek() === 0x5d) {
    cursor.next();
    return;
  }
  for (;;) {
    handler();
    skipWhitespace(cursor);
    const separator = cursor.next();
    if (separator < 0) throw new JsonSyntaxError();
    if (separator === 0x5d) return;
    if (separator !== 0x2c) throw new JsonSyntaxError();
  }
}

// ── Content / block parsing ──────────────────────────────────────────────────

interface ToolCallScan {
  id: string;
  name: string;
  args: RawScan | null;
}

interface ImageScan {
  data: RawScan;
  mime: string | null;
}

type ContentValue =
  | { kind: "none" }
  | { kind: "string"; text: TextScan }
  | { kind: "array"; blocks: ScannedBlock[] }
  | {
      kind: "object";
      rawSpan: HistoryScannedSpan;
      text: TextScan | null;
      contentBlocks: ScannedBlock[] | null;
      contentText: TextScan | null;
    };

type ScannedBlock =
  | { type: "text"; text: TextScan }
  | { type: "toolCall"; call: ToolCallScan }
  | { type: "image"; image: ImageScan }
  | { type: "other" };

function parseBlock(cursor: Cursor, previewBytes: number): ScannedBlock {
  let type: string | null = null;
  let text: TextScan | null = null;
  let id = "";
  let name = "";
  let args: RawScan | null = null;
  let data: RawScan | null = null;
  let mime: string | null = null;

  consumeObject(cursor, (key) => {
    switch (key) {
      case "type": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 64) : null;
        type = scalar === null || scalar.truncated ? null : scalar.text;
        if (scalar === null) skipValue(cursor);
        return;
      }
      case "text": {
        if (cursor.peek() === 0x22) text = consumeText(cursor, { previewBytes, hash: true });
        else skipValue(cursor);
        return;
      }
      case "id": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 2048) : null;
        id = scalar !== null && !scalar.truncated ? scalar.text : "";
        if (scalar === null) skipValue(cursor);
        return;
      }
      case "name": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 512) : null;
        name = scalar !== null && !scalar.truncated ? scalar.text : "";
        if (scalar === null) skipValue(cursor);
        return;
      }
      case "arguments": {
        if (cursor.peek() === 0x6e) {
          // null: P1 falls back to {}.
          skipValue(cursor);
          args = null;
          return;
        }
        args = consumeRaw(cursor, previewBytes);
        return;
      }
      case "data": {
        if (cursor.peek() === 0x22) data = consumeRaw(cursor, 4096);
        else skipValue(cursor);
        return;
      }
      case "mimeType": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 256) : null;
        mime = scalar !== null && !scalar.truncated ? scalar.text : null;
        if (scalar === null) skipValue(cursor);
        return;
      }
      default:
        skipValue(cursor);
    }
  });

  if (type === "text" && text !== null) return { type: "text", text };
  if (type === "toolCall") return { type: "toolCall", call: { id, name, args } };
  if (type === "image" && data !== null) return { type: "image", image: { data, mime } };
  return { type: "other" };
}

function parseContent(
  cursor: Cursor,
  previewBytes: number,
): ContentValue {
  const first = cursor.peek();
  if (first === 0x22) return { kind: "string", text: consumeText(cursor, { previewBytes, hash: true }) };
  if (first === 0x5b) {
    const blocks: ScannedBlock[] = [];
    consumeArray(cursor, () => {
      if (cursor.peek() === 0x7b) blocks.push(parseBlock(cursor, previewBytes));
      else skipValue(cursor);
    });
    return { kind: "array", blocks };
  }
  if (first === 0x7b) {
    const start = cursor.offset();
    let text: TextScan | null = null;
    let contentBlocks: ScannedBlock[] | null = null;
    let contentText: TextScan | null = null;
    consumeObject(cursor, (key) => {
      switch (key) {
        case "text": {
          if (cursor.peek() === 0x22) text = consumeText(cursor, { previewBytes, hash: true });
          else skipValue(cursor);
          return;
        }
        case "content": {
          const value = parseContent(cursor, previewBytes);
          if (value.kind === "array") contentBlocks = value.blocks;
          else if (value.kind === "string") contentText = value.text;
          return;
        }
        default:
          skipValue(cursor);
      }
    });
    return { kind: "object", rawSpan: { start, end: cursor.offset() }, text, contentBlocks, contentText };
  }
  skipValue(cursor);
  return { kind: "none" };
}

// ── Multi-span helpers (same decoders the sidecar uses) ──────────────────────

function* spanChunks(
  source: HistoryTokenizerSource,
  spans: readonly HistoryScannedSpan[],
): Generator<Uint8Array> {
  for (const span of spans) {
    let position = span.start;
    while (position < span.end) {
      const length = Math.min(64 * 1024, span.end - position);
      yield source.read(position, length);
      position += length;
    }
  }
}

/** Stream a raw JSON value span into a text scan (tool-result fallback). */
function textScanFromRawSpan(
  source: HistoryTokenizerSource,
  span: HistoryScannedSpan,
  previewBytes: number,
): TextScan {
  const hash = createHash("sha256");
  let total = 0;
  const preview: number[] = [];
  for (const chunk of spanChunks(source, [span])) {
    hash.update(chunk);
    total += chunk.length;
    if (preview.length < previewBytes) {
      const take = Math.min(chunk.length, previewBytes - preview.length);
      for (let index = 0; index < take; index += 1) preview.push(chunk[index]!);
    }
  }
  let text = Buffer.from(preview).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > previewBytes) {
    let used = 0;
    let out = "";
    for (const char of text) {
      const size = Buffer.byteLength(char, "utf8");
      if (used + size > previewBytes) break;
      out += char;
      used += size;
    }
    text = out;
  }
  return {
    span,
    preview: text,
    totalBytes: total,
    digest: hash.digest("hex"),
    truncated: total > previewBytes,
  };
}

function finalizeTextSpans(
  source: HistoryTokenizerSource,
  spans: readonly TextScan[],
  previewBytes: number,
): { spans: HistoryScannedSpan[]; totalBytes: number; digest: string; preview: string; truncated: boolean } {
  const rawSpans = spans.map((scan) => scan.span);
  if (spans.length === 1) {
    const only = spans[0]!;
    return {
      spans: rawSpans,
      totalBytes: only.totalBytes,
      digest: only.digest,
      preview: only.preview,
      truncated: only.truncated,
    };
  }
  const hash = createHash("sha256");
  let total = 0;
  for (const chunk of spanChunks(source, rawSpans)) {
    decodeJsonStringBody([chunk], (bytes) => {
      hash.update(bytes);
      total += bytes.length;
    });
  }
  let preview = spans.map((scan) => scan.preview).join("");
  if (Buffer.byteLength(preview, "utf8") > previewBytes) {
    let used = 0;
    let out = "";
    for (const char of preview) {
      const size = Buffer.byteLength(char, "utf8");
      if (used + size > previewBytes) break;
      out += char;
      used += size;
    }
    preview = out;
  }
  return {
    spans: rawSpans,
    totalBytes: total,
    digest: hash.digest("hex"),
    preview,
    truncated: total > previewBytes,
  };
}

function finalizeBinarySpan(
  source: HistoryTokenizerSource,
  scan: RawScan,
  previewBytes: number,
): { totalBytes: number; digest: string; preview: string; truncated: boolean; spans: HistoryScannedSpan[] } {
  const hash = createHash("sha256");
  let total = 0;
  for (const chunk of spanChunks(source, [scan.span])) {
    decodeBase64Body([chunk], (bytes) => {
      hash.update(bytes);
      total += bytes.length;
    });
  }
  // The base64 text prefix of the first floor(preview*3/4) bytes is the first
  // `previewBytes` base64 characters for canonical encoding.
  const preview = scan.preview.slice(0, Math.min(scan.preview.length, previewBytes));
  return {
    totalBytes: total,
    digest: hash.digest("hex"),
    preview,
    truncated: total > Math.floor((previewBytes * 3) / 4),
    spans: [scan.span],
  };
}

function syntheticField(
  field: string,
  representation: HistoryScannedRepresentation,
  bytes: Buffer,
  mime: string | null = null,
): HistoryScannedField {
  return {
    field,
    representation,
    mime,
    spans: [],
    synthetic_base64: bytes.toString("base64"),
    total_bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
    preview: bytes.toString("utf8"),
    preview_truncated: false,
  };
}

function textFieldFromScan(
  field: string,
  scan: {
    spans: HistoryScannedSpan[];
    totalBytes: number;
    digest: string;
    preview: string;
    truncated: boolean;
  },
): HistoryScannedField {
  return {
    field,
    representation: "text_utf8",
    mime: null,
    spans: scan.spans,
    synthetic_base64: null,
    total_bytes: scan.totalBytes,
    digest: scan.digest,
    preview: scan.preview,
    preview_truncated: scan.truncated,
  };
}

/** One already-scanned JSON string becomes a text field. */
function textFieldFromSingle(field: string, scan: TextScan): HistoryScannedField {
  return {
    field,
    representation: "text_utf8",
    mime: null,
    spans: [scan.span],
    synthetic_base64: null,
    total_bytes: scan.totalBytes,
    digest: scan.digest,
    preview: scan.preview,
    preview_truncated: scan.truncated,
  };
}

function jsonFieldFromScan(field: string, scan: RawScan, previewBytes: number): HistoryScannedField {
  return {
    field,
    representation: "json_utf8",
    mime: null,
    spans: [scan.span],
    synthetic_base64: null,
    total_bytes: scan.totalBytes,
    digest: scan.digest,
    preview: scan.preview,
    preview_truncated: scan.totalBytes > previewBytes,
  };
}

// ── Message / entry projection ───────────────────────────────────────────────

interface MessageScan {
  role: string;
  timestampMs: number | null;
  content: ContentValue;
  usage: HistoryScannedUsage | null;
  toolCallId: string | null;
  isError: boolean;
  tokensBefore: number | null;
}

function parseMessage(cursor: Cursor, previewBytes: number): MessageScan {
  let role = "";
  let timestampMs: number | null = null;
  let content: ContentValue = { kind: "none" };
  let usage: HistoryScannedUsage | null = null;
  let toolCallId: string | null = null;
  let isError = false;
  let tokensBefore: number | null = null;

  consumeObject(cursor, (key) => {
    switch (key) {
      case "role": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 128) : null;
        role = scalar !== null && !scalar.truncated ? scalar.text : "";
        if (scalar === null) skipValue(cursor);
        return;
      }
      case "timestamp": {
        const first = cursor.peek();
        if (first === 0x2d || (first >= 0x30 && first <= 0x39)) {
          timestampMs = readNumber(cursor);
        } else {
          skipValue(cursor);
        }
        return;
      }
      case "content":
        content = parseContent(cursor, previewBytes);
        return;
      case "usage": {
        if (cursor.peek() === 0x7b) usage = readUsage(cursor);
        else skipValue(cursor);
        return;
      }
      case "toolCallId": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 2048) : null;
        toolCallId = scalar !== null && !scalar.truncated ? scalar.text : null;
        if (scalar === null) skipValue(cursor);
        return;
      }
      case "isError": {
        const raw = readRawPrimitive(cursor);
        isError = raw === "true";
        return;
      }
      case "tokensBefore": {
        const first = cursor.peek();
        if (first === 0x2d || (first >= 0x30 && first <= 0x39)) tokensBefore = readNumber(cursor);
        else skipValue(cursor);
        return;
      }
      default:
        skipValue(cursor);
    }
  });

  return { role, timestampMs, content, usage, toolCallId, isError, tokensBefore };
}

function readNumber(cursor: Cursor): number {
  let text = "";
  for (;;) {
    const byte = cursor.peek();
    if (byte < 0) break;
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      break;
    }
    cursor.next();
    text += String.fromCharCode(byte);
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

function readRawPrimitive(cursor: Cursor): string {
  let text = "";
  for (;;) {
    const byte = cursor.peek();
    if (byte < 0) break;
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      break;
    }
    cursor.next();
    text += String.fromCharCode(byte);
  }
  return text;
}

function readUsage(cursor: Cursor): HistoryScannedUsage | null {
  let input = 0;
  let output = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let reasoning: number | undefined;
  let totalTokens: number | undefined;
  consumeObject(cursor, (key) => {
    switch (key) {
      case "input": input = readNumber(cursor); return;
      case "output": output = readNumber(cursor); return;
      case "cacheRead": cacheRead = readNumber(cursor); return;
      case "cacheWrite": cacheWrite = readNumber(cursor); return;
      case "reasoning": reasoning = readNumber(cursor); return;
      case "totalTokens": totalTokens = readNumber(cursor); return;
      default: skipValue(cursor);
    }
  });
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/** Join the text blocks of an array content exactly like `stringifyContent`. */
function textScansOfBlocks(blocks: readonly ScannedBlock[]): TextScan[] {
  const out: TextScan[] = [];
  for (const block of blocks) if (block.type === "text") out.push(block.text);
  return out;
}

function combinedTextField(
  source: HistoryTokenizerSource,
  scans: readonly TextScan[],
  previewBytes: number,
  field: string,
): HistoryScannedField {
  if (scans.length === 0) return syntheticField(field, "text_utf8", Buffer.from("", "utf8"));
  return textFieldFromScan(field, finalizeTextSpans(source, scans, previewBytes));
}

function userPreviewOf(content: ContentValue): string | null {
  if (content.kind === "string") return content.text.preview === "" ? null : content.text.preview;
  if (content.kind === "array") {
    const parts = textScansOfBlocks(content.blocks)
      .map((scan) => scan.preview)
      .filter((text) => text !== "");
    return parts.length === 0 ? null : parts.join(" ");
  }
  return null;
}

function projectMessage(
  source: HistoryTokenizerSource,
  message: MessageScan,
  entryId: string,
  previewBytes: number,
): { events: HistoryScannedEvent[]; userPreview: string | null } {
  const role = message.role;
  const events: HistoryScannedEvent[] = [];

  if (role === "compaction") {
    const text = message.content.kind === "string" ? message.content.text : null;
    const field =
      text === null
        ? syntheticField("summary", "text_utf8", Buffer.from("", "utf8"))
        : textFieldFromSingle("summary", text);
    events.push({
      index: 0,
      type: "compaction",
      fields: [field],
      text: field.preview,
      text_truncated: field.preview_truncated,
      tokens_before: message.tokensBefore ?? 0,
    });
    return { events, userPreview: null };
  }

  if (role === "user") {
    const textScans =
      message.content.kind === "string"
        ? [message.content.text]
        : message.content.kind === "array"
          ? textScansOfBlocks(message.content.blocks)
          : [];
    const field = combinedTextField(source, textScans, previewBytes, "text");
    const fields: HistoryScannedField[] = [field];
    if (message.content.kind === "array") {
      let imageIndex = 0;
      for (const block of message.content.blocks) {
        if (block.type !== "image") continue;
        const binary = finalizeBinarySpan(source, block.image.data, previewBytes);
        fields.push({
          field: `images.${imageIndex}`,
          representation: "binary",
          mime: block.image.mime,
          spans: binary.spans,
          synthetic_base64: null,
          total_bytes: binary.totalBytes,
          digest: binary.digest,
          preview: binary.preview,
          preview_truncated: binary.truncated,
        });
        imageIndex += 1;
      }
    }
    events.push({
      index: 0,
      type: "user_input",
      fields,
      text: field.preview,
      text_truncated: field.preview_truncated,
    });
    return { events, userPreview: userPreviewOf(message.content) };
  }

  if (role === "assistant") {
    if (message.content.kind !== "array") return { events, userPreview: null };
    let index = 0;
    for (const block of message.content.blocks) {
      if (block.type === "text") {
        if (block.text.preview === "" && block.text.totalBytes === 0) continue;
        const field = textFieldFromSingle("text", block.text);
        events.push({
          index,
          type: "agent_message",
          fields: [field],
          text: field.preview,
          text_truncated: field.preview_truncated,
          ...(message.usage !== null ? { usage: message.usage } : {}),
        });
        index += 1;
        continue;
      }
      if (block.type === "toolCall") {
        const field =
          block.call.args === null
            ? syntheticField("args", "json_utf8", Buffer.from("{}", "utf8"))
            : jsonFieldFromScan("args", block.call.args, previewBytes);
        events.push({
          index,
          type: "tool_request",
          fields: [field],
          text: null,
          text_truncated: true,
          tool_call_id: block.call.id,
          tool_name: block.call.name,
        });
        index += 1;
      }
    }
    return { events, userPreview: null };
  }

  if (role === "toolResult") {
    let textScans: TextScan[] = [];
    if (message.content.kind === "string") {
      textScans = [message.content.text];
    } else if (message.content.kind === "array") {
      textScans = textScansOfBlocks(message.content.blocks);
    } else if (message.content.kind === "object") {
      if (message.content.contentBlocks !== null) {
        textScans = textScansOfBlocks(message.content.contentBlocks);
      } else if (message.content.contentText !== null) {
        textScans = [message.content.contentText];
      } else if (message.content.text !== null) {
        textScans = [message.content.text];
      } else {
        // P1 falls back to JSON.stringify(value); the raw value is valid JSON.
        textScans = [textScanFromRawSpan(source, message.content.rawSpan, previewBytes)];
      }
    }
    const fieldName = message.isError ? "error" : "result";
    const field = combinedTextField(source, textScans, previewBytes, fieldName);
    events.push({
      index: 0,
      type: "tool_result",
      fields: [field],
      text: field.preview,
      text_truncated: field.preview_truncated,
      tool_call_id: message.toolCallId ?? "",
      is_error: message.isError,
    });
    return { events, userPreview: null };
  }

  return { events, userPreview: null };
}

// ── Entry point ──────────────────────────────────────────────────────────────

interface TopScan {
  type: string | null;
  id: string | null;
  parentId: string | null;
  timestamp: string | null;
  cwd: string | null;
  name: string | null;
  message: MessageScan | null;
}

function parseTopLevel(cursor: Cursor, previewBytes: number): TopScan {
  const top: TopScan = {
    type: null,
    id: null,
    parentId: null,
    timestamp: null,
    cwd: null,
    name: null,
    message: null,
  };
  consumeObject(cursor, (key) => {
    switch (key) {
      case "type": {
        const scalar = cursor.peek() === 0x22 ? consumeScalar(cursor, 64) : null;
        top.type = scalar !== null && !scalar.truncated ? scalar.text : null;
        if (scalar === null) skipValue(cursor);
        return;
      }
      case "id":
        top.id = optionalScalar(cursor, 2048);
        return;
      case "parentId":
        top.parentId = optionalScalar(cursor, 2048);
        return;
      case "timestamp":
        top.timestamp = optionalScalar(cursor, 128);
        return;
      case "cwd":
        top.cwd = optionalScalar(cursor, 4096);
        return;
      case "name":
        top.name = optionalScalar(cursor, 4096);
        return;
      case "message":
        if (cursor.peek() === 0x7b) {
          top.message = parseMessage(cursor, previewBytes);
        } else {
          skipValue(cursor);
          top.message = null;
        }
        return;
      default:
        skipValue(cursor);
    }
  });
  return top;
}

/**
 * Scan the complete line occupying `[start,end)` (end exclusive; newline not
 * included). Returns null for malformed JSON / a non-object top level / a
 * message without a usable string id.
 */
export function scanHistoryLine(
  source: HistoryTokenizerSource,
  start: number,
  end: number,
  options: HistoryTokenizerOptions = {},
  stats?: HistoryTokenizerStats,
): HistoryScannedLine | null {
  const previewBytes = Math.max(1, Math.floor(options.preview_bytes ?? HISTORY_TOKENIZER_DEFAULT_PREVIEW_BYTES));
  const counters: HistoryTokenizerStats = stats ?? { bytes_read: 0, max_buffer_bytes: 0, chunks: 0 };
  const cursor = new Cursor(source, start, end, counters);
  try {
    skipWhitespace(cursor);
    if (cursor.peek() !== 0x7b) return null;
    const top = parseTopLevel(cursor, previewBytes);
    skipWhitespace(cursor);
    if (cursor.peek() !== -1) return null;
    if (top.type === "session") {
      return {
        kind: "session",
        session: { id: top.id, timestamp: top.timestamp, cwd: top.cwd },
        bad: 0,
      };
    }
    if (top.type === "session_info") {
      return { kind: "session_info", name: top.name ?? "", bad: 0 };
    }
    if (top.type === "message") {
      if (top.id === null) return null;
      const message = top.message;
      if (message === null) {
        return {
          kind: "message",
          entry: {
            id: top.id,
            parent_id: top.parentId,
            timestamp: top.timestamp,
            role: "",
            events: [],
            message_timestamp_ms: null,
          },
          user_preview: null,
          bad: 0,
        };
      }
      const projected = projectMessage(source, message, top.id, previewBytes);
      return {
        kind: "message",
        entry: {
          id: top.id,
          parent_id: top.parentId,
          timestamp: top.timestamp,
          role: message.role,
          events: projected.events,
          message_timestamp_ms: message.timestampMs,
        },
        user_preview: projected.userPreview,
        bad: 0,
      };
    }
    return { kind: "other", bad: 0 };
  } catch (error) {
    if (error instanceof JsonSyntaxError) return null;
    throw error;
  }
}
