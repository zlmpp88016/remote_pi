import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:cockpit/app/core/domain/result.dart';

import '../domain/contracts/ed25519_signer.dart';
import '../domain/contracts/host_client.dart';
import '../domain/entities/host_protocol.dart';
import '../domain/entities/pairing_code.dart';
import '../domain/errors/host_error.dart';
import '../domain/value_objects/host_client_config.dart';
import 'host_socket.dart';

/// Cliente do protocolo do room `host` (plano 69 W3).
///
/// Espelha a semântica do cliente web de referência
/// (`site/src/lib/remote-pi/client.ts`, validado contra o relay real):
///
///   connect   WS no relay + `hello → challenge → auth` (Ed25519 efêmera)
///   pair      `pair_request` no room host            → pair_ok | pair_error
///   hello     `host_hello`                           → host_hello_ok
///   browse    `fs_list` (host resolve todo path)     → fs_list_ok | action_error
///   list      `workspace_list`                       → workspace_list_ok
///   start     `workspace_add` + `workspace_start`    → action_ok + start_ok
///   restart   `workspace_restart` (idempotente)      → restart_ok | restart_error
///   chat      `user_message` dentro de `host_forward` no room host;
///             respostas voltam como `host_message{room, ct}` e são
///             desembrulhadas + arquivadas por room em [events].
///
/// Conexão ancorada EXCLUSIVAMENTE no room `host` (decisão B do spike de
/// multiplex): uma conexão não sustenta room host + rooms de workspace — o
/// demux descarta envelope de room não-ativa, por isso o chat proxeia.
class RelayHostClient implements HostClient {
  RelayHostClient(this._socketFactory, this._signerFactory, this._config);

  final HostSocketFactory _socketFactory;
  final Ed25519SignerFactory _signerFactory;
  final HostClientConfig _config;

  HostSocket? _socket;
  StreamSubscription<dynamic>? _subscription;
  String? _hostEpk;

  final _pending = <String, _PendingRequest>{};
  final _events = StreamController<HostEvent>.broadcast();

  /// Ativo só durante o handshake; completa com `null` no sucesso e com o
  /// erro quando o socket fecha/erra no meio da negociação.
  Completer<HostError?>? _handshake;
  Completer<String>? _challenge;

  bool _handshakeDone = false;
  bool _closed = false;
  HostConnectionStatus _status = HostConnectionStatus.disconnected;

  @override
  HostConnectionStatus get status => _status;

  @override
  String? get hostEpk => _hostEpk;

  @override
  Stream<HostEvent> get events => _events.stream;

  // ── conexão ───────────────────────────────────────────────────────────────

  @override
  Future<Result<void, HostError>> connect(String relayUrl) async {
    if (_closed) return const Failure(HostClosedError());
    if (_status != HostConnectionStatus.disconnected) {
      return const Failure(HostProtocolError('client já conectado'));
    }

    final Uri uri;
    try {
      uri = _normalizeRelayUrl(relayUrl);
    } on FormatException catch (e) {
      return Failure(HostConnectionError('relay inválido: ${e.message}'));
    }

    final Ed25519Signer signer;
    try {
      signer = await _signerFactory.create();
    } catch (error) {
      return Failure(HostConnectionError('falha ao gerar App-key: $error'));
    }

    final HostSocket socket;
    try {
      socket = await _socketFactory.connect(uri, protocols: [_config.subprotocol]);
    } catch (error) {
      return Failure(HostConnectionError('falha ao conectar no relay: $error'));
    }
    _socket = socket;
    _status = HostConnectionStatus.connecting;

    _subscription = socket.stream.listen(
      _onFrame,
      onError: _onSocketError,
      onDone: _onSocketDone,
      cancelOnError: false,
    );

    _handshake = Completer<HostError?>();
    _challenge = Completer<String>();

    // 1. hello — o cliente já anuncia o room `host` no primeiro frame.
    _sendRaw(
      jsonEncode(Hello(id: _newId(), pubkey: signer.publicKeyBase64).toJson()),
    );

    try {
      // 2. challenge — corrida entre o nonce, o fechamento do socket e o
      // timeout (o relay fecha na hora se algo dá ruim e não diz nada).
      final nonceB64 = await Future.any([
        _challenge!.future,
        _handshake!.future.then((err) {
          if (err != null) throw _HandshakeAborted(err);
          return Completer<String>().future;
        }),
      ]).timeout(
        _config.handshakeTimeout,
        onTimeout: () => throw const _HandshakeAborted(
          HostHandshakeError('timeout: relay não enviou challenge'),
        ),
      );

      // 3. auth — assinatura Ed25519 sobre os bytes crus do nonce.
      final nonce = _base64DecodeLenient(nonceB64);
      final signature = await signer.sign(nonce);
      _sendRaw(jsonEncode(Auth(base64.encode(signature)).toJson()));

      // Cortesia: o relay rejeita fechando imediato; sucesso é silêncio.
      final graceError = await Future.any<HostError?>([
        Future<void>.delayed(_config.authGrace).then((_) => null),
        _handshake!.future,
      ]);
      if (graceError != null) throw _HandshakeAborted(graceError);

      _handshakeDone = true;
      _status = HostConnectionStatus.connected;
      _handshake = null;
      _challenge = null;
      return const Success(null);
    } on _HandshakeAborted catch (aborted) {
      await _teardownHandshake();
      return Failure(aborted.error);
    } on TimeoutException catch (e) {
      await _teardownHandshake();
      return Failure(HostHandshakeError('timeout no handshake: ${e.message}'));
    } catch (error) {
      await _teardownHandshake();
      return Failure(HostHandshakeError('handshake falhou: $error'));
    }
  }

