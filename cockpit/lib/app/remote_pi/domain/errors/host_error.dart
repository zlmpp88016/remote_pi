/// Erros do cliente do room `host` — união selada e tipada. `data/` e
/// ViewModels **não produzem frase** (regra do CLAUDE.md): devolvem o tipo com
/// os dados variáveis e a UI monta o texto traduzido.
library;

import '../entities/pairing_code.dart';

sealed class HostError implements Exception {
  const HostError();
}

/// Falha ao abrir/ manter o WebSocket com o relay.
final class HostConnectionError extends HostError {
  const HostConnectionError(this.detail);

  /// Texto cru da falha (exceção do socket) — interpolado na UI.
  final String detail;
}

/// Handshake `hello → challenge → auth` não completou (timeout, fechamento
/// antes do challenge, relay rejeitou a assinatura).
final class HostHandshakeError extends HostError {
  const HostHandshakeError(this.detail);

  final String detail;
}

/// `pair_error` do host — token inválido, expirado ou rotacionado.
final class HostPairingError extends HostError {
  const HostPairingError({required this.code, required this.message});

  final String code;
  final String message;
}

/// Código de pareamento colado não parseia (validação local, antes da rede).
final class HostPairingCodeError extends HostError {
  const HostPairingCodeError(this.problem);

  final PairingCodeProblem problem;
}

/// Request sem resposta dentro do timeout.
final class HostTimeoutError extends HostError {
  const HostTimeoutError(this.requestType);

  final String requestType;
}

/// `action_error` / `workspace_restart_error` — código fechado do host
/// (`not_found`, `not_a_directory`, `permission_denied`, `spawn_failed`, …).
final class HostActionRejected extends HostError {
  const HostActionRejected({required this.action, required this.code});

  final String action;
  final String code;
}

/// Payload inesperado para uma request conhecida (host novo/desatualizado).
final class HostProtocolError extends HostError {
  const HostProtocolError(this.detail);

  final String detail;
}

/// Client fechado (`close()` já chamado) — precisa de uma instância nova.
final class HostClosedError extends HostError {
  const HostClosedError();
}
