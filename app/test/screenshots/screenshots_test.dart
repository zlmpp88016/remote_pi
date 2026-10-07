// Harness de screenshots — renderiza as telas reais em PNG, no Windows.
//
// Por que existe: o app e mobile-only (`MethodChannelOwnerIdentityStore` em
// `dependencies.dart`, plugin so com android/ios), entao `flutter run -d
// windows` nao sobe. Mas o `lib/ui/` e Flutter puro — o mesmo widget tree que
// roda no iPhone. Um teste de widget renderiza a pagina de verdade sem
// executar nenhum bootstrap de plataforma, e o golden vira a imagem.
//
// Uso: `scripts/screenshots.sh` (nao roda no `flutter test` normal — veja o
// guard de SCREENSHOTS abaixo).
//
// As fontes do sistema sao carregadas via FontLoader porque `flutter test`
// usa Ahem por padrao, que desenha todo glifo como um retangulo solido.

import 'dart:async';
import 'dart:io';

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
import 'package:app/ui/onboarding/onboarding_page.dart';
import 'package:app/ui/onboarding/viewmodels/onboarding_viewmodel.dart';
import 'package:app/ui/pi_surface/pi_surface_page.dart';
import 'package:app/ui/pi_surface/viewmodels/pi_surface_viewmodel.dart';
import 'package:app/ui/sessions/session_list_page.dart';
import 'package:app/ui/sessions/viewmodels/session_list_viewmodel.dart';
import 'package:app/ui/settings/settings_page.dart';
import 'package:app/ui/settings/viewmodels/settings_viewmodel.dart';
import 'package:app/ui/update/viewmodels/update_banner_viewmodel.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_browser_viewmodel.dart';
import 'package:app/ui/workspaces/workspace_browser_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

// ---------------------------------------------------------------------------
// Configuracao
// ---------------------------------------------------------------------------

/// So roda quando pedido explicitamente, para nao poluir o `flutter test`
/// normal com PNGs. O script passa `--dart-define=SCREENSHOTS=true`.
const bool _enabled = bool.fromEnvironment('SCREENSHOTS');

/// Onde os PNGs saem, relativo a `app/`.
const String _outDir = String.fromEnvironment(
  'SCREENSHOT_DIR',
  defaultValue: 'build/screenshots',
);

/// O app usa `kMonoFamily = 'Courier'`; no Windows a fonte real e `cour*.ttf`.
const _monoFiles = ['cour.ttf', 'courbd.ttf'];
const _sansFiles = ['segoeui.ttf', 'segoeuib.ttf'];

/// Familia sans usada SO nas capturas: o app deixa `kSansFamily = null` (sans
/// do sistema), que no `flutter test` cai no Ahem (retangulos solidos).
const String _sansShotFamily = 'ScreenshotSans';

/// Aparelhos alvo: os mesmos do teste de layout (pixels logicos).
const _devices = <String, Size>{
  'iphone': Size(393, 852),
  'ipad': Size(1024, 1366),
};

const _epk = 'Bz02uLi';
const _roomId = 'room-1';

// ---------------------------------------------------------------------------
// Fontes reais
// ---------------------------------------------------------------------------

Future<void> _loadFont(String family, List<String> files) async {
  final loader = FontLoader(family);
  var found = false;
  for (final f in files) {
    final file = File('C:/Windows/Fonts/$f');
    if (!file.existsSync()) continue;
    final bytes = file.readAsBytesSync();
    loader.addFont(
      Future<ByteData>.value(ByteData.view(Uint8List.fromList(bytes).buffer)),
    );
    found = true;
  }
  if (found) await loader.load();
}

Future<void> _loadRealFonts() async {
  await _loadFont(kMonoFamily, _monoFiles);
  await _loadFont(_sansShotFamily, _sansFiles);
  // O titulo de marca ("Remote Pi") vem de `brandTextStyle`, que usa
  // google_fonts. Como a carga HTTP esta desligada nos screenshots, o pacote
  // cai no `fontFamilyFallback: ['Inter']` — registrar 'Inter' aqui cobre
  // essa familia e o titulo deixa de sair como retangulo solido.
  await _loadFont('Inter', _sansFiles);
  await _loadFont('Inter_700', _sansFiles);
  await _loadFont('Inter_600', _sansFiles);
  await _loadFont('Inter_500', _sansFiles);
}

