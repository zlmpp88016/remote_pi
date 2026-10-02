import 'dart:async';

import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan 01 — session-tree picker. Renders the Pi's tree snapshot so the user can
/// branch: tapping a forkable (user) message branches from just before it,
/// tapping any other entry moves the active branch there.
///
/// Takes the ViewModel rather than a snapshot value: a sheet is built once, so
/// value params would freeze the tree while the reply it is waiting for lands.
Future<void> showSessionTreeSheet(
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
        child: const _SessionTreeSheetBody(),
      );
    },
  );
}

class _SessionTreeSheetBody extends StatefulWidget {
  const _SessionTreeSheetBody();

  @override
  State<_SessionTreeSheetBody> createState() => _SessionTreeSheetBodyState();
}

class _SessionTreeSheetBodyState extends State<_SessionTreeSheetBody> {
  /// Currently selected filter chip, seeded from the snapshot's default.
  String? _selectedFilter;

  @override
  void initState() {
    super.initState();
    // The sheet opens before the snapshot exists in the normal case; asking on
    // mount is what fills the loading state in.
    unawaited(context.read<ChatViewModel>().refreshTree());
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<ChatViewModel>();
    final mq = MediaQuery.of(context);
    final snapshot = vm.treeSnapshot;
    final error = vm.treeError;
    final busy = vm.isWorking;

    final filter = _selectedFilter ?? snapshot?.defaultFilter ?? 'default';

    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: mq.size.height * 0.78),
        child: Padding(
          padding: EdgeInsets.only(bottom: mq.viewInsets.bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
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
              const SizedBox(height: 8),
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 8, 10),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Session tree',
                        style: TextStyle(
                          fontFamily: kMonoFamily,
                          fontSize: 13,
                          color: colors.text,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                    IconButton(
                      icon: Icon(
                        LucideIcons.refreshCw,
                        size: 18,
                        color: colors.muted,
                      ),
                      tooltip: 'Refresh',
                      onPressed: () => unawaited(vm.refreshTree()),
                    ),
                  ],
                ),
              ),
              Divider(color: colors.border, height: 1, thickness: 1),
              if (busy)
                _Notice(
                  text: 'Agent is working — branching is paused.',
                  color: colors.warning,
                ),
              if (snapshot != null && snapshot.filters.length > 1)
                _FilterRow(
                  filters: snapshot.filters,
                  selected: filter,
                  onSelect: (f) => setState(() => _selectedFilter = f),
                ),
              Flexible(
                child: _buildList(
                  context: context,
                  vm: vm,
                  snapshot: snapshot,
                  error: error,
                  busy: busy,
                  filter: filter,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildList({
    required BuildContext context,
    required ChatViewModel vm,
    required TreeSnapshot? snapshot,
    required String? error,
    required bool busy,
    required String filter,
  }) {
    final colors = context.colors;
    if (error != null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _humanError(error),
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 12,
                color: colors.error,
              ),
            ),
            const SizedBox(height: 14),
            OutlinedButton(
              onPressed: () => unawaited(vm.refreshTree()),
              style: OutlinedButton.styleFrom(
                foregroundColor: colors.accent,
                side: BorderSide(color: colors.border),
              ),
              child: const Text(
                'Retry',
                style: TextStyle(fontFamily: kMonoFamily, fontSize: 12),
              ),
            ),
          ],
        ),
      );
    }
    if (snapshot == null) {
      return SizedBox(
        height: 120,
        child: Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              color: colors.accent,
            ),
          ),
        ),
      );
    }
    final entries = _filterEntries(snapshot.entries, filter);
    if (entries.isEmpty) {
      return SizedBox(
        height: 120,
        child: Center(
          child: Text(
            'Empty tree',
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 12,
              color: colors.muted,
            ),
          ),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 18),
      shrinkWrap: true,
      itemCount: entries.length,
      separatorBuilder: (_, _) =>
          Divider(color: colors.border, height: 1, thickness: 1),
      itemBuilder: (_, i) {
        final entry = entries[i];
        return _TreeTile(
          entry: entry,
          onTap: () => _dispatch(vm, snapshot, entry, busy),
        );
      },
    );
  }

  void _dispatch(
    ChatViewModel vm,
    TreeSnapshot snapshot,
    TreeEntry entry,
    bool busy,
  ) {
    if (busy) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('The agent is working — try again when it finishes.'),
        ),
      );
      return;
    }
    final fence = TreeFence.fromSnapshot(snapshot);
    if (entry.isForkable) {
      unawaited(vm.forkSession(entry.id, fence));
    } else {
      unawaited(vm.navigateTree(entry.id, fence));
    }
    Navigator.of(context).pop();
  }

  /// Wire code → something a user can act on. Unknown codes fall through to the
  /// raw string rather than pretending to know what happened.
  static String _humanError(String code) {
    return switch (code) {
      'session_busy' => 'The agent is working — try again when it finishes.',
      'tree_state_changed' => 'The tree changed — refresh and try again.',
      'target_not_found' => 'That entry no longer exists.',
      'target_not_forkable' => 'That entry cannot be branched.',
      _ => code,
    };
  }

  /// Apply the snapshot's filter vocabulary. Anything unrecognised (a filter a
  /// future Pi adds) shows everything rather than hiding the tree.
  static List<TreeEntry> _filterEntries(List<TreeEntry> entries, String filter) {
    return switch (filter) {
      'user' => entries.where((e) => e.role == 'user').toList(),
      'assistant' => entries.where((e) => e.role == 'assistant').toList(),
      'tools' =>
        entries.where((e) => e.type == 'tool' || e.toolName != null).toList(),
      _ => entries,
    };
  }
}

