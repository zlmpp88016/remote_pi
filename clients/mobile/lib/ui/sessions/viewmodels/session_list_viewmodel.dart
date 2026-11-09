import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/sessions/states/session_list_state.dart';

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
      // A workspace that is not live has no room listening on it, so asking it
      // for `session_list` can only end in the 12 s request timeout. Ask the
      // host to start it instead, and adopt the room id the host answers with:
      // it derives the id from (cwd, name) and may differ from the one carried
      // in `extra` (e.g. after a rename), which would silently address a room
      // that does not exist.
      var room = roomId;
      if (!_conn.isRoomLive(epk, roomId) && cwd != null) {
        try {
          final started = await _catalog.startWorkspace(cwd: cwd);
          room = started.roomId;
        } on WorkspaceControlFailure catch (e) {
          // Host down, folder gone, or the daemon refused to start (another Pi
          // owns the folder). Say so now: falling through to `listSessions()`
          // would replace a precise reason with a generic 12 s timeout.
          emit(SessionListError(_startHuman(e)));
          return;
        }
        // The daemon needs a moment to subscribe to the relay, and the room is
        // not addressable before that — poll instead of paying a full timeout.
        for (var i = 0; i < 40 && !_conn.isRoomLive(epk, room); i += 1) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
        }
        if (!_conn.isRoomLive(epk, room)) {
          emit(SessionListError(_startHuman(const WorkspaceControlFailure('spawn_failed'))));
          return;
        }
      }
      _conn.switchRoom(room);
      await _prefs.setSelectedRoom(epk: epk, roomId: room);
      final ok = await _catalog.listSessions();
      emit(SessionListReady(sessions: ok.sessions, currentId: ok.currentId));
    } catch (e) {
      emit(SessionListError(e.toString()));
    }
  }

  /// The workspace could not be brought up, so there is nothing to list.
  static String _startHuman(WorkspaceControlFailure e) => switch (e.message) {
    'offline' => '未连接到该机器。',
    'not_found' => '该目录在机器上已不存在。',
    'not_a_directory' => '该路径是文件，不是目录。',
    'permission_denied' => '没有权限访问机器上的该目录。',
    'spawn_failed' => '主机无法在该目录启动 Pi。',
    'not_registered' => '该文件夹没有在机器上注册。',
    // The daemon refuses when another Pi already owns the folder — the same
    // sentence the workspace screen shows, because it is the same condition.
    _ when e.message.contains('owns') || e.message.contains('lock') =>
      '这个目录上已经有另一个 Pi 在运行，先停掉它。',
    _ => e.message.isEmpty ? '无法启动该工作区。' : e.message,
  };

  /// Returns true when the Pi switched (or was already on) that session.
  Future<bool> pick(String sessionId) async {
    final s = state;
    if (s is! SessionListReady || s.switching) return false;
    emit(s.copyWith(switching: true));
    try {
      _conn.switchRoom(roomId);
      await _catalog.switchSession(sessionId);
      await _prefs.setSelectedRoom(epk: epk, roomId: roomId);
      // `switching` gates every row (`ListTile(enabled: !switching)`), so
      // leaving it true after a successful switch disables the whole list
      // with no way back short of leaving the screen.
      final now = state;
      if (now is SessionListReady) emit(now.copyWith(switching: false));
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
        e.message.isEmpty ? '无法切换会话。' : e.message,
    };
  }
}
