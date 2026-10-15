import 'package:cockpit/app/remote_pi/domain/entities/host_protocol.dart' show WorkspaceState;
import 'package:cockpit/app/remote_pi/domain/entities/pairing_code.dart';
import 'package:cockpit/app/remote_pi/domain/errors/host_error.dart';
import 'package:cockpit/i18n/strings.g.dart';
import 'package:flutter/widgets.dart';

/// Traduz um [HostError] pra frase mostrada ao usuário — padrão do repo
/// (`automation_error_message.dart`): a VM devolve o TIPO, a frase nasce aqui,
/// na borda da UI, com `context.t` (reconstrói na troca de idioma).
String hostErrorMessage(BuildContext context, HostError error) {
  final tr = context.t.remotePiHost.error;
  return switch (error) {
    HostConnectionError e => tr.connection(detail: e.detail),
    HostHandshakeError e => tr.handshake(detail: e.detail),
    HostPairingError e => tr.pairing(message: e.message),
    HostPairingCodeError e => pairingCodeProblemMessage(context, e.problem),
    HostTimeoutError e => tr.timeout(request: e.requestType),
    HostActionRejected e => hostActionRejectedMessage(context, e),
    HostProtocolError e => tr.protocol(detail: e.detail),
    HostClosedError _ => tr.closed,
  };
}

/// `action_error`/`workspace_restart_error` — código fechado do host. Código
/// desconhecido (host mais novo que o cliente) cai no genérico com o código
/// cru interpolado, nunca num switch que esquiva.
String hostActionRejectedMessage(BuildContext context, HostActionRejected error) {
  final tr = context.t.remotePiHost.error;
  return switch (error.code) {
    'not_found' => tr.notFound,
    'not_a_directory' => tr.notADirectory,
    'permission_denied' => tr.permissionDenied,
    'spawn_failed' => tr.spawnFailed,
    _ => tr.rejected(code: error.code),
  };
}

/// Problema de parse do código colado.
String pairingCodeProblemMessage(BuildContext context, PairingCodeProblem problem) {
  final tr = context.t.remotePiHost.error;
  return switch (problem) {
    PairingCodeProblem.notAUri => tr.codeNotAUri,
    PairingCodeProblem.wrongScheme => tr.codeWrongScheme,
    PairingCodeProblem.missingField => tr.codeMissingField,
    PairingCodeProblem.badToken => tr.codeBadToken,
    PairingCodeProblem.badEpk => tr.codeBadEpk,
  };
}

/// Rótulo do estado de ciclo de vida (chip da lista de workspaces). Switch
/// EXAUSTIVO sobre o enum de domínio — regra do CLAUDE.md: kind sem tradução
/// é erro de compilação, não string em inglês vazando em produção.
String workspaceStateLabel(BuildContext context, WorkspaceState state) {
  final tr = context.t.remotePiHost.workspaceState;
  return switch (state) {
    WorkspaceState.running => tr.running,
    WorkspaceState.starting => tr.starting,
    WorkspaceState.crashed => tr.crashed,
    WorkspaceState.stopped => tr.stopped,
  };
}
