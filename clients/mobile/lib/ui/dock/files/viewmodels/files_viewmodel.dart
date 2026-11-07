import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/dock/files/states/files_state.dart';

/// 文件面板的 viewmodel。
///
/// 与计划面板不同，这里**不**在构造时自动列目录：要列哪个目录是用户输入的，
/// 猜一个默认值会让用户以为已经看过了某个地方。web 端也是如此 —— 空态文案
/// 明说「尚未列出任何内容」。
class FilesViewModel extends ViewModel<FilesState> {
  FilesViewModel(this._catalog) : super(const FilesIdle());

  final SessionCatalog _catalog;

  /// 用户输入的路径。请求失败时保留，好让用户改。
  String path = '';

  /// 是否包含点文件与隐藏项。
  bool showHidden = false;

  void setPath(String value) => path = value;

  void setShowHidden(bool value) => showHidden = value;

  Future<void> list(String target) async {
    path = target;
    emit(const FilesLoading());
    try {
      final listing = await _catalog.listDirectory(
        target,
        showHidden: showHidden,
      );
      emit(FilesReady(listing));
    } catch (_) {
      emit(const FilesError());
    }
  }

  /// 正在执行的行操作（`workspace_add` / `workspace_start`）。
  ///
  /// 用它禁用所有行内动作：两个并发的工作区操作会让主机的生命周期状态
  /// 进入竞态，而 UI 无法表达「A 正在启动、B 正在添加」。
  String? busyPath;

  /// 把一个目录登记为工作区（不启动）。
  ///
  /// 主机拒绝时（路径没权限、已存在）重新列一次当前目录 —— 服务端的事实比
  /// 客户端的乐观更新可靠。
  Future<void> addWorkspace(String target) async {
    busyPath = target;
    emit(const FilesLoading());
    try {
      await _catalog.addWorkspace(target);
    } catch (_) {
      // 静默失败会让用户以为加上了。用当前目录重列来反映主机的事实状态。
    } finally {
      busyPath = null;
    }
    await _relist(target);
  }

  /// 把一个目录作为 Pi 工作区启动。
  Future<void> startWorkspace(String target) async {
    busyPath = target;
    emit(const FilesLoading());
    try {
      await _catalog.startWorkspace(cwd: target);
    } catch (_) {
      // 同上：不假装成功。
    } finally {
      busyPath = null;
    }
    await _relist(target);
  }

  /// 把一个目录从主机目录中移除。只对「自己加的」有效 —— 已登记的 daemon
  /// 不是这条路径能删的（主机也会拒）。
  Future<void> removeWorkspace(String target) async {
    busyPath = target;
    emit(const FilesLoading());
    try {
      await _catalog.removeWorkspace(target);
    } catch (_) {
      // 同上：不假装成功。
    } finally {
      busyPath = null;
    }
    await _relist(target);
  }

  /// 重列当前目录。操作后刷新是因为主机的目录状态可能已变（新增了 daemons.json
  /// 条目、工作区跑起来了）。
  Future<void> _relist(String target) async {
    emit(const FilesLoading());
    try {
      final listing = await _catalog.listDirectory(
        target,
        showHidden: showHidden,
      );
      emit(FilesReady(listing));
    } catch (_) {
      emit(const FilesError());
    }
  }
}
