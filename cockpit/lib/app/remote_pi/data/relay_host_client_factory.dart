import '../domain/contracts/ed25519_signer.dart';
import '../domain/contracts/host_client.dart';
import '../domain/contracts/host_client_factory.dart';
import '../domain/value_objects/host_client_config.dart';
import 'host_socket.dart';
import 'relay_host_client.dart';

/// Cria [RelayHostClient]s com as dependências de produção resolvidas pelo
/// injector (socket `dart:io` + signer pinenacl). Um client novo por tentativa
/// de conexão — o anterior pode estar fechado ou com o handshake morto.
class RelayHostClientFactory implements HostClientFactory {
  RelayHostClientFactory(this._socketFactory, this._signerFactory, this._config);

  final HostSocketFactory _socketFactory;
  final Ed25519SignerFactory _signerFactory;
  final HostClientConfig _config;

  @override
  HostClient create() => RelayHostClient(_socketFactory, _signerFactory, _config);
}
