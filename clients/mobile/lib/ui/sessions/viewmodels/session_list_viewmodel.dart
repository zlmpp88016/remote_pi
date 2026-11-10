import 'dart:async';

import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:mobile/data/sync/sync_service.dart';
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
    this.sync,
  }) : super(const SessionListLoading()) {
    // ignore: discarded_futures
    reload();
  }

  final SessionCatalog _catalog;
  final ConnectionManager _conn;
  final Preferences _prefs;

  /// Paint-first open. Present in the app (see `app_router`); absent in the unit
  /// tests that only exercise this screen's own gating.
  final SyncService? sync;
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
      var starting = false;
      if (!_conn.isRoomLive(epk, roomId) && cwd != null) {
        starting = true;
        emit(const SessionListLoading(message: '正在启动工作区…'));
        try {
          final started = await _catalog.startWorkspace(cwd: cwd);
          room = started.roomId;
        } on WorkspaceControlFailure catch (e) {
          // Host down, folder gone, or the daemon refused to start (another Pi
          // owns the folder). Say so now: falling through to `listSessions()`
          // would replace a precise reason with a generic timeout.
          emit(SessionListError(_startHuman(e)));
          return;
        }
      }
      _conn.switchRoom(room);
      await _prefs.setSelectedRoom(epk: epk, roomId: room);
      // "The room is live" is NOT "the room can answer". The Pi registers its
      // room on the relay as soon as it subscribes, but the handler that
      // answers `session_list` only exists once Pi has finished booting.
      // Measured over the public frp path: the room is announced immediately and
      // the first `session_list` answer arrives ~13.7 s later, against ~100 ms
      // for a room that is warm. So the budget is a boot budget, not a liveness
      // test: keep retrying on short slices until the deadline. A warm room
      // answers on the first slice and never notices this.
      if (starting) {
        emit(const SessionListLoading(message: '等工作区就绪…'));
      }
      final ok = await _retryOnTimeout(
        () => _catalog.listSessions(timeout: const Duration(seconds: 3)),
      );
      emit(SessionListReady(sessions: ok.sessions, currentId: ok.currentId));
    } on TimeoutException {
      // Past the deadline. Prefer the host's own reason when it has one: a
      // workspace whose Pi died on spawn reports `stopped` + `last_error`, and
      // "no response" would throw that away for a generic sentence.
      final failure = cwd == null ? null : _conn.workspaceStateFor(cwd!);
      final reason = failure?.lastError;
      emit(
        SessionListError(
          reason != null && reason.isNotEmpty
              ? '这个工作区起不来：$reason'
              : '这个工作区没有响应。稍后重试，或先重启该工作区。',
        ),
      );
    } catch (e) {
      emit(SessionListError(e.toString()));
    }
  }

  /// Retries [call] on request timeout until a boot-sized deadline expires.
  ///
  /// Both calls on this screen address a room that may be mid-boot: the relay
  /// announces a room as soon as its Pi subscribes, but the command handlers
  /// only exist once Pi has finished starting. Measured over the public frp
  /// path: ~13.7 s from `workspace_start_ok` to the first `session_list`
  /// answer, against ~100 ms for a warm room. One generous timeout cannot
  /// cover that gap without also making a genuinely dead room hang for half a
  /// minute, so retry on short slices and let the deadline decide.
  Future<T> _retryOnTimeout<T>(
    Future<T> Function() call, {
    Duration deadline = const Duration(seconds: 30),
  }) async {
    final end = DateTime.now().add(deadline);
    while (true) {
      try {
        return await call();
      } on TimeoutException {
        if (DateTime.now().isAfter(end)) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
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

  /// Declare the open before the route is pushed, so the chat that mounts a
  /// moment later already knows a sync is not welcome yet. See
  /// [SyncService.markOpening].
  void markOpening(String sessionId) {
    sync?.markOpening(sessionId);
  }

  /// Returns true when the Pi switched (or was already on) that session.
  Future<bool> pick(String sessionId) async {
    final s = state;
    if (s is! SessionListReady || s.switching) return false;
    emit(s.copyWith(switching: true, openingId: sessionId));
    try {
      _conn.switchRoom(roomId);
      // Paint first, attach behind it.
      //
      // Measured over the public relay: the switch ack arrives in ~50 ms, but
      // the OLD Pi is still the one answering then (it exits ~150 ms later) and
      // the room goes deaf for the 12 s respawn. A chat built on that window
      // gets either the transcript of the session you just left, or nothing.
      // So the transcript is read from the file by id (~200 ms, independent of
      // which session the Pi is on) and the chat says "同步中…" until the
      // attach is confirmed against `session_list.current_id`.
      await _prefs.setSelectedRoom(epk: epk, roomId: roomId);
      final syncer = sync;
      if (syncer != null) {
        await syncer.openSession(sessionId, epk: epk, roomId: roomId);
      } else {
        // No writer bound (unit test): keep the legacy contract, so this
        // screen's own gating stays testable without a Hive-backed SyncService.
        await _retryOnTimeout(() => _catalog.switchSession(sessionId));
      }
      // `switching` gates every row (`ListTile(enabled: !switching)`), so
      // leaving it true after a successful switch disables the whole list
      // with no way back short of leaving the screen.
      final now = state;
      if (now is SessionListReady) {
        emit(now.copyWith(switching: false, clearOpening: true));
      }
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
