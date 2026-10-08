// Tests for PairingViewModel: paste → pair_request → paired.
// Uses in-memory transport so no real WS is needed.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:app/pairing/owner_identity_bridge.dart';
import 'package:app/pairing/pair_payload.dart';
import 'package:app/pairing/pair_request_flow.dart' show PeerTransport;
import 'package:app/pairing/storage.dart';
import 'package:app/ui/pairing/states/pairing_state.dart';
import 'package:app/ui/pairing/viewmodels/pairing_viewmodel.dart';
import 'package:app/ui/pairing/widgets/paste_pairing_sheet.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:remote_pi_identity/remote_pi_identity.dart';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

class _Q {
  final _buf = <Uint8List>[];
  final _wait = <Completer<Uint8List>>[];
  void add(Uint8List d) {
    if (_wait.isNotEmpty) {
      _wait.removeAt(0).complete(d);
    } else {
      _buf.add(d);
    }
  }

  Future<Uint8List> next() {
    if (_buf.isNotEmpty) return Future.value(_buf.removeAt(0));
    final c = Completer<Uint8List>();
    _wait.add(c);
    return c.future;
  }
}

class _MemTransport implements PeerTransport {
  final _Q _s;
  final _Q _r;
  _MemTransport({required _Q send, required _Q recv}) : _s = send, _r = recv;
  @override
  Future<void> send(Uint8List d) async => _s.add(d);
  @override
  Future<Uint8List> receive() => _r.next();
  @override
  Future<void> close() async {}
}

/// In-memory fake of FlutterSecureStorage so Preferences can be
/// constructed in tests without touching the platform channel.
class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _store = {};
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _store[key];
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
      _store.remove(key);
    } else {
      _store[key] = value;
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
  }) async {
    _store.remove(key);
  }

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Synchronous Preferences subclass for tests. Pre-set relay URL to
/// `ws://localhost` so it matches `_qrUri` (which embeds the legacy
/// `r=ws://localhost`). The field is mutable so tests can observe the
/// relay-adoption path (`setRelayUrl` writes are reflected by [relayUrl]).
class _PrefsForTest extends Preferences {
  String? _relay;
  _PrefsForTest({String? relay = 'ws://localhost'})
    : _relay = relay,
      super(_FakeSecureStorage());
  @override
  String? get relayUrl => _relay;
  @override
  Future<void> setRelayUrl(String? value) async {
    _relay = (value != null && value.isNotEmpty) ? value : null;
  }
}

class _FakeStorage extends PairingStorage {
  final List<PeerRecord> _saved = [];

  @override
  Future<List<PeerRecord>> listPeers() async => _saved;

  @override
  Future<void> savePeer(PeerRecord r) async => _saved.add(r);
}

/// Helper: build a fully-booted [OwnerIdentityBridge] backed by an
/// in-memory plugin store, seeded with a freshly-generated identity.
/// Mirrors what `dependencies.dart` + the router's _BootState do before
/// PairingViewModel runs in production.
Future<OwnerIdentityBridge> _bootedBridge(PairingStorage storage) async {
  final store = InMemoryOwnerIdentityStore();
  final bridge = OwnerIdentityBridge(store, storage);
  await bridge.boot();
  return bridge;
}

const _qrUri =
    'remotepi://pair?t=AAAAAAAAAAAAAAAAAAAAAA&'
    'epk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&'
    'r=ws%3A%2F%2Flocalhost&n=test+session';

/// Same payload WITHOUT the legacy `r=` relay field — the canonical shape
/// produced since plan/14. Needed to exercise paths that must NOT trip the
/// relay-mismatch guard.
const _qrUriNoRelay =
    'remotepi://pair?t=AAAAAAAAAAAAAAAAAAAAAA&'
    'epk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&'
    'n=test+session';

/// A pairing transport factory that runs a fake "Pi" responder which replies
/// with the given inner message to whatever `pair_request` it receives.
/// Records the relay URL the ViewModel dialled (plan/69 W1: the factory
/// receives the EFFECTIVE relay, not the Preferences default).
class _RecordingFactory {
  final Map<String, dynamic> reply;
  String? dialledRelay;
  _RecordingFactory(this.reply);

