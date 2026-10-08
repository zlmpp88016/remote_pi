// ignore_for_file: lines_longer_than_80_chars

// ---------------------------------------------------------------------------
// Control frames (plano 12 — presence)
//
// These travel raw over the WS (no outer envelope) and are routed by the
// relay itself, not the Pi. They never enter the inner-message switch.
// ---------------------------------------------------------------------------

/// Inbound control frame (relay → app).
sealed class ControlInbound {
  const ControlInbound();

  /// Parses a top-level JSON map into a control inbound. Returns null when
  /// the `type` is unknown (forward-compat).
  static ControlInbound? tryFromJson(Map<String, dynamic> j) {
    return switch (j['type']) {
      'peer_online' => PeerOnline(peer: j['peer'] as String),
      'peer_offline' => PeerOffline(
        peer: j['peer'] as String,
        sinceTs: (j['since_ts'] as num).toInt(),
      ),
      'presence' => PresenceSnapshot(
        states: (j['states'] as List<dynamic>)
            .map((e) => PeerPresence.fromJson(e as Map<String, dynamic>))
            .toList(),
      ),
      'room_announced' => () {
        // Plan/28 Wave D — thinking arrives either as a top-level
        // field (post-relay-flatten) or nested under `meta.thinking`
        // (pre-flatten relay forwarding the Pi's room_meta verbatim).
        // Read both so the app stays forward-compat with either side.
        final metaJson = j['meta'] as Map<String, dynamic>?;
        final rawThinking =
            (j['thinking'] as String?) ?? (metaJson?['thinking'] as String?);
        // Plan/32 — `working` arrives top-level (RoomMeta serializes flat)
        // or nested under `meta.working`; read both for forward-compat.
        final rawWorking =
            (j['working'] as bool?) ?? (metaJson?['working'] as bool?);
        return RoomAnnounced(
          peer: j['peer'] as String,
          roomId: j['room_id'] as String,
          name: j['name'] as String?,
          cwd: j['cwd'] as String?,
          startedAt: (j['started_at'] as num).toInt(),
          model: j['model'] as String?,
          thinking: rawThinking != null
              ? ThinkingLevel.fromWire(rawThinking)
              : null,
          working: rawWorking,
        );
      }(),
      'room_ended' => RoomEnded(
        peer: j['peer'] as String,
        roomId: j['room_id'] as String,
        sinceTs: (j['since_ts'] as num).toInt(),
      ),
      'rooms' => RoomsSnapshot(
        peer: j['peer'] as String,
        rooms: (j['rooms'] as List<dynamic>)
            .map((e) => RoomInfo.fromJson(e as Map<String, dynamic>))
            .toList(),
      ),
      'room_meta_updated' => () {
        final meta = j['meta'] as Map<String, dynamic>?;
        final hasModel = meta?.containsKey('model') ?? false;
        final hasThinking = meta?.containsKey('thinking') ?? false;
        final rawThinking = meta?['thinking'] as String?;
        return RoomMetaUpdated(
          peer: j['peer'] as String,
          roomId: j['room_id'] as String,
          model: meta?['model'] as String?,
          thinking: rawThinking != null
              ? ThinkingLevel.fromWire(rawThinking)
              : null,
          // Plan/32 — `working` has no "clear to null" state (false IS the
          // cleared state), so a plain nullable bool models the patch:
          // null = absent (preserve current), true/false = set.
          working: meta?['working'] as bool?,
          hasModel: hasModel,
          hasThinking: hasThinking,
        );
      }(),
      _ => null,
    };
  }
}

class PeerOnline extends ControlInbound {
  final String peer;
  const PeerOnline({required this.peer});
}

class PeerOffline extends ControlInbound {
  final String peer;
  final int sinceTs;
  const PeerOffline({required this.peer, required this.sinceTs});
}

class PresenceSnapshot extends ControlInbound {
  final List<PeerPresence> states;
  const PresenceSnapshot({required this.states});
}

class PeerPresence {
  final String peer;
  final bool online;
  final int? sinceTs;
  const PeerPresence({
    required this.peer,
    required this.online,
    required this.sinceTs,
  });

  factory PeerPresence.fromJson(Map<String, dynamic> j) => PeerPresence(
    peer: j['peer'] as String,
    online: j['online'] as bool,
    sinceTs: (j['since_ts'] as num?)?.toInt(),
  );
}

// --- Outbound control frames (helpers; the wire shape is just a Map) ---

Map<String, dynamic> subscribePresenceFrame(List<String> peers) => {
  'type': 'subscribe_presence',
  'peers': peers,
};

Map<String, dynamic> unsubscribePresenceFrame(List<String> peers) => {
  'type': 'unsubscribe_presence',
  'peers': peers,
};

Map<String, dynamic> presenceCheckFrame(List<String> peers) => {
  'type': 'presence_check',
  'peers': peers,
};

Map<String, dynamic> subscribeRoomsFrame(List<String> peers) => {
  'type': 'subscribe_rooms',
  'peers': peers,
};

Map<String, dynamic> unsubscribeRoomsFrame(List<String> peers) => {
  'type': 'unsubscribe_rooms',
  'peers': peers,
};

Map<String, dynamic> roomsCheckFrame(List<String> peers) => {
  'type': 'rooms_check',
  'peers': peers,
};

// ---------------------------------------------------------------------------
// Rooms (plan 17 — multi-cwd per Mac)
//
// Each Pi-extension instance opens one room per active session (cwd).
// The relay tracks room metadata per peer and pushes:
//   - room_announced: a new room came online for a peer
//   - room_ended: a room closed (Pi exited or stopped that cwd)
//   - rooms (snapshot): full list for a peer (sent after subscribe_rooms
//     or rooms_check).
// The app subscribes via `subscribe_rooms(peers)` and renders them as
// tiles grouped by Mac.
// ---------------------------------------------------------------------------

// Sentinel for nullable copyWith parameters that need to distinguish
// "keep current" (omit) from "set to null" (pass `null` explicitly).
const Object _kRoomInfoUnset = Object();

/// Snapshot of a single Pi room (one cwd / session).
class RoomInfo {
  final String roomId;
  final String? name;
  final String? cwd;
  final int startedAt;

  /// Plan 18 — display model the Pi-extension is running with (e.g.
  /// `claude-sonnet-4.5`, `gpt-4o`). Optional; Pi-ext may omit and
  /// the app falls back to `last paired` in the subtitle.
  final String? model;

  /// Plan/28 Wave D — current thinking level the Pi-extension session
  /// is running with. Optional; Pi-ext may omit when it cannot resolve
  /// it from the SDK, and legacy Pis don't publish this field at all.
  /// Drives the initial highlight of the Quick Actions thinking
  /// segmented control.
  final ThinkingLevel? thinking;

  /// Plan/32 — `true` when the room currently has an in-flight agent
  /// turn. The relay broadcasts `meta.working` for EVERY subscribed room
  /// (like presence), so Home can light the blue "working" dot on any
  /// session — not just the single connected one. Defaults to `false`
  /// (idle / not reported yet).
  final bool working;

  const RoomInfo({
    required this.roomId,
    required this.startedAt,
    this.name,
    this.cwd,
    this.model,
    this.thinking,
    this.working = false,
  });

  factory RoomInfo.fromJson(Map<String, dynamic> j) {
    final rawThinking = j['thinking'] as String?;
    return RoomInfo(
      roomId: j['room_id'] as String,
      name: j['name'] as String?,
      cwd: j['cwd'] as String?,
      startedAt: (j['started_at'] as num).toInt(),
      model: j['model'] as String?,
      thinking: rawThinking != null
          ? ThinkingLevel.fromWire(rawThinking)
          : null,
      working: (j['working'] as bool?) ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
    'room_id': roomId,
    'name': name,
    'cwd': cwd,
    'started_at': startedAt,
    'model': model,
    if (thinking != null) 'thinking': thinking!.wire,
    'working': working,
  };

  RoomInfo copyWith({
    String? name,
    String? cwd,
    int? startedAt,
    Object? model = _kRoomInfoUnset,
    Object? thinking = _kRoomInfoUnset,
    bool? working,
  }) => RoomInfo(
    roomId: roomId,
    name: name ?? this.name,
    cwd: cwd ?? this.cwd,
    startedAt: startedAt ?? this.startedAt,
    model: identical(model, _kRoomInfoUnset) ? this.model : model as String?,
    thinking: identical(thinking, _kRoomInfoUnset)
        ? this.thinking
        : thinking as ThinkingLevel?,
    working: working ?? this.working,
  );

  @override
  bool operator ==(Object other) =>
      other is RoomInfo &&
      other.roomId == roomId &&
      other.name == name &&
      other.cwd == cwd &&
      other.startedAt == startedAt &&
      other.model == model &&
      other.thinking == thinking &&
      other.working == working;

  @override
  int get hashCode =>
      Object.hash(roomId, name, cwd, startedAt, model, thinking, working);
}

class RoomAnnounced extends ControlInbound {
  final String peer;
  final String roomId;
  final String? name;
  final String? cwd;
  final int startedAt;

  /// Plan 18 — display model the Pi-extension is running with.
  final String? model;

  /// Plan/28 Wave D — current thinking level the Pi seeds at
  /// session start. Parsed from `meta.thinking` or top-level
  /// `thinking` depending on whether the relay flattens metadata.
  final ThinkingLevel? thinking;

  /// Plan/32 — in-flight agent turn at announce time. `null` when the
  /// frame omitted it (legacy relay); the ConnectionManager then keeps
  /// any previously-known value instead of forcing `false`.
  final bool? working;
  const RoomAnnounced({
    required this.peer,
    required this.roomId,
    required this.startedAt,
    this.name,
    this.cwd,
    this.model,
    this.thinking,
    this.working,
  });
}

class RoomEnded extends ControlInbound {
  final String peer;
  final String roomId;
  final int sinceTs;
  const RoomEnded({
    required this.peer,
    required this.roomId,
    required this.sinceTs,
  });
}

class RoomsSnapshot extends ControlInbound {
  final String peer;
  final List<RoomInfo> rooms;
  const RoomsSnapshot({required this.peer, required this.rooms});
}

/// Plan 18 — incremental update to a room's metadata (model is the
/// only field for now, but the `meta` envelope is open-ended). The
/// relay pushes this when the Pi-extension swaps its model
/// mid-session.
class RoomMetaUpdated extends ControlInbound {
  final String peer;
  final String roomId;
  final String? model;

  /// Plan/28 Wave D — current thinking level, parsed from
  /// `meta.thinking`. Null when the Pi only published a model change.
  /// The app treats both fields as independently optional so an update
  /// for only one of them doesn't clobber the other on the cache side.
  final ThinkingLevel? thinking;

  /// Plan/28 Wave D — `true` when the `meta` envelope carried a `model`
  /// key (even if value is null). Lets the ConnectionManager handler
  /// distinguish "model was not part of this update" from "model was
  /// explicitly cleared", which matters now that updates can be
  /// thinking-only.
  ///
  /// Defaults to `true` for ergonomic programmatic construction
  /// (callers / tests can pass `model: x` without also remembering
  /// the boolean). [RoomMetaUpdated.fromJson] passes the precise
  /// presence-of-key boolean instead.
  final bool hasModel;

