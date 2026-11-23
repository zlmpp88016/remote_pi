/**
 * Plan 86 P1 test fixtures — REAL temporary session buckets.
 *
 * Nothing here mocks the filesystem: every test writes JSONL transcripts into
 * an OS temp directory and points either `agentRoot` or `PI_CODING_AGENT_DIR` at
 * it BEFORE the history service is created. No test touches the developer's
 * `~/.pi/agent`, the real index DB, pairing tokens or a live Pi.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionDirFor } from "../src/session/session_paths.js";

export interface HistoryFixture {
  root: string;
  cwd: string;
  bucket: string;
  cleanup(): void;
}

/** Create an isolated agent root + workspace cwd + derived session bucket. */
export function makeHistoryFixture(prefix = "rp86-"): HistoryFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cwd = path.join(root, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const bucket = sessionDirFor(cwd, root);
  fs.mkdirSync(bucket, { recursive: true });
  return {
    root,
    cwd,
    bucket,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

export interface MessageSpec {
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message: Record<string, unknown>;
}

export interface WriteTranscriptOptions {
  id: string;
  cwd: string;
  name?: string;
  /** Base instant; entries are spaced one second apart from it. */
  start?: string;
  messages: MessageSpec[];
  fileName?: string;
}

export function timestampAt(start: string, offsetSeconds: number): string {
  return new Date(Date.parse(start) + offsetSeconds * 1000).toISOString();
}

/**
 * Write one structurally faithful session JSONL file.
 *
 * Returns the file path and the byte length of every complete line (used by
 * tests that need to reason about high-water/truncation).
 */
export function writeTranscript(
  bucket: string,
  options: WriteTranscriptOptions,
): { file: string; lines: string[] } {
  const start = options.start ?? "2026-01-01T00:00:00.000Z";
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session",
      id: options.id,
      cwd: options.cwd,
      timestamp: start,
    }),
  );
  if (options.name !== undefined) {
    lines.push(JSON.stringify({ type: "session_info", name: options.name }));
  }
  options.messages.forEach((message, index) => {
    lines.push(
      JSON.stringify({
        type: "message",
        id: message.id,
        parentId: message.parentId ?? (index === 0 ? null : options.messages[index - 1]!.id),
        timestamp: message.timestamp ?? timestampAt(start, index + 1),
        message: message.message,
      }),
    );
  });
  const fileName = options.fileName ?? `2026-01-01T00-00-00-000Z_${options.id}.jsonl`;
  const file = path.join(bucket, fileName);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, lines };
}

/** Append raw text (used for torn/corrupt trailing lines). */
export function appendRaw(file: string, text: string): void {
  fs.appendFileSync(file, text);
}

/** Write a non-session / corrupt JSONL file into the bucket. */
export function writeRawLines(bucket: string, fileName: string, lines: string[]): string {
  const file = path.join(bucket, fileName);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// Small message builders keep the tests about the API, not about JSON shape.

export function userMessage(id: string, text: string): MessageSpec {
  return { id, message: { role: "user", content: text } };
}

export function assistantMessage(
  id: string,
  blocks: Array<Record<string, unknown>>,
  usage?: Record<string, unknown>,
): MessageSpec {
  return { id, message: { role: "assistant", content: blocks, ...(usage ? { usage } : {}) } };
}

export function toolResultMessage(id: string, toolCallId: string, text: string, isError = false): MessageSpec {
  return {
    id,
    message: { role: "toolResult", toolCallId, content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
  };
}

export function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

export function toolCallBlock(id: string, name: string, args: unknown): Record<string, unknown> {
  return { type: "toolCall", id, name, arguments: args };
}

export function imageBlock(base64: string, mimeType: string): Record<string, unknown> {
  return { type: "image", data: base64, mimeType };
}
