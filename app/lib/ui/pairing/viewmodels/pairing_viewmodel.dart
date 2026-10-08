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

// Factory that produces a connected PeerTransport for the given pairing
// payload. [relayUrl] is the EFFECTIVE relay the user confirmed in the
// pairing form (plan/69 W1): the address field, or the Preferences
// default when the field is empty. Production: WsTransport.connect(...).
// Tests: in-memory pipe.
typedef PairingTransportFactory =
    Future<pair_flow.PeerTransport> Function(
      PairPayload qr,
      String relayUrl,
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
  /// attempt in [submitPairing].
  String? _lastRelayUrl;

  /// Overall deadline for the pair_request/pair_ok exchange. Injectable so
  /// tests can exercise the timeout branch without waiting 30 real seconds.
  final Duration _pairTimeout;

  // ---------------------------------------------------------------------------
  // Form state (plan/69 W1) — address (relay) + code (pasted URI).
  //
  // The pairing screen has exactly two inputs: the relay address and the
  // pairing code. The address auto-fills from the code's `r=` param when
  // present, is fully editable, and falls back to the Preferences default
  // when empty. Both live on the ViewModel (not in a widget) so the paste
  // sheet, the page and the tests all observe the same source of truth.
  // ---------------------------------------------------------------------------

  String _address = '';
  String _code = '';

  /// Last value auto-filled into [_address] from a code's `r=`. Used by the
  /// overwrite rule: auto-fill replaces the address only while the field is
  /// empty or still holds the previous auto-fill — a manual edit is never
  /// clobbered by a later keystroke in the code field.
  String? _autoFilledAddress;

  /// Last typed validation failure, or `null` when the form is clean.
  PairingValidationError? _validationError;

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
  // Form accessors
  // ---------------------------------------------------------------------------

  /// Raw text of the relay address field.
  String get address => _address;

  /// Raw text of the pairing-code field (the full `remotepi://pair?…` URI).
  String get code => _code;

  /// Typed validation failure for the current form contents, if any.
  PairingValidationError? get validationError => _validationError;

  /// Relay used when the address field is empty — the Preferences
  /// override or the public community relay.
  String get defaultRelayUrl => resolveRelayUrl(_prefs);

  /// Relay this submission will dial: the address field when non-empty,
  /// otherwise [defaultRelayUrl].
  String get effectiveRelayUrl {
    final typed = _address.trim();
    return typed.isEmpty ? resolveRelayUrl(_prefs) : typed;
  }

  bool get canSubmit =>
      _code.trim().isNotEmpty &&
      state is! PairingConnecting &&
      state is! PairingPaired;

  /// Address field edited by the user. Clears any stale validation error.
  void onAddressChanged(String value) {
    _address = value;
    _validationError = null;
    notifyListeners();
  }

  /// Code field edited by the user. When the pasted URI parses and carries
  /// `r=<relay>`, the address field auto-fills with it — unless the user
  /// already typed a different address (see [_autoFilledAddress]).
  void onCodeChanged(String value) {
    _code = value;
    _validationError = null;
    final relay = PairPayload.tryParse(value.trim())?.relayUrl;
    if (relay != null &&
        relay.isNotEmpty &&
        (_address.isEmpty || _address == _autoFilledAddress)) {
      _address = relay;
      _autoFilledAddress = relay;
    }
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /// Submit the current form. Validates with TYPED errors before any
  /// network work (plan/69 W1):
  ///
  ///   1. the code must parse as a `remotepi://pair?…` payload
  ///      ([PairingValidationCode.invalidPayload]);
  ///   2. when the code carries `r=`, the effective address must match it
  ///      ([PairingValidationCode.relayMismatch] — the plan/68 contract,
  ///      the code was issued by a host on that relay);
  ///   3. when the code carries no `r=`, a non-empty address must be a
  ///      valid relay URL ([PairingValidationCode.invalidRelay]).
  ///
  /// On success the effective relay is adopted into Preferences when it
  /// is storable and differs, so a self-hosted relay keeps working with
  /// zero configuration after the first pairing (plan/14 behaviour,
  /// preserved).
  Future<void> submitPairing() async {
    if (state is PairingConnecting || state is PairingPaired) return;

    final payload = PairPayload.tryParse(_code.trim());
    if (payload == null) {
      _failValidation(
        const PairingValidationError(
          code: PairingValidationCode.invalidPayload,
          message:
              'This is not a Remote Pi pairing code. Copy the full '
              'remotepi://pair?… address printed by /remote-pi pair.',
        ),
      );
      return;
    }

    final relayUrl = effectiveRelayUrl;
    if (payload.relayUrl != null) {
      if (!relayUrlsMatch(payload.relayUrl!, relayUrl)) {
        _failValidation(
          PairingValidationError(
            code: PairingValidationCode.relayMismatch,
            message:
                'This code was issued for relay "${payload.relayUrl}", but '
                'the address field says "$relayUrl". Fix the address (or '
                'clear it to use your default relay) and try again.',
          ),
        );
        return;
      }
    } else if (!isValidRelayUrl(relayUrl)) {
      _failValidation(
        PairingValidationError(
          code: PairingValidationCode.invalidRelay,
          message:
              relayUrlValidationMessage(relayUrl) ?? kRelayUrlInvalidGeneric,
        ),
      );
      return;
    }

    _validationError = null;
    emit(PairingConnecting(sessionName: payload.sessionName));

    // Capture the relay this attempt will dial, for the timeout message.
    _lastRelayUrl = relayUrl;

    try {
      // Adopt the effective relay into Preferences when it is storable
      // (http(s)://) and differs from the current one — this is what makes
      // a self-hosted relay work with zero manual configuration: after the
      // first pairing the app stays on the relay it just paired on.
      // Legacy `ws://` values from old codes are honoured for THIS dial
      // (the factory receives them explicitly) but never persisted.
      if (!relayUrlsMatch(relayUrl, resolveRelayUrl(_prefs)) &&
          isValidRelayUrl(relayUrl)) {
        await _prefs.setRelayUrl(relayUrl);
      }

      // Close any active session before opening a new WS to the relay.
      // Same device Ed25519 key on a second WS would collide in the relay's
      // peer registry, causing the old handler to unregister our new entry.
      await _conn.disconnect();

      // Plan 23 — challenge-response now uses the Owner-key (synced
      // via iCloud Keychain / Block Store). The bridge is hydrated by
      // the router's _BootState well before pairing is reachable, so
      // requireKeyPair() never throws here.
      final ownerKey = await _ownerBridge.requireKeyPair();

      final transport = await _transportFactory(payload, relayUrl, ownerKey);
      _transport = transport;

      final result = await pair_flow
          .performPairing(
            qr: payload,
            transport: transport,
            storage: _storage,
            deviceName: _deviceName(),
            currentRelayUrl: relayUrl,
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

  /// Convenience entry point: drop a full pasted URI into the code field
  /// (auto-filling the address from its `r=`) and submit immediately.
  /// Used by the onboarding paste path and by tests.
  Future<void> submitPairingCode(String rawUri) async {
    onCodeChanged(rawUri);
    await submitPairing();
  }

  /// Retry after an error. Returns to the form; the typed address/code
  /// values are preserved so the user can fix just the broken field.
  void retry() {
    _validationError = null;
    emit(const PairingScanning());
  }

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

  void _failValidation(PairingValidationError error) {
    _validationError = error;
    notifyListeners();
  }

  Future<void> _closeTransient() async {
    await _liveChannel?.close();
    _liveChannel = null;
    await _transport?.close();
    _transport = null;
  }

  String _friendlyError(pair_flow.PairingError e) => switch (e.code) {
    'token_expired' => 'Code expired — generate a new one on your computer',
    'token_consumed' => 'Code already used — generate a new one',
    'token_unknown' =>
      'Code not recognized by the host — re-run /remote-pi pair',
    // Include the relay this attempt dialled: since plan 14 the code carries no
    // relay, and the ONLY symptom of an App/host relay mismatch is this timeout.
    // Without the address the error reads as "the host is down" and the real
    // cause (both sides on different relays) stays invisible.
    'pair_timeout' => _lastRelayUrl == null
        ? 'Timed out — make sure /remote-pi is running on your computer'
        : 'Timed out talking to $_lastRelayUrl — make sure /remote-pi is '
            'running AND that the host uses this same relay (check '
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
