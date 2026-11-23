// Plan 86 #46 — deterministic coverage for the profile probe's fragile paths.
// No device, no Flutter binding, no Hive: pure logic only.
//
// P5 key contract under test: the Hive key is a stable nonnegative PHYSICAL KEY,
// display order is the signed `MessageRecord.seq`. Key comparison must never be
// read as ordering, so none of these cases may infer "older/newer" from a key.

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/domain/history/history_models.dart';

import '../../tool/history_perf/p86_tally.dart';

HistoryMetricSample _sample(int i) => HistoryMetricSample(
  op: 'history_read',
  queueMs: i,
  wireMs: i,
  decodeApplyMs: i,
  cacheHit: false,
  items: i,
);

void main() {
  group('HistoryMetricsTail', () {
    test('ring saturation keeps emitting new samples (>64 pushes)', () {
      final metrics = HistoryMetrics(capacity: 64);
      final tail = HistoryMetricsTail();
      final printed = <HistoryMetricSample>[];

      void drain() {
        final result = tail.drain(metrics.samples);
        expect(result.dropped, isFalse, reason: 'nothing lost yet');
        printed.addAll(result.fresh);
      }

      // 1) below capacity: everything is new.
      for (var i = 0; i < 10; i++) {
        metrics.record(_sample(i));
      }
      drain();
      expect(printed, hasLength(10));

      // 2) ring is now full but the cursor is still inside it: only the tail
      //    after the cursor is new. A length-based cursor would emit nothing
      //    here — the bug this test pins.
      for (var i = 10; i < 70; i++) {
        metrics.record(_sample(i));
      }
      drain();
      expect(printed, hasLength(70));
      expect(metrics.samples, hasLength(64));

      // 3) push past the cursor: it is evicted, everything kept is fresh.
      for (var i = 70; i < 140; i++) {
        metrics.record(_sample(i));
      }
      final result = tail.drain(metrics.samples);
      expect(result.dropped, isTrue, reason: 'cursor evicted ⇒ unknown loss');
      expect(result.fresh, hasLength(64));

      // Nothing was ever emitted twice, and drains are cumulative-only.
      expect(
        {for (final s in [...printed, ...result.fresh]) s}.length,
        printed.length + result.fresh.length,
        reason: 'each sample printed at most once',
      );
      final after = tail.drain(metrics.samples);
      expect(after.fresh, isEmpty);
      expect(after.dropped, isFalse);
    });

    test('empty ring and repeated drains are inert', () {
      final tail = HistoryMetricsTail();
      expect(tail.drain(const []).fresh, isEmpty);
      expect(tail.drain(const []).dropped, isFalse);

      final metrics = HistoryMetrics(capacity: 4);
      metrics.record(_sample(1));
      expect(tail.drain(metrics.samples).fresh, hasLength(1));
      expect(tail.drain(metrics.samples).fresh, isEmpty);
    });
  });

  group('MsgsWriteTally — physical key is not seq', () {
    test('seed separates rewrites of pre-existing rows from new keys', () {
      final tally = MsgsWriteTally();
      // Keys 10,11,12 already held rows when the observation attached.
      expect(tally.seedExisting(const [10, 11, 12]), 3);
      expect(tally.seededKeys, 3);
      expect(tally.distinctKeys, 3);

      // New row appended => new physical key.
      tally.onEvent(13, false);
      expect(tally.puts, 1);
      expect(tally.inserts, 1, reason: 'new key, not a rewrite');
      expect(tally.existingWrites, 0);
      expect(tally.duplicates, 0);

      // Rewrite of a pre-existing row => existing, never "new".
      tally.onEvent(11, false);
      expect(tally.puts, 2);
      expect(tally.inserts, 1);
      expect(tally.existingWrites, 1);
      expect(tally.duplicates, 0, reason: 'first observed put of key 11');

      // Rewrite of a row created during the observation is also existing.
      tally.onEvent(13, false);
      expect(tally.puts, 3);
      expect(tally.inserts, 1);
      expect(tally.existingWrites, 2);
      expect(tally.duplicates, 1, reason: 'repeated event for key 13');
      expect(tally.distinctKeys, 4);
    });

    test('prepend allocates a new key below the seeded minimum: new, not old',
        () {
      final tally = MsgsWriteTally();
      tally.seedExisting(const [10, 11, 12]);

      // A prepended row gets a fresh physical key 9 (below every seeded key)
      // while its MessageRecord.seq is lower than all of them. Key order says
      // nothing about display order, so this is simply a new row.
      tally.onEvent(9, false);
      expect(tally.inserts, 1);
      expect(tally.existingWrites, 0);
      expect(tally.duplicates, 0);
      expect(tally.puts, 1, reason: 'a new key is never an old-row rewrite');

      // Rewriting the lowest seeded key after that is still a rewrite.
      tally.onEvent(10, false);
      expect(tally.existingWrites, 1);
      expect(tally.inserts, 1);
    });

    test('rewrites of lower and higher existing keys are both rewrites', () {
      final tally = MsgsWriteTally();
      tally.seedExisting(const [100, 4]);

      tally.onEvent(100, false); // higher key
      tally.onEvent(4, false); // lower key
      expect(tally.puts, 2);
      expect(tally.existingWrites, 2);
      expect(tally.inserts, 0);
      expect(tally.duplicates, 0);

      // Same key twice more: each repeat is a duplicate (repeated observed
      // physical key), independent of the key's numeric value.
      tally.onEvent(4, false);
      tally.onEvent(100, false);
      expect(tally.puts, 4);
      expect(tally.duplicates, 2);
      expect(tally.existingWrites, 4);
      expect(tally.distinctKeys, 2);
    });

    test('deletes and contract violations are inert', () {
      final tally = MsgsWriteTally();
      tally.seedExisting(const [5]);

      tally.onEvent(5, true);
      expect(tally.deletes, 1);
      expect(tally.puts, 0);
      // Deleting an unseen key is still just a delete.
      tally.onEvent(99, true);
      expect(tally.deletes, 2);

      // Non-int and negative keys violate the contract: ignored entirely.
      tally.onEvent('not-a-key', false);
      tally.onEvent(-1, false);
      tally.onEvent(null, false);
      tally.onEvent(1.5, false);
      expect(tally.puts, 0);
      expect(tally.distinctKeys, 1);

      tally.seedExisting(const [-7]);
      expect(tally.seededKeys, 1, reason: 'negative seed keys rejected');
    });

    test('seeding twice is idempotent and keys-only', () {
      final tally = MsgsWriteTally();
      tally.seedExisting(const [1, 2]);
      tally.seedExisting(const [2, 3]);
      expect(tally.seededKeys, 3);
      expect(tally.distinctKeys, 3);
      expect(tally.puts, 0, reason: 'seeding never counts as a write');
    });
  });

  group('MsgsObservationSwitch — rebinding never reuses a box', () {
    test('waits until a peer, room and open box exist', () {
      final s = MsgsObservationSwitch();
      expect(s.observe(epk: null, room: 'main', boxOpen: false),
          (detach: false, attach: false));
      expect(s.observe(epk: 'peer-a', room: 'main', boxOpen: false),
          (detach: false, attach: false));
      expect(s.attached, isNull);

      expect(s.observe(epk: 'peer-a', room: 'main', boxOpen: true),
          (detach: false, attach: true));
      expect(s.attached, ('peer-a', 'main'));

      // Idempotent while the same box stays focused.
      expect(s.observe(epk: 'peer-a', room: 'main', boxOpen: true),
          (detach: false, attach: false));
    });

    test('peer switch detaches the old box and attaches the new one', () {
      final s = MsgsObservationSwitch();
      s.observe(epk: 'peer-a', room: 'main', boxOpen: true);

      // New peer's box not open yet: the old observation must be dropped
      // rather than keep counting into the new session.
      expect(s.observe(epk: 'peer-b', room: 'main', boxOpen: false),
          (detach: true, attach: false));
      expect(s.attached, isNull);

      expect(s.observe(epk: 'peer-b', room: 'main', boxOpen: true),
          (detach: false, attach: true));
      expect(s.attached, ('peer-b', 'main'));
    });

    test('room switch rebinds (detach + attach) in one observation', () {
      final s = MsgsObservationSwitch();
      s.observe(epk: 'peer-a', room: 'main', boxOpen: true);

      expect(s.observe(epk: 'peer-a', room: 'side', boxOpen: true),
          (detach: true, attach: true),
          reason: 'cancel + reset + seed the new room box');
      expect(s.attached, ('peer-a', 'side'));
    });

    test('losing the focus detaches and stays detached', () {
      final s = MsgsObservationSwitch();
      s.observe(epk: 'peer-a', room: 'main', boxOpen: true);

      expect(s.observe(epk: null, room: 'main', boxOpen: false),
          (detach: true, attach: false));
      expect(s.observe(epk: null, room: 'main', boxOpen: false),
          (detach: false, attach: false));
      expect(s.attached, isNull);
    });
  });
}
