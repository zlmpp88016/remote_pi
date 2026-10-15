import 'dart:convert';

import 'package:cockpit/app/remote_pi/domain/entities/pairing_code.dart';
import 'package:flutter_test/flutter_test.dart';

/// Parse do código colado — payload congelado (PROTOCOL.md "Pareamento").
/// Espelha os testes do app (`pair_payload_test.dart`) e do site
/// (`verify-web-client.mjs`): mesmo contrato, três clientes.
void main() {
  // epk = 32 bytes, token = 16 bytes (randomBytes(16) no daemon e no Pi).
  final epkB64Url = base64Url.encode(List.filled(32, 0xAB));
  final tokenB64Url = base64Url.encode(List.filled(16, 0x7C));

  PairingCode buildUri({
    String token = '',
    String epk = '',
    String name = 'Mac do Jacob',
    String? rm,
    String? r,
  }) {
    final params = <String, String>{
      't': token.isEmpty ? tokenB64Url : token,
      'epk': epk.isEmpty ? epkB64Url : epk,
      'n': name,
      'rm': ?rm,
      'r': ?r,
    };
    final query = params.entries.map((e) => '${e.key}=${e.value}').join('&');
    return parsePairingCode('remotepi://pair?$query');
  }

  test('happy path: token/epk/n e default do room host', () {
    final code = buildUri();
    expect(code.token, tokenB64Url);
    expect(code.name, 'Mac do Jacob');
    expect(code.roomId, 'host');
    expect(code.relayUrl, isNull);
    // epk normalizado pra base64 padrão COM padding (formato do relay).
    expect(code.hostEpk, base64.encode(List.filled(32, 0xAB)));
  });

  test('rm e r opcionais são lidos', () {
    final code = buildUri(rm: 'host', r: 'wss://relay.example');
    expect(code.roomId, 'host');
    expect(code.relayUrl, 'wss://relay.example');
  });

  test('rm vazio cai no default host', () {
    final code = buildUri(rm: '');
    expect(code.roomId, kHostRoomId);
  });

  test('aceita espaços em volta (colagem do terminal)', () {
    final code = parsePairingCode(
      '\n  remotepi://pair?t=$tokenB64Url&epk=$epkB64Url&n=x  \n',
    );
    expect(code.name, 'x');
  });

  test('epk com padding padrão também parseia (cliente leniente)', () {
    final padded = base64.encode(List.filled(32, 0xAB)); // + padding
    final code = buildUri(epk: padded.replaceAll('+', '-').replaceAll('/', '_'));
    expect(code.hostEpk, padded);
  });

  group('erros tipados', () {
    test('não é URI', () {
      expect(
        () => parsePairingCode('::'),
        throwsA(
          isA<PairingCodeError>().having(
            (e) => e.problem,
            'problem',
            PairingCodeProblem.notAUri,
          ),
        ),
      );
    });

    test('esquema errado', () {
      expect(
        () => parsePairingCode('https://pair?t=x&epk=y&n=z'),
        throwsA(
          isA<PairingCodeError>().having(
            (e) => e.problem,
            'problem',
            PairingCodeProblem.wrongScheme,
          ),
        ),
      );
    });

    test('faltando campo', () {
      expect(
        () => parsePairingCode('remotepi://pair?t=$tokenB64Url&epk=$epkB64Url'),
        throwsA(
          isA<PairingCodeError>().having(
            (e) => e.problem,
            'problem',
            PairingCodeProblem.missingField,
          ),
        ),
      );
    });

    test('epk com tamanho errado', () {
      expect(
        () => buildUri(epk: base64Url.encode(List.filled(16, 1))),
        throwsA(
          isA<PairingCodeError>().having(
            (e) => e.problem,
            'problem',
            PairingCodeProblem.badEpk,
          ),
        ),
      );
    });

    test('token com tamanho errado', () {
      expect(
        () => buildUri(token: base64Url.encode(List.filled(8, 1))),
        throwsA(
          isA<PairingCodeError>().having(
            (e) => e.problem,
            'problem',
            PairingCodeProblem.badToken,
          ),
        ),
      );
    });
  });
}
