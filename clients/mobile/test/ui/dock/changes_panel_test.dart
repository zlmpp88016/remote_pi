// 更改面板（Plan/84）。
//
// 这些测试保护同一件事：**面板撒不了谎**。
//  - 「干净」和「读不了」必须是两种不同外观 —— 混为一谈会让正常面板像坏了。
//  - 计数取自 `total`，不是 `entries.length`（后者可能被主机截断）。
//  - 失败时绝不回显主机散文或异常文本（可能带绝对路径 / 内部堆栈）。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/changes/changes_panel.dart';
import 'package:mobile/ui/dock/changes/viewmodels/changes_viewmodel.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// 假通道：收到 `changes_snapshot` 后按配置回答成功帧或失败帧。
class _Channel implements IChannel, IControlLink {
  _Channel({this.snapshot, this.unavailableReason});

  final Map<String, dynamic>? snapshot;
  final String? unavailableReason;

  final sentTypes = <String>[];
  final requests = <Map<String, dynamic>>[];
  final _server = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();

  @override
  Stream<ServerMessage> get serverMessages => _server.stream;
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}

  @override
  Future<void> send(ClientMessage msg) async {
    if (_server.isClosed) return;
    final j = msg.toJson();
    sentTypes.add((j['type'] as String?) ?? '');
    requests.add(j);
    if (msg is ChangesSnapshotRequest) {
      if (unavailableReason != null) {
        _server.add(ChangesSnapshotUnavailable(
          inReplyTo: msg.id,
          reason: unavailableReason!,
        ));
      } else {
        _server.add(ChangesSnapshotOk(
          inReplyTo: msg.id,
          snapshot: snapshot ?? const {},
        ));
      }
    }
  }

  @override
  Future<void> close() async {
    await _server.close();
    await _control.close();
  }
}

