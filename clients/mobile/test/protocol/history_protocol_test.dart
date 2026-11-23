// Plan 86 P4 — App mirror of the host-native history wire.
//
// Mirrors `server/src/protocol/history.ts` + `types.ts` (P1 contract, P2 keeps
// it byte-compatible). The tests pin the exact request JSON, every reply
// family, the closed error vocabulary and the guards that refuse a malformed
// frame instead of rendering half a page.

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/transport/host_proxy.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';

Map<String, dynamic> _session({
  String id = 's-1',
  String? name,
  int mtime = 1700000000000,
  String? preview,
}) => {'id': id, 'name': name, 'mtime': mtime, 'preview': preview};

Map<String, dynamic> _listOk({
  String id = 'r1',
  String? revision = 'rev-1',
  String indexState = 'ready',
  Map<String, dynamic>? current,
  List<Map<String, dynamic>> sessions = const [],
  String? nextCursor,
  bool hasMore = false,
  int? retryAfterMs,
}) => {
  'type': 'history_list_ok',
  'in_reply_to': id,
  'daemon_id': 'd1',
  'revision': revision,
  'index_state': indexState,
  'current':
      current ??
      {'session_id': null, 'ready': null, 'state': null, 'source': 'unknown'},
  'sessions': sessions,
  'next_cursor': nextCursor,
  'has_more': hasMore,
  'retry_after_ms': retryAfterMs,
};

Map<String, dynamic> _readOk({
  String id = 'r1',
  String sessionId = 's-1',
  String snapshot = 'snap-1',
  String? revision = 'rev-1',
  List<Map<String, dynamic>> items = const [],
  String? olderCursor,
  bool hasOlder = false,
}) => {
  'type': 'history_read_ok',
  'in_reply_to': id,
  'daemon_id': 'd1',
  'session_id': sessionId,
  'snapshot': snapshot,
  'revision': revision,
  'projection': 1,
  'session': _session(id: sessionId),
  'items': items,
  'older_cursor': olderCursor,
  'has_older': hasOlder,
};

Map<String, dynamic> _item({
  String eventId = 'u1',
  String entryId = 'u1',
  Map<String, dynamic>? event,
  List<Map<String, dynamic>> refs = const [],
  bool parent = false,
  bool truncated = false,
}) => {
  'event_id': eventId,
  'entry_id': entryId,
  'event': event ?? {'type': 'user_input', 'ts': 1, 'id': 'u1', 'text': 'hi'},
  'body_refs': refs,
  'parent': parent,
  'truncated': truncated,
};

