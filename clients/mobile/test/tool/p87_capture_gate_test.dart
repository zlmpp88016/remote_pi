import 'package:flutter_test/flutter_test.dart';
import '../../tool/history_perf/p87_capture_gate.dart';

void main() {
  test('ready/start/completion/export acknowledge strictly ordered', () async {
    final gate = P87CaptureGate(suite: 'p5');
    expect(gate.handle({})['state'], 'ready');
    expect(
      () => gate.handle({'action': 'exportAcknowledged'}),
      throwsStateError,
    );
    expect(
      () => gate.handle({'action': 'start', 'mode': 'unknown'}),
      throwsStateError,
    );
    final started = gate.waitForStart();
    expect(
      gate.handle({'action': 'start', 'mode': 'diagnostic'})['state'],
      'capturing',
    );
    await started;
    expect(
      () => gate.handle({'action': 'start', 'mode': 'diagnostic'}),
      throwsStateError,
    );
    expect(() => gate.handle({'action': 'finish'}), throwsStateError);
    gate.complete({'phases': 4});
    expect(gate.endUs, greaterThanOrEqualTo(gate.beginUs!));
    expect(
      gate.handle({'action': 'captureComplete'})['state'],
      'captureComplete',
    );
    final exported = gate.waitForExport();
    expect(
      gate.handle({'action': 'exportAcknowledged'})['state'],
      'exportAcknowledged',
    );
    await exported;
    expect(() => gate.complete({}), throwsStateError);
  });
  test('browse finish is explicit, once only; failure is exportable', () {
    final gate = P87CaptureGate(suite: 'browse');
    var finishes = 0;
    gate.onFinish = () => finishes++;
    expect(() => gate.handle({'action': 'finish'}), throwsStateError);
    gate.handle({'action': 'start', 'mode': 'unprofiled'});
    gate.handle({'action': 'finish'});
    expect(finishes, 1);
    expect(() => gate.handle({'action': 'finish'}), throwsStateError);
    gate.complete({'frames': []}, error: 'incomplete');
    expect(gate.handle({})['failure'], 'incomplete');
  });
}
