import 'package:app/domain/session_state.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/chat/widgets/tool_request_card.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan 01 — collapses a run of consecutive tool calls into one expandable
/// card. The transcript's noisiest stretch is a burst of tool traffic between
/// two messages; a single summary line ("Ran 4 tools") keeps the conversation
/// readable while the detail stays one tap away.
///
/// Collapsed by default, and it reuses [ToolRequestCard] for the expanded
/// detail so tool rendering stays in exactly one place.
class ActivityGroupCard extends StatefulWidget {
  final List<ToolEvent> tools;

  const ActivityGroupCard({super.key, required this.tools});

  @override
  State<ActivityGroupCard> createState() => _ActivityGroupCardState();
}

class _ActivityGroupCardState extends State<ActivityGroupCard> {
  bool _expanded = false;

  /// One colour for the whole group: any failure makes it red, otherwise any
  /// still-running tool makes it blue, otherwise it reads as done.
  Color _groupColor(BuildContext context) {
    final colors = context.colors;
    final statuses = widget.tools.map((t) => t.status).toSet();
    if (statuses.contains(ToolEventStatus.failed)) return colors.error;
    if (statuses.contains(ToolEventStatus.denied) ||
        statuses.contains(ToolEventStatus.expired)) {
      return colors.muted;
    }
    if (statuses.contains(ToolEventStatus.pending) ||
        statuses.contains(ToolEventStatus.allowed)) {
      return colors.accent;
    }
    return colors.success;
  }

  String _summary() {
    final names = <String, int>{};
    for (final t in widget.tools) {
      names[t.tool] = (names[t.tool] ?? 0) + 1;
    }
    final parts = names.entries
        .map((e) => e.value == 1 ? e.key : '${e.key} ×${e.value}')
        .toList();
    return 'Ran ${widget.tools.length} '
        '${widget.tools.length == 1 ? 'tool' : 'tools'}: ${parts.join(', ')}';
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final color = _groupColor(context);
    return Container(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(
                children: [
                  Icon(
                    _expanded
                        ? LucideIcons.chevronDown
                        : LucideIcons.chevronRight,
                    size: 14,
                    color: colors.muted,
                  ),
                  const SizedBox(width: 8),
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _summary(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: kMonoFamily,
                        fontSize: 11.5,
                        color: colors.muted2,
                        letterSpacing: 0.2,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Column(
                children: [
                  for (final tool in widget.tools) ...[
                    ToolRequestCard(tool: tool),
                    const SizedBox(height: 8),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}
