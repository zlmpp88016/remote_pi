import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile/protocol/changes.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/changes/states/changes_state.dart';
import 'package:mobile/ui/dock/changes/viewmodels/changes_viewmodel.dart';
import 'package:provider/provider.dart';

/// 更改面板 —— 该工作区的工作树状态。
///
/// 四态各自有明确外观，因为把「干净」和「读不了」画成同一个空列表，会让一块
/// 正常的面板看起来像坏了。web 端当初就是为这个理由把失败做成独立帧。
class ChangesPanel extends StatelessWidget {
  const ChangesPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<ChangesViewModel>();
    final state = vm.state;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Text(ChangesCopy.title),
        actions: [
          IconButton(
            tooltip: ChangesCopy.reloadTitle,
            onPressed: state is ChangesLoading ? null : () => vm.reload(),
            icon: const Icon(LucideIcons.refreshCw),
          ),
        ],
      ),
      body: switch (state) {
        ChangesLoading() => const _CenteredProgress(),
        ChangesUnavailableState(:final reason) => _Info(
            icon: LucideIcons.circleAlert,
            text: _unavailableText(reason),
          ),
        ChangesError(:final message) => _Info(
            icon: LucideIcons.circleAlert,
            text: message,
            action: TextButton(
              onPressed: () => vm.reload(),
              child: const Text(Common.retry),
            ),
          ),
        ChangesReady(:final snapshot) => _Snapshot(snapshot: snapshot),
      },
    );
  }

  /// 封闭原因 → 固定句子。**不回显主机散文。**
  static String _unavailableText(ChangesUnavailable reason) => switch (reason) {
        ChangesUnavailable.notARepo => ChangesCopy.notARepo,
        ChangesUnavailable.gitMissing => ChangesCopy.noGit,
        ChangesUnavailable.timeout => ChangesCopy.timedOut,
        // 工作区没跑起来 / 读不了：都归到「读不了」，并说清是哪一步。
        ChangesUnavailable.workspaceMissing ||
        ChangesUnavailable.unreadable =>
          ChangesCopy.notReadableDetail,
      };
}

/// 成功状态：摘要行 + 条目列表。
class _Snapshot extends StatelessWidget {
  const _Snapshot({required this.snapshot});

  final ChangesSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    if (snapshot.total.isEmpty) {
      // 干净与空看着一样，但这里说的是「真的没有更改」，不是「读不到」。
      return const _Info(icon: LucideIcons.check, text: ChangesCopy.noChanges);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Summary(snapshot: snapshot),
        if (snapshot.truncated)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Text(
              ChangesCopy.untrackedCollapsed,
              style: TextStyle(fontSize: 12, color: colors.muted),
            ),
          ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 4),
            itemCount: snapshot.entries.length,
            separatorBuilder: (_, _) => Divider(
              height: 1,
              color: colors.border.withValues(alpha: 0.4),
            ),
            itemBuilder: (context, i) => _EntryRow(entry: snapshot.entries[i]),
          ),
        ),
      ],
    );
  }
}

/// 摘要：分支、HEAD、四项计数。
///
/// 计数取自 `total`，**不是** `entries.length` —— 后者可能在主机上限处被截断，
/// 用它显示计数会低报。
class _Summary extends StatelessWidget {
  const _Summary({required this.snapshot});

  final ChangesSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final branch = snapshot.branch;
    final head = snapshot.head;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.border.withValues(alpha: 0.5))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (branch != null)
            _MetaLine(label: ChangesCopy.branch, value: branch),
          if (head != null)
            _MetaLine(label: ChangesCopy.head, value: '${head.sha7} ${head.subject}'),
          const SizedBox(height: 6),
          Wrap(
            spacing: 12,
            runSpacing: 4,
            children: [
              if (snapshot.total.staged > 0)
                _CountChip(
                  label: ChangesCopy.staged,
                  value: snapshot.total.staged,
                  tone: colors.accent,
                ),
              if (snapshot.total.unstaged > 0)
                _CountChip(
                  label: ChangesCopy.unstaged,
                  value: snapshot.total.unstaged,
                  tone: colors.warning,
                ),
              if (snapshot.total.untracked > 0)
                _CountChip(
                  label: ChangesCopy.untracked,
                  value: snapshot.total.untracked,
                  tone: colors.muted,
                ),
              if (snapshot.total.conflicted > 0)
                _CountChip(
                  label: ChangesCopy.conflicted,
                  value: snapshot.total.conflicted,
                  tone: colors.error,
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 52,
            child: Text(label, style: TextStyle(fontSize: 12, color: colors.muted)),
          ),
          Expanded(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: colors.text),
            ),
          ),
        ],
      ),
    );
  }
}

class _CountChip extends StatelessWidget {
  const _CountChip({required this.label, required this.value, required this.tone});

  final String label;
  final int value;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          '$value',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: tone),
        ),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontSize: 12)),
      ],
    );
  }
}

/// 一行变更。状态字母来自 git 的封闭词表，**不翻译**。
class _EntryRow extends StatelessWidget {
  const _EntryRow({required this.entry});

  final ChangesEntry entry;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final Color tone = entry.isConflicted
        ? colors.error
        : entry.isUntracked
            ? colors.muted
            : entry.isStaged
                ? colors.accent
                : colors.warning;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
      child: Row(
        children: [
          // git 的列字符是协议词汇，不译。
          //
          // 两个字符都保留，**不 trim**：`" M"`（仅工作树修改）与 `"M "`
          // （仅暂存）trim 之后都是 `"M"`，用户就分不出自己暂存了没有。
          // 等宽字体下前导空格是有效的列位。
          SizedBox(
            width: 24,
            child: Text(
              '${entry.x}${entry.y}',
              style: TextStyle(
                fontSize: 12,
                fontFamily: 'monospace',
                color: tone,
              ),
            ),
          ),
          Expanded(
            child: Text(
              entry.rel,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, color: colors.text),
            ),
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
          Text(ChangesCopy.reading, style: TextStyle(fontSize: 13)),
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