/// Mesmo tema do app, com o sans trocado por uma fonte real para o texto das
/// capturas ficar legivel.
ThemeData _shotTheme() {
  final base = buildDarkTheme();
  return base.copyWith(
    textTheme: base.textTheme.apply(fontFamily: _sansShotFamily),
  );
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/// Cobre toda a superficie do FlutterSecureStorage sem escrever cada metodo:
/// so `read`/`write` importam aqui.
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
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// `PairingStorage` e uma classe concreta (extends ChangeNotifier), entao o
// fake a ESTENDE e sobrescreve so o que as telas leem.
class _FakeStorage extends PairingStorage {
  _FakeStorage([List<PeerRecord>? peers]) : peers = peers ?? const [];
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

/// Canal fake que responde o minimo para as telas nao saírem vazias: a lista
/// de sessoes e o switch.
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
                name: 'refatorar o parser de protocolo',
                mtime: 1759500000,
                live: true,
              ),
              WireSessionInfo(
                id: 's2',
                name: 'implementar o painel de sessoes',
                mtime: 1759400000,
                live: false,
              ),
              WireSessionInfo(
                id: 's3',
                name: 'ajustes de layout no chat',
                mtime: 1759300000,
                live: false,
              ),
            ],
          ),
        );
      case SessionSwitch(:final id, :final sessionId):
        _server.add(
          SessionSwitchOk(
            inReplyTo: id,
            sessionId: sessionId,
            sessionStartedAt: 1759500000,
          ),
        );
      // Plan/68 — o navegador de pastas do host.
      case FsList(:final id, :final path):
        _server.add(_fsListOk(id, path));
      // Plan/68 — a superficie Pi (skills + packages).
      case PiSurface(:final id):
        _server.add(
          PiSurfaceOk(
            inReplyTo: id,
            runtime: const PiSurfaceRuntime(
              running: true,
              model: 'anthropic/claude-opus-4-7',
              thinking: ThinkingLevel.medium,
            ),
            skills: const [
              WireSkill(
                name: 'code-review',
                description: 'Revisa o diff atual procurando bugs e regressoes',
                source: SkillSource.project,
                path: '/Users/jacob/Projects/remote_pi/.pi/skills/code-review/SKILL.md',
                enabled: true,
              ),
              WireSkill(
                name: 'pdf-tools',
                description: 'Extrai texto e tabelas de PDFs',
                source: SkillSource.user,
                path: '/Users/jacob/.pi/agent/skills/pdf-tools/SKILL.md',
                enabled: true,
              ),
              WireSkill(
                name: 'commit-style',
                description: 'Convencoes de mensagem de commit',
                source: SkillSource.package,
                path: '/Users/jacob/.pi/agent/npm/node_modules/pi-extras/skills/commit-style/SKILL.md',
                enabled: true,
                disableModelInvocation: true,
              ),
            ],
            packages: const [
              WirePackage(
                source: 'npm:@remote-pi/extras@0.4.1',
                scope: PackageScope.user,
                resources: ['skills', 'prompts'],
              ),
              WirePackage(
                source: 'git:github.com/example/pi-team-tools',
                scope: PackageScope.project,
                resources: ['skills'],
              ),
            ],
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

  /// Uma árvore de pastas plausível para a captura do seletor de workspace.
  /// O `path` pedido define o nível, para o breadcrumb não ficar vazio.
  FsListOk _fsListOk(String replyTo, String path) {
    const home = '/Users/jacob';
    if (path == home) {
      return FsListOk(
        inReplyTo: replyTo,
        path: home,
        parent: '/Users',
        entries: const [
          WireFsEntry(name: 'Projects', kind: 'dir'),
          WireFsEntry(name: 'Documents', kind: 'dir'),
          WireFsEntry(name: 'Movies', kind: 'dir'),
          WireFsEntry(name: '.config', kind: 'dir'),
          WireFsEntry(name: 'notes.md', kind: 'file'),
        ],
      );
    }
    final projects = '$home/Projects';
    if (path == projects) {
      return FsListOk(
        inReplyTo: replyTo,
        path: projects,
        parent: home,
        entries: const [
          WireFsEntry(name: 'remote_pi', kind: 'dir', isRepo: true),
          WireFsEntry(name: 'cockpit', kind: 'dir', isRepo: true),
          WireFsEntry(name: 'sandbox', kind: 'dir'),
          WireFsEntry(name: 'README.md', kind: 'file'),
        ],
      );
    }
    return FsListOk(
      inReplyTo: replyTo,
      path: path,
      parent: projects,
      entries: const [
        WireFsEntry(name: 'lib', kind: 'dir'),
        WireFsEntry(name: 'test', kind: 'dir'),
        WireFsEntry(name: 'pubspec.yaml', kind: 'file'),
      ],
    );
  }
}

// Stubs de rede: a captura nao pode depender de HTTP.
class _NoUpdate implements UpdateChecker {
  @override
  Future<UpdateInfo?> fetchLatest() async => null;
}

class _NoDismissed implements DismissedUpdateStore {
  @override
  Future<String?> dismissedVersion() async => null;
  @override
  Future<void> dismiss(String version) async {}
}

class _NoOpener implements UrlOpener {
  @override
  Future<bool> open(String url) async => false;
}

// ---------------------------------------------------------------------------
// Wiring das telas
// ---------------------------------------------------------------------------

class _Scenario {
  _Scenario({
    required this.providers,
    required this.child,
    this.dispose = _noop,
  });
  final List<SingleChildWidget> providers;
  final Widget child;
  final void Function() dispose;
}

void _noop() {}

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// Deixa as futures de verdade (conexao, catalogo, load dos VMs) resolverem.
/// Precisa de `runAsync`: dentro do relogio falso os `Future.delayed` ficam
/// pendurados.
Future<void> _real(WidgetTester tester, [int ms = 25]) => tester.runAsync(
  () => Future<void>.delayed(Duration(milliseconds: ms)),
);

Future<_Scenario> _home(WidgetTester tester, {bool withPeer = true}) async {
  final storage = _FakeStorage(withPeer ? [_peer()] : const []);
  final ch = _Channel();
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: storage,
    emitDebounce: Duration.zero,
  );
  if (withPeer) {
    await conn.connectTo(_peer());
    await _real(tester);
    ch.pushControl(
      const RoomAnnounced(
        peer: _epk,
        roomId: _roomId,
        startedAt: 1759500000,
        cwd: '/Users/jacob/Projects/remote_pi',
        name: 'proj',
      ),
    );
    await _real(tester);
  }
  final prefs = Preferences(_FakeSecureStorage());
  final vm = HomeViewModel(storage, prefs, conn);
  await _real(tester);
  final sel = SessionSelection();
  final shell = ShellLayout();
  return _Scenario(
    providers: [
      ChangeNotifierProvider<HomeViewModel>.value(value: vm),
      ChangeNotifierProvider<ShellLayout>.value(value: shell),
      ChangeNotifierProvider<SessionSelection>.value(value: sel),
      ChangeNotifierProvider<Preferences>.value(value: prefs),
      ChangeNotifierProvider<UpdateBannerViewModel>.value(
        value: UpdateBannerViewModel(
          _NoUpdate(),
          _NoDismissed(),
          _NoOpener(),
          currentVersion: '0.0.0',
          enabled: true,
        ),
      ),
    ],
    child: const HomePage(),
    dispose: () {
      vm.dispose();
      sel.dispose();
      shell.dispose();
      prefs.dispose();
      conn.dispose();
    },
  );
}

