import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile/protocol/schedule.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/automations/states/automations_state.dart';
import 'package:mobile/ui/dock/automations/viewmodels/automations_viewmodel.dart';
import 'package:provider/provider.dart';

/// 自动化面板 —— 主机上的定时任务。
///
/// 三处诚实性要求：
///  - `model == null` 必须写成「继承工作区当前模型」，不能留白。留白会让用户
///    以为任务用了固定模型，而实际成本跟着他上次在界面里选的那个走。
///  - `last_status` 是守护进程的封闭词表，**原样显示不翻译**。
///  - 启用/禁用/删除之后重新拉列表，不本地改写 —— 显示为「已禁用」却仍在
///    触发是最糟的谎言。
class AutomationsPanel extends StatelessWidget {
  const AutomationsPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<AutomationsViewModel>();
    final state = vm.state;
    final catalog = vm.current;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Text(AutomationsCopy.title),
        actions: [
          IconButton(
            tooltip: Common.reload,
            onPressed: state is AutomationsLoading ? null : () => vm.reload(),
            icon: const Icon(LucideIcons.refreshCw),
          ),
          IconButton(
            tooltip: AutomationsCopy.create,
            onPressed: () =>
                _showCreate(context, vm, catalog ?? const ScheduleCatalog()),
            icon: const Icon(LucideIcons.plus),
          ),
        ],
      ),
      body: switch (state) {
        AutomationsLoading() => const _CenteredProgress(),
        AutomationsError() => _Info(
          icon: LucideIcons.circleAlert,
          text: Common.somethingFailed,
          action: TextButton(
            onPressed: () => vm.reload(),
            child: const Text(Common.retry),
          ),
        ),
        AutomationsReady() || AutomationsBusy() => _List(
          catalog: catalog ?? const ScheduleCatalog(),
          vm: vm,
          busyJobId: state is AutomationsBusy ? state.jobId : null,
        ),
      },
    );
  }

  Future<void> _showCreate(
    BuildContext context,
    AutomationsViewModel vm,
    ScheduleCatalog catalog,
  ) async {
    final draft = await showModalBottomSheet<ScheduleDraft>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _CreateSheet(catalog: catalog, modelCatalog: vm.modelCatalog),
    );
    if (draft == null || !context.mounted) return;
    await vm.add(
      daemonId: draft.daemonId,
      schedule: draft.schedule,
      prompt: draft.prompt,
      tz: draft.tz,
      skipIfBusy: draft.skipIfBusy,
      wake: draft.wake,
      catchup: draft.catchup,
      modelProvider: draft.modelProvider,
      modelId: draft.modelId,
      freshSession: draft.freshSession,
    );
  }
}

class _List extends StatelessWidget {
  const _List({required this.catalog, required this.vm, this.busyJobId});

  final ScheduleCatalog catalog;
  final AutomationsViewModel vm;
  final String? busyJobId;

