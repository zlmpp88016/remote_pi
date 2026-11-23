import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/history_fixture_bootstrap.dart';

void main() {
  group('isolated history fixture bootstrap', () {
    const origin = 'http://127.0.0.1:61986';
    test('requires profile, harness opt-in, explicit boot opt-in and exact loopback origin', () {
      expect(useIsolatedHistoryFixtureBootstrap(
        profile: true, performanceOptIn: true, fixtureBootOptIn: true, origin: origin,
      ), isTrue);
      for (final values in <({bool profile, bool performanceOptIn, bool fixtureBootOptIn, String origin})>[
        (profile: false, performanceOptIn: true, fixtureBootOptIn: true, origin: origin),
        (profile: true, performanceOptIn: false, fixtureBootOptIn: true, origin: origin),
        (profile: true, performanceOptIn: true, fixtureBootOptIn: false, origin: origin),
        (profile: true, performanceOptIn: true, fixtureBootOptIn: true, origin: 'http://localhost:61986'),
        (profile: true, performanceOptIn: true, fixtureBootOptIn: true, origin: 'https://127.0.0.1:61986'),
        (profile: true, performanceOptIn: true, fixtureBootOptIn: true, origin: 'http://127.0.0.1:61986/'),
      ]) {
        expect(useIsolatedHistoryFixtureBootstrap(
          profile: values.profile,
          performanceOptIn: values.performanceOptIn,
          fixtureBootOptIn: values.fixtureBootOptIn,
          origin: values.origin,
        ), isFalse);
      }
    });
  });
}
