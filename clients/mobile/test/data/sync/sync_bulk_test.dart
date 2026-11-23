// Exercises the real reconciler with real Hive behind an instrumented Box.
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hive/hive.dart';
import 'package:mobile/data/local/boxes.dart';
import 'package:mobile/data/local/records/message_record.dart';
import 'package:mobile/data/repositories/session_read_repository.dart';
import 'package:mobile/data/sync/sync_service.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';

class _Channel implements IChannel, IControlLink {
  final input = StreamController<ServerMessage>.broadcast();
  final controls = StreamController<ControlInbound>.broadcast();
  @override
  Stream<ServerMessage> get serverMessages => input.stream;
  @override
  Stream<ControlInbound> get controlFrames => controls.stream;
  @override
  Future<void> send(ClientMessage message) async {}
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> close() async {
    await input.close();
    await controls.close();
  }
}

class _Storage extends PairingStorage {
  @override
  Future<List<PeerRecord>> listPeers() async => [];
  @override
  Future<List<PersistedRoom>> loadRooms(String remoteEpk) async => [];
  @override
  Future<void> saveRooms(String remoteEpk, List<PersistedRoom> rooms) async {}
}

class _Box extends Fake implements Box<dynamic> {
  _Box(this.inner);
  final Box<dynamic> inner;
  final calls = <String>[];
  Future<void> Function()? afterPutAll;
  @override
  Iterable<dynamic> get keys => inner.keys;
  @override
  Iterable<dynamic> get values => inner.values;
  @override
  dynamic get(dynamic key, {dynamic defaultValue}) =>
      inner.get(key, defaultValue: defaultValue);
  @override
  Future<void> flush() => inner.flush();
  @override
  Future<void> deleteAll(Iterable<dynamic> keys) async {
    calls.add('deleteAll:${keys.length}');
    await inner.deleteAll(keys);
  }

  @override
  Future<void> putAll(Map<dynamic, dynamic> entries) async {
    calls.add('putAll:${entries.length}');
    await inner.putAll(entries);
    await afterPutAll?.call();
  }
}

class _Boxes extends LocalBoxes {
  final wrapped = <String, _Box>{};
  @override
  Future<Box<dynamic>> msgsBox(String epk, String roomId) async {
    final box = await super.msgsBox(epk, roomId);
    return wrapped.putIfAbsent(box.name, () => _Box(box));
  }

  _Box probe(String epk) => wrapped[LocalBoxes.msgsBoxName(epk, 'main')]!;
}

Future<void> _until(bool Function() predicate) async {
  final deadline = Stopwatch()..start();
  while (!predicate()) {
    if (deadline.elapsed > const Duration(seconds: 5)) {
      fail('bulk reconciler did not reach its publication boundary');
    }
    await Future<void>.delayed(Duration.zero);
  }
}

SessionHistory _history(String id, List<String> ids) => SessionHistory(
  inReplyTo: id,
  sessionStartedAt: 0,
  eos: true,
  events: [for (final id in ids) UserInputEvt(ts: 1, id: id, text: id)],
);

