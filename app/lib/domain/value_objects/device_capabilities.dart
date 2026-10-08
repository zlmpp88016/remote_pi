// Plan/69 W3 — what the running device can do.
//
// The app ships on iOS + Android (camera-first mobile) and, since plan 68 U2 /
// plan 69 W3, on Windows (desktop). The desktop device is **camera-less**:
// pairing is paste-only (plan/68 removed the QR/camera scan path — see
// `lib/ui/pairing/pairing_page.dart`), and the chat composer must not offer
// camera capture. On-device speech-to-text is **optional**: the plugin has a
// Windows implementation (`speech_to_text_windows`), but the mic affordance
// stays gated by the runtime probe (`SpeechService.init` → `SpeechUnsupported`
// hides it — decision #9), so a machine without a recognizer degrades to
// keyboard input instead of a dead button.
//
// This file is the single platform → capability table. UI and data code ask
// the snapshot; nobody probes `Platform.is*` inline. Pure Dart: no Flutter,
// no `dart:io` — the probe lives in `data/device/`.

/// Platforms the app can run on. [other] catches Fuchsia and any future
/// target added before this table is updated — it maps to the most
/// conservative capability set (everything off).
enum DevicePlatform { ios, android, macos, windows, linux, other }

/// Immutable snapshot of the capabilities of the device the app runs on.
///
/// Each flag mirrors one concrete platform limitation discovered while
/// adding the Windows target (plan 69 W3):
///
/// - [camera] — `image_picker`'s `ImageSource.camera`. The Windows
///   implementation registers no camera delegate and throws a `StateError`
///   when invoked, so the attach sheet must not offer it there.
/// - [photoLibrary] — file/gallery picking (system picker). Available on
///   every shipped target.
/// - [speechToText] — the `speech_to_text` plugin ships a Windows
///   implementation, so dictation is offered; availability at runtime is
///   still decided by `SpeechService.init`.
/// - [systemSettingsDeepLink] — `app_settings` has no Windows
///   implementation; invoking it there throws `MissingPluginException`, so
///   permission-denied snackbars drop the Settings action on Windows.
/// - [imageCompression] — `flutter_image_compress` has no Windows
///   implementation (`UnsupportedError` at runtime); the picker falls back
///   to the raw file bytes when this is false.
class DeviceCapabilities {
  const DeviceCapabilities({
    required this.camera,
    required this.photoLibrary,
    required this.speechToText,
    required this.systemSettingsDeepLink,
    required this.imageCompression,
  });

  /// Camera capture available (mobile cameras). False on desktop.
  final bool camera;

  /// System file/gallery picking available.
  final bool photoLibrary;

  /// On-device speech-to-text offered (still runtime-gated).
  final bool speechToText;

  /// Deep-link to the system app-settings screen available.
  final bool systemSettingsDeepLink;

  /// Native JPEG compression available (picker falls back to raw bytes
  /// when false).
  final bool imageCompression;

  /// iOS / Android — every plugin has a mobile implementation.
  static const DeviceCapabilities mobile = DeviceCapabilities(
    camera: true,
    photoLibrary: true,
    speechToText: true,
    systemSettingsDeepLink: true,
    imageCompression: true,
  );

  /// macOS — not a shipped target yet, but every plugin has a darwin
  /// implementation, so the capability shape matches mobile.
  static const DeviceCapabilities macos = DeviceCapabilities(
    camera: true,
    photoLibrary: true,
    speechToText: true,
    systemSettingsDeepLink: true,
    imageCompression: true,
  );

  /// Windows (plan 69 W3) — camera-less desktop. Pairing is paste-only
  /// (plan/68); STT works via `speech_to_text_windows` but stays optional
  /// behind the runtime probe; compression and the settings deep-link are
  /// absent from their plugins on this platform.
  static const DeviceCapabilities windows = DeviceCapabilities(
    camera: false,
    photoLibrary: true,
    speechToText: true,
    systemSettingsDeepLink: false,
    imageCompression: false,
  );

  /// Linux — not a shipped target; conservative (no STT plugin, no
  /// settings deep-link, no compressor registered here).
  static const DeviceCapabilities linux = DeviceCapabilities(
    camera: false,
    photoLibrary: true,
    speechToText: false,
    systemSettingsDeepLink: false,
    imageCompression: false,
  );

  /// Unknown / Fuchsia / anything unrecognized — everything off.
  static const DeviceCapabilities other = DeviceCapabilities(
    camera: false,
    photoLibrary: false,
    speechToText: false,
    systemSettingsDeepLink: false,
    imageCompression: false,
  );

  /// The capability table for [platform].
  factory DeviceCapabilities.forPlatform(DevicePlatform platform) {
    switch (platform) {
      case DevicePlatform.ios:
      case DevicePlatform.android:
        return mobile;
      case DevicePlatform.macos:
        return macos;
      case DevicePlatform.windows:
        return windows;
      case DevicePlatform.linux:
        return linux;
      case DevicePlatform.other:
        return other;
    }
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is DeviceCapabilities &&
        other.camera == camera &&
        other.photoLibrary == photoLibrary &&
        other.speechToText == speechToText &&
        other.systemSettingsDeepLink == systemSettingsDeepLink &&
        other.imageCompression == imageCompression;
  }

  @override
  int get hashCode =>
      Object.hash(camera, photoLibrary, speechToText, systemSettingsDeepLink, imageCompression);

  @override
  String toString() =>
      'DeviceCapabilities(camera: $camera, photoLibrary: $photoLibrary, '
      'speechToText: $speechToText, '
      'systemSettingsDeepLink: $systemSettingsDeepLink, '
      'imageCompression: $imageCompression)';
}
