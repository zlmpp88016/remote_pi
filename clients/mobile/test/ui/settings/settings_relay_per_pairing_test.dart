// #34 — o 中继 pertence ao PAR, não ao app.
//
// O sintoma relatado foi literal: "adiciono um par a um segundo servidor, e
// esse 中继 é o endereço do primeiro ou do segundo?". A causa era estrutural —
// existia um único `Preferences.relayUrl` global, aplicado a TODA conexão,
// enquanto `PeerRecord.relayUrl` era gravado e nunca lido. Com dois servidores
// pareados a pergunta não tinha resposta.
//
// Estes testes fixam as duas metades da correção: (1) cada par guarda e mantém
// seu próprio endereço, sem um sobrescrever o outro; (2) a tela de Configurações
// não oferece mais um campo global editável, porque esse campo era justamente a
// fonte da confusão.

import 'dart:async';
import 'dart:typed_data';

import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/data/transport/peer_channel.dart';
import 'package:mobile/pairing/pair_request_flow.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/settings/settings_page.dart';
import 'package:mobile/ui/settings/viewmodels/settings_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

class _NoopTransport implements PeerTransport {
  @override
  Future<void> send(Uint8List data) async {}
  @override
  Future<Uint8List> receive() => Completer<Uint8List>().future;
  @override
  Future<void> close() async {}
}

class _FakeStorage extends PairingStorage {
  List<PeerRecord> peers;
  _FakeStorage(this.peers);

  @override
  Future<List<PeerRecord>> listPeers() async => List.of(peers);

  @override
  Future<void> savePeer(PeerRecord r) async {
    peers = [r, ...peers.where((p) => p.remoteEpk != r.remoteEpk)];
  }

  @override
  Future<void> deletePeer(String epk) async {
    peers = peers.where((p) => p.remoteEpk != epk).toList();
  }

  @override
  Future<List<PersistedRoom>> loadRooms(String remoteEpk) async => const [];
}

class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _v = {};
  @override
  Future<String?> read({required String key, IOSOptions? iOptions, AndroidOptions? aOptions, LinuxOptions? lOptions, WebOptions? webOptions, MacOsOptions? mOptions, WindowsOptions? wOptions}) async => _v[key];
  @override
  Future<void> write({required String key, required String? value, IOSOptions? iOptions, AndroidOptions? aOptions, LinuxOptions? lOptions, WebOptions? webOptions, MacOsOptions? mOptions, WindowsOptions? wOptions}) async {
    if (value == null) {
      _v.remove(key);
    } else {
      _v[key] = value;
    }
  }
  @override
  Future<void> delete({required String key, IOSOptions? iOptions, AndroidOptions? aOptions, LinuxOptions? lOptions, WebOptions? webOptions, MacOsOptions? mOptions, WindowsOptions? wOptions}) async {
    _v.remove(key);
  }
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

PeerRecord _peer(String epk, String relay) => PeerRecord(
  remoteEpk: epk,
  sessionName: 'Pi $epk',
  relayUrl: relay,
  pairedAt: '2026-01-01T00:00:00Z',
);

ConnectionManager _conn(_FakeStorage storage) => ConnectionManager(
  factory: (_, _) async => PlainPeerChannel(transport: _NoopTransport()),
  storage: storage,
  emitDebounce: Duration.zero,
);

Future<({SettingsViewModel vm, Preferences prefs, ConnectionManager conn})>
_rig(_FakeStorage storage) async {
  final prefs = Preferences(_FakeSecureStorage());
  await prefs.load();
  final conn = _conn(storage);
  final vm = SettingsViewModel(storage, prefs, conn);
  return (vm: vm, prefs: prefs, conn: conn);
}

void main() {
  test('two pairings keep their own relay — one never overwrites the other',
      () async {
    final storage = _FakeStorage([
      _peer('epkA', 'https://relay-one.example.com'),
      _peer('epkB', 'https://relay-two.example.com'),
    ]);

    final peers = await storage.listPeers();
    expect(peers, hasLength(2));

    final byEpk = {for (final p in peers) p.remoteEpk: p.relayUrl};
    expect(byEpk['epkA'], 'https://relay-one.example.com');
    expect(byEpk['epkB'], 'https://relay-two.example.com');

    // Saving one must not touch the other: the relay lives on the record, so
    // there is no shared cell for them to fight over.
    final first = peers.firstWhere((p) => p.remoteEpk == 'epkA');
    await storage.savePeer(PeerRecord(
      remoteEpk: first.remoteEpk,
      sessionName: first.sessionName,
      relayUrl: 'https://relay-one-changed.example.com',
      pairedAt: first.pairedAt,
    ));
    final after = {for (final p in await storage.listPeers()) p.remoteEpk: p.relayUrl};
    expect(after['epkA'], 'https://relay-one-changed.example.com');
    expect(after['epkB'], 'https://relay-two.example.com',
        reason: 'the second pairing must be untouched');
  });

  test('changing the default relay does not rewrite existing pairings',
      () async {
    final storage = _FakeStorage([
      _peer('epkA', 'https://relay-one.example.com'),
    ]);
    final r = await _rig(storage);
    addTearDown(r.vm.dispose);
    addTearDown(r.prefs.dispose);
    addTearDown(r.conn.dispose);

    // The default is a PREFILL for the next pairing, nothing more.
    await r.vm.saveRelayUrl('https://brand-new.example.com');

    final peers = await storage.listPeers();
    expect(peers.single.relayUrl, 'https://relay-one.example.com',
        reason: 'an existing pairing keeps the address it was made through');
  });

  testWidgets('Settings has no global relay input any more', (tester) async {
    final storage = _FakeStorage([
      _peer('epkA', 'https://relay-one.example.com'),
      _peer('epkB', 'https://relay-two.example.com'),
    ]);
    final r = await _rig(storage);
    addTearDown(r.vm.dispose);
    addTearDown(r.prefs.dispose);
    addTearDown(r.conn.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<SettingsViewModel>.value(value: r.vm),
          ChangeNotifierProvider<Preferences>.value(value: r.prefs),
        ],
        child: const MaterialApp(home: SettingsPage()),
      ),
    );
    await tester.pumpAndSettle();

    // The editable field is gone. Its presence is what let a single value
    // masquerade as "the" relay for every server.
    expect(find.byType(TextField), findsNothing);
    expect(find.text('https://my-relay.example.com'), findsNothing);

    // The section that remains says what it actually does.
    expect(find.text(AppSettingsCopy.defaultRelay), findsOneWidget);
    expect(find.text(AppSettingsCopy.defaultRelayDetail), findsOneWidget);

    // Each pairing shows ITS OWN address, side by side and different.
    expect(find.textContaining('https://relay-one.example.com'), findsOneWidget);
    expect(find.textContaining('https://relay-two.example.com'), findsOneWidget);

    // Tear the tree down BEFORE disposing the manager: its watchdog timer is
    // still armed, and a pending timer fails the test harness.
    await tester.pumpWidget(const SizedBox.shrink());
    r.conn.dispose();
    await tester.pumpAndSettle();
  });
}
