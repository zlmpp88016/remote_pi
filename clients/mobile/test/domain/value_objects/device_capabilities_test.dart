// Plan/69 W3 — the platform → capability table (pure domain value object).

import 'package:app/domain/value_objects/device_capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('mobile platforms get the full capability set', () {
    for (final p in [DevicePlatform.ios, DevicePlatform.android]) {
      final caps = DeviceCapabilities.forPlatform(p);
      expect(caps.camera, isTrue, reason: '$p camera');
      expect(caps.photoLibrary, isTrue, reason: '$p photoLibrary');
      expect(caps.speechToText, isTrue, reason: '$p speechToText');
      expect(caps.systemSettingsDeepLink, isTrue, reason: '$p settings');
      expect(caps.imageCompression, isTrue, reason: '$p compression');
    }
  });

  test('windows is camera-less but keeps paste pairing + STT', () {
    // Plan 69 W3: sem câmera → colagem (pareamento paste-only desde o
    // plan/68); STT opcional via speech_to_text_windows, ainda gateado pelo
    // probe de runtime; compressor e deep-link de settings ausentes.
    final caps = DeviceCapabilities.forPlatform(DevicePlatform.windows);
    expect(caps.camera, isFalse);
    expect(caps.photoLibrary, isTrue);
    expect(caps.speechToText, isTrue);
    expect(caps.systemSettingsDeepLink, isFalse);
    expect(caps.imageCompression, isFalse);
  });

  test('macos matches mobile (darwin plugin implementations exist)', () {
    expect(
      DeviceCapabilities.forPlatform(DevicePlatform.macos),
      DeviceCapabilities.mobile,
    );
  });

  test('linux and unknown platforms stay conservative', () {
    final linux = DeviceCapabilities.forPlatform(DevicePlatform.linux);
    expect(linux.camera, isFalse);
    expect(linux.speechToText, isFalse);
    expect(linux.systemSettingsDeepLink, isFalse);
    expect(linux.imageCompression, isFalse);
    // Gallery picking still works (file selector).
    expect(linux.photoLibrary, isTrue);

    final other = DeviceCapabilities.forPlatform(DevicePlatform.other);
    expect(other.photoLibrary, isFalse);
  });

  test('value equality + hashCode', () {
    expect(
      DeviceCapabilities.forPlatform(DevicePlatform.windows),
      DeviceCapabilities.windows,
    );
    expect(
      DeviceCapabilities.forPlatform(DevicePlatform.windows).hashCode,
      DeviceCapabilities.windows.hashCode,
    );
    expect(
      DeviceCapabilities.forPlatform(DevicePlatform.windows),
      isNot(DeviceCapabilities.mobile),
    );
  });

  test('toString lists every flag (debug aid)', () {
    final s = DeviceCapabilities.windows.toString();
    expect(s, contains('camera: false'));
    expect(s, contains('speechToText: true'));
  });
}
