export type PairErrorCode =
  | "token_expired"
  | "token_consumed"
  | "token_unknown"
  | "internal_error";

export type StreamingBehavior = "steer";

export type QueuedMessageItem = {
  id: string;
  text: string;
  editable: boolean;
  created_at: number;
};

// ── Plan/57 — extension_ui_request bridge (mirror SDK RPC contract) ───────
// The paired app renders interactive extension prompts (ask_user today, via
// @eko24ive/pi-ask) natively instead of stranding the mobile user. The wire
// mirrors the SDK's `pi --mode rpc` extension_ui_request/response contract
// (RpcExtensionUIRequest/Response in dist/modes/rpc/rpc-types.d.ts) so the
// mobile app and the Cockpit share one interactive-UI vocabulary. Casing is
// snake_case to match the rest of the relay protocol (mirror is semantic, not
// literal). pi-ask's richer schema (multi/preview/notes) rides in an optional
// `ask` envelope; strict clients ignore it. Inert when pi-ask is absent.

export type ExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify";

export type AskQuestionWireType = "single" | "multi" | "preview";

export interface AskOptionWire {
  value: string;
  label: string;
  description?: string;
  /** Preview-pane content (preview questions only). */
  preview?: string;
  /** pi-ask addition: option allows freeform custom entry. */
  freeform?: boolean;
}

export interface AskQuestionWire {
  id: string;
  label: string;
  prompt: string;
  type: AskQuestionWireType;
  required: boolean;
  /** pi-ask addition: type actually presented after live toggle / policy. */
  presentedType?: AskQuestionWireType;
  /** pi-ask addition: type originally requested by the model. */
  requestedType?: AskQuestionWireType;
  options: AskOptionWire[];
}

/** Optional pi-ask enrichment on an extension_ui_request — lets the app render
 *  the full flow (multi/preview/notes) instead of the degraded SDK select. A
 *  flow maps to ONE request carrying every question; the app renders a
 *  full-screen modal and submits ONE response with all answers (pi-ask resolves
 *  a flow in a single submit). When `ask` is absent the SDK method/options
 *  drive rendering (future generic prompts). */
export interface AskEnrichmentWire {
  flow_id: string;
  tool_call_id: string | null;
  /** pi-ask RemoteAskSource: "tool" | "answer" | "answer:again" | "ask:replay". */
  source: string;
  title: string | null;
  questions: AskQuestionWire[];
}

/** pi-ask RemoteAskAnswer — one question's answered parts.
 *
 *  CASING EXCEPTION: inside the `ask` envelope the keys mirror pi-ask's own
 *  schema VERBATIM (camelCase: `presentedType`, `requestedType`, `customText`,
 *  `optionNotes`) so the bridge can forward the response to pi-ask's submit
 *  event without a remap pass. The snake_case convention of this protocol
 *  applies at the frame level (`flow_id`, `tool_call_id`, `notify_type`). */
export interface AskAnswerWire {
  values?: string[];
  customText?: string;
  note?: string;
  optionNotes?: Record<string, string>;
}

/** Optional pi-ask enrichment on an extension_ui_response — carries the
 *  structured answer so multi/preview/notes survive the round-trip. */
export type AskResponseEnrichmentWire =
  | {
      flow_id: string;
      kind: "answer";
      mode?: "submit" | "elaborate";
      answers: Record<string, AskAnswerWire>;
    }
  | { flow_id: string; kind: "cancel" };

/** ServerMessage: interactive extension prompt. Mirrors RpcExtensionUIRequest
 *  (select/confirm/input/editor/notify). The `ask` envelope is present when the
 *  prompt originates from a pi-ask flow, carrying the full question schema. */
export type ExtensionUiRequestWire =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notify_type?: "info" | "warning" | "error";
    };

/** ClientMessage: response to an extension_ui_request. Mirrors
 *  RpcExtensionUIResponse (value / confirmed / cancelled). The `ask` envelope
 *  carries pi-ask's structured answer when the app rendered the rich flow. */