  /// Plan/28 Wave D — same convention for `thinking`.
  final bool hasThinking;

  /// Plan/32 — in-flight agent turn for this room. `null` = the update
  /// did not carry `working` (preserve the cached value); non-null =
  /// set. No separate `hasWorking` flag is needed because `working` can
  /// never be "explicitly null" on the wire — `false` is the off state.
  final bool? working;
  const RoomMetaUpdated({
    required this.peer,
    required this.roomId,
    this.model,
    this.thinking,
    this.working,
    this.hasModel = true,
    this.hasThinking = true,
  });
}

// ---------------------------------------------------------------------------
// PresenceState — per-peer summary kept by ConnectionManager.
// ---------------------------------------------------------------------------

sealed class PresenceState {
  const PresenceState();
}

class PresenceUnknown extends PresenceState {
  const PresenceUnknown();
}

class PresenceOnline extends PresenceState {
  final int? sinceTs;
  const PresenceOnline({this.sinceTs});
}

class PresenceOffline extends PresenceState {
  final int? sinceTs;
  const PresenceOffline({this.sinceTs});
}

// --- Supporting types ---

class Usage {
  final int inputTokens;
  final int outputTokens;

  const Usage({required this.inputTokens, required this.outputTokens});

  factory Usage.fromJson(Map<String, dynamic> j) => Usage(
    inputTokens: j['input_tokens'] as int,
    outputTokens: j['output_tokens'] as int,
  );
}

enum ApproveDecision { allow, deny }

class UnsupportedTypeException implements Exception {
  final String type;
  const UnsupportedTypeException(this.type);

  @override
  String toString() => 'UnsupportedTypeException: unknown type "$type"';
}

// --- ClientMessage (app → extension) ---
// Plan/67: pairing is machine-level; session_list / session_switch select
// an AgentSession inside the current workspace room.

sealed class ClientMessage {
  Map<String, dynamic> toJson();
}

/// Plan/30 — one image carried inline on a `user_message` (base64 + mime).
/// Mirrors `WireImage` in `pi-extension/src/protocol/types.ts` and the SDK's
/// `ImageContent`. The relay forwards it opaquely inside the existing `ct`.
class WireImage {
  final String data; // base64, no data-URI prefix
  final String mime; // e.g. image/jpeg
  const WireImage({required this.data, required this.mime});

  factory WireImage.fromJson(Map<String, dynamic> j) =>
      WireImage(data: j['data'] as String, mime: j['mime'] as String);

  Map<String, dynamic> toJson() => {'data': data, 'mime': mime};

  @override
  bool operator ==(Object other) =>
      other is WireImage && other.data == data && other.mime == mime;

  @override
  int get hashCode => Object.hash(data, mime);
}

enum UserMessageStreamingBehavior {
  steer;

  /// Mirrors the Pi wire shape. Keep permissive parsing for forward-compat.
  static UserMessageStreamingBehavior? fromWire(String? raw) {
    return switch (raw) {
      'steer' => UserMessageStreamingBehavior.steer,
      _ => null,
    };
  }

  String get wireValue {
    return switch (this) {
      UserMessageStreamingBehavior.steer => 'steer',
    };
  }
}

class UserMessage extends ClientMessage {
  final String id;
  final String text;

  /// Optional steering behavior for this message. Omitted when null for
  /// compatibility with older Pi extensions.
  final UserMessageStreamingBehavior? streamingBehavior;

  /// Plan/30 — optional attached images. The feature sends at most one, but
  /// the wire shape is a list to mirror the SDK's `(TextContent|ImageContent)[]`
  /// and stay forward-compatible. Omitted entirely when empty (retro-compat).
  final List<WireImage>? images;

  UserMessage({
    required this.id,
    required this.text,
    this.streamingBehavior,
    this.images,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'user_message',
    'id': id,
    'text': text,
    if (streamingBehavior != null)
      'streaming_behavior': streamingBehavior!.wireValue,
    if (images != null && images!.isNotEmpty)
      'images': images!.map((i) => i.toJson()).toList(),
  };
}

class QueuedMessageSet extends ClientMessage {
  final String id;
  final String text;
  QueuedMessageSet({required this.id, required this.text});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'queued_message_set',
    'id': id,
    'text': text,
  };
}

class QueuedMessageClear extends ClientMessage {
  final String id;
  final String? targetId;
  QueuedMessageClear({required this.id, this.targetId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'queued_message_clear',
    'id': id,
    if (targetId != null) 'target_id': targetId,
  };
}

class ApproveTool extends ClientMessage {
  final String id;
  final String toolCallId;
  final ApproveDecision decision;
  ApproveTool({
    required this.id,
    required this.toolCallId,
    required this.decision,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'approve_tool',
    'id': id,
    'tool_call_id': toolCallId,
    'decision': decision.name,
  };
}

class Cancel extends ClientMessage {
  final String id;
  final String targetId;
  Cancel({required this.id, required this.targetId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'cancel',
    'id': id,
    'target_id': targetId,
  };
}

class Ping extends ClientMessage {
  final String id;
  Ping({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'ping', 'id': id};
}

class PairRequest extends ClientMessage {
  final String id;
  final String token;
  final String deviceName;
  PairRequest({
    required this.id,
    required this.token,
    required this.deviceName,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'pair_request',
    'id': id,
    'token': token,
    'device_name': deviceName,
  };
}

/// Sent on reconnect / re-entry to request the current view of Pi's
/// session. With the mirror-cache strategy (plan/16) the app no longer
/// negotiates incremental since_ts; it just asks for the latest N
/// events and replaces local state with whatever Pi returns.
/// Plan 01 — runtime status snapshot from the Pi (model / thinking / usage /
/// cost / context occupancy). Mirrors `RuntimeStatusWire` in the extension.
class RuntimeStatus {
  final RuntimeModelInfo? model;
  final ThinkingLevel? thinkingLevel;
  final RuntimeUsage usage;
  final RuntimeContextInfo? context;
  final DateTime? updatedAt;

  const RuntimeStatus({
    this.model,
    this.thinkingLevel,
    this.usage = const RuntimeUsage.empty(),
    this.context,
    this.updatedAt,
  });

  factory RuntimeStatus.fromJson(Map<String, dynamic> j) => RuntimeStatus(
    model: j['model'] == null
        ? null
        : RuntimeModelInfo.fromJson(j['model'] as Map<String, dynamic>),
    thinkingLevel: ThinkingLevel.fromWire(
      (j['thinking_level'] as String?) ?? '',
    ),
    usage: j['usage'] == null
        ? const RuntimeUsage.empty()
        : RuntimeUsage.fromJson(j['usage'] as Map<String, dynamic>),
    context: j['context'] == null
        ? null
        : RuntimeContextInfo.fromJson(j['context'] as Map<String, dynamic>),
    updatedAt: DateTime.tryParse((j['updated_at'] as String?) ?? ''),
  );
}

class RuntimeModelInfo {
  final String provider;
  final String id;
  final String? name;
  final int? contextWindow;
  final bool reasoning;

  const RuntimeModelInfo({
    required this.provider,
    required this.id,
    this.name,
    this.contextWindow,
    this.reasoning = false,
  });

  /// What to show in the header: the display name when the provider supplied
  /// one, otherwise the bare id (never an empty string).
  String get displayName => (name != null && name!.isNotEmpty) ? name! : id;

  factory RuntimeModelInfo.fromJson(Map<String, dynamic> j) => RuntimeModelInfo(
    provider: (j['provider'] as String?) ?? '',
    id: (j['id'] as String?) ?? '',
    name: j['name'] as String?,
    contextWindow: (j['context_window'] as num?)?.toInt(),
    reasoning: (j['reasoning'] as bool?) ?? false,
  );
}

class RuntimeUsage {
  final int input;
  final int output;
  final int cacheRead;
  final int cacheWrite;
  final RuntimeCost cost;

  const RuntimeUsage({
    this.input = 0,
    this.output = 0,
    this.cacheRead = 0,
    this.cacheWrite = 0,
    this.cost = const RuntimeCost.empty(),
  });

  const RuntimeUsage.empty()
      : input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        cost = const RuntimeCost.empty();

  factory RuntimeUsage.fromJson(Map<String, dynamic> j) => RuntimeUsage(
    input: (j['input'] as num?)?.toInt() ?? 0,
    output: (j['output'] as num?)?.toInt() ?? 0,
    cacheRead: (j['cache_read'] as num?)?.toInt() ?? 0,
    cacheWrite: (j['cache_write'] as num?)?.toInt() ?? 0,
    cost: j['cost'] == null
        ? const RuntimeCost.empty()
        : RuntimeCost.fromJson(j['cost'] as Map<String, dynamic>),
  );
}

class RuntimeCost {
  final double input;
  final double output;
  final double cacheRead;
  final double cacheWrite;
  final double total;

  const RuntimeCost({
    this.input = 0,
    this.output = 0,
    this.cacheRead = 0,
    this.cacheWrite = 0,
    this.total = 0,
  });

  const RuntimeCost.empty()
      : input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        total = 0;

  factory RuntimeCost.fromJson(Map<String, dynamic> j) => RuntimeCost(
    input: (j['input'] as num?)?.toDouble() ?? 0,
    output: (j['output'] as num?)?.toDouble() ?? 0,
    cacheRead: (j['cache_read'] as num?)?.toDouble() ?? 0,
    cacheWrite: (j['cache_write'] as num?)?.toDouble() ?? 0,
    total: (j['total'] as num?)?.toDouble() ?? 0,
  );
}

/// Plan 01 — context-window occupancy. `tokens`/`percent` are null right after
/// a compaction, before the next provider response.
class RuntimeContextInfo {
  final int? tokens;
  final int contextWindow;
  final double? percent;

  const RuntimeContextInfo({
    required this.contextWindow,
    this.tokens,
    this.percent,
  });

  factory RuntimeContextInfo.fromJson(Map<String, dynamic> j) => RuntimeContextInfo(
    tokens: (j['tokens'] as num?)?.toInt(),
    contextWindow: (j['context_window'] as num?)?.toInt() ?? 0,
    percent: (j['percent'] as num?)?.toDouble(),
  );
}

/// Plan 01 — one session-tree entry. `snapshotVersion`/`branchVersion` ride on
/// the enclosing [TreeSnapshot]; clients echo both back when acting.
class TreeEntry {
  final String id;
  final String? parentId;
  final String type;
  final String? role;
  final String? customType;
  final String? toolName;
  final String title;
  final String preview;
  final DateTime? timestamp;
  final bool isCurrentLeaf;
  final bool isOnActiveBranch;
  final bool isForkable;

  /// `edit_prompt` entries (user and custom messages) branch from their parent
  /// and may return editor text; others navigate in place.
  final String navigationBehavior;

  const TreeEntry({
    required this.id,
    required this.parentId,
    required this.type,
    required this.title,
    required this.preview,
    required this.isCurrentLeaf,
    required this.isOnActiveBranch,
    required this.isForkable,
    required this.navigationBehavior,
    this.role,
    this.customType,
    this.toolName,
    this.timestamp,
  });

