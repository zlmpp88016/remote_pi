import 'package:mobile/protocol/changes.dart';

/// 更改面板的状态。
///
/// 刻意保持「一个快照」，因为主机一次性回答 `changes_snapshot`。扁平状态让页面
/// 无需协调两个 loading，刷新失败时整体替换而不是留下半个旧目录。
///
/// 四态必须可区分，这是面板诚实性的全部：
///  - [ChangesLoading]            正在读
///  - [ChangesReady]              读到了（**空列表是真的干净**）
///  - [ChangesUnavailableState]   主机说给不了（不是仓库/没装 git/超时…）
///  - [ChangesError]              意外失败（连接断了）
///
/// 把「干净」和「不是仓库」混为一谈，会让一块正常的空面板看起来像坏了 ——
/// 这正是 web 端当初分开两帧的原因。
sealed class ChangesState {
  const ChangesState();
}

class ChangesLoading extends ChangesState {
  const ChangesLoading();
}

class ChangesReady extends ChangesState {
  final ChangesSnapshot snapshot;
  const ChangesReady(this.snapshot);
}

class ChangesUnavailableState extends ChangesState {
  final ChangesUnavailable reason;
  const ChangesUnavailableState(this.reason);
}

class ChangesError extends ChangesState {
  final String message;
  const ChangesError(this.message);
}
