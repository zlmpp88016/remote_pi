// Plan 86 P4 — the App's typed, read-only history transport.
//
// Two paths, chosen by the host's OWN declaration:
//
//   `workspace_history_v1` in `host_hello_ok`
//     → `history_list` / `history_read` / `history_body` on room `host`
//       (host-direct, zero Pi). Works while the workspace is stopped,
//       starting, running or crashing.
//
//   capability absent (older host)
//     → legacy READ-ONLY `session_list` / `session_read` through a LIVE Pi.
//       If the Pi is not live the request fails as `unavailable` with a
//       client-owned explanation. It NEVER calls `workspace_start` and NEVER
//       upgrades a browse action into `session_switch`.
//
// Everything is bounded: one in-flight request per identical key (single
// flight), a request deadline, typed failures, and a cache that is invalidated
// only for the affected scope. The sole state-changing call is [switchOnce],
// used exclusively by the explicit "继续对话" confirmation.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/history/history_cache.dart';
import 'package:mobile/data/history/history_mapper.dart';
import 'package:mobile/data/transport/channel.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/data/transport/epk_encoding.dart';
import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/protocol/history.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/protocol/uuid7.dart';

/// Host capability that selects the native path.
const String kWorkspaceHistoryCapability = 'workspace_history_v1';

class HistoryRepositoryImpl extends HistoryRepository {
  HistoryRepositoryImpl({
    required ConnectionManager conn,
    HistoryPageCache? cache,
    HistoryMetrics? metrics,
    Duration requestTimeout = const Duration(seconds: 12),
  }) : _conn = conn,
       _cache = cache ?? HistoryPageCache(),
       _metrics = metrics ?? HistoryMetrics(),
       _requestTimeout = requestTimeout {
    _statusSub = _conn.statusesStream.listen(_onStatuses);
    _focusSub = _conn.statusStream.listen(_onFocusedStatus);
    _helloSub = _conn.hostHelloStream.listen((_) => _kindCache.clear());
    final active = _conn.activePeer?.remoteEpk;
    if (active != null) _knownPeers.add(toStandardB64(active));
    _knownPeers.addAll(_conn.statusesSnapshot.keys);
  }

  final ConnectionManager _conn;
  final HistoryPageCache _cache;
  final HistoryMetrics _metrics;
  final Duration _requestTimeout;

  StreamSubscription<Map<String, ConnectionStatus>>? _statusSub;
  StreamSubscription<ConnectionStatus>? _focusSub;
  StreamSubscription<HostHelloOk>? _helloSub;

  /// Peers seen in the pool. A peer that DISAPPEARS from a statuses snapshot
  /// was disconnected/removed, which must invalidate its cached pages even
  /// though the snapshot no longer names it.
  final Set<String> _knownPeers = {};

  /// peer key (standard base64) → was online at the previous broadcast.
  final Map<String, bool> _wasOnline = {};

  /// Capability resolution per peer. `resolved` is true when `host_hello_ok`
  /// was actually seen; a missing hello is cached for a short TTL so an older
  /// host does not pay the 1.5 s handshake wait on EVERY page request.
  final Map<String, ({HistoryTransportKind kind, DateTime at, bool resolved})>
  _kindCache = {};

  /// The focused peer is emitted only on `statusStream`, not on
  /// `statusesStream`; track it so a focused offline/reconnect edge is not
  /// lost.
  String? _lastFocusedKey;
  bool _lastFocusedOnline = false;

  /// Identical in-flight requests share one future (one wire frame).
  final Map<String, Future<dynamic>> _inflight = {};

  @override
  HistoryMetrics get metrics => _metrics;

  @override
  void recordMetric(HistoryMetricSample sample) {
    _metrics.record(sample);
    if (!kDebugMode) return;
    // Scalar-only by construction: no message text, no token, no ciphertext.
    debugPrint(
      '[history] op=${sample.op}'
      ' queue_ms=${sample.queueMs}'
      ' wire_ms=${sample.wireMs}'
      ' decode_apply_ms=${sample.decodeApplyMs}'
      ' first_content_ms=${sample.firstContentMs}'
      ' cache_hit=${sample.cacheHit}'
      ' items=${sample.items}',
    );
  }

