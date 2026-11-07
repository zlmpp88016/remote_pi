import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:mobile/protocol/models.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/models/model_draft.dart';
import 'package:mobile/ui/dock/models/states/models_state.dart';
import 'package:mobile/ui/dock/models/viewmodels/models_viewmodel.dart';

/// 模型配置面板。
///
/// **可达性对照 web 的 `model-providers-panel.tsx`** —— 那里能改 provider 的
/// baseUrl / api 风格、增删模型、改上下文档与 token 上限，这里也必须能。只读
/// 地「展示」一个配置面板，等于让用户看着不能改的东西。
///
/// **一条这个面板独有的规矩：密钥永远不是表单字段。** 没有预填、没有掩码、
/// 没有长度 —— 输入框启动即空，留空**绝不等于清空**（清空要显式点移除）。见
/// `model_draft.dart` 里密钥三态的说明。
class ModelsPanel extends StatelessWidget {
  const ModelsPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<ModelsViewModel>();
    final state = vm.state;
    final snap = vm.snapshot;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Text(ModelsCopy.title),
        actions: [
          IconButton(
            tooltip: Common.reload,
            onPressed: state is ModelsLoading || state is ModelsSaving
                ? null
                : () => vm.reload(),
            icon: const Icon(LucideIcons.refreshCw),
          ),
        ],
      ),
      body: switch (state) {
        ModelsLoading() => const _CenteredProgress(),
        // 从没发过请求：主机没声明这个能力。没有重试按钮，因为重试不会改变
        // 主机的能力声明。
        ModelsUnsupported() => const _Info(
          icon: LucideIcons.shieldOff,
          text: WorkspaceReason.noModelsCapability,
        ),
        ModelsError() => _Info(
            icon: LucideIcons.circleAlert,
            text: Common.somethingFailed,
            action: TextButton(
              onPressed: () => vm.reload(),
              child: const Text(Common.retry),
            ),
          ),
        ModelsRefused(:final reason) => _Info(
            icon: LucideIcons.shieldAlert,
            text: _refusalText(reason),
            action: TextButton(
              onPressed: () => vm.reload(),
              child: const Text(Common.reload),
            ),
          ),
        ModelsReady() || ModelsSaving() => snap == null
            ? const _CenteredProgress()
            : _Editor(snapshot: snap, vm: vm, saving: state is ModelsSaving),
      },
    );
  }

  static String _refusalText(ModelsErrorReason reason) => switch (reason) {
        ModelsErrorReason.notFound => ModelsCopy.notFound,
        ModelsErrorReason.corrupted => ModelsCopy.corrupted,
        ModelsErrorReason.permission => ModelsCopy.permission,
        ModelsErrorReason.conflict => ModelsCopy.conflict,
        ModelsErrorReason.verifyFailed => ModelsCopy.verifyFailed,
        ModelsErrorReason.unsupported => ModelsCopy.unsupported,
        ModelsErrorReason.invalid => Common.somethingFailed,
      };
}

/// 编辑主体。
///
/// 草稿策略与 web 一致：**草稿只在它属于当前 provider 时生效**。切换 provider
/// 会丢掉草稿 —— 否则会把 A 的字段写进 B 的子树。
class _Editor extends StatefulWidget {
  const _Editor({
    required this.snapshot,
    required this.vm,
    required this.saving,
  });

  final ModelsSnapshot snapshot;
  final ModelsViewModel vm;
  final bool saving;

  @override
  State<_Editor> createState() => _EditorState();
}

class _EditorState extends State<_Editor> {
  String? _providerId;
  ProviderDraft? _draft;

  /// 密钥框**启动即空**，且永远不回填 —— 没有值可回填。
  final _key = TextEditingController();
  bool _removeKey = false;

  @override
  void dispose() {
    _key.dispose();
    super.dispose();
  }