  Future<PeerTransport> call(
    PairPayload qr,
    String relayUrl,
    SimpleKeyPair deviceEd25519,
  ) async {
    dialledRelay = relayUrl;
    final q1 = _Q();
    final q2 = _Q();
    final iTrans = _MemTransport(send: q1, recv: q2);
    final rTrans = _MemTransport(send: q2, recv: q1);

    // Responder runs in background — copies in_reply_to from the request.
    unawaited(() async {
      final raw = await rTrans.receive();
      final req = jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
      final resp = Map<String, dynamic>.from(reply);
      resp['in_reply_to'] = req['id'];
      await rTrans.send(Uint8List.fromList(utf8.encode(jsonEncode(resp))));
    }());

    return iTrans;
  }
}

// ---------------------------------------------------------------------------
// Spy ConnectionManager — records adopt/disconnect (plan/31: PairingViewModel
// now drives the ConnectionManager directly). Overrides skip super so no
// ping/connect timers are started.
// ---------------------------------------------------------------------------

class _SpyConn extends ConnectionManager {
  _SpyConn()
    : super(
        factory: (_, _) async => throw UnimplementedError(),
        storage: _FakeStorage(),
      );

  IChannel? adoptedChannel;
  PeerRecord? adoptedPeer;
  int disconnectCalls = 0;

  @override
  void adopt(IChannel channel, PeerRecord peer) {
    adoptedChannel = channel;
    adoptedPeer = peer;
  }

  @override
  Future<void> disconnect() async => disconnectCalls++;
}

// ---------------------------------------------------------------------------
// Unit tests — PairingViewModel
// ---------------------------------------------------------------------------

