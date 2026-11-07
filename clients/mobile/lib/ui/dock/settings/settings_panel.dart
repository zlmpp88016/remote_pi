import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile/protocol/settings.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/settings/states/settings_state.dart';
import 'package:mobile/ui/dock/settings/viewmodels/settings_viewmodel.dart';
import 'package:provider/provider.dart';

/// 设置面板 —— 主机的 `settings.json`（正白名单投影）。
///
/// 这个面板改的是**主机文件**，所以每条错误都有自己的句子：陈旧 revision 与
/// 权限被拒是完全不同的两件事，用一句「出错了」盖住会让用户不知道该怎么办。
class SettingsPanel extends StatelessWidget {
  const SettingsPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<SettingsViewModel>();
    final state = vm.state;
    final snap = vm.snapshot;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Text(SettingsCopy.title),
        actions: [
          IconButton(
            tooltip: Common.reload,
            onPressed: state is SettingsLoading ? null : () => vm.reload(),
            icon: const Icon(LucideIcons.refreshCw),
          ),
        ],
      ),
      body: switch (state) {
        SettingsLoading() => const _CenteredProgress(),
        // 从没发过请求：主机没声明这个能力。没有重试按钮，因为重试不会
        // 改变主机的能力声明。
        SettingsUnsupported() => const _Info(
          icon: LucideIcons.shieldOff,
          text: WorkspaceReason.noSettingsCapability,
        ),
        SettingsError() => _Info(
            icon: LucideIcons.circleAlert,
            text: Common.somethingFailed,
            action: TextButton(
              onPressed: () => vm.reload(),
              child: const Text(Common.retry),
            ),
          ),
        SettingsRefused(:final reason) => _Info(
            icon: LucideIcons.shieldAlert,
            text: _refusalText(reason),
            action: TextButton(
              onPressed: () => vm.reload(),
              child: const Text(Common.reload),
            ),
          ),
        SettingsReady() || SettingsSaving() => snap == null
            ? const _CenteredProgress()
            : _Form(snapshot: snap, vm: vm, saving: state is SettingsSaving),
      },
    );
  }

  static String _refusalText(SettingsErrorReason reason) => switch (reason) {
        SettingsErrorReason.notFound => SettingsCopy.notFound,
        SettingsErrorReason.corrupted => SettingsCopy.corrupted,
        SettingsErrorReason.permission => SettingsCopy.permission,
        SettingsErrorReason.conflict => SettingsCopy.conflict,
        SettingsErrorReason.invalidField => SettingsCopy.invalidField,
        SettingsErrorReason.verifyFailed => SettingsCopy.verifyFailed,
        SettingsErrorReason.invalid => Common.somethingFailed,
        SettingsErrorReason.unsupported => SettingsCopy.invalidField,
      };
}

class _Form extends StatelessWidget {
  const _Form({required this.snapshot, required this.vm, required this.saving});