  factory TreeEntry.fromJson(Map<String, dynamic> j) => TreeEntry(
    id: j['id'] as String,
    parentId: j['parent_id'] as String?,
    type: (j['type'] as String?) ?? 'other',
    role: j['role'] as String?,
    customType: j['custom_type'] as String?,
    toolName: j['tool_name'] as String?,
    title: (j['title'] as String?) ?? '',
    preview: (j['preview'] as String?) ?? '',
    timestamp: DateTime.tryParse((j['timestamp'] as String?) ?? ''),
    isCurrentLeaf: (j['is_current_leaf'] as bool?) ?? false,
    isOnActiveBranch: (j['is_on_active_branch'] as bool?) ?? false,
    isForkable: (j['is_forkable'] as bool?) ?? false,
    navigationBehavior: (j['navigation_behavior'] as String?) ?? 'navigate',
  );
}

/// Plan 01 — session-tree snapshot with the double version fence.
class TreeSnapshot {
  final String snapshotVersion;
  final String branchVersion;
  final String? leafId;
  final List<TreeEntry> entries;
  final String defaultFilter;
  final List<String> filters;

  const TreeSnapshot({
    required this.snapshotVersion,
    required this.branchVersion,
    required this.leafId,
    required this.entries,
    this.defaultFilter = 'default',
    this.filters = const [],
  });

  factory TreeSnapshot.fromJson(Map<String, dynamic> j) => TreeSnapshot(
    snapshotVersion: (j['snapshot_version'] as String?) ?? '',
    branchVersion: (j['branch_version'] as String?) ?? '',
    leafId: j['leaf_id'] as String?,
    entries: ((j['entries'] as List<dynamic>?) ?? const [])
        .map((e) => TreeEntry.fromJson(e as Map<String, dynamic>))
        .toList(),
    defaultFilter: (j['default_filter'] as String?) ?? 'default',
    filters: ((j['filters'] as List<dynamic>?) ?? const [])
        .map((f) => f as String)
        .toList(),
  );
}

class RuntimeStatusMessage extends ServerMessage {
  final RuntimeStatus status;
  const RuntimeStatusMessage(this.status);

  factory RuntimeStatusMessage.fromJson(Map<String, dynamic> j) =>
      RuntimeStatusMessage(RuntimeStatus.fromJson(j['status'] as Map<String, dynamic>));
}

class TreeSnapshotOk extends ServerMessage {
  final String inReplyTo;
  final TreeSnapshot snapshot;
  const TreeSnapshotOk({required this.inReplyTo, required this.snapshot});

  factory TreeSnapshotOk.fromJson(Map<String, dynamic> j) => TreeSnapshotOk(
    inReplyTo: j['in_reply_to'] as String,
    snapshot: TreeSnapshot.fromJson(j['snapshot'] as Map<String, dynamic>),
  );
}

class TreeNavigateOk extends ServerMessage {
  final String inReplyTo;
  final String? leafId;
  final String snapshotVersion;
  final String branchVersion;
  final String? editorText;

  const TreeNavigateOk({
    required this.inReplyTo,
    required this.leafId,
    required this.snapshotVersion,
    required this.branchVersion,
    this.editorText,
  });

  factory TreeNavigateOk.fromJson(Map<String, dynamic> j) => TreeNavigateOk(
    inReplyTo: j['in_reply_to'] as String,
    leafId: j['leaf_id'] as String?,
    snapshotVersion: (j['snapshot_version'] as String?) ?? '',
    branchVersion: (j['branch_version'] as String?) ?? '',
    editorText: j['editor_text'] as String?,
  );
}

class SessionForkOk extends ServerMessage {
  final String inReplyTo;

  /// Text of the forked user prompt, offered to the composer. Never auto-sent.
  final String editorText;
  const SessionForkOk({required this.inReplyTo, required this.editorText});

  factory SessionForkOk.fromJson(Map<String, dynamic> j) => SessionForkOk(
    inReplyTo: j['in_reply_to'] as String,
    editorText: (j['editor_text'] as String?) ?? '',
  );
}

class SessionCloneOk extends ServerMessage {
  final String inReplyTo;
  const SessionCloneOk({required this.inReplyTo});

  factory SessionCloneOk.fromJson(Map<String, dynamic> j) =>
      SessionCloneOk(inReplyTo: j['in_reply_to'] as String);
}

class SessionSync extends ClientMessage {
  final String id;
  final int? limit;

  /// Plan 01 — opaque cursor from a previous `session_history.older_cursor`.
  /// Omitted → the newest window (the pre-pagination behaviour).
  final String? before;

  SessionSync({required this.id, this.limit, this.before});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'session_sync',
    'id': id,
    if (limit != null) 'limit': limit,
    if (before != null) 'before': before,
  };
}

// ---------------------------------------------------------------------------
// Plan/28 — Typed app actions
// ---------------------------------------------------------------------------

/// Plan/28 — Curated catalogue of actions the app can dispatch on the
/// Pi-side session. Each value matches an `action_ok`/`action_error`
/// reply emitted by the pi-extension handlers in
/// `pi-extension/src/actions/handlers.ts`.
enum ActionName {
  sessionNew('session_new'),
  sessionCompact('session_compact'),
  modelSet('model_set'),
  thinkingSet('thinking_set'),
  sessionList('session_list'),
  sessionSwitch('session_switch'),
  workspaceList('workspace_list'),
  workspaceStart('workspace_start'),
  workspaceStop('workspace_stop'),
  // Plan/68 — host filesystem navigation + explicit workspace catalog.
  fsList('fs_list'),
  workspaceAdd('workspace_add'),
  workspaceRemove('workspace_remove'),
  // Plan/68 — Pi surface (skills + packages).
  piSurface('pi_surface'),
  skillInvoke('skill_invoke'),
  skillSetEnabled('skill_set_enabled'),
  packageInstall('package_install'),
  packageRemove('package_remove'),
  packageUpdate('package_update'),
  // Plan 01 — session tree navigation and branching.
  treeGet('tree_get'),
  treeNavigate('tree_navigate'),
  sessionFork('session_fork'),
  sessionClone('session_clone');

  final String wire;
  const ActionName(this.wire);

  static ActionName? fromWire(String s) {
    for (final a in values) {
      if (a.wire == s) return a;
    }
    return null;
  }
}

/// Plan/28 — Mirror of the SDK's `ThinkingLevel`. Six fixed values; the
/// wire format is the lower-case string. `xhigh` is honored only by
/// select models — the app surfaces every level and the SDK falls back
/// when the active model doesn't support the requested one.
enum ThinkingLevel {
  off('off'),
  minimal('minimal'),
  low('low'),
  medium('medium'),
  high('high'),
  xhigh('xhigh');

  final String wire;
  const ThinkingLevel(this.wire);

  static ThinkingLevel? fromWire(String s) {
    for (final l in values) {
      if (l.wire == s) return l;
    }
    return null;
  }
}

/// Plan/28 — Wire shape for one entry in the model picker. Subset of
/// the SDK's `Model` interface; matches the `WireModel` declared in
/// `pi-extension/src/protocol/types.ts`.
class WireModel {
  /// Stable id inside the provider's catalog (e.g. `claude-opus-4-7`).
  final String id;

  /// Display name shown in the picker (e.g. `Claude Opus 4.7`).
  final String name;

  /// Provider slug (e.g. `anthropic`, `openai`).
  final String provider;

  /// Whether this model exposes the thinking surface. Drives the
  /// thinking segmented control's enabled state on the picker side.
  final bool reasoning;

  /// Context window in tokens — surfaced as picker subtitle.
  final int contextWindow;

  /// Plan/30 — whether the model accepts image input (multimodal). Derived
  /// pi-side from `model.input.includes("image")`. Drives the attach
  /// button's enabled state (#9): a text-only model greys it out.
  final bool vision;

  const WireModel({
    required this.id,
    required this.name,
    required this.provider,
    required this.reasoning,
    required this.contextWindow,
    this.vision = false,
  });

  factory WireModel.fromJson(Map<String, dynamic> j) => WireModel(
    id: j['id'] as String,
    name: j['name'] as String,
    provider: j['provider'] as String,
    reasoning: (j['reasoning'] as bool?) ?? false,
    contextWindow: (j['context_window'] as num?)?.toInt() ?? 0,
    vision: (j['vision'] as bool?) ?? false,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'provider': provider,
    'reasoning': reasoning,
    'context_window': contextWindow,
    'vision': vision,
  };

  @override
  bool operator ==(Object other) =>
      other is WireModel &&
      other.id == id &&
      other.provider == provider &&
      other.name == name &&
      other.reasoning == reasoning &&
      other.contextWindow == contextWindow &&
      other.vision == vision;

  @override
  int get hashCode =>
      Object.hash(id, provider, name, reasoning, contextWindow, vision);
}

class SessionCompact extends ClientMessage {
  final String id;
  SessionCompact({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'session_compact', 'id': id};
}

class SessionNew extends ClientMessage {
  final String id;
  SessionNew({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'session_new', 'id': id};
}

class ModelSet extends ClientMessage {
  final String id;
  final String provider;
  final String modelId;
  ModelSet({required this.id, required this.provider, required this.modelId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'model_set',
    'id': id,
    'provider': provider,
    'model_id': modelId,
  };
}

class ThinkingSet extends ClientMessage {
  final String id;
  final ThinkingLevel level;
  ThinkingSet({required this.id, required this.level});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'thinking_set',
    'id': id,
    'level': level.wire,
  };
}

class ListModels extends ClientMessage {
  final String id;
  ListModels({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'list_models', 'id': id};
}

/// Plan/67 — list AgentSessions for the current workspace cwd.
class SessionList extends ClientMessage {
  final String id;
  SessionList({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'session_list', 'id': id};
}

/// Plan/67 — switch the live AgentSession. `sessionId` is the Pi
/// SessionManager id from [SessionListOk].
class SessionSwitch extends ClientMessage {
  final String id;
  final String sessionId;
  SessionSwitch({required this.id, required this.sessionId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'session_switch',
    'id': id,
    'session_id': sessionId,
  };
}

/// Plan/67 — reserved room_id for the supervisor host control plane.
const kHostRoomId = 'host';

/// Plan 01 — the double fence every tree mutation carries.
///
/// Both versions AND the leaf id must match the Pi's live tree, otherwise the
/// Pi rejects the request with `tree_state_changed`. Sending a stale leaf is
/// the failure the fence exists to prevent: the user's pick came from a tree
/// that has since moved.
class TreeFence {
  final String snapshotVersion;
  final String branchVersion;
  final String? leafId;

  const TreeFence({
    required this.snapshotVersion,
    required this.branchVersion,
    required this.leafId,
  });

  /// Build a fence from a snapshot this client just received.
  factory TreeFence.fromSnapshot(TreeSnapshot s) => TreeFence(
    snapshotVersion: s.snapshotVersion,
    branchVersion: s.branchVersion,
    leafId: s.leafId,
  );
}

class TreeGet extends ClientMessage {
  final String id;
  TreeGet({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'tree_get', 'id': id};
}

class TreeNavigate extends ClientMessage {
  final String id;
  final String targetEntryId;
  final TreeFence fence;
  final bool summarize;

