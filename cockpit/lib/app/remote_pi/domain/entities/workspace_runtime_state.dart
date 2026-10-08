import 'host_protocol.dart';

/// Estado de ciclo de vida de um workspace NA SUPERFÍCIE do cliente. Não é
/// wire: o host só manda o push [WorkspaceStatePush]; esta classe soma o push
/// ao seed do `workspace_list_ok` (`live`) pra UI ter uma resposta única.
///
/// Regra do plano: o host nunca fabrica estado — e o cliente também não.
/// Sem push e sem seed, o estado é `stopped` (nunca `running` adivinhado).
class WorkspaceRuntimeState {
  const WorkspaceRuntimeState({required this.state, this.lastError, this.restarts = 0});

  final WorkspaceState state;

  /// Presente quando `state == crashed`.
  final String? lastError;

  /// Contador de restarts do supervisor (backoff).
  final int restarts;

  bool get isLive =>
      state == WorkspaceState.running || state == WorkspaceState.starting;
}
