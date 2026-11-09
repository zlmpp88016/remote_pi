import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/transport/relay_config.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/settings/states/settings_state.dart';
import 'package:mobile/ui/settings/viewmodels/settings_viewmodel.dart';
import 'package:mobile/ui/settings/widgets/widgets.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

class SettingsPage extends StatelessWidget {
  /// Plan/tablet — `true` when presented as a modal bottom sheet (tablet)
  /// rather than a pushed full-screen route (phone). Swaps the back arrow
  /// for a close (X), since the sheet is dismissed, not popped to a parent.
  final bool embedded;

  const SettingsPage({super.key, this.embedded = false});

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<SettingsViewModel>();
    final state = vm.state;
    final colors = context.colors;

    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: const Text(AppSettingsCopy.title),
        automaticallyImplyLeading: false,
        leading: IconButton(
          icon: Icon(
            embedded ? LucideIcons.x : LucideIcons.chevronLeft,
            size: embedded ? 22 : 18,
            color: colors.text,
          ),
          tooltip: embedded ? 'Close' : 'Back',
          onPressed: () =>
              context.canPop() ? context.pop() : context.go('/home'),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Divider(color: colors.border, height: 1),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          const _RelaySection(),
          Divider(color: colors.border, height: 1),
          const _DisplaySection(),
          Divider(color: colors.border, height: 1),
          const _SectionHeader(AppSettingsCopy.pairings),
          switch (state) {
            SettingsLoading() => Padding(
              padding: const EdgeInsets.symmetric(vertical: 32),
              child: Center(
                child: CircularProgressIndicator(color: colors.accent),
              ),
            ),
            SettingsNoPeer() => const _EmptyState(),
            SettingsList(:final peers) => _PeerList(
              peers: peers,
              onRevoke: vm.revoke,
              onSetNickname: vm.setNickname,
            ),
          },
          // Plan-17 follow-up — entry point to pair an additional Pi.
          // The flow itself lives at /pair and survives whatever
          // peers/rooms already exist (PairingViewModel handles the
          // add path the same way as the first pair).
          const _AddPairingButton(),
        ],
      ),
    );
  }
}

class _AddPairingButton extends StatelessWidget {
  const _AddPairingButton();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 16),
      child: OutlinedButton.icon(
        onPressed: () => context.push('/pair'),
        style: OutlinedButton.styleFrom(
          foregroundColor: colors.accent,
          side: BorderSide(color: colors.border),
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(6)),
          ),
          minimumSize: const Size.fromHeight(0),
        ),
        icon: const Icon(LucideIcons.scanQrCode, size: 18),
        label: Text(
          AppSettingsCopy.addPairing,
          style: const TextStyle(fontFamily: kMonoFamily, fontSize: 13),
        ),
      ),
    );
  }
}

class _RelaySection extends StatefulWidget {
  const _RelaySection();
  @override
  State<_RelaySection> createState() => _RelaySectionState();
}

/*
 * The relay is a property of EACH PAIRING, not a global app setting.
 *
 * This used to be an editable field feeding `Preferences.relayUrl`, applied to
 * every connection. That only made sense while exactly one server could be
 * paired: once a second machine is added, "the" relay is unanswerable — the
 * user's own words were "does this middleman belong to the first machine or the
 * second?". The connection now reads the relay recorded on the PeerRecord, and
 * this section is reduced to what remains true: a prefill for the NEXT pairing,
 * plus a per-pairing (read-only) address rendered next to each pairing.
 */
