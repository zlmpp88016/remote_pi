import 'package:mobile/protocol/settings.dart';

/// 设置面板的状态。
sealed class SettingsState {
  const SettingsState();
}

class SettingsLoading extends SettingsState {
  const SettingsLoading();
}

/// 读到了。[snapshot.file.editable] 为假时界面只读，且要说明为什么。
class SettingsReady extends SettingsState {
  final SettingsSnapshot snapshot;
  const SettingsReady(this.snapshot);
}

/// 主机根本没声明 `settings` 能力。
///
/// 与「被拒绝」不同：这是**从未发请求**，所以不该给重试按钮 —— 重试不会
/// 改变主机的能力声明。
class SettingsUnsupported extends SettingsState {
  const SettingsUnsupported();
}

/// 主机明确拒绝（文件损坏/权限/字段不支持）。
class SettingsRefused extends SettingsState {
  final SettingsErrorReason reason;
  const SettingsRefused(this.reason);
}

/// 意外失败。
class SettingsError extends SettingsState {
  const SettingsError();
}

/// 正在保存。保留快照，让界面不闪回加载态。
class SettingsSaving extends SettingsState {
  final SettingsSnapshot snapshot;
  const SettingsSaving(this.snapshot);
}
