import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/data/transport/relay_config.dart';
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

void main() {
  group('relay_config — isValidRelayUrl', () {
    test('accepts http:// and https:// with non-empty host', () {
      expect(isValidRelayUrl('http://localhost'), isTrue);
      expect(isValidRelayUrl('http://127.0.0.1:8080'), isTrue);
      expect(isValidRelayUrl('https://relay.example.com'), isTrue);
      expect(isValidRelayUrl('https://relay.880160.xyz'), isTrue);
    });

    test('rejects ws:// and wss:// — those are conversions only', () {
      expect(isValidRelayUrl('ws://localhost'), isFalse);
      expect(isValidRelayUrl('wss://relay.example.com'), isFalse);
    });

    test('rejects empty, unsupported schemes, missing host', () {
      expect(isValidRelayUrl(''), isFalse);
      expect(isValidRelayUrl('ftp://example.com'), isFalse);
      expect(isValidRelayUrl('foo'), isFalse);
      expect(isValidRelayUrl('https://'), isFalse,
          reason: 'no host segment');
      expect(isValidRelayUrl('http://'), isFalse,
          reason: 'no host segment');
    });
  });

  group('relay_config — relayUrlValidationMessage', () {
    test('returns null for valid http(s) URLs', () {
      expect(relayUrlValidationMessage('https://relay.example.com'), isNull);
      expect(relayUrlValidationMessage('http://localhost:3000'), isNull);
    });

    test('returns ws-specific hint for ws:// and wss://', () {
      final ws = relayUrlValidationMessage('ws://localhost');
      expect(ws, kRelayUrlInvalidScheme);
      expect(ws, contains('http://'));
      expect(ws, contains('ws://'));

      final wss = relayUrlValidationMessage('wss://relay.example.com');
      expect(wss, kRelayUrlInvalidScheme);
    });

    test('returns generic message for empty / malformed input', () {
      expect(relayUrlValidationMessage(''), kRelayUrlInvalidGeneric);
      expect(relayUrlValidationMessage('foo'), kRelayUrlInvalidGeneric);
      expect(relayUrlValidationMessage('ftp://x.com'), kRelayUrlInvalidGeneric);
      expect(relayUrlValidationMessage('https://'), kRelayUrlInvalidGeneric);
    });
  });

  group('relay_config — toWsRelayUrl', () {
    test('translates http(s) to ws(s)', () {
      expect(toWsRelayUrl('https://relay.example.com'),
          'wss://relay.example.com');
      expect(toWsRelayUrl('http://localhost:8080'),
          'ws://localhost:8080');
    });

    test('passes ws(s) through unchanged (legacy QR / PeerRecord)', () {
      expect(toWsRelayUrl('wss://relay.example.com'),
          'wss://relay.example.com');
      expect(toWsRelayUrl('ws://localhost'), 'ws://localhost');
    });
  });

  group('relay_config — resolveRelayUrl', () {
    test('returns prefs.relayUrl when set', () async {
      final p = Preferences(_FakeStore());
      await p.setRelayUrl('https://custom.example.com');
      expect(resolveRelayUrl(p), 'https://custom.example.com');
    });

    test('falls back to kDefaultRelayUrl when override is null', () async {
      final p = Preferences(_FakeStore());
      expect(p.relayUrl, isNull);
      expect(resolveRelayUrl(p), kDefaultRelayUrl);
    });

    test('kDefaultRelayUrl is https://', () {
      expect(kDefaultRelayUrl, startsWith('https://'));
    });
  });

  /*
   * The relay is a property of the PAIRING (the user's question: "is this
   * middleman the first machine or the second?"). The app-wide default is only
   * a fallback, so a record carrying its own address is never redirected to the
   * shared one.
   */
  group('relay_config — relayUrlForPeer', () {
    PeerRecord peerWith(String relay) => PeerRecord(
      remoteEpk: 'epk-1',
      sessionName: 'Pi',
      relayUrl: relay,
      pairedAt: '2026-01-01T00:00:00Z',
    );

    test('uses the address recorded on the pairing', () async {
      final p = Preferences(_FakeStore());
      await p.setRelayUrl('https://app-default.example.com');
      expect(
        relayUrlForPeer(peerWith('https://its-own.example.com'), p),
        'https://its-own.example.com',
      );
    });

    test('two pairings do not share a relay', () async {
      final p = Preferences(_FakeStore());
      await p.setRelayUrl('https://app-default.example.com');
      expect(relayUrlForPeer(peerWith('https://one.example.com'), p),
          'https://one.example.com');
      expect(relayUrlForPeer(peerWith('https://two.example.com'), p),
          'https://two.example.com');
    });

    test('falls back to the default only when the record has none', () async {
      final p = Preferences(_FakeStore());
      expect(relayUrlForPeer(peerWith(''), p), kDefaultRelayUrl);
      await p.setRelayUrl('https://app-default.example.com');
      expect(relayUrlForPeer(peerWith('   '), p),
          'https://app-default.example.com');
    });
  });
}
