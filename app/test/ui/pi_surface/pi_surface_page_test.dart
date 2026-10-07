// Plan/68 W3b — a tela "Pi" do workspace (skills + packages).
//
// O ponto que estes testes protegem: a UI NUNCA inventa estado. O host diz
// `enabled: null` quando não sabe, e a tela mostra isso em vez de assumir
// "ligado". E a instalação — que executa código de terceiros — só manda
// `confirm_third_party: true` depois de dois aceites explícitos (o diálogo de
// origem e o de confirmação). Cancelar em qualquer um dos dois não envia nada.

import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/pi_surface/pi_surface_page.dart';
import 'package:app/ui/pi_surface/states/pi_surface_state.dart';
import 'package:app/ui/pi_surface/viewmodels/pi_surface_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// Fake do Pi que responde `pi_surface`, `skill_*` e `package_*`.
class _Channel implements IChannel, IControlLink {
  _Channel({
    this.skills = const [],
    this.packages = const [],
    this.running = true,
    this.model,
    this.thinking,
    this.installError,
  });

  List<WireSkill> skills;
  final List<WirePackage> packages;
  final bool running;
  final String? model;
  final ThinkingLevel? thinking;
  final String? installError;

  /// Todo `package_install` recebido, para o teste provar o flag.
  final installRequests = <Map<String, dynamic>>[];
  final sentTypes = <String>[];

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
    final j = msg.toJson();
    sentTypes.add((j['type'] as String?) ?? '');
    switch (msg) {
      case PiSurface():
        _server.add(PiSurfaceOk(
          inReplyTo: msg.id,
          runtime: PiSurfaceRuntime(
            running: running,
            model: model,
            thinking: thinking,
          ),
          skills: skills,
          packages: packages,
        ));
      case SkillSetEnabled(:final id, :final name, :final enabled):
        // The host persists, then the next pi_surface reflects it.
        skills = [
          for (final s in skills)
            if (s.name == name)
              WireSkill(
                name: s.name,
                description: s.description,
                source: s.source,
                path: s.path,
                enabled: enabled,
                disableModelInvocation: s.disableModelInvocation,
              )
            else
              s,
        ];
        _server.add(SkillSetEnabledOk(inReplyTo: id, name: name, enabled: enabled));
      case SkillInvoke(:final id, :final name):
        _server.add(SkillInvokeOk(inReplyTo: id, name: name));
      case PackageInstall(:final id, :final source, :final scope):
        installRequests.add(j);
        if (installError != null) {
          _server.add(ActionError(
            inReplyTo: id,
            action: ActionName.packageInstall,
            rawAction: 'package_install',
            error: installError!,
          ));
        } else {
          _server.add(PackageOpOk(
            inReplyTo: id,
            op: PackageOp.install,
            source: source,
            scope: scope,
          ));
        }
      case PackageRemove(:final id, :final source, :final scope):
        _server.add(PackageOpOk(
          inReplyTo: id,
          op: PackageOp.remove,
          source: source,
          scope: scope,
        ));
      case PackageUpdate(:final id, :final source):
        _server.add(PackageOpOk(
          inReplyTo: id,
          op: PackageOp.update,
          source: source ?? '',
          scope: null,
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

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

/// Taps que disparam um round-trip real: `runAsync` para o canal falso avançar
/// e pumps repetidos para as continuações de diálogo progredirem.
Future<void> _tapAsync(WidgetTester tester, Finder f) async {
  await tester.tap(f);
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
  }
}

Future<PiSurfaceViewModel> _pump(WidgetTester tester, _Channel ch) async {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(393, 900);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  late ConnectionManager conn;
  late PiSurfaceViewModel vm;
  await tester.runAsync(() async {
    conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = PiSurfaceViewModel(SessionCatalog(conn));
    await Future<void>.delayed(const Duration(milliseconds: 40));
  });
  addTearDown(conn.dispose);
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    MaterialApp(
      home: ChangeNotifierProvider<PiSurfaceViewModel>.value(
        value: vm,
        child: const PiSurfacePage(device: 'Mac de Teste'),
      ),
    ),
  );
  await _settle(tester);
  return vm;
}

void main() {
  testWidgets('lista skills com origem e packages com escopo', (tester) async {
    final ch = _Channel(
      skills: const [
        WireSkill(
          name: 'pdf-tools',
          description: 'Extract text from PDFs',
          source: SkillSource.user,
          path: '/home/me/.pi/agent/skills/pdf-tools/SKILL.md',
          enabled: true,
        ),
        WireSkill(
          name: 'repo-helper',
          description: 'Repo conventions',
          source: SkillSource.project,
          path: '/proj/.pi/skills/repo-helper/SKILL.md',
          enabled: true,
        ),
      ],
      packages: const [
        WirePackage(
          source: 'npm:@example/pi-tools@1.0.0',
          scope: PackageScope.user,
          resources: ['skills'],
        ),
      ],
      model: 'anthropic/claude-opus-4-7',
      thinking: ThinkingLevel.medium,
    );
    await _pump(tester, ch);

    expect(find.text('pdf-tools'), findsOneWidget);
    expect(find.text('repo-helper'), findsOneWidget);
    expect(find.text('project'), findsOneWidget);
    expect(find.text('npm:@example/pi-tools@1.0.0'), findsOneWidget);
    // `user` aparece duas vezes: origem da skill E escopo do package.
    expect(find.text('user'), findsNWidgets(2));
    expect(find.textContaining('Running · anthropic/claude-opus-4-7 · medium'), findsOneWidget);
  });

  testWidgets('toggle desabilita o skill e re-lê o estado do host', (tester) async {
    final ch = _Channel(
      skills: const [
        WireSkill(
          name: 'pdf-tools',
          description: 'PDFs',
          source: SkillSource.user,
          path: '/a/SKILL.md',
          enabled: true,
        ),
      ],
    );
    final vm = await _pump(tester, ch);

    await _tapAsync(tester, find.byType(Switch));
    expect(ch.sentTypes, contains('skill_set_enabled'));
    // Re-lido do host: o toggle reflete o que o host persistiu.
    expect((vm.state as PiSurfaceReady).skills.single.enabled, isFalse);
  });

  testWidgets('skill de package não pode ser alternado (vem com o pacote)', (tester) async {
    final ch = _Channel(
      skills: const [
        WireSkill(
          name: 'fmt',
          description: 'Format code',
          source: SkillSource.package,
          path: '/pkg/skills/fmt/SKILL.md',
          enabled: true,
        ),
      ],
    );
    await _pump(tester, ch);

    final toggle = tester.widget<Switch>(find.byType(Switch));
    expect(toggle.onChanged, isNull, reason: 'o pacote dono é quem liga/desliga');
  });

  testWidgets('enabled null é mostrado como desconhecido, sem assumir ligado', (tester) async {
    final ch = _Channel(
      skills: const [
        WireSkill(
          name: 'mystery',
          description: 'Unknown state',
          source: SkillSource.user,
          path: '/a/SKILL.md',
          enabled: null,
        ),
      ],
    );
    await _pump(tester, ch);

    expect(find.text('mystery'), findsOneWidget);
    final toggle = tester.widget<Switch>(find.byType(Switch));
    expect(toggle.onChanged, isNull, reason: 'sem certeza do host, não deixa alternar');
  });

  testWidgets('instalar exige dois aceites e só então manda confirm_third_party', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);

    await tester.tap(find.text('Install a package'));
    await tester.pump();
    expect(find.text('Install a package'), findsWidgets);
    await tester.enterText(find.byType(TextField), 'npm:@example/pi-tools@1.0.0');
    await tester.pump();

    await _tapAsync(tester, find.text('Continue'));
    // Segundo aceite: o aviso de código de terceiros.
    expect(find.text('Install third-party code?'), findsOneWidget);
    await _tapAsync(tester, find.text('Install'));

    expect(ch.installRequests, hasLength(1));
    expect(ch.installRequests.single['confirm_third_party'], isTrue);
    expect(ch.installRequests.single['source'], 'npm:@example/pi-tools@1.0.0');
    expect(ch.installRequests.single['scope'], 'user');
  });

