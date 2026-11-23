import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hive/hive.dart';
import 'package:mobile/data/local/boxes.dart';
import 'package:mobile/data/local/records/message_record.dart';
import 'package:mobile/data/repositories/session_read_repository.dart';

MessageRecord row(int order, String id) => MessageRecord(
  id: id,
  seq: order,
  role: MsgRole.user,
  text: id,
  ts: DateTime.fromMillisecondsSinceEpoch(1),
);

void main() {
  late Directory dir;
  var count = 0;
  setUpAll(() async {
    dir = Directory.systemTemp.createTempSync('p5_batches');
    await LocalBoxes.initForTest(dir.path);
  });
  tearDownAll(() async {
    await Hive.close();
    await dir.delete(recursive: true);
  });

  test(
    '100 writes publish initial plus one immutable ordered snapshot',
    () async {
      final boxes = LocalBoxes();
      final epk = 'batch${count++}';
      final box = await boxes.msgsBox(epk, 'main');
      final snapshots = <List<MessageRecord>>[];
      final sub = SessionReadRepository(
        boxes,
      ).watchMessages(epk, 'main').listen(snapshots.add);
      await Future<void>.delayed(Duration.zero);
      var events = 0;
      final eventsSub = box.watch().listen((_) => events++);
      await boxes.messageBatchWrite(epk, 'main', () async {
        for (var i = 0; i < 100; i++) {
          await box.put(i, row(99 - i, '$i').toJson());
        }
      }, isCurrent: () => true);
      await Future<void>.delayed(Duration.zero);
      expect(events, 100);
      expect(snapshots.map((r) => r.length), [0, 100]);
      expect(snapshots.last.first.id, '99');
      expect(() => snapshots.last.clear(), throwsUnsupportedError);
      await box.put(0, row(-1, 'changed').toJson());
      await Future<void>.delayed(Duration.zero);
      expect(snapshots.length, 3);
      expect(snapshots[1].first.id, '99');
      await sub.cancel();
      await eventsSub.cancel();
    },
  );

  test(
    'failure and invalid generation withhold partial rows; recovery publishes once',
    () async {
      final boxes = LocalBoxes();
      final epk = 'batch${count++}';
      final box = await boxes.msgsBox(epk, 'main');
      final snapshots = <List<MessageRecord>>[];
      final sub = SessionReadRepository(
        boxes,
      ).watchMessages(epk, 'main').listen(snapshots.add);
      await Future<void>.delayed(Duration.zero);
      await expectLater(
        boxes.messageBatchWrite(epk, 'main', () async {
          await box.put(0, row(0, 'partial').toJson());
          throw StateError('interrupted');
        }, isCurrent: () => true),
        throwsStateError,
      );
      await boxes.messageBatchWrite(epk, 'main', () async {
        await box.put(1, row(1, 'stale').toJson());
      }, isCurrent: () => false);
      await Future<void>.delayed(Duration.zero);
      expect(snapshots.map((r) => r.length), [0]);
      await boxes.messageBatchWrite(epk, 'main', () async {
        await box.clear();
        await box.put(2, row(-2, 'fresh').toJson());
      }, isCurrent: () => true);
      await Future<void>.delayed(Duration.zero);
      expect(snapshots.map((r) => r.length), [0, 1]);
      expect(snapshots.last.single.id, 'fresh');
      await sub.cancel();
    },
  );

  test(
    'cancel during a batch and other room publication stay isolated',
    () async {
      final boxes = LocalBoxes();
      final epk = 'cancel${count++}';
      final box = await boxes.msgsBox(epk, 'main');
      final other = await boxes.msgsBox(epk, 'other');
      final snapshots = <List<MessageRecord>>[];
      final sub = SessionReadRepository(
        boxes,
      ).watchMessages(epk, 'main').listen(snapshots.add);
      final otherSnapshots = <List<MessageRecord>>[];
      final otherSub = SessionReadRepository(
        boxes,
      ).watchMessages(epk, 'other').listen(otherSnapshots.add);
      await Future<void>.delayed(Duration.zero);
      await boxes.messageBatchWrite(epk, 'main', () async {
        await box.put(0, row(0, 'hidden').toJson());
        await other.put(0, row(0, 'other').toJson());
        await sub.cancel();
      }, isCurrent: () => true);
      await Future<void>.delayed(Duration.zero);
      expect(snapshots.map((r) => r.length), [0]);
      expect(otherSnapshots.map((r) => r.length), [0, 1]);
      expect(otherSnapshots.last.single.id, 'other');
      await otherSub.cancel();
    },
  );

  test(
    'schema 2 adoption is byte preserving, replayable and durable on reopen',
    () async {
      final boxes = LocalBoxes();
      final epk = 'migration${count++}';
      var box = await boxes.msgsBox(epk, 'main');
      final legacy = row(17, 'legacy').toJson();
      await box.put(17, legacy);
      var writes = 0;
      final sub = box.watch().listen((_) => writes++);
      await boxes.ensureMessageSchema(epk, 'main');
      await boxes.ensureMessageSchema(epk, 'main');
      expect(writes, 0);
      expect(box.get(17), legacy);
      // Missing marker models interruption before its durable commit.
      final metadata = Hive.box<int>('message_schema');
      await metadata.delete(LocalBoxes.msgsBoxName(epk, 'main'));
      await boxes.ensureMessageSchema(epk, 'main');
      expect(writes, 0);
      await sub.cancel();
      await box.close();
      box = await boxes.msgsBox(epk, 'main');
      expect(box.keys, [17]);
      expect(box.get(17), legacy);
      expect(metadata.get(LocalBoxes.msgsBoxName(epk, 'main')), 2);
      expect(() => box.put(-1, legacy), throwsA(isA<HiveError>()));
    },
  );
}
