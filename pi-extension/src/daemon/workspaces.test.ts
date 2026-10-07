import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorkspace,
  listWorkspaces,
  loadWorkspaces,
  removeWorkspace,
  workspacesPath,
} from "./workspaces.js";

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pi-wsreg-"));
  process.env["REMOTE_PI_HOME"] = testHome;
});

afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("plan/68 — workspaces.json store", () => {
  test("path is ~/.pi/remote/workspaces.json under REMOTE_PI_HOME", () => {
    expect(workspacesPath()).toBe(join(testHome, ".pi", "remote", "workspaces.json"));
  });

  test("add normalizes (realpath) and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wsadd-"));
    const first = addWorkspace(dir);
    expect(first.added).toBe(true);
    const second = addWorkspace(dir);
    expect(second.added).toBe(false);
    expect(second.cwd).toBe(first.cwd);
    expect(listWorkspaces()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists only { workspaces: [{ cwd }] }", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wsfile-"));
    addWorkspace(dir);
    const raw = JSON.parse(readFileSync(workspacesPath(), "utf8")) as unknown;
    expect(raw).toEqual({ workspaces: [{ cwd: listWorkspaces()[0]!.cwd }] });
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadWorkspaces tolerates a corrupt file", () => {
    mkdirSync(join(testHome, ".pi", "remote"), { recursive: true });
    require("node:fs").writeFileSync(workspacesPath(), "{ not json");
    expect(loadWorkspaces()).toEqual({ workspaces: [] });
  });

  test("remove deletes the entry; a second remove is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wsrm-"));
    addWorkspace(dir);
    const cwd = listWorkspaces()[0]!.cwd;
    expect(removeWorkspace(cwd).removed).toBe(true);
    expect(listWorkspaces()).toHaveLength(0);
    expect(removeWorkspace(cwd).removed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("remove can clean a stale entry whose directory is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wsstale-"));
    const { cwd } = addWorkspace(dir);
    rmSync(dir, { recursive: true, force: true }); // entry now points at nothing
    // normalizeCwd would throw (realpath fails) — removal must still work.
    expect(removeWorkspace(cwd).removed).toBe(true);
    expect(listWorkspaces()).toHaveLength(0);
  });

  test("add of a missing path throws (caller maps to not_found)", () => {
    expect(() => addWorkspace(join(tmpdir(), "definitely-gone-42"))).toThrow();
  });
});