  @override
  Widget build(BuildContext context) {
    if (catalog.tasks.isEmpty) {
      // 「还没有任何自动化」与「读不到」不同，要分开说。
      return const _Info(
        icon: LucideIcons.clock,
        text: AutomationsCopy.none,
        detail: AutomationsCopy.noneHint,
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: catalog.tasks.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        final t = catalog.tasks[i];
        return _TaskCard(
          task: t,
          workspace: catalog.workspaceLabel(t.daemonId),
          busy: busyJobId == t.id,
          vm: vm,
        );
      },
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({
    required this.task,
    required this.workspace,
    required this.busy,
    required this.vm,
  });

  final ScheduleTask task;
  final String workspace;
  final bool busy;
  final AutomationsViewModel vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      // 点卡片看详情。动作仍在下方的按钮上 —— 点空白处不该触发任何写操作。
      onTap: () => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (_) => _DetailSheet(task: task, workspace: workspace),
      ),
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 12),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: colors.border.withValues(alpha: 0.6)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    task.prompt,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: colors.text),
                  ),
                ),
                const SizedBox(width: 8),
                // 启用状态：颜色 + 文字，不只靠颜色（无障碍）。
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: (task.enabled ? colors.success : colors.muted)
                        .withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    task.enabled
                        ? AutomationsCopy.enabled
                        : AutomationsCopy.disabled,
                    style: TextStyle(
                      fontSize: 11,
                      color: task.enabled ? colors.success : colors.muted,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            // cron 原文 + 工作区名。
            Row(
              children: [
                Icon(LucideIcons.clock, size: 12, color: colors.muted),
                const SizedBox(width: 4),
                Text(
                  task.schedule,
                  style: TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: colors.muted,
                  ),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    workspace,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: colors.muted),
                  ),
                ),
              ],
            ),
            if (task.inheritsModel)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  AutomationsCopy.inheritModel,
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
              )
            else
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  task.model!.qualified,
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
              ),
            if (task.nextRun != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '${AutomationsCopy.nextRun} ${task.nextRun}',
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
              )
            else if (task.lastRun == null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  AutomationsCopy.neverRun,
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
              ),
            if (task.lastStatus != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                // 守护进程的封闭词表，原样显示不翻译。
                child: Text(
                  task.lastStatus!,
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
              ),
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: busy ? null : () => vm.runNow(task.id),
                  child: const Text(AutomationsCopy.runNow),
                ),
                TextButton(
                  onPressed: busy
                      ? null
                      : () => vm.setEnabled(task.id, !task.enabled),
                  child: Text(
                    task.enabled
                        ? AutomationsCopy.disable
                        : AutomationsCopy.enable,
                  ),
                ),
                IconButton(
                  tooltip: Common.delete,
                  onPressed: busy
                      ? null
                      : () => _confirmDelete(context, vm, task.id),
                  icon: const Icon(LucideIcons.trash2, size: 16),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmDelete(
    BuildContext context,
    AutomationsViewModel vm,
    String jobId,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(AutomationsCopy.deleteConfirmTitle),
        content: const Text(AutomationsCopy.deleteConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(Common.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(Common.delete),
          ),
        ],
      ),
    );
    if (ok == true) await vm.remove(jobId);
  }
}

/// 新建自动化的表单。
/// 新建自动化的表单。
///
/// **字段全集照搬 web 的 `automations-panel.tsx`（9 个）**。少一个都不是「布局不同」，
/// 而是「web 能配的东西 iOS 配不了」：
///   预设计划、cron、提示词、时区、目标工作区、模型、会话模式、
///   skip_if_busy、wake、catchup。
///
/// 返回一个 `ScheduleDraft` 而不是编码串 —— 上一次用 `\u0000` 拼串是
/// 因为只有三个字段；十项之后拼串会把「字段顺序」变成隐式契约，改一处就静默错位。
class ScheduleDraft {
  final String daemonId;
  final String schedule;
  final String prompt;
  final String? tz;
  final bool skipIfBusy;
  final bool wake;
  final bool catchup;
  final String? modelProvider;
  final String? modelId;
  final bool freshSession;

  const ScheduleDraft({
    required this.daemonId,
    required this.schedule,
    required this.prompt,
    this.tz,
    this.skipIfBusy = false,
    this.wake = false,
    this.catchup = false,
    this.modelProvider,
    this.modelId,
    this.freshSession = false,
  });
}

/// 预设计划：选中即覆盖 cron 输入框。`custom` 表示不覆盖。
class _Preset {
  final String label;
  final String? cron;
  const _Preset(this.label, this.cron);
}

const _presets = <_Preset>[
  _Preset(AutomationsCopy.presetCustom, null),
  _Preset(AutomationsCopy.presetHourly, '0 * * * *'),
  _Preset(AutomationsCopy.presetDaily9, '0 9 * * *'),
  _Preset(AutomationsCopy.presetWeekdays9, '0 9 * * 1-5'),
  _Preset(AutomationsCopy.presetWeeklyMon, '0 9 * * 1'),
];

class _CreateSheet extends StatefulWidget {
  const _CreateSheet({required this.catalog, required this.modelCatalog});

