// `fs_list` / `fs_read` 之上那一层的测试（Plan/84）。
//
// wire 类型本身归 `protocol.dart`，这里测的是两件它没有的东西：
//  - `FsRefusal` 的封闭词表（必须与 host 的 `FsReadError` 逐字一致）
//  - `markdownFiles` 这个投影（计划面板的列表来源）

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/protocol/plan.dart';
import 'package:mobile/protocol/protocol.dart';

FsListOk _list(List<Map<String, dynamic>> raw) =>
    FsListOk.fromJson({
  'in_reply_to': 'r1',
  'path': '/ws/plan',
  'entries': raw,
});

void main() {
  group('FsRefusal — 词表必须与 host 一致', () {
    test('四个真实 wire 值全部可映射', () {
      expect(FsRefusal.fromWire('not_found'), FsRefusal.notFound);
      expect(FsRefusal.fromWire('permission_denied'), FsRefusal.permissionDenied);
      expect(FsRefusal.fromWire('not_a_file'), FsRefusal.notAFile);
      expect(FsRefusal.fromWire('not_allowed'), FsRefusal.notAllowed);
    });

    test('臆造的值不匹配 —— 本条防止客户端与 host 词表悄悄分叉', () {
      // 这些曾经是我按常理猜出来的值。它们不存在于 fs_nav.ts 的 FsReadError 里。
      expect(FsRefusal.fromWire('outside_allowlist'), isNull);
      expect(FsRefusal.fromWire('too_large'), isNull);
      expect(FsRefusal.fromWire('missing'), isNull);
      expect(FsRefusal.fromWire('unreadable'), isNull);
    });

    test('未知值与 null 都映射为 null，不抛异常', () {
      expect(FsRefusal.fromWire('future_reason'), isNull);
      expect(FsRefusal.fromWire(null), isNull);
    });
  });

  group('markdownFiles — 计划面板的列表来源', () {
    test('只挑 .md 文件，按名字排序', () {
      final md = _list([
        {'name': '84-ios.md', 'kind': 'file'},
        {'name': 'subdir', 'kind': 'dir'},
        {'name': '00-decisions.md', 'kind': 'file'},
        {'name': 'notes.txt', 'kind': 'file'},
        {'name': '72-sidebar.md', 'kind': 'file'},
      ]).markdownFiles;
      expect(md.map((e) => e.name).toList(),
          ['00-decisions.md', '72-sidebar.md', '84-ios.md']);
    });

    test('名字里带 .md 的目录不算文档', () {
      final md = _list([
        {'name': 'archive.md', 'kind': 'dir'},
        {'name': 'real.md', 'kind': 'file'},
      ]).markdownFiles;
      expect(md.map((e) => e.name).toList(), ['real.md']);
    });

    test('空目录返回空列表，不抛异常', () {
      expect(_list(const []).markdownFiles, isEmpty);
    });
  });

  group('FsReadOk — 截断时 bytes 是真实大小', () {
    test('完整读取', () {
      final r = FsReadOk.fromJson({
        'in_reply_to': 'r1',
        'path': '/ws/plan/84.md',
        'content': '# 标题',
        'truncated': false,
        'bytes': 12,
      });
      expect(r.path, '/ws/plan/84.md');
      expect(r.content, '# 标题');
      expect(r.truncated, isFalse);
      expect(r.bytes, 12);
    });

    test('截断时 content 只是开头，bytes 说的是真实文件大小', () {
      final r = FsReadOk.fromJson({
        'in_reply_to': 'r2',
        'path': '/ws/plan/big.md',
        'content': '# 开头',
        'truncated': true,
        'bytes': 5242880,
      });
      expect(r.truncated, isTrue);
      expect(r.bytes, 5242880);
    });

    test('缺省字段不抛异常', () {
      final r = FsReadOk.fromJson(const {});
      expect(r.content, isEmpty);
      expect(r.truncated, isFalse);
      expect(r.bytes, 0);
    });
  });
}
