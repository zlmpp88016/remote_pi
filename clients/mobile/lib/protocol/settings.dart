/// `settings_describe` / `settings_mutate` —— 主机自己的 `~/.pi/agent/settings.json`。
///
/// 与 `server/src/protocol/types.ts` 的 `SettingsDescribeOkWire` 等类型逐字段对齐。
///
/// 这个文件与 `models.json` **威胁模型不同**，所以处理方式也不同：
/// `models.json` 是凭证库（密钥必须剥离）；`settings.json` 是**混合文件** ——
/// 既有偏好，也有机器状态（带绝对主机路径的 packages、extensions、changelog
/// 记账）。主机投影一个**正白名单**，因此这一帧在结构上就装不下其余内容。
/// 客户端连"请求其余内容"的办法都没有，这正是设计意图。
///
/// 另一条不可妥协的规则：`revision` 是文件字节的 sha256，写入前比对一次，
/// 陈旧就拒。客户端必须原样带回，不能自己算。
library;

/// 正白名单里的六个字段。
enum SettingsField {
  theme('theme'),
  hideThinkingBlock('hideThinkingBlock'),
  retryEnabled('retry.enabled'),
  retryMaxRetries('retry.maxRetries'),
  retryBaseDelayMs('retry.baseDelayMs'),
  retryProviderMaxRetryDelayMs('retry.provider.maxRetryDelayMs');

  final String wire;
  const SettingsField(this.wire);

  static SettingsField? fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}

/// settings.json 在磁盘上的状态。
class SettingsFileState {
  final bool exists;
  final bool parseable;
  final bool writable;

  const SettingsFileState({
    this.exists = false,
    this.parseable = false,
    this.writable = false,
  });

  factory SettingsFileState.fromJson(Map<String, dynamic> j) => SettingsFileState(
        exists: j['exists'] as bool? ?? false,
        parseable: j['parseable'] as bool? ?? false,
        writable: j['writable'] as bool? ?? false,
      );

  /// 三个都为真才能安全编辑。
  bool get editable => exists && parseable && writable;
}

/// 外观段。`theme` 是**只读**的：它选择 pi 的 TUI 主题，这个面板不提供修改。
class SettingsAppearance {
  final String? theme;
  final bool? hideThinkingBlock;

  const SettingsAppearance({this.theme, this.hideThinkingBlock});

  factory SettingsAppearance.fromJson(Map<String, dynamic> j) => SettingsAppearance(
        theme: j['theme'] as String?,
        hideThinkingBlock: j['hide_thinking_block'] as bool?,
      );
}

/// 行为段。null 表示「主机没设这个键」，不是「关了」。
class SettingsBehaviour {
  final bool? retryEnabled;
  final int? retryMaxRetries;
  final int? retryBaseDelayMs;
  final int? retryProviderMaxRetryDelayMs;

  const SettingsBehaviour({
    this.retryEnabled,
    this.retryMaxRetries,
    this.retryBaseDelayMs,
    this.retryProviderMaxRetryDelayMs,
  });

  factory SettingsBehaviour.fromJson(Map<String, dynamic> j) => SettingsBehaviour(
        retryEnabled: j['retry_enabled'] as bool?,
        retryMaxRetries: (j['retry_max_retries'] as num?)?.toInt(),
        retryBaseDelayMs: (j['retry_base_delay_ms'] as num?)?.toInt(),
        retryProviderMaxRetryDelayMs:
            (j['retry_provider_max_retry_delay_ms'] as num?)?.toInt(),
      );
}

/// 一次成功的 describe。
class SettingsSnapshot {
  /// 文件字节的 sha256。写回时必须原样带上。
  final String revision;
  final SettingsFileState file;
  final SettingsAppearance appearance;
  final SettingsBehaviour behaviour;

  const SettingsSnapshot({
    this.revision = '',
    this.file = const SettingsFileState(),
    this.appearance = const SettingsAppearance(),
    this.behaviour = const SettingsBehaviour(),
  });

  factory SettingsSnapshot.fromJson(Map<String, dynamic> j) => SettingsSnapshot(
        revision: j['revision'] as String? ?? '',
        file: j['file'] is Map<String, dynamic>
            ? SettingsFileState.fromJson(j['file'] as Map<String, dynamic>)
            : const SettingsFileState(),
        appearance: j['appearance'] is Map<String, dynamic>
            ? SettingsAppearance.fromJson(j['appearance'] as Map<String, dynamic>)
            : const SettingsAppearance(),
        behaviour: j['behaviour'] is Map<String, dynamic>
            ? SettingsBehaviour.fromJson(j['behaviour'] as Map<String, dynamic>)
            : const SettingsBehaviour(),
      );
}

/// 一次写入操作。**只做路径寻址 mutate，永不整文件 replace** ——
/// replace 是一台密钥清除机器。
class SettingsOp {
  final SettingsField field;

  /// 新值。`null` 且 [isUnset] 为真表示删掉这个键。
  final Object? value;
  final bool isUnset;

  const SettingsOp.set(this.field, this.value) : isUnset = false;
  const SettingsOp.unset(this.field)
      : value = null,
        isUnset = true;

  Map<String, dynamic> toJson() => {
        'op': isUnset ? 'unset' : 'set',
        'path': field.wire,
        if (!isUnset) 'value': value,
      };
}

/// 封闭错误词表。客户端拥有句子，绝不回显主机散文。
enum SettingsErrorReason {
  notFound('not_found'),
  corrupted('corrupted'),
  permission('permission'),

  /// 陈旧 revision —— 文件在读取之后被别人改了。
  conflict('conflict'),
  invalid('invalid'),
  invalidField('invalid_field'),
  unsupported('unsupported'),
  verifyFailed('verify_failed');

  final String wire;
  const SettingsErrorReason(this.wire);

  static SettingsErrorReason? fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}
