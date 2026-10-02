import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

/// Plan 01 — runtime-status detail sheet, opened by tapping the AppBar's
/// context chip. Shows the Pi's model, thinking level, token usage, cost and
/// context-window occupancy.
///
/// Takes the ViewModel (not a status value) and renders through
/// `context.watch`, so the figures keep updating while the sheet is open — a
/// turn in flight moves usage and cost, and a frozen snapshot would misreport
/// them.
Future<void> showRuntimeStatusSheet(
  BuildContext context, {
  required ChatViewModel vm,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.colors.bg,
    barrierColor: Colors.black.withValues(alpha: 0.6),
    isScrollControlled: true,
    showDragHandle: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) {
      return ChangeNotifierProvider<ChatViewModel>.value(
        value: vm,
        child: const _RuntimeStatusSheetBody(),
      );
    },
  );
}

class _RuntimeStatusSheetBody extends StatelessWidget {
  const _RuntimeStatusSheetBody();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final mq = MediaQuery.of(context);
    final status = context.watch<ChatViewModel>().runtimeStatus;
    final model = status.model;
    final ctxInfo = status.context;

    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: mq.size.height * 0.78),
        child: Padding(
          padding: EdgeInsets.only(bottom: mq.viewInsets.bottom),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 10),
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: colors.border,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                  child: Text(
                    'Runtime',
                    style: TextStyle(
                      fontFamily: kMonoFamily,
                      fontSize: 13,
                      color: colors.text,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                // ── Model ────────────────────────────────────────────────
                _Section(
                  title: 'Model',
                  child: model == null
                      ? const _Placeholder('unknown')
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    model.displayName,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontFamily: kMonoFamily,
                                      fontSize: 13,
                                      color: colors.text,
                                    ),
                                  ),
                                ),
                                if (model.reasoning) ...[
                                  const SizedBox(width: 6),
                                  const _Badge(label: 'reasoning'),
                                ],
                              ],
                            ),
                            const SizedBox(height: 3),
                            Text(
                              _modelSubtitle(model),
                              style: TextStyle(
                                fontFamily: kMonoFamily,
                                fontSize: 10,
                                color: colors.muted,
                              ),
                            ),
                          ],
                        ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                // ── Thinking ─────────────────────────────────────────────
                _Section(
                  title: 'Thinking',
                  child: _Row(
                    label: 'level',
                    value: status.thinkingLevel?.wire ?? '—',
                  ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                // ── Tokens ───────────────────────────────────────────────
                _Section(
                  title: 'Tokens',
                  child: Column(
                    children: [
                      _Row(label: 'input', value: _fmtInt(status.usage.input)),
                      _Row(label: 'output', value: _fmtInt(status.usage.output)),
                      _Row(
                        label: 'cache read',
                        value: _fmtInt(status.usage.cacheRead),
                      ),
                      _Row(
                        label: 'cache write',
                        value: _fmtInt(status.usage.cacheWrite),
                      ),
                    ],
                  ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                // ── Cost ─────────────────────────────────────────────────
                _Section(
                  title: 'Cost',
                  child: Column(
                    children: [
                      _Row(
                        label: 'input',
                        value: _fmtUsd(status.usage.cost.input),
                      ),
                      _Row(
                        label: 'output',
                        value: _fmtUsd(status.usage.cost.output),
                      ),
                      _Row(
                        label: 'cache read',
                        value: _fmtUsd(status.usage.cost.cacheRead),
                      ),
                      _Row(
                        label: 'cache write',
                        value: _fmtUsd(status.usage.cost.cacheWrite),
                      ),
                      _Row(
                        label: 'total',
                        value: _fmtUsd(status.usage.cost.total),
                        emphasis: true,
                      ),
                    ],
                  ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                // ── Context ──────────────────────────────────────────────
                _Section(
                  title: 'Context',
                  child: (ctxInfo == null || ctxInfo.tokens == null)
                      ? const _Placeholder('not reported yet')
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _ContextBar(
                              fraction: ((ctxInfo.percent ?? 0) / 100)
                                  .clamp(0.0, 1.0),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              '${ctxInfo.tokens} / ${ctxInfo.contextWindow} tokens '
                              '(${(ctxInfo.percent ?? 0).toStringAsFixed(1)}%)',
                              style: TextStyle(
                                fontFamily: kMonoFamily,
                                fontSize: 11,
                                color: colors.muted,
                              ),
                            ),
                          ],
                        ),
                ),
                if (status.updatedAt != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 4, 18, 20),
                    child: Text(
                      'updated ${_fmtClock(status.updatedAt!)}',
                      style: TextStyle(
                        fontFamily: kMonoFamily,
                        fontSize: 10,
                        color: colors.muted,
                      ),
                    ),
                  )
                else
                  const SizedBox(height: 20),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static String _modelSubtitle(RuntimeModelInfo m) {
    final ctx = m.contextWindow;
    if (ctx == null || ctx <= 0) return m.provider;
    final humanized = ctx >= 1000 ? '${(ctx / 1000).round()}k' : '$ctx';
    return '${m.provider} · ctx $humanized';
  }
}

/// Section chrome: an uppercase mono label above its content, with the divider
/// between sections handled by the caller's `Divider`.
class _Section extends StatelessWidget {
  final String title;
  final Widget child;
  const _Section({required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 11,
              color: colors.muted,
              letterSpacing: 0.4,
            ),
          ),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final String label;
  final String value;
  final bool emphasis;
  const _Row({required this.label, required this.value, this.emphasis = false});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 12,
                color: colors.muted,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Text(
            value,
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 12,
              color: colors.text,
              fontWeight: emphasis ? FontWeight.w500 : FontWeight.normal,
            ),
          ),
        ],
      ),
    );
  }
}

class _Placeholder extends StatelessWidget {
  final String text;
  const _Placeholder(this.text);

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        fontFamily: kMonoFamily,
        fontSize: 12,
        color: context.colors.muted,
      ),
    );
  }
}

/// Plain (non-animated) occupancy bar: `fraction` is expected pre-clamped.
class _ContextBar extends StatelessWidget {
  final double fraction;
  const _ContextBar({required this.fraction});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        return Stack(
          children: [
            Container(
              height: 6,
              width: width,
              decoration: BoxDecoration(
                color: colors.border,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
            Container(
              height: 6,
              width: width * fraction,
              decoration: BoxDecoration(
                color: colors.accent,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _Badge extends StatelessWidget {
  final String label;
  const _Badge({required this.label});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: colors.accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: kMonoFamily,
          fontSize: 9,
          color: colors.accent,
        ),
      ),
    );
  }
}

/// 1234567 → '1,234,567'.
String _fmtInt(int n) {
  final s = n.toString();
  final buf = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
    buf.write(s[i]);
  }
  return buf.toString();
}

String _fmtUsd(double v) => '\$${v.toStringAsFixed(4)}';

/// Local wall-clock 'HH:mm:ss' with zero padding (avoids an `intl` dep for a
/// single label).
String _fmtClock(DateTime t) {
  final local = t.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(local.hour)}:${two(local.minute)}:${two(local.second)}';
}