  TreeNavigate({
    required this.id,
    required this.targetEntryId,
    required this.fence,
    this.summarize = false,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'tree_navigate',
    'id': id,
    'target_entry_id': targetEntryId,
    'base_snapshot_version': fence.snapshotVersion,
    'base_branch_version': fence.branchVersion,
    'base_leaf_id': fence.leafId,
    'summarize': summarize,
  };
}

class SessionFork extends ClientMessage {
  final String id;
  final String targetEntryId;
  final TreeFence fence;

  SessionFork({
    required this.id,
    required this.targetEntryId,
    required this.fence,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'session_fork',
    'id': id,
    'target_entry_id': targetEntryId,
    'base_snapshot_version': fence.snapshotVersion,
    'base_branch_version': fence.branchVersion,
    'base_leaf_id': fence.leafId,
  };
}

class SessionClone extends ClientMessage {
  final String id;
  final TreeFence fence;

  SessionClone({required this.id, required this.fence});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'session_clone',
    'id': id,
    'base_snapshot_version': fence.snapshotVersion,
    'base_branch_version': fence.branchVersion,
    'base_leaf_id': fence.leafId,
  };
}
class WorkspaceList extends ClientMessage {
  final String id;
  WorkspaceList({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'workspace_list', 'id': id};
}

class WorkspaceStart extends ClientMessage {
  final String id;
  final String? cwd;
  final String? daemonId;
  WorkspaceStart({required this.id, this.cwd, this.daemonId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'workspace_start',
    'id': id,
    if (cwd != null) 'cwd': cwd,
    if (daemonId != null) 'daemon_id': daemonId,
  };
}

class WorkspaceStop extends ClientMessage {
  final String id;
  final String? cwd;
  final String? daemonId;
  WorkspaceStop({required this.id, this.cwd, this.daemonId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'workspace_stop',
    'id': id,
    if (cwd != null) 'cwd': cwd,
    if (daemonId != null) 'daemon_id': daemonId,
  };
}

/// Plan/69 — host-first handshake. Sent on boot/reconnect of the machine
/// connection (which is anchored on room `host`); the host answers
/// `host_hello_ok` with its real version/hostname (never fabricated).
class HostHello extends ClientMessage {
  final String id;
  HostHello({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'host_hello', 'id': id};
}

/// Plan/69 — restart a workspace by cwd. Idempotent host-side: a workspace
/// that is already `running` answers `workspace_restart_ok` without
/// respawning anything.
class WorkspaceRestart extends ClientMessage {
  final String id;
  final String cwd;
  WorkspaceRestart({required this.id, required this.cwd});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'workspace_restart',
    'id': id,
    'cwd': cwd,
  };
}

/// Plan/69 — proxy envelope (spike decision B). The app anchors on room
/// `host` ONLY — one connection cannot sustain room `host` plus workspace
/// rooms because the app-side demux drops envelopes from a non-active room
/// (spike E2c). A child-addressed ClientMessage therefore rides inside
/// `host_forward{room, ct}` addressed to the host; `ct` is base64 of the
/// inner ClientMessage JSON. Replies come back as `host_message`
/// (`lib/data/transport/host_proxy.dart` does the wrap/unwrap).
class HostForward extends ClientMessage {
  final String id;

  /// Child room the host must re-emit to.
  final String room;

  /// Base64 of the inner ClientMessage JSON.
  final String ct;
  HostForward({required this.id, required this.room, required this.ct});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'host_forward',
    'id': id,
    'room': room,
    'ct': ct,
  };
}

/// Plan/68 — ask the host to list one directory so the user can pick a cwd
/// by walking the host's tree. The client never resolves a path itself.
class FsList extends ClientMessage {
  final String id;
  final String path;
  final bool showHidden;
  FsList({required this.id, required this.path, this.showHidden = false});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'fs_list',
    'id': id,
    'path': path,
    'show_hidden': showHidden,
  };
}

/// Plan/68 — persist a workspace the user added from the picker.
class WorkspaceAdd extends ClientMessage {
  final String id;
  final String path;
  WorkspaceAdd({required this.id, required this.path});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'workspace_add',
    'id': id,
    'path': path,
  };
}

/// Plan/68 — drop an added workspace (never a registered daemon).
class WorkspaceRemove extends ClientMessage {
  final String id;
  final String path;
  WorkspaceRemove({required this.id, required this.path});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'workspace_remove',
    'id': id,
    'path': path,
  };
}

/// Plan/68 — ask the machine for its Pi surface: runtime, skills, packages.
class PiSurface extends ClientMessage {
  final String id;
  PiSurface({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'pi_surface', 'id': id};
}

/// Plan/68 — force a skill by name. `args` is appended to the skill body as a
/// user request (`/skill:<name> <args>`), so the result flows through chat.
class SkillInvoke extends ClientMessage {
  final String id;
  final String name;
  final String? args;
  SkillInvoke({required this.id, required this.name, this.args});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'skill_invoke',
    'id': id,
    'name': name,
    if (args != null && args!.isNotEmpty) 'args': args,
  };
}

/// Plan/68 — enable/disable one skill for the workspace.
class SkillSetEnabled extends ClientMessage {
  final String id;
  final String name;
  final bool enabled;
  SkillSetEnabled({required this.id, required this.name, required this.enabled});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'skill_set_enabled',
    'id': id,
    'name': name,
    'enabled': enabled,
  };
}

/// Plan/68 — install a Pi package. Packages execute code, so
/// [confirmThirdParty] must be true (the extension refuses otherwise).
class PackageInstall extends ClientMessage {
  final String id;
  final String source;
  final PackageScope scope;
  final bool confirmThirdParty;
  PackageInstall({
    required this.id,
    required this.source,
    required this.scope,
    required this.confirmThirdParty,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'package_install',
    'id': id,
    'source': source,
    'scope': scope.wire,
    'confirm_third_party': confirmThirdParty,
  };
}

/// Plan/68 — remove a configured package source.
class PackageRemove extends ClientMessage {
  final String id;
  final String source;
  final PackageScope? scope;
  PackageRemove({required this.id, required this.source, this.scope});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'package_remove',
    'id': id,
    'source': source,
    if (scope != null) 'scope': scope!.wire,
  };
}

/// Plan/68 — reconcile one package, or every installed one when [source] is
/// omitted.
class PackageUpdate extends ClientMessage {
  final String id;
  final String? source;
  PackageUpdate({required this.id, this.source});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'package_update',
    'id': id,
    if (source != null) 'source': source,
  };
}

// --- ServerMessage (extension → app) ---
// 1 pairing = 1 session: no session_id on any message.
// Sealed: all subtypes in this file — switch exhaustiveness enforced by compiler.

sealed class ServerMessage {
  const ServerMessage();

  factory ServerMessage.fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String?;
    return switch (type) {
      'agent_chunk' => AgentChunk.fromJson(json),
      'agent_done' => AgentDone.fromJson(json),
      'tool_request' => ToolRequest.fromJson(json),
      'tool_result' => ToolResult.fromJson(json),
      'error' => ErrorMessage.fromJson(json),
      'cancelled' => Cancelled.fromJson(json),
      'pong' => Pong.fromJson(json),
      'pair_ok' => PairOk.fromJson(json),
      'pair_error' => PairError.fromJson(json),
      // Plan/24-fix-app-source-of-truth + follow-up: Pi rebroadcasts
      // every accepted user_message via this stream. Some Pi-extension
      // versions emit `type: "user_input"` (mirror of a terminal-side
      // input), others reuse the original `user_message` type when
      // echoing back. Treat both as the same payload — `UserInput`
      // here is the "user-text-arrived" event regardless of origin.
      'user_input' || 'user_message' => UserInput.fromJson(json),
      'queued_message_state' => QueuedMessageState.fromJson(json),
      'steer_consumed' => SteerConsumed.fromJson(json),
      'agent_message' => AgentMessage.fromJson(json),
      // Plan/32 — Pi-extension emits this when a context compaction finishes.
      'compaction' => Compaction.fromJson(json),
      'session_history' => SessionHistory.fromJson(json),
      'bye' => Bye.fromJson(json),
      'action_ok' => ActionOk.fromJson(json),
      'action_error' => ActionError.fromJson(json),
      'models_list' => ModelsList.fromJson(json),
      'session_list_ok' => SessionListOk.fromJson(json),
      'session_switch_ok' => SessionSwitchOk.fromJson(json),
      'session_switch_error' => SessionSwitchError.fromJson(json),
      'workspace_list_ok' => WorkspaceListOk.fromJson(json),
      'workspace_start_ok' => WorkspaceStartOk.fromJson(json),
      'workspace_stop_ok' => WorkspaceStopOk.fromJson(json),
      // Plan/69 — host-first handshake + workspace lifecycle + restart.
      'host_hello_ok' => HostHelloOk.fromJson(json),
      'workspace_state' => WorkspaceState.fromJson(json),
      'workspace_restart_ok' => WorkspaceRestartOk.fromJson(json),
      'workspace_restart_error' => WorkspaceRestartError.fromJson(json),
      // Plan/69 — proxy wrapper. Normally unwrapped by WsTransport before
      // reaching the channel; registered so a stray frame still decodes.
      'host_message' => HostMessage.fromJson(json),
      // Plan/68 — host filesystem navigation for the workspace picker.
      'fs_list_ok' => FsListOk.fromJson(json),
      // Plan/68 — Pi surface (skills + packages) and its management acks.
      'pi_surface_ok' => PiSurfaceOk.fromJson(json),
      'skill_invoke_ok' => SkillInvokeOk.fromJson(json),
      'skill_set_enabled_ok' => SkillSetEnabledOk.fromJson(json),
      'package_op_ok' => PackageOpOk.fromJson(json),
      // Plan/57 — interactive extension prompt (ask_user via pi-ask). Mirrors
      // the SDK's extension_ui_request RPC contract; optional `ask` envelope
      // carries pi-ask's full question so the app renders multi/preview/notes.
      'extension_ui_request' => ExtensionUiRequest.fromJson(json),
      // Plan 01 — runtime status + session tree/branching replies.
      'runtime_status' => RuntimeStatusMessage.fromJson(json),
      'tree_snapshot_ok' => TreeSnapshotOk.fromJson(json),
      'tree_navigate_ok' => TreeNavigateOk.fromJson(json),
      'session_fork_ok' => SessionForkOk.fromJson(json),
      'session_clone_ok' => SessionCloneOk.fromJson(json),
      // forward-compat: unknown types are not fatal — callers catch and log
      _ => throw UnsupportedTypeException(type ?? ''),
    };
  }
}

class AgentChunk extends ServerMessage {
  final String inReplyTo;
  final String delta;
  AgentChunk({required this.inReplyTo, required this.delta});

  factory AgentChunk.fromJson(Map<String, dynamic> j) => AgentChunk(
    inReplyTo: j['in_reply_to'] as String,
    delta: j['delta'] as String,
  );
}

class AgentDone extends ServerMessage {
  final String inReplyTo;
  final Usage? usage;
  AgentDone({required this.inReplyTo, this.usage});

