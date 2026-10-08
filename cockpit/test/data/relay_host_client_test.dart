/// Integração mocked do cliente do room `host` (plano 69 W3) contra um stub
/// do protocolo: parear → listar → navegar → add/start → chat, provando o
/// handshake `hello → challenge → auth` (Ed25519 real, pinenacl) e o proxy
/// `host_forward`/`host_message` (decisão B do spike de multiplex).
///
/// O stub é fiel ao relay + daemon reais:
///   • relay: hello → challenge → auth (verifica a assinatura de verdade) e
///     reescreve peer/room do remetente nos envelopes entregues;
///   • daemon: responde o control plane no room `host` e reembrulha o tráfego
///     do filho como `host_message{room, ct}`.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:cockpit/app/core/domain/result.dart';
import 'package:cockpit/app/remote_pi/data/host_socket.dart';
import 'package:cockpit/app/remote_pi/data/pinenacl_ed25519_signer.dart';
import 'package:cockpit/app/remote_pi/data/relay_host_client.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/ed25519_signer.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/host_client.dart';
import 'package:cockpit/app/remote_pi/domain/entities/host_protocol.dart';
import 'package:cockpit/app/remote_pi/domain/entities/pairing_code.dart';
import 'package:cockpit/app/remote_pi/domain/errors/host_error.dart';
import 'package:cockpit/app/remote_pi/domain/value_objects/host_client_config.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pinenacl/ed25519.dart' show Signature, VerifyKey;

// ── stub ────────────────────────────────────────────────────────────────────

/// Par de sockets em memória (cliente ↔ stub), sem rede.
class _SocketPair {
  _SocketPair(this.client, this.server);
  final _FakeHostSocket client;
  final _FakeHostSocket server;
}

class _FakeHostSocket implements HostSocket {
  _FakeHostSocket(this._onSend);

  final void Function(String data) _onSend;
  final _inbound = StreamController<dynamic>.broadcast();
  bool _closed = false;

  @override
  void send(String data) {
    if (_closed) throw StateError('socket fechado');
    _onSend(data);
  }

  @override
  Stream<dynamic> get stream => _inbound.stream;

  @override
  Future<void> close() async {
    _closed = true;
    await _inbound.close();
  }

  void deliver(String frame) {
    if (!_inbound.isClosed) _inbound.add(frame);
  }

  void dropConnection() {
    if (!_inbound.isClosed) unawaited(_inbound.close());
  }
}

/// Stub do relay + daemon do host. `hostEpkB64` é a Pi-key da máquina — tudo
/// que o cliente manda DEVE ser endereçado a (hostEpkB64, room "host").
class _StubHost {
  _StubHost({
    this.closeOnAuth = false,
    this.silentTypes = const {},
    this.errorReplies = const {},
    this.delayedTypes = const {},
  });

  /// Pi-key do host (32 bytes fixos, base64 padrão).
  final String hostEpkB64 = base64.encode(List.filled(32, 0x11));
  static const hostRoom = 'host';
  static const childRoom = 'ws-room-1';

  /// Token válido no stub; qualquer outro → pair_error.
  static const validToken = 'token-bom';

  final bool closeOnAuth;

  /// Tipos que o stub NUNCA responde (prova timeout).
  final Set<String> silentTypes;

  /// Tipos que o stub responde com `action_error` (tipo → action/error).
  final Map<String, Map<String, String>> errorReplies;

  /// Tipos cuja reply só sai depois de um timer (prova close com pendente).
  final Set<String> delayedTypes;

  /// Envelopes externos recebidos — inspecionados pelos testes.
  final List<Map<String, dynamic>> outerFrames = [];

  /// Mensagens internas (ct decodificado) recebidas.
  final List<Map<String, dynamic>> innerMessages = [];

  bool authVerified = false;
  String? _clientPubkey;
  String? _nonce;
  _FakeHostSocket? _serverSide;

  _SocketPair connect() {
    late _FakeHostSocket server;
    final client = _FakeHostSocket((data) => _onClientFrame(server, data));
    server = _FakeHostSocket((data) => client.deliver(data));
    // O lado servidor entrega AO cliente: `deliver` no socket servidor é
    // assim que todos os call sites significam "frame indo pro cliente"
    // (challenge, replies, pushes). Sem este forward o frame cairia no
    // inbound do próprio servidor, que ninguém escuta.
    server.stream.listen(
      (frame) => client.deliver(frame as String),
      onDone: () => client.dropConnection(),
    );
    _serverSide = server;
    return _SocketPair(client, server);
  }

