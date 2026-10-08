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
    );
  }

  /// Plan/69 — restart a workspace by cwd. Idempotent host-side: a
  /// workspace that is already `running` answers `workspace_restart_ok`
  /// without respawning. Errors are typed (`spawn_failed`, `not_found`).
  /// The lifecycle push (`workspace_state`) that follows is surfaced by
  /// [ConnectionManager.workspaceStatesStream].
  Future<WorkspaceRestartOk> restartWorkspace(String cwd) {
    return _expect<WorkspaceRestartOk>(
      WorkspaceRestart(id: uuid7(), cwd: cwd),
      (id, msg) {
        if (msg is WorkspaceRestartError && msg.inReplyTo == id) {
          throw WorkspaceControlFailure(msg.code);
        }
        return msg is WorkspaceRestartOk && msg.inReplyTo == id;
      },
    );
  }

  /// Plan/68 — list one directory on the host so the user can pick a cwd by
  /// walking the machine's tree. Errors come back typed (`not_found`,
  /// `not_a_directory`, `permission_denied`) via [WorkspaceControlFailure].
  Future<FsListOk> listDirectory(String path, {bool showHidden = false}) {
    return _expect<FsListOk>(
      FsList(id: uuid7(), path: path, showHidden: showHidden),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'fs_list') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is FsListOk && msg.inReplyTo == id;
      },
    );
  }

  /// Plan/68 — persist a workspace the user added from the picker.
  Future<void> addWorkspace(String path) {
    return _expectAction(
      WorkspaceAdd(id: uuid7(), path: path),
      'workspace_add',
    );
  }

  /// Plan/68 — drop an added workspace (never a registered daemon).
  Future<void> removeWorkspace(String path) {
    return _expectAction(
      WorkspaceRemove(id: uuid7(), path: path),
      'workspace_remove',
    );
  }

  /// Expects the plain `action_ok` / `action_error` pair for [action].
  ///
  /// Plan/69 — no room override: the host control plane (`workspace_*`,
  /// `fs_list`, `host_hello`, `workspace_restart`) is addressed to room
  /// `host` by the transport itself (see `host_proxy.dart` — those types
  /// are host-direct), so switching the connection's active room here
  /// would only disturb the chat's child room for no benefit.
  Future<void> _expectAction(ClientMessage request, String action) {
    return _expect<ActionOk>(request, (id, msg) {
      if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == action) {
        throw WorkspaceControlFailure(msg.error);
      }
      return msg is ActionOk && msg.inReplyTo == id && msg.rawAction == action;
    });
  }

  // ── Plan/68 — Pi surface (skills + packages) ──────────────────────────────
  //
  // Unlike the workspace ops above, these are handled by the paired Pi itself
  // (`pi-extension/src/index.ts`), so they go on the ACTIVE room (the workspace
  // session the app is talking to) — no room override.

  /// Ask the machine for its runtime + installed skills and packages.
  Future<PiSurfaceOk> piSurface() {
    return _expect<PiSurfaceOk>(
      PiSurface(id: uuid7()),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id) {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is PiSurfaceOk && msg.inReplyTo == id;
      },
    );
  }

  /// Force a skill; the output flows through the normal chat channels.
  Future<SkillInvokeOk> invokeSkill(String name, {String? args}) {
    return _expect<SkillInvokeOk>(
      SkillInvoke(id: uuid7(), name: name, args: args),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'skill_invoke') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is SkillInvokeOk && msg.inReplyTo == id;
      },
    );
  }

  Future<SkillSetEnabledOk> setSkillEnabled(String name, bool enabled) {
    return _expect<SkillSetEnabledOk>(
      SkillSetEnabled(id: uuid7(), name: name, enabled: enabled),
      (id, msg) {
        if (msg is ActionError &&
            msg.inReplyTo == id &&
            msg.rawAction == 'skill_set_enabled') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is SkillSetEnabledOk && msg.inReplyTo == id;
      },
    );
  }

  /// Install a package. [confirmThirdParty] must be true — the extension
  /// refuses without it, and the UI only sets it after an explicit accept.
  Future<PackageOpOk> installPackage({
    required String source,
    required PackageScope scope,
    required bool confirmThirdParty,
  }) {
    return _packageOp(
      PackageInstall(
        id: uuid7(),
        source: source,
        scope: scope,
        confirmThirdParty: confirmThirdParty,
      ),
      'package_install',
    );
  }

  Future<PackageOpOk> removePackage(String source, {PackageScope? scope}) {
    return _packageOp(
      PackageRemove(id: uuid7(), source: source, scope: scope),
      'package_remove',
    );
  }

  /// Reconcile one package, or every installed one when [source] is omitted.
  Future<PackageOpOk> updatePackages({String? source}) {
    return _packageOp(
      PackageUpdate(id: uuid7(), source: source),
      'package_update',
    );
  }

  Future<PackageOpOk> _packageOp(ClientMessage request, String action) {
    return _expect<PackageOpOk>(request, (id, msg) {
      if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == action) {
        throw WorkspaceControlFailure(msg.error);
      }
      return msg is PackageOpOk && msg.inReplyTo == id;
    });
  }

  Future<T> _expect<T extends ServerMessage>(
    ClientMessage request,
    bool Function(String id, ServerMessage msg) match,
  ) async {
    final ch = _conn.channel;
    if (ch == null) {
      throw const WorkspaceControlFailure('offline');
    }
    final id = (request.toJson()['id'] as String?) ?? '';
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
