// 自动化面板（Plan/84 阶段 5）。
//
// 三条诚实性要求，每条都有对应测试：
//  - `model == null` 必须写成「继承工作区当前模型」，不能留白。
//  - `last_status` 是守护进程封闭词表，原样显示不翻译。
//  - 启用/禁用之后重新拉列表，不本地改写。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/automations/automations_panel.dart';
import 'package:mobile/ui/dock/automations/viewmodels/automations_viewmodel.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

Map<String, dynamic> _task({
  String id = 'j1',
  String prompt = '检查依赖更新',
  String schedule = '0 9 * * *',
  bool enabled = true,
  Map<String, dynamic>? model,
  String? lastStatus,
  String? nextRun,
  String? lastRun,
}) => {
  'id': id,
  'daemon_id': 'd1',
  'schedule': schedule,
  'kind': 'daily',
  'prompt': prompt,
  'enabled': enabled,
  'skip_if_busy': false,
  'wake': false,
  'catchup': false,
  'created_at': '2026-01-01T00:00:00Z',
  'last_run': lastRun,
  'last_status': lastStatus,
  'next_run': nextRun,
  'model': model,
  'fresh_session': false,
};

class _Channel implements IChannel, IControlLink {
  _Channel({this.tasks = const []});

  List<Map<String, dynamic>> tasks;
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
      case ScheduleListRequest():
        _server.add(ScheduleListOk(
          inReplyTo: msg.id,
          tasks: tasks,
          workspaceNames: const {'d1': 'remote_pi'},
        ));
      case ScheduleSetEnabled(:final jobId, :final enabled):
        // 主机真的改了状态，下一次 list 会反映出来。
        tasks = [
          for (final t in tasks)
            if (t['id'] == jobId) {...t, 'enabled': enabled} else t,
        ];
        _server.add(ScheduleAck(inReplyTo: msg.id, jobId: jobId));
      case ScheduleRemove(:final jobId):
        tasks = tasks.where((t) => t['id'] != jobId).toList();
        _server.add(ScheduleAck(inReplyTo: msg.id, jobId: jobId));
      case ScheduleRunNow(:final jobId):
        _server.add(ScheduleAck(inReplyTo: msg.id, jobId: jobId));
      case ModelsDescribeRequest():
        // 主机上真实的 models 配置：两个 provider、三个模型。
        _server.add(ModelsDescribeOk(
          inReplyTo: msg.id,
          body: {
            "revision": "rev-1",
            "file": {"path": "/home/u/.pi/models.json", "exists": true, "mode": "600"},
            "config": {
              "providers": {
                "acme": {
                  "baseUrl": "https://acme.test/v1",
                  "models": {"fast": {}, "deep": {}},
                },
                "solo": {
                  "baseUrl": "https://solo.test/v1",
                  "models": {"only": {}},
                },
              },
            },
            "secrets": <String, dynamic>{},
          },
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

Future<AutomationsViewModel> _pump(WidgetTester tester, _Channel ch) async {
  late AutomationsViewModel vm;
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = AutomationsViewModel(SessionCatalog(conn));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    addTearDown(conn.dispose);
  });
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<AutomationsViewModel>.value(
      value: vm,
      child: const MaterialApp(home: AutomationsPanel()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return vm;
}

void main() {
  testWidgets('打开即拉列表', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(ch.requests.where((r) => r['type'] == 'schedule_list'), isNotEmpty);
    await ch.close();
  });

  testWidgets('没有任务时说「还没有任何自动化」，不是空白', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(find.text(AutomationsCopy.none), findsOneWidget);
    expect(find.text(AutomationsCopy.noneHint), findsOneWidget);
    await ch.close();
  });

  testWidgets('model 为 null 时明确写「继承工作区当前模型」', (tester) async {
    final ch = _Channel(tasks: [_task()]);
    await _pump(tester, ch);
    // 留白会让用户以为任务用了固定模型，而实际成本跟着会话模型走。
    expect(find.text(AutomationsCopy.inheritModel), findsOneWidget);
    await ch.close();
  });

  testWidgets('固定模型时显示 provider/id，不显示「继承」', (tester) async {
    final ch = _Channel(tasks: [
      _task(model: {'provider': 'my-newapi', 'id': 'deepseek-flash', 'name': null}),
    ]);
    await _pump(tester, ch);
    expect(find.text('my-newapi/deepseek-flash'), findsOneWidget);
    expect(find.text(AutomationsCopy.inheritModel), findsNothing);
    await ch.close();
  });

  testWidgets('last_status 原样显示，不翻译', (tester) async {
    final ch = _Channel(tasks: [_task(lastStatus: 'woke_and_delivered')]);
    await _pump(tester, ch);
    // 封闭词表：翻译它会让 woke_and_delivered 与 delivered 看起来一样。
    expect(find.text('woke_and_delivered'), findsOneWidget);
    await ch.close();
  });

  testWidgets('禁用后重新拉列表，状态来自主机', (tester) async {
    final ch = _Channel(tasks: [_task(enabled: true)]);
    await _pump(tester, ch);
    expect(find.text(AutomationsCopy.enabled), findsOneWidget);

    await tester.runAsync(() async {
      await tester.tap(find.text(AutomationsCopy.disable));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 确实发过 set_enabled，且值为 false。
    final req = ch.requests.firstWhere((r) => r['type'] == 'schedule_set_enabled');
    expect(req['enabled'], isFalse);
    // 界面反映的是主机回给我们的新状态，不是本地改的。
    expect(find.text(AutomationsCopy.disabled), findsOneWidget);
    await ch.close();
  });

  testWidgets('删除需要确认，取消则不删', (tester) async {
    final ch = _Channel(tasks: [_task()]);
    await _pump(tester, ch);

    await tester.runAsync(() async {
      await tester.tap(find.byTooltip(Common.delete));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    expect(find.text(AutomationsCopy.deleteConfirmTitle), findsOneWidget);

    await tester.runAsync(() async {
      await tester.tap(find.text(Common.cancel));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    // 取消后没有发 remove。
    expect(ch.requests.where((r) => r['type'] == 'schedule_remove'), isEmpty);
    await ch.close();
  });

  testWidgets('cron 原文与工作区名都显示', (tester) async {
    final ch = _Channel(tasks: [_task(schedule: '*/15 * * * *')]);
    await _pump(tester, ch);
    expect(find.text('*/15 * * * *'), findsOneWidget);
    expect(find.text('remote_pi'), findsOneWidget);
    await ch.close();
  });

  testWidgets('next_run 有值时显示「下次」', (tester) async {
    final ch = _Channel(tasks: [_task(nextRun: '2026-11-03T09:00:00Z')]);
    await _pump(tester, ch);
    expect(find.textContaining(AutomationsCopy.nextRun), findsOneWidget);
    await ch.close();
  });

  testWidgets('从未运行且无下次时间时说「从未运行」', (tester) async {
    final ch = _Channel(tasks: [_task()]);
    await _pump(tester, ch);
    expect(find.text(AutomationsCopy.neverRun), findsOneWidget);
    await ch.close();
  });

  testWidgets('创建表单有全部 9 个字段 —— 不是 web 的残缺副本', (tester) async {
    final ch = _Channel(tasks: [_task()]);
    await _pump(tester, ch);

    await tester.runAsync(() async {
      await tester.tap(find.byTooltip(AutomationsCopy.create));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // web 有而旧 iOS 版本没有的六个字段，逐个盯住。
    expect(find.text(AutomationsCopy.preset), findsOneWidget);
    expect(find.text(AutomationsCopy.cron), findsOneWidget);
    expect(find.text(AutomationsCopy.prompt), findsOneWidget);
    expect(find.text(AutomationsCopy.tz), findsOneWidget);
    expect(find.text(AutomationsCopy.target), findsOneWidget);
    expect(find.text(AutomationsCopy.model), findsOneWidget);
    expect(find.text(AutomationsCopy.sessionMode), findsOneWidget);
    expect(find.text(AutomationsCopy.skipIfBusy), findsOneWidget);
    expect(find.text(AutomationsCopy.wake), findsOneWidget);
    expect(find.text(AutomationsCopy.catchup), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 15));
    await ch.close();
  });

  // 回归：第一条自动化必须能建出来。此前「目标工作区」的候选只从
  // `catalog.tasks` 派生，主机上一条任务都没有时集合为空 → 下拉框不渲染 →
  // `_daemonId` 恒为 null → 「创建」永远灰着，用户无法创建**第一条**。
  // 权威来源应是主机随 `schedule_list` 下发的 `workspace_names`。
  testWidgets('没有任务时也能选到工作区，第一条自动化可以创建', (tester) async {
    final ch = _Channel(tasks: const []);
    await _pump(tester, ch);

    await tester.runAsync(() async {
      await tester.tap(find.byTooltip(AutomationsCopy.create));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 工作区选择器必须存在，并显示主机给的名字而不是空白。
    expect(find.text(AutomationsCopy.target), findsOneWidget);
    expect(find.text('remote_pi'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 15));
    await ch.close();
  });

  testWidgets('预设计划选中后真的覆盖 cron 输入框', (tester) async {
    final ch = _Channel(tasks: [_task()]);
    await _pump(tester, ch);
    await tester.runAsync(() async {
      await tester.tap(find.byTooltip(AutomationsCopy.create));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 选「每小时」→ cron 应变成 0 * * * *。
    await tester.runAsync(() async {
      await tester.tap(find.text(AutomationsCopy.presetCustom).first);
      await Future<void>.delayed(const Duration(milliseconds: 40));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      await tester.tap(find.text(AutomationsCopy.presetHourly).last);
      await Future<void>.delayed(const Duration(milliseconds: 40));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('0 * * * *'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 15));
    await ch.close();
  });

  testWidgets('点卡片看详情 —— 动作仍在按钮上，不被点击吞走', (tester) async {
    final ch = _Channel(tasks: [_task(lastStatus: 'delivered')]);
    await _pump(tester, ch);
    await tester.runAsync(() async {
      await tester.tap(find.text('检查依赖更新'));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text(AutomationsCopy.detail), findsOneWidget);
    expect(find.text(AutomationsCopy.detailCron), findsOneWidget);
    expect(find.text(AutomationsCopy.detailLastStatus), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 15));
    await ch.close();
  });
  testWidgets('创建表单能选到主机上有、但从未用过的模型', (tester) async {
    // 回归防线：曾经下拉只列「现有任务里固定过的模型」，导致用户无法给新任务
    // 指定一个没用过的模型 —— 而 web 端用全局列表，这是 iOS 的功能缺口。
    final ch = _Channel(tasks: [_task()]);
    final vm = await _pump(tester, ch);
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();

    // 主机 models 配置里的三个模型都在候选里（task 本身没固定任何模型）。
    expect(vm.modelCatalog, contains(('acme', 'fast')));
    expect(vm.modelCatalog, contains(('acme', 'deep')));
    expect(vm.modelCatalog, contains(('solo', 'only')));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 15));
    await ch.close();
  });
}
