import 'package:mobile/protocol/schedule.dart';

/// 自动化面板的状态。
sealed class AutomationsState {
  const AutomationsState();
}

class AutomationsLoading extends AutomationsState {
  const AutomationsLoading();
}

/// 列表就绪。[catalog.tasks] 为空是「还没有任何自动化」。
class AutomationsReady extends AutomationsState {
  final ScheduleCatalog catalog;
  const AutomationsReady(this.catalog);
}

class AutomationsError extends AutomationsState {
  const AutomationsError();
}

/// 一个动作正在提交中。[jobId] 为 null 表示新建。
class AutomationsBusy extends AutomationsState {
  final ScheduleCatalog catalog;
  final String? jobId;
  const AutomationsBusy(this.catalog, this.jobId);
}
