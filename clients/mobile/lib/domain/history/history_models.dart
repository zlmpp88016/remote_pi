// Plan 86 P4 — read-only workspace-history domain models.
//
// Pure Dart: no Flutter, no transport, no storage. The data layer maps the
// guarded wire DTOs (`protocol/history.dart`) plus the legacy `session_read`
// events into these types, and the read-only viewer renders them. Nothing here
// knows about Hive boxes, SyncService or the live transcript.
//
// Identity rule (mirrors the server contract): an item is identified by
// `eventId`. For a host-native page it is `entry_id` for 1:1 events and
// `entry_id#index` for multi-event entries; `parent` items are tool-call
// parents outside the primary cursor. Deduplicate by `eventId`, never by list
// index or timestamp.

/// What the host can honestly say about a workspace's history index.
enum HistoryIndexState { ready, building, unavailable }

/// Whether the host has a runtime authority for `current`.
enum HistoryCurrentSource { runtime, unknown }

/// Closed failure vocabulary. The first block is the host's `history_error`
/// codes; the second block is client-side and never appears on the wire.
enum HistoryErrorCode {
  building('building'),
  stale('stale'),
  notModified('not_modified'),
  unsupported('unsupported'),
  notFound('not_found'),
  invalidCursor('invalid_cursor'),
  bodyTooLarge('body_too_large'),
  invalidRequest('invalid_request'),
  internal('internal'),
  unknown('unknown'),

  /// The wire code was not recognized (forward compatibility).
  offline('offline'),

  /// The request went out and no reply arrived inside the deadline.
  timeout('timeout'),

  /// The host has no history service AND the workspace Pi is not live, so the
  /// legacy read-only path is unavailable. Browsing never starts a Pi.
  unavailable('unavailable'),

  /// The body exceeds the App's own materialization budget (see
  /// `kHistoryClientBodyMaxBytes`). The preview stays visible.
  clientBudget('client_budget'),

  /// The host's body bytes were not valid UTF-8 for a text representation.
  /// Reported instead of painting replacement characters as real content.
  malformed('malformed'),

  /// `history_list_ok.index_state="unavailable"`: the host could not read the
  /// bucket. This is NOT evidence that the workspace has no history.
  indexUnavailable('index_unavailable'),

  /// The EXPLICIT continue could not start the workspace Pi (typed host
  /// refusal or the room never became live in the bounded window). Browsing
  /// never reaches this code.
  startFailed('start_failed');

  final String wire;
  const HistoryErrorCode(this.wire);

  /// True for codes a host can actually send in `history_error`.
  bool get fromHost => switch (this) {
    building ||
    stale ||
    notModified ||
    unsupported ||
    notFound ||
    invalidCursor ||
    bodyTooLarge ||
    invalidRequest ||
    internal => true,
    unknown ||
    offline ||
    timeout ||
    unavailable ||
    clientBudget ||
    malformed ||
    indexUnavailable ||
    startFailed => false,
  };
}

/// The typed refusal a `session_switch` can answer with. Kept closed so the
/// viewer owns the sentence; `unknown` keeps the host's existence opaque.
enum HistorySwitchRefusal { locked, noSdk, unknown }

/// Typed failure for every history operation.
///
/// Carries no host prose and no path, so a page can render a client-owned
/// sentence and a test can assert the exact code.
class HistoryFailure implements Exception {
  final HistoryErrorCode code;

  /// Set only when [code] is [HistoryErrorCode.invalidRequest] and the refusal
  /// came from a `session_switch_error`.
  final HistorySwitchRefusal? switchRefusal;

  /// Suggested wait before retrying the SAME request (`building`).
  final int? retryAfterMs;

  /// Scope echoes, when the host sent them. Used only for scoped invalidation
  /// and for tests; never shown.
  final String? daemonId;
  final String? sessionId;
  final String? revision;
  final String? snapshot;

  const HistoryFailure(
    this.code, {
    this.switchRefusal,
    this.retryAfterMs,
    this.daemonId,
    this.sessionId,
    this.revision,
    this.snapshot,
  });

  @override
  String toString() => 'HistoryFailure(${code.wire})';
}

/// The byte representation a body reference materializes.
enum HistoryBodyRepresentation { textUtf8, jsonUtf8, binary }

/// Independent runtime snapshot for a workspace. `sessionId`/`ready` are null
/// when the host does not know — never "the newest file is current".
class HistoryCurrent {
  final String? sessionId;
  final bool? ready;