  final SettingsSnapshot snapshot;
  final SettingsViewModel vm;
  final bool saving;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final editable = snapshot.file.editable && !saving;
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        if (!snapshot.file.editable)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              SettingsCopy.readOnly,
              style: TextStyle(fontSize: 12, color: colors.warning),
            ),
          ),
        _Section(title: SettingsCopy.appearance),
        // theme 只读：它选择 pi 的 TUI 主题，这个面板不提供修改。web 端的
        // 视觉预设是浏览器本地概念，永不写这个值。
        _ReadOnlyRow(
          label: SettingsCopy.theme,
          value: snapshot.appearance.theme ?? SettingsCopy.notSet,
          hint: SettingsCopy.themeReadOnly,
        ),
        _BoolRow(
          label: SettingsCopy.hideThinking,
          value: snapshot.appearance.hideThinkingBlock,
          enabled: editable,
          onChanged: (v) => vm.save([SettingsOp.set(SettingsField.hideThinkingBlock, v)]),
        ),
        _Section(title: SettingsCopy.behaviour),
        _BoolRow(
          label: SettingsCopy.retryEnabled,
          value: snapshot.behaviour.retryEnabled,
          enabled: editable,
          onChanged: (v) => vm.save([SettingsOp.set(SettingsField.retryEnabled, v)]),
        ),
        _NumberRow(
          label: SettingsCopy.retryMaxRetries,
          value: snapshot.behaviour.retryMaxRetries,
          field: SettingsField.retryMaxRetries,
          enabled: editable,
          vm: vm,
        ),
        _NumberRow(
          label: SettingsCopy.retryBaseDelay,
          value: snapshot.behaviour.retryBaseDelayMs,
          field: SettingsField.retryBaseDelayMs,
          enabled: editable,
          vm: vm,
        ),
        _NumberRow(
          label: SettingsCopy.retryProviderMaxDelay,
          value: snapshot.behaviour.retryProviderMaxRetryDelayMs,
          field: SettingsField.retryProviderMaxRetryDelayMs,
          enabled: editable,
          vm: vm,
        ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: colors.muted,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}

class _ReadOnlyRow extends StatelessWidget {
  const _ReadOnlyRow({
    required this.label,
    required this.value,
    required this.hint,
  });

  final String label;
  final String value;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ListTile(
      dense: true,
      title: Text(label, style: const TextStyle(fontSize: 13)),
      subtitle: Text(hint, style: TextStyle(fontSize: 11, color: colors.muted)),
      trailing: Text(
        value,
        style: TextStyle(fontSize: 12, color: colors.muted2),
      ),
    );
  }
}

class _BoolRow extends StatelessWidget {
  const _BoolRow({
    required this.label,
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final String label;
  final bool? value;
  final bool enabled;
  final Future<bool> Function(bool) onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SwitchListTile(
      dense: true,
      value: value ?? false,
      onChanged: enabled ? (v) => onChanged(v) : null,
      title: Text(label, style: const TextStyle(fontSize: 13)),
      // null 不是「关」——主机没设这个键时必须说出来。
      subtitle: value == null
          ? Text(SettingsCopy.notSet,
              style: TextStyle(fontSize: 11, color: colors.muted))
          : null,
    );
  }
}

class _NumberRow extends StatefulWidget {
  const _NumberRow({
    required this.label,
    required this.value,
    required this.field,
    required this.enabled,
    required this.vm,
  });

  final String label;
  final int? value;
  final SettingsField field;
  final bool enabled;
  final SettingsViewModel vm;

  @override
  State<_NumberRow> createState() => _NumberRowState();
}

class _NumberRowState extends State<_NumberRow> {
  late final _controller = TextEditingController(text: widget.value?.toString() ?? '');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant _NumberRow old) {
    super.didUpdateWidget(old);
    // 主机回了新值就同步过来 —— 但只在值真的变了时，否则会打断用户输入。
    final next = widget.value?.toString() ?? '';
    if (next != _controller.text && !_controller.selection.isValid) {
      _controller.text = next;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ListTile(
      dense: true,
      title: Text(widget.label, style: const TextStyle(fontSize: 13)),
      subtitle: widget.value == null
          ? Text(SettingsCopy.notSet,
              style: TextStyle(fontSize: 11, color: colors.muted))
          : null,
      trailing: SizedBox(
        width: 90,
        child: TextField(
          controller: _controller,
          enabled: widget.enabled,
          keyboardType: TextInputType.number,
          textAlign: TextAlign.end,
          style: const TextStyle(fontSize: 13),
          decoration: const InputDecoration(
            isDense: true,
            border: OutlineInputBorder(),
          ),
          onSubmitted: (raw) {
            final n = int.tryParse(raw.trim());
            if (n == null) return;
            widget.vm.save([SettingsOp.set(widget.field, n)]);
          },
        ),
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
          Text(SettingsCopy.loading, style: TextStyle(fontSize: 13)),
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
