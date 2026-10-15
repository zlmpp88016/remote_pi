/// VM da superfície Remote Pi com client falso: prova o fluxo
/// parear→listar→navegar→start→chat e o tratamento dos pushes
/// (`workspace_state`, `host_message`) sem rede.
library;

import 'dart:async';

import 'package:cockpit/app/core/domain/result.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/host_client.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/host_client_factory.dart';
import 'package:cockpit/app/remote_pi/domain/entities/host_protocol.dart';
import 'package:cockpit/app/remote_pi/domain/entities/pairing_code.dart';
import 'package:cockpit/app/remote_pi/domain/errors/host_error.dart';
import 'package:cockpit/app/remote_pi/ui/viewmodels/remote_pi_host_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _kPairUri =
    'remotepi://pair?t='
    'AAAAAAAAAAAAAAAAAAAAAA'
    '&epk='
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    '&n=Mac%20do%20Jacob&r=wss://relay.example';

WorkspaceInfo _ws({
  required String cwd,
  required String room,
  bool live = false,
  WorkspaceSource source = WorkspaceSource.daemon,
}) => WorkspaceInfo(
  cwd: cwd,
  daemonId: 'd-$cwd',
  roomId: room,
  name: cwd.split('/').last,
  live: live,
  daemon: live,
  source: source,
);

class _FakeHostClient implements HostClient {
  final _events = StreamController<HostEvent>.broadcast();

  HostConnectionStatus _status = HostConnectionStatus.disconnected;
  String? _hostEpk;

  // comportamento configurável
  Result<void, HostError> connectResult = const Success(null);
  Result<PairOk, HostError> pairResult = const Success(
    PairOk(
      inReplyTo: 'x',
      sessionName: 'Mac do Jacob',
      sessionStartedAt: 1,
      roomId: 'host',
      hostname: 'mac-do-jacob',
    ),
  );
  Result<HostHelloOk, HostError> helloResult = const Success(
    HostHelloOk(
      inReplyTo: 'x',
      daemon: HostDaemonInfo(version: '1.4.0', hostname: 'mac', platform: 'darwin'),
      capabilities: ['host_pairing', 'workspace_state', 'fs_nav'],
    ),
  );
  Result<WorkspaceListOk, HostError> listResult = Success(
    WorkspaceListOk(
      inReplyTo: 'x',
      workspaces: [
        _ws(cwd: '/ws/um', room: 'ws-room-1', live: true),
        _ws(cwd: '/ws/dois', room: 'ws-room-2'),
      ],
    ),
  );
  Result<FsListOk, HostError> fsResult = Success(
    FsListOk(
      inReplyTo: 'x',
      path: '/ws',
      parent: '/',
      entries: const [FsEntry(name: 'um', kind: FsEntryKind.dir, isRepo: true)],
    ),
  );
  Result<ActionOk, HostError> addResult = const Success(
    ActionOk(inReplyTo: 'x', action: 'workspace_add'),
  );
  Result<WorkspaceStartOk, HostError> startResult = const Success(
    WorkspaceStartOk(
      inReplyTo: 'x',
      cwd: '/ws/um',
      roomId: 'ws-room-1',
      daemonId: 'd9',
    ),
  );
  Result<WorkspaceRestartOk, HostError> restartResult = const Success(
    WorkspaceRestartOk(inReplyTo: 'x', cwd: '/ws/um', daemonId: 'd9'),
  );

  // chamadas gravadas
  final List<String> calls = [];
  String? lastChatRoom;
  String? lastChatText;
  int chatCounter = 0;

  @override
  HostConnectionStatus get status => _status;

  @override
  String? get hostEpk => _hostEpk;

  @override
  Stream<HostEvent> get events => _events.stream;

  @override
  Future<Result<void, HostError>> connect(String relayUrl) async {
    calls.add('connect:$relayUrl');
    if (connectResult case Success()) {
      _status = HostConnectionStatus.connected;
    }
    return connectResult;
  }

