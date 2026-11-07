// `changes_snapshot` 的 wire 解析测试。
//
// 字段名取自 `server/src/protocol/types.ts` 的 `ChangesSnapshotWire` /
// `ChangesEntryWire`，不是臆造的。每条测试都对应 host 真会发出的形状。

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/protocol/changes.dart';

void main() {
  group('ChangesEntry — git 的封闭词表', () {
    test('" M" 是仅 worktree 修改', () {
      const e = ChangesEntry(rel: 'a.dart', x: ' ', y: 'M');
      expect(e.isStaged, isFalse);
      expect(e.isUnstaged, isTrue);
      expect(e.isUntracked, isFalse);
      expect(e.isConflicted, isFalse);
    });

    test('"M " 是仅暂存', () {
      const e = ChangesEntry(rel: 'a.dart', x: 'M', y: ' ');
      expect(e.isStaged, isTrue);
      expect(e.isUnstaged, isFalse);
    });

    test('"??" 是未跟踪，不算已修改', () {
      const e = ChangesEntry(rel: 'new.dart', x: '?', y: '?');
      expect(e.isUntracked, isTrue);
      // 未跟踪的文件不是「未暂存的修改」—— 它是自己一类，计数也分开。
      expect(e.isUnstaged, isFalse);
      expect(e.isStaged, isFalse);
    });

    test('"UU" 是冲突', () {
      const e = ChangesEntry(rel: 'c.dart', x: 'U', y: 'U');
      expect(e.isConflicted, isTrue);
    });

    test('"AA" 与 "DD" 也算冲突', () {
      expect(const ChangesEntry(rel: 'a', x: 'A', y: 'A').isConflicted, isTrue);
      expect(const ChangesEntry(rel: 'd', x: 'D', y: 'D').isConflicted, isTrue);
    });

    test('重命名标记被保留', () {
      final e = ChangesEntry.fromJson({'rel': 'new_name.dart', 'x': 'R', 'y': ' ', 'renamed': true});
      expect(e.renamed, isTrue);
      // rel 是重命名后的新名字，不是旧名字。
      expect(e.rel, 'new_name.dart');
    });
  });

  group('ChangesTotal — 与 entries 截断无关', () {
    test('从 wire 解析四项计数', () {
      final t = ChangesTotal.fromJson({
        'staged': 3,
        'unstaged': 7,
        'untracked': 41,
        'conflicted': 2,
      });
      expect(t.staged, 3);
      expect(t.unstaged, 7);
      expect(t.untracked, 41);
      expect(t.conflicted, 2);
      expect(t.isEmpty, isFalse);
    });

    test('全零是空的', () {
      expect(ChangesTotal.fromJson(const {}).isEmpty, isTrue);
    });
  });

  group('ChangesSnapshot', () {
    test('完整快照逐字段解析', () {
      final s = ChangesSnapshot.fromJson({
        'is_repo': true,
        'branch': 'feat/remote-workspace-sessions',
        'head': {'sha7': 'd20782f', 'subject': 'feat(web): SSE direct transport by default'},
        'ahead': 2,
        'behind': 0,
        'entries': [
          {'rel': 'src/a.ts', 'x': 'M', 'y': ' ', 'renamed': false},
          {'rel': 'src/b.ts', 'x': ' ', 'y': 'M', 'renamed': false},
        ],
        'total': {'staged': 1, 'unstaged': 1, 'untracked': 0, 'conflicted': 0},
        'truncated': false,
      });

      expect(s.branch, 'feat/remote-workspace-sessions');
      expect(s.head?.sha7, 'd20782f');
      expect(s.head?.subject, 'feat(web): SSE direct transport by default');
      expect(s.ahead, 2);
      expect(s.behind, 0);
      expect(s.entries, hasLength(2));
      expect(s.entries.first.rel, 'src/a.ts');
      expect(s.total.staged, 1);
      expect(s.truncated, isFalse);
    });

    test('detached HEAD：branch 与 head 都是 null', () {
      final s = ChangesSnapshot.fromJson({
        'is_repo': true,
        'branch': null,
        'head': null,
        'entries': const [],
        'total': const {},
        'truncated': false,
      });
      expect(s.branch, isNull);
      expect(s.head, isNull);
      expect(s.entries, isEmpty);
    });

    test('截断时 total 仍是全量 —— 这是 UI 计数唯一可信来源', () {
      final s = ChangesSnapshot.fromJson({
        'is_repo': true,
        'branch': 'main',
        'entries': [
          {'rel': 'a.ts', 'x': ' ', 'y': 'M', 'renamed': false},
        ],
        'total': {'staged': 0, 'unstaged': 260, 'untracked': 0, 'conflicted': 0},
        'truncated': true,
      });
      // entries 被上限切成 1 条，但 total 说的仍然是 260。
      expect(s.entries, hasLength(1));
      expect(s.total.unstaged, 260);
      expect(s.truncated, isTrue);
    });

    test('缺少可选字段不抛异常', () {
      final s = ChangesSnapshot.fromJson(const {});
      expect(s.branch, isNull);
      expect(s.entries, isEmpty);
      expect(s.total.isEmpty, isTrue);
    });
  });

  group('ChangesUnavailable — 封闭原因词表', () {
    test('五个 wire 值全部可映射', () {
      expect(ChangesUnavailable.fromWire('not_a_repo'), ChangesUnavailable.notARepo);
      expect(ChangesUnavailable.fromWire('git_missing'), ChangesUnavailable.gitMissing);
      expect(ChangesUnavailable.fromWire('timeout'), ChangesUnavailable.timeout);
      expect(ChangesUnavailable.fromWire('workspace_missing'), ChangesUnavailable.workspaceMissing);
      expect(ChangesUnavailable.fromWire('unreadable'), ChangesUnavailable.unreadable);
    });

    test('未知值与 null 都映射为 null，不抛异常', () {
      // 未知 reason 必须落到「固定文案」的兜底路径，而不是把主机发来的
      // 原字符串回显给用户 —— 那可能是异常文本或路径。
      expect(ChangesUnavailable.fromWire('some_future_reason'), isNull);
      expect(ChangesUnavailable.fromWire(null), isNull);
    });
  });
}
