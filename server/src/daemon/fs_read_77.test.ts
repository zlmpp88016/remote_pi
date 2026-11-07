/**
 * Plan/77 — `fs_read` containment.
 *
 * This test file exists because `isReadAllowed` IS the security boundary: it
 * decides whether a paired device can pull arbitrary file content off the host.
 * The cases below are the ones that would silently regress if the predicate were
 * ever "simplified" into a prefix check or a denylist.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FS_READ_MAX_BYTES, handleFsRead, isReadAllowed } from "./fs_nav.js";
import type { ServerMessage } from "../protocol/types.js";

const ROOT = "/repo";

describe("isReadAllowed — positive allowlist", () => {
  test("accepts markdown under plan/", () => {
    expect(isReadAllowed("/repo/plan/69-host-first.md", ROOT)).toBe(true);
  });

  test("accepts docs/ and .workflow/ text", () => {
    expect(isReadAllowed("/repo/docs/guide.md", ROOT)).toBe(true);
    expect(isReadAllowed("/repo/.workflow/knowhow/a.json", ROOT)).toBe(true);
  });

  test("accepts an allowlisted directory nested deeper", () => {
    expect(isReadAllowed("/repo/sub/docs/plan/77.md", ROOT)).toBe(true);
  });

  test("accepts .txt and .markdown too", () => {
    expect(isReadAllowed("/repo/plan/notes.txt", ROOT)).toBe(true);
    expect(isReadAllowed("/repo/plan/notes.markdown", ROOT)).toBe(true);
  });
});

describe("isReadAllowed — rejections", () => {
  test("rejects a file at the workspace root (no allowlisted directory)", () => {
    expect(isReadAllowed("/repo/README.md", ROOT)).toBe(false);
    expect(isReadAllowed("/repo/config.json", ROOT)).toBe(false);
  });

  test("rejects source directories", () => {
    expect(isReadAllowed("/repo/src/main.ts", ROOT)).toBe(false);
  });

  test("rejects anything outside the workspace", () => {
    expect(isReadAllowed("/home/u/.ssh/id_rsa", ROOT)).toBe(false);
    expect(isReadAllowed("/home/u/.pi/remote/peers.json", ROOT)).toBe(false);
  });

  test("rejects a sibling directory whose name merely starts with the root", () => {
    // The classic prefix trap: startsWith("/repo") would wrongly accept this.
    expect(isReadAllowed("/repo-evil/plan/x.md", ROOT)).toBe(false);
  });

  test("rejects dotfiles, including inside an allowlisted directory", () => {
    expect(isReadAllowed("/repo/.env", ROOT)).toBe(false);
    expect(isReadAllowed("/repo/plan/.secret.md", ROOT)).toBe(false);
    expect(isReadAllowed("/repo/.ssh/id_rsa", ROOT)).toBe(false);
  });

  test("rejects non-text extensions even inside plan/", () => {
    expect(isReadAllowed("/repo/plan/payload.exe", ROOT)).toBe(false);
    expect(isReadAllowed("/repo/plan/blob", ROOT)).toBe(false);
  });

  test("rejects the workspace root itself", () => {
    expect(isReadAllowed("/repo", ROOT)).toBe(false);
  });

  test("handles Windows separators on both sides", () => {
    expect(isReadAllowed("C:\\repo\\plan\\77.md", "C:\\repo")).toBe(true);
    expect(isReadAllowed("C:\\repo\\src\\a.ts", "C:\\repo")).toBe(false);
  });
});

/** Collects the frames a handler emits. Mirrors HostReplySender, which is an
 *  OBJECT with a send method — not a bare function. */
function collector(): { sent: ServerMessage[]; send: { send(m: ServerMessage): void } } {
  const sent: ServerMessage[] = [];
  return { sent, send: { send: (m: ServerMessage) => sent.push(m) } };
}

