import 'package:app/protocol/protocol.dart';

/// Plan/68 — state of the host-filesystem navigator used to pick a workspace.
///
/// The picker starts in the home directory and walks the **host's** tree: the
/// app never resolves a path locally, it asks the machine's `host` room for
/// `fs_list` and renders whatever comes back. The current breadcrumb holds the
/// host-resolved `realpath`, so what the user sees is always the machine's
/// canonical path.
sealed class WorkspaceBrowserState {
  const WorkspaceBrowserState();
}

class WorkspaceBrowserLoading extends WorkspaceBrowserState {
  const WorkspaceBrowserLoading();
}

class WorkspaceBrowserError extends WorkspaceBrowserState {
  final String message;
  /// The path that failed, so Retry can re-request the same directory.
  final String path;
  const WorkspaceBrowserError({required this.message, required this.path});
}

class WorkspaceBrowserReady extends WorkspaceBrowserState {
  /// Host-resolved absolute path of the listed directory.
  final String path;
  /// `null` at the filesystem root.
  final String? parent;
  final List<WireFsEntry> entries;
  final bool showHidden;
  /// `true` while an `workspace_add`/`workspace_start` is in flight.
  final bool busy;
  /// Set after a successful "use this folder": the started workspace.
  final WorkspaceStartOk? started;

  const WorkspaceBrowserReady({
    required this.path,
    required this.parent,
    required this.entries,
    this.showHidden = false,
    this.busy = false,
    this.started,
  });

  /// Navigable children (directories only) — files are shown greyed but are
  /// not targets for a workspace.
  List<WireFsEntry> get directories =>
      entries.where((e) => e.isDir).toList(growable: false);

  WorkspaceBrowserReady copyWith({
    String? path,
    String? parent,
    List<WireFsEntry>? entries,
    bool? showHidden,
    bool? busy,
    WorkspaceStartOk? started,
  }) => WorkspaceBrowserReady(
    path: path ?? this.path,
    parent: parent ?? this.parent,
    entries: entries ?? this.entries,
    showHidden: showHidden ?? this.showHidden,
    busy: busy ?? this.busy,
    started: started ?? this.started,
  );
}