  /// 用来列出可选的工作区与模型。没有它的话「目标工作区」只能手打 daemonId，
  /// 而用户根本看不到自己的 daemonId 是什么。
  final ScheduleCatalog catalog;

  /// 主机上全部可用模型，来自 models 配置。空列表时下拉只留「沿用会话的模型」。
  final List<(String, String)> modelCatalog;

  @override
  State<_CreateSheet> createState() => _CreateSheetState();
}

class _CreateSheetState extends State<_CreateSheet> {
  final _schedule = TextEditingController();
  final _prompt = TextEditingController();
  final _tz = TextEditingController();

  int _presetIndex = 0;
  String? _daemonId;
  String? _modelProvider;
  String? _modelId;
  bool _skipIfBusy = false;
  bool _wake = false;
  bool _catchup = false;
  bool _freshSession = false;

  @override
  void initState() {
    super.initState();
    // 默认选中第一个工作区 —— 让用户从一个有意义的值开始，而不是空着让
    // 「创建」永远灰着。
    final ids = _knownDaemonIds();
    _daemonId = ids.isEmpty ? null : ids.first;
  }

  /// 可选的工作区 id：主机在 `schedule_list` 里给的 `workspace_names` 是权威
  /// 来源（它列的是已注册的 daemon，不是只有已被排程引用的那些）。退回现有
  /// 任务上的 daemonId 只是为了兼容不发送 `workspace_names` 的旧主机。
  ///
  /// 早先只从 `catalog.tasks` 取，导致「一条任务都没有」时集合为空、
  /// 下拉框整个不渲染、`_canSubmit` 永远 false —— 第一条自动化根本建不出来。
  List<String> _knownDaemonIds() {
    final ids = <String>{
      ...widget.catalog.workspaceNames.keys,
      ...widget.catalog.tasks.map((t) => t.daemonId),
    }.toList()
      ..sort();
    return ids;
  }

  @override
  void dispose() {
    _schedule.dispose();
    _prompt.dispose();
    _tz.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      (_daemonId ?? '').isNotEmpty &&
      _schedule.text.trim().isNotEmpty &&
      _prompt.text.trim().isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    // 已知的工作区 id 集合。主机在 `schedule_list` 里给出 `workspace_names`
    // （已注册 daemon 的全集），它才是权威来源；只从任务里取会在「还没有任何
    // 自动化」时得到空集，把第一条自动化堵死。
    final daemons = _knownDaemonIds();

    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              AutomationsCopy.create,
              style: TextStyle(fontSize: 15, color: colors.text),
            ),
            const SizedBox(height: 12),

