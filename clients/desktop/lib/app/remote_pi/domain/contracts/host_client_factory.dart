import 'host_client.dart';

/// Fábrica de [HostClient] — uma instância nova por tentativa de conexão (o
/// cliente é descartável: depois de `close()` ou de uma falha de handshake,
/// a VM cria o próximo). Interface nomeada porque o parser de parâmetros do
/// auto_injector quebra em `Function()` (regra do CLAUDE.md).
abstract interface class HostClientFactory {
  HostClient create();
}
