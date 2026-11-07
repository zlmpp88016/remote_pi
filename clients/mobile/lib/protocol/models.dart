/// `models_describe` / `models_mutate` —— 主机自己的 `~/.pi/agent/models.json`。
///
/// 与 `server/src/protocol/types.ts` 的 `ModelsDescribeOkWire` /
/// `ModelsSecretsWire` / `ModelsOpWire` 逐字段对齐。
///
/// **这个文件是凭证库。** 主机发来的 `config` 已经把所有密钥字段**删除**
/// （不是置空、不是打码），密钥是否存在由独立的 `secrets` 汇报，且只有
/// `has_key` 一个布尔。这不是客户端的纪律，是主机在结构上就不发 ——
/// 所以这里连"请求密钥"的办法都没有。
///
/// 为什么连掩码都不要（服务端注释的原话，值得抄在这里）：掩码每次泄漏四个
/// 凭证字符，而面板并不基于它做任何决定；更糟的是，把掩码预填进表单是
/// 「把掩码当成 key 写回去」的经典路径。长度也不行 —— 它会暴露是哪个
/// 签发方发的 key。
library;

/// models.json 在磁盘上的状态。全是布尔，没有主机文本。
class ModelsFileState {
  final bool exists;
  final bool parseable;
  final bool writable;

  /// 权限是否安全（仅属主可读）。明文 key 就在这个文件里。
  final bool modeSafe;

  const ModelsFileState({
    this.exists = false,
    this.parseable = false,
    this.writable = false,
    this.modeSafe = false,
  });

  factory ModelsFileState.fromJson(Map<String, dynamic> j) => ModelsFileState(
        exists: j['exists'] as bool? ?? false,
        parseable: j['parseable'] as bool? ?? false,
        writable: j['writable'] as bool? ?? false,
        modeSafe: j['mode_safe'] as bool? ?? false,
      );

  /// 三个写入前提都满足才能编辑。`modeSafe` 单独提示，不阻断读取。
  bool get editable => exists && parseable && writable;
}

/// 一个 provider 的密钥存在性。
///
/// **只有 has_key。** 没有值、没有掩码、没有长度 —— 见文件头。
class ModelsSecret {
  final bool hasKey;

  const ModelsSecret({this.hasKey = false});

  factory ModelsSecret.fromJson(Map<String, dynamic> j) =>
      ModelsSecret(hasKey: j['has_key'] as bool? ?? false);
}

/// 一次成功的 describe。
class ModelsSnapshot {
  /// 原始文件字节的 sha256 —— 乐观并发的栅栏。
  final String revision;
  final ModelsFileState file;

  /// 已解析的配置，**每个密钥字段都已删除**。
  final Map<String, dynamic> config;

  /// provider → 是否存在密钥。
  final Map<String, ModelsSecret> secrets;

  const ModelsSnapshot({
    this.revision = '',
    this.file = const ModelsFileState(),
    this.config = const {},
    this.secrets = const {},
  });

  factory ModelsSnapshot.fromJson(Map<String, dynamic> j) {
    final rawSecrets = j['secrets'];
    final secrets = <String, ModelsSecret>{};
    if (rawSecrets is Map) {
      for (final e in rawSecrets.entries) {
        final k = e.key;
        final v = e.value;
        if (k is String && v is Map<String, dynamic>) {
          secrets[k] = ModelsSecret.fromJson(v);
        }
      }
    }
    return ModelsSnapshot(
      revision: j['revision'] as String? ?? '',
      file: j['file'] is Map<String, dynamic>
          ? ModelsFileState.fromJson(j['file'] as Map<String, dynamic>)
          : const ModelsFileState(),
      config: (j['config'] as Map<String, dynamic>?) ?? const {},
      secrets: secrets,
    );
  }

  /// provider 名 → 原始配置。键的形状由 pi 自己的 models.json 决定，
  /// 这里刻意不建模：面板展示的是配置树，不是一个封闭的 domain 类型。
  Map<String, dynamic> get providers {
    final raw = config['providers'];
    return raw is Map<String, dynamic> ? raw : const {};
  }

  /// 某个 provider 是否配置了密钥。
  ///
  /// **键名是点号路径，不是 provider 名。** 主机的 `pathKey()`
  ///（`server/src/daemon/models_config.ts:162`）把字段位置拼成
  /// `"providers.<id>.apiKey"`，所以查 `secrets[provider]` 永远拿不到 —— 面板会
  /// 一直说「未设置密钥」，即使主机早就配好了。这是静默的假信息，不是报错。
  bool hasKey(String provider) =>
      secrets['providers.$provider.apiKey']?.hasKey ?? false;
}

/// 一次写入操作。**路径寻址，永不整文件 replace。**
///
/// replace 是一台密钥清除机器：把内存里那份（密钥已被删除的）配置写回去，
/// 会真的把用户已配置的 key 抹掉。
class ModelsOp {
  final String op;

  /// 路径段：字符串是对象键，数字是数组下标。
  final List<Object> path;
  final Object? value;
  final bool hasValue;

  const ModelsOp._(this.op, this.path, this.value, this.hasValue);

  /// 设置某个路径的值（存在则覆盖）。
  const ModelsOp.set(List<Object> path, Object? value)
      : this._('set', path, value, true);

  /// 在数组路径处插入。
  const ModelsOp.insert(List<Object> path, Object? value)
      : this._('insert', path, value, true);

  /// 删掉某个路径。
  const ModelsOp.remove(List<Object> path) : this._('remove', path, null, false);

  /// 删掉某个键（unset）。
  const ModelsOp.unset(List<Object> path) : this._('unset', path, null, false);

  Map<String, dynamic> toJson() => {
        'op': op,
        'path': path,
        if (hasValue) 'value': value,
      };
}

/// 封闭错误词表。客户端拥有句子。
enum ModelsErrorReason {
  notFound('not_found'),
  corrupted('corrupted'),
  permission('permission'),

  /// 陈旧 revision。
  conflict('conflict'),
  invalid('invalid'),
  verifyFailed('verify_failed'),
  unsupported('unsupported');

  final String wire;
  const ModelsErrorReason(this.wire);

  static ModelsErrorReason? fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}
