// Plan/tablet — layout por CLASSE DE DEVICE, medido em pixels de aparelho.
//
// Monta as páginas reais (HomePage / SessionListPage) nos tamanhos de iPhone
// 15 Pro e iPad Pro 12.9 para travar três decisões que só existem em tela
// larga:
//
//   home_page.dart:350      isSelected = isWideLayout(...) && seleção — o
//                           destaque da sessão aberta só faz sentido nos dois
//                           painéis; no celular a lista fica sob o chat.
//   home_page.dart:543      !isWideLayout → push('/sessions'). No tablet o
//                           painel detail reage à seleção, sem navegar.
//   home_page.dart:598/645  BoxConstraints(maxWidth: kMaxContentWidth) — o
//                           estado vazio não estica borda-a-borda no tablet.
//   session_list_page.dart:107  !isWideLayout → push('/chat'), a mesma regra
//                           uma tela depois.
//
// As dimensões são as do aparelho, nas duas orientações: 393x852 (iPhone 15
// Pro) e 1024x1366 (iPad Pro 12.9). `devicePixelRatio = 1` faz
// `physicalSize` valer diretamente como pixels lógicos — o que
// `MediaQuery.sizeOf` mede.
//
// Nota de harness: o setup (connect + frames) roda dentro de
// `tester.runAsync` porque precisa de async REAL; dentro do corpo de um
// `testWidgets` os `Future.delayed` usam o relógio falso e só avançam com
// `pump`. Pelo mesmo motivo os passos de UI usam pumps limitados em vez de
// `pumpAndSettle` (que nunca terminaria enquanto houver um spinner).

import 'dart:async';

import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/domain/contracts/dismissed_update_store.dart';
import 'package:app/domain/contracts/update_checker.dart';
import 'package:app/domain/contracts/url_opener.dart';
import 'package:app/domain/entities/update_info.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/home/home_page.dart';
import 'package:app/ui/home/viewmodels/home_viewmodel.dart';
import 'package:app/ui/home/widgets/session_tile.dart';
import 'package:app/ui/sessions/session_list_page.dart';
import 'package:app/ui/sessions/viewmodels/session_list_viewmodel.dart';
import 'package:app/ui/update/viewmodels/update_banner_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

// ---------------------------------------------------------------------------
// Tamanhos de aparelho (pixels lógicos)
// ---------------------------------------------------------------------------

const _iPhonePortrait = Size(393, 852);
const _iPhoneLandscape = Size(852, 393);
const _iPadPortrait = Size(1024, 1366);
const _iPadLandscape = Size(1366, 1024);

/// Valor documentado em `adaptive.dart` (kMaxContentWidth). Repetido aqui de
/// propósito: o teste deve falhar se o design mudar sem alguém revisitar esta
/// decisão de layout.
const _documentedMaxContentWidth = 460.0;

const _kSessionsMarker = 'ROUTE:SESSIONS';
const _kChatMarker = 'ROUTE:CHAT';

const _epk = 'Bz02uLi';
const _roomId = 'room-1';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _map = {};
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _map[key];
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
      _map.remove(key);
    } else {
      _map[key] = value;
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
  }) async {
    _map.remove(key);
  }
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

