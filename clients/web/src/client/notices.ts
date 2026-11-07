/**
 * Fixed, client-authored text for the Remote Pi web client.
 *
 * Every sentence the connect view can render lives here, together with the
 * pure helpers that choose between them. Nothing from the wire is ever
 * interpolated: a refusal is reported by KIND, never by echoing a payload.
 *
 * Pure module — no React, no hooks, no state. Extracted from
 * `connect-client.tsx` so the container is left owning wiring only.
 */

import type { SkillOption } from "@/components/remote-pi/chat";
import type {
  ChatItemStatus,
} from "@/components/remote-pi/chat";
import { AdapterStateError } from "@/lib/remote-pi/adapter";
import { PairRejectedError } from "@/lib/remote-pi/protocol";
import type { ChatTurn } from "@/lib/remote-pi/chat";
import type { WireSessionInfo } from "@/lib/remote-pi/protocol";
import { sessionActionErrorText } from "@/lib/remote-pi/sessions";
import type { ConnectionPhase } from "@/lib/remote-pi/state";

/** Device label the host sees in `pair_request`. */
export const DEVICE_NAME =
  "Remote Pi Web";

/**
 * How long a submitted turn may stay unanswered before the UI calls it lost.
 *
 * 30 s was far too aggressive for a coding agent: real work (reading files,
 * running a build, following a skill) routinely takes minutes, so the transcript
 * declared "did not finish in time" while the host was still working. That
 * message is not just noise — it invites a Retry that would run the task TWICE.
 *
 * Ten minutes is still a bound, not an eternity: a genuinely dead connection is
 * caught by the transport layer long before this fires.
 */
export const CHAT_TIMEOUT_MS = 600_000;

/** A `session_switch` is a process restart, not a model turn: seconds, not
 *  minutes. Bounded so a lost reply surfaces instead of hanging forever. */
export const SWITCH_TIMEOUT_MS = 45_000;

/**
 * How long to wait before the first re-list after a switch.
 *
 * `session_switch_ok` is sent and then the daemon child exits ~150ms later to
 * respawn its Pi pointed at the target (see `EXIT_DAEMON_SWITCH_SESSION`). Firing
 * the re-list immediately therefore guarantees the request arrives at a process
 * that is already gone: no reply is ever produced, the in-flight guard holds it
 * for the whole list timeout, and every retry in between is swallowed — which is
 * what made the LIVE badge take ~16s.
 *
 * A short grace lets the obsolete process leave and the new one bind, so the first
 * request has a chance of being answered. It is deliberately small: the retries
 * still cover a slower respawn, this only avoids a knowingly-wasted first try.
 */
export const SWITCH_RESPAWN_GRACE_MS = 600;

/**
 * How many extra times a timed-out `session_list` retries itself before the
 * panel admits defeat.
 *
 * A host respawn takes ~15s on this machine (SDK import alone is 2.4s cold), and
 * during that window the host answers nothing. With a 2.5s list timeout that is
 * roughly six attempts, so this budget covers a full respawn with margin. The
 * point is that the user no longer has to press refresh repeatedly to outlast a
 * restart that the client can wait out by itself.
 */
export const SESSIONS_RETRY_BUDGET = 8;

/**
 * How many times to re-ask when the TRANSPORT itself is not connected yet.
 *
 * A separate budget from `SESSIONS_RETRY_BUDGET` because these retries never
 * reach the host: nothing is sent, so no host budget is spent. Keeping them
 * unbounded was a real hang — every retry that landed while the transport was
 * still down re-armed another 800ms timer, forever, with the panel showing
 * "Asking the host for this workspace's sessions…" and the Refresh control
 * disabled by the very `busy` flag it would have cleared.
 *
 * 30 x 800ms = 24s, which comfortably covers a relay reconnect (the normal
 * reason the transport is briefly down) and then gives up honestly instead of
 * pretending a request is outstanding when none was ever sent.
 */
export const SESSIONS_NOT_READY_BUDGET = 30;

/**
 * How long a switch waits for the panel to re-list.
 *
 * A switch makes the host respawn its Pi pointed at the target session, so the
 * listing is unavailable for a moment. Retrying is the only way the new LIVE
 * badge can appear without the user reloading or pressing Refresh.
 *
 * The window MUST outlast a real respawn. It was 40 attempts x 800ms = 32s,
 * which a loaded machine exceeded: the composer appeared at 45s and every retry
 * had already been abandoned, leaving the transcript permanently empty even
 * though the resume itself had succeeded. 2 minutes spans a slow respawn plus a
 * relay reconnect and still stops well short of being a background poll.
 */
