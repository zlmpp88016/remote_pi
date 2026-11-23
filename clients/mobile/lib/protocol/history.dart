// Plan 86 P4 — App-side mirror of the host-native workspace history wire.
//
// Authoritative contract: `server/src/protocol/history.ts` +
// `server/src/protocol/types.ts` (Plan 86 P1, unchanged by P2 except the body
// budget). This file parses the JSON EXACTLY as the host sends it and refuses
// shapes the contract does not describe, so a malformed/partial frame becomes
// a typed failure instead of a half-rendered page.
//
// No SDK, no Flutter, no storage: pure wire DTOs. The data layer maps these to
// `domain/history` models.
//
// Rules that are structural, not conventions:
//   * `before`, `snapshot`, `if_revision`, `body_ref` are opaque tokens. This
//     file never interprets them (no base64 decode, no path).
//   * `offset_bytes` indexes the REFERENCE'S representation bytes, never a
//     UTF-16 index and never a JSONL source offset.
//   * error codes are a closed vocabulary; an unknown code is kept as
//     [HistoryErrorCodeWire.unknown] so a future host can never make the app
//     print host text.
//   * an item's `event_id` is the identity. `entry_id` is the Pi entry id;
//     `parent: true` items are tool-call parents outside the primary cursor.
library;

/// `history_list` default/maximum page size (rows).
const int kHistoryListDefaultLimit = 50;
const int kHistoryListMaxLimit = 100;

/// `history_read` default/maximum page size (transcript ENTRIES, not events).
const int kHistoryReadDefaultLimit = 30;
const int kHistoryReadMaxLimit = 100;

/// Maximum decoded bytes of one `history_body_ok.data` chunk.
const int kHistoryBodyChunkBytes = 65536;

/// Projection version of the event ids in `history_read_ok.items`.
const int kHistoryProjection = 1;

/// The App refuses to materialize a single body larger than this even though
/// the host (P2) allows up to 256 MiB: an 8 MiB string/byte array on a phone is
/// already a UI-freezing allocation. The preview stays readable and the
/// limitation is explicit (`client_budget`), never a silent truncation.
const int kHistoryClientBodyMaxBytes = 8 * 1024 * 1024;

/// `index_state` — `building` is a STATE, never "no history".
enum HistoryIndexStateWire {
  ready('ready'),
  building('building'),
  unavailable('unavailable');

  final String wire;
  const HistoryIndexStateWire(this.wire);

  static HistoryIndexStateWire? tryParse(Object? raw) {
    for (final v in values) {
      if (v.wire == raw) return v;
    }
    return null;
  }
}

/// The byte representation a `body_ref` materializes.
enum HistoryBodyRepresentationWire {
  textUtf8('text_utf8'),
  jsonUtf8('json_utf8'),
  binary('binary');

  final String wire;
  const HistoryBodyRepresentationWire(this.wire);

  static HistoryBodyRepresentationWire? tryParse(Object? raw) {
    for (final v in values) {
      if (v.wire == raw) return v;
    }
    return null;
  }
}

/// Closed error vocabulary. [unknown] only exists for forward compatibility:
/// it is never a code the current host sends.
enum HistoryErrorCodeWire {
  building('building'),
  stale('stale'),
  notModified('not_modified'),
  unsupported('unsupported'),
  notFound('not_found'),
  invalidCursor('invalid_cursor'),
  bodyTooLarge('body_too_large'),
  invalidRequest('invalid_request'),
  internal('internal'),
  unknown('unknown');

  final String wire;
  const HistoryErrorCodeWire(this.wire);

  static HistoryErrorCodeWire parse(Object? raw) {
    for (final v in values) {
      if (v.wire == raw) return v;
    }
    return HistoryErrorCodeWire.unknown;
  }
}

/// `current.source` — `unknown` means "the host has no runtime authority",
/// not "current is the newest file".
enum HistoryCurrentSourceWire {
  runtime('runtime'),
  unknown('unknown');

  final String wire;
  const HistoryCurrentSourceWire(this.wire);

  static HistoryCurrentSourceWire parse(Object? raw) {
    for (final v in values) {
      if (v.wire == raw) return v;
    }
    return HistoryCurrentSourceWire.unknown;
  }
}

/// Thrown when a frame does not satisfy the contract. Carries the offending
/// field name (never host payload text) so tests can be specific.
class HistoryWireFormatException implements Exception {
  final String field;
  final String reason;
  const HistoryWireFormatException(this.field, this.reason);