/// PairingStorage sem Hive — só a lista de peers interessa ao layout.
class _FakeStorage extends PairingStorage {
  _FakeStorage(this.peers);
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

/// Canal controlável. Responde `session_list`/`session_switch` (o
/// [SessionCatalog] é request/reply sobre o canal ativo) e aceita frames de
/// controle injetados pelo teste (`room_announced`) para popular a Home.
class _Channel implements IChannel, IControlLink {
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
      case SessionList(:final id):
        _server.add(
          SessionListOk(
            inReplyTo: id,
            currentId: 's1',
            sessions: const [
              WireSessionInfo(
                id: 's1',
                name: 'Session One',
                mtime: 1,
                live: true,
              ),
            ],
          ),
        );
      case SessionSwitch(:final id, :final sessionId):
        _server.add(
          SessionSwitchOk(
            inReplyTo: id,
            sessionId: sessionId,
            sessionStartedAt: 1,
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

  void pushControl(ControlInbound c) {
    if (!_control.isClosed) _control.add(c);
  }
}

class _NoUpdate implements UpdateChecker {
  @override
  Future<UpdateInfo?> fetchLatest() async => null;
}

class _NoDismiss implements DismissedUpdateStore {
  @override
  Future<String?> dismissedVersion() async => null;
  @override
  Future<void> dismiss(String version) async {}
}

class _NoOpener implements UrlOpener {
  @override
  Future<bool> open(String url) async => false;
}

/// O aviso de update é Android-only; `enabled: false` o deixa inerte (nunca
/// toca a rede) — é o que acontece no iOS de verdade.
UpdateBannerViewModel _bannerVm() => UpdateBannerViewModel(
  _NoUpdate(),
  _NoDismiss(),
  _NoOpener(),
  currentVersion: '1.0.0',
  enabled: false,
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// Espera real de estabilização para o setup (fora do relógio falso).
Future<void> _tick() =>
    Future<void>.delayed(const Duration(milliseconds: 20));

void _useSize(WidgetTester tester, Size size) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Passos de UI com pumps LIMITADOS: `pumpAndSettle` não terminaria enquanto
/// houver animação contínua (o spinner do estado Loading). 400ms cobrem a
/// transição de rota do Material (300ms).
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

/// Um peer, uma room viva e o ConnectionManager online — o estado mínimo em
/// que a Home renderiza um tile. O rig devolve tudo que cria `Timer` para o
/// teste desmontar EM-BODY (o framework checa timers pendentes antes dos
/// `addTearDown`; o watchdog do manager é um deles).
class _HomeRig {
  _HomeRig(this.conn, this.storage, this.prefs, this.vm, this.sel, this.shell);
  final ConnectionManager conn;
  final _FakeStorage storage;
  final Preferences prefs;
  final HomeViewModel vm;
  final SessionSelection sel;
  final ShellLayout shell;

  void dispose() {
    vm.dispose();
    sel.dispose();
    shell.dispose();
    prefs.dispose();
    conn.dispose();
  }
}

/// Monta o rig com async REAL (`runAsync`), senão os `Future.delayed` do
/// connect/frames nunca completariam dentro do relógio falso.
Future<_HomeRig> _homeRig(
  WidgetTester tester, {
  bool withPeer = true,
  bool withRoom = true,
}) async {
  late _HomeRig rig;
  await tester.runAsync(() async {
    final storage = _FakeStorage(withPeer ? [_peer()] : const []);
    final ch = _Channel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: storage,
      emitDebounce: Duration.zero,
    );
    if (withPeer) {
      await conn.connectTo(_peer());
      await _tick();
      if (withRoom) {
        ch.pushControl(
          const RoomAnnounced(
            peer: _epk,
            roomId: _roomId,
            startedAt: 1,
            cwd: '/proj',
            name: 'proj',
          ),
        );
        await _tick();
      }
    }
    final prefs = Preferences(_FakeSecureStorage());
    final vm = HomeViewModel(storage, prefs, conn);
    await _tick();
    rig = _HomeRig(
      conn,
      storage,
      prefs,
      vm,
      SessionSelection(),
      ShellLayout(),
    );
  });
  return rig;
}

List<SingleChildWidget> _homeProviders(_HomeRig r) => [
  ChangeNotifierProvider<HomeViewModel>.value(value: r.vm),
  ChangeNotifierProvider<ShellLayout>.value(value: r.shell),
  ChangeNotifierProvider<SessionSelection>.value(value: r.sel),
  ChangeNotifierProvider<Preferences>.value(value: r.prefs),
  ChangeNotifierProvider<UpdateBannerViewModel>.value(value: _bannerVm()),
];

/// Router com a Home em `/` e um marcador no destino. Se o `push` aconteceu,
/// o texto do marcador aparece.
GoRouter _homeRouter() => GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (_, _) => const HomePage()),
    GoRoute(
      path: '/sessions',
      builder: (_, _) =>
          const Scaffold(body: Center(child: Text(_kSessionsMarker))),
    ),
  ],
);

