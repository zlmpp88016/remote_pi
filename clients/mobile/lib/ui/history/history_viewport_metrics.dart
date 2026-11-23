// Opt-in correlation of real ready-state post-frame with its engine raster.
import 'dart:developer' as developer;
import 'dart:ui';

import 'package:flutter/scheduler.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';

class HistoryViewportMetrics {
  static final _pending = <HistoryStageSpan>[];
  static bool _installed = false;
  static void install() {
    if (_installed || !HistoryStageMetrics.enabled) return;
    _installed = true;
    SchedulerBinding.instance.addTimingsCallback((values) {
      for (final timing in values) {
        final vsync = timing.timestampInMicroseconds(FramePhase.vsyncStart);
        for (final span in _pending.toList()) {
          if (span.fields['viewport_frame_number'] != timing.frameNumber) {
            continue;
          }
          span.mark('viewport_vsync_us', vsync);
          span.mark(
            'viewport_raster_finish_us',
            timing.timestampInMicroseconds(FramePhase.rasterFinish),
          );
          span.mark('timing_delivered_us', developer.Timeline.now);
          _pending.remove(span);
        }
      }
    });
  }

  // Called only for the exact ready state captured by the widget, after its
  // real row or completed-empty-state frame. A skeleton never calls this.
  static void report(HistoryStageSpan? span) {
    reportFrame(
      span,
      frameNumber: PlatformDispatcher.instance.frameData.frameNumber,
      frameworkTargetUs:
          SchedulerBinding.instance.currentSystemFrameTimeStamp.inMicroseconds,
    );
  }

  // Explicit engine identity also makes the correlation independently testable
  // when widget-test pumps do not supply native FrameData.
  static void reportFrame(
    HistoryStageSpan? span, {
    required int frameNumber,
    required int frameworkTargetUs,
  }) {
    if (frameNumber < 0) return;
    if (span == null || span.viewportQueued) return;
    span.viewportQueued = true;
    span.mark('real_post_frame_us');
    span.mark('viewport_framework_target_us', frameworkTargetUs);
    span.mark('viewport_frame_number', frameNumber);
    _pending.add(span);
  }
}
