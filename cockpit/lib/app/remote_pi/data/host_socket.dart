import 'dart:async';
import 'dart:io';

/// Socket WebSocket mínimo que o [RelayHostClient] consome. Interface fina de
/// propósito: os testes injetam um par de sockets em memória (stub do
/// protocolo) sem rede — espelha o `WebSocketFactory` do cliente web de
/// referência (`site/src/lib/remote-pi/client.ts`).
abstract interface class HostSocket {
  /// Envia um frame de texto (JSON).
  void send(String data);

  /// Frames inbound (strings JSON).
  Stream<dynamic> get stream;

  Future<void> close();
}

/// Conecta um [HostSocket] real. Abstração de fábrica pela mesma razão do
/// socket: produção = `dart:io` WebSocket (desktop), teste = stub.
abstract interface class HostSocketFactory {
  Future<HostSocket> connect(Uri uri, {Iterable<String>? protocols});
}

/// `dart:io` WebSocket — o transporte desktop do Cockpit.
class IoHostSocket implements HostSocket {
  IoHostSocket(this._ws);

  final WebSocket _ws;

  static Future<HostSocket> connect(Uri uri, {Iterable<String>? protocols}) async =>
      IoHostSocket(await WebSocket.connect(uri.toString(), protocols: protocols));

  @override
  void send(String data) => _ws.add(data);

  /// `dart:io` WebSocket **é** um `Stream<dynamic>` (implementa, não
  /// expõe `.stream`) — devolve a própria conexão.
  @override
  Stream<dynamic> get stream => _ws;

  @override
  Future<void> close() => _ws.close();
}

class IoHostSocketFactory implements HostSocketFactory {
  const IoHostSocketFactory();

  @override
  Future<HostSocket> connect(Uri uri, {Iterable<String>? protocols}) =>
      IoHostSocket.connect(uri, protocols: protocols);
}