export type ExtensionUiResponseWire =
  | {
      type: "extension_ui_response";
      id: string;
      value: string;
      ask?: AskResponseEnrichmentWire;
    }
  | {
      type: "extension_ui_response";
      id: string;
      confirmed: boolean;
      ask?: AskResponseEnrichmentWire;
    }
  | {
      type: "extension_ui_response";
      id: string;
      cancelled: true;
      ask?: AskResponseEnrichmentWire;
    }
  // Rich pi-ask answer: a client that rendered the full flow from the `ask`
  // envelope submits ONLY the envelope — no value/confirmed/cancelled
  // discriminator (the structured `answers` supersede them). This is the
  // shape the app actually sends for rich submits; routing keys off
  // `ask.kind` before any discriminator is read.
  | {
      type: "extension_ui_response";
      id: string;
      ask: AskResponseEnrichmentWire;
    };

export type ClientMessage =
  // Plan/69 — `pair_request` is valid on room `host` too: the supervisor's
  // HostBridge answers it (daemon-side pairing, zero Pi processes running).
  // The Pi-side handler in src/index.ts stays intact for URIs issued by an
  // older Pi. Both paths answer with the same `pair_ok`/`pair_error` below.
  | { type: "pair_request"; id: string; token: string; device_name: string }
  // Plan/30: optional `images` carry inline base64 attachments (one today).
  // Omitted entirely on text-only messages — the no-image path is unchanged.
  | {
      type: "user_message";
      id: string;
      text: string;
      images?: WireImage[];
      streaming_behavior?: StreamingBehavior;
    }
  | { type: "queued_message_set"; id: string; text: string }
  | { type: "queued_message_clear"; id: string; target_id?: string }
  | { type: "approve_tool"; id: string; tool_call_id: string; decision: "allow" | "deny" }
  | { type: "cancel"; id: string; target_id: string }
  | { type: "ping"; id: string }
  // Plan 01 — `before` is an opaque pagination cursor from a previous
  // `session_history.older_cursor`. Omitted → the newest window (today's
  // behaviour), so an older app keeps working unchanged.
  | { type: "session_sync"; id: string; limit?: number; before?: string }
  // Plan/28 — Typed app actions on the paired Pi session. Each carries a
  // structured payload (no string parsing) and gets either `action_ok` or
  // `action_error` back. Visible side-effects (chat output, model change
  // broadcasts, compaction notice) still flow through the normal channels.
  | { type: "session_new"; id: string }
  | { type: "session_compact"; id: string }
  | { type: "model_set"; id: string; provider: string; model_id: string }
  | { type: "thinking_set"; id: string; level: ThinkingLevel }
  | { type: "list_models"; id: string }
  // Plan/67 — list/switch AgentSessions for the current workspace cwd.
  | { type: "session_list"; id: string }
  | { type: "session_switch"; id: string; session_id: string }
  // Plan 01 — session tree + branching. The version fields are the double
  // fence from the snapshot the app rendered: `base_snapshot_version` guards
  // entry content, `base_branch_version` guards position, and `base_leaf_id`
  // must match the leaf the user was looking at.
  | { type: "tree_get"; id: string }
  | {
      type: "tree_navigate";
      id: string;
      target_entry_id: string;
      base_snapshot_version: string;
      base_branch_version: string;
      base_leaf_id: string | null;
      summarize?: boolean;
    }
  | {
      type: "session_fork";
      id: string;
      target_entry_id: string;
      base_snapshot_version: string;
      base_branch_version: string;
      base_leaf_id: string | null;
    }
  | {
      type: "session_clone";
      id: string;
      base_snapshot_version: string;
      base_branch_version: string;
      base_leaf_id: string | null;
    }
  // Plan/67 — host room (`room=host`) control plane on the supervisor.
  | { type: "workspace_list"; id: string }
  | { type: "workspace_start"; id: string; cwd?: string; daemon_id?: string }
  | { type: "workspace_stop"; id: string; cwd?: string; daemon_id?: string }
  // Plan/69 — host-first connection: the client anchors on room `host` only.
  // `host_hello` is sent on boot/reconnect; the host answers with real
  // version/hostname (never fabricated).
  | { type: "host_hello"; id: string }
  // Plan/69 — proxy (spike decision B): the client cannot hold room `host` +
  // workspace rooms on one connection, so it forwards a child-addressed
  // ClientMessage through the host. `ct` is base64 of the inner ClientMessage.
  | { type: "host_forward"; id: string; room: string; ct: string }
  // Plan/69 — restart a workspace by cwd. Idempotent: an already-running
  // workspace answers `workspace_restart_ok` without respawning.
  | { type: "workspace_restart"; id: string; cwd: string }
  // Plan/68 — host filesystem navigation + explicit workspace catalog. The host
  // resolves every path; the client never receives local-path access.
  | { type: "fs_list"; id: string; path: string; show_hidden?: boolean }
  | { type: "workspace_add"; id: string; path: string }
  | { type: "workspace_remove"; id: string; path: string }
  // Plan/68 — Pi surface: what this Pi has installed (skills + packages) and
  // the three closed-vocabulary management actions. No free shell on the wire.
  | { type: "pi_surface"; id: string }
  // `skill_invoke` forces a skill: the handler appends `args` as a user request
  // and dispatches `/skill:<name> <args>` through Pi's own expansion.
  | { type: "skill_invoke"; id: string; name: string; args?: string }
  | { type: "skill_set_enabled"; id: string; name: string; enabled: boolean }
  // `confirm_third_party` is mandatory-true: packages execute extension code.
  | {
      type: "package_install";
      id: string;
      source: string;
      scope: "user" | "project";
      confirm_third_party?: boolean;
    }
  | { type: "package_remove"; id: string; source: string; scope?: "user" | "project" }
  | { type: "package_update"; id: string; source?: string }
  // Plan/57 — interactive extension prompt response (ask_user via pi-ask).
  // Mirrors RpcExtensionUIResponse; the optional `ask` envelope carries
  // pi-ask's structured answer so multi/preview/notes survive the round-trip.
  | ExtensionUiResponseWire;