Future<_Scenario> _sessionList(WidgetTester tester) async {
  final ch = _Channel();
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage([_peer()]),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await _real(tester);
  final prefs = Preferences(_FakeSecureStorage());
  final vm = SessionListViewModel(
    SessionCatalog(conn),
    conn,
    prefs,
    epk: _epk,
    roomId: _roomId,
  );
  await _real(tester);
  return _Scenario(
    providers: [ChangeNotifierProvider<SessionListViewModel>.value(value: vm)],
    child: const SessionListPage(title: 'proj', device: 'Mac de Teste'),
    dispose: () {
      vm.dispose();
      prefs.dispose();
      conn.dispose();
    },
  );
}

Future<_Scenario> _workspaceBrowser(WidgetTester tester) async {
  final ch = _Channel();
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage([_peer()]),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await _real(tester);
  final vm = WorkspaceBrowserViewModel(SessionCatalog(conn));
  await _real(tester, 80);
  // Entra em ~/Projects para a captura mostrar o nível interessante (repos).
  vm.openTyped('/Users/jacob/Projects');
  await _real(tester, 80);
  return _Scenario(
    providers: [ChangeNotifierProvider<WorkspaceBrowserViewModel>.value(value: vm)],
    child: const WorkspaceBrowserPage(epk: _epk, device: 'Mac de Teste'),
    dispose: () {
      vm.dispose();
      conn.dispose();
    },
  );
}

