import 'dart:async';

import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/protocol/changes.dart';
import 'package:mobile/protocol/plan.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/protocol/schedule.dart';
import 'package:mobile/protocol/models.dart';
import 'package:mobile/protocol/settings.dart';
import 'package:mobile/protocol/uuid7.dart';

/// Plan/84 — the host could not report the working tree.
///
/// Carries the CLOSED reason, not a string: the UI owns the sentence, so a host
/// prose (or an exception text with an absolute path in it) can never reach the
/// screen.
class ChangesFailure implements Exception {
  final ChangesUnavailable reason;
  const ChangesFailure(this.reason);

  @override
  String toString() => 'ChangesFailure(${reason.wire})';
}

/// Plan/84 — the host refused to read a file.
///
/// Like [ChangesFailure], carries the CLOSED reason rather than a string: the
/// refusal vocabulary is the contract, and the sentence belongs to the client.
class FsReadFailure implements Exception {
  final FsRefusal reason;
  const FsReadFailure(this.reason);

  @override
  String toString() => 'FsReadFailure(${reason.wire})';
}

/// Plan/84 — the host refused a settings read or write.
class SettingsFailure implements Exception {
  final SettingsErrorReason reason;
  const SettingsFailure(this.reason);

  @override
  String toString() => 'SettingsFailure(${reason.wire})';
}

/// Plan/84 — the host refused a models.json read or write.
class ModelsFailure implements Exception {
  final ModelsErrorReason reason;
  const ModelsFailure(this.reason);

  @override
  String toString() => 'ModelsFailure(${reason.wire})';
}

/// Plan/67 — request/reply helper over the active [IChannel].
class SessionCatalog {
  SessionCatalog(this._conn);
  final ConnectionManager _conn;

  static const _timeout = Duration(seconds: 12);

