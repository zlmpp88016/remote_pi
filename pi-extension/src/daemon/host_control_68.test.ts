import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFsList } from "./fs_nav.js";
import {
  handleWorkspaceAdd,
  handleWorkspaceList,
  handleWorkspaceRemove,
  handleWorkspaceStart,
  type FleetEntry,
  type FleetOps,
  type HostReplySender,
} from "./host_control.js";
import { daemonIdForCwd } from "./id.js";
import { addWorkspace, listWorkspaces, removeWorkspace, workspacesPath } from "./workspaces.js";
import type { ServerMessage } from "../protocol/types.js";

/** Captures everything the handler sends so assertions stay on the wire shape. */
function capture(): { sender: HostReplySender; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { sender: { send: (m) => sent.push(m) }, sent };
}

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pi-ws68-"));
  process.env["REMOTE_PI_HOME"] = testHome;
});

afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Minimal in-memory FleetOps backed by the real workspaces.json + a fake
 *  daemon set, so the handlers see the same catalog the supervisor builds. */
function makeOps(opts: { daemons?: FleetEntry[]; started?: string[]; startError?: string } = {}): FleetOps {
  const daemons = opts.daemons ?? [];
  const started = opts.started ?? [];
  const catalog = (): FleetEntry[] => [
    ...daemons,
    ...listWorkspaces()
      .filter((w) => !daemons.some((d) => d.cwd === w.cwd))
      .map((w) => ({
        id: daemonIdForCwd(w.cwd),
        cwd: w.cwd,
        name: w.name,
        live: false,
        source: "added" as const,
      })),
  ];
  return {
    list: catalog,
    ensure: (cwd) => {
      try {
        const { cwd: resolved, added } = addWorkspace(cwd);
        return { ok: true, id: daemonIdForCwd(resolved), cwd: resolved, name: "ws", added };
      } catch (e) {
        const message = (e as Error).message;
        return { ok: false, error: /ENOENT|not directory|ENOTDIR|required/i.test(message) ? "not_found" : message };
      }
    },
    start: (id) => {
      if (opts.startError) return { ok: false, error: opts.startError };
      started.push(id);
      return { ok: true, started: true };
    },
    stop: async () => ({ ok: true, stopped: true }),
    addWorkspace: (cwd) => {
      try {
        const { cwd: resolved, added } = addWorkspace(cwd);
        return { ok: true, cwd: resolved, added };
      } catch (e) {
        const message = (e as Error).message;
        return { ok: false, error: /ENOENT|not directory|ENOTDIR|required/i.test(message) ? "not_found" : message };
      }
    },
    removeWorkspace: (cwd) => {
      try {
        const { cwd: resolved, removed } = removeWorkspace(cwd);
        return { ok: true, cwd: resolved, removed };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

// ── fs_list ──────────────────────────────────────────────────────────────────

describe("plan/68 — fs_list", () => {
  test("lists directories (dirs first, alphabetical) and files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fsroot-"));
    mkdirSync(join(root, "zeta"));
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "beta.txt"), "x");
    const { sender, sent } = capture();
    handleFsList(sender, { id: "r1", path: root });

    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg.type).toBe("fs_list_ok");
    if (msg.type !== "fs_list_ok") throw new Error("wrong type");
    expect(msg.in_reply_to).toBe("r1");
    expect(msg.entries.map((e) => e.name)).toEqual(["alpha", "zeta", "beta.txt"]);
    expect(msg.entries.map((e) => e.kind)).toEqual(["dir", "dir", "file"]);
    expect(msg.parent).not.toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("marks is_repo when a .git directory is present", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fsrepo-"));
    mkdirSync(join(root, "proj", ".git"), { recursive: true });
    mkdirSync(join(root, "plain"));
    const { sender, sent } = capture();
    handleFsList(sender, { id: "r2", path: root });
    const msg = sent[0]!;
    if (msg.type !== "fs_list_ok") throw new Error("wrong type");
    const proj = msg.entries.find((e) => e.name === "proj");
    const plain = msg.entries.find((e) => e.name === "plain");
    expect(proj?.is_repo).toBe(true);
    expect(plain?.is_repo).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  test("hides dotfiles by default, shows them with show_hidden", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fshidden-"));
    mkdirSync(join(root, ".config"));
    mkdirSync(join(root, "visible"));
    const a = capture();
    handleFsList(a.sender, { id: "r3", path: root });
    const hiddenOff = a.sent[0]!;
    if (hiddenOff.type !== "fs_list_ok") throw new Error("wrong type");
    expect(hiddenOff.entries.map((e) => e.name)).toEqual(["visible"]);

    const b = capture();
    handleFsList(b.sender, { id: "r4", path: root, show_hidden: true });
    const hiddenOn = b.sent[0]!;
    if (hiddenOn.type !== "fs_list_ok") throw new Error("wrong type");
    expect(hiddenOn.entries.map((e) => e.name)).toContain(".config");
    rmSync(root, { recursive: true, force: true });
  });

  test("expands ~ to the home directory", () => {
    // REMOTE_PI_HOME overrides only the registry root, not ~ expansion, so this
    // asserts against the real homedir() the handler uses.
    const { sender, sent } = capture();
    handleFsList(sender, { id: "r5", path: "~" });
    const msg = sent[0]!;
    expect(msg.type).toBe("fs_list_ok");
    if (msg.type !== "fs_list_ok") throw new Error("wrong type");
    expect(msg.parent).not.toBe("~");
  });

  // Typed errors
  test("not_found for a missing path", () => {
    const { sender, sent } = capture();
    handleFsList(sender, { id: "e1", path: join(tmpdir(), "definitely-missing-xyz-123") });
    const msg = sent[0]!;
    expect(msg.type).toBe("action_error");
    if (msg.type !== "action_error") throw new Error("wrong type");
    expect(msg.action).toBe("fs_list");
    expect(msg.error).toBe("not_found");
  });

  test("not_a_directory for a file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fsfile-"));
    const file = join(root, "a.txt");
    writeFileSync(file, "hi");
    const { sender, sent } = capture();
    handleFsList(sender, { id: "e2", path: file });
    const msg = sent[0]!;
    if (msg.type !== "action_error") throw new Error("expected action_error");
    expect(msg.error).toBe("not_a_directory");
    rmSync(root, { recursive: true, force: true });
  });
});

