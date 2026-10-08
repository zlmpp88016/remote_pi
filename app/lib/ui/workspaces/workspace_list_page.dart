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
///
/// Plan/69 — each row also renders the workspace LIFECYCLE pushed by the
/// host (`workspace_state`): a `crashed` workspace shows its `last_error`
/// and a one-tap restart (`workspace_restart`, idempotent host-side). The
/// machine connection lives on room `host`, so a dead Pi never takes this
/// screen down with it.
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
        WorkspaceListReady(
          :final workspaces,
          :final starting,
          :final statesByCwd,
          :final restartingCwd,
          :final restartError,
        ) =>
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
                        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                        itemCount: workspaces.length,
                        separatorBuilder: (_, _) =>
                            const SizedBox(height: 10),
                        itemBuilder: (ctx, i) {
                          final w = workspaces[i];
                          return _WorkspaceCard(
                            workspace: w,
                            lifecycle: statesByCwd[w.cwd],
                            busy: starting,
                            restarting: restartingCwd == w.cwd,
                            restartError:
                                restartError?.cwd == w.cwd
                                    ? restartError!.message
                                    : null,
                            onOpen: () => _open(ctx, vm, w),
                            onRemove: w.source == 'added'
                                ? () => vm.remove(w.cwd)
                                : null,
                            onRestart: () => vm.restart(w.cwd),
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

// ---------------------------------------------------------------------------
// Plan/69 — one workspace card: catalog row + lifecycle state.
// ---------------------------------------------------------------------------

class _WorkspaceCard extends StatelessWidget {
  const _WorkspaceCard({
    required this.workspace,
    required this.lifecycle,
    required this.busy,
    required this.restarting,
    required this.restartError,
    required this.onOpen,
    required this.onRestart,
    this.onRemove,
  });

  final WireWorkspaceInfo workspace;

  /// Latest `workspace_state` push for this cwd, or `null` when the host
  /// has not pushed one yet.
  final WorkspaceState? lifecycle;
  final bool busy;
  final bool restarting;
  final String? restartError;
  final VoidCallback onOpen;
  final VoidCallback onRestart;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    // Local alias: `lifecycle` is a final field, so it does not get null
    // promotion inside the `if` below.
    final WorkspaceState? lc = lifecycle;
    final state = lc?.state;
    final crashed = state == WorkspaceStateValue.crashed;
    final name = workspace.name.isNotEmpty ? workspace.name : workspace.cwd;

    final (Color stateColor, String stateLabel) = switch (state) {
      WorkspaceStateValue.running => (colors.accent, 'running'),
      WorkspaceStateValue.starting => (colors.accent, 'starting…'),
      WorkspaceStateValue.crashed => (colors.error, 'crashed'),
      WorkspaceStateValue.stopped => (colors.muted, 'stopped'),
      null => (
        workspace.live ? colors.accent : colors.muted,
        workspace.live ? 'running' : 'stopped',
      ),
    };

    return Container(
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: crashed ? colors.error : colors.border,
        ),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: busy ? null : onOpen,
            borderRadius: BorderRadius.circular(6),
            child: Row(
              children: [
                Icon(
                  crashed ? LucideIcons.triangleAlert : LucideIcons.folder,
                  color: stateColor,
                  size: 18,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.text,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        workspace.cwd,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: colors.muted, fontSize: 11),
                      ),
                    ],
                  ),
                ),
                if (busy)
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: colors.accent,
                    ),
                  )
                else if (onRemove != null)
                  IconButton(
                    tooltip: 'Remove from list',
                    onPressed: onRemove,
                    icon: Icon(LucideIcons.trash2, color: colors.muted, size: 18),
                  )
                else
                  Icon(LucideIcons.chevronRight, color: colors.muted, size: 18),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // Lifecycle line: state + restart count. `restarts` only shows
          // once the supervisor actually respawned the workspace.
          Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: stateColor,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Text(
                stateLabel,
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  color: stateColor,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (lc != null && lc.restarts > 0) ...[
                const SizedBox(width: 8),
                Text(
                  '${lc.restarts} restart${lc.restarts == 1 ? '' : 's'}',
                  style: TextStyle(color: colors.muted, fontSize: 11),
                ),
              ],
              if (workspace.source == 'added') ...[
                const SizedBox(width: 8),
                Text(
                  'added',
                  style: TextStyle(color: colors.muted, fontSize: 11),
                ),
              ],
            ],
          ),
          // Crashed: last_error + one-tap restart (plan/69).
          if (crashed) ...[
            const SizedBox(height: 8),
            Text(
              lc?.lastError?.isNotEmpty == true
                  ? lc!.lastError!
                  : 'The Pi process exited. No error detail was reported.',
              style: TextStyle(color: colors.error, fontSize: 11, height: 1.35),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.icon(
                onPressed: restarting ? null : onRestart,
                icon: restarting
                    ? SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: colors.onAccent,
                        ),
                      )
                    : Icon(LucideIcons.rotateCw, size: 14, color: colors.onAccent),
                label: Text(
                  restarting ? 'Restarting…' : 'Restart',
                  style: TextStyle(
                    color: colors.onAccent,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  disabledBackgroundColor: colors.border,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.all(Radius.circular(6)),
                  ),
                ),
              ),
            ),
          ],
          if (restartError != null) ...[
            const SizedBox(height: 8),
            Text(
              restartError!,
              style: TextStyle(color: colors.error, fontSize: 11, height: 1.35),
            ),
          ],
        ],
      ),
    );
  }
}
