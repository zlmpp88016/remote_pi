import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/home/states/home_state.dart';
import 'package:flutter/material.dart';

/// A row on Home: one paired SERVER.
///
/// Home is the OUTERMOST layer of server → workspace → session, so this row
/// answers exactly one question — which machine is this, and is it reachable.
/// The folders it runs are the next screen's subject, so their count appears
/// only as a muted sub-label, never as the row's status.
///
/// It replaces [SessionTile] on Home. That tile rendered a (peer, room) pair,
/// which meant one machine running eight folders produced eight rows with eight
/// dots — and the dot could not honestly mean "this machine is up".
class ServerTile extends StatelessWidget {
  final HomeServer server;

  /// `true` when the app's WS to the relay is retrying/down. Overrides the
  /// server's own state: with no relay we have no fresh signal about ANY
  /// machine, so an amber dot is the honest answer.
  final bool isReconnecting;

  final VoidCallback onOpen;

  /// Plan/tablet — paints the accent bar + faint fill on the server whose
  /// detail pane is open. Always false on phone.
  final bool isSelected;

  const ServerTile({
    super.key,
    required this.server,
    required this.onOpen,
    this.isReconnecting = false,
    this.isSelected = false,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.bg,
      child: InkWell(
        onTap: onOpen,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: isSelected ? colors.accent.withValues(alpha: 0.06) : colors.bg,
            border: Border(
              left: BorderSide(
                color: isSelected ? colors.accent : Colors.transparent,
                width: 3,
              ),
            ),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(isSelected ? 15 : 18, 14, 18, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _ServerAvatar(label: server.displayName),
                const SizedBox(width: 14),
                Expanded(child: _TitleBlock(server: server)),
                _StatusDot(
                  online: server.online,
                  isReconnecting: isReconnecting,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ServerAvatar extends StatelessWidget {
  final String label;
  const _ServerAvatar({required this.label});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final initial = label.isEmpty ? '?' : label.characters.first.toUpperCase();
    return Container(
      width: 36,
      height: 36,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: const BorderRadius.all(Radius.circular(8)),
        border: Border.all(color: colors.border),
      ),
      child: Text(
        initial,
        style: TextStyle(
          color: colors.text,
          fontSize: 15,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _TitleBlock extends StatelessWidget {
  final HomeServer server;
  const _TitleBlock({required this.server});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          server.displayName,
          style: TextStyle(
            color: colors.text,
            fontSize: 14,
            fontWeight: FontWeight.w500,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 2),
        Text(
          _subtitle(),
          style: TextStyle(color: colors.muted, fontSize: 12),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }

  /// Deliberately describes the NEXT layer without pretending to be a status.
  /// A machine with no open folder is normal, and saying so is more useful than
  /// an empty space.
  String _subtitle() {
    if (server.workspaceCount == 0) return '没有打开的工作空间';
    final noun = server.workspaceCount == 1 ? '工作空间' : '工作空间';
    if (server.liveCount == 0) return '${server.workspaceCount} $noun';
    return '${server.workspaceCount} $noun · ${server.liveCount} 活跃';
  }
}

/// Same 3-state contract as the old tile, minus `working`: at server level an
/// agent streaming somewhere inside the machine is not a machine-wide state.
class _StatusDot extends StatelessWidget {
  final bool online;
  final bool isReconnecting;
  const _StatusDot({required this.online, required this.isReconnecting});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final Color color = isReconnecting
        ? colors.warning
        : online
        ? colors.success
        : colors.muted;
    return Semantics(
      label: isReconnecting ? '重连中' : (online ? '在线' : '离线'),
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(shape: BoxShape.circle, color: color),
      ),
    );
  }
}
