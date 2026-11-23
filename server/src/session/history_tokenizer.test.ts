/**
 * Plan 86 P2 — bounded streaming tokenizer tests.
 *
 * Real temporary files, no mocked filesystem. The cases that matter for the
 * approved plan are here: escapes/backslashes/surrogates, UTF-8 across the
 * 64 KiB window, span-exact digests, bounded previews, and a giant line that
 * is never accumulated (stats prove the window bound).
 */

import { afterAll, describe, expect, test, vi } from "vitest";
import { HistoryUtf8Decoder } from "./history_utf8.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanHistoryLine,
  type HistoryScannedField,
  type HistoryTokenizerSource,
  type HistoryTokenizerStats,
} from "./history_tokenizer.js";
import {
  imagesFromContent,
  stringifyContent,
  stringifyToolResult,
} from "./history_format.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempFile(name: string, contents: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp86-tok-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

class SmallReadSource implements HistoryTokenizerSource {
  private readonly fd: number;
  constructor(
    private readonly file: string,
    private readonly readSize: number,
  ) {
    this.fd = fs.openSync(file, "r");
  }
  size(): number {
    return fs.statSync(this.file).size;
  }
  read(offset: number, length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const chunk = Math.min(this.readSize, length - done);
      const read = fs.readSync(this.fd, out, done, chunk, offset + done);
      if (read <= 0) throw new Error("short read");
      done += read;
    }
    return out;
  }
}

function lineRanges(file: string): Array<{ start: number; end: number }> {
  const bytes = fs.readFileSync(file);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    ranges.push({ start, end: index });
    start = index + 1;
  }
  if (start < bytes.length) ranges.push({ start, end: bytes.length });
  return ranges;
}

function scanLine<T extends HistoryScannedField>(
  file: string,
  lineIndex: number,
  fields?: T[],
): { line: ReturnType<typeof scanHistoryLine>; stats: HistoryTokenizerStats } {
  const stats: HistoryTokenizerStats = { bytes_read: 0, max_buffer_bytes: 0, chunks: 0 };
  const range = lineRanges(file)[lineIndex]!;
  const line = scanHistoryLine(new SmallReadSource(file, 7), range.start, range.end, { preview_bytes: 4096 }, stats);
  if (fields !== undefined && line?.entry !== undefined) {
    for (const event of line.entry.events) fields.push(...(event.fields as unknown as T[]));
  }
  return { line, stats };
}