export const SESSIONS_RELIST_MS = 800;
export const SESSIONS_RELIST_ATTEMPTS = 150;

/**
 * How long the host may stay silent before the UI calls it stalled.
 *
 * The relay sends a keepalive every ~25s, so a healthy-but-idle session always
 * shows inbound traffic well inside this. 75s is three missed keepalives: past
 * any plausible scheduling hiccup, and short enough that the user learns what is
 * wrong instead of concluding the app is broken.
 */
export const HOST_STALE_MS = 75_000;

/**
 * A session LIST reads the workspace's session files (measured 150ms for 11
 * sessions) and crosses the relay (measured ~0.5s end to end).
 *
 * It used to be 10s, and that single number was the reason a resume took ~16s to
 * show its LIVE badge: `session_switch_ok` fires `relistAfterSwitch`, whose very
 * first request lands while the host is exiting to respawn its Pi. That request
 * is never answered, so `sessionsReqRef` stayed set for the whole timeout and
 * every retry in between was silently swallowed by the in-flight guard. One
 * wasted 10s window, then a real answer.
 *
 * 2.5s keeps a generous margin over the real cost while cutting the wasted window
 * by 4x. A genuinely slow list still resolves; the difference is that a LOST one
 * no longer costs a fifth of a minute.
 */
export const SESSIONS_LIST_TIMEOUT_MS = 2_500;

/**
 * The hard ceiling on how long the panel may say "Asking…" before admitting it
 * does not know.
 *
 * This is NOT a tuning value, it is a correctness bound: `busy` gates both the
 * panel's message and the Refresh button, so leaving it true with no timer makes
 * the whole Sessions surface inert and the user cannot even retry. It must
 * exceed every legitimate wait that legitimately keeps busy true:
 *
 *   SESSIONS_LIST_TIMEOUT_MS 2.5s + a full respawn (SESSIONS_RELIST_ATTEMPTS x
 *   SESSIONS_RELIST_MS = 120s), with margin.
 *
 * A watchdog that fires too early is worse than none: it would report a failure
 * over a host that was about to answer. The value is therefore generous, and it
 * exists only to catch the paths that have no timeout at all.
 */
export const SESSIONS_STUCK_MS = 150_000;

/**
 * How long a `session_new` may stay unanswered.
 *
 * Shorter than a list or a switch because creating a session does NOT respawn
 * anything: the host writes the file and answers. There is no legitimate window
 * where it may go silent for long, so this surfaces the failure quickly instead
 * of leaving the Sessions panel locked (its Refresh button is disabled while
 * busy) for the full watchdog interval.
 */
export const SESSION_NEW_TIMEOUT_MS = 10_000;

/* Fixed, client-authored chat notice text: a settled turn is reported by KIND
   and never by echoing a wire payload. The reducer's code decides WHICH fixed
   sentence is used — raw errors are never rendered, so a host `provider_error`
   (whose wire `message` carries raw provider text) is reported through the
   SAME generic failure sentence as any other failed turn. The retry WARNING that
   sits next to the panel's Retry button is owned by the panel itself, which is
   the only place that button is drawn. */
export const CHAT_NOTICE_REJECTED =
  "主机拒绝了这轮对话，其他内容未改动。";
export const CHAT_NOTICE_FAILED =
  "这轮对话未完成，其他内容未改动。";
export const CHAT_NOTICE_TIMED_OUT =
  "这轮对话超时，主机端可能仍在处理。";
export const CHAT_NOTICE_DISCONNECTED =
  "这轮对话尚未完成，连接已断开。";

/* Fixed, client-authored failure text. Nothing from the wire, no exception
   content: a refusal is reported by KIND, never by echoing a payload. */
export const PAIR_CODE_INVALID =
  "无法读取该配对码。";
export const PAIR_UNAVAILABLE =
  "此页面已无法配对，刷新后重试。";
export const PAIR_FAILED =
  "无法连接主机。检查中继地址和配对码。";
export const RELAY_REQUIRED =
  "输入中继地址（或使用带 &r=… 的配对码）";
export const FS_FAILED =
  "无法列出该目录。";
/* Plan/77 — the plan viewer.
 *
 * Fixed, client-authored strings ONLY. A refusal from the host carries a typed
 * code (`not_allowed`, `not_found`, ...) but never text we would show: echoing
 * host prose into the UI would leak absolute paths and host detail, and would
 * make the wording depend on a remote machine. */
export const PLAN_READ_FAILED =
  "无法读取该文档。";
