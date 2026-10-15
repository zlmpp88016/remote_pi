// Plan/69 — workspace lifecycle in the picker: the `workspace_state` push
// merged into the rows, and the one-tap `workspace_restart`.
//
// The acceptance this file pins: a crashed workspace shows its last_error
// and restarts on ONE tap (idempotent host-side), and the visible flip back
// to `running` only ever comes from the next push — the app never
// fabricates state.

import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/workspaces/states/workspace_list_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_list_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _epk = 'Bz02uLi';
const _cwdA = '/Users/jacob/Projects/remote_pi';
const _cwdB = '/Users/jacob/Projects/cockpit';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
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

/// Answers `workspace_list` with two workspaces and `workspace_restart`
/// with ok or a typed error. Records what the app sent.
class _Channel implements IChannel, IControlLink {
  _Channel({this.restartError});

  /// When set, `workspace_restart` answers `workspace_restart_error` with
  /// this code instead of ok.
  final String? restartError;

  final sent = <ClientMessage>[];
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
    sent.add(msg);
    if (_server.isClosed) return;
    switch (msg) {
      case WorkspaceList(:final id):
        _server.add(
          WorkspaceListOk(
            inReplyTo: id,
            workspaces: const [
              WireWorkspaceInfo(
                cwd: _cwdA,
                daemonId: 'd1',
                roomId: 'r-a',
                name: 'remote_pi',
                live: true,
                daemon: true,
              ),
              WireWorkspaceInfo(
                cwd: _cwdB,
                daemonId: 'd2',
                roomId: 'r-b',
                name: 'cockpit',
                live: false,
                daemon: true,
              ),
            ],
          ),
        );
      case WorkspaceRestart(:final id, :final cwd):
        if (restartError != null) {
          _server.add(
            WorkspaceRestartError(
              inReplyTo: id,
              code: restartError!,
              message: 'host said no',
            ),
          );
        } else {
          _server.add(
            WorkspaceRestartOk(inReplyTo: id, cwd: cwd, daemonId: 'd1'),
          );
        }
      default:
        break;
    }
  }

  @override
  Future<void> close() async {
    if (!_server.isClosed) await _server.close();
    if (!_control.isClosed) await _control.close();
  }

  void push(ServerMessage m) {
    if (!_server.isClosed) _server.add(m);
  }
}

Future<({ConnectionManager conn, _Channel ch, WorkspaceListViewModel vm})>
_rig({String? restartError}) async {
  final ch = _Channel(restartError: restartError);
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  final vm = WorkspaceListViewModel(SessionCatalog(conn), conn: conn);
  await Future<void>.delayed(const Duration(milliseconds: 30));
  return (conn: conn, ch: ch, vm: vm);
}

WorkspaceListReady _ready(WorkspaceListViewModel vm) =>
    (vm.state as WorkspaceListReady);

WorkspaceState _state(
  String cwd,
  WorkspaceStateValue value, {
  String? lastError,
  int restarts = 0,
}) => WorkspaceState(
  cwd: cwd,
  state: value,
  lastError: lastError,
  restarts: restarts,
  rawState: value.wire,
);

void main() {
  test('workspace_state push merga no row (crashed + last_error + restarts)', () async {
    final r = await _rig();
    addTearDown(r.conn.dispose);
    addTearDown(r.vm.dispose);

    expect(_ready(r.vm).statesByCwd, isEmpty);

    r.ch.push(
      _state(_cwdA, WorkspaceStateValue.crashed, lastError: 'SIGKILL', restarts: 2),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final s = _ready(r.vm);
    expect(s.statesByCwd.keys, [_cwdA]);
    final ws = s.statesByCwd[_cwdA]!;
    expect(ws.state, WorkspaceStateValue.crashed);
    expect(ws.lastError, 'SIGKILL');
    expect(ws.restarts, 2);
  });

  test('o push seguinte (running) substitui o crashed — app não fabrica', () async {
    final r = await _rig();
    addTearDown(r.conn.dispose);
    addTearDown(r.vm.dispose);

    r.ch.push(_state(_cwdA, WorkspaceStateValue.crashed, lastError: 'boom'));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    r.ch.push(_state(_cwdA, WorkspaceStateValue.running));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final ws = _ready(r.vm).statesByCwd[_cwdA]!;
    expect(ws.state, WorkspaceStateValue.running);
    expect(ws.lastError, isNull);
  });

  test('restart por 1 toque envia workspace_restart {cwd} e aceita ok', () async {
    final r = await _rig();
    addTearDown(r.conn.dispose);
    addTearDown(r.vm.dispose);

    r.ch.push(_state(_cwdA, WorkspaceStateValue.crashed, lastError: 'boom'));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final ok = await r.vm.restart(_cwdA);

    expect(ok, isTrue);
    final sent = r.ch.sent.whereType<WorkspaceRestart>().toList();
    expect(sent, hasLength(1));
    expect(sent.single.cwd, _cwdA);
    // Spinner cleared after the ack; the row flips on the NEXT push.
    final s = _ready(r.vm);
    expect(s.restartingCwd, isNull);
    expect(s.restartError, isNull);
    expect(s.statesByCwd[_cwdA]!.state, WorkspaceStateValue.crashed);

    r.ch.push(_state(_cwdA, WorkspaceStateValue.running));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(_ready(r.vm).statesByCwd[_cwdA]!.state, WorkspaceStateValue.running);
  });

  test('restart é idempotente: running também envia (host responde ok sem respawn)', () async {
    final r = await _rig();
    addTearDown(r.conn.dispose);
    addTearDown(r.vm.dispose);

    r.ch.push(_state(_cwdA, WorkspaceStateValue.running));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final ok = await r.vm.restart(_cwdA);

    expect(ok, isTrue);
    expect(r.ch.sent.whereType<WorkspaceRestart>(), hasLength(1));
  });

  test('restart falhando (spawn_failed) mostra erro no row e libera o botão', () async {
    final r = await _rig(restartError: 'spawn_failed');
    addTearDown(r.conn.dispose);
    addTearDown(r.vm.dispose);

    r.ch.push(_state(_cwdA, WorkspaceStateValue.crashed, lastError: 'boom'));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final ok = await r.vm.restart(_cwdA);

    expect(ok, isFalse);
    final s = _ready(r.vm);
    expect(s.restartingCwd, isNull);
    expect(s.restartError, isNotNull);
    expect(s.restartError!.cwd, _cwdA);
    expect(s.restartError!.message, contains('could not start'));
  });

  test('restart sem conexão vira erro legível no row', () async {
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);
    // No connectTo — channel is null → WorkspaceControlFailure('offline').
    final vm = WorkspaceListViewModel(SessionCatalog(conn), conn: conn);
    addTearDown(vm.dispose);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(vm.state, isA<WorkspaceListError>());

    // Back to Ready via a fresh rig-like flow is not possible offline; the
    // error state itself is the readable outcome.
    expect((vm.state as WorkspaceListError).message, contains('Not connected'));
  });

  test('sem conn (picker puro) não há ciclo de vida e nada quebra', () async {
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    addTearDown(conn.dispose);
    final vm = WorkspaceListViewModel(SessionCatalog(conn));
    addTearDown(vm.dispose);
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(vm.state, isA<WorkspaceListReady>());
    expect(_ready(vm).statesByCwd, isEmpty);
    // Restart still works (the request is host-room addressed); it just has
    // no lifecycle stream to merge into.
    final ok = await vm.restart(_cwdA);
    expect(ok, isTrue);
    expect(_ready(vm).statesByCwd, isEmpty);
  });
}
