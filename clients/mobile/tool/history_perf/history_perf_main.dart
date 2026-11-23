// Plan 86 #46 — profile-mode observability seam. TEST-ONLY, never shipped.
//
// Selected with `-t tool/history_perf/history_perf_main.dart` AND
// `--dart-define=REMOTE_PI_HISTORY_PERF=true`; without the define it just runs
// `production.main()` and prints nothing.
//
// It runs the production bootstrap unchanged (LocalBoxes + setupDependencies +
// real `RemotePiApp` router/transport/pairing) and only *observes* it, because
// `HistoryMetricSample` reaches logcat in debug builds only:
//   * `HistoryRepository.metrics.samples` — the P4 read-only ring;
//   * the ACTIVE session's Hive msgs box (`box.watch()`) — P5 row writes:
//     new physical keys vs rewrites of pre-existing keys, repeated events;
//   * `ChatRenderMetrics` — the actual ChatViewModel projection-input snapshot
//     count (`SessionReadRepository.watchMessages` emissions consumed by the
//     VM). This is a projection-input counter, NOT a frame/render count;
//   * `SchedulerBinding` frame timings — production build/raster ms.
//
// P5 key contract: the Hive key is a stable nonnegative PHYSICAL KEY; display
// order is the signed `MessageRecord.seq`. Key order is never read as order, so
// a low key is not "an old row" and a new key below the previous maximum is not
// "a prepend". Pre-existing keys are seeded at attach, so writes to them are
// reported separately from writes that create new keys.
//
// Switching the active peer/room cancels the old observation, resets the
// counters and seeds the newly focused box — events are never attributed to a
// box they did not come from.
//
// Printed fields are scalars/ids/counts only: op names, ms, cache flags, item
// and row counts. No message text, token, ciphertext, pairing URI, path, peer
// or room identifier.
//
// Capture: `adb logcat -s flutter | grep p86perf`.
//
// ignore_for_file: avoid_print

import 'dart:async';
import 'dart:developer' as developer;
import 'dart:ui' show FramePhase, PlatformDispatcher;

import 'package:flutter/foundation.dart'
    show kDebugMode, kProfileMode, kReleaseMode;
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart'
    show WidgetsBinding, WidgetsFlutterBinding;
import 'package:hive/hive.dart' show BoxEvent;
import 'package:mobile/config/dependencies.dart';
import 'package:mobile/data/local/boxes.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';
import 'package:mobile/ui/history/history_viewport_metrics.dart';
import 'package:mobile/main.dart' as production;
import 'package:mobile/ui/chat/render_metrics.dart';

import 'p86_tally.dart';
import 'p86_fixture_prefill.dart';
import 'p5_frame_fence.dart';
import 'p87_capture_gate.dart';

const bool _enabled = bool.fromEnvironment('REMOTE_PI_HISTORY_PERF');
const String _tag = '[p86perf]';
const int _tickMs = 500;
const int _windowMs = 5000;
const int _slowFrameUs = 16700;

