import 'dart:async';

import 'package:cockpit/app/core/domain/result.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/host_client.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/host_client_factory.dart';
import 'package:cockpit/app/remote_pi/domain/entities/host_protocol.dart';
import 'package:cockpit/app/remote_pi/domain/entities/pairing_code.dart';
import 'package:cockpit/app/remote_pi/domain/entities/workspace_runtime_state.dart';
import 'package:cockpit/app/remote_pi/domain/errors/host_error.dart';
import 'package:flutter/foundation.dart';

/// Uma bolha do chat de um workspace. O eco `user_message` confirma a bolha
/// do próprio cliente; `agent_chunk` anexa delta na bolha de streaming
/// (`streaming: true`) até o `agent_done`.
class ChatEntry {
  ChatEntry({
    required this.id,
    required this.text,
    required this.fromUser,
    this.streaming = false,
  });

  final String id;
  String text;
  final bool fromUser;
  bool streaming;
}

/// VM page-scoped da superfície Remote Pi (plano 69 W3): parear por colagem,
/// listar workspaces, navegar o fs do host, iniciar Pi em cwd arbitrário,
/// ver ciclo de vida (push) e restart por 1 toque, e conversar via proxy
/// `host_forward`/`host_message` no room `host`.
///
/// Erros são tipados ([HostError]) — a UI traduz. Nenhuma frase aqui.
class RemotePiHostViewModel extends ChangeNotifier {
  RemotePiHostViewModel(this._clientFactory);

  final HostClientFactory _clientFactory;

  HostClient? _client;
  StreamSubscription<HostEvent>? _eventsSub;

  HostConnectionStatus _status = HostConnectionStatus.disconnected;
  HostError? _error;
  HostHelloOk? _hello;
  bool _busy = false;

  final List<WorkspaceInfo> _workspaces = [];
  final Map<String, WorkspaceRuntimeState> _runtime = {};
  WorkspaceInfo? _selected;

  FsListOk? _fsListing;
  bool _fsLoading = false;
  HostError? _fsError;

  final Map<String, List<ChatEntry>> _chat = {};

  // ── estado exposto ─────────────────────────────────────────────────────────

  HostConnectionStatus get status => _status;

  bool get busy => _busy;

  HostError? get error => _error;

  /// `host_hello_ok` — versão/hostname/plataforma reais do daemon.
  HostHelloOk? get hello => _hello;

  List<WorkspaceInfo> get workspaces => List.unmodifiable(_workspaces);

  WorkspaceInfo? get selectedWorkspace => _selected;

  FsListOk? get fsListing => _fsListing;

  bool get fsLoading => _fsLoading;

  HostError? get fsError => _fsError;

  bool get connected => _status == HostConnectionStatus.connected;

  /// Estado de ciclo de vida de um workspace. Sem push nem seed → `stopped`
  /// (nunca inventa `running`).
  WorkspaceRuntimeState runtimeStateOf(WorkspaceInfo workspace) =>
      _runtime[workspace.cwd] ??
      WorkspaceRuntimeState(
        state: workspace.live ? WorkspaceState.running : WorkspaceState.stopped,
      );

  List<ChatEntry> chatFor(WorkspaceInfo workspace) =>
      List.unmodifiable(_chat[workspace.roomId] ?? const []);

  void clearError() {
    if (_error == null && _fsError == null) return;
    _error = null;
    _fsError = null;
    notifyListeners();
  }

  // ── ações ──────────────────────────────────────────────────────────────────

