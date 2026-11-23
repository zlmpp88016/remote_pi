// Plan 86 P4 — read-only history viewer ViewModel.
//
// Structural guarantees, not conventions:
//   * it has no composer and no `sendMessage`; the only mutating verb is
//     [continueToChat], gated by the page's confirmation dialog;
//   * it never touches Hive, SyncService or the live transcript — pages are
//     in-memory and body previews are fetched on demand;
//   * a cached page is painted immediately and revalidated (`if_revision`);
//   * the NEWEST page NEVER pins a `snapshot`: it is a conditional head read
//     (`if_revision` only). Sending the cached snapshot would let the host
//     certify an OLD head against a NEW file revision after a trusted append,
//     hiding the new rows behind a `not_modified`;
//   * a returned head with a DIFFERENT snapshot REPLACES the whole page
//     sequence (base page + every spliced older page) and fences every
//     older/body request that was started under the previous generation, so a
//     late reply can never be spliced across generations;
//   * OLDER pages keep the ORIGINAL opaque snapshot and cursor of the loaded
//     sequence. A mismatch answers `stale` and triggers a deliberate reopen,
//     never a mixed generation;
//   * one in-flight page request per direction, bounded `building` retries,
//     late replies dropped by an epoch guard;
//   * explicit continue sends `session_switch` AT MOST ONCE per intent. A
//     missed ACK switches to a dedicated target watch (no re-send, no global
//     lock of the viewer).

import 'dart:async';

import 'package:mobile/data/history/history_body_loader.dart';
import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/history/states/history_viewer_state.dart';

/// Outcome of the explicit "继续对话" intent.
enum HistoryContinueOutcome {
  /// The target was already the runtime current session: no switch was sent.
  alreadyCurrent,

  /// One switch was sent and the host confirmed the target as current.
  switched,

  /// The intent failed; [HistoryViewerReady.continueError] says why.
  failed,

  /// The viewer was disposed or a newer intent superseded this one.
  superseded,
}

class HistoryViewerViewModel extends ViewModel<HistoryViewerState> {
  HistoryViewerViewModel(
    this._repo,
    this._bodyLoader,
    this._conn,
    this._prefs, {
    required this.epk,
    required this.daemonId,
    required this.sessionId,
    this.cwd,
    this.roomId,
    this.title = '',
    Duration switchAckTimeout = const Duration(seconds: 12),
    Duration switchSettleBudget = const Duration(seconds: 90),
    Duration watchPollInterval = const Duration(seconds: 2),
    Duration roomLiveBudget = const Duration(seconds: 30),
    Duration roomLivePollInterval = const Duration(milliseconds: 200),
  }) : _switchAckTimeout = switchAckTimeout,
       _switchSettleBudget = switchSettleBudget,
       _watchPollInterval = watchPollInterval,
       _roomLiveBudget = roomLiveBudget,
       _roomLivePollInterval = roomLivePollInterval,
       super(const HistoryViewerLoading()) {
    _mount.start();
    _stageIntentUs = HistoryStageMetrics.intentNow;
    // ignore: discarded_futures
    _bootstrap();
  }

  final HistoryRepository _repo;
  final HistoryBodyLoader _bodyLoader;
  final ConnectionManager _conn;
  final Preferences _prefs;

  final String epk;
  final String daemonId;
  final String sessionId;
  final String? cwd;
  final String? roomId;
  final String title;

  static const _pageLimit = 30;
  static const _maxBuildingRetries = 8;
  static const _buildingBudget = Duration(seconds: 8);

  /// Bound the expanded bodies a single viewer keeps in memory (the page
  /// cache is separate and already byte-bounded). Oldest expansions are
  /// dropped first; their previews remain in the rows.
  static const _maxLoadedBodies = 8;
  static const _maxLoadedBodyBytes = 8 * 1024 * 1024;

  /// The exact ACK slice for the ONE `session_switch` this ViewModel may send.
  final Duration _switchAckTimeout;

  /// Bound for the target watch after the single send. It does NOT lock the
  /// viewer: only the continue affordance reads [HistoryViewerReady.continuing].
  final Duration _switchSettleBudget;
  final Duration _watchPollInterval;

  /// Bound for the explicit-start precondition: after `workspace_start_ok` the
  /// relay still has to announce the room before a switch can be delivered.
  final Duration _roomLiveBudget;
  final Duration _roomLivePollInterval;

