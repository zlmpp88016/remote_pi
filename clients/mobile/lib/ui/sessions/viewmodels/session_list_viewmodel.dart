import 'dart:async';

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

  /// How long the reply frame for `session_switch` is waited for.
  ///
  /// This is an ACK budget, not a boot budget, and it is deliberately left at
  /// the catalog's 12 s: a missed ack is not a failed switch (see
  /// [_switchOnce]), so there is nothing to inflate here.
  static const _switchAckTimeout = Duration(seconds: 12);

  /// True from the moment a tap becomes a `session_switch` until that switch is
  /// settled — cleared in a `finally`, so on EVERY exit path.
  ///
  /// The gate lives here, not in `SessionListReady.switching`, because the state
  /// is replaceable: [reload] re-emits a fresh `SessionListReady` whose
  /// `switching` defaults to false while a watch may still be running for up to
  /// [_switchSettleBudget], and the next tap would then put a SECOND
  /// `session_switch` on the wire — one extra Pi spawn, which is exactly the
  /// invariant this whole path exists to keep.
  bool _switchInFlight = false;

  /// Boot-level budget for the switch to actually take effect.
  ///
  /// Counted from the moment the request is sent, because the staged host only
  /// exits AFTER answering, so the respawn starts on top of the ack slice above.
  /// Worst case it has to cover: 12 s of ack slice + a full ~13.7 s cold boot of
  /// the recycled Pi (the same figure this file documents for `session_list` on
  /// the public frp lane, measured from `workspace_start_ok`) + a ~1.1 s median /
  /// 1.82 s p95 round trip per 2 s poll — about 26 s, so 90 s leaves >3x margin
  /// without failing so late that a dead workspace looks like a hang. It stays
  /// well inside the minute-scale patience a user has for one screen.
  static const _switchSettleBudget = Duration(seconds: 90);

  /// Spacing between read-only polls while watching for the switch.
  ///
  /// The public lane's round trip is ~1.1 s median / 1.82 s p95, so polling at
  /// that rate would queue requests behind a Pi that is still booting and turn
  /// the observation itself into congestion. Two seconds is the smallest gap
  /// that leaves the wire idle between polls.
  static const _switchPollInterval = Duration(seconds: 2);

  /// Per-poll budget — the same short slice [reload] uses for `session_list`.
  static const _switchPollTimeout = Duration(seconds: 3);

  Future<void> reload() async {
    // A switch in flight owns this screen's state: [pick] will report the
    // outcome and clear its own flag. Reloading here would swap the rows for a
    // spinner and re-emit a `switching: false` list the moment the listing
    // answers — i.e. hand the user a tappable list while a `session_switch` is
    // still unsettled. Only reachable from the full-screen error branch today;
    // refused anyway so it cannot become the hole the gate used to have.
    if (_switchInFlight) return;
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
  /// This is for `session_list` on this screen: it addresses a room that may be
  /// mid-boot, because the relay announces a room as soon as its Pi subscribes
  /// while the command handlers only exist once Pi has finished starting.
  /// Measured over the public frp path: ~13.7 s from `workspace_start_ok` to the
  /// first `session_list` answer, against ~100 ms for a warm room. One generous
  /// timeout cannot cover that gap without also making a genuinely dead room
  /// hang for half a minute, so retry on short slices and let the deadline
  /// decide.
  ///
  /// NOT for `session_switch`: re-sending that one makes the host exit and
  /// respawn the Pi again, so it is sent exactly once and then watched
  /// (see [_switchOnce]).
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

  /// Returns true when the Pi switched (or was already on) that session.
  Future<bool> pick(String sessionId) async {
    final s = state;
    // A failed open leaves the list itself intact (see [_failOpen]); tapping
    // again from the inline error must work, so an error that still carries the
    // rows is a valid starting point.
    final base = s is SessionListReady
        ? s
        : (s is SessionListError ? s.recoverable : null);
    if (base == null) return false;
    // One switch at a time, whatever the row. `session_switch` is not re-sendable
    // (see [_switchOnce]), so a second one while the first is in flight would be
    // a second Pi spawn for a tap the user did not mean to repeat. The
    // authoritative gate is [_switchInFlight], a field of this view model, and
    // NOT the `switching` bit of the state: that bit is what the ROWS read (they
    // are `enabled: !switching`), while the exactly-once promise has to survive
    // any state replacement (a `reload()` racing the watch). It is cleared in
    // the `finally` below — every exit path, including a throw or dispose — so it
    // can never leave the list dead; it only spans a switch that is running.
    if (_switchInFlight || base.switching) return false;
    _switchInFlight = true;
    emit(base.copyWith(
      switching: true,
      openingId: sessionId,
      clearOpenError: true,
    ));
    try {
      _conn.switchRoom(roomId);
      // `session_switch` takes the same road as `session_list`: the daemon
      // either switches in-process or stages the target and exits so the
      // supervisor can reopen it with `--session`. That exit window is routinely
      // longer than one request timeout over the public relay — but unlike a
      // listing, a switch must NEVER be repeated: every extra copy makes the
      // supervisor exit and respawn the Pi again, so retrying a slow boot is
      // exactly what turned one tap into a restart storm. Send once, then watch.
      final switched = await _switchOnce(sessionId);
      if (!switched) return false;
      await _prefs.setSelectedRoom(epk: epk, roomId: roomId);
      // The gate itself is released in the `finally` below, so this path and the
      // failure paths share one release.
      return true;
    } on SessionSwitchFailure catch (e) {
      _failOpen(_human(e));
      return false;
    } on WorkspaceControlFailure catch (e) {
      // The link is gone (see [_awaitSettled]): no amount of watching fixes that,
      // so say so now instead of at the deadline.
      _failOpen(_startHuman(e));
      return false;
    } on TimeoutException {
      // The one request went out and nothing confirmed it inside the boot-level
      // budget: the Pi is dead, refused to come back, or the room is gone.
      // Prefer the host's own reason when it has one — a workspace whose Pi
      // crashed reports `last_error`, and a generic "no response" would throw
      // that away, the same trade [reload] already refuses to make.
      final failure = cwd == null ? null : _conn.workspaceStateFor(cwd!);
      final reason = failure?.lastError;
      _failOpen(
        reason != null && reason.isNotEmpty
            ? '这个工作区起不来：$reason'
            : '这个会话没有响应。先确认机器上的 Pi 还在运行，或重启该工作区后重试。',
      );
      return false;
    } catch (e) {
      _failOpen('无法打开该会话：$e');
      return false;
    } finally {
      // ONE place, every path — a tap that threw, was refused, timed out, or
      // outlived the screen must not keep the next tap out.
      _switchInFlight = false;
      // …and neither may the `switching` bit, which is what the ROWS read. Also
      // idempotent, so the paths that already released it (and the banner they
      // set) are left untouched.
      _settleSwitch();
    }
  }

  /// Sends `session_switch` EXACTLY ONCE and waits for it to take effect.
  ///
  /// One `session_switch` is one Pi spawn. On the daemon path the host stages
  /// the target, answers `session_switch_ok`, and exits so the supervisor can
  /// reopen the Pi with `--session`; the supervisor restarts a switch exit with
  /// no backoff at all, so a re-sent request kills the Pi that is still booting
  /// and spawns another one. Measured on the public lane, one tap abandoned
  /// after its first 12 s slice and then retried churned the workspace through
  /// pid 17184 → 3740 → 12360 → 18248 → … while the supervisor's `restarts`
  /// counter stayed 0 the whole time (so that counter is not evidence of calm).
  ///
  /// Therefore the request is never repeated: a missed ack only moves this
  /// method from "wait for the reply" to "watch for the effect". While it
  /// watches, `switching` stays true, which is also what keeps a second tap
  /// from putting a second `session_switch` on the wire.
  ///
  /// The whole method is bounded by [_switchSettleBudget] counted from the
  /// send, so the gated list can never be held open longer than that.
  ///
  /// Returns false only when the screen was disposed while watching: there is
  /// nobody left to report to, so the caller must not record a switch it could
  /// not confirm.
  Future<bool> _switchOnce(String sessionId) async {
    final end = DateTime.now().add(_switchSettleBudget);
    try {
      await _catalog.switchSession(sessionId, timeout: _switchAckTimeout);
      return true;
    } on TimeoutException {
      // The frame is on the wire — the ack just missed its slice. Whether the
      // host is mid-recycle or the frame never landed is NOT observable from
      // here, and the two answers differ by a whole extra Pi spawn, so the
      // cheaper one wins: read the host's state instead of asking it to switch
      // again. A frame that really was lost ends as the banner below, which the
      // user can retry deliberately.
      return _awaitSettled(sessionId, end);
    }
  }

  /// Read-only watch for [sessionId] becoming the current session.
  ///
  /// Asks `session_list` — the same reply [reload] already parses — and compares
  /// `current_id`, which the host publishes only when the id it is running is
  /// actually in that listing. Nothing here mutates host state, so polling can
  /// never cost a spawn.
  ///
  /// Throws [TimeoutException] when [end] passes, so the caller keeps the
  /// existing `_failOpen` banner path and the list itself survives. Returns
  /// false when the view model was disposed first — the watch is abandoned with
  /// no claim either way.
  ///
  /// A late `session_switch_error` (typed refusals such as `locked`) that lands
  /// after the ack budget cannot be observed through this channel; the banner
  /// then carries the host's `last_error` when there is one, or the generic
  /// sentence, and the rows stay tappable for another attempt.
  Future<bool> _awaitSettled(String sessionId, DateTime end) async {
    while (DateTime.now().isBefore(end)) {
      // The screen that asked is gone: `emit` is already a no-op, so there is
      // nobody to report to and no reason to keep spending the wire on it.
      if (isDisposed) return false;
      await Future<void>.delayed(_switchPollInterval);
      try {
        final ok = await _catalog.listSessions(timeout: _switchPollTimeout);
        if (ok.currentId == sessionId) return true;
      } on TimeoutException {
        // A Pi that is still booting has no handler for `session_list` yet, so
        // silence is the expected state during a recycle — poll again.
        continue;
      } on WorkspaceControlFailure {
        // NOT the mid-recycle case, which is silence ([TimeoutException]): the
        // catalog throws this BEFORE anything reaches the wire, when there is no
        // channel at all (see `SessionCatalog._expect`). A link that is not
        // there cannot turn into a switch, so watching it only keeps every row
        // disabled for the whole budget before the banner appears — the old,
        // correct failure took the ack slice. Fail fast instead.
        rethrow;
      }
    }
    if (isDisposed) return false;
    throw TimeoutException(
      'session_switch was sent once and never became current',
    );
  }

  /// A tap that failed must not erase the list.
  ///
  /// The screen used to swap `SessionListReady` for a full-screen
  /// `SessionListError`, which removed every row: after one refused switch
  /// there was nothing left to tap and the screen could only be abandoned. The
  /// error now rides on top of the rows as a banner, and the gate is released so
  /// the next tap goes through.
  void _failOpen(String message) {
    final now = state;
    final base = now is SessionListReady ? now : null;
    if (base == null) {
      emit(SessionListError(message));
      return;
    }
    emit(
      base.copyWith(
        switching: false,
        clearOpening: true,
        openError: message,
      ),
    );
  }

  /// Clear the per-row spinner and the list-wide gate on EVERY exit path.
  ///
  /// `switching` gates every row (`ListTile(enabled: !switching)`), so leaving
  /// it true after a failure disabled the whole list with no way back short of
  /// leaving the screen — the guard at the top of [pick] then dropped every
  /// later tap. Idempotent, so it can be the single release in `pick`'s
  /// `finally` without stamping over the banner [_failOpen] just set.
  void _settleSwitch() {
    final now = state;
    if (now is SessionListReady && (now.switching || now.openingId != null)) {
      emit(now.copyWith(switching: false, clearOpening: true));
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