  Future<SessionListOk> listSessions({Duration? timeout}) {
    return _expect<SessionListOk>(
      SessionList(id: uuid7()),
      (id, msg) => msg is SessionListOk && msg.inReplyTo == id,
      timeout: timeout,
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

  /// Plan/84 — read ONE allowlisted text file (`fs_read`) under [root].
  ///
  /// [root] is the workspace, and it is not optional: the host uses it to confine
  /// the read to that workspace's allowlisted directories. A refusal comes back
  /// as a typed [FsRefusal], so the UI owns the sentence rather than echoing a
  /// host message that may name an absolute path.
  Future<FsReadOk> readFile({required String path, required String root}) {
    return _expect<FsReadOk>(
      FsReadRequest(id: uuid7(), path: path, root: root),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'fs_read') {
          final refusal = FsRefusal.fromWire(msg.error);
          if (refusal != null) throw FsReadFailure(refusal);
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is FsReadOk && msg.inReplyTo == id;
      },
    );
  }

  /// Plan/84 — list every scheduled task on the host.
  Future<ScheduleCatalog> listSchedules() async {
    final ok = await _expect<ScheduleListOk>(
      ScheduleListRequest(id: uuid7()),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'schedule_list') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is ScheduleListOk && msg.inReplyTo == id;
      },
    );
    return ScheduleCatalog.fromJson({
      'tasks': ok.tasks,
      'workspace_names': ok.workspaceNames,
    });
  }

  /// Plan/84 — create a scheduled task. Returns the task the HOST created, not
  /// the one we asked for: the host assigns the id and may normalize the cron.
  Future<ScheduleTask> addSchedule({
    required String daemonId,
    required String schedule,
    required String prompt,
    String? tz,
    bool skipIfBusy = false,
    bool wake = false,
    bool catchup = false,
    String? modelProvider,
    String? modelId,
    bool freshSession = false,
  }) async {
    final ok = await _expect<ScheduleAddOk>(
      ScheduleAdd(
        id: uuid7(),
        daemonId: daemonId,
        schedule: schedule,
        prompt: prompt,
        tz: tz,
        skipIfBusy: skipIfBusy,
        wake: wake,
        catchup: catchup,
        modelProvider: modelProvider,
        modelId: modelId,
        freshSession: freshSession,
      ),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'schedule_add') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is ScheduleAddOk && msg.inReplyTo == id;
      },
    );
    return ScheduleTask.fromJson(ok.task);
  }

  /// Plan/84 — delete one scheduled task.
  Future<void> removeSchedule(String jobId) {
    return _expect<ScheduleAck>(
      ScheduleRemove(id: uuid7(), jobId: jobId),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'schedule_remove') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is ScheduleAck && msg.inReplyTo == id;
      },
    );
  }

  /// Plan/84 — enable or disable one scheduled task.
  Future<void> setScheduleEnabled(String jobId, bool enabled) {
    return _expect<ScheduleAck>(
      ScheduleSetEnabled(id: uuid7(), jobId: jobId, enabled: enabled),
      (id, msg) {
        if (msg is ActionError &&
            msg.inReplyTo == id &&
            msg.rawAction == 'schedule_set_enabled') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is ScheduleAck && msg.inReplyTo == id;
      },
    );
  }

  /// Plan/84 — fire one scheduled task immediately.
  Future<void> runScheduleNow(String jobId) {
    return _expect<ScheduleAck>(
      ScheduleRunNow(id: uuid7(), jobId: jobId),
      (id, msg) {
        if (msg is ActionError &&
            msg.inReplyTo == id &&
            msg.rawAction == 'schedule_run_now') {
          throw WorkspaceControlFailure(msg.error);
        }
        return msg is ScheduleAck && msg.inReplyTo == id;
      },
    );
  }

  /// Plan/84 — read the host's models.json. Keys never ride this reply.
  Future<ModelsSnapshot> describeModels() async {
    final ok = await _expect<ModelsDescribeOk>(
      ModelsDescribeRequest(id: uuid7()),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'models_describe') {
          final reason = ModelsErrorReason.fromWire(msg.error);
          throw ModelsFailure(reason ?? ModelsErrorReason.invalid);
        }
        return msg is ModelsDescribeOk && msg.inReplyTo == id;
      },
    );
    return ModelsSnapshot.fromJson(ok.body);
  }

  /// Plan/84 — write models.json via path-addressed ops.
  ///
  /// [revision] is the sha256 from the describe that preceded this edit; the host
  /// refuses a stale one.
  Future<String> mutateModels({
    required List<ModelsOp> ops,
    required String revision,
  }) async {
    final ok = await _expect<ModelsMutateOk>(
      ModelsMutateRequest(
        id: uuid7(),
        ops: ops.map((o) => o.toJson()).toList(),
        revision: revision,
      ),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'models_mutate') {
          final reason = ModelsErrorReason.fromWire(msg.error);
          throw ModelsFailure(reason ?? ModelsErrorReason.invalid);
        }
        return msg is ModelsMutateOk && msg.inReplyTo == id;
      },
    );
    return ok.revision;
  }

  /// Plan/84 — read the host's settings.json through the whitelist projection.
  Future<SettingsSnapshot> describeSettings() async {
    final ok = await _expect<SettingsDescribeOk>(
      SettingsDescribeRequest(id: uuid7()),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'settings_describe') {
          final reason = SettingsErrorReason.fromWire(msg.error);
          throw SettingsFailure(reason ?? SettingsErrorReason.invalid);
        }
        return msg is SettingsDescribeOk && msg.inReplyTo == id;
      },
    );
    return SettingsSnapshot.fromJson(ok.body);
  }

  /// Plan/84 — write settings via path-addressed SET/UNSET ops.
  ///
  /// [revision] must be the value from the describe that preceded this edit: the
  /// host compares it against the file's current byte sha256 and refuses a stale
  /// one. That single check is what keeps a client from silently reverting a
  /// change somebody else made in between.
  Future<String> mutateSettings({
    required List<SettingsOp> ops,
    required String revision,
  }) async {
    final ok = await _expect<SettingsMutateOk>(
      SettingsMutateRequest(
        id: uuid7(),
        ops: ops.map((o) => o.toJson()).toList(),
        revision: revision,
      ),
      (id, msg) {
        if (msg is ActionError && msg.inReplyTo == id && msg.rawAction == 'settings_mutate') {
          final reason = SettingsErrorReason.fromWire(msg.error);
          throw SettingsFailure(reason ?? SettingsErrorReason.invalid);
        }
        return msg is SettingsMutateOk && msg.inReplyTo == id;
      },
    );
    return ok.revision;
  }

  /// Plan/84 — the workspace's working-tree status (`changes_snapshot`).
  ///
  /// Two distinct outcomes, and the difference matters: a CLEAN worktree is a
  /// successful snapshot with an empty entry list, while "not a git repo" is
  /// `ChangesSnapshotUnavailable`. Collapsing them would make a clean tree look
  /// like a broken panel (and vice versa).
  Future<ChangesSnapshot> changesSnapshot({
    required String root,
    required String daemonId,
  }) async {
    final ok = await _expect<ChangesSnapshotOk>(
      ChangesSnapshotRequest(id: uuid7(), root: root, daemonId: daemonId),
      (id, msg) {
        if (msg is ChangesSnapshotUnavailable && msg.inReplyTo == id) {
          final known = ChangesUnavailable.fromWire(msg.reason);
          throw ChangesFailure(known ?? ChangesUnavailable.unreadable);
        }
        return msg is ChangesSnapshotOk && msg.inReplyTo == id;
      },
    );
    return ChangesSnapshot.fromJson(ok.snapshot);
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
  // (`server/src/index.ts`), so they go on the ACTIVE room (the workspace
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
    bool Function(String id, ServerMessage msg) match, {
    Duration? timeout,
  }) async {
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
      return await done.future.timeout(timeout ?? _timeout);
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