  final Stopwatch _mount = Stopwatch();
  Stopwatch? _requestClock;

  int _epoch = 0;
  bool _reopening = false;
  Timer? _retryTimer;
  int _retryAttempts = 0;
  DateTime? _buildingSince;

  int _continueGeneration = 0;
  bool _continuing = false;
  bool _continueReportedAlreadyCurrent = false;

  HistoryMetricSample? _firstPaintSample;
  bool _firstPaintCaptured = false;
  bool _firstContentReported = false;
  HistoryStageSpan? viewportStage;
  int? _stageIntentUs;

  // ---- Public surface -----------------------------------------------------

  Future<void> refresh() async {
    _stageIntentUs = HistoryStageMetrics.intentNow;
    final epoch = ++_epoch;
    _retryTimer?.cancel();
    _retryAttempts = 0;
    _buildingSince = null;
    final now = state;
    if (now is HistoryViewerReady) {
      // Conditional HEAD read: `if_revision` only. The loaded snapshot is
      // deliberately NOT pinned here — after a trusted append the host must be
      // free to return the new head (new snapshot + new rows) instead of
      // answering `not_modified` for a generation the client happens to hold.
      await _loadNewest(epoch, ifRevision: now.revision);
      return;
    }
    emit(const HistoryViewerLoading());
    await _loadNewest(epoch);
  }

  /// Fetch the older page in front of the loaded window. One in-flight.
  Future<void> loadOlder() async {
    final now = state;
    if (now is! HistoryViewerReady ||
        !now.hasOlder ||
        now.olderCursor == null ||
        now.loadingOlder) {
      return;
    }
    final epoch = _epoch;
    // The ORIGINAL opaque snapshot of the loaded sequence: an older page is
    // only ever fetched/spliced against the generation the window was opened
    // with, never against a newer head.
    final sequenceSnapshot = now.snapshot;
    final cursor = now.olderCursor!;
    final stage = HistoryStageMetrics.begin('history_read_page');
    emit(now.copyWith(loadingOlder: true, issue: null));
    try {
      final page = await HistoryStageMetrics.request(
        stage,
        () => _repo.readSession(
          HistorySessionQuery(
            epk: epk,
            daemonId: daemonId,
            sessionId: sessionId,
            cwd: cwd,
            roomId: roomId,
            limit: _pageLimit,
            before: cursor,
            snapshot: sequenceSnapshot,
          ),
        ),
      );
      if (_isStale(epoch)) return;
      final current = state;
      if (current is! HistoryViewerReady) return;
      if (current.snapshot != sequenceSnapshot ||
          page.snapshot != sequenceSnapshot) {
        // Two generations must never be spliced: keep the current window, say
        // so, and reopen deliberately. The reopen drops the stale window and
        // re-reads a fresh head, so this page is never applied.
        emit(
          current.copyWith(loadingOlder: false, issue: HistoryErrorCode.stale),
        );
        await _reopen();
        return;
      }
      // The host may continue ONE extreme entry across pages (an opaque
      // sub-entry continuation) while keeping the base frames. An item that
      // comes back with the same event_id is therefore MERGED by stable
      // identity, never dropped: its union of body refs (keyed by field+opaque
      // ref) is preserved, and an item either side marked truncated stays
      // marked so the UI never presents a partial item as complete.
      final byId = <String, HistoryItem>{
        for (final item in current.items) item.eventId: item,
      };
      final older = <HistoryItem>[];
      for (final item in page.items) {
        final existingItem = byId[item.eventId];
        if (existingItem == null) {
          older.add(item);
        } else {
          byId[item.eventId] = _mergeItem(existingItem, item);
        }
      }
      final merged = <HistoryItem>[...older, ...byId.values];
      emit(
        current.copyWith(
          items: merged,
          olderCursor: page.olderCursor,
          hasOlder: page.hasOlder,
          loadingOlder: false,
          // Do NOT adopt the older page's revision: the sequence stays anchored
          // to the first page's snapshot/revision. Mixing a newer revision into
          // this window would let a later conditional refresh claim a
          // generation the loaded pages were not fetched under.
          issue: null,
        ),
      );
      viewportStage = stage?..applied(page.items.length);
    } on HistoryFailure catch (failure) {
      stage?.failed = true;
      if (_isStale(epoch)) return;
      final current = state;
      if (current is! HistoryViewerReady) return;
      if (failure.code == HistoryErrorCode.stale ||
          failure.code == HistoryErrorCode.invalidCursor) {
        emit(
          current.copyWith(
            loadingOlder: false,
            issue: failure.code,
            hasOlder: false,
            olderCursor: null,
          ),
        );
        await _reopen();
        return;
      }
      emit(current.copyWith(loadingOlder: false, issue: failure.code));
    }
  }

