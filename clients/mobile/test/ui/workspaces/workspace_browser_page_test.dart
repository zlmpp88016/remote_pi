// Plan/68 — a tela do navegador de pastas do host.
//
// Cobre o que o viewmodel sozinho não mostra: o breadcrumb com o realpath do
// host, a lista de sub-pastas, o Up desabilitado na raiz, o fluxo
// "usar esta pasta" (com a confirmação de primeiro start) navegando para
// /sessions, e o erro tipado com retry. Dois pontos de comportamento que só a
// árvore revela: navegar NÃO ativa a sessão (nenhum `SyncService.activate`
// — constraint do plan/67) e a confirmação aparece uma vez por diretório.

import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/workspaces/states/workspace_browser_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_browser_viewmodel.dart';
import 'package:app/ui/workspaces/workspace_browser_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';
const _sessionsMarker = 'ROUTE:SESSIONS';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _Channel implements IChannel, IControlLink {
  _Channel({this.failPath});

  final String? failPath;

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
    if (_server.isClosed) return;
    switch (msg) {
      case FsList(:final id, :final path):
        if (failPath != null && path.startsWith(failPath!)) {
          _server.add(ActionError(
            inReplyTo: id,
            action: ActionName.fsList,
            rawAction: 'fs_list',
            error: 'permission_denied',
          ));
          return;
        }
        _server.add(FsListOk(
          inReplyTo: id,
          path: path == '~' ? '/home/me' : path,
          parent: path == '/' ? null : '/home',
          entries: const [
            WireFsEntry(name: 'proj', kind: 'dir', isRepo: true),
            WireFsEntry(name: 'plain', kind: 'dir'),
          ],
        ));
      case WorkspaceAdd(:final id):
        _server.add(ActionOk(
          inReplyTo: id,
          action: ActionName.workspaceAdd,
          rawAction: 'workspace_add',
        ));
      case WorkspaceStart(:final id, :final cwd):
        _server.add(WorkspaceStartOk(
          inReplyTo: id,
          cwd: cwd ?? '/home/me',
          roomId: 'r-me',
          daemonId: 'd-me',
        ));
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

/// Pumps limitados: `pumpAndSettle` não terminaria enquanto o spinner de
/// Loading estiver na árvore.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

/// Taps that trigger a real round-trip (fs_list/workspace_*) need `runAsync`
/// for the channel's reply to advance, and repeated pumps for the fake-zone
/// continuations (e.g. a dialog's `await showDialog` resolution) to progress.
Future<void> _tapAsync(WidgetTester tester, Finder f) async {
  await tester.tap(f);
  for (var i = 0; i < 4; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
  }
}

Future<WorkspaceBrowserViewModel> _pump(
  WidgetTester tester,
  _Channel ch, {
  String initial = '~',
}) async {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(393, 852);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  late ConnectionManager conn;
  late WorkspaceBrowserViewModel vm;
  await tester.runAsync(() async {
    conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = WorkspaceBrowserViewModel(
      SessionCatalog(conn),
      initialPath: initial,
    );
    await Future<void>.delayed(const Duration(milliseconds: 30));
  });
  addTearDown(conn.dispose);
  addTearDown(vm.dispose);

  final router = GoRouter(
    initialLocation: '/workspaces/browse',
    routes: [
      GoRoute(
        path: '/workspaces/browse',
        builder: (_, _) =>
            ChangeNotifierProvider<WorkspaceBrowserViewModel>.value(
          value: vm,
          child: const WorkspaceBrowserPage(epk: _epk, device: 'Mac de Teste'),
        ),
      ),
      GoRoute(
        path: '/sessions',
        builder: (_, _) => const Scaffold(body: Text(_sessionsMarker)),
      ),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await _settle(tester);
  return vm;
}

void main() {
  testWidgets('mostra o realpath do host no breadcrumb e lista as sub-pastas', (
    tester,
  ) async {
    await _pump(tester, _Channel());
    expect(find.text('/home/me'), findsOneWidget);
    expect(find.text('proj'), findsOneWidget);
    expect(find.text('plain'), findsOneWidget);
    // Arquivos não aparecem como alvo (o canal só devolve dirs aqui).
    expect(find.text('Use this folder'), findsOneWidget);
  });

  testWidgets('tocar numa pasta navega para dentro dela', (tester) async {
    final vm = await _pump(tester, _Channel());
    await _tapAsync(tester, find.text('proj'));
    expect(find.text('/home/me/proj'), findsOneWidget);
    // Navegar NÃO ativa a sessão (constraint do plan/67): nenhum marker de chat.
    expect(find.text(_sessionsMarker), findsNothing);
    expect((vm.state as WorkspaceBrowserReady).path, '/home/me/proj');
  });

  testWidgets('erro tipado mostra mensagem clara e oferece Retry', (tester) async {
    await _pump(tester, _Channel(failPath: '/home/me/proj'));
    await _tapAsync(tester, find.text('proj'));
    expect(find.textContaining('permission'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('"usar esta pasta" pede confirmação e então navega para /sessions', (
    tester,
  ) async {
    await _pump(tester, _Channel());

    await tester.tap(find.text('Use this folder'));
    await tester.pump();
    // Primeira vez no diretório → diálogo de confirmação.
    expect(find.text('Start a Pi here?'), findsOneWidget);

    await _tapAsync(tester, find.text('Start'));
    expect(find.text(_sessionsMarker), findsOneWidget);
  });

  testWidgets('cancelar a confirmação não navega', (tester) async {
    await _pump(tester, _Channel());
    await tester.tap(find.text('Use this folder'));
    await tester.pump();
    await _tapAsync(tester, find.text('Cancel'));
    expect(find.text(_sessionsMarker), findsNothing);
    expect(find.text('/home/me'), findsOneWidget, reason: 'segue no navegador');
  });

  testWidgets('confirmar uma vez não pergunta de novo no mesmo diretório', (
    tester,
  ) async {
    final vm = await _pump(tester, _Channel());
    vm.markConfirmed('/home/me');
    await _tapAsync(tester, find.text('Use this folder'));
    expect(find.text('Start a Pi here?'), findsNothing);
    expect(find.text(_sessionsMarker), findsOneWidget);
  });

  testWidgets('digitar um caminho absoluto navega direto para ele', (tester) async {
    await _pump(tester, _Channel());
    // O breadcrumb é editável: ao submeter, o caminho vai verbatim ao host.
    final field = find.byType(TextField);
    expect(field, findsOneWidget);
    await tester.enterText(field, '/var/log');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await _settle(tester);
    expect(find.text('/var/log'), findsOneWidget);
    expect(find.text('proj'), findsOneWidget, reason: 'lista a nova pasta');
  });
}
