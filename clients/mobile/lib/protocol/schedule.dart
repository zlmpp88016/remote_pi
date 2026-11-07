/// `schedule_*` — 自动化（定时任务）。
///
/// 与 `server/src/protocol/types.ts` 的 `WireScheduleTask` / `WireScheduleModel`
/// 逐字段对齐。**不要臆造字段名。**
///
/// 两处语义细节，UI 不能抹平：
///  - `model == null` 不是「未知」，而是**继承**：本次触发沿用该工作区会话
///    当前使用的模型。面板必须说出来，否则用户会以为任务用了固定的模型，
///    而实际成本跟着他上次在界面里选的那个走。
///  - `last_status` 是守护进程自己的封闭词表，**永不翻译** —— 翻译它会让
///    「woke_and_delivered」和「delivered」看起来一样。
library;

/// 一条定时任务。
class ScheduleTask {
  final String id;
  final String daemonId;

  /// cron 表达式原文 —— 唯一永远有意义的字段。
  final String schedule;

  /// `every_minutes` | `every_hours` | `daily` | `weekly` | `custom`
  final String kind;
  final int? everyMinutes;
  final int? everyHours;

  /// `HH:mm`（daily/weekly），否则 null。
  final String? time;

  /// ISO weekday（周一=1..周日=7），weekly 才有。
  final List<int>? weekdays;
  final String? tz;
  final String prompt;
  final bool enabled;
  final bool skipIfBusy;
  final bool wake;
  final bool catchup;
  final String createdAt;

  /// 上次触发时刻，从未触发则为 null。
  final String? lastRun;

  /// 守护进程自己的结果词表，或 null。**永不翻译。**
  final String? lastStatus;
  final String? nextRun;

  /// 固定的模型；null = 继承（不是未知）。
  final ScheduleModel? model;

  /// 每次触发开自己的会话，而不是追加到活动会话。
  final bool freshSession;

  const ScheduleTask({
    required this.id,
    required this.daemonId,
    required this.schedule,
    this.kind = 'custom',
    this.everyMinutes,
    this.everyHours,
    this.time,
    this.weekdays,
    this.tz,
    required this.prompt,
    this.enabled = true,
    this.skipIfBusy = false,
    this.wake = false,
    this.catchup = false,
    this.createdAt = '',
    this.lastRun,
    this.lastStatus,
    this.nextRun,
    this.model,
    this.freshSession = false,
  });

  factory ScheduleTask.fromJson(Map<String, dynamic> j) {
    final rawModel = j['model'];
    final rawWeekdays = j['weekdays'];
    return ScheduleTask(
      id: j['id'] as String? ?? '',
      daemonId: j['daemon_id'] as String? ?? '',
      schedule: j['schedule'] as String? ?? '',
      kind: j['kind'] as String? ?? 'custom',
      everyMinutes: (j['every_minutes'] as num?)?.toInt(),
      everyHours: (j['every_hours'] as num?)?.toInt(),
      time: j['time'] as String?,
      weekdays: rawWeekdays is List
          ? rawWeekdays.map((e) => (e as num).toInt()).toList()
          : null,
      tz: j['tz'] as String?,
      prompt: j['prompt'] as String? ?? '',
      enabled: j['enabled'] as bool? ?? true,
      skipIfBusy: j['skip_if_busy'] as bool? ?? false,
      wake: j['wake'] as bool? ?? false,
      catchup: j['catchup'] as bool? ?? false,
      createdAt: j['created_at'] as String? ?? '',
      lastRun: j['last_run'] as String?,
      lastStatus: j['last_status'] as String?,
      nextRun: j['next_run'] as String?,
      model: rawModel is Map<String, dynamic>
          ? ScheduleModel.fromJson(rawModel)
          : null,
      freshSession: j['fresh_session'] as bool? ?? false,
    );
  }

  /// 是否继承工作区当前模型 —— 面板必须显式说出来。
  bool get inheritsModel => model == null;
}

/// 任务上固定的模型。
class ScheduleModel {
  final String provider;

  /// 提供方的模型 id（如 `deepseek-flash`）。
  final String id;

  /// 主机知道时的显示名；否则客户端显示 [id]。
  final String? name;

  const ScheduleModel({required this.provider, required this.id, this.name});

  factory ScheduleModel.fromJson(Map<String, dynamic> json) => ScheduleModel(
        provider: json['provider'] as String? ?? '',
        id: json['id'] as String? ?? '',
        name: json['name'] as String?,
      );

  /// `<provider>/<id>`，与 toast/日志里用的形式一致。
  String get qualified => '$provider/$id';

  /// 展示给用户的标签：有名字用名字，否则用 id。
  String get label => name ?? id;
}

/// `schedule_list_ok` 的载荷。
class ScheduleCatalog {
  final List<ScheduleTask> tasks;

  /// daemon id -> 显示名。任务里的 daemon 不在这里时回落到 id，**绝不**回落到
  /// cwd 路径 —— 那会泄漏主机目录布局。
  final Map<String, String> workspaceNames;

  const ScheduleCatalog({this.tasks = const [], this.workspaceNames = const {}});

  factory ScheduleCatalog.fromJson(Map<String, dynamic> j) {
    final rawTasks = j['tasks'];
    final tasks = <ScheduleTask>[];
    if (rawTasks is List) {
      for (final t in rawTasks) {
        if (t is Map<String, dynamic>) tasks.add(ScheduleTask.fromJson(t));
      }
    }
    final rawNames = j['workspace_names'];
    final names = <String, String>{};
    if (rawNames is Map) {
      for (final entry in rawNames.entries) {
        final k = entry.key;
        final v = entry.value;
        if (k is String && v is String) names[k] = v;
      }
    }
    return ScheduleCatalog(tasks: tasks, workspaceNames: names);
  }

  /// 任务的展示名：优先主机给的工作区名，其次 daemon id。
  String workspaceLabel(String daemonId) =>
      workspaceNames[daemonId] ?? daemonId;
}

/// 新建任务时的调度预设。
///
/// 只提供 web 端也提供的几种 —— 一个自由的 cron 输入框会把错误留到触发时才
/// 暴露，而预设可以当场证明表达式是合法的。
enum SchedulePreset {
  everyMinutes('every_minutes'),
  everyHours('every_hours'),
  daily('daily'),
  weekly('weekly'),
  custom('custom');

  final String wire;
  const SchedulePreset(this.wire);

  static SchedulePreset fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return SchedulePreset.custom;
  }
}
