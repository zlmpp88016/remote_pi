// Plan 86 P4 — wire/legacy → domain mapping.
//
// All shape validation already happened in `protocol/history.dart`; this file
// only translates vocabulary. It also derives the legacy identity, because the
// Plan/71 `session_read` frame predates `event_id`:
//   * user input  → its Pi id (already stable);
//   * tool       → `tool:<tool_call_id>:req|res`;
//   * assistant  → `agent:<in_reply_to>:<ts>` (the legacy frame has no entry
//                  id; the pair is unique in practice and only used to dedupe
//                  an overlapping older page);
//   * compaction → `compaction:<ts>:<index>`.
// Legacy pages are READ-ONLY and never cached as host pages, so this identity
// never crosses a snapshot boundary.

import 'dart:convert';
import 'dart:typed_data';

import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';

HistoryIndexState _indexState(HistoryIndexStateWire wire) => switch (wire) {
  HistoryIndexStateWire.ready => HistoryIndexState.ready,
  HistoryIndexStateWire.building => HistoryIndexState.building,
  HistoryIndexStateWire.unavailable => HistoryIndexState.unavailable,
};

HistoryBodyRepresentation _representation(
  HistoryBodyRepresentationWire wire,
) => switch (wire) {
  HistoryBodyRepresentationWire.textUtf8 => HistoryBodyRepresentation.textUtf8,
  HistoryBodyRepresentationWire.jsonUtf8 => HistoryBodyRepresentation.jsonUtf8,
  HistoryBodyRepresentationWire.binary => HistoryBodyRepresentation.binary,
};

HistorySessionInfo mapSession(HistorySessionWire wire) => HistorySessionInfo(
  id: wire.id,
  name: wire.name,
  mtime: wire.mtime,
  preview: wire.preview,
);

HistoryCurrent mapCurrent(HistoryCurrentWire wire) => HistoryCurrent(
  sessionId: wire.sessionId,
  ready: wire.ready,
  state: wire.state,
  source: switch (wire.source) {
    HistoryCurrentSourceWire.runtime => HistoryCurrentSource.runtime,
    HistoryCurrentSourceWire.unknown => HistoryCurrentSource.unknown,
  },
);

HistoryBodyRef mapBodyRef(HistoryBodyRefWire wire) => HistoryBodyRef(
  ref: wire.ref,
  field: wire.field,
  representation: _representation(wire.representation),
  mime: wire.mime,
  totalBytes: wire.totalBytes,
  preview: wire.preview,
  previewTruncated: wire.previewTruncated,
);

HistoryEvent _mapWireEvent(Map<String, dynamic> event, String eventId) {
  final ts = (event['ts'] as num).toInt();
  switch (event['type']) {
    case 'user_input':
      final images = event['images'];
      String? data;
      String? mime;
      if (images is List) {
        for (final raw in images) {
          if (raw is Map) {
            final d = raw['data'];
            final m = raw['mime'];
            if (d is String && d.isNotEmpty) {
              data = d;
              mime = m is String ? m : null;
              break;
            }
          }
        }
      }
      return HistoryUserEvent(
        ts: ts,
        id: (event['id'] as String?) ?? eventId,
        text: (event['text'] as String?) ?? '',
        imageData: data,
        imageMime: mime,
      );
    case 'agent_message':
      return HistoryAssistantEvent(
        ts: ts,
        inReplyTo: (event['in_reply_to'] as String?) ?? '',
        text: (event['text'] as String?) ?? '',
      );
    case 'tool_request':
      return HistoryToolRequestEvent(
        ts: ts,
        toolCallId: (event['tool_call_id'] as String?) ?? '',
        tool: (event['tool'] as String?) ?? '',
        args: event['args'],
      );
    case 'tool_result':
      return HistoryToolResultEvent(
        ts: ts,
        toolCallId: (event['tool_call_id'] as String?) ?? '',
        result: event['result'],
        error: event['error'] as String?,
      );
    case 'compaction':
      return HistoryCompactionEvent(
        ts: ts,
        summary: (event['summary'] as String?) ?? '',
        tokensBefore: (event['tokens_before'] as num?)?.toInt(),
      );
    default:
      return HistoryUnknownEvent(
        ts: ts,
        type: (event['type'] as String?) ?? '',
      );
  }
}

HistoryItem mapItem(HistoryItemWire wire) => HistoryItem(
  eventId: wire.eventId,
  entryId: wire.entryId,
  event: _mapWireEvent(wire.event, wire.eventId),
  bodyRefs: [for (final ref in wire.bodyRefs) mapBodyRef(ref)],
  parent: wire.parent,
  truncated: wire.truncated,
);

HistoryWorkspaceListing mapListing(
  HistoryListWire wire, {
  int? queueMs,
  int? wireMs,
}) => HistoryWorkspaceListing(
  daemonId: wire.daemonId,
  revision: wire.revision,
  indexState: _indexState(wire.indexState),
  current: mapCurrent(wire.current),
  sessions: [for (final s in wire.sessions) mapSession(s)],
  nextCursor: wire.nextCursor,
  hasMore: wire.hasMore,
  retryAfterMs: wire.retryAfterMs,
  queueMs: queueMs,
  wireMs: wireMs,
);

HistoryPage mapPage(HistoryReadWire wire, {int? queueMs, int? wireMs}) =>
    HistoryPage(
      daemonId: wire.daemonId,
      sessionId: wire.sessionId,
      snapshot: wire.snapshot,
      revision: wire.revision,
      projection: wire.projection,
      session: mapSession(wire.session),
      items: [for (final item in wire.items) mapItem(item)],
      olderCursor: wire.olderCursor,
      hasOlder: wire.hasOlder,
      queueMs: queueMs,
      wireMs: wireMs,
    );

