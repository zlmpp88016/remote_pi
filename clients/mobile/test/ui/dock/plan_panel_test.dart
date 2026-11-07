// 计划面板（Plan/84）。
//
// 保护的还是同一件事：**面板不撒谎**。
//  - 「这个工作区没有计划文档」与「读不到」必须是两句不同的话。
//  - 拒绝原因映射成固定句子，不回显主机散文（可能带绝对路径）。
//  - 行标签是「序号 + 名字」，不显示绝对路径。
//  - 打开文档时必须带上 root —— 主机靠它把读取限制在工作区内。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/plan/plan_panel.dart';
import 'package:mobile/ui/dock/plan/viewmodels/plan_viewmodel.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';
const _root = '/ws';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// 假通道：按请求类型回答 `fs_list_ok` / `fs_read_ok` / `action_error`。
class _Channel implements IChannel, IControlLink {
  _Channel({
    this.entries = const [],
    this.content = '',
    this.readError,
    this.listError,
  });

  final List<Map<String, dynamic>> entries;
  final String content;

  /// `fs_read` 的拒绝原因（走 action_error 帧）。
  final String? readError;

  /// `fs_list` 的拒绝原因。
  final String? listError;

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
    requests.add(j);
    switch (msg) {
      case FsList():
        if (listError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.fsList,
            rawAction: 'fs_list',
            error: listError!,
          ));
        } else {
          _server.add(FsListOk(
            inReplyTo: msg.id,
            path: msg.path,
            parent: null,
            entries: entries
                .map((e) => WireFsEntry.fromJson(e))
                .toList(),
          ));
        }
      case FsReadRequest():
        if (readError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.fsRead,
            rawAction: 'fs_read',
            error: readError!,
          ));
        } else {
          _server.add(FsReadOk(
            inReplyTo: msg.id,
            path: msg.path,
            content: content,
            truncated: false,
            bytes: content.length,
          ));
        }
      default:
        break;
    }
  }

  @override
  Future<void> close() async {
    await _server.close();
    await _control.close();
  }
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

Future<PlanViewModel> _pump(WidgetTester tester, _Channel ch) async {
  late PlanViewModel vm;
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = PlanViewModel(SessionCatalog(conn), root: _root);
    await Future<void>.delayed(const Duration(milliseconds: 40));
    addTearDown(conn.dispose);
  });
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<PlanViewModel>.value(
      value: vm,
      child: const MaterialApp(home: PlanPanel()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
  return vm;
}

void main() {
  testWidgets('打开即列 plan/ —— 不依赖缓存', (tester) async {
    final ch = _Channel(entries: const []);
    await _pump(tester, ch);
    final req = ch.requests.firstWhere((r) => r['type'] == 'fs_list');
    expect(req['path'], '$_root/plan');
    await ch.close();
  });

  testWidgets('没有文档时说「未找到计划文档」，不是空白', (tester) async {
    final ch = _Channel(entries: const []);
    await _pump(tester, ch);
    expect(find.text(PlanCopy.noDocuments), findsOneWidget);
    await ch.close();
  });

  testWidgets('只列 .md 文件，目录不算文档', (tester) async {
    final ch = _Channel(entries: const [
      {'name': '84-ios-web-parity.md', 'kind': 'file'},
      {'name': 'archive.md', 'kind': 'dir'},
      {'name': 'notes.txt', 'kind': 'file'},
    ]);
    await _pump(tester, ch);
    expect(find.textContaining('ios web parity'), findsOneWidget);
    // 目录与 .txt 都不出现。
    expect(find.textContaining('archive'), findsNothing);
    expect(find.textContaining('notes'), findsNothing);
    await ch.close();
  });

  testWidgets('行标签显示序号，不显示绝对路径', (tester) async {
    final ch = _Channel(entries: const [
      {'name': '84-ios-web-parity.md', 'kind': 'file'},
    ]);
    await _pump(tester, ch);
    // 序号单独一格。
    expect(find.text('84'), findsOneWidget);
    // 绝对路径不得出现在屏幕上。
    expect(find.textContaining(_root), findsNothing);
    await ch.close();
  });

  testWidgets('点一行打开文档，且请求带 root', (tester) async {
    final ch = _Channel(
      entries: const [
        {'name': '84-ios-web-parity.md', 'kind': 'file'},
      ],
      content: '# 标题\n\n正文',
    );
    await _pump(tester, ch);
    await tester.runAsync(() async {
      await tester.tap(find.textContaining('ios web parity'));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final req = ch.requests.firstWhere((r) => r['type'] == 'fs_read');
    // 关键的否定断言：root 必须原样带上，主机靠它做目录围栏。
    expect(req['root'], _root);
    expect(req['path'], '$_root/plan/84-ios-web-parity.md');
    expect(find.textContaining('标题'), findsOneWidget);
    await ch.close();
  });

  testWidgets('拒绝原因映射成固定句子，不回显主机散文', (tester) async {
    final ch = _Channel(
      entries: const [
        {'name': '84-ios-web-parity.md', 'kind': 'file'},
      ],
      readError: 'not_allowed',
    );
    await _pump(tester, ch);
    await tester.runAsync(() async {
      await tester.tap(find.textContaining('ios web parity'));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text(PlanCopy.refused), findsOneWidget);
    // 主机原始 reason 不得出现在屏幕上。
    expect(find.textContaining('not_allowed'), findsNothing);
    await ch.close();
  });

  testWidgets('列表因其他原因失败才给出可重试的提示', (tester) async {
    // `not_found` 已改由「没有 plan/ 目录」呈现（下一个测试），这里用真正
    // 的意外失败。
    final ch = _Channel(listError: 'boom');
    await _pump(tester, ch);
    expect(find.text(Common.somethingFailed), findsOneWidget);
    expect(find.text(Common.retry), findsOneWidget);
    await ch.close();
  });

  // 主机回 `not_found` 是在陈述事实（这个工作区没有 plan/ 目录），不是故障。
  // 早先它被兜底成「出错了」并配一个重试按钮，而重试永远不会成功 —— 用户
  // 会一直点。这句话也绝不能退化成「未找到计划文档」（那暗示目录存在但为空）。
  testWidgets('工作区没有 plan/ 目录时说清楚，并且不给重试按钮', (tester) async {
    final ch = _Channel(listError: 'not_found');
    await _pump(tester, ch);
    expect(find.text(PlanCopy.noDirectory), findsOneWidget);
    expect(find.text(Common.somethingFailed), findsNothing);
    expect(find.text(Common.retry), findsNothing);
    // 与「目录存在但为空」区分开。
    expect(find.text(PlanCopy.noDocuments), findsNothing);
    await ch.close();
  });

  testWidgets('筛选按名字过滤', (tester) async {
    final ch = _Channel(entries: const [
      {'name': '84-ios-web-parity.md', 'kind': 'file'},
      {'name': '72-web-sidebar.md', 'kind': 'file'},
    ]);
    await _pump(tester, ch);
    expect(find.textContaining('ios web parity'), findsOneWidget);
    expect(find.textContaining('web sidebar'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'sidebar');
    await tester.pump();
    expect(find.textContaining('web sidebar'), findsOneWidget);
    expect(find.textContaining('ios web parity'), findsNothing);
    await ch.close();
  });
}
