/**
 * BASELINE — `listWorkspaceSessions` is the single seam between the SDK's
 * `SessionManager.list` and everything the app displays.
 *
 * Passo 6 (SQLite index) replaces the slow path behind this seam, so the
 * field mapping has to be pinned FIRST: without a baseline, "the index made
 * it faster" is unfalsifiable — it might also have changed what the app sees.
 *
 * These tests deliberately do not touch the filesystem. They assert the
 * mapping from an SDK-shaped row (Date | number mtime, optional firstMessage)
 * to the wire `ListedSession`, which is the contract the client decodes.
 */
import { describe, expect, test, vi } from "vitest";

const listMock = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list: (...args: unknown[]) => listMock(...args) },
}));

const { listWorkspaceSessions } = await import("./sessions.js");

describe("listWorkspaceSessions — BASELINE field mapping", () => {
  test("maps an SDK row to the wire shape the client decodes", async () => {
    listMock.mockResolvedValueOnce([
      {
        id: "01a1b6e5-e92a-775b-ae63-de0da8dde5f1",
        path: "/home/u/.pi/agent/sessions/x/2026-01-01T00-00-00-000Z_abc.jsonl",
        name: "meu-projeto",
        modified: new Date("2026-01-02T03:04:05.000Z"),
        firstMessage: "primeira mensagem do usuario",
        cwd: "/home/u/proj",
      },
    ]);

    const rows = await listWorkspaceSessions("/home/u/proj");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "01a1b6e5-e92a-775b-ae63-de0da8dde5f1",
      path: "/home/u/.pi/agent/sessions/x/2026-01-01T00-00-00-000Z_abc.jsonl",
      name: "meu-projeto",
      mtime: Date.parse("2026-01-02T03:04:05.000Z"),
      preview: "primeira mensagem do usuario",
      cwd: "/home/u/proj",
    });
  });

  test("a numeric `modified` is passed through untouched", async () => {
    listMock.mockResolvedValueOnce([
      { id: "s1", path: "/p/s1.jsonl", name: "n", modified: 1794071162089, cwd: "/c" },
    ]);

    const rows = await listWorkspaceSessions("/c");
    expect(rows[0]!.mtime).toBe(1794071162089);
  });

  test("a missing firstMessage leaves preview undefined, never a placeholder", async () => {
    listMock.mockResolvedValueOnce([
      { id: "s1", path: "/p/s1.jsonl", name: "n", modified: 1, cwd: "/c" },
    ]);

    const rows = await listWorkspaceSessions("/c");
    expect(rows[0]!.preview).toBeUndefined();
  });

  test("preview is truncated to 200 chars", async () => {
    const long = "x".repeat(500);
    listMock.mockResolvedValueOnce([
      { id: "s1", path: "/p/s1.jsonl", name: "n", modified: 1, firstMessage: long, cwd: "/c" },
    ]);

    const rows = await listWorkspaceSessions("/c");
    expect(rows[0]!.preview).toHaveLength(200);
  });

  test("an empty SDK result maps to an empty list", async () => {
    listMock.mockResolvedValueOnce([]);
    await expect(listWorkspaceSessions("/c")).resolves.toEqual([]);
  });

  test("cwd falls back to the requested cwd when the SDK row omits it", async () => {
    listMock.mockResolvedValueOnce([
      { id: "s1", path: "/p/s1.jsonl", name: "n", modified: 1 },
    ]);

    const rows = await listWorkspaceSessions("/requested/cwd");
    expect(rows[0]!.cwd).toBe("/requested/cwd");
  });

  test("the cwd argument is what gets scanned", async () => {
    listMock.mockResolvedValueOnce([]);
    await listWorkspaceSessions("/some/where");
    expect(listMock).toHaveBeenCalledWith("/some/where");
  });
});
