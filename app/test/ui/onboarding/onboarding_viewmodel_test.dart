import 'package:app/data/preferences/preferences.dart';
import 'package:app/ui/onboarding/states/onboarding_state.dart';
import 'package:app/ui/onboarding/viewmodels/onboarding_viewmodel.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeStore implements FlutterSecureStorage {
  final Map<String, String> _m = {};
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _m[key];
  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _m.remove(key);
    } else {
      _m[key] = value;
    }
  }
  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _m.remove(key);
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

Future<({Preferences prefs, OnboardingViewModel vm})> _setup({
  String? storedRelay,
}) async {
  final prefs = Preferences(_FakeStore());
  if (storedRelay != null) {
    await prefs.load();
    await prefs.setRelayUrl(storedRelay);
  }
  final vm = OnboardingViewModel(prefs);
  return (prefs: prefs, vm: vm);
}

void main() {
  group('OnboardingViewModel', () {
    test('initial state is OnboardingInProgress(welcome, community)',
        () async {
      final s = await _setup();
      final state = s.vm.state;
      expect(state, isA<OnboardingInProgress>());
      final p = state as OnboardingInProgress;
      expect(p.step, OnboardingStep.welcome);
      expect(p.relayChoice, RelayChoice.community);
      expect(p.customRelayUrl, isEmpty);
      expect(p.customRelayError, isNull);
    });

    test('next() advances welcome → relay', () async {
      final s = await _setup();
      s.vm.next();
      expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.relay);
    });

    test(
      'next() on relay step with community choice persists null relay '
      '(falls back to default) and advances to pair',
      () async {
        final s = await _setup();
        s.vm.next(); // → relay
        s.vm.next(); // community → pair
        expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.pair);
        expect(s.prefs.relayUrl, isNull,
            reason: 'community choice clears the override');
      },
    );

    test(
      'next() on relay step with INVALID custom URL emits error + '
      'stays on relay step',
      () async {
        final s = await _setup();
        s.vm.next(); // → relay
        s.vm.setRelayChoice(RelayChoice.custom);
        s.vm.setCustomRelayUrl('not-a-url');
        s.vm.next(); // should not advance
        final state = s.vm.state as OnboardingInProgress;
        expect(state.step, OnboardingStep.relay);
        expect(state.customRelayError, isNotNull);
      },
    );

    test(
      'next() on relay step with VALID custom URL persists it and '
      'advances to pair',
      () async {
        final s = await _setup();
        s.vm.next(); // → relay
        s.vm.setRelayChoice(RelayChoice.custom);
        s.vm.setCustomRelayUrl('https://my-relay.example');
        s.vm.next();
        expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.pair);
        // setRelayUrl is await-able but called fire-and-forget inside
        // the VM. Give the microtask a tick.
        await Future<void>.delayed(Duration.zero);
        expect(s.prefs.relayUrl, 'https://my-relay.example');
      },
    );

    test('back() walks pair → relay → welcome and stops there', () async {
      final s = await _setup();
      s.vm.next();
      s.vm.next();
      expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.pair);
      s.vm.back();
      expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.relay);
      s.vm.back();
      expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.welcome);
      s.vm.back(); // no-op
      expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.welcome);
    });

    test(
      'setCustomRelayUrl validates on-the-fly: invalid → error, empty → '
      'no error, valid → clear error',
      () async {
        final s = await _setup();
        s.vm.next();
        s.vm.setRelayChoice(RelayChoice.custom);

        s.vm.setCustomRelayUrl('ftp://nope');
        expect((s.vm.state as OnboardingInProgress).customRelayError,
            isNotNull);

        s.vm.setCustomRelayUrl('');
        expect((s.vm.state as OnboardingInProgress).customRelayError, isNull);

        s.vm.setCustomRelayUrl('https://localhost');
        expect((s.vm.state as OnboardingInProgress).customRelayError, isNull);
      },
    );

    test(
      'setCustomRelayUrl flags ws:// and wss:// with the scheme-specific '
      'hint about internal conversion',
      () async {
        final s = await _setup();
        s.vm.next();
        s.vm.setRelayChoice(RelayChoice.custom);

        s.vm.setCustomRelayUrl('ws://localhost');
        final err1 =
            (s.vm.state as OnboardingInProgress).customRelayError;
        expect(err1, isNotNull);
        expect(err1, contains('ws://'));
        expect(err1, contains('http://'));

        s.vm.setCustomRelayUrl('wss://relay.example');
        final err2 =
            (s.vm.state as OnboardingInProgress).customRelayError;
        expect(err2, isNotNull);
        expect(err2, contains('ws://'));
      },
    );

    test('completePairing flips onboardingCompleted and emits complete',
        () async {
      final s = await _setup();
      expect(s.prefs.onboardingCompleted, isFalse);
      await s.vm.completePairing();
      expect(s.prefs.onboardingCompleted, isTrue);
      expect(s.vm.state, isA<OnboardingComplete>());
    });

    // -------------------------------------------------------------------------
    // Regression — a stored relay must survive re-running onboarding.
    //
    // The relay step used to boot with `community` + empty custom URL and then
    // call `setRelayUrl(null)` on next(), which DELETES the stored key. Users
    // who hit onboarding twice (revoke the last peer → onboardingCompleted is
    // reset) silently lost a self-hosted relay and only ever saw a pairing
    // timeout blaming the Pi.
    // -------------------------------------------------------------------------

    test('seeds the relay step from a stored override', () async {
      final s = await _setup(storedRelay: 'https://relay.880160.xyz');
      final state = s.vm.state as OnboardingInProgress;
      expect(state.relayChoice, RelayChoice.custom);
      expect(state.customRelayUrl, 'https://relay.880160.xyz');
    });

    test('no stored override still seeds community/empty', () async {
      final s = await _setup();
      final state = s.vm.state as OnboardingInProgress;
      expect(state.relayChoice, RelayChoice.community);
      expect(state.customRelayUrl, isEmpty);
    });

    test(
      're-running onboarding without touching the relay step KEEPS the '
      'stored override',
      () async {
        final s = await _setup(storedRelay: 'https://relay.880160.xyz');
        s.vm.next(); // welcome → relay
        s.vm.next(); // relay → pair (seeded custom)
        await Future<void>.delayed(Duration.zero);
        expect(s.prefs.relayUrl, 'https://relay.880160.xyz',
            reason: 'the stored relay must not be wiped by a re-run');
      },
    );

    test(
      'explicitly choosing community DOES clear a stored override',
      () async {
        final s = await _setup(storedRelay: 'https://relay.880160.xyz');
        s.vm.next(); // → relay (seeded custom)
        s.vm.setRelayChoice(RelayChoice.community);
        s.vm.next(); // → pair
        await Future<void>.delayed(Duration.zero);
        expect(s.prefs.relayUrl, isNull,
            reason: 'a deliberate community choice clears the override');
      },
    );

    // -------------------------------------------------------------------------
    // Regression guard RV-001 — "empty custom == default community" is the
    // step contract (relay_step.dart). Emptying a seeded field must CLEAR the
    // override, not silently keep the old value.
    // -------------------------------------------------------------------------

    test(
      'emptying the seeded custom field clears the override ',
      () async {
        final s = await _setup(storedRelay: 'https://relay.880160.xyz');
        s.vm.next(); // → relay (seeded custom + filled)
        s.vm.setCustomRelayUrl(''); // user erases the field
        s.vm.next();
        await Future<void>.delayed(Duration.zero);
        expect(s.prefs.relayUrl, isNull,
            reason: 'empty custom means "use the default relay"');
      },
    );

    // -------------------------------------------------------------------------
    // Regression guard RV-002 — a legacy non-http(s) relay persisted by an old
    // build must NOT be seeded, or the step opens with Continue permanently
    // disabled (isValidRelayUrl rejects ws://) on a field the user never
    // touched.
    // -------------------------------------------------------------------------

    test(
      'CRITICAL: the relay step stays advanceable with a legacy ws:// relay '
      'persisted',
      () async {
        final s = await _setup(storedRelay: 'ws://legacy.example:8080');
        final state = s.vm.state as OnboardingInProgress;
        expect(state.relayChoice, RelayChoice.community,
            reason: 'an unseedable value must not open the custom branch');
        expect(state.customRelayUrl, isEmpty);
        expect(state.customRelayError, isNull);

        // Must be able to walk through the step and clear the bad value.
        s.vm.next(); // welcome → relay
        s.vm.next(); // relay → pair
        await Future<void>.delayed(Duration.zero);
        expect((s.vm.state as OnboardingInProgress).step, OnboardingStep.pair,
            reason: 'Continue must not be stuck on a seeded legacy value');
        expect(s.prefs.relayUrl, isNull,
            reason: 'the unusable legacy value is cleared on advance');
      },
    );
  });
}