  @override
  Future<Result<PairOk, HostError>> pair(PairingCode code) async {
    calls.add('pair');
    if (pairResult case Success()) _hostEpk = code.hostEpk;
    return pairResult;
  }

  @override
  Future<Result<HostHelloOk, HostError>> helloHost() async {
    calls.add('hello');
    return helloResult;
  }

  @override
  Future<Result<WorkspaceListOk, HostError>> listWorkspaces() async {
    calls.add('list');
    return listResult;
  }

  @override
  Future<Result<FsListOk, HostError>> fsList(
    String path, {
    bool showHidden = false,
  }) async {
    calls.add('fs:$path');
    return fsResult;
  }

  @override
  Future<Result<ActionOk, HostError>> addWorkspace(String path) async {
    calls.add('add:$path');
    return addResult;
  }

  @override
  Future<Result<WorkspaceStartOk, HostError>> startWorkspace(String cwd) async {
    calls.add('start:$cwd');
    return startResult;
  }

  @override
  Future<Result<WorkspaceRestartOk, HostError>> restartWorkspace(
    String cwd,
  ) async {
    calls.add('restart:$cwd');
    return restartResult;
  }

  @override
  String sendChat({required String room, required String text}) {
    lastChatRoom = room;
    lastChatText = text;
    chatCounter += 1;
    calls.add('chat:$room');
    return 'msg-$chatCounter';
  }

  @override
  Future<void> close() async {
    calls.add('close');
    _status = HostConnectionStatus.disconnected;
  }

  // ── helpers de teste ──
  void emit(HostEvent event) => _events.add(event);
}

class _FakeHostClientFactory implements HostClientFactory {
  _FakeHostClientFactory(this.client);

  final _FakeHostClient client;
  int created = 0;

  @override
  HostClient create() {
    created += 1;
    return client;
  }
}

