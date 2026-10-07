// Plan/68 — navegador de pastas do HOST (fs_list).
//
// O ponto central: o app NUNCA resolve caminho local. Ele manda um `path`
// (aceita `~`) para o room `host` da máquina e renderiza o que voltar, com o
// breadcrumb vindo do `realpath` do host. Estes testes provam:
//   - abre em `~` e lista o que o host devolveu;
//   - descer (`enter`) e subir (`up`) mandam o caminho composto;
//   - `up` na raiz (parent == null) não faz nada;
//   - erros tipados viram mensagem clara e o Retry repete o MESMO path;
//   - "usar esta pasta" = workspace_add + workspace_start (nessa ordem);
//   - a confirmação de primeiro start é por diretório;
//   - `toggleHidden` re-lista com show_hidden.

import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/workspaces/states/workspace_browser_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_browser_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _epk = 'Bz02uLi';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// Fakes `fs_list` / `workspace_add` / `workspace_start` no room `host`.
class _Channel implements IChannel, IControlLink {
  _Channel({this.failPath, this.failCode = 'not_found', this.startError});

  /// Quando o path pedido casa com este prefixo, responde `action_error`.
  final String? failPath;
  final String failCode;
  final String? startError;

  final _server = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();
  final sentTypes = <String>[];
  final sentPaths = <String>[];

