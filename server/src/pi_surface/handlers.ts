/**
 * Plan/68 — Pi surface handlers: `pi_surface`, `skill_invoke`,
 * `skill_set_enabled`, `package_install|remove|update`.
 *
 * Same discipline as `actions/handlers.ts`: dependencies are parameters so
 * index.ts wiring stays a one-liner and tests pass fakes without globals.
 * Every handler replies through the closed wire vocabulary — never a shell.
 */

import type {
  ClientMessage,
  ServerMessage,
  PiSurfaceRuntimeWire,
  ThinkingLevel,
} from "../protocol/types.js";
import {
  listPackages,
  listSkills,
  setSkillEnabled,
  type SurfaceDeps,
} from "./surface.js";

/** Minimal reply channel (mirrors `ActionReplySender`). */
export interface ReplySender {
  send(msg: ServerMessage): void;
}

type PiSurfaceMsg = Extract<ClientMessage, { type: "pi_surface" }>;
type SkillInvokeMsg = Extract<ClientMessage, { type: "skill_invoke" }>;
type SkillSetEnabledMsg = Extract<ClientMessage, { type: "skill_set_enabled" }>;
type PackageInstallMsg = Extract<ClientMessage, { type: "package_install" }>;
type PackageRemoveMsg = Extract<ClientMessage, { type: "package_remove" }>;
type PackageUpdateMsg = Extract<ClientMessage, { type: "package_update" }>;

/**
 * Live runtime bits for `pi_surface_ok.runtime`. All optional: when there is
 * no bound session (daemon boot, control channel) the fields degrade to
 * `false`/`null` rather than throwing.
 */
export interface SurfaceRuntime {
  model?: () => { provider: string; id: string } | undefined;
  thinking?: () => ThinkingLevel;
}

function runtimeWire(runtime?: SurfaceRuntime): PiSurfaceRuntimeWire {
  let model: string | null = null;
  let thinking: ThinkingLevel | null = null;
  let running = false;
  try {
    const m = runtime?.model?.();
    if (m) {
      model = `${m.provider}/${m.id}`;
      running = true;
    }
  } catch {
    // stale ctx — leave null (never fabricate).
  }
  try {
    const t = runtime?.thinking?.();
    if (t != null) {
      thinking = t;
      running = true;
    }
  } catch {
    thinking = null;
  }
  return { running, model, thinking };
}

function fail(sender: ReplySender, msg: { id: string }, action: string, err: unknown): void {
  const error = err instanceof Error ? err.message : String(err);
  sender.send({
    type: "action_error",
    in_reply_to: msg.id,
    action: action as never,
    error,
  });
}

/** `pi_surface` — snapshot skills + packages + the live runtime. */
export async function handlePiSurface(
  deps: SurfaceDeps,
  runtime: SurfaceRuntime | undefined,
  sender: ReplySender,
  msg: PiSurfaceMsg,
): Promise<void> {
  try {
    const [skills, packages] = await Promise.all([listSkills(deps), listPackages(deps)]);
    sender.send({
      type: "pi_surface_ok",
      in_reply_to: msg.id,
      runtime: runtimeWire(runtime),
      skills,
      packages,
    });
  } catch (e) {
    fail(sender, msg, "pi_surface", e);
  }
}

/**
 * Dependency for `skill_invoke`: dispatch a user message and report whether
 * the agent accepted it. Injected so tests assert the exact text without a
 * live Pi session.
 */
export type DispatchUserMessageFn = (
  text: string,
  options?: { expandPromptTemplates?: boolean },
) => { ok: boolean; detail?: string };

/**
 * `skill_invoke` — force a skill by handing Pi the `/skill:<name> <args>`
 * command, which Pi expands into the skill body plus the args as a user
 * request (docs/skills.md). The reply only confirms dispatch: the skill's
 * output arrives through the normal chat channels.
 *
 * A name that is not installed is refused with an explicit error — otherwise
 * Pi would pass the literal `/skill:<name>` text through to the model.
 */
