import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/protocol/changes.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/dock/changes/states/changes_state.dart';

/// 更改面板的 viewmodel。
///
/// **懒加载**：构造即发起自己的请求，绝不依赖「某个更早的动作碰巧填了缓存」。
/// web 端曾有 5 个面板的刷新 prop 声明了却没人调用，于是面板从空缓存渲染、
/// 看起来像坏了。这里不重犯。
///
/// **不乐观**：只有主机确认后才更新状态，因为主机才是事实来源
/// （`git status` 的结果不能被客户端猜出来）。
class ChangesViewModel extends ViewModel<ChangesState> {
  ChangesViewModel(
    this._catalog, {
    required this.root,
    required this.daemonId,
    bool workspaceLive = true,
  }) : _workspaceLive = workspaceLive,
       super(
         // 工作区没跑时不进 Loading：主机没有东西可读，请求只会换回一个
         // `workspace_missing` 拒绝。直接把这个事实说出来，省一次往返。
         workspaceLive
             ? const ChangesLoading()
             : const ChangesUnavailableState(ChangesUnavailable.workspaceMissing),
       ) {
    if (!workspaceLive) return;
    // ignore: discarded_futures
    reload();
  }

  final bool _workspaceLive;

  final SessionCatalog _catalog;

  /// 要读哪个工作区。**必须是工作区路径**，不是客户端自己的 cwd。
  final String root;

  /// 随请求一起发，防止过期回复被算到另一个目录头上。
  final String daemonId;

  Future<void> reload() async {
    // 对齐 web 的 `changesDisabledReason`：工作区未运行时连刷新也不可用，
    // 否则「重新加载」按钮会变成一个按下去只换来拒绝的控件。
    if (!_workspaceLive) {
      emit(const ChangesUnavailableState(ChangesUnavailable.workspaceMissing));
      return;
    }
    emit(const ChangesLoading());
    try {
      final snapshot = await _catalog.changesSnapshot(
        root: root,
        daemonId: daemonId,
      );
      emit(ChangesReady(snapshot));
    } on ChangesFailure catch (e) {
      emit(ChangesUnavailableState(e.reason));
    } catch (_) {
      // 意外失败：**不**把异常文本转给用户 —— 它可能带绝对路径或内部堆栈。
      emit(const ChangesError(Common.somethingFailed));
    }
  }
}