void main() {
  group('PairingViewModel', () {
    test('initial state is PairingScanning', () async {
      final storage = _FakeStorage();
      final bridge = await _bootedBridge(storage);
      final vm = PairingViewModel(
        storage,
        (qr, relay, key) async => throw Exception('should not be called'),
        _SpyConn(),
        _PrefsForTest(),
        bridge,
      );
      expect(vm.state, isA<PairingScanning>());
      vm.dispose();
    });

    test(
      'invalid code → typed invalidPayload error, form stays up',
      () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final vm = PairingViewModel(
          storage,
          (qr, relay, key) async => throw Exception('should not be called'),
          _SpyConn(),
          _PrefsForTest(),
          bridge,
        );
        await vm.submitPairingCode('https://example.com/not-a-code');

        expect(vm.state, isA<PairingScanning>());
        expect(vm.validationError, isNotNull);
        expect(
          vm.validationError!.code,
          PairingValidationCode.invalidPayload,
        );
        expect(vm.validationError!.wireCode, 'invalid_payload');
        vm.dispose();
      },
    );

    test('scan → connecting → paired (channel adopted)', () async {
      final storage = _FakeStorage();
      final fakeRepo = _SpyConn();
      final bridge = await _bootedBridge(storage);
      final factory = _RecordingFactory({
        'type': 'pair_ok',
        'session_name': 'test session',
      });
      final vm = PairingViewModel(
        storage,
        factory.call,
        fakeRepo,
        _PrefsForTest(),
        bridge,
      );

      final fut = vm.submitPairingCode(_qrUri);
      expect(vm.state, isA<PairingConnecting>());

      await fut;
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(vm.state, isA<PairingPaired>());
      expect(storage._saved, hasLength(1));
      expect(storage._saved.first.sessionName, 'test session');
      expect(fakeRepo.adoptedChannel, isNotNull);
      expect(fakeRepo.adoptedPeer?.remoteEpk, isNotEmpty);
      expect(fakeRepo.disconnectCalls, 1);

      vm.dispose();
    });

    test('pair_error → PairingError(canRetry: true)', () async {
      final storage = _FakeStorage();
      final bridge = await _bootedBridge(storage);
      final factory = _RecordingFactory({
        'type': 'pair_error',
        'code': 'token_expired',
        'message': 'Token expired',
      });
      final vm = PairingViewModel(
        storage,
        factory.call,
        _SpyConn(),
        _PrefsForTest(),
        bridge,
      );

      await vm.submitPairingCode(_qrUri);
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(vm.state, isA<PairingError>());
      final err = vm.state as PairingError;
      expect(err.canRetry, isTrue);
      expect(err.message, contains('Code expired'));
      expect(storage._saved, isEmpty);

      vm.dispose();
    });

    test(
      'transport failure → PairingError + retry returns to scanning',
      () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final vm = PairingViewModel(
          storage,
          (qr, relay, key) async => throw Exception('socket exception'),
          _SpyConn(),
          _PrefsForTest(),
          bridge,
        );

        await vm.submitPairingCode(_qrUri);
        expect(vm.state, isA<PairingError>());
        expect((vm.state as PairingError).canRetry, isTrue);

        vm.retry();
        expect(vm.state, isA<PairingScanning>());

        vm.dispose();
      },
    );

    // -------------------------------------------------------------------------
    // Regression — the timeout message must name the relay actually dialled.
    //
    // Since plan/14 the code carries no relay, so an App/host relay mismatch
    // has EXACTLY one symptom: this timeout. Without the address the message
    // reads as "the host is down" and the real cause stays invisible.
    // -------------------------------------------------------------------------

    test(
      'pair_timeout names the relay currently configured in Preferences',
      () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        // A silent transport: the fake "Pi" never replies → timeout.
        Future<PeerTransport> neverReplies(qr, relay, key) async {
          final q1 = _Q();
          return _MemTransport(send: q1, recv: _Q());
        }
        final vm = PairingViewModel(
          storage,
          neverReplies,
          _SpyConn(),
          _PrefsForTest(relay: 'https://relay.880160.xyz'),
          bridge,
          pairTimeout: const Duration(milliseconds: 50),
        );

        // No `r=` in the code → the mismatch guard can't fire; the failure is
        // a real timeout, exactly like an App/host relay mismatch in
        // production.
        await vm.submitPairingCode(_qrUriNoRelay);

        expect(vm.state, isA<PairingError>());
        final msg = (vm.state as PairingError).message;
        expect(msg, contains('relay.880160.xyz'),
            reason: 'the timeout must expose the relay it dialled');
        expect(msg, contains('same relay'),
            reason: 'and hint at the mismatch as a cause');

        vm.dispose();
      },
    );

    test(
      'code relay is ADOPTED into Preferences before dialling',
      () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        // Reply with pair_ok so the flow completes; we assert on the relay
        // that was persisted, not on the outcome.
        final factory = _RecordingFactory({
          'type': 'pair_ok',
          'session_name': 'test session',
        });
        final prefs = _PrefsForTest(relay: 'https://app-relay.example');
        final vm = PairingViewModel(
          storage,
          factory.call,
          _SpyConn(),
          prefs,
          bridge,
        );

        await vm.submitPairingCode(_qrUri); // code carries r=ws://localhost
        await Future<void>.delayed(const Duration(milliseconds: 30));

        // ws://localhost is a legacy scheme the app rejects for storage, so it
        // must NOT be adopted — the preference stays intact.
        expect(prefs.relayUrl, 'https://app-relay.example');
        // ...but it IS the relay this attempt dialled.
        expect(factory.dialledRelay, 'ws://localhost');
        vm.dispose();
      },
    );

    test(
      'a valid code relay is adopted (self-host works with zero config)',
      () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final factory = _RecordingFactory({
          'type': 'pair_ok',
          'session_name': 'test session',
        });
        // Preferences on the app's default; the code names the self-hosted
        // relay.
        final prefs = _PrefsForTest(relay: 'https://relay-rp1.jacobmoura.work');
        final vm = PairingViewModel(
          storage,
          factory.call,
          _SpyConn(),
          prefs,
          bridge,
        );

        const codeRelay = 'remotepi://pair?t=AAAAAAAAAAAAAAAAAAAAAA&'
            'epk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&'
            'r=https%3A%2F%2Frelay.880160.xyz&n=self+hosted';
        await vm.submitPairingCode(codeRelay);
        await Future<void>.delayed(const Duration(milliseconds: 30));

        expect(prefs.relayUrl, 'https://relay.880160.xyz',
            reason: 'the code relay must be adopted before dialling');
        expect(factory.dialledRelay, 'https://relay.880160.xyz');
        vm.dispose();
      },
    );

    // -------------------------------------------------------------------------
    // Plan/69 W1 — address + code form
    // -------------------------------------------------------------------------

    group('address + code form (plan/69 W1)', () {
      test('address auto-fills from the code r= param', () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final vm = PairingViewModel(
          storage,
          (qr, relay, key) async => throw Exception('should not be called'),
          _SpyConn(),
          _PrefsForTest(relay: null),
          bridge,
        );

        expect(vm.address, isEmpty);
        vm.onCodeChanged(_qrUri);
        expect(vm.address, 'ws://localhost',
            reason: 'r= auto-fills the address field');
        expect(vm.defaultRelayUrl, 'https://relay-rp1.jacobmoura.work');
        vm.dispose();
      });

      test('a manual address edit survives later code edits', () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final vm = PairingViewModel(
          storage,
          (qr, relay, key) async => throw Exception('should not be called'),
          _SpyConn(),
          _PrefsForTest(relay: null),
          bridge,
        );

        vm.onCodeChanged(_qrUri);
        expect(vm.address, 'ws://localhost');
        vm.onAddressChanged('https://my-relay.example');
        // Typing more into the code field must NOT clobber the manual edit.
        vm.onCodeChanged('$_qrUri&x=1');
        expect(vm.address, 'https://my-relay.example');
        vm.dispose();
      });

      test(
        'empty address dials the Preferences default relay',
        () async {
          final storage = _FakeStorage();
          final bridge = await _bootedBridge(storage);
          final factory = _RecordingFactory({
            'type': 'pair_ok',
            'session_name': 'test session',
          });
          final vm = PairingViewModel(
            storage,
            factory.call,
            _SpyConn(),
            _PrefsForTest(relay: 'https://relay.880160.xyz'),
            bridge,
          );

          await vm.submitPairingCode(_qrUriNoRelay);
          await Future<void>.delayed(const Duration(milliseconds: 30));

          expect(vm.effectiveRelayUrl, 'https://relay.880160.xyz');
          expect(factory.dialledRelay, 'https://relay.880160.xyz',
              reason: 'empty address = default relay from Preferences');
          vm.dispose();
        },
      );

      test(
        'edited address away from the code r= → typed relay_mismatch',
        () async {
          final storage = _FakeStorage();
          final bridge = await _bootedBridge(storage);
          final vm = PairingViewModel(
            storage,
            (qr, relay, key) async => throw Exception('should not be called'),
            _SpyConn(),
            _PrefsForTest(relay: null),
            bridge,
          );

          vm.onCodeChanged(_qrUri); // auto-fills ws://localhost
          vm.onAddressChanged('https://other-relay.example');
          await vm.submitPairing();

          expect(vm.state, isA<PairingScanning>(),
              reason: 'validation failures keep the form on screen');
          expect(vm.validationError, isNotNull);
          expect(
            vm.validationError!.code,
            PairingValidationCode.relayMismatch,
          );
          expect(vm.validationError!.wireCode, 'relay_mismatch',
              reason: 'plan/68 relay_mismatch contract preserved');
          expect(vm.validationError!.message, contains('ws://localhost'));
          expect(vm.validationError!.message,
              contains('https://other-relay.example'));
          vm.dispose();
        },
      );

      test(
        'cleared address with a code that names another relay → '
        'typed relay_mismatch',
        () async {
          final storage = _FakeStorage();
          final bridge = await _bootedBridge(storage);
          final vm = PairingViewModel(
            storage,
            (qr, relay, key) async => throw Exception('should not be called'),
            _SpyConn(),
            _PrefsForTest(relay: 'https://app-relay.example'),
            bridge,
          );

          vm.onCodeChanged(_qrUri); // auto-fills ws://localhost
          vm.onAddressChanged(''); // user cleared it → default relay
          await vm.submitPairing();

          expect(vm.validationError?.code,
              PairingValidationCode.relayMismatch);
          vm.dispose();
        },
      );

      test(
        'code without r= + garbage address → typed invalidRelay',
        () async {
          final storage = _FakeStorage();
          final bridge = await _bootedBridge(storage);
          final vm = PairingViewModel(
            storage,
            (qr, relay, key) async => throw Exception('should not be called'),
            _SpyConn(),
            _PrefsForTest(relay: null),
            bridge,
          );

          vm.onCodeChanged(_qrUriNoRelay);
          vm.onAddressChanged('not-a-url');
          await vm.submitPairing();

          expect(vm.validationError?.code, PairingValidationCode.invalidRelay);
          expect(vm.validationError!.message, isNotEmpty);
          vm.dispose();
        },
      );

      test(
        'code without r= + typed valid address dials that address',
        () async {
          final storage = _FakeStorage();
          final bridge = await _bootedBridge(storage);
          final factory = _RecordingFactory({
            'type': 'pair_ok',
            'session_name': 'test session',
          });
          final vm = PairingViewModel(
            storage,
            factory.call,
            _SpyConn(),
            _PrefsForTest(relay: 'https://relay-rp1.jacobmoura.work'),
            bridge,
          );

          vm.onCodeChanged(_qrUriNoRelay);
          vm.onAddressChanged('https://relay.880160.xyz');
          await vm.submitPairing();
          await Future<void>.delayed(const Duration(milliseconds: 30));

          expect(factory.dialledRelay, 'https://relay.880160.xyz');
          vm.dispose();
        },
      );

      test('editing a field clears the stale validation error', () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final vm = PairingViewModel(
          storage,
          (qr, relay, key) async => throw Exception('should not be called'),
          _SpyConn(),
          _PrefsForTest(relay: null),
          bridge,
        );

        await vm.submitPairingCode('https://example.com/not-a-code');
        expect(vm.validationError, isNotNull);
        vm.onCodeChanged(_qrUriNoRelay);
        expect(vm.validationError, isNull);
        vm.dispose();
      });

      test('retry keeps the typed values and clears the error', () async {
        final storage = _FakeStorage();
        final bridge = await _bootedBridge(storage);
        final vm = PairingViewModel(
          storage,
          (qr, relay, key) async => throw Exception('should not be called'),
          _SpyConn(),
          _PrefsForTest(relay: null),
          bridge,
        );

        await vm.submitPairingCode('https://example.com/not-a-code');
        vm.onCodeChanged(_qrUri);
        expect(vm.address, 'ws://localhost');
        vm.retry();
        expect(vm.state, isA<PairingScanning>());
        expect(vm.validationError, isNull);
        expect(vm.code, _qrUri, reason: 'values survive a retry');
        expect(vm.address, 'ws://localhost');
        vm.dispose();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Widget harness test — page reacts to ViewModel state changes
  // -------------------------------------------------------------------------

  group('PairingPage widget', () {
    testWidgets('navigates via PairingPaired after pair_ok', (tester) async {
      final storage = _FakeStorage();
      final bridge = await _bootedBridge(storage);
      final factory = _RecordingFactory({
        'type': 'pair_ok',
        'session_name': 'test session',
      });
      final conn = _SpyConn();
      final vm = PairingViewModel(
        storage,
        factory.call,
        conn,
        _PrefsForTest(),
        bridge,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: ChangeNotifierProvider.value(
            value: vm,
            child: _PairingPageTestHarness(vm: vm),
          ),
        ),
      );

      await tester.runAsync(() async {
        await vm.submitPairingCode(_qrUri);
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();

      expect(vm.state, isA<PairingPaired>());
      expect(find.text('Done'), findsOneWidget);

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });

    testWidgets('shows error view on pair_error', (tester) async {
      final factory = _RecordingFactory({
        'type': 'pair_error',
        'code': 'token_consumed',
        'message': 'Already used',
      });
      final storage = _FakeStorage();
      final bridge = await _bootedBridge(storage);
      final conn = _SpyConn();
      final vm = PairingViewModel(
        storage,
        factory.call,
        conn,
        _PrefsForTest(),
        bridge,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: ChangeNotifierProvider.value(
            value: vm,
            child: _PairingPageTestHarness(vm: vm),
          ),
        ),
      );

      await tester.runAsync(() async {
        await vm.submitPairingCode(_qrUri);
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();

      expect(vm.state, isA<PairingError>());
      expect(find.text('Try again'), findsOneWidget);

      await tester.tap(find.text('Try again'));
      await tester.pump();
      expect(vm.state, isA<PairingScanning>());

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });
  });

  // -------------------------------------------------------------------------
  // Paste sheet widget tests — plan/69 W1 address + code form
  // -------------------------------------------------------------------------

  group('paste pairing sheet (plan/69 W1)', () {
    Future<({PairingViewModel vm, _SpyConn conn})> pumpSheet(
      WidgetTester tester, {
      String relay = 'ws://localhost',
    }) async {
      final storage = _FakeStorage();
      final bridge = await _bootedBridge(storage);
      final conn = _SpyConn();
      final vm = PairingViewModel(
        storage,
        (qr, relayUrl, key) async => throw Exception('should not be called'),
        conn,
        _PrefsForTest(relay: relay),
        bridge,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (ctx) => ElevatedButton(
                child: const Text('open'),
                onPressed: () => showPastePairingSheet(ctx, vm: vm),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return (vm: vm, conn: conn);
    }

    testWidgets('renders address + code fields', (tester) async {
      final (:vm, :conn) = await pumpSheet(tester);

      expect(find.byKey(const Key('pairing-sheet-address')), findsOneWidget);
      expect(find.byKey(const Key('pairing-sheet-code')), findsOneWidget);
      expect(find.text('Relay address'), findsOneWidget);
      expect(find.text('Pairing code'), findsOneWidget);
      // Empty address shows the Preferences default as the placeholder.
      expect(find.text('ws://localhost'), findsOneWidget);
      expect(find.text('Leave empty to use the default relay'), findsOneWidget);

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });

    testWidgets('pasting a code auto-fills the address from r=', (tester) async {
      final (:vm, :conn) = await pumpSheet(
        tester,
        relay: 'https://relay-rp1.jacobmoura.work',
      );

      await tester.enterText(
        find.byKey(const Key('pairing-sheet-code')),
        _qrUri,
      );
      await tester.pump();

      expect(vm.address, 'ws://localhost');
      final addressField = tester.widget<TextField>(
        find.byKey(const Key('pairing-sheet-address')),
      );
      expect(addressField.controller?.text, 'ws://localhost');

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });

    testWidgets('invalid code shows the typed error inline', (tester) async {
      final (:vm, :conn) = await pumpSheet(tester);

      await tester.enterText(
        find.byKey(const Key('pairing-sheet-code')),
        'not-a-pairing-code',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('pairing-sheet-submit')));
      await tester.pump();

      expect(vm.validationError?.code, PairingValidationCode.invalidPayload);
      expect(
        find.textContaining('not a Remote Pi pairing code'),
        findsOneWidget,
      );
      expect(vm.state, isA<PairingScanning>());

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });

    testWidgets('relay mismatch shows the typed error inline', (tester) async {
      final (:vm, :conn) = await pumpSheet(
        tester,
        relay: 'https://relay-rp1.jacobmoura.work',
      );

      await tester.enterText(
        find.byKey(const Key('pairing-sheet-code')),
        _qrUri,
      );
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('pairing-sheet-address')),
        'https://other-relay.example',
      );
      await tester.tap(find.byKey(const Key('pairing-sheet-submit')));
      await tester.pump();

      expect(vm.validationError?.code, PairingValidationCode.relayMismatch);
      expect(find.textContaining('issued for relay'), findsOneWidget);

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });

    testWidgets('submit disabled until a code is present', (tester) async {
      final (:vm, :conn) = await pumpSheet(tester);

      final button = tester.widget<FilledButton>(
        find.byKey(const Key('pairing-sheet-submit')),
      );
      expect(button.onPressed, isNull);

      await tester.enterText(
        find.byKey(const Key('pairing-sheet-code')),
        _qrUri,
      );
      await tester.pump();

      final enabled = tester.widget<FilledButton>(
        find.byKey(const Key('pairing-sheet-submit')),
      );
      expect(enabled.onPressed, isNotNull);

      vm.dispose();
      conn.dispose(); // cancel the watchdog before the timer-pending check
    });
  });
}

// ---------------------------------------------------------------------------
// Minimal widget harness that renders PairingState without MobileScanner
// ---------------------------------------------------------------------------

class _PairingPageTestHarness extends StatelessWidget {
  final PairingViewModel vm;
  const _PairingPageTestHarness({required this.vm});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<PairingViewModel>().state;

    return Scaffold(
      body: switch (state) {
        PairingIdle() => const Text('Idle'),
        PairingScanning() => const Text('Scanning'),
        PairingConnecting() => const Text('Connecting…'),
        PairingPaired() => const Text('Done'),
        PairingError(:final message) => Column(
          children: [
            Text(message),
            ElevatedButton(onPressed: vm.retry, child: const Text('Try again')),
          ],
        ),
      },
    );
  }
}