  /// Materialize one bounded body ref. Idempotent while loading/loaded.
  Future<void> loadBody(String eventId, HistoryBodyRef ref) async {
    final snapshot = state;
    if (snapshot is! HistoryViewerReady) return;
    final key = _bodyKey(eventId, ref);
    if (snapshot.bodies.containsKey(key)) return;
    final epoch = _epoch;
    // Re-read the state after the guard so two parallel expansions keep each
    // other's `loading` entry instead of overwriting the map.
    final before = state;
    if (before is! HistoryViewerReady) return;
    emit(
      before.copyWith(
        bodies: {...before.bodies, key: const HistoryBodyLoading()},
      ),
    );
    // The generation this body belongs to. A head change rewrites the sequence
    // and bumps the epoch, so a chunk that lands afterwards is dropped twice
    // over: by the epoch guard and by this snapshot check.
    final generation = snapshot.snapshot;
    try {
      final body = await _bodyLoader.load(
        epk: epk,
        daemonId: daemonId,
        sessionId: sessionId,
        snapshot: generation,
        ref: ref,
      );
      if (_isStale(epoch)) return;
      final current = state;
      if (current is! HistoryViewerReady) return;
      if (current.snapshot != generation) return;
      emit(
        current.copyWith(
          bodies: _pruneBodies({
            ...current.bodies,
            key: HistoryBodyLoaded(
              representation: body.representation,
              text: body.text,
              bytes: body.bytes,
              mime: body.mime,
            ),
          }),
        ),
      );
    } on HistoryFailure catch (failure) {
      if (_isStale(epoch)) return;
      final current = state;
      if (current is! HistoryViewerReady) return;
      if (current.snapshot != generation) return;
      emit(
        current.copyWith(
          bodies: {
            ...current.bodies,
            key: HistoryBodyUnavailable(failure.code),
          },
        ),
      );
    }
  }

