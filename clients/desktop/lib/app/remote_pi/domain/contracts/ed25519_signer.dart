import 'dart:typed_data';

/// App-key Ed25519 efêmera (PROTOCOL.md): a identidade do cliente no relay É
/// a chave pública; a privada vive só em RAM pela sessão de pareamento.
///
/// Contrato no domínio; a impl de produção usa pinenacl (TweetNaCl) e os
/// testes injetam um signer determinístico.
abstract interface class Ed25519Signer {
  /// Base64 RFC 4648 padrão COM padding — formato do registro do relay.
  String get publicKeyBase64;

  /// Assina os bytes crus (nonce do challenge) → 64 bytes.
  Future<Uint8List> sign(Uint8List message);
}

/// Fábrica de signers. Interface **nomeada** (não `Function()`): o
/// parser de parâmetros do auto_injector quebra no `=>` — regra do CLAUDE.md.
abstract interface class Ed25519SignerFactory {
  Future<Ed25519Signer> create();
}
