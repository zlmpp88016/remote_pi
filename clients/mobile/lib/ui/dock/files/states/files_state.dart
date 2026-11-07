import 'package:mobile/protocol/protocol.dart';

/// 文件面板的状态。
///
/// 与更改/计划同构：一个面板只呈现一种事实。
sealed class FilesState {
  const FilesState();
}

/// 尚未列出任何内容（刚打开，还没发请求或用户清了路径）。
class FilesIdle extends FilesState {
  const FilesIdle();
}

class FilesLoading extends FilesState {
  const FilesLoading();
}

/// 列出了一次结果。[listing.entries] 为空是「该目录为空」，不是错误。
class FilesReady extends FilesState {
  final FsListOk listing;
  const FilesReady(this.listing);
}

class FilesError extends FilesState {
  const FilesError();
}