  @override
  Future<HistoryTransportKind> transportKind(
    String epk, {
    required String daemonId,
    String? cwd,
    String? roomId,
    Duration helloWait = const Duration(milliseconds: 1500),
  }) async {
    final key = toStandardB64(epk);
    final cached = _kindCache[key];
    if (cached != null) {
      final age = DateTime.now().difference(cached.at);
      // A host that declared the capability stays resolved for this session. A
      // missing hello is re-checked after 30 s (a late handshake must not pin
      // the peer to the legacy path forever).
      if (cached.resolved || age < const Duration(seconds: 30)) {
        return cached.kind;
      }
    }
    final hello = await _hello(epk, helloWait);
    final kind =
        hello != null &&
            hello.capabilities.contains(kWorkspaceHistoryCapability)
        ? HistoryTransportKind.hostV1
        : HistoryTransportKind.legacy;
    _kindCache[key] = (kind: kind, at: DateTime.now(), resolved: hello != null);
    return kind;
  }

  @override
  HistoryWorkspaceListing? cachedWorkspace(String epk, String daemonId) =>
      _cache.lookupWorkspace(epk, daemonId);

  @override
  HistoryPage? cachedNewestPage(
    String epk,
    String daemonId,
    String sessionId,
  ) => _cache.lookupNewestPage(epk, daemonId, sessionId);

  @override
  HistoryPage? cachedPage({
    required String epk,
    required String daemonId,
    required String sessionId,
    required String snapshot,
    required int projection,
    String? cursor,
  }) => _cache.lookupPage(
    HistoryCacheKey(
      peer: epk,
      daemonId: daemonId,
      sessionId: sessionId,
      snapshot: snapshot,
      projection: projection,
      cursor: cursor,
    ),
  );

  @override
  Future<HistoryWorkspaceListing> listWorkspace(HistoryWorkspaceQuery query) {
    final key =
        'list|${toStandardB64(query.epk)}|${query.daemonId}|${query.limit}|'
        '${query.before}|${query.ifRevision}|${query.bypassCache}';
    return _singleFlight(key, () => _listWorkspace(query));
  }

  Future<HistoryWorkspaceListing> _listWorkspace(
    HistoryWorkspaceQuery query,
  ) async {
    final kind = await transportKind(
      query.epk,
      daemonId: query.daemonId,
      cwd: query.cwd,
      roomId: query.roomId,
    );
    if (kind == HistoryTransportKind.hostV1) {
      final ch = _channelOrThrow(query.epk);
      final _Reply<HistoryListOk> reply;
      try {
        reply = await _expect<HistoryListOk>(
          ch,
          HistoryListRequest(
            id: uuid7(),
            daemonId: query.daemonId,
            limit: query.limit.clamp(1, kHistoryListMaxLimit).toInt(),
            before: query.before,
            ifRevision: query.ifRevision,
          ),
          accept: (m) => m is HistoryListOk,
          handleHistoryError: true,
        );
      } on HistoryFailure catch (f) {
        _applyFailureScope(f, query.epk, query.daemonId);
        rethrow;
      }
      final listing = mapListing(
        reply.message.payload,
        queueMs: reply.queueMs,
        wireMs: reply.wireMs,
      );
      // Only a complete first page is worth caching. `building`/`unavailable`
      // must never replace rows the user can still read.
      if (query.before == null &&
          listing.indexState == HistoryIndexState.ready &&
          listing.revision != null) {
        _cache.putWorkspace(query.epk, query.daemonId, listing);
      }
      return listing;
    }

    return _listLegacy(query);
  }

