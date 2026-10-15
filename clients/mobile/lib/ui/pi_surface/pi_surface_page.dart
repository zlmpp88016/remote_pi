import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/pi_surface/states/pi_surface_state.dart';
import 'package:app/ui/pi_surface/viewmodels/pi_surface_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan/68 — the "Pi" page of a workspace: what the machine's Pi has installed
/// and the closed-vocabulary actions to manage it.
///
/// Everything here is the app's view of the *machine's* Pi — the same Pi the
/// chat talks to. Skills show their provenance (user / project / package) and
/// can be toggled or run with args; packages show their scope and can be
/// installed, removed or updated. Installing runs third-party code, so it
/// always goes through an explicit confirmation dialog and the
/// `confirm_third_party` flag is only ever set after that accept.
class PiSurfacePage extends StatelessWidget {
  const PiSurfacePage({
    super.key,
    this.title = 'Pi',
    this.device,
  });

  final String title;
  final String? device;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<PiSurfaceViewModel>();
    final state = vm.state;
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: TextStyle(color: colors.text, fontSize: 16)),
            Text(
              device ?? 'Skills and plugins on the machine',
              style: TextStyle(color: colors.muted, fontSize: 12),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: state is PiSurfaceReady ? () => vm.reload() : null,
            icon: Icon(LucideIcons.refreshCw, color: colors.muted, size: 18),
          ),
        ],
      ),
      body: switch (state) {
        PiSurfaceLoading() => Center(
          child: CircularProgressIndicator(color: colors.accent),
        ),
        PiSurfaceError(:final message) => _ErrorBody(
          message: message,
          onRetry: vm.reload,
        ),
        PiSurfaceReady() => _ReadyBody(state: state, vm: vm),
      },
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
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
            Icon(LucideIcons.circleAlert, color: colors.error, size: 36),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted),
            ),
            const SizedBox(height: 16),
            TextButton(
              onPressed: onRetry,
              child: Text('Retry', style: TextStyle(color: colors.accent)),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadyBody extends StatelessWidget {
  const _ReadyBody({required this.state, required this.vm});
  final PiSurfaceReady state;
  final PiSurfaceViewModel vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            _RuntimeHeader(runtime: state.runtime),
            if (state.lastOp != null) _OpBanner(op: state.lastOp!),
            _SectionHeader(
              title: 'Skills',
              trailing: Text(
                '${state.skills.length}',
                style: TextStyle(color: colors.muted, fontSize: 12),
              ),
            ),
            if (state.skills.isEmpty)
              const _EmptyRow(
                icon: LucideIcons.sparkles,
                text: 'No skills installed on this Pi.',
              )
            else
              ...state.skills.map(
                (s) => _SkillTile(
                  skill: s,
                  busy: state.busySkill == s.name,
                  anyBusy: state.busySkill != null,
                  onToggle: (v) => vm.setSkillEnabled(s.name, v),
                  onInvoke: (args) => vm.invokeSkill(s.name, args: args),
                ),
              ),
            _SectionHeader(
              title: 'Packages',
              trailing: TextButton.icon(
                onPressed: state.busyPackage != null
                    ? null
                    : () => vm.updatePackages(),
                icon: Icon(LucideIcons.refreshCw, size: 14, color: colors.accent),
                label: Text(
                  'Update all',
                  style: TextStyle(color: colors.accent, fontSize: 12),
                ),
              ),
            ),
            if (state.packages.isEmpty)
              const _EmptyRow(
                icon: LucideIcons.package,
                text: 'No packages installed on this Pi.',
              )
            else
              ...state.packages.map(
                (p) => _PackageTile(
                  package: p,
                  busy: state.busyPackage == p.source,
                  anyBusy: state.busyPackage != null,
                  onRemove: () => _confirmRemove(context, p),
                  onUpdate: () => vm.updatePackages(source: p.source),
                ),
              ),
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: OutlinedButton.icon(
                onPressed: state.busyPackage != null
                    ? null
                    : () => _promptInstall(context),
                icon: Icon(LucideIcons.plus, size: 16, color: colors.accent),
                label: Text(
                  'Install a package',
                  style: TextStyle(color: colors.accent),
                ),
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  side: BorderSide(color: colors.accent),
                ),
              ),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  /// Ask for the source + scope, then confirm the third-party install. The
  /// `confirm_third_party` flag is true only on the second, explicit accept.
  Future<void> _promptInstall(BuildContext context) async {
    final request = await showDialog<_InstallRequest>(
      context: context,
      builder: (dctx) => const _InstallDialog(),
    );
    if (request == null || !context.mounted) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: context.colors.bg,
        title: Text(
          'Install third-party code?',
          style: TextStyle(color: context.colors.text),
        ),
        content: Text(
          'The machine will download and run:\n\n${request.source}\n\n'
          'Packages can execute extension code and ship skills that instruct '
          'the model to run programs. Only continue if you trust the source.',
          style: TextStyle(color: context.colors.muted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dctx).pop(false),
            child: Text('Cancel', style: TextStyle(color: context.colors.muted)),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: context.colors.accent,
              foregroundColor: context.colors.onAccent,
            ),
            child: const Text('Install'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await vm.installPackage(
      source: request.source,
      scope: request.scope,
      confirmThirdParty: true,
    );
  }

  Future<void> _confirmRemove(BuildContext context, WirePackage p) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: context.colors.bg,
        title: Text('Remove package?', style: TextStyle(color: context.colors.text)),
        content: Text(
          p.source,
          style: TextStyle(color: context.colors.muted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dctx).pop(false),
            child: Text('Cancel', style: TextStyle(color: context.colors.muted)),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: context.colors.error,
              foregroundColor: context.colors.onAccent,
            ),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await vm.removePackage(p.source, scope: p.scope);
  }
}