  /// The explicit, user-confirmed "继续对话".
  ///
  /// Preflight (identity + current runtime) → at most ONE `session_switch` →
  /// dedicated target watch. A missed ACK NEVER re-sends. The caller navigates
  /// only after the host has confirmed the target as current, so the composer
  /// on the chat screen can never send into the previous session.
  Future<HistoryContinueOutcome> continueToChat() async {
    if (_continuing) return HistoryContinueOutcome.failed;
    final now = state;
    if (now is! HistoryViewerReady) return HistoryContinueOutcome.failed;
    // Target identity: the page must still be the session whose Continue was
    // tapped, and the host's own row must agree.
    if (now.session.id != sessionId) {
      _setContinueError(HistoryErrorCode.invalidRequest);
      return HistoryContinueOutcome.failed;
    }
    if (!_conn.isConnected(epk)) {
      _setContinueError(HistoryErrorCode.offline);
      return HistoryContinueOutcome.failed;
    }
    final room = (roomId != null && roomId!.isNotEmpty)
        ? roomId!
        : _resolveRoom();
    if (room == null || room.isEmpty) {
      _setContinueError(HistoryErrorCode.unavailable);
      return HistoryContinueOutcome.failed;
    }

    final intent = ++_continueGeneration;
    _continuing = true;
    _continueReportedAlreadyCurrent = false;
    _updateReady(
      (s) => s.copyWith(
        continuing: true,
        waitingForTarget: false,
        startingWorkspace: false,
        continueError: null,
        continueRefusal: null,
      ),
    );
    try {
      HistoryWorkspaceListing? listing;
      HistoryFailure? preflightFailure;
      try {
        listing = await _preflight(intent);
      } on HistoryFailure catch (failure) {
        preflightFailure = failure;
      }
      if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;

      var effectiveRoom = room;
      // Already current AND live: nothing to change, zero switches.
      if (listing != null &&
          listing.current.sessionId == sessionId &&
          _repo.isRoomLive(epk, effectiveRoom)) {
        await _persistSelection(effectiveRoom);
        if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
        _continueReportedAlreadyCurrent = true;
        _updateReady((s) => s.copyWith(openChat: true));
        return HistoryContinueOutcome.alreadyCurrent;
      }

      if (!_repo.isRoomLive(epk, effectiveRoom)) {
        // EXPLICIT continue may start the Pi; browsing never does. A switch
        // sent into a room with no listener is silently dropped, so the start
        // is a real precondition, not an optimization.
        _updateReady(
          (s) => s.copyWith(startingWorkspace: true, waitingForTarget: false),
        );
        final HistoryWorkspaceLaunch launch;
        try {
          launch = await _repo.startWorkspace(
            epk: epk,
            daemonId: daemonId,
            cwd: cwd,
          );
        } on HistoryFailure catch (failure) {
          if (_isContinueStale(intent)) {
            return HistoryContinueOutcome.superseded;
          }
          _setContinueError(failure.code);
          return HistoryContinueOutcome.failed;
        }
        if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
        effectiveRoom = launch.roomId;
        final live = await _waitForRoomLive(effectiveRoom, intent);
        if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
        if (!live) {
          _setContinueError(HistoryErrorCode.startFailed);
          return HistoryContinueOutcome.failed;
        }
        // Re-verify the runtime current after the start: the host may have
        // restored the target, in which case the switch is unnecessary.
        try {
          listing = await _preflight(intent, roomOverride: effectiveRoom);
          preflightFailure = null;
        } on HistoryFailure catch (failure) {
          preflightFailure = failure;
        }
        if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
        if (listing != null && listing.current.sessionId == sessionId) {
          await _persistSelection(effectiveRoom);
          if (_isContinueStale(intent)) {
            return HistoryContinueOutcome.superseded;
          }
          _continueReportedAlreadyCurrent = true;
          _updateReady((s) => s.copyWith(openChat: true));
          return HistoryContinueOutcome.alreadyCurrent;
        }
        _updateReady((s) => s.copyWith(startingWorkspace: false));
      }

      // The target/current could not be verified, so a state-changing switch
      // must not be sent. (The page identity alone proves the session existed
      // when it was read, not what the runtime is doing now.)
      if (preflightFailure != null) {
        _setContinueError(preflightFailure.code);
        return HistoryContinueOutcome.failed;
      }

      try {
        await _repo.switchOnce(
          epk: epk,
          roomId: effectiveRoom,
          sessionId: sessionId,
          ackTimeout: _switchAckTimeout,
        );
      } on HistoryFailure catch (failure) {
        if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
        if (failure.code != HistoryErrorCode.timeout) {
          _setContinueError(failure.code, refusal: failure.switchRefusal);
          return HistoryContinueOutcome.failed;
        }
        // The frame went out and the ACK missed its slice. Watch for the
        // effect — a second send would be a second Pi spawn.
      }
      if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;

      _updateReady(
        (s) => s.copyWith(waitingForTarget: true, startingWorkspace: false),
      );
      final bool settled;
      try {
        settled = await _watchForTarget(intent, roomOverride: effectiveRoom);
      } on HistoryFailure catch (failure) {
        if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
        _setContinueError(failure.code);
        return HistoryContinueOutcome.failed;
      }
      if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
      if (!settled) {
        _setContinueError(HistoryErrorCode.timeout);
        return HistoryContinueOutcome.failed;
      }
      await _persistSelection(effectiveRoom);
      if (_isContinueStale(intent)) return HistoryContinueOutcome.superseded;
      _updateReady((s) => s.copyWith(openChat: true));
      return HistoryContinueOutcome.switched;
    } finally {
      _continuing = false;
      if (!_isContinueStale(intent)) {
        _updateReady(
          (s) => s.copyWith(continuing: false, waitingForTarget: false),
        );
      }
    }
  }

  /// True after [continueToChat] returned `alreadyCurrent` for this mount.
  bool get reportedAlreadyCurrent => _continueReportedAlreadyCurrent;

  /// P0 — called from a post-frame callback once a REAL item is painted.
  void reportFirstContent() {
    if (_firstContentReported) return;
    final sample = _firstPaintSample;
    if (sample == null) return;
    _firstContentReported = true;
    _repo.recordMetric(
      sample.copyWith(firstContentMs: _mount.elapsedMilliseconds),
    );
  }

