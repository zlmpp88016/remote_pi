// BASELINE — pins the CURRENT subtitle behaviour of a workspace row.
//
// The user reported (docs/1109/迭代需求.md, item 2): every workspace under the
// same pairing shows the identical "上次配对: xx ago", which is redundant —
// they want the actual cwd.
//
// The cause is `session_tile.dart`: when a room carries no `model`, the
// subtitle falls back to `peer.pairedAt`. That value is PEER-level, so all
// workspaces of one server render the same string. The tests below assert that
// current behaviour so Passo 2's change shows up as an explicit diff rather
// than a silent rewrite.
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

void main() {
  group('SessionTile subtitle — BASELINE (peer-level timestamp)', () {
    testWidgets('a room without a model falls back to the peer timestamp',
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

      // Current behaviour: the cwd is IGNORED in favour of the paired-at
      // timestamp, which is why the user sees the same text on every row.
      expect(find.textContaining('上次配对'), findsOneWidget);
      expect(find.textContaining(r'D:\proj\one'), findsNothing);
    });

    testWidgets(
        'BASELINE: two workspaces of the SAME peer render the identical subtitle',
        (tester) async {
      const roomOne = RoomInfo(
        roomId: 'r1',
        startedAt: 1,
        name: 'one',
        cwd: r'D:\proj\one',
      );
      const roomTwo = RoomInfo(
        roomId: 'r2',
        startedAt: 2,
        name: 'two',
        cwd: r'D:\proj\two',
      );

      String subtitleOf(WidgetTester t) {
        final texts = t
            .widgetList<Text>(find.byType(Text))
            .map((w) => w.data ?? '')
            .toList();
        return texts.firstWhere(
          (s) => s.contains('上次配对') || s.contains(r'D:\proj'),
          orElse: () => '',
        );
      }

      await _pump(
        tester,
        const SessionTile(peer: _peer, isLive: true, room: roomOne, onOpen: _noop),
      );
      final first = subtitleOf(tester);

      await _pump(
        tester,
        const SessionTile(peer: _peer, isLive: true, room: roomTwo, onOpen: _noop),
      );
      final second = subtitleOf(tester);

      // The defect, pinned: different workspaces, SAME text.
      expect(first, isNotEmpty);
      expect(second, first);
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
  });
}

void _noop() {}