  @override
  Stream<ServerMessage> get serverMessages => _server.stream;
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> send(ClientMessage msg) async {
    final j = msg.toJson();
    sentTypes.add((j['type'] as String?) ?? '');
    if (_server.isClosed) return;
    switch (msg) {
      case FsList(:final id, :final path):
        sentPaths.add(path);
        if (failPath != null && path.startsWith(failPath!)) {
          _server.add(
            ActionError(
              inReplyTo: id,
              action: ActionName.fsList,
              rawAction: 'fs_list',
              error: failCode,
            ),
          );
          return;
        }
        _server.add(
          FsListOk(
            inReplyTo: id,
            path: path == '~' ? '/home/me' : path,
            parent: path == '/' ? null : '/home',
            entries: const [
              WireFsEntry(name: 'proj', kind: 'dir', isRepo: true),
              WireFsEntry(name: 'plain', kind: 'dir'),
              WireFsEntry(name: 'file.txt', kind: 'file'),
            ],
          ),
        );
      case WorkspaceAdd(:final id):
        _server.add(ActionOk(inReplyTo: id, action: ActionName.workspaceAdd, rawAction: 'workspace_add'));
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
              cwd: cwd ?? '/home/me',
              roomId: 'r-me',
              daemonId: 'd-me',
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
  Future<PeerRecord?> loadPeer(String epk) async => epk == _epk ? _peer() : null;
  @override
  Future<void> savePeer(PeerRecord record) async {}
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {}
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async => const [];
  @override
  Future<void> deleteRooms(String epk) async {}
}

/// Monta o viewmodel com um canal já ativo e devolve ambos.
Future<(WorkspaceBrowserViewModel, _Channel, ConnectionManager)> _rig(
  _Channel ch, {
  String initial = '~',
}) async {
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  conn.switchRoom('room-1'); // a room do chat, como o picker é aberto na vida real
  final vm = WorkspaceBrowserViewModel(SessionCatalog(conn), initialPath: initial);
  await _drain(vm);
  return (vm, ch, conn);
}

/// Espera o viewmodel assentar (fora do relógio do teste de widget).
Future<void> _drain(WorkspaceBrowserViewModel vm) async {
  for (var i = 0; i < 20 && vm.state is! WorkspaceBrowserReady && vm.state is! WorkspaceBrowserError; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  await Future<void>.delayed(const Duration(milliseconds: 10));
}

void main() {
  test('abre em ~ e lista o que o host devolveu (breadcrumb = realpath)', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);

    expect(ch.sentTypes, contains('fs_list'));
    expect(ch.sentPaths.first, '~');
    final s = vm.state as WorkspaceBrowserReady;
    expect(s.path, '/home/me', reason: 'o path exibido é o realpath do host');
    expect(s.directories.map((e) => e.name), ['proj', 'plain'], reason: 'só dirs são navegáveis');
    conn.dispose();
  });

  test('enter desce e up sobe usando os caminhos do host', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);

    await vm.enter('proj');
    await _drain(vm);
    expect(ch.sentPaths.last, '/home/me/proj');

    await vm.up();
    await _drain(vm);
    expect(ch.sentPaths.last, '/home');
    conn.dispose();
  });

  test('up na raiz (parent == null) não dispara request', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch, initial: '/');
    final before = ch.sentPaths.length;
    await vm.up();
    expect(ch.sentPaths.length, before, reason: 'na raiz não há para onde subir');
    conn.dispose();
  });

  test('erro tipado vira mensagem clara e Retry repete o MESMO path', () async {
    final ch = _Channel(failPath: '/home/me/secret', failCode: 'permission_denied');
    final (vm, _, conn) = await _rig(ch);

    await vm.enter('secret');
    await _drain(vm);
    final err = vm.state as WorkspaceBrowserError;
    expect(err.message, contains('permission'));
    expect(err.path, '/home/me/secret');

    // Retry re-request the same directory (the channel must answer twice).
    await vm.retry();
    await _drain(vm);
    expect(ch.sentPaths.where((p) => p == '/home/me/secret').length, 2);
    conn.dispose();
  });

  test('not_found e not_a_directory têm copy própria', () {
    expect(WorkspaceBrowserViewModel.humanError('not_found'), contains('no longer exists'));
    expect(WorkspaceBrowserViewModel.humanError('not_a_directory'), contains('file'));
    expect(WorkspaceBrowserViewModel.humanError('permission_denied'), contains('permission'));
    expect(WorkspaceBrowserViewModel.humanError('spawn_failed'), contains('start a Pi'));
  });

  test('useCurrentFolder faz workspace_add ANTES de workspace_start', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);

    final ok = await vm.useCurrentFolder();
    expect(ok, isNotNull);
    expect(ok!.cwd, '/home/me');
    final addIdx = ch.sentTypes.indexOf('workspace_add');
    final startIdx = ch.sentTypes.indexOf('workspace_start');
    expect(addIdx, greaterThanOrEqualTo(0));
    expect(startIdx, greaterThan(addIdx), reason: 'registra antes de subir');
    conn.dispose();
  });

  test('start falhando vira erro tipado (spawn_failed)', () async {
    final ch = _Channel(startError: 'spawn_failed');
    final (vm, _, conn) = await _rig(ch);
    final ok = await vm.useCurrentFolder();
    expect(ok, isNull);
    final err = vm.state as WorkspaceBrowserError;
    expect(err.message, contains('start a Pi'));
    conn.dispose();
  });

  test('a confirmação de primeiro start é por diretório', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);
    expect(vm.needsConfirmation('/home/me'), isTrue);
    vm.markConfirmed('/home/me');
    expect(vm.needsConfirmation('/home/me'), isFalse);
    expect(vm.needsConfirmation('/other'), isTrue, reason: 'cada diretório confirma uma vez');
    conn.dispose();
  });

  test('toggleHidden re-lista marcando show_hidden', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);
    await vm.toggleHidden();
    await _drain(vm);
    final s = vm.state as WorkspaceBrowserReady;
    expect(s.showHidden, isTrue);
    conn.dispose();
  });

  test('openTyped manda o caminho digitado verbatim (o host resolve)', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);

    await vm.openTyped('/var/log');
    await _drain(vm);
    expect(ch.sentPaths.last, '/var/log');

    // `~` e `..` não são resolvidos no cliente — vão como estão.
    await vm.openTyped('  ~/ws/..  ');
    await _drain(vm);
    expect(ch.sentPaths.last, '~/ws/..');
    conn.dispose();
  });

  test('openTyped vazio é no-op', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);
    final before = ch.sentPaths.length;
    await vm.openTyped('   ');
    expect(ch.sentPaths.length, before);
    conn.dispose();
  });
}