  @override
  String toString() => 'HistoryWireFormatException($field: $reason)';
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

String _requireString(Map<String, dynamic> j, String key) {
  final v = j[key];
  if (v is String) return v;
  throw HistoryWireFormatException(key, v == null ? 'missing' : 'not a string');
}

String? _optionalString(Map<String, dynamic> j, String key) {
  final v = j[key];
  if (v == null || v is String) return v as String?;
  throw HistoryWireFormatException(key, 'not a string');
}

int _requireInt(Map<String, dynamic> j, String key) {
  final v = j[key];
  // JSON numbers arrive as int on VM platforms; accept num for robustness
  // against a JSON codec that yields double for large values.
  if (v is num && v.isFinite && v == v.roundToDouble()) return v.toInt();
  throw HistoryWireFormatException(key, v == null ? 'missing' : 'not an int');
}

int? _optionalInt(Map<String, dynamic> j, String key) {
  final v = j[key];
  if (v == null) return null;
  if (v is num && v.isFinite && v == v.roundToDouble()) return v.toInt();
  throw HistoryWireFormatException(key, 'not an int');
}

bool _optionalBool(
  Map<String, dynamic> j,
  String key, {
  bool fallback = false,
}) {
  final v = j[key];
  if (v == null) return fallback;
  if (v is bool) return v;
  throw HistoryWireFormatException(key, 'not a bool');
}

Map<String, dynamic> _requireMap(Map<String, dynamic> j, String key) {
  final v = j[key];
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.cast<String, dynamic>();
  throw HistoryWireFormatException(
    key,
    v == null ? 'missing' : 'not an object',
  );
}

List<dynamic> _optionalList(Map<String, dynamic> j, String key) {
  final v = j[key];
  if (v == null) return const <dynamic>[];
  if (v is List) return v;
  throw HistoryWireFormatException(key, 'not a list');
}

/// One session row. No path and no guessed `live` field exists in the family.
class HistorySessionWire {
  final String id;
  final String? name;
  final int mtime;
  final String? preview;

  const HistorySessionWire({
    required this.id,
    required this.name,
    required this.mtime,
    required this.preview,
  });

  factory HistorySessionWire.fromJson(Map<String, dynamic> j) =>
      HistorySessionWire(
        id: _requireString(j, 'id'),
        name: _optionalString(j, 'name'),
        mtime: _optionalInt(j, 'mtime') ?? 0,
        preview: _optionalString(j, 'preview'),
      );
}

/// Independent runtime snapshot. `session_id`/`ready` are null when unknown —
/// null is never "the newest file is current".
class HistoryCurrentWire {
  final String? sessionId;
  final bool? ready;

  /// Supervisor lifecycle state (`stopped`/`starting`/`running`/`crashed`),
  /// kept as the raw closed string. Null when the host has no slot.
  final String? state;
  final HistoryCurrentSourceWire source;

  const HistoryCurrentWire({
    required this.sessionId,
    required this.ready,
    required this.state,
    required this.source,
  });

  factory HistoryCurrentWire.fromJson(Map<String, dynamic> j) {
    final ready = j['ready'];
    if (ready != null && ready is! bool) {
      throw const HistoryWireFormatException('current.ready', 'not a bool');
    }
    return HistoryCurrentWire(
      sessionId: _optionalString(j, 'session_id'),
      ready: ready as bool?,
      state: _optionalString(j, 'state'),
      source: HistoryCurrentSourceWire.parse(j['source']),
    );
  }

  static const empty = HistoryCurrentWire(
    sessionId: null,
    ready: null,
    state: null,
    source: HistoryCurrentSourceWire.unknown,
  );
}

/// Opaque reference to one bounded payload inside one snapshot.
class HistoryBodyRefWire {
  final String ref;
  final String field;
  final HistoryBodyRepresentationWire representation;
  final String? mime;
  final int totalBytes;
  final String? preview;
  final bool previewTruncated;

  const HistoryBodyRefWire({
    required this.ref,
    required this.field,
    required this.representation,
    required this.mime,
    required this.totalBytes,
    required this.preview,
    required this.previewTruncated,
  });