// ── workspace_add / workspace_remove ─────────────────────────────────────────

describe("plan/68 — workspace_add / workspace_remove", () => {
  test("add persists to workspaces.json and appears in the catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-addws-"));
    const ops = makeOps();
    const { sender, sent } = capture();
    handleWorkspaceAdd(ops, sender, { id: "a1", path: dir });

    expect(sent[0]).toEqual({ type: "action_ok", in_reply_to: "a1", action: "workspace_add" });
    expect(listWorkspaces().map((w) => w.cwd)).toContain(listWorkspaces()[0]!.cwd);

    const list = capture();
    handleWorkspaceList(ops, list.sender, { id: "l1" });
    const msg = list.sent[0]!;
    if (msg.type !== "workspace_list_ok") throw new Error("wrong type");
    const row = msg.workspaces.find((w) => w.cwd === listWorkspaces()[0]!.cwd);
    expect(row?.source).toBe("added");
    expect(row?.daemon).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("add is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-addws2-"));
    const ops = makeOps();
    handleWorkspaceAdd(ops, capture().sender, { id: "a1", path: dir });
    handleWorkspaceAdd(ops, capture().sender, { id: "a2", path: dir });
    expect(listWorkspaces()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("add of a missing path → typed not_found", () => {
    const ops = makeOps();
    const { sender, sent } = capture();
    handleWorkspaceAdd(ops, sender, { id: "a3", path: join(tmpdir(), "nope-xyz-987") });
    const msg = sent[0]!;
    if (msg.type !== "action_error") throw new Error("expected action_error");
    expect(msg.action).toBe("workspace_add");
    expect(msg.error).toBe("not_found");
  });

  test("remove drops the added entry (and never a daemon)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rmws-"));
    const ops = makeOps();
    handleWorkspaceAdd(ops, capture().sender, { id: "a1", path: dir });
    const { sender, sent } = capture();
    handleWorkspaceRemove(ops, sender, { id: "r1", path: dir });
    expect(sent[0]).toEqual({ type: "action_ok", in_reply_to: "r1", action: "workspace_remove" });
    expect(listWorkspaces()).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── workspace_start with an arbitrary cwd ────────────────────────────────────

describe("plan/68 — workspace_start with an unregistered cwd", () => {
  test("registers + starts a cwd outside daemons.json, and it survives a reconnect", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-startws-"));
    const started: string[] = [];
    const ops = makeOps({ started });

    const { sender, sent } = capture();
    handleWorkspaceStart(ops, sender, { id: "s1", cwd: dir });

    const ok = sent[0]!;
    expect(ok.type).toBe("workspace_start_ok");
    if (ok.type !== "workspace_start_ok") throw new Error("wrong type");
    expect(started).toContain(ok.daemon_id);
    // Persisted on the host side.
    expect(listWorkspaces().map((w) => w.cwd)).toContain(ok.cwd);

    // "Reconnect" = a fresh FleetOps over the same on-disk catalog (the
    // supervisor re-reads workspaces.json on construction).
    const reconnected = makeOps();
    const list = capture();
    handleWorkspaceList(reconnected, list.sender, { id: "l2" });
    const msg = list.sent[0]!;
    if (msg.type !== "workspace_list_ok") throw new Error("wrong type");
    expect(msg.workspaces.some((w) => w.cwd === ok.cwd && w.source === "added")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("a spawn failure surfaces the typed spawn_failed error", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-startfail-"));
    const ops = makeOps({ startError: "spawn ENOENT pi" });
    const { sender, sent } = capture();
    handleWorkspaceStart(ops, sender, { id: "s2", cwd: dir });
    const msg = sent[0]!;
    if (msg.type !== "action_error") throw new Error("expected action_error");
    expect(msg.action).toBe("workspace_start");
    expect(msg.error).toBe("spawn_failed");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a nonexistent cwd → not_found", () => {
    const ops = makeOps();
    const { sender, sent } = capture();
    handleWorkspaceStart(ops, sender, { id: "s3", cwd: join(tmpdir(), "gone-xyz-555") });
    const msg = sent[0]!;
    if (msg.type !== "action_error") throw new Error("expected action_error");
    expect(msg.error).toBe("not_found");
  });
});

// ── persistence ──────────────────────────────────────────────────────────────

describe("plan/68 — workspaces.json persistence", () => {
  test("path honours REMOTE_PI_HOME and the schema is only { workspaces: [{cwd}] }", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-persist-"));
    addWorkspace(dir);
    expect(workspacesPath()).toBe(join(testHome, ".pi", "remote", "workspaces.json"));
    const raw = JSON.parse(require("node:fs").readFileSync(workspacesPath(), "utf8")) as unknown;
    expect(raw).toEqual({ workspaces: [{ cwd: listWorkspaces()[0]!.cwd }] });
    rmSync(dir, { recursive: true, force: true });
  });
});
