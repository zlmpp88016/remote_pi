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
  // Plan/71 — READ one session's transcript without touching the live one.
  // `session_id` must be an id this host reports in `session_list_ok`; the
  // host resolves it to a path itself and NEVER accepts a path from the
  // client (that would be an arbitrary-file-read primitive).
  | { type: "session_read"; id: string; session_id: string; limit?: number; before?: string }
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
  /*
   * Automations — scheduled tasks (plan/39 cron, projected for the web).
   *
   * `schedule_add` carries the raw cron expression rather than a friendly kind:
   * the expression is what the host stores, and round-tripping through a UI
   * abstraction would let the two drift.
   */
  | { type: "schedule_list"; id: string }
  | {
      type: "schedule_add";
      id: string;
      daemon_id: string;
      schedule: string;
      prompt: string;
      tz?: string | null;
      skip_if_busy?: boolean;
      wake?: boolean;
      catchup?: boolean;
      /** Pin a model for this task; omitted means inherit the session's model. */
      model?: { provider: string; id: string } | null;
      /** Give each fire its own session instead of appending to the live one. */
      fresh_session?: boolean;
    }
  | { type: "schedule_remove"; id: string; job_id: string }
  | { type: "schedule_set_enabled"; id: string; job_id: string; enabled: boolean }
  | { type: "schedule_run_now"; id: string; job_id: string }
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
  // Plan/77 — read ONE allowlisted text file (the web Plan viewer). The host
  // resolves and fences the path; the client never resolves one itself.
  //
  // `root` is the WORKSPACE the read belongs to, and it is part of the fence:
  // the allowlist is measured against it, so a host serving several workspaces
  // cannot be talked into reading one workspace's files on another's behalf.
  // It is required, not defaulted, because a default would silently fall back to
  // the daemon's own cwd — which is not a workspace at all.
  | { type: "fs_read"; id: string; path: string; root: string }
  // Plan/78 — Changes tab. `root` is the workspace the client is looking at;
  // the host runs git against THAT directory, never against its own cwd (which
  // is wherever the supervisor started it, not a workspace), and echoes the
  // daemon id so a stale reply cannot be attributed to a different folder.
  | { type: "changes_snapshot"; id: string; root: string; daemon_id: string }
  // Plan/79 — editing the host's own ~/.pi/agent/models.json.
  //
  // NOTE the absence of a path field. `fs_read` accepts a client path and fences
  // it; here the target is resolved host-side, so there is no parameter that
  // could be pointed at another file. That is a structural fence, not a check.
  | { type: "models_describe"; id: string }
  | { type: "models_mutate"; id: string; ops: ModelsOpWire[]; revision: string }
  // Plan/80 — the host's own ~/.pi/agent/settings.json.
  //
  // Like models_*, no path parameter: the target is resolved host-side. Unlike
  // models_*, this file is MIXED — it holds preferences AND machine state
  // (packages with absolute host paths, extensions, changelog bookkeeping). The
  // host projects a POSITIVE whitelist, so the frame cannot carry the rest.
  | { type: "settings_describe"; id: string }
  | { type: "settings_mutate"; id: string; ops: SettingsOpWire[]; revision: string }
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
  /*
   * Enable/disable a configured package WITHOUT uninstalling it.
   *
   * Distinct from `package_remove` on purpose: remove deletes the code (npm
   * uninstall / git clone removal) and the settings entry, so re-enabling is
   * impossible without a fresh install. Disable keeps the files on disk and only
   * flips the settings entry to its filtered form, so it is reversible offline.
   *
   * The SDK's disable mechanism is the OBJECT form of a package entry: writing
   * `{source, extensions: [], skills: [], prompts: [], themes: []}` makes
   * `applyPackageFilter` mark every resource of every type as disabled
   * ("Empty array explicitly disables all resources of this type"). Enable
   * writes the plain string form back, i.e. load everything.
   */
  | {
      type: "package_set_enabled";
      id: string;
      source: string;
      scope: "user" | "project";
      enabled: boolean;
    }
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