/// The runtime line: whether the Pi is live and what it is running.
class _RuntimeHeader extends StatelessWidget {
  const _RuntimeHeader({required this.runtime});
  final PiSurfaceRuntime runtime;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    // `running` unknown fields are shown as "unknown" — never a guessed value.
    final model = runtime.model ?? 'unknown model';
    final thinking = runtime.thinking?.wire ?? 'unknown thinking';
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(
            runtime.running ? LucideIcons.circleCheck : LucideIcons.circleDashed,
            size: 16,
            color: runtime.running ? colors.accent : colors.muted,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              runtime.running ? 'Running · $model · $thinking' : 'Not running',
              style: TextStyle(color: colors.muted, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

class _OpBanner extends StatelessWidget {
  const _OpBanner({required this.op});
  final PackageOpOk op;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        switch (op.op) {
          PackageOp.install => 'Installed ${op.source}',
          PackageOp.remove => 'Removed ${op.source}',
          PackageOp.update => op.source.isEmpty
              ? 'Updated all packages'
              : 'Updated ${op.source}',
        },
        style: TextStyle(color: colors.accent, fontSize: 12),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, this.trailing});
  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title.toUpperCase(),
              style: TextStyle(
                color: colors.muted,
                fontSize: 11,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.6,
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

class _EmptyRow extends StatelessWidget {
  const _EmptyRow({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Row(
        children: [
          Icon(icon, size: 16, color: colors.muted),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: colors.muted, fontSize: 13)),
          ),
        ],
      ),
    );
  }
}

/// Human label + colour for a skill's provenance.
String _sourceLabel(SkillSource s) => switch (s) {
  SkillSource.user => 'user',
  SkillSource.project => 'project',
  SkillSource.package => 'package',
};

class _SkillTile extends StatelessWidget {
  const _SkillTile({
    required this.skill,
    required this.busy,
    required this.anyBusy,
    required this.onToggle,
    required this.onInvoke,
  });

