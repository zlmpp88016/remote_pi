import 'package:app/protocol/protocol.dart';

/// Plan/67 — state of the workspace (cwd) picker. The app reaches this
/// screen from Home; it queries the machine's `host` room for the
/// registered workdirs (`workspace_list`) and can start one
/// (`workspace_start`) so its room shows up as a session tile.
///
/// Plan/69 — the same rows now carry the workspace LIFECYCLE: the host
/// pushes `workspace_state` (running/starting/crashed/stopped +
/// last_error + restarts) and a crashed workspace gets a one-tap
/// `workspace_restart`.
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

/// Sentinel for nullable copyWith parameters that must distinguish
/// "keep current" (omit) from "set to null" (pass `null` explicitly).
const Object _kUnset = Object();

class WorkspaceListReady extends WorkspaceListState {
  final List<WireWorkspaceInfo> workspaces;

  /// `true` while a `workspace_start` is in flight, so the list can
  /// disable taps instead of letting the user queue several starts.
  final bool starting;

  /// Plan/69 — latest `workspace_state` push per cwd. A cwd with no entry
  /// simply has no lifecycle information yet (the host pushes on
  /// transitions only).
  final Map<String, WorkspaceState> statesByCwd;

  /// cwd with a `workspace_restart` in flight (row shows a spinner),
  /// `null` when idle.
  final String? restartingCwd;

  /// Last restart failure, kept for inline display under the row that
  /// asked for it. Cleared on the next attempt.
  final ({String cwd, String message})? restartError;

  const WorkspaceListReady({
    required this.workspaces,
    this.starting = false,
    this.statesByCwd = const {},
    this.restartingCwd,
    this.restartError,
  });

  WorkspaceListReady copyWith({
    bool? starting,
    Map<String, WorkspaceState>? statesByCwd,
    Object? restartingCwd = _kUnset,
    Object? restartError = _kUnset,
  }) => WorkspaceListReady(
    workspaces: workspaces,
    starting: starting ?? this.starting,
    statesByCwd: statesByCwd ?? this.statesByCwd,
    restartingCwd: identical(restartingCwd, _kUnset)
        ? this.restartingCwd
        : restartingCwd as String?,
    restartError: identical(restartError, _kUnset)
        ? this.restartError
        : restartError as ({String cwd, String message})?,
  );
}
