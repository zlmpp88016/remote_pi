/// Código de pareamento colado — `remotepi://pair?t=…&epk=…&n=…[&rm=…][&r=…]`.
///
/// Payload **congelado** (PROTOCOL.md "Pareamento", planos 68/69): o cliente
/// parseia, nunca reescreve. O que o plano 69 mudou foi só o emitente — o
/// daemon residente (`remote-pi pair`, com zero Pi rodando) emite o mesmo
/// formato que o Pi interativo sempre emitiu.
library;

import 'dart:convert';

/// Room canônico do host (plano 67/69). É a ÚNICA room em que este cliente
/// ancora (decisão B do spike de multiplex, plano 69 W2): uma conexão não
/// sustenta room `host` + rooms de workspace — o demux descarta envelope de
/// room não-ativa. O chat proxeia via `host_forward`/`host_message`.
const String kHostRoomId = 'host';

/// Código já parseado e validado.
class PairingCode {
  const PairingCode({
    required this.token,
    required this.hostEpk,
    required this.name,
    this.roomId = kHostRoomId,
    this.relayUrl,
  });

  /// Token de uso único (16 bytes, base64url). Persistente por padrão quando
  /// emitido pelo daemon (inválida só com `--rotate`); efêmero de 60s com
  /// `--ephemeral`.
  final String token;

  /// Pi-key do host normalizada pra base64 padrão COM padding — formato do
  /// registro do relay (o `epk` da URI vem em base64url).
  final String hostEpk;

  /// Nome da sessão/máquina (`n`) — preview.
  final String name;

  /// Room do pareamento (`rm`, default `host`).
  final String roomId;

  /// Relay em que o host está de fato conectado (`r`, opcional). Quando
  /// presente, MANDA no relay digitado: o código é a fonte da verdade.
  final String? relayUrl;
}

/// Problema de parse — tipado pra a UI traduzir (domínio não produz frase).
enum PairingCodeProblem {
  /// Não é uma URI.
  notAUri,

  /// URI válida, mas não `remotepi://pair`.
  wrongScheme,

  /// Faltam `t`/`epk`/`n`.
  missingField,

  /// `t` não decodifica pra 16 bytes.
  badToken,

  /// `epk` não decodifica pra 32 bytes.
  badEpk,
}

class PairingCodeError implements Exception {
  const PairingCodeError(this.problem);

  final PairingCodeProblem problem;

  @override
  String toString() => 'PairingCodeError($problem)';
}

/// Parseia o código colado. Espelha `app/lib/pairing/pair_payload.dart` e
/// `site/src/lib/remote-pi/protocol.ts` — mesmo contrato, três clientes.
PairingCode parsePairingCode(String raw) {
  final Uri uri;
  try {
    uri = Uri.parse(raw.trim());
  } on FormatException {
    throw const PairingCodeError(PairingCodeProblem.notAUri);
  }
  if (uri.scheme != 'remotepi' || uri.host != 'pair') {
    throw const PairingCodeError(PairingCodeProblem.wrongScheme);
  }
  final token = uri.queryParameters['t'];
  final epk = uri.queryParameters['epk'];
  final name = uri.queryParameters['n'];
  if (token == null || token.isEmpty || epk == null || epk.isEmpty || name == null || name.isEmpty) {
    throw const PairingCodeError(PairingCodeProblem.missingField);
  }
  final epkBytes = _base64UrlDecode(epk);
  if (epkBytes.length != 32) {
    throw const PairingCodeError(PairingCodeProblem.badEpk);
  }
  final tokenBytes = _base64UrlDecode(token);
  if (tokenBytes.length != 16) {
    throw const PairingCodeError(PairingCodeProblem.badToken);
  }
  final rm = uri.queryParameters['rm'];
  final r = uri.queryParameters['r'];
  return PairingCode(
    token: token,
    // Normaliza pra base64 padrão: o relay registra o peer pelo `hello` em
    // base64 padrão, e o envelope endereça o host por essa mesma string.
    hostEpk: base64.encode(epkBytes),
    name: name,
    roomId: (rm != null && rm.isNotEmpty) ? rm : kHostRoomId,
    relayUrl: (r != null && r.isNotEmpty) ? r : null,
  );
}

/// Decode base64url tolerante: aceita unpadded e até alfabeto padrão (o
/// `epk`/`t` da URI são base64url por contrato, mas o app já é leniente).
List<int> _base64UrlDecode(String value) {
  final normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  final padded = normalized.padRight((normalized.length + 3) ~/ 4 * 4, '=');
  return base64.decode(padded);
}