export const PLAN_REFUSED =
  "主机拒绝读取该文件。只有 plan/、.workflow/ 或 docs/ 下的文档可读。";
export const PLAN_TRUNCATED =
  "文档超过读取上限，仅显示开头部分。";
export const START_FAILED =
  "主机未能启动该工作区。";
export const WORKSPACES_FAILED =
  "无法读取主机目录。";
export const RESTART_FAILED =
  "主机未能重启该工作区。";
export const STOP_FAILED =
  "主机未能停止该工作区。";
export const REMOVE_FAILED =
  "主机未能从目录中移除该目录。";
export const ADD_FAILED =
  "主机未能将该目录加入目录。";
export const FS_NAV_UNAVAILABLE =
  "该主机未提供 fs_nav 能力，因此 Web 端没有目录列表。";
export const SEND_FAILED =
  "无法发送该消息。";
export const RELAY_NOTICE =
  "中继连接报告了异常帧。";
/** The transport's diagnostic codes are a FIXED, closed vocabulary — they never
 *  carry frame content, host text or keys (see `TRANSPORT_DIAGNOSTIC_CODES`).
 *  Naming the code is therefore safe, and it is the difference between a
 *  useless "something went wrong" and a report the user can act on: a stray
 *  frame from another room is benign noise, a `late_reply` means our own
 *  request was orphaned, and `malformed_ct` means the frame was corrupt. */
export function relayNotice(code: string): string {
  return `${RELAY_NOTICE} (${code})`;
}
/* `reauth_required` means the stored credential was refused: the ONLY way out
   is a fresh pairing, so the launcher prompt names that action explicitly
   instead of reusing the generic rejection text. */
export const REAUTH_REQUIRED =
  "该配对已过期或失效，请输入新的配对码。";
/* A storage deletion that FAILED must stay visible in the launcher: it is a
   snapshot STATE warning, not a per-action failure, so it may not be shadowed
   by whichever prompt the phase owns. Both sentences are fixed and
   client-authored. */
export const STORAGE_WARNING =
  "无法删除已保存的会话，它可能仍在本设备上配对。";

/* Fixed, client-authored model-surface text. The host's own `action_error`
   string is never rendered: a refusal is reported by KIND, with a fixed
   sentence, exactly like the workspace actions. */
export const MODELS_FAILED =
  "无法读取该工作区的模型。";
export const MODEL_SET_FAILED =
  "主机未能切换模型。";
export const THINKING_SET_FAILED =
  "主机未能更改思考级别。";
export const MODEL_NOT_CONNECTED =
  "先连接主机并选择运行中的工作区。";
/** Fixed skill notices — never host text. */
export const SKILLS_FAILED =
  "无法读取该工作区的技能。";
export const SKILL_FAILED =
  "主机未能运行该技能。";

/**
 * A package mutation (install / remove / update) was refused or failed.
 *
 * Deliberately NOT `SKILL_FAILED`: telling someone who tried to install a plugin
 * that "the host did not run that skill" describes a different operation and
 * leaves them unsure whether the plugin changed. The host's raw error is never
 * shown — it can carry absolute paths and npm output — so this sentence says what
 * happened and implies the safe next step (retry).
 */
export const PACKAGE_FAILED =
  "主机未完成该插件操作。未作任何更改，请重试。";

/**
 * Every plugin change needs a restart to take effect.
 *
 * The Pi process loads extensions, skills, prompts and themes ONCE, at startup.
 * Writing settings afterwards changes what the NEXT Pi will load, not what the
 * running one already loaded. Saying so is not a hedge — without it the user
 * installs a plugin, sees nothing happen, and concludes the install failed.
 *
 * Deliberately names the restart rather than offering to perform it: restarting
 * kills the live session and any turn in progress, which is the user's call, not
 * a side effect of pressing Install.
 */
/**
 * Automations — the mutation failed.
 *
 * Deliberately NOT reusing PACKAGE_FAILED: a plugin failure and a schedule
 * failure are different repairs ("reinstall the package" vs "fix the cron
 * expression"), and one shared sentence would send the user to the wrong place.
 */
export const SCHEDULE_FAILED =
  "主机未能完成该自动化更改。";

/**
 * Automations — there is no workspace to run the task in.
 *
 * A schedule is bound to one workspace; without one the host has nowhere to
 * deliver the prompt, and creating the row anyway would produce a task that
 * silently never runs.
 */
export const SCHEDULE_NO_WORKSPACE =
  "请先为该自动化选择一个工作区。";

export const PACKAGE_RESTART_REQUIRED =
  "重启该工作区的 Pi 后更改才会生效。";

