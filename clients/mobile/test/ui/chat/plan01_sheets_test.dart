// Plan 01 — the two new chat sheets (session tree picker, runtime status) and
// the transcript paging plumbing behind them.
//
// These exercise the parts that are easy to get wrong and invisible to a pure
// protocol test: which action a tap dispatches, that the double fence is built
// from the rendered snapshot, and that a second `session_sync` page MERGES in
// front of the window instead of replacing it.

import 'dart:async';
import 'dart:io';

import 'package:app/data/local/boxes.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/repositories/session_read_repository.dart';
import 'package:app/data/sync/sync_service.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:app/ui/chat/widgets/runtime_status_sheet.dart';
import 'package:app/ui/chat/widgets/session_tree_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive/hive.dart';
import 'package:provider/provider.dart';

class _FakeChannel implements IChannel, IControlLink {
  final _ctrl = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();
  final List<ClientMessage> sent = [];
  @override
  Stream<ServerMessage> get serverMessages => _ctrl.stream;
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> send(ClientMessage msg) async => sent.add(msg);
  @override
  Future<void> close() async {
    await _ctrl.close();
    await _control.close();
  }

  void push(ServerMessage m) => _ctrl.add(m);
}

class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _s = {};
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _s[key];
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
      _s.remove(key);
    } else {
      _s[key] = value;
    }
  }

  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

