import 'dart:async';

import 'package:cockpit/app/core/domain/result.dart';

import '../entities/host_protocol.dart';
import '../entities/pairing_code.dart';
import '../errors/host_error.dart';

/// Eventos inbound que NÃO são reply de request: push de ciclo de vida e
/// chat proxeado (`host_message` desembrulhado, arquivado por room).
sealed class HostEvent {
  const HostEvent();
}

/// `workspace_state` — push do supervisor (exit/restart/start/stop).
final class WorkspaceStateChanged extends HostEvent {
  const WorkspaceStateChanged(this.state);

  final WorkspaceStatePush state;
}

/// Mensagem de chat de um workspace (eco `user_message`, `agent_chunk`,
/// `agent_done`), já desembrulhada do `host_message` e arquivada por [room].
final class ChatFrameArrived extends HostEvent {
  const ChatFrameArrived({required this.room, required this.message});

  final String room;
  final ServerMessage message;
}

/// Conexão com o relay caiu depois do handshake.
final class HostConnectionLost extends HostEvent {
  const HostConnectionLost(this.reason);

  final HostError reason;
}

enum HostConnectionStatus { disconnected, connecting, connected }

/// Cliente do protocolo do room `host` (plano 69) — a porta do Cockpit pra
/// uma máquina Remote Pi. Contrato no domínio; impl em `data/`.
///
/// Modelo de conexão (decisão B do spike de multiplex): ancora SÓ no room
/// `host`. `pair`/`hello`/`workspace_*`/`fs_list` são endereçados a
/// (hostEpk, "host"); o chat monta um `user_message` dentro de
/// `host_forward{room, ct}` e recebe `host_message{room, ct}` de volta —
/// arquivado por room em [events]. Pi morto não derruba essa conexão.
abstract interface class HostClient {
  HostConnectionStatus get status;

  /// Pi-key do host após o `pair`. `null` antes.
  String? get hostEpk;

  Stream<HostEvent> get events;

  /// Abre o WS no relay e completa `hello → challenge → auth`.
  Future<Result<void, HostError>> connect(String relayUrl);

  /// `pair_request` no room do host → `pair_ok` | `pair_error`.
  Future<Result<PairOk, HostError>> pair(PairingCode code);

  /// `host_hello` → versão/hostname/capacidades reais.
  Future<Result<HostHelloOk, HostError>> helloHost();

  /// `workspace_list` → daemons ∪ workspaces adicionados.
  Future<Result<WorkspaceListOk, HostError>> listWorkspaces();

  /// `fs_list` — o host resolve e lista.
  Future<Result<FsListOk, HostError>> fsList(String path, {bool showHidden = false});

  /// `workspace_add` — persiste o cwd no catálogo do host.
  Future<Result<ActionOk, HostError>> addWorkspace(String path);

  /// `workspace_start` — spawn/adopt de Pi em cwd arbitrário; devolve a room
  /// do filho (endereço do `host_forward`).
  Future<Result<WorkspaceStartOk, HostError>> startWorkspace(String cwd);

  /// `workspace_restart` — idempotente.
  Future<Result<WorkspaceRestartOk, HostError>> restartWorkspace(String cwd);

  /// Chat via proxy: manda `user_message` dentro de `host_forward{room}` no
  /// room host. Fire-and-forget — devolve o id da mensagem interna, que o
  /// eco e o stream referenciam. Lança [StateError] se não estiver conectado
  /// e pareado (a VM guarda isso antes de chamar).
  String sendChat({required String room, required String text});

  Future<void> close();
}
