import 'package:mobile/routing/adaptive.dart' show kMaxContentWidth;
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/home/states/home_state.dart';
import 'package:flutter/material.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan-38 Fase 3 — presence filter for the Home list. A 3-pill segmented
/// control (All · Online · Offline) the user taps to slice the existing
/// (peer → room) list by liveness. Pure view filter: tapping a tab never
/// reloads data, it only narrows [HomeViewModel.visibleItems]. The default
/// tab is Online (set by [HomeList.filter]).
class HomeFilterTabs extends StatelessWidget {
  final HomeFilter filter;

  /// Per-tab counts for the badges (each tab shows its own slice's size).
  final ({int all, int online, int offline}) counts;
  final ValueChanged<HomeFilter> onSelected;

  const HomeFilterTabs({
    super.key,
    required this.filter,
    required this.counts,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 10),
      child: Container(
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: colors.border),
        ),
        padding: const EdgeInsets.all(3),
        child: Row(
          children: [
            _segment(context, HomeFilter.all, '全部', counts.all),
            _segment(context, HomeFilter.online, '在线', counts.online),
            _segment(context, HomeFilter.offline, '离线', counts.offline),
          ],
        ),
      ),
    );
  }

  Widget _segment(
    BuildContext context,
    HomeFilter value,
    String label,
    int count,
  ) {
    final colors = context.colors;
    final selected = filter == value;
    return Expanded(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onSelected(value),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: selected ? colors.accent : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: selected ? colors.onAccent : colors.muted,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                '$count',
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: selected ? colors.onAccent : colors.muted2,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Plan-38 Fase 3 — empty state shown BELOW the tabs when the current tab
/// has no matching sessions but the list isn't globally empty (the
/// globally-empty case keeps the existing "Nothing here…" lonely state and
/// hides the tabs entirely). Copy varies per tab so the user understands
/// it's a filter, not a dead end. [HomeFilter.all] is included for
/// completeness but in practice never renders empty while items exist.
class HomeFilterEmptyState extends StatelessWidget {
  final HomeFilter filter;
  const HomeFilterEmptyState({super.key, required this.filter});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (String title, String subtitle) = switch (filter) {
      HomeFilter.online => (
        '没有在线的会话',
        '当已配对的 Pi 活动时，在线会话会出现在这里。',
      ),
      HomeFilter.offline => (
        '没有离线会话',
        '你之前见过但当前不在线的会话会出现在这里。',
      ),
      HomeFilter.all => (
        HomeCopy.nothingHere,
        HomeCopy.nothingHint,
      ),
    };
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
        child: Opacity(
          opacity: 0.35,
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(LucideIcons.moon, color: colors.muted, size: 56),
                const SizedBox(height: 18),
                Text(
                  title,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    color: colors.muted2,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  subtitle,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    color: colors.muted,
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
