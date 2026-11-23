/**
 * Plan 86 P2 — SDK-free projection of SCANNED transcript entries into the
 * EXISTING `SessionHistoryEvent` vocabulary.
 *
 * P1 parsed a whole entry and then bounded it. P2's streaming tokenizer
 * (`history_tokenizer.ts`) never builds the full entry: it returns bounded
 * previews plus body-field source spans. This module is the one place that
 * turns those scanned events into the wire event JSON stored in the index, so
 * the reader path is a pure `O(page)` DB read.
 *
 * The event shapes are the same as `session/history.ts` and the live broadcast
 * path, so a client renders history with the code it already has. Body fields are enumerated from the indexed manifest in bounded reader slices;
 * full bytes are fetched through `history_body`, including evicted inline values.
 *
 * The formatting helpers at the top are the P1 semantic reference for
 * `stringifyContent` / `stringifyToolResult` / `imagesFromContent`; the
 * tokenizer tests compare their output against the streamed scanner, which is
 * what keeps the two implementations from drifting.
 *
 * MUST stay SDK-free.
 */

import type { HistoryStoredEvent, HistoryStoredRef } from "./history_index.js";
import { HISTORY_MAX_INDEXED_REFS_PER_EVENT } from "../protocol/history.js";
import type { SessionHistoryEvent, Usage, WireImage } from "../protocol/types.js";
import type { HistoryScannedEntry, HistoryScannedEvent, HistoryScannedField } from "./history_tokenizer.js";

// ── Formatting (mirrors src/index.ts's pure helpers) ─────────────────────────

export interface HistoryFormatting {
  stringifyContent(content: unknown): string;
  stringifyToolResult(value: unknown): string;
  imagesFromContent(content: unknown): WireImage[];
}

/** Same rules as `_stringifyContent` in `src/index.ts`. */
export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" ? String(record.text ?? "") : "";
    })
    .join("");
}

/**
 * Same rules as `_stringifyToolResult` in `src/index.ts`: string → as-is;
 * content array → joined text; wrapper object with `content`/`text` unwrapped;
 * other object → readable JSON; null/undefined → "". Never "[object Object]".
 */
export function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return stringifyContent(value);
  if (value !== null && typeof value === "object") {
    const record = value as { content?: unknown; text?: unknown };
    if (Array.isArray(record.content)) return stringifyContent(record.content);
    if (typeof record.text === "string") return record.text;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return value === null || value === undefined ? "" : String(value);
}

/** Same rules as `_imagesFromContent` in `src/index.ts`. */
export function imagesFromContent(content: unknown): WireImage[] {
  if (!Array.isArray(content)) return [];
  const out: WireImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
      out.push({ data: record.data, mime: record.mimeType });
    }
  }
  return out;
}

export const defaultHistoryFormatting: HistoryFormatting = {
  stringifyContent,
  stringifyToolResult,
  imagesFromContent,
};

// ── Projection ───────────────────────────────────────────────────────────────

function fieldOf(event: HistoryScannedEvent, name: string): HistoryScannedField | undefined {
  return event.fields.find((field) => field.field === name);
}

function refOf(field: HistoryScannedField, preview: string | null): HistoryStoredRef {
  return {
    field: field.field,
    representation: field.representation,
    mime: field.mime,
    total_bytes: field.total_bytes,
    digest: field.digest,
    preview,
    preview_truncated: true,
  };
}

function usageOf(event: HistoryScannedEvent): Usage | undefined {
  const usage = event.usage;
  if (usage === undefined) return undefined;
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    ...(usage.cacheRead !== undefined ? { cache_read_tokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cache_write_tokens: usage.cacheWrite } : {}),
    ...(usage.reasoning !== undefined ? { reasoning_tokens: usage.reasoning } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
  };
}

/** Raw image previews include the JSON string delimiters when complete. */
function inlineImage(preview: string): string {
  if (!preview.startsWith('"')) return preview;
  try { const value: unknown = JSON.parse(preview); return typeof value === "string" ? value : ""; }
  catch { return ""; }
}

