// Plan/69 W3 — the `dart:io` probe behind the capability table.
//
// The test host decides the expected value (this suite runs on Windows CI
// and on developer machines), so the expectation is derived from the same
// `Platform.is*` facts the probe reads — host-conditional by design, like
// `speech_service_test`'s darwin assertion.

import 'dart:io' show Platform;

import 'package:app/data/device/device_capabilities_probe.dart';
import 'package:app/domain/value_objects/device_capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('currentDevicePlatform maps dart:io facts', () {
    final DevicePlatform expected;
    if (Platform.isIOS) {
      expected = DevicePlatform.ios;
    } else if (Platform.isAndroid) {
      expected = DevicePlatform.android;
    } else if (Platform.isMacOS) {
      expected = DevicePlatform.macos;
    } else if (Platform.isWindows) {
      expected = DevicePlatform.windows;
    } else if (Platform.isLinux) {
      expected = DevicePlatform.linux;
    } else {
      expected = DevicePlatform.other;
    }
    expect(currentDevicePlatform(), expected);
  });

  test('detectDeviceCapabilities agrees with the table', () {
    expect(
      detectDeviceCapabilities(),
      DeviceCapabilities.forPlatform(currentDevicePlatform()),
    );
  });

  test('on a Windows host the snapshot is the camera-less desktop one', () {
    // Windows is where this capability layer exists for (plan 69 W3); on
    // other hosts the assertion is vacuous rather than wrong.
    if (!Platform.isWindows) return;
    final caps = detectDeviceCapabilities();
    expect(caps.camera, isFalse);
    expect(caps.photoLibrary, isTrue);
    expect(caps.speechToText, isTrue);
    expect(caps.systemSettingsDeepLink, isFalse);
    expect(caps.imageCompression, isFalse);
  });
}
