import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureRelayLog, parseRelayLogFlags, _resetRelayLogForTest } from "./log.js";

/**
 * Relay-log flag parsing + configuration.
 *
 * The supervisor deliberately refuses unknown arguments (a stray arg once
 * started a full supervisor for days), so `--log`/`--log-file` must be
 * recognised, validated, and REMOVED from the arg list — everything else has
 * to keep flowing to the caller's own parser.
 */
describe("relay log flags", () => {
  const savedLog = process.env["REMOTE_PI_LOG"];
  const savedFile = process.env["REMOTE_PI_LOG_FILE"];

  beforeEach(() => {
    delete process.env["REMOTE_PI_LOG"];
    delete process.env["REMOTE_PI_LOG_FILE"];
    _resetRelayLogForTest();
  });

  afterEach(() => {
    if (savedLog === undefined) delete process.env["REMOTE_PI_LOG"];
    else process.env["REMOTE_PI_LOG"] = savedLog;
    if (savedFile === undefined) delete process.env["REMOTE_PI_LOG_FILE"];
    else process.env["REMOTE_PI_LOG_FILE"] = savedFile;
    _resetRelayLogForTest();
  });

  test("--log <level> is parsed and stripped from the rest", () => {
    const f = parseRelayLogFlags(["--log", "summary", "pair"]);
    expect(f.error).toBeUndefined();
    expect(f.level).toBe("summary");
    expect(f.rest).toEqual(["pair"]);
  });

  test("--log=<level> inline form works", () => {
    expect(parseRelayLogFlags(["--log=full"]).level).toBe("full");
  });

  test("--log-file <path> is parsed", () => {
    const f = parseRelayLogFlags(["--log-file", "/tmp/x.log"]);
    expect(f.file).toBe("/tmp/x.log");
    expect(f.rest).toEqual([]);
  });

  test("both flags in one argv", () => {
    const f = parseRelayLogFlags(["--log", "full", "--log-file", "a.log", "devices"]);
    expect(f.level).toBe("full");
    expect(f.file).toBe("a.log");
    expect(f.rest).toEqual(["devices"]);
  });

  test("unknown args are left for the caller to reject", () => {
    expect(parseRelayLogFlags(["--bogus", "x"]).rest).toEqual(["--bogus", "x"]);
  });

  test("invalid level is an error, not a silent default", () => {
    const f = parseRelayLogFlags(["--log", "loud"]);
    expect(f.error).toMatch(/invalid --log value/);
  });

  test("missing value is an error", () => {
    expect(parseRelayLogFlags(["--log"]).error).toMatch(/requires a value/);
    expect(parseRelayLogFlags(["--log-file"]).error).toMatch(/requires a value/);
  });

  test("off disables logging explicitly", () => {
    configureRelayLog({ level: "off", inheritEnv: false });
    expect(parseRelayLogFlags(["--log", "off"]).level).toBe("off");
  });

  test("configureRelayLog mirrors the level into the env for child inheritance", () => {
    configureRelayLog({ level: "summary" });
    expect(process.env["REMOTE_PI_LOG"]).toBe("summary");
    configureRelayLog({ level: "full", file: "f.log" });
    expect(process.env["REMOTE_PI_LOG"]).toBe("full");
    expect(process.env["REMOTE_PI_LOG_FILE"]).toBe("f.log");
  });

  test("inheritEnv:false configures this process without exporting", () => {
    configureRelayLog({ level: "full", inheritEnv: false });
    expect(process.env["REMOTE_PI_LOG"]).toBeUndefined();
  });
});
