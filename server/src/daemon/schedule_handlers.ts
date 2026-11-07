/**
 * Automations — host-room handlers for the scheduled-task surface.
 *
 * Lives beside the other host handlers (no WS, no storage of its own): every
 * mutation is forwarded to `ScheduleOps`, which the supervisor backs with the
 * same cron registry the CLI uses. That is what keeps a task created from the
 * browser and one created by `remote-pi-server cron add` indistinguishable.
 *
 * ## Reply shape
 *
 * Each request gets exactly one reply carrying `in_reply_to`. Failures use
 * `action_error`, matching the rest of the wire, rather than a bespoke error
 * envelope — the client already knows how to surface those.
 *
 * ## What is NOT here
 *
 * No derivation. The response carries the projection (kind, time, weekdays) as
 * computed by `projection.ts`, so the browser never re-implements cron parsing.
 */
import { projectJob, projectJobs, toWire } from "../automations/projection.js";
import type { ActionName, ServerMessage, ClientMessage } from "../protocol/types.js";
import type { HostReplySender, ScheduleOps } from "./host_control.js";

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

function ok(sender: HostReplySender, msg: ServerMessage): void {
  sender.send(msg);
}

function fail(
  sender: HostReplySender,
  inReplyTo: string,
  action: ActionName,
  error: string,
): void {
  sender.send({ type: "action_error", in_reply_to: inReplyTo, action, error });
}

/** The capability is absent when the host has no cron engine (bare host, tests). */
function requireOps(
  sender: HostReplySender,
  inReplyTo: string,
  action: ActionName,
  ops: ScheduleOps | undefined,
): ops is ScheduleOps {
  if (ops !== undefined) return true;
  fail(sender, inReplyTo, action, "automations are not available on this host");
  return false;
}

export function handleScheduleList(
  ops: ScheduleOps | undefined,
  sender: HostReplySender,
  msg: Msg<"schedule_list">,
): void {
  if (!requireOps(sender, msg.id, "schedule_list", ops)) return;
  ok(sender, {
    type: "schedule_list_ok",
    in_reply_to: msg.id,
    tasks: projectJobs(ops.list()).map(toWire),
    workspace_names: ops.names(),
  });
}

export function handleScheduleAdd(
  ops: ScheduleOps | undefined,
  sender: HostReplySender,
  msg: Msg<"schedule_add">,
): void {
  if (!requireOps(sender, msg.id, "schedule_add", ops)) return;

  /*
   * Validate before touching storage. The daemon would reject a bad expression
   * anyway, but doing it here means a typo never creates a row that the list
   * then has to explain.
   */
  const draft: Parameters<ScheduleOps["add"]>[0] = {
    daemon_id: msg.daemon_id,
    schedule: msg.schedule,
    prompt: msg.prompt,
  };
  if (msg.tz !== null && msg.tz !== undefined) draft.tz = msg.tz;
  if (msg.skip_if_busy !== undefined) draft.skip_if_busy = msg.skip_if_busy;
  if (msg.wake !== undefined) draft.wake = msg.wake;
  if (msg.catchup !== undefined) draft.catchup = msg.catchup;
  /*
   * A half-specified model is refused rather than silently ignored.
   *
   * If the client sends `{provider}` with no `id`, dropping it would create a task
   * the user believes is pinned while it actually inherits — the failure would
   * only show up as an unexpected bill on the expensive model.
   */
  if (msg.model !== null && msg.model !== undefined) {
    if (msg.model.provider === "" || msg.model.id === "") {
      fail(sender, msg.id, "schedule_add", "model needs both a provider and an id");
      return;
    }
    draft.model = { provider: msg.model.provider, id: msg.model.id };
  }
  if (msg.fresh_session === true) draft.fresh_session = true;

  const created = ops.add(draft);
  if ("error" in created) {
    fail(sender, msg.id, "schedule_add", created.error);
    return;
  }
  ok(sender, {
    type: "schedule_add_ok",
    in_reply_to: msg.id,
    task: toWire(projectJob(created)),
  });
}

export function handleScheduleRemove(
  ops: ScheduleOps | undefined,
  sender: HostReplySender,
  msg: Msg<"schedule_remove">,
): void {
  if (!requireOps(sender, msg.id, "schedule_remove", ops)) return;
  if (!ops.remove(msg.job_id)) {
    fail(sender, msg.id, "schedule_remove", "no automation with that id");
    return;
  }
  ok(sender, { type: "schedule_remove_ok", in_reply_to: msg.id, job_id: msg.job_id });
}

export function handleScheduleSetEnabled(
  ops: ScheduleOps | undefined,
  sender: HostReplySender,
  msg: Msg<"schedule_set_enabled">,
): void {
  if (!requireOps(sender, msg.id, "schedule_set_enabled", ops)) return;
  if (!ops.setEnabled(msg.job_id, msg.enabled)) {
    fail(sender, msg.id, "schedule_set_enabled", "no automation with that id");
    return;
  }
  ok(sender, {
    type: "schedule_set_enabled_ok",
    in_reply_to: msg.id,
    job_id: msg.job_id,
    enabled: msg.enabled,
  });
}

export async function handleScheduleRunNow(
  ops: ScheduleOps | undefined,
  sender: HostReplySender,
  msg: Msg<"schedule_run_now">,
): Promise<void> {
  if (!requireOps(sender, msg.id, "schedule_run_now", ops)) return;
  const result = await ops.runNow(msg.job_id);
  /*
   * A fire that was SKIPPED is not a failed request — the host did what the
   * policy said. It still reports the outcome verbatim so the UI can show
   * "skipped_busy" rather than a green check that lies.
   */
  ok(sender, {
    type: "schedule_run_now_ok",
    in_reply_to: msg.id,
    job_id: msg.job_id,
    result,
  });
}
