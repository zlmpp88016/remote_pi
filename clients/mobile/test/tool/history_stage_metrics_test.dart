import 'dart:convert';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/history/history_body_loader.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/history/history_list_page.dart';
import 'package:mobile/ui/history/history_viewer_page.dart';
import 'package:mobile/ui/history/history_viewport_metrics.dart';
import 'package:mobile/ui/history/states/history_list_state.dart';
import 'package:mobile/ui/history/states/history_viewer_state.dart';
import 'package:mobile/ui/history/viewmodels/history_list_viewmodel.dart';
import 'package:mobile/ui/history/viewmodels/history_viewer_viewmodel.dart';
import 'package:mobile/ui/workspaces/states/workspace_list_state.dart';
import 'package:mobile/ui/workspaces/viewmodels/workspace_list_viewmodel.dart';
import 'package:mobile/ui/workspaces/workspace_list_page.dart';

import '../ui/history/history_test_rig.dart';

void main() {
  setUp(() {
    HistoryStageMetrics.samples.clear();
    HistoryStageMetrics.dropped = 0;
  });
  tearDown(() {
    HistoryStageMetrics.enabled = false;
  });
  test(
    'stage clock is opt-in and loss is explicit with scalar-only fields',
    () async {
      expect(HistoryStageMetrics.begin('history_list'), isNull);
      HistoryStageMetrics.enabled = true;
      final stage = HistoryStageMetrics.begin('history_list')!;
      await HistoryStageMetrics.request(stage, () async {
        expect(HistoryStageMetrics.current, same(stage));
        stage.mark('send_begin_us');
      });
      expect(HistoryStageMetrics.current, isNull);
      for (var i = 0; i < 256; i++) {
        HistoryStageMetrics.begin('history_read');
      }
      expect(HistoryStageMetrics.samples.length, 256);
      expect(HistoryStageMetrics.dropped, 1);
      final text = jsonEncode(HistoryStageMetrics.export());
      expect(text, contains('overlaps queue_ms and wire_ms'));
      expect(text, isNot(contains('epk_A')));
    },
  );
  for (final path in ['history_list', 'history_read']) {
    test('$path retries retain the original intent until refresh', () async {
      HistoryStageMetrics.enabled = true;
      final r = await buildHistoryRig();
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      var calls = 0;
      r.ch.handler = (msg) async {
        if (msg is HistoryListRequest && path == 'history_list' ||
            msg is HistoryReadRequest && path == 'history_read') {
          calls++;
          final id = msg is HistoryListRequest
              ? msg.id
              : (msg as HistoryReadRequest).id;
          if (calls == 1) {
            return historyError(
              id,
              HistoryErrorCodeWire.building,
              retryAfterMs: 25,
            );
          }
          if (msg is HistoryListRequest) {
            return HistoryListOk(
              listWire(id: id, sessions: [wireSession('s-1')]),
            );
          }
          return HistoryReadOk(readWire(id: id, items: [userItem('u1')]));
        }
        return null;
      };
      HistoryListViewModel? list;
      HistoryViewerViewModel? read;
      if (path == 'history_list') {
        list = HistoryListViewModel(r.repo, epk: testEpk, daemonId: testDaemon);
        addTearDown(list.dispose);
      } else {
        read = HistoryViewerViewModel(
          r.repo,
          HistoryBodyLoader(r.repo),
          r.conn,
          r.prefs,
          epk: testEpk,
          daemonId: testDaemon,
          sessionId: 's-1',
        );
        addTearDown(read.dispose);
      }
      await waitUntil(
        () => list?.viewportStage != null || read?.viewportStage != null,
      );
      final attempts = HistoryStageMetrics.samples
          .where((s) => s.path == path)
          .toList();
      expect(calls, 2);
      expect(attempts, hasLength(2));
      expect(
        attempts.last.fields['intent_us'],
        attempts.first.fields['intent_us'],
        reason: 'cold-build backoff belongs to the opening intent',
      );
      expect(
        attempts.last.fields['request_us'],
        greaterThan(attempts.first.fields['request_us']!),
      );
      expect(list?.viewportStage ?? read?.viewportStage, same(attempts.last));

      if (list != null) {
        await list.refresh();
      } else {
        await read!.refresh();
      }
      final refreshed = HistoryStageMetrics.samples.last;
      expect(refreshed.path, path);
      expect(
        refreshed.fields['intent_us'],
        greaterThan(attempts.first.fields['intent_us']!),
        reason: 'an explicit refresh starts a new user intent',
      );
      expect(calls, 3);
    });
  }
  testWidgets(
    'three ready-state frames retain typed transport stages and wait for matching raster',
    (tester) async {
      HistoryStageMetrics.enabled = true;
      HistoryViewportMetrics.install();
      late HistoryRig r;
      await tester.runAsync(() async {
        r = await buildHistoryRig();
      });
      addTearDown(r.dispose);
      addTearDown(r.ch.close);
      r.ch.handler = (msg) async => switch (msg) {
        WorkspaceList(:final id) => WorkspaceListOk(
          inReplyTo: id,
          workspaces: const [
            WireWorkspaceInfo(
              cwd: '/synthetic',
              daemonId: 'd1',
              roomId: 'r1',
              name: 'directory',
              live: false,
              daemon: true,
            ),
          ],
        ),
        HistoryListRequest(:final id) => HistoryListOk(
          listWire(
            id: id,
            sessions: [wireSession('s-1', name: 'listed')],
          ),
        ),
        HistoryReadRequest(:final id) => HistoryReadOk(
          readWire(
            id: id,
            items: [userItem('u1', text: 'content')],
          ),
        ),
        _ => null,
      };
      late WorkspaceListViewModel directory;
      late HistoryListViewModel list;
      late HistoryViewerViewModel read;
      await tester.runAsync(() async {
        directory = WorkspaceListViewModel(SessionCatalog(r.conn));
        list = HistoryListViewModel(r.repo, epk: testEpk, daemonId: testDaemon);
        read = HistoryViewerViewModel(
          r.repo,
          HistoryBodyLoader(r.repo),
          r.conn,
          r.prefs,
          epk: testEpk,
          daemonId: testDaemon,
          sessionId: 's-1',
        );
        await waitUntil(
          () =>
              directory.state is WorkspaceListReady &&
              list.state is HistoryListReady &&
              read.state is HistoryViewerReady,
        );
      });
      addTearDown(directory.dispose);
      addTearDown(list.dispose);
      addTearDown(read.dispose);
      final pages = <Widget>[
        ChangeNotifierProvider.value(
          value: directory,
          child: const WorkspaceListPage(epk: testEpk, title: 'test'),
        ),
        ChangeNotifierProvider.value(
          value: list,
          child: const HistoryListPage(
            epk: testEpk,
            daemonId: testDaemon,
            title: 'test',
          ),
        ),
        ChangeNotifierProvider.value(
          value: read,
          child: const HistoryViewerPage(
            epk: testEpk,
            daemonId: testDaemon,
            sessionId: 's-1',
            title: 'test',
          ),
        ),
      ];
      for (final page in pages) {
        await tester.pumpWidget(
          MaterialApp(theme: buildDarkTheme(), home: page),
        );
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(HistoryStageMetrics.samples.map((s) => s.path), [
        'registered_workspace_directory',
        'history_list',
        'history_read',
      ]);
      var frameNumber = 100;
      for (final stage in HistoryStageMetrics.samples) {
        HistoryViewportMetrics.reportFrame(
          stage,
          frameNumber: frameNumber++,
          frameworkTargetUs: 2667401922,
        );
        for (final k in [
          'intent_us',
          'request_us',
          'transport_request_us',
          'send_begin_us',
          'send_complete_us',
          'typed_reply_us',
          'map_begin_us',
          'state_apply_us',
          'real_post_frame_us',
          'viewport_framework_target_us',
          'viewport_frame_number',
        ]) {
          expect(stage.fields[k], isNotNull, reason: '${stage.path}:$k');
        }
        expect(stage.fields['viewport_raster_finish_us'], isNull);
      }
      final timings = HistoryStageMetrics.samples.map((s) {
        final v = s.fields['viewport_framework_target_us']! - 16667;
        return FrameTiming(
          vsyncStart: v,
          buildStart: v + 1,
          buildFinish: v + 2,
          rasterStart: v + 3,
          rasterFinish: v + 4,
          rasterFinishWallTime: 0,
          frameNumber: s.fields['viewport_frame_number']!,
        );
      }).toList();
      tester.binding.platformDispatcher.onReportTimings!([
        FrameTiming(
          vsyncStart: 2667401922,
          buildStart: 2667401923,
          buildFinish: 2667401924,
          rasterStart: 2667401925,
          rasterFinish: 2667401926,
          rasterFinishWallTime: 0,
          frameNumber: 999,
        ),
      ]);
      expect(
        HistoryStageMetrics.samples.every(
          (s) => s.fields['viewport_raster_finish_us'] == null,
        ),
        isTrue,
      );
      tester.binding.platformDispatcher.onReportTimings!(timings);
      for (final stage in HistoryStageMetrics.samples) {
        expect(
          stage.fields['viewport_raster_finish_us'],
          stage.fields['viewport_vsync_us']! + 4,
        );
      }
      expect(r.ch.count('workspace_start'), 0);
      expect(r.ch.count('session_switch'), 0);
      expect(r.metrics.samples.every((s) => s.decodeApplyMs != null), isTrue);
    },
  );
}
