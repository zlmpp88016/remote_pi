// Pure frame attribution. Engine timestamps, never timing-delivery time, own
// phases. Framework timestamps can be vsync TARGET time; join engine frame
// numbers to raw FrameTiming.vsyncStart instead of assuming timestamp equality.
import 'dart:async';

class P5FrameSample {
  const P5FrameSample({
    required this.vsyncUs,
    required this.buildStartUs,
    required this.buildFinishUs,
    required this.rasterStartUs,
    required this.rasterFinishUs,
    required this.frameNumber,
  });
  final int vsyncUs, buildStartUs, buildFinishUs, rasterStartUs, rasterFinishUs;
  final int frameNumber;
  int get buildUs => buildFinishUs - buildStartUs;
  int get rasterUs => rasterFinishUs - rasterStartUs;
  Map<String, int> toJson() => {
    'vsync_us': vsyncUs,
    'build_start_us': buildStartUs,
    'build_finish_us': buildFinishUs,
    'raster_start_us': rasterStartUs,
    'raster_finish_us': rasterFinishUs,
    'frame_number': frameNumber,
  };
}

class P5FrameFence {
  P5FrameFence({this.deadline = const Duration(seconds: 10)});
  final Duration deadline;
  final observed = <int>{};
  final raw = <P5FrameSample>[];
  final deliveries = <Map<String, Object>>[];
  final contents = <int, ({int vsyncUs, int postFrameUs})>{};
  final _waiters = <void Function()>{};
  final phases = <Map<String, Object>>[];
  final observedFrames = <int, int>{};
  final frameContents = <int, ({int frameNumber, int postFrameUs})>{};

  // Startup warm-up can inherit a positive dispatcher ID while the framework
  // timestamp is still zero. Select the FIRST real callback before looking for
  // its timing, so a missing/slow genuine frame cannot be skipped.
  Future<int> openingFrame() async {
    int? number;
    await _wait(() {
      for (final entry in observedFrames.entries) {
        if (entry.value > 0) {
          number ??= entry.key;
          break;
        }
      }
      return number != null && raw.any((s) => s.frameNumber == number);
    }, 'opening_engine_timing');
    return number!;
  }

  void contentFrame(int revision, int frameNumber, int postFrameUs) {
    if (frameNumber < 0) return;
    frameContents[revision] = (
      frameNumber: frameNumber,
      postFrameUs: postFrameUs,
    );
    _notify();
  }

  Future<({int frameNumber, int postFrameUs})> frameRevision(
    int expected,
  ) async {
    await _wait(
      () => frameContents.containsKey(expected),
      'revision_$expected',
    );
    return frameContents[expected]!;
  }

  void observeFrame(int frameNumber, int frameworkTargetUs) {
    // Warm-up frames have no engine identity and cannot be attributed.
    if (frameNumber < 0) return;
    observedFrames[frameNumber] = frameworkTargetUs;
    _notify();
  }

  Future<Map<String, Object>> sealFrames({
    required String name,
    required int openFrame,
    required int targetFrame,
    required int closeFrame,
    required int revision,
    required bool observationOnly,
  }) async {
    if (!(openFrame < targetFrame && targetFrame < closeFrame)) {
      throw StateError('invalid_frame_boundaries_$name');
    }
    await _wait(() {
      final delivered = raw.map((s) => s.frameNumber).toSet();
      return [openFrame, targetFrame, closeFrame].every(delivered.contains) &&
          observedFrames.keys
              .where((n) => n > openFrame && n <= closeFrame)
              .every(delivered.contains);
    }, '${name}_target_and_closing_timings');
    final byNumber = {for (final s in raw) s.frameNumber: s};
    for (final n in observedFrames.keys) {
      final sample = byNumber[n];
      if (sample != null) observed.add(sample.vsyncUs);
    }
    final phase = await seal(
      name: name,
      openUs: byNumber[openFrame]!.vsyncUs,
      targetUs: byNumber[targetFrame]!.vsyncUs,
      closeUs: byNumber[closeFrame]!.vsyncUs,
      revision: revision,
      observationOnly: observationOnly,
    );
    phase.addAll({
      'open_frame_number': openFrame,
      'target_frame_number': targetFrame,
      'close_frame_number': closeFrame,
    });
    return phase;
  }

  void observe(int vsyncUs) {
    observed.add(vsyncUs);
    _notify();
  }

  void content(int revision, int vsyncUs, int postFrameUs) {
    contents[revision] = (vsyncUs: vsyncUs, postFrameUs: postFrameUs);
    _notify();
  }

  void deliver(List<P5FrameSample> values, int deliveredUs) {
    raw.addAll(values);
    deliveries.add({
      'batch': deliveries.length,
      'delivered_us': deliveredUs,
      'vsync_us': values.map((s) => s.vsyncUs).toList(),
    });
    _notify();
  }

  Future<({int vsyncUs, int postFrameUs})> revision(int expected) async {
    await _wait(() => contents.containsKey(expected), 'revision_$expected');
    return contents[expected]!;
  }

  Future<Map<String, Object>> seal({
    required String name,
    required int openUs,
    required int targetUs,
    required int closeUs,
    required int revision,
    required bool observationOnly,
  }) async {
    if (!(openUs < targetUs && targetUs < closeUs)) {
      throw StateError('invalid_frame_boundaries_$name');
    }
    await _wait(() {
      final delivered = raw.map((s) => s.vsyncUs).toSet();
      return delivered.contains(targetUs) &&
          delivered.contains(closeUs) &&
          observed
              .where((v) => v > openUs && v <= closeUs)
              .every(delivered.contains);
    }, '${name}_target_and_closing_timings');
    final frames =
        raw.where((s) => s.vsyncUs > openUs && s.vsyncUs <= closeUs).toList()
          ..sort((a, b) => a.vsyncUs.compareTo(b.vsyncUs));
    final phase = <String, Object>{
      'name': name,
      'open_vsync_us': openUs,
      'target_vsync_us': targetUs,
      'close_vsync_us': closeUs,
      'revision': revision,
      'observation_only': observationOnly,
      'frames': frames.map((s) => s.toJson()).toList(),
    };
    phases.add(phase);
    return phase;
  }

  Future<void> _wait(bool Function() ready, String label) async {
    if (ready()) return;
    final done = Completer<void>();
    void check() {
      if (!done.isCompleted && ready()) done.complete();
    }

    _waiters.add(check);
    try {
      await done.future.timeout(
        deadline,
        onTimeout: () {
          throw StateError('timeout_$label');
        },
      );
    } finally {
      _waiters.remove(check);
    }
  }

  void _notify() {
    for (final check in _waiters.toList()) {
      check();
    }
  }

  Map<String, Object> toJson() => {
    'clock': 'engine_monotonic_microseconds',
    'raw_timings': raw.map((s) => s.toJson()).toList(),
    'delivery_batches': deliveries,
    'observed_vsync_us': observed.toList(),
    'observed_framework_frames': [
      for (final e in observedFrames.entries)
        {'frame_number': e.key, 'framework_target_us': e.value},
    ],
    'phases': phases,
  };
}
