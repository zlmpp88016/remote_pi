import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/protocol/models.dart';

/// `secrets` 的键名是**点号路径**，不是 provider 名。
///
/// 主机的 `pathKey()`（`server/src/daemon/models_config.ts:162`）把字段位置拼成
/// `"providers.<id>.apiKey"`。用 provider 名去查会永远拿到 null，于是面板对
/// 每一台已经配好密钥的主机都显示「未设置密钥」—— 一个静默的谎，不是错误。
void main() {
  test('hasKey 用点号路径查找，不是 provider 名', () {
    final snap = ModelsSnapshot.fromJson({
      'revision': 'abc',
      'file': {'exists': true, 'parseable': true, 'writable': true, 'mode_safe': true},
      'config': {
        'providers': {
          'my-newapi': {'baseUrl': 'http://x/v1', 'api': 'openai', 'models': []},
        },
      },
      'secrets': {
        'providers.my-newapi.apiKey': {'has_key': true},
      },
    });

    // 真事实：主机配了密钥。
    expect(snap.secrets['providers.my-newapi.apiKey']?.hasKey, isTrue);
    // 旧写法（secrets[provider]）会在这里返回 false —— 这就是那个 bug。
    expect(snap.secrets['my-newapi'], isNull);
    // 正确行为。
    expect(snap.hasKey('my-newapi'), isTrue);
    // 未配置的 provider 仍然是 false，不是「全部为真」。
    expect(snap.hasKey('other'), isFalse);
  });

  test('hasKey 在没有 secrets 帧时安全返回 false', () {
    final snap = ModelsSnapshot.fromJson({'revision': 'r'});
    expect(snap.hasKey('anything'), isFalse);
  });
}