            // ── 预设计划 ──────────────────────────────────────────
            _Label(AutomationsCopy.preset),
            DropdownButton<int>(
              value: _presetIndex,
              isExpanded: true,
              underline: const SizedBox.shrink(),
              onChanged: (v) {
                if (v == null) return;
                setState(() {
                  _presetIndex = v;
                  // 预设覆盖 cron；custom 不碰用户已经输入的表达式。
                  final c = _presets[v].cron;
                  if (c != null) _schedule.text = c;
                });
              },
              items: [
                for (var i = 0; i < _presets.length; i++)
                  DropdownMenuItem(
                    value: i,
                    child: Text(
                      _presets[i].label,
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),

            // ── cron ──────────────────────────────────────────────
            _Label(AutomationsCopy.cron),
            TextField(
              controller: _schedule,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: const InputDecoration(
                isDense: true,
                hintText: AutomationsCopy.scheduleHint,
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),

            // ── 提示词 ────────────────────────────────────────────
            _Label(AutomationsCopy.prompt),
            TextField(
              controller: _prompt,
              maxLines: 3,
              decoration: const InputDecoration(
                isDense: true,
                hintText: AutomationsCopy.promptHint,
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),

            // ── 时区 ──────────────────────────────────────────────
            _Label(AutomationsCopy.tz),
            TextField(
              controller: _tz,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: const InputDecoration(
                isDense: true,
                hintText: AutomationsCopy.tzHint,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),

            // ── 目标工作区 ────────────────────────────────────────
            if (daemons.isNotEmpty) ...[
              _Label(AutomationsCopy.target),
              DropdownButton<String>(
                value: daemons.contains(_daemonId) ? _daemonId : daemons.first,
                isExpanded: true,
                underline: const SizedBox.shrink(),
                onChanged: (v) => setState(() => _daemonId = v),
                items: [
                  for (final d in daemons)
                    DropdownMenuItem(
                      value: d,
                      child: Text(
                        widget.catalog.workspaceLabel(d),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
            ],

            // ── 模型 ──────────────────────────────────────────────
            _Label(AutomationsCopy.model),
            DropdownButton<String>(
              value: _modelKey,
              isExpanded: true,
              underline: const SizedBox.shrink(),
              onChanged: (v) => setState(() {
                if (v == null || v.isEmpty) {
                  _modelProvider = null;
                  _modelId = null;
                } else {
                  final parts = v.split('\u0000');
                  _modelProvider = parts[0];
                  _modelId = parts[1];
                }
              }),
              items: [
                DropdownMenuItem(
                  value: '',
                  child: Text(
                    AutomationsCopy.inheritModel,
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                // 已被任务固定过的模型也列出来 —— 否则用户看不到自己设过的值。
                for (final m in _knownModels())
                  DropdownMenuItem(
                    value: '${m.$1}\u0000${m.$2}',
                    child: Text(
                      '${m.$2} (${m.$1})',
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),

            // ── 会话模式 ──────────────────────────────────────────
            _Label(AutomationsCopy.sessionMode),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(
                  value: false,
                  label: Text(AutomationsCopy.sessionLive),
                ),
                ButtonSegment(
                  value: true,
                  label: Text(AutomationsCopy.sessionFresh),
                ),
              ],
              selected: {_freshSession},
              onSelectionChanged: (s) =>
                  setState(() => _freshSession = s.first),
            ),

            // ── 三个容错开关 ──────────────────────────────────────
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _skipIfBusy,
              onChanged: (v) => setState(() => _skipIfBusy = v == true),
              title: Text(
                AutomationsCopy.skipIfBusy,
                style: const TextStyle(fontSize: 13),
              ),
            ),
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _wake,
              onChanged: (v) => setState(() => _wake = v == true),
              title: Text(
                AutomationsCopy.wake,
                style: const TextStyle(fontSize: 13),
              ),
            ),
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _catchup,
              onChanged: (v) => setState(() => _catchup = v == true),
              title: Text(
                AutomationsCopy.catchup,
                style: const TextStyle(fontSize: 13),
              ),
            ),

            const SizedBox(height: 12),
            FilledButton(
              onPressed: _canSubmit
                  ? () {
                      final tz = _tz.text.trim();
                      Navigator.of(context).pop(
                        ScheduleDraft(
                          daemonId: _daemonId!,
                          schedule: _schedule.text.trim(),
                          prompt: _prompt.text.trim(),
                          tz: tz.isEmpty ? null : tz,
                          skipIfBusy: _skipIfBusy,
                          wake: _wake,
                          catchup: _catchup,
                          modelProvider: _modelProvider,
                          modelId: _modelId,
                          freshSession: _freshSession,
                        ),
                      );
                    }
                  : null,
              child: const Text(Common.create),
            ),
          ],
        ),
      ),
    );
  }

  /// 下拉框的当前值。空串代表「继承」。
  String get _modelKey => _modelProvider == null || _modelId == null
      ? ''
      : '$_modelProvider\u0000$_modelId';

  /// 可选模型 = 主机 models 配置里的全量 ∪ 现有任务里固定过的。
  ///
  /// **两边都要**：只列主机配置会丢掉一个已固定但后来从配置里删掉的模型
  /// （打开详情时下拉显示不出原值，看起来像坏了）；只列任务里出现过的，
  /// 则用户永远无法给新任务指定一个没用过的模型 —— 那是 web 端有的能力。
  List<(String, String)> _knownModels() {
    final seen = <String>{};
    final out = <(String, String)>[];
    for (final m in widget.modelCatalog) {
      final k = '${m.$1}\u0000${m.$2}';
      if (seen.add(k)) out.add(m);
    }
    for (final t in widget.catalog.tasks) {
      final m = t.model;
      if (m == null) continue;
      final k = '${m.provider}\u0000${m.id}';
      if (seen.add(k)) out.add((m.provider, m.id));
    }
    return out;
  }
}

/// 小标题。表单里连续十几个控件，没有标题就分不清哪行属于哪个字段。
class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 3),
      child: Text(
        text,
        style: TextStyle(fontSize: 11, color: colors.muted, letterSpacing: 0.3),
      ),
    );
  }
}

/// 任务详情视图。
///
/// web 有 drill-down 详情；iOS 也要有，否则「下次何时跑、上次结果如何、用的哪个
/// 模型」这些只能在列表里挤成一行小字。详情不新增动作 —— 动作仍在列表卡片上，
/// 这里只是把事实摊开。
class _DetailSheet extends StatelessWidget {
  const _DetailSheet({required this.task, required this.workspace});