  @override
  void dispose() {
    _epoch++;
    _continueGeneration++;
    _retryTimer?.cancel();
    _retryTimer = null;
    super.dispose();
  }

  // ---- Loading ------------------------------------------------------------

  Future<void> _bootstrap() async {
    final epoch = ++_epoch;
    final cached = _repo.cachedNewestPage(epk, daemonId, sessionId);
    if (cached != null) {
      final applyMs = _mount.elapsedMilliseconds;
      emit(
        HistoryViewerReady(
          session: cached.session.id == sessionId
              ? cached.session
              : HistorySessionInfo(id: sessionId),
          snapshot: cached.snapshot,
          revision: cached.revision,
          projection: cached.projection,
          items: cached.items,
          olderCursor: cached.olderCursor,
          hasOlder: cached.hasOlder,
          staleLabel: true,
          fromCache: true,
        ),
      );
      viewportStage = HistoryStageMetrics.begin(
        'history_read',
        cache: true,
        intentUs: _stageIntentUs,
      )?..applied(cached.items.length);
      _captureFirstPaint(
        items: cached.items.length,
        cacheHit: true,
        queueMs: 0,
        wireMs: null,
        decodeApplyMs: applyMs,
      );
      // Revalidate the painted cache with a conditional HEAD read: the cached
      // snapshot is NOT pinned, so a trusted append is answered with the new
      // head page instead of `not_modified`.
      await _loadNewest(epoch, ifRevision: cached.revision);
      return;
    }
    await _loadNewest(epoch);
  }

  /// Fetches the newest page.
  ///
  /// [ifRevision] is a conditional head read. There is deliberately NO
  /// `snapshot` parameter: the newest page must never be bound to a
  /// client-held generation, otherwise the host could certify an old head with
  /// a new file revision after an append. Older pages are the only callers that
  /// carry an opaque snapshot (see [loadOlder]).
  Future<void> _loadNewest(int epoch, {String? ifRevision}) async {
    _requestClock = Stopwatch()..start();
    final stage = HistoryStageMetrics.begin(
      'history_read',
      intentUs: _stageIntentUs,
    );
    // Building retries share the opening/refresh intent; request_us still
    // measures each attempt separately. Do not hide the cold-build wait.
    try {
      final page = await HistoryStageMetrics.request(
        stage,
        () => _repo.readSession(
          HistorySessionQuery(
            epk: epk,
            daemonId: daemonId,
            sessionId: sessionId,
            cwd: cwd,
            roomId: roomId,
            limit: _pageLimit,
            ifRevision: ifRevision,
          ),
        ),
      );
      if (_isStale(epoch)) return;
      _retryAttempts = 0;
      _buildingSince = null;
      final previous = state;
      final headChanged =
          previous is HistoryViewerReady && previous.snapshot != page.snapshot;
      if (headChanged) {
        // A new head generation REPLACES the entire page sequence (items,
        // older cursor, paging flags all come from the new page below) and
        // FENCES every older/body request still in flight under the previous
        // generation, so a late reply can never be spliced into this window.
        _epoch++;
        _retryTimer?.cancel();
        _retryAttempts = 0;
        _buildingSince = null;
      }
      emit(
        HistoryViewerReady(
          session: page.session,
          snapshot: page.snapshot,
          revision: page.revision,
          projection: page.projection,
          items: page.items,
          olderCursor: page.olderCursor,
          hasOlder: page.hasOlder,
          staleLabel: false,
          fromCache: false,
        ),
      );
      viewportStage = stage?..applied(page.items.length);
      _captureFirstPaint(
        items: page.items.length,
        cacheHit: false,
        queueMs: page.queueMs,
        wireMs: page.wireMs,
        decodeApplyMs: _requestClock?.elapsedMilliseconds ?? 0,
      );
    } on HistoryFailure catch (failure) {
      stage?.failed = true;
      if (_isStale(epoch)) return;
      if (failure.code == HistoryErrorCode.notModified) {
        _updateReady(
          (s) => s.copyWith(staleLabel: false, fromCache: true, issue: null),
        );
        return;
      }
      if (failure.code == HistoryErrorCode.building) {
        _scheduleBuildingRetry(
          epoch,
          failure.retryAfterMs,
          ifRevision: ifRevision,
        );
        return;
      }
      if (failure.code == HistoryErrorCode.stale ||
          failure.code == HistoryErrorCode.invalidCursor) {
        _repo.invalidateSession(epk, daemonId, sessionId);
        await _reopen();
        return;
      }
      _applyReadFailure(epoch, failure.code);
    }
  }

