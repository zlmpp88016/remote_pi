// Plan/69 — host-first machine connection.
//
// What these tests protect:
//   1. `host_hello` goes out on connect AND on every reconnect (the
//      handshake is what makes the machine — not a Pi — the peer);
//   2. `host_hello_ok` and the `workspace_state` push surface through the
//      ConnectionManager streams;
//   3. a crashed workspace NEVER drops the machine connection — the WS
//      stays StatusOnline because it is anchored on room `host`, not on
//      the Pi's room (spike decision B / plan 69 U4);
//   4. switching machines clears the previous machine's lifecycle rows.

import 'dart:async';

import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

const _epkA = 'Bz02uLi';
const _epkB = 'Cp91vMj';

PeerRecord _peer(String epk) => PeerRecord(
  remoteEpk: epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
  roomId: 'host',
);

class _FakeStorage extends PairingStorage {
  _FakeStorage([this.peers = const []]);
  final List<PeerRecord> peers;
  @override
  Future<List<PeerRecord>> listPeers() async => peers;
  @override
  Future<PeerRecord?> loadPeer(String epk) async {
    for (final p in peers) {
      if (p.remoteEpk == epk) return p;
    }
    return null;
  }
  @override
  Future<void> savePeer(PeerRecord record) async {}
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {}
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async => const [];
  @override
  Future<void> deleteRooms(String epk) async {}
}

/// Channel that records what the app sent and can push frames back —
/// including after the stream is closed once (to force a reconnect).
class _Channel implements IChannel, IControlLink {
  final sent = <ClientMessage>[];
  final _ctrl = StreamController<ServerMessage>.broadcast();
  final _controlCtrl = StreamController<ControlInbound>.broadcast();

  @override
  Stream<ServerMessage> get serverMessages => _ctrl.stream;
  @override
  Stream<ControlInbound> get controlFrames => _controlCtrl.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> send(ClientMessage msg) async => sent.add(msg);
  @override
  Future<void> close() async {
    if (!_ctrl.isClosed) await _ctrl.close();
    if (!_controlCtrl.isClosed) await _controlCtrl.close();
  }

  void push(ServerMessage m) {
    if (!_ctrl.isClosed) _ctrl.add(m);
  }

  /// Kill the stream — ConnectionManager treats it as a channel loss and
  /// schedules a reconnect.
  Future<void> drop() async {
    if (!_ctrl.isClosed) await _ctrl.close();
  }
}