Future<_Scenario> _piSurface(WidgetTester tester) async {
  final ch = _Channel();
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage([_peer()]),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await _real(tester);
  final vm = PiSurfaceViewModel(SessionCatalog(conn));
  await _real(tester, 80);
  return _Scenario(
    providers: [ChangeNotifierProvider<PiSurfaceViewModel>.value(value: vm)],
    child: const PiSurfacePage(device: 'Mac de Teste'),
    dispose: () {
      vm.dispose();
      conn.dispose();
    },
  );
}

Future<_Scenario> _onboarding(WidgetTester tester) async {
  final prefs = Preferences(_FakeSecureStorage());
  final vm = OnboardingViewModel(prefs);
  return _Scenario(
    providers: [
      ChangeNotifierProvider<OnboardingViewModel>.value(value: vm),
      ChangeNotifierProvider<Preferences>.value(value: prefs),
    ],
    child: const OnboardingPage(),
    dispose: () {
      vm.dispose();
      prefs.dispose();
    },
  );
}

Future<_Scenario> _settings(WidgetTester tester) async {
  final ch = _Channel();
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage([_peer()]),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await _real(tester);
  final prefs = Preferences(_FakeSecureStorage());
  final vm = SettingsViewModel(_FakeStorage([_peer()]), prefs, conn);
  await _real(tester);
  return _Scenario(
    providers: [
      ChangeNotifierProvider<SettingsViewModel>.value(value: vm),
      ChangeNotifierProvider<Preferences>.value(value: prefs),
    ],
    child: const SettingsPage(),
    dispose: () {
      vm.dispose();
      prefs.dispose();
      conn.dispose();
    },
  );
}

/// Telas capturadas: id -> builder.
final _pages = <String, Future<_Scenario> Function(WidgetTester)>{
  'home-com-peer': (t) => _home(t),
  'home-sem-peer': (t) => _home(t, withPeer: false),
  'sessions': _sessionList,
  'onboarding': _onboarding,
  'settings': _settings,
  // Plan/68 — o caminho novo: escolher workspace caminhando no host e
  // gerenciar as skills/packages do Pi daquela máquina.
  'workspace-browser': _workspaceBrowser,
  'pi-surface': _piSurface,
};

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

void main() {
  // Sem --dart-define=SCREENSHOTS=true isto e no-op, para o `flutter test`
  // normal nao gerar PNGs nem falhar por um harness que nao e teste.
  if (!_enabled) return;

  setUpAll(() async {
    // O titulo "Remote Pi" resolve via google_fonts, que nao acha a Inter nos
    // assets e rejeita a carga. A rejeicao so aparece quando um `runAsync`
    // desta harness lhe da um event loop real — o mesmo problema do
    // home_page_layout_test. Aqui a captura nao mede tipografia, entao a
    // guarda descarta so essa rejeicao.
    GoogleFonts.config.allowRuntimeFetching = false;
    await _loadRealFonts();
    Directory(_outDir).createSync(recursive: true);
  });

  tearDownAll(() {
    GoogleFonts.config.allowRuntimeFetching = true;
  });

  for (final entry in _pages.entries) {
    for (final dev in _devices.entries) {
      testWidgets('${entry.key} @ ${dev.key}', (tester) async {
        // Mesma guarda do home_page_layout_test: o google_fonts rejeita a
        // carga da Inter quando um runAsync da harness lhe da um event loop
        // real, e isso quebraria a captura por um motivo alheio a UI.
        Object? failure;
        StackTrace? failureStack;
        await runZonedGuarded(
          () async {
            try {
              await _capture(
                tester,
                '${entry.key}-${dev.key}',
                entry.value,
                dev.value,
              );
            } catch (e, s) {
              failure = e;
              failureStack = s;
            }
          },
          (e, s) {
            if (s.toString().contains('package:google_fonts/')) return;
            failure ??= e;
            failureStack ??= s;
          },
        );
        if (failure != null) {
          Error.throwWithStackTrace(failure!, failureStack!);
        }
      });
    }
  }
}

Future<void> _capture(
  WidgetTester tester,
  String id,
  Future<_Scenario> Function(WidgetTester) build,
  Size size,
) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final scenario = await build(tester);

  await tester.pumpWidget(
    MultiProvider(
      providers: scenario.providers,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: _shotTheme(),
        home: scenario.child,
      ),
    ),
  );
  // Pumps limitados: varias telas mostram spinner de Loading que nunca
  // settle, entao `pumpAndSettle` travaria.
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
  await _real(tester, 80);
  await tester.pump(const Duration(milliseconds: 200));

  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('$_outDir/$id.png'),
  );

  await tester.pumpWidget(const SizedBox());
  scenario.dispose();
}
