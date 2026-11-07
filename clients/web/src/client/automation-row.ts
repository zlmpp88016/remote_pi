/**
 * Wire -> panel row conversion for Automations.
 *
 * Kept out of the panel (which must stay render-only) and out of the protocol
 * module (which must stay free of UI types). This is the one place the snake_case
 * wire shape becomes the camelCase view shape, so a field rename has exactly one
 * site to change.
 *
 * The derived fields are passed through as `null` when the host said null. They
 * are NEVER defaulted: a `kind` of "custom" is a real answer, and an
 * `every_minutes` of 0 would describe a rule that fires constantly rather than
 * one the host could not classify.
 */
import type { AutomationRow } from "@/components/remote-pi/layout/automations-panel";
import type { WireScheduleTask } from "@/lib/remote-pi/protocol";

/** The host's projection can gain kinds before this client knows them. */
const KINDS: readonly AutomationRow["kind"][] = [
  "every_minutes",
  "every_hours",
  "daily",
  "weekly",
  "custom",
];

export function toAutomationRow(wire: WireScheduleTask): AutomationRow {
  const kind = KINDS.find((k) => k === wire.kind) ?? "custom";
  return {
    id: wire.id,
    daemonId: wire.daemon_id,
    schedule: wire.schedule,
    kind,
    everyMinutes: wire.every_minutes ?? null,
    everyHours: wire.every_hours ?? null,
    time: wire.time ?? null,
    weekdays: wire.weekdays ?? null,
    tz: wire.tz ?? null,
    prompt: wire.prompt,
    enabled: wire.enabled,
    skipIfBusy: wire.skip_if_busy === true,
    wake: wire.wake === true,
    catchup: wire.catchup === true,
    createdAt: wire.created_at,
    lastRun: wire.last_run ?? null,
    lastStatus: wire.last_status ?? null,
    nextRun: wire.next_run ?? null,
    /*
     * An absent model is INHERIT, spelled as `null` so the panel has exactly one
     * state to test. It is never synthesized: there is no sensible default
     * provider to invent, and guessing would put a model on screen that the
     * daemon is not actually using.
     */
    model: wire.model === null || wire.model === undefined
      ? null
      : { provider: wire.model.provider, id: wire.model.id, name: wire.model.name ?? null },
    freshSession: wire.fresh_session === true,
  };
}
