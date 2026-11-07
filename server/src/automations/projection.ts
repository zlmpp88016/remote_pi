/**
 * Automations projection — the web-facing view of the daemon's cron jobs.
 *
 * WHY THIS IS A PROJECTION AND NOT A NEW SUBSYSTEM
 *
 * plan/39 already gave this host a complete scheduled-task engine: a durable
 * registry (`cron.json`), croner-backed timers, catch-up on restart, wake-up of
 * a stopped workspace, a fire log, and six control ops. The web client had no
 * view of any of it, so the sidebar rendered "Automations" as a dead row.
 *
 * The alternative — porting DSH's `@deepseek-ai/dsh-schedule` — was rejected
 * after measurement: its published build exposes only after/at/every (the
 * daily/weekly/cron constructors are literally `undefined`), its records carry
 * no `title`, and it pulls 18 transitive alpha packages. Meanwhile the cron
 * engine here already expresses "every weekday at 09:00" and "every day at
 * 23:00 in Asia/Shanghai" — the requests users actually make.
 *
 * So there is ONE source of truth (`cron.json`), and this module only translates
 * its rows into a shape the browser can render.
 *
 * THE HONESTY RULE
 *
 * A cron expression is authoritative; a "kind" is a convenience label derived
 * FROM it. When the expression cannot be expressed as one of the simple kinds,
 * the derived fields are `null` — never a plausible-looking guess. A caller that
 * reads `everyMinutes === null` must treat it as "not an interval rule", not as
 * "zero minutes".
 */
import { nextRunFor, type CronJob } from "../daemon/cron_registry.js";
import type { WireScheduleTask } from "../protocol/types.js";

/** The label a task gets when its expression fits a common shape. */
export type ScheduleKind = "every_minutes" | "every_hours" | "daily" | "weekly" | "custom";

export interface ScheduleShape {
  kind: ScheduleKind;
  everyMinutes: number | null;
  everyHours: number | null;
  /** `HH:mm` wall-clock time for daily/weekly rules, else `null`. */
  time: string | null;
  /** ISO weekdays (Mon=1..Sun=7) for weekly rules, else `null`. */
  weekdays: number[] | null;
}

export interface ScheduleJobView extends ScheduleShape {
  id: string;
  daemonId: string;
  /** The authoritative cron expression, verbatim. Always present. */
  schedule: string;
  /** IANA zone, or `null` when the job inherits the host zone. */
  tz: string | null;
  prompt: string;
  enabled: boolean;
  skipIfBusy: boolean;
  wake: boolean;
  catchup: boolean;
  createdAt: string;
  /** Last fire instant, or `null` when it has never fired. */
  lastRun: string | null;
  /**
   * Last fire outcome, or `null`.
   *
   * This is the daemon's own closed vocabulary (`delivered`, `skipped_busy`,
   * `woke_and_delivered`, `skipped_down`, `skipped_disabled`, `deliver_failed`).
   * Passed through verbatim rather than mapped to friendlier words, because the
   * difference between "delivered" and "skipped_busy" is exactly what the user
   * needs to see when a task appears not to have run.
   */
  lastStatus: string | null;
  /** Next scheduled fire, or `null` when the expression yields none. */
  nextRun: string | null;
  /** Pinned model, or `null` when this job inherits the session's model. */
  model: { provider: string; id: string } | null;
  /** True when each fire opens its own session instead of the live one. */
  freshSession: boolean;
}

/* Only the shapes the create form can produce are recognised. A non-match is
 * not a failure — it is the honest answer for an expression the presets cannot
 * describe, and the UI shows the raw expression for it. */
const MINUTE_STEP = /^\*\/(\d+) \* \* \* \*$/;
const HOUR_STEP = /^0 \*\/(\d+) \* \* \*$/;
const HOURLY_AT = /^\d+ \* \* \* \*$/;
const DAILY_AT = /^(\d+) (\d+) \* \* \*$/;
const WEEKLY_AT = /^(\d+) (\d+) \* \* ([0-7](?:,[0-7])*)$/;

