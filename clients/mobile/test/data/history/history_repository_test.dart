// Plan 86 P4 — history repository: capability negotiation, typed failures,
// single-flight, scoped cache invalidation and the explicit once-switch.
//
// The fake channel answers the real wire frames; the repository is exercised
// against a real ConnectionManager (same rig pattern as the session list
// tests), so routing/capability behavior is not mocked away.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/history/history_cache.dart';
import 'package:mobile/data/history/history_repository_impl.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';

const _epk = 'epk_A';
const _room = 'room-1';
const _daemon = 'd1';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac',
  pairedAt: '2026-01-01T00:00:00Z',
  relayUrl: 'https://relay.example',
);

class _FakeStorage extends PairingStorage {
  @override
  Future<List<PeerRecord>> listPeers() async => [_peer()];
  @override
  Future<PeerRecord?> loadPeer(String epk) async =>
      epk == _epk ? _peer() : null;
  @override
  Future<void> savePeer(PeerRecord record) async {}
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {}
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async => const [];
  @override
  Future<void> deleteRooms(String epk) async {}
}

class _Channel implements IChannel, IControlLink {
  _Channel({this.capabilities = const ['workspace_history_v1']});

  List<String> capabilities;
  final sent = <String>[];
  final requests = <ClientMessage>[];
  Future<ServerMessage?> Function(ClientMessage msg)? handler;
  Future<void> Function(ClientMessage msg)? sendOverride;

  final _server = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();

  @override
  Stream<ServerMessage> get serverMessages => _server.stream;
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}

  @override
  Future<void> send(ClientMessage msg) async {
    sent.add(msg.toJson()['type'] as String);
    requests.add(msg);
    if (msg is HostHello) {
      if (!_server.isClosed) {
        _server.add(
          HostHelloOk(
            inReplyTo: msg.id,
            daemon: const HostDaemonInfo(),
            capabilities: capabilities,
          ),
        );
      }
      return;
    }
    final override = sendOverride;
    if (override != null) {
      await override(msg);
      return;
    }
    final fn = handler;
    if (fn == null) return;
    final reply = await fn(msg);
    if (reply != null && !_server.isClosed) _server.add(reply);
  }

  void pushControl(ControlInbound frame) {
    if (!_control.isClosed) _control.add(frame);
  }

  void push(ServerMessage message) {
    if (!_server.isClosed) _server.add(message);
  }

  int count(String type) => sent.where((t) => t == type).length;

  @override
  Future<void> close() async {
    await _server.close();
    await _control.close();
  }
}

typedef _Rig = ({
  ConnectionManager conn,
  _Channel ch,
  HistoryRepositoryImpl repo,
  HistoryPageCache cache,
  HistoryMetrics metrics,
});

