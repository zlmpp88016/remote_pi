import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/files/states/files_state.dart';
import 'package:mobile/ui/dock/files/viewmodels/files_viewmodel.dart';
import 'package:provider/provider.dart';

/// 文件面板 —— 在主机上按路径浏览目录。
///
/// 与 web 端同一套交互：输入路径 → 列出 → 点目录进去 / 点「上一级」回来。
/// 目录行同时是「在此启动 Pi」的入口 —— 因为选目录和开工作区本来就是同一个
/// 动作的两个名字。
class FilesPanel extends StatefulWidget {
  const FilesPanel({super.key});

  @override
  State<FilesPanel> createState() => _FilesPanelState();
}

class _FilesPanelState extends State<FilesPanel> {
  final _path = TextEditingController();

  @override
  void dispose() {
    _path.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<FilesViewModel>();
    final state = vm.state;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Text(FilesCopy.title),
      ),
      body: Column(
        children: [
          _PathRow(controller: _path, vm: vm, busy: state is FilesLoading),
          _ShowHiddenRow(vm: vm, busy: state is FilesLoading),
          // 当前路径的三个目录动作。与 web 的 buttonRow 对齐 —— 子目录行上的
          // 按钮管不到「你刚输入并列出、但下面没有子目录」的那个目录本身。
          if (state is FilesReady)
            _PathActionsRow(
              vm: vm,
              path: state.listing.path,
              busy: vm.busyPath != null,
            ),
          Expanded(
            child: switch (state) {
              FilesIdle() => const _Info(
                  icon: LucideIcons.folderOpen,
                  title: FilesCopy.nothingListed,
                  detail: FilesCopy.emptyHint,
                ),
              FilesLoading() => const _CenteredProgress(),
              FilesError() => _Info(
                  icon: LucideIcons.circleAlert,
                  title: FilesCopy.listFailed,
                  detail: '',
                  action: TextButton(
                    onPressed: () => vm.list(vm.path),
                    child: const Text(Common.retry),
                  ),
                ),
              FilesReady(:final listing) => _Listing(listing: listing, vm: vm),
            },
          ),
        ],
      ),
    );
  }
}

class _PathRow extends StatelessWidget {
  const _PathRow({required this.controller, required this.vm, required this.busy});

  final TextEditingController controller;
  final FilesViewModel vm;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: vm.setPath,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                isDense: true,
                hintText: FilesCopy.pathHint,
                border: const OutlineInputBorder(),
              ),
              style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: busy ? null : () => vm.list(controller.text),
            child: const Text(FilesCopy.list),
          ),
        ],
      ),
    );
  }
}

class _ShowHiddenRow extends StatelessWidget {
  const _ShowHiddenRow({required this.vm, required this.busy});

  final FilesViewModel vm;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 16, 4),
      child: Row(
        children: [
          Checkbox(
            value: vm.showHidden,
            onChanged: busy
                ? null
                : (v) {
                    vm.setShowHidden(v ?? false);
                    if (vm.path.isNotEmpty) vm.list(vm.path);
                  },
          ),
          Expanded(
            child: Text(
              FilesCopy.showHidden,
              style: TextStyle(fontSize: 13, color: colors.text),
            ),
          ),
        ],
      ),
    );
  }
}

class _Listing extends StatelessWidget {
  const _Listing({required this.listing, required this.vm});

  final FsListOk listing;
  final FilesViewModel vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    if (listing.entries.isEmpty) {
      return const _Info(
        icon: LucideIcons.folderOpen,
        title: FilesCopy.emptyDir,
        detail: '',
      );
    }
    return Column(
      children: [
        if (listing.parent != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => vm.list(listing.parent!),
              icon: const Icon(LucideIcons.arrowUp, size: 14),
              label: const Text(FilesCopy.upOneLevel),
            ),
          ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.only(bottom: 8),
            itemCount: listing.entries.length,
            separatorBuilder: (_, _) => Divider(
              height: 1,
              color: colors.border.withValues(alpha: 0.4),
            ),
            itemBuilder: (context, i) {
              final e = listing.entries[i];
              final child = '${listing.path}/${e.name}';
              final rowBusy = vm.busyPath != null;
              return ListTile(
                dense: true,
                leading: Icon(
                  e.isDir ? LucideIcons.folder : LucideIcons.file,
                  size: 16,
                  color: e.isDir ? colors.accent : colors.muted,
                ),
                title: Text(
                  e.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13),
                ),
                // 只在目录上可点：文件没有「进去」这回事，给个假的点击态
                // 会让用户以为点了会有反应。
                onTap: e.isDir ? () => vm.list(child) : null,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (e.isRepo)
                      Padding(
                        padding: const EdgeInsets.only(right: 4),
                        child: Icon(
                          LucideIcons.gitBranch,
                          size: 14,
                          color: colors.muted,
                        ),
                      ),
                    // 两个工作区动作。只对目录给 —— 对一个文件说「启动 Pi」
                    // 是错的动作，不是「暂未支持」。
                    if (e.isDir) ...[
                      IconButton(
                        tooltip: FilesCopy.addToCatalogTitle,
                        visualDensity: VisualDensity.compact,
                        onPressed: rowBusy
                            ? null
                            : () => vm.addWorkspace(child),
                        icon: const Icon(LucideIcons.folderPlus, size: 15),
                      ),
                      IconButton(
                        tooltip: FilesCopy.startHereTitle,
                        visualDensity: VisualDensity.compact,
                        onPressed: rowBusy
                            ? null
                            : () => vm.startWorkspace(child),
                        icon: const Icon(LucideIcons.play, size: 15),
                      ),
                    ],
                  ],
                ),
              );
            },
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
          Text(FilesCopy.listing, style: TextStyle(fontSize: 13)),
        ],
      ),
    );
  }
}

class _Info extends StatelessWidget {
  const _Info({
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
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
              title,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: colors.text),
            ),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                detail,
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

/// 针对**当前已列出路径**的三个动作。
///
/// 子目录行上的按钮管不到「用户刚输入并列出、但下面没有子目录」的那个目录。
/// web 的 `buttonRow`（`right-rail.tsx:729-765`）把这三个放在工具栏，这里照做。
class _PathActionsRow extends StatelessWidget {
  const _PathActionsRow({
    required this.vm,
    required this.path,
    required this.busy,
  });

  final FilesViewModel vm;
  final String path;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        children: [
          TextButton.icon(
            onPressed: busy ? null : () => vm.addWorkspace(path),
            icon: const Icon(LucideIcons.folderPlus, size: 14),
            label: const Text(FilesCopy.addToCatalog, style: TextStyle(fontSize: 12)),
          ),
          TextButton.icon(
            onPressed: busy ? null : () => vm.startWorkspace(path),
            icon: Icon(LucideIcons.play, size: 14, color: colors.accent),
            label: Text(
              FilesCopy.startHere,
              style: TextStyle(fontSize: 12, color: colors.accent),
            ),
          ),
          TextButton.icon(
            onPressed: busy ? null : () => vm.removeWorkspace(path),
            icon: Icon(LucideIcons.x, size: 14, color: colors.muted),
            label: Text(
              FilesCopy.removeFromCatalog,
              style: TextStyle(fontSize: 12, color: colors.muted),
            ),
          ),
        ],
      ),
    );
  }
}