  Future<void> _reopen() async {
    if (_reopening) return;
    _reopening = true;
    try {
      final epoch = ++_epoch;
      _retryTimer?.cancel();
      _retryAttempts = 0;
      _buildingSince = null;
      emit(const HistoryViewerLoading());
      await _loadNewest(epoch);
    } finally {
      _reopening = false;
    }
  }

  void _scheduleBuildingRetry(
    int epoch,
    int? retryAfterMs, {
    String? ifRevision,
  }) {
    _retryTimer?.cancel();
    if (epoch != _epoch) return;
    _buildingSince ??= DateTime.now();
    if (_retryAttempts >= _maxBuildingRetries ||
        DateTime.now().difference(_buildingSince!) > _buildingBudget) {
      _applyReadFailure(epoch, HistoryErrorCode.internal);
      return;
    }
    _retryAttempts++;
    final delay = Duration(
      milliseconds: (retryAfterMs ?? 250).clamp(25, 500).toInt(),
    );
    _retryTimer = Timer(delay, () {
      if (isDisposed || epoch != _epoch) return;
      // ignore: discarded_futures
      _loadNewest(epoch, ifRevision: ifRevision);
    });
  }

  void _applyReadFailure(int epoch, HistoryErrorCode code) {
    if (_isStale(epoch)) return;
    final now = state;
    if (now is HistoryViewerReady) {
      emit(now.copyWith(issue: code, staleLabel: false, loadingOlder: false));
      return;
    }
    final recoverable = now is HistoryViewerError ? now.recoverable : null;
    emit(HistoryViewerError(code, recoverable: recoverable));
  }

  // ---- Explicit continue helpers -----------------------------------------

  /// Polls the relay's room liveness after an EXPLICIT `workspace_start`.
  /// A switch cannot be delivered until the Pi has subscribed to its room.
  Future<bool> _waitForRoomLive(String room, int intent) async {
    final end = DateTime.now().add(_roomLiveBudget);
    while (DateTime.now().isBefore(end)) {
      if (_isContinueStale(intent)) return false;
      if (_repo.isRoomLive(epk, room)) return true;
      await Future<void>.delayed(_roomLivePollInterval);
    }
    return false;
  }

