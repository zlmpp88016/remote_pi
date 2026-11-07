import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/protocol/schedule.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/dock/automations/states/automations_state.dart';

/// 自动化面板的 viewmodel。
///
/// **不乐观**：启用/禁用/删除都以主机的应答为准，再重新拉一次列表。
/// 一次成功的本地状态改写不证明主机真的改了 —— 而一个显示为「已禁用」
/// 却仍在触发的任务是最糟的谎言。
class AutomationsViewModel extends ViewModel<AutomationsState> {
  AutomationsViewModel(this._catalog) : super(const AutomationsLoading()) {
    // ignore: discarded_futures
    reload();
    // ignore: discarded_futures
    _loadModelCatalog();
  }

  final SessionCatalog _catalog;

  /// 主机模型配置里能用的全部模型，形如 `(provider, modelId)`。
  ///
  /// 创建任务时不能只从「已固定过模型的任务」里列候选 —— 那样用户就永远
  /// 无法给新任务指定一个从未用过的模型，而 web 端用的是全局列表。
  /// 拿不到（主机不支持 models_config、文件损坏）时保持空列表，下拉里只剩
  /// 「沿用会话的模型」那一项，而不是编一个。
  List<(String, String)> modelCatalog = const [];

  Future<void> _loadModelCatalog() async {
    try {
      final snapshot = await _catalog.describeModels();
      final providers = snapshot.config['providers'];
      if (providers is! Map) return;
      final out = <(String, String)>[];
      for (final entry in providers.entries) {
        final providerId = entry.key.toString();
        final body = entry.value;
        if (body is! Map) continue;
        final models = body['models'];
        if (models is! Map) continue;
        for (final key in models.keys) {
          out.add((providerId, key.toString()));
        }
      }
      modelCatalog = out;
      // 目录在面板打开前就绪，不重发列表请求。
      if (current != null) emit(current as AutomationsState);
    } catch (_) {
      // 主机没声明 models_config：留空，不编造候选。
    }
  }

  Future<void> reload() async {
    emit(const AutomationsLoading());
    try {
      final catalog = await _catalog.listSchedules();
      emit(AutomationsReady(catalog));
    } catch (_) {
      emit(const AutomationsError());
    }
  }

  /// 当前列表（busy 态也要能取到，好让界面保持可见而不是闪回加载）。
  ScheduleCatalog? get current => switch (state) {
        AutomationsReady(:final catalog) => catalog,
        AutomationsBusy(:final catalog) => catalog,
        _ => null,
      };

  Future<void> setEnabled(String jobId, bool enabled) async {
    final before = current;
    if (before == null) return;
    emit(AutomationsBusy(before, jobId));
    try {
      await _catalog.setScheduleEnabled(jobId, enabled);
      await reload();
    } catch (_) {
      emit(const AutomationsError());
    }
  }

  Future<void> remove(String jobId) async {
    final before = current;
    if (before == null) return;
    emit(AutomationsBusy(before, jobId));
    try {
      await _catalog.removeSchedule(jobId);
      await reload();
    } catch (_) {
      emit(const AutomationsError());
    }
  }

  Future<void> runNow(String jobId) async {
    final before = current;
    if (before == null) return;
    emit(AutomationsBusy(before, jobId));
    try {
      await _catalog.runScheduleNow(jobId);
      await reload();
    } catch (_) {
      emit(const AutomationsError());
    }
  }

  /// 新建。成功后就重新拉列表 —— 返回的是主机创建的那条，不是我们要的那条。
  Future<bool> add({
    required String daemonId,
    required String schedule,
    required String prompt,
    String? tz,
    bool skipIfBusy = false,
    bool wake = false,
    bool catchup = false,
    String? modelProvider,
    String? modelId,
    bool freshSession = false,
  }) async {
    final before = current;
    emit(AutomationsBusy(before ?? const ScheduleCatalog(), null));
    try {
      await _catalog.addSchedule(
        daemonId: daemonId,
        schedule: schedule,
        prompt: prompt,
        tz: tz,
        skipIfBusy: skipIfBusy,
        wake: wake,
        catchup: catchup,
        modelProvider: modelProvider,
        modelId: modelId,
        freshSession: freshSession,
      );
      await reload();
      return true;
    } catch (_) {
      emit(const AutomationsError());
      return false;
    }
  }
}