  @override
  Future<Result<PairOk, HostError>> pair(PairingCode code) async {
    final result = await _request<PairOk>(
      inner: PairRequest(
        id: _newId(),
        token: code.token,
        deviceName: _config.deviceName,
      ),
      peer: code.hostEpk,
      room: code.roomId,
      parse: (msg) => switch (msg) {
        PairOk ok => Success(ok),
        PairError err => Failure(
          HostPairingError(code: err.code, message: err.message),
        ),
        _ => Failure(
          HostProtocolError('resposta inesperada ao pair_request: ${msg.type}'),
        ),
      },
    );
    // O host só fica conhecido depois do pair_ok — um pair_error não pode
    // deixar endereço pendurado pra hello/requests seguintes.
    _hostEpk = result.isSuccess ? code.hostEpk : null;
    return result;
  }

  @override
  Future<Result<HostHelloOk, HostError>> helloHost() =>
      _requestToHost(
        inner: HostHello(_newId()),
        parse: (msg) => switch (msg) {
          HostHelloOk ok => Success(ok),
          _ => Failure(
            HostProtocolError('resposta inesperada ao host_hello: ${msg.type}'),
          ),
        },
      );

  @override
  Future<Result<WorkspaceListOk, HostError>> listWorkspaces() =>
      _requestToHost(
        inner: WorkspaceList(_newId()),
        parse: (msg) => switch (msg) {
          WorkspaceListOk ok => Success(ok),
          _ => Failure(
            HostProtocolError('resposta inesperada ao workspace_list: ${msg.type}'),
          ),
        },
      );

  @override
  Future<Result<FsListOk, HostError>> fsList(
    String path, {
    bool showHidden = false,
  }) => _requestToHost(
    inner: FsList(id: _newId(), path: path, showHidden: showHidden),
    parse: (msg) => switch (msg) {
      FsListOk ok => Success(ok),
      ActionError err => Failure(
        HostActionRejected(action: err.action, code: err.error),
      ),
      _ => Failure(
        HostProtocolError('resposta inesperada ao fs_list: ${msg.type}'),
      ),
    },
  );

  @override
  Future<Result<ActionOk, HostError>> addWorkspace(String path) =>
      _requestToHost(
        inner: WorkspaceAdd(id: _newId(), path: path),
        parse: (msg) => switch (msg) {
          ActionOk ok => Success(ok),
          ActionError err => Failure(
            HostActionRejected(action: err.action, code: err.error),
          ),
          _ => Failure(
            HostProtocolError('resposta inesperada ao workspace_add: ${msg.type}'),
          ),
        },
      );

  @override
  Future<Result<WorkspaceStartOk, HostError>> startWorkspace(String cwd) =>
      _requestToHost(
        inner: WorkspaceStart(id: _newId(), cwd: cwd),
        parse: (msg) => switch (msg) {
          WorkspaceStartOk ok => Success(ok),
          ActionError err => Failure(
            HostActionRejected(action: err.action, code: err.error),
          ),
          _ => Failure(
            HostProtocolError('resposta inesperada ao workspace_start: ${msg.type}'),
          ),
        },
      );