  Future<HistoryWorkspaceListing> _listLegacy(
    HistoryWorkspaceQuery query,
  ) async {
    final room = _legacyRoom(query.epk, query.cwd, query.roomId);
    if (room == null) {
      throw const HistoryFailure(HistoryErrorCode.unavailable);
    }
    // Legacy reads only exist while the Pi is live; a stopped workspace has
    // nothing to answer and browsing must never start one.
    if (!_conn.isRoomLive(query.epk, room)) {
      throw const HistoryFailure(HistoryErrorCode.unavailable);
    }
    _conn.switchRoomFor(query.epk, room);
    final ch = _channelOrThrow(query.epk);
    final _Reply<SessionListOk> reply;
    try {
      reply = await _expect<SessionListOk>(
        ch,
        SessionList(id: uuid7()),
        accept: (m) => m is SessionListOk,
        handleHistoryError: false,
      );
    } catch (_) {
      // A Pi that is live but still booting has no handler yet; report it as a
      // timeout (retryable) rather than inventing an empty catalog.
      rethrow;
    }
    return mapLegacyListing(
      reply.message,
      daemonId: query.daemonId,
      queueMs: reply.queueMs,
      wireMs: reply.wireMs,
    );
  }

  @override
  Future<HistoryPage> readSession(HistorySessionQuery query) {
    final key =
        'read|${toStandardB64(query.epk)}|${query.daemonId}|${query.sessionId}|'
        '${query.limit}|${query.before}|${query.snapshot}|${query.ifRevision}|'
        '${query.bypassCache}';
    return _singleFlight(key, () => _readSession(query));
  }

  Future<HistoryPage> _readSession(HistorySessionQuery query) async {
    final kind = await transportKind(
      query.epk,
      daemonId: query.daemonId,
      cwd: query.cwd,
      roomId: query.roomId,
    );
    if (kind == HistoryTransportKind.hostV1) {
      final ch = _channelOrThrow(query.epk);
      final _Reply<HistoryReadOk> reply;
      try {
        reply = await _expect<HistoryReadOk>(
          ch,
          HistoryReadRequest(
            id: uuid7(),
            daemonId: query.daemonId,
            sessionId: query.sessionId,
            limit: query.limit.clamp(1, kHistoryReadMaxLimit).toInt(),
            before: query.before,
            snapshot: query.snapshot,
            ifRevision: query.ifRevision,
          ),
          accept: (m) => m is HistoryReadOk,
          handleHistoryError: true,
        );
      } on HistoryFailure catch (f) {
        _applyFailureScope(f, query.epk, query.daemonId);
        rethrow;
      }
      final page = mapPage(
        reply.message.payload,
        queueMs: reply.queueMs,
        wireMs: reply.wireMs,
      );
      _cache.putPage(
        HistoryCacheKey(
          peer: query.epk,
          daemonId: query.daemonId,
          sessionId: query.sessionId,
          snapshot: page.snapshot,
          projection: page.projection,
          cursor: query.before,
        ),
        page,
      );
      return page;
    }

    return _readLegacy(query);
  }

  Future<HistoryPage> _readLegacy(HistorySessionQuery query) async {
    final room = _legacyRoom(query.epk, query.cwd, query.roomId);
    if (room == null || !_conn.isRoomLive(query.epk, room)) {
      throw const HistoryFailure(HistoryErrorCode.unavailable);
    }
    _conn.switchRoomFor(query.epk, room);
    final ch = _channelOrThrow(query.epk);
    final _Reply<ServerMessage> reply = await _expect<ServerMessage>(
      ch,
      SessionRead(
        id: uuid7(),
        sessionId: query.sessionId,
        limit: query.limit.clamp(1, kHistoryReadMaxLimit).toInt(),
        before: query.before,
      ),
      accept: (m) => m is SessionReadOk || m is SessionHistory,
      handleHistoryError: false,
    );
    final msg = reply.message;
    if (msg is SessionReadOk) {
      return mapLegacyPage(
        msg,
        daemonId: query.daemonId,
        sessionId: query.sessionId,
        queueMs: reply.queueMs,
        wireMs: reply.wireMs,
      );
    }
    if (msg is SessionHistory) {
      return mapLegacyHistory(
        msg,
        daemonId: query.daemonId,
        sessionId: query.sessionId,
        queueMs: reply.queueMs,
        wireMs: reply.wireMs,
      );
    }
    throw const HistoryFailure(HistoryErrorCode.unsupported);
  }

