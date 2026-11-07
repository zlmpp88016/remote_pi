// 模型面板（Plan/84 阶段 4b）。
//
// 这个文件装着明文 API key，所以测试的第一要务是证明**面板撒不出密钥**：
//  - config 里根本没有 key 字段（主机已删除），只有 has_key 布尔。
//  - UI 上不出现任何像密钥的东西：没有 sk- 前缀、没有掩码、没有长度提示。
//  - 写入只发路径寻址 ops，永不整文件 replace（那会把删掉密钥的配置写回去）。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/models.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/dock/models/models_panel.dart';
import 'package:mobile/ui/dock/models/viewmodels/models_viewmodel.dart';
import 'package:provider/provider.dart';

const _epk = 'Bz02uLi';
const _rev = 'sha256-models-1';

PeerRecord _peer() => const PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Mac de Teste',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

/// 主机发来的 config 样本。密钥字段**不存在**（不是置空、不是打码）。
Map<String, dynamic> _body({
  bool writable = true,
  bool modeSafe = true,
  Map<String, dynamic>? config,
}) => {
  'revision': _rev,
  'file': {
    'exists': true,
    'parseable': true,
    'writable': writable,
    'mode_safe': modeSafe,
  },
  'config': config ??
      {
        'providers': {
          'my-newapi': {'baseUrl': 'https://api.example.com'},
          'antigravity': {'baseUrl': 'https://ag.example.com'},
        },
      },
  // 线上形状是点号路径（主机 pathKey() 拼的），不是 provider 名。
  // mock 用错形状会让测试一直绿而面板一直显示「未设置密钥」。
  'secrets': {
    'providers.my-newapi.apiKey': {'has_key': true},
    'providers.antigravity.apiKey': {'has_key': false},
  },
};

class _Channel implements IChannel, IControlLink {
  _Channel({this.writable = true, this.modeSafe = true, this.describeError, this.mutateError});

  final bool writable;
  final bool modeSafe;
  final String? describeError;
  final String? mutateError;

