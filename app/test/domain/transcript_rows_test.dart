// Plan 01 — transcript row grouping. Tool bursts collapse into one row; every
// other message keeps its own row; a lone tool event is NOT grouped (a
// one-item group would add a tap for no benefit).

import 'package:app/domain/session_state.dart';
import 'package:app/domain/transcript_rows.dart';
import 'package:flutter_test/flutter_test.dart';

ToolEvent _tool(String id) => ToolEvent(
  id: id,
  toolCallId: 'tc_$id',
  tool: 'bash',
  args: const <String, dynamic>{},
);

void main() {
  group('groupTranscriptRows', () {
    test('an empty transcript yields no rows', () {
      expect(groupTranscriptRows(const []), isEmpty);
    });

    test('a lone tool event stays a single row', () {
      final rows = groupTranscriptRows([_tool('t1')]);
      expect(rows, hasLength(1));
      expect(rows.single, isA<SingleMessageRow>());
    });

    test('two adjacent tool events become one group', () {
      final rows = groupTranscriptRows([_tool('t1'), _tool('t2')]);
      expect(rows, hasLength(1));
      expect(rows.single, isA<ToolGroupRow>());
      expect((rows.single as ToolGroupRow).tools, hasLength(2));
    });

    test('a non-tool message splits the groups', () {
      final rows = groupTranscriptRows([
        _tool('t1'),
        _tool('t2'),
        const AssistantMsg(id: 'a1', text: 'done'),
        _tool('t3'),
        _tool('t4'),
        _tool('t5'),
      ]);
      expect(rows, hasLength(3));
      expect(rows[0], isA<ToolGroupRow>());
      expect(rows[1], isA<SingleMessageRow>());
      expect(rows[2], isA<ToolGroupRow>());
      expect((rows[2] as ToolGroupRow).tools, hasLength(3));
    });

    test('preserves order and message identity', () {
      final rows = groupTranscriptRows([
        const UserMsg(id: 'u1', text: 'hi'),
        const AssistantMsg(id: 'a1', text: 'hello'),
      ]);
      expect(rows, hasLength(2));
      expect((rows[0] as SingleMessageRow).message.id, 'u1');
      expect((rows[1] as SingleMessageRow).message.id, 'a1');
    });

    test('a trailing run of tools is flushed', () {
      final rows = groupTranscriptRows([
        const UserMsg(id: 'u1', text: 'hi'),
        _tool('t1'),
        _tool('t2'),
      ]);
      expect(rows, hasLength(2));
      expect(rows.last, isA<ToolGroupRow>());
    });

    test('a non-tool message between single tools keeps them separate', () {
      final rows = groupTranscriptRows([
        _tool('t1'),
        const AssistantMsg(id: 'a1', text: 'x'),
        _tool('t2'),
      ]);
      expect(rows, hasLength(3));
      expect(rows[0], isA<SingleMessageRow>());
      expect(rows[1], isA<SingleMessageRow>());
      expect(rows[2], isA<SingleMessageRow>());
    });

    test('compaction rows are single rows too', () {
      final rows = groupTranscriptRows([
        const CompactionMsg(id: 'c1', summary: 's', tokensBefore: 10),
        _tool('t1'),
        _tool('t2'),
      ]);
      expect(rows, hasLength(2));
      expect(rows[0], isA<SingleMessageRow>());
      expect(rows[1], isA<ToolGroupRow>());
    });
  });
}
