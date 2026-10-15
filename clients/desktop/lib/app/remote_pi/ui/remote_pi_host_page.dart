import 'package:cockpit/app/core/ui/themes/themes.dart';
import 'package:cockpit/app/core/ui/widgets/app_tooltip.dart';
import 'package:cockpit/app/core/ui/widgets/hover_tap.dart';
import 'package:cockpit/app/core/ui/widgets/window_controls.dart';
import 'package:cockpit/app/remote_pi/domain/entities/host_protocol.dart';
import 'package:cockpit/app/remote_pi/ui/host_error_message.dart';
import 'package:cockpit/app/remote_pi/ui/viewmodels/remote_pi_host_viewmodel.dart';
import 'package:cockpit/i18n/strings.g.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:shadcn_flutter/shadcn_flutter.dart';

/// Superfície Remote Pi (plano 69 W3) — o Cockpit como cliente do host.
///
/// Um modo de conexão por **pareamento** (colagem da URI `remotepi://pair?…`)
/// que fala o protocolo do room `host`: lista workspaces, navega o filesystem
/// do host, inicia Pi em cwd arbitrário, mostra o ciclo de vida (push do
/// supervisor) com restart por 1 toque, e conversa via proxy
/// `host_forward`/`host_message`. Paridade pc/web do plano 69.
class RemotePiHostPage extends StatefulWidget {
  const RemotePiHostPage({super.key});

  @override
  State<RemotePiHostPage> createState() => _RemotePiHostPageState();
}

class _RemotePiHostPageState extends State<RemotePiHostPage> {
  final _relayController = TextEditingController();
  final _codeController = TextEditingController();
  final _composerController = TextEditingController();

  RemotePiHostViewModel get _vm => context.read<RemotePiHostViewModel>();

  @override
  void dispose() {
    _relayController.dispose();
    _codeController.dispose();
    _composerController.dispose();
    super.dispose();
  }

  void _connect() {
    final relay = _relayController.text.trim();
    final code = _codeController.text.trim();
    if (relay.isEmpty || code.isEmpty) return;
    _vm.connectWithCode(relayUrl: relay, code: code);
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<RemotePiHostViewModel>();
    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.bg,
      child: Column(
        children: [
          WindowTitleBar(
            children: [
              const WindowControls(),
              const SizedBox(width: 14),
              AppTooltip(
                message: context.t.remotePiHost.header.back,
                child: HoverTap(
                  borderRadius: BorderRadius.circular(6),
                  onTap: () => context.pop(),
                  child: SizedBox(
                    width: 30,
                    height: 30,
                    child: Icon(Icons.arrow_back, size: 18, color: colors.text2),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                context.t.remotePiHost.header.title,
                style: context.typo.title.copyWith(
                  fontSize: 14,
                  color: colors.text,
                ),
              ),
              const Spacer(),
              const WindowControlsTrailing(),
            ],
          ),
          Expanded(
            child: vm.connected
                ? _ConnectedBody(vm: vm, composer: _composerController)
                : _ConnectForm(
                    vm: vm,
                    relayController: _relayController,
                    codeController: _codeController,
                    onSubmit: _connect,
                  ),
          ),
        ],
      ),
    );
  }
}

// ── formulário de pareamento ────────────────────────────────────────────────

class _ConnectForm extends StatelessWidget {
  const _ConnectForm({
    required this.vm,
    required this.relayController,
    required this.codeController,
    required this.onSubmit,
  });