function writeSession(lines: unknown[]): string {
  return tempFile("session.jsonl", lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function messageLine(message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message,
    ...extra,
  };
}

function rawSpan(file: string, field: HistoryScannedField, index = 0): Buffer {
  const span = field.spans[index]!;
  return fs.readFileSync(file).subarray(span.start, span.end);
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("plan 86 P2 — tokenizer metadata and spans", () => {
  test("user text: span, total, digest and preview are decoded-string exact", () => {
    const file = writeSession([
      { type: "session", id: "s1", cwd: "/w", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "user", content: "hello" }),
    ]);
    const fields: HistoryScannedField[] = [];
    const { line } = scanLine(file, 1, fields);
    expect(line?.kind).toBe("message");
    expect(line?.entry?.id).toBe("m1");
    expect(line?.entry?.role).toBe("user");
    expect(line?.entry?.timestamp).toBe("2026-01-01T00:00:01.000Z");
    expect(line?.user_preview).toBe("hello");
    const text = fields.find((field) => field.field === "text")!;
    expect(text.representation).toBe("text_utf8");
    expect(text.preview).toBe("hello");
    expect(text.preview_truncated).toBe(false);
    expect(text.total_bytes).toBe(5);
    expect(text.digest).toBe(sha(Buffer.from("hello", "utf8")));
    expect(JSON.parse(`"${rawSpan(file, text).toString("utf8")}"`)).toBe("hello");
  });

  test("assistant text + toolCall args: json_utf8 span parses to the value", () => {
    const args = {
      path: "/x",
      padding: "p".repeat(9000),
      quote: 'a"b',
      slash: "a\\b",
      nested: { list: [1, 2, 3], flag: true },
    };
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine(
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "tc1", name: "read", arguments: args }],
          usage: { input: 3, output: 4, cacheRead: 5 },
        },
        { id: "a1" },
      ),
    ]);
    const fields: HistoryScannedField[] = [];
    const { line } = scanLine(file, 1, fields);
    expect(line?.entry?.events.map((event) => event.type)).toEqual(["agent_message", "tool_request"]);
    expect(line?.entry?.events[1]?.tool_call_id).toBe("tc1");
    expect(line?.entry?.events[1]?.tool_name).toBe("read");
    expect(line?.entry?.events[0]?.usage).toMatchObject({ input: 3, output: 4, cacheRead: 5 });
    const json = fields.find((field) => field.field === "args")!;
    expect(json.representation).toBe("json_utf8");
    expect(json.preview_truncated).toBe(true);
    expect(Buffer.byteLength(json.preview, "utf8")).toBeLessThanOrEqual(4096);
    const raw = rawSpan(file, json);
    expect(JSON.parse(raw.toString("utf8"))).toEqual(args);
    expect(json.total_bytes).toBe(raw.length);
    expect(json.digest).toBe(sha(raw));
  });

  test("toolCall arguments with internal whitespace hash the exact source span", () => {
    const line = `{"type":"message","id":"a1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"read","arguments":{ "a" : 1, "b" : [ 2, 3 ] }}]}}`;
    const file = tempFile("spaced.jsonl", line + "\n");
    const fields: HistoryScannedField[] = [];
    const { line: scanned } = scanLine(file, 0, fields);
    const args = scanned?.entry?.events[0]?.fields[0]!;
    const raw = rawSpan(file, args);
    expect(JSON.parse(raw.toString("utf8"))).toEqual({ a: 1, b: [2, 3] });
    expect(args.total_bytes).toBe(raw.length);
    expect(args.digest).toBe(sha(raw));
  });

  test("toolResult + compaction projections match the P1 helpers", () => {
    const toolText = "line\nwith \"quotes\" and \\ slashes";
    const toolContent = [{ type: "text", text: toolText }];
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "toolResult", toolCallId: "tc9", content: toolContent }, { id: "r1" }),
      messageLine({ role: "compaction", content: "summarized", tokensBefore: 42 }, { id: "c1" }),
    ]);
    const { line } = scanLine(file, 1);
    const events = line?.entry?.events ?? [];
    expect(events[0]?.type).toBe("tool_result");
    expect(events[0]?.tool_call_id).toBe("tc9");
    expect(events[0]?.text).toBe(stringifyToolResult(toolContent));
    const compaction = scanLine(file, 2).line;
    expect(compaction?.entry?.events[0]?.type).toBe("compaction");
    expect(compaction?.entry?.events[0]?.text).toBe("summarized");
    expect(compaction?.entry?.events[0]?.tokens_before).toBe(42);
    expect(stringifyToolResult(toolContent)).toBe(toolText);
  });

  test("user array: text join + image binary metadata (digest/total/mime)", () => {
    const image = Buffer.alloc(5000, 7);
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    ];
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "user", content }),
    ]);
    const fields: HistoryScannedField[] = [];
    const { line } = scanLine(file, 1, fields);
    const text = fields.find((field) => field.field === "text")!;
    expect(text.preview).toBe(stringifyContent(content));
    expect(text.total_bytes).toBe(Buffer.byteLength("firstsecond", "utf8"));
    expect(line?.user_preview).toBe("first second");
    const imageField = fields.find((field) => field.field === "images.0")!;
    expect(imageField.representation).toBe("binary");
    expect(imageField.mime).toBe("image/png");
    expect(imageField.total_bytes).toBe(image.length);
    expect(imageField.digest).toBe(sha(image));
    expect(imageField.preview_truncated).toBe(true);
    expect(imagesFromContent(content)[0]?.mime).toBe("image/png");
  });
});

describe("plan 86 P2 — tokenizer escape and UTF-8 boundaries", () => {
  test("escaped quotes/backslashes/surrogate pairs + lone surrogate match Buffer semantics", () => {
    const text = `quote:" back:\\ newline:\n pair:\u{1F600} lone:\uD800 raw:αβγ😀 done`;
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "user", content: text }),
    ]);
    const fields: HistoryScannedField[] = [];
    const { line } = scanLine(file, 1, fields);
    const field = fields.find((entry) => entry.field === "text")!;
    const expected = Buffer.from(text, "utf8");
    expect(field.total_bytes).toBe(expected.length);
    expect(field.digest).toBe(sha(expected));
    expect(Buffer.from(field.preview, "utf8").equals(expected)).toBe(true);
    expect(line?.entry?.events[0]?.text_truncated).toBe(false);
  });

  test("a multi-byte character split across the 64 KiB window is not corrupted", () => {
    // Put an emoji's first byte at the last byte of the first 64 KiB window.
    const prefix = "a".repeat(65535 - 1);
    const text = `${prefix}😀tail-αβγ`;
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "user", content: text }),
    ]);
    const stats: HistoryTokenizerStats = { bytes_read: 0, max_buffer_bytes: 0, chunks: 0 };
    const range = lineRanges(file)[1]!;
    const line = scanHistoryLine(new SmallReadSource(file, 7), range.start, range.end, { preview_bytes: 4096 }, stats);
    const field = line?.entry?.events[0]?.fields[0]!;
    const expected = Buffer.from(text, "utf8");
    expect(field.total_bytes).toBe(expected.length);
    expect(field.digest).toBe(sha(expected));
    expect(line?.user_preview?.startsWith("aaaa")).toBe(true);
    expect(stats.max_buffer_bytes).toBeLessThanOrEqual(131072);
    expect(stats.bytes_read).toBeLessThanOrEqual(range.end - range.start + 65536);
  });

  test("giant 1 MiB text keeps a bounded preview and exact full digest", () => {
    const text = `${"x".repeat(500_000)}"\\\n😀${"αβγ".repeat(300_000)}END`;
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "user", content: text }),
    ]);
    const fields: HistoryScannedField[] = [];
    const { line, stats } = scanLine(file, 1, fields);
    const field = fields.find((entry) => entry.field === "text")!;
    const expected = Buffer.from(text, "utf8");
    expect(field.total_bytes).toBe(expected.length);
    expect(field.digest).toBe(sha(expected));
    expect(field.preview_truncated).toBe(true);
    expect(Buffer.byteLength(field.preview, "utf8")).toBeLessThanOrEqual(4096);
    expect(expected.subarray(0, Buffer.byteLength(field.preview, "utf8")).toString("utf8")).toBe(field.preview);
    expect(line?.entry?.events[0]?.text).toBe(field.preview);
    expect(stats.max_buffer_bytes).toBeLessThanOrEqual(131072);
    const size = rangeSize(file, 1);
    expect(stats.bytes_read).toBeLessThanOrEqual(size + 65536);
  });
});

