import { describe, expect, it } from "vitest";
import { entriesToEvents, transcriptEventsBefore, transcriptEventsRecent, type HistoryFormatting } from "./history.js";
import { encodeTranscriptCursor, type TranscriptEntry } from "./transcript.js";

/** Stand-ins for index.ts's private formatters — same contract, simpler body. */
const formatting: HistoryFormatting = {
  stringifyContent: (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => (block && typeof block === "object" && (block as any).type === "text" ? String((block as any).text ?? "") : ""))
      .join("");
  },
  stringifyToolResult: (value) => (typeof value === "string" ? value : JSON.stringify(value ?? "")),
  imagesFromContent: (content) => {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const record = block as { type?: unknown; data?: unknown; mime?: unknown };
      return record.type === "image" && typeof record.data === "string" && typeof record.mime === "string"
        ? [{ data: record.data, mime: record.mime }]
        : [];
    });
  },
};

function entry(id: string, parentId: string | null, timestamp: string, message: Record<string, unknown>): TranscriptEntry {
  return { id, parentId, timestamp, message };
}

const userEntry = entry("entry_u1", null, "2026-09-29T10:00:00.000Z", { role: "user", content: "hello" });
const assistantEntry = entry("entry_a1", "entry_u1", "2026-09-29T10:01:00.000Z", {
  role: "assistant",
  content: [
    { type: "text", text: "hi there" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
  ],
  usage: { input: 10, output: 5 },
});
const resultEntry = entry("entry_r1", "entry_a1", "2026-09-29T10:02:00.000Z", {
  role: "toolResult",
  toolCallId: "call_1",
  content: "file.txt",
});

describe("entriesToEvents", () => {
  it("uses the session-entry id as the user message identity", () => {
    const events = entriesToEvents([userEntry], formatting);
    expect(events).toEqual([
      { ts: Date.parse("2026-09-29T10:00:00.000Z"), type: "user_input", id: "entry_u1", text: "hello" },
    ]);
  });

  it("omits `images` for a text-only message", () => {
    const [event] = entriesToEvents([userEntry], formatting);
    expect("images" in (event as object)).toBe(false);
  });

  it("carries image attachments through", () => {
    const withImage = entry("entry_u2", null, "2026-09-29T10:00:00.000Z", {
      role: "user",
      content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mime: "image/jpeg" }],
    });
    const [event] = entriesToEvents([withImage], formatting);
    expect((event as any).images).toEqual([{ data: "AAA", mime: "image/jpeg" }]);
  });

  it("links an assistant message to the preceding user entry", () => {
    const events = entriesToEvents([userEntry, assistantEntry], formatting);
    const agentMessage = events.find((event) => event.type === "agent_message") as any;
    expect(agentMessage.in_reply_to).toBe("entry_u1");
    expect(agentMessage.text).toBe("hi there");
    expect(agentMessage.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("emits a tool_request per toolCall block", () => {
    const events = entriesToEvents([assistantEntry], formatting);
    expect(events.find((event) => event.type === "tool_request")).toEqual({
      ts: Date.parse("2026-09-29T10:01:00.000Z"),
      type: "tool_request",
      tool_call_id: "call_1",
      tool: "bash",
      args: { command: "ls" },
    });
  });

  it("maps a successful and a failed tool result differently", () => {
    const failed = entry("entry_r2", "entry_a1", "2026-09-29T10:03:00.000Z", {
      role: "toolResult",
      toolCallId: "call_2",
      content: "boom",
      isError: true,
    });
    const events = entriesToEvents([resultEntry, failed], formatting);
    expect(events[0]).toEqual({
      ts: Date.parse("2026-09-29T10:02:00.000Z"),
      type: "tool_result",
      tool_call_id: "call_1",
      result: "file.txt",
    });
    expect(events[1]).toEqual({
      ts: Date.parse("2026-09-29T10:03:00.000Z"),
      type: "tool_result",
      tool_call_id: "call_2",
      error: "boom",
    });
  });

  it("skips empty assistant text blocks", () => {
    const empty = entry("entry_a2", null, "2026-09-29T10:04:00.000Z", {
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
    expect(entriesToEvents([empty], formatting)).toEqual([]);
  });

  it("maps a compaction entry", () => {
    const compaction = entry("entry_c1", null, "2026-09-29T10:05:00.000Z", {
      role: "compaction",
      content: "summary text",
      tokensBefore: 12345,
    });
    expect(entriesToEvents([compaction], formatting)).toEqual([
      { ts: Date.parse("2026-09-29T10:05:00.000Z"), type: "compaction", summary: "summary text", tokens_before: 12345 },
    ]);
  });

  it("falls back to the entry id when an assistant has no preceding user", () => {
    const events = entriesToEvents([assistantEntry], formatting);
    const agentMessage = events.find((event) => event.type === "agent_message") as any;
    expect(agentMessage.in_reply_to).toBe("entry_a1");
  });
});

describe("transcriptEventsRecent / transcriptEventsBefore", () => {
  const all = [userEntry, assistantEntry, resultEntry];

  it("returns the newest window with a cursor when older history exists", () => {
    const result = transcriptEventsRecent(all, 1, formatting);
    // The window is the last entry plus the tool-call parent it depends on.
    expect(result.events.map((event) => event.type)).toEqual(["agent_message", "tool_request", "tool_result"]);
    expect(result.hasOlder).toBe(true);
    expect(result.olderCursor).toBe(encodeTranscriptCursor(resultEntry.timestamp));
  });

  it("reports no cursor when the window covers everything", () => {
    const result = transcriptEventsRecent(all, 50, formatting);
    expect(result.hasOlder).toBe(false);
    expect(result.olderCursor).toBeNull();
  });

  it("pages strictly older than the cursor", () => {
    const cursor = encodeTranscriptCursor(resultEntry.timestamp);
    const result = transcriptEventsBefore(all, cursor, 10, formatting);
    expect(result.hasOlder).toBe(false);
    expect(result.events.some((event) => event.type === "user_input")).toBe(true);
  });

  it("rejects a foreign cursor", () => {
    const foreign = encodeTranscriptCursor("2026-01-01T00:00:00.000Z");
    expect(() => transcriptEventsBefore(all, foreign, 10, formatting)).toThrow();
  });

  it("advances the cursor to the oldest entry of each page", () => {
    // Page boundaries are entry-based while events are finer-grained, and a
    // tool-call parent is deliberately repeated across a boundary — the client
    // merges pages by id, so this walk must terminate and cover every entry.
    const visitedEntries = new Set<string>(["entry_r1"]);
    let cursor = transcriptEventsRecent(all, 1, formatting).olderCursor;
    let guard = 0;
    while (cursor && guard < 10) {
      const page = transcriptEventsBefore(all, cursor, 1, formatting);
      for (const event of page.events) {
        if (event.type === "user_input") visitedEntries.add(event.id);
      }
      cursor = page.olderCursor;
      guard += 1;
    }
    expect(guard).toBeLessThan(10);
    expect([...visitedEntries].sort()).toEqual(["entry_r1", "entry_u1"]);
  });
});