  /// Push `workspace_state` (não é reply) — o supervisor emite em
  /// exit/restart/start/stop.
  void pushWorkspaceState({
    required String cwd,
    required String state,
    String? lastError,
    int restarts = 0,
  }) {
    _sendToClient({
      'type': 'workspace_state',
      'cwd': cwd,
      'state': state,
      'last_error': lastError,
      'restarts': restarts,
    });
  }

  void _onClientFrame(_FakeHostSocket socket, String text) {
    final json = jsonDecode(text) as Map<String, dynamic>;
    final type = json['type'];

    // ── handshake do relay ──
    if (type == 'hello') {
      _clientPubkey = json['pubkey'] as String;
      _nonce = base64.encode(List.filled(32, 0x5A));
      socket.deliver(jsonEncode({'type': 'challenge', 'nonce': _nonce}));
      return;
    }
    if (type == 'auth') {
      authVerified = _verifyAuth(json['sig'] as String);
      if (closeOnAuth) socket.dropConnection();
      return;
    }

    // ── envelope {peer, room, ct} ──
    outerFrames.add(json);
    final inner = jsonDecode(
      utf8.decode(base64.decode(json['ct'] as String)),
    ) as Map<String, dynamic>;
    innerMessages.add(inner);
    _handleInner(inner);
  }

  void _handleInner(Map<String, dynamic> inner) {
    if (silentTypes.contains(inner['type'])) return;
    final forced = errorReplies[inner['type']];
    if (forced != null) {
      _sendToClient({
        'type': 'action_error',
        'in_reply_to': inner['id'],
        'action': forced['action'],
        'error': forced['error'],
      });
      return;
    }
    if (delayedTypes.contains(inner['type'])) {
      Future<void>.delayed(const Duration(milliseconds: 60), () {
        _reply(inner);
      });
      return;
    }
    _reply(inner);
  }

  void _reply(Map<String, dynamic> inner) {
    switch (inner['type']) {
      case 'pair_request':
        if (inner['token'] == validToken) {
          _sendToClient({
            'type': 'pair_ok',
            'in_reply_to': inner['id'],
            'session_name': 'Mac do Jacob',
            'session_started_at': 1782250000000,
            'room_id': hostRoom,
            'hostname': 'mac-do-jacob',
          });
        } else {
          _sendToClient({
            'type': 'pair_error',
            'in_reply_to': inner['id'],
            'code': 'unknown',
            'message': 'token inválido ou rotacionado',
          });
        }
      case 'host_hello':
        _sendToClient({
          'type': 'host_hello_ok',
          'in_reply_to': inner['id'],
          'daemon': {
            'version': '1.4.0',
            'hostname': 'mac-do-jacob',
            'platform': 'darwin',
          },
          'capabilities': ['host_pairing', 'workspace_state', 'fs_nav'],
        });
      case 'workspace_list':
        _sendToClient({
          'type': 'workspace_list_ok',
          'in_reply_to': inner['id'],
          'workspaces': [
            {
              'cwd': '/ws/um',
              'daemon_id': 'd1',
              'room_id': childRoom,
              'name': 'um',
              'live': true,
              'daemon': true,
              'source': 'daemon',
            },
            {
              'cwd': '/ws/dois',
              'daemon_id': 'd2',
              'room_id': 'ws-room-2',
              'name': 'dois',
              'live': false,
              'daemon': false,
              'source': 'added',
            },
          ],
        });
      case 'fs_list':
        _sendToClient({
          'type': 'fs_list_ok',
          'in_reply_to': inner['id'],
          'path': '/ws',
          'parent': '/',
          'entries': [
            {'name': 'um', 'kind': 'dir', 'is_repo': true},
            {'name': 'notas.txt', 'kind': 'file'},
          ],
        });
      case 'workspace_add':
        _sendToClient({
          'type': 'action_ok',
          'in_reply_to': inner['id'],
          'action': 'workspace_add',
        });
      case 'workspace_start':
        _sendToClient({
          'type': 'workspace_start_ok',
          'in_reply_to': inner['id'],
          'cwd': inner['cwd'],
          'room_id': childRoom,
          'daemon_id': 'd9',
        });
      case 'workspace_restart':
        _sendToClient({
          'type': 'workspace_restart_ok',
          'in_reply_to': inner['id'],
          'cwd': inner['cwd'],
          'daemon_id': 'd9',
        });
      case 'host_forward':
        _handleForwarded(inner);
    }
  }

