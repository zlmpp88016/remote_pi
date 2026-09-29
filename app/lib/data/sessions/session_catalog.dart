import 'dart:async';

import 'package:app/data/transport/connection_manager.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/protocol/uuid7.dart';

/// Plan/67 — request/reply helper over the active [IChannel].
class SessionCatalog {
  SessionCatalog(this._conn);
  final ConnectionManager _conn;

  static const _timeout = Duration(seconds: 12);

  Future<SessionListOk> listSessions() {
    return _expect<SessionListOk>(
      SessionList(id: uuid7()),
      (id, msg) => msg is SessionListOk && msg.inReplyTo == id,
    );
  }

  Future<SessionSwitchOk> switchSession(String sessionId) {
    return _expect<SessionSwitchOk>(
      SessionSwitch(id: uuid7(), sessionId: sessionId),
      (id, msg) {
        if (msg is SessionSwitchError && msg.inReplyTo == id) {
          throw SessionSwitchFailure(msg.code, msg.message);
        }
        return msg is SessionSwitchOk && msg.inReplyTo == id;
      },
    );
  }

  Future<WorkspaceListOk> listWorkspaces() {
    return _expect<WorkspaceListOk>(
      WorkspaceList(id: uuid7()),
      (id, msg) => msg is WorkspaceListOk && msg.inReplyTo == id,
      room: kHostRoomId,
    );
  }

  Future<WorkspaceStartOk> startWorkspace({String? cwd, String? daemonId}) {
    return _expect<WorkspaceStartOk>(
      WorkspaceStart(id: uuid7(), cwd: cwd, daemonId: daemonId),
      (id, msg) {
        if (msg is ActionError &&
            msg.inReplyTo == id &&
            msg.rawAction == 'workspace_start') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is WorkspaceStartOk && msg.inReplyTo == id;
      },
      room: kHostRoomId,
    );
  }

  Future<T> _expect<T extends ServerMessage>(
    ClientMessage request,
    bool Function(String id, ServerMessage msg) match, {
    String? room,
  }) async {
    final ch = _conn.channel;
    if (ch == null) {
      throw const WorkspaceControlFailure('offline');
    }
    final id = (request.toJson()['id'] as String?) ?? '';
    if (room != null) _conn.switchRoom(room);
    final done = Completer<T>();
    late final StreamSubscription sub;
    sub = ch.serverMessages.listen((msg) {
      try {
        if (!match(id, msg)) return;
        if (!done.isCompleted) done.complete(msg as T);
      } catch (e, st) {
        if (!done.isCompleted) done.completeError(e, st);
      }
    });
    try {
      await ch.send(request);
      return await done.future.timeout(_timeout);
    } finally {
      await sub.cancel();
    }
  }
}

class SessionSwitchFailure implements Exception {
  final SessionSwitchErrorCode code;
  final String message;
  const SessionSwitchFailure(this.code, this.message);
  @override
  String toString() => 'SessionSwitchFailure($code: $message)';
}

class WorkspaceControlFailure implements Exception {
  final String message;
  const WorkspaceControlFailure(this.message);
  @override
  String toString() => 'WorkspaceControlFailure($message)';
}
