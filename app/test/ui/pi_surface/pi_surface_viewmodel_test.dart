// Plan/68 W3b — o viewmodel da superfície Pi.
//
// O que só o viewmodel pode provar: a superfície fala na room ATIVA (a do
// workspace), não na `host` — ao contrário do picker de workspace. Se isso
// regredir, o `pi_surface` iria para o supervisor e a tela ficaria vazia para
// sempre. E as operações nunca são otimistas: cada uma re-lê o host.

import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/pi_surface/states/pi_surface_state.dart';
import 'package:app/ui/pi_surface/viewmodels/pi_surface_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _epk = 'Bz02uLi';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _Channel implements IChannel, IControlLink {
  _Channel({this.skills = const [], this.packages = const [], this.surfaceError});

  List<WireSkill> skills;
  final List<WirePackage> packages;
  final String? surfaceError;

  final sentTypes = <String>[];
  final installRequests = <Map<String, dynamic>>[];

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
        if (surfaceError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.piSurface,
            rawAction: 'pi_surface',
            error: surfaceError!,
          ));
          return;
        }
        _server.add(PiSurfaceOk(
          inReplyTo: msg.id,
          runtime: const PiSurfaceRuntime(running: true, model: 'p/m'),
          skills: skills,
          packages: packages,
        ));
      case SkillSetEnabled(:final id, :final name, :final enabled):
        skills = [
          for (final s in skills)
            if (s.name == name)
              WireSkill(
                name: s.name,
                description: s.description,
                source: s.source,
                path: s.path,
                enabled: enabled,
              )
            else
              s,
        ];
        _server.add(SkillSetEnabledOk(inReplyTo: id, name: name, enabled: enabled));
      case SkillInvoke(:final id, :final name):
        _server.add(SkillInvokeOk(inReplyTo: id, name: name));
      case PackageInstall(:final id, :final source, :final scope):
        installRequests.add(j);
        _server.add(PackageOpOk(
          inReplyTo: id,
          op: PackageOp.install,
          source: source,
          scope: scope,
        ));
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

Future<void> _drain(PiSurfaceViewModel vm) async {
  for (var i = 0; i < 30 && vm.state is PiSurfaceLoading; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  await Future<void>.delayed(const Duration(milliseconds: 10));
}

Future<(PiSurfaceViewModel, _Channel, ConnectionManager)> _rig(_Channel ch) async {
  final conn = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await conn.connectTo(_peer());
  await Future<void>.delayed(const Duration(milliseconds: 20));
  conn.switchRoom('room-1'); // a room do workspace ativo
  final vm = PiSurfaceViewModel(SessionCatalog(conn));
  await _drain(vm);
  return (vm, ch, conn);
}

void main() {
  test('carrega a superfície na room ATIVA (não na host)', () async {
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
    final (vm, _, conn) = await _rig(ch);

    expect(ch.sentTypes, contains('pi_surface'));
    // A room do chat continua sendo a ativa: a superfície foi pedida por lá.
    expect(conn.activeRoomId, 'room-1');
    final s = vm.state as PiSurfaceReady;
    expect(s.skills.single.name, 'pdf-tools');
    expect(s.runtime.running, isTrue);
    conn.dispose();
  });

  test('erro tipado do host vira mensagem clara', () async {
    final (vm, _, conn) = await _rig(_Channel(surfaceError: 'offline'));
    final s = vm.state as PiSurfaceError;
    expect(s.message, contains('Not connected'));
    conn.dispose();
  });

  test('toggle re-lê o host (nunca otimista)', () async {
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
    final (vm, _, conn) = await _rig(ch);

    final ok = await vm.setSkillEnabled('pdf-tools', false);
    expect(ok, isTrue);
    expect(ch.sentTypes.where((t) => t == 'pi_surface').length, 2, reason: 're-lê após mudar');
    expect((vm.state as PiSurfaceReady).skills.single.enabled, isFalse);
    conn.dispose();
  });

  test('invoke limpa o spinner e o resultado sai pelo chat', () async {
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
    final (vm, _, conn) = await _rig(ch);

    final ok = await vm.invokeSkill('pdf-tools', args: 'a.pdf');
    expect(ok, isTrue);
    final s = vm.state as PiSurfaceReady;
    expect(s.busySkill, isNull, reason: 'o spinner some quando o dispatch é aceito');
    conn.dispose();
  });

  test('install repassa confirm_third_party e registra a operação', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);

    final ok = await vm.installPackage(
      source: 'npm:@x/y@1',
      scope: PackageScope.user,
      confirmThirdParty: true,
    );
    expect(ok, isTrue);
    expect(ch.installRequests.single['confirm_third_party'], isTrue);
    expect((vm.state as PiSurfaceReady).lastOp?.op, PackageOp.install);
    conn.dispose();
  });

  test('update sem source reconcilia todos', () async {
    final ch = _Channel();
    final (vm, _, conn) = await _rig(ch);
    await vm.updatePackages();
    expect(ch.sentTypes, contains('package_update'));
    expect((vm.state as PiSurfaceReady).lastOp?.source, isEmpty);
    conn.dispose();
  });

  test('remove passa o source e o escopo', () async {
    final ch = _Channel(
      packages: const [WirePackage(source: 'npm:@x/y@1', scope: PackageScope.user)],
    );
    final (vm, _, conn) = await _rig(ch);
    final ok = await vm.removePackage('npm:@x/y@1', scope: PackageScope.user);
    expect(ok, isTrue);
    expect((vm.state as PiSurfaceReady).lastOp?.op, PackageOp.remove);
    conn.dispose();
  });
}
