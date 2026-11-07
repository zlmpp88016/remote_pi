import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/protocol/models.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/dock/models/states/models_state.dart';

/// 模型面板的 viewmodel。
///
/// 与设置面板同构，但风险更高：这个文件装着明文 API key。
/// 三条规则不变 —— revision 原样带回、只发路径寻址 ops、写后重新 describe。
///
/// 一条这个面板独有的规则：**密钥永远不被写回**。面板只知道
/// `has_key: true/false`，所以任何「保存」都不得包含 secrets 字段的值 ——
/// 因为它根本没有值。要改密钥是另一个动作（host 侧另开），不是本面板。
class ModelsViewModel extends ViewModel<ModelsState> {
  ModelsViewModel(this._catalog, {bool supported = true})
    : _supported = supported,
      super(
        supported
            ? const ModelsLoading()
            : const ModelsUnsupported(),
      ) {
    // 主机没声明 `models_config` 时**不发请求**：它会拒，而我们本可以提前知道。
    if (!supported) return;
    // ignore: discarded_futures
    reload();
  }

  /// 主机 `host_hello_ok.capabilities` 是否包含 `models_config`。
  /// 对齐 web 的 `modelsAvailable`。
  final bool _supported;

  final SessionCatalog _catalog;

  ModelsSnapshot? get snapshot => switch (state) {
        ModelsReady(:final snapshot) => snapshot,
        ModelsSaving(:final snapshot) => snapshot,
        _ => null,
      };

  Future<void> reload() async {
    if (!_supported) {
      emit(const ModelsUnsupported());
      return;
    }
    emit(const ModelsLoading());
    try {
      final snap = await _catalog.describeModels();
      emit(ModelsReady(snap));
    } on ModelsFailure catch (e) {
      emit(ModelsRefused(e.reason));
    } catch (_) {
      emit(const ModelsError());
    }
  }

  Future<bool> save(List<ModelsOp> ops) async {
    if (ops.isEmpty) return true;
    final current = snapshot;
    if (current == null) return false;

    // Defence in depth: the panel hides its controls when the file is not
    // editable, but a read-only BANNER is only decoration. Any other caller of
    // this viewmodel (or a future refactor that forgets to check) would
    // otherwise reach `mutate` and rely solely on the host to refuse.
    if (!current.file.editable) return false;

    emit(ModelsSaving(current));
    try {
      await _catalog.mutateModels(ops: ops, revision: current.revision);
      await reload();
      return true;
    } on ModelsFailure catch (e) {
      emit(ModelsRefused(e.reason));
      return false;
    } catch (_) {
      emit(const ModelsError());
      return false;
    }
  }
}