  final RemotePiHostViewModel vm;
  final TextEditingController relayController;
  final TextEditingController codeController;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.connect;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(28, 32, 28, 40),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                tr.title,
                style: context.typo.title.copyWith(
                  fontSize: 17,
                  color: colors.text,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                tr.subtitle,
                style: context.typo.body.copyWith(
                  fontSize: 13,
                  color: colors.text2,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 22),
              TextField(
                controller: relayController,
                placeholder: Text(tr.relayPlaceholder),
                onSubmitted: (_) => onSubmit(),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: codeController,
                placeholder: Text(tr.codePlaceholder),
                maxLines: 3,
                onSubmitted: (_) => onSubmit(),
              ),
              if (vm.error case final error?) ...[
                const SizedBox(height: 12),
                Text(
                  hostErrorMessage(context, error),
                  style: context.typo.label.copyWith(
                    fontSize: 12,
                    color: colors.error,
                  ),
                ),
              ],
              const SizedBox(height: 18),
              Align(
                alignment: Alignment.centerLeft,
                child: PrimaryButton(
                  onPressed: vm.busy ? null : onSubmit,
                  child: Text(vm.busy ? tr.connecting : tr.submit),
                ),
              ),
              const SizedBox(height: 18),
              Text(
                tr.hint,
                style: context.typo.label.copyWith(
                  fontSize: 11.5,
                  color: colors.text3,
                  height: 1.5,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── superfície conectada ────────────────────────────────────────────────────

class _ConnectedBody extends StatelessWidget {
  const _ConnectedBody({required this.vm, required this.composer});

  final RemotePiHostViewModel vm;
  final TextEditingController composer;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final hello = vm.hello;
    final narrow = MediaQuery.sizeOf(context).width < 900;
    final workspaces = _WorkspaceList(vm: vm);
    final detail = _WorkspaceDetail(vm: vm, composer: composer);

    final body = narrow
        ? Column(
            children: [
              SizedBox(height: 260, child: workspaces),
              Divider(color: colors.border),
              Expanded(child: detail),
            ],
          )
        : Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(width: 320, child: workspaces),
              Container(width: 1, color: colors.border),
              Expanded(child: detail),
            ],
          );

    return Column(
      children: [
        _DaemonBar(vm: vm),
        if (vm.error case final error?)
          Container(
            width: double.infinity,
            color: colors.error.withValues(alpha: 0.12),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    hostErrorMessage(context, error),
                    style: context.typo.label.copyWith(
                      fontSize: 12,
                      color: colors.error,
                    ),
                  ),
                ),
                HoverTap(
                  borderRadius: BorderRadius.circular(6),
                  onTap: vm.clearError,
                  child: SizedBox(
                    width: 26,
                    height: 26,
                    child: Icon(Icons.close, size: 14, color: colors.text3),
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          child: hello == null && vm.busy
              ? const Center(child: CircularProgressIndicator())
              : body,
        ),
      ],
    );
  }
}

/// Barra do daemon: versão/hostname/plataforma reais (host_hello_ok) + ações.
class _DaemonBar extends StatelessWidget {
  const _DaemonBar({required this.vm});

  final RemotePiHostViewModel vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.daemon;
    final hello = vm.hello;
    final daemon = hello?.daemon;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.border)),
      ),
      child: Row(
        children: [
          Icon(Icons.dns_outlined, size: 16, color: colors.online),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              daemon == null
                  ? tr.unknown
                  : '${daemon.hostname ?? tr.unknown} · ${daemon.platform ?? '?'} · v${daemon.version ?? '?'}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.typo.label.copyWith(
                fontSize: 12,
                color: colors.text2,
              ),
            ),
          ),
          if (hello != null) ...[
            for (final capability in hello.capabilities) ...[
              const SizedBox(width: 6),
              _CapabilityChip(label: capability),
            ],
            const SizedBox(width: 10),
          ],
          OutlineButton(
            size: ButtonSize.small,
            onPressed: vm.busy ? null : vm.refreshWorkspaces,
            child: Text(context.t.remotePiHost.actions.refresh),
          ),
          const SizedBox(width: 8),
          OutlineButton(
            size: ButtonSize.small,
            onPressed: vm.disconnect,
            child: Text(context.t.remotePiHost.actions.disconnect),
          ),
        ],
      ),
    );
  }
}

class _CapabilityChip extends StatelessWidget {
  const _CapabilityChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: colors.panel3,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        style: context.typo.label.copyWith(fontSize: 10, color: colors.text3),
      ),
    );
  }
}

// ── lista de workspaces ─────────────────────────────────────────────────────

class _WorkspaceList extends StatelessWidget {
  const _WorkspaceList({required this.vm});

