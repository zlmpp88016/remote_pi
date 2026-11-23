// TEST ONLY. No stores, submission, or production dependency registration.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:mobile/ui/onboarding/widgets/pair_step.dart';
import 'package:mobile/ui/pairing/pairing_page.dart';
import 'package:mobile/ui/pairing/viewmodels/pairing_viewmodel.dart';
import 'package:provider/provider.dart';

const p86FixtureOrigin = 'http://127.0.0.1:61986';

bool fixturePrefillAllowed(bool perf, String origin) =>
    perf && origin == p86FixtureOrigin;

/// Fixed field order and safe name; bootstrap values never leave memory.
String fixturePairingCode(Map<String, dynamic> view) {
  final token = view['token'];
  final key = view['hostEpk'];
  if (token is! String ||
      !RegExp(r'^[A-Za-z0-9_-]{4,128}$').hasMatch(token) ||
      key is! String) {
    throw const FormatException('fixture shape');
  }
  final bytes = base64.decode(base64.normalize(key));
  if (bytes.length != 32) throw const FormatException('fixture key');
  final epk = base64Url.encode(bytes).replaceAll('=', '');
  return Uri(
    scheme: 'remotepi',
    host: 'pair',
    queryParameters: {
      't': token,
      'epk': epk,
      'n': 'P86_TEST',
      'rm': 'host',
      'r': p86FixtureOrigin,
    },
  ).toString();
}

Future<String> _fetchCode() async {
  final client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 10)
    ..findProxy = (_) => 'DIRECT';
  final deadline = Timer(
    const Duration(seconds: 15),
    () => client.close(force: true),
  );
  try {
    final pageRequest = await client.getUrl(Uri.parse(p86FixtureOrigin));
    pageRequest.followRedirects = false;
    final page = await pageRequest.close();
    if (page.statusCode != 200 || page.cookies.isEmpty) {
      throw const FormatException('fixture page');
    }
    final cookies = page.cookies;
    await page.drain<void>();
    final request = await client.postUrl(
      Uri.parse('$p86FixtureOrigin/api/bootstrap'),
    );
    request.followRedirects = false;
    request.cookies.addAll(cookies);
    request.headers.set('Origin', p86FixtureOrigin);
    final response = await request.close();
    if (response.statusCode != 200) {
      throw const FormatException('fixture bootstrap');
    }
    final text = await utf8.decoder.bind(response).join();
    return fixturePairingCode(jsonDecode(text) as Map<String, dynamic>);
  } finally {
    deadline.cancel();
    client.close(force: true);
  }
}

/// Read the PROVIDED screen VM, never resolve/create another instance via DI.
/// An already-open sheet is too late: its code controller seeds in initState.
PairingViewModel? onscreenPairingVm(Element? root) {
  PairingViewModel? result;
  var sheetOpen = false;
  final pending = <Element>[?root];
  final children = <Element>[];
  while (pending.isNotEmpty) {
    final element = pending.removeLast();
    if (!element.mounted) continue;
    if (element.widget.key == const ValueKey('pairing-sheet-code')) {
      sheetOpen = true;
    }
    if (element.widget is PairStep || element.widget is PairingPage) {
      result ??= Provider.of<PairingViewModel?>(element, listen: false);
    }
    // visitChildren enumerates immediate children in framework order. Reverse
    // the push order so the LIFO worklist preserves recursive pre-order DFS,
    // without keeping one Dart call frame per widget-tree level.
    children.clear();
    element.visitChildren(children.add);
    pending.addAll(children.reversed);
  }
  return sheetOpen ? null : result;
}

/// Bounded wait for onboarding. One fetch + one whole-value notification;
/// no retries after fetch, no reapply on edits/navigation, no auto-submit.
void installFixturePrefill({
  required bool perf,
  required String origin,
  required void Function(bool ready) report,
  bool autoSubmit = false,
}) {
  if (!fixturePrefillAllowed(perf, origin)) return;
  var ticks = 0;
  var pendingFrame = false;
  final timer = Timer.periodic(const Duration(milliseconds: 500), (timer) {
    if (++ticks > 240) {
      timer.cancel();
      report(false);
      return;
    }
    if (pendingFrame) return;
    pendingFrame = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      pendingFrame = false;
      final vm = onscreenPairingVm(WidgetsBinding.instance.rootElement);
      if (vm == null) return;
      timer.cancel();
      try {
        final code = await _fetchCode().timeout(const Duration(seconds: 15));
        if (!identical(
          vm,
          onscreenPairingVm(WidgetsBinding.instance.rootElement),
        )) {
          report(false);
          return;
        }
        if (autoSubmit) {
          await vm.submitPairingCode(code);
        } else {
          vm.onCodeChanged(code);
        }
        report(true);
      } catch (_) {
        // Never stringify an exception: it could carry response/URI values.
        report(false);
      }
    });
    WidgetsBinding.instance.scheduleFrame();
  });
  // Retained by its callback until it cancels; no long-lived fixture state.
  assert(timer.isActive);
}
