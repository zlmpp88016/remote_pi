import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/protocol/settings.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/dock/settings/states/settings_state.dart';

/// 设置面板的 viewmodel。
///
/// 三条不可妥协的规则：
///  1. **revision 原样带回**。它由主机从文件字节算出，必须跟着写入一起发；
///     读旧值 + 写新值之间的任何间隙都不由客户端决定。
///  2. **只发 SET/UNSET 路径操作**，永不整文件 replace。replace 会抹掉这个
///     混合文件里的机器状态（packages、extensions）。
///  3. **写成功后重新 describe**，不本地改写快照 —— 主机可能规范化了值，
///     也可能顺手改了 revision。
class SettingsViewModel extends ViewModel<SettingsState> {
  SettingsViewModel(this._catalog, {bool supported = true})
    : _supported = supported,
      super(
        supported
            ? const SettingsLoading()
            : const SettingsUnsupported(),
      ) {
    // 主机没声明 `settings` 时**不发请求** —— 它会拒，而我们本可以提前知道。
    if (!supported) return;
    // ignore: discarded_futures
    reload();
  }

  /// 主机 `host_hello_ok.capabilities` 是否包含 `settings`。
  /// 对齐 web 的 `settingsAvailable`。
  final bool _supported;

  final SessionCatalog _catalog;

  /// 当前快照（saving 态也要能取到，好让表单保持可见）。
  SettingsSnapshot? get snapshot => switch (state) {
        SettingsReady(:final snapshot) => snapshot,
        SettingsSaving(:final snapshot) => snapshot,
        _ => null,
      };

  Future<void> reload() async {
    if (!_supported) {
      emit(const SettingsUnsupported());
      return;
    }
    emit(const SettingsLoading());
    try {
      final snap = await _catalog.describeSettings();
      emit(SettingsReady(snap));
    } on SettingsFailure catch (e) {
      emit(SettingsRefused(e.reason));
    } catch (_) {
      emit(const SettingsError());
    }
  }

  /// 保存若干路径操作。返回是否成功。
  ///
  /// 空操作直接返回 true 并不打扰主机 —— 「没有需要保存的更改」比一次
  /// 无意义的写入更诚实。
  Future<bool> save(List<SettingsOp> ops) async {
    if (ops.isEmpty) return true;
    final current = snapshot;
    if (current == null) return false;

    // Defence in depth: the read-only banner is decoration, not a gate. Without
    // this, any other caller of this viewmodel would reach `mutate` and rely
    // solely on the host to refuse.
    if (!current.file.editable) return false;

    emit(SettingsSaving(current));
    try {
      await _catalog.mutateSettings(ops: ops, revision: current.revision);
      await reload();
      return true;
    } on SettingsFailure catch (e) {
      emit(SettingsRefused(e.reason));
      return false;
    } catch (_) {
      emit(const SettingsError());
      return false;
    }
  }
}
