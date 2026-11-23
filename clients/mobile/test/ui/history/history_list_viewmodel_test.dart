// Plan 86 P4 — workspace history list ViewModel.
//
// The screen must open instantly, browse with ZERO Pi work, paint a cached page
// first (labelled) and never turn `building` into "no history". Paging must not
// splice two revisions and a late reply from a superseded request must be
// dropped.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/history/states/history_list_state.dart';
import 'package:mobile/ui/history/viewmodels/history_list_viewmodel.dart';

import 'history_test_rig.dart';

HistoryListViewModel _vm(HistoryRig r) => HistoryListViewModel(
  r.repo,
  epk: testEpk,
  daemonId: testDaemon,
  cwd: testCwd,
  roomId: testRoom,
);

void main() {
  test('opens with a skeleton immediately and never starts a Pi', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [wireSession('s-1', name: 'one', preview: 'hi')],
          ),
        );
      }
      return null;
    };

    final vm = _vm(r);
    addTearDown(vm.dispose);
    // The first frame is a skeleton, not an awaited start.
    expect(vm.state, isA<HistoryListLoading>());
    await waitUntil(() => vm.state is HistoryListReady);
    final ready = vm.state as HistoryListReady;
    expect(ready.sessions.single.id, 's-1');
    expect(ready.building, isFalse);
    expect(ready.staleLabel, isFalse);

    // Browsing is zero-Pi and zero-switch.
    expect(r.ch.count('workspace_start'), 0);
    expect(r.ch.count('session_switch'), 0);
    expect(r.ch.count('session_list'), 0);
    expect(r.ch.count('session_read'), 0);
  });

  test(
    'paints a cached page first, then verifies it with if_revision',
    () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      var verifications = 0;
      r.ch.handler = (msg) async {
        if (msg is HistoryListRequest) {
          if (msg.ifRevision != null) {
            verifications++;
            return historyError(
              msg.id,
              HistoryErrorCodeWire.notModified,
              revision: msg.ifRevision,
            );
          }
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession('s-1', name: 'one')],
            ),
          );
        }
        return null;
      };

      final first = _vm(r);
      addTearDown(first.dispose);
      await waitUntil(() => first.state is HistoryListReady);

      final second = _vm(r);
      addTearDown(second.dispose);
      // Cache paint is synchronous with the constructor (well under the 100 ms
      // target; measured in the dedicated test below).
      expect(second.state, isA<HistoryListReady>());
      final cached = second.state as HistoryListReady;
      expect(cached.fromCache, isTrue);
      expect(cached.staleLabel, isTrue);
      expect(cached.sessions.single.id, 's-1');

      await waitUntil(
        () =>
            second.state is HistoryListReady &&
            !(second.state as HistoryListReady).staleLabel,
      );
      expect(verifications, 1);
      expect(r.ch.count('history_list'), 2);
    },
  );

  test('a cache hit paints real content in <= 100 ms', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    // A realistic first page: 50 rows with names and previews (the wire cap is
    // 50 and the previews are real content, not empty placeholders).
    final sessions = [
      for (var i = 0; i < 50; i++)
        wireSession(
          's-$i',
          name: 'session $i',
          preview:
              'a realistic first user message for session $i with enough text ',
        ),
    ];
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        return HistoryListOk(listWire(id: msg.id, sessions: sessions));
      }
      return null;
    };
    final first = _vm(r);
    addTearDown(first.dispose);
    await waitUntil(() => first.state is HistoryListReady);

    final watch = Stopwatch()..start();
    final second = _vm(r);
    addTearDown(second.dispose);
    final state = second.state;
    watch.stop();
    expect(state, isA<HistoryListReady>());
    expect((state as HistoryListReady).fromCache, isTrue);
    expect(state.sessions, hasLength(50));
    // ignore: avoid_print
    print('cache-hit first paint: ${watch.elapsedMicroseconds} us');
    expect(
      watch.elapsedMilliseconds,
      lessThanOrEqualTo(100),
      reason: 'cache hit target is <= 100 ms',
    );
  });

  test(
    'building retries with one in-flight request and is never empty-final',
    () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      r.ch.handler = (msg) async {
        if (msg is HistoryListRequest) {
          return HistoryListOk(
            listWire(
              id: msg.id,
              revision: null,
              indexState: HistoryIndexStateWire.building,
              retryAfterMs: 10,
            ),
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryListReady);
      await waitUntil(() => r.ch.count('history_list') >= 2);
      final state = vm.state as HistoryListReady;
      expect(state.building, isTrue);
      expect(state.sessions, isEmpty);
      // Never an error while the bounded budget is still open.
      expect(state.issue, isNull);
    },
  );

  test('older pages append with stable identity and never switch', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        if (msg.before == null) {
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession('s-1'), wireSession('s-2')],
              nextCursor: 'c1',
              hasMore: true,
            ),
          );
        }
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [wireSession('s-2'), wireSession('s-3')],
            revision: 'rev-1',
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryListReady);
    await vm.loadMore();
    final state = vm.state as HistoryListReady;
    expect(state.sessions.map((s) => s.id), ['s-1', 's-2', 's-3']);
    expect(state.hasMore, isFalse);
    expect(r.ch.count('session_switch'), 0);
    expect(r.ch.count('workspace_start'), 0);
  });

  test('a revision change between pages is refused, not spliced', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        if (msg.before == null) {
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession('s-1')],
              nextCursor: 'c1',
              hasMore: true,
            ),
          );
        }
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [wireSession('s-2')],
            revision: 'rev-2',
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryListReady);
    await vm.loadMore();
    final state = vm.state as HistoryListReady;
    expect(state.sessions.map((s) => s.id), ['s-1']);
    expect(state.issue, HistoryErrorCode.stale);
  });

  test('a late older-page reply after a refresh is dropped', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    final gate = Completer<void>();
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        if (msg.before != null) {
          await gate.future;
          return HistoryListOk(
            listWire(id: msg.id, sessions: [wireSession('s-late')]),
          );
        }
        return HistoryListOk(listList(id: msg.id));
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryListReady);
    unawaited(vm.loadMore());
    await waitUntil(() => r.ch.count('history_list') >= 2);
    await vm.refresh();
    gate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    final state = vm.state as HistoryListReady;
    expect(
      state.sessions.map((s) => s.id),
      isNot(contains('s-late')),
      reason: 'a reply from a superseded epoch must not be applied',
    );
  });

  test('P0 sample records queue/wire/apply/first content as scalars', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        return HistoryListOk(
          listWire(id: msg.id, sessions: [wireSession('s-1')]),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryListReady);
    expect(r.metrics.last, isNull, reason: 'reported on first real paint');
    vm.reportFirstContent();
    final sample = r.metrics.last!;
    expect(sample.op, 'history_list');
    expect(sample.queueMs, isNotNull);
    expect(sample.wireMs, isNotNull);
    expect(sample.decodeApplyMs, isNotNull);
    expect(sample.firstContentMs, isNotNull);
    expect(sample.cacheHit, isFalse);
    expect(sample.items, 1);
  });
}

// Small helper kept below so the "late reply" test can build a page without
// repeating the session list literal.
HistoryListWire listList({required String id}) => listWire(
  id: id,
  sessions: [wireSession('s-1')],
  nextCursor: 'c1',
  hasMore: true,
);