class _RelaySectionState extends State<_RelaySection> {
  @override
  Widget build(BuildContext context) {
    final vm = context.watch<SettingsViewModel>();
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _SectionHeader(AppSettingsCopy.defaultRelay),
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                vm.effectiveRelayUrl,
                style: context.typo.mono.copyWith(
                  fontSize: 13,
                  color: colors.text,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                AppSettingsCopy.defaultRelayDetail,
                style: context.typo.sansBody.copyWith(
                  fontSize: 12,
                  color: colors.muted,
                  height: 1.4,
                ),
              ),
              if (vm.relayUrlOverride != kDefaultRelayUrl) ...[
                const SizedBox(height: 4),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: () => vm.saveRelayUrl(kDefaultRelayUrl),
                    child: Text(
                      AppSettingsCopy.defaultRelayReset,
                      style: const TextStyle(
                        fontFamily: kMonoFamily,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _DisplaySection extends StatelessWidget {
  const _DisplaySection();

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<Preferences>();
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _SectionHeader('显示'),
        // Theme mode — System follows the OS; Light / Dark pin it.
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 4, 18, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '主题',
                style: context.typo.sansBody.copyWith(color: colors.text),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: SegmentedButton<ThemeMode>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(
                      value: ThemeMode.system,
                      label: Text('跟随系统'),
                    ),
                    ButtonSegment(
                      value: ThemeMode.light,
                      label: Text('浅色'),
                    ),
                    ButtonSegment(
                      value: ThemeMode.dark,
                      label: Text('深色'),
                    ),
                  ],
                  selected: {prefs.themeMode},
                  onSelectionChanged: (s) => prefs.setThemeMode(s.first),
                ),
              ),
            ],
          ),
        ),
        // Text size — the app hardcodes its font sizes and Flutter can't read
        // iOS's per-app Text Size, so without this the only way to enlarge chat
        // text is the OS-wide accessibility setting (issue #114).
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                AppSettingsCopy.textSize,
                style: context.typo.sansBody.copyWith(color: colors.text),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: SegmentedButton<AppFontScale>(
                  showSelectedIcon: false,
                  segments: [
                    for (final scale in AppFontScale.values)
                      ButtonSegment(value: scale, label: Text(scale.label)),
                  ],
                  selected: {prefs.fontScale},
                  onSelectionChanged: (s) => prefs.setFontScale(s.first),
                ),
              ),
            ],
          ),
        ),
        SwitchListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 18),
          activeThumbColor: colors.accent,
          title: Text(
            AppSettingsCopy.hideToolCalls,
            style: context.typo.sansBody.copyWith(color: colors.text),
          ),
          subtitle: Text(
            AppSettingsCopy.hideToolCallsDetail,
            style: context.typo.sansBody.copyWith(
              color: colors.muted,
              fontSize: 12,
            ),
          ),
          value: prefs.hideToolCalls,
          onChanged: (v) => prefs.setHideToolCalls(v),
        ),
        const SizedBox(height: 8),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String label;
  const _SectionHeader(this.label);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: context.colors.muted,
          letterSpacing: 1.4,
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(LucideIcons.monitorSmartphone, color: colors.muted, size: 40),
          const SizedBox(height: 12),
          Text(
            AppSettingsCopy.noPairings,
            style: TextStyle(color: colors.muted2, fontSize: 14),
          ),
          const SizedBox(height: 6),
          Text(
            AppSettingsCopy.noPairingsHint,
            style: TextStyle(color: colors.muted, fontSize: 12),
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: () => context.push('/pair'),
            style: FilledButton.styleFrom(
              backgroundColor: colors.accent,
              foregroundColor: colors.onAccent,
            ),
            icon: const Icon(LucideIcons.scanQrCode, size: 18),
            label: const Text('扫码配对'),
          ),
        ],
      ),
    );
  }
}

class _PeerList extends StatelessWidget {
  final List<PeerRecord> peers;
  final Future<void> Function(String epk) onRevoke;
  final Future<void> Function(String epk, String? nickname) onSetNickname;

  const _PeerList({
    required this.peers,
    required this.onRevoke,
    required this.onSetNickname,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final peer in peers)
          PeerListItem(
            peer: peer,
            onEditNickname: () => _editNickname(context, peer),
            onRevokeRequested: () async {
              final confirmed = await showRevokeConfirmDialog(
                context,
                peer: peer,
              );
              if (!confirmed) return false;
              await onRevoke(peer.remoteEpk);
              return true;
            },
          ),
      ],
    );
  }

  Future<void> _editNickname(BuildContext context, PeerRecord peer) async {
    final result = await showNicknameEditor(
      context,
      defaultName: peer.sessionName,
      currentNickname: peer.nickname ?? '',
    );
    if (result == null) return; // canceled
    await onSetNickname(peer.remoteEpk, result.isEmpty ? null : result);
  }
}
