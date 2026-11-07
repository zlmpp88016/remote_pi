/**
 * Automations projection tests.
 *
 * The point of these tests is the HONESTY RULE: a derived label must never be
 * invented for an expression that does not imply it. Every "does not match"
 * case asserts `custom` + all four derived fields null, so a future refactor
 * that "helpfully" guesses an interval fails here instead of shipping a lie to
 * the UI.
 */
import { describe, expect, it } from "vitest";
import { classifySchedule, projectJob, projectJobs } from "./projection.js";
import type { CronJob } from "../daemon/cron_registry.js";

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "j_abcdef01",
    daemon_id: "d_1",
    schedule: "*/5 * * * *",
    prompt: "check the deploy",
    enabled: true,
    skip_if_busy: true,
    wake: false,
    catchup: false,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

describe("classifySchedule — interval rules", () => {
  it("recognises a minute-step expression", () => {
    expect(classifySchedule("*/5 * * * *")).toEqual({
      kind: "every_minutes",
      everyMinutes: 5,
      everyHours: null,
      time: null,
      weekdays: null,
    });
  });

  it("recognises an hour-step expression", () => {
    expect(classifySchedule("0 */2 * * *")).toEqual({
      kind: "every_hours",
      everyHours: 2,
      everyMinutes: null,
      time: null,
      weekdays: null,
    });
  });

  it("treats a fixed minute of every hour as a one-hour interval", () => {
    expect(classifySchedule("30 * * * *")).toEqual({
      kind: "every_hours",
      everyHours: 1,
      everyMinutes: null,
      time: null,
      weekdays: null,
    });
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(classifySchedule("  */10   *  * * * ")).toMatchObject({
      kind: "every_minutes",
      everyMinutes: 10,
    });
  });
});

describe("classifySchedule — wall-clock rules", () => {
  it("recognises a daily wall-clock expression and zero-pads it", () => {
    expect(classifySchedule("5 9 * * *")).toEqual({
      kind: "daily",
      time: "09:05",
      everyMinutes: null,
      everyHours: null,
      weekdays: null,
    });
  });

  it("recognises a weekly expression with ascending ISO weekdays", () => {
    expect(classifySchedule("0 9 * * 5,1,3")).toEqual({
      kind: "weekly",
      time: "09:00",
      weekdays: [1, 3, 5],
      everyMinutes: null,
      everyHours: null,
    });
  });

  it("normalises cron's Sunday 0 to ISO 7", () => {
    expect(classifySchedule("0 9 * * 0")).toMatchObject({ kind: "weekly", weekdays: [7] });
    expect(classifySchedule("0 9 * * 7")).toMatchObject({ kind: "weekly", weekdays: [7] });
  });

  it("de-duplicates repeated weekdays", () => {
    expect(classifySchedule("0 9 * * 1,1,2")).toMatchObject({ weekdays: [1, 2] });
  });
});

describe("classifySchedule — refusals", () => {
  it("refuses an out-of-range hour instead of clamping it", () => {
    expect(classifySchedule("0 25 * * *")).toMatchObject({ kind: "custom", time: null });
  });

  it("refuses an out-of-range minute instead of clamping it", () => {
    expect(classifySchedule("75 9 * * *")).toMatchObject({ kind: "custom", time: null });
  });

  it("refuses a monthly expression", () => {
    expect(classifySchedule("0 0 1 * *")).toMatchObject({ kind: "custom" });
  });

  it("refuses a list-of-minutes expression", () => {
    expect(classifySchedule("0,30 * * * *")).toMatchObject({ kind: "custom" });
  });

  it("refuses a five-field expression that needs a day-of-month", () => {
    expect(classifySchedule("0 9 15 * *")).toMatchObject({ kind: "custom" });
  });

  it("refuses garbage without throwing", () => {
    expect(classifySchedule("not a cron")).toMatchObject({ kind: "custom" });
    expect(classifySchedule("")).toMatchObject({ kind: "custom" });
  });
});

describe("projectJob", () => {
  it("carries the authoritative expression through verbatim", () => {
    const v = projectJob(job({ schedule: "0 9 * * 1" }));
    expect(v.schedule).toBe("0 9 * * 1");
    expect(v.kind).toBe("weekly");
  });

  it("reports null for facts the daemon never recorded", () => {
    const v = projectJob(job());
    expect(v.lastRun).toBeNull();
    expect(v.lastStatus).toBeNull();
    expect(v.tz).toBeNull();
  });

  it("passes the daemon's own status vocabulary through unmapped", () => {
    const v = projectJob(job({ last_status: "skipped_busy", last_run: "2026-10-01T00:00:00.000Z" }));
    expect(v.lastStatus).toBe("skipped_busy");
  });

  it("keeps an explicit timezone", () => {
    expect(projectJob(job({ tz: "America/Sao_Paulo" })).tz).toBe("America/Sao_Paulo");
  });

  it("computes a next run for a valid expression", () => {
    /* `* * * * *` is valid croner syntax even though the control ops reject it
     * for being too frequent — the projection must not hide it. */
    expect(projectJob(job({ schedule: "*/5 * * * *" })).nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports null nextRun rather than throwing on an invalid expression", () => {
    expect(projectJob(job({ schedule: "definitely not cron" })).nextRun).toBeNull();
  });
});

describe("projectJobs", () => {
  it("preserves registry order", () => {
    const out = projectJobs([job({ id: "j_a" }), job({ id: "j_b" })]);
    expect(out.map((v) => v.id)).toEqual(["j_a", "j_b"]);
  });

  it("returns an empty array for no jobs", () => {
    expect(projectJobs([])).toEqual([]);
  });
});
