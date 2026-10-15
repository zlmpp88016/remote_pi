/// Configuração do cliente do room `host`. Value object injetável (regra do
/// auto_injector: vários primitivos ambíguos viram um tipo nomeado).
class HostClientConfig {
  const HostClientConfig({
    this.requestTimeout = const Duration(seconds: 10),
    this.handshakeTimeout = const Duration(seconds: 5),
    this.authGrace = const Duration(milliseconds: 300),
    this.deviceName = 'Cockpit',
    this.subprotocol = 'remote-pi.1',
  });

  /// Tempo máximo de espera por reply de request.
  final Duration requestTimeout;

  /// Tempo máximo pela fase `hello → challenge → auth`.
  final Duration handshakeTimeout;

  /// Janela de cortesia depois do `auth`: o relay fecha na hora quando a
  /// assinatura é rejeitada, e não diz NADA quando dá certo (relay HELLO).
  final Duration authGrace;

  /// Nome do dispositivo anunciado no `pair_request` (`device_name`).
  final String deviceName;

  /// Subprotocolo oferecido no handshake WS; o relay ecoa o negociado
  /// (plano 69 W4). Convenção do lado cliente — PROTOCOL.md não fixa nome.
  final String subprotocol;
}
