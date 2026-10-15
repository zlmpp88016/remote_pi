import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';
import 'package:app/ui/sessions/states/session_list_state.dart';

/// Plan/67 — lists AgentSessions for the selected workspace and switches.
class SessionListViewModel extends ViewModel<SessionListState> {
  SessionListViewModel(
    this._catalog,
    this._conn,
    this._prefs, {
    required this.epk,
    required this.roomId,
    this.cwd,
  }) : super(const SessionListLoading()) {
    // ignore: discarded_futures
    reload();
  }

  final SessionCatalog _catalog;
  final ConnectionManager _conn;
  final Preferences _prefs;
  final String epk;
  final String roomId;
  final String? cwd;

  Future<void> reload() async {
    emit(const SessionListLoading());
    try {
      if (!_conn.isRoomLive(epk, roomId) && cwd != null) {
        try {
          await _catalog.startWorkspace(cwd: cwd);
        } on WorkspaceControlFailure {
          // Host down or cwd not registered — still try session_list.
        }
      }
      _conn.switchRoom(roomId);
      await _prefs.setSelectedRoom(epk: epk, roomId: roomId);
      final ok = await _catalog.listSessions();
      emit(SessionListReady(sessions: ok.sessions, currentId: ok.currentId));
    } catch (e) {
      emit(SessionListError(e.toString()));
    }
  }

  /// Returns true when the Pi switched (or was already on) that session.
  Future<bool> pick(String sessionId) async {
    final s = state;
    if (s is! SessionListReady || s.switching) return false;
    emit(s.copyWith(switching: true));
    try {
      _conn.switchRoom(roomId);
      await _catalog.switchSession(sessionId);
      await _prefs.setSelectedRoom(epk: epk, roomId: roomId);
      return true;
    } on SessionSwitchFailure catch (e) {
      emit(SessionListError(_human(e)));
      return false;
    } catch (e) {
      emit(SessionListError(e.toString()));
      return false;
    }
  }

  static String _human(SessionSwitchFailure e) {
    return switch (e.code) {
      SessionSwitchErrorCode.locked =>
        'That session is in use on the desktop. Remote Pi will not take it over.',
      SessionSwitchErrorCode.noSdk =>
        'This workspace has no command context (start a Pi or a registered daemon).',
      SessionSwitchErrorCode.unknown =>
        e.message.isEmpty ? 'Could not switch session.' : e.message,
    };
  }
}
