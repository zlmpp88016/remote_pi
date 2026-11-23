// Plan 86: synthetic, test-only profile entry. No production bootstrap, network,
// preferences, pairing keys or user database. Runtime PASS belongs to the device.
import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:ui' show FramePhase, FrameTiming, PlatformDispatcher;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:hive/hive.dart';
import 'package:mobile/data/local/boxes.dart';
import 'package:mobile/data/local/records/message_record.dart';
import 'package:mobile/data/repositories/session_read_repository.dart';
import 'package:mobile/data/sync/sync_service.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/domain/session_state.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/chat/chat_page.dart';
import 'package:mobile/ui/chat/render_metrics.dart';
import 'package:mobile/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:mobile/ui/core/themes/themes.dart';

import 'p5_frame_fence.dart';
import 'p87_capture_gate.dart';

void _log(String fields) => debugPrintSynchronously('[p86p5] $fields');
void _check(bool value, String criterion) {
  if (!value) throw StateError(criterion);
}

Future<void> _until(bool Function() predicate, String criterion) async {
  final clock = Stopwatch()..start();
  while (!predicate()) {
    if (clock.elapsed > const Duration(seconds: 10)) {
      throw StateError('timeout_$criterion');
    }
    await Future<void>.delayed(const Duration(milliseconds: 2));
  }
}

class _Channel implements IChannel, IControlLink {
  final inbound = StreamController<ServerMessage>.broadcast();
  final control = StreamController<ControlInbound>.broadcast();
  final sent = <ClientMessage>[];
  @override
  Stream<ServerMessage> get serverMessages => inbound.stream;
  @override
  Stream<ControlInbound> get controlFrames => control.stream;
  @override
  Future<void> send(ClientMessage message) async => sent.add(message);
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> close() async {
    await inbound.close();
    await control.close();
  }
}

class _Storage extends PairingStorage {
  @override
  Future<List<PeerRecord>> listPeers() async => const [];
  @override
  Future<List<PersistedRoom>> loadRooms(String remoteEpk) async => const [];
  @override
  Future<void> saveRooms(String remoteEpk, List<PersistedRoom> rooms) async {}
}

final _messages = ValueNotifier<List<ChatMessage>>(const []);
final _phase = ValueNotifier<String>('Preparing synthetic P5 profile');
final _frameFence = P5FrameFence();
int _revision = 0;

class _Transcript extends StatelessWidget {
  const _Transcript();
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: _messages,
    builder: (context, messages, _) {
      final revision = _revision;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _frameFence.contentFrame(
          revision,
          PlatformDispatcher.instance.frameData.frameNumber,
          developer.Timeline.now,
        );
      });
      return ChatTranscriptList(
        messages: messages,
        streaming: null,
        onDecide: (_, _) {},
        hasOlder: false,
        onLoadOlder: () {},
      );
    },
  );
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!const bool.fromEnvironment('REMOTE_PI_HISTORY_PERF') || !kProfileMode) {
    throw StateError('P5_requires_opt_in_profile');
  }
  final gate = P87CaptureGate(suite: 'p5')..install();
  SchedulerBinding.instance.addPersistentFrameCallback((_) {
    _frameFence.observeFrame(
      PlatformDispatcher.instance.frameData.frameNumber,
      SchedulerBinding.instance.currentSystemFrameTimeStamp.inMicroseconds,
    );
  });
  ChatRenderMetrics.enabled = true;
  ChatRenderMetrics.reset();
  runApp(
    MaterialApp(
      theme: buildDarkTheme(),
      home: Scaffold(
        appBar: AppBar(
          title: ValueListenableBuilder(
            valueListenable: _phase,
            builder: (_, value, _) => Text(value),
          ),
        ),
        body: const _Transcript(),
      ),
    ),
  );
  try {
    await gate.waitForStart();
    final result = await _run();
    gate.complete(result);
    await gate.waitForExport();
    _phase.value = 'Synthetic P5 complete — inspect trace';
    _log('phase=complete status=PASS synthetic=1 network=0');
  } catch (error, stack) {
    _phase.value = 'Synthetic P5 failed — inspect trace';
    _log('phase=complete status=FAIL synthetic=1 network=0');
    if (gate.state == 'capturing') {
      gate.complete(_frameFence.toJson(), error: 'p5_incomplete');
    }
    // Preserve the actual error and stack; failure must never masquerade as PASS.
    Error.throwWithStackTrace(error, stack);
  }
}

