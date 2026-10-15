import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';
import 'package:app/ui/workspaces/states/workspace_browser_state.dart';

/// Plan/68 — navigator over the **host** filesystem to pick a workspace.
///
/// The user starts at the machine's home directory (`~`) and walks down (or up
/// via `parent`, or by typing an absolute path). "Use this folder" registers
/// the cwd (`workspace_add`, idempotent) and starts it (`workspace_start`),
/// which is the plan/68 replacement for the old "only registered daemons"
/// catalog.
///
/// The client never touches a local path: every listing is resolved and
/// returned by the host, and the breadcrumb shows the host's `realpath`.
class WorkspaceBrowserViewModel extends ViewModel<WorkspaceBrowserState> {
  WorkspaceBrowserViewModel(this._catalog, {this.initialPath = '~'})
    : super(const WorkspaceBrowserLoading()) {
    // ignore: discarded_futures
    open(initialPath);
  }

  final SessionCatalog _catalog;

  /// Where the picker opens. `~` is expanded by the host.
  final String initialPath;

  /// Lists [path] (host-resolved). A failure becomes [WorkspaceBrowserError]
  /// carrying the path so [retry] can repeat the exact request.
  Future<void> open(String path) async {
    emit(const WorkspaceBrowserLoading());
    try {
      final ok = await _catalog.listDirectory(path, showHidden: _showHidden);
      emit(
        WorkspaceBrowserReady(
          path: ok.path,
          parent: ok.parent,
          entries: ok.entries,
          showHidden: _showHidden,
        ),
      );
    } on WorkspaceControlFailure catch (e) {
      emit(WorkspaceBrowserError(message: humanError(e.message), path: path));
    } catch (e) {
      emit(WorkspaceBrowserError(message: 'Could not read the folder: $e', path: path));
    }
  }

  bool _showHidden = false;

  /// Plan/68 — paths the user already confirmed starting in this session.
  /// Starting a Pi in an arbitrary cwd means executing code there, so the
  /// first start of each new directory asks for explicit confirmation; once
  /// confirmed, repeats don't nag. In-memory on purpose: a fresh picker visit
  /// (e.g. after an app restart) confirms again.
  final Set<String> _confirmedPaths = <String>{};

  /// Whether `path` still needs the first-start confirmation.
  bool needsConfirmation(String path) => !_confirmedPaths.contains(path);

  /// Records that the user confirmed starting in `path`.
  void markConfirmed(String path) => _confirmedPaths.add(path);

  /// Re-request whatever directory the current state refers to.
  Future<void> retry() async {
    final s = state;
    final path = switch (s) {
      WorkspaceBrowserError(:final path) => path,
      WorkspaceBrowserReady(:final path) => path,
      _ => initialPath,
    };
    await open(path);
  }

  /// Toggle dotfile visibility and re-list the current directory.
  Future<void> toggleHidden() async {
    final s = state;
    if (s is! WorkspaceBrowserReady) return;
    _showHidden = !_showHidden;
    await open(s.path);
  }

  /// Plan/68 — jump to a path the user typed by hand.
  ///
  /// The input goes to the host verbatim (absolute, `~`-prefixed, or with
  /// `..`): only the host expands and validates paths, so the client stays
  /// path-agnostic. Blank input is a no-op.
  Future<void> openTyped(String input) async {
    final t = input.trim();
    if (t.isEmpty) return;
    await open(t);
  }

  /// Descend into a child directory.
  Future<void> enter(String name) async {
    final s = state;
    if (s is! WorkspaceBrowserReady) return;
    // The host joins and realpaths; sending `current/name` keeps the client
    // path-agnostic (no local separator logic beyond the host's own).
    await open(_join(s.path, name));
  }

  /// Go up to the parent (no-op at the root).
  Future<void> up() async {
    final s = state;
    if (s is! WorkspaceBrowserReady) return;
    final parent = s.parent;
    if (parent == null) return;
    await open(parent);
  }

  /// "Use this folder" — register (idempotent) then start the current cwd.
  ///
  /// Returns the started workspace so the caller can push `/sessions`; `null`
  /// on failure (surfaced through the state as an error while staying usable).
  Future<WorkspaceStartOk?> useCurrentFolder() async {
    final s = state;
    if (s is! WorkspaceBrowserReady || s.busy) return null;
    emit(s.copyWith(busy: true));
    try {
      await _catalog.addWorkspace(s.path);
      final ok = await _catalog.startWorkspace(cwd: s.path);
      emit(s.copyWith(busy: false, started: ok));
      return ok;
    } on WorkspaceControlFailure catch (e) {
      emit(WorkspaceBrowserError(message: humanError(e.message), path: s.path));
      return null;
    } catch (e) {
      emit(WorkspaceBrowserError(message: 'Could not start that folder: $e', path: s.path));
      return null;
    }
  }

  /// Plan/68 typed errors → user-facing copy. Kept here (not in the page) so
  /// both the browser and the workspace list share one mapping.
  static String humanError(String code) => switch (code) {
    'offline' => 'Not connected to that machine.',
    'not_found' => 'That folder no longer exists on the machine.',
    'not_a_directory' => 'That path is a file, not a folder.',
    'permission_denied' => 'No permission to read that folder on the machine.',
    'not_registered' =>
      'That folder is not registered on the machine. Run "remote-pi create <cwd>" there.',
    'spawn_failed' => 'The machine could not start a Pi in that folder.',
    _ => code.isEmpty ? 'Workspace request failed.' : code,
  };

  /// Joins with `/`, which the host normalizes for both POSIX and Windows
  /// (`normalizeCwd`/`realpath`). The host is the single source of path truth.
  static String _join(String base, String name) {
    if (base.endsWith('/')) return '$base$name';
    return '$base/$name';
  }
}