  /// Simula o filho: ecoa o user_message e strema agent_chunk/agent_done —
  /// tudo reembrulhado em `host_message{room, ct}` pelo daemon (decisão B).
  void _handleForwarded(Map<String, dynamic> forward) {
    final childRoom = forward['room'] as String;
    final inner = jsonDecode(
      utf8.decode(base64.decode(forward['ct'] as String)),
    ) as Map<String, dynamic>;
    if (inner['type'] != 'user_message') return;
    _sendHostMessage(childRoom, {
      'type': 'user_message',
      'id': inner['id'],
      'text': inner['text'],
    });
    _sendHostMessage(childRoom, {
      'type': 'agent_chunk',
      'in_reply_to': inner['id'],
      'delta': 'olá ',
    });
    _sendHostMessage(childRoom, {
      'type': 'agent_chunk',
      'in_reply_to': inner['id'],
      'delta': 'mundo',
    });
    _sendHostMessage(childRoom, {
      'type': 'agent_done',
      'in_reply_to': inner['id'],
    });
  }

  /// Entrega um envelope como o relay entregaria: peer/room do REMETENTE.
  void _sendToClient(Map<String, dynamic> inner) {
    _serverSide?.deliver(
      jsonEncode({
        'peer': hostEpkB64,
        'room': hostRoom,
        'ct': base64.encode(utf8.encode(jsonEncode(inner))),
      }),
    );
  }

  /// `host_message{room, ct}` dentro do envelope do room host.
  void _sendHostMessage(String room, Map<String, dynamic> inner) {
    _sendToClient({
      'type': 'host_message',
      'room': room,
      'ct': base64.encode(utf8.encode(jsonEncode(inner))),
    });
  }

  bool _verifyAuth(String sigB64) {
    final pub = _clientPubkey;
    final nonce = _nonce;
    if (pub == null || nonce == null) return false;
    try {
      return VerifyKey(
        Uint8List.fromList(base64.decode(pub)),
      ).verify(
        signature: Signature(Uint8List.fromList(base64.decode(sigB64))),
        message: Uint8List.fromList(base64.decode(nonce)),
      );
    } catch (_) {
      return false; // pinenacl throws em assinatura forjada/malformada
    }
  }
}

class _StubSocketFactory implements HostSocketFactory {
  _StubSocketFactory(this._stub);

  final _StubHost _stub;

  @override
  Future<HostSocket> connect(Uri uri, {Iterable<String>? protocols}) async {
    lastUri = uri;
    lastProtocols = protocols?.toList();
    return _stub.connect().client;
  }

  Uri? lastUri;
  List<String>? lastProtocols;
}

class _StubSignerFactory implements Ed25519SignerFactory {
  @override
  Future<Ed25519Signer> create() async => PinenaclEd25519Signer.generate();
}

// ── testes ──────────────────────────────────────────────────────────────────

