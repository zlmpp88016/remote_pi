import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile/protocol/plan.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/chat/widgets/agent_markdown.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/plan/states/plan_state.dart';
import 'package:mobile/ui/dock/plan/viewmodels/plan_viewmodel.dart';
import 'package:provider/provider.dart';

/// 计划面板 —— 该工作区 `plan/` 目录下的计划文档。
///
/// 钻取式：列表与文档二选一，不做并排两栏。iPhone 上没有并排的空间，而且
/// web 端本来也是「列表或文档」—— 保持一致的是信息架构，不是像素布局。
///
/// 行标签用**序号 + 文件名**（`84-ios-web-parity.md` → `84 · ios-web-parity`），
/// 不显示绝对路径：路径的主机前缀对用户没有信息量，只是噪音。
class PlanPanel extends StatelessWidget {
  const PlanPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<PlanViewModel>();
    final state = vm.state;
    final inDoc = state is PlanDocLoading || state is PlanDocReady ||
        state is PlanRefused;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        leading: inDoc
            ? IconButton(
                tooltip: PlanCopy.backToList,
                onPressed: vm.back,
                icon: const Icon(LucideIcons.arrowLeft),
              )
            : null,
        title: Text(PlanCopy.title),
        actions: [
          if (!inDoc)
            IconButton(
              tooltip: Common.reload,
              onPressed: state is PlanListLoading ? null : () => vm.loadList(),
              icon: const Icon(LucideIcons.refreshCw),
            ),
        ],
      ),
      body: switch (state) {
        PlanListLoading() || PlanDocLoading() => const _CenteredProgress(),
        PlanError() => _Info(
            icon: LucideIcons.circleAlert,
            text: Common.somethingFailed,
            action: TextButton(
              onPressed: inDoc ? () => vm.open(vm.currentPath!) : () => vm.loadList(),
              child: const Text(Common.retry),
            ),
          ),
        // 主机回 `not_found`：这个工作区没有 plan/ 目录。没有重试按钮 ——
        // 重试不会让目录出现，给按钮只会让用户白点。
        PlanNoDirectory() => const _Info(
            icon: LucideIcons.folderX,
            text: PlanCopy.noDirectory,
          ),
        PlanRefused(:final reason) => _Info(
            icon: LucideIcons.shieldAlert,
            text: _refusalText(reason),
          ),
        PlanListReady(:final documents) => _DocumentList(documents: documents),
        PlanDocReady(:final doc) => _Document(doc: doc),
      },
    );
  }

  /// 封闭拒绝原因 → 固定句子。
  static String _refusalText(FsRefusal reason) => switch (reason) {
        FsRefusal.notAllowed => PlanCopy.refused,
        FsRefusal.notAFile => PlanCopy.couldNotRead,
        FsRefusal.notFound => PlanCopy.couldNotRead,
        FsRefusal.permissionDenied => PlanCopy.couldNotRead,
      };
}

/// 文档列表，带筛选。
class _DocumentList extends StatefulWidget {
  const _DocumentList({required this.documents});

  final List<WireFsEntry> documents;

  @override
  State<_DocumentList> createState() => _DocumentListState();
}

class _DocumentListState extends State<_DocumentList> {
  final _filter = TextEditingController();

  @override
  void dispose() {
    _filter.dispose();
    super.dispose();
  }

  List<WireFsEntry> get _visible {
    final q = _filter.text.trim().toLowerCase();
    if (q.isEmpty) return widget.documents;
    return widget.documents
        .where((e) => e.name.toLowerCase().contains(q))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    if (widget.documents.isEmpty) {
      // 「这个工作区还没有计划文档」—— 与「读不到」不同，这句话必须说清。
      return const _Info(icon: LucideIcons.fileText, text: PlanCopy.noDocuments);
    }

    final visible = _visible;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: TextField(
            controller: _filter,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              isDense: true,
              hintText: PlanCopy.filterHint,
              prefixIcon: const Icon(LucideIcons.search, size: 16),
              suffixIcon: _filter.text.isEmpty
                  ? null
                  : IconButton(
                      tooltip: PlanCopy.clearFilter,
                      icon: const Icon(LucideIcons.x, size: 16),
                      onPressed: () {
                        _filter.clear();
                        setState(() {});
                      },
                    ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: colors.border),
              ),
            ),
            style: const TextStyle(fontSize: 13),
          ),
        ),
        Expanded(
          child: visible.isEmpty
              ? const _Info(icon: LucideIcons.searchX, text: PlanCopy.noDocuments)
              : ListView.separated(
                  padding: const EdgeInsets.only(bottom: 8),
                  itemCount: visible.length,
                  separatorBuilder: (_, _) => Divider(
                    height: 1,
                    color: colors.border.withValues(alpha: 0.4),
                  ),
                  itemBuilder: (context, i) => _DocRow(entry: visible[i]),
                ),
        ),
      ],
    );
  }
}

/// 一行文档。标签是「序号 + 去扩展名的名字」，不是绝对路径。
class _DocRow extends StatelessWidget {
  const _DocRow({required this.entry});

  final WireFsEntry entry;

  /// `84-ios-web-parity.md` → (`84`, `ios-web-parity`)
  (String, String) get _label {
    final base = entry.name.endsWith('.md')
        ? entry.name.substring(0, entry.name.length - 3)
        : entry.name;
    final dash = base.indexOf('-');
    if (dash <= 0) return ('', base);
    final head = base.substring(0, dash);
    // 只有前导确实是数字时才当序号，避免把 `feat-x.md` 误拆。
    if (int.tryParse(head) == null) return ('', base);
    return (head, base.substring(dash + 1));
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.read<PlanViewModel>();
    final (num, name) = _label;
    return ListTile(
      dense: true,
      onTap: () => vm.open('${vm.root}/plan/${entry.name}'),
      leading: num.isEmpty
          ? const Icon(LucideIcons.fileText, size: 16)
          : SizedBox(
              width: 26,
              child: Text(
                num,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  fontFamily: 'monospace',
                  color: colors.muted,
                ),
              ),
            ),
      title: Text(
        name.replaceAll('-', ' '),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 13),
      ),
      trailing: const Icon(LucideIcons.chevronRight, size: 16),
    );
  }
}

/// 一篇文档。
class _Document extends StatelessWidget {
  const _Document({required this.doc});

  final FsReadOk doc;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (doc.truncated)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: colors.surface,
            child: Row(
              children: [
                Icon(LucideIcons.info, size: 14, color: colors.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    PlanCopy.truncated,
                    style: TextStyle(fontSize: 12, color: colors.muted),
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          // 单滚动容器：Markdown 内部不滚动，避免嵌套滚动打架。
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
            child: AgentMarkdown(doc.content, selectable: true),
          ),
        ),
      ],
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
          Text(PlanCopy.reading, style: TextStyle(fontSize: 13)),
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