const CUSTOM: ScheduleShape = {
  kind: "custom",
  everyMinutes: null,
  everyHours: null,
  time: null,
  weekdays: null,
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Classify a cron expression into the UI's preset vocabulary.
 *
 * Deliberately strict: every alternative returns `custom` rather than a partial
 * match, so a rule that happens to fire hourly by coincidence is not advertised
 * as "every hour" unless its expression actually says so.
 */
export function classifySchedule(schedule: string): ScheduleShape {
  const expr = schedule.trim().replace(/\s+/g, " ");

  const minuteStep = MINUTE_STEP.exec(expr);
  if (minuteStep !== null) {
    const n = Number(minuteStep[1]);
    if (Number.isSafeInteger(n) && n > 0) {
      return { ...CUSTOM, kind: "every_minutes", everyMinutes: n };
    }
    return CUSTOM;
  }

  const hourStep = HOUR_STEP.exec(expr);
  if (hourStep !== null) {
    const n = Number(hourStep[1]);
    if (Number.isSafeInteger(n) && n > 0) {
      return { ...CUSTOM, kind: "every_hours", everyHours: n };
    }
    return CUSTOM;
  }

  /* "At minute M of every hour" is a clean one-hour interval only because the
   * shape fixes M; the regex requires that, so no extra check is needed. */
  if (HOURLY_AT.test(expr)) {
    return { ...CUSTOM, kind: "every_hours", everyHours: 1 };
  }

  const daily = DAILY_AT.exec(expr);
  if (daily !== null) {
    const minute = Number(daily[1]);
    const hour = Number(daily[2]);
    if (hour < 24 && minute < 60) {
      return { ...CUSTOM, kind: "daily", time: `${pad(hour)}:${pad(minute)}` };
    }
    return CUSTOM;
  }

  const weekly = WEEKLY_AT.exec(expr);
  if (weekly !== null) {
    const minute = Number(weekly[1]);
    const hour = Number(weekly[2]);
    /* Cron accepts both 0 and 7 for Sunday. Normalise to ISO (Mon=1..Sun=7) so
     * the UI has one convention to render. */
    const iso = weekly[3].split(",").map((d) => (Number(d) === 0 ? 7 : Number(d)));
    if (hour < 24 && minute < 60 && iso.every((d) => d >= 1 && d <= 7)) {
      return {
        ...CUSTOM,
        kind: "weekly",
        time: `${pad(hour)}:${pad(minute)}`,
        weekdays: [...new Set(iso)].sort((a, b) => a - b),
      };
    }
    return CUSTOM;
  }

  return CUSTOM;
}

/** Project one registry row into the shape the browser renders. */
export function projectJob(job: CronJob): ScheduleJobView {
  const shape = classifySchedule(job.schedule);
  const next = nextRunFor(job);
  return {
    ...shape,
    id: job.id,
    daemonId: job.daemon_id,
    schedule: job.schedule,
    tz: job.tz ?? null,
    prompt: job.prompt,
    enabled: job.enabled,
    skipIfBusy: job.skip_if_busy,
    wake: job.wake,
    catchup: job.catchup,
    createdAt: job.created_at,
    lastRun: job.last_run ?? null,
    lastStatus: job.last_status ?? null,
    nextRun: next === null ? null : next.toISOString(),
    model: job.model === undefined ? null : { provider: job.model.provider, id: job.model.id },
    freshSession: job.fresh_session === true,
  };
}

export function projectJobs(jobs: readonly CronJob[]): ScheduleJobView[] {
  return jobs.map(projectJob);
}

/**
 * The camelCase view -> snake_case wire.
 *
 * A single explicit mapping rather than a generic re-keyer: the two shapes are
 * allowed to diverge (the wire is versioned independently of this module), and a
 * generic transform would silently carry a renamed field across as a new key.
 */
export function toWire(v: ScheduleJobView): WireScheduleTask {
  return {
    id: v.id,
    daemon_id: v.daemonId,
    schedule: v.schedule,
    kind: v.kind,
    every_minutes: v.everyMinutes,
    every_hours: v.everyHours,
    time: v.time,
    weekdays: v.weekdays,
    tz: v.tz,
    prompt: v.prompt,
    enabled: v.enabled,
    skip_if_busy: v.skipIfBusy,
    wake: v.wake,
    catchup: v.catchup,
    created_at: v.createdAt,
    last_run: v.lastRun,
    last_status: v.lastStatus,
    next_run: v.nextRun,
    /*
     * `name` is deliberately null: the daemon stores only ids, and inventing a
     * display label here would put a guessed string on the wire. The panel shows
     * the id, which is what the user actually chose.
     */
    model: v.model === null ? null : { provider: v.model.provider, id: v.model.id, name: null },
    fresh_session: v.freshSession,
  };
}
