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
export const DEVICE_NAME = "Remote Pi Web";

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

/* Fixed, client-authored chat notice text: a settled turn is reported by KIND
   and never by echoing a wire payload. The reducer's code decides WHICH fixed
   sentence is used — raw errors are never rendered, so a host `provider_error`
   (whose wire `message` carries raw provider text) is reported through the
   SAME generic failure sentence as any other failed turn. The retry WARNING that
   sits next to the panel's Retry button is owned by the panel itself, which is
   the only place that button is drawn. */
export const CHAT_NOTICE_REJECTED = "The host rejected that turn. Nothing else was changed.";
export const CHAT_NOTICE_FAILED = "That turn did not finish. Nothing else was changed.";
export const CHAT_NOTICE_TIMED_OUT =
  "That turn did not finish in time. It may still be running on the host.";
export const CHAT_NOTICE_DISCONNECTED = "The connection dropped before that turn finished.";

/* Fixed, client-authored failure text. Nothing from the wire, no exception
   content: a refusal is reported by KIND, never by echoing a payload. */
export const PAIR_CODE_INVALID = "That pairing code could not be read.";
export const PAIR_UNAVAILABLE = "This page can no longer pair; reload it and try again.";
export const PAIR_FAILED = "Could not reach the host. Check the relay address and the code.";
export const RELAY_REQUIRED = "enter the relay address (or use a code carrying &r=…)";
export const FS_FAILED = "Could not list that directory.";
export const START_FAILED = "The host did not start that workspace.";
export const WORKSPACES_FAILED = "Could not read the host catalog.";
export const RESTART_FAILED = "The host did not restart that workspace.";
export const ADD_FAILED = "The host did not add that directory to the catalog.";
export const FS_NAV_UNAVAILABLE =
  "This host did not advertise the fs_nav capability, so the web client has no directory listing.";
export const SEND_FAILED = "Could not send that message.";
export const RELAY_NOTICE = "The relay connection reported an unexpected frame.";
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
  "This pairing has expired or is no longer valid. Enter a new pairing code.";
/* A storage deletion that FAILED must stay visible in the launcher: it is a
   snapshot STATE warning, not a per-action failure, so it may not be shadowed
   by whichever prompt the phase owns. Both sentences are fixed and
   client-authored. */
export const STORAGE_WARNING =
  "Could not delete the saved session. It may still be paired on this device.";

/* Fixed, client-authored model-surface text. The host's own `action_error`
   string is never rendered: a refusal is reported by KIND, with a fixed
   sentence, exactly like the workspace actions. */
export const MODELS_FAILED = "Could not read this workspace's models.";
export const MODEL_SET_FAILED = "The host did not switch the model.";
export const THINKING_SET_FAILED = "The host did not change the thinking level.";
export const MODEL_NOT_CONNECTED = "Connect to a host and pick a running workspace first.";
/** Fixed skill notices — never host text. */
export const SKILLS_FAILED = "Could not read this workspace's skills.";
export const SKILL_FAILED = "The host did not run that skill.";

/**
 * A refused `session_new`. The host answers with the generic `action_error`,
 * whose `error` text is diagnostic detail and is never shown; this sentence
 * says what the user can do. The two real causes are a Pi without a
 * command-capable context and an extension hook vetoing the new session.
 */
export const SESSION_NEW_FAILED = "Could not start a new session in this workspace.";
export const EMPTY_SKILLS: readonly SkillOption[] = [];
export const EMPTY_SESSIONS: readonly WireSessionInfo[] = [];
/** A model the Pi acknowledged via `action_ok` — never optimistic. */
export interface ConfirmedModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}
export const MODELS_FOR_LIVE_WORKSPACE = "List the workspace's models; it must be running.";
/** Session-list reasons. Sessions are NOT models — reusing the models sentence here
 *  told the user to "list the workspace's models" inside the Sessions panel, which
 *  is simply the wrong instruction for that surface. */
export const SESSIONS_FOR_LIVE_WORKSPACE = "List this workspace's sessions; it must be running.";
/** Fixed session notices — never host text. Sourced from the pure helper so the
 *  refusal path and the never-left-the-client path cannot drift apart. */
export const SESSIONS_FAILED = sessionActionErrorText("session_list")!;
export const SESSION_READ_FAILED = sessionActionErrorText("session_read")!;
/** Fixed sentence for a `session_switch` that never left the client. */
export const SWITCH_FAILED = sessionActionErrorText("session_switch")!;
/** Attachment control reasons (fixed, client-authored). */
export const ATTACH_MODEL_REQUIRED =
  "Select a model first — image support depends on the active model.";
export const ATTACH_VISION_REQUIRED =
  "The selected model does not accept images. Pick a vision model to attach one.";

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