  factory AgentDone.fromJson(Map<String, dynamic> j) => AgentDone(
    inReplyTo: j['in_reply_to'] as String,
    usage: j['usage'] != null
        ? Usage.fromJson(j['usage'] as Map<String, dynamic>)
        : null,
  );
}

class ToolRequest extends ServerMessage {
  final String toolCallId;
  final String tool;
  final dynamic args;
  ToolRequest({
    required this.toolCallId,
    required this.tool,
    required this.args,
  });

  factory ToolRequest.fromJson(Map<String, dynamic> j) => ToolRequest(
    toolCallId: j['tool_call_id'] as String,
    tool: j['tool'] as String,
    args: j['args'],
  );
}

class ToolResult extends ServerMessage {
  final String toolCallId;
  final dynamic result;
  final String? error;
  ToolResult({required this.toolCallId, this.result, this.error});

  factory ToolResult.fromJson(Map<String, dynamic> j) => ToolResult(
    toolCallId: j['tool_call_id'] as String,
    result: j['result'],
    error: j['error'] as String?,
  );
}

class ErrorMessage extends ServerMessage {
  final String? inReplyTo;
  final String code;
  final String message;
  ErrorMessage({this.inReplyTo, required this.code, required this.message});

  factory ErrorMessage.fromJson(Map<String, dynamic> j) => ErrorMessage(
    inReplyTo: j['in_reply_to'] as String?,
    code: j['code'] as String,
    message: j['message'] as String,
  );
}

class Cancelled extends ServerMessage {
  final String inReplyTo;
  final String targetId;
  Cancelled({required this.inReplyTo, required this.targetId});

  factory Cancelled.fromJson(Map<String, dynamic> j) => Cancelled(
    inReplyTo: j['in_reply_to'] as String,
    targetId: j['target_id'] as String,
  );
}

class Pong extends ServerMessage {
  final String inReplyTo;
  Pong({required this.inReplyTo});

  factory Pong.fromJson(Map<String, dynamic> j) =>
      Pong(inReplyTo: j['in_reply_to'] as String);
}

/// Plan/27 Wave A — identifies the agent harness the paired PC is
/// running. Surfaced as a subtitle on the PiCard ("via Pi coding
/// agent"). Pi-extension is expected to publish this in `pair_ok`
/// (contract for the next pi-extension dispatch); the app falls back
/// to a sensible default when the field is absent so legacy Pis keep
/// working.
class PiHarness {
  final String name;
  final String version;
  const PiHarness({required this.name, required this.version});

  /// Default used when `pair_ok` omits `harness` (current
  /// pi-extension behaviour) and when migrating legacy PeerRecords.
  static const PiHarness piCodingAgentUnknown = PiHarness(
    name: 'Pi coding agent',
    version: '—',
  );

  Map<String, dynamic> toJson() => {'name': name, 'version': version};

  static PiHarness fromJson(Map<String, dynamic> j) => PiHarness(
    name: (j['name'] as String?) ?? piCodingAgentUnknown.name,
    version: (j['version'] as String?) ?? piCodingAgentUnknown.version,
  );

  @override
  bool operator ==(Object other) =>
      other is PiHarness && other.name == name && other.version == version;

  @override
  int get hashCode => Object.hash(name, version);
}

class PairOk extends ServerMessage {
  final String inReplyTo;
  final String sessionName;

  /// Epoch-ms timestamp when the Pi started this session. The app caches
  /// it locally so a future `session_sync` can detect a Pi restart (value
  /// changed) and replace the cache instead of appending stale events.
  final int sessionStartedAt;

  /// Plan 17 fix — Pi-side room id (cwd-session) that confirmed this
  /// pair. The app persists this on the PeerRecord so subsequent
  /// reconnects can address the right (peer, room) directly without
  /// having to wait for subscribe_rooms / discovery. Legacy Pis that
  /// don't emit `room_id` fall back to `'main'`.
  final String roomId;

  /// Plan/27 Wave A — agent harness identification. `null` when the
  /// pi-extension hasn't been upgraded to publish it; consumers fall
  /// back to [PiHarness.piCodingAgentUnknown] so the UI never renders
  /// an empty subtitle.
  final PiHarness? harness;

  /// Plan/27 Wave A — hostname hint for the post-pair nickname modal.
  /// The pi-extension reports its OS hostname so the modal can
  /// pre-fill a sensible placeholder ("Mac do Jacob") instead of a
  /// generic "Pi". `null` on legacy Pis.
  final String? hostname;
  PairOk({
    required this.inReplyTo,
    required this.sessionName,
    required this.sessionStartedAt,
    required this.roomId,
    this.harness,
    this.hostname,
  });

  factory PairOk.fromJson(Map<String, dynamic> j) {
    final harnessJson = j['harness'];
    final hostname = j['hostname'];
    final startedAt = j['session_started_at'];
    return PairOk(
      inReplyTo: j['in_reply_to'] as String,
      sessionName: j['session_name'] as String,
      // Legacy Pis (pre-session_sync) don't emit session_started_at.
      // The downstream caller treats `0` as "unknown" and skips the
      // restart-detection branch.
      sessionStartedAt: startedAt is num ? startedAt.toInt() : 0,
      // Backward-compat: pre-fix Pis don't emit room_id → use 'main'.
      // Callers that need to distinguish "Pi said main" from "Pi
      // omitted room" should peek at the raw JSON instead.
      roomId: (j['room_id'] as String?) ?? 'main',
      harness: harnessJson is Map<String, dynamic>
          ? PiHarness.fromJson(harnessJson)
          : null,
      hostname: hostname is String && hostname.isNotEmpty ? hostname : null,
    );
  }
}

/// Mirror of user input typed directly in the Pi's terminal (or injected via
/// RPC). The Pi emits this so the app can show what was sent even though it
/// did not originate from the app's own [UserMessage] flow.
/// Parse an optional `images` array (the Pi echoes back whatever the app
/// sent on `user_message`). Returns the first image — the feature is one
/// image per message — or null when absent/empty.
WireImage? _firstImage(dynamic raw) {
  if (raw is! List || raw.isEmpty) return null;
  final first = raw.first;
  if (first is! Map) return null;
  return WireImage.fromJson(first.cast<String, dynamic>());
}

class QueuedMessageItem {
  final String id;
  final String text;
  final bool editable;
  final DateTime createdAt;

  const QueuedMessageItem({
    required this.id,
    required this.text,
    required this.editable,
    required this.createdAt,
  });

  factory QueuedMessageItem.fromJson(Map<String, dynamic> j) =>
      QueuedMessageItem(
        id: j['id'] as String,
        text: (j['text'] as String?) ?? '',
        editable: (j['editable'] as bool?) ?? true,
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          (j['created_at'] as num?)?.toInt() ?? 0,
        ),
      );
}

class QueuedMessageState extends ServerMessage {
  final List<QueuedMessageItem> items;
  QueuedMessageState({this.items = const []});

  String? get id => items.isEmpty ? null : items.first.id;
  String? get text => items.isEmpty ? null : items.first.text;

  factory QueuedMessageState.fromJson(Map<String, dynamic> j) {
    final rawItems = j['items'];
    if (rawItems is List) {
      return QueuedMessageState(
        items: rawItems
            .whereType<Map>()
            .map((m) => QueuedMessageItem.fromJson(m.cast<String, dynamic>()))
            .where((item) => item.text.isNotEmpty)
            .toList(growable: false),
      );
    }
    final id = j['id'] as String?;
    final text = j['text'] as String?;
    if (id == null || text == null || text.isEmpty) {
      return QueuedMessageState();
    }
    return QueuedMessageState(
      items: [
        QueuedMessageItem(
          id: id,
          text: text,
          editable: true,
          createdAt: DateTime.fromMillisecondsSinceEpoch(0),
        ),
      ],
    );
  }
}

class SteerConsumed extends ServerMessage {
  final String id;
  SteerConsumed({required this.id});

  factory SteerConsumed.fromJson(Map<String, dynamic> j) =>
      SteerConsumed(id: j['id'] as String);
}

class UserInput extends ServerMessage {
  final String id;
  final String text;

  /// Present when the message was sent with `streaming_behavior` (currently used
  /// for steering).
  final UserMessageStreamingBehavior? streamingBehavior;

  /// Plan/30 — echoed-back attached image (the Pi rebroadcasts `images`).
  final WireImage? image;

  UserInput({
    required this.id,
    required this.text,
    this.streamingBehavior,
    this.image,
  });

  factory UserInput.fromJson(Map<String, dynamic> j) => UserInput(
    id: j['id'] as String,
    text: j['text'] as String,
    streamingBehavior: UserMessageStreamingBehavior.fromWire(
      j['streaming_behavior'] as String?,
    ),
    image: _firstImage(j['images']),
  );
}

/// Consolidated assistant reply, used only inside `session_history` events
/// (history dumps); real-time replies still flow as `agent_chunk` +
/// `agent_done`. May also arrive standalone for backfill — treated as a
/// final assistant message for the given `inReplyTo`.
class AgentMessage extends ServerMessage {
  final String inReplyTo;
  final String text;
  final Usage? usage;
  AgentMessage({required this.inReplyTo, required this.text, this.usage});

  factory AgentMessage.fromJson(Map<String, dynamic> j) => AgentMessage(
    inReplyTo: j['in_reply_to'] as String,
    text: j['text'] as String,
    usage: j['usage'] != null
        ? Usage.fromJson(j['usage'] as Map<String, dynamic>)
        : null,
  );
}

/// Plan/32 — emitted by the Pi-extension when a context compaction finishes.
/// Rendered as a system bubble in the chat (✓ Contexto compactado + summary +
/// the token count that was reclaimed). `ts` is optional (epoch millis).
class Compaction extends ServerMessage {
  final String summary;
  final int? tokensBefore;
  final int? ts;
  Compaction({required this.summary, this.tokensBefore, this.ts});

  factory Compaction.fromJson(Map<String, dynamic> j) => Compaction(
    summary: (j['summary'] as String?) ?? '',
    tokensBefore: (j['tokens_before'] as num?)?.toInt(),
    ts: (j['ts'] as num?)?.toInt(),
  );
}

// ---------------------------------------------------------------------------
// SessionHistory + embedded event types
// ---------------------------------------------------------------------------

/// Reply to a `session_sync`. May arrive in batches; the final batch
/// sets `eos: true`. `truncated: true` indicates Pi had more events
/// than the requested `limit` and dropped the oldest — surfaced to
/// logs only (no UI affordance per plan/16 D1=B).
class SessionHistory extends ServerMessage {
  final String inReplyTo;
  final int sessionStartedAt;
  final List<SessionHistoryEvent> events;
  final bool eos;
  final bool truncated;

  /// Plan 01 — cursor for the next older page, or null when there is none.
  /// Absent on the wire (older Pi extension) reads as null: paging simply is
  /// unavailable, which is exactly the pre-feature behaviour.
  final String? olderCursor;

  /// Plan 01 — whether an older page is reachable via [olderCursor].
  final bool hasOlder;

