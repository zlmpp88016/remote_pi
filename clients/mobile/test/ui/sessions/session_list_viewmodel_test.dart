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
  _Channel({this.startError, this.answerSessionList = true, this.silentAttempts = 0, this.switchError});
  final String? startError;

  /// When set, every `session_switch` is answered with this failure instead of
  /// an ack — the path that used to leave `switching` stuck on.
  final String? switchError;

  bool answerSessionList;

  /// Number of `session_list` requests to swallow before answering. A cold
  /// start answers exactly this way: the room is announced (so it IS live) a
  /// full 13 s before the Pi behind it can reply.
  int silentAttempts;
  int _sessionListTries = 0;

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
        _sessionListTries += 1;
        if (_sessionListTries <= silentAttempts) return; // still booting
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
        if (switchError != null) {
          _server.add(
            SessionSwitchError(
              inReplyTo: id,
              code: SessionSwitchErrorCode.unknown,
              message: switchError!,
            ),
          );
          return;
        }
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
  int silentAttempts = 0,
  bool roomLive = false,
  String? switchError,
}) async {
  final ch = _Channel(
    startError: startError,
    answerSessionList: answerSessionList,
    silentAttempts: silentAttempts,
    switchError: switchError,
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

    test('a cold start retries until the Pi answers, instead of giving up', () async {
      // Measured on the public frp path: `workspace_start_ok` returns in ~250 ms
      // and the relay announces the room immediately, but the Pi behind it only
      // answers `session_list` after ~13.7 s. A room that is live is therefore
      // NOT a room that can answer — the old code treated the announcement as
      // the gate and reported a timeout for a workspace that was coming up.
      final r = await _rig(silentAttempts: 3);
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

      // 3 silent attempts x (4 s timeout + 500 ms pause), then the answer.
      // That is longer than the old single 12 s budget, which is the point.
      await Future<void>.delayed(const Duration(seconds: 16));

      expect(
        vm.state,
        isA<SessionListReady>(),
        reason: 'a slow boot is not a dead workspace',
      );
      expect(
        r.ch.sent.where((t) => t == 'session_list').length,
        greaterThan(1),
        reason: 'giving up after the first silence is the bug being fixed',
      );
    }, timeout: const Timeout(Duration(seconds: 90)));

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

    test('a FAILED pick still leaves the list tappable', () async {
      // Regression: `switching` used to be cleared only on the success path, so
      // one failed switch left it `true` forever. The guard at the top of
      // `pick()` then dropped every later tap with no feedback, and the whole
      // session list looked dead until it was left and re-entered.
      final r = await _rig(roomLive: true, switchError: 'no sdk');
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
      expect(ok, isFalse, reason: 'the switch was refused by the host');

      // The screen may show an error, but the GATE must be released. Replaying
      // the state is how the list would see it: not `switching` any more.
      final after = vm.state;
      if (after is SessionListReady) {
        expect(
          after.switching,
          isFalse,
          reason: 'a failed switch must not disable every row',
        );
      }

      // And the decisive bit: the next tap is not swallowed by the guard.
      final setBefore = r.ch.sent.where((t) => t == 'session_switch').length;
      await vm.pick('s1');
      expect(
        r.ch.sent.where((t) => t == 'session_switch').length,
        greaterThan(setBefore),
        reason: 'the second tap must reach the wire, not be gated out',
      );
    });

    test('a switch that outlives its view model does not throw', () async {
      // `switchSession` can take a while; the user may leave the screen first.
      // `emit` is a no-op after dispose, so the reset must be safe — this pins
      // that down instead of trusting it.
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
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(vm.state, isA<SessionListReady>());

      final pending = vm.pick('s1');
      vm.dispose(); // gone before the switch resolves
      await expectLater(pending, completes);
    });
  });
}