/** Parse a bounded args preview into the event value. */
function argsValue(field: HistoryScannedField): Record<string, unknown> {
  if (field.preview_truncated) return {};
  try {
    const parsed = JSON.parse(field.preview) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Project one SCANNED entry into zero or more bounded wire events.
 *
 * `seedUserId` is the last user entry id before this entry, when the caller
 * already knows it (append). Initial builds publish seeds after the whole file
 * is indexed; the reader injects the stored seed into `in_reply_to`.
 */
export function projectScannedEntry(
  entry: HistoryScannedEntry,
  seedUserId: string | null = null,
): HistoryStoredEvent[] {
  const ts = Date.parse(entry.timestamp ?? "") || 0;
  const multi = entry.events.length !== 1;
  const out: HistoryStoredEvent[] = [];

  for (const scanned of entry.events) {
    const eventId = multi ? `${entry.id}#${scanned.index}` : entry.id;
    const refs: HistoryStoredRef[] = [];

    switch (scanned.type) {
      case "user_input": {
        const event: SessionHistoryEvent = {
          ts,
          type: "user_input",
          id: entry.id,
          text: scanned.text ?? "",
        };
        const textField = fieldOf(scanned, "text");
        if (textField !== undefined) refs.push(refOf(textField, null));
        /*
         * R3 — EVERY image value gets a HANDLE, not only the ones whose preview
         * was truncated.
         *
         * A wide entry can hold hundreds of individually small images (each
         * well under the 4 KiB preview budget). Such an event has no truncated
         * field at all, so a refs-only-for-truncated rule produced a page the
         * frame budget could not carry and — worse — left the discarded values
         * with no way back. The invariant is now "inline or handle, never
         * neither": a value's bytes are either on the wire or reachable through
         * `history_body` at `(event, field)`. The 16-ref WIRE cap is handled
         * by the same continuation the giant-entry case uses.
         */
        const images: WireImage[] = [];
        for (const field of scanned.fields) {
          if (!field.field.startsWith("images.")) continue;
          const index = Number(field.field.slice("images.".length));
          if (!Number.isInteger(index)) continue;
          images.push({ data: field.preview_truncated ? "" : inlineImage(field.preview), mime: field.mime ?? "" });
          // Always publish the handle; a client that evicts inline data keeps it.
          refs.push(refOf(field, field.preview));
        }
        if (images.length > 0) event.images = images;
        out.push(finishEvent(eventId, entry.id, event, refs));
        break;
      }
      case "agent_message": {
        const usage = usageOf(scanned);
        const event: SessionHistoryEvent = {
          ts,
          type: "agent_message",
          in_reply_to: seedUserId ?? entry.id,
          text: scanned.text ?? "",
          ...(usage !== undefined ? { usage } : {}),
        };
        const textField = fieldOf(scanned, "text");
        if (textField !== undefined) refs.push(refOf(textField, null));
        out.push(finishEvent(eventId, entry.id, event, refs));
        break;
      }
      case "tool_request": {
        const argsField = fieldOf(scanned, "args");
        const event: SessionHistoryEvent = {
          ts,
          type: "tool_request",
          tool_call_id: scanned.tool_call_id ?? "",
          tool: scanned.tool_name ?? "",
          args: argsField === undefined ? {} : argsValue(argsField),
        };
        if (argsField !== undefined) {
          refs.push(refOf(argsField, argsField.preview));
        }
        out.push(finishEvent(eventId, entry.id, event, refs));
        break;
      }
      case "tool_result": {
        const isError = scanned.is_error === true;
        const field = fieldOf(scanned, isError ? "error" : "result");
        const event: SessionHistoryEvent = isError
          ? { ts, type: "tool_result", tool_call_id: scanned.tool_call_id ?? "", error: scanned.text ?? "" }
          : { ts, type: "tool_result", tool_call_id: scanned.tool_call_id ?? "", result: scanned.text ?? "" };
        if (field !== undefined) refs.push(refOf(field, null));
        out.push(finishEvent(eventId, entry.id, event, refs));
        break;
      }
      case "compaction": {
        const event: SessionHistoryEvent = {
          ts,
          type: "compaction",
          summary: scanned.text ?? "",
          tokens_before: scanned.tokens_before ?? 0,
        };
        const field = fieldOf(scanned, "summary");
        if (field !== undefined) refs.push(refOf(field, null));
        out.push(finishEvent(eventId, entry.id, event, refs));
        break;
      }
    }
  }

  return out;
}

/**
 * Index ONE event with EVERY body ref it has.
 *
 * R3 — the index used to keep only the first `HISTORY_MAX_BODY_REFS_PER_ITEM`
 * of an event's refs, which made the omitted values permanently unreachable
 * through the history API (a 17-image user entry lost image 17). The INDEX must
 * hold everything it indexed; the CAP belongs to the WIRE, where
 * `history_read` ref-chunks one event across pages (R4's resume cursor).
 *
 * A defensive absolute bound still applies: a pathological event cannot grow the
 * projection row without limit, and every value above it is enumerated from the fields index through
 * the existing history_read continuation cursor.
 */
function finishEvent(
  eventId: string,
  entryId: string,
  event: SessionHistoryEvent,
  refs: HistoryStoredRef[],
): HistoryStoredEvent {
  return {
    event_id: eventId,
    entry_id: entryId,
    event: (event.type === "user_input" && refs.length > HISTORY_MAX_INDEXED_REFS_PER_EVENT ? { ...event, images: undefined } : event) as unknown as Record<string, unknown>,
    refs: refs.slice(0, HISTORY_MAX_INDEXED_REFS_PER_EVENT),
    truncated: refs.length > HISTORY_MAX_INDEXED_REFS_PER_EVENT,
  };
}

/** Stored events of one entry, parsed defensively (the DB is host-written but
 *  a corrupt cache must never crash the control plane). */
export function parseStoredEvents(projections: string): HistoryStoredEvent[] {
  try {
    const parsed = JSON.parse(projections) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: HistoryStoredEvent[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record["event_id"] !== "string" || typeof record["entry_id"] !== "string") continue;
      if (typeof record["event"] !== "object" || record["event"] === null) continue;
      const refs: HistoryStoredRef[] = [];
      const rawRefs = record["refs"];
      if (Array.isArray(rawRefs)) {
        for (const raw of rawRefs) {
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
          const ref = raw as Record<string, unknown>;
          const representation = ref["representation"];
          if (representation !== "text_utf8" && representation !== "json_utf8" && representation !== "binary") {
            continue;
          }
          if (typeof ref["field"] !== "string" || typeof ref["total_bytes"] !== "number") continue;
          if (typeof ref["digest"] !== "string") continue;
          refs.push({
            field: ref["field"],
            representation,
            mime: typeof ref["mime"] === "string" ? ref["mime"] : null,
            total_bytes: ref["total_bytes"],
            digest: ref["digest"],
            preview: typeof ref["preview"] === "string" ? ref["preview"] : null,
            preview_truncated: ref["preview_truncated"] === true,
          });
        }
      }
      out.push({
        event_id: record["event_id"],
        entry_id: record["entry_id"],
        event: record["event"] as Record<string, unknown>,
        refs,
        truncated: record["truncated"] === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}
