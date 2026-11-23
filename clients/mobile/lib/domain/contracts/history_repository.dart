// Plan 86 P4 — read-only workspace-history contract.
//
// The App never resolves a filesystem path and never opens a session bucket
// itself: `daemon_id` + opaque tokens are the whole addressing surface. A host
// that advertises `workspace_history_v1` is served by the daemon with zero Pi;
// an older host falls back to the legacy READ-ONLY `session_list` /
// `session_read` while its Pi is live. Browsing never issues `session_switch`
// and never calls `workspace_start`.
//
// The one state-changing operation in this feature is deliberately separate:
// [HistoryRepository.switchOnce] is the explicit "继续对话" intent and is only
// called after the user confirms.

import 'package:mobile/domain/contracts/repository.dart';
import 'package:mobile/domain/history/history_models.dart';

/// Which read path a workspace will use.
enum HistoryTransportKind {
  /// `workspace_history_v1` — host-native, zero Pi.
  hostV1,

  /// Legacy `session_list` + `session_read` through a LIVE Pi.
  legacy,
}

/// Where a listing/page came from. Used to label a cached paint honestly.
enum HistoryResultOrigin { network, cache }

/// Parameters for `history_list` (or the legacy `session_list` fallback).
class HistoryWorkspaceQuery {
  final String epk;

  /// Registered daemon id. It is the host's authorization key; the App has no
  /// path parameter at all.
  final String daemonId;

  /// Workspace cwd, only used to locate the legacy Pi room.
  final String? cwd;

  /// Known workspace room id, only used by the legacy fallback.
  final String? roomId;

  final int limit;

  /// Opaque list cursor. Null = first (newest) page.
  final String? before;

  /// Opaque list revision. Only sent on the FIRST page; a match answers
  /// `not_modified` and the caller keeps its cache.
  final String? ifRevision;

  /// Skip the cache entirely (used by the explicit-continue preflight/watch).
  final bool bypassCache;

  const HistoryWorkspaceQuery({
    required this.epk,
    required this.daemonId,
    this.cwd,
    this.roomId,
    this.limit = 50,
    this.before,
    this.ifRevision,
    this.bypassCache = false,
  });
}

/// Parameters for `history_read` (or the legacy `session_read` fallback).
class HistorySessionQuery {
  final String epk;
  final String daemonId;
  final String sessionId;
  final String? cwd;
  final String? roomId;
  final int limit;
  final String? before;

  /// Snapshot the page sequence belongs to. A mismatch answers `stale`.
  final String? snapshot;

  /// Opaque content revision. Only sent on the FIRST page for a conditional
  /// refresh; paged requests must not carry it or the host would answer
  /// `not_modified` instead of the older page.
  final String? ifRevision;

  final bool bypassCache;

  const HistorySessionQuery({
    required this.epk,
    required this.daemonId,
    required this.sessionId,
    this.cwd,
    this.roomId,
    this.limit = 30,
    this.before,
    this.snapshot,
    this.ifRevision,
    this.bypassCache = false,
  });
}

/// Parameters for `history_body`.
class HistoryBodyQuery {
  final String epk;
  final String daemonId;
  final String sessionId;
  final String snapshot;
  final String bodyRef;
  final int offsetBytes;

  const HistoryBodyQuery({
    required this.epk,
    required this.daemonId,
    required this.sessionId,
    required this.snapshot,
    required this.bodyRef,
    this.offsetBytes = 0,
  });
}

/// Read-only workspace history. Implemented in `data/history/`.
abstract class HistoryRepository extends Repository {
  /// Scalar-only metrics for the Plan 86 P0 seams.
  HistoryMetrics get metrics;

  /// Records one finalized client sample (span completion happens in the
  /// ViewModel). Logged as scalars only in debug builds.
  void recordMetric(HistoryMetricSample sample);

  /// Resolves the read path for a workspace. Waits briefly for `host_hello_ok`
  /// when the handshake has not arrived yet; never starts a Pi.
  Future<HistoryTransportKind> transportKind(
    String epk, {
    required String daemonId,
    String? cwd,
    String? roomId,
    Duration helloWait = const Duration(milliseconds: 1500),
  });

  /// Cached first-page listing for instant paint, or null.
  HistoryWorkspaceListing? cachedWorkspace(String epk, String daemonId);

  /// Cached newest page for a session (regardless of snapshot), or null.
  HistoryPage? cachedNewestPage(String epk, String daemonId, String sessionId);

  /// Cached page for the exact sequence key, or null.
  HistoryPage? cachedPage({
    required String epk,
    required String daemonId,
    required String sessionId,
    required String snapshot,
    required int projection,
    String? cursor,
  });

  Future<HistoryWorkspaceListing> listWorkspace(HistoryWorkspaceQuery query);

  Future<HistoryPage> readSession(HistorySessionQuery query);

  Future<HistoryBodyChunk> readBody(HistoryBodyQuery query);

  /// EXPLICIT continue precondition: start the workspace Pi exactly once.
  ///
  /// Browsing NEVER calls this. It exists so the confirmed "继续对话" can make
  /// the target addressable when the workspace is stopped (a switch into a dead
  /// room would be lost). The returned room id may differ from the catalog's
  /// derived id, so callers must send the switch to the RETURNED room.
  Future<HistoryWorkspaceLaunch> startWorkspace({
    required String epk,
    String? daemonId,
    String? cwd,
    Duration timeout = const Duration(seconds: 12),
  });

  /// Sends `session_switch` EXACTLY ONCE for [sessionId] on [roomId] and waits
  /// for its ack up to [ackTimeout].
  ///
  /// A missed ack throws `HistoryFailure(timeout)` — the frame may still have
  /// landed, so callers watch for the effect instead of re-sending. Any typed
  /// host refusal is thrown as `HistoryFailure(unsupported/invalidRequest)`.
  Future<void> switchOnce({
    required String epk,
    required String roomId,
    required String sessionId,
    Duration ackTimeout = const Duration(seconds: 12),
  });

  /// Whether a legacy Pi room is currently live. Used only for honest copy.
  bool isRoomLive(String epk, String roomId);

  /// Scoped invalidation. Never clears another workspace/session.
  void invalidateWorkspace(String epk, String daemonId);

  void invalidateSession(String epk, String daemonId, String sessionId);

  void invalidatePeer(String epk);
}