Future<void> _pumpHome(WidgetTester tester, Size size, _HomeRig rig) async {
  _useSize(tester, size);
  await tester.pumpWidget(
    MultiProvider(
      providers: _homeProviders(rig),
      child: MaterialApp.router(
        theme: buildDarkTheme(),
        routerConfig: _homeRouter(),
      ),
    ),
  );
  await _settle(tester);
}

/// `testWidgets` com a rejeição da carga da Inter neutralizada.
///
/// `brandTextStyle` (o título "Remote Pi") resolve via `google_fonts`, que não
/// acha a Inter nos assets do app e — com `allowRuntimeFetching = false` —
/// rejeita a carga. O pacote registra o variant como "carregando" ANTES de a
/// carga assíncrona resolver e deixa o future sem `catchError`, então a
/// rejeição só chega quando um `runAsync` do harness (necessário para o
/// `onTap`, que é async) dá a ela um event loop real.
///
/// Isso tornaria o resultado dependente da ORDEM: rodando o arquivo inteiro, o
/// future criado pelo primeiro caso fica pendurado para sempre no relógio
/// falso e os casos seguintes passam; rodando um caso isolado, ele rejeita e o
/// teste quebra por um motivo que não tem nada a ver com layout (verificado:
/// falha 3/3 isolado, passa 3/3 inteiro). Esta guarda descarta APENAS
/// rejeições vindas de `package:google_fonts/`; qualquer outro erro é
/// reerguido com o stack original.
///
/// O `try/catch` DENTRO da zona é o que impede o travamento: se o corpo
/// deixasse o erro escapar de um `runZonedGuarded` assíncrono, o future
/// retornado nunca completaria e o framework ficaria em `did not complete`
/// até o watchdog (verificado com um caso mínimo).
void _testWidgets(
  String description,
  Future<void> Function(WidgetTester) body,
) {
  testWidgets(description, (tester) async {
    Object? failure;
    StackTrace? failureStack;
    await runZonedGuarded(
      () async {
        try {
          await body(tester);
        } catch (error, stack) {
          failure = error;
          failureStack = stack;
        }
      },
      (error, stack) {
        if (stack.toString().contains('package:google_fonts/')) return;
        failure ??= error;
        failureStack ??= stack;
      },
    );
    if (failure != null) {
      Error.throwWithStackTrace(failure!, failureStack!);
    }
  });
}

