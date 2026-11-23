// Plan 86 P4 — read-only history viewer.
//
// There is NO composer on this screen. The only action that changes host state
// is the explicit "继续对话" footer button, which confirms first (because the
// switch is visible to every paired client) and then asks the ViewModel for the
// single-switch flow. Browsing and paging are always read-only.

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
import 'package:mobile/ui/history/states/history_viewer_state.dart';
import 'package:mobile/ui/history/viewmodels/history_viewer_viewmodel.dart';
import 'package:mobile/ui/history/widgets/history_rows.dart';

class HistoryViewerPage extends StatefulWidget {
  const HistoryViewerPage({
    super.key,
    required this.epk,
    required this.daemonId,
    required this.sessionId,
    required this.title,
    this.cwd,
    this.roomId,
    this.device,
    this.online = false,
  });

  final String epk;
  final String daemonId;
  final String sessionId;
  final String? cwd;
  final String? roomId;
  final String title;
  final String? device;
  final bool online;

  @override
  State<HistoryViewerPage> createState() => _HistoryViewerPageState();
}

class _HistoryViewerPageState extends State<HistoryViewerPage> {
  /// One post-frame navigation per mount. The VM sets [HistoryViewerReady.openChat]
  /// only AFTER the host confirmed the target, so this push cannot precede the
  /// switch and the composer cannot address the previous session.
  bool _openedChat = false;

  // Local aliases keep the build readable.
  String get epk => widget.epk;
  String get daemonId => widget.daemonId;
  String get sessionId => widget.sessionId;
  String? get cwd => widget.cwd;
  String? get roomId => widget.roomId;
  String get title => widget.title;
  String? get device => widget.device;
  bool get online => widget.online;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<HistoryViewerViewModel>();
    final state = vm.state;