  @override
  Future<HistoryBodyChunk> readBody(HistoryBodyQuery query) {
    final key =
        'body|${toStandardB64(query.epk)}|${query.daemonId}|'
        '${query.sessionId}|${query.snapshot}|${query.bodyRef}|${query.offsetBytes}';
    return _singleFlight(key, () => _readBody(query));
  }

  Future<HistoryBodyChunk> _readBody(HistoryBodyQuery query) async {
    final kind = await transportKind(query.epk, daemonId: query.daemonId);
    if (kind != HistoryTransportKind.hostV1) {
      // Legacy pages carry no body refs; there is nothing to materialize.
      throw const HistoryFailure(HistoryErrorCode.unsupported);
    }
    final ch = _channelOrThrow(query.epk);
    final _Reply<HistoryBodyOk> reply;
    try {
      reply = await _expect<HistoryBodyOk>(
        ch,
        HistoryBodyRequest(
          id: uuid7(),
          daemonId: query.daemonId,
          sessionId: query.sessionId,
          snapshot: query.snapshot,
          bodyRef: query.bodyRef,
          offsetBytes: query.offsetBytes,
        ),
        accept: (m) => m is HistoryBodyOk,
        handleHistoryError: true,
      );
    } on HistoryFailure catch (f) {
      _applyFailureScope(f, query.epk, query.daemonId);
      rethrow;
    }
    final wire = reply.message.payload;
    if (wire.bodyRef != query.bodyRef ||
        wire.snapshot != query.snapshot ||
        wire.sessionId != query.sessionId ||
        wire.offsetBytes != query.offsetBytes) {
      // A mismatched chunk would be spliced into the wrong body. Treat as a
      // protocol failure, never as data.
      throw const HistoryFailure(HistoryErrorCode.invalidRequest);
    }
    return mapBody(wire);
  }

  @override
  Future<HistoryWorkspaceLaunch> startWorkspace({
    required String epk,
    String? daemonId,
    String? cwd,
    Duration timeout = const Duration(seconds: 12),
  }) {
    // One start per workspace per explicit intent. The host's start is
    // idempotent, but joining the in-flight future means a double tap cannot
    // put two start frames (and two spawn attempts) on the wire.
    final key = 'start|${toStandardB64(epk)}|${daemonId ?? ''}|${cwd ?? ''}';
    return _singleFlight(key, () async {
      final ch = _channelOrThrow(epk);
      final request = WorkspaceStart(id: uuid7(), cwd: cwd, daemonId: daemonId);
      final done = Completer<HistoryWorkspaceLaunch>();
      late final StreamSubscription<ServerMessage> sub;
      sub = ch.serverMessages.listen(
        (msg) {
          if (done.isCompleted) return;
          if (msg is WorkspaceStartOk && msg.inReplyTo == request.id) {
            done.complete(
              HistoryWorkspaceLaunch(
                cwd: msg.cwd,
                roomId: msg.roomId,
                daemonId: msg.daemonId,
              ),
            );
          } else if (msg is ActionError &&
              msg.inReplyTo == request.id &&
              msg.rawAction == 'workspace_start') {
            done.completeError(
              const HistoryFailure(HistoryErrorCode.startFailed),
            );
          }
        },
        onError: (_) {
          if (!done.isCompleted) {
            done.completeError(const HistoryFailure(HistoryErrorCode.offline));
          }
        },
        onDone: () {
          if (!done.isCompleted) {
            done.completeError(const HistoryFailure(HistoryErrorCode.offline));
          }
        },
      );
      try {
        await ch.send(request);
        return await done.future.timeout(timeout);
      } on TimeoutException {
        // The host may still be spawning. The caller must NOT send a second
        // start; it reports the typed failure and the user can retry.
        throw const HistoryFailure(HistoryErrorCode.startFailed);
      } finally {
        await sub.cancel();
      }
    });
  }

