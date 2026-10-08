import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';
import 'package:app/ui/workspaces/states/workspace_list_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_browser_viewmodel.dart';

/// Plan/67 — lists the workdirs registered on a machine and starts one.
///
/// Home only shows rooms the Pi has already announced, so a registered
/// workdir whose Pi isn't running (or was never opened) is invisible
/// there. This screen closes that gap: it asks the machine's `host` room
/// for `workspace_list` and can `workspace_start` an entry so it comes
/// up as a normal session tile.
///
/// The active room is NOT managed here: [SessionCatalog] addresses the
/// `host` room per request and restores the previous one itself, so
/// overlapping calls (this constructor's [reload] plus a user retry)
/// can't clobber each other's room.
///
/// Plan/69 — with [conn] the same rows also render the workspace
/// LIFECYCLE: the host pushes `workspace_state` (state / last_error /
/// restarts) and a crashed workspace gets a one-tap `workspace_restart`.
/// The parameter is optional so existing call sites (and tests) that only
/// need the picker keep working unchanged.
class WorkspaceListViewModel extends ViewModel<WorkspaceListState> {
  WorkspaceListViewModel(this._catalog, {ConnectionManager? conn})
    : _conn = conn,
      super(const WorkspaceListLoading()) {
    if (_conn != null) {
      _states = Map<String, WorkspaceState>.from(
        _conn.workspaceStatesSnapshot,
      );
      // ignore: discarded_futures
      _statesSub = _conn.workspaceStatesStream.listen(_onStates);
    }
    // ignore: discarded_futures
    reload();
  }

  final SessionCatalog _catalog;
  final ConnectionManager? _conn;
  StreamSubscription<Map<String, WorkspaceState>>? _statesSub;

  /// Latest lifecycle push per cwd (mirror of the ConnectionManager map,
  /// kept here so `reload` can re-attach it to a fresh Ready state).
  Map<String, WorkspaceState> _states = const {};

  Future<void> reload() async {
    emit(const WorkspaceListLoading());
    try {
      final ok = await _catalog.listWorkspaces();
      emit(
        WorkspaceListReady(workspaces: ok.workspaces, statesByCwd: _states),
      );
    } on WorkspaceControlFailure catch (e) {
      emit(WorkspaceListError(_human(e)));
    } catch (e) {
      emit(WorkspaceListError('Could not list workspaces: $e'));
    }
  }

  /// Starts the workspace [daemonId] (preferred) or [cwd] and returns the
  /// resulting room so the caller can open it. Returns `null` when it
  /// failed — the failure is surfaced through [state].
  Future<WorkspaceStartOk?> start({String? daemonId, String? cwd}) async {
    final s = state;
    if (s is! WorkspaceListReady || s.starting) return null;
    emit(s.copyWith(starting: true));
    try {
      final ok = await _catalog.startWorkspace(cwd: cwd, daemonId: daemonId);
      emit(s.copyWith(starting: false));
      return ok;
    } on WorkspaceControlFailure catch (e) {
      emit(WorkspaceListError(_human(e)));
      return null;
    } catch (e) {
      emit(WorkspaceListError('Could not start workspace: $e'));
      return null;
    }
  }

  /// Plan/69 — one-tap restart for a workspace (the crashed row's button).
  ///
  /// Idempotent host-side: a workspace that is already `running` answers
  /// `workspace_restart_ok` without respawning, so this is safe to call
  /// from any state. The visible flip to `running` arrives as the next
  /// `workspace_state` push ([_onStates]) — the app never fabricates it.
  ///
  /// Returns `true` when the host accepted the restart.
  Future<bool> restart(String cwd) async {
    final s = state;
    if (s is! WorkspaceListReady || s.restartingCwd != null) return false;
    emit(s.copyWith(restartingCwd: cwd, restartError: null));
    try {
      await _catalog.restartWorkspace(cwd);
      final cur = state;
      if (cur is WorkspaceListReady) {
        emit(cur.copyWith(restartingCwd: null));
      }
      return true;
    } on WorkspaceControlFailure catch (e) {
      _failRestart(cwd, _human(e));
      return false;
    } catch (e) {
      _failRestart(cwd, 'Could not restart workspace: $e');
      return false;
    }
  }

  void _failRestart(String cwd, String message) {
    final cur = state;
    if (cur is WorkspaceListReady) {
      emit(
        cur.copyWith(restartingCwd: null, restartError: (cwd: cwd, message: message)),
      );
    }
  }

  /// Plan/68 — drop a workspace the user had added by navigating the host
  /// filesystem. Registered daemons can't be removed here (that stays the
  /// machine's own `/remote-pi remove`), so the UI only offers this for
  /// `source == "added"` rows.
  Future<void> remove(String cwd) async {
    final s = state;
    if (s is! WorkspaceListReady) return;
    try {
      await _catalog.removeWorkspace(cwd);
      emit(WorkspaceListReady(workspaces: s.workspaces.where((w) => w.cwd != cwd).toList()));
    } on WorkspaceControlFailure catch (e) {
      emit(WorkspaceListError(_human(e)));
    } catch (e) {
      emit(WorkspaceListError('Could not remove workspace: $e'));
    }
  }

  void _onStates(Map<String, WorkspaceState> snapshot) {
    _states = snapshot;
    final s = state;
    if (s is! WorkspaceListReady) return;
    emit(s.copyWith(statesByCwd: snapshot));
  }

  static String _human(WorkspaceControlFailure e) =>
      WorkspaceBrowserViewModel.humanError(e.message);

  @override
  void dispose() {
    _statesSub?.cancel();
    super.dispose();
  }
}
