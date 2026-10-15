import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/workspaces/states/workspace_browser_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_browser_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan/68 — pick a workspace by walking the **host's** filesystem.
///
/// Unlike the plan/67 list (registered daemons only), this screen lets the
/// user choose *any* folder: it starts at the machine's home and navigates
/// down / up / by typing an absolute path. The listing always comes from the
/// host (`fs_list`); the app never resolves a local path.
///
/// "Use this folder" registers the cwd on the machine (`workspace_add`) and
/// starts it (`workspace_start`), then hands off to `/sessions`.
class WorkspaceBrowserPage extends StatelessWidget {
  const WorkspaceBrowserPage({
    super.key,
    required this.epk,
    this.device,
    this.online = false,
  });

  final String epk;
  final String? device;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<WorkspaceBrowserViewModel>();
    final state = vm.state;
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Choose a folder', style: TextStyle(color: colors.text, fontSize: 16)),
            if (device != null)
              Text(device!, style: TextStyle(color: colors.muted, fontSize: 12)),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Show hidden files',
            onPressed: state is WorkspaceBrowserReady ? vm.toggleHidden : null,
            icon: Icon(
              state is WorkspaceBrowserReady && (state).showHidden
                  ? LucideIcons.eye
                  : LucideIcons.eyeOff,
              color: colors.muted,
              size: 18,
            ),
          ),
        ],
      ),
      body: switch (state) {
        WorkspaceBrowserLoading() => Center(
          child: CircularProgressIndicator(color: colors.accent),
        ),
        WorkspaceBrowserError(:final message) => _ErrorBody(
          message: message,
          onRetry: vm.retry,
        ),
        WorkspaceBrowserReady() => _ReadyBody(
          state: state,
          vm: vm,
          epk: epk,
          device: device,
          online: online,
        ),
      },
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.circleAlert, color: colors.error, size: 36),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted),
            ),
            const SizedBox(height: 16),
            TextButton(
              onPressed: onRetry,
              child: Text('Retry', style: TextStyle(color: colors.accent)),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadyBody extends StatefulWidget {
  const _ReadyBody({
    required this.state,
    required this.vm,
    required this.epk,
    required this.device,
    required this.online,
  });

  final WorkspaceBrowserReady state;
  final WorkspaceBrowserViewModel vm;
  final String epk;
  final String? device;
  final bool online;

  @override
  State<_ReadyBody> createState() => _ReadyBodyState();
}

class _ReadyBodyState extends State<_ReadyBody> {
  late final TextEditingController _pathCtrl =
      TextEditingController(text: widget.state.path);

  bool _isEditing = false;

  @override
  void didUpdateWidget(covariant _ReadyBody old) {
    super.didUpdateWidget(old);
    // The host owns the authoritative path (realpath). When a tap, an Up, or a
    // typed jump resolves to a different directory, retarget the field — unless
    // the user is still editing it.
    if (widget.state.path != old.state.path && !_isEditing) {
      _pathCtrl.text = widget.state.path;
    }
  }

  @override
  void dispose() {
    _pathCtrl.dispose();
    super.dispose();
  }

  WorkspaceBrowserReady get state => widget.state;
  WorkspaceBrowserViewModel get vm => widget.vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final dirs = state.directories;
    return Column(
      children: [
        // Breadcrumb — the host-resolved realpath (what the machine sees),
        // editable so the user can jump straight to an absolute path.
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          color: colors.surface,
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _pathCtrl,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 12,
                    color: colors.muted,
                  ),
                  decoration: const InputDecoration(
                    isDense: true,
                    border: InputBorder.none,
                    hintText: 'Type an absolute path',
                  ),
                  onTap: () => _isEditing = true,
                  onSubmitted: (v) {
                    _isEditing = false;
                    // ignore: discarded_futures
                    vm.openTyped(v);
                  },
                ),
              ),
              TextButton(
                onPressed: state.parent == null ? null : vm.up,
                child: Text('Up', style: TextStyle(color: colors.accent, fontSize: 12)),
              ),
            ],
          ),
        ),
        Expanded(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
            child: dirs.isEmpty
                ? Center(
                    child: Text(
                      'No sub-folders here',
                      style: TextStyle(color: colors.muted, fontSize: 13),
                    ),
                  )
                : ListView.separated(
                    itemCount: dirs.length,
                    separatorBuilder: (_, _) => Divider(height: 1, color: colors.border),
                    itemBuilder: (ctx, i) {
                      final e = dirs[i];
                      return ListTile(
                        leading: Icon(
                          e.isRepo ? LucideIcons.gitBranch : LucideIcons.folder,
                          color: e.isRepo ? colors.accent : colors.muted,
                        ),
                        title: Text(e.name, style: TextStyle(color: colors.text)),
                        trailing: Icon(
                          LucideIcons.chevronRight,
                          color: colors.muted,
                          size: 18,
                        ),
                        onTap: () => vm.enter(e.name),
                      );
                    },
                  ),
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: state.busy ? null : () => _use(context),
                icon: state.busy
                    ? SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: colors.onAccent,
                        ),
                      )
                    : Icon(LucideIcons.check, size: 18, color: colors.onAccent),
                label: Text(
                  'Use this folder',
                  style: TextStyle(
                    color: colors.onAccent,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.all(Radius.circular(8)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _use(BuildContext context) async {
    // Plan/68 — first start of a new directory asks for explicit confirmation
    // (a cwd is a code-execution location on the machine). Repeats within the
    // same picker session don't ask again.
    if (vm.needsConfirmation(state.path)) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dctx) => AlertDialog(
          backgroundColor: context.colors.bg,
          title: Text('Start a Pi here?', style: TextStyle(color: context.colors.text)),
          content: Text(
            'The machine will run Pi in:\n\n${state.path}\n\n'
            'Anything in that folder can execute. Continue?',
            style: TextStyle(color: context.colors.muted, fontSize: 13),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dctx).pop(false),
              child: Text('Cancel', style: TextStyle(color: context.colors.muted)),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dctx).pop(true),
              style: FilledButton.styleFrom(
                backgroundColor: context.colors.accent,
                foregroundColor: context.colors.onAccent,
              ),
              child: const Text('Start'),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
      if (!context.mounted) return;
      vm.markConfirmed(state.path);
    }

    final ok = await vm.useCurrentFolder();
    if (ok == null) {
      if (!context.mounted) return;
      final s = vm.state;
      if (s is WorkspaceBrowserError) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(s.message)),
        );
      }
      return;
    }
    if (!context.mounted) return;
    context.push(
      '/sessions',
      extra: {
        'epk': widget.epk,
        'roomId': ok.roomId,
        'cwd': ok.cwd,
        'title': _leaf(ok.cwd),
        'device': widget.device,
        'online': widget.online,
      },
    );
  }

  /// Last path segment for a readable session title.
  static String _leaf(String cwd) {
    final trimmed = cwd.endsWith('/') ? cwd.substring(0, cwd.length - 1) : cwd;
    final idx = trimmed.lastIndexOf('/');
    final leaf = idx >= 0 ? trimmed.substring(idx + 1) : trimmed;
    return leaf.isEmpty ? cwd : leaf;
  }
}