/**
 * Plugins need a RUNNING workspace.
 *
 * Not `MODELS_FOR_LIVE_WORKSPACE` ("List the workspace's models…") — that is the
 * model picker's sentence and reads as nonsense in the Plugins panel.
 */
export const PACKAGE_OP_TIMEOUT_MS = 45_000;

export const PLUGINS_FOR_LIVE_WORKSPACE =
  "启动该工作区后即可查看和管理其插件。";

/**
 * A refused `session_new`. The host answers with the generic `action_error`,
 * whose `error` text is diagnostic detail and is never shown; this sentence
 * says what the user can do. The two real causes are a Pi without a
 * command-capable context and an extension hook vetoing the new session.
 */
export const SESSION_NEW_FAILED =
  "无法在该工作区新建会话。";
export const EMPTY_SKILLS: readonly SkillOption[] = [];
export const EMPTY_SESSIONS: readonly WireSessionInfo[] = [];
/* Stable empty lists for the Plugins dock. Re-creating an `[]` per render would
   defeat the memo boundaries the transcript relies on. */
export const EMPTY_PACKAGES: readonly {
  source: string;
  scope: "user" | "project";
  resources: readonly string[];
  readme: string | null;
  readmePath: string | null;
  readmeTruncated: boolean;
  enabled: boolean | null;
}[] = [];
export const EMPTY_PLUGIN_SKILLS: readonly { name: string; description: string; source: "user" | "project" | "package"; enabled: boolean | null }[] = [];
/** A model the Pi acknowledged via `action_ok` — never optimistic. */
export interface ConfirmedModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}
export const MODELS_FOR_LIVE_WORKSPACE =
  "列出该工作区的模型；工作区须正在运行。";
/** The composer's own reason for a workspace that is not running. DISTINCT from
 *  the model/session sentences: those instruct a LISTING action, while this one
 *  explains why a message cannot be SENT. Sending into a stopped workspace used
 *  to be allowed, and it wedged the turn forever in `awaiting_echo` because no
 *  Pi process was left to answer. */
export const COMPOSER_WORKSPACE_NOT_RUNNING =
  "该工作区未运行 — 请先启动再发送消息。";
/** Session-list reasons. Sessions are NOT models — reusing the models sentence here
 *  told the user to "list the workspace's models" inside the Sessions panel, which
 *  is simply the wrong instruction for that surface. */
export const SESSIONS_FOR_LIVE_WORKSPACE =
  "列出该工作区的会话；工作区须正在运行。";
/** Fixed session notices — never host text. Sourced from the pure helper so the
 *  refusal path and the never-left-the-client path cannot drift apart. */
export const SESSIONS_FAILED = sessionActionErrorText("session_list")!;
export const SESSION_READ_FAILED = sessionActionErrorText("session_read")!;
/** Fixed sentence for a `session_switch` that never left the client. */
export const SWITCH_FAILED = sessionActionErrorText("session_switch")!;
/** Attachment control reasons (fixed, client-authored). */
export const ATTACH_MODEL_REQUIRED =
  "先选择模型 — 是否支持图片取决于当前模型。";
export const ATTACH_VISION_REQUIRED =
  "所选模型不支持图片。请选择视觉模型后再添加。";

/** A reply that belongs to an older connection/action is NOT a user-facing
 *  failure: it must never become a UI error. */
export function isSuperseded(err: unknown): boolean {
  return err instanceof AdapterStateError && err.code === "superseded";
}

export function pairFailureText(err: unknown): string {
  if (err instanceof PairRejectedError) return PAIR_CODE_INVALID;
  if (err instanceof AdapterStateError) return PAIR_UNAVAILABLE;
  return PAIR_FAILED;
}

/** Minimal, text-free status for the panel: a settled turn that did not
 *  complete must not keep drawing as a live stream. No error code, no wire
 *  string, and no retry risk is exposed here. */
export function chatItemStatus(phase: ChatTurn["phase"]): ChatItemStatus {
  switch (phase) {
    case "completed":
      return "complete";
    /* Stopped by the user: its own status, because reporting a deliberate cancel
       as a failure would blame the user for using the control. */
    case "cancelled":
      return "cancelled";
    case "error":
    case "timed_out":
    case "disconnected":
      return "failed";
    default:
      return "streaming";
  }
}

/** Fixed notice sentence for the room's latest SETTLED turn, or null when
 *  there is nothing to report. `action_rejected` gets the safe generic text;
 *  `provider_error` (a failed provider turn) and every other error code get
 *  the same generic failure text — a payload is never echoed. */
