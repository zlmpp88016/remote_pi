import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/pairing/states/pairing_state.dart';
import 'package:app/ui/pairing/viewmodels/pairing_viewmodel.dart';
import 'package:app/ui/pairing/widgets/paste_pairing_sheet.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Onboarding step 3 — embeds the existing pairing flow. Watches the
/// already-registered `PairingViewModel` (Provider) and notifies the
/// onboarding flow when `pair_ok` lands.
///
/// Plan/68 — paste-only: the camera/QR-scan path was removed, so this step
/// shows the paste entry point directly instead of a live scanner preview.
class PairStep extends StatefulWidget {
  final VoidCallback onPaired;
  final VoidCallback onBack;
  final VoidCallback onSkip;
  const PairStep({
    super.key,
    required this.onPaired,
    required this.onBack,
    required this.onSkip,
  });

  @override
  State<PairStep> createState() => _PairStepState();
}

class _PairStepState extends State<PairStep> {
  PairingState? _lastObserved;

  Future<void> _openPasteSheet(PairingViewModel vm) async {
    await showPastePairingSheet(context, vm: vm);
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<PairingViewModel>();
    final state = vm.state;

    // Detect transition into PairingPaired and notify parent. Done once.
    if (state is PairingPaired && _lastObserved is! PairingPaired) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onPaired();
      });
    }
    _lastObserved = state;

    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 24),
          Text(
            'Connect to your device',
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 16,
              color: colors.text,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'On your computer (Mac, Linux, or Windows), open Pi and run:',
            style: TextStyle(
                fontFamily: kMonoFamily, fontSize: 11, color: colors.muted),
          ),
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: colors.bg,
              border: Border.all(color: colors.border),
              borderRadius: const BorderRadius.all(Radius.circular(6)),
            ),
            child: Text(
              '/remote-pi pair',
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 13,
                color: colors.accent,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Copy the pairing code it prints:',
            style: TextStyle(
                fontFamily: kMonoFamily, fontSize: 11, color: colors.muted),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: ClipRRect(
              borderRadius: const BorderRadius.all(Radius.circular(8)),
              child: _buildStatusBody(state, vm),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              OutlinedButton(
                onPressed: widget.onBack,
                style: OutlinedButton.styleFrom(
                  foregroundColor: colors.muted,
                  side: BorderSide(color: colors.border),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 18,
                    vertical: 12,
                  ),
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.all(Radius.circular(6)),
                  ),
                ),
                child: Text(
                  'Back',
                  style: TextStyle(fontFamily: kMonoFamily, fontSize: 13),
                ),
              ),
              const Spacer(),
              TextButton(
                onPressed: widget.onSkip,
                style: TextButton.styleFrom(
                  foregroundColor: colors.accent,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                ),
                child: Text(
                  'Pair later',
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _buildStatusBody(PairingState state, PairingViewModel vm) {
    if (state is PairingScanning || state is PairingIdle) {
      final colors = context.colors;
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.clipboardPaste, color: colors.accent, size: 40),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: FilledButton.icon(
                onPressed: () => _openPasteSheet(vm),
                icon: Icon(
                  LucideIcons.clipboardPaste,
                  size: 16,
                  color: colors.onAccent,
                ),
                label: Text(
                  'Paste pairing code',
                  style: TextStyle(fontFamily: kMonoFamily, fontSize: 12),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  foregroundColor: colors.onAccent,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 18,
                    vertical: 12,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }
    if (state is PairingConnecting) {
      return _StatusOverlay(
        icon: LucideIcons.refreshCw,
        message: 'Pairing…',
      );
    }
    if (state is PairingError) {
      return _StatusOverlay(
        icon: LucideIcons.circleAlert,
        message: state.message,
        actionLabel: state.canRetry ? 'Try again' : null,
        onAction: state.canRetry ? vm.retry : null,
      );
    }
    if (state is PairingPaired) {
      return _StatusOverlay(
        icon: LucideIcons.circleCheck,
        message: 'Paired!',
      );
    }
    return const SizedBox.shrink();
  }
}

class _StatusOverlay extends StatelessWidget {
  final IconData icon;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  const _StatusOverlay({
    required this.icon,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      color: colors.bg,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: colors.accent, size: 40),
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Text(
                message,
                textAlign: TextAlign.center,
                style: TextStyle(
                    fontFamily: kMonoFamily, fontSize: 12, color: colors.text),
              ),
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 16),
              FilledButton(
                onPressed: onAction,
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  foregroundColor: colors.onAccent,
                ),
                child: Text(
                  actionLabel!,
                  style:
                      TextStyle(fontFamily: kMonoFamily, fontSize: 12),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