describe("plan 86 P2 — tokenizer malformed input", () => {
  test("malformed JSON returns null, never a partial entry", () => {
    for (const raw of ["{", "not json", '{"type":"message","id":']) {
      const file = tempFile("bad.jsonl", raw + "\n");
      const range = lineRanges(file)[0]!;
      const stats: HistoryTokenizerStats = { bytes_read: 0, max_buffer_bytes: 0, chunks: 0 };
      expect(scanHistoryLine(new SmallReadSource(file, 7), range.start, range.end, {}, stats)).toBeNull();
    }
  });

  test("a message without a string id is rejected; a non-message line is 'other'", () => {
    const file = writeSession([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", message: { role: "user", content: "x" } },
      { type: "session_info", name: "named" },
    ]);
    expect(scanLine(file, 1).line).toBeNull();
    const info = scanLine(file, 2).line;
    expect(info?.kind).toBe("session_info");
    expect(info?.name).toBe("named");
  });

  test("session header fields are extracted", () => {
    const file = writeSession([
      { type: "session", id: "s1", cwd: "/work", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);
    const line = scanLine(file, 0).line;
    expect(line?.kind).toBe("session");
    expect(line?.session).toEqual({ id: "s1", cwd: "/work", timestamp: "2026-01-01T00:00:00.000Z" });
  });
});

function rangeSize(file: string, index: number): number {
  const range = lineRanges(file)[index]!;
  return range.end - range.start;
}


describe("bounded ASCII string runs", () => {
  test("scalar header fields and ASCII text allocate no 16KiB hash buffer", () => {
    const file = writeSession([
      { type: "session", id: "scalar", cwd: "/w", timestamp: "2026-01-01T00:00:00.000Z" },
      messageLine({ role: "user", content: "a".repeat(8192) }),
    ]);
    const allocated = vi.spyOn(Buffer, "allocUnsafe");
    let headerBuffers = -1;
    let bodyBuffers = -1;
    try {
      scanLine(file, 0);
      headerBuffers = allocated.mock.calls.filter(args => args[0] === 16 * 1024).length;
      allocated.mockClear();
      scanLine(file, 1);
      bodyBuffers = allocated.mock.calls.filter(args => args[0] === 16 * 1024).length;
    } finally { allocated.mockRestore(); }
    expect(headerBuffers).toBe(0);
    expect(bodyBuffers).toBe(0);
  });

  test("plain ASCII is not fed byte by byte through the UTF-8 state machine", () => {
    const file = writeSession([messageLine({ role: "user", content: "ASCII ".repeat(1000) })]);
    const decoded = vi.spyOn(HistoryUtf8Decoder.prototype, "push");
    let byteCalls = 0;
    try {
      scanLine(file, 0);
      byteCalls = decoded.mock.calls.length;
    } finally { decoded.mockRestore(); }
    expect(byteCalls).toBeLessThan(100);
  });

  const mixed = [
    "ASCII with \"quote\" and \\slash\n next",
    "before \ud83d\ude42 \u4e2d\u6587 after",
    "before \ud800x after \udc00 end",
    ...[65533, 65534, 65535, 65536].map(padding => "a".repeat(padding) + "\ud83d\ude42\u4e2d" + "b".repeat(100)),
  ];
  test.each(mixed.map((text, index) => ({ text, index })))("mixed run $index keeps digest, preview and exact spans", ({ text }) => {
    const file = writeSession([messageLine({ role: "user", content: text })]);
    const fields: HistoryScannedField[] = [];
    const { line, stats } = scanLine(file, 0, fields);
    expect(line?.kind).toBe("message");
    const field = fields.find(value => value.field === "text")!;
    const expected = Buffer.from(text, "utf8");
    expect(field.total_bytes).toBe(expected.length);
    expect(field.digest).toBe(sha(expected));
    expect(Buffer.byteLength(field.preview, "utf8")).toBeLessThanOrEqual(4096);
    expect(field.preview_truncated).toBe(expected.length > 4096);
    expect(expected.subarray(0, Buffer.byteLength(field.preview, "utf8")).toString("utf8")).toBe(field.preview);
    expect(Buffer.from(JSON.parse('"' + rawSpan(file, field).toString("utf8") + '"'), "utf8")).toEqual(expected);
    expect(stats.max_buffer_bytes).toBeLessThanOrEqual(65536 + 8192);
  });
});
