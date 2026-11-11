import 'package:mobile/routing/adaptive.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/sessions/states/session_list_state.dart';
import 'package:mobile/ui/sessions/viewmodels/session_list_viewmodel.dart';
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
        SessionListLoading(:final message) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(color: colors.accent),
              if (message != null) ...[
                const SizedBox(height: 16),
                Text(message, style: TextStyle(color: colors.muted)),
              ],
            ],
          ),
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
        SessionListReady(
            :final sessions,
            :final currentId,
            :final switching,
            :final openingId,
            :final openError,
          ) =>
          sessions.isEmpty
              ? Center(
                  child: Text(
                    '这个工作区还没有会话。',
                    style: TextStyle(color: colors.muted),
                  ),
                )
              : Column(
                  children: [
                    // A tap that failed keeps the rows: the message rides on top
                    // instead of replacing them, so the user can just tap again.
                    if (openError != null) _OpenErrorBanner(message: openError),
                    Expanded(
                      child: ListView.separated(
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
                          if (live) '当前',
                          if (s.preview != null && s.preview!.isNotEmpty)
                            s.preview!,
                        ].join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: colors.muted, fontSize: 12),
                      ),
                      trailing: s.id == openingId
                          ? SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: colors.accent,
                              ),
                            )
                          : live
                          ? Icon(LucideIcons.circleDot, color: colors.accent)
                          : null,
                      onTap: () async {
                        // Navigate FIRST, then switch. `session_switch` restarts
                        // the daemon (stage → ack → exit → respawn), so awaiting
                        // it before navigating left the list sitting there for
                        // over a second after the tap. The chat already handles
                        // an empty session while its sync lands.
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
                        await vm.pick(s.id);
                      },
                    );
                  },
                ),
                    ),
                  ],
                ),
      },
    );
  }
}

/// A tap that failed, shown ABOVE the rows instead of replacing them.
class _OpenErrorBanner extends StatelessWidget {
  const _OpenErrorBanner({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      color: colors.error.withValues(alpha: 0.08),
      child: Row(
        children: [
          Icon(LucideIcons.circleAlert, color: colors.error, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: colors.error, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}