  final WireSkill skill;
  final bool busy;
  final bool anyBusy;
  final ValueChanged<bool> onToggle;
  final ValueChanged<String?> onInvoke;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    // `enabled == null` means the host could not determine it — show it as
    // unknown rather than pretending the skill is on.
    final enabled = skill.enabled;
    return ListTile(
      leading: Icon(
        skill.source == SkillSource.package
            ? LucideIcons.package
            : LucideIcons.sparkles,
        color: colors.muted,
        size: 18,
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              skill.name,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.text),
            ),
          ),
          const SizedBox(width: 8),
          _Chip(text: _sourceLabel(skill.source)),
          if (skill.disableModelInvocation) ...[
            const SizedBox(width: 4),
            const _Chip(text: 'manual'),
          ],
        ],
      ),
      subtitle: Text(
        skill.description.isEmpty ? skill.path : skill.description,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: colors.muted, fontSize: 12),
      ),
      trailing: busy
          ? SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: colors.accent),
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: 'Run',
                  onPressed: anyBusy ? null : () => _promptInvoke(context),
                  icon: Icon(LucideIcons.play, size: 18, color: colors.accent),
                ),
                Switch(
                  value: enabled ?? true,
                  // A package skill ships with its package and cannot be
                  // toggled; also disable while unknown or another row is busy.
                  onChanged: anyBusy || skill.source == SkillSource.package || enabled == null
                      ? null
                      : onToggle,
                  activeThumbColor: colors.accent,
                ),
              ],
            ),
    );
  }

  Future<void> _promptInvoke(BuildContext context) async {
    final controller = TextEditingController();
    final args = await showDialog<String>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: context.colors.bg,
        title: Text('Run ${skill.name}', style: TextStyle(color: context.colors.text)),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Arguments (optional)'),
          style: TextStyle(color: context.colors.text),
          onSubmitted: (v) => Navigator.of(dctx).pop(v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dctx).pop(),
            child: Text('Cancel', style: TextStyle(color: context.colors.muted)),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dctx).pop(controller.text),
            style: FilledButton.styleFrom(
              backgroundColor: context.colors.accent,
              foregroundColor: context.colors.onAccent,
            ),
            child: const Text('Run'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (args == null) return;
    onInvoke(args.trim().isEmpty ? null : args.trim());
  }
}

class _PackageTile extends StatelessWidget {
  const _PackageTile({
    required this.package,
    required this.busy,
    required this.anyBusy,
    required this.onRemove,
    required this.onUpdate,
  });

  final WirePackage package;
  final bool busy;
  final bool anyBusy;
  final VoidCallback onRemove;
  final VoidCallback onUpdate;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final scope = package.scope == PackageScope.project ? 'project' : 'user';
    return ListTile(
      leading: Icon(LucideIcons.package, color: colors.muted, size: 18),
      title: Row(
        children: [
          Flexible(
            child: Text(
              package.source,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.text),
            ),
          ),
          const SizedBox(width: 8),
          _Chip(text: scope),
        ],
      ),
      subtitle: Text(
        package.resources.isEmpty
            ? 'No resources resolved yet'
            : package.resources.join(', '),
        style: TextStyle(color: colors.muted, fontSize: 12),
      ),
      trailing: busy
          ? SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: colors.accent),
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: 'Update',
                  onPressed: anyBusy ? null : onUpdate,
                  icon: Icon(LucideIcons.refreshCw, size: 18, color: colors.muted),
                ),
                IconButton(
                  tooltip: 'Remove',
                  onPressed: anyBusy ? null : onRemove,
                  icon: Icon(LucideIcons.trash2, size: 18, color: colors.error),
                ),
              ],
            ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: colors.border),
      ),
      child: Text(
        text,
        style: TextStyle(color: colors.muted, fontSize: 10),
      ),
    );
  }
}

/// What the install dialog collects before any host call is made.
class _InstallRequest {
  final String source;
  final PackageScope scope;
  const _InstallRequest(this.source, this.scope);
}

class _InstallDialog extends StatefulWidget {
  const _InstallDialog();

  @override
  State<_InstallDialog> createState() => _InstallDialogState();
}

class _InstallDialogState extends State<_InstallDialog> {
  final _controller = TextEditingController();
  PackageScope _scope = PackageScope.user;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return AlertDialog(
      backgroundColor: colors.bg,
      title: Text('Install a package', style: TextStyle(color: colors.text)),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _controller,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'Source',
              hintText: 'npm:@example/pi-tools@1.0.0',
            ),
            style: TextStyle(color: colors.text),
          ),
          const SizedBox(height: 12),
          SegmentedButton<PackageScope>(
            segments: const [
              ButtonSegment(value: PackageScope.user, label: Text('This user')),
              ButtonSegment(value: PackageScope.project, label: Text('This project')),
            ],
            selected: {_scope},
            onSelectionChanged: (s) => setState(() => _scope = s.first),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('Cancel', style: TextStyle(color: colors.muted)),
        ),
        FilledButton(
          onPressed: () {
            final source = _controller.text.trim();
            if (source.isEmpty) return;
            Navigator.of(context).pop(_InstallRequest(source, _scope));
          },
          style: FilledButton.styleFrom(
            backgroundColor: colors.accent,
            foregroundColor: colors.onAccent,
          ),
          child: const Text('Continue'),
        ),
      ],
    );
  }
}