Future<void> main() async {
  if (!_enabled) {
    production.main();
    return;
  }

  if (!kProfileMode) throw StateError('browse_requires_opt_in_profile');
  final gate = P87CaptureGate(suite: 'browse')..install();
  gate.onFinish = () => unawaited(_finishBrowse(gate));
  // `production.main()` is declared `void` (it awaits inside), so it cannot be
  // awaited here. Ordering is still safe: its bootstrap (boxes + DI, committed
  // before `runApp`) finishes before the first frame, so the post-frame probes
  // below resolve a committed injector. Cost: frame 1 is not measured.
  WidgetsFlutterBinding.ensureInitialized();
  HistoryStageMetrics.enabled = true;
  HistoryViewportMetrics.install();
  SchedulerBinding.instance.addPersistentFrameCallback((_) {
    _browseFrames.observeFrame(
      PlatformDispatcher.instance.frameData.frameNumber,
      SchedulerBinding.instance.currentSystemFrameTimeStamp.inMicroseconds,
    );
  });
  SchedulerBinding.instance.addTimingsCallback((values) {
    _browseFrames.deliver([
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
  });
  await gate.waitForStart();
  // Enabled before the production bootstrap so no inbox/chat attach is missed.
  // `ChatRenderMetrics.messageSnapshots` counts the projection input snapshots
  // the ChatViewModel actually consumes from `watchMessages` — it is not a
  // frame or render counter and must never be labelled as an emit estimate.
  ChatRenderMetrics.enabled = true;
  ChatRenderMetrics.reset();
  print(
    '$_tag probe on mode=${_modeName()}'
    ' tick_ms=$_tickMs window_ms=$_windowMs'
    ' slow_frame_ms=${(_slowFrameUs / 1000).toStringAsFixed(1)}',
  );
  WidgetsBinding.instance.addPostFrameCallback((_) {
    _installFrameProbe();
    _installHistoryProbe();
    _installMsgsProbe();
    installFixturePrefill(
      perf: _enabled,
      origin: const String.fromEnvironment('REMOTE_PI_HISTORY_FIXTURE'),
      autoSubmit: const bool.fromEnvironment('REMOTE_PI_HISTORY_ISOLATED_BOOT'),
      report: (ready) =>
          print('$_tag fixture_prefill${ready ? 'ready' : 'failure'}'),
    );
  });

  // Start selecting before bootstrap: no genuine bootstrap frame can be
  // skipped merely because its timing is slow or not yet delivered.
  final opening = _browseFrames.openingFrame();
  production.main();
  try {
    _browseOpenFrame = await opening;
  } catch (_) {
    if (gate.state == 'capturing') {
      gate.complete({
        'stages': HistoryStageMetrics.export(),
        'frames': _browseFrames.toJson(),
      }, error: 'browse_opening_incomplete');
    }
  }
}

final _browseFrames = P5FrameFence();
int? _browseOpenFrame;

Future<int> _browseFrame() {
  final done = Completer<int>();
  SchedulerBinding.instance.addPostFrameCallback((_) {
    done.complete(PlatformDispatcher.instance.frameData.frameNumber);
  });
  SchedulerBinding.instance.scheduleFrame();
  return done.future.timeout(const Duration(seconds: 10));
}

Future<void> _finishBrowse(P87CaptureGate gate) async {
  try {
    final close = await _browseFrame();
    final opening = _browseOpenFrame;
    if (opening == null) throw StateError('browse_opening_not_ready');
    final open =
        _browseFrames.observedFrames.keys
            .where((v) => v >= opening && v < close)
            .toList()
          ..sort();
    if (open.length < 2) throw StateError('no_browse_frames');
    final drain = Timer.periodic(const Duration(milliseconds: 100), (_) {
      SchedulerBinding.instance.scheduleFrame();
    });
    try {
      await _browseFrames.sealFrames(
        name: 'browse',
        openFrame: opening,
        targetFrame: open.last,
        closeFrame: close,
        revision: 0,
        observationOnly: true,
      );
    } finally {
      drain.cancel();
    }
    gate.complete({
      'stages': HistoryStageMetrics.export(),
      'frames': _browseFrames.toJson(),
    });
    await gate.waitForExport();
  } catch (_) {
    if (gate.state == 'capturing') {
      gate.complete({
        'stages': HistoryStageMetrics.export(),
        'frames': _browseFrames.toJson(),
      }, error: 'browse_incomplete');
    }
  }
}

String _modeName() {
  if (kProfileMode) return 'profile';
  if (kReleaseMode) return 'release';
  return kDebugMode ? 'debug' : 'unknown';
}

// ---------------------------------------------------------------------------
// P4 read-only history ring
// ---------------------------------------------------------------------------

void _installHistoryProbe() {
  final tail = HistoryMetricsTail();
  final repo = injector.get<HistoryRepository>();

  Timer.periodic(const Duration(milliseconds: _tickMs), (_) {
    final result = tail.drain(repo.metrics.samples);
    if (result.dropped) {
      // More than the ring capacity arrived between two drains: the number
      // lost is unknown, so say so instead of guessing.
      print('$_tag metrics dropped=unknown reason=ring_evicted_cursor');
    }
    for (final sample in result.fresh) {
      _printSample(sample);
    }
  });
}

void _printSample(HistoryMetricSample s) {
  print(
    '$_tag hist t=${DateTime.now().millisecondsSinceEpoch}'
    ' op=${s.op}'
    ' queue_ms=${_ms(s.queueMs)}'
    ' wire_ms=${_ms(s.wireMs)}'
    ' decode_apply_ms=${_ms(s.decodeApplyMs)}'
    ' decode_apply_definition=request_through_apply_overlaps_queue_wire'
    ' first_content_ms=${_ms(s.firstContentMs)}'
    ' cache_hit=${_flag(s.cacheHit)}'
    ' items=${s.items ?? '-'}',
  );
}

/// `unknown` stays `-`, never a fabricated 0 (same rule as the model).
String _ms(int? value) => value == null ? '-' : '$value';
String _flag(bool? value) => value == null ? '-' : (value ? '1' : '0');

// ---------------------------------------------------------------------------
// P5 row-write + ChatVM projection-input counters for the ACTIVE msgs box
// ---------------------------------------------------------------------------

void _installMsgsProbe() {
  final boxes = injector.get<LocalBoxes>();
  final conn = injector.get<ConnectionManager>();
  final switch_ = MsgsObservationSwitch();
  StreamSubscription<BoxEvent>? sub;
  MsgsWriteTally? tally;
  var lastRows = '';
  var lastRender = '';
  var ticks = 0;

  void resetCounters() {
    ChatRenderMetrics.reset();
    lastRows = '';
    lastRender = '';
    ticks = 0;
  }

  Timer.periodic(const Duration(milliseconds: _tickMs), (_) {
    // The box name embeds epk+room; identifiers are compared, never printed.
    final epk = conn.activePeer?.remoteEpk;
    final room = conn.activeRoomId;
    final open = epk != null && boxes.isMsgsBoxOpen(epk, room);
    final action = switch_.observe(epk: epk, room: room, boxOpen: open);

    if (action.detach) {
      final closing = tally;
      if (closing != null) _printRows('final', closing);
      sub?.cancel();
      sub = null;
      tally = null;
      resetCounters();
      // Rewritten counts are dropped with the box: a switch is a new window.
      print('$_tag rows detached reason=${action.attach ? 'rebind' : 'none'}');
    }

    if (action.attach) {
      final target = switch_.attached!;
      final box = boxes.openMsgsBox(target.$1, target.$2);
      final fresh = MsgsWriteTally();
      // Seed the keys that already exist so puts to them count as rewrites,
      // not as newly created rows. Keys only — no values are read.
      final seeded = fresh.seedExisting(box.keys.whereType<int>());
      tally = fresh;
      ChatRenderMetrics.enabled = true;
      resetCounters();
      sub = box.watch().listen(
        (event) => fresh.onEvent(event.key, event.deleted),
      );
      print(
        '$_tag rows attached seeded=$seeded'
        ' window_ms=$_windowMs reset=render+rows',
      );
      return;
    }

    final current = tally;
    if (current == null) return;
    if (++ticks % (_windowMs ~/ _tickMs) != 0) return;

    final rows = _rowsFields(current);
    if (rows != lastRows) {
      lastRows = rows;
      _printRows('window', current);
    }
    final render = _renderFields();
    if (render != lastRender) {
      lastRender = render;
      print(
        '$_tag render t=${DateTime.now().millisecondsSinceEpoch}'
        ' $render src=chatvm_projection_inputs',
      );
    }
  });
}

String _rowsFields(MsgsWriteTally t) =>
    'puts=${t.puts}'
    ' new_keys=${t.inserts}'
    ' existing_writes=${t.existingWrites}'
    ' dup=${t.duplicates}'
    ' del=${t.deletes}'
    ' distinct=${t.distinctKeys}'
    ' seeded=${t.seededKeys}';

void _printRows(String phase, MsgsWriteTally t) {
  print(
    '$_tag rows t=${DateTime.now().millisecondsSinceEpoch}'
    ' phase=$phase ${_rowsFields(t)}',
  );
}

/// Actual ChatViewModel projection-input snapshots (per `watchMessages`
/// emission the VM consumes) plus the derived projection/build counters.
String _renderFields() {
  final m = ChatRenderMetrics.snapshot;
  return 'snapshots=${m['messageSnapshots']}'
      ' projections=${m['projections']}'
      ' grouping=${m['groupingPasses']}'
      ' user=${m['userBuilds']}'
      ' assistant=${m['assistantBuilds']}'
      ' md_builds=${m['markdownBuilds']}'
      ' md_creates=${m['markdownCreations']}';
}

// ---------------------------------------------------------------------------
// Frame timings — windowed percentiles, scalars only
// ---------------------------------------------------------------------------

void _installFrameProbe() {
  final buildUs = <int>[];
  final rasterUs = <int>[];
  var frames = 0;
  var slow = 0;

  SchedulerBinding.instance.addTimingsCallback((timings) {
    for (final timing in timings) {
      final build = timing.buildDuration.inMicroseconds;
      final raster = timing.rasterDuration.inMicroseconds;
      buildUs.add(build);
      rasterUs.add(raster);
      frames++;
      if (build + raster > _slowFrameUs) slow++;
    }
  });

  Timer.periodic(const Duration(milliseconds: _windowMs), (_) {
    if (frames == 0) return;
    print(
      '$_tag frames t=${DateTime.now().millisecondsSinceEpoch}'
      ' n=$frames'
      ' build_p50_ms=${_percentileMs(buildUs, 50)}'
      ' build_p95_ms=${_percentileMs(buildUs, 95)}'
      ' build_max_ms=${_percentileMs(buildUs, 100)}'
      ' raster_p95_ms=${_percentileMs(rasterUs, 95)}'
      ' raster_max_ms=${_percentileMs(rasterUs, 100)}'
      ' slow=$slow',
    );
    buildUs.clear();
    rasterUs.clear();
    frames = 0;
    slow = 0;
  });
}

/// [percentile] 0–100, 100 = max. Milliseconds, 2 decimals.
String _percentileMs(List<int> micros, int percentile) {
  if (micros.isEmpty) return '-';
  final sorted = List<int>.of(micros)..sort();
  var index = ((percentile * (sorted.length - 1)) / 100).round();
  if (index < 0) index = 0;
  if (index >= sorted.length) index = sorted.length - 1;
  return (sorted[index] / 1000).toStringAsFixed(2);
}