  /// 派生的当前 provider：用户没选时取第一个。必须用派生值而不是原始 state，
  /// 否则首帧会把所有密钥都报成「未设置」。
  String? get _effectiveProviderId {
    if (_providerId != null) return _providerId;
    final ids = widget.snapshot.providers.keys;
    return ids.isEmpty ? null : ids.first;
  }

  ProviderDraft? get _seeded {
    final id = _effectiveProviderId;
    if (id == null) return null;
    return ProviderDraft.seed(widget.snapshot.providers, id);
  }

  /// 草稿优先，但只在它属于当前 provider 时。保存或重载会换掉 snapshot，
  /// 草稿随之失效（按身份判断）。
  ProviderDraft? get _active {
    final seeded = _seeded;
    final draft = _draft;
    if (seeded == null) return null;
    if (draft == null || draft.providerId != seeded.providerId) return seeded;
    return draft;
  }

  void _mutate(ProviderDraft next) {
    final seeded = _seeded;
    if (seeded == null) return;
    setState(() => _draft = next);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final snap = widget.snapshot;
    final providers = snap.providers;
    final readOnly = !snap.file.editable;
    final inert = readOnly || widget.saving;
    final active = _active;
    final id = _effectiveProviderId;
    final hasKey = id == null ? false : snap.hasKey(id);

    final ops = (active == null || id == null)
        ? const <Map<String, dynamic>>[]
        : buildModelsOps(
            providers: providers,
            draft: active,
            removeKey: _removeKey,
            newKey: _key.text,
          );
    final canSave = !inert && ops.isNotEmpty;

    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        if (!snap.file.editable)
          _Banner(text: ModelsCopy.readOnly, tone: colors.warning),
        // 权限过宽是独立的事实：文件可写不代表安全，明文 key 可能被别的用户读到。
        if (!snap.file.modeSafe)
          _Banner(text: ModelsCopy.modeUnsafe, tone: colors.error),

        if (providers.isEmpty)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              ModelsCopy.noProviders,
              style: TextStyle(fontSize: 13, color: colors.muted),
            ),
          )
        else if (active == null || id == null)
          const _CenteredProgress()
        else ...[
          _Field(
            label: ModelsCopy.providers,
            child: DropdownButton<String>(
              value: id,
              isExpanded: true,
              underline: const SizedBox.shrink(),
              onChanged: inert
                  ? null
                  : (v) {
                      // 换 provider 就是换一棵子树：留着旧草稿会把它的字段
                      // 写进这一棵。
                      setState(() {
                        _providerId = v;
                        _draft = null;
                        _removeKey = false;
                        _key.clear();
                      });
                    },
              items: [
                for (final p in providers.keys)
                  DropdownMenuItem(value: p, child: Text(p, style: const TextStyle(fontSize: 13))),
              ],
            ),
          ),
          _TextFieldRow(
            label: ModelsCopy.baseUrl,
            value: active.baseUrl,
            mono: true,
            enabled: !inert,
            onChanged: (v) => _mutate(active.copyWith(baseUrl: v)),
          ),
          _TextFieldRow(
            label: ModelsCopy.apiStyle,
            value: active.api,
            mono: true,
            enabled: !inert,
            onChanged: (v) => _mutate(active.copyWith(api: v)),
          ),

          // ── 密钥：三态，永不混淆 ─────────────────────────────────
          _Field(
            label: ModelsCopy.apiKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Icon(
                      LucideIcons.keyRound,
                      size: 14,
                      color: hasKey ? colors.success : colors.muted,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      hasKey ? ModelsCopy.keySet : ModelsCopy.keyMissing,
                      style: TextStyle(
                        fontSize: 12,
                        color: hasKey ? colors.success : colors.muted,
                      ),
                    ),
                    const Spacer(),
                    if (hasKey)
                      TextButton(
                        onPressed: inert
                            ? null
                            : () => setState(() => _removeKey = !_removeKey),
                        child: Text(
                          _removeKey ? ModelsCopy.keyKeep : ModelsCopy.keyRemove,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                  ],
                ),
                if (_removeKey)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      ModelsCopy.keyRemovePending,
                      style: TextStyle(fontSize: 11, color: colors.warning),
                    ),
                  )
                else
                  TextField(
                    controller: _key,
                    enabled: !inert,
                    obscureText: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                    decoration: const InputDecoration(
                      isDense: true,
                      hintText: ModelsCopy.apiKeyEmpty,
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
              ],
            ),
          ),

          // ── 模型列表 ────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Row(
              children: [
                Text(
                  ModelsCopy.models,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: colors.muted,
                    letterSpacing: 0.4,
                  ),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: inert
                      ? null
                      : () => _mutate(active.copyWith(
                            rows: [...active.rows, ModelRow.blank()],
                          )),
                  icon: const Icon(LucideIcons.plus, size: 14),
                  label: const Text(ModelsCopy.addModel, style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
          ),
          for (var i = 0; i < active.rows.length; i++)
            _ModelEditor(
              key: ValueKey('${active.providerId}-$i'),
              row: active.rows[i],
              enabled: !inert,
              onChanged: (next) {
                final rows = [...active.rows];
                rows[i] = next;
                _mutate(active.copyWith(rows: rows));
              },
              onRemove: () {
                final rows = [...active.rows]..removeAt(i);
                _mutate(active.copyWith(rows: rows));
              },
            ),

          // ── 保存 ───────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FilledButton(
                  onPressed: canSave
                      ? () async {
                          final ok = await widget.vm.save([
                            for (final o in ops) _toOp(o),
                          ]);
                          if (!ok || !mounted) return;
                          // 写成功后主机可能规范化了值，也可能顺手改了
                          // revision —— 草稿必须作废，否则下次保存带的是旧
                          // revision，会被判 conflict。
                          setState(() {
                            _draft = null;
                            _removeKey = false;
                            _key.clear();
                          });
                        }
                      : null,
                  child: Text(widget.saving ? ModelsCopy.saving : ModelsCopy.save),
                ),
                const SizedBox(height: 8),
                Text(
                  ops.isEmpty
                      ? ModelsCopy.nothingToSave
                      : '${ops.length} ${ModelsCopy.pendingChanges}',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
                const SizedBox(height: 8),
                Text(
                  ModelsCopy.keyHint,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 11, color: colors.muted2),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  /// 把 diff 的 map 形状转回协议类型，保持协议层是唯一的线上格式来源。
  static ModelsOp _toOp(Map<String, dynamic> o) {
    final op = o['op'] as String;
    final path = (o['path'] as List).cast<Object>();
    switch (op) {
      case 'insert':
        return ModelsOp.insert(path, o['value']);
      case 'remove':
        return ModelsOp.remove(path);
      case 'unset':
        return ModelsOp.unset(path);
      default:
        return ModelsOp.set(path, o['value']);
    }
  }
}

