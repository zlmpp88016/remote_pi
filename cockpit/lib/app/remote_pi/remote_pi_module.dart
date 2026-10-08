import 'package:cockpit/app/remote_pi/data/host_socket.dart';
import 'package:cockpit/app/remote_pi/data/pinenacl_ed25519_signer.dart';
import 'package:cockpit/app/remote_pi/data/relay_host_client_factory.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/ed25519_signer.dart';
import 'package:cockpit/app/remote_pi/domain/contracts/host_client_factory.dart';
import 'package:cockpit/app/remote_pi/domain/value_objects/host_client_config.dart';
import 'package:cockpit/app/remote_pi/ui/remote_pi_host_page.dart';
import 'package:cockpit/app/remote_pi/ui/viewmodels/remote_pi_host_viewmodel.dart';
import 'package:flutter_modular/flutter_modular.dart';

/// Feature **Remote Pi** (plano 69 W3) — modo de conexão por pareamento host.
///
/// `path: '/remote-pi'`, empilhada por cima do shell via `pushNamed`. Os binds
/// de infra (socket `dart:io`, signer pinenacl efêmero, config) são
/// feature-scoped; a VM é page-scoped (`provide`) e dona do ciclo de vida do
/// client — cria um por tentativa de conexão e fecha no dispose.
Module buildRemotePiHostModule() => createModule(
  path: '/remote-pi',
  register: (c) {
    c
      ..addInstance<HostSocketFactory>(const IoHostSocketFactory())
      ..addInstance<Ed25519SignerFactory>(const PinenaclEd25519SignerFactory())
      ..addInstance<HostClientConfig>(const HostClientConfig())
      ..addLazySingleton<HostClientFactory>(RelayHostClientFactory.new)
      ..route(
        '/',
        transition: TransitionType.fade,
        provide: (s) => s
            .addChangeNotifier<RemotePiHostViewModel>(
              RemotePiHostViewModel.new,
            ),
        child: (context, state) => const RemotePiHostPage(),
      );
  },
);
