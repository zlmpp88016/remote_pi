// The subtitle of a workspace row answers ONE question: which folder is this?
//
// It used to fall back to `peer.pairedAt` — a PEER-level value — so every
// workspace of the same server rendered the identical "上次配对: xx ago". The
// user reported it as redundant and asked for the real cwd instead
// (docs/1109/迭代需求.md, item 2).
//
// These tests were born as BASELINE assertions of the defect; they now assert
// the fix. The first one is the reason the defect was invisible for so long:
// it compared a single row against a timestamp, and only rendering TWO rows of
// the same peer side by side exposes that they are identical.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/home/widgets/session_tile.dart';

const _peer = PeerRecord(
  remoteEpk: 'epk_A',
  sessionName: 'Mac do User',
  relayUrl: 'ws://localhost:8080',
  pairedAt: '2026-01-01T00:00:00Z',
  roomId: 'r1',
);

Future<void> _pump(WidgetTester tester, SessionTile tile) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: SizedBox(width: 400, child: tile)),
    ),
  );
}

String _subtitleOf(WidgetTester t) {
  final texts = t
      .widgetList<Text>(find.byType(Text))
      .map((w) => w.data ?? '')
      .toList();
  // The subtitle is the only mono-font line besides the title; identify it by
  // exclusion — it is never the row title.
  return texts.firstWhere(
    (s) => s.contains('proj') || s == '—' || s.contains('claude'),
    orElse: () => '',
  );
}

void main() {
  group('SessionTile subtitle — the workspace cwd', () {
    testWidgets('two workspaces of the SAME peer render DIFFERENT subtitles',
        (tester) async {
      await _pump(
        tester,
        const SessionTile(
          peer: _peer,
          isLive: true,
          room: RoomInfo(
            roomId: 'r1',
            startedAt: 1,
            name: 'one',
            cwd: r'D:\proj\one',
          ),
          onOpen: _noop,
        ),
      );
      final first = _subtitleOf(tester);

      await _pump(
        tester,
        const SessionTile(
          peer: _peer,
          isLive: true,
          room: RoomInfo(
            roomId: 'r2',
            startedAt: 2,
            name: 'two',
            cwd: r'D:\proj\two',
          ),
          onOpen: _noop,
        ),
      );
      final second = _subtitleOf(tester);

      expect(first, isNotEmpty);
      expect(second, isNotEmpty);
      // The whole point: identical text here was the reported bug.
      expect(second, isNot(first));
      expect(first, contains('one'));
      expect(second, contains('two'));
    });

    testWidgets('the subtitle shows the cwd, never the paired-at timestamp',
        (tester) async {
      await _pump(
        tester,
        const SessionTile(
          peer: _peer,
          isLive: true,
          room: RoomInfo(
            roomId: 'r1',
            startedAt: 1,
            name: 'r1',
            cwd: r'D:\proj\one',
          ),
          onOpen: _noop,
        ),
      );

      expect(find.textContaining(r'D:\proj\one'), findsOneWidget);
      expect(find.textContaining('上次配对'), findsNothing);
      // A peer-level fact must not leak into a workspace row.
      expect(find.textContaining('ago'), findsNothing);
    });

    testWidgets('a missing cwd shows a placeholder, not a timestamp',
        (tester) async {
      await _pump(
        tester,
        const SessionTile(
          peer: _peer,
          isLive: false,
          room: RoomInfo(roomId: 'r1', startedAt: 1, name: 'r1'),
          onOpen: _noop,
        ),
      );

      expect(find.text('—'), findsOneWidget);
      expect(find.textContaining('上次配对'), findsNothing);
      expect(find.textContaining('ago'), findsNothing);
    });

    testWidgets('a null room also shows the placeholder', (tester) async {
      await _pump(
        tester,
        const SessionTile(peer: _peer, isLive: false, onOpen: _noop),
      );

      expect(find.text('—'), findsOneWidget);
      expect(find.textContaining('上次配对'), findsNothing);
    });

    testWidgets('a room WITH a model shows the model instead', (tester) async {
      await _pump(
        tester,
        const SessionTile(
          peer: _peer,
          isLive: true,
          room: RoomInfo(
            roomId: 'r1',
            startedAt: 1,
            name: 'r1',
            cwd: r'D:\proj\one',
            model: 'anthropic/claude-opus-4',
          ),
          onOpen: _noop,
        ),
      );

      expect(find.textContaining('claude-opus-4'), findsOneWidget);
      expect(find.textContaining('上次配对'), findsNothing);
    });

    testWidgets('a very long cwd stays on one line and is ellipsised',
        (tester) async {
      final longCwd =
          r'D:\a-very\long\nested\path\that\goes\on\and\on\and\on\forever\project';
      await _pump(
        tester,
        SessionTile(
          peer: _peer,
          isLive: true,
          room: RoomInfo(roomId: 'r1', startedAt: 1, name: 'r1', cwd: longCwd),
          onOpen: _noop,
        ),
      );

      final text = tester.widget<Text>(
        find.textContaining(r'D:\a-very'),
      );
      expect(text.maxLines, 1);
      expect(text.overflow, TextOverflow.ellipsis);
    });
  });
}

void _noop() {}
