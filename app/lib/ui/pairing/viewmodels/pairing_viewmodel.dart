import 'dart:io' show Platform;

import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/data/transport/peer_channel.dart';
import 'package:app/data/transport/relay_config.dart';
import 'package:app/pairing/owner_identity_bridge.dart';
import 'package:app/pairing/pair_request_flow.dart' as pair_flow;
import 'package:app/pairing/pair_payload.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';
import 'package:app/ui/pairing/states/pairing_state.dart';
import 'package:cryptography/cryptography.dart';

// Factory that produces a connected PeerTransport for the given QR payload.
// Production: WsTransport.connect(...). Tests: in-memory pipe.
typedef PairingTransportFactory =
    Future<pair_flow.PeerTransport> Function(
      PairPayload qr,
      SimpleKeyPair deviceEd25519,
    );

class PairingViewModel extends ViewModel<PairingState> {
  final PairingStorage _storage;
  final PairingTransportFactory _transportFactory;
  // Plan/31 — connection lifecycle (disconnect/adopt) now goes straight to
  // the ConnectionManager (the removed SessionRepository was a pass-through).
  final ConnectionManager _conn;
  final Preferences _prefs;
  final OwnerIdentityBridge _ownerBridge;
  pair_flow.PeerTransport? _transport;
  PlainPeerChannel? _liveChannel;

  /// Relay the LAST pairing attempt dialled — surfaced in the timeout message
  /// so a relay mismatch is visible instead of blaming the Pi. Reset per
  /// attempt in [submitPairingCode].
  String? _lastRelayUrl;

  /// Overall deadline for the pair_request/pair_ok exchange. Injectable so
  /// tests can exercise the timeout branch without waiting 30 real seconds.
  final Duration _pairTimeout;

  PairingViewModel(
    this._storage,
    this._transportFactory,
    this._conn,
    this._prefs,
    this._ownerBridge, {
    Duration pairTimeout = const Duration(seconds: 30),
  }) : _pairTimeout = pairTimeout,
       super(const PairingScanning());

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /// Called when MobileScanner detects a barcode.
  Future<void> submitPairingCode(String rawUri) async {
    if (state is PairingConnecting) return;

    final qr = PairPayload.tryParse(rawUri);
    if (qr == null) return; // not a remotepi:// QR — ignore silently

    emit(PairingConnecting(sessionName: qr.sessionName));

    // A QR generated since the `r=` fix names the relay the Pi is actually on.
    // ADOPT it (persist into Preferences) before dialling: the pairing
    // transport resolves the relay from Preferences, so this is what makes a
    // self-hosted relay work with zero manual configuration — the user just
    // pastes the code. A legacy QR (no `r`) keeps the app's own preference.
    if (qr.relayUrl != null &&
        qr.relayUrl!.isNotEmpty &&
        !relayUrlsMatch(qr.relayUrl!, resolveRelayUrl(_prefs))) {
      if (isValidRelayUrl(qr.relayUrl!)) {
        await _prefs.setRelayUrl(qr.relayUrl!);
      }
    }

    // Capture the relay this attempt will dial, for the timeout message.
    _lastRelayUrl = resolveRelayUrl(_prefs);

    try {
      // Close any active session before opening a new WS to the relay.
      // Same device Ed25519 key on a second WS would collide in the relay's
      // peer registry, causing the old handler to unregister our new entry.
      await _conn.disconnect();

      // Plan 23 — challenge-response now uses the Owner-key (synced
      // via iCloud Keychain / Block Store). The bridge is hydrated by
      // the router's _BootState well before pairing is reachable, so
      // requireKeyPair() never throws here.
      final ownerKey = await _ownerBridge.requireKeyPair();

      final transport = await _transportFactory(qr, ownerKey);
      _transport = transport;

      final result = await pair_flow
          .performPairing(
            qr: qr,
            transport: transport,
            storage: _storage,
            deviceName: _deviceName(),
            currentRelayUrl: resolveRelayUrl(_prefs),
          )
          .timeout(
            _pairTimeout,
            onTimeout: () => throw const pair_flow.PairingError(
              code: 'pair_timeout',
              message:
                  'Timed out — make sure /remote-pi is running on your Mac',
            ),
          );

      final channel = PlainPeerChannel(transport: transport);
      _liveChannel = channel;
      _transport = null; // channel now owns the transport

      _conn.adopt(channel, result.peer);
      _liveChannel = null;

      emit(PairingPaired(peer: result.peer, hostnameHint: result.hostnameHint));
    } on pair_flow.PairingError catch (e) {
      await _closeTransient();
      emit(PairingError(message: _friendlyError(e), canRetry: true));
    } catch (e) {
      await _closeTransient();
      emit(PairingError(message: e.toString(), canRetry: true));
    }
  }

  /// Retry after an error.
  void retry() => emit(const PairingScanning());

  /// Persist a nickname on the just-paired peer. Called by the
  /// post-pair nickname modal (plan/27 Wave A) — `null` or empty
  /// leaves the existing record unchanged, anything else is written
  /// back through [PairingStorage.savePeer], whose mutation hook
  /// republishes `mesh_versions` so other devices learn the label.
  ///
  /// The trimmed nickname is also reflected on the in-state peer so
  /// the post-frame navigation to /home shows the chosen label
  /// immediately (no flicker waiting for `loadPeer`).
  Future<void> applyNickname(String? nickname) async {
    final s = state;
    if (s is! PairingPaired) return;
    final trimmed = nickname?.trim();
    if (trimmed == null || trimmed.isEmpty) return;
    final updated = s.peer.copyWith(nickname: trimmed);
    await _storage.savePeer(updated);
    emit(PairingPaired(peer: updated, hostnameHint: s.hostnameHint));
  }

  // ---------------------------------------------------------------------------

  Future<void> _closeTransient() async {
    await _liveChannel?.close();
    _liveChannel = null;
    await _transport?.close();
    _transport = null;
  }

  String _friendlyError(pair_flow.PairingError e) => switch (e.code) {
    'token_expired' => 'QR expired — generate a new one on your Mac',
    'token_consumed' => 'QR already used — generate a new one',
    'token_unknown' => 'QR not recognized by Mac — re-run /remote-pi pair',
    // Include the relay this attempt dialled: since plan 14 the QR carries no
    // relay, and the ONLY symptom of an App/Pi relay mismatch is this timeout.
    // Without the address the error reads as "the Pi is down" and the real
    // cause (both sides on different relays) stays invisible.
    'pair_timeout' => _lastRelayUrl == null
        ? 'Timed out — make sure /remote-pi is running on your Mac'
        : 'Timed out talking to $_lastRelayUrl — make sure /remote-pi is '
            'running AND that the Pi uses this same relay (check '
            '/remote-pi config on it).',
    _ => e.message.isEmpty ? e.code : e.message,
  };

  static String _deviceName() {
    try {
      if (Platform.isIOS) return 'iPhone';
      if (Platform.isAndroid) return 'Android device';
      return 'Mobile';
    } catch (_) {
      return 'Mobile';
    }
  }
}
