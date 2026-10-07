import 'package:app/protocol/protocol.dart';

/// Plan/67 — state of the workspace (cwd) picker. The app reaches this
/// screen from Home; it queries the machine's `host` room for the
/// registered workdirs (`workspace_list`) and can start one
/// (`workspace_start`) so its room shows up as a session tile.
sealed class WorkspaceListState {
  const WorkspaceListState();
}

class WorkspaceListLoading extends WorkspaceListState {
  const WorkspaceListLoading();
}

class WorkspaceListError extends WorkspaceListState {
  final String message;
  const WorkspaceListError(this.message);
}

class WorkspaceListReady extends WorkspaceListState {
  final List<WireWorkspaceInfo> workspaces;

  /// `true` while a `workspace_start` is in flight, so the list can
  /// disable taps instead of letting the user queue several starts.
  final bool starting;

  const WorkspaceListReady({
    required this.workspaces,
    this.starting = false,
  });

  WorkspaceListReady copyWith({bool? starting}) => WorkspaceListReady(
    workspaces: workspaces,
    starting: starting ?? this.starting,
  );
}