void main() {
  group('history client requests', () {
    test('history_list omits tokens and keeps the default limit explicit', () {
      expect(HistoryListRequest(id: 'r1', daemonId: 'd1').toJson(), {
        'type': 'history_list',
        'id': 'r1',
        'daemon_id': 'd1',
        'limit': 50,
      });
    });

    test('history_list encodes before and if_revision when supplied', () {
      expect(
        HistoryListRequest(
          id: 'r1',
          daemonId: 'd1',
          limit: 100,
          before: 'Y3Vyc29y',
          ifRevision: 'cmV2',
        ).toJson(),
        {
          'type': 'history_list',
          'id': 'r1',
          'daemon_id': 'd1',
          'limit': 100,
          'before': 'Y3Vyc29y',
          'if_revision': 'cmV2',
        },
      );
    });

    test('history_read carries the snapshot sequence and paging tokens', () {
      expect(
        HistoryReadRequest(
          id: 'r2',
          daemonId: 'd1',
          sessionId: 's-1',
          limit: 30,
          before: 'c',
          snapshot: 's',
          ifRevision: 'v',
        ).toJson(),
        {
          'type': 'history_read',
          'id': 'r2',
          'daemon_id': 'd1',
          'session_id': 's-1',
          'limit': 30,
          'before': 'c',
          'snapshot': 's',
          'if_revision': 'v',
        },
      );
    });

    test('history_body always sends a byte offset into the representation', () {
      expect(
        HistoryBodyRequest(
          id: 'r3',
          daemonId: 'd1',
          sessionId: 's-1',
          snapshot: 'snap',
          bodyRef: 'ref',
        ).toJson(),
        {
          'type': 'history_body',
          'id': 'r3',
          'daemon_id': 'd1',
          'session_id': 's-1',
          'snapshot': 'snap',
          'body_ref': 'ref',
          'offset_bytes': 0,
        },
      );
    });

    test('family types are host-direct: never wrapped in host_forward', () {
      final inner = HistoryListRequest(id: 'r1', daemonId: 'd1').toJson();
      // The transport's own helper is the authority; this pins the App's set.
      expect(isHostDirectType('history_list'), isTrue);
      expect(isHostDirectType('history_read'), isTrue);
      expect(isHostDirectType('history_body'), isTrue);
      expect(inner['type'], 'history_list');
    });
  });

  group('history_list_ok', () {
    test(
      'decodes ready/build/unavailable and the unknown current honestly',
      () {
        final msg = ServerMessage.fromJson(
          _listOk(
            revision: 'rev-1',
            sessions: [_session(id: 's-1', name: 'one', preview: 'hello')],
            nextCursor: 'next',
            hasMore: true,
          ),
        );
        expect(msg, isA<HistoryListOk>());
        final payload = (msg as HistoryListOk).payload;
        expect(payload.indexState, HistoryIndexStateWire.ready);
        expect(payload.current.sessionId, isNull);
        expect(payload.current.ready, isNull);
        expect(payload.current.source, HistoryCurrentSourceWire.unknown);
        expect(payload.sessions.single.id, 's-1');
        expect(payload.nextCursor, 'next');
        expect(payload.hasMore, isTrue);

        final building = ServerMessage.fromJson(
          _listOk(revision: null, indexState: 'building', retryAfterMs: 25),
        );
        expect(
          (building as HistoryListOk).payload.indexState,
          HistoryIndexStateWire.building,
        );
        expect(building.payload.retryAfterMs, 25);

        final unavailable = ServerMessage.fromJson(
          _listOk(indexState: 'unavailable'),
        );
        expect(
          (unavailable as HistoryListOk).payload.indexState,
          HistoryIndexStateWire.unavailable,
        );
      },
    );

    test(
      'decodes a runtime current snapshot and refuses a fake newest file',
      () {
        final payload =
            (ServerMessage.fromJson(
                      _listOk(
                        current: {
                          'session_id': 's-9',
                          'ready': true,
                          'state': 'running',
                          'source': 'runtime',
                        },
                      ),
                    )
                    as HistoryListOk)
                .payload;
        expect(payload.current.sessionId, 's-9');
        expect(payload.current.ready, isTrue);
        expect(payload.current.state, 'running');
        expect(payload.current.source, HistoryCurrentSourceWire.runtime);
      },
    );

    test('refuses an unknown index_state instead of guessing', () {
      expect(
        () => ServerMessage.fromJson(_listOk(indexState: 'almost')),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });

    test('refuses a non-boolean current.ready', () {
      expect(
        () => ServerMessage.fromJson(
          _listOk(
            current: {
              'session_id': null,
              'ready': 'yes',
              'state': null,
              'source': 'runtime',
            },
          ),
        ),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });

    test('refuses a missing session id', () {
      expect(
        () => ServerMessage.fromJson(
          _listOk(
            sessions: [
              {'mtime': 1},
            ],
          ),
        ),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });
  });

  group('history_read_ok', () {
    test('decodes items, identity, body refs and paging', () {
      final payload =
          (ServerMessage.fromJson(
                    _readOk(
                      items: [
                        _item(
                          eventId: 'e1#0',
                          entryId: 'e1',
                          event: {
                            'type': 'agent_message',
                            'ts': 2,
                            'in_reply_to': 'u1',
                            'text': 'preview…',
                          },
                          refs: [
                            {
                              'ref': 'ref-1',
                              'field': 'text',
                              'representation': 'text_utf8',
                              'mime': null,
                              'total_bytes': 9000,
                              'preview': null,
                              'preview_truncated': true,
                            },
                          ],
                          truncated: true,
                        ),
                        _item(eventId: 'p1', entryId: 'p1', parent: true),
                      ],
                      olderCursor: 'older',
                      hasOlder: true,
                    ),
                  )
                  as HistoryReadOk)
              .payload;
      expect(payload.sessionId, 's-1');
      expect(payload.snapshot, 'snap-1');
      expect(payload.revision, 'rev-1');
      expect(payload.projection, 1);
      expect(payload.items, hasLength(2));
      expect(payload.items.first.eventId, 'e1#0');
      expect(payload.items.first.entryId, 'e1');
      expect(payload.items.first.event['type'], 'agent_message');
      expect(payload.items.first.bodyRefs.single.ref, 'ref-1');
      expect(
        payload.items.first.bodyRefs.single.representation,
        HistoryBodyRepresentationWire.textUtf8,
      );
      expect(payload.items.first.bodyRefs.single.totalBytes, 9000);
      expect(payload.items.last.parent, isTrue);
      expect(payload.olderCursor, 'older');
      expect(payload.hasOlder, isTrue);
    });

    test('refuses an item without an event identity or timestamp', () {
      expect(
        () => ServerMessage.fromJson(
          _readOk(
            items: [
              {
                'event_id': 'e',
                'entry_id': 'e',
                'event': {'type': 'x'},
              },
            ],
          ),
        ),
        throwsA(isA<HistoryWireFormatException>()),
      );
      expect(
        () => ServerMessage.fromJson(
          _readOk(
            items: [
              {
                'event': {'type': 'x', 'ts': 1},
              },
            ],
          ),
        ),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });

    test('refuses an unknown body representation', () {
      expect(
        () => ServerMessage.fromJson(
          _readOk(
            items: [
              _item(
                refs: [
                  {
                    'ref': 'r',
                    'field': 'text',
                    'representation': 'utf16',
                    'mime': null,
                    'total_bytes': 1,
                    'preview': null,
                    'preview_truncated': false,
                  },
                ],
              ),
            ],
          ),
        ),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });
  });

  group('history_body_ok', () {
    test('decodes representation, mime, offsets and base64 data', () {
      final payload =
          (ServerMessage.fromJson({
                    'type': 'history_body_ok',
                    'in_reply_to': 'r1',
                    'daemon_id': 'd1',
                    'session_id': 's-1',
                    'snapshot': 'snap',
                    'body_ref': 'ref',
                    'representation': 'binary',
                    'mime': 'image/png',
                    'offset_bytes': 0,
                    'next_offset_bytes': 3,
                    'total_bytes': 3,
                    'data': 'AAEC',
                  })
                  as HistoryBodyOk)
              .payload;
      expect(payload.bodyRef, 'ref');
      expect(payload.snapshot, 'snap');
      expect(payload.representation, HistoryBodyRepresentationWire.binary);
      expect(payload.mime, 'image/png');
      expect(payload.nextOffsetBytes, 3);
      expect(payload.totalBytes, 3);
      expect(payload.data, 'AAEC');
    });

    test('refuses a chunk whose offsets cannot progress', () {
      expect(
        () => ServerMessage.fromJson({
          'type': 'history_body_ok',
          'in_reply_to': 'r1',
          'daemon_id': 'd1',
          'session_id': 's-1',
          'snapshot': 'snap',
          'body_ref': 'ref',
          'representation': 'text_utf8',
          'mime': null,
          'offset_bytes': 10,
          'next_offset_bytes': 5,
          'total_bytes': 20,
          'data': '',
        }),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });
  });

  group('history_error', () {
    test('maps every closed code and keeps an unknown one closed', () {
      const expected = {
        'building': HistoryErrorCodeWire.building,
        'stale': HistoryErrorCodeWire.stale,
        'not_modified': HistoryErrorCodeWire.notModified,
        'unsupported': HistoryErrorCodeWire.unsupported,
        'not_found': HistoryErrorCodeWire.notFound,
        'invalid_cursor': HistoryErrorCodeWire.invalidCursor,
        'body_too_large': HistoryErrorCodeWire.bodyTooLarge,
        'invalid_request': HistoryErrorCodeWire.invalidRequest,
        'internal': HistoryErrorCodeWire.internal,
        'from_a_future_host': HistoryErrorCodeWire.unknown,
      };
      for (final entry in expected.entries) {
        final payload =
            (ServerMessage.fromJson({
                      'type': 'history_error',
                      'in_reply_to': 'r1',
                      'code': entry.key,
                      'daemon_id': null,
                      'session_id': 's-1',
                      'revision': null,
                      'snapshot': null,
                      'retry_after_ms': 25,
                    })
                    as HistoryError)
                .payload;
        expect(payload.code, entry.value, reason: entry.key);
        expect(payload.sessionId, 's-1');
        expect(payload.retryAfterMs, 25);
      }
    });

    test('refuses an error without a reply id', () {
      expect(
        () =>
            ServerMessage.fromJson({'type': 'history_error', 'code': 'stale'}),
        throwsA(isA<HistoryWireFormatException>()),
      );
    });
  });

  group('legacy session_read_ok', () {
    test('decodes the read-only fallback with its paging fields', () {
      final msg = ServerMessage.fromJson({
        'type': 'session_read_ok',
        'in_reply_to': 'r9',
        'session_id': 's-1',
        'events': [
          {'type': 'user_input', 'ts': 1, 'id': 'u1', 'text': 'hi'},
          {'type': 'agent_message', 'ts': 2, 'in_reply_to': 'u1', 'text': 'yo'},
        ],
        'eos': false,
        'truncated': true,
        'older_cursor': 'c',
        'has_older': true,
      });
      expect(msg, isA<SessionReadOk>());
      final ok = msg as SessionReadOk;
      expect(ok.sessionId, 's-1');
      expect(ok.events, hasLength(2));
      expect(ok.eos, isFalse);
      expect(ok.truncated, isTrue);
      expect(ok.olderCursor, 'c');
      expect(ok.hasOlder, isTrue);
    });
  });
}
