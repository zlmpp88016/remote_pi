/// Guard the fresh-package browse harness from production identity/relay
/// bootstrap. All four conditions are required; caller input alone is not enough.
bool useIsolatedHistoryFixtureBootstrap({
  required bool profile,
  required bool performanceOptIn,
  required bool fixtureBootOptIn,
  required String origin,
}) =>
    profile &&
    performanceOptIn &&
    fixtureBootOptIn &&
    origin == 'http://127.0.0.1:61986';
