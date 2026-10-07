import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/relay_config.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';
import 'package:app/ui/onboarding/states/onboarding_state.dart';

/// Owns the 3-step onboarding flow. Pure state machine — the actual
/// pairing happens via [PairingViewModel] surfaced inside `pair_step.dart`.
/// Once pairing succeeds (callback into [completePairing]) the flag in
/// [Preferences] flips and the router redirects to `/home`.
class OnboardingViewModel extends ViewModel<OnboardingState> {
  final Preferences _prefs;

  /// Seeds the relay step from the ALREADY-PERSISTED override so re-running
  /// onboarding (e.g. after the last peer was revoked) cannot silently reset a
  /// self-hosted relay back to the default. The old default (`community` + an
  /// empty custom URL) made `next()` call `setRelayUrl(null)`, which DELETES
  /// the stored key — the pairing then silently targeted the public relay and
  /// only ever surfaced as a timeout.
  ///
  /// Only a VALID stored relay is seeded as `custom`. A legacy value in a
  /// scheme the app no longer accepts (`ws://`/`wss://`, persisted by a
  /// pre-plan/14 build — `Preferences.setRelayUrl` does not validate) must NOT
  /// be seeded, or the step would open with Continue permanently disabled and
  /// the user stuck on a field they never typed into. Such values fall back to
  /// `community`, which clears them on [next] — the same "the onboarding gate
  /// re-sets historical values" behavior the app had before.
  ///
  /// `community` is also the seed when there is no override at all.
  OnboardingViewModel(this._prefs)
      : super(
          OnboardingInProgress(
            relayChoice: _seedableRelay(_prefs.relayUrl) != null
                ? RelayChoice.custom
                : RelayChoice.community,
            customRelayUrl: _seedableRelay(_prefs.relayUrl) ?? '',
          ),
        );

  /// The stored relay, but only when it is a value the relay step can accept
  /// (non-empty and `isValidRelayUrl`). Null otherwise — see the constructor.
  static String? _seedableRelay(String? stored) =>
      (stored != null && stored.isNotEmpty && isValidRelayUrl(stored))
          ? stored
          : null;

  // ---------------------------------------------------------------------------
  // Step navigation
  // ---------------------------------------------------------------------------

  void next() {
    final s = state;
    if (s is! OnboardingInProgress) return;
    switch (s.step) {
      case OnboardingStep.welcome:
        emit(s.copyWith(step: OnboardingStep.relay));
      case OnboardingStep.relay:
        // Validate the relay choice before advancing. Empty custom URL
        // is allowed — it falls back to the default community relay.
        if (s.relayChoice == RelayChoice.custom &&
            s.customRelayUrl.isNotEmpty) {
          final reason = relayUrlValidationMessage(s.customRelayUrl);
          if (reason != null) {
            emit(s.copyWith(customRelayError: reason));
            return;
          }
        }
        // Persist the step's outcome. An empty custom URL means "use the
        // default community relay" (see the step contract) and therefore
        // clears the override, exactly like choosing `community`. The seed in
        // the constructor already restored a valid stored override into this
        // state, so re-running onboarding writes the same value back — it is
        // the MISSING SEED, not this write, that used to wipe the relay.
        final urlToSave = s.relayChoice == RelayChoice.custom &&
                s.customRelayUrl.isNotEmpty
            ? s.customRelayUrl
            : null;
        // ignore: unawaited_futures
        _prefs.setRelayUrl(urlToSave);
        emit(s.copyWith(step: OnboardingStep.pair, clearCustomError: true));
      case OnboardingStep.pair:
        // Advancing from pair happens via `completePairing` (callback
        // when pair_ok lands). Manual `next()` from pair is a no-op.
    }
  }

  void back() {
    final s = state;
    if (s is! OnboardingInProgress) return;
    switch (s.step) {
      case OnboardingStep.welcome:
        return; // first step — no back
      case OnboardingStep.relay:
        emit(s.copyWith(step: OnboardingStep.welcome));
      case OnboardingStep.pair:
        emit(s.copyWith(step: OnboardingStep.relay));
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2 — relay configuration
  // ---------------------------------------------------------------------------

  void setRelayChoice(RelayChoice choice) {
    final s = state;
    if (s is! OnboardingInProgress) return;
    emit(s.copyWith(relayChoice: choice, clearCustomError: true));
  }

  /// Updates the in-flight custom URL string. Validates on-the-fly:
  /// inline error if non-empty + invalid. Empty input clears the error
  /// (user is still typing).
  void setCustomRelayUrl(String url) {
    final s = state;
    if (s is! OnboardingInProgress) return;
    final error = url.isEmpty ? null : relayUrlValidationMessage(url);
    emit(s.copyWith(
      customRelayUrl: url,
      customRelayError: error,
      clearCustomError: error == null,
    ));
  }

  // ---------------------------------------------------------------------------
  // Step 3 — pairing success
  // ---------------------------------------------------------------------------

  /// Called by `pair_step.dart` when the underlying PairingViewModel
  /// reports a successful pair_ok. Flips the onboarding flag in
  /// preferences and transitions to [OnboardingComplete] — the
  /// OnboardingPage observes that and navigates to `/home`.
  Future<void> completePairing() async {
    await _prefs.setOnboardingCompleted(true);
    emit(const OnboardingComplete());
  }

  /// User dismisses the QR step ("Scan later"). Onboarding is marked
  /// done so we don't loop back here, but no peer is paired — Home
  /// will show the "Awaiting pairing" empty state until the user pairs
  /// from there.
  Future<void> skipPairing() async {
    await _prefs.setOnboardingCompleted(true);
    emit(const OnboardingComplete());
  }
}