  /// Supervisor lifecycle state (`stopped`/`starting`/`running`/`crashed`),
  /// or null when there is no slot. Kept as the closed raw string so the UI
  /// can decide without a second enum drifting from the host.
  final String? state;
  final HistoryCurrentSource source;

  const HistoryCurrent({
    this.sessionId,
    this.ready,
    this.state,
    this.source = HistoryCurrentSource.unknown,
  });

  static const unknown = HistoryCurrent();

  bool get isKnown => sessionId != null || state != null;

  @override
  bool operator ==(Object other) =>
      other is HistoryCurrent &&
      other.sessionId == sessionId &&
      other.ready == ready &&
      other.state == state &&
      other.source == source;

  @override
  int get hashCode => Object.hash(sessionId, ready, state, source);
}

/// One session row. Deliberately has no path and no guessed `live` flag.
class HistorySessionInfo {
  final String id;
  final String? name;

  /// Newest message timestamp inside the transcript (ms since epoch).
  final int mtime;

  /// First user message, bounded host-side.
  final String? preview;

  const HistorySessionInfo({
    required this.id,
    this.name,
    this.mtime = 0,
    this.preview,
  });

  @override
  bool operator ==(Object other) =>
      other is HistorySessionInfo &&
      other.id == id &&
      other.name == name &&
      other.mtime == mtime &&
      other.preview == preview;

  @override
  int get hashCode => Object.hash(id, name, mtime, preview);
}

/// Opaque reference to one bounded payload inside one snapshot.
class HistoryBodyRef {
  final String ref;
  final String field;
  final HistoryBodyRepresentation representation;
  final String? mime;

  /// Decoded length of the FULL representation.
  final int totalBytes;

  /// Bounded preview for fields whose event value is a placeholder.
  final String? preview;

  /// True when the event carries only a bounded preview of this field.
  final bool previewTruncated;

  const HistoryBodyRef({
    required this.ref,
    required this.field,
    required this.representation,
    required this.mime,
    required this.totalBytes,
    required this.preview,
    required this.previewTruncated,
  });

  /// Stable per-item key for the viewer's body state.
  String get stateKey => '$field|$ref';

  @override
  bool operator ==(Object other) =>
      other is HistoryBodyRef &&
      other.ref == ref &&
      other.field == field &&
      other.representation == representation &&
      other.mime == mime &&
      other.totalBytes == totalBytes &&
      other.preview == preview &&
      other.previewTruncated == previewTruncated;

  @override
  int get hashCode => Object.hash(
    ref,
    field,
    representation,
    mime,
    totalBytes,
    preview,
    previewTruncated,
  );
}

// ---------------------------------------------------------------------------
// Events (the EXISTING SessionHistoryEvent vocabulary, domain-shaped)
// ---------------------------------------------------------------------------

sealed class HistoryEvent {
  final int ts;
  const HistoryEvent({required this.ts});
}

class HistoryUserEvent extends HistoryEvent {
  final String id;
  final String text;
  final String? imageData;
  final String? imageMime;