  Future<HistoryWorkspaceListing> _preflight(
    int intent, {
    String? roomOverride,
  }) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (true) {
      if (_isContinueStale(intent)) {
        throw const HistoryFailure(HistoryErrorCode.offline);
      }
      try {
        return await _repo.listWorkspace(
          HistoryWorkspaceQuery(
            epk: epk,
            daemonId: daemonId,
            cwd: cwd,
            roomId: roomOverride ?? roomId,
            limit: 50,
            bypassCache: true,
          ),
        );
      } on HistoryFailure catch (failure) {
        // `building` is a state; `timeout` is expected while a just-started
        // Pi is booting. Both are retried inside the SAME bounded window and
        // with ONE in-flight request (the repository single-flights the key).
        final retryable =
            failure.code == HistoryErrorCode.building ||
            failure.code == HistoryErrorCode.timeout;
        if (!retryable || DateTime.now().isAfter(deadline)) {
          rethrow;
        }
        await Future<void>.delayed(
          Duration(
            milliseconds: (failure.retryAfterMs ?? 250).clamp(25, 500).toInt(),
          ),
        );
      }
    }
  }

  /// Polls the host's runtime snapshot until it reports [sessionId] as current.
  /// Throws only on an unrecoverable condition (offline / not_found); a booting
  /// Pi answers `timeout`/`building`, which is expected and retried.
  Future<bool> _watchForTarget(int intent, {String? roomOverride}) async {
    final end = DateTime.now().add(_switchSettleBudget);
    while (DateTime.now().isBefore(end)) {
      if (_isContinueStale(intent)) return false;
      try {
        final listing = await _repo.listWorkspace(
          HistoryWorkspaceQuery(
            epk: epk,
            daemonId: daemonId,
            cwd: cwd,
            roomId: roomOverride ?? roomId,
            limit: 50,
            bypassCache: true,
          ),
        );
        if (_isContinueStale(intent)) return false;
        if (listing.current.sessionId == sessionId) return true;
      } on HistoryFailure catch (failure) {
        if (_isContinueStale(intent)) return false;
        if (failure.code == HistoryErrorCode.offline ||
            failure.code == HistoryErrorCode.notFound) {
          rethrow;
        }
        // A room that is respawning is silent/unavailable; keep watching.
      }
      await Future<void>.delayed(_watchPollInterval);
    }
    return false;
  }

  Future<void> _persistSelection(String room) async {
    await _prefs.setSelectedPeerEpk(epk);
    await _prefs.setSelectedRoom(epk: epk, roomId: room);
  }

  String? _resolveRoom() {
    for (final room in _conn.roomsFor(epk)) {
      if (cwd != null && cwd!.isNotEmpty && room.cwd == cwd) {
        return room.roomId;
      }
    }
    final rooms = _conn.roomsFor(epk);
    return rooms.length == 1 ? rooms.first.roomId : null;
  }

  void _setContinueError(
    HistoryErrorCode code, {
    HistorySwitchRefusal? refusal,
  }) {
    _updateReady(
      (s) => s.copyWith(
        continueError: code,
        continueRefusal: refusal,
        waitingForTarget: false,
        startingWorkspace: false,
      ),
    );
  }

  // ---- Small helpers ------------------------------------------------------

  void _updateReady(HistoryViewerReady Function(HistoryViewerReady) update) {
    final now = state;
    if (now is HistoryViewerReady) emit(update(now));
  }

  bool _isStale(int epoch) => isDisposed || epoch != _epoch;

  bool _isContinueStale(int intent) =>
      isDisposed || intent != _continueGeneration;

  /// Merge a continuation of the same event (stable `event_id`) from an older
  /// page. Only the base contract is used: the first item's event/entry identity
  /// and event payload are kept (stable paint), body refs are unioned by
  /// `field|ref`, and `parent`/`truncated` are OR-ed. This is what lets a host
  /// continue a pathological entry without a variant API and without the client
  /// silently forgetting refs it already received.
  static HistoryItem _mergeItem(HistoryItem existing, HistoryItem incoming) {
    final refs = <String, HistoryBodyRef>{};
    for (final ref in existing.bodyRefs) {
      refs['${ref.field}|${ref.ref}'] = ref;
    }
    for (final ref in incoming.bodyRefs) {
      refs.putIfAbsent('${ref.field}|${ref.ref}', () => ref);
    }
    return HistoryItem(
      eventId: existing.eventId,
      entryId: existing.entryId,
      event: existing.event,
      bodyRefs: refs.values.toList(),
      parent: existing.parent || incoming.parent,
      truncated: existing.truncated || incoming.truncated,
    );
  }

  String _bodyKey(String eventId, HistoryBodyRef ref) =>
      '$eventId|${ref.stateKey}';

  static int _bodyBytes(HistoryBodyState state) {
    if (state is! HistoryBodyLoaded) return 0;
    // UTF-16 units * 2 is a conservative in-memory estimate for text; the
    // byte list is exact.
    return (state.text?.length ?? 0) * 2 + (state.bytes?.length ?? 0);
  }

  Map<String, HistoryBodyState> _pruneBodies(
    Map<String, HistoryBodyState> bodies,
  ) {
    final result = Map<String, HistoryBodyState>.from(bodies);
    var total = 0;
    final loaded = <String>[];
    for (final entry in result.entries) {
      if (entry.value is HistoryBodyLoaded) {
        loaded.add(entry.key);
        total += _bodyBytes(entry.value);
      }
    }
    while (loaded.length > _maxLoadedBodies || total > _maxLoadedBodyBytes) {
      if (loaded.isEmpty) break;
      final drop = loaded.removeAt(0);
      total -= _bodyBytes(result[drop] ?? const HistoryBodyLoading());
      result.remove(drop);
    }
    return result;
  }

  void _captureFirstPaint({
    required int items,
    required bool cacheHit,
    required int? queueMs,
    required int? wireMs,
    required int decodeApplyMs,
  }) {
    if (_firstPaintCaptured || items == 0) return;
    _firstPaintCaptured = true;
    _firstPaintSample = HistoryMetricSample(
      op: 'history_read',
      queueMs: queueMs,
      wireMs: wireMs,
      decodeApplyMs: decodeApplyMs,
      cacheHit: cacheHit,
      items: items,
    );
  }
}
