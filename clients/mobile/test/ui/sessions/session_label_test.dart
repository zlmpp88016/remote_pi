import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/sessions/session_label.dart';

WireSessionInfo _s({
  String id = '01a19917-3f54-7140-92ec-06333ea51655',
  String? name,
  String? preview,
  String? cwd,
}) => WireSessionInfo(
  id: id,
  name: name,
  mtime: 0,
  preview: preview,
  live: false,
  cwd: cwd,
);

void main() {
  group('sessionLabel — same rule as web', () {
    test('a folder-like name is NOT a title: every row of one folder read the '
        'same, so the first message wins', () {
      // Measured on the emulator: all 11 sessions of D:\模型测试\4.1f arrive
      // with name "4.1f". Rendering it made the list impossible to tell apart.
      final a = _s(
        name: '4.1f',
        cwd: r'D:\模型测试\4.1f',
        preview: '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画',
      );
      final b = _s(
        id: '01a1b6e5-e92a-775b-ae63-de0da8dde5f1',
        name: '4.1f',
        cwd: r'D:\模型测试\4.1f',
        preview: '/mofrl',
      );
      expect(sessionLabel(a), isNot('4.1f'));
      expect(sessionLabel(b), '/mofrl');
      expect(
        sessionLabel(a),
        isNot(sessionLabel(b)),
        reason: 'two sessions in one folder must not read identically',
      );
    });

    test('a real user-given name still wins over the preview', () {
      final s = _s(name: '回归验收', cwd: r'D:\模型测试\4.1f', preview: '首条消息');
      expect(sessionLabel(s), '回归验收');
    });

    test('POSIX cwd is handled too — the host may not be Windows', () {
      final s = _s(name: 'proj', cwd: '/home/u/proj', preview: 'hello');
      expect(sessionLabel(s), 'hello');
    });

    test('no preview falls back to the short id, not the full uuid', () {
      final s = _s(name: '4.1f', cwd: r'D:\模型测试\4.1f');
      expect(sessionLabel(s), '01a19917');
    });

    test('no cwd means the name cannot be judged folder-like, so it is kept', () {
      expect(sessionLabel(_s(name: '4.1f')), '4.1f');
    });

    test('a pasted blob is cut to one line', () {
      final s = _s(preview: 'x' * 200);
      final label = sessionLabel(s);
      expect(label.length, 64);
      expect(label.endsWith('…'), isTrue);
    });

    test('whitespace in the preview is collapsed', () {
      expect(sessionLabel(_s(preview: '  a\n\t b  ')), 'a b');
    });
  });

  group('sessionSubtitle — never repeat the label', () {
    test('empty when the label already is the first message', () {
      final s = _s(preview: '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画');
      final label = sessionLabel(s);
      expect(sessionSubtitle(s, label), '');
    });

    test('kept when it adds something the label does not say', () {
      final s = _s(name: '回归验收', preview: '完全不同的首条消息内容');
      expect(sessionSubtitle(s, sessionLabel(s)), '完全不同的首条消息内容');
    });

    test('empty when there is no preview at all', () {
      expect(sessionSubtitle(_s(name: 'x'), 'x'), '');
    });
  });
}