/// 一条模型的可编辑块。
class _ModelEditor extends StatefulWidget {
  const _ModelEditor({
    super.key,
    required this.row,
    required this.enabled,
    required this.onChanged,
    required this.onRemove,
  });

  final ModelRow row;
  final bool enabled;
  final ValueChanged<ModelRow> onChanged;
  final VoidCallback onRemove;

  @override
  State<_ModelEditor> createState() => _ModelEditorState();
}

class _ModelEditorState extends State<_ModelEditor> {
  // 数字框要能接受中间态（比如清空后重输），所以用 controller 而不是直接把
  // 数字渲染成文本 —— 直接渲染会在用户删光时把 0 塞回去。
  late final _ctx = TextEditingController(text: '${widget.row.contextWindow}');
  late final _max = TextEditingController(text: '${widget.row.maxTokens}');
  late final _name = TextEditingController(text: widget.row.name);
  late final _id = TextEditingController(text: widget.row.id);

  @override
  void dispose() {
    _ctx.dispose();
    _max.dispose();
    _name.dispose();
    _id.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _id,
                  enabled: widget.enabled,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: ModelsCopy.modelId,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (v) => widget.onChanged(widget.row.copyWith(id: v)),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                tooltip: ModelsCopy.removeModel,
                onPressed: widget.enabled ? widget.onRemove : null,
                icon: Icon(LucideIcons.trash2, size: 16, color: colors.muted),
              ),
            ],
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _name,
            enabled: widget.enabled,
            style: const TextStyle(fontSize: 12),
            decoration: const InputDecoration(
              isDense: true,
              labelText: ModelsCopy.modelName,
              border: OutlineInputBorder(),
            ),
            onChanged: (v) => widget.onChanged(widget.row.copyWith(name: v)),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _ctx,
                  enabled: widget.enabled,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(fontSize: 12),
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: ModelsCopy.contextWindow,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (v) {
                    final n = int.tryParse(v);
                    // 解析不了就保留上一个有效值，不把 0 写进去。
                    if (n != null) {
                      widget.onChanged(widget.row.copyWith(contextWindow: n));
                    }
                  },
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _max,
                  enabled: widget.enabled,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(fontSize: 12),
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: ModelsCopy.maxTokens,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (v) {
                    final n = int.tryParse(v);
                    if (n != null) {
                      widget.onChanged(widget.row.copyWith(maxTokens: n));
                    }
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Checkbox(
                value: widget.row.reasoning,
                onChanged: widget.enabled
                    ? (v) => widget.onChanged(
                          widget.row.copyWith(reasoning: v == true),
                        )
                    : null,
              ),
              Text(ModelsCopy.reasoning, style: const TextStyle(fontSize: 12)),
            ],
          ),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            label,
            style: TextStyle(fontSize: 11, color: colors.muted, letterSpacing: 0.3),
          ),
          const SizedBox(height: 4),
          child,
        ],
      ),
    );
  }
}