    if (state is HistoryViewerReady) {
      final stage = vm.viewportStage;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !identical(vm.state, state)) return;
        if (state.items.isNotEmpty) vm.reportFirstContent();
        if (HistoryStageMetrics.enabled) HistoryViewportMetrics.report(stage);
      });
    }

    final ready = state is HistoryViewerReady ? state : null;
    if (ready != null && ready.openChat && !_openedChat) {
      _openedChat = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (vm.reportedAlreadyCurrent) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(HistoryCopy.continueAlreadyCurrent)),
          );
        }
        context.push(
          '/chat',
          extra: {'title': title, 'device': device, 'online': online},
        );
      });
    }
    // The route title came from the same host listing the page reports, so it
    // is never worse than the loaded label (a legacy page has no name/preview
    // and would otherwise collapse the header to a short id).
    final headerTitle = title.isNotEmpty
        ? title
        : (ready == null
              ? HistoryCopy.title
              : historySessionLabel(ready.session));
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              headerTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.text, fontSize: 16),
            ),
            Text(
              [
                HistoryCopy.readOnly,
                if (ready != null) historyTime(ready.session.mtime),
                ?device,
              ].where((s) => s.isNotEmpty).join(' · '),
              style: TextStyle(color: colors.muted, fontSize: 12),
            ),
          ],
        ),
        actions: [
          if (ready?.staleLabel == true)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Text(
                HistoryCopy.cached,
                style: TextStyle(
                  color: colors.muted,
                  fontSize: 10,
                  fontFamily: kMonoFamily,
                ),
              ),
            ),
          IconButton(
            tooltip: HistoryCopy.refresh,
            onPressed: vm.refresh,
            icon: Icon(LucideIcons.refreshCw, color: colors.muted, size: 18),
          ),
        ],
      ),
      body: Column(
        children: [
          if (ready != null && ready.issue != null)
            _Banner(
              text: historyFailureText(ready.issue!),
              tone: _Tone.warning,
              onRetry: vm.refresh,
            )
          else if (ready != null && ready.waitingForTarget)
            const _Banner(
              text: HistoryCopy.continueWatching,
              tone: _Tone.info,
              showProgress: true,
            )
          else if (ready != null && ready.startingWorkspace)
            const _Banner(
              text: HistoryCopy.startingWorkspace,
              tone: _Tone.info,
              showProgress: true,
            )
          else if (ready != null && ready.staleLabel)
            const _Banner(
              text: HistoryCopy.verifying,
              tone: _Tone.info,
              showProgress: true,
            ),
          if (ready != null && ready.continueError != null)
            _Banner(
              text: historyFailureText(
                ready.continueError!,
                refusal: ready.continueRefusal,
              ),
              tone: _Tone.warning,
            ),
          Expanded(
            child: switch (state) {
              HistoryViewerLoading() => const _ViewerSkeleton(),
              HistoryViewerError(:final code) => _FullError(
                code: code,
                onRetry: vm.refresh,
              ),
              HistoryViewerReady(
                :final items,
                :final hasOlder,
                :final loadingOlder,
              ) =>
                items.isEmpty
                    ? const _EmptyViewer()
                    : ConstrainedBox(
                        constraints: const BoxConstraints(
                          maxWidth: kMaxContentWidth,
                        ),
                        child: ListView.builder(
                          padding: const EdgeInsets.only(bottom: 16),
                          itemCount: items.length + 2,
                          itemBuilder: (ctx, index) {
                            if (index == 0) {
                              return _OlderHeader(
                                hasOlder: hasOlder,
                                loading: loadingOlder,
                                onLoad: vm.loadOlder,
                              );
                            }
                            if (index == items.length + 1) {
                              return const _EndOfHistory();
                            }
                            final item = items[index - 1];
                            return HistoryItemTile(
                              key: ValueKey(item.eventId),
                              item: item,
                              bodyState: (eventId, ref) =>
                                  _bodyOf(state, eventId, ref),
                              onLoadBody: (eventId, ref) =>
                                  vm.loadBody(eventId, ref),
                            );
                          },
                        ),
                      ),
            },
          ),
          _ReadOnlyFooter(
            state: state,
            onContinue: () => _confirmContinue(context, vm),
          ),
        ],
      ),
    );
  }

  static HistoryBodyState? _bodyOf(
    HistoryViewerState state,
    String eventId,
    HistoryBodyRef ref,
  ) {
    if (state is! HistoryViewerReady) return null;
    return state.bodies['$eventId|${ref.stateKey}'];
  }

  Future<void> _confirmContinue(
    BuildContext context,
    HistoryViewerViewModel vm,
  ) async {
    final state = vm.state;
    if (state is! HistoryViewerReady || state.continuing) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        final colors = ctx.colors;
        return AlertDialog(
          backgroundColor: colors.surface,
          title: Text(HistoryCopy.continueTitle),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                HistoryCopy.continueBody,
                style: TextStyle(
                  color: colors.muted,
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(LucideIcons.users, size: 13, color: colors.warning),
                  const SizedBox(width: 6),
                  Text(
                    HistoryCopy.affectsOtherClients,
                    style: TextStyle(color: colors.warning, fontSize: 11),
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(
                HistoryCopy.continueCancel,
                style: TextStyle(color: colors.muted),
              ),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: colors.accent),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(
                HistoryCopy.continueConfirm,
                style: TextStyle(color: colors.onAccent),
              ),
            ),
          ],
        );
      },
    );
    if (confirmed != true || !context.mounted) return;
    // The VM owns the state change; the PAGE owns navigation and does it from
    // a post-frame callback once `openChat` is set (after the host confirmed
    // the target as current). No BuildContext is touched after an await here.
    await vm.continueToChat();
  }
}

// ---------------------------------------------------------------------------
// Footer — read-only hint + explicit continue. No text field exists here.
// ---------------------------------------------------------------------------

