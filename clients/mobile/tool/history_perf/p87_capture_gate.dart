// TEST-ONLY VM-service rendezvous; callers must enforce profile + opt-in.
import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

class P87CaptureGate {
  P87CaptureGate({required this.suite});
  final String suite;
  final _start = Completer<void>();
  final _exported = Completer<void>();
  String state = 'ready';
  String mode = 'unset';
  int? beginUs, endUs;
  Map<String, Object?> result = {};
  String? failure;
  void Function()? onFinish;
  bool _finishRequested = false;

  void install() {
    developer.registerExtension('ext.remote_pi.p87.capture', (
      _,
      parameters,
    ) async {
      try {
        return developer.ServiceExtensionResponse.result(
          jsonEncode(handle(parameters)),
        );
      } catch (_) {
        // No exception strings: service errors can carry an authenticated URI.
        return developer.ServiceExtensionResponse.error(
          developer.ServiceExtensionResponse.invalidParams,
          'invalid capture transition',
        );
      }
    });
  }

  Map<String, Object?> handle(Map<String, String> parameters) {
    switch (parameters['action'] ?? 'ready') {
      case 'ready':
        break;
      case 'start':
        if (state != 'ready') throw StateError('start_requires_ready');
        mode = parameters['mode'] ?? '';
        if (!['diagnostic', 'unprofiled'].contains(mode)) {
          throw StateError('capture_mode');
        }
        state = 'capturing';
        beginUs = developer.Timeline.now;
        developer.Timeline.instantSync(
          'p87_capture_begin',
          arguments: {'suite': suite, 'mode': mode},
        );
        _start.complete();
      case 'finish':
        if (suite != 'browse' ||
            state != 'capturing' ||
            _finishRequested ||
            onFinish == null) {
          throw StateError('finish_requires_browse_capture');
        }
        _finishRequested = true;
        onFinish!();
      case 'captureComplete':
        break;
      case 'exportAcknowledged':
        if (state != 'captureComplete') {
          throw StateError('export_requires_completion');
        }
        state = 'exportAcknowledged';
        _exported.complete();
      default:
        throw StateError('capture_action');
    }
    return {
      'schema': 1,
      'suite': suite,
      'build': const String.fromEnvironment('P87_BUILD_TAG'),
      'state': state,
      'mode': mode,
      'begin_us': beginUs,
      'end_us': endUs,
      'failure': failure,
      'result': result,
    };
  }

  Future<void> waitForStart() =>
      _start.future.timeout(const Duration(minutes: 2));
  void complete(Map<String, Object?> value, {String? error}) {
    if (state != 'capturing') throw StateError('completion_requires_capture');
    result = value;
    failure = error;
    developer.Timeline.instantSync(
      'p87_capture_end',
      arguments: {'suite': suite, 'success': error == null},
    );
    endUs = developer.Timeline.now;
    state = 'captureComplete';
    developer.postEvent('p87.captureComplete', {
      'suite': suite,
      'success': error == null,
    });
  }

  Future<void> waitForExport() =>
      _exported.future.timeout(const Duration(minutes: 2));
}