void main() {
  late _StubHost stub;
  late _StubSocketFactory factory;
  late RelayHostClient client;
  late List<HostEvent> events;
  late StreamSubscription<HostEvent> sub;

  HostClientConfig testConfig({
    Duration requestTimeout = const Duration(seconds: 2),
  }) => HostClientConfig(
    requestTimeout: requestTimeout,
    authGrace: Duration.zero,
    deviceName: 'Cockpit',
  );

  setUp(() {
    stub = _StubHost();
    factory = _StubSocketFactory(stub);
    client = RelayHostClient(factory, _StubSignerFactory(), testConfig());
    events = [];
    sub = client.events.listen(events.add);
  });

  tearDown(() async {
    await sub.cancel();
    await client.close();
  });

  test('handshake hello → challenge → auth verifica a assinatura Ed25519', () async {
    final result = await client.connect('https://relay.example');
    expect(result.isSuccess, true);
    expect(stub.authVerified, true);
    // http(s) na forma usuário → ws(s) no fio.
    expect(factory.lastUri.toString(), 'wss://relay.example');
    expect(client.status, HostConnectionStatus.connected);
  });

  test('cadeia completa: pair → hello → list → fs → add/start → chat', () async {
    final connected = await client.connect('wss://relay.test');
    expect(connected.isSuccess, true);

    final paired = await client.pair(
      PairingCode(
        token: _StubHost.validToken,
        hostEpk: stub.hostEpkB64,
        name: 'Mac do Jacob',
      ),
    );
    expect(paired.isSuccess, true);
    final pairOk = (paired as Success<PairOk, HostError>).value;
    expect(pairOk.sessionName, 'Mac do Jacob');
    expect(pairOk.hostname, 'mac-do-jacob');
    expect(client.hostEpk, stub.hostEpkB64);

    // TODO envelope do control plane vai endereçado a (host, "host") — a
    // conexão ancora EXCLUSIVAMENTE no room host (decisão B).
    for (final frame in stub.outerFrames) {
      expect(frame['peer'], stub.hostEpkB64);
      expect(frame['room'], 'host');
    }

    final hello = await client.helloHost();
    expect(hello.isSuccess, true);
    final helloOk = (hello as Success<HostHelloOk, HostError>).value;
    expect(helloOk.daemon.hostname, 'mac-do-jacob');
    expect(helloOk.daemon.version, '1.4.0');
    expect(helloOk.capabilities, contains('host_pairing'));
    expect(helloOk.capabilities, contains('fs_nav'));

    final list = await client.listWorkspaces();
    final workspaces =
        (list as Success<WorkspaceListOk, HostError>).value.workspaces;
    expect(workspaces, hasLength(2));
    expect(workspaces.first.cwd, '/ws/um');
    expect(workspaces.first.live, true);
    expect(workspaces.last.source, WorkspaceSource.added);

    final fs = await client.fsList('~');
    final listing = (fs as Success<FsListOk, HostError>).value;
    expect(listing.path, '/ws');
    expect(listing.parent, '/');
    expect(listing.entries.first.name, 'um');
    expect(listing.entries.first.kind, FsEntryKind.dir);
    expect(listing.entries.first.isRepo, true);

    final added = await client.addWorkspace('/ws/um');
    expect(added.isSuccess, true);

    final started = await client.startWorkspace('/ws/um');
    final startOk = (started as Success<WorkspaceStartOk, HostError>).value;
    expect(startOk.roomId, 'ws-room-1');
    expect(startOk.cwd, '/ws/um');

    // ── chat via proxy ──
    final messageId = client.sendChat(room: 'ws-room-1', text: 'oi');
    expect(messageId, isNotEmpty);

    // O user_message trafega DENTRO do host_forward, no room host.
    final forward = stub.innerMessages.lastWhere(
      (m) => m['type'] == 'host_forward',
    );
    expect(forward['room'], 'ws-room-1');
    final forwarded = jsonDecode(
      utf8.decode(base64.decode(forward['ct'] as String)),
    ) as Map<String, dynamic>;
    expect(forwarded['type'], 'user_message');
    expect(forwarded['text'], 'oi');
    expect(forwarded['id'], messageId);

    await Future<void>.delayed(Duration.zero);

    // Eco + chunks + done chegam como host_message desembrulhado, arquivado
    // pela room do filho.
    final chatEvents = events.whereType<ChatFrameArrived>().toList();
    expect(chatEvents.map((e) => e.room), everyElement('ws-room-1'));
    final echo = chatEvents
        .map((e) => e.message)
        .whereType<UserMessageEcho>()
        .first;
    expect(echo.id, messageId);
    final chunks = chatEvents
        .map((e) => e.message)
        .whereType<AgentChunk>()
        .toList();
    expect(chunks.map((c) => c.delta).join(), 'olá mundo');
    expect(chunks.every((c) => c.inReplyTo == messageId), true);
    expect(
      chatEvents.map((e) => e.message).whereType<AgentDone>().single.inReplyTo,
      messageId,
    );

    final restart = await client.restartWorkspace('/ws/um');
    expect(restart.isSuccess, true);
  });

  test('pair_error vira HostPairingError tipado', () async {
    await client.connect('wss://relay.test');
    final result = await client.pair(
      PairingCode(
        token: 'token-ruim',
        hostEpk: stub.hostEpkB64,
        name: 'x',
      ),
    );
    expect(result.isFailure, true);
    final error = (result as Failure<PairOk, HostError>).error;
    expect(error, isA<HostPairingError>());
    expect((error as HostPairingError).code, 'unknown');
    // Sem pair_ok, o host não fica conhecido.
    expect(client.hostEpk, isNull);
  });

  test('workspace_state push chega como evento (não é reply)', () async {
    await client.connect('wss://relay.test');
    await client.pair(
      PairingCode(
        token: _StubHost.validToken,
        hostEpk: stub.hostEpkB64,
        name: 'x',
      ),
    );
    stub.pushWorkspaceState(
      cwd: '/ws/um',
      state: 'crashed',
      lastError: 'exit 1',
      restarts: 2,
    );
    await Future<void>.delayed(Duration.zero);
    final push = events.whereType<WorkspaceStateChanged>().single.state;
    expect(push.cwd, '/ws/um');
    expect(push.state, WorkspaceState.crashed);
    expect(push.lastError, 'exit 1');
    expect(push.restarts, 2);
  });

  test('action_error do host vira HostActionRejected com o código do plano 68', () async {
    final failing = _StubHost(
      errorReplies: {
        'fs_list': {'action': 'fs_list', 'error': 'not_found'},
      },
    );
    final failingClient = RelayHostClient(
      _StubSocketFactory(failing),
      _StubSignerFactory(),
      testConfig(),
    );
    addTearDown(failingClient.close);
    await failingClient.connect('wss://relay.test');
    await failingClient.pair(
      PairingCode(
        token: _StubHost.validToken,
        hostEpk: failing.hostEpkB64,
        name: 'x',
      ),
    );
    final result = await failingClient.fsList('/nao-existe');
    expect(result.isFailure, true);
    final error = switch (result) {
      Failure(error: HostActionRejected e) => e,
      _ => throw StateError('expected Failure'),
    };
    expect(error.action, 'fs_list');
    expect(error.code, 'not_found');
  });

  test('request sem resposta vira HostTimeoutError', () async {
    final silent = _StubHost(silentTypes: {'workspace_list'});
    final silentClient = RelayHostClient(
      _StubSocketFactory(silent),
      _StubSignerFactory(),
      testConfig(requestTimeout: const Duration(milliseconds: 50)),
    );
    addTearDown(silentClient.close);
    await silentClient.connect('wss://relay.test');
    await silentClient.pair(
      PairingCode(
        token: _StubHost.validToken,
        hostEpk: silent.hostEpkB64,
        name: 'x',
      ),
    );
    final result = await silentClient.listWorkspaces();
    expect(result.isFailure, true);
    final error = (result as Failure<WorkspaceListOk, HostError>).error;
    expect(error, isA<HostTimeoutError>());
    expect((error as HostTimeoutError).requestType, 'workspace_list');
  });

  test('queda do transporte após o handshake emite HostConnectionLost', () async {
    await client.connect('wss://relay.test');
    await client.pair(
      PairingCode(
        token: _StubHost.validToken,
        hostEpk: stub.hostEpkB64,
        name: 'x',
      ),
    );
    stub._serverSide!.dropConnection();
    await Future<void>.delayed(Duration.zero);
    expect(client.status, HostConnectionStatus.disconnected);
    final lost = events.whereType<HostConnectionLost>().single;
    expect(lost.reason, isA<HostConnectionError>());
  });

  test('relay fecha no auth → handshake falha tipado', () async {
    final failing = _StubHost(closeOnAuth: true);
    final failingClient = RelayHostClient(
      _StubSocketFactory(failing),
      _StubSignerFactory(),
      testConfig(),
    );
    addTearDown(failingClient.close);
    final result = await failingClient.connect('wss://relay.test');
    expect(result.isFailure, true);
    final error = (result as Failure<void, HostError>).error;
    expect(error, isA<HostHandshakeError>());
    expect(failingClient.status, HostConnectionStatus.disconnected);
  });

  test('close() falha request pendente com HostClosedError', () async {
    final slow = _StubHost(delayedTypes: {'workspace_list'});
    final slowClient = RelayHostClient(
      _StubSocketFactory(slow),
      _StubSignerFactory(),
      testConfig(),
    );
    addTearDown(slowClient.close);
    await slowClient.connect('wss://relay.test');
    await slowClient.pair(
      PairingCode(
        token: _StubHost.validToken,
        hostEpk: slow.hostEpkB64,
        name: 'x',
      ),
    );
    final pending = slowClient.listWorkspaces();
    await slowClient.close();
    final result = await pending;
    expect(result.isFailure, true);
    expect(
      (result as Failure<WorkspaceListOk, HostError>).error,
      isA<HostClosedError>(),
    );
  });

  test('frame de controle e envelope malformado são ignorados', () async {
    await client.connect('wss://relay.test');
    stub._serverSide!.deliver('{"type":"presence","x":1}'); // controle
    stub._serverSide!.deliver('{isto não é json');
    await Future<void>.delayed(Duration.zero);
    expect(events, isEmpty);
  });
}