void main() {
  late Directory dir;
  var serial = 0;
  setUpAll(() async {
    dir = await Directory.systemTemp.createTemp('p87_bulk_');
    await LocalBoxes.initForTest(dir.path);
  });
  tearDownAll(() async {
    await Hive.close();
    await dir.delete(recursive: true);
  });

  Future<
    ({
      SyncService sync,
      _Channel channel,
      _Boxes boxes,
      String epk,
      ConnectionManager conn,
      _Storage storage,
    })
  >
  setup() async {
    final channel = _Channel();
    final storage = _Storage();
    final conn = ConnectionManager(
      factory: (_, _) async => channel,
      storage: storage,
      emitDebounce: Duration.zero,
    );
    final boxes = _Boxes();
    final sync = SyncService(conn, boxes);
    final epk = 'bulk_${serial++}';
    await sync.activate(epk, 'main');
    conn.adopt(
      channel,
      PeerRecord(
        remoteEpk: epk,
        sessionName: 'test',
        relayUrl: 'ws://localhost',
        pairedAt: '2026-01-01T00:00:00Z',
      ),
    );
    await Future<void>.delayed(Duration.zero);
    return (
      sync: sync,
      channel: channel,
      boxes: boxes,
      epk: epk,
      conn: conn,
      storage: storage,
    );
  }

  test(
    'reconcile uses one nonempty bulk call per diff, deletes before puts',
    () async {
      final s = await setup();
      final probe = s.boxes.probe(s.epk);
      var completions = 0;
      final sub = s.boxes
          .messageBatch(s.epk, 'main')
          .completions
          .stream
          .listen((_) => completions++);
      final ids = [for (var i = 0; i < 100; i++) 'u$i'];
      s.channel.input.add(_history('head', ids));
      await _until(() => completions == 1);
      expect(probe.calls, ['putAll:100']);
      final keys = probe.inner.keys.toList();
      expect(keys.every((key) => key is int && key >= 0), isTrue);
      s.channel.input.add(_history('duplicate', ids));
      await _until(() => completions == 2);
      expect(probe.calls, ['putAll:100']);
      s.channel.input.add(_history('replace', ['u1', 'u0', 'new']));
      await _until(() => completions == 3);
      expect(probe.calls, ['putAll:100', 'deleteAll:98', 'putAll:3']);
      expect(probe.inner.keys, [keys[0], keys[1], 100]);
      final rows =
          probe.inner.values
              .map(
                (v) =>
                    MessageRecord.fromJson((v as Map).cast<String, dynamic>()),
              )
              .toList()
            ..sort((a, b) => a.seq.compareTo(b.seq));
      expect(rows.map((r) => r.id), ['u1', 'u0', 'new']);
      await sub.cancel();
      s.sync.dispose();
      s.conn.dispose();
      await s.channel.close();
      s.storage.dispose();
    },
  );

  for (final failure in [true, false]) {
    test(
      'bulk ${failure ? 'exception' : 'invalid generation'} withholds partial snapshot and recovers',
      () async {
        final finished = Completer<void>();
        final errors = <Object>[];
        runZonedGuarded(
          () async {
            final s = await setup();
            final probe = s.boxes.probe(s.epk);
            final snapshots = <List<MessageRecord>>[];
            final read = SessionReadRepository(
              LocalBoxes(),
            ).watchMessages(s.epk, 'main').listen(snapshots.add);
            await _until(() => snapshots.isNotEmpty);
            final entered = Completer<void>();
            final release = Completer<void>();
            probe.afterPutAll = () async {
              entered.complete();
              await release.future;
              if (failure) {
                throw StateError('injected bulk failure after append');
              }
            };
            final results = <bool>[];
            final batches = s.boxes
                .messageBatch(s.epk, 'main')
                .completions
                .stream
                .listen(results.add);
            s.channel.input.add(
              _history('partial', ['partial-a', 'partial-b']),
            );
            await entered.future;
            expect(snapshots.map((s) => s.length), [0]);
            final switched = failure
                ? null
                : s.sync.activate('other_${s.epk}', 'main');
            release.complete();
            await _until(() => results.isNotEmpty);
            await switched;
            if (failure) {
              await _until(() => errors.isNotEmpty);
            }
            expect(results, [false]);
            expect(snapshots.map((s) => s.length), [0]);
            expect(s.boxes.messageBatch(s.epk, 'main').active, isFalse);
            expect(s.boxes.messageBatch(s.epk, 'main').valid, isFalse);
            probe.afterPutAll = null;
            await s.sync.activate(s.epk, 'main');
            s.channel.input.add(_history('recovered', ['fresh']));
            await _until(() => snapshots.length == 2);
            expect(snapshots.last.single.id, 'fresh');
            expect(results, [false, true]);
            expect(probe.calls, ['putAll:2', 'deleteAll:2', 'putAll:1']);
            expect(errors.length, failure ? 1 : 0);
            await read.cancel();
            await batches.cancel();
            s.sync.dispose();
            s.conn.dispose();
            await s.channel.close();
            s.storage.dispose();
            finished.complete();
          },
          (error, _) {
            if (error is StateError &&
                error.message == 'injected bulk failure after append') {
              errors.add(error);
            } else {
              finished.completeError(error);
            }
          },
        );
        await finished.future;
      },
    );
  }
}