  testWidgets('cancelar a confirmação de terceiros não envia nada', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);

    await tester.tap(find.text('Install a package'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'npm:@example/pi-tools@1.0.0');
    await tester.pump();
    await _tapAsync(tester, find.text('Continue'));
    await _tapAsync(tester, find.text('Cancel'));

    expect(ch.installRequests, isEmpty, reason: 'sem aceite explícito, nada sai do app');
  });

  testWidgets('remover passa pelo diálogo e envia o source', (tester) async {
    final ch = _Channel(
      packages: const [
        WirePackage(source: 'npm:@x/y@1', scope: PackageScope.user),
      ],
    );
    await _pump(tester, ch);

    await tester.tap(find.byTooltip('Remove'));
    await tester.pump();
    expect(find.text('Remove package?'), findsOneWidget);
    await _tapAsync(tester, find.text('Remove'));

    expect(ch.sentTypes, contains('package_remove'));
  });

  testWidgets('estado vazio ensina o que fazer nas duas seções', (tester) async {
    await _pump(tester, _Channel());

    expect(find.text('No skills installed on this Pi.'), findsOneWidget);
    expect(find.text('No packages installed on this Pi.'), findsOneWidget);
  });

  testWidgets('sem runtime mostra Not running (nunca inventa modelo)', (tester) async {
    await _pump(tester, _Channel(running: false));
    expect(find.text('Not running'), findsOneWidget);
  });

  testWidgets('erro de instalação vira mensagem clara com Retry', (tester) async {
    final ch = _Channel(installError: 'not_registered');
    await _pump(tester, ch);

    await tester.tap(find.text('Install a package'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'npm:@x/y@1');
    await tester.pump();
    await _tapAsync(tester, find.text('Continue'));
    await _tapAsync(tester, find.text('Install'));

    // O erro substitui o estado e a tela oferece retry.
    expect(find.text('Retry'), findsOneWidget);
  });
}
