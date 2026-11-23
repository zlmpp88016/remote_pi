import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/ui/history/states/history_list_state.dart';
import 'package:mobile/ui/history/viewmodels/history_list_viewmodel.dart';

class _Repository extends HistoryRepository {
  int calls = 0;
  Future<HistoryWorkspaceListing> Function()? respond;
  @override
  HistoryWorkspaceListing? cachedWorkspace(String epk, String daemonId) => null;
  @override
  Future<HistoryWorkspaceListing> listWorkspace(
    HistoryWorkspaceQuery query,
  ) async {
    calls++;
    return await respond!();
  }

  @override
  void recordMetric(HistoryMetricSample sample) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

HistoryWorkspaceListing _listing(
  HistoryIndexState state, {
  int retryAfterMs = 25,
}) => HistoryWorkspaceListing(
  daemonId: 'cold',
  revision: state == HistoryIndexState.ready ? 'ready' : null,
  indexState: state,
  current: HistoryCurrent.unknown,
  sessions: const [],
  nextCursor: null,
  hasMore: false,
  retryAfterMs: retryAfterMs,
);

HistoryListViewModel _view(_Repository repo, {DateTime Function()? now}) =>
    HistoryListViewModel(repo, epk: 'fixture', daemonId: 'cold', now: now);

void main() {
  for (final envelope in ['success', 'error', 'mixed']) {
    test(
      '$envelope building replies can span a 27s cold build with bounded requests',
      () {
        fakeAsync((clock) {
          final repo = _Repository();
          repo.respond = () async {
            if (clock.elapsed >= const Duration(seconds: 27)) {
              return _listing(HistoryIndexState.ready);
            }
            if (envelope == 'error' ||
                envelope == 'mixed' && repo.calls.isEven) {
              throw const HistoryFailure(
                HistoryErrorCode.building,
                retryAfterMs: 25,
              );
            }
            return _listing(HistoryIndexState.building);
          };
          final vm = _view(repo);
          try {
            clock.flushMicrotasks();
            clock.elapse(const Duration(seconds: 30));
            expect(vm.state, isA<HistoryListReady>());
            final state = vm.state as HistoryListReady;
            expect(state.building, isFalse);
            expect(state.issue, isNull);
            expect(repo.calls, lessThanOrEqualTo(21));
            final completeCalls = repo.calls;
            clock.elapse(const Duration(seconds: 60));
            expect(repo.calls, completeCalls);
          } finally {
            if (!vm.isDisposed) vm.dispose();
          }
        });
      },
    );

    test(
      '$envelope permanently building replies terminate without a false ready page',
      () {
        fakeAsync((clock) {
          final repo = _Repository();
          repo.respond = () async {
            if (envelope == 'error' ||
                envelope == 'mixed' && repo.calls.isEven) {
              throw const HistoryFailure(
                HistoryErrorCode.building,
                retryAfterMs: 25,
              );
            }
            return _listing(HistoryIndexState.building);
          };
          final vm = _view(repo);
          try {
            clock.flushMicrotasks();
            clock.elapse(const Duration(seconds: 60));
            final state = vm.state as HistoryListReady;
            expect(state.building, isTrue);
            expect(state.sessions, isEmpty);
            expect(state.issue, HistoryErrorCode.internal);
            expect(repo.calls, lessThanOrEqualTo(21));
            final terminalCalls = repo.calls;
            clock.elapse(const Duration(seconds: 60));
            expect(repo.calls, terminalCalls);
          } finally {
            if (!vm.isDisposed) vm.dispose();
          }
        });
      },
    );
  }

  test(
    'a slow building response cannot start another retry after the 30s budget',
    () {
      fakeAsync((clock) {
        final repo = _Repository();
        repo.respond = () async {
          if (repo.calls > 1) {
            await Future<void>.delayed(const Duration(seconds: 29));
          }
          return _listing(HistoryIndexState.building, retryAfterMs: 1000);
        };
        final vm = _view(
          repo,
          now: () => DateTime.utc(2026).add(clock.elapsed),
        );
        try {
          clock.flushMicrotasks();
          clock.elapse(const Duration(seconds: 30));
          expect(repo.calls, 2);
          expect(
            (vm.state as HistoryListReady).issue,
            HistoryErrorCode.internal,
          );
          clock.elapse(const Duration(minutes: 1));
          expect(repo.calls, 2);
        } finally {
          vm.dispose();
        }
      });
    },
  );

  test(
    'a timer that resumes after the deadline sends no additional request',
    () {
      fakeAsync((clock) {
        final repo = _Repository();
        repo.respond = () async => _listing(HistoryIndexState.building);
        var now = DateTime.utc(2026);
        final vm = _view(repo, now: () => now);
        try {
          clock.flushMicrotasks();
          now = now.add(const Duration(minutes: 1));
          clock.elapse(const Duration(milliseconds: 25));
          expect(repo.calls, 1);
          expect(
            (vm.state as HistoryListReady).issue,
            HistoryErrorCode.internal,
          );
        } finally {
          vm.dispose();
        }
      });
    },
  );

  test(
    'refresh starts a new round and a late old building reply cannot restart it',
    () {
      fakeAsync((clock) {
        final repo = _Repository();
        final held = Completer<HistoryWorkspaceListing>();
        repo.respond = () async => repo.calls == 1
            ? _listing(HistoryIndexState.building)
            : repo.calls == 2
            ? await held.future
            : _listing(HistoryIndexState.ready);
        final vm = _view(
          repo,
          now: () => DateTime.utc(2026).add(clock.elapsed),
        );
        try {
          clock.flushMicrotasks();
          clock.elapse(const Duration(milliseconds: 25));
          expect(repo.calls, 2);
          var refreshed = false;
          vm.refresh().then((_) {
            refreshed = true;
          });
          clock.flushMicrotasks();
          expect(refreshed, isTrue);
          expect((vm.state as HistoryListReady).building, isFalse);
          held.complete(_listing(HistoryIndexState.building));
          clock.flushMicrotasks();
          clock.elapse(const Duration(minutes: 1));
          expect(repo.calls, 3);
          expect((vm.state as HistoryListReady).building, isFalse);
          expect((vm.state as HistoryListReady).issue, isNull);
        } finally {
          vm.dispose();
        }
      });
    },
  );

  test(
    'a held retry remains single flight and disposal cancels future retries',
    () {
      fakeAsync((clock) {
        final repo = _Repository();
        final held = Completer<HistoryWorkspaceListing>();
        repo.respond = () async => repo.calls == 1
            ? _listing(HistoryIndexState.building)
            : await held.future;
        final vm = _view(repo);
        try {
          clock.flushMicrotasks();
          clock.elapse(const Duration(seconds: 60));
          expect(repo.calls, 2);
          vm.dispose();
          held.complete(_listing(HistoryIndexState.building));
          clock.flushMicrotasks();
          clock.elapse(const Duration(seconds: 60));
          expect(repo.calls, 2);
        } finally {
          if (!vm.isDisposed) vm.dispose();
        }
      });
    },
  );
}
