import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addJob,
  cronRegistryPath,
  getJob,
  listJobs,
  loadCronRegistry,
  nextRunFor,
  recordRun,
  removeJob,
  saveCronRegistry,
  setJobEnabled,
  validateSchedule,
} from "./cron_registry.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-cron-"));
  process.env["REMOTE_PI_HOME"] = home;
});
afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("cron_registry — CRUD", () => {
  test("missing file → empty registry", () => {
    expect(loadCronRegistry()).toEqual({ jobs: [] });
    expect(listJobs()).toEqual([]);
  });

  test("addJob persists with a j_ id + sensible defaults", () => {
    const job = addJob({ daemon_id: "abcd1234", schedule: "0 9 * * *", prompt: "hi" });
    expect(job.id).toMatch(/^j_[0-9a-f]{8}$/);
    expect(job).toMatchObject({
      daemon_id: "abcd1234",
      schedule: "0 9 * * *",
      prompt: "hi",
      enabled: true,
      skip_if_busy: true,
      wake: false,
      catchup: false,
    });
    expect(typeof job.created_at).toBe("string");
    // round-trips to disk
    const onDisk = JSON.parse(readFileSync(cronRegistryPath(), "utf8")) as { jobs: unknown[] };
    expect(onDisk.jobs).toHaveLength(1);
    expect(getJob(job.id)?.prompt).toBe("hi");
  });

  test("flags + tz are honored", () => {
    const job = addJob({
      daemon_id: "d", schedule: "0 * * * *", prompt: "p",
      tz: "America/Sao_Paulo", skip_if_busy: false, wake: true, catchup: true,
    });
    expect(job).toMatchObject({ tz: "America/Sao_Paulo", skip_if_busy: false, wake: true, catchup: true });
  });

  test("removeJob removes; unknown id → false", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p" });
    expect(removeJob(job.id)).toBe(true);
    expect(listJobs()).toEqual([]);
    expect(removeJob("j_deadbeef")).toBe(false);
  });

  test("setJobEnabled toggles; unknown id → false", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p" });
    expect(setJobEnabled(job.id, false)).toBe(true);
    expect(getJob(job.id)?.enabled).toBe(false);
    expect(setJobEnabled("j_nope", true)).toBe(false);
  });

  test("recordRun stores last_run/last_status", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p" });
    recordRun(job.id, "2026-06-07T12:00:00.000Z", "delivered");
    expect(getJob(job.id)).toMatchObject({ last_run: "2026-06-07T12:00:00.000Z", last_status: "delivered" });
  });

  test("corrupt entries are dropped on load", () => {
    saveCronRegistry({ jobs: [
      { id: "j_ok", daemon_id: "d", schedule: "0 9 * * *", prompt: "p", enabled: true, skip_if_busy: true, wake: false, catchup: false, created_at: "x" },
      // @ts-expect-error intentionally malformed
      { id: "j_bad" },
    ] });
    expect(listJobs().map((j) => j.id)).toEqual(["j_ok"]);
  });
});

describe("validateSchedule", () => {
  test("accepts a daily expression", () => {
    const v = validateSchedule("0 9 * * *");
    expect(v.ok).toBe(true);
    expect(v.intervalMs).toBeGreaterThanOrEqual(60_000);
  });

  test("rejects an invalid expression", () => {
    const v = validateSchedule("not a cron");
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/invalid cron/i);
  });

  test("rejects a too-frequent (<60s) schedule (per-second 6-field)", () => {
    const v = validateSchedule("* * * * * *"); // every second
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/too frequent|60s/i);
  });

  test("accepts a per-minute schedule (exactly 60s)", () => {
    const v = validateSchedule("* * * * *");
    expect(v.ok).toBe(true);
  });

  test("honors timezone without throwing", () => {
    const v = validateSchedule("0 9 * * *", "America/Sao_Paulo");
    expect(v.ok).toBe(true);
  });
});

describe("nextRunFor", () => {
  test("returns a future Date for a valid job", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p" });
    const next = nextRunFor(job);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });
});

/*
 * Model pin + session choice.
 *
 * These are the two fields that decide WHAT a fire actually does, so the tests
 * check both directions: an absent field must stay absent (inherit), and a
 * half-written pin must be discarded rather than half-applied.
 */
describe("job model pin and session choice", () => {
  test("omitting the model leaves the job inheriting", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p" });
    expect(job.model).toBeUndefined();
    expect(job.fresh_session).toBeUndefined();
    const reread = getJob(job.id);
    expect(reread!.model).toBeUndefined();
  });

  test("a pinned model survives a save/load round trip", () => {
    const job = addJob({
      daemon_id: "d",
      schedule: "0 9 * * *",
      prompt: "p",
      model: { provider: "my-newapi", id: "deepseek-flash" },
      fresh_session: true,
    });
    const reread = getJob(job.id);
    expect(reread!.model).toEqual({ provider: "my-newapi", id: "deepseek-flash" });
    expect(reread!.fresh_session).toBe(true);
  });

  test("a half-written pin is dropped instead of silently applied", () => {
    saveCronRegistry({
      jobs: [
        {
          id: "j_bad",
          daemon_id: "d",
          schedule: "0 9 * * *",
          prompt: "p",
          enabled: true,
          skip_if_busy: true,
          wake: false,
          catchup: false,
          created_at: new Date(0).toISOString(),
          // provider without an id: cannot be honoured, must not look pinned
          model: { provider: "my-newapi" } as unknown as { provider: string; id: string },
        },
      ],
    });
    expect(getJob("j_bad")!.model).toBeUndefined();
  });

  test("fresh_session only becomes true when explicitly true", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p", fresh_session: false });
    expect(getJob(job.id)!.fresh_session).toBeUndefined();
  });
});