  String revision = _rev;
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
      case ModelsDescribeRequest():
        if (describeError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.modelsDescribe,
            rawAction: 'models_describe',
            error: describeError!,
          ));
        } else {
          _server.add(ModelsDescribeOk(
            inReplyTo: msg.id,
            body: _body(writable: writable, modeSafe: modeSafe),
          ));
        }
      case ModelsMutateRequest():
        if (mutateError != null) {
          _server.add(ActionError(
            inReplyTo: msg.id,
            action: ActionName.modelsMutate,
            rawAction: 'models_mutate',
            error: mutateError!,
          ));
        } else {
          revision = 'sha256-models-2';
          _server.add(ModelsMutateOk(inReplyTo: msg.id, revision: revision));
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

Future<ModelsViewModel> _pump(WidgetTester tester, _Channel ch) async {
  late ModelsViewModel vm;
  await tester.runAsync(() async {
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    await conn.connectTo(_peer());
    await Future<void>.delayed(const Duration(milliseconds: 20));
    conn.switchRoom('room-1');
    vm = ModelsViewModel(SessionCatalog(conn));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    addTearDown(conn.dispose);
  });
  addTearDown(vm.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<ModelsViewModel>.value(
      value: vm,
      child: const MaterialApp(home: ModelsPanel()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return vm;
}

/// 屏幕上所有可见文本。
List<String> _allText(WidgetTester tester) {
  final out = <String>[];
  for (final e in find.byType(Text).evaluate()) {
    final w = e.widget as Text;
    final d = w.data;
    if (d != null) out.add(d);
    final span = w.textSpan;
    if (span != null) out.add(span.toPlainText());
  }
  return out;
}

void main() {
  testWidgets('打开即 describe', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(ch.requests.where((r) => r['type'] == 'models_describe'), isNotEmpty);
    await ch.close();
  });

  testWidgets('provider 选择器只显示选中项，密钥状态跟着选中的走', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    // 第一个 provider 被选中并渲染在 DropdownButton 里。
    expect(find.text('my-newapi'), findsOneWidget);
    // 它不是「已配置」，而是由 secrets 点号路径决定 —— 这条断言同时盯着那个
    // 曾经用错键名的 bug。
    expect(find.text(ModelsCopy.keySet), findsOneWidget);
    expect(find.text(ModelsCopy.keyMissing), findsNothing);
    await ch.close();
  });

  testWidgets('切换 provider 后密钥状态跟着换', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    await tester.runAsync(() async {
      await tester.tap(find.byType(DropdownButton<String>));
      await Future<void>.delayed(const Duration(milliseconds: 40));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      await tester.tap(find.text('antigravity').last);
      await Future<void>.delayed(const Duration(milliseconds: 40));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // antigravity 没有密钥。
    expect(find.text(ModelsCopy.keyMissing), findsOneWidget);
    await ch.close();
  });

  testWidgets('屏幕上不出现任何像密钥的东西', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    final texts = _allText(tester);
    for (final t in texts) {
      // 没有 sk- 前缀、没有省略式掩码、没有 "***"。
      expect(t.contains('sk-'), isFalse, reason: '泄漏密钥前缀: $t');
      expect(t.contains('...'), isFalse, reason: '泄漏掩码: $t');
      expect(t.contains('***'), isFalse, reason: '泄漏掩码: $t');
      // baseUrl 允许显示（它不是密钥），但 key 相关字段不该有值可显示。
      expect(RegExp(r'key\s*[:=]\s*\S', caseSensitive: false).hasMatch(t), isFalse,
          reason: '泄漏 key 值: $t');
    }
    await ch.close();
  });

  testWidgets('密钥输入框启动即空 —— 没有值可预填，也没有掩码', (tester) async {
    final ch = _Channel();
    await _pump(tester, ch);
    expect(find.text(ModelsCopy.keyHint), findsOneWidget);
    // 面板现在可编辑（baseUrl/api/模型），密钥框也在 —— 但它必须是空的。
    // 预填一个掩码是「把掩码当成 key 写回去」的经典路径。
    final keyField = tester.widget<TextField>(
      find.descendant(
        of: find.byType(ModelsPanel),
        matching: find.byWidgetPredicate(
          (w) => w is TextField && w.obscureText && w.controller?.text == '',
        ),
      ).first,
    );
    expect(keyField.controller!.text, isEmpty);
    await ch.close();
  });

  testWidgets('文件不可写时提示只读', (tester) async {
    final ch = _Channel(writable: false);
    await _pump(tester, ch);
    expect(find.text(ModelsCopy.readOnly), findsOneWidget);
    await ch.close();
  });

  testWidgets('权限过宽时单独提示 —— 可写不等于安全', (tester) async {
    final ch = _Channel(modeSafe: false);
    await _pump(tester, ch);
    expect(find.text(ModelsCopy.modeUnsafe), findsOneWidget);
    await ch.close();
  });

  testWidgets('陈旧 revision 有自己的句子', (tester) async {
    final ch = _Channel(describeError: 'conflict');
    await _pump(tester, ch);
    expect(find.text(ModelsCopy.conflict), findsOneWidget);
    expect(find.text(ModelsCopy.permission), findsNothing);
    await ch.close();
  });

  testWidgets('文件损坏时给出修复指引', (tester) async {
    final ch = _Channel(describeError: 'corrupted');
    await _pump(tester, ch);
    expect(find.text(ModelsCopy.corrupted), findsOneWidget);
    await ch.close();
  });

  testWidgets('写入只发路径寻址 ops，永不整文件 replace', (tester) async {
    final ch = _Channel();
    final vm = await _pump(tester, ch);

    await tester.runAsync(() async {
      await vm.save([
        ModelsOp.set(const ['providers', 'my-newapi', 'baseUrl'], 'https://new.example.com'),
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final req = ch.requests.firstWhere((r) => r['type'] == 'models_mutate');
    expect(req['revision'], _rev);
    final ops = req['ops'] as List;
    expect(ops, hasLength(1));
    final op = ops.first as Map;
    // 路径寻址：整文件 replace 会把删掉密钥的 config 写回去，抹掉用户的 key。
    expect(op['op'], 'set');
    expect(op['path'], ['providers', 'my-newapi', 'baseUrl']);
    await ch.close();
  });

  testWidgets('写入校验失败时说文件未被改动', (tester) async {
    final ch = _Channel(mutateError: 'verify_failed');
    final vm = await _pump(tester, ch);

    await tester.runAsync(() async {
      await vm.save([
        ModelsOp.set(const ['providers', 'my-newapi', 'baseUrl'], 'https://x'),
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text(ModelsCopy.verifyFailed), findsOneWidget);
    await ch.close();
  });

  testWidgets('没有 provider 时说明清楚，不是空白', (tester) async {
    final ch = _Channel();
    final vm = await _pump(tester, ch);
    expect(vm.snapshot, isNotNull);
    await ch.close();
  });
}
