// Plan/67 — o picker de workspace (cwd).
//
// O ponto que estes testes protegem não é a lista em si, e sim um efeito
// colateral real: `SessionCatalog.listWorkspaces()`/`startWorkspace()`
// endereçam o room `host` da máquina, e a implementação faz isso chamando
// `ConnectionManager.switchRoom('host')` — que muda o `_activeRoomId` GLOBAL,
// o room que TODO envelope de saída carrega (inclusive o chat). Se o viewmodel
// não devolvesse o room anterior, abrir o picker deixaria o app falando com o
// room `host` para sempre: o chat seguiria enviando para `host` e o Pi nunca
// receberia as mensagens da sessão.
//
// Por isso o caso central aqui (`restaura o room ativo`) existe: ele falha se
// alguém remover o `finally` que devolve o room.

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

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// Responde `workspace_list`/`workspace_start` (vão para o room `host`) e
/// permite forçar o `action_error` para exercitar o caminho de falha.
class _Channel implements IChannel, IControlLink {
  _Channel({this.listEmpty = false, this.startError});

  /// `workspace_list` responde sempre com `workspace_list_ok` (o host não tem
  /// branch de erro nessa op — ver `handleWorkspaceList`), então o único
  /// caso degenerado é a lista vazia.
  final bool listEmpty;

  /// `workspace_start` de um cwd desconhecido responde `action_error`
  /// `not_registered` (`resolveEntry` não achou o entry).
  final String? startError;

  final _server = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();

  /// Tipos das mensagens enviadas pelo app, na ordem — o teste confere que a
  /// requisição de workspace saiu.
  final sentTypes = <String>[];

  @override
  Stream<ServerMessage> get serverMessages => _server.stream;
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> send(ClientMessage msg) async {
    sentTypes.add((msg.toJson()['type'] as String?) ?? '');
    if (_server.isClosed) return;
    switch (msg) {
      case WorkspaceList(:final id):
        _server.add(
          WorkspaceListOk(
            inReplyTo: id,
            workspaces: listEmpty
                ? const []
                : const [
                    WireWorkspaceInfo(
                      cwd: '/proj/a',
                      daemonId: 'd1',
                      roomId: 'r-a',
                      name: 'a',
                      live: true,
                      daemon: true,
                    ),
                    WireWorkspaceInfo(
                      cwd: '/proj/b',
                      daemonId: 'd2',
                      roomId: 'r-b',
                      name: 'b',
                      live: false,
                      daemon: true,
                    ),
                  ],
          ),
        );
      case WorkspaceStart(:final id):
        if (startError != null) {
          _server.add(
            ActionError(
              inReplyTo: id,
              action: ActionName.sessionCompact,
              rawAction: 'workspace_start',
              error: startError!,
            ),
          );
        } else {
          _server.add(
            WorkspaceStartOk(
              inReplyTo: id,
              cwd: '/proj/b',
              roomId: 'r-b',
              daemonId: 'd2',
            ),
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

/// Conexão online com `_activeRoomId` já apontado para a room de chat — é o
/// estado em que o picker é aberto na vida real (o usuário vem de um chat).
Future<({ConnectionManager conn, _Channel ch})> _rig({
  bool listEmpty = false,
  String? startError,
}) async {
  final ch = _Channel(listEmpty: listEmpty, startError: startError);
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  conn.switchRoom('room-1'); // a room do chat
  return (conn: conn, ch: ch);
}

void main() {
  test('reload lista os workspaces e RESTAURA o room ativo', () async {
    final r = await _rig();
    addTearDown(r.conn.dispose);

    final vm = WorkspaceListViewModel(SessionCatalog(r.conn));
    addTearDown(vm.dispose);

    await vm.reload();

    final s = vm.state;
    expect(s, isA<WorkspaceListReady>());
    final workspaces = (s as WorkspaceListReady).workspaces;
    expect(workspaces.map((w) => w.name), ['a', 'b']);
    expect(workspaces.first.live, isTrue);
    expect(workspaces.last.live, isFalse);

    // O ponto do teste: o request foi para o host, mas o app VOLTOU para a
    // room do chat. Sem o `finally` o valor aqui seria 'host'.
    expect(r.ch.sentTypes, contains('workspace_list'));
    expect(r.conn.activeRoomId, 'room-1');
  });

  test('lista vazia vira Ready vazio (o host não tem erro nessa op)', () async {
    final r = await _rig(listEmpty: true);
    addTearDown(r.conn.dispose);
    final vm = WorkspaceListViewModel(SessionCatalog(r.conn));
    addTearDown(vm.dispose);

    await vm.reload();

    final s = vm.state;
    expect(s, isA<WorkspaceListReady>());
    expect((s as WorkspaceListReady).workspaces, isEmpty);
    expect(r.conn.activeRoomId, 'room-1');
  });

  test('start devolve o room resultante e restaura o room ativo', () async {
    final r = await _rig();
    addTearDown(r.conn.dispose);
    final vm = WorkspaceListViewModel(SessionCatalog(r.conn));
    addTearDown(vm.dispose);

    await vm.reload();
    final ok = await vm.start(daemonId: 'd2', cwd: '/proj/b');

    expect(ok, isNotNull);
    expect(ok!.roomId, 'r-b');
    expect(ok.cwd, '/proj/b');
    expect(r.conn.activeRoomId, 'room-1');
  });

  test('start falhando volta para Ready (não deixa a lista travada)', () async {
    final r = await _rig(startError: 'not_registered');
    addTearDown(r.conn.dispose);
    final vm = WorkspaceListViewModel(SessionCatalog(r.conn));
    addTearDown(vm.dispose);

    await vm.reload();
    final ok = await vm.start(cwd: '/nope');

    expect(ok, isNull);
    expect(vm.state, isA<WorkspaceListError>());
    expect(r.conn.activeRoomId, 'room-1');
  });

  test('sem canal (offline) o estado vira erro legível', () async {
    // Sem `connectTo`: `ConnectionManager.channel` é null e o catálogo
    // lança WorkspaceControlFailure('offline').
    final conn = ConnectionManager(
      factory: (_, _) async => _Channel(),
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    addTearDown(conn.dispose);
    final vm = WorkspaceListViewModel(SessionCatalog(conn));
    addTearDown(vm.dispose);

    await vm.reload();

    final s = vm.state;
    expect(s, isA<WorkspaceListError>());
    expect((s as WorkspaceListError).message, contains('Not connected'));
  });
}