const _peer = PeerRecord(
  remoteEpk: 'epk_plan01',
  sessionName: 'Pi',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _FakeStorage extends PairingStorage {
  @override
  Future<List<PeerRecord>> listPeers() async => const [_peer];
  @override
  Future<PeerRecord?> loadPeer(String epk) async =>
      epk == _peer.remoteEpk ? _peer : null;
  @override
  Future<void> savePeer(PeerRecord r) async {}
  final Map<String, List<PersistedRoom>> _rooms = {};
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async =>
      _rooms[epk] = rooms;
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async =>
      _rooms[epk] ?? const [];
  @override
  Future<void> deleteRooms(String epk) async => _rooms.remove(epk);
}

late Directory _dir;

/// Builds a live ChatViewModel over a fake channel, paired to `_peer`.
///
/// Async on purpose for the plain `test()` cases (real clock). Widget tests use
/// [_bootSync] + pumping instead: inside `testWidgets` the clock is fake, so an
/// awaited `Future.delayed` would deadlock.
Future<(ChatViewModel, _FakeChannel, SyncService)> _boot() async {
  final built = _bootSync();
  await Future<void>.delayed(const Duration(milliseconds: 120));
  addTearDown(built.$4.dispose);
  return (built.$1, built.$2, built.$3);
}

/// Constructs the pieces and kicks off bootstrap without awaiting it.
(ChatViewModel, _FakeChannel, SyncService, ConnectionManager) _bootSync() {
  final ch = _FakeChannel();
  final storage = _FakeStorage();
  final conn = ConnectionManager(factory: (_, _) async => ch, storage: storage);
  final boxes = LocalBoxes();
  final sync = SyncService(conn, boxes);
  final read = SessionReadRepository(boxes);
  final prefs = Preferences(_FakeSecureStorage());
  // `_compose` only carries the tree/runtime fields in ChatReady, which needs a
  // selected peer. setSelectedPeerEpk caches the value synchronously, so the
  // first compose already sees it despite the returned future being ignored.
  unawaited(prefs.setSelectedPeerEpk(_peer.remoteEpk));
  unawaited(prefs.setSelectedRoom(epk: _peer.remoteEpk, roomId: 'main'));
  conn.adopt(ch, _peer);
  final vm = ChatViewModel(read, sync, conn, prefs, storage);
  return (vm, ch, sync, conn);
}

/// Pumps until the ViewModel's bootstrap settles AND any modal route has
/// finished animating in (fake clock friendly).
///
/// The route transition matters: mid-animation the sheet's ListView has almost
/// no height, so its lazily-built rows do not exist yet and finders miss them.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

/// Unmounts the tree and disposes the transport graph so no timer outlives the
/// test (the framework asserts on pending timers).
Future<void> _teardown(
  WidgetTester tester,
  ChatViewModel vm,
  SyncService sync,
  ConnectionManager conn,
) async {
  await tester.pumpWidget(const SizedBox());
  vm.dispose();
  sync.dispose();
  conn.dispose();
}

/// Wraps a button that opens [show] in the providers the sheets read.
Widget _host(ChatViewModel vm, Future<void> Function(BuildContext) show) {
  return MaterialApp(
    home: ChangeNotifierProvider<ChatViewModel>.value(
      value: vm,
      child: Builder(
        builder: (ctx) => Scaffold(
          body: ElevatedButton(
            onPressed: () => show(ctx),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

TreeSnapshot _snapshot() => TreeSnapshot.fromJson({
  'snapshot_version': 'treev_a',
  'branch_version': 'branchv_b',
  'leaf_id': 'a2',
  'entries': [
    {
      'id': 'u1',
      'parent_id': null,
      'type': 'message',
      'role': 'user',
      'title': 'user',
      'preview': 'explique o reducer',
      'timestamp': '2026-09-29T10:00:00.000Z',
      'is_current_leaf': false,
      'is_on_active_branch': true,
      'is_forkable': true,
      'navigation_behavior': 'edit_prompt',
    },
    {
      'id': 'a2',
      'parent_id': 'u1',
      'type': 'message',
      'role': 'assistant',
      'title': 'assistant',
      'preview': 'O reducer aplica…',
      'timestamp': '2026-09-29T10:00:20.000Z',
      'is_current_leaf': true,
      'is_on_active_branch': true,
      'is_forkable': false,
      'navigation_behavior': 'navigate',
    },
  ],
  'default_filter': 'default',
  'filters': ['default', 'user', 'assistant', 'tools'],
});

void main() {
  setUpAll(() async {
    _dir = Directory.systemTemp.createTempSync('rp_plan01_');
    await LocalBoxes.initForTest(_dir.path);
  });
  tearDownAll(() async {
    await Hive.close();
    await _dir.delete(recursive: true);
  });

  group('session tree sheet', () {
    testWidgets('requests a snapshot on open and renders the entries', (
      tester,
    ) async {
      final (vm, ch, sync, conn) = _bootSync();
      await tester.pumpWidget(_host(vm, (ctx) => showSessionTreeSheet(ctx, vm: vm)));
      await _settle(tester);

      await tester.tap(find.text('open'));
      await _settle(tester);

      // Opening asks the Pi for the tree.
      expect(ch.sent.whereType<TreeGet>(), isNotEmpty);

      ch.push(TreeSnapshotOk(inReplyTo: 'r1', snapshot: _snapshot()));
      await _settle(tester);

      expect(find.text('Session tree'), findsOneWidget);
      expect(find.text('explique o reducer'), findsOneWidget);
      expect(find.text('O reducer aplica…'), findsOneWidget);
      await _teardown(tester, vm, sync, conn);
    });

    testWidgets('tapping a forkable entry forks with the double fence', (
      tester,
    ) async {
      final (vm, ch, sync, conn) = _bootSync();
      await tester.pumpWidget(_host(vm, (ctx) => showSessionTreeSheet(ctx, vm: vm)));
      await _settle(tester);
      await tester.tap(find.text('open'));
      await _settle(tester);
      ch.push(TreeSnapshotOk(inReplyTo: 'r1', snapshot: _snapshot()));
      await _settle(tester);

      ch.sent.clear();
      await tester.tap(find.text('explique o reducer'));
      await _settle(tester);

      final forks = ch.sent.whereType<SessionFork>().toList();
      expect(forks, hasLength(1));
      expect(forks.single.targetEntryId, 'u1');
      // The fence must come from the snapshot the user was looking at.
      expect(forks.single.fence.snapshotVersion, 'treev_a');
      expect(forks.single.fence.branchVersion, 'branchv_b');
      expect(forks.single.fence.leafId, 'a2');
      await _teardown(tester, vm, sync, conn);
    });

    testWidgets('tapping a non-forkable entry navigates instead', (
      tester,
    ) async {
      final (vm, ch, sync, conn) = _bootSync();
      await tester.pumpWidget(_host(vm, (ctx) => showSessionTreeSheet(ctx, vm: vm)));
      await _settle(tester);
      await tester.tap(find.text('open'));
      await _settle(tester);
      ch.push(TreeSnapshotOk(inReplyTo: 'r1', snapshot: _snapshot()));
      await _settle(tester);

      ch.sent.clear();
      await tester.tap(find.text('O reducer aplica…'));
      await _settle(tester);

      final navs = ch.sent.whereType<TreeNavigate>().toList();
      expect(navs, hasLength(1));
      expect(navs.single.targetEntryId, 'a2');
      expect(navs.single.summarize, isFalse);
      expect(ch.sent.whereType<SessionFork>(), isEmpty);
      await _teardown(tester, vm, sync, conn);
    });

    testWidgets('a tree_state_changed error is explained to the user', (
      tester,
    ) async {
      final (vm, ch, sync, conn) = _bootSync();
      await tester.pumpWidget(_host(vm, (ctx) => showSessionTreeSheet(ctx, vm: vm)));
      await _settle(tester);
      await tester.tap(find.text('open'));
      await _settle(tester);

      ch.push(
        ActionError(
          inReplyTo: 'r1',
          action: ActionName.treeGet,
          rawAction: 'tree_get',
          error: 'tree_state_changed',
        ),
      );
      await _settle(tester);

      expect(
        find.text('The tree changed — refresh and try again.'),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsOneWidget);
      await _teardown(tester, vm, sync, conn);
    });
  });

  group('runtime status sheet', () {
    testWidgets('renders model, thinking, cost and context', (tester) async {
      final (vm, ch, sync, conn) = _bootSync();
      await tester.pumpWidget(_host(vm, (ctx) => showRuntimeStatusSheet(ctx, vm: vm)));
      await _settle(tester);

      ch.push(
        RuntimeStatusMessage(
          RuntimeStatus.fromJson({
            'model': {
              'provider': 'anthropic',
              'id': 'claude-sonnet-4-6',
              'name': 'Claude Sonnet 4.6',
              'context_window': 200000,
              'reasoning': true,
            },
            'thinking_level': 'high',
            'usage': {
              'input': 18500,
              'output': 2400,
              'cache_read': 12000,
              'cache_write': 800,
              'cost': {
                'input': 0.0555,
                'output': 0.036,
                'cache_read': 0.0036,
                'cache_write': 0.003,
                'total': 0.0981,
              },
            },
            'context': {
              'tokens': 19800,
              'context_window': 200000,
              'percent': 9.9,
            },
          }),
        ),
      );
      await _settle(tester);

      await tester.tap(find.text('open'));
      await _settle(tester);

      expect(find.text('MODEL'), findsOneWidget);
      expect(find.text('Claude Sonnet 4.6'), findsOneWidget);
      expect(find.text('reasoning'), findsOneWidget);
      expect(find.text('high'), findsOneWidget);
      expect(find.text('18,500'), findsOneWidget);
      expect(find.text('\$0.0981'), findsOneWidget);
      expect(find.text('19800 / 200000 tokens (9.9%)'), findsOneWidget);
      await _teardown(tester, vm, sync, conn);
    });

    testWidgets('a status with no context reports the gap instead of crashing', (
      tester,
    ) async {
      final (vm, ch, sync, conn) = _bootSync();
      await tester.pumpWidget(_host(vm, (ctx) => showRuntimeStatusSheet(ctx, vm: vm)));
      await _settle(tester);

      ch.push(
        RuntimeStatusMessage(
          RuntimeStatus.fromJson({
            'model': null,
            'thinking_level': null,
            'usage': <String, dynamic>{},
            'context': null,
          }),
        ),
      );
      await _settle(tester);

      await tester.tap(find.text('open'));
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('unknown'), findsOneWidget);
      expect(find.text('not reported yet'), findsOneWidget);
      await _teardown(tester, vm, sync, conn);
    });
  });

  group('transcript paging', () {
    test('requestOlderPage is a no-op until the Pi advertises a cursor', () async {
      final (_, ch, sync) = await _boot();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      ch.sent.clear();

      sync.requestOlderPage();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(ch.sent.whereType<SessionSync>(), isEmpty);

      // A history reply that advertises paging enables it.
      ch.push(
        SessionHistory(
          inReplyTo: 'r1',
          sessionStartedAt: 1,
          events: const [],
          eos: true,
          olderCursor: 'CURSOR1',
          hasOlder: true,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 40));

      sync.requestOlderPage();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final reqs = ch.sent.whereType<SessionSync>().toList();
      expect(reqs, hasLength(1));
      expect(reqs.single.before, 'CURSOR1');
    });

    test('a second paging request is suppressed while one is in flight', () async {
      final (_, ch, sync) = await _boot();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      ch.push(
        SessionHistory(
          inReplyTo: 'r1',
          sessionStartedAt: 1,
          events: const [],
          eos: true,
          olderCursor: 'CURSOR1',
          hasOlder: true,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 40));
      ch.sent.clear();

      sync.requestOlderPage();
      sync.requestOlderPage();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(ch.sent.whereType<SessionSync>(), hasLength(1));
    });

    test('exhausting older pages stops further requests', () async {
      final (_, ch, sync) = await _boot();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      ch.push(
        SessionHistory(
          inReplyTo: 'r1',
          sessionStartedAt: 1,
          events: const [],
          eos: true,
          hasOlder: false,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 40));
      ch.sent.clear();

      sync.requestOlderPage();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(ch.sent.whereType<SessionSync>(), isEmpty);
    });
  });
}