  SessionHistory({
    required this.inReplyTo,
    required this.sessionStartedAt,
    required this.events,
    required this.eos,
    this.truncated = false,
    this.olderCursor,
    this.hasOlder = false,
  });

  factory SessionHistory.fromJson(Map<String, dynamic> j) => SessionHistory(
    inReplyTo: j['in_reply_to'] as String,
    sessionStartedAt: (j['session_started_at'] as num).toInt(),
    events: (j['events'] as List<dynamic>)
        .map((e) => SessionHistoryEvent.fromJson(e as Map<String, dynamic>))
        .toList(),
    eos: j['eos'] as bool,
    // Tolerate absence during the protocol transition window.
    truncated: (j['truncated'] as bool?) ?? false,
    olderCursor: j['older_cursor'] as String?,
    hasOlder: (j['has_older'] as bool?) ?? false,
  );
}

sealed class SessionHistoryEvent {
  final int ts;
  const SessionHistoryEvent({required this.ts});

  factory SessionHistoryEvent.fromJson(Map<String, dynamic> j) {
    final ts = (j['ts'] as num).toInt();
    return switch (j['type'] as String?) {
      'user_input' => UserInputEvt(
        ts: ts,
        id: j['id'] as String,
        text: j['text'] as String,
        image: _firstImage(j['images']),
      ),
      'tool_request' => ToolRequestEvt(
        ts: ts,
        toolCallId: j['tool_call_id'] as String,
        tool: j['tool'] as String,
        args: j['args'],
      ),
      'tool_result' => ToolResultEvt(
        ts: ts,
        toolCallId: j['tool_call_id'] as String,
        result: j['result'],
        error: j['error'] as String?,
      ),
      'agent_message' => AgentMessageEvt(
        ts: ts,
        inReplyTo: j['in_reply_to'] as String,
        text: j['text'] as String,
      ),
      // Plan/32 — compaction replayed from history so the system bubble
      // survives a re-sync.
      'compaction' => CompactionEvt(
        ts: ts,
        summary: (j['summary'] as String?) ?? '',
        tokensBefore: (j['tokens_before'] as num?)?.toInt(),
      ),
      final t => throw UnsupportedTypeException(t ?? ''),
    };
  }
}

class UserInputEvt extends SessionHistoryEvent {
  final String id;
  final String text;

  /// Plan/30 — image replayed from history (decision #8 — bytes always
  /// travel, so the bubble reconstructs on cold start / reconnect).
  final WireImage? image;

  const UserInputEvt({
    required super.ts,
    required this.id,
    required this.text,
    this.image,
  });
}

class ToolRequestEvt extends SessionHistoryEvent {
  final String toolCallId;
  final String tool;
  final dynamic args;
  const ToolRequestEvt({
    required super.ts,
    required this.toolCallId,
    required this.tool,
    required this.args,
  });
}

class ToolResultEvt extends SessionHistoryEvent {
  final String toolCallId;
  final dynamic result;
  final String? error;
  const ToolResultEvt({
    required super.ts,
    required this.toolCallId,
    this.result,
    this.error,
  });
}

class AgentMessageEvt extends SessionHistoryEvent {
  final String inReplyTo;
  final String text;
  const AgentMessageEvt({
    required super.ts,
    required this.inReplyTo,
    required this.text,
  });
}

/// Plan/32 — a context compaction replayed from `session_history`.
class CompactionEvt extends SessionHistoryEvent {
  final String summary;
  final int? tokensBefore;
  const CompactionEvt({
    required super.ts,
    required this.summary,
    this.tokensBefore,
  });
}

class PairError extends ServerMessage {
  final String inReplyTo;
  final String code;
  final String message;
  PairError({
    required this.inReplyTo,
    required this.code,
    required this.message,
  });

  factory PairError.fromJson(Map<String, dynamic> j) => PairError(
    inReplyTo: j['in_reply_to'] as String,
    code: j['code'] as String,
    message: j['message'] as String,
  );
}

/// Graceful disconnect notice sent by the Pi right before it closes the
/// channel (e.g. `/remote-pi stop`, session replaced, shutdown). The app
/// treats this as a terminal "Pi went offline" signal, stops the retry
/// loop, and surfaces a banner. Reconnect is manual.
enum ByeReason { peerStop, sessionReplaced, shutdown, unknown }

// ---------------------------------------------------------------------------
// Plan/28 — Replies for typed app actions.
//
// `action_ok` / `action_error` use the original `ActionName` so the app
// can demultiplex by intended action (no need to remember every
// in-flight request id). `models_list` is the reply to `list_models`
// and optionally echoes the model the Pi is using right now so the
// picker highlights the right row immediately.
// ---------------------------------------------------------------------------

class ActionOk extends ServerMessage {
  final String inReplyTo;
  final ActionName action;

  /// Raw wire string for `action` kept verbatim so a future Pi adds
  /// a new action without us silently dropping the ack.
  final String rawAction;
  ActionOk({
    required this.inReplyTo,
    required this.action,
    required this.rawAction,
  });

  factory ActionOk.fromJson(Map<String, dynamic> j) {
    final raw = (j['action'] as String?) ?? '';
    final parsed = ActionName.fromWire(raw);
    return ActionOk(
      inReplyTo: j['in_reply_to'] as String,
      action: parsed ?? ActionName.sessionCompact,
      rawAction: raw,
    );
  }
}

class ActionError extends ServerMessage {
  final String inReplyTo;
  final ActionName action;
  final String rawAction;
  final String error;
  ActionError({
    required this.inReplyTo,
    required this.action,
    required this.rawAction,
    required this.error,
  });

  factory ActionError.fromJson(Map<String, dynamic> j) {
    final raw = (j['action'] as String?) ?? '';
    final parsed = ActionName.fromWire(raw);
    return ActionError(
      inReplyTo: j['in_reply_to'] as String,
      action: parsed ?? ActionName.sessionCompact,
      rawAction: raw,
      error: (j['error'] as String?) ?? '',
    );
  }
}

class ModelsList extends ServerMessage {
  final String inReplyTo;
  final List<WireModel> models;

  /// Echoes the model the Pi is using right now (if it can be
  /// resolved). `null` is honest absence — the UI should fall back to
  /// the cached `model_select` event from the rooms layer.
  final WireModel? current;
  ModelsList({required this.inReplyTo, required this.models, this.current});

  factory ModelsList.fromJson(Map<String, dynamic> j) {
    final list = (j['models'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireModel.fromJson(e as Map<String, dynamic>))
        .toList();
    final cur = j['current'];
    return ModelsList(
      inReplyTo: j['in_reply_to'] as String,
      models: list,
      current: cur is Map<String, dynamic> ? WireModel.fromJson(cur) : null,
    );
  }
}

/// Plan/67 — one AgentSession in `session_list_ok`.
class WireSessionInfo {
  final String id;
  final String? name;
  final int mtime;
  final String? preview;
  final bool live;
  final String? cwd;
  const WireSessionInfo({
    required this.id,
    this.name,
    required this.mtime,
    this.preview,
    required this.live,
    this.cwd,
  });

  factory WireSessionInfo.fromJson(Map<String, dynamic> j) => WireSessionInfo(
    id: j['id'] as String,
    name: j['name'] as String?,
    mtime: (j['mtime'] as num?)?.toInt() ?? 0,
    preview: j['preview'] as String?,
    live: j['live'] as bool? ?? false,
    cwd: j['cwd'] as String?,
  );
}

class SessionListOk extends ServerMessage {
  final String inReplyTo;
  final String? currentId;
  final List<WireSessionInfo> sessions;
  SessionListOk({
    required this.inReplyTo,
    this.currentId,
    required this.sessions,
  });