void main() {
  late _FakeHostClient client;
  late _FakeHostClientFactory factory;
  late RemotePiHostViewModel vm;

  setUp(() {
    client = _FakeHostClient();
    factory = _FakeHostClientFactory(client);
    vm = RemotePiHostViewModel(factory);
  });

  tearDown(() async {
    vm.dispose();
  });

  test('connectWithCode: pareia, dá hello, lista e semeia o runtime', () async {
    await vm.connectWithCode(relayUrl: 'wss://outro', code: _kPairUri);

    expect(vm.status, HostConnectionStatus.connected);
    expect(vm.error, isNull);
    expect(vm.hello?.daemon.hostname, 'mac');
    expect(vm.hello?.capabilities, contains('fs_nav'));
    expect(vm.workspaces, hasLength(2));
    expect(vm.selectedWorkspace?.cwd, '/ws/um');
    expect(vm.runtimeStateOf(vm.workspaces.first).state, WorkspaceState.running);
    expect(vm.runtimeStateOf(vm.workspaces.last).state, WorkspaceState.stopped);
    expect(client.calls, containsAll(['pair', 'hello', 'list']));
    // O código manda no relay quando traz `r`.
    expect(client.calls, contains('connect:wss://relay.example'));
  });

  test('código inválido → erro tipado, sem tocar na rede', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: '::');
    expect(vm.error, isA<HostPairingCodeError>());
    expect(
      (vm.error as HostPairingCodeError).problem,
      PairingCodeProblem.notAUri,
    );
    expect(factory.created, 0);
    expect(vm.status, HostConnectionStatus.disconnected);
  });

  test('falha no pair → erro surfaceado e client descartado', () async {
    client.pairResult = Failure(
      const HostPairingError(code: 'unknown', message: 'token rotacionado'),
    );
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    expect(vm.error, isA<HostPairingError>());
    expect(vm.status, HostConnectionStatus.disconnected);
    expect(client.calls, contains('close'));
  });

  test('browseFs navega e guarda o listing; erro vira fsError', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    await vm.browseFs('~');
    expect(vm.fsListing?.path, '/ws');
    expect(vm.fsListing?.entries.single.name, 'um');
    expect(vm.fsError, isNull);

    client.fsResult = Failure(
      const HostActionRejected(action: 'fs_list', code: 'not_found'),
    );
    await vm.browseFs('/nao-existe');
    expect(vm.fsListing, isNull);
    expect(vm.fsError, isA<HostActionRejected>());
  });

  test('addAndStartWorkspace: add → start → runtime starting → seleciona', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    await vm.addAndStartWorkspace('/ws/um');
    expect(client.calls, containsAll(['add:/ws/um', 'start:/ws/um']));
    expect(
      vm.runtimeStateOf(vm.selectedWorkspace!).state,
      WorkspaceState.starting,
    );
    expect(vm.error, isNull);
  });

  test('restartWorkspace é refletido no runtime', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    await vm.restartWorkspace('/ws/um');
    expect(client.calls, contains('restart:/ws/um'));
    expect(
      vm.runtimeStateOf(vm.workspaces.first).state,
      WorkspaceState.starting,
    );
  });

  test('sendChat monta a bolha do usuário na room selecionada', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    vm.sendChat('  oi  ');
    expect(client.lastChatRoom, 'ws-room-1');
    expect(client.lastChatText, 'oi');
    final entries = vm.chatFor(vm.selectedWorkspace!);
    expect(entries, hasLength(1));
    expect(entries.single.text, 'oi');
    expect(entries.single.fromUser, true);
  });

  test('push workspace_state(crashed) atualiza o runtime com last_error', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    client.emit(
      WorkspaceStateChanged(
        const WorkspaceStatePush(
          cwd: '/ws/um',
          state: WorkspaceState.crashed,
          lastError: 'exit 1',
          restarts: 3,
        ),
      ),
    );
    await Future<void>.delayed(Duration.zero);
    final runtime = vm.runtimeStateOf(vm.workspaces.first);
    expect(runtime.state, WorkspaceState.crashed);
    expect(runtime.lastError, 'exit 1');
    expect(runtime.restarts, 3);
  });

  test('host_message: eco + chunks + done montam o chat da room do filho', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    final room = 'ws-room-1';
    client.emit(
      ChatFrameArrived(
        room: room,
        message: const UserMessageEcho(id: 'msg-1', text: 'oi'),
      ),
    );
    client.emit(
      ChatFrameArrived(
        room: room,
        message: const AgentChunk(inReplyTo: 'msg-1', delta: 'olá '),
      ),
    );
    client.emit(
      ChatFrameArrived(
        room: room,
        message: const AgentChunk(inReplyTo: 'msg-1', delta: 'mundo'),
      ),
    );
    client.emit(
      ChatFrameArrived(
        room: room,
        message: const AgentDone('msg-1'),
      ),
    );
    await Future<void>.delayed(Duration.zero);

    final entries = vm.chatFor(vm.selectedWorkspace!);
    expect(entries, hasLength(2));
    expect(entries.first.fromUser, true);
    expect(entries.first.text, 'oi');
    expect(entries.last.fromUser, false);
    expect(entries.last.text, 'olá mundo');
    expect(entries.last.streaming, false);
  });

  test('frame de outra room não vaza pro chat selecionado', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    client.emit(
      ChatFrameArrived(
        room: 'ws-room-2',
        message: const UserMessageEcho(id: 'm2', text: 'reserva'),
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(vm.chatFor(vm.selectedWorkspace!), isEmpty);
  });

  test('HostConnectionLost derruba o status e surfaceia o erro', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    client.emit(
      const HostConnectionLost(
        HostConnectionError('conexão com o relay caiu'),
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(vm.status, HostConnectionStatus.disconnected);
    expect(vm.error, isA<HostConnectionError>());
  });

  test('disconnect limpa tudo', () async {
    await vm.connectWithCode(relayUrl: 'wss://relay', code: _kPairUri);
    await vm.browseFs('~');
    await vm.disconnect();
    expect(vm.workspaces, isEmpty);
    expect(vm.selectedWorkspace, isNull);
    expect(vm.fsListing, isNull);
    expect(vm.status, HostConnectionStatus.disconnected);
    expect(client.calls, contains('close'));
  });
}