  const HistoryUserEvent({
    required super.ts,
    required this.id,
    required this.text,
    this.imageData,
    this.imageMime,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryUserEvent &&
      other.ts == ts &&
      other.id == id &&
      other.text == text &&
      other.imageData == imageData &&
      other.imageMime == imageMime;

  @override
  int get hashCode => Object.hash(ts, id, text, imageData, imageMime);
}

class HistoryAssistantEvent extends HistoryEvent {
  final String inReplyTo;
  final String text;

  const HistoryAssistantEvent({
    required super.ts,
    required this.inReplyTo,
    required this.text,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryAssistantEvent &&
      other.ts == ts &&
      other.inReplyTo == inReplyTo &&
      other.text == text;

  @override
  int get hashCode => Object.hash(ts, inReplyTo, text);
}

class HistoryToolRequestEvent extends HistoryEvent {
  final String toolCallId;
  final String tool;
  final Object? args;

  const HistoryToolRequestEvent({
    required super.ts,
    required this.toolCallId,
    required this.tool,
    this.args,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryToolRequestEvent &&
      other.ts == ts &&
      other.toolCallId == toolCallId &&
      other.tool == tool;

  @override
  int get hashCode => Object.hash(ts, toolCallId, tool);
}

class HistoryToolResultEvent extends HistoryEvent {
  final String toolCallId;
  final Object? result;
  final String? error;

  const HistoryToolResultEvent({
    required super.ts,
    required this.toolCallId,
    this.result,
    this.error,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryToolResultEvent &&
      other.ts == ts &&
      other.toolCallId == toolCallId &&
      other.error == error;

  @override
  int get hashCode => Object.hash(ts, toolCallId, error);
}

class HistoryCompactionEvent extends HistoryEvent {
  final String summary;
  final int? tokensBefore;

  const HistoryCompactionEvent({
    required super.ts,
    required this.summary,
    this.tokensBefore,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryCompactionEvent &&
      other.ts == ts &&
      other.summary == summary &&
      other.tokensBefore == tokensBefore;

  @override
  int get hashCode => Object.hash(ts, summary, tokensBefore);
}

/// A future event type. Kept so the item is not silently dropped; the viewer
/// renders a muted placeholder and the page still advances.
class HistoryUnknownEvent extends HistoryEvent {
  final String type;
  const HistoryUnknownEvent({required super.ts, required this.type});

  @override
  bool operator ==(Object other) =>
      other is HistoryUnknownEvent && other.ts == ts && other.type == type;

  @override
  int get hashCode => Object.hash(ts, type);
}

/// One history item. `parent` marks a tool-call parent prepended outside the
/// primary page cursor; `truncated` means the host omitted part of the item.
class HistoryItem {
  final String eventId;
  final String entryId;
  final HistoryEvent event;
  final List<HistoryBodyRef> bodyRefs;
  final bool parent;
  final bool truncated;

  const HistoryItem({
    required this.eventId,
    required this.entryId,
    required this.event,
    this.bodyRefs = const [],
    this.parent = false,
    this.truncated = false,
  });

  /// True when at least one field is only a bounded preview.
  bool get hasTruncatedBody => bodyRefs.any((r) => r.previewTruncated);

  @override
  bool operator ==(Object other) =>
      other is HistoryItem &&
      other.eventId == eventId &&
      other.entryId == entryId &&
      other.event == event &&
      _listEquals(other.bodyRefs, bodyRefs) &&
      other.parent == parent &&
      other.truncated == truncated;

  @override
  int get hashCode => Object.hash(
    eventId,
    entryId,
    event,
    Object.hashAll(bodyRefs),
    parent,
    truncated,
  );
}

/// `history_list_ok` result.
class HistoryWorkspaceListing {
  final String daemonId;
  final String? revision;
  final HistoryIndexState indexState;
  final HistoryCurrent current;
  final List<HistorySessionInfo> sessions;
  final String? nextCursor;
  final bool hasMore;
  final int? retryAfterMs;

  /// Wall-clock spans measured by the repository. Null when the reply came
  /// from the cache (no wire) or the sample was not taken.
  final int? queueMs;
  final int? wireMs;

  const HistoryWorkspaceListing({
    required this.daemonId,
    required this.revision,
    required this.indexState,
    required this.current,
    required this.sessions,
    required this.nextCursor,
    required this.hasMore,
    this.retryAfterMs,
    this.queueMs,
    this.wireMs,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryWorkspaceListing &&
      other.daemonId == daemonId &&
      other.revision == revision &&
      other.indexState == indexState &&
      other.current == current &&
      _listEquals(other.sessions, sessions) &&
      other.nextCursor == nextCursor &&
      other.hasMore == hasMore &&
      other.retryAfterMs == retryAfterMs;

  @override
  int get hashCode => Object.hash(
    daemonId,
    revision,
    indexState,
    current,
    Object.hashAll(sessions),
    nextCursor,
    hasMore,
    retryAfterMs,
  );
}

/// `history_read_ok` (host-native) or one legacy `session_read` page.
class HistoryPage {
  final String daemonId;
  final String sessionId;
  final String snapshot;
  final String revision;
  final int projection;
  final HistorySessionInfo session;
  final List<HistoryItem> items;
  final String? olderCursor;
  final bool hasOlder;

  /// True for a legacy `session_read` page. Legacy pages carry no snapshot /
  /// body refs and are never cached as host pages.
  final bool legacy;

  final int? queueMs;
  final int? wireMs;

  const HistoryPage({
    required this.daemonId,
    required this.sessionId,
    required this.snapshot,
    required this.revision,
    this.projection = 1,
    required this.session,
    required this.items,
    this.olderCursor,
    this.hasOlder = false,
    this.legacy = false,
    this.queueMs,
    this.wireMs,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryPage &&
      other.daemonId == daemonId &&
      other.sessionId == sessionId &&
      other.snapshot == snapshot &&
      other.revision == revision &&
      other.projection == projection &&
      other.session == session &&
      _listEquals(other.items, items) &&
      other.olderCursor == olderCursor &&
      other.hasOlder == hasOlder &&
      other.legacy == legacy;

  @override
  int get hashCode => Object.hash(
    daemonId,
    sessionId,
    snapshot,
    revision,
    projection,
    session,
    Object.hashAll(items),
    olderCursor,
    hasOlder,
    legacy,
  );
}

/// One decoded `history_body_ok` chunk. `bytes` are the representation bytes
/// of `[offsetBytes, nextOffsetBytes)` — the caller owns the streaming decode.
class HistoryBodyChunk {
  final HistoryBodyRepresentation representation;
  final String? mime;
  final int offsetBytes;
  final int nextOffsetBytes;
  final int totalBytes;
  final List<int> bytes;

  const HistoryBodyChunk({
    required this.representation,
    required this.mime,
    required this.offsetBytes,
    required this.nextOffsetBytes,
    required this.totalBytes,
    required this.bytes,
  });
}

/// Result of an EXPLICIT `workspace_start` issued by the "继续对话" action.
///
/// Browsing never calls this. The returned room id is the address the subsequent
/// single `session_switch` must use (the host may derive a different id than the
/// one the catalog listed).
class HistoryWorkspaceLaunch {
  final String cwd;
  final String roomId;
  final String daemonId;

  const HistoryWorkspaceLaunch({
    required this.cwd,
    required this.roomId,
    required this.daemonId,
  });
}

/// One fully materialized body (text or binary). Never partially decoded and
/// never silently truncated: exceeding the client budget is a typed failure.
class HistoryFullBody {
  final HistoryBodyRepresentation representation;
  final String? mime;
  final String? text;
  final List<int>? bytes;
  final int totalBytes;

  const HistoryFullBody({
    required this.representation,
    required this.mime,
    required this.text,
    required this.bytes,
    required this.totalBytes,
  });
}

// ---------------------------------------------------------------------------
// P0 metrics (scalar only — no text, no token, no ciphertext ever)
// ---------------------------------------------------------------------------

/// One client-side timing sample for the history path.
///
/// `unknown` is represented as null, never as a fabricated 0. `wireMs` is null
/// for a cache hit (nothing went on the wire) and `firstContentMs` is null
/// until a REAL item has been painted after a frame.
class HistoryMetricSample {
  final String op;
  final int? queueMs;
  final int? wireMs;
  final int? decodeApplyMs;
  final int? firstContentMs;
  final bool? cacheHit;
  final int? items;

  const HistoryMetricSample({
    required this.op,
    this.queueMs,
    this.wireMs,
    this.decodeApplyMs,
    this.firstContentMs,
    this.cacheHit,
    this.items,
  });

  HistoryMetricSample copyWith({
    int? decodeApplyMs,
    int? firstContentMs,
    bool clearFirstContent = false,
  }) => HistoryMetricSample(
    op: op,
    queueMs: queueMs,
    wireMs: wireMs,
    decodeApplyMs: decodeApplyMs ?? this.decodeApplyMs,
    firstContentMs: clearFirstContent
        ? null
        : (firstContentMs ?? this.firstContentMs),
    cacheHit: cacheHit,
    items: items,
  );

  @override
  bool operator ==(Object other) =>
      other is HistoryMetricSample &&
      other.op == op &&
      other.queueMs == queueMs &&
      other.wireMs == wireMs &&
      other.decodeApplyMs == decodeApplyMs &&
      other.firstContentMs == firstContentMs &&
      other.cacheHit == cacheHit &&
      other.items == items;

  @override
  int get hashCode => Object.hash(
    op,
    queueMs,
    wireMs,
    decodeApplyMs,
    firstContentMs,
    cacheHit,
    items,
  );
}

/// Bounded, in-memory collector. The data layer logs the scalar fields (and
/// only them) in debug builds; tests read [samples].
class HistoryMetrics {
  final int capacity;
  final List<HistoryMetricSample> _samples = [];

  HistoryMetrics({this.capacity = 64});

  List<HistoryMetricSample> get samples => List.unmodifiable(_samples);
  HistoryMetricSample? get last => _samples.isEmpty ? null : _samples.last;

  void record(HistoryMetricSample sample) {
    _samples.add(sample);
    if (_samples.length > capacity) _samples.removeAt(0);
  }

  void clear() => _samples.clear();
}

bool _listEquals<T>(List<T> a, List<T> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
