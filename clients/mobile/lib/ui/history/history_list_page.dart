// Plan 86 P4 — workspace history list (read-only, zero Pi).
//
// Tapping a workspace in the picker lands here SYNCHRONOUSLY: no
// `workspace_start` is awaited and no Pi is spawned. The screen paints a
// skeleton at once, then the host's `history_list` fills it. Tapping a row
// opens the read-only viewer; switching the live session only happens from the
// viewer's explicit "继续对话".

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/routing/adaptive.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';
import 'package:mobile/ui/history/history_viewport_metrics.dart';
import 'package:mobile/ui/history/history_labels.dart';
import 'package:mobile/ui/history/states/history_list_state.dart';
import 'package:mobile/ui/history/viewmodels/history_list_viewmodel.dart';

class HistoryListPage extends StatelessWidget {
  const HistoryListPage({
    super.key,
    required this.epk,
    required this.daemonId,
    required this.title,
    this.cwd,
    this.roomId,
    this.device,
    this.online = false,
  });

  final String epk;
  final String daemonId;
  final String? cwd;
  final String? roomId;
  final String title;
  final String? device;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<HistoryListViewModel>();
    final state = vm.state;

    if (state is HistoryListReady && !state.building) {
      final stage = vm.viewportStage;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!identical(vm.state, state)) return;
        if (state.sessions.isNotEmpty) vm.reportFirstContent();
        if (HistoryStageMetrics.enabled) HistoryViewportMetrics.report(stage);
      });
    }

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: TextStyle(color: colors.text, fontSize: 16)),
            Text(
              [HistoryCopy.title, HistoryCopy.readOnly, ?device].join(' · '),
              style: TextStyle(color: colors.muted, fontSize: 12),
            ),
          ],
        ),
        actions: [
          _CacheChip(state: state),
          IconButton(
            tooltip: HistoryCopy.refresh,
            onPressed: vm.refresh,
            icon: Icon(LucideIcons.refreshCw, color: colors.muted, size: 18),
          ),
        ],
      ),
      body: switch (state) {
        HistoryListLoading() => const _HistorySkeleton(),
        HistoryListError(:final code) => _FullError(
          code: code,
          onRetry: vm.refresh,
        ),
        HistoryListReady(
          :final sessions,
          :final current,
          :final building,
          :final staleLabel,
          :final hasMore,
          :final loadingMore,
          :final issue,
        ) =>
          Column(
            children: [
              if (issue != null)
                _Banner(
                  text: historyFailureText(issue),
                  tone: _BannerTone.warning,
                  onRetry: vm.refresh,
                )
              else if (building)
                const _Banner(
                  text: HistoryCopy.building,
                  tone: _BannerTone.info,
                  showProgress: true,
                )
              else if (staleLabel)
                const _Banner(
                  text: HistoryCopy.verifying,
                  tone: _BannerTone.info,
                  showProgress: true,
                ),
              Expanded(
                child: sessions.isEmpty
                    ? _Empty(
                        building: building,
                        indexUnavailable:
                            issue == HistoryErrorCode.indexUnavailable,
                      )
                    : ConstrainedBox(
                        constraints: const BoxConstraints(
                          maxWidth: kMaxContentWidth,
                        ),
                        child: ListView.separated(
                          padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
                          itemCount: sessions.length + (hasMore ? 1 : 0),
                          separatorBuilder: (_, _) =>
                              Divider(height: 1, color: colors.border),
                          itemBuilder: (ctx, i) {
                            if (i >= sessions.length) {
                              return _LoadMore(
                                busy: loadingMore,
                                onTap: vm.loadMore,
                              );
                            }
                            final session = sessions[i];
                            return _HistoryRow(
                              session: session,
                              current: current,
                              onTap: () => ctx.push(
                                '/history/session',
                                extra: {
                                  'epk': epk,
                                  'daemonId': daemonId,
                                  'cwd': cwd,
                                  'roomId': roomId,
                                  'sessionId': session.id,
                                  'title': historySessionLabel(session),
                                  'device': device,
                                  'online': online,
                                },
                              ),
                            );
                          },
                        ),
                      ),
              ),
            ],
          ),
      },
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({
    required this.session,
    required this.current,
    required this.onTap,
  });

  final HistorySessionInfo session;
  final HistoryCurrent current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final label = historySessionLabel(session);
    final subtitle = historySessionSubtitle(session, label);
    final isCurrent = current.sessionId == session.id;
    final time = historyTime(session.mtime);
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      leading: Icon(
        LucideIcons.messageSquareText,
        color: colors.muted,
        size: 20,
      ),
      title: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: colors.text, fontSize: 14),
      ),
      subtitle: Text(
        [
          if (time.isNotEmpty) time,
          if (subtitle.isNotEmpty) subtitle,
        ].join(' · '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: colors.muted, fontSize: 12),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (isCurrent) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
              decoration: BoxDecoration(
                color: colors.accent.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(
                HistoryCopy.currentSession,
                style: TextStyle(
                  color: colors.accent,
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(width: 6),
            Text(
              historyCurrentLabel(current),
              style: TextStyle(color: colors.muted, fontSize: 10),
            ),
          ],
          const SizedBox(width: 4),
          Icon(LucideIcons.chevronRight, color: colors.muted, size: 18),
        ],
      ),
      onTap: onTap,
    );
  }
}