  final RemotePiHostViewModel vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.workspaces;
    final workspaces = vm.workspaces;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
          child: Text(
            tr.title,
            style: context.typo.label.copyWith(fontSize: 11, color: colors.text3),
          ),
        ),
        Expanded(
          child: workspaces.isEmpty
              ? Center(
                  child: Text(
                    tr.empty,
                    style: context.typo.body.copyWith(color: colors.text3),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 16),
                  itemCount: workspaces.length,
                  itemBuilder: (context, index) =>
                      _WorkspaceCard(vm: vm, workspace: workspaces[index]),
                ),
        ),
      ],
    );
  }
}

class _WorkspaceCard extends StatelessWidget {
  const _WorkspaceCard({required this.vm, required this.workspace});

  final RemotePiHostViewModel vm;
  final WorkspaceInfo workspace;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.workspaceState;
    final selected = vm.selectedWorkspace?.cwd == workspace.cwd;
    final runtime = vm.runtimeStateOf(workspace);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: HoverTap(
        borderRadius: BorderRadius.circular(8),
        onTap: () => vm.selectWorkspace(workspace),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: selected ? colors.panel3 : colors.bg,
            border: Border.all(
              color: selected ? colors.border : colors.border,
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: switch (runtime.state) {
                        WorkspaceState.running => colors.online,
                        WorkspaceState.starting => colors.text3,
                        WorkspaceState.crashed => colors.error,
                        WorkspaceState.stopped => colors.text4,
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      workspace.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.typo.label.copyWith(
                        fontSize: 12.5,
                        color: colors.text,
                      ),
                    ),
                  ),
                  Text(
                    workspaceStateLabel(context, runtime.state),
                    style: context.typo.label.copyWith(
                      fontSize: 10,
                      color: runtime.state == WorkspaceState.crashed
                          ? colors.error
                          : colors.text3,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                workspace.cwd,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.typo.mono.copyWith(
                  fontSize: 10.5,
                  color: colors.text3,
                ),
              ),
              if (runtime.state == WorkspaceState.crashed) ...[
                const SizedBox(height: 4),
                Text(
                  runtime.lastError ?? tr.crashedNoError,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.typo.label.copyWith(
                    fontSize: 10.5,
                    color: colors.error,
                  ),
                ),
              ],
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlineButton(
                  size: ButtonSize.small,
                  onPressed: vm.busy ? null : () => vm.restartWorkspace(workspace.cwd),
                  child: Text(
                    '${context.t.remotePiHost.actions.restart}${runtime.restarts > 0 ? ' · ${runtime.restarts}' : ''}',
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── detalhe: fs + chat ──────────────────────────────────────────────────────

class _WorkspaceDetail extends StatelessWidget {
  const _WorkspaceDetail({required this.vm, required this.composer});

  final RemotePiHostViewModel vm;
  final TextEditingController composer;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost;
    final selected = vm.selectedWorkspace;
    if (selected == null) {
      return Center(
        child: Text(
          tr.detail.selectWorkspace,
          style: context.typo.body.copyWith(color: colors.text3),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FsBrowser(vm: vm),
        Container(height: 1, color: colors.border),
        Expanded(child: _Chat(vm: vm, workspace: selected, composer: composer)),
      ],
    );
  }
}

class _FsBrowser extends StatelessWidget {
  const _FsBrowser({required this.vm});

  final RemotePiHostViewModel vm;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.fs;
    final listing = vm.fsListing;
    return SizedBox(
      height: 240,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
            child: Row(
              children: [
                Text(
                  tr.title,
                  style: context.typo.label.copyWith(
                    fontSize: 11,
                    color: colors.text3,
                  ),
                ),
                const Spacer(),
                OutlineButton(
                  size: ButtonSize.small,
                  onPressed: vm.busy ? null : () => vm.browseFs('~'),
                  child: Text(tr.home),
                ),
                const SizedBox(width: 6),
                OutlineButton(
                  size: ButtonSize.small,
                  onPressed: vm.busy || listing == null || listing.parent == null
                      ? null
                      : () => vm.browseFs(listing.parent!),
                  child: Text(tr.up),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              listing?.path ?? tr.emptyPath,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.typo.mono.copyWith(fontSize: 11, color: colors.text2),
            ),
          ),
          const SizedBox(height: 6),
          if (vm.fsLoading)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (listing == null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Builder(
                builder: (context) {
                  final fsError = vm.fsError;
                  return Text(
                    fsError == null
                        ? tr.emptyPath
                        : hostErrorMessage(context, fsError),
                    style: context.typo.label.copyWith(
                      fontSize: 11.5,
                      color: fsError == null ? colors.text3 : colors.error,
                    ),
                  );
                },
              ),
            )
          else
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 12),
                itemCount: listing.entries.length,
                itemBuilder: (context, index) => _FsEntryRow(
                  vm: vm,
                  entry: listing.entries[index],
                  parentPath: listing.path,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _FsEntryRow extends StatelessWidget {
  const _FsEntryRow({
    required this.vm,
    required this.entry,
    required this.parentPath,
  });

  final RemotePiHostViewModel vm;
  final FsEntry entry;

  /// Caminho resolvido do diretório listado — o cliente compõe
  /// `parent/name` (o host resolve e devolve o realpath no reply).
  final String parentPath;

  String get _childPath => '$parentPath/${entry.name}';

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.fs;
    final isDir = entry.kind == FsEntryKind.dir;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: HoverTap(
        borderRadius: BorderRadius.circular(6),
        onTap: isDir ? () => vm.browseFs(_childPath) : null,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: [
              Icon(
                isDir ? Icons.folder_outlined : Icons.insert_drive_file_outlined,
                size: 15,
                color: isDir ? colors.text2 : colors.text4,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  entry.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.typo.label.copyWith(
                    fontSize: 12,
                    color: isDir ? colors.text : colors.text3,
                  ),
                ),
              ),
              if (entry.isRepo == true) ...[
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.panel3,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    tr.repoBadge,
                    style: context.typo.label.copyWith(
                      fontSize: 9.5,
                      color: colors.text3,
                    ),
                  ),
                ),
              ],
              if (isDir) ...[
                const SizedBox(width: 8),
                OutlineButton(
                  size: ButtonSize.small,
                  onPressed: vm.busy ? null : () => vm.addAndStartWorkspace(_childPath),
                  child: Text(tr.startHere),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Chat extends StatelessWidget {
  const _Chat({required this.vm, required this.workspace, required this.composer});

  final RemotePiHostViewModel vm;
  final WorkspaceInfo workspace;
  final TextEditingController composer;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tr = context.t.remotePiHost.chat;
    final entries = vm.chatFor(workspace);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
          child: Text(
            '${tr.title} · ${workspace.name}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.typo.label.copyWith(fontSize: 11, color: colors.text3),
          ),
        ),
        Expanded(
          child: entries.isEmpty
              ? Center(
                  child: Text(
                    tr.empty,
                    style: context.typo.body.copyWith(color: colors.text3),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                  itemCount: entries.length,
                  itemBuilder: (context, index) =>
                      _ChatBubble(entry: entries[index]),
                ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: colors.border)),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: composer,
                  placeholder: Text(tr.placeholder),
                  onSubmitted: (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              PrimaryButton(
                onPressed: vm.busy ? null : _send,
                child: Text(tr.send),
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _send() {
    final text = composer.text;
    if (text.trim().isEmpty) return;
    vm.sendChat(text);
    composer.clear();
  }
}

class _ChatBubble extends StatelessWidget {
  const _ChatBubble({required this.entry});

  final ChatEntry entry;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fromUser = entry.fromUser;
    return Align(
      alignment: fromUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        constraints: const BoxConstraints(maxWidth: 560),
        decoration: BoxDecoration(
          color: fromUser ? colors.panel3 : colors.bg,
          border: Border.all(color: colors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          entry.text,
          style: context.typo.body.copyWith(
            fontSize: 12.5,
            color: colors.text,
            height: 1.4,
          ),
        ),
      ),
    );
  }
}
