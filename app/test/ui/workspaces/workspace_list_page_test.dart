// Plan/67 — a tela do picker de workspace.
//
// Cobre o que o viewmodel sozinho não mostra: os três estados renderizam, o
// estado vazio ensina o operador a registrar uma pasta (é o caso real de quem
// registrou a pasta mas nunca rodou `remote-pi create`), e o erro oferece
// retry.

import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/workspaces/states/workspace_list_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_list_viewmodel.dart';
import 'package:app/ui/workspaces/workspace_list_page.dart';
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
  _Channel({this.workspaces = const [], this.startError});

  final List<WireWorkspaceInfo> workspaces;
  final String? startError;

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
      case WorkspaceList(:final id):
        _server.add(
          WorkspaceListOk(inReplyTo: id, workspaces: workspaces),
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
      case WorkspaceRemove(:final id):
        _server.add(
          ActionOk(
            inReplyTo: id,
            action: ActionName.workspaceRemove,
            rawAction: 'workspace_remove',
          ),
        );
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

/// Pumps limitados: `pumpAndSettle` não terminaria enquanto o spinner de
/// Loading estiver na árvore.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

Future<WorkspaceListViewModel> _pump(
  WidgetTester tester,
  _Channel ch, {
  Size size = const Size(393, 852),
}) async {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  late ConnectionManager conn;
  late WorkspaceListViewModel vm;
  await tester.runAsync(() async {
    conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    // Room de chat ativa: o picker é aberto a partir de um chat.
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = WorkspaceListViewModel(SessionCatalog(conn));
    // O construtor dispara `reload()` sem await; sem ceder o event loop real
    // aqui a resposta nunca chegaria e o teste veria Loading para sempre.
    await Future<void>.delayed(const Duration(milliseconds: 20));
  });
  addTearDown(conn.dispose);
  addTearDown(vm.dispose);

  final router = GoRouter(
    initialLocation: '/workspaces',
    routes: [
      GoRoute(
        path: '/workspaces',
        builder: (_, _) => ChangeNotifierProvider<WorkspaceListViewModel>.value(
          value: vm,
          child: const WorkspaceListPage(
            epk: _epk,
            title: 'Workspaces',
            device: 'Mac de Teste',
          ),
        ),
      ),
      GoRoute(
        path: '/sessions',
        builder: (_, _) =>
            const Scaffold(body: Center(child: Text(_sessionsMarker))),
      ),
    ],
  );
  await tester.pumpWidget(
    MaterialApp.router(theme: buildDarkTheme(), routerConfig: router),
  );
  await _settle(tester);
  return vm;
}

void main() {
  testWidgets('lista os workspaces com nome, cwd e badge running', (
    tester,
  ) async {
    final ch = _Channel(
      workspaces: const [
        WireWorkspaceInfo(
          cwd: '/proj/a',
          daemonId: 'd1',
          roomId: 'r-a',
          name: 'proj-a',
          live: true,
          daemon: true,
        ),
        WireWorkspaceInfo(
          cwd: '/proj/b',
          daemonId: 'd2',
          roomId: 'r-b',
          name: 'proj-b',
          live: false,
          daemon: true,
        ),
      ],
    );
    final vm = await _pump(tester, ch);

    expect(vm.state, isA<WorkspaceListReady>());
    expect(find.text('proj-a'), findsOneWidget);
    expect(find.text('proj-b'), findsOneWidget);
    // O cwd aparece sempre; o estado (`running`) agora é uma linha própria do
    // card (plan/69), não mais um subtitle concatenado.
    expect(find.text('running'), findsOneWidget);
    expect(find.text('/proj/b'), findsOneWidget);
  });

  testWidgets('lista vazia ensina a navegar no host', (tester) async {
    await _pump(tester, _Channel());

    // Plan/68 — o catálogo deixou de ser "só daemons registrados": o estado
    // vazio agora aponta para o navegador de pastas do host.
    expect(find.text('No workspaces yet'), findsOneWidget);
    expect(
      find.textContaining("Browse the machine's folders"),
      findsOneWidget,
      reason: 'o usuário precisa saber como escolher uma pasta',
    );
    expect(
      find.text('Browse folders on the machine'),
      findsOneWidget,
      reason: 'atalho para o picker do filesystem do host',
    );
  });

  testWidgets('tocar num workspace navega para /sessions', (tester) async {
    final ch = _Channel(
      workspaces: const [
        WireWorkspaceInfo(
          cwd: '/proj/b',
          daemonId: 'd2',
          roomId: 'r-b',
          name: 'proj-b',
          live: false,
          daemon: true,
        ),
      ],
    );
    await _pump(tester, ch);

    await tester.tap(find.text('proj-b'));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await _settle(tester);

    expect(find.text(_sessionsMarker), findsOneWidget);
  });

  testWidgets('start falhando mostra o erro com retry', (tester) async {
    final ch = _Channel(
      startError: 'not_registered',
      workspaces: const [
        WireWorkspaceInfo(
          cwd: '/proj/b',
          daemonId: 'd2',
          roomId: 'r-b',
          name: 'proj-b',
          live: false,
          daemon: true,
        ),
      ],
    );
    final vm = await _pump(tester, ch);

    await tester.tap(find.text('proj-b'));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await _settle(tester);

    expect(vm.state, isA<WorkspaceListError>());
    expect(find.textContaining('remote-pi create'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text(_sessionsMarker), findsNothing);
  });

  testWidgets('workspace adicionado tem badge \'added\' e botão de remover', (
    tester,
  ) async {
    final ch = _Channel(
      workspaces: const [
        WireWorkspaceInfo(
          cwd: '/proj/a',
          daemonId: 'd1',
          roomId: 'r-a',
          name: 'proj-a',
          live: false,
          daemon: false,
          source: 'added',
        ),
      ],
    );
    final vm = await _pump(tester, ch);

    expect(find.text('added'), findsOneWidget);
    expect(find.byTooltip('Remove from list'), findsOneWidget);

    await tester.tap(find.byTooltip('Remove from list'));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await _settle(tester);
    final s = vm.state as WorkspaceListReady;
    expect(s.workspaces, isEmpty, reason: 'some da lista após remover');
  });

  testWidgets('workspace registrado (daemon) não oferece remover', (tester) async {
    final ch = _Channel(
      workspaces: const [
        WireWorkspaceInfo(
          cwd: '/proj/a',
          daemonId: 'd1',
          roomId: 'r-a',
          name: 'proj-a',
          live: true,
          daemon: true,
        ),
      ],
    );
    await _pump(tester, ch);
    expect(find.byTooltip('Remove from list'), findsNothing);
    expect(find.text('Browse folders on the machine'), findsOneWidget);
  });

  testWidgets('o estado vazio respeita a largura máxima de conteúdo', (
    tester,
  ) async {
    // Mesma decisão do `home_page_layout_test`: no tablet o estado vazio não
    // estica borda-a-borda. Mede a geometria real, não a presença do widget —
    // `findsOneWidget` passaria com qualquer outro ConstrainedBox na subárvore.
    await _pump(tester, _Channel(), size: const Size(1024, 1366));

    final box = find.ancestor(
      of: find.text('No workspaces yet'),
      matching: find.byType(ConstrainedBox),
    );
    expect(box, findsWidgets);
    final widths = tester
        .widgetList<ConstrainedBox>(box)
        .map((b) => b.constraints.maxWidth)
        .toList();
    expect(
      widths,
      contains(kMaxContentWidth),
      reason: 'largura máxima documentada em adaptive.dart',
    );
  });
}