class _LoadMore extends StatelessWidget {
  const _LoadMore({required this.busy, required this.onTap});
  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: busy
            ? SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors.accent,
                ),
              )
            : TextButton(
                onPressed: onTap,
                child: Text(
                  HistoryCopy.loadOlder,
                  style: TextStyle(color: colors.accent, fontSize: 12),
                ),
              ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.building, required this.indexUnavailable});
  final bool building;
  final bool indexUnavailable;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    if (building) {
      return const _HistorySkeleton();
    }
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                indexUnavailable ? LucideIcons.cloudOff : LucideIcons.history,
                color: colors.muted,
                size: 42,
              ),
              const SizedBox(height: 12),
              Text(
                indexUnavailable
                    ? HistoryCopy.indexUnavailable
                    : HistoryCopy.empty,
                textAlign: TextAlign.center,
                style: TextStyle(color: colors.muted, fontSize: 13),
              ),
              const SizedBox(height: 8),
              Text(
                HistoryCopy.readOnlyHint,
                textAlign: TextAlign.center,
                style: TextStyle(color: colors.muted2, fontSize: 11),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HistorySkeleton extends StatelessWidget {
  const _HistorySkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
        itemCount: 7,
        itemBuilder: (_, i) => Padding(
          padding: const EdgeInsets.only(bottom: 18),
          child: Row(
            children: [
              Container(
                width: 20,
                height: 20,
                decoration: BoxDecoration(
                  color: colors.surface,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FractionallySizedBox(
                      widthFactor: 0.64,
                      child: Container(
                        height: 12,
                        decoration: BoxDecoration(
                          color: colors.surface,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    FractionallySizedBox(
                      widthFactor: 0.4,
                      child: Container(
                        height: 9,
                        decoration: BoxDecoration(
                          color: colors.surface,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CacheChip extends StatelessWidget {
  const _CacheChip({required this.state});
  final HistoryListState state;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final ready = state is HistoryListReady ? state as HistoryListReady : null;
    if (ready == null || !ready.fromCache) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 2),
      child: Text(
        ready.staleLabel ? HistoryCopy.cached : HistoryCopy.readOnly,
        style: TextStyle(
          color: colors.muted,
          fontSize: 10,
          fontFamily: kMonoFamily,
        ),
      ),
    );
  }
}

enum _BannerTone { info, warning }

class _Banner extends StatelessWidget {
  const _Banner({
    required this.text,
    required this.tone,
    this.onRetry,
    this.showProgress = false,
  });

  final String text;
  final _BannerTone tone;
  final VoidCallback? onRetry;
  final bool showProgress;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final color = tone == _BannerTone.warning ? colors.error : colors.accent;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 9, 10, 9),
      color: color.withValues(alpha: 0.07),
      child: Row(
        children: [
          if (showProgress) ...[
            SizedBox(
              width: 12,
              height: 12,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: color),
            ),
            const SizedBox(width: 8),
          ] else ...[
            Icon(
              tone == _BannerTone.warning
                  ? LucideIcons.circleAlert
                  : LucideIcons.info,
              color: color,
              size: 14,
            ),
            const SizedBox(width: 8),
          ],
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: color, fontSize: 11, height: 1.35),
            ),
          ),
          if (onRetry != null)
            TextButton(
              onPressed: onRetry,
              child: Text(
                HistoryCopy.retry,
                style: TextStyle(color: color, fontSize: 11),
              ),
            ),
        ],
      ),
    );
  }
}

class _FullError extends StatelessWidget {
  const _FullError({required this.code, required this.onRetry});
  final HistoryErrorCode code;
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
            Icon(LucideIcons.circleAlert, color: colors.error, size: 34),
            const SizedBox(height: 12),
            Text(
              historyFailureText(code),
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted, fontSize: 13),
            ),
            const SizedBox(height: 6),
            Text(
              HistoryCopy.readOnlyHint,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted2, fontSize: 11),
            ),
            const SizedBox(height: 14),
            TextButton(
              onPressed: onRetry,
              child: Text(
                HistoryCopy.retry,
                style: TextStyle(color: colors.accent),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