export function chatNoticeForTurn(turn: ChatTurn | null): string | null {
  if (turn === null) return null;
  switch (turn.phase) {
    case "error":
      return turn.error === "action_rejected" ? CHAT_NOTICE_REJECTED : CHAT_NOTICE_FAILED;
    case "timed_out":
      return CHAT_NOTICE_TIMED_OUT;
    case "disconnected":
      return CHAT_NOTICE_DISCONNECTED;
    default:
      return null;
  }
}

/** Busy label for the phases that are actually in flight. */
export function phaseBusyLabel(phase: ConnectionPhase): string | null {
  switch (phase) {
    case "relay_authenticating":
      return "connecting…";
    case "pairing":
      return "pairing…";
    case "host_authenticating":
      return "reading host…";
    case "reconnecting":
      return "reconnecting…";
    default:
      return null;
  }
}

/* ── Changes (plan/78) ───────────────────────────────────────────────────────
 *
 * Every sentence is authored HERE, never received from the host. The host sends
 * a closed reason enum and repo-relative paths; git's stderr, absolute paths and
 * exception text never reach the screen. That rule is what makes it safe to show
 * a worktree at all — a `fatal: not a git repository (or any of the parent
 * directories): .git` banner would be both useless and a layout leak.
 */

/** Why the panel could not read the worktree, in the user's terms.
 *
 * `not_a_repo` is not an error state in the usual sense: plenty of legitimate
 * workspaces are not git repos (the acceptance workspace `4.1f` is one), so this
 * sentence must read as a fact about the folder rather than a failure. It is kept
 * distinct from "nothing changed", because a clean repo and a non-repo are
 * completely different answers and conflating them would make the panel lie. */
export const CHANGES_UNAVAILABLE: Record<string, string> = {
  not_a_repo: "该工作区不是 git 仓库，所以没有工作树变更可显示。",
  git_missing: "这台主机没有安装 git，无法报告工作树变更。",
  timeout: "读取工作树太久了。请重试，或检查仓库是不是太大。",
  /* NOT `git_missing`: the folder is gone, not the tool. Telling the user to
   * install git would be advice for the wrong problem. */
  workspace_missing: "该工作区的目录已经不可达 —— 可能被移动、删除，或所在磁盘已断开。",
  /* NOT `not_a_repo`: the repository is there. */
  unreadable: "这个仓库存在但读不到 —— 请检查权限，或 git 是否信任该目录的所有者。",
};

/** The panel is asking. */
export const CHANGES_READING =
  "正在读取工作树…";

/** Never left the client (no adapter, or a thrown transport error). */
export const CHANGES_FAILED =
  "无法读取该工作区的工作树。";

/* ── Plan/79 — Settings (the host's own models.json) ───────────────────────────
 *
 * Every sentence is authored here. The host reports a closed reason code and
 * nothing else, so no errno, stack or absolute path can reach the screen.
 */

/** A `models_describe` that never produced a usable answer. */
export const SETTINGS_UNREADABLE =
  "无法读取该主机的模型配置。";

export const SETTINGS_SAVED =
  "已保存到该主机的 models.json。";

/** The host does not advertise the `models_config` capability. */
export const SETTINGS_UNAVAILABLE =
  "该主机未向此客户端提供模型配置界面。";

/** The host does not advertise the `settings` capability (plan/80). */
export const SETTINGS_SURFACE_UNAVAILABLE =
  "该主机未向此客户端提供设置界面。";

/**
 * Maps the host's closed reason set to a sentence.
 *
 * `conflict` is singled out because it is the one failure with a user action
 * attached: someone (or another process) changed the file between load and save,
 * and the correct response is to reload rather than to retry. The host refuses the
 * write in that case, so the newer content is never overwritten.
 */
export const SETTINGS_ERROR: Record<string, string> = {
  not_found: "This host has no model configuration file to edit.",
  corrupted:
    "This host's model configuration cannot be parsed, so it cannot be edited here.",
  permission:
    "This host refused the write. The configuration file is not writable by the daemon.",
  conflict:
    "This host's configuration changed since this panel loaded it. Reload to see the current contents, then edit again.",
  invalid:
    "The host rejected these values. Check the model ids, token limits and base URL.",
  verify_failed:
    "The host wrote the file but could not load it back, so the previous contents were restored.",
  unsupported:
    "This host's configuration is not in a form this panel can edit.",
};

/** Caps the row count so a huge repo cannot flood the dock. */
export const CHANGES_ROW_CAP = 200;