export async function handleSkillInvoke(
  deps: SurfaceDeps,
  dispatch: DispatchUserMessageFn,
  sender: ReplySender,
  msg: SkillInvokeMsg,
): Promise<void> {
  const name = msg.name.trim();
  if (!name) {
    fail(sender, msg, "skill_invoke", new Error("skill name is required"));
    return;
  }
  try {
    const skills = await listSkills(deps);
    if (!skills.some((s) => s.name === name)) {
      throw new Error(`skill "${name}" is not installed on this machine`);
    }
  } catch (e) {
    fail(sender, msg, "skill_invoke", e);
    return;
  }
  const args = (msg.args ?? "").trim();
  const text = args ? `/skill:${name} ${args}` : `/skill:${name}`;
  // `expandPromptTemplates` is what makes Pi run `_expandSkillCommand` on this
  // text; without it the literal string reaches the model.
  const result = dispatch(text, { expandPromptTemplates: true });
  if (!result.ok) {
    fail(sender, msg, "skill_invoke", new Error(result.detail ?? "agent rejected the skill invocation"));
    return;
  }
  sender.send({ type: "skill_invoke_ok", in_reply_to: msg.id, name });
}

/** `skill_set_enabled` — persist the enabled/disabled pattern and ack. */
export async function handleSkillSetEnabled(
  deps: SurfaceDeps,
  sender: ReplySender,
  msg: SkillSetEnabledMsg,
): Promise<void> {
  try {
    const skill = await setSkillEnabled(deps, msg.name.trim(), msg.enabled);
    sender.send({
      type: "skill_set_enabled_ok",
      in_reply_to: msg.id,
      name: skill.name,
      enabled: msg.enabled,
    });
  } catch (e) {
    fail(sender, msg, "skill_set_enabled", e);
  }
}

/**
 * `package_install` — third-party code executes on this machine, so the
 * confirmation flag is mandatory. Absent/false is refused before any work.
 */
export async function handlePackageInstall(
  deps: SurfaceDeps,
  sender: ReplySender,
  msg: PackageInstallMsg,
): Promise<void> {
  if (msg.confirm_third_party !== true) {
    fail(
      sender,
      msg,
      "package_install",
      new Error("third-party packages execute code; confirm_third_party must be true"),
    );
    return;
  }
  const source = msg.source.trim();
  if (!source) {
    fail(sender, msg, "package_install", new Error("package source is required"));
    return;
  }
  const local = msg.scope === "project";
  if (local && !deps.settings.isProjectTrusted()) {
    fail(sender, msg, "package_install", new Error("project is not trusted; cannot write project settings"));
    return;
  }
  try {
    await deps.packages.installAndPersist(source, { local });
    sender.send({
      type: "package_op_ok",
      in_reply_to: msg.id,
      op: "install",
      source,
      scope: msg.scope,
    });
  } catch (e) {
    fail(sender, msg, "package_install", e);
  }
}

/** `package_remove` — only affects the settings entry of an installed source. */
export async function handlePackageRemove(
  deps: SurfaceDeps,
  sender: ReplySender,
  msg: PackageRemoveMsg,
): Promise<void> {
  const source = msg.source.trim();
  if (!source) {
    fail(sender, msg, "package_remove", new Error("package source is required"));
    return;
  }
  const local = msg.scope === "project";
  try {
    const removed = await deps.packages.removeAndPersist(source, { local });
    if (!removed) {
      fail(sender, msg, "package_remove", new Error(`package "${source}" is not configured`));
      return;
    }
    sender.send({
      type: "package_op_ok",
      in_reply_to: msg.id,
      op: "remove",
      source,
      scope: msg.scope ?? null,
    });
  } catch (e) {
    fail(sender, msg, "package_remove", e);
  }
}

/** `package_update` — reconcile one source, or every installed package. */
export async function handlePackageUpdate(
  deps: SurfaceDeps,
  sender: ReplySender,
  msg: PackageUpdateMsg,
): Promise<void> {
  const source = msg.source?.trim();
  try {
    await deps.packages.update(source || undefined);
    sender.send({
      type: "package_op_ok",
      in_reply_to: msg.id,
      op: "update",
      source: source ?? "",
      scope: null,
    });
  } catch (e) {
    fail(sender, msg, "package_update", e);
  }
}
