import { describe, expect, test } from "vitest";
import { ipcAddress, usesNamedPipe } from "./ipc.js";

describe("usesNamedPipe", () => {
  test("true only on win32", () => {
    expect(usesNamedPipe("win32")).toBe(true);
    expect(usesNamedPipe("darwin")).toBe(false);
    expect(usesNamedPipe("linux")).toBe(false);
  });
});

describe("ipcAddress", () => {
  test("POSIX → returns the filesystem path unchanged", () => {
    const p = "/home/u/.pi/remote/supervisor.sock";
    expect(ipcAddress("supervisor", p, "darwin", "u")).toBe(p);
    expect(ipcAddress("supervisor", p, "linux", "u")).toBe(p);
  });

  test("Windows → per-user named pipe", () => {
    expect(ipcAddress("supervisor", "/ignored.sock", "win32", "user"))
      .toBe("\\\\.\\pipe\\remote-pi-supervisor-user");
    expect(ipcAddress("broker-local", "/ignored.sock", "win32", "alice"))
      .toBe("\\\\.\\pipe\\remote-pi-broker-local-alice");
  });

  test("Windows → sanitizes unsafe chars in suffix + user", () => {
    expect(ipcAddress("broker local", "/x", "win32", "DOMAIN\\user"))
      .toBe("\\\\.\\pipe\\remote-pi-broker_local-DOMAIN_user");
  });

  test("Windows → falls back to 'user' when username is empty", () => {
    expect(ipcAddress("supervisor", "/x", "win32", "", "")).toBe("\\\\.\\pipe\\remote-pi-supervisor-user");
  });

  /*
   * `REMOTE_PI_INSTANCE` is what lets a SECOND stack run beside the dev one.
   * Without it the Windows pipe name carries only suffix+user, so two
   * supervisors collide no matter which `REMOTE_PI_HOME` each was built from.
   */
  test("an instance name keeps two stacks off each other's address", () => {
    expect(ipcAddress("supervisor", "/x", "win32", "u", ".staging"))
      .toBe("\\\\.\\pipe\\remote-pi-supervisor.staging-u");
    // POSIX: the suffix goes before `.sock`, so stale-socket globs still match.
    expect(ipcAddress("supervisor", "/h/.pi/remote/supervisor.sock", "darwin", "u", ".staging"))
      .toBe("/h/.pi/remote/supervisor.staging.sock");
    // A path without `.sock` still gets a distinct address rather than colliding.
    expect(ipcAddress("broker", "/h/broker", "linux", "u", ".staging")).toBe("/h/broker.staging");
  });

  test("no instance name → exactly today's addresses", () => {
    expect(ipcAddress("supervisor", "/h/supervisor.sock", "darwin", "u", ""))
      .toBe("/h/supervisor.sock");
    expect(ipcAddress("supervisor", "/x", "win32", "u", ""))
      .toBe("\\\\.\\pipe\\remote-pi-supervisor-u");
  });
});
