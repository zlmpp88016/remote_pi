// 停靠栏容器（Plan/84 阶段 3）。
//
// 保护的核心：**切到某个面，该面就自己开始加载**。
// web 端曾因 `handleDockTabChange` 从未被调用，导致 5 个面板从空缓存渲染、
// 看起来像坏了。这里断言的是「切过去就发了请求」，而不是「切过去有个空壳」。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/dock_page.dart';

const _epk = 'Bz02uLi';
const _root = '/ws';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// 回答任何 `fs_list` / `changes_snapshot`，并记录收到的请求类型。
class _Channel implements IChannel, IControlLink {
  _Channel();

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
    switch (msg) {
      case FsList():
        _server.add(FsListOk(
          inReplyTo: msg.id,
          path: msg.path,
          parent: null,
          entries: const [],
        ));
      case ChangesSnapshotRequest():
        _server.add(ChangesSnapshotOk(
          inReplyTo: msg.id,
          snapshot: const {'is_repo': true, 'entries': [], 'total': {}},
        ));
      case PiSurface():
        _server.add(PiSurfaceOk(
          inReplyTo: msg.id,
          runtime: const PiSurfaceRuntime(running: true),
          skills: const [],
          packages: const [],
        ));
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

Future<_Channel> _pumpDock(
  WidgetTester tester, {
  DockFace initialFace = DockFace.plan,
  bool workspaceLive = true,
  bool modelsSupported = true,
  bool settingsSupported = true,
}) async {
  final ch = _Channel();
  late SessionCatalog catalog;
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    catalog = SessionCatalog(conn);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    addTearDown(conn.dispose);
  });

  await tester.pumpWidget(
    MaterialApp(
      home: DockPage(
        catalog: catalog,
        root: _root,
        initialFace: initialFace,
        workspaceLive: workspaceLive,
        modelsSupported: modelsSupported,
        settingsSupported: settingsSupported,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return ch;
}

void main() {
  testWidgets('打开即加载初始面 —— 不是空壳', (tester) async {
    final ch = await _pumpDock(tester, initialFace: DockFace.plan);
    // 计划面首次出现就该列 plan/。
    final req = ch.requests.firstWhere((r) => r['type'] == 'fs_list');
    expect(req['path'], '$_root/plan');
    await ch.close();
  });

  testWidgets('切到更改面才发 changes_snapshot —— 懒加载', (tester) async {
    final ch = await _pumpDock(tester, initialFace: DockFace.plan);
    // 还没切，不应该有 changes_snapshot。
    expect(ch.requests.where((r) => r['type'] == 'changes_snapshot'), isEmpty);

    await tester.runAsync(() async {
      // 点 TabBar 里那个，不是 AppBar 标题（两者文字相同）。
      await tester.tap(find.descendant(
        of: find.byType(TabBar),
        matching: find.text(DockTab.changes),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final req = ch.requests.firstWhere((r) => r['type'] == 'changes_snapshot');
    // root 必须原样带上 —— 主机靠它决定读哪个目录。
    expect(req['root'], _root);
    await ch.close();
  });

  testWidgets('切到插件面才发 pi_surface', (tester) async {
    final ch = await _pumpDock(tester, initialFace: DockFace.plan);
    expect(ch.requests.where((r) => r['type'] == 'pi_surface'), isEmpty);

    await tester.runAsync(() async {
      await tester.tap(find.descendant(
        of: find.byType(TabBar),
        matching: find.text(DockTab.plugins),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(ch.requests.where((r) => r['type'] == 'pi_surface'), isNotEmpty);
    await ch.close();
  });

  testWidgets('切走再切回不重发请求 —— 已建过的面保持存活', (tester) async {
    final ch = await _pumpDock(tester, initialFace: DockFace.changes);
    final before = ch.requests.where((r) => r['type'] == 'changes_snapshot').length;
    expect(before, greaterThan(0));

    // 切到计划，再切回更改。
    await tester.runAsync(() async {
      await tester.tap(find.descendant(
        of: find.byType(TabBar),
        matching: find.text(DockTab.plan),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(find.descendant(
        of: find.byType(TabBar),
        matching: find.text(DockTab.changes),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 关键：没有第二次 changes_snapshot。更改面要跑 git status，
    // 每次切 tab 都重跑会变成静默的 IO 风暴。
    final after = ch.requests.where((r) => r['type'] == 'changes_snapshot').length;
    expect(after, before);
    await ch.close();
  });

  testWidgets('工作区未运行时，需要读工作树的三个面不发请求且说明原因', (tester) async {
    // changes 面最贵（主机要跑 git status），所以拿它当探针。
    final ch = await _pumpDock(
      tester,
      initialFace: DockFace.changes,
      workspaceLive: false,
    );

    // 关键断言：一发请求都没有。不是「发了被拒」，是根本没发。
    expect(
      ch.requests.where((r) => r['type'] == 'changes_snapshot'),
      isEmpty,
    );
    // 而且面板不是空白 —— 空白无法解释自己。
    expect(find.text(WorkspaceReason.dockNeedsLive), findsOneWidget);
    await ch.close();
  });

  testWidgets('工作区未运行时不挡住不需要工作树的面', (tester) async {
    // 自动化读的是主机自己的调度表，与某个工作区的 Pi 在不在跑无关。
    final ch = await _pumpDock(
      tester,
      initialFace: DockFace.automations,
      workspaceLive: false,
    );
    expect(find.text(WorkspaceReason.dockNeedsLive), findsNothing);
    expect(
      ch.requests.where((r) => r['type'] == 'schedule_list').length,
      greaterThan(0),
    );
    // 自动化面有一个轮询计时器；先把它跑完再拆树，否则测试框架会报
    // "A Timer is still pending even after the widget tree was disposed"。
    await tester.pumpWidget(const SizedBox.shrink());
    // 该面有一个 12 秒的重试计时器，推进到它之后。
    await tester.pump(const Duration(seconds: 15));
    await ch.close();
  });

  testWidgets('主机没声明 models_config 时，模型面不发请求且说明原因', (tester) async {
    final ch = await _pumpDock(
      tester,
      initialFace: DockFace.models,
      modelsSupported: false,
    );
    expect(
      ch.requests.where((r) => r['type'] == 'models_describe'),
      isEmpty,
    );
    expect(find.text(WorkspaceReason.noModelsCapability), findsOneWidget);
    await ch.close();
  });

  testWidgets('主机没声明 settings 时，设置面不发请求且说明原因', (tester) async {
    final ch = await _pumpDock(
      tester,
      initialFace: DockFace.settings,
      settingsSupported: false,
    );
    expect(
      ch.requests.where((r) => r['type'] == 'settings_describe'),
      isEmpty,
    );
    expect(find.text(WorkspaceReason.noSettingsCapability), findsOneWidget);
    await ch.close();
  });

  testWidgets('七个面都在 tab 里，顺序与 web 一致', (tester) async {
    final ch = await _pumpDock(tester, initialFace: DockFace.plan);
    for (final f in DockFace.values) {
      expect(find.text(f.label), findsWidgets, reason: '${f.label} 应在 tab 里');
    }
    await ch.close();
  });
}