/**
 * Token accounting for one assistant message, mirroring the SDK's `Usage`.
 *
 * The SDK reports `{input, output, cacheRead, cacheWrite, reasoning, totalTokens,
 * cost}` on every assistant message (verified against real session files). Only
 * the first two used to be forwarded, so the cache and reasoning shares were
 * dropped before they could ever be displayed.
 */
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  /** Prompt tokens served from the provider's cache (`cacheRead` in the SDK). */
  cache_read_tokens?: number;
  /** Prompt tokens written INTO the cache (`cacheWrite` in the SDK). */
  cache_write_tokens?: number;
  /** Reasoning tokens, a subset of `output_tokens` on models that report them. */
  reasoning_tokens?: number;
  /** SDK `totalTokens` when the provider reports it. */
  total_tokens?: number;
};

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
       * remote-pi instance. `name` is hardcoded to "Pi coding agent"
       * today; future Pi forks (Claude Code, OpenCode) populate their own
       * here. `version` is the remote-pi `package.json` version.
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
      /**
       * Whether this host can act on the listed sessions.
       *
       * `switchSession` and `newSession` only exist on a command-capable
       * context, which an RPC-mode daemon never captures — so `session_switch`
       * answers `no_sdk` there and `session_new` answers `action_error`. The
       * client cannot infer that from anything else, and a control that fails
       * only after being clicked is worse than one that explains itself, so the
       * host states the capability up front with the listing.
       */
      can_switch: boolean;
      can_new: boolean;
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
  // Plan/71 — reply to `session_read`. Same event vocabulary as
  // `session_history`, so the app renders it with the SAME code path; what
  // changes is that this answers for an arbitrary (non-active) session.
  | {
      type: "session_read_ok";
      in_reply_to: string;
      session_id: string;
      events: SessionHistoryEvent[];
      eos: boolean;
      truncated: boolean;
      older_cursor?: string | null;
      has_older?: boolean;
    }
  | {
      type: "workspace_list_ok";
      in_reply_to: string;
      workspaces: WireWorkspaceInfo[];
    }
  | {
      type: "schedule_list_ok";
      in_reply_to: string;
      tasks: WireScheduleTask[];
      /*
       * daemon id -> display name. Sent alongside the tasks so the panel can
       * name a workspace without resolving it from the catalog; a task whose
       * daemon is absent here falls back to its id rather than to a cwd path.
       */
      workspace_names: Record<string, string>;
    }
  | { type: "schedule_add_ok"; in_reply_to: string; task: WireScheduleTask }
  | { type: "schedule_remove_ok"; in_reply_to: string; job_id: string }
  | {
      type: "schedule_set_enabled_ok";
      in_reply_to: string;
      job_id: string;
      enabled: boolean;
    }
  | {
      type: "schedule_run_now_ok";
      in_reply_to: string;
      job_id: string;
      /*
       * The daemon's own fire outcome, verbatim. A string rather than the closed
       * union because `fireJob` can also answer "missing"; the client shows
       * whatever it got instead of us inventing a member for it.
       */
      result: string;
    }
  // Plan/68 — directory listing for the workspace picker (host-side listing).
  | {
      type: "fs_list_ok";
      in_reply_to: string;
      path: string;
      parent: string | null;
      entries: WireFsEntry[];
    }
  // Plan/77 — one allowlisted text file. `truncated` says the content is the
  // head of a larger file; `bytes` is the REAL size, so the UI can say so.
  | {
      type: "fs_read_ok";
      in_reply_to: string;
      path: string;
      content: string;
      truncated: boolean;
      bytes: number;
    }
  // Plan/78 — Changes snapshot. A failure is its own frame rather than an empty
  // list, because "this is not a git repo" and "your worktree is clean" must
  // never look the same: the workspace used for every acceptance run here is not
  // a repo, so collapsing them would make the panel lie exactly when the user
  // needs the truth. `reason` is a closed enum; the client owns the sentence.
  | {
      type: "changes_snapshot_ok";
      in_reply_to: string;
      snapshot: ChangesSnapshotWire;
    }
  | {
      type: "changes_snapshot_unavailable";
      in_reply_to: string;
      reason: "not_a_repo" | "git_missing" | "timeout" | "workspace_missing" | "unreadable";
    }
  // Plan/79 — models.json describe/mutate. `models_describe_ok` carries the config
  // with every secret field REMOVED and their existence reported separately, so a
  // credential cannot ride this frame no matter what the form asks for.
  | {
      type: "models_describe_ok";
      in_reply_to: string;
      revision: string;
      file: ModelsFileStateWire;
      config: Record<string, unknown>;
      secrets: ModelsSecretsWire;
    }
  | {
      type: "models_mutate_ok";
      in_reply_to: string;
      revision: string;
    }
  | {
      type: "models_error";
      in_reply_to: string;
      reason: ModelsErrorReasonWire;
    }
  // Plan/80 — settings.json. The payload is the whitelist projection; the host
  // never serialises the document.
  | {
      type: "settings_describe_ok";
      in_reply_to: string;
      revision: string;
      file: SettingsFileStateWire;
      appearance: SettingsAppearanceWire;
      behaviour: SettingsBehaviourWire;
    }
  | {
      type: "settings_mutate_ok";
      in_reply_to: string;
      revision: string;
    }
  | {
      type: "settings_error";
      in_reply_to: string;
      reason: SettingsErrorReasonWire;
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
  /*
   * Automations push (NOT a reply) — a scheduled task reached its fire time.
   *
   * Unsolicited like `workspace_state`: there is no `in_reply_to` because no
   * client asked for this occurrence. It exists so the browser learns a fire
   * happened without polling the whole task list on a timer.
   *
   * `result` is the daemon's OWN closed vocabulary, passed through unmapped. The
   * difference between "delivered" and "skipped_busy" is exactly what a user
   * staring at a task that appears not to have run needs to see.
   *
   * `prompt_preview` is truncated host-side (see SCHEDULE_PREVIEW_CHARS): the
   * full prompt already lives in the transcript and in the task row, so the
   * push carries only enough to identify which task fired.
   */
  | {
      type: "schedule_fired";
      job_id: string;
      daemon_id: string;
      result: CronResultWire;
      fired_at: string;
      prompt_preview: string;
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
  | "session_read"
  | "workspace_list"
  | "workspace_start"
  | "workspace_stop"
  // Plan/68 — filesystem navigation + explicit workspace catalog.
  | "fs_list"
  | "fs_read"
  | "workspace_add"
  | "workspace_remove"
  // Plan/78 — git working-tree snapshot for the Changes dock tab.
  | "changes_snapshot"
  | "models_describe"
  | "models_mutate"
  | "settings_describe"
  | "settings_mutate"
  // Plan/68 — Pi surface (skills + packages).
  | "pi_surface"
  | "skill_invoke"
  | "skill_set_enabled"
  | "package_install"
  | "package_remove"
  | "package_set_enabled"
  | "package_update"
  // Automations — scheduled tasks (plan/39 cron projected to the web).
  | "schedule_list"
  | "schedule_add"
  | "schedule_remove"
  | "schedule_set_enabled"
  | "schedule_run_now"
  // Plan 01 — session tree navigation + branching.
  | "tree_get"
  | "tree_navigate"
  | "session_fork"
  | "session_clone";

/** Plan/67 — one row in `session_list_ok`. `id` is the Pi SessionManager id. */
/** One changed path, as the Changes panel renders it (plan/78). */
export interface ChangesEntryWire {
  /** Repo-RELATIVE path with forward slashes. Never absolute: the panel needs
   *  the part that differs between rows, not the host's directory layout. */
  rel: string;
  /** Index status column from `git status --porcelain` (`.MADRCU?!`). Single
   *  character from git's closed vocabulary, not free text. */
  x: string;
  /** Worktree status column, same vocabulary. */
  y: string;
  /** True when git reported a rename; `rel` is the new name. */
  renamed: boolean;
}

/**
 * The Changes snapshot (plan/78).
 *
 * Status only — no file bodies, no diff. Returning a diff would widen a pairing
 * token's grant from "a few allowlisted documents" (plan/77 `fs_read`) to "the
 * content of every file you have edited", which is the hole that fence exists to
 * prevent.
 */
/**
 * One path-addressed edit to the models config (plan/79).
 *
 * `path` addresses the JSON STRUCTURE, never a filesystem path. This is the only
 * way the client can express a change, which is why a key that no op names cannot
 * be touched — the property that makes `replace`-style whole-document writes
 * unsafe here (the client never receives the key, so "absent" and "delete it"
 * would be the same message).
 */
export type ModelsOpWire =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "insert"; path: (string | number)[]; value: unknown }
  | { op: "remove"; path: (string | number)[] }
  | { op: "unset"; path: (string | number)[] };

/** What the host can say about the file, all as booleans — no host text. */
export interface ModelsFileStateWire {
  exists: boolean;
  parseable: boolean;
  writable: boolean;
  /** Owner-only permissions. Plaintext keys live in this file. */
  mode_safe: boolean;
}

/**
 * Existence of a credential, and nothing else.
 *
 * No value, no `sk-…abcd` mask, no length. A mask leaks four credential
 * characters for no decision this panel makes, and a masked value pre-filled into
 * a form is the classic path to writing the mask back as the key. A length would
 * reveal which scheme issued the key.
 */
export type ModelsSecretsWire = Record<string, { has_key: boolean }>;

export interface ModelsDescribeOkWire {
  /** sha256 of the raw file bytes — the optimistic-concurrency fence. */
  revision: string;
  file: ModelsFileStateWire;
  /** Parsed config with every secret field REMOVED (not blanked). */
  config: Record<string, unknown>;
  secrets: ModelsSecretsWire;
}

/** Why a models-config operation failed. Closed set: the client owns the wording,
 *  so no errno, stack or host path can reach the screen. */
export type ModelsErrorReasonWire =
  | "not_found"
  | "corrupted"
  | "permission"
  | "conflict"
  | "invalid"
  | "verify_failed"
  | "unsupported";

/**
 * Plan/80 — settings.json wire types.
 *
 * Every field here is on the host's POSITIVE whitelist. `packages`, `extensions`
 * and `lastChangelogVersion` have no representation at all, so they cannot be
 * expressed in a frame even by mistake.
 */
export type SettingsFieldWire =
  | "theme"
  | "hideThinkingBlock"
  | "retry.enabled"
  | "retry.maxRetries"
  | "retry.baseDelayMs"
  | "retry.provider.maxRetryDelayMs";

export type SettingsOpWire =
  | { op: "set"; path: SettingsFieldWire | string[]; value: unknown }
  | { op: "unset"; path: SettingsFieldWire | string[] };

export interface SettingsFileStateWire {
  exists: boolean;
  parseable: boolean;
  writable: boolean;
}

/** `theme` is reported for DISPLAY only: it selects a pi TUI theme and this panel
 *  does not offer to change it. The web client's visual presets are a separate,
 *  browser-local concept and never write this value. */
export interface SettingsAppearanceWire {
  theme: string | null;
  hide_thinking_block: boolean | null;
}

export interface SettingsBehaviourWire {
  retry_enabled: boolean | null;
  retry_max_retries: number | null;
  retry_base_delay_ms: number | null;
  retry_provider_max_retry_delay_ms: number | null;
}

export interface SettingsDescribeOkWire {
  revision: string;
  file: SettingsFileStateWire;
  appearance: SettingsAppearanceWire;
  behaviour: SettingsBehaviourWire;
}

export type SettingsErrorReasonWire =
  | "not_found"
  | "corrupted"
  | "permission"
  | "conflict"
  | "invalid"
  | "invalid_field"
  | "unsupported"
  | "verify_failed";

export interface ChangesSnapshotWire {  is_repo: true;
  /** Short branch name, or null on a detached HEAD. */
  branch: string | null;
  /** Short HEAD sha + subject, or null on an unborn branch. */
  head: { sha7: string; subject: string } | null;
  ahead: number | null;
  behind: number | null;
  entries: ChangesEntryWire[];
  /** Full counts, independent of the entry cap. */
  total: { staged: number; unstaged: number; untracked: number; conflicted: number };
  /** True when `entries` was cut at the host's cap. */
  truncated: boolean;
}

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
 * Automations — one scheduled task as the browser sees it.
 *
 * The derived fields (`kind`, `time`, `weekdays`, `every_*`) are computed by the
 * host's projection from the AUTHORITATIVE `schedule` expression, and are `null`
 * when the expression does not imply them. A client that renders `null` as
 * "zero" would be describing a rule the host never stored, so the type keeps the
 * distinction visible instead of defaulting.
 */
export interface WireScheduleTask {
  id: string;
  daemon_id: string;
  /** The cron expression verbatim — the one field that is always meaningful. */
  schedule: string;
  kind: "every_minutes" | "every_hours" | "daily" | "weekly" | "custom";
  every_minutes: number | null;
  every_hours: number | null;
  /** `HH:mm` for daily/weekly, else null. */
  time: string | null;
  /** ISO weekdays (Mon=1..Sun=7) for weekly, else null. */
  weekdays: number[] | null;
  tz: string | null;
  prompt: string;
  enabled: boolean;
  skip_if_busy: boolean;
  wake: boolean;
  catchup: boolean;
  created_at: string;
  /** Last fire instant, or null when it has never fired. */
  last_run: string | null;
  /** The daemon's own outcome vocabulary, or null. Never translated. */
  last_status: string | null;
  next_run: string | null;
  /**
   * Pinned model for this task, or null when it inherits.
   *
   * Null is not "unknown": it is the meaningful state INHERIT, i.e. the fire uses
   * whatever model the workspace session currently has. The panel must say so
   * explicitly rather than leaving the row silent, because an inheriting task's
   * cost follows whatever the user last picked in the UI.
   */
  model: WireScheduleModel | null;
  /** True when each fire opens its own session instead of the live one. */
  fresh_session: boolean;
}

/** A pinned model on a scheduled task. */
export interface WireScheduleModel {
  provider: string;
  /** The provider's model id (e.g. `deepseek-flash`). */
  id: string;
  /** Display label when the host knows one; otherwise the client shows `id`. */
  name: string | null;
}

/**
 * Automations — outcome of one scheduled fire, mirrored onto the wire.
 *
 * Duplicated from `daemon/cron_log.ts` ON PURPOSE. That type is a daemon-internal
 * detail; widening the protocol to import from it would let a daemon refactor
 * silently change the browser contract. Keeping a closed copy here means a new
 * result value is a deliberate protocol change, and the web mirror can assert
 * against the same closed set.
 *
 * Every member is a fact the daemon actually records. There is no "unknown"
 * member: a frame carrying anything else is rejected by the client guard.
 */
export type CronResultWire =
  | "delivered"
  | "deliver_failed"
  | "woke_and_delivered"
  | "skipped_busy"
  | "skipped_down"
  | "skipped_disabled";

/**
 * How much of a job's prompt the `schedule_fired` push carries.
 *
 * The preview identifies WHICH task fired; the full text is already in the task
 * row and in the transcript. Keeping it short stops a large prompt from being
 * duplicated over the wire on every single fire.
 */
export const SCHEDULE_PREVIEW_CHARS = 120;

/**
 * Plan/69 — capabilities advertised by `host_hello_ok`. Closed union so the
 * app can switch on them with exhaustiveness checking.
 */
export type HostCapability =
  | "host_pairing"
  | "workspace_state"
  | "host_forward"
  | "fs_nav"
  | "changes"
  /** Plan/79 — read AND write the host's own models.json. This is the first
   *  capability that mutates host state, and the file holds plaintext API keys,
   *  so a client that lacks it cannot even read the provider list. */
  | "models_config"
  /** Plan/80 — read AND write the host's own settings.json, projected through a
   *  positive whitelist. Kept separate from `models_config` because the two files
   *  have different threat models (credentials vs. mixed preferences). */
  | "settings"
  /* The host serves the Automations surface (plan/39 cron projected to the web). */
  | "schedule";

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
export type PackageOp = "install" | "remove" | "update" | "set_enabled";

export interface PiSurfacePackageWire {
  source: string;
  scope: "user" | "project";
  /**
   * Resource kinds this package declares — the four conventional resource
   * directories Pi discovers (`extensions`, `skills`, `prompts`, `themes`).
   * Empty when the package declares nothing discoverable.
   */
  resources: string[];
  /**
   * The package's README text, or `null`.
   *
   * A plugin is third-party code, so "what does this actually do?" has to be
   * answerable in the app before the user installs or keeps it. Only the host
   * knows where a package was installed, so only the host can read this.
   *
   * OPTIONAL, and `null` is meaningful: an older host omits the field entirely,
   * and a package may genuinely ship no README. The UI must distinguish "not
   * provided" from an empty document instead of rendering a blank panel.
   */
  readme?: string | null;
  /** Where that README came from, for provenance. `null` when none. */
  readme_path?: string | null;
  /** True when the README exceeded the cap and was cut. */
  readme_truncated?: boolean;
  /**
   * Whether this package's resources will actually load.
   *
   * False means the settings entry is in Pi's "disabled" spelling (the object
   * form with every resource array empty): the code is still on disk, so this is
   * reversible and distinct from removing the package.
   *
   * OPTIONAL so an older host that does not report it never causes the client to
   * claim a package is off. Absent must be read as "unknown", not "disabled".
   */
  enabled?: boolean;
}

/**
 * Plan/28 — Mirror of the SDK's `ThinkingLevel` (defined in
 * `@earendil-works/pi-agent-core/types`). Re-declared locally so the wire
 * protocol owns its own enum and we don't leak SDK-internal types onto
 * the app's network surface.
 *
 * Note: `"xhigh"` and `"max"` are only honored by select model families — the SDK
 * uses each `Model.thinkingLevelMap` to decide if the requested level is
 * supported, falling back to a sensible neighbour when not. The app surfaces
 * exactly the levels the model reports (`thinking_levels`), so an unsupported one
 * is never offered.
 */
export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /**
   * Thinking levels THIS model actually accepts, in picker order.
   *
   * Derived from the SDK's `Model.thinkingLevelMap`: a level is supported when the
   * model maps it to a provider value, and unsupported when the map holds `null`.
   *
   * It travels on the wire because the alternative — one hard-coded six-item list —
   * showed every model the same levels, so a model supporting only `high`/`max`
   * still offered `low`/`medium`/`xhigh`, and picking one silently fell back to a
   * neighbour. The picker now renders exactly what the model honours.
   *
   * Omitted (rather than empty) when the model is not a reasoning model, so the
   * client can tell "no thinking surface" apart from "supports nothing".
   */
  thinking_levels?: ThinkingLevel[];
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
