// Regression tests for the two defects found while walking the three layers on
// a real Android device over the public relay:
//
//   1. Opening a workspace that is NOT live put the screen on a 12 s request
//      timeout, because `reload()` asked a room nothing was listening on.
//   2. `pick()` set `switching = true` and never cleared it, and since every
//      row is `ListTile(enabled: !switching)` that left the whole list dead
//      until the user left the screen.
//
// Both are cheap to assert here and expensive to notice by hand, which is
// exactly why they survived until a device walk.
import 'dart:async';

import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/sessions/states/session_list_state.dart';
import 'package:mobile/ui/sessions/viewmodels/session_list_viewmodel.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _epk = 'epk_A';
const _room = 'room-1';

PeerRecord _peer() => PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac',
  pairedAt: '2026-01-01T00:00:00Z',
  relayUrl: 'https://relay.example',
);

/// Minimal secure-storage stand-in so `Preferences` never touches the platform
/// channel (which needs `TestWidgetsFlutterBinding`).
class _FakeSecureStorage implements FlutterSecureStorage {
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
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

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

/// Answers the two actions this screen issues. `session_list` is deliberately
/// silent when [answerSessionList] is false — that is what the old code walked
/// into and what the 12 s timeout was made of.
class _Channel implements IChannel, IControlLink {
  _Channel({this.startError, this.answerSessionList = true});

  final String? startError;
  bool answerSessionList;

  final _server = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();

  final sent = <String>[];

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
    if (_server.isClosed) return;
    switch (msg) {
      case WorkspaceStart(:final id, :final cwd):
        if (startError != null) {
          _server.add(
            ActionError(
              inReplyTo: id,
              action: ActionName.workspaceStart,
              rawAction: 'workspace_start',
              error: startError!,
            ),
          );
        } else {
          _server.add(
            WorkspaceStartOk(
              inReplyTo: id,
              cwd: cwd ?? '/proj',
              roomId: _room,
              daemonId: 'd1',
            ),
          );
          // The real host announces the room once the daemon subscribes. Do it
          // here too, otherwise the post-start liveness poll would spin the
          // full window and this test would be measuring the fixture, not the
          // behaviour.
          _control.add(
            const RoomAnnounced(
              peer: _epk,
              roomId: _room,
              startedAt: 1,
              cwd: '/proj',
            ),
          );
        }
      case SessionList(:final id):
        if (!answerSessionList) return; // the silent room: no reply at all
        _server.add(
          SessionListOk(
            inReplyTo: id,
            sessions: const [
              WireSessionInfo(
                id: 's1',
                name: 'one',
                mtime: 0,
                live: true,
              ),
            ],
            currentId: 's1',
          ),
        );
      case SessionSwitch(:final id):
        _server.add(
          SessionSwitchOk(
            inReplyTo: id,
            sessionId: 's1',
            sessionStartedAt: 0,
          ),
        );
      default:
        // Anything else is not this screen's business.
        break;
    }
  }

  /// Lets the rig push a control frame (e.g. `room_announced`) as if the relay
  /// sent it.
  void pushControl(ControlInbound frame) {
    if (!_control.isClosed) _control.add(frame);
  }

  @override
  Future<void> close() async {
    await _server.close();
    await _control.close();
  }
}

Future<({ConnectionManager conn, _Channel ch})> _rig({
  String? startError,
  bool answerSessionList = true,
  bool roomLive = false,
}) async {
  final ch = _Channel(
    startError: startError,
    answerSessionList: answerSessionList,
  );
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  if (roomLive) {
    // `isRoomLive` is driven by what the relay announces, so announce it — a
    // test that skips this exercises the "not live" branch by accident.
    ch.pushControl(
      const RoomAnnounced(peer: _epk, roomId: _room, startedAt: 1, cwd: '/proj'),
    );
    await Future<void>.delayed(const Duration(milliseconds: 30));
    if (!conn.isRoomLive(_epk, _room)) {
      throw StateError('rig: room $_room did not become live');
    }
  }
  return (conn: conn, ch: ch);
}

void main() {
  group('SessionListViewModel — a workspace that is not live', () {
    test('asks the host to start it instead of timing out on its room', () async {
      final r = await _rig();
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);

      final vm = SessionListViewModel(
        SessionCatalog(r.conn),
        r.conn,
        Preferences(_FakeSecureStorage()),
        epk: _epk,
        roomId: 'stale-room', // not live, and the wrong id on purpose
        cwd: '/proj',
      );
      addTearDown(vm.dispose);

      await Future<void>.delayed(const Duration(milliseconds: 120));

      await Future<void>.delayed(const Duration(milliseconds: 120));

      expect(
        r.ch.sent,
        contains('workspace_start'),
        reason: 'a room with nothing on it must be started, not queried',
      );
      expect(
        vm.state,
        isA<SessionListReady>(),
        reason: 'the start answered, so the list must load',
      );
    });

    test('a refused start surfaces a reason instead of a 12 s timeout', () async {
      // The daemon refuses when another Pi already owns the folder.
      final r = await _rig(startError: 'lock_held');
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);

      final vm = SessionListViewModel(
        SessionCatalog(r.conn),
        r.conn,
        Preferences(_FakeSecureStorage()),
        epk: _epk,
        roomId: 'stale-room',
        cwd: '/proj',
      );
      addTearDown(vm.dispose);

      await Future<void>.delayed(const Duration(milliseconds: 120));

      final s = vm.state;
      expect(s, isA<SessionListError>());
      expect(
        (s as SessionListError).message.contains('timeout'),
        isFalse,
        reason: 'a refusal has a reason; a timeout has none',
      );
      expect(
        r.ch.sent,
        isNot(contains('session_list')),
        reason: 'nothing to list — do not ask the dead room',
      );
    });
  });

  group('SessionListViewModel — switching gate', () {
    test('pick() clears `switching` so the list is usable again', () async {
      final r = await _rig(roomLive: true);
      addTearDown(r.conn.dispose);
      addTearDown(r.ch.close);

      final vm = SessionListViewModel(
        SessionCatalog(r.conn),
        r.conn,
        Preferences(_FakeSecureStorage()),
        epk: _epk,
        roomId: _room,
        cwd: '/proj',
      );
      addTearDown(vm.dispose);

      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(vm.state, isA<SessionListReady>());

      final ok = await vm.pick('s1');
      expect(ok, isTrue);

      final s = vm.state as SessionListReady;
      expect(
        s.switching,
        isFalse,
        reason: 'a stuck `switching` disables every row with no way back',
      );

      // The real test of the flag: a second pick must not be refused.
      final again = await vm.pick('s1');
      expect(again, isTrue, reason: 'the second pick must not be gated out');
    });
  });
}
