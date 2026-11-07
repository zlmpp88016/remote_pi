/// `fs_list` / `fs_read` 之上的一层：计划面板真正需要的那一点东西。
///
/// wire 类型本身归 `lib/protocol/protocol.dart` 所有（`FsListOk`、`WireFsEntry`、
/// `FsReadOk`、`FsReadRequest`），这里**不重复定义**它们 —— 同一份 wire 契约
/// 有两个家，迟早会分叉。
///
/// 本文件只放两件 protocol.dart 里没有的东西：
///  1. [FsRefusal] —— `fs_read` 的封闭拒绝词表（客户端拥有句子）。
///  2. [FsListPlanning] —— 从目录列表里挑出计划文档的投影。
library;

import 'package:mobile/protocol/protocol.dart';

/// `fs_read` 的封闭拒绝原因。
///
/// 词表取自 `server/src/daemon/fs_nav.ts:168` 的 `FsReadError` —— 不要臆造。
/// 客户端把它映射成固定中文句子，绝不回显主机散文（可能带绝对路径）。
enum FsRefusal {
  /// 文件不存在。
  notFound('not_found'),

  /// 权限被拒。
  permissionDenied('permission_denied'),

  /// 不是普通文件（目录、设备等）。
  notAFile('not_a_file'),

  /// 不在允许的目录里（plan/、.workflow/、docs/）。这是安全边界。
  notAllowed('not_allowed');

  final String wire;
  const FsRefusal(this.wire);

  static FsRefusal? fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}

/// 计划面板从一份目录列表里取文档。
extension FsListPlanning on FsListOk {
  /// 该目录下的 Markdown 文档，按名字排序。
  ///
  /// 只认 `file`，所以名字里带 `.md` 的**目录**不会被当成文档。
  List<WireFsEntry> get markdownFiles {
    final out = entries
        .where((e) => !e.isDir && e.name.endsWith('.md'))
        .toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    return out;
  }
}
