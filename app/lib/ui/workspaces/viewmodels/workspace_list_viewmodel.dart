import 'dart:async';

import 'package:app/data/sessions/session_catalog.dart';
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
class WorkspaceListViewModel extends ViewModel<WorkspaceListState> {
  WorkspaceListViewModel(this._catalog)
    : super(const WorkspaceListLoading()) {
    // ignore: discarded_futures
    reload();
  }

  final SessionCatalog _catalog;

  Future<void> reload() async {
    emit(const WorkspaceListLoading());
    try {
      final ok = await _catalog.listWorkspaces();
      emit(WorkspaceListReady(workspaces: ok.workspaces));
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

  static String _human(WorkspaceControlFailure e) =>
      WorkspaceBrowserViewModel.humanError(e.message);
}