  @override
  Future<void> switchOnce({
    required String epk,
    required String roomId,
    required String sessionId,
    Duration ackTimeout = const Duration(seconds: 12),
  }) {
    // One in-flight frame per target. A second caller joins the SAME future
    // instead of putting a second `session_switch` on the wire (one extra Pi
    // spawn). After it settles, a deliberate later intent may try again.
    final key = 'switch|${toStandardB64(epk)}|$roomId|$sessionId';
    return _singleFlight(key, () async {
      final ch = _channelOrThrow(epk);
      // `session_switch` is child-addressed: the room rides inside the host
      // proxy wrapper, so point the peer's room before sending.
      _conn.switchRoomFor(epk, roomId);
      final id = uuid7();
      await _expectSwitch(
        ch,
        SessionSwitch(id: id, sessionId: sessionId),
        ackTimeout,
      );
    });
  }

  Future<void> _expectSwitch(
    IChannel ch,
    SessionSwitch request,
    Duration timeout,
  ) async {
    final id = request.id;
    final done = Completer<void>();
    late final StreamSubscription<ServerMessage> sub;
    sub = ch.serverMessages.listen(
      (msg) {
        if (done.isCompleted) return;
        if (msg is SessionSwitchOk && msg.inReplyTo == id) {
          done.complete();
        } else if (msg is SessionSwitchError && msg.inReplyTo == id) {
          done.completeError(
            HistoryFailure(
              HistoryErrorCode.invalidRequest,
              switchRefusal: switch (msg.code) {
                SessionSwitchErrorCode.locked => HistorySwitchRefusal.locked,
                SessionSwitchErrorCode.noSdk => HistorySwitchRefusal.noSdk,
                SessionSwitchErrorCode.unknown => HistorySwitchRefusal.unknown,
              },
            ),
          );
        }
      },
      onError: (_) {
        if (!done.isCompleted) {
          done.completeError(const HistoryFailure(HistoryErrorCode.offline));
        }
      },
      onDone: () {
        if (!done.isCompleted) {
          done.completeError(const HistoryFailure(HistoryErrorCode.offline));
        }
      },
    );
    try {
      await ch.send(request);
      await done.future.timeout(timeout);
    } on TimeoutException {
      // The frame went out. The caller watches for the effect; it must not
      // re-send, because that is a second Pi spawn.
      throw const HistoryFailure(HistoryErrorCode.timeout);
    } finally {
      await sub.cancel();
    }
  }

  @override
  bool isRoomLive(String epk, String roomId) => _conn.isRoomLive(epk, roomId);

  @override
  void invalidateWorkspace(String epk, String daemonId) =>
      _cache.invalidateWorkspace(epk, daemonId);

  @override
  void invalidateSession(String epk, String daemonId, String sessionId) =>
      _cache.invalidateSession(epk, daemonId, sessionId);

  @override
  void invalidatePeer(String epk) => _cache.invalidatePeer(epk);