HistoryBodyChunk mapBody(HistoryBodyWire wire) => HistoryBodyChunk(
  representation: _representation(wire.representation),
  mime: wire.mime,
  offsetBytes: wire.offsetBytes,
  nextOffsetBytes: wire.nextOffsetBytes,
  totalBytes: wire.totalBytes,
  bytes: Uint8List.fromList(base64Decode(wire.data)),
);

/// Legacy `session_list_ok` → the same listing shape (index always ready,
/// no revision, no cursor).
HistoryWorkspaceListing mapLegacyListing(
  SessionListOk ok, {
  required String daemonId,
  int? queueMs,
  int? wireMs,
}) => HistoryWorkspaceListing(
  daemonId: daemonId,
  revision: null,
  indexState: HistoryIndexState.ready,
  current: HistoryCurrent(
    sessionId: ok.currentId,
    ready: null,
    state: null,
    source: ok.currentId == null
        ? HistoryCurrentSource.unknown
        : HistoryCurrentSource.runtime,
  ),
  sessions: [
    for (final s in ok.sessions)
      HistorySessionInfo(
        id: s.id,
        name: s.name,
        mtime: s.mtime,
        preview: s.preview,
      ),
  ],
  nextCursor: null,
  hasMore: false,
  queueMs: queueMs,
  wireMs: wireMs,
);

/// Legacy `session_read_ok` → a read-only page. `snapshot`/`revision` are
/// synthetic constants: they exist only to satisfy the domain shape and are
/// never used for conditional requests or caching.
HistoryPage mapLegacyPage(
  SessionReadOk ok, {
  required String daemonId,
  required String sessionId,
  int? queueMs,
  int? wireMs,
}) {
  final items = <HistoryItem>[];
  final seen = <String>{};
  for (var i = 0; i < ok.events.length; i++) {
    final event = ok.events[i];
    final id = legacyEventId(event, i);
    if (!seen.add(id)) continue;
    items.add(
      HistoryItem(eventId: id, entryId: id, event: mapLegacyEvent(event)),
    );
  }
  // Legacy carries a FRAME-level `truncated`: mark the last rendered item so
  // the viewer shows "partial", never a complete-looking transcript.
  if (ok.truncated && items.isNotEmpty) {
    final last = items.removeLast();
    items.add(
      HistoryItem(
        eventId: last.eventId,
        entryId: last.entryId,
        event: last.event,
        bodyRefs: last.bodyRefs,
        parent: last.parent,
        truncated: true,
      ),
    );
  }
  return HistoryPage(
    daemonId: daemonId,
    sessionId: sessionId,
    snapshot: 'legacy',
    revision: 'legacy',
    session: HistorySessionInfo(id: sessionId),
    items: items,
    olderCursor: ok.olderCursor,
    hasOlder: ok.hasOlder,
    legacy: true,
    queueMs: queueMs,
    wireMs: wireMs,
  );
}

String legacyEventId(SessionHistoryEvent event, int index) => switch (event) {
  UserInputEvt(:final id) => id,
  ToolRequestEvt(:final toolCallId) => 'tool:$toolCallId:req',
  ToolResultEvt(:final toolCallId) => 'tool:$toolCallId:res',
  AgentMessageEvt(:final inReplyTo, :final ts) => 'agent:$inReplyTo:$ts',
  CompactionEvt(:final ts) => 'compaction:$ts:$index',
};

HistoryEvent mapLegacyEvent(SessionHistoryEvent event) => switch (event) {
  UserInputEvt(:final ts, :final id, :final text, :final image) =>
    HistoryUserEvent(
      ts: ts,
      id: id,
      text: text,
      imageData: image?.data,
      imageMime: image?.mime,
    ),
  AgentMessageEvt(:final ts, :final inReplyTo, :final text) =>
    HistoryAssistantEvent(ts: ts, inReplyTo: inReplyTo, text: text),
  ToolRequestEvt(:final ts, :final toolCallId, :final tool, :final args) =>
    HistoryToolRequestEvent(
      ts: ts,
      toolCallId: toolCallId,
      tool: tool,
      args: args,
    ),
  ToolResultEvt(:final ts, :final toolCallId, :final result, :final error) =>
    HistoryToolResultEvent(
      ts: ts,
      toolCallId: toolCallId,
      result: result,
      error: error,
    ),
  CompactionEvt(:final ts, :final summary, :final tokensBefore) =>
    HistoryCompactionEvent(
      ts: ts,
      summary: summary,
      tokensBefore: tokensBefore,
    ),
};

/// Legacy `session_history` (some older Pi builds answer `session_read` with
/// the live-sync frame instead of `session_read_ok`). Same mapping, same
/// read-only guarantees.
HistoryPage mapLegacyHistory(
  SessionHistory history, {
  required String daemonId,
  required String sessionId,
  int? queueMs,
  int? wireMs,
}) {
  final ok = SessionReadOk(
    inReplyTo: history.inReplyTo,
    sessionId: sessionId,
    events: history.events,
    eos: history.eos,
    truncated: history.truncated,
    olderCursor: history.olderCursor,
    hasOlder: history.hasOlder,
  );
  return mapLegacyPage(
    ok,
    daemonId: daemonId,
    sessionId: sessionId,
    queueMs: queueMs,
    wireMs: wireMs,
  );
}
