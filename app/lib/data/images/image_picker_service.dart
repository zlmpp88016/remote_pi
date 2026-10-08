import 'dart:io';
import 'dart:typed_data';

import 'package:app/data/device/device_capabilities_probe.dart';
import 'package:app/domain/value_objects/device_capabilities.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image_picker/image_picker.dart';

/// Plan/30 — pick one image from the camera or the gallery and compress it
/// (JPEG, longest side ≤1568px, q80) entirely on-device before it travels
/// inline on a `user_message`. No file is uploaded out-of-band.
///
/// The plugin calls go through the [ImagePickerBackend] seam so the
/// pick + iterative size-ceiling logic is unit-testable without a device.
abstract class IImagePickerService {
  /// Capture a photo. Returns null if the user cancelled. Throws
  /// [ImagePermissionDeniedException] when camera permission is denied (#10).
  Future<PickedImage?> pickFromCamera();

  /// Pick from the gallery (system PHPicker / Photo Picker — no permission).
  /// Returns null if the user cancelled.
  Future<PickedImage?> pickFromGallery();
}

/// A picked + compressed image ready for preview and sending. Bytes are raw
/// (not base64) so the composer preview renders them directly; the send path
/// base64-encodes into a `MessageImage`.
class PickedImage {
  final Uint8List bytes;
  final String mime;
  const PickedImage({required this.bytes, required this.mime});
}

/// Thrown when the camera permission was denied — the UI guides the user to
/// system Settings (reuses the plan-29 `app_settings` affordance).
class ImagePermissionDeniedException implements Exception {
  const ImagePermissionDeniedException();
  @override
  String toString() => 'ImagePermissionDeniedException';
}

class ImagePickerService implements IImagePickerService {
  ImagePickerService([
    ImagePickerBackend? backend,
    DeviceCapabilities? capabilities,
  ]) : _backend = backend ?? PlatformImagePickerBackend(),
       _capabilities = capabilities ?? detectDeviceCapabilities();

  final ImagePickerBackend _backend;

  /// Plan/69 W3 — platform capabilities. When the native compressor is
  /// missing (Windows), the picked file's raw bytes travel instead.
  final DeviceCapabilities _capabilities;

  /// Longest side of the compressed image (decision #5).
  static const int _maxSide = 1568;

  /// Initial JPEG quality (decision #5).
  static const int _quality = 80;

  /// Safety ceiling — re-compress harder if we somehow blow past this
  /// (rare; the defaults land ~150–400 KB).
  static const int _ceilingBytes = 1500 * 1024;

  /// Max extra passes before we accept whatever we have.
  static const int _maxExtraPasses = 3;

  @override
  Future<PickedImage?> pickFromCamera() =>
      _pickAndCompress(ImageSourceKind.camera);

  @override
  Future<PickedImage?> pickFromGallery() =>
      _pickAndCompress(ImageSourceKind.gallery);

  Future<PickedImage?> _pickAndCompress(ImageSourceKind source) async {
    final path = await _backend.pick(source);
    if (path == null) return null; // user cancelled

    // Plan/69 W3 — no native compressor on this platform (Windows): the
    // plugin has no implementation and would throw `UnsupportedError`.
    // Send the picked file's raw bytes with the mime its extension claims.
    if (!_capabilities.imageCompression) {
      final raw = await _backend.readRaw(path);
      return PickedImage(bytes: raw, mime: mimeForPath(path));
    }

    var side = _maxSide;
    var quality = _quality;
    var bytes = await _backend.compress(path, maxSide: side, quality: quality);

    // Iterative ceiling: shrink dimension + quality until under the cap (or
    // we run out of passes). Practically never fires.
    var pass = 0;
    while (bytes.length > _ceilingBytes && pass < _maxExtraPasses) {
      pass++;
      quality = (quality - 15).clamp(35, 100);
      side = (side * 0.85).round();
      bytes = await _backend.compress(path, maxSide: side, quality: quality);
    }

    return PickedImage(bytes: bytes, mime: 'image/jpeg');
  }
}

// ---------------------------------------------------------------------------
// Backend seam
// ---------------------------------------------------------------------------

enum ImageSourceKind { camera, gallery }

/// Thin seam over `image_picker` + `flutter_image_compress`.
abstract class ImagePickerBackend {
  /// Pick a file; returns its path, or null if cancelled. Throws
  /// [ImagePermissionDeniedException] on a denied camera permission.
  Future<String?> pick(ImageSourceKind source);

  /// Compress [path] to JPEG bounded by [maxSide]px at [quality].
  Future<Uint8List> compress(
    String path, {
    required int maxSide,
    required int quality,
  });

  /// Read [path]'s bytes as-is — the fallback on platforms without a native
  /// compressor (plan/69 W3, Windows).
  Future<Uint8List> readRaw(String path);
}

/// Mime type for a picked file path, by extension. Defaults to JPEG (the
/// compressed path always produces JPEG); the raw path (Windows) preserves
/// whatever the user picked so the inline `MessageImage` is labelled
/// truthfully.
String mimeForPath(String path) {
  final ext = path.split('.').last.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return 'image/jpeg';
  }
}

class PlatformImagePickerBackend implements ImagePickerBackend {
  PlatformImagePickerBackend([
    ImagePicker? picker,
    DeviceCapabilities? capabilities,
  ]) : _picker = picker ?? ImagePicker(),
       _capabilities = capabilities ?? detectDeviceCapabilities();

  final ImagePicker _picker;

  /// Plan/69 W3 — gates the compressor call (no Windows implementation).
  final DeviceCapabilities _capabilities;

  @override
  Future<String?> pick(ImageSourceKind source) async {
    try {
      final file = await _picker.pickImage(
        source: source == ImageSourceKind.camera
            ? ImageSource.camera
            : ImageSource.gallery,
      );
      return file?.path;
    } on PlatformException catch (e) {
      // image_picker surfaces a denied camera/photo permission as a
      // PlatformException with an `*_access_denied` code.
      if (e.code.contains('access_denied') || e.code.contains('denied')) {
        throw const ImagePermissionDeniedException();
      }
      rethrow;
    }
  }

  @override
  Future<Uint8List> compress(
    String path, {
    required int maxSide,
    required int quality,
  }) async {
    // Plan/69 W3 — `flutter_image_compress` has no Windows implementation;
    // calling it there throws `UnsupportedError`. Capability-aware callers
    // (ImagePickerService) route around this, but the backend stays honest
    // if invoked directly.
    if (!_capabilities.imageCompression) {
      return readRaw(path);
    }
    final out = await FlutterImageCompress.compressWithFile(
      path,
      minWidth: maxSide,
      minHeight: maxSide,
      quality: quality,
      format: CompressFormat.jpeg,
    );
    // Fallback: if the platform compressor returns null (unsupported source
    // format), surface an empty result so the caller can no-op gracefully.
    return out ?? Uint8List(0);
  }

  @override
  Future<Uint8List> readRaw(String path) => File(path).readAsBytes();
}
