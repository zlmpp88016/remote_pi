import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/sessions/states/session_list_state.dart';
import 'package:app/ui/sessions/viewmodels/session_list_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan/67 — pick an AgentSession inside a workspace, then open chat.
class SessionListPage extends StatelessWidget {
  const SessionListPage({
    super.key,
    required this.title,
    this.device,
    this.online = false,
  });

  final String title;
  final String? device;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<SessionListViewModel>();
    final state = vm.state;
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: TextStyle(color: colors.text, fontSize: 16)),
            if (device != null)
              Text(
                device!,
                style: TextStyle(color: colors.muted, fontSize: 12),
              ),
          ],
        ),
      ),
      body: switch (state) {
        SessionListLoading() => Center(
          child: CircularProgressIndicator(color: colors.accent),
        ),
        SessionListError(:final message) => Center(
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
        SessionListReady(:final sessions, :final currentId, :final switching) =>
          sessions.isEmpty
              ? Center(
                  child: Text(
                    'No sessions in this workspace yet.',
                    style: TextStyle(color: colors.muted),
                  ),
                )
              : ListView.separated(
                  itemCount: sessions.length,
                  separatorBuilder: (_, _) =>
                      Divider(height: 1, color: colors.border),
                  itemBuilder: (ctx, i) {
                    final s = sessions[i];
                    final live = s.id == currentId || s.live;
                    return ListTile(
                      enabled: !switching,
                      title: Text(
                        (s.name?.isNotEmpty ?? false) ? s.name! : s.id,
                        style: TextStyle(color: colors.text),
                      ),
                      subtitle: Text(
                        [
                          if (live) 'current',
                          if (s.preview != null && s.preview!.isNotEmpty)
                            s.preview!,
                        ].join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: colors.muted, fontSize: 12),
                      ),
                      trailing: live
                          ? Icon(LucideIcons.circleDot, color: colors.accent)
                          : null,
                      onTap: () async {
                        final ok = await vm.pick(s.id);
                        if (!ok || !ctx.mounted) return;
                        if (!isWideLayout(ctx)) {
                          ctx.push(
                            '/chat',
                            extra: {
                              'title': title,
                              'device': device,
                              'online': online,
                            },
                          );
                        }
                      },
                    );
                  },
                ),
      },
    );
  }
}
