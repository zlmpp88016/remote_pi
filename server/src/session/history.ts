/**
 * Plan 01 (Wave 1 + 2) — project Pi transcript entries onto the wire.
 *
 * The reference implementation returns a public `TranscriptMessage[]` built
 * from the session file. We already have a stable wire vocabulary
 * (`SessionHistoryEvent`) that the shipped app parses, so instead of changing
 * that shape we map Pi entries onto it — but sourced from the **session file**
 * rather than an in-memory buffer, which is what makes cursor pagination
 * possible.
 *
 * The load-bearing change is ids: `id` is now the Pi session-entry id, which is
 * the same value the live canonicalizer rewrites message events to. A live
 * message and its later re-sync therefore agree on identity, and the app's
 * de-duplication works across a reconnect.
 */

import type { SessionHistoryEvent, WireImage } from "../protocol/types.js";
import { recentTranscriptWindow, olderTranscriptPage, type TranscriptEntry } from "./transcript.js";

/** Content/tool formatting shared with the live broadcast path. */
export interface HistoryFormatting {
  stringifyContent(content: unknown): string;
  stringifyToolResult(value: unknown): string;
  imagesFromContent(content: unknown): WireImage[];
}

export interface TranscriptEventsResult {
  events: SessionHistoryEvent[];
  olderCursor: string | null;
  hasOlder: boolean;
}

/**
 * The newest page of history.
 */
export function transcriptEventsRecent(
  entries: TranscriptEntry[],
  limit: number,
  formatting: HistoryFormatting,
): TranscriptEventsResult {
  const page = recentTranscriptWindow(entries, limit);
  return {
    events: entriesToEvents(page.entries, formatting),
    olderCursor: page.olderCursor,
    hasOlder: page.hasOlder,
  };
}

/**
 * The page strictly older than `cursor`. Throws `InvalidTranscriptCursorError`
 * for a cursor that does not belong to this transcript.
 */
export function transcriptEventsBefore(
  entries: TranscriptEntry[],
  cursor: string,
  limit: number,
  formatting: HistoryFormatting,
): TranscriptEventsResult {
  const page = olderTranscriptPage(entries, cursor, limit);
  return {
    events: entriesToEvents(page.entries, formatting),
    olderCursor: page.olderCursor,
    hasOlder: page.hasOlder,
  };
}

/**
 * Map transcript entries to the app's flat event vocabulary.
 *
 * `in_reply_to` for an assistant message is the id of the nearest preceding
 * user entry — a linear scan, matching the existing mapper's semantics. It is
 * only used for grouping in the UI, so a linear approximation is acceptable;
 * identity (the `id` field) is now exact.
 */
export function entriesToEvents(entries: TranscriptEntry[], formatting: HistoryFormatting): SessionHistoryEvent[] {
  const events: SessionHistoryEvent[] = [];
  let lastUserId: string | null = null;

  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp) || 0;
    const message = entry.message;
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "compaction") {
      events.push({
        ts,
        type: "compaction",
        summary: typeof message.content === "string" ? message.content : "",
        tokens_before: typeof message.tokensBefore === "number" ? message.tokensBefore : 0,
      });
      continue;
    }

    if (role === "user") {
      // `id` is the session-entry id — the same identity the live stream uses.
      lastUserId = entry.id;
      const images = formatting.imagesFromContent(message.content);
      const event: SessionHistoryEvent = {
        ts,
        type: "user_input",
        id: entry.id,
        text: formatting.stringifyContent(message.content),
      };
      // Omitted entirely when absent so the text-only wire bytes are unchanged.
      if (images.length > 0) event.images = images;
      events.push(event);
      continue;
    }

    if (role === "assistant") {
      const usage = readUsage(message.usage);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (block.type === "text") {
          const text = String(block.text ?? "");
          if (!text) continue;
          events.push({
            ts,
            type: "agent_message",
            in_reply_to: lastUserId ?? entry.id,
            text,
            ...(usage ? { usage } : {}),
          });
        } else if (block.type === "toolCall") {
          events.push({
            ts,
            type: "tool_request",
            tool_call_id: String(block.id ?? ""),
            tool: String(block.name ?? ""),
            args: (block.arguments as Record<string, unknown>) ?? {},
          });
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const text = formatting.stringifyToolResult(message.content);
      const toolCallId = String(message.toolCallId ?? "");
      events.push(
        message.isError
          ? { ts, type: "tool_result", tool_call_id: toolCallId, error: text }
          : { ts, type: "tool_result", tool_call_id: toolCallId, result: text },
      );
    }
  }

  return events;
}

function readUsage(value: unknown): { input_tokens: number; output_tokens: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as { input?: unknown; output?: unknown };
  return {
    input_tokens: typeof usage.input === "number" ? usage.input : 0,
    output_tokens: typeof usage.output === "number" ? usage.output : 0,
  };
}
