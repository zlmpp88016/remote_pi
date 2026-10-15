// Plan 29 — RecordingStrip presentational behavior: running timer, waveform
// that reacts to level, and the slide-to-cancel hint flip.

import 'dart:math' as math;

import 'package:app/ui/chat/voice/widgets/recording_strip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget host({
    required double level,
    required Duration elapsed,
    bool cancelArmed = false,
  }) {
    return MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: 360,
            child: RecordingStrip(
              level: level,
              elapsed: elapsed,
              maxDuration: const Duration(seconds: 60),
              cancelArmed: cancelArmed,
            ),
          ),
        ),
      ),
    );
  }

  // Bars are 3px-wide Containers; their tight height encodes the amplitude.
  double maxBarHeight(WidgetTester tester) {
    final bars = tester
        .widgetList<Container>(find.byType(Container))
        .where((c) => c.constraints?.maxWidth == 3.0);
    return bars.map((c) => c.constraints!.maxHeight).fold<double>(0, math.max);
  }

  testWidgets('timer renders elapsed as MM:SS and increments', (tester) async {
    await tester.pumpWidget(
      host(level: 0, elapsed: const Duration(seconds: 5)),
    );
    await tester.pump();
    expect(find.text('00:05'), findsOneWidget);

    await tester.pumpWidget(
      host(level: 0, elapsed: const Duration(seconds: 65)),
    );
    await tester.pump();
    expect(find.text('01:05'), findsOneWidget);
  });

  testWidgets('waveform reacts to the level — bar height grows', (
    tester,
  ) async {
    await tester.pumpWidget(host(level: 0.0, elapsed: Duration.zero));
    await tester.pump();
    final quiet = maxBarHeight(tester);

    // Rebuild with a loud sample → didUpdateWidget pushes it into the buffer.
    await tester.pumpWidget(host(level: 1.0, elapsed: Duration.zero));
    await tester.pump();
    final loud = maxBarHeight(tester);

    expect(loud, greaterThan(quiet));
  });

  testWidgets('shows the slide-to-cancel hint, then the armed warning', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(level: 0.3, elapsed: const Duration(seconds: 2)),
    );
    await tester.pump();
    expect(find.text('slide to cancel'), findsOneWidget);
    expect(find.text('release to cancel'), findsNothing);

    await tester.pumpWidget(
      host(level: 0.3, elapsed: const Duration(seconds: 2), cancelArmed: true),
    );
    await tester.pump();
    expect(find.text('release to cancel'), findsOneWidget);
    expect(find.text('slide to cancel'), findsNothing);
  });
}