/**
 * Plan/30 — one inline image attachment on a `user_message`. Mirrors the
 * SDK's `ImageContent` ({@link https }) split across the wire: `data` is the
 * base64-encoded (compressed) image bytes, `mime` its content type
 * (e.g. `"image/jpeg"`). The Pi maps `{ data, mime }` → the SDK's
 * `{ type:"image", data, mimeType }` before handing it to the model.
 */
export interface WireImage {
  /** Base64-encoded image bytes (compressed app-side). */
  data: string;
  /** MIME type, e.g. `"image/jpeg"`. Maps to the SDK's `mimeType`. */
  mime: string;
}

export type Usage = { input_tokens: number; output_tokens: number };

export type KnownErrorCode =
  | "tool_approval_required"
  | "invalid_message"
  | "unsupported_type"
  | "too_large"
  | "rate_limited"
  | "timeout"
  | "internal_error";

// aberto para forward-compat — receivers toleram codes desconhecidos
export type ErrorCode = KnownErrorCode | (string & {});

export type SessionHistoryEvent =
  // Plan/30: `images` replayed in history so a re-sync rebuilds the image
  // bubble (the bytes live in `_messageBuffer`). Omitted on text-only inputs.
  | { ts: number; type: "user_input"; id: string; text: string; images?: WireImage[] }
  | {
      ts: number;
      type: "tool_request";
      tool_call_id: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      ts: number;
      type: "tool_result";
      tool_call_id: string;
      result?: unknown;
      error?: string;
    }
  | {
      ts: number;
      type: "agent_message";
      in_reply_to: string;
      text: string;
      usage?: Usage;
    }
  // Plan/32: a context-compaction marker, replayed in history (survives
  // re-sync like images) so the app re-renders the "context compacted" notice.
  | { ts: number; type: "compaction"; summary: string; tokens_before: number };