  /// Fluxo completo de pareamento: parseia o código colado, conecta no relay
  /// (o código manda no relay quando trouxer `r`), pareia, dá `host_hello` e
  /// já carrega a lista de workspaces.
  Future<void> connectWithCode({
    required String relayUrl,
    required String code,
  }) async {
    if (_busy) return;
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      final PairingCode parsed;
      try {
        parsed = parsePairingCode(code);
      } on PairingCodeError catch (e) {
        _error = HostPairingCodeError(e.problem);
        return;
      }

      await _disposeClient();
      final client = _clientFactory.create();
      _client = client;
      _eventsSub = client.events.listen(_onEvent);

      final connected = await client.connect(parsed.relayUrl ?? relayUrl);
      if (connected case Failure(:final error)) {
        _error = error;
        await _disposeClient();
        return;
      }
      _status = client.status;

      final paired = await client.pair(parsed);
      if (paired case Failure(:final error)) {
        _error = error;
        await _disposeClient();
        return;
      }

      // host_hello → host_hello_ok faz parte do aceite do connect. Falha do
      // hello não derruba a sessão pareada: surfaceia e segue (a lista de
      // workspaces é mais importante que os metadados do daemon).
      final hello = await client.helloHost();
      switch (hello) {
        case Success(:final value):
          _hello = value;
        case Failure(:final error):
          _hello = null;
          _error = error;
      }

      await _loadWorkspaces();
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> refreshWorkspaces() async {
    if (_busy) return;
    _busy = true;
    notifyListeners();
    try {
      await _loadWorkspaces();
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Navega o filesystem do HOST — o cliente nunca toca um path local.
  Future<void> browseFs(String path) async {
    final client = _client;
    if (client == null || _fsLoading) return;
    _fsLoading = true;
    _fsError = null;
    notifyListeners();
    final result = await client.fsList(path);
    switch (result) {
      case Success(:final value):
        _fsListing = value;
      case Failure(:final error):
        _fsListing = null;
        _fsError = error;
    }
    _fsLoading = false;
    notifyListeners();
  }

  /// `workspace_add` + `workspace_start` num cwd arbitrário (plano 68/69).
  Future<void> addAndStartWorkspace(String path) async {
    final client = _client;
    if (client == null || _busy) return;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final added = await client.addWorkspace(path);
      if (added case Failure(:final error)) {
        _error = error;
        return;
      }
      final started = await client.startWorkspace(path);
      switch (started) {
        case Success(:final value):
          _runtime[value.cwd] = const WorkspaceRuntimeState(
            state: WorkspaceState.starting,
          );
          await _loadWorkspaces();
          final started_ = _workspaces.where((w) => w.cwd == value.cwd);
          _selected = started_.isNotEmpty ? started_.first : _selected;
        case Failure(:final error):
          _error = error;
      }
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Restart por 1 toque — idempotente no host (running → ok sem respawn).
  Future<void> restartWorkspace(String cwd) async {
    final client = _client;
    if (client == null || _busy) return;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final result = await client.restartWorkspace(cwd);
      switch (result) {
        case Success():
          // O push `workspace_state` do supervisor confirma running/crashed;
          // `starting` é o estado honesto de "restart pedido".
          _runtime[cwd] = const WorkspaceRuntimeState(
            state: WorkspaceState.starting,
          );
        case Failure(:final error):
          _error = error;
      }
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  void selectWorkspace(WorkspaceInfo workspace) {
    if (_selected?.cwd == workspace.cwd) return;
    _selected = workspace;
    notifyListeners();
  }

  /// Chat via proxy: o `user_message` viaja dentro do `host_forward` no room
  /// host; o eco e o stream voltam como `host_message` arquivado por room.
  void sendChat(String text) {
    final client = _client;
    final selected = _selected;
    final trimmed = text.trim();
    if (client == null || selected == null || trimmed.isEmpty) return;
    final id = client.sendChat(room: selected.roomId, text: trimmed);
    _chat
        .putIfAbsent(selected.roomId, () => [])
        .add(ChatEntry(id: id, text: trimmed, fromUser: true));
    notifyListeners();
  }

  Future<void> disconnect() async {
    await _disposeClient();
    _hello = null;
    _workspaces.clear();
    _runtime.clear();
    _chat.clear();
    _fsListing = null;
    _fsError = null;
    _selected = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _eventsSub?.cancel();
    final client = _client;
    _client = null;
    if (client != null) unawaited(client.close());
    super.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  Future<void> _loadWorkspaces() async {
    final client = _client;
    if (client == null) return;
    final result = await client.listWorkspaces();
    switch (result) {
      case Success(:final value):
        _workspaces
          ..clear()
          ..addAll(value.workspaces);
        // Semeia o runtime a partir do `live` do próprio host (não fabrica —
        // é a resposta dele); pushes de `workspace_state` refinam depois.
        for (final workspace in _workspaces) {
          _runtime[workspace.cwd] ??= WorkspaceRuntimeState(
            state: workspace.live
                ? WorkspaceState.running
                : WorkspaceState.stopped,
          );
        }
        _selected ??= _workspaces.isNotEmpty ? _workspaces.first : null;
      case Failure(:final error):
        _error = error;
    }
  }

  void _onEvent(HostEvent event) {
    switch (event) {
      case WorkspaceStateChanged(:final state):
        _runtime[state.cwd] = WorkspaceRuntimeState(
          state: state.state,
          lastError: state.lastError,
          restarts: state.restarts,
        );
        notifyListeners();
      case ChatFrameArrived(:final room, :final message):
        _applyChatFrame(room, message);
        notifyListeners();
      case HostConnectionLost(:final reason):
        _status = HostConnectionStatus.disconnected;
        _error = reason;
        notifyListeners();
    }
  }

  void _applyChatFrame(String room, ServerMessage message) {
    final entries = _chat.putIfAbsent(room, () => []);
    switch (message) {
      case UserMessageEcho echo:
        // Eco do filho (broadcast a todos os owners). A bolha otimista já
        // pode existir (foi este cliente que enviou) — não duplica.
        final exists = entries.any((e) => e.id == echo.id);
        if (!exists) {
          entries.add(
            ChatEntry(id: echo.id, text: echo.text, fromUser: true),
          );
        }
      case AgentChunk chunk:
        ChatEntry? target;
        for (final entry in entries) {
          if (entry.id == chunk.inReplyTo && !entry.fromUser) {
            target = entry;
            break;
          }
        }
        if (target == null) {
          target = ChatEntry(
            id: chunk.inReplyTo,
            text: '',
            fromUser: false,
            streaming: true,
          );
          entries.add(target);
        }
        target.text += chunk.delta;
      case AgentDone done:
        for (final entry in entries) {
          if (entry.id == done.inReplyTo && !entry.fromUser) {
            entry.streaming = false;
          }
        }
      default:
        break; // outros frames do filho não são chat
    }
  }

  Future<void> _disposeClient() async {
    final subscription = _eventsSub;
    _eventsSub = null;
    await subscription?.cancel();
    final client = _client;
    _client = null;
    _status = HostConnectionStatus.disconnected;
    await client?.close();
  }
}