  factory HistoryBodyRefWire.fromJson(Map<String, dynamic> j) {
    final representation = HistoryBodyRepresentationWire.tryParse(
      j['representation'],
    );
    if (representation == null) {
      throw const HistoryWireFormatException(
        'body_refs[].representation',
        'unknown representation',
      );
    }
    return HistoryBodyRefWire(
      ref: _requireString(j, 'ref'),
      field: _requireString(j, 'field'),
      representation: representation,
      mime: _optionalString(j, 'mime'),
      totalBytes: _optionalInt(j, 'total_bytes') ?? 0,
      preview: _optionalString(j, 'preview'),
      previewTruncated: _optionalBool(j, 'preview_truncated'),
    );
  }
}

/// One history item. `event` is kept as the raw JSON object: the data layer
/// maps the EXISTING `SessionHistoryEvent` vocabulary and tolerates future
/// event types without failing the whole page.
class HistoryItemWire {
  final String eventId;
  final String entryId;
  final Map<String, dynamic> event;
  final List<HistoryBodyRefWire> bodyRefs;
  final bool parent;
  final bool truncated;

  const HistoryItemWire({
    required this.eventId,
    required this.entryId,
    required this.event,
    required this.bodyRefs,
    required this.parent,
    required this.truncated,
  });

  factory HistoryItemWire.fromJson(Map<String, dynamic> j) {
    final refs = <HistoryBodyRefWire>[];
    for (final raw in _optionalList(j, 'body_refs')) {
      if (raw is Map<String, dynamic>) {
        refs.add(HistoryBodyRefWire.fromJson(raw));
      } else if (raw is Map) {
        refs.add(HistoryBodyRefWire.fromJson(raw.cast<String, dynamic>()));
      } else {
        throw const HistoryWireFormatException('body_refs[]', 'not an object');
      }
    }
    final event = _requireMap(j, 'event');
    // Contract requires a type and timestamp on the existing vocabulary. A
    // missing/ill-typed pair is a malformed frame, not an empty event.
    _requireString(event, 'type');
    _requireInt(event, 'ts');
    return HistoryItemWire(
      eventId: _requireString(j, 'event_id'),
      entryId: _requireString(j, 'entry_id'),
      event: event,
      bodyRefs: refs,
      parent: _optionalBool(j, 'parent'),
      truncated: _optionalBool(j, 'truncated'),
    );
  }
}

/// `history_list_ok`.
class HistoryListWire {
  final String inReplyTo;
  final String daemonId;
  final String? revision;
  final HistoryIndexStateWire indexState;
  final HistoryCurrentWire current;
  final List<HistorySessionWire> sessions;
  final String? nextCursor;
  final bool hasMore;
  final int? retryAfterMs;

  const HistoryListWire({
    required this.inReplyTo,
    required this.daemonId,
    required this.revision,
    required this.indexState,
    required this.current,
    required this.sessions,
    required this.nextCursor,
    required this.hasMore,
    required this.retryAfterMs,
  });

  factory HistoryListWire.fromJson(Map<String, dynamic> j) {
    final indexState = HistoryIndexStateWire.tryParse(j['index_state']);
    if (indexState == null) {
      throw const HistoryWireFormatException('index_state', 'unknown value');
    }
    final sessions = <HistorySessionWire>[];
    for (final raw in _optionalList(j, 'sessions')) {
      if (raw is Map<String, dynamic>) {
        sessions.add(HistorySessionWire.fromJson(raw));
      } else if (raw is Map) {
        sessions.add(HistorySessionWire.fromJson(raw.cast<String, dynamic>()));
      } else {
        throw const HistoryWireFormatException('sessions[]', 'not an object');
      }
    }
    return HistoryListWire(
      inReplyTo: _requireString(j, 'in_reply_to'),
      daemonId: _requireString(j, 'daemon_id'),
      revision: _optionalString(j, 'revision'),
      indexState: indexState,
      current: HistoryCurrentWire.fromJson(_requireMap(j, 'current')),
      sessions: sessions,
      nextCursor: _optionalString(j, 'next_cursor'),
      hasMore: _optionalBool(j, 'has_more'),
      retryAfterMs: _optionalInt(j, 'retry_after_ms'),
    );
  }
}

/// `history_read_ok`.
class HistoryReadWire {
  final String inReplyTo;
  final String daemonId;
  final String sessionId;
  final String snapshot;
  final String revision;
  final int projection;
  final HistorySessionWire session;
  final List<HistoryItemWire> items;
  final String? olderCursor;
  final bool hasOlder;