  @override
  void dispose() {
    _statusSub?.cancel();
    _statusSub = null;
    _focusSub?.cancel();
    _focusSub = null;
    _helloSub?.cancel();
    _helloSub = null;
    _kindCache.clear();
    _inflight.clear();
    _cache.clear();
    super.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  Future<HostHelloOk?> _hello(String epk, Duration wait) async {
    final known = _conn.hostHelloFor(epk);
    if (known != null) return known;
    if (wait <= Duration.zero || !_conn.isConnected(epk)) return null;
    final end = DateTime.now().add(wait);
    while (DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
      final hello = _conn.hostHelloFor(epk);
      if (hello != null) return hello;
    }
    return null;
  }

  IChannel _channelOrThrow(String epk) {
    final ch = _conn.channelFor(epk);
    if (ch == null) throw const HistoryFailure(HistoryErrorCode.offline);
    return ch;
  }

  String? _legacyRoom(String epk, String? cwd, String? roomId) {
    if (roomId != null && roomId.isNotEmpty) return roomId;
    final rooms = _conn.roomsFor(epk);
    if (cwd != null && cwd.isNotEmpty) {
      for (final room in rooms) {
        if (room.cwd == cwd) return room.roomId;
      }
    }
    // A single announced room is unambiguous; several require cwd/roomId.
    if (rooms.length == 1) return rooms.first.roomId;
    return null;
  }

  Future<T> _singleFlight<T>(String key, Future<T> Function() run) {
    final existing = _inflight[key];
    if (existing != null) return existing as Future<T>;
    final future = run();
    _inflight[key] = future;
    // Keep the ORIGINAL future in the map so a second caller awaits the same
    // result/error. The derived future consumes the error (removing the entry)
    // so a failed request never becomes an unhandled async error here.
    future.then<void>(
      (_) {
        if (identical(_inflight[key], future)) _inflight.remove(key);
      },
      onError: (Object _, StackTrace _) {
        if (identical(_inflight[key], future)) _inflight.remove(key);
      },
    );
    return future;
  }

  Future<_Reply<T>> _expect<T extends ServerMessage>(
    IChannel ch,
    ClientMessage request, {
    required bool Function(ServerMessage msg) accept,
    required bool handleHistoryError,
  }) async {
    final stage = HistoryStageMetrics.current;
    stage?.mark('transport_request_us');
    final id = (request.toJson()['id'] as String?) ?? '';
    final queue = Stopwatch()..start();
    final done = Completer<T>();
    late final StreamSubscription<ServerMessage> sub;
    sub = ch.serverMessages.listen(
      (msg) {
        if (done.isCompleted) return;
        if (handleHistoryError && msg is HistoryError) {
          if (msg.payload.inReplyTo != id) return;
          done.completeError(_failureFromWire(msg.payload));
          return;
        }
        if (!accept(msg)) return;
        if (id.isNotEmpty && !_inReplyTo(msg, id)) return;
        stage?.mark('typed_reply_us');
        done.complete(msg as T);
      },
      onError: (_) {
        if (!done.isCompleted) {
          done.completeError(const HistoryFailure(HistoryErrorCode.offline));
        }
      },
      onDone: () {
        if (!done.isCompleted) {
          done.completeError(const HistoryFailure(HistoryErrorCode.offline));
        }
      },
    );
    try {
      var queueMs = 0;
      final wire = Stopwatch();
      stage?.mark('send_begin_us');
      // Attach to the reply immediately: offline/error replies can arrive
      // while send is pending. One deadline owns both operations, and neither
      // a late send error nor an early reply error becomes unhandled.
      final result = await Future.wait<Object?>([
        Future<void>.sync(() => ch.send(request)).then<void>((_) {
          stage?.mark('send_complete_us');
          queueMs = queue.elapsedMilliseconds;
          wire.start();
        }),
        done.future,
      ], eagerError: true).timeout(_requestTimeout);
      stage?.mark('map_begin_us');
      return _Reply(result[1] as T, queueMs, wire.elapsedMilliseconds);
    } on TimeoutException {
      throw const HistoryFailure(HistoryErrorCode.timeout);
    } finally {
      await sub.cancel();
    }
  }

  static bool _inReplyTo(ServerMessage msg, String id) => switch (msg) {
    HistoryListOk(:final payload) => payload.inReplyTo == id,
    HistoryReadOk(:final payload) => payload.inReplyTo == id,
    HistoryBodyOk(:final payload) => payload.inReplyTo == id,
    SessionListOk(:final inReplyTo) => inReplyTo == id,
    SessionReadOk(:final inReplyTo) => inReplyTo == id,
    SessionHistory(:final inReplyTo) => inReplyTo == id,
    _ => true,
  };

  static HistoryFailure _failureFromWire(HistoryErrorWire wire) {
    final code = switch (wire.code) {
      HistoryErrorCodeWire.building => HistoryErrorCode.building,
      HistoryErrorCodeWire.stale => HistoryErrorCode.stale,
      HistoryErrorCodeWire.notModified => HistoryErrorCode.notModified,
      HistoryErrorCodeWire.unsupported => HistoryErrorCode.unsupported,
      HistoryErrorCodeWire.notFound => HistoryErrorCode.notFound,
      HistoryErrorCodeWire.invalidCursor => HistoryErrorCode.invalidCursor,
      HistoryErrorCodeWire.bodyTooLarge => HistoryErrorCode.bodyTooLarge,
      HistoryErrorCodeWire.invalidRequest => HistoryErrorCode.invalidRequest,
      HistoryErrorCodeWire.internal => HistoryErrorCode.internal,
      HistoryErrorCodeWire.unknown => HistoryErrorCode.unknown,
    };
    return HistoryFailure(
      code,
      retryAfterMs: wire.retryAfterMs,
      daemonId: wire.daemonId,
      sessionId: wire.sessionId,
      revision: wire.revision,
      snapshot: wire.snapshot,
    );
  }

  void _applyFailureScope(HistoryFailure failure, String epk, String daemonId) {
    switch (failure.code) {
      case HistoryErrorCode.stale:
      case HistoryErrorCode.invalidCursor:
        final sessionId = failure.sessionId;
        if (sessionId != null) {
          _cache.invalidateSession(epk, daemonId, sessionId);
        } else {
          _cache.invalidateWorkspace(epk, daemonId);
        }
      case HistoryErrorCode.notFound:
        _cache.invalidateWorkspace(epk, daemonId);
      default:
        break;
    }
  }

  void _onStatuses(Map<String, ConnectionStatus> snapshot) {
    final seen = <String>{};
    for (final entry in snapshot.entries) {
      seen.add(entry.key);
      _knownPeers.add(entry.key);
      final online = entry.value is StatusOnline;
      final was = _wasOnline[entry.key] ?? false;
      _wasOnline[entry.key] = online;
      if (was && !online) {
        // Scoped: only this peer's cached pages are invalidated, so a
        // reconnect cannot paint another machine's history and a background
        // peer's cache survives. The next visit refetches deliberately.
        _cache.invalidatePeer(entry.key);
      }
    }
    // A peer that DISAPPEARED from the snapshot was removed from the pool
    // (`disconnectPeer`/`disconnect`), which is also a reconnect/reset edge:
    // its pages must not survive into a later connection under the same epk.
    for (final key in _knownPeers.toList()) {
      if (seen.contains(key)) continue;
      _cache.invalidatePeer(key);
      _knownPeers.remove(key);
      _wasOnline.remove(key);
      _kindCache.remove(key);
    }
  }

  /// Focused-peer edge (the `statusesStream` snapshot never carries the
  /// focused peer's transitions). Going offline is a reset edge; only that
  /// peer's cache is dropped.
  void _onFocusedStatus(ConnectionStatus status) {
    final active = _conn.activePeer?.remoteEpk;
    if (active == null) {
      _lastFocusedKey = null;
      _lastFocusedOnline = false;
      return;
    }
    final key = toStandardB64(active);
    _knownPeers.add(key);
    final online = status is StatusOnline;
    if (_lastFocusedKey == key && _lastFocusedOnline && !online) {
      _cache.invalidatePeer(key);
    }
    _lastFocusedKey = key;
    _lastFocusedOnline = online;
  }
}

class _Reply<T> {
  final T message;
  final int queueMs;
  final int wireMs;
  const _Reply(this.message, this.queueMs, this.wireMs);
}