export type ServerMessage =
  | {
      type: "pair_ok";
      in_reply_to: string;
      session_name: string;
      session_started_at: number;
      room_id: string;
      /**
       * Plan/27 Wave A: identifies the host coding agent driving this
       * pi-extension instance. `name` is hardcoded to "Pi coding agent"
       * today; future Pi forks (Claude Code, OpenCode) populate their own
       * here. `version` is the pi-extension `package.json` version.
       * Optional in the wire schema so app-side parsing tolerates older
       * Pi builds that predate this field — every new pairing emits both.
       */
      harness?: { name: string; version: string };
      /**
       * Plan/27 Wave A: `os.hostname()` of the machine the Pi runs on.
       * App displays it in the device list so the user can distinguish
       * two paired PCs that happen to share a nickname or sit in the
       * same project folder.
       */
      hostname?: string;
    }
  | { type: "pair_error"; in_reply_to: string; code: PairErrorCode; message: string }
  | { type: "user_input"; id: string; text: string; streaming_behavior?: StreamingBehavior }
  // Echo of an app-originated user_message, broadcast by the Pi to every
  // connected owner (including the sender). Source-of-truth model: each
  // app waits for this echo to render the message it sent, so all owners
  // see the same session timeline regardless of who typed.
  // Field shape mirrors the inbound ClientMessage `user_message` exactly,
  // and `id` is the sender-provided id — Pi never re-generates it (lets
  // future dedup logic use id as a stable key). See plan/24 W2D fix.
  // Plan/30: `images` echoed back so every owner renders the same image bubble.
  | {
      type: "user_message";
      id: string;
      text: string;
      images?: WireImage[];
      streaming_behavior?: StreamingBehavior;
    }
  | { type: "queued_message_state"; id?: string; text?: string; items?: QueuedMessageItem[] }
  | { type: "steer_consumed"; id: string }
  | { type: "agent_chunk"; in_reply_to: string; delta: string }
  | { type: "agent_done"; in_reply_to: string; usage?: Usage }
  | { type: "agent_message"; in_reply_to: string; text: string; usage?: Usage }
  // Plan/32: pushed after a context compaction (live, and replayed on history
  // re-sync). `tokens_before` is the pre-compaction token count.
  | { type: "compaction"; summary: string; tokens_before: number; ts?: number }
  | { type: "tool_request"; tool_call_id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id: string; result?: unknown; error?: string }
  | { type: "error"; in_reply_to?: string; code: ErrorCode; message: string }
  | { type: "cancelled"; in_reply_to: string; target_id: string }
  | { type: "pong"; in_reply_to: string }
  | { type: "bye"; reason: ByeReason }
  | {
      type: "session_history";
      in_reply_to: string;
      session_started_at: number;
      events: SessionHistoryEvent[];
      eos: boolean;
      truncated: boolean;
      // Plan 01 — cursor for the next older page, and whether one exists.
      // Absent when paging is unavailable (memory-buffer fallback), which the
      // app reads as "no older history reachable" rather than as an error.
      older_cursor?: string | null;
      has_older?: boolean;
    }
  // Plan 01 — runtime status snapshot (model / thinking / usage / cost /
  // context occupancy). Published only when the comparable snapshot changes.
  | { type: "runtime_status"; status: RuntimeStatusWire }
  // Plan/28 — Replies for typed app actions.
  // `action_ok` / `action_error` carry the original `ActionName` so the
  // app can demultiplex by action type rather than having to remember
  // every in-flight request id.
  // `models_list` is the response to a `list_models` request; the optional
  // `current` echoes the model the Pi is using right now so the app can
  // highlight the selected row without a second round-trip.
  | { type: "action_ok"; in_reply_to: string; action: ActionName }
  | { type: "action_error"; in_reply_to: string; action: ActionName; error: string }
  | { type: "models_list"; in_reply_to: string; models: WireModel[]; current?: WireModel }
  // Plan 01 — tree snapshot reply, plus the outcome of a navigate/fork/clone.
  // Errors reuse `action_error` with the matching `ActionName`, so the app has
  // one demultiplexing path for all typed actions.
  | { type: "tree_snapshot_ok"; in_reply_to: string; snapshot: TreeSnapshotWire }
  | {
      type: "tree_navigate_ok";
      in_reply_to: string;
      leaf_id: string | null;
      snapshot_version: string;
      branch_version: string;
      editor_text?: string;
    }
  | {
      type: "session_fork_ok";
      in_reply_to: string;
      // Text of the forked user prompt, returned for the composer. Never
      // auto-sent: the user decides whether to re-run it.
      editor_text: string;
    }
  | { type: "session_clone_ok"; in_reply_to: string }
  | {
      type: "session_list_ok";
      in_reply_to: string;
      current_id: string | null;
      sessions: WireSessionInfo[];
    }
  | {
      type: "session_switch_ok";
      in_reply_to: string;
      session_id: string;
      session_started_at: number;
    }
  | {
      type: "session_switch_error";
      in_reply_to: string;
      code: SessionSwitchErrorCode;
      message: string;
    }
  | {
      type: "workspace_list_ok";
      in_reply_to: string;
      workspaces: WireWorkspaceInfo[];
    }
  // Plan/68 — directory listing for the workspace picker (host-side listing).
  | {
      type: "fs_list_ok";
      in_reply_to: string;
      path: string;
      parent: string | null;
      entries: WireFsEntry[];
    }
  // Plan/68 — Pi surface snapshot (skills + packages) and its management acks.
  | {
      type: "pi_surface_ok";
      in_reply_to: string;
      runtime: PiSurfaceRuntimeWire;
      skills: PiSurfaceSkillWire[];
      packages: PiSurfacePackageWire[];
    }
  | {
      type: "skill_invoke_ok";
      in_reply_to: string;
      name: string;
    }
  | {
      type: "skill_set_enabled_ok";
      in_reply_to: string;
      name: string;
      enabled: boolean;
    }
  | {
      type: "package_op_ok";
      in_reply_to: string;
      op: PackageOp;
      source: string;
      scope: "user" | "project" | null;
    }
  | {
      type: "workspace_start_ok";
      in_reply_to: string;
      cwd: string;
      room_id: string;
      daemon_id: string;
    }
  | {
      type: "workspace_stop_ok";
      in_reply_to: string;
      cwd: string;
      daemon_id: string;
    }
  // Plan/69 — host-first handshake reply. `daemon` fields are `null` when the
  // host genuinely cannot determine them (never a guessed value).
  | {
      type: "host_hello_ok";
      in_reply_to: string;
      daemon: { version: string | null; hostname: string | null; platform: string | null };
      capabilities: HostCapability[];
    }
  // Plan/69 — lifecycle push (NOT a reply): the host mirrors the supervisor's
  // ChildSlot on every transition. No `in_reply_to` — it is unsolicited.
  | {
      type: "workspace_state";
      cwd: string;
      state: WorkspaceState;
      last_error: string | null;
      restarts: number;
    }
  | { type: "workspace_restart_ok"; in_reply_to: string; cwd: string; daemon_id: string }
  | {
      type: "workspace_restart_error";
      in_reply_to: string;
      code: WorkspaceRestartErrorCode;
      message: string;
    }
  // Plan/69 — proxy (spike decision B): the host re-wraps a child ServerMessage
  // that arrived addressed to the machine's own key. `ct` is base64 of the
  // inner ServerMessage; `room` is the child room it came from, so the client
  // files it per workspace.
  | { type: "host_message"; room: string; ct: string }
  // Plan/57 — interactive extension prompt (ask_user via pi-ask). Mirrors
  // RpcExtensionUIRequest (select/confirm/input/editor/notify); the optional
  // `ask` envelope carries pi-ask's full question so the app renders richly.
  | ExtensionUiRequestWire;

