import 'dart:async';

import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/pairing/states/pairing_state.dart';
import 'package:app/ui/pairing/viewmodels/pairing_viewmodel.dart';
import 'package:app/ui/pairing/widgets/nickname_sheet.dart';
import 'package:app/ui/pairing/widgets/paste_pairing_sheet.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

// ---------------------------------------------------------------------------
// PairingPage — paste the pairing code, then pair_request
//
// Plan/68 — pairing is paste-only. The camera/QR-scan path was removed: the
// user copies the `remotepi://pair?…` string from the computer and pastes
// it here. Plan/69 W1 — the paste sheet grew a second field: the relay
// ADDRESS (auto-filled from the code's `r=`, editable, empty = the default
// relay from Preferences). The payload format is unchanged (see
// `lib/pairing/pair_payload.dart`).
// ---------------------------------------------------------------------------

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});

  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  // Guards against [_runPostPairFlow] firing twice — `PairingPaired`
  // is rebroadcast on every `applyNickname` emit, and we only want to
  // open the sheet once per pairing.
  bool _postPairStarted = false;

  Future<void> _openPasteSheet() async {
    await showPastePairingSheet(
      context,
      vm: context.read<PairingViewModel>(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<PairingViewModel>();
    final state = vm.state;

    if (state is PairingPaired && !_postPairStarted) {
      _postPairStarted = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        unawaited(_runPostPairFlow(state.hostnameHint));
      });
    }

    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: const Text('Pair device'),
      ),
      body: _buildBody(state, vm),
    );
  }

  /// Plan/27 Wave A — opens the post-pair nickname sheet, persists
  /// whatever the user picked, then navigates home. Modal is
  /// dismissible; either Save, Skip or drag-down all produce a usable
  /// label so the mesh blob carries a real string for other devices.
  Future<void> _runPostPairFlow(String? hostnameHint) async {
    final vm = context.read<PairingViewModel>();
    final nickname = await showNicknameSheet(
      context,
      defaultName: hostnameHint,
    );
    if (!mounted) return;
    await vm.applyNickname(nickname);
    if (!mounted) return;
    context.go('/home');
  }

  Widget _buildBody(PairingState state, PairingViewModel vm) {
    return switch (state) {
      PairingIdle() ||
      PairingScanning() ||
      PairingConnecting() => _buildPasteBody(state),
      PairingPaired() => Center(
        child: CircularProgressIndicator(color: context.colors.accent),
      ),
      PairingError(:final message, :final canRetry) => _ErrorView(
        message: message,
        canRetry: canRetry,
        onRetry: vm.retry,
      ),
    };
  }

  Widget _buildPasteBody(PairingState state) {
    final colors = context.colors;
    final isConnecting = state is PairingConnecting;
    final sessionName = isConnecting ? state.sessionName : null;

    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.clipboardPaste, size: 48, color: colors.accent),
            const SizedBox(height: 20),
            Text(
              isConnecting
                  ? 'Connecting to $sessionName…'
                  : 'Paste the pairing code from your computer',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.text, fontSize: 14),
            ),
            const SizedBox(height: 8),
            Text(
              'Run /remote-pi pair on your computer and paste the '
              'remotepi://pair?… code it prints. The relay address fills in '
              'from the code — edit it only for a self-hosted relay, or '
              'clear it to use your default.',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted2, fontSize: 12, height: 1.4),
            ),
            if (!isConnecting) ...[
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: _openPasteSheet,
                icon: Icon(
                  LucideIcons.clipboardPaste,
                  size: 16,
                  color: colors.onAccent,
                ),
                label: Text(
                  'Paste pairing code',
                  style: TextStyle(
                    color: colors.onAccent,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 20,
                    vertical: 14,
                  ),
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.all(Radius.circular(8)),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Error view
// ---------------------------------------------------------------------------

class _ErrorView extends StatelessWidget {
  final String message;
  final bool canRetry;
  final VoidCallback onRetry;

  const _ErrorView({
    required this.message,
    required this.canRetry,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              LucideIcons.circleAlert,
              color: colors.error,
              size: 48,
            ),
            const SizedBox(height: 16),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted2, fontSize: 14),
            ),
            if (canRetry) ...[
              const SizedBox(height: 24),
              FilledButton(
                onPressed: onRetry,
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  foregroundColor: colors.onAccent,
                ),
                child: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
