// Plan/30 — ImagePickerService pick + iterative size-ceiling logic, via the
// ImagePickerBackend seam (no plugins / device).
// Plan/69 W3 — plus the camera-less / no-compressor path (Windows): the
// service sends the raw file bytes with the extension's mime.

import 'dart:typed_data';

import 'package:app/data/images/image_picker_service.dart';
import 'package:app/domain/value_objects/device_capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeBackend implements ImagePickerBackend {
  String? path = '/tmp/pic.jpg'; // null → user cancelled
  bool denied = false;

  /// Bytes returned per compress pass, in order. The last value repeats.
  List<int> sizes = [200 * 1024];
  final List<({int side, int quality})> calls = [];
  ImageSourceKind? pickedSource;

  @override
  Future<String?> pick(ImageSourceKind source) async {
    pickedSource = source;
    if (denied) throw const ImagePermissionDeniedException();
    return path;
  }

  @override
  Future<Uint8List> compress(
    String path, {
    required int maxSide,
    required int quality,
  }) async {
    calls.add((side: maxSide, quality: quality));
    final idx = calls.length - 1;
    final n = idx < sizes.length ? sizes[idx] : sizes.last;
    return Uint8List(n);
  }

  @override
  Future<Uint8List> readRaw(String path) async => Uint8List.fromList(
    // Distinct payload so tests can tell raw bytes from compressed ones.
    [for (var i = 0; i < 8; i++) i],
  );
}

void main() {
  test('gallery pick under the ceiling compresses once', () async {
    final backend = _FakeBackend()..sizes = [180 * 1024];
    final svc = ImagePickerService(backend, DeviceCapabilities.forPlatform(DevicePlatform.android));

    final result = await svc.pickFromGallery();
    expect(result, isNotNull);
    expect(result!.mime, 'image/jpeg');
    expect(result.bytes.length, 180 * 1024);
    expect(backend.pickedSource, ImageSourceKind.gallery);
    expect(backend.calls, hasLength(1));
    expect(backend.calls.first.side, 1568);
    expect(backend.calls.first.quality, 80);
  });

  test('oversized result re-compresses with smaller side + quality', () async {
    final backend = _FakeBackend()
      // First two passes blow the 1.5MB ceiling, the third lands under.
      ..sizes = [2000 * 1024, 1700 * 1024, 300 * 1024];
    final svc = ImagePickerService(backend, DeviceCapabilities.forPlatform(DevicePlatform.android));

    final result = await svc.pickFromCamera();
    expect(result!.bytes.length, 300 * 1024);
    expect(backend.calls.length, 3);
    // Side + quality shrink monotonically across passes.
    expect(backend.calls[1].side, lessThan(backend.calls[0].side));
    expect(backend.calls[1].quality, lessThan(backend.calls[0].quality));
    expect(backend.calls[2].side, lessThan(backend.calls[1].side));
  });

  test('cancelled pick returns null and never compresses', () async {
    final backend = _FakeBackend()..path = null;
    final svc = ImagePickerService(backend, DeviceCapabilities.forPlatform(DevicePlatform.android));
    expect(await svc.pickFromGallery(), isNull);
    expect(backend.calls, isEmpty);
  });

  test('denied camera permission propagates as a typed exception', () async {
    final backend = _FakeBackend()..denied = true;
    final svc = ImagePickerService(backend, DeviceCapabilities.forPlatform(DevicePlatform.android));
    expect(
      () => svc.pickFromCamera(),
      throwsA(isA<ImagePermissionDeniedException>()),
    );
  });

  // --- Plan/69 W3 — camera-less / no-compressor platform (Windows) -------

  test('no compressor → raw bytes with the path extension mime', () async {
    final backend = _FakeBackend()..path = r'C:\pics\shot.png';
    final svc = ImagePickerService(
      backend,
      const DeviceCapabilities(
        camera: false,
        photoLibrary: true,
        speechToText: true,
        systemSettingsDeepLink: false,
        imageCompression: false,
      ),
    );

    final result = await svc.pickFromGallery();
    expect(result, isNotNull);
    expect(result!.bytes, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.mime, 'image/png');
    // The compressor is never touched on this path.
    expect(backend.calls, isEmpty);
  });

  test('no compressor + jpeg path keeps the jpeg mime', () async {
    final backend = _FakeBackend()..path = '/tmp/pic.jpeg';
    final svc = ImagePickerService(
      backend,
      const DeviceCapabilities(
        camera: false,
        photoLibrary: true,
        speechToText: true,
        systemSettingsDeepLink: false,
        imageCompression: false,
      ),
    );

    final result = await svc.pickFromGallery();
    expect(result!.mime, 'image/jpeg');
  });

  test('compressor present → compressed path unchanged', () async {
    // Default capabilities on a mobile-shaped snapshot keep the legacy
    // behaviour: compress once, jpeg mime.
    final backend = _FakeBackend()..sizes = [180 * 1024];
    final svc = ImagePickerService(
      backend,
      DeviceCapabilities.forPlatform(DevicePlatform.android),
    );

    final result = await svc.pickFromGallery();
    expect(result!.mime, 'image/jpeg');
    expect(backend.calls, hasLength(1));
  });

  test('mimeForPath maps known extensions, defaults to jpeg', () {
    expect(mimeForPath('/a/b.png'), 'image/png');
    expect(mimeForPath('/a/b.PNG'), 'image/png');
    expect(mimeForPath('/a/b.gif'), 'image/gif');
    expect(mimeForPath('/a/b.webp'), 'image/webp');
    expect(mimeForPath('/a/b.bmp'), 'image/bmp');
    expect(mimeForPath('/a/b.tiff'), 'image/tiff');
    expect(mimeForPath('/a/b.jpg'), 'image/jpeg');
    expect(mimeForPath('/a/b'), 'image/jpeg');
  });
}
