import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/pairing/pair_payload.dart';
import 'package:mobile/ui/onboarding/widgets/pair_step.dart';
import 'package:mobile/ui/pairing/viewmodels/pairing_viewmodel.dart';
import 'package:provider/provider.dart';

import '../../tool/history_perf/p86_fixture_prefill.dart';

// Marker retains the production screen type and Provider ancestry without
// starting onboarding, storage, networking, or platform identity services.
class _Screen extends PairStep {
  _Screen() : super(onPaired: () {}, onBack: () {}, onSkip: () {});

  @override
  State<PairStep> createState() => _ScreenState();
}

class _ScreenState extends State<PairStep> {
  @override
  Widget build(BuildContext context) => const SizedBox();
}

class _Vm extends ChangeNotifier implements PairingViewModel {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// Synthetic Element tree avoids Flutter's own recursive mount/layout while
// exercising the real lookup over a tree deeper than the VM sampling ceiling.
class _TreeElement extends Element {
  _TreeElement(this.children, this.onVisit, {this.live = true})
    : super(const SizedBox());
  final List<Element> children;
  final void Function() onVisit;
  final bool live;
  @override
  bool get mounted => live;
  @override
  bool get debugDoingBuild => false;
  @override
  void visitChildren(ElementVisitor visitor) {
    onVisit();
    for (final child in children) {
      visitor(child);
    }
  }

  @override
  void performRebuild() => super.performRebuild();
}

void main() {
  test(
    'deep fixture lookup uses bounded call depth and skips unmounted subtrees',
    () {
      var visits = 0;
      var deepestStack = 0;
      void visited() {
        visits++;
        if (visits == 1 || visits == 2000) {
          final depth = StackTrace.current.toString().split('\n').length;
          if (depth > deepestStack) deepestStack = depth;
        }
      }

      Element root = _TreeElement([], visited);
      for (var i = 1; i < 2000; i++) {
        root = _TreeElement([root], visited);
      }
      root = _TreeElement([
        _TreeElement(
          [_TreeElement([], () => fail('unmounted descendant'))],
          () => fail('unmounted node'),
          live: false,
        ),
        root,
      ], () {});
      expect(onscreenPairingVm(root), isNull);
      expect(visits, 2000);
      expect(deepestStack, lessThan(100));
    },
  );

  testWidgets('lookup keeps first DFS provided VM across sibling branches', (
    tester,
  ) async {
    final first = _Vm();
    final second = _Vm();
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Column(
          children: [
            ChangeNotifierProvider<PairingViewModel>.value(
              value: first,
              child: Padding(padding: EdgeInsets.zero, child: _Screen()),
            ),
            ChangeNotifierProvider<PairingViewModel>.value(
              value: second,
              child: _Screen(),
            ),
          ],
        ),
      ),
    );
    expect(onscreenPairingVm(tester.binding.rootElement), same(first));
  });

  test('dual opt-in accepts only the exact frozen origin', () {
    expect(fixturePrefillAllowed(true, p86FixtureOrigin), isTrue);
    expect(fixturePrefillAllowed(false, p86FixtureOrigin), isFalse);
    for (final origin in [
      '',
      '$p86FixtureOrigin/',
      '$p86FixtureOrigin/other',
      '$p86FixtureOrigin?redirect=other',
      'http://localhost:61986',
      'https://127.0.0.1:61986',
      'http://127.0.0.1:61987',
      'http://127.0.0.1:61986@elsewhere',
    ]) {
      expect(fixturePrefillAllowed(true, origin), isFalse);
    }
  });

  test(
    'ordered full URI normalizes standard key and real parser accepts it',
    () {
      final bytes = List<int>.filled(32, 255);
      final code = fixturePairingCode({
        'token': 'TEST_ONLY_TOKEN',
        'hostEpk': base64.encode(bytes),
        'name': 'ignored fixture name',
      });
      final query = Uri.parse(code).queryParameters;
      expect(query.keys.toList(), ['t', 'epk', 'n', 'rm', 'r']);
      expect(query['n'], 'P86_TEST');
      expect(query['rm'], 'host');
      expect(query['r'], p86FixtureOrigin);
      expect(query['epk'], base64Url.encode(bytes).replaceAll('=', ''));
      final payload = PairPayload.tryParse(code);
      expect(payload, isNotNull);
      expect(payload!.epkBytes, bytes);
      expect(payload.token == 'TEST_ONLY_TOKEN', isTrue);
    },
  );

  test('canonical base64url stays canonical; malformed fields fail closed', () {
    final key = base64Url.encode(List<int>.filled(32, 254)).replaceAll('=', '');
    expect(
      Uri.parse(
            fixturePairingCode({'token': 'TEST', 'hostEpk': key}),
          ).queryParameters['epk'] ==
          key,
      isTrue,
    );
    for (final view in <Map<String, dynamic>>[
      {},
      {'token': 'bad space', 'hostEpk': key},
      {'token': 'TEST', 'hostEpk': 'AA'},
      {'token': 'TEST', 'hostEpk': 1},
    ]) {
      expect(() => fixturePairingCode(view), throwsFormatException);
    }
  });

  testWidgets(
    'tree lookup returns exactly provided screen VM and blocks sheet',
    (tester) async {
      final vm = _Vm();
      await tester.pumpWidget(
        ChangeNotifierProvider<PairingViewModel>.value(
          value: vm,
          child: Directionality(
            textDirection: TextDirection.ltr,
            child: _Screen(),
          ),
        ),
      );
      expect(
        identical(onscreenPairingVm(tester.binding.rootElement), vm),
        isTrue,
      );
      await tester.pumpWidget(
        ChangeNotifierProvider<PairingViewModel>.value(
          value: vm,
          child: Directionality(
            textDirection: TextDirection.ltr,
            child: Column(
              children: [
                _Screen(),
                const SizedBox(key: ValueKey('pairing-sheet-code')),
              ],
            ),
          ),
        ),
      );
      expect(onscreenPairingVm(tester.binding.rootElement), isNull);
      await tester.pumpWidget(const SizedBox());
      expect(onscreenPairingVm(tester.binding.rootElement), isNull);
    },
  );
}
