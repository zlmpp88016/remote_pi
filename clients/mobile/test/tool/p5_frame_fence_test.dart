import 'package:flutter_test/flutter_test.dart';
import '../../tool/history_perf/p5_frame_fence.dart';

P5FrameSample sample(int vsync) => P5FrameSample(
  vsyncUs: vsync,
  buildStartUs: vsync + 1,
  buildFinishUs: vsync + 2,
  rasterStartUs: vsync + 3,
  rasterFinishUs: vsync + 4,
  frameNumber: vsync,
);

void main() {
  test(
    'browse opening rejects stale positive warm-up identity and waits for first real timing',
    () async {
      final f = P5FrameFence();
      final opening = f.openingFrame();
      f.observeFrame(3, 0);
      f.deliver([sample(4)], 5); // distinct warm-up rendering identity
      var ready = false;
      final done = opening.then((n) {
        ready = true;
        return n;
      });
      f.observeFrame(5, 16672);
      f.observeFrame(6, 16673);
      f.deliver([sample(6)], 100);
      await Future<void>.value();
      expect(ready, isFalse); // must not pick later, already delivered frame 6
      f.deliver([sample(5)], 200);
      expect(await done, 5);
      f.observeFrame(7, 16674);
      f.observeFrame(8, 16675);
      final sealed = f.sealFrames(
        name: 'browse',
        openFrame: 5,
        targetFrame: 7,
        closeFrame: 8,
        revision: 0,
        observationOnly: true,
      );
      f.deliver([sample(7), sample(8)], 300);
      final phase = await sealed;
      expect(phase['open_frame_number'], 5);
      expect((phase['frames'] as List).map((s) => s['frame_number']), [
        6,
        7,
        8,
      ]);
      expect(f.observedFrames[3], 0); // audit evidence retained
    },
  );

  test(
    'missing first genuine browse timing fails instead of skipping ahead',
    () async {
      final f = P5FrameFence(deadline: const Duration(milliseconds: 5));
      f.observeFrame(3, 0);
      f.observeFrame(5, 16672);
      f.observeFrame(6, 16673);
      f.deliver([sample(4), sample(6)], 100);
      await expectLater(f.openingFrame(), throwsStateError);
    },
  );

  test(
    'engine identity joins target timestamps to raw starts exactly',
    () async {
      final f = P5FrameFence();
      // Actual diagnostic05 values: framework target is 16667us after start.
      final samples = [
        for (final (number, start) in [
          (8, 2667168588),
          (9, 2667218588),
          (10, 2667385255),
          (11, 2667518588),
        ])
          P5FrameSample(
            vsyncUs: start,
            buildStartUs: start + 1,
            buildFinishUs: start + 2,
            rasterStartUs: start + 3,
            rasterFinishUs: start + 4,
            frameNumber: number,
          ),
      ];
      for (final s in samples) {
        f.observeFrame(s.frameNumber, s.vsyncUs + 16667);
      }
      f.contentFrame(2, 10, 2667478756);
      expect((await f.frameRevision(2)).frameNumber, 10);
      var ready = false;
      final done = f
          .sealFrames(
            name: 'apply100',
            openFrame: 8,
            targetFrame: 10,
            closeFrame: 11,
            revision: 2,
            observationOnly: false,
          )
          .then((p) {
            ready = true;
            return p;
          });
      // Closing arrives first, intermediate is still missing.
      f.deliver([samples[0], samples[2], samples[3]], 3000000000);
      await Future<void>.value();
      expect(ready, isFalse);
      f.deliver([samples[1]], 3000000100);
      final phase = await done;
      expect(phase['target_vsync_us'], 2667385255);
      expect(phase['close_vsync_us'], 2667518588);
      expect(phase['target_frame_number'], 10);
      expect(f.observed, samples.map((s) => s.vsyncUs).toSet());
      expect(f.observedFrames[10], 2667401922);
      expect(f.deadline, const Duration(seconds: 10));
    },
  );

  test('nearby timestamp with wrong frame identity cannot seal', () async {
    final f = P5FrameFence(deadline: const Duration(milliseconds: 5));
    f.observeFrame(1, 30);
    f.observeFrame(2, 40);
    f.observeFrame(3, 50);
    // sample() uses its timestamp as frame number: none is identity 1/2/3.
    f.deliver([sample(10), sample(20), sample(30)], 100);
    await expectLater(
      f.sealFrames(
        name: 'wrong_identity',
        openFrame: 1,
        targetFrame: 2,
        closeFrame: 3,
        revision: 1,
        observationOnly: false,
      ),
      throwsStateError,
    );
    expect(f.phases, isEmpty);
  });

  test('early status frame cannot satisfy expected content revision', () async {
    final f = P5FrameFence();
    var ready = false;
    final content = f.revision(2).then((_) => ready = true);
    f.observe(20);
    f.deliver([sample(20)], 1000);
    f.content(1, 20, 22);
    await Future<void>.value();
    expect(ready, isFalse);
    f.content(2, 30, 32);
    await content;
    expect(ready, isTrue);
  });
  test('late content and closing timing both required', () async {
    final f = P5FrameFence();
    f.observe(20);
    f.observe(30);
    f.observe(40);
    var ready = false;
    final sealed = f
        .seal(
          name: 'apply100',
          openUs: 10,
          targetUs: 30,
          closeUs: 40,
          revision: 2,
          observationOnly: false,
        )
        .then((_) => ready = true);
    f.deliver([sample(20), sample(40)], 1000);
    await Future<void>.value();
    expect(ready, isFalse);
    f.deliver([sample(30)], 2000);
    await sealed;
    expect(ready, isTrue);
    expect((f.phases.single['frames'] as List).length, 3);
  });
  test(
    'two phases in one delivery batch partition by bilateral vsync bounds',
    () async {
      final f = P5FrameFence();
      for (final v in [20, 30, 50, 60]) {
        f.observe(v);
      }
      final a = f.seal(
        name: 'a',
        openUs: 10,
        targetUs: 20,
        closeUs: 30,
        revision: 1,
        observationOnly: false,
      );
      final b = f.seal(
        name: 'b',
        openUs: 40,
        targetUs: 50,
        closeUs: 60,
        revision: 2,
        observationOnly: false,
      );
      f.deliver([sample(60), sample(20), sample(50), sample(30)], 9000);
      final phases = await Future.wait([a, b]);
      expect((phases[0]['frames'] as List).map((s) => s['vsync_us']), [20, 30]);
      expect((phases[1]['frames'] as List).map((s) => s['vsync_us']), [50, 60]);
      expect(f.deliveries.length, 1);
    },
  );
  test(
    'final delayed timing is retained despite earlier delivered samples',
    () async {
      final f = P5FrameFence();
      f.deliver([sample(5)], 6);
      f.observe(20);
      f.observe(30);
      var ready = false;
      final done = f
          .seal(
            name: 'same_length',
            openUs: 10,
            targetUs: 20,
            closeUs: 30,
            revision: 4,
            observationOnly: false,
          )
          .then((_) => ready = true);
      f.deliver([sample(20)], 100);
      await Future<void>.value();
      expect(ready, isFalse);
      f.deliver([sample(30)], 200);
      await done;
      expect(f.raw.length, 3);
    },
  );
  test(
    'duplicate uses distinct observation frame with unchanged revision',
    () async {
      final f = P5FrameFence();
      f.content(3, 5, 7);
      f.observe(20);
      f.observe(30);
      final done = f.seal(
        name: 'duplicate',
        openUs: 10,
        targetUs: 20,
        closeUs: 30,
        revision: 3,
        observationOnly: true,
      );
      f.deliver([sample(20), sample(30)], 100);
      expect((await done)['observation_only'], isTrue);
      expect(f.contents[3]!.vsyncUs, 5);
    },
  );
  test('missing target or intermediate timing fails boundedly', () async {
    final f = P5FrameFence(deadline: const Duration(milliseconds: 5));
    for (final v in [20, 25, 30]) {
      f.observe(v);
    }
    final done = f.seal(
      name: 'missing',
      openUs: 10,
      targetUs: 20,
      closeUs: 30,
      revision: 1,
      observationOnly: false,
    );
    f.deliver([sample(20), sample(30)], 100);
    await expectLater(done, throwsStateError);
    expect(f.phases, isEmpty);
  });
}
