/**
 * Plan 86 P1 — the SDK-free JSONL session-file parser.
 *
 * Extracted from `actions/session_index.ts` so the host history worker can
 * reuse the ONE definition of "what a session row is" without importing the
 * index module (which opens `node:sqlite`). The index re-exports this function,
 * so no caller changes and no second copy can drift.
 *
 * It reproduces the SDK's rules rather than inventing new ones, because the
 * list must be indistinguishable from a cold SDK scan. Two details are easy to
 * get wrong and are pinned by tests:
 *
 *  - `mtime` is NOT the file's mtime. It is the newest message timestamp
 *    inside the file, falling back to the header timestamp and only then to
 *    the filesystem mtime.
 *  - the preview is the FIRST *user* message, not the first message overall.
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

export interface IndexedSession {
  id: string;
  path: string;
  name?: string;
  mtime: number;
  preview?: string;
  cwd?: string;
}

/**
 * Optional accounting for callers that must report REAL read bytes/parsed
 * entries (Plan 86 P1) instead of inventing zeros.
 */
export interface SessionReadStats {
  bytes?: number;
  entries?: number;
}

/**
 * Parses one session file into the fields the list needs.
 *
 * Returns null for a file that is not a session (no `type: "session"` header),
 * matching `SessionManager.list`, which drops those silently.
 */
export async function readSessionFile(
  file: string,
  stats?: SessionReadStats,
): Promise<IndexedSession | null> {
  let header: Record<string, unknown> | null = null;
  let lastActivityTime: number | undefined;
  let firstMessage = "";
  let name: string | undefined;

  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim() === "") continue;
      if (stats !== undefined) {
        stats.bytes = (stats.bytes ?? 0) + Buffer.byteLength(line, "utf8") + 1;
      }
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!header) {
        if (entry["type"] !== "session") return null;
        header = entry;
        continue;
      }
      if (entry["type"] === "session_info") {
        const n = entry["name"];
        name = typeof n === "string" && n.trim() !== "" ? n.trim() : undefined;
        continue;
      }
      if (entry["type"] !== "message") continue;
      const message = entry["message"];
      if (!message || typeof message !== "object") continue;
      if (stats !== undefined) stats.entries = (stats.entries ?? 0) + 1;
      const msg = message as Record<string, unknown>;
      const role = msg["role"];
      if (role !== "user" && role !== "assistant") continue;
      if (!("content" in msg)) continue;

      const ts = msg["timestamp"];
      const activity = typeof ts === "number" ? ts : new Date(String(entry["timestamp"])).getTime();
      if (!Number.isNaN(activity)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, activity);
      }

      if (firstMessage === "") {
        const text = textOf(msg["content"]);
        if (text !== "" && role === "user") firstMessage = text;
      }
    }
  } catch {
    return null;
  }

  if (!header) return null;

  const headerTime = new Date(String(header["timestamp"])).getTime();
  const fallback = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const mtime =
    typeof lastActivityTime === "number" && lastActivityTime > 0
      ? lastActivityTime
      : !Number.isNaN(headerTime)
        ? headerTime
        : fallback;

  const cwd = typeof header["cwd"] === "string" ? header["cwd"] : "";
  const id = typeof header["id"] === "string" ? header["id"] : path.basename(file, ".jsonl");

  return {
    id,
    path: file,
    name,
    mtime,
    preview: firstMessage === "" ? undefined : firstMessage.slice(0, 200),
    cwd,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join(" ");
}