Future<Map<String, Object?>> _run() async {
  const epk = 'cDg2cDVzeW50aGV0aWM=';
  const room = 'main';
  final dir = await Directory.systemTemp.createTemp('rp_p86_p5_');
  final channel = _Channel();
  final storage = _Storage();
  final conn = ConnectionManager(
    factory: (_, _) async => channel,
    storage: storage,
    emitDebounce: Duration.zero,
  );
  await LocalBoxes.initForTest(dir.path);
  final boxes = LocalBoxes();
  final sync = SyncService(conn, boxes);
  StreamSubscription<dynamic>? writeSub;
  StreamSubscription<dynamic>? readSub;
  StreamSubscription<dynamic>? batchSub;
  var writes = 0;
  var existingWrites = 0;
  var emits = 0;
  var completions = 0;
  var lastBatchCompleteUs = 0;
  var frames = 0;
  var maxBuildUs = 0;
  var maxRasterUs = 0;
  void onTimings(List<FrameTiming> values) {
    _frameFence.deliver([
      for (final t in values)
        P5FrameSample(
          vsyncUs: t.timestampInMicroseconds(FramePhase.vsyncStart),
          buildStartUs: t.timestampInMicroseconds(FramePhase.buildStart),
          buildFinishUs: t.timestampInMicroseconds(FramePhase.buildFinish),
          rasterStartUs: t.timestampInMicroseconds(FramePhase.rasterStart),
          rasterFinishUs: t.timestampInMicroseconds(FramePhase.rasterFinish),
          frameNumber: t.frameNumber,
        ),
    ], developer.Timeline.now);
    for (final timing in values) {
      frames++;
      if (timing.buildDuration.inMicroseconds > maxBuildUs) {
        maxBuildUs = timing.buildDuration.inMicroseconds;
      }
      if (timing.rasterDuration.inMicroseconds > maxRasterUs) {
        maxRasterUs = timing.rasterDuration.inMicroseconds;
      }
    }
  }

  SchedulerBinding.instance.addTimingsCallback(onTimings);
  try {
    await sync.activate(epk, room);
    conn.adopt(
      channel,
      PeerRecord(
        remoteEpk: epk,
        sessionName: 'Synthetic P5',
        relayUrl: 'ws://synthetic.invalid',
        pairedAt: '2026-01-01T00:00:00Z',
      ),
    );
    await _until(
      () => sync.activeEpk == epk && boxes.isMsgsBoxOpen(epk, room),
      'binding',
    );
    channel.control.add(
      RoomAnnounced(peer: epk, roomId: room, startedAt: 1, cwd: '/synthetic'),
    );
    await _until(() => conn.isRoomLive(epk, room), 'room');
    final box = boxes.openMsgsBox(epk, room);
    final knownKeys = box.keys.toSet();
    writeSub = box.watch().listen((event) {
      writes++;
      if (!knownKeys.add(event.key)) existingWrites++;
    });
    batchSub = boxes.messageBatch(epk, room).completions.stream.listen((
      complete,
    ) {
      _check(complete, 'batch_incomplete');
      lastBatchCompleteUs = developer.Timeline.now;
      completions++;
    });
    final projection = ChatMessageProjection();
    var rows = <MessageRecord>[];
    readSub = SessionReadRepository(boxes).watchMessages(epk, room).listen((
      snapshot,
    ) {
      final snapshotUs = developer.Timeline.now;
      rows = snapshot;
      emits++;
      _revision++;
      developer.Timeline.startSync(
        'p87_projection',
        arguments: {'revision': _revision, 'rows': snapshot.length},
      );
      try {
        _messages.value = projection.project(snapshot);
      } finally {
        developer.Timeline.finishSync();
      }
      developer.Timeline.instantSync(
        'p87_snapshot_projected',
        arguments: {
          'revision': _revision,
          'snapshot_us': snapshotUs,
          'projection_complete_us': developer.Timeline.now,
        },
      );
    });
    await _until(() => emits == 1, 'initial_snapshot');
    await _frame();
    final head = <SessionHistoryEvent>[
      for (var i = 0; i < 99; i++)
        UserInputEvt(ts: i + 100, id: 'u$i', text: 'Synthetic row $i'),
      const AgentMessageEvt(ts: 199, inReplyTo: 'a99', text: '**alpha**'),
    ];
    SessionHistory history(String id, List<SessionHistoryEvent> events) =>
        SessionHistory(
          inReplyTo: id,
          sessionStartedAt: 0,
          events: events,
          eos: true,
          hasOlder: true,
          olderCursor: 'synthetic_cursor',
        );

    Future<void> apply(String phase, SessionHistory message, int count) async {
      _phase.value = 'Synthetic P5: $phase';
      final completed = completions;
      final startWrites = writes;
      final startExistingWrites = existingWrites;
      final startEmits = emits;
      final startMetrics = Map<String, int>.of(ChatRenderMetrics.snapshot);
      final openFrameNumber = await _nextFrame();
      final startRevision = _revision;
      final expectedRevision = startRevision + (phase == 'duplicate' ? 0 : 1);
      final clock = Stopwatch()..start();
      final enqueueUs = developer.Timeline.now;
      final task = developer.TimelineTask()..start('p86p5_$phase');
      try {
        channel.inbound.add(message);
        // Batch completion includes duplicate reconciliation, but excludes
        // later writer index/label work. Do not infer it from a quiet delay.
        await _until(
          () =>
              completions > completed &&
              !boxes.messageBatch(epk, room).active &&
              rows.length == count &&
              _revision == expectedRevision,
          '${phase}_queue',
        );
        // The publication boundary is not queue-idle; record it separately.
        final batchCompleteUs = lastBatchCompleteUs;
        _check(_revision == expectedRevision, '${phase}_expected_revision');
        // Retain the legacy dispatch -> queue observation -> framework-frame
        // aggregate for comparisons. Target attribution is independently exact.
        if (phase != 'duplicate') {
          await _frame();
        }
        final target = phase == 'duplicate'
            ? (
                frameNumber: await _nextFrame(),
                postFrameUs: developer.Timeline.now,
              )
            : await _frameFence.frameRevision(expectedRevision);
        final queueFrameUs = clock.elapsedMicroseconds;
        final closeFrameNumber = await _nextFrame();
        // Engine timing delivery is batched. Extra frames only drain delivery;
        // they lie after closeFrameNumber and never become phase content frames.
        final drain = Timer.periodic(const Duration(milliseconds: 100), (_) {
          SchedulerBinding.instance.scheduleFrame();
        });
        final Map<String, Object> sealed;
        try {
          sealed = await _frameFence.sealFrames(
            name: phase,
            openFrame: openFrameNumber,
            targetFrame: target.frameNumber,
            closeFrame: closeFrameNumber,
            revision: expectedRevision,
            observationOnly: phase == 'duplicate',
          );
        } finally {
          drain.cancel();
        }
        sealed.addAll({
          'enqueue_us': enqueueUs,
          'batch_complete_us': batchCompleteUs,
          'content_post_frame_us': target.postFrameUs,
          'timing_delivery_complete_us': developer.Timeline.now,
          'queue_frame_us': queueFrameUs,
        });
        developer.Timeline.instantSync(
          'p87_phase_sealed',
          arguments: {
            'phase': phase,
            'target_vsync_us': sealed['target_vsync_us']!,
            'close_vsync_us': sealed['close_vsync_us']!,
          },
        );
        final phaseTimings = _frameFence.raw
            .where(
              (t) =>
                  t.vsyncUs > (sealed['open_vsync_us'] as int) &&
                  t.vsyncUs <= (sealed['close_vsync_us'] as int),
            )
            .toList();
        final phaseBuildUs = phaseTimings
            .map((t) => t.buildUs)
            .reduce((a, b) => a > b ? a : b);
        final phaseRasterUs = phaseTimings
            .map((t) => t.rasterUs)
            .reduce((a, b) => a > b ? a : b);
        _log(
          'phase=$phase queue_frame_us=$queueFrameUs rows=${rows.length} writes=${writes - startWrites} existing_writes=${existingWrites - startExistingWrites} emits=${emits - startEmits} cumulative_writes=$writes cumulative_emits=$emits frames=${phaseTimings.length} max_build_us=$phaseBuildUs max_raster_us=$phaseRasterUs ${ChatRenderMetrics.snapshot.entries.map((e) => '${e.key}=${e.value - startMetrics[e.key]!}').join(' ')}',
        );
      } finally {
        task.finish();
      }
    }

    final syncStart = channel.sent.length;
    sync.requestSync();
    await _until(
      () => channel.sent.skip(syncStart).whereType<SessionSync>().isNotEmpty,
      'head_request',
    );
    final headRequest = channel.sent
        .skip(syncStart)
        .whereType<SessionSync>()
        .last;
    await apply('apply100', history(headRequest.id, head), 100);
    _check(writes == 100 && emits <= 2 && emits == 2, 'apply100_counts');
    _check(ChatRenderMetrics.projections == 100, 'apply100_projections');
    _check(
      ChatRenderMetrics.assistantBuilds > 0 &&
          ChatRenderMetrics.markdownCreations > 0,
      'actual_markdown_render',
    );
    final originals = {
      for (final key in box.keys) key: jsonEncode(box.get(key)),
    };
    final beforePrepend = _messages.value;
    final sentBefore = channel.sent.length;
    sync.requestOlderPage();
    await _until(
      () => channel.sent.skip(sentBefore).whereType<SessionSync>().isNotEmpty,
      'older_request',
    );
    final request = channel.sent.skip(sentBefore).whereType<SessionSync>().last;
    const older = UserInputEvt(ts: 1, id: 'older', text: 'Synthetic older');
    await apply('prepend', history(request.id, [older, head.first]), 101);
    _check(
      writes == 101 && existingWrites == 0 && emits == 3,
      'prepend_counts',
    );
    _check(rows.first.seq == -1 && rows.first.id == 'older', 'prepend_order');
    for (final entry in originals.entries) {
      _check(
        jsonEncode(box.get(entry.key)) == entry.value,
        'prepend_preserves_bytes_keys',
      );
    }
    for (var i = 0; i < beforePrepend.length; i++) {
      _check(
        identical(beforePrepend[i], _messages.value[i + 1]),
        'prepend_projection_identity',
      );
    }
    final all = <SessionHistoryEvent>[older, ...head];
    final beforeDuplicate = Map<String, int>.of(ChatRenderMetrics.snapshot);
    final duplicateList = _messages.value;
    await apply('duplicate', history('duplicate', all), 101);
    _check(
      writes == 101 && emits == 3 && existingWrites == 0,
      'duplicate_zero_writes_emits',
    );
    _check(
      identical(duplicateList, _messages.value),
      'duplicate_list_identity',
    );
    for (final entry in beforeDuplicate.entries) {
      _check(
        ChatRenderMetrics.snapshot[entry.key] == entry.value,
        'duplicate_render_unchanged',
      );
    }
    final beforeChange = _messages.value;
    final metricsBefore = Map<String, int>.of(ChatRenderMetrics.snapshot);
    await apply(
      'same_length',
      history('changed', [
        older,
        ...head.take(99),
        const AgentMessageEvt(ts: 199, inReplyTo: 'a99', text: '**bravo**'),
      ]),
      101,
    );
    _check(writes == 102 && existingWrites == 1 && emits == 4, 'change_counts');
    for (var i = 0; i < beforeChange.length - 1; i++) {
      _check(
        identical(beforeChange[i], _messages.value[i]),
        'unchanged_projection_identity',
      );
    }
    _check(
      (_messages.value.last as AssistantMsg).text == '**bravo**',
      'same_length_text',
    );
    _check(
      ChatRenderMetrics.projections == metricsBefore['projections']! + 1,
      'only_changed_projection',
    );
    _check(
      ChatRenderMetrics.assistantBuilds ==
          metricsBefore['assistantBuilds']! + 1,
      'only_changed_bubble',
    );
    _check(
      ChatRenderMetrics.userBuilds == metricsBefore['userBuilds'],
      'unchanged_user_builds',
    );
    _check(
      ChatRenderMetrics.markdownCreations ==
          metricsBefore['markdownCreations']! + 1,
      'only_changed_markdown',
    );
    // Every phase already awaited its target AND closing timing. Earlier
    // delivery can no longer allow a final late content frame to escape.
    _log(
      'phase=timings samples=$frames max_build_us=$maxBuildUs max_raster_us=$maxRasterUs',
    );
    return {
      ..._frameFence.toJson(),
      'assertions_passed': true,
      'writes': writes,
      'emits': emits,
      'synthetic': true,
      'network': false,
    };
  } finally {
    SchedulerBinding.instance.removeTimingsCallback(onTimings);
    await readSub?.cancel();
    await writeSub?.cancel();
    await batchSub?.cancel();
    sync.dispose();
    conn.dispose();
    await channel.close();
    storage.dispose();
    await Hive.close();
    await dir.delete(recursive: true);
  }
}

Future<void> _frame() async {
  await _nextFrame();
}

Future<int> _nextFrame() {
  final done = Completer<int>();
  final binding = SchedulerBinding.instance;
  binding.addPostFrameCallback((_) {
    done.complete(PlatformDispatcher.instance.frameData.frameNumber);
  });
  binding.scheduleFrame();
  return done.future.timeout(const Duration(seconds: 10));
}