  factory SessionListOk.fromJson(Map<String, dynamic> j) => SessionListOk(
    inReplyTo: j['in_reply_to'] as String,
    currentId: j['current_id'] as String?,
    sessions: (j['sessions'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireSessionInfo.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

class SessionSwitchOk extends ServerMessage {
  final String inReplyTo;
  final String sessionId;
  final int sessionStartedAt;
  SessionSwitchOk({
    required this.inReplyTo,
    required this.sessionId,
    required this.sessionStartedAt,
  });

  factory SessionSwitchOk.fromJson(Map<String, dynamic> j) => SessionSwitchOk(
    inReplyTo: j['in_reply_to'] as String,
    sessionId: j['session_id'] as String,
    sessionStartedAt: (j['session_started_at'] as num?)?.toInt() ?? 0,
  );
}

enum SessionSwitchErrorCode {
  locked('locked'),
  unknown('unknown'),
  noSdk('no_sdk');

  final String wire;
  const SessionSwitchErrorCode(this.wire);

  static SessionSwitchErrorCode fromWire(String s) => switch (s) {
    'locked' => SessionSwitchErrorCode.locked,
    'no_sdk' => SessionSwitchErrorCode.noSdk,
    _ => SessionSwitchErrorCode.unknown,
  };
}

class SessionSwitchError extends ServerMessage {
  final String inReplyTo;
  final SessionSwitchErrorCode code;
  final String message;
  SessionSwitchError({
    required this.inReplyTo,
    required this.code,
    required this.message,
  });

  factory SessionSwitchError.fromJson(Map<String, dynamic> j) =>
      SessionSwitchError(
        inReplyTo: j['in_reply_to'] as String,
        code: SessionSwitchErrorCode.fromWire((j['code'] as String?) ?? ''),
        message: (j['message'] as String?) ?? '',
      );
}

class WireWorkspaceInfo {
  final String cwd;
  final String daemonId;
  final String roomId;
  final String name;
  final bool live;
  final bool daemon;
  /// Plan/68 — `"daemon"` came from the machine's `daemons.json`;
  /// `"added"` was picked by navigating the host filesystem (or by starting
  /// an unregistered cwd) and lives in `workspaces.json`.
  final String source;
  const WireWorkspaceInfo({
    required this.cwd,
    required this.daemonId,
    required this.roomId,
    required this.name,
    required this.live,
    required this.daemon,
    this.source = 'daemon',
  });

  factory WireWorkspaceInfo.fromJson(Map<String, dynamic> j) => WireWorkspaceInfo(
    cwd: j['cwd'] as String,
    daemonId: j['daemon_id'] as String,
    roomId: j['room_id'] as String,
    name: (j['name'] as String?) ?? '',
    live: j['live'] as bool? ?? false,
    daemon: j['daemon'] as bool? ?? true,
    source: (j['source'] as String?) ?? 'daemon',
  );
}

/// Plan/68 — one entry in an `fs_list_ok` directory listing.
class WireFsEntry {
  final String name;
  /// `"dir"` | `"file"`.
  final String kind;
  /// Hint only: the directory contains a `.git` marker.
  final bool isRepo;
  const WireFsEntry({required this.name, required this.kind, this.isRepo = false});

  bool get isDir => kind == 'dir';

  factory WireFsEntry.fromJson(Map<String, dynamic> j) => WireFsEntry(
    name: j['name'] as String,
    kind: (j['kind'] as String?) ?? 'file',
    isRepo: j['is_repo'] as bool? ?? false,
  );
}

class FsListOk extends ServerMessage {
  final String inReplyTo;
  /// The host-resolved absolute realpath of the listed directory.
  final String path;
  /// `null` at the filesystem root.
  final String? parent;
  final List<WireFsEntry> entries;
  FsListOk({
    required this.inReplyTo,
    required this.path,
    required this.parent,
    required this.entries,
  });

  factory FsListOk.fromJson(Map<String, dynamic> j) => FsListOk(
    inReplyTo: j['in_reply_to'] as String,
    path: j['path'] as String,
    parent: j['parent'] as String?,
    entries: (j['entries'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireFsEntry.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

/// Plan/68 — runtime part of a `pi_surface_ok`. Every field is nullable because
/// the host reports `null` rather than fabricating a value it cannot determine.
class PiSurfaceRuntime {
  final bool running;
  /// `<provider>/<id>`, or `null` when undetermined.
  final String? model;
  final ThinkingLevel? thinking;
  const PiSurfaceRuntime({required this.running, this.model, this.thinking});

  factory PiSurfaceRuntime.fromJson(Map<String, dynamic> j) => PiSurfaceRuntime(
    running: j['running'] as bool? ?? false,
    model: j['model'] as String?,
    thinking: j['thinking'] != null
        ? ThinkingLevel.fromWire(j['thinking'] as String)
        : null,
  );
}

/// Plan/68 — where a discovered skill came from. Mirrors the extension's
/// `SkillSource` (`user` | `project` | `package`).
enum SkillSource {
  user('user'),
  project('project'),
  package('package');

  final String wire;
  const SkillSource(this.wire);

  static SkillSource fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    // Unknown provenance is reported as user rather than dropped, so an older
    // host that omits the field still renders a usable row.
    return SkillSource.user;
  }
}

/// Plan/68 — one skill in the Pi surface.
class WireSkill {
  final String name;
  final String description;
  final SkillSource source;
  /// Absolute path of the `SKILL.md` on the machine.
  final String path;
  /// `false` when an exclusion pattern disables it; `null` when the host could
  /// not determine it. Never assume `true` for `null` in the UI.
  final bool? enabled;
  /// `disable-model-invocation` — invokable only via `/skill:<name>`.
  final bool disableModelInvocation;
  const WireSkill({
    required this.name,
    required this.description,
    required this.source,
    required this.path,
    required this.enabled,
    this.disableModelInvocation = false,
  });

  factory WireSkill.fromJson(Map<String, dynamic> j) => WireSkill(
    name: j['name'] as String,
    description: (j['description'] as String?) ?? '',
    source: SkillSource.fromWire(j['source'] as String?),
    path: (j['path'] as String?) ?? '',
    enabled: j['enabled'] as bool?,
    disableModelInvocation: j['disable_model_invocation'] as bool? ?? false,
  );
}

/// Plan/68 — the scope a package is declared in.
enum PackageScope {
  user('user'),
  project('project');

  final String wire;
  const PackageScope(this.wire);

  static PackageScope fromWire(String? s) =>
      s == 'project' ? PackageScope.project : PackageScope.user;
}

/// Plan/68 — one configured Pi package.
class WirePackage {
  final String source;
  final PackageScope scope;
  /// Resource kinds the package contributes (`extensions`, `skills`, ...).
  final List<String> resources;
  const WirePackage({
    required this.source,
    required this.scope,
    this.resources = const [],
  });

  factory WirePackage.fromJson(Map<String, dynamic> j) => WirePackage(
    source: j['source'] as String,
    scope: PackageScope.fromWire(j['scope'] as String?),
    resources: (j['resources'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => e as String)
        .toList(),
  );
}

/// The operation a `package_op_ok` confirms.
enum PackageOp {
  install('install'),
  remove('remove'),
  update('update');

  final String wire;
  const PackageOp(this.wire);

  static PackageOp fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return PackageOp.update;
  }
}

class PiSurfaceOk extends ServerMessage {
  final String inReplyTo;
  final PiSurfaceRuntime runtime;
  final List<WireSkill> skills;
  final List<WirePackage> packages;
  PiSurfaceOk({
    required this.inReplyTo,
    required this.runtime,
    required this.skills,
    required this.packages,
  });

  factory PiSurfaceOk.fromJson(Map<String, dynamic> j) => PiSurfaceOk(
    inReplyTo: j['in_reply_to'] as String,
    runtime: PiSurfaceRuntime.fromJson(
      (j['runtime'] as Map<String, dynamic>?) ?? const {},
    ),
    skills: (j['skills'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireSkill.fromJson(e as Map<String, dynamic>))
        .toList(),
    packages: (j['packages'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WirePackage.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

class SkillInvokeOk extends ServerMessage {
  final String inReplyTo;
  final String name;
  SkillInvokeOk({required this.inReplyTo, required this.name});

  factory SkillInvokeOk.fromJson(Map<String, dynamic> j) => SkillInvokeOk(
    inReplyTo: j['in_reply_to'] as String,
    name: j['name'] as String,
  );
}

class SkillSetEnabledOk extends ServerMessage {
  final String inReplyTo;
  final String name;
  final bool enabled;
  SkillSetEnabledOk({
    required this.inReplyTo,
    required this.name,
    required this.enabled,
  });

  factory SkillSetEnabledOk.fromJson(Map<String, dynamic> j) => SkillSetEnabledOk(
    inReplyTo: j['in_reply_to'] as String,
    name: j['name'] as String,
    enabled: j['enabled'] as bool? ?? true,
  );
}

class PackageOpOk extends ServerMessage {
  final String inReplyTo;
  final PackageOp op;
  final String source;
  /// `null` when the op was not scoped (e.g. `package_update` with no source).
  final PackageScope? scope;
  PackageOpOk({
    required this.inReplyTo,
    required this.op,
    required this.source,
    this.scope,
  });

  factory PackageOpOk.fromJson(Map<String, dynamic> j) => PackageOpOk(
    inReplyTo: j['in_reply_to'] as String,
    op: PackageOp.fromWire(j['op'] as String?),
    source: (j['source'] as String?) ?? '',
    scope: j['scope'] != null ? PackageScope.fromWire(j['scope'] as String) : null,
  );
}

class WorkspaceListOk extends ServerMessage {
  final String inReplyTo;
  final List<WireWorkspaceInfo> workspaces;
  WorkspaceListOk({required this.inReplyTo, required this.workspaces});

  factory WorkspaceListOk.fromJson(Map<String, dynamic> j) => WorkspaceListOk(
    inReplyTo: j['in_reply_to'] as String,
    workspaces: (j['workspaces'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireWorkspaceInfo.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

class WorkspaceStartOk extends ServerMessage {
  final String inReplyTo;
  final String cwd;
  final String roomId;
  final String daemonId;
  WorkspaceStartOk({
    required this.inReplyTo,
    required this.cwd,
    required this.roomId,
    required this.daemonId,
  });

  factory WorkspaceStartOk.fromJson(Map<String, dynamic> j) => WorkspaceStartOk(
    inReplyTo: j['in_reply_to'] as String,
    cwd: j['cwd'] as String,
    roomId: j['room_id'] as String,
    daemonId: j['daemon_id'] as String,
  );
}

class WorkspaceStopOk extends ServerMessage {
  final String inReplyTo;
  final String cwd;
  final String daemonId;
  WorkspaceStopOk({
    required this.inReplyTo,
    required this.cwd,
    required this.daemonId,
  });

  factory WorkspaceStopOk.fromJson(Map<String, dynamic> j) => WorkspaceStopOk(
    inReplyTo: j['in_reply_to'] as String,
    cwd: j['cwd'] as String,
    daemonId: j['daemon_id'] as String,
  );
}

/// Plan/69 — `daemon` block of `host_hello_ok`. Every field is nullable
/// because the host reports `null` rather than fabricating a value it
/// cannot determine (PROTOCOL.md: never fabricate).
class HostDaemonInfo {
  final String? version;
  final String? hostname;
  final String? platform;
  const HostDaemonInfo({this.version, this.hostname, this.platform});

  factory HostDaemonInfo.fromJson(Map<String, dynamic> j) => HostDaemonInfo(
    version: j['version'] as String?,
    hostname: j['hostname'] as String?,
    platform: j['platform'] as String?,
  );
}

/// Plan/69 — reply to `host_hello`. `capabilities` is the closed
/// vocabulary the host actually implements (`host_pairing`,
/// `workspace_state`, `host_forward`, `fs_nav`, …).
class HostHelloOk extends ServerMessage {
  final String inReplyTo;
  final HostDaemonInfo daemon;
  final List<String> capabilities;
  HostHelloOk({
    required this.inReplyTo,
    required this.daemon,
    required this.capabilities,
  });

  factory HostHelloOk.fromJson(Map<String, dynamic> j) => HostHelloOk(
    inReplyTo: j['in_reply_to'] as String,
    daemon: HostDaemonInfo.fromJson(
      (j['daemon'] as Map<String, dynamic>?) ?? const <String, dynamic>{},
    ),
    capabilities: ((j['capabilities'] as List<dynamic>?) ?? const <dynamic>[])
        .map((e) => e as String)
        .toList(),
  );
}

/// Plan/69 — lifecycle state of a workspace Pi, mirroring the supervisor's
/// ChildSlot. Same closed union as `WorkspaceState` in
/// `pi-extension/src/protocol/types.ts`.
enum WorkspaceStateValue {
  running('running'),
  starting('starting'),
  crashed('crashed'),
  stopped('stopped');

  final String wire;
  const WorkspaceStateValue(this.wire);

  static WorkspaceStateValue fromWire(String? s) => switch (s) {
    'running' => WorkspaceStateValue.running,
    'starting' => WorkspaceStateValue.starting,
    'crashed' => WorkspaceStateValue.crashed,
    'stopped' => WorkspaceStateValue.stopped,
    // Forward-compat: a host newer than the app may add a state. Map it to
    // the least-alarming known value and keep the raw string so the UI can
    // show what actually arrived instead of guessing.
    _ => WorkspaceStateValue.stopped,
  };
}

/// Plan/69 — lifecycle PUSH from the host (NOT a reply): emitted when the
/// supervisor detects a child exit, restart (backoff), start or stop. There
/// is no `in_reply_to` — it is unsolicited. `crashed` carries `last_error`;
/// the machine connection stays online in every state.
class WorkspaceState extends ServerMessage {
  final String cwd;
  final WorkspaceStateValue state;

  /// Why the workspace crashed; `null` in every non-crashed state.
  final String? lastError;

  /// How many times the supervisor respawned this workspace.
  final int restarts;

  /// Raw wire value of `state` — kept verbatim so a state this build does
  /// not know about is still displayed honestly.
  final String rawState;

  WorkspaceState({
    required this.cwd,
    required this.state,
    required this.lastError,
    required this.restarts,
    required this.rawState,
  });

  factory WorkspaceState.fromJson(Map<String, dynamic> j) {
    final raw = (j['state'] as String?) ?? '';
    return WorkspaceState(
      cwd: (j['cwd'] as String?) ?? '',
      state: WorkspaceStateValue.fromWire(raw),
      lastError: j['last_error'] as String?,
      restarts: (j['restarts'] as num?)?.toInt() ?? 0,
      rawState: raw,
    );
  }
}

/// Plan/69 — reply to `workspace_restart`. Idempotent host-side: a running
/// workspace answers this without respawning.
class WorkspaceRestartOk extends ServerMessage {
  final String inReplyTo;
  final String cwd;
  final String daemonId;
  WorkspaceRestartOk({
    required this.inReplyTo,
    required this.cwd,
    required this.daemonId,
  });

  factory WorkspaceRestartOk.fromJson(Map<String, dynamic> j) =>
      WorkspaceRestartOk(
        inReplyTo: j['in_reply_to'] as String,
        cwd: j['cwd'] as String,
        daemonId: j['daemon_id'] as String,
      );
}

/// Plan/69 — typed refusal of `workspace_restart`. `code` is kept as the
/// raw wire string (same convention as `PairError.code` / `ErrorMessage.code`)
/// so a host newer than the app is not silently dropped.
class WorkspaceRestartError extends ServerMessage {
  final String inReplyTo;

  /// `spawn_failed` | `not_found` (closed union host-side).
  final String code;
  final String message;
  WorkspaceRestartError({
    required this.inReplyTo,
    required this.code,
    required this.message,
  });

  factory WorkspaceRestartError.fromJson(Map<String, dynamic> j) =>
      WorkspaceRestartError(
        inReplyTo: j['in_reply_to'] as String,
        code: (j['code'] as String?) ?? '',
        message: (j['message'] as String?) ?? '',
      );
}

/// Plan/69 — proxy wrapper (spike decision B): the host re-wraps a child
/// ServerMessage that arrived addressed to the machine's own Pi-key. `ct`
/// is base64 of the inner ServerMessage; `room` is the child room it came
/// from, so the client files it per workspace. Unwrapped by the transport
/// (see `host_proxy.dart`) — consumers above the channel never see it.
class HostMessage extends ServerMessage {
  final String room;
  final String ct;
  HostMessage({required this.room, required this.ct});

  factory HostMessage.fromJson(Map<String, dynamic> j) => HostMessage(
    room: (j['room'] as String?) ?? '',
    ct: (j['ct'] as String?) ?? '',
  );
}

class Bye extends ServerMessage {
  final ByeReason reason;

  /// Raw wire value (kept for logging/debugging if the enum mapping turns
  /// it into [ByeReason.unknown]).
  final String rawReason;
  Bye({required this.reason, required this.rawReason});

  factory Bye.fromJson(Map<String, dynamic> j) {
    final raw = (j['reason'] as String?) ?? '';
    return Bye(reason: _parseReason(raw), rawReason: raw);
  }

  static ByeReason _parseReason(String s) => switch (s) {
    'peer_stop' => ByeReason.peerStop,
    'session_replaced' => ByeReason.sessionReplaced,
    'shutdown' => ByeReason.shutdown,
    _ => ByeReason.unknown,
  };
}

// ---------------------------------------------------------------------------
// Plan/57 — extension_ui_request bridge (mirror SDK RPC contract)
//
// Interactive extension prompts (ask_user today, via @eko24ive/pi-ask) are
// rendered natively instead of stranding the mobile user. The wire mirrors the
// SDK's `pi --mode rpc` extension_ui_request / extension_ui_response contract
// (RpcExtensionUIRequest/Response), so the app and the Cockpit share one
// interactive-UI vocabulary. pi-ask's richer schema (multi/preview/notes) rides
// in an optional `ask` envelope; strict handling ignores it. Inert when pi-ask
// is absent (the tool doesn't exist → no frames ever arrive).
// ---------------------------------------------------------------------------

/// `select` | `confirm` | `input` | `editor` | `notify` (SDK methods). `notify`
/// is fire-and-forget; the rest expect an `extension_ui_response`.
enum ExtensionUiMethod {
  select('select'),
  confirm('confirm'),
  input('input'),
  editor('editor'),
  notify('notify');

  final String wire;
  const ExtensionUiMethod(this.wire);

  static ExtensionUiMethod? fromWire(String? s) {
    for (final m in values) {
      if (m.wire == s) return m;
    }
    return null;
  }
}

/// pi-ask AskQuestionType — `single` (one answer) | `multi` (several) |
/// `preview` (options carry a preview pane).
enum AskQuestionWireType {
  single('single'),
  multi('multi'),
  preview('preview');

  final String wire;
  const AskQuestionWireType(this.wire);

  static AskQuestionWireType? fromWire(String? s) {
    for (final t in values) {
      if (t.wire == s) return t;
    }
    return null;
  }
}

class AskOptionWire {
  final String value;
  final String label;
  final String? description;
  final String? preview;
  final bool freeform;

  const AskOptionWire({
    required this.value,
    required this.label,
    this.description,
    this.preview,
    this.freeform = false,
  });

  factory AskOptionWire.fromJson(Map<String, dynamic> j) {
    final value = (j['value'] as String?) ?? (j['label'] as String?) ?? '';
    final label = (j['label'] as String?) ?? value;
    return AskOptionWire(
      value: value,
      label: label,
      description: j['description'] as String?,
      preview: j['preview'] as String?,
      freeform: (j['freeform'] as bool?) ?? false,
    );
  }
}

class AskQuestionWire {
  final String id;
  final String label;
  final String prompt;
  final AskQuestionWireType type;
  final bool required;
  final AskQuestionWireType? presentedType;
  final AskQuestionWireType? requestedType;
  final List<AskOptionWire> options;

  const AskQuestionWire({
    required this.id,
    required this.label,
    required this.prompt,
    required this.type,
    required this.required,
    this.presentedType,
    this.requestedType,
    this.options = const <AskOptionWire>[],
  });

  factory AskQuestionWire.fromJson(Map<String, dynamic> j) => AskQuestionWire(
        id: j['id'] as String? ?? '',
        label: (j['label'] as String?) ?? (j['prompt'] as String?) ?? '',
        prompt: j['prompt'] as String? ?? '',
        type: AskQuestionWireType.fromWire(j['type'] as String?) ??
            AskQuestionWireType.single,
        required: (j['required'] as bool?) ?? false,
        presentedType:
            AskQuestionWireType.fromWire(j['presentedType'] as String?),
        requestedType:
            AskQuestionWireType.fromWire(j['requestedType'] as String?),
        options: (j['options'] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map>()
            .map((m) => AskOptionWire.fromJson(m.cast<String, dynamic>()))
            .toList(growable: false),
      );
}

/// Optional pi-ask enrichment on an `extension_ui_request`. When present, the
/// app renders the full flow (multi/preview/notes) from [questions] instead of
/// the degraded SDK method. One request carries the whole flow.
class AskEnrichmentWire {
  final String flowId;
  final String? toolCallId;
  final String source;
  final String? title;
  final List<AskQuestionWire> questions;

  const AskEnrichmentWire({
    required this.flowId,
    this.toolCallId,
    required this.source,
    this.title,
    this.questions = const <AskQuestionWire>[],
  });

  factory AskEnrichmentWire.fromJson(Map<String, dynamic> j) => AskEnrichmentWire(
        flowId: j['flow_id'] as String? ?? '',
        toolCallId: j['tool_call_id'] as String?,
        source: (j['source'] as String?) ?? 'tool',
        title: j['title'] as String?,
        questions: (j['questions'] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map>()
            .map((m) => AskQuestionWire.fromJson(m.cast<String, dynamic>()))
            .toList(growable: false),
      );
}

/// ServerMessage: interactive extension prompt. Mirrors RpcExtensionUIRequest.
/// `notifyType` is kept raw (info/warning/error) for forward-compat.
class ExtensionUiRequest extends ServerMessage {
  final String id;
  final ExtensionUiMethod method;
  final String? title;
  final String? message; // confirm
  final String? placeholder; // input
  final String? prefill; // editor
  final List<String> options; // select
  final String? notifyType; // notify
  final AskEnrichmentWire? ask;

  const ExtensionUiRequest({
    required this.id,
    required this.method,
    this.title,
    this.message,
    this.placeholder,
    this.prefill,
    this.options = const <String>[],
    this.notifyType,
    this.ask,
  });

  factory ExtensionUiRequest.fromJson(Map<String, dynamic> j) =>
      ExtensionUiRequest(
        id: j['id'] as String? ?? '',
        method: ExtensionUiMethod.fromWire(j['method'] as String?) ??
            ExtensionUiMethod.select,
        title: j['title'] as String?,
        message: j['message'] as String?,
        placeholder: j['placeholder'] as String?,
        prefill: j['prefill'] as String?,
        options: (j['options'] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        notifyType: j['notify_type'] as String?,
        ask: j['ask'] is Map<String, dynamic>
            ? AskEnrichmentWire.fromJson(j['ask'] as Map<String, dynamic>)
            : null,
      );
}

/// pi-ask RemoteAskAnswer — one question's answered parts (outbound).
class AskAnswerWire {
  final List<String> values;
  final String? customText;
  final String? note;
  final Map<String, String> optionNotes;

  const AskAnswerWire({
    this.values = const <String>[],
    this.customText,
    this.note,
    this.optionNotes = const <String, String>{},
  });

  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (values.isNotEmpty) m['values'] = values;
    if (customText != null && customText!.isNotEmpty) m['customText'] = customText;
    if (note != null && note!.isNotEmpty) m['note'] = note;
    if (optionNotes.isNotEmpty) m['optionNotes'] = optionNotes;
    return m;
  }
}

/// Optional pi-ask enrichment on an `extension_ui_response` (outbound). Carries
/// the structured answer so multi/preview/notes survive the round-trip.
class AskResponseEnrichmentWire {
  final String flowId;
  final bool isCancel;
  /// 'submit' | 'elaborate' (null when cancel). Raw string for forward-compat.
  final String? mode;
  final Map<String, AskAnswerWire> answers;

  const AskResponseEnrichmentWire({
    required this.flowId,
    this.isCancel = false,
    this.mode,
    this.answers = const <String, AskAnswerWire>{},
  });

  Map<String, dynamic> toJson() {
    if (isCancel) return {'flow_id': flowId, 'kind': 'cancel'};
    return <String, dynamic>{
      'flow_id': flowId,
      'kind': 'answer',
      if (mode != null) 'mode': mode,
      'answers': answers.map((k, v) => MapEntry(k, v.toJson())),
    };
  }
}

/// ClientMessage: response to an `extension_ui_request`. Mirrors
/// RpcExtensionUIResponse (value / confirmed / cancelled) + optional `ask`
/// envelope carrying pi-ask's structured answer.
class ExtensionUiResponse extends ClientMessage {
  final String id;
  final String? value;
  final bool? confirmed;
  final bool cancelled;
  final AskResponseEnrichmentWire? ask;

  ExtensionUiResponse({
    required this.id,
    this.value,
    this.confirmed,
    this.cancelled = false,
    this.ask,
  });

  @override
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{'type': 'extension_ui_response', 'id': id};
    if (cancelled) m['cancelled'] = true;
    if (value != null) m['value'] = value;
    if (confirmed != null) m['confirmed'] = confirmed;
    if (ask != null) m['ask'] = ask!.toJson();
    return m;
  }
}
