// Plan 86 P4 — shared rig for the history ViewModel/widget tests.
//
// Same pattern as the existing session tests: a real ConnectionManager over a
// fake IChannel, so capability negotiation, host-direct routing and the
// one-request-per-frame promises are exercised for real.

import 'dart:async';

import 'package:mobile/data/history/history_cache.dart';
import 'package:mobile/data/history/history_repository_impl.dart';
import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const testEpk = 'epk_A';
const testRoom = 'room-1';
const testDaemon = 'd1';
const testCwd = '/proj';

PeerRecord testPeerRecord() => const PeerRecord(
  remoteEpk: testEpk,
  sessionName: 'Mac',
  pairedAt: '2026-01-01T00:00:00Z',
  relayUrl: 'https://relay.example',
);

class FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _store = {};
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _store[key];
  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _store.remove(key);
    } else {
      _store[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _store.remove(key);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakePairingStorage extends PairingStorage {
  @override
  Future<List<PeerRecord>> listPeers() async => [testPeerRecord()];
  @override
  Future<PeerRecord?> loadPeer(String epk) async =>
      epk == testEpk ? testPeerRecord() : null;
  @override
  Future<void> savePeer(PeerRecord record) async {}
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {}
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async => const [];
  @override
  Future<void> deleteRooms(String epk) async {}
}

class FakeHistoryChannel implements IChannel, IControlLink {
  FakeHistoryChannel({this.capabilities = const ['workspace_history_v1']});

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
    final type = (msg.toJson()['type'] as String?) ?? '';
    sent.add(type);
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

class HistoryRig {
  HistoryRig({
    required this.conn,
    required this.ch,
    required this.repo,
    required this.cache,
    required this.metrics,
    required this.prefs,
  });

  final ConnectionManager conn;
  final FakeHistoryChannel ch;
  final HistoryRepositoryImpl repo;
  final HistoryPageCache cache;
  final HistoryMetrics metrics;
  final Preferences prefs;

  void dispose() {
    repo.dispose();
    conn.dispose();
    // The fake channel is closed by the test's addTearDown.
  }
}

Future<HistoryRig> buildHistoryRig({
  List<String> capabilities = const ['workspace_history_v1'],
  bool roomLive = false,
  Duration requestTimeout = const Duration(seconds: 2),
  FakeHistoryChannel? channel,
}) async {
  final ch = channel ?? FakeHistoryChannel(capabilities: capabilities);
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: FakePairingStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(testPeerRecord());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  if (roomLive) {
    ch.pushControl(
      const RoomAnnounced(
        peer: testEpk,
        roomId: testRoom,
        startedAt: 1,
        cwd: testCwd,
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
  final prefs = Preferences(FakeSecureStorage());
  return HistoryRig(
    conn: conn,
    ch: ch,
    repo: repo,
    cache: cache,
    metrics: metrics,
    prefs: prefs,
  );
}

String reqId(ClientMessage msg) => msg.toJson()['id'] as String;

HistorySessionWire wireSession(
  String id, {
  String? name,
  String? preview,
  int mtime = 1700000000000,
}) => HistorySessionWire(id: id, name: name, mtime: mtime, preview: preview);

HistoryListWire listWire({
  required String id,
  String? revision = 'rev-1',
  HistoryIndexStateWire indexState = HistoryIndexStateWire.ready,
  HistoryCurrentWire current = HistoryCurrentWire.empty,
  List<HistorySessionWire> sessions = const [],
  String? nextCursor,
  bool hasMore = false,
  int? retryAfterMs,
}) => HistoryListWire(
  inReplyTo: id,
  daemonId: testDaemon,
  revision: revision,
  indexState: indexState,
  current: current,
  sessions: sessions,
  nextCursor: nextCursor,
  hasMore: hasMore,
  retryAfterMs: retryAfterMs,
);

HistoryReadWire readWire({
  required String id,
  String sessionId = 's-1',
  String snapshot = 'snap-1',
  String revision = 'rev-1',
  List<HistoryItemWire> items = const [],
  String? olderCursor,
  bool hasOlder = false,
}) => HistoryReadWire(
  inReplyTo: id,
  daemonId: testDaemon,
  sessionId: sessionId,
  snapshot: snapshot,
  revision: revision,
  projection: 1,
  session: wireSession(sessionId),
  items: items,
  olderCursor: olderCursor,
  hasOlder: hasOlder,
);

HistoryItemWire userItem(String id, {String text = 'hello'}) => HistoryItemWire(
  eventId: id,
  entryId: id,
  event: {'type': 'user_input', 'ts': 1, 'id': id, 'text': text},
  bodyRefs: const [],
  parent: false,
  truncated: false,
);

HistoryItemWire assistantItem(
  String eventId, {
  required String entryId,
  String text = 'reply',
  int ts = 2,
  List<HistoryBodyRefWire> refs = const [],
  bool parent = false,
}) => HistoryItemWire(
  eventId: eventId,
  entryId: entryId,
  event: {'type': 'agent_message', 'ts': ts, 'in_reply_to': 'u1', 'text': text},
  bodyRefs: refs,
  parent: parent,
  truncated: refs.isNotEmpty,
);

HistoryBodyRefWire textRef({
  String ref = 'ref-1',
  int totalBytes = 100,
  String? preview,
  bool truncated = true,
}) => HistoryBodyRefWire(
  ref: ref,
  field: 'text',
  representation: HistoryBodyRepresentationWire.textUtf8,
  mime: null,
  totalBytes: totalBytes,
  preview: preview,
  previewTruncated: truncated,
);

HistoryError historyError(
  String id,
  HistoryErrorCodeWire code, {
  String? sessionId,
  String? revision,
  int? retryAfterMs,
}) => HistoryError(
  HistoryErrorWire(
    inReplyTo: id,
    code: code,
    daemonId: testDaemon,
    sessionId: sessionId,
    revision: revision,
    snapshot: null,
    retryAfterMs: retryAfterMs,
  ),
);

Future<void> waitUntil(
  bool Function() predicate, {
  Duration timeout = const Duration(seconds: 3),
}) async {
  final end = DateTime.now().add(timeout);
  while (!predicate()) {
    if (DateTime.now().isAfter(end)) {
      throw StateError('waitUntil timed out');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
