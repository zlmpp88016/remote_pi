import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/workspaces/states/workspace_list_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_list_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan/67 — pick a registered workdir (cwd) on a machine, then its session.
///
/// Home only lists rooms the Pi has already announced, so a workdir that
/// was registered (`remote-pi create`) but isn't running never shows up
/// there. This screen lists everything registered on the machine and can
/// start one, which makes it appear as a normal session tile afterwards.
class WorkspaceListPage extends StatelessWidget {
  const WorkspaceListPage({
    super.key,
    required this.epk,
    required this.title,
    this.device,
    this.online = false,
  });

  final String epk;
  final String title;
  final String? device;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<WorkspaceListViewModel>();
    final state = vm.state;
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Workspaces', style: TextStyle(color: colors.text, fontSize: 16)),
            if (device != null)
              Text(
                device!,
                style: TextStyle(color: colors.muted, fontSize: 12),
              ),
          ],
        ),
        actions: [
          // Plan/68 — the machine's Pi surface (skills + packages).
          IconButton(
            tooltip: 'Pi skills and packages',
            onPressed: () => context.push(
              '/pi',
              extra: {if (device != null) 'device': device},
            ),
            icon: Icon(LucideIcons.sparkles, color: colors.muted, size: 18),
          ),
        ],
      ),
      body: switch (state) {
        WorkspaceListLoading() => Center(
          child: CircularProgressIndicator(color: colors.accent),
        ),
        WorkspaceListError(:final message) => Center(
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
                  onPressed: vm.reload,
                  child: Text('Retry', style: TextStyle(color: colors.accent)),
                ),
              ],
            ),
          ),
        ),
        WorkspaceListReady(:final workspaces, :final starting) =>
          Column(
            children: [
              Expanded(
                child: workspaces.isEmpty
                    ? Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
                          child: Padding(
                            padding: const EdgeInsets.all(32),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(LucideIcons.folderOpen, color: colors.muted, size: 48),
                                const SizedBox(height: 16),
                                Text(
                                  'No workspaces yet',
                                  style: TextStyle(color: colors.muted2, fontSize: 14),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  'Browse the machine\'s folders to pick one.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(color: colors.muted, fontSize: 12),
                                ),
                              ],
                            ),
                          ),
                        ),
                      )
                    : ListView.separated(
                        itemCount: workspaces.length,
                        separatorBuilder: (_, _) =>
                            Divider(height: 1, color: colors.border),
                        itemBuilder: (ctx, i) {
                          final w = workspaces[i];
                          final isAdded = w.source == 'added';
                          return ListTile(
                            enabled: !starting,
                            leading: Icon(
                              w.live ? LucideIcons.folder : LucideIcons.folder,
                              color: w.live ? colors.accent : colors.muted,
                            ),
                            title: Text(
                              w.name.isNotEmpty ? w.name : w.cwd,
                              style: TextStyle(color: colors.text),
                            ),
                            subtitle: Text(
                              [
                                if (w.live) 'running',
                                if (isAdded) 'added',
                                w.cwd,
                              ].join(' · '),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(color: colors.muted, fontSize: 12),
                            ),
                            trailing: starting
                                ? SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: colors.accent,
                                    ),
                                  )
                                : (isAdded
                                    ? IconButton(
                                        tooltip: 'Remove from list',
                                        onPressed: () => vm.remove(w.cwd),
                                        icon: Icon(
                                          LucideIcons.trash2,
                                          color: colors.muted,
                                          size: 18,
                                        ),
                                      )
                                    : Icon(
                                        LucideIcons.chevronRight,
                                        color: colors.muted,
                                        size: 18,
                                      )),
                            onTap: () => _open(ctx, vm, w),
                          );
                        },
                      ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                  child: SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: () => _browse(context, epk, device, online),
                      icon: Icon(LucideIcons.folderSearch, size: 18, color: colors.accent),
                      label: Text(
                        'Browse folders on the machine',
                        style: TextStyle(color: colors.accent, fontSize: 13),
                      ),
                      style: OutlinedButton.styleFrom(
                        side: BorderSide(color: colors.accent),
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
          ),
      },
    );
  }

  /// Plan/68 — open the host-filesystem picker (any folder, not just the
  /// registered daemons).
  static void _browse(
    BuildContext context,
    String epk,
    String? device,
    bool online,
  ) {
    context.push(
      '/workspaces/browse',
      extra: {'epk': epk, 'device': device, 'online': online},
    );
  }

  Future<void> _open(
    BuildContext ctx,
    WorkspaceListViewModel vm,
    WireWorkspaceInfo w,
  ) async {
    final ok = await vm.start(daemonId: w.daemonId, cwd: w.cwd);
    if (ok == null || !ctx.mounted) return;
    // Hand off to the existing sessions screen, which lists the
    // AgentSessions of the now-live room and is where the user actually
    // opens a chat.
    ctx.push(
      '/sessions',
      extra: {
        'epk': epk,
        'roomId': ok.roomId,
        'cwd': ok.cwd,
        'title': w.name.isNotEmpty ? w.name : ok.cwd,
        'device': device,
        'online': online,
      },
    );
  }
}
