// 设置面板（Plan/84 阶段 4）。
//
// 这是唯一会**改主机文件**的面板，所以测试的重点全在边界上：
//  - 写入必须带回原样的 revision（主机用它拒陈旧写）。
//  - 只发路径寻址的 SET/UNSET，永不整文件 replace。
//  - 陈旧 revision 的错误有自己的句子，不能和「权限被拒」混成一句。
//  - `theme` 只读：这个面板不提供修改它。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/settings/settings_panel.dart';
import 'package:mobile/ui/dock/settings/viewmodels/settings_viewmodel.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';
const _rev = 'sha256-abc123';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _Channel implements IChannel, IControlLink {
  _Channel({
    this.editable = true,
    this.mutateError,
    this.describeError,
  });

  String revision = _rev;
  final bool editable;
  final String? mutateError;
  final String? describeError;

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
      case SettingsDescribeRequest():
        if (describeError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.settingsDescribe,
            rawAction: 'settings_describe',
            error: describeError!,
          ));
        } else {
          _server.add(SettingsDescribeOk(
            inReplyTo: msg.id,
            body: {
              'revision': revision,
              'file': {
                'exists': true,
                'parseable': true,
                'writable': editable,
              },
              'appearance': {'theme': 'dark', 'hide_thinking_block': null},
              'behaviour': {
                'retry_enabled': true,
                'retry_max_retries': 3,
                'retry_base_delay_ms': 500,
                'retry_provider_max_retry_delay_ms': 30000,
              },
            },
          ));
        }
      case SettingsMutateRequest():
        if (mutateError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.settingsMutate,
            rawAction: 'settings_mutate',
            error: mutateError!,
          ));
        } else {
          revision = 'sha256-new';
          _server.add(SettingsMutateOk(inReplyTo: msg.id, revision: revision));
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

Future<SettingsViewModel> _pump(WidgetTester tester, _Channel ch) async {
  late SettingsViewModel vm;
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = SettingsViewModel(SessionCatalog(conn));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    addTearDown(conn.dispose);
  });
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<SettingsViewModel>.value(
      value: vm,
      child: const MaterialApp(home: SettingsPanel()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return vm;
}

void main() {
  testWidgets('打开即 describe，不猜默认值', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(ch.requests.where((r) => r['type'] == 'settings_describe'), isNotEmpty);
    await ch.close();
  });

  testWidgets('theme 只读显示，没有可编辑控件', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(find.text(SettingsCopy.theme), findsOneWidget);
    expect(find.text('dark'), findsOneWidget);
    expect(find.text(SettingsCopy.themeReadOnly), findsOneWidget);
    await ch.close();
  });

  testWidgets('null 的开关显示「未设置」，不冒充「关」', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    // hide_thinking_block 是 null → 必须说「未设置」。
    expect(find.text(SettingsCopy.notSet), findsWidgets);
    await ch.close();
  });

  testWidgets('切开关发 SET，且带回原样的 revision', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);

    await tester.runAsync(() async {
      await tester.tap(find.byType(Switch).first);
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final req = ch.requests.firstWhere((r) => r['type'] == 'settings_mutate');
    // 这是安全边界：主机靠它拒绝陈旧写。
    expect(req['revision'], _rev);
    // 只发路径操作，永不整文件 replace。
    final ops = req['ops'] as List;
    expect(ops, hasLength(1));
    expect((ops.first as Map)['op'], 'set');
    expect((ops.first as Map)['path'], 'hideThinkingBlock');
    await ch.close();
  });

  testWidgets('陈旧 revision 有自己的句子，不与权限错误混同', (tester) async {
    final ch = _Channel(mutateError: 'conflict');
    await _pump(tester, ch);

    await tester.runAsync(() async {
      await tester.tap(find.byType(Switch).first);
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text(SettingsCopy.conflict), findsOneWidget);
    // 不能退化成「出错了」或权限提示。
    expect(find.text(SettingsCopy.permission), findsNothing);
    expect(find.text(Common.somethingFailed), findsNothing);
    await ch.close();
  });

  testWidgets('文件不可写时界面只读并说明原因', (tester) async {
    final ch = _Channel(editable: false);
    await _pump(tester, ch);
    expect(find.text(SettingsCopy.readOnly), findsOneWidget);
    final sw = tester.widget<Switch>(find.byType(Switch).first);
    expect(sw.onChanged, isNull);
    await ch.close();
  });

  testWidgets('文件损坏时给出修复指引，不是笼统错误', (tester) async {
    final ch = _Channel(describeError: 'corrupted');
    await _pump(tester, ch);
    expect(find.text(SettingsCopy.corrupted), findsOneWidget);
    await ch.close();
  });

  testWidgets('写入校验失败时说文件未被改动', (tester) async {
    final ch = _Channel(mutateError: 'verify_failed');
    await _pump(tester, ch);

    await tester.runAsync(() async {
      await tester.tap(find.byType(Switch).first);
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text(SettingsCopy.verifyFailed), findsOneWidget);
    await ch.close();
  });

  testWidgets('六个白名单字段全部呈现', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    for (final label in [
      SettingsCopy.theme,
      SettingsCopy.hideThinking,
      SettingsCopy.retryEnabled,
      SettingsCopy.retryMaxRetries,
      SettingsCopy.retryBaseDelay,
      SettingsCopy.retryProviderMaxDelay,
    ]) {
      expect(find.text(label), findsOneWidget, reason: '$label 应出现');
    }
    await ch.close();
  });
}