  const HistoryReadWire({
    required this.inReplyTo,
    required this.daemonId,
    required this.sessionId,
    required this.snapshot,
    required this.revision,
    required this.projection,
    required this.session,
    required this.items,
    required this.olderCursor,
    required this.hasOlder,
  });

  factory HistoryReadWire.fromJson(Map<String, dynamic> j) {
    final items = <HistoryItemWire>[];
    for (final raw in _optionalList(j, 'items')) {
      if (raw is Map<String, dynamic>) {
        items.add(HistoryItemWire.fromJson(raw));
      } else if (raw is Map) {
        items.add(HistoryItemWire.fromJson(raw.cast<String, dynamic>()));
      } else {
        throw const HistoryWireFormatException('items[]', 'not an object');
      }
    }
    return HistoryReadWire(
      inReplyTo: _requireString(j, 'in_reply_to'),
      daemonId: _requireString(j, 'daemon_id'),
      sessionId: _requireString(j, 'session_id'),
      snapshot: _requireString(j, 'snapshot'),
      revision: _requireString(j, 'revision'),
      projection: _optionalInt(j, 'projection') ?? kHistoryProjection,
      session: HistorySessionWire.fromJson(_requireMap(j, 'session')),
      items: items,
      olderCursor: _optionalString(j, 'older_cursor'),
      hasOlder: _optionalBool(j, 'has_older'),
    );
  }
}

/// `history_body_ok`.
class HistoryBodyWire {
  final String inReplyTo;
  final String daemonId;
  final String sessionId;
  final String snapshot;
  final String bodyRef;
  final HistoryBodyRepresentationWire representation;
  final String? mime;
  final int offsetBytes;
  final int nextOffsetBytes;
  final int totalBytes;
  final String data;

  const HistoryBodyWire({
    required this.inReplyTo,
    required this.daemonId,
    required this.sessionId,
    required this.snapshot,
    required this.bodyRef,
    required this.representation,
    required this.mime,
    required this.offsetBytes,
    required this.nextOffsetBytes,
    required this.totalBytes,
    required this.data,
  });

  factory HistoryBodyWire.fromJson(Map<String, dynamic> j) {
    final representation = HistoryBodyRepresentationWire.tryParse(
      j['representation'],
    );
    if (representation == null) {
      throw const HistoryWireFormatException(
        'representation',
        'unknown representation',
      );
    }
    final offset = _optionalInt(j, 'offset_bytes') ?? 0;
    final next = _requireInt(j, 'next_offset_bytes');
    final total = _requireInt(j, 'total_bytes');
    if (offset < 0 || next < offset || total < 0 || next > total) {
      throw const HistoryWireFormatException(
        'offset_bytes',
        'inconsistent chunk bounds',
      );
    }
    return HistoryBodyWire(
      inReplyTo: _requireString(j, 'in_reply_to'),
      daemonId: _requireString(j, 'daemon_id'),
      sessionId: _requireString(j, 'session_id'),
      snapshot: _requireString(j, 'snapshot'),
      bodyRef: _requireString(j, 'body_ref'),
      representation: representation,
      mime: _optionalString(j, 'mime'),
      offsetBytes: offset,
      nextOffsetBytes: next,
      totalBytes: total,
      data: _requireString(j, 'data'),
    );
  }
}

/// `history_error`. Carries no host prose and no path.
class HistoryErrorWire {
  final String inReplyTo;
  final HistoryErrorCodeWire code;
  final String? daemonId;
  final String? sessionId;
  final String? revision;
  final String? snapshot;
  final int? retryAfterMs;

  const HistoryErrorWire({
    required this.inReplyTo,
    required this.code,
    required this.daemonId,
    required this.sessionId,
    required this.revision,
    required this.snapshot,
    required this.retryAfterMs,
  });

  factory HistoryErrorWire.fromJson(Map<String, dynamic> j) => HistoryErrorWire(
    inReplyTo: _requireString(j, 'in_reply_to'),
    code: HistoryErrorCodeWire.parse(j['code']),
    daemonId: _optionalString(j, 'daemon_id'),
    sessionId: _optionalString(j, 'session_id'),
    revision: _optionalString(j, 'revision'),
    snapshot: _optionalString(j, 'snapshot'),
    retryAfterMs: _optionalInt(j, 'retry_after_ms'),
  );
}