/**
 * Plan/28 — Stable names for the typed actions the app can request. Kept
 * as a closed string union so a switch in either side gets exhaustiveness
 * checking from the compiler.
 */
export type ActionName =
  | "session_new"
  | "session_compact"
  | "model_set"
  | "thinking_set"
  | "session_list"
  | "session_switch"
  | "workspace_list"
  | "workspace_start"
  | "workspace_stop"
  // Plan/68 — filesystem navigation + explicit workspace catalog.
  | "fs_list"
  | "workspace_add"
  | "workspace_remove"
  // Plan/68 — Pi surface (skills + packages).
  | "pi_surface"
  | "skill_invoke"
  | "skill_set_enabled"
  | "package_install"
  | "package_remove"
  | "package_update"
  // Plan 01 — session tree navigation + branching.
  | "tree_get"
  | "tree_navigate"
  | "session_fork"
  | "session_clone";

/** Plan/67 — one row in `session_list_ok`. `id` is the Pi SessionManager id. */
export interface WireSessionInfo {
  id: string;
  name?: string;
  mtime: number;
  preview?: string;
  live: boolean;
  cwd?: string;
}

export type SessionSwitchErrorCode = "locked" | "unknown" | "no_sdk";

/** Plan/67 — reserved relay room_id for the machine-level supervisor. */
export const HOST_ROOM_ID = "host";

