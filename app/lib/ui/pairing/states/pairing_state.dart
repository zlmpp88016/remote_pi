import 'package:app/pairing/storage.dart';

sealed class PairingState {
  const PairingState();
}

/// Initial state — pairing form not yet shown.
class PairingIdle extends PairingState {
  const PairingIdle();
}

/// Form visible, waiting for the pairing code. Plan/68 removed the
/// camera/QR-scan path; plan/69 W1 turned this into the address + code
/// form. The class name is kept so existing call sites (onboarding,
/// router, tests) stay stable.
class PairingScanning extends PairingState {
  const PairingScanning();
}

/// Code accepted; opening transport + sending pair_request.
class PairingConnecting extends PairingState {
  final String sessionName;
  const PairingConnecting({required this.sessionName});
}

/// Pi confirmed; channel adopted. UI navigates straight to chat
/// after the post-pair nickname modal is dismissed.
///
/// Plan/27 Wave A — [hostnameHint] is what the pi-extension reported
/// as its OS hostname in `pair_ok.hostname`. The post-pair nickname
/// modal pre-fills its input with it (e.g. "Mac do Jacob") instead
/// of the generic "Pi" placeholder. `null` on legacy Pis that
/// haven't been upgraded yet.
class PairingPaired extends PairingState {
  final PeerRecord peer;
  final String? hostnameHint;
  const PairingPaired({required this.peer, this.hostnameHint});

  @override
  bool operator ==(Object other) =>
      other is PairingPaired &&
      other.peer.remoteEpk == peer.remoteEpk &&
      other.hostnameHint == hostnameHint;

  @override
  int get hashCode => Object.hash(peer.remoteEpk, hostnameHint);
}

/// Transport or pair_request failed (network, timeout, Pi refusal).
/// Distinct from [PairingValidationError]: this one means the attempt
/// actually ran and the remote side (or the socket) said no.
class PairingError extends PairingState {
  final String message;
  final bool canRetry;
  const PairingError({required this.message, this.canRetry = true});
}

// ---------------------------------------------------------------------------
// Typed form validation (plan/69 W1)
// ---------------------------------------------------------------------------

/// Machine-readable reason a pairing submission was rejected BEFORE any
/// network work. The screen maps each code to a field-level message; the
/// [relayMismatch] case preserves the plan/68 `relay_mismatch` contract
/// (the pairing code names the relay its issuer is on).
enum PairingValidationCode {
  /// The pasted text is not a `remotepi://pair?…` payload.
  invalidPayload,

  /// The address field holds something that is not a relay URL.
  invalidRelay,

  /// The code carries `r=<relay>` and the address field points elsewhere.
  relayMismatch,
}

/// A typed validation failure. NOT part of the [PairingState] machine:
/// it lives on the ViewModel as form state so the user stays on the
/// form and can fix the offending field (the pairing page keeps
/// rendering [PairingScanning] underneath).
class PairingValidationError {
  final PairingValidationCode code;
  final String message;
  const PairingValidationError({required this.code, required this.message});

  /// Stable wire code — `relay_mismatch` matches the
  /// `pair_request_flow.dart` error code so logs/tests agree.
  String get wireCode => switch (code) {
    PairingValidationCode.invalidPayload => 'invalid_payload',
    PairingValidationCode.invalidRelay => 'invalid_relay',
    PairingValidationCode.relayMismatch => 'relay_mismatch',
  };
}