  @override
  Future<Result<WorkspaceRestartOk, HostError>> restartWorkspace(String cwd) =>
      _requestToHost(
        inner: WorkspaceRestart(id: _newId(), cwd: cwd),
        parse: (msg) => switch (msg) {
          WorkspaceRestartOk ok => Success(ok),
          WorkspaceRestartError err => Failure(
            HostActionRejected(action: 'workspace_restart', code: err.code),
          ),
          ActionError err => Failure(
            HostActionRejected(action: err.action, code: err.error),
          ),
          _ => Failure(
            HostProtocolError('resposta inesperada ao workspace_restart: ${msg.type}'),
          ),
        },
      );

  @override
  String sendChat({required String room, required String text}) {
    if (_closed || !_handshakeDone || _socket == null) {
      throw StateError('client não conectado — chame connect() antes');
    }
    final hostEpk = _hostEpk;
    if (hostEpk == null) {
      throw StateError('host desconhecido — chame pair() antes');
    }
    // Proxy (decisão B): o user_message viaja DENTRO do host_forward,
    // endereçado à room do filho, mas trafega no room host.
    final innerId = _newId();
    final forward = HostForward(
      id: _newId(),
      room: room,
      ct: encodeCt(UserMessageText(id: innerId, text: text).toJson()),
    );
    _sendOuter(hostEpk, kHostRoomId, forward);
    return innerId;
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _handshakeDone = false;
    _status = HostConnectionStatus.disconnected;
    for (final pending in _pending.values) {
      pending.timer.cancel();
      pending.fail(const HostClosedError());
    }
    _pending.clear();
    _challenge = null;
    _handshake = null;
    await _subscription?.cancel();
    _subscription = null;
    await _socket?.close();
    _socket = null;
    await _events.close();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /// Request endereçada a (hostEpk, room `host`) — todo o control plane.
  Future<Result<T, HostError>> _requestToHost<T>({
    required ClientMessage inner,
    required Result<T, HostError> Function(ServerMessage msg) parse,
  }) {
    final hostEpk = _hostEpk;
    if (hostEpk == null) {
      return Future.value(
        const Failure(HostProtocolError('host desconhecido — chame pair() antes')),
      );
    }
    return _request(inner: inner, peer: hostEpk, room: kHostRoomId, parse: parse);
  }

  Future<Result<T, HostError>> _request<T>({
    required ClientMessage inner,
    required String peer,
    required String room,
    required Result<T, HostError> Function(ServerMessage msg) parse,
  }) {
    if (_closed) return Future.value(const Failure(HostClosedError()));
    if (!_handshakeDone || _socket == null) {
      return Future.value(
        const Failure(HostConnectionError('client não conectado — chame connect() antes')),
      );
    }
    final completer = Completer<Result<T, HostError>>();
    final timer = Timer(_config.requestTimeout, () {
      _pending.remove(inner.id);
      if (!completer.isCompleted) {
        completer.complete(Failure(HostTimeoutError(inner.type)));
      }
    });
    _pending[inner.id] = _PendingRequest(
      timer,
      (message) {
        if (!completer.isCompleted) completer.complete(parse(message));
      },
      (error) {
        if (!completer.isCompleted) completer.complete(Failure(error));
      },
    );
    try {
      _sendOuter(peer, room, inner);
    } on StateError catch (error) {
      timer.cancel();
      _pending.remove(inner.id);
      return Future.value(Failure(HostConnectionError(error.message)));
    }
    return completer.future;
  }

  void _sendRaw(String text) {
    final socket = _socket;
    if (socket == null) throw StateError('socket fechado durante o handshake');
    socket.send(text);
  }

  void _sendOuter(String peer, String room, ClientMessage inner) {
    final socket = _socket;
    if (socket == null || !_handshakeDone) {
      throw StateError('client não conectado — chame connect() antes');
    }
    socket.send(encodeOuter(peer, room, inner));
  }

  void _onFrame(dynamic raw) {
    final text = raw is String ? raw : raw.toString();

    // Fase de handshake: só o challenge interessa.
    final challenge = _challenge;
    if (challenge != null && !challenge.isCompleted) {
      final Object? json;
      try {
        json = jsonDecode(text);
      } on FormatException {
        return;
      }
      if (json is Map && json['type'] == 'challenge' && json['nonce'] is String) {
        challenge.complete(json['nonce'] as String);
      }
      return;
    }

    final decoded = decodeOuter(text);
    if (decoded == null) return; // frame de controle do relay / lixo
    final message = decoded.inner;
    if (message == null) return;

    // Proxy inbound (decisão B): tráfego de workspace chega embrulhado em
    // host_message{room, ct}. Desembrulha e arquiva pelo room do filho.
    if (message is HostMessage) {
      final inner = decodeCt(message.ct);
      if (inner == null) return; // payload malformado — não é nosso
      _dispatch(inner, message.room);
      return;
    }
    _dispatch(message, decoded.fromRoom);
  }

  /// Arquiva um frame inbound: reply de request pendente (por `in_reply_to`)
  /// settle a promise; o resto vira evento (push de estado / chat).
  void _dispatch(ServerMessage message, String room) {
    final id = message.inReplyTo;
    if (id != null && id.isNotEmpty && _pending.containsKey(id)) {
      final pending = _pending.remove(id)!;
      pending.timer.cancel();
      pending.settle(message);
      return;
    }
    switch (message) {
      case WorkspaceStatePush state:
        if (!_events.isClosed) _events.add(WorkspaceStateChanged(state));
      case UserMessageEcho _:
      case AgentChunk _:
      case AgentDone _:
        if (!_events.isClosed) {
          _events.add(ChatFrameArrived(room: room, message: message));
        }
      default:
        break; // broadcast de ruído de outro dono — ignorar
    }
  }

  void _onSocketError(Object error, StackTrace _) {
    final handshake = _handshake;
    if (handshake != null && !handshake.isCompleted) {
      // Falha de transporte DURANTE o handshake = handshake falhou (o
      // "não consegui conectar" já é coberto pelo socket factory).
      handshake.complete(HostHandshakeError('erro no socket: $error'));
      return;
    }
    _handleTransportLost(HostConnectionError('erro no socket: $error'));
  }

  void _onSocketDone() {
    final handshake = _handshake;
    if (handshake != null && !handshake.isCompleted) {
      handshake.complete(
        const HostHandshakeError('conexão fechada durante o handshake'),
      );
      return;
    }
    _handleTransportLost(
      const HostConnectionError('conexão com o relay caiu'),
    );
  }

  /// Queda de transporte DEPOIS do handshake: falha todo request pendente e
  /// avisa a VM. A conexão da máquina (room host) é o dono da presença —
  /// quando ela cai, o cliente precisa de reconnect (novo client).
  void _handleTransportLost(HostError reason) {
    _handshakeDone = false;
    _status = HostConnectionStatus.disconnected;
    for (final pending in _pending.values) {
      pending.timer.cancel();
      pending.fail(reason);
    }
    _pending.clear();
    if (!_events.isClosed) _events.add(HostConnectionLost(reason));
  }

  Future<void> _teardownHandshake() async {
    _handshake = null;
    _challenge = null;
    _handshakeDone = false;
    _status = HostConnectionStatus.disconnected;
    await _subscription?.cancel();
    _subscription = null;
    await _socket?.close();
    _socket = null;
  }

  /// Aceita http(s) na forma usuário e sempre fala ws(s) no fio.
  static Uri _normalizeRelayUrl(String relayUrl) {
    var value = relayUrl.trim();
    if (value.isEmpty) {
      throw const FormatException('endereço do relay vazio');
    }
    if (value.startsWith('http://')) {
      value = 'ws://${value.substring(7)}';
    } else if (value.startsWith('https://')) {
      value = 'wss://${value.substring(8)}';
    } else if (!value.startsWith('ws://') && !value.startsWith('wss://')) {
      value = 'wss://$value';
    }
    return Uri.parse(value);
  }
}

/// Exceção interna do handshake — carrega o [HostError] tipado pra superfície.
class _HandshakeAborted implements Exception {
  const _HandshakeAborted(this.error);

  final HostError error;
}

class _PendingRequest {
  _PendingRequest(this.timer, this.settle, this.fail);

  final Timer timer;

  /// Reply chegou — completa com o parse tipado.
  final void Function(ServerMessage msg) settle;

  /// Request morreu (close/transporte) — completa com a falha.
  final void Function(HostError error) fail;
}

var _idCounter = 0;

/// Id de request — uuid quando disponível, contador+timestamp como fallback.
String _newId() {
  final c = _idCounter = (_idCounter + 1) % 0xffffff;
  final ts = DateTime.now().microsecondsSinceEpoch.toRadixString(16);
  return 'ck-$ts-$c';
}

/// Decode base64 tolerante (o nonce do relay é padrão com padding).
Uint8List _base64DecodeLenient(String value) => base64.decode(value);