/**
 * Plan/69 — lifecycle state of a workspace Pi, mirroring the supervisor's
 * `ChildSlot` (`DaemonState` in daemon/control_protocol.ts — same closed
 * union, declared here so the protocol layer owns its own vocabulary).
 */
export type WorkspaceState = "running" | "starting" | "crashed" | "stopped";

/** Plan/69 — closed error codes for `workspace_restart_error`. */
export type WorkspaceRestartErrorCode = "spawn_failed" | "not_found";

/**
 * Plan/69 — capabilities advertised by `host_hello_ok`. Closed union so the
 * app can switch on them with exhaustiveness checking.
 */
export type HostCapability =
  | "host_pairing"
  | "workspace_state"
  | "host_forward"
  | "fs_nav";

export interface WireWorkspaceInfo {
  cwd: string;
  daemon_id: string;
  room_id: string;
  name: string;
  live: boolean;
  daemon: boolean;
  /**
   * Plan/68 — provenance of the row: `"daemon"` came from `daemons.json`,
   * `"added"` was picked by navigating the host filesystem (or by starting an
   * unregistered cwd) and lives in `workspaces.json`.
   */
  source: "daemon" | "added";
}

/** Plan/68 — one entry in an `fs_list_ok` directory listing. */
export interface WireFsEntry {
  name: string;
  kind: "dir" | "file";
  /** Hint only: the directory contains a `.git` marker. Never recursed. */
  is_repo?: boolean;
}

/**
 * Plan/68 — Pi surface (skills + packages) wire shapes.
 *
 * **Never fabricate.** A field the host cannot determine is `null`, never a
 * guessed value: the app renders "unknown" rather than a plausible lie.
 */
export interface PiSurfaceRuntimeWire {
  /** The paired Pi session is live (the surface was built from a real ctx). */
  running: boolean;
  /** `<provider>/<id>` of the current model, or `null` when undetermined. */
  model: string | null;
  thinking: ThinkingLevel | null;
}

/** Where a discovered skill came from. Mirrors the SDK's `sourceInfo.scope`. */
export type SkillSource = "user" | "project" | "package";

export interface PiSurfaceSkillWire {
  name: string;
  description: string;
  source: SkillSource;
  /** Absolute path to the `SKILL.md` the host discovered. */
  path: string;
  /**
   * Whether the skill is enabled. `false` when an exclusion pattern in the
   * effective `skills` settings matches it (`-<path>`), `null` when the host
   * could not determine it.
   */
  enabled: boolean | null;
  /** `disable-model-invocation: true` — explicit `/skill:<name>` only. */
  disable_model_invocation: boolean;
}

