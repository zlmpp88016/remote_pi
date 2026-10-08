// Plan/30 + tablet fix — the Camera/Gallery attach sheet must close when the
// tablet's selected session changes out from under it.
// Plan/69 W3 — camera-less devices (Windows desktop) get no Camera option:
// image_picker's Windows implementation throws a StateError on
// ImageSource.camera. Pairing on those devices is paste-only (plan/68).

import 'package:app/domain/value_objects/device_capabilities.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/chat/widgets/attach_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

Future<void> _pumpSheet(
  WidgetTester tester,
  DeviceCapabilities caps,
) async {
  final selection = SessionSelection()..select('e1', 'r1', 'Chat 1');
  addTearDown(selection.dispose);

  late BuildContext pageContext;
  await tester.pumpWidget(
    MaterialApp(
      home: ChangeNotifierProvider<SessionSelection>.value(
        value: selection,
        child: Provider<DeviceCapabilities>.value(
          value: caps,
          child: Builder(
            builder: (context) {
              pageContext = context;
              return const Scaffold(body: SizedBox());
            },
          ),
        ),
      ),
    ),
  );

  // ignore: unawaited_futures
  showAttachSheet(pageContext);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('attach sheet closes when the session changes', (tester) async {
    final selection = SessionSelection()..select('e1', 'r1', 'Chat 1');
    addTearDown(selection.dispose);

    late BuildContext pageContext;
    await tester.pumpWidget(
      MaterialApp(
        home: ChangeNotifierProvider<SessionSelection>.value(
          value: selection,
          child: Provider<DeviceCapabilities>.value(
            value: DeviceCapabilities.forPlatform(DevicePlatform.android),
            child: Builder(
              builder: (context) {
                pageContext = context;
                return const Scaffold(body: SizedBox());
              },
            ),
          ),
        ),
      ),
    );

    // ignore: unawaited_futures
    showAttachSheet(pageContext);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attach-camera')), findsOneWidget);
    expect(find.byKey(const Key('attach-gallery')), findsOneWidget);

    // Switch session on the tablet master list → sheet must dismiss.
    selection.select('e2', 'r2', 'Chat 2');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attach-camera')), findsNothing);
  });

  testWidgets('camera-capable device offers Camera + Photo Library', (
    tester,
  ) async {
    await _pumpSheet(
      tester,
      DeviceCapabilities.forPlatform(DevicePlatform.android),
    );
    expect(find.byKey(const Key('attach-camera')), findsOneWidget);
    expect(find.byKey(const Key('attach-gallery')), findsOneWidget);
  });

  testWidgets('camera-less device (Windows) offers Photo Library only', (
    tester,
  ) async {
    // Plan/69 W3 — the desktop target has no camera: the sheet must not
    // offer an option that would throw a StateError when tapped.
    await _pumpSheet(
      tester,
      DeviceCapabilities.forPlatform(DevicePlatform.windows),
    );
    expect(find.byKey(const Key('attach-camera')), findsNothing);
    expect(find.byKey(const Key('attach-gallery')), findsOneWidget);
  });
}