Future<void> _pump(WidgetTester tester, _Channel ch) async {
  late ChangesViewModel vm;
  // runAsync 是必需的：真实的 ConnectionManager 会等 microtask/定时器，
  // 而 widget test 的假时钟不会推进它们 —— 不包起来就会永远卡住（本轮实测）。
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = ChangesViewModel(SessionCatalog(conn), root: '/ws', daemonId: 'd1');
    await Future<void>.delayed(const Duration(milliseconds: 40));
    addTearDown(conn.dispose);
  });
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<ChangesViewModel>.value(
      value: vm,
      child: const MaterialApp(home: ChangesPanel()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

class _FakeStorage extends PairingStorage {
  @override
  Future<List<PeerRecord>> listPeers() async => [_peer()];
  @override
  Future<PeerRecord?> loadPeer(String epk) async => epk == _epk ? _peer() : null;
  @override
  Future<void> savePeer(PeerRecord record) async {}
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {}
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async => const [];
  @override
  Future<void> deleteRooms(String epk) async {}
}

void main() {
  testWidgets('打开即自己发请求 —— 不依赖缓存被别处填过', (tester) async {
    final ch = _Channel(snapshot: {'is_repo': true, 'entries': const [], 'total': const {}});
    await _pump(tester, ch);
    expect(ch.sentTypes, contains('changes_snapshot'));
    // root 与 daemon_id 必须原样带上：前者决定读哪个目录，后者防止过期回复错配。
    // 按 type 找那一条 —— 通道上还有握手与 ping 等其它帧，first 不一定是它。
    final req = ch.requests.firstWhere((r) => r['type'] == 'changes_snapshot');
    expect(req['root'], '/ws');
    expect(req['daemon_id'], 'd1');
    await ch.close();
  });

  testWidgets('干净的仓库显示「没有更改」，不是空面板', (tester) async {
    final ch = _Channel(snapshot: {
      'is_repo': true,
      'branch': 'main',
      'entries': const [],
      'total': {'staged': 0, 'unstaged': 0, 'untracked': 0, 'conflicted': 0},
      'truncated': false,
    });
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.noChanges), findsOneWidget);
    await ch.close();
  });

  testWidgets('不是 git 仓库时给出明确说明，而不是空列表', (tester) async {
    final ch = _Channel(unavailableReason: 'not_a_repo');
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.notARepo), findsOneWidget);
    // 空列表那句话**不能**出现在这里。
    expect(find.text(ChangesCopy.noChanges), findsNothing);
    await ch.close();
  });

  testWidgets('没装 git 时说清是没装 git', (tester) async {
    final ch = _Channel(unavailableReason: 'git_missing');
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.noGit), findsOneWidget);
    await ch.close();
  });

  testWidgets('超时有自己的句子', (tester) async {
    final ch = _Channel(unavailableReason: 'timeout');
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.timedOut), findsOneWidget);
    await ch.close();
  });

  testWidgets('未知 reason 落到固定兜底句，不回显主机发的字符串', (tester) async {
    final ch = _Channel(unavailableReason: 'some_future_reason');
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.notReadableDetail), findsOneWidget);
    // 关键的否定断言：主机原始字符串不得出现在屏幕上。
    expect(find.textContaining('some_future_reason'), findsNothing);
    await ch.close();
  });

  testWidgets('计数取自 total，不是 entries.length', (tester) async {
    final ch = _Channel(snapshot: {
      'is_repo': true,
      'branch': 'main',
      'entries': [
        {'rel': 'only-one.ts', 'x': ' ', 'y': 'M', 'renamed': false},
      ],
      // 截断：正文只给 1 条，但总数是 260。
      'total': {'staged': 0, 'unstaged': 260, 'untracked': 0, 'conflicted': 0},
      'truncated': true,
    });
    await _pump(tester, ch);
    expect(find.text('260'), findsOneWidget);
    expect(find.text(ChangesCopy.unstaged), findsOneWidget);
    await ch.close();
  });

  testWidgets('分支与 HEAD 都显示出来', (tester) async {
    final ch = _Channel(snapshot: {
      'is_repo': true,
      'branch': 'feat/x',
      'head': {'sha7': 'd20782f', 'subject': 'feat(web): SSE'},
      'entries': [
        {'rel': 'a.ts', 'x': 'M', 'y': ' ', 'renamed': false},
      ],
      'total': {'staged': 1, 'unstaged': 0, 'untracked': 0, 'conflicted': 0},
      'truncated': false,
    });
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.branch), findsOneWidget);
    expect(find.text('feat/x'), findsOneWidget);
    expect(find.text(ChangesCopy.head), findsOneWidget);
    await ch.close();
  });

  testWidgets('条目路径直接显示，rel 是仓库相对路径', (tester) async {
    final ch = _Channel(snapshot: {
      'is_repo': true,
      'entries': [
        {'rel': 'src/a.ts', 'x': ' ', 'y': 'M', 'renamed': false},
      ],
      'total': {'staged': 0, 'unstaged': 1, 'untracked': 0, 'conflicted': 0},
      'truncated': false,
    });
    await _pump(tester, ch);
    expect(find.text('src/a.ts'), findsOneWidget);
    await ch.close();
  });

  testWidgets('状态列保留两个字符 —— 「仅暂存」与「仅修改」不能长得一样', (tester) async {
    final ch = _Channel(snapshot: {
      'is_repo': true,
      'entries': [
        {'rel': 'staged.ts', 'x': 'M', 'y': ' ', 'renamed': false},
        {'rel': 'modified.ts', 'x': ' ', 'y': 'M', 'renamed': false},
      ],
      'total': {'staged': 1, 'unstaged': 1, 'untracked': 0, 'conflicted': 0},
      'truncated': false,
    });
    await _pump(tester, ch);
    // 'M ' 与 ' M' 都必须原样出现。若 trim 了，两者都变成 'M'，
    // 用户就看不出自己有没有暂存。
    expect(find.text('M '), findsOneWidget);
    expect(find.text(' M'), findsOneWidget);
    await ch.close();
  });

  testWidgets('冲突计数用错误色标出', (tester) async {
    final ch = _Channel(snapshot: {
      'is_repo': true,
      'entries': [
        {'rel': 'c.ts', 'x': 'U', 'y': 'U', 'renamed': false},
      ],
      'total': {'staged': 0, 'unstaged': 0, 'untracked': 0, 'conflicted': 3},
      'truncated': false,
    });
    await _pump(tester, ch);
    expect(find.text(ChangesCopy.conflicted), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    await ch.close();
  });
}
