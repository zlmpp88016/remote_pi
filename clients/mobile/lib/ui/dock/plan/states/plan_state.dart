import 'package:mobile/protocol/plan.dart';
import 'package:mobile/protocol/protocol.dart';

/// 计划面板的状态。
///
/// 与更改面板同构：一次只呈现一种事实，绝不用「空」冒充「读不到」。
///
/// 钻取（drill-down）是两页而不是一页两栏 —— iPhone 上没有空间并排，
/// 而且 web 端也是「列表或文档，二选一」。
sealed class PlanState {
  const PlanState();
}

/// 正在列 `plan/`。
class PlanListLoading extends PlanState {
  const PlanListLoading();
}

/// 列表就绪。[documents] 可能为空 —— 那是「这个工作区还没有计划文档」。
class PlanListReady extends PlanState {
  final List<WireFsEntry> documents;
  const PlanListReady(this.documents);
}

/// 正在读某一篇。
class PlanDocLoading extends PlanState {
  const PlanDocLoading();
}

/// 文档就绪。
class PlanDocReady extends PlanState {
  final FsReadOk doc;
  const PlanDocReady(this.doc);
}

/// 主机明确拒绝（不在允许目录、不是文件、权限…）。
class PlanRefused extends PlanState {
  final FsRefusal reason;
  const PlanRefused(this.reason);
}

/// 这个工作区没有 `plan/` 目录。
///
/// 与 [PlanError] 分开是因为它是**正常事实**而不是故障：主机回 `not_found`
/// 就是在说「这里没有计划目录」。把两者合并成一句「出错了」，用户会反复
/// 点重试，而重试永远不会成功。
class PlanNoDirectory extends PlanState {
  const PlanNoDirectory();
}

/// 意外失败。**不携带异常文本** —— 它可能含绝对路径或内部堆栈。
class PlanError extends PlanState {
  const PlanError();
}
