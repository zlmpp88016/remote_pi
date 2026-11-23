// Plan/31 — local SSOT box layer (Hive v2).
//
// Three families of box in a NEW namespace (`rp_v2`); v1 (`session_history`,
// the blob snapshot) is abandoned without migration (#6 — re-sync from the Pi
// on first boot). The `runtime` box is VOLATILE: wiped on every boot (#3) so
// connection/presence never report stale online across restarts.
//
//   DURABLE  msgs_<epk>__<roomId>   stable nonnegative key → MessageRecord
//   DURABLE  sessions_index         key = <epk>:<roomId>   → SessionIndexRecord
//   VOLATILE runtime  (wiped@boot)  key = <epk>:<roomId>   → RuntimeRecord

import 'dart:async';

import 'package:mobile/data/transport/epk_encoding.dart';
import 'package:hive_flutter/hive_flutter.dart';

const String _kNamespace = 'rp_v2';
const String _kSessionsIndex = 'sessions_index';
const String _kRuntime = 'runtime';

/// Facade over the v2 Hive boxes. A single instance is shared by the
/// [SyncService] (writer) and the read repositories (readers) so they observe
/// the same open box objects (`Hive.openBox` is idempotent).
class LocalBoxes {
  static bool _initialized = false;

  // Publication boundaries only; SyncService's existing queue owns writes.
  static final Map<String, MessageBatchState> _messageBatches = {};
  MessageBatchState messageBatch(String epk, String room) => _messageBatches
      .putIfAbsent(msgsBoxName(epk, room), MessageBatchState.new);

  Future<void> messageBatchWrite(
    String epk,
    String room,
    Future<void> Function() write, {
    required bool Function() isCurrent,
  }) async {
    final state = messageBatch(epk, room);
    state.active = true;
    var complete = false;
    try {
      await write();
      // Drain Hive's asynchronous BoxEvents before the completion boundary.
      await Future<void>.value();
      complete = isCurrent();
    } finally {
      state.active = false;
      state.valid = complete;
      state.completions.add(complete);
    }
  }

  /// Schema 2 decouples signed row.seq from the nonnegative Hive key.
  /// Legacy rows already store seq: adoption needs no row writes. Flush rows
  /// before the marker so interrupted adoption is safe to repeat.
  Future<void> ensureMessageSchema(String epk, String room) async {
    final metadata = await Hive.openBox<int>('message_schema');
    final name = msgsBoxName(epk, room);
    if (metadata.get(name) == 2) return;
    final box = await msgsBox(epk, room);
    await box.flush();
    await metadata.put(name, 2);
    await metadata.flush();
  }

  /// Open the v2 namespace and the always-on boxes; **wipe `runtime`** before
  /// anything subscribes (#3 / Risk 2). Call once during bootstrap, before
  /// `runApp` and before any read-repo is constructed.
  static Future<void> init() async {
    if (_initialized) return;
    await Hive.initFlutter(_kNamespace);
    await _openCommon();
    _initialized = true;
  }

  /// For tests: open against a custom directory. Unlike [init] this always
  /// re-opens + wipes the volatile box, so a second call simulates a restart
  /// (and lets tests assert the wipe).
  static Future<void> initForTest(String path) async {
    if (!_initialized) Hive.init(path);
    await _openCommon();
    _initialized = true;
  }

  static Future<void> _openCommon() async {
    await Hive.openBox<dynamic>(_kSessionsIndex);
    final runtime = await Hive.openBox<dynamic>(_kRuntime);
    await runtime.clear(); // VOLATILE — zero on boot (#3)
  }

  Box<dynamic> sessionsIndexBox() => Hive.box<dynamic>(_kSessionsIndex);

  Box<dynamic> runtimeBox() => Hive.box<dynamic>(_kRuntime);

  /// Per-session message box. Lazily opened; idempotent (returns the already
  /// open box on subsequent calls).
  Future<Box<dynamic>> msgsBox(String epk, String roomId) =>
      Hive.openBox<dynamic>(msgsBoxName(epk, roomId));

  /// Synchronous accessor for a msgs box known to be open already.
  Box<dynamic> openMsgsBox(String epk, String roomId) =>
      Hive.box<dynamic>(msgsBoxName(epk, roomId));

  bool isMsgsBoxOpen(String epk, String roomId) =>
      Hive.isBoxOpen(msgsBoxName(epk, roomId));

  /// `:` and the epk's `/`+`=` would break the on-disk filename — sanitise to
  /// the url-safe, unpadded epk form (same approach as the v1 store).
  static String msgsBoxName(String epk, String roomId) =>
      'msgs_${toAppEpk(epk)}__$roomId';

  static String sessionKey(String epk, String roomId) => '$epk:$roomId';
}

class MessageBatchState {
  bool active = false;
  bool valid = true;
  final StreamController<bool> completions = StreamController<bool>.broadcast(
    sync: true,
  );
}