void main() {
  // O teste mede geometria, não tipografia: sem os `.ttf` da Inter nos assets
  // do app, ligar o fetch de runtime só serviria para bater em
  // fonts.gstatic.com e voltar 400. Desligá-lo deixa a falha imediata e
  // determinística — `_testWidgets` é quem a absorve.
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  tearDownAll(() {
    GoogleFonts.config.allowRuntimeFetching = true;
  });

  group('HomePage — destaque da sessão só nos dois painéis (:350)', () {
    // A seleção é marcada ANTES do pump; só o tamanho varia. Se a guarda
    // `isWideLayout` de :350 sumir, o celular passa a acender o destaque e os
    // dois primeiros casos falham.
    Future<void> assertSelected(
      WidgetTester tester,
      Size size,
      bool expected,
    ) async {
      final rig = await _homeRig(tester);
      rig.sel.select(_epk, _roomId, 'proj', 'Mac', true);
      await _pumpHome(tester, size, rig);

      final tiles = find.byType(SessionTile);
      expect(tiles, findsOneWidget, reason: 'um tile para a room anunciada');
      expect(
        tester.widget<SessionTile>(tiles).isSelected,
        expected,
        reason: 'isSelected em ${size.width}x${size.height}',
      );

      await tester.pumpWidget(const SizedBox());
      rig.dispose();
    }

    _testWidgets('iPhone retrato: NÃO destaca (lista fica sob o chat)', (
      tester,
    ) async {
      await assertSelected(tester, _iPhonePortrait, false);
    });

    _testWidgets('iPhone paisagem: segue celular (largura != classe de device)', (
      tester,
    ) async {
      await assertSelected(tester, _iPhoneLandscape, false);
    });

    _testWidgets('iPad retrato: destaca', (tester) async {
      await assertSelected(tester, _iPadPortrait, true);
    });

    _testWidgets('iPad paisagem: destaca', (tester) async {
      await assertSelected(tester, _iPadLandscape, true);
    });
  });

  group('HomePage — navegação do tile (:543)', () {
    // A asserção roda DENTRO do helper, com a árvore montada: o desmonte
    // (pumpWidget(SizedBox)) precisa vir antes do fim do teste por causa do
    // check de timers pendentes, e depois dele não há mais árvore para
    // consultar.
    Future<void> tapTile(
      WidgetTester tester,
      Size size, {
      required bool expectPush,
      required String reason,
    }) async {
      final rig = await _homeRig(tester);
      await _pumpHome(tester, size, rig);
      await tester.tap(find.byType(SessionTile));
      // `_open` é async (await vm.openSession antes do push) e a cadeia
      // precisa do event loop REAL; dentro do relógio falso ela fica
      // pendurada e o push nunca chega a acontecer.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await _settle(tester);

      if (expectPush) {
        expect(
          find.text(_kSessionsMarker),
          findsOneWidget,
          reason: reason,
        );
      } else {
        expect(find.text(_kSessionsMarker), findsNothing, reason: reason);
        expect(
          find.byType(SessionTile),
          findsOneWidget,
          reason: 'deve continuar na Home — $reason',
        );
      }

      await tester.pumpWidget(const SizedBox());
      rig.dispose();
    }

    _testWidgets('iPhone: empurra /sessions', (tester) async {
      await tapTile(
        tester,
        _iPhonePortrait,
        expectPush: true,
        reason: 'celular navega para a lista de sessões',
      );
    });

    _testWidgets('iPhone paisagem: ainda empurra', (tester) async {
      await tapTile(
        tester,
        _iPhoneLandscape,
        expectPush: true,
        reason: 'largura grande não faz dele um tablet',
      );
    });

    _testWidgets('iPad: NÃO empurra — o painel detail reage à seleção', (
      tester,
    ) async {
      await tapTile(
        tester,
        _iPadPortrait,
        expectPush: false,
        reason: 'o detail pane reage à seleção, sem navegar',
      );
    });

    _testWidgets('iPad paisagem: NÃO empurra', (tester) async {
      await tapTile(
        tester,
        _iPadLandscape,
        expectPush: false,
        reason: 'dois painéis — o chat já está visível',
      );
    });
  });

  group('HomePage — estado vazio preso a kMaxContentWidth (:598/:645)', () {
    // Duas telas de "vazio" aplicam o limite — e sobram DOIS pontos no
    // arquivo, então cada um precisa do seu próprio caso:
    //   :645  _EmptyState        — sem peer (HomeNoPeer), "No pairings yet"
    //   :598  _LonelyEmptyState  — com peer e ZERO rooms (counts.all == 0)
    // Sem o segundo, trocar :598 por `double.infinity` passa batido (foi
    // exatamente o que a mutação 3a mostrou).
    //
    // A asserção usa `tester.getRect` (geometria real do render), não só a
    // presença do `ConstrainedBox`: `findsOneWidget` continuaria verde com
    // qualquer outro `ConstrainedBox` de maxWidth 460 na subárvore.
    Future<void> assertClamped(
      WidgetTester tester,
      Size size,
      String marker, {
      required bool withPeer,
      bool withRoom = true,
    }) async {
      final rig = await _homeRig(tester, withPeer: withPeer, withRoom: withRoom);
      await _pumpHome(tester, size, rig);

      // As asserções vêm antes da limpeza (árvore ainda montada), mas a
      // limpeza fica num `finally`: se a asserção falhar sem desmontar, o
      // watchdog do ConnectionManager segue pendente e o framework trava em
      // `did not complete` em vez de reportar a falha (visto nas mutações 3).
      try {
        expect(find.text(marker), findsOneWidget, reason: 'estado esperado');
        final clamped = find.byWidgetPredicate(
          (w) =>
              w is ConstrainedBox &&
              w.constraints.maxWidth == _documentedMaxContentWidth,
        );
        expect(
          clamped,
          findsOneWidget,
          reason: '$marker deve aplicar o limite documentado',
        );
        expect(
          tester.getRect(clamped.first).width,
          lessThanOrEqualTo(_documentedMaxContentWidth + 0.01),
          reason: 'o conteúdo não pode passar de 460 em ${size.width}px',
        );
      } finally {
        await tester.pumpWidget(const SizedBox());
        rig.dispose();
      }
    }

    _testWidgets('iPhone: limite aplicado em _EmptyState (:645)', (
      tester,
    ) async {
      await assertClamped(
        tester,
        _iPhonePortrait,
        'No pairings yet',
        withPeer: false,
      );
    });

    _testWidgets('iPad: limite aplicado em _EmptyState (:645)', (tester) async {
      await assertClamped(
        tester,
        _iPadPortrait,
        'No pairings yet',
        withPeer: false,
      );
    });

    // Com peer e nenhuma room, `counts.all == 0` → _LonelyEmptyState (:598).
    _testWidgets('iPad: limite aplicado em _LonelyEmptyState (:598)', (
      tester,
    ) async {
      await assertClamped(
        tester,
        _iPadPortrait,
        'Nothing here…',
        withPeer: true,
        withRoom: false,
      );
    });
  });

  group('SessionListPage — navegação (:107)', () {
    // Mesma regra do Home: asserção com a árvore montada, desmonte por último.
    Future<void> tapSession(
      WidgetTester tester,
      Size size, {
      required bool expectPush,
      required String reason,
    }) async {
      _useSize(tester, size);
      late SessionListViewModel vm;
      late Preferences prefs;
      late ConnectionManager conn;

      await tester.runAsync(() async {
        final storage = _FakeStorage([_peer()]);
        final ch = _Channel();
        conn = ConnectionManager(
          factory: (_, _) async => ch,
          storage: storage,
          emitDebounce: Duration.zero,
        );
        await conn.connectTo(_peer());
        await _tick();
        prefs = Preferences(_FakeSecureStorage());
        vm = SessionListViewModel(
          SessionCatalog(conn),
          conn,
          prefs,
          epk: _epk,
          roomId: _roomId,
        );
        await _tick();
      });

      await tester.pumpWidget(
        ChangeNotifierProvider<SessionListViewModel>.value(
          value: vm,
          child: MaterialApp.router(
            theme: buildDarkTheme(),
            routerConfig: GoRouter(
              initialLocation: '/session-list',
              routes: [
                GoRoute(
                  path: '/session-list',
                  builder: (_, _) =>
                      const SessionListPage(title: 'proj', device: 'Mac'),
                ),
                GoRoute(
                  path: '/chat',
                  builder: (_, _) => const Scaffold(
                    body: Center(child: Text(_kChatMarker)),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await _settle(tester);

      // A lista precisa estar pronta, senão não há ListTile para tocar.
      expect(find.text('Session One'), findsOneWidget);

      await tester.tap(find.text('Session One'));
      // O `onTap` da tile é async (await vm.pick antes do push), e a cadeia
      // depende do event loop REAL — dentro do relógio falso ela fica
      // pendurada. Deixa-a correr em `runAsync` e só então renderiza o frame
      // da navegação; sem isso o push nunca acontece e o teste dá falso
      // negativo (verificado: sem este passo, 0 marcadores na árvore).
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await _settle(tester);

      if (expectPush) {
        expect(find.text(_kChatMarker), findsOneWidget, reason: reason);
      } else {
        expect(find.text(_kChatMarker), findsNothing, reason: reason);
        expect(
          find.text('Session One'),
          findsOneWidget,
          reason: 'deve continuar na lista — $reason',
        );
      }

      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      prefs.dispose();
      conn.dispose();
    }

    _testWidgets('iPhone: tocar uma sessão empurra /chat', (tester) async {
      await tapSession(
        tester,
        _iPhonePortrait,
        expectPush: true,
        reason: 'celular abre o chat em tela cheia',
      );
    });

    _testWidgets('iPad: NÃO empurra — o painel detail cuida disso', (
      tester,
    ) async {
      await tapSession(
        tester,
        _iPadPortrait,
        expectPush: false,
        reason: 'o painel detail já mostra a sessão escolhida',
      );
    });
  });
}
