// 文件面板（Plan/84 阶段 3）。
//
// 要点：
//  - 刚打开时**不**自动列目录 —— 猜一个默认路径会让用户以为已经看过某处。
//  - 「尚未列出任何内容」与「该目录为空」是两句不同的话。
//  - 只有目录可点；文件不可点，不给假的点击态。
//  - 勾上「显示隐藏项」后重新列，且 show_hidden 必须真的发给主机。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/files/files_panel.dart';
import 'package:mobile/ui/dock/files/viewmodels/files_viewmodel.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _Channel implements IChannel, IControlLink {
  _Channel({this.entries = const [], this.fail = false});

  final List<Map<String, dynamic>> entries;
  final bool fail;

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
    requests.add(msg.toJson());
    if (msg is FsList) {
      if (fail) {
        _server.add(ActionError(
          inReplyTo: msg.id,
          action: ActionName.fsList,
          rawAction: 'fs_list',
          error: 'permission_denied',
        ));
      } else {
        _server.add(FsListOk(
          inReplyTo: msg.id,
          path: msg.path,
          parent: '/',
          entries: entries.map((e) => WireFsEntry.fromJson(e)).toList(),
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

Future<FilesViewModel> _pump(WidgetTester tester, _Channel ch) async {
  late FilesViewModel vm;
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = FilesViewModel(SessionCatalog(conn));
    await Future<void>.delayed(const Duration(milliseconds: 30));
    addTearDown(conn.dispose);
  });
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<FilesViewModel>.value(
      value: vm,
      child: const MaterialApp(home: FilesPanel()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return vm;
}

Future<void> _list(WidgetTester tester, _Channel ch, String path) async {
  await tester.enterText(find.byType(TextField), path);
  await tester.runAsync(() async {
    await tester.tap(find.text(FilesCopy.list));
    await Future<void>.delayed(const Duration(milliseconds: 60));
  });
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  testWidgets('刚打开不自动列目录 —— 不猜默认路径', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(ch.requests.where((r) => r['type'] == 'fs_list'), isEmpty);
    expect(find.text(FilesCopy.nothingListed), findsOneWidget);
    await ch.close();
  });

  testWidgets('点「列出」才发请求，路径原样带上', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/home/user/project');
    final req = ch.requests.firstWhere((r) => r['type'] == 'fs_list');
    expect(req['path'], '/home/user/project');
    await ch.close();
  });

  testWidgets('空目录说「该目录为空」，不是「尚未列出」', (tester) async {
    final ch = _Channel(entries: const []);
    await _pump(tester, ch);
    await _list(tester, ch, '/empty');
    expect(find.text(FilesCopy.emptyDir), findsOneWidget);
    expect(find.text(FilesCopy.nothingListed), findsNothing);
    await ch.close();
  });

  testWidgets('目录可点、文件不可点', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
      {'name': 'README.md', 'kind': 'file'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');

    final dirTile = tester.widget<ListTile>(
      find.ancestor(of: find.text('src'), matching: find.byType(ListTile)),
    );
    final fileTile = tester.widget<ListTile>(
      find.ancestor(of: find.text('README.md'), matching: find.byType(ListTile)),
    );
    expect(dirTile.onTap, isNotNull);
    // 文件没有「进去」这回事。
    expect(fileTile.onTap, isNull);
    await ch.close();
  });

  testWidgets('点目录进去时路径拼接正确', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    await tester.runAsync(() async {
      await tester.tap(find.text('src'));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    final reqs = ch.requests.where((r) => r['type'] == 'fs_list').toList();
    expect(reqs.last['path'], '/ws/src');
    await ch.close();
  });

  testWidgets('目录行有「加为工作区」与「启动 Pi」—— web 有，iOS 也必须有', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    expect(find.byTooltip(FilesCopy.addToCatalogTitle), findsOneWidget);
    expect(find.byTooltip(FilesCopy.startHereTitle), findsOneWidget);
    await ch.close();
  });

  testWidgets('文件行没有工作区动作 —— 给错的动作比没动作更糟', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'a.txt', 'kind': 'file'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    expect(find.byTooltip(FilesCopy.addToCatalogTitle), findsNothing);
    expect(find.byTooltip(FilesCopy.startHereTitle), findsNothing);
    await ch.close();
  });

  testWidgets('点「加为工作区」发 workspace_add，路径是拼出来的子目录', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    await tester.runAsync(() async {
      await tester.tap(find.byTooltip(FilesCopy.addToCatalogTitle));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    final add = ch.requests.where((r) => r['type'] == 'workspace_add').toList();
    expect(add, hasLength(1));
    expect(add.single['path'], '/ws/src');
    await ch.close();
  });

  testWidgets('点「启动 Pi」发 workspace_start，cwd 是子目录', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    await tester.runAsync(() async {
      await tester.tap(find.byTooltip(FilesCopy.startHereTitle));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    final start = ch.requests.where((r) => r['type'] == 'workspace_start').toList();
    expect(start, hasLength(1));
    expect(start.single['cwd'], '/ws/src');
    await ch.close();
  });

  testWidgets('工具栏有当前路径的三个动作 —— 子目录行管不到当前目录本身', (tester) async {
    // 目录里没有任何子项：这正是子目录行动作覆盖不到的场景。
    final ch = _Channel(entries: const []);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    expect(find.text(FilesCopy.addToCatalog), findsOneWidget);
    expect(find.text(FilesCopy.startHere), findsOneWidget);
    expect(find.text(FilesCopy.removeFromCatalog), findsOneWidget);
    await ch.close();
  });

  testWidgets('工具栏动作作用于当前路径，不是子目录', (tester) async {
    final ch = _Channel(entries: const []);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    await tester.runAsync(() async {
      await tester.tap(find.text(FilesCopy.addToCatalog));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    final add = ch.requests.where((r) => r['type'] == 'workspace_add').toList();
    expect(add.single['path'], '/ws');
    await ch.close();
  });

  testWidgets('工具栏「移除」发 workspace_remove', (tester) async {
    final ch = _Channel(entries: const []);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    await tester.runAsync(() async {
      await tester.tap(find.text(FilesCopy.removeFromCatalog));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    final rm = ch.requests.where((r) => r['type'] == 'workspace_remove').toList();
    expect(rm.single['path'], '/ws');
    await ch.close();
  });

  testWidgets('勾上显示隐藏项后 show_hidden 真的发给主机', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    final before = ch.requests.where((r) => r['type'] == 'fs_list').length;

    await tester.runAsync(() async {
      await tester.tap(find.byType(Checkbox));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final reqs = ch.requests.where((r) => r['type'] == 'fs_list').toList();
    expect(reqs.length, greaterThan(before));
    expect(reqs.last['show_hidden'], isTrue);
    await ch.close();
  });

  testWidgets('列出失败给出可重试的明确提示', (tester) async {
    final ch = _Channel(fail: true);
    await _pump(tester, ch);
    await _list(tester, ch, '/forbidden');
    expect(find.text(FilesCopy.listFailed), findsOneWidget);
    expect(find.text(Common.retry), findsOneWidget);
    await ch.close();
  });

  testWidgets('有父目录时给出「上一级」', (tester) async {
    final ch = _Channel(entries: const [
      {'name': 'src', 'kind': 'dir'},
    ]);
    await _pump(tester, ch);
    await _list(tester, ch, '/ws');
    expect(find.text(FilesCopy.upOneLevel), findsOneWidget);
    await ch.close();
  });
}
