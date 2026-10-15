import 'dart:io' show Platform;

import 'package:app/domain/value_objects/device_capabilities.dart';

// Plan/69 W3 — the `dart:io` probe behind the capability table.
//
// Lives in `data/` because it touches the platform directly (the domain
// value object stays pure). Pure Dart — no platform channels, no async:
// `Platform.is*` is a synchronous OS check, so the snapshot can be resolved
// once during bootstrap and shared as an immutable instance.

/// The platform the app is running on, per `dart:io`.
DevicePlatform currentDevicePlatform() {
  if (Platform.isIOS) return DevicePlatform.ios;
  if (Platform.isAndroid) return DevicePlatform.android;
  if (Platform.isMacOS) return DevicePlatform.macos;
  if (Platform.isWindows) return DevicePlatform.windows;
  if (Platform.isLinux) return DevicePlatform.linux;
  return DevicePlatform.other;
}

/// Resolves the capability snapshot for the running platform.
DeviceCapabilities detectDeviceCapabilities() =>
    DeviceCapabilities.forPlatform(currentDevicePlatform());
