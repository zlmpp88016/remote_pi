import 'dart:convert';
import 'dart:typed_data';

import 'package:pinenacl/ed25519.dart' show SigningKey;

import '../domain/contracts/ed25519_signer.dart';

/// App-key Ed25519 efêmera via pinenacl (TweetNaCl puro Dart — mesma biblioteca
/// que já gera as chaves SSH do device em `mobile_ssh_key_store.dart`).
///
/// A chave nasce no RAM por instância e morre com ela: nenhuma persistência,
/// nenhum keychain — é a identidade de sessão de pareamento do PROTOCOL.md.
class PinenaclEd25519Signer implements Ed25519Signer {
  PinenaclEd25519Signer._(this._key);

  factory PinenaclEd25519Signer.generate() =>
      PinenaclEd25519Signer._(SigningKey.generate());

  final SigningKey _key;

  @override
  String get publicKeyBase64 => base64.encode(Uint8List.fromList(_key.verifyKey));

  @override
  Future<Uint8List> sign(Uint8List message) async =>
      Uint8List.fromList(_key.sign(message).signature);
}

class PinenaclEd25519SignerFactory implements Ed25519SignerFactory {
  const PinenaclEd25519SignerFactory();

  @override
  Future<Ed25519Signer> create() async => PinenaclEd25519Signer.generate();
}
