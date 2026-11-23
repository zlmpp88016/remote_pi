// Plan 86 P4 — widget flow: workspace list → read-only viewer → explicit
// continue → live chat.
//
// Asserts the user-visible invariants:
//   * a tapped workspace goes to the HISTORY route and never starts a Pi;
//   * the viewer has no text field/composer at all;
//   * a truncated preview can be expanded to its full body;
//   * "继续对话" confirms first (and says it affects other paired clients),
//     then performs exactly one switch and only then navigates to chat.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import 'package:mobile/data/history/history_body_loader.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/history/history_list_page.dart';
import 'package:mobile/ui/history/history_viewer_page.dart';
import 'package:mobile/ui/history/states/history_list_state.dart';
import 'package:mobile/ui/history/states/history_viewer_state.dart';
import 'package:mobile/ui/history/viewmodels/history_list_viewmodel.dart';
import 'package:mobile/ui/history/viewmodels/history_viewer_viewmodel.dart';

import 'history_test_rig.dart';

const _chatMarker = 'ROUTE:CHAT';
const _sessionMarker = 'ROUTE:HISTORY_SESSION';

void main() {
  testWidgets('workspace rows are read-only and tap opens the viewer route', (
    tester,
  ) async {
    final ch = FakeHistoryChannel();
    late HistoryRig r;
    await tester.runAsync(() async {
      r = await buildHistoryRig(channel: ch);
    });
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    r.ch.handler = (msg) async {
      if (msg is HistoryListRequest) {
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [
              wireSession('s-1', name: 'one', preview: 'first message'),
              wireSession('s-2', name: 'two'),
            ],
            current: const HistoryCurrentWire(
              sessionId: 's-1',
              ready: true,
              state: 'running',
              source: HistoryCurrentSourceWire.runtime,
            ),
          ),
        );
      }
      return null;
    };

    late HistoryListViewModel vm;
    await tester.runAsync(() async {
      vm = HistoryListViewModel(
        r.repo,
        epk: testEpk,
        daemonId: testDaemon,
        cwd: testCwd,
        roomId: testRoom,
      );
      await waitUntil(() => vm.state is HistoryListReady);
    });
    addTearDown(vm.dispose);

    Map<String, dynamic>? viewerExtra;
    final router = GoRouter(
      initialLocation: '/history',
      routes: [
        GoRoute(
          path: '/history',
          builder: (_, _) => ChangeNotifierProvider.value(
            value: vm,
            child: const HistoryListPage(
              epk: testEpk,
              daemonId: testDaemon,
              cwd: testCwd,
              roomId: testRoom,
              title: 'proj',
              device: 'Mac',
            ),
          ),
        ),
        GoRoute(
          path: '/history/session',
          builder: (_, state) {
            viewerExtra = (state.extra as Map).cast<String, dynamic>();
            return const Scaffold(body: Center(child: Text(_sessionMarker)));
          },
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp.router(theme: buildDarkTheme(), routerConfig: router),
    );
    await tester.pump();

    expect(find.text('one'), findsOneWidget);
    expect(find.text(HistoryCopy.currentSession), findsOneWidget);
    expect(r.ch.count('workspace_start'), 0);
    expect(r.ch.count('session_switch'), 0);

    await tester.tap(find.text('two'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text(_sessionMarker), findsOneWidget);
    expect(viewerExtra, isNotNull);
    expect(viewerExtra!['sessionId'], 's-2');
    expect(viewerExtra!['daemonId'], testDaemon);
    expect(viewerExtra!['roomId'], testRoom);
    expect(r.ch.count('session_switch'), 0);
  });

  testWidgets('viewer has no composer and expands a truncated body', (
    tester,
  ) async {
    final ch = FakeHistoryChannel();
    late HistoryRig r;
    await tester.runAsync(() async {
      r = await buildHistoryRig(channel: ch);
    });
    addTearDown(r.dispose);
    addTearDown(r.ch.close);
    final payload = utf8.encode('full body');
    r.ch.handler = (msg) async {
      if (msg is HistoryReadRequest) {
        return HistoryReadOk(
          readWire(
            id: msg.id,
            items: [
              userItem('u1', text: 'hello'),
              assistantItem(
                'e1#0',
                entryId: 'e1',
                text: 'preview…',
                refs: [textRef(totalBytes: payload.length)],
              ),
            ],
          ),
        );
      }
      if (msg is HistoryBodyRequest) {
        return HistoryBodyOk(
          HistoryBodyWire(
            inReplyTo: msg.id,
            daemonId: testDaemon,
            sessionId: 's-1',
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
      if (msg is HistoryListRequest) {
        return HistoryListOk(
          listWire(
            id: msg.id,
            sessions: [wireSession('s-1')],
            current: const HistoryCurrentWire(
              sessionId: 'other',
              ready: true,
              state: 'running',
              source: HistoryCurrentSourceWire.runtime,
            ),
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

    late HistoryViewerViewModel vm;
    await tester.runAsync(() async {
      vm = HistoryViewerViewModel(
        r.repo,
        HistoryBodyLoader(r.repo),
        r.conn,
        r.prefs,
        epk: testEpk,
        daemonId: testDaemon,
        sessionId: 's-1',
        cwd: testCwd,
        roomId: testRoom,
        switchAckTimeout: const Duration(milliseconds: 300),
        switchSettleBudget: const Duration(seconds: 2),
        watchPollInterval: const Duration(milliseconds: 20),
      );
      await waitUntil(() => vm.state is HistoryViewerReady);
    });
    addTearDown(vm.dispose);

    final router = GoRouter(
      initialLocation: '/history/session',
      routes: [
        GoRoute(
          path: '/history/session',
          builder: (_, _) => ChangeNotifierProvider.value(
            value: vm,
            child: const HistoryViewerPage(
              epk: testEpk,
              daemonId: testDaemon,
              sessionId: 's-1',
              cwd: testCwd,
              roomId: testRoom,
              title: 'one',
              device: 'Mac',
            ),
          ),
        ),
        GoRoute(
          path: '/chat',
          builder: (_, _) =>
              const Scaffold(body: Center(child: Text(_chatMarker))),
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp.router(theme: buildDarkTheme(), routerConfig: router),
    );
    await tester.pump();

    // Structural read-only: there is no input widget to send from.
    expect(find.byType(TextField), findsNothing);
    expect(find.text(HistoryCopy.continueTitle), findsOneWidget);
    expect(find.text(HistoryCopy.readOnlyHint), findsOneWidget);
    // A host-truncated item is visibly partial, never presented as complete.
    expect(find.text(HistoryCopy.partialContent), findsOneWidget);

    // Expand the bounded preview into the full body.
    expect(find.text(HistoryCopy.loadFull), findsOneWidget);
    await tester.tap(find.text(HistoryCopy.loadFull));
    await tester.runAsync(() async {
      await waitUntil(() {
        final s = vm.state;
        return s is HistoryViewerReady &&
            s.bodies.values.any((b) => b is HistoryBodyLoaded);
      });
    });
    await tester.pump();
    expect(r.ch.count('history_body'), 1);
    expect(r.ch.count('user_message'), 0);
  });

  testWidgets(
    'continue confirms, says it affects other clients, then switches once',
    (tester) async {
      late HistoryRig r;
      await tester.runAsync(() async {
        r = await buildHistoryRig(
          roomLive: true,
          requestTimeout: const Duration(seconds: 30),
        );
      });
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
              sessions: [wireSession('s-1')],
              current: lists == 1
                  ? const HistoryCurrentWire(
                      sessionId: 'other',
                      ready: true,
                      state: 'running',
                      source: HistoryCurrentSourceWire.runtime,
                    )
                  : const HistoryCurrentWire(
                      sessionId: 's-1',
                      ready: true,
                      state: 'running',
                      source: HistoryCurrentSourceWire.runtime,
                    ),
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

      late HistoryViewerViewModel vm;
      await tester.runAsync(() async {
        vm = HistoryViewerViewModel(
          r.repo,
          HistoryBodyLoader(r.repo),
          r.conn,
          r.prefs,
          epk: testEpk,
          daemonId: testDaemon,
          sessionId: 's-1',
          cwd: testCwd,
          roomId: testRoom,
          switchAckTimeout: const Duration(milliseconds: 300),
          switchSettleBudget: const Duration(seconds: 2),
          watchPollInterval: const Duration(milliseconds: 20),
        );
        await waitUntil(() => vm.state is HistoryViewerReady);
      });
      addTearDown(vm.dispose);

      final router = GoRouter(
        initialLocation: '/history/session',
        routes: [
          GoRoute(
            path: '/history/session',
            builder: (_, _) => ChangeNotifierProvider.value(
              value: vm,
              child: const HistoryViewerPage(
                epk: testEpk,
                daemonId: testDaemon,
                sessionId: 's-1',
                cwd: testCwd,
                roomId: testRoom,
                title: 'one',
                device: 'Mac',
              ),
            ),
          ),
          GoRoute(
            path: '/chat',
            builder: (_, _) =>
                const Scaffold(body: Center(child: Text(_chatMarker))),
          ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp.router(theme: buildDarkTheme(), routerConfig: router),
      );
      await tester.pump();

      await tester.tap(find.text(HistoryCopy.continueTitle));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      // Confirmation is mandatory and states the cross-client effect.
      expect(find.text(HistoryCopy.continueBody), findsOneWidget);
      expect(find.text(HistoryCopy.affectsOtherClients), findsOneWidget);
      expect(r.ch.count('session_switch'), 0);

      // Cancel keeps the viewer read-only (no switch, no navigation).
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.widgetWithText(TextButton, HistoryCopy.continueCancel),
        ),
      );
      await tester.pump();
      expect(r.ch.count('session_switch'), 0);
      expect(find.text(_chatMarker), findsNothing);

      // The VM owns the confirmed intent; navigation is state-driven. Driving it
      // in the REAL async zone keeps this test independent of the fake-timer
      // zone Flutter uses for gesture callbacks.
      late HistoryContinueOutcome outcome;
      await tester.runAsync(() async {
        outcome = await vm.continueToChat();
      });
      expect(outcome, HistoryContinueOutcome.switched);
      expect(r.ch.count('session_switch'), 1);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text(_chatMarker), findsOneWidget);
      expect(r.prefs.selectedPeerEpk, testEpk);
      expect(r.prefs.selectedRoomId, testRoom);
      expect(r.ch.count('user_message'), 0);
    },
  );
}