describe("handleFsRead — end to end against a real temp tree", () => {
  test("reads an allowlisted file and reports truncated:false", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, "plan", "77.md"), "# Plan 77\n");
    const { sent, send } = collector();
    handleFsRead(send, { id: "r1", path: join(root, "plan", "77.md"), root });
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg.type).toBe("fs_read_ok");
    if (msg.type !== "fs_read_ok") throw new Error("wrong type");
    expect(msg.content).toBe("# Plan 77\n");
    expect(msg.truncated).toBe(false);
    expect(msg.in_reply_to).toBe("r1");
  });

  test("refuses a file outside the allowlist, even though it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    writeFileSync(join(root, "secret.md"), "TOPSECRET");
    const { sent, send } = collector();
    handleFsRead(send, { id: "r2", path: join(root, "secret.md"), root });
    expect(sent[0]?.type).toBe("action_error");
    if (sent[0]?.type !== "action_error") throw new Error("wrong type");
    expect(sent[0].error).toBe("not_allowed");
    // The content must not appear anywhere in the frame.
    expect(JSON.stringify(sent[0])).not.toContain("TOPSECRET");
  });

  test("refuses a traversal out of an allowlisted directory", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, "outside.md"), "OUTSIDE");
    const { sent, send } = collector();
    // plan/../outside.md resolves OUT of plan/, and the root is not allowlisted.
    handleFsRead(send, { id: "r3", path: join(root, "plan", "..", "outside.md"), root });
    if (sent[0]?.type !== "action_error") throw new Error("expected action_error");
    expect(sent[0].error).toBe("not_allowed");
  });

  test("refuses a symlink that escapes the allowlist", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    const secret = mkdtempSync(join(tmpdir(), "phasecret-"));
    mkdirSync(join(root, "plan"));
    writeFileSync(join(secret, "id_rsa.md"), "PRIVATE KEY");
    try {
      symlinkSync(join(secret, "id_rsa.md"), join(root, "plan", "innocent.md"));
    } catch {
      return; // symlink creation can require privileges on Windows CI
    }
    const { sent, send } = collector();
    // realpath collapses the link BEFORE the containment test, so this is caught.
    handleFsRead(send, { id: "r4", path: join(root, "plan", "innocent.md"), root });
    expect(sent[0]?.type).toBe("action_error");
    if (sent[0]?.type !== "action_error") throw new Error("wrong type");
    expect(sent[0].error).toBe("not_allowed");
  });

  test("reports not_a_file for a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    mkdirSync(join(root, "plan"));
    const { sent, send } = collector();
    handleFsRead(send, { id: "r5", path: join(root, "plan"), root });
    expect(sent[0]?.type).toBe("action_error");
    if (sent[0]?.type !== "action_error") throw new Error("wrong type");
    // `plan` has no extension, so containment rejects it before the stat.
    expect(sent[0].error).toBe("not_allowed");
  });

  test("truncates beyond the cap but still answers", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    mkdirSync(join(root, "plan"));
    const big = "x".repeat(FS_READ_MAX_BYTES + 512);
    writeFileSync(join(root, "plan", "big.md"), big);
    const { sent, send } = collector();
    handleFsRead(send, { id: "r6", path: join(root, "plan", "big.md"), root });
    if (sent[0]?.type !== "fs_read_ok") throw new Error("expected fs_read_ok");
    expect(sent[0].truncated).toBe(true);
    expect(sent[0].bytes).toBe(big.length);
    expect(sent[0].content.length).toBe(FS_READ_MAX_BYTES);
  });

  test("reports not_found for a missing path", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    const { sent, send } = collector();
    handleFsRead(send, { id: "r7", path: join(root, "plan", "absent.md"), root });
    if (sent[0]?.type !== "action_error") throw new Error("expected action_error");
    expect(sent[0].error).toBe("not_found");
  });
});

/*
 * Regression (found in the real browser, not by these tests):
 *
 * `handleFsRead` originally measured the allowlist against `process.cwd()`. The
 * daemon's cwd is wherever the supervisor started it, which is NOT the workspace
 * whose plan/ the user is reading — so every legitimate read of a workspace plan
 * came back `not_allowed` and the Plan tab looked broken while the fence was in
 * fact working perfectly on the wrong root.
 *
 * The fix made `root` a REQUIRED field of the request. These two cases pin the
 * behaviour: the same file is readable under its own workspace and refused under
 * a different one.
 */
describe("handleFsRead — the allowlist is measured against the REQUESTED root", () => {
  test("a plan document is readable under its own workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, "plan", "77.md"), "# mine\n");
    const { sent, send } = collector();
    handleFsRead(send, { id: "x1", path: join(root, "plan", "77.md"), root });
    expect(sent[0]?.type).toBe("fs_read_ok");
  });

  test("the same file is refused under a DIFFERENT workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "fsread-"));
    const other = mkdtempSync(join(tmpdir(), "fsread-other-"));
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, "plan", "77.md"), "# mine\n");
    const { sent, send } = collector();
    handleFsRead(send, { id: "x2", path: join(root, "plan", "77.md"), root: other });
    if (sent[0]?.type !== "action_error") throw new Error("expected action_error");
    expect(sent[0].error).toBe("not_allowed");
  });
});
