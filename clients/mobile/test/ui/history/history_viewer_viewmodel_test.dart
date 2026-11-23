// Plan 86 P4 — read-only history viewer ViewModel.
//
// Covers: page load, cached paint + conditional revalidation, older-page
// identity/snapshot fencing, body expansion, and the explicit continue flow:
// at most ONE `session_switch` per intent, a missed ACK changes to a dedicated
// target watch (never a resend), and the viewer itself has no send path.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/history/history_body_loader.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/history/states/history_viewer_state.dart';
import 'package:mobile/ui/history/viewmodels/history_viewer_viewmodel.dart';

import 'history_test_rig.dart';

const _sessionId = 's-1';

HistoryCurrentWire _current(String? id, {bool? ready, String? state}) =>
    HistoryCurrentWire(
      sessionId: id,
      ready: ready,
      state: state,
      source: HistoryCurrentSourceWire.runtime,
    );

HistoryViewerViewModel _vm(
  HistoryRig r, {
  String sessionId = _sessionId,
  Duration ackTimeout = const Duration(seconds: 1),
  Duration settleBudget = const Duration(seconds: 1),
  Duration pollInterval = const Duration(milliseconds: 20),
  Duration roomLiveBudget = const Duration(seconds: 1),
  Duration roomLivePollInterval = const Duration(milliseconds: 20),
}) => HistoryViewerViewModel(
  r.repo,
  HistoryBodyLoader(r.repo),
  r.conn,
  r.prefs,
  epk: testEpk,
  daemonId: testDaemon,
  sessionId: sessionId,
  cwd: testCwd,
  roomId: testRoom,
  switchAckTimeout: ackTimeout,
  switchSettleBudget: settleBudget,
  watchPollInterval: pollInterval,
  roomLiveBudget: roomLiveBudget,
  roomLivePollInterval: roomLivePollInterval,
);

void _readPage(HistoryRig r, List<HistoryItemWire> items) {
  r.ch.handler = (msg) async {
    if (msg is HistoryReadRequest) {
      return HistoryReadOk(readWire(id: msg.id, items: items));
    }
    return null;
  };
}