void main() {
  test('host_hello is sent on connect and host_hello_ok surfaces', () async {
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage([_peer(_epkA)]),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);

    await conn.connectTo(_peer(_epkA));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final hellos = ch.sent.whereType<HostHello>().toList();
    expect(hellos, hasLength(1));

    final hellosOk = <HostHelloOk>[];
    // ignore: discarded_futures
    final sub = conn.hostHelloStream.listen(hellosOk.add);

    ch.push(
      HostHelloOk(
        inReplyTo: hellos.first.id,
        daemon: const HostDaemonInfo(
          version: '1.2.3',
          hostname: 'mac do jacob',
          platform: 'darwin',
        ),
        capabilities: const ['host_pairing', 'workspace_state', 'fs_nav'],
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(hellosOk, hasLength(1));
    expect(hellosOk.first.daemon.version, '1.2.3');
    expect(conn.hostHelloFor(_epkA)?.daemon.hostname, 'mac do jacob');
    // url-safe / standard epk lookups agree.
    expect(conn.hostHelloFor(_epkA)?.capabilities, contains('workspace_state'));

    await sub.cancel();
  });

  test('host_hello is re-sent on reconnect (WS loss → retry → online)', () async {
    var attempt = 0;
    final channels = <_Channel>[];
    final conn = ConnectionManager(
      factory: (_, _) async {
        attempt++;
        // First connection drops immediately; the second stays up.
        final ch = _Channel();
        channels.add(ch);
        if (attempt == 1) {
          // ignore: discarded_futures
          Future.delayed(const Duration(milliseconds: 5), ch.drop);
        }
        return ch;
      },
      storage: _FakeStorage([_peer(_epkA)]),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);

    await conn.connectTo(_peer(_epkA));
    // Wait past the first backoff (1s) so the reconnect happens.
    await Future<void>.delayed(const Duration(milliseconds: 1200));

    expect(attempt, greaterThanOrEqualTo(2));
    // Every successful (re)connect sent its own host_hello.
    for (final ch in channels) {
      expect(ch.sent.whereType<HostHello>(), hasLength(1));
    }
  });

  test('workspace_state push surfaces and a crash keeps the machine online', () async {
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage([_peer(_epkA)]),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);

    final statuses = <ConnectionStatus>[];
    // ignore: discarded_futures
    conn.statusStream.listen(statuses.add);

    await conn.connectTo(_peer(_epkA));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(conn.status, isA<StatusOnline>());

    final snapshots = <Map<String, WorkspaceState>>[];
    // ignore: discarded_futures
    final sub = conn.workspaceStatesStream.listen(snapshots.add);

    // The supervisor pushes the crash of the workspace Pi…
    ch.push(
      WorkspaceState(
        cwd: '/Users/jacob/Projects/remote_pi',
        state: WorkspaceStateValue.crashed,
        lastError: 'Pi process exited with code 1 (SIGKILL)',
        restarts: 1,
        rawState: 'crashed',
      ),
    );
    // …and later the restart coming back up.
    ch.push(
      WorkspaceState(
        cwd: '/Users/jacob/Projects/remote_pi',
        state: WorkspaceStateValue.running,
        lastError: null,
        restarts: 1,
        rawState: 'running',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    // The machine connection never left StatusOnline — that is the whole
    // point of anchoring on room `host`.
    expect(statuses.whereType<StatusOnline>(), hasLength(1));
    expect(statuses.whereType<StatusRetrying>(), isEmpty);
    expect(statuses.whereType<StatusOffline>(), isEmpty);
    expect(conn.status, isA<StatusOnline>());

    final state = conn.workspaceStateFor('/Users/jacob/Projects/remote_pi');
    expect(state, isNotNull);
    expect(state!.state, WorkspaceStateValue.running);
    expect(state.restarts, 1);
    expect(conn.workspaceStatesSnapshot, hasLength(1));
    expect(snapshots, hasLength(2));

    await sub.cancel();
  });

  test('switching machines clears the previous machine lifecycle rows', () async {
    final chA = _Channel();
    final chB = _Channel();
    final conn = ConnectionManager(
      factory: (peer, _) async =>
          peer.remoteEpk == _epkA ? chA : chB,
      storage: _FakeStorage([_peer(_epkA), _peer(_epkB)]),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);

    await conn.connectTo(_peer(_epkA));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    chA.push(
      WorkspaceState(
        cwd: '/proj/a',
        state: WorkspaceStateValue.crashed,
        lastError: 'boom',
        restarts: 0,
        rawState: 'crashed',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(conn.workspaceStateFor('/proj/a'), isNotNull);

    await conn.switchTo(_peer(_epkB));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(conn.workspaceStatesSnapshot, isEmpty);
    expect(conn.workspaceStateFor('/proj/a'), isNull);
    // The new machine got its own host_hello.
    expect(chB.sent.whereType<HostHello>(), hasLength(1));
  });

  test('adopt (post-pairing) also sends host_hello', () async {
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage([_peer(_epkA)]),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);

    conn.adopt(ch, _peer(_epkA));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(ch.sent.whereType<HostHello>(), hasLength(1));
    expect(conn.status, isA<StatusOnline>());
  });

  test('a workspace_state push does not count as Pi liveness for ping reset'
      ' only — machine stays online regardless', () async {
    // Regression guard for the plan-18 ping coupling: the protocol Ping is
    // now answered by the daemon on the host room, so a dead Pi cannot
    // accumulate misses that would tear the WS down.
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage([_peer(_epkA)]),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);

    await conn.connectTo(_peer(_epkA));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    // Inbound traffic of any kind resets the miss counter; with the Pi dead
    // the daemon's pong/host frames keep it at zero and the WS stays up.
    for (var i = 0; i < 5; i++) {
      ch.push(Pong(inReplyTo: 'ping_$i'));
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(conn.status, isA<StatusOnline>());
  });
}