class _ReadOnlyFooter extends StatelessWidget {
  const _ReadOnlyFooter({required this.state, required this.onContinue});
  final HistoryViewerState state;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final ready = state is HistoryViewerReady
        ? state as HistoryViewerReady
        : null;
    final busy = ready?.continuing == true;
    final waiting = ready?.waitingForTarget == true;
    final canContinue = ready != null;
    return SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(
          color: colors.bg,
          border: Border(top: BorderSide(color: colors.border)),
        ),
        padding: const EdgeInsets.fromLTRB(14, 9, 14, 10),
        child: Row(
          children: [
            Icon(LucideIcons.eye, size: 14, color: colors.muted),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                HistoryCopy.readOnlyHint,
                style: TextStyle(color: colors.muted2, fontSize: 11),
              ),
            ),
            const SizedBox(width: 10),
            FilledButton.icon(
              onPressed: busy || !canContinue ? null : onContinue,
              icon: busy
                  ? SizedBox(
                      width: 13,
                      height: 13,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.6,
                        color: colors.onAccent,
                      ),
                    )
                  : Icon(LucideIcons.play, size: 15, color: colors.onAccent),
              label: Text(
                busy
                    ? (waiting
                          ? HistoryCopy.waitingShort
                          : (state is HistoryViewerReady &&
                                    (state as HistoryViewerReady)
                                        .startingWorkspace
                                ? HistoryCopy.startingShort
                                : HistoryCopy.continuing))
                    : HistoryCopy.continueTitle,
                style: TextStyle(
                  color: colors.onAccent,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              style: FilledButton.styleFrom(
                backgroundColor: colors.accent,
                disabledBackgroundColor: colors.border,
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 11,
                ),
                shape: const RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(7)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Small views
// ---------------------------------------------------------------------------

class _OlderHeader extends StatelessWidget {
  const _OlderHeader({
    required this.hasOlder,
    required this.loading,
    required this.onLoad,
  });
  final bool hasOlder;
  final bool loading;
  final VoidCallback onLoad;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      child: Center(
        child: hasOlder
            ? loading
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 13,
                          height: 13,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.5,
                            color: colors.accent,
                          ),
                        ),
                        const SizedBox(width: 7),
                        Text(
                          HistoryCopy.loadingOlder,
                          style: TextStyle(color: colors.muted, fontSize: 11),
                        ),
                      ],
                    )
                  : TextButton(
                      onPressed: onLoad,
                      child: Text(
                        HistoryCopy.loadOlder,
                        style: TextStyle(color: colors.accent, fontSize: 12),
                      ),
                    )
            : Text(
                HistoryCopy.olderSession,
                style: TextStyle(color: colors.muted2, fontSize: 11),
              ),
      ),
    );
  }
}

class _EndOfHistory extends StatelessWidget {
  const _EndOfHistory();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
      child: Center(
        child: Text(
          HistoryCopy.ended,
          style: TextStyle(color: colors.muted2, fontSize: 11),
        ),
      ),
    );
  }
}

class _EmptyViewer extends StatelessWidget {
  const _EmptyViewer();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Text(
        HistoryCopy.empty,
        style: TextStyle(color: colors.muted, fontSize: 13),
      ),
    );
  }
}

class _ViewerSkeleton extends StatelessWidget {
  const _ViewerSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
        itemCount: 8,
        itemBuilder: (_, i) => Align(
          alignment: i.isEven ? Alignment.centerLeft : Alignment.centerRight,
          child: Container(
            width: i.isEven ? 230 : 180,
            height: 54,
            margin: const EdgeInsets.only(bottom: 14),
            decoration: BoxDecoration(
              color: colors.surface,
              borderRadius: BorderRadius.circular(10),
            ),
          ),
        ),
      ),
    );
  }
}

enum _Tone { info, warning }

class _Banner extends StatelessWidget {
  const _Banner({
    required this.text,
    required this.tone,
    this.onRetry,
    this.showProgress = false,
  });

  final String text;
  final _Tone tone;
  final VoidCallback? onRetry;
  final bool showProgress;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final color = tone == _Tone.warning ? colors.error : colors.accent;
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
              tone == _Tone.warning
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