void main() {
  test(
    'disposed pending session A cannot hold distinct session B loading',
    () async {
      final r = await buildHistoryRig(
        requestTimeout: const Duration(milliseconds: 40),
      );
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      final sendA = Completer<void>();
      r.ch.sendOverride = (msg) async {
        if (msg is HistoryReadRequest && msg.sessionId == 'session-A') {
          await sendA.future;
          r.ch.push(
            HistoryReadOk(
              readWire(
                id: msg.id,
                sessionId: 'session-A',
                items: [userItem('a1')],
              ),
            ),
          );
        } else if (msg is HistoryReadRequest && msg.sessionId == 'session-B') {
          r.ch.push(
            HistoryReadOk(
              readWire(
                id: msg.id,
                sessionId: 'session-B',
                items: [userItem('b1')],
              ),
            ),
          );
        }
      };

      final a = _vm(r, sessionId: 'session-A');
      await waitUntil(
        () => r.ch.requests.whereType<HistoryReadRequest>().any(
          (request) => request.sessionId == 'session-A',
        ),
      );
      a.dispose();

      final b = _vm(r, sessionId: 'session-B');
      await waitUntil(() => b.state is HistoryViewerReady);
      expect((b.state as HistoryViewerReady).session.id, 'session-B');
      expect((b.state as HistoryViewerReady).items.single.eventId, 'b1');
      expect(
        r.ch.requests.whereType<HistoryReadRequest>().map((r) => r.sessionId),
        containsAllInOrder(['session-A', 'session-B']),
      );

      // Let A's bounded send finish after B is already ready; disposal fences its
      // result and there is no cross-session single-flight join.
      sendA.complete();
      await Future<void>.delayed(Duration.zero);
      expect((b.state as HistoryViewerReady).session.id, 'session-B');
      expect((b.state as HistoryViewerReady).items.single.eventId, 'b1');
      b.dispose();
    },
  );

  test(
    'A close, pending B close, then A reopen paints cached A despite a late B reply',
    () async {
      final r = await buildHistoryRig(
        requestTimeout: const Duration(milliseconds: 35),
      );
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      final releaseB = Completer<void>();
      r.ch.sendOverride = (msg) async {
        if (msg is! HistoryReadRequest) return;
        if (msg.sessionId == 'session-B') {
          await releaseB.future;
          r.ch.push(
            HistoryReadOk(
              readWire(
                id: msg.id,
                sessionId: 'session-B',
                items: [userItem('late-b')],
              ),
            ),
          );
          return;
        }
        if (msg.sessionId == 'session-A') {
          r.ch.push(
            HistoryReadOk(
              readWire(
                id: msg.id,
                sessionId: 'session-A',
                items: [userItem('keep-a')],
              ),
            ),
          );
        }
      };

      final firstA = _vm(r, sessionId: 'session-A');
      await waitUntil(() => firstA.state is HistoryViewerReady);
      expect((firstA.state as HistoryViewerReady).session.id, 'session-A');
      expect(
        (firstA.state as HistoryViewerReady).items.single.eventId,
        'keep-a',
      );
      firstA.dispose();

      final b = _vm(r, sessionId: 'session-B');
      await waitUntil(
        () => r.ch.requests.whereType<HistoryReadRequest>().any(
          (request) => request.sessionId == 'session-B',
        ),
      );
      expect(b.state, isA<HistoryViewerLoading>());
      // Close B before its reply. The blocked request must not own the list or
      // the next A viewer.
      b.dispose();

      final reopenedA = _vm(r, sessionId: 'session-A');
      addTearDown(reopenedA.dispose);
      await waitUntil(() => reopenedA.state is HistoryViewerReady);
      expect((reopenedA.state as HistoryViewerReady).session.id, 'session-A');
      expect(
        (reopenedA.state as HistoryViewerReady).items.single.eventId,
        'keep-a',
      );

      releaseB.complete();
      await Future<void>.delayed(Duration.zero);
      expect(reopenedA.state, isA<HistoryViewerReady>());
      expect((reopenedA.state as HistoryViewerReady).session.id, 'session-A');
      expect(
        (reopenedA.state as HistoryViewerReady).items.single.eventId,
        'keep-a',
      );
    },
  );

  test(
    'reopened same session joins one flight that settles by request deadline',
    () async {
      final r = await buildHistoryRig(
        requestTimeout: const Duration(milliseconds: 35),
      );
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      r.ch.sendOverride = (_) => Completer<void>().future;

      final first = _vm(r, sessionId: 'session-A');
      await waitUntil(
        () => r.ch.requests.whereType<HistoryReadRequest>().isNotEmpty,
      );
      first.dispose();
      final reopened = _vm(r, sessionId: 'session-A');
      addTearDown(reopened.dispose);
      await waitUntil(() => reopened.state is HistoryViewerError);
      expect(
        (reopened.state as HistoryViewerError).code,
        HistoryErrorCode.timeout,
      );
      expect(
        r.ch.requests
            .whereType<HistoryReadRequest>()
            .where((request) => request.sessionId == 'session-A')
            .length,
        1,
      );
    },
  );

  test(
    'two mounted same-session viewers share one bounded pending request',
    () async {
      final r = await buildHistoryRig(
        requestTimeout: const Duration(milliseconds: 35),
      );
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      r.ch.sendOverride = (_) => Completer<void>().future;

      final first = _vm(r, sessionId: 'session-A');
      addTearDown(first.dispose);
      await waitUntil(
        () => r.ch.requests.whereType<HistoryReadRequest>().isNotEmpty,
      );
      final reopened = _vm(r, sessionId: 'session-A');
      addTearDown(reopened.dispose);

      await waitUntil(
        () =>
            first.state is HistoryViewerError &&
            reopened.state is HistoryViewerError,
      );
      expect(
        (first.state as HistoryViewerError).code,
        HistoryErrorCode.timeout,
      );
      expect(
        (reopened.state as HistoryViewerError).code,
        HistoryErrorCode.timeout,
      );
      expect(
        r.ch.requests
            .whereType<HistoryReadRequest>()
            .where((request) => request.sessionId == 'session-A')
            .length,
        1,
      );
    },
  );

  test(
    'loads a page read-only: zero switch, zero live write, zero start',
    () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      _readPage(r, [userItem('u1'), assistantItem('e1#0', entryId: 'e1')]);

      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);
      final ready = vm.state as HistoryViewerReady;
      expect(ready.items.map((i) => i.eventId), ['u1', 'e1#0']);
      expect(ready.snapshot, 'snap-1');
      expect(ready.staleLabel, isFalse);

      expect(r.ch.count('session_switch'), 0);
      expect(r.ch.count('user_message'), 0);
      expect(r.ch.count('workspace_start'), 0);
      expect(r.ch.count('session_list'), 0);
    },
  );

  test('paints the cache first and clears the label on not_modified', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    var reads = 0;
    var notModified = 0;
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        reads++;
        if (msg.ifRevision != null) {
          notModified++;
          return historyError(
            msg.id,
            HistoryErrorCodeWire.notModified,
            sessionId: _sessionId,
            revision: msg.ifRevision,
          );
        }
        return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
      }
      return null;
    };

    final first = _vm(r);
    addTearDown(first.dispose);
    await waitUntil(() => first.state is HistoryViewerReady);

    final second = _vm(r);
    addTearDown(second.dispose);
    expect(second.state, isA<HistoryViewerReady>());
    final cached = second.state as HistoryViewerReady;
    expect(cached.fromCache, isTrue);
    expect(cached.staleLabel, isTrue);
    expect(cached.items.single.eventId, 'u1');

    await waitUntil(
      () =>
          second.state is HistoryViewerReady &&
          !(second.state as HistoryViewerReady).staleLabel,
    );
    expect(reads, 2);
    expect(notModified, 1);
  });

  test('older pages prepend and dedupe by event_id', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        if (msg.before == null) {
          return HistoryReadOk(
            readWire(
              id: msg.id,
              items: [
                userItem('u2'),
                assistantItem('e2#0', entryId: 'e2'),
              ],
              olderCursor: 'c1',
              hasOlder: true,
            ),
          );
        }
        return HistoryReadOk(
          readWire(
            id: msg.id,
            items: [userItem('u1'), userItem('u2')],
            olderCursor: null,
            hasOlder: false,
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);
    await vm.loadOlder();
    final ready = vm.state as HistoryViewerReady;
    expect(ready.items.map((i) => i.eventId), ['u1', 'u2', 'e2#0']);
    expect(ready.hasOlder, isFalse);
    expect(r.ch.count('session_switch'), 0);
  });

  test('a continued item keeps refs merged by stable identity', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    final ref1 = textRef(ref: 'ref-1', totalBytes: 10);
    final ref2 = textRef(ref: 'ref-2', totalBytes: 20);
    final reads = <HistoryReadRequest>[];
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        reads.add(msg);
        if (msg.before == null) {
          return HistoryReadOk(
            readWire(
              id: msg.id,
              revision: 'rev-1',
              items: [
                assistantItem(
                  'e1#0',
                  entryId: 'e1',
                  text: 'preview',
                  refs: [ref1],
                ),
              ],
              olderCursor: 'c1',
              hasOlder: true,
            ),
          );
        }
        // The SAME event continues on the older page with a new opaque ref.
        // It must be merged, not dropped, and the item must stay partial.
        return HistoryReadOk(
          readWire(
            id: msg.id,
            revision: 'rev-2',
            items: [
              assistantItem(
                'e1#0',
                entryId: 'e1',
                text: 'continuation-fragment',
                refs: [ref2],
              ),
            ],
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);
    await vm.loadOlder();
    final ready = vm.state as HistoryViewerReady;
    expect(ready.items, hasLength(1));
    expect(ready.items.single.eventId, 'e1#0');
    expect(
      ready.items.single.bodyRefs.map((r) => r.ref),
      containsAll(<String>['ref-1', 'ref-2']),
    );
    expect(ready.items.single.truncated, isTrue);
    expect(
      (ready.items.single.event as HistoryAssistantEvent).text,
      'preview',
      reason: 'a continuation fragment must not overwrite the event body',
    );
    // The sequence stays anchored to the first page snapshot AND revision; the
    // older request carries both opaque values and never an if_revision.
    expect(ready.snapshot, 'snap-1');
    expect(ready.revision, 'rev-1');
    expect(reads, hasLength(2));
    expect(reads[1].before, 'c1');
    expect(reads[1].snapshot, 'snap-1');
    expect(reads[1].ifRevision, isNull);
    expect(reads[0].ifRevision, isNull);
  });

  test('has_older=false never fetches an older page', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    _readPage(r, [userItem('u1')]);
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);
    final before = r.ch.count('history_read');
    await vm.loadOlder();
    expect(r.ch.count('history_read'), before);
    expect((vm.state as HistoryViewerReady).items.single.eventId, 'u1');
  });

  test('an older page from another snapshot is never spliced', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        if (msg.before != null) {
          // A different generation than the loaded page.
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: 'snap-2',
              items: [userItem('foreign')],
            ),
          );
        }
        if (msg.snapshot == null) {
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: 'snap-3',
              items: [userItem('u9')],
              olderCursor: 'c1',
              hasOlder: true,
            ),
          );
        }
        return HistoryReadOk(
          readWire(
            id: msg.id,
            snapshot: 'snap-1',
            items: [userItem('u1')],
            olderCursor: 'c1',
            hasOlder: true,
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);
    await vm.loadOlder();
    await waitUntil(
      () =>
          vm.state is HistoryViewerReady &&
          (vm.state as HistoryViewerReady).snapshot == 'snap-3',
    );
    final ready = vm.state as HistoryViewerReady;
    expect(ready.items.map((i) => i.eventId), ['u9']);
    expect(ready.items.map((i) => i.eventId), isNot(contains('foreign')));
  });

  test(
    'continue with the target already current sends ZERO switches',
    () async {
      final r = await buildHistoryRig(roomLive: true);
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      _readPage(r, [userItem('u1')]);
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
        }
        if (msg is HistoryListRequest) {
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession(_sessionId)],
              current: _current(_sessionId, ready: true, state: 'running'),
            ),
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);

      final outcome = await vm.continueToChat();
      expect(outcome, HistoryContinueOutcome.alreadyCurrent);
      expect(r.ch.count('session_switch'), 0);
      expect(r.prefs.selectedPeerEpk, testEpk);
      expect(r.prefs.selectedRoomId, testRoom);
    },
  );

  test(
    'continue sends exactly one switch and waits for the target identity',
    () async {
      final r = await buildHistoryRig(roomLive: true);
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      var lists = 0;
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
        }
        if (msg is HistoryListRequest) {
          lists++;
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession(_sessionId)],
              current: lists == 1
                  ? _current('other', ready: true, state: 'running')
                  : _current(_sessionId, ready: true, state: 'running'),
            ),
          );
        }
        if (msg is SessionSwitch) {
          return SessionSwitchOk(
            inReplyTo: msg.id,
            sessionId: msg.sessionId,
            sessionStartedAt: 0,
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);

      final outcome = await vm.continueToChat();
      expect(outcome, HistoryContinueOutcome.switched);
      expect(r.ch.count('session_switch'), 1);
      // The workspace was already live: the explicit continue must NOT start it.
      expect(r.ch.count('workspace_start'), 0);
      expect(r.ch.count('user_message'), 0);
      expect(r.prefs.selectedPeerEpk, testEpk);
      expect(r.prefs.selectedRoomId, testRoom);
    },
  );

  test(
    'continue starts a stopped workspace once, then switches once',
    () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      var lists = 0;
      var starts = 0;
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
        }
        if (msg is HistoryListRequest) {
          lists++;
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession(_sessionId)],
              current: lists >= 3
                  ? _current(_sessionId, ready: true, state: 'running')
                  : _current('other', ready: false, state: 'stopped'),
            ),
          );
        }
        if (msg is WorkspaceStart) {
          starts++;
          // The relay announces the room once the Pi subscribes; without that
          // edge a switch frame would be silently dropped.
          r.ch.pushControl(
            const RoomAnnounced(
              peer: testEpk,
              roomId: testRoom,
              startedAt: 1,
              cwd: testCwd,
            ),
          );
          return WorkspaceStartOk(
            inReplyTo: msg.id,
            cwd: testCwd,
            roomId: testRoom,
            daemonId: testDaemon,
          );
        }
        if (msg is SessionSwitch) {
          return SessionSwitchOk(
            inReplyTo: msg.id,
            sessionId: msg.sessionId,
            sessionStartedAt: 0,
          );
        }
        return null;
      };
      final vm = _vm(
        r,
        roomLiveBudget: const Duration(seconds: 1),
        roomLivePollInterval: const Duration(milliseconds: 20),
        pollInterval: const Duration(milliseconds: 20),
      );
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);

      final outcome = await vm.continueToChat();
      expect(outcome, HistoryContinueOutcome.switched);
      expect(starts, 1, reason: 'one explicit start per intent');
      expect(r.ch.count('session_switch'), 1);
      expect(r.ch.count('workspace_start'), 1);
      expect(r.prefs.selectedRoomId, testRoom);
    },
  );

  test('a missed ACK never re-sends: it watches the target instead', () async {
    final r = await buildHistoryRig(roomLive: true);
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    var lists = 0;
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
      }
      if (msg is HistoryListRequest) {
        lists++;
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [wireSession(_sessionId)],
            current: lists < 3
                ? _current('other', ready: true, state: 'running')
                : _current(_sessionId, ready: true, state: 'running'),
          ),
        );
      }
      if (msg is SessionSwitch) {
        return null; // never acknowledged
      }
      return null;
    };
    final vm = _vm(
      r,
      ackTimeout: const Duration(milliseconds: 60),
      settleBudget: const Duration(seconds: 2),
      pollInterval: const Duration(milliseconds: 20),
    );
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);

    final outcome = await vm.continueToChat();
    expect(outcome, HistoryContinueOutcome.switched);
    expect(r.ch.count('session_switch'), 1);
    expect(lists, greaterThanOrEqualTo(3));
  });

  test('a second continue tap while one is running is refused', () async {
    final r = await buildHistoryRig(roomLive: true);
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    final gate = Completer<void>();
    var lists = 0;
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
      }
      if (msg is HistoryListRequest) {
        lists++;
        if (lists == 1) await gate.future;
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [wireSession(_sessionId)],
            current: lists <= 2
                ? _current('other', ready: true, state: 'running')
                : _current(_sessionId, ready: true, state: 'running'),
          ),
        );
      }
      if (msg is SessionSwitch) {
        return SessionSwitchOk(
          inReplyTo: msg.id,
          sessionId: msg.sessionId,
          sessionStartedAt: 0,
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);

    final first = vm.continueToChat();
    await waitUntil(() => lists == 1);
    final second = await vm.continueToChat();
    expect(second, HistoryContinueOutcome.failed);
    gate.complete();
    expect(await first, HistoryContinueOutcome.switched);
    expect(r.ch.count('session_switch'), 1);
  });

  test(
    'a locked switch is a typed refusal with the client-owned sentence',
    () async {
      final r = await buildHistoryRig(roomLive: true);
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
        }
        if (msg is HistoryListRequest) {
          return HistoryListOk(
            listWire(
              id: msg.id,
              sessions: [wireSession(_sessionId)],
              current: _current('other', ready: true, state: 'running'),
            ),
          );
        }
        if (msg is SessionSwitch) {
          return SessionSwitchError(
            inReplyTo: msg.id,
            code: SessionSwitchErrorCode.locked,
            message: 'host prose must not be shown',
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);

      final outcome = await vm.continueToChat();
      expect(outcome, HistoryContinueOutcome.failed);
      final ready = vm.state as HistoryViewerReady;
      expect(ready.continueError, HistoryErrorCode.invalidRequest);
      expect(ready.continueRefusal, HistorySwitchRefusal.locked);
      expect(ready.continuing, isFalse);
    },
  );

  test('a late older page after refresh is dropped', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    final gate = Completer<void>();
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        if (msg.before != null) {
          await gate.future;
          return HistoryReadOk(
            readWire(id: msg.id, items: [userItem('late')], snapshot: 'snap-1'),
          );
        }
        return HistoryReadOk(
          readWire(
            id: msg.id,
            items: [userItem('u1')],
            olderCursor: 'c1',
            hasOlder: true,
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);
    unawaited(vm.loadOlder());
    await waitUntil(() => r.ch.count('history_read') >= 2);
    await vm.refresh();
    gate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    final ready = vm.state as HistoryViewerReady;
    expect(ready.items.map((i) => i.eventId), isNot(contains('late')));
  });

  test(
    'body chunks materialize into the row state with a stateful decoder',
    () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      final payload = <int>[0x61, 0xE2, 0x82, 0xAC, 0x62]; // a€b
      _readPage(r, [
        assistantItem(
          'e1#0',
          entryId: 'e1',
          text: 'a',
          refs: [textRef(totalBytes: payload.length)],
        ),
      ]);
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          return HistoryReadOk(
            readWire(
              id: msg.id,
              items: [
                assistantItem(
                  'e1#0',
                  entryId: 'e1',
                  text: 'a',
                  refs: [textRef(totalBytes: payload.length)],
                ),
              ],
            ),
          );
        }
        if (msg is HistoryBodyRequest) {
          final offset = msg.offsetBytes;
          final next = offset == 0 ? 2 : payload.length;
          return HistoryBodyOk(
            HistoryBodyWire(
              inReplyTo: msg.id,
              daemonId: testDaemon,
              sessionId: _sessionId,
              snapshot: 'snap-1',
              bodyRef: msg.bodyRef,
              representation: HistoryBodyRepresentationWire.textUtf8,
              mime: null,
              offsetBytes: offset,
              nextOffsetBytes: next,
              totalBytes: payload.length,
              data: base64Encode(payload.sublist(offset, next)),
            ),
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);
      final ready = vm.state as HistoryViewerReady;
      final ref = ready.items.single.bodyRefs.single;
      await vm.loadBody(ready.items.single.eventId, ref);
      await waitUntil(() {
        final s = vm.state;
        if (s is! HistoryViewerReady) return false;
        return s.bodies.values.any((b) => b is HistoryBodyLoaded);
      });
      final loaded = (vm.state as HistoryViewerReady).bodies.values
          .whereType<HistoryBodyLoaded>()
          .single;
      expect(loaded.text, 'a€b');
      expect(r.ch.count('history_body'), 2);
    },
  );

  test('a body above the App budget is explicit and never fetched', () async {
    final r = await buildHistoryRig();
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    final huge = textRef(totalBytes: kHistoryClientBodyMaxBytes + 1);
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        return HistoryReadOk(
          readWire(
            id: msg.id,
            items: [
              assistantItem('e1#0', entryId: 'e1', text: 'a', refs: [huge]),
            ],
          ),
        );
      }
      return null;
    };
    final vm = _vm(r);
    addTearDown(vm.dispose);
    await waitUntil(() => vm.state is HistoryViewerReady);
    final ready = vm.state as HistoryViewerReady;
    await vm.loadBody(
      ready.items.single.eventId,
      ready.items.single.bodyRefs.single,
    );
    await waitUntil(() {
      final s = vm.state;
      if (s is! HistoryViewerReady) return false;
      return s.bodies.values.any((b) => b is HistoryBodyUnavailable);
    });
    final state = (vm.state as HistoryViewerReady).bodies.values
        .whereType<HistoryBodyUnavailable>()
        .single;
    expect(state.code, HistoryErrorCode.clientBudget);
    expect(r.ch.count('history_body'), 0);
  });

  // -------------------------------------------------------------------------
  // Plan 86 R5 boundary — the newest page is a conditional HEAD read and a new
  // head generation replaces (and fences) the whole loaded sequence.
  // -------------------------------------------------------------------------

  group('newest-head revalidation', () {
    test('cache revalidation never pins the old snapshot', () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      final heads = <HistoryReadRequest>[];
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          heads.add(msg);
          return HistoryReadOk(readWire(id: msg.id, items: [userItem('u1')]));
        }
        return null;
      };

      final first = _vm(r);
      addTearDown(first.dispose);
      await waitUntil(() => first.state is HistoryViewerReady);

      // The second mount paints the cache and revalidates it.
      final second = _vm(r);
      addTearDown(second.dispose);
      expect((second.state as HistoryViewerReady).fromCache, isTrue);
      await waitUntil(() => heads.length >= 2);

      // The cache revalidation is conditional on the revision ONLY: pinning
      // `snap-1` would let the host certify the old head after an append.
      final revalidation = heads[1];
      expect(revalidation.ifRevision, 'rev-1');
      expect(revalidation.snapshot, isNull);
      expect(revalidation.before, isNull);
      // The cold first read carries neither value either.
      expect(heads[0].snapshot, isNull);
      expect(heads[0].ifRevision, isNull);
    });

    test(
      'cache revalidation applies the NEW head rows: a pinned snapshot would '
      'let an append stay invisible behind not_modified',
      () async {
        final r = await buildHistoryRig();
        addTearDown(r.dispose);
        addTearDown(r.ch.close);
        // Trusted-append model of the host's high-water enforcement: the file
        // revision moves forward and the page generation is rewritten.
        var revision = 'rev-1';
        var snapshot = 'snap-1';
        var items = <HistoryItemWire>[userItem('u1')];
        final pinned = <String?>[];
        r.ch.handler = (msg) async {
          if (msg is! HistoryReadRequest) return null;
          pinned.add(msg.snapshot);
          if (msg.snapshot != null) {
            // A host that honours a CLIENT-PINNED generation answers with the
            // rows of THAT generation — while still reporting the CURRENT
            // revision. The client would then hold stale rows it believes are
            // current, and its next conditional refresh (if_revision == the
            // current revision) is answered with not_modified forever.
            return HistoryReadOk(
              readWire(
                id: msg.id,
                snapshot: msg.snapshot!,
                revision: revision,
                items: [userItem('u1')],
              ),
            );
          }
          if (msg.ifRevision != null && msg.ifRevision == revision) {
            return historyError(
              msg.id,
              HistoryErrorCodeWire.notModified,
              sessionId: _sessionId,
              revision: revision,
            );
          }
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: snapshot,
              revision: revision,
              items: items,
            ),
          );
        };

        final first = _vm(r);
        addTearDown(first.dispose);
        await waitUntil(() => first.state is HistoryViewerReady);
        expect((first.state as HistoryViewerReady).items, hasLength(1));

        // The append is published by the host: new revision + new generation.
        revision = 'rev-2';
        snapshot = 'snap-2';
        items = [
          userItem('u1'),
          assistantItem('e2#0', entryId: 'e2', text: 'appended'),
        ];

        final second = _vm(r);
        addTearDown(second.dispose);
        // The cache paints the OLD rows first (honestly labelled).
        final cachedPaint = second.state as HistoryViewerReady;
        expect(cachedPaint.staleLabel, isTrue);
        expect(cachedPaint.items.map((i) => i.eventId), ['u1']);

        await waitUntil(
          () =>
              second.state is HistoryViewerReady &&
              !(second.state as HistoryViewerReady).staleLabel,
        );
        // The revalidation read carried NO snapshot: only then can the host
        // answer with the newest generation instead of the pinned old head.
        expect(pinned.last, isNull);
        final ready = second.state as HistoryViewerReady;
        // The new head REPLACES the sequence: the appended row is visible and
        // the generation is the new one.
        expect(ready.snapshot, 'snap-2');
        expect(ready.revision, 'rev-2');
        expect(ready.items.map((i) => i.eventId), ['u1', 'e2#0']);
        expect(ready.fromCache, isFalse);

        // And the window now revalidates cleanly against the NEW head.
        await second.refresh();
        final verified = second.state as HistoryViewerReady;
        expect(verified.staleLabel, isFalse);
        expect(verified.items.map((i) => i.eventId), ['u1', 'e2#0']);
      },
    );

    test('an explicit refresh revalidates by revision only and applies a '
        'new head', () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      var snapshot = 'snap-1';
      var revision = 'rev-1';
      var items = <HistoryItemWire>[userItem('u1')];
      final reads = <HistoryReadRequest>[];
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          reads.add(msg);
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: snapshot,
              revision: revision,
              items: items,
            ),
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);

      snapshot = 'snap-2';
      revision = 'rev-2';
      items = [
        userItem('u1'),
        assistantItem('e3#0', entryId: 'e3', text: 'appended'),
      ];
      await vm.refresh();

      expect(reads, hasLength(2));
      expect(reads[1].ifRevision, 'rev-1');
      expect(reads[1].snapshot, isNull);
      expect(reads[1].before, isNull);

      final ready = vm.state as HistoryViewerReady;
      expect(ready.snapshot, 'snap-2');
      expect(ready.revision, 'rev-2');
      expect(ready.items.map((i) => i.eventId), ['u1', 'e3#0']);
    });

    test('an older page keeps the ORIGINAL snapshot and cursor', () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      final reads = <HistoryReadRequest>[];
      r.ch.handler = (msg) async {
        if (msg is HistoryReadRequest) {
          reads.add(msg);
          if (msg.before != null) {
            return HistoryReadOk(
              readWire(
                id: msg.id,
                snapshot: 'snap-1',
                revision: 'rev-9',
                items: [userItem('u0')],
              ),
            );
          }
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: 'snap-1',
              items: [userItem('u1')],
              olderCursor: 'c1',
              hasOlder: true,
            ),
          );
        }
        return null;
      };
      final vm = _vm(r);
      addTearDown(vm.dispose);
      await waitUntil(() => vm.state is HistoryViewerReady);
      await vm.loadOlder();

      expect(reads, hasLength(2));
      // Older keeps the ORIGINAL opaque snapshot + cursor and never carries
      // an `if_revision` (that would answer `not_modified` instead of a page).
      expect(reads[1].before, 'c1');
      expect(reads[1].snapshot, 'snap-1');
      expect(reads[1].ifRevision, isNull);

      final ready = vm.state as HistoryViewerReady;
      // The window stays anchored to its own generation/revision; the older
      // page's newer revision is never adopted.
      expect(ready.snapshot, 'snap-1');
      expect(ready.revision, 'rev-1');
      expect(ready.items.map((i) => i.eventId), ['u0', 'u1']);
    });

    test('a late older page from the pinned cache generation is fenced by a '
        'head change in the SAME epoch', () async {
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      final olderGate = Completer<void>();
      final headGate = Completer<void>();
      r.ch.handler = (msg) async {
        if (msg is! HistoryReadRequest) return null;
        if (msg.before != null) {
          await olderGate.future;
          // Fetched under the cached generation (snap-1): a correct client
          // must never splice it into the snap-2 window.
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: 'snap-1',
              revision: 'rev-1',
              items: [userItem('stale-older')],
            ),
          );
        }
        if (msg.ifRevision != null) {
          // The trusted append landed: the conditional head read returns a
          // NEW generation at the SAME epoch as the cached paint.
          await headGate.future;
          return HistoryReadOk(
            readWire(
              id: msg.id,
              snapshot: 'snap-2',
              revision: 'rev-2',
              items: [
                userItem('u1'),
                assistantItem('e2#0', entryId: 'e2', text: 'appended'),
              ],
              olderCursor: 'c2',
              hasOlder: true,
            ),
          );
        }
        return HistoryReadOk(
          readWire(
            id: msg.id,
            snapshot: 'snap-1',
            revision: 'rev-1',
            items: [userItem('u1')],
            olderCursor: 'c1',
            hasOlder: true,
          ),
        );
      };

      // Mount #1 populates the cache with the snap-1 head.
      final first = _vm(r);
      addTearDown(first.dispose);
      await waitUntil(() => first.state is HistoryViewerReady);
      expect((first.state as HistoryViewerReady).snapshot, 'snap-1');

      // Mount #2 paints the cache synchronously and revalidates.
      final vm = _vm(r);
      addTearDown(vm.dispose);
      final cached = vm.state as HistoryViewerReady;
      expect(cached.fromCache, isTrue);
      expect(cached.snapshot, 'snap-1');

      // Paging starts against the CACHED generation while the revalidation
      // head is still in flight (same epoch).
      unawaited(vm.loadOlder());
      await waitUntil(() => r.ch.count('history_read') >= 3);

      headGate.complete();
      await waitUntil(
        () =>
            vm.state is HistoryViewerReady &&
            (vm.state as HistoryViewerReady).snapshot == 'snap-2',
      );
      final afterHead = vm.state as HistoryViewerReady;
      expect(afterHead.items.map((i) => i.eventId), ['u1', 'e2#0']);
      expect(afterHead.loadingOlder, isFalse);
      expect(afterHead.olderCursor, 'c2');

      olderGate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 60));
      final ready = vm.state as HistoryViewerReady;
      expect(ready.snapshot, 'snap-2');
      expect(ready.items.map((i) => i.eventId), isNot(contains('stale-older')));
      expect(ready.items.map((i) => i.eventId), ['u1', 'e2#0']);
      expect(ready.issue, isNull, reason: 'a fenced reply is silent');
    });

    test(
      'a late body chunk from the cached generation cannot apply after a head '
      'change in the SAME epoch',
      () async {
        final r = await buildHistoryRig();
        addTearDown(r.dispose);
        addTearDown(r.ch.close);
        final bodyGate = Completer<void>();
        final headGate = Completer<void>();
        final payload = utf8.encode('stale body');
        final ref = textRef(totalBytes: payload.length);
        r.ch.handler = (msg) async {
          if (msg is HistoryReadRequest) {
            if (msg.before == null && msg.ifRevision != null) {
              await headGate.future;
              return HistoryReadOk(
                readWire(
                  id: msg.id,
                  snapshot: 'snap-2',
                  revision: 'rev-2',
                  items: [userItem('u1')],
                ),
              );
            }
            return HistoryReadOk(
              readWire(
                id: msg.id,
                snapshot: 'snap-1',
                revision: 'rev-1',
                items: [
                  assistantItem('e1#0', entryId: 'e1', text: 'a', refs: [ref]),
                ],
              ),
            );
          }
          if (msg is HistoryBodyRequest) {
            await bodyGate.future;
            return HistoryBodyOk(
              HistoryBodyWire(
                inReplyTo: msg.id,
                daemonId: testDaemon,
                sessionId: _sessionId,
                snapshot: 'snap-1',
                bodyRef: msg.bodyRef,
                representation: HistoryBodyRepresentationWire.textUtf8,
                mime: null,
                offsetBytes: 0,
                nextOffsetBytes: payload.length,
                totalBytes: payload.length,
                data: base64Encode(payload),
              ),
            );
          }
          return null;
        };

        final first = _vm(r);
        addTearDown(first.dispose);
        await waitUntil(() => first.state is HistoryViewerReady);
        expect((first.state as HistoryViewerReady).snapshot, 'snap-1');

        final vm = _vm(r);
        addTearDown(vm.dispose);
        final cached = vm.state as HistoryViewerReady;
        expect(cached.fromCache, isTrue);
        final domainRef = cached.items.single.bodyRefs.single;

        // Expansion starts against the CACHED generation while the
        // revalidation head is still in flight (same epoch).
        unawaited(vm.loadBody(cached.items.single.eventId, domainRef));
        await waitUntil(() => r.ch.count('history_body') >= 1);
        expect(
          (vm.state as HistoryViewerReady).bodies.values.single,
          isA<HistoryBodyLoading>(),
        );

        headGate.complete();
        await waitUntil(
          () =>
              vm.state is HistoryViewerReady &&
              (vm.state as HistoryViewerReady).snapshot == 'snap-2',
        );

        bodyGate.complete();
        await Future<void>.delayed(const Duration(milliseconds: 60));
        final ready = vm.state as HistoryViewerReady;
        // The fenced generation's bytes must not be pinned into the new
        // window (the item they belong to is no longer part of it).
        expect(ready.snapshot, 'snap-2');
        expect(ready.bodies, isEmpty);
        expect(ready.items.map((i) => i.eventId), ['u1']);
      },
    );
  });
}