class _TreeTile extends StatelessWidget {
  final TreeEntry entry;
  final VoidCallback onTap;
  const _TreeTile({required this.entry, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (IconData icon, Color iconColor) = entry.isCurrentLeaf
        ? (LucideIcons.circleDot, colors.accent)
        : entry.isOnActiveBranch
        ? (LucideIcons.circle, colors.muted2)
        : (LucideIcons.circle, colors.border);
    final kind = entry.role ?? entry.customType ?? entry.type;

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(icon, size: 14, color: iconColor),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    kind.toUpperCase(),
                    style: TextStyle(
                      fontFamily: kMonoFamily,
                      fontSize: 9,
                      color: colors.muted,
                      letterSpacing: 0.4,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    entry.preview,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: kMonoFamily,
                      fontSize: 12,
                      color: colors.text,
                    ),
                  ),
                  if (entry.timestamp != null) ...[
                    const SizedBox(height: 3),
                    Text(
                      _fmtDayMinute(entry.timestamp!),
                      style: TextStyle(
                        fontFamily: kMonoFamily,
                        fontSize: 10,
                        color: colors.muted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (entry.isForkable)
              Padding(
                padding: const EdgeInsets.only(top: 2, left: 8),
                child: Tooltip(
                  message: 'Fork from here',
                  child: Icon(
                    LucideIcons.gitBranch,
                    size: 14,
                    color: colors.accent,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _FilterRow extends StatelessWidget {
  final List<String> filters;
  final String selected;
  final ValueChanged<String> onSelect;
  const _FilterRow({
    required this.filters,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          for (final f in filters) ...[
            GestureDetector(
              onTap: () => onSelect(f),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  border: Border.all(
                    color: selected == f ? colors.accent : colors.border,
                  ),
                  color: selected == f
                      ? colors.accent.withValues(alpha: 0.12)
                      : colors.bg,
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  f,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 11,
                    color: selected == f ? colors.accent : colors.muted,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
          ],
        ],
      ),
    );
  }
}

/// One-line status strip under the header (currently: agent busy).
class _Notice extends StatelessWidget {
  final String text;
  final Color color;
  const _Notice({required this.text, required this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          text,
          style: TextStyle(
            fontFamily: kMonoFamily,
            fontSize: 11,
            color: color,
          ),
        ),
      ),
    );
  }
}

/// Local 'MM-DD HH:mm' (avoids an `intl` dependency for one label).
String _fmtDayMinute(DateTime t) {
  final local = t.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}