/** A package operation, echoed back on `package_op_ok`. */
export type PackageOp = "install" | "remove" | "update";

export interface PiSurfacePackageWire {
  source: string;
  scope: "user" | "project";
  /**
   * Resource kinds this package declares — the four conventional resource
   * directories Pi discovers (`extensions`, `skills`, `prompts`, `themes`).
   * Empty when the package declares nothing discoverable.
   */
  resources: string[];
}

/**
 * Plan/28 — Mirror of the SDK's `ThinkingLevel` (defined in
 * `@earendil-works/pi-agent-core/types`). Re-declared locally so the wire
 * protocol owns its own enum and we don't leak SDK-internal types onto
 * the app's network surface.
 *
 * Note: `"xhigh"` is only honored by select model families — the SDK uses
 * each `Model.thinkingLevelMap` to decide if the requested level is
 * supported, falling back to a sensible neighbour when not. The app
 * surfaces all 6 buttons but can grey out unsupported ones using the
 * model's metadata if the picker fetches it later.
 */
export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Plan/28 — Wire shape for one model entry in the app's model picker.
 *
 * Subset of the SDK's `Model<Api>` interface — only the fields the app
 * actually renders. Cost / max-tokens / API class are left off the wire
 * deliberately; if the app's picker grows to need them, they get added
 * here and to the handler's mapping in `index.ts` in one diff.
 */
export interface WireModel {
  /** Stable identifier inside the provider's catalog. E.g. `"claude-opus-4-7"`. */
  id: string;
  /** Display name for the picker row. E.g. `"Claude Opus 4.7"`. */
  name: string;
  /** Provider slug. E.g. `"anthropic"`, `"openai"`. */
  provider: string;
  /** Whether the model supports the thinking surface (`reasoning: true`
   *  in the SDK). Useful so the app can decide whether the thinking
   *  segmented control should be enabled when this model is selected. */
  reasoning: boolean;
  /** Context window in tokens, for display in the picker subtitle. */
  context_window: number;
  /** Plan/30: true when the model accepts image input (SDK `Model.input`
   *  includes `"image"`). The app uses it to enable/disable the attach
   *  button — a text-only model greys out image attachments. */
  vision: boolean;
}

export type ByeReason = "peer_stop" | "session_replaced" | "shutdown";

/**
 * Plan 01 — Runtime status snapshot sent to the app.
 *
 * Mirrors the reference implementation's `RuntimeStatus`. snake_case on the
 * wire because every other field in this protocol is snake_case; the
 * collector's camelCase shape is mapped at the boundary.
 */
export interface RuntimeStatusWire {
  model: {
    provider: string;
    id: string;
    name?: string;
    context_window?: number;
    reasoning?: boolean;
  } | null;
  thinking_level: ThinkingLevel | null;
  usage: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cost: {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      total: number;
    };
  };
  context: { tokens: number | null; context_window: number; percent: number | null } | null;
  updated_at: string;
}

/**
 * Plan 01 — One flat session-tree entry for the app's tree picker. `preview` is
 * already bounded by the producer (see `TREE_PREVIEW_LIMIT`).
 */
export interface TreeEntryWire {
  id: string;
  parent_id: string | null;
  type: string;
  role?: string;
  custom_type?: string;
  tool_name?: string;
  title: string;
  preview: string;
  timestamp: string;
  is_current_leaf: boolean;
  is_on_active_branch: boolean;
  is_forkable: boolean;
  navigation_behavior: "edit_prompt" | "navigate";
}

/**
 * Plan 01 — Session-tree snapshot.
 *
 * `snapshot_version` covers entry content; `branch_version` covers the current
 * position. Clients echo both back on navigate/fork/clone so a stale view
 * cannot be acted on.
 */
export interface TreeSnapshotWire {
  snapshot_version: string;
  branch_version: string;
  leaf_id: string | null;
  entries: TreeEntryWire[];
  default_filter: string;
  filters: string[];
}