/// 文本输入行。**本地草稿 + 失焦提交**，不每次按键都重建整棵树 ——
/// 每键 setState 会让光标在中文输入法里跳动。
class _TextFieldRow extends StatefulWidget {
  const _TextFieldRow({
    required this.label,
    required this.value,
    required this.enabled,
    required this.onChanged,
    this.mono = false,
  });

  final String label;
  final String value;
  final bool enabled;
  final ValueChanged<String> onChanged;
  final bool mono;

  @override
  State<_TextFieldRow> createState() => _TextFieldRowState();
}

class _TextFieldRowState extends State<_TextFieldRow> {
  late final _c = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant _TextFieldRow old) {
    super.didUpdateWidget(old);
    // 只在外部值与本地不一致时同步（例如保存后主机返回了新值），否则每次
    // 重建都会把光标推到末尾。
    if (widget.value != _c.text && widget.value != old.value) {
      _c.text = widget.value;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _Field(
      label: widget.label,
      child: TextField(
        controller: _c,
        enabled: widget.enabled,
        style: TextStyle(
          fontSize: 13,
          fontFamily: widget.mono ? 'monospace' : null,
        ),
        decoration: const InputDecoration(
          isDense: true,
          border: OutlineInputBorder(),
        ),
        onChanged: widget.onChanged,
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.tone});

  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          Icon(LucideIcons.alertTriangle, size: 14, color: tone),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 12, color: colors.text)),
          ),
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
          SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)),
          SizedBox(height: 12),
          Text(ModelsCopy.loading, style: TextStyle(fontSize: 13)),
        ],
      ),
    );
  }
}

class _Info extends StatelessWidget {
  const _Info({required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
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
              style: TextStyle(fontSize: 13, color: colors.muted),
            ),
            if (action != null) ...[const SizedBox(height: 12), action!],
          ],
        ),
      ),
    );
  }
}
