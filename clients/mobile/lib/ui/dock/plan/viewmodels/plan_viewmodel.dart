import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/protocol/plan.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/dock/plan/states/plan_state.dart';

/// 计划面板的 viewmodel。
///
/// **懒加载**：构造即列 `plan/`，不依赖别的动作碰巧填缓存。
/// **不臆造**：文档内容只来自 `fs_read` 的应答，不在客户端拼路径猜内容。
class PlanViewModel extends ViewModel<PlanState> {
  PlanViewModel(this._catalog, {required this.root, this.daemonId = ''})
      : super(const PlanListLoading()) {
    // ignore: discarded_futures
    loadList();
  }

  final SessionCatalog _catalog;

  /// 工作区根。`fs_read` 必须带上它，主机据此把读取限制在该工作区内。
  final String root;

  final String daemonId;

  /// 当前看的是哪一篇（null = 看列表）。返回时用它决定回到哪。
  String? currentPath;

  /// 列 `plan/` 下的 Markdown 文档。
  Future<void> loadList() async {
    currentPath = null;
    emit(const PlanListLoading());
    try {
      final list = await _catalog.listDirectory('$root/plan');
      emit(PlanListReady(list.markdownFiles));
    } on WorkspaceControlFailure catch (e) {
      // `fs_list` 的 `not_found` 是主机的正常回答（这个工作区没有 plan/
      // 目录），不是故障。两者的 UI 后果完全不同：前者应该停止重试，
      // 后者才值得再试一次。
      emit(e.message == 'not_found' ? const PlanNoDirectory() : const PlanError());
    } catch (_) {
      emit(const PlanError());
    }
  }

  /// 打开一篇文档。
  Future<void> open(String path) async {
    currentPath = path;
    emit(const PlanDocLoading());
    try {
      final doc = await _catalog.readFile(path: path, root: root);
      emit(PlanDocReady(doc));
    } on FsReadFailure catch (e) {
      emit(PlanRefused(e.reason));
    } catch (_) {
      emit(const PlanError());
    }
  }

  /// 返回列表。
  void back() {
    // ignore: discarded_futures
    loadList();
  }
}