Future<_Rig> _rig({
  List<String> capabilities = const ['workspace_history_v1'],
  bool roomLive = false,
  Duration requestTimeout = const Duration(seconds: 2),
}) async {
  final ch = _Channel(capabilities: capabilities);
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  if (roomLive) {
    ch.pushControl(
      const RoomAnnounced(
        peer: _epk,
        roomId: _room,
        startedAt: 1,
        cwd: '/proj',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  final cache = HistoryPageCache();
  final metrics = HistoryMetrics();
  final repo = HistoryRepositoryImpl(
    conn: conn,
    cache: cache,
    metrics: metrics,
    requestTimeout: requestTimeout,
  );
  return (conn: conn, ch: ch, repo: repo, cache: cache, metrics: metrics);
}

HistorySessionWire _session(String id, {String? name, String? preview}) =>
    HistorySessionWire(
      id: id,
      name: name,
      mtime: 1700000000000,
      preview: preview,
    );

HistoryListWire _listWire({
  required String id,
  String? revision = 'rev-1',
  HistoryIndexStateWire indexState = HistoryIndexStateWire.ready,
  HistoryCurrentWire current = HistoryCurrentWire.empty,
  List<HistorySessionWire> sessions = const [],
  String? nextCursor,
  bool hasMore = false,
}) => HistoryListWire(
  inReplyTo: id,
  daemonId: _daemon,
  revision: revision,
  indexState: indexState,
  current: current,
  sessions: sessions,
  nextCursor: nextCursor,
  hasMore: hasMore,
  retryAfterMs: null,
);

HistoryReadWire _readWire({
  required String id,
  String sessionId = 's-1',
  String snapshot = 'snap-1',
  String revision = 'rev-1',
  List<HistoryItemWire> items = const [],
  String? olderCursor,
  bool hasOlder = false,
}) => HistoryReadWire(
  inReplyTo: id,
  daemonId: _daemon,
  sessionId: sessionId,
  snapshot: snapshot,
  revision: revision,
  projection: 1,
  session: _session(sessionId),
  items: items,
  olderCursor: olderCursor,
  hasOlder: hasOlder,
);

HistoryItemWire _userItem(String id) => HistoryItemWire(
  eventId: id,
  entryId: id,
  event: {'type': 'user_input', 'ts': 1, 'id': id, 'text': 'hello'},
  bodyRefs: const [],
  parent: false,
  truncated: false,
);

HistoryError _error(
  String id,
  HistoryErrorCodeWire code, {
  String? sessionId,
  String? revision,
  int? retryAfterMs,
}) => HistoryError(
  HistoryErrorWire(
    inReplyTo: id,
    code: code,
    daemonId: _daemon,
    sessionId: sessionId,
    revision: revision,
    snapshot: null,
    retryAfterMs: retryAfterMs,
  ),
);

String _reqId(ClientMessage msg) => msg.toJson()['id'] as String;

void main() {
  group('capability negotiation', () {
    test('workspace_history_v1 selects the host-native path', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);

      expect(
        await r.repo.transportKind(_epk, daemonId: _daemon),
        HistoryTransportKind.hostV1,
      );
    });

    test(
      'a host without the capability selects the legacy read path',
      () async {
        final r = await _rig(capabilities: const []);
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);

        expect(
          await r.repo.transportKind(_epk, daemonId: _daemon),
          HistoryTransportKind.legacy,
        );
      },
    );
  });

  group('host-native list/read/body', () {
    test(
      'request deadline covers a send future that never completes',
      () async {
        final r = await _rig(requestTimeout: const Duration(milliseconds: 30));
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        r.ch.sendOverride = (_) => Completer<void>().future;
        final watch = Stopwatch()..start();
        try {
          await r.repo.listWorkspace(
            const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
          );
          fail('expected bounded send timeout');
        } on HistoryFailure catch (failure) {
          expect(failure.code, HistoryErrorCode.timeout);
        }
        expect(watch.elapsed, lessThan(const Duration(seconds: 1)));
        expect(r.ch.count('history_list'), 1);
      },
    );

    test(
      'request deadline covers a sent request with a dropped reply',
      () async {
        final r = await _rig(requestTimeout: const Duration(milliseconds: 30));
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        r.ch.handler = (_) async => null;
        final watch = Stopwatch()..start();
        try {
          await r.repo.listWorkspace(
            const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
          );
          fail('expected bounded reply timeout');
        } on HistoryFailure catch (failure) {
          expect(failure.code, HistoryErrorCode.timeout);
        }
        expect(watch.elapsed, lessThan(const Duration(seconds: 1)));
        expect(r.ch.count('history_list'), 1);
      },
    );

    test(
      'list maps the reply, caches the first page and sends a host frame',
      () async {
        final r = await _rig();
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        r.ch.handler = (msg) async {
          if (msg is HistoryListRequest) {
            return HistoryListOk(
              _listWire(
                id: _reqId(msg),
                sessions: [_session('s-1', name: 'one', preview: 'hi')],
                nextCursor: 'next',
                hasMore: true,
              ),
            );
          }
          return null;
        };

        final listing = await r.repo.listWorkspace(
          const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
        );
        expect(r.ch.count('history_list'), 1);
        expect(listing.sessions.single.id, 's-1');
        expect(listing.nextCursor, 'next');
        expect(listing.hasMore, isTrue);
        expect(r.repo.cachedWorkspace(_epk, _daemon), isNotNull);
        // No Pi control-plane call ever rides the browse path.
        expect(r.ch.count('workspace_start'), 0);
        expect(r.ch.count('session_switch'), 0);
        expect(r.ch.count('session_list'), 0);
      },
    );

    test(
      'building is reported, never turned into an empty final list',
      () async {
        final r = await _rig();
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        r.ch.handler = (msg) async {
          if (msg is HistoryListRequest) {
            return HistoryListOk(
              _listWire(
                id: _reqId(msg),
                revision: null,
                indexState: HistoryIndexStateWire.building,
                sessions: const [],
              ),
            );
          }
          return null;
        };
        final listing = await r.repo.listWorkspace(
          const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
        );
        expect(listing.indexState, HistoryIndexState.building);
        // A building page must not poison the cache with an empty catalog.
        expect(r.repo.cachedWorkspace(_epk, _daemon), isNull);
      },
    );

    test(
      'not_modified is a typed directive carrying the echoed revision',
      () async {
        final r = await _rig();
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        r.ch.handler = (msg) async {
          if (msg is HistoryListRequest) {
            return _error(
              _reqId(msg),
              HistoryErrorCodeWire.notModified,
              revision: 'rev-1',
            );
          }
          return null;
        };
        try {
          await r.repo.listWorkspace(
            const HistoryWorkspaceQuery(
              epk: _epk,
              daemonId: _daemon,
              ifRevision: 'rev-1',
            ),
          );
          fail('expected not_modified');
        } on HistoryFailure catch (failure) {
          expect(failure.code, HistoryErrorCode.notModified);
          expect(failure.revision, 'rev-1');
        }
      },
    );

    test('read maps stable ids + body refs and caches the page', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(
            _readWire(
              id: _reqId(msg),
              items: [
                _userItem('u1'),
                HistoryItemWire(
                  eventId: 'e1#0',
                  entryId: 'e1',
                  event: {
                    'type': 'agent_message',
                    'ts': 2,
                    'in_reply_to': 'u1',
                    'text': 'preview',
                  },
                  bodyRefs: [
                    HistoryBodyRefWire(
                      ref: 'ref-1',
                      field: 'text',
                      representation: HistoryBodyRepresentationWire.textUtf8,
                      mime: null,
                      totalBytes: 9000,
                      preview: null,
                      previewTruncated: true,
                    ),
                  ],
                  parent: false,
                  truncated: true,
                ),
              ],
              olderCursor: 'older',
              hasOlder: true,
            ),
          );
        }
        return null;
      };

      final page = await r.repo.readSession(
        const HistorySessionQuery(
          epk: _epk,
          daemonId: _daemon,
          sessionId: 's-1',
        ),
      );
      expect(page.snapshot, 'snap-1');
      expect(page.items, hasLength(2));
      expect(page.items[1].eventId, 'e1#0');
      expect(page.items[1].bodyRefs.single.totalBytes, 9000);
      expect(page.olderCursor, 'older');
      expect(page.hasOlder, isTrue);
      expect(r.repo.cachedNewestPage(_epk, _daemon, 's-1'), isNotNull);
      expect(r.ch.count('session_switch'), 0);
    });

    test(
      'stale invalidates the cached session and is never papered over',
      () async {
        final r = await _rig();
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        r.ch.handler = (msg) async {
          if (msg is HistoryReadRequest) {
            return HistoryReadOk(
              _readWire(id: _reqId(msg), items: [_userItem('u1')]),
            );
          }
          return null;
        };
        await r.repo.readSession(
          const HistorySessionQuery(
            epk: _epk,
            daemonId: _daemon,
            sessionId: 's-1',
          ),
        );
        expect(r.repo.cachedNewestPage(_epk, _daemon, 's-1'), isNotNull);

        r.ch.handler = (msg) async {
          if (msg is HistoryReadRequest) {
            return _error(
              _reqId(msg),
              HistoryErrorCodeWire.stale,
              sessionId: 's-1',
            );
          }
          return null;
        };
        try {
          await r.repo.readSession(
            const HistorySessionQuery(
              epk: _epk,
              daemonId: _daemon,
              sessionId: 's-1',
              snapshot: 'old',
            ),
          );
          fail('expected stale');
        } on HistoryFailure catch (failure) {
          expect(failure.code, HistoryErrorCode.stale);
        }
        expect(r.repo.cachedNewestPage(_epk, _daemon, 's-1'), isNull);
      },
    );

    test('body chunks are typed and a mismatched scope is refused', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);
      r.ch.handler = (msg) async {
        if (msg is HistoryBodyRequest) {
          return HistoryBodyOk(
            HistoryBodyWire(
              inReplyTo: msg.id,
              daemonId: _daemon,
              sessionId: 's-1',
              snapshot: 'snap-1',
              bodyRef: msg.bodyRef,
              representation: HistoryBodyRepresentationWire.textUtf8,
              mime: null,
              offsetBytes: msg.offsetBytes,
              nextOffsetBytes: 3,
              totalBytes: 3,
              data: 'aGk=',
            ),
          );
        }
        return null;
      };
      final chunk = await r.repo.readBody(
        const HistoryBodyQuery(
          epk: _epk,
          daemonId: _daemon,
          sessionId: 's-1',
          snapshot: 'snap-1',
          bodyRef: 'ref',
        ),
      );
      expect(chunk.nextOffsetBytes, 3);
      expect(chunk.bytes, [104, 105]);

      r.ch.handler = (msg) async {
        if (msg is HistoryBodyRequest) {
          return HistoryBodyOk(
            HistoryBodyWire(
              inReplyTo: msg.id,
              daemonId: _daemon,
              sessionId: 's-1',
              snapshot: 'OTHER',
              bodyRef: msg.bodyRef,
              representation: HistoryBodyRepresentationWire.textUtf8,
              mime: null,
              offsetBytes: 0,
              nextOffsetBytes: 2,
              totalBytes: 2,
              data: 'aGk=',
            ),
          );
        }
        return null;
      };
      expect(
        () => r.repo.readBody(
          const HistoryBodyQuery(
            epk: _epk,
            daemonId: _daemon,
            sessionId: 's-1',
            snapshot: 'snap-1',
            bodyRef: 'ref',
          ),
        ),
        throwsA(
          isA<HistoryFailure>().having(
            (f) => f.code,
            'code',
            HistoryErrorCode.invalidRequest,
          ),
        ),
      );
    });
  });

  group('legacy read-only fallback', () {
    test(
      'refuses to browse a stopped workspace and never starts a Pi',
      () async {
        final r = await _rig(capabilities: const []);
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        try {
          await r.repo.listWorkspace(
            const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
          );
          fail('expected unavailable');
        } on HistoryFailure catch (failure) {
          expect(failure.code, HistoryErrorCode.unavailable);
        }
        expect(r.ch.count('session_list'), 0);
        expect(r.ch.count('session_read'), 0);
        expect(r.ch.count('session_switch'), 0);
        expect(r.ch.count('workspace_start'), 0);
      },
    );

    test('reads a live Pi read-only and never switches', () async {
      final r = await _rig(capabilities: const [], roomLive: true);
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);
      r.ch.handler = (msg) async {
        if (msg is SessionList) {
          return SessionListOk(
            inReplyTo: msg.id,
            sessions: const [WireSessionInfo(id: 's-1', mtime: 1, live: true)],
            currentId: 's-1',
          );
        }
        if (msg is SessionRead) {
          return SessionReadOk(
            inReplyTo: msg.id,
            sessionId: msg.sessionId,
            events: [UserInputEvt(ts: 1, id: 'u1', text: 'hello')],
            eos: true,
            truncated: true,
          );
        }
        return null;
      };

      final listing = await r.repo.listWorkspace(
        const HistoryWorkspaceQuery(
          epk: _epk,
          daemonId: _daemon,
          roomId: _room,
        ),
      );
      expect(listing.sessions.single.id, 's-1');
      expect(listing.current.sessionId, 's-1');
      expect(listing.indexState, HistoryIndexState.ready);

      final page = await r.repo.readSession(
        const HistorySessionQuery(
          epk: _epk,
          daemonId: _daemon,
          sessionId: 's-1',
          roomId: _room,
        ),
      );
      expect(page.legacy, isTrue);
      expect(page.items.single.eventId, 'u1');
      expect(
        page.items.single.truncated,
        isTrue,
        reason: 'legacy frame-level truncation must stay visible',
      );
      expect(r.ch.count('session_list'), 1);
      expect(r.ch.count('session_read'), 1);
      expect(r.ch.count('session_switch'), 0);
      expect(r.ch.count('workspace_start'), 0);
      // Legacy pages are read-only and never cached as host pages.
      expect(r.repo.cachedNewestPage(_epk, _daemon, 's-1'), isNull);
    });
  });

  group('single-flight', () {
    test('two identical list calls share ONE wire frame', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);
      final gate = Completer<void>();
      r.ch.handler = (msg) async {
        if (msg is HistoryListRequest) {
          await gate.future;
          return HistoryListOk(
            _listWire(id: _reqId(msg), sessions: [_session('s-1')]),
          );
        }
        return null;
      };
      final a = r.repo.listWorkspace(
        const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
      );
      final b = r.repo.listWorkspace(
        const HistoryWorkspaceQuery(epk: _epk, daemonId: _daemon),
      );
      gate.complete();
      final results = await Future.wait([a, b]);
      expect(results[0].sessions.single.id, 's-1');
      expect(results[1].sessions.single.id, 's-1');
      expect(r.ch.count('history_list'), 1);
    });
  });

  group('explicit continue', () {
    test(
      'switchOnce sends exactly one frame and maps a locked refusal',
      () async {
        final r = await _rig();
        addTearDown(r.conn.dispose);
        addTearDown(r.ch.close);
        addTearDown(r.repo.dispose);
        var switches = 0;
        r.ch.handler = (msg) async {
          if (msg is SessionSwitch) {
            switches++;
            return SessionSwitchOk(
              inReplyTo: msg.id,
              sessionId: msg.sessionId,
              sessionStartedAt: 0,
            );
          }
          return null;
        };
        await r.repo.switchOnce(
          epk: _epk,
          roomId: _room,
          sessionId: 's-1',
          ackTimeout: const Duration(seconds: 1),
        );
        expect(switches, 1);

        r.ch.handler = (msg) async {
          if (msg is SessionSwitch) {
            return SessionSwitchError(
              inReplyTo: msg.id,
              code: SessionSwitchErrorCode.locked,
              message: 'locked',
            );
          }
          return null;
        };
        try {
          await r.repo.switchOnce(
            epk: _epk,
            roomId: _room,
            sessionId: 's-2',
            ackTimeout: const Duration(seconds: 1),
          );
          fail('expected a typed refusal');
        } on HistoryFailure catch (failure) {
          expect(failure.code, HistoryErrorCode.invalidRequest);
          expect(failure.switchRefusal, HistorySwitchRefusal.locked);
        }
      },
    );

    test('a missed ACK is a typed timeout, not a silent retry', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);
      r.ch.handler = (msg) async => null; // never answer
      try {
        await r.repo.switchOnce(
          epk: _epk,
          roomId: _room,
          sessionId: 's-1',
          ackTimeout: const Duration(milliseconds: 80),
        );
        fail('expected timeout');
      } on HistoryFailure catch (failure) {
        expect(failure.code, HistoryErrorCode.timeout);
      }
      expect(r.ch.count('session_switch'), 1);
    });
  });

  group('bounded, scoped cache', () {
    test(
      'the identity key separates daemon, snapshot, projection and cursor',
      () async {
        final cache = HistoryPageCache();
        final page = HistoryPage(
          daemonId: 'd1',
          sessionId: 's-1',
          snapshot: 'snap-1',
          revision: 'rev-1',
          session: const HistorySessionInfo(id: 's-1'),
          items: [
            HistoryItem(
              eventId: 'u1',
              entryId: 'u1',
              event: const HistoryUserEvent(ts: 1, id: 'u1', text: 'hello'),
            ),
          ],
        );
        final key = HistoryCacheKey(
          peer: _epk,
          daemonId: 'd1',
          sessionId: 's-1',
          snapshot: 'snap-1',
          projection: 1,
          cursor: null,
        );
        cache.putPage(key, page);
        expect(cache.lookupPage(key), isNotNull);

        // Every component is load-bearing. Dropping one would serve this page
        // for a different workspace/generation/projection/cursor.
        expect(
          cache.lookupPage(
            HistoryCacheKey(
              peer: _epk,
              daemonId: 'd2',
              sessionId: 's-1',
              snapshot: 'snap-1',
              projection: 1,
              cursor: null,
            ),
          ),
          isNull,
          reason: 'a different workspace must not share the page',
        );
        expect(
          cache.lookupPage(
            HistoryCacheKey(
              peer: _epk,
              daemonId: 'd1',
              sessionId: 's-1',
              snapshot: 'snap-2',
              projection: 1,
              cursor: null,
            ),
          ),
          isNull,
          reason: 'a different generation must not share the page',
        );
        expect(
          cache.lookupPage(
            HistoryCacheKey(
              peer: _epk,
              daemonId: 'd1',
              sessionId: 's-1',
              snapshot: 'snap-1',
              projection: 2,
              cursor: null,
            ),
          ),
          isNull,
          reason: 'a different projection must not share the page',
        );
        expect(
          cache.lookupPage(
            HistoryCacheKey(
              peer: _epk,
              daemonId: 'd1',
              sessionId: 's-1',
              snapshot: 'snap-1',
              projection: 1,
              cursor: 'other',
            ),
          ),
          isNull,
          reason: 'a different cursor must not share the page',
        );
      },
    );

    test('evicts by bytes and by distinct session keys', () {
      final cache = HistoryPageCache();
      final bigText = 'x' * (900 * 1024);
      for (var i = 0; i < 9; i++) {
        cache.putPage(
          HistoryCacheKey(
            peer: _epk,
            daemonId: _daemon,
            sessionId: 's-$i',
            snapshot: 'snap',
            projection: 1,
            cursor: null,
          ),
          HistoryPage(
            daemonId: _daemon,
            sessionId: 's-$i',
            snapshot: 'snap',
            revision: 'rev',
            session: HistorySessionInfo(id: 's-$i'),
            items: [
              HistoryItem(
                eventId: 'e$i',
                entryId: 'e$i',
                event: HistoryAssistantEvent(
                  ts: 1,
                  inReplyTo: 'u$i',
                  text: bigText,
                ),
              ),
            ],
          ),
        );
      }
      expect(
        cache.sessionKeyCount,
        lessThanOrEqualTo(HistoryPageCache.maxSessions),
      );
      expect(cache.totalBytes, lessThanOrEqualTo(HistoryPageCache.maxBytes));
      // The oldest session was evicted; the newest survives.
      expect(
        cache.lookupNewestPage(_epk, _daemon, 's-0'),
        isNull,
        reason: 'oldest page should be evicted first',
      );
      expect(cache.lookupNewestPage(_epk, _daemon, 's-8'), isNotNull);
    });

    test('invalidation is scoped to one session/workspace/peer', () {
      final cache = HistoryPageCache();
      HistoryPage page(String daemon, String session) => HistoryPage(
        daemonId: daemon,
        sessionId: session,
        snapshot: 'snap',
        revision: 'rev',
        session: HistorySessionInfo(id: session),
        items: const [],
      );
      HistoryCacheKey key(String daemon, String session) => HistoryCacheKey(
        peer: _epk,
        daemonId: daemon,
        sessionId: session,
        snapshot: 'snap',
        projection: 1,
        cursor: null,
      );
      cache.putPage(key('d1', 's1'), page('d1', 's1'));
      cache.putPage(key('d1', 's2'), page('d1', 's2'));
      cache.putPage(key('d2', 's1'), page('d2', 's1'));

      cache.invalidateSession(_epk, 'd1', 's1');
      expect(cache.lookupPage(key('d1', 's1')), isNull);
      expect(cache.lookupPage(key('d1', 's2')), isNotNull);
      expect(cache.lookupPage(key('d2', 's1')), isNotNull);

      cache.invalidateWorkspace(_epk, 'd1');
      expect(cache.lookupPage(key('d1', 's2')), isNull);
      expect(cache.lookupPage(key('d2', 's1')), isNotNull);

      cache.invalidatePeer(_epk);
      expect(cache.lookupPage(key('d2', 's1')), isNull);
    });
  });

  group('P0 metrics and reconnect invalidation', () {
    test('records scalar spans with null (never fake 0) for unknown', () {
      final metrics = HistoryMetrics();
      metrics.record(
        const HistoryMetricSample(op: 'history_read', cacheHit: true, items: 3),
      );
      final sample = metrics.last!;
      expect(sample.op, 'history_read');
      expect(sample.wireMs, isNull);
      expect(sample.decodeApplyMs, isNull);
      expect(sample.firstContentMs, isNull);
      expect(sample.cacheHit, isTrue);
      expect(sample.items, 3);
    });

    test('a peer going offline invalidates only that peer cache', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);
      addTearDown(r.repo.dispose);
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(
            _readWire(id: _reqId(msg), items: [_userItem('u1')]),
          );
        }
        return null;
      };
      await r.repo.readSession(
        const HistorySessionQuery(
          epk: _epk,
          daemonId: _daemon,
          sessionId: 's-1',
        ),
      );
      expect(r.repo.cachedNewestPage(_epk, _daemon, 's-1'), isNotNull);

      await r.conn.disconnectPeer(_epk);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(r.repo.cachedNewestPage(_epk, _daemon, 's-1'), isNull);
    });
  });
}