  final ScheduleTask task;
  final String workspace;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              AutomationsCopy.detail,
              style: TextStyle(fontSize: 15, color: colors.text),
            ),
            const SizedBox(height: 14),
            _Row(AutomationsCopy.detailCron, task.schedule, mono: true),
            _Row(AutomationsCopy.detailTarget, workspace),
            _Row(AutomationsCopy.detailTz, task.tz ?? emptyValue),
            _Row(
              AutomationsCopy.detailModel,
              task.inheritsModel
                  ? AutomationsCopy.inheritModel
                  : task.model!.qualified,
            ),
            _Row(
              AutomationsCopy.sessionMode,
              task.freshSession
                  ? AutomationsCopy.sessionFresh
                  : AutomationsCopy.sessionLive,
            ),
            _Row(
              AutomationsCopy.detailNext,
              task.nextRun ?? AutomationsCopy.neverRun,
            ),
            _Row(
              AutomationsCopy.detailLast,
              task.lastRun ?? AutomationsCopy.neverRun,
            ),
            // 守护进程的封闭词表，原样显示不翻译。
            _Row(
              AutomationsCopy.detailLastStatus,
              task.lastStatus ?? emptyValue,
            ),
            _Row(AutomationsCopy.detailCreated, task.createdAt),
            const SizedBox(height: 8),
            _Flag(AutomationsCopy.skipIfBusy, task.skipIfBusy),
            _Flag(AutomationsCopy.wake, task.wake),
            _Flag(AutomationsCopy.catchup, task.catchup),
          ],
        ),
      ),
    );
  }
}

/// 空值占位。用「—」而不是留白：留白分不清「没设置」和「界面没渲染」。
const String emptyValue = '—';

class _Row extends StatelessWidget {
  const _Row(this.label, this.value, {this.mono = false});

  final String label;
  final String value;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 96,
            child: Text(
              label,
              style: TextStyle(fontSize: 12, color: colors.muted),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: 12,
                color: colors.text,
                fontFamily: mono ? 'monospace' : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Flag extends StatelessWidget {
  const _Flag(this.label, this.on);

  final String label;
  final bool on;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Icon(
            on ? LucideIcons.check : LucideIcons.minus,
            size: 12,
            color: on ? colors.success : colors.muted2,
          ),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(fontSize: 12, color: colors.muted)),
        ],
      ),
    );
  }
}

class _CenteredProgress extends StatelessWidget {
  const _CenteredProgress();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(height: 12),
          Text(AutomationsCopy.loading, style: TextStyle(fontSize: 13)),
        ],
      ),
    );
  }
}

class _Info extends StatelessWidget {
  const _Info({
    required this.icon,
    required this.text,
    this.detail,
    this.action,
  });

  final IconData icon;
  final String text;
  final String? detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 28, color: colors.muted),
            const SizedBox(height: 12),
            Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: colors.text),
            ),
            if (detail != null) ...[
              const SizedBox(height: 6),
              Text(
                detail!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: colors.muted),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 12), action!],
          ],
        ),
      ),
    );
  }
}
