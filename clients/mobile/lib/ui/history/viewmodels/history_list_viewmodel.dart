// Plan 86 P4 — workspace history list ViewModel (read-only, zero Pi).
//
// Opening a workspace lands here directly: the constructor paints the skeleton
// immediately and asks the HOST for the session catalog. It never calls
// `workspace_start`, never waits for a Pi and never issues `session_switch`.
//
// A cached first page is painted at once and revalidated with `if_revision`
// (`not_modified` keeps it); a cache hit is labelled [staleLabel] until that
// check lands. `building` is a state with bounded, single-flight retries — it
// is never presented as "no history".

import 'dart:async';

import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/domain/history/history_stage_metrics.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/history/states/history_list_state.dart';

class HistoryListViewModel extends ViewModel<HistoryListState> {
  HistoryListViewModel(
    this._repo, {
    required this.epk,
    required this.daemonId,
    this.cwd,
    this.roomId,
    this.title = '',
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       super(const HistoryListLoading()) {
    _mount.start();
    _stageIntentUs = HistoryStageMetrics.intentNow;
    // ignore: discarded_futures
    _bootstrap();
  }

  final HistoryRepository _repo;
  final DateTime Function() _now;
  final String epk;
  final String daemonId;
  final String? cwd;
  final String? roomId;
  final String title;

  /// Building retries are bounded (attempts AND wall time); a host that never
  /// finishes indexing must not spin this screen forever.
  static const _maxBuildingRetries = 20;
  static const _buildingBudget = Duration(seconds: 30);
  static const _pageLimit = 50;

  final Stopwatch _mount = Stopwatch();
  Stopwatch? _requestClock;

  /// Bumped by every explicit refresh/dispose. A late reply from a superseded
  /// request is dropped instead of being applied to the new screen state.
  int _epoch = 0;

  Timer? _retryTimer;
  int _retryAttempts = 0;
  DateTime? _buildingSince;

  String? _lastIfRevision;

  HistoryMetricSample? _firstPaintSample;
  bool _firstPaintCaptured = false;
  bool _firstContentReported = false;
  HistoryStageSpan? viewportStage;
  int? _stageIntentUs;

  Future<void> _bootstrap() async {
    final epoch = ++_epoch;
    _retryAttempts = 0;
    _buildingSince = null;
    final cached = _repo.cachedWorkspace(epk, daemonId);
    if (cached != null) {
      _lastIfRevision = cached.revision;
      final applyMs = _mount.elapsedMilliseconds;
      emit(
        HistoryListReady(
          sessions: cached.sessions,
          revision: cached.revision,
          indexState: cached.indexState,
          current: cached.current,
          nextCursor: cached.nextCursor,
          hasMore: cached.hasMore,
          staleLabel: true,
          fromCache: true,
        ),
      );
      viewportStage = HistoryStageMetrics.begin(
        'history_list',
        cache: true,
        intentUs: _stageIntentUs,
      )?..applied(cached.sessions.length);
      _captureFirstPaint(
        sessions: cached.sessions.length,
        cacheHit: true,
        queueMs: 0,
        wireMs: null,
        decodeApplyMs: applyMs,
      );
    } else {
      _lastIfRevision = null;
    }
    await _fetch(epoch, ifRevision: cached?.revision);
  }

  /// Manual refresh. Rows stay on screen while the request runs; a failure is
  /// a banner, not a blank screen.
  Future<void> refresh() async {
    _stageIntentUs = HistoryStageMetrics.intentNow;
    final epoch = ++_epoch;
    _retryTimer?.cancel();
    _retryAttempts = 0;
    _buildingSince = null;
    final now = state;
    if (now is HistoryListReady) {
      emit(now.copyWith(issue: null, staleLabel: now.revision != null));
      _lastIfRevision = now.revision;
    } else {
      emit(const HistoryListLoading());
      _lastIfRevision = null;
    }
    await _fetch(epoch, ifRevision: _lastIfRevision);
  }

  Future<void> _fetch(int epoch, {String? ifRevision}) async {
    _requestClock = Stopwatch()..start();
    final stage = HistoryStageMetrics.begin(
      'history_list',
      intentUs: _stageIntentUs,
    );
    // Building retries share the opening/refresh intent; request_us still
    // measures each attempt separately. Do not hide the cold-build wait.
    try {
      final listing = await HistoryStageMetrics.request(
        stage,
        () => _repo.listWorkspace(
          HistoryWorkspaceQuery(
            epk: epk,
            daemonId: daemonId,
            cwd: cwd,
            roomId: roomId,
            limit: _pageLimit,
            ifRevision: ifRevision,
          ),
        ),
      );
      stage?.mark('repository_return_us');
      if (_isStale(epoch)) return;
      _lastIfRevision = listing.revision;
      final previous = state is HistoryListReady
          ? state as HistoryListReady
          : null;

      if (listing.indexState == HistoryIndexState.building) {
        // Keep whatever rows are already readable; NEVER overwrite them with
        // an empty building page.
        emit(
          HistoryListReady(
            sessions: previous?.sessions ?? const [],
            revision: previous?.revision,
            indexState: HistoryIndexState.building,
            current: listing.current,
            nextCursor: previous?.nextCursor,
            hasMore: previous?.hasMore ?? false,
            staleLabel: previous?.staleLabel ?? true,
            fromCache: previous != null,
          ),
        );
        _scheduleBuildingRetry(epoch, listing.retryAfterMs);
        return;
      }
      if (listing.indexState == HistoryIndexState.unavailable) {
        _applyReadFailure(
          epoch,
          HistoryErrorCode.indexUnavailable,
          recoverable: previous,
        );
        return;
      }

      _retryAttempts = 0;
      _buildingSince = null;
      emit(
        HistoryListReady(
          sessions: listing.sessions,
          revision: listing.revision,
          indexState: HistoryIndexState.ready,
          current: listing.current,
          nextCursor: listing.nextCursor,
          hasMore: listing.hasMore,
          staleLabel: false,
          fromCache: false,
        ),
      );
      viewportStage = stage?..applied(listing.sessions.length);
      _captureFirstPaint(
        sessions: listing.sessions.length,
        cacheHit: false,
        queueMs: listing.queueMs,
        wireMs: listing.wireMs,
        decodeApplyMs: _requestClock?.elapsedMilliseconds ?? 0,
      );
    } on HistoryFailure catch (failure) {
      stage?.failed = true;
      if (_isStale(epoch)) return;
      if (failure.code == HistoryErrorCode.notModified) {
        _retryAttempts = 0;
        _buildingSince = null;
        // The cache is current: clear the label, keep the rows, no new pages.
        final now = state;
        if (now is HistoryListReady) {
          emit(now.copyWith(staleLabel: false, issue: null));
        }
        return;
      }
      if (failure.code == HistoryErrorCode.building) {
        final now = state;
        if (now is HistoryListReady) {
          emit(now.copyWith(indexState: HistoryIndexState.building));
        } else {
          emit(
            HistoryListReady(
              sessions: const [],
              revision: null,
              indexState: HistoryIndexState.building,
              current: HistoryCurrent.unknown,
            ),
          );
        }
        _scheduleBuildingRetry(epoch, failure.retryAfterMs);
        return;
      }
      _applyReadFailure(epoch, failure.code);
    } finally {}
  }

  /// Older page. `if_revision` is deliberately omitted: it would answer
  /// `not_modified` instead of the older page. The cursor is only trusted while
  /// the listing revision is unchanged — two generations are never spliced.
  Future<void> loadMore() async {
    final now = state;
    if (now is! HistoryListReady ||
        !now.hasMore ||
        now.nextCursor == null ||
        now.loadingMore ||
        now.building) {
      return;
    }
    final epoch = _epoch;
    final cursor = now.nextCursor!;
    final revision = now.revision;
    final stage = HistoryStageMetrics.begin('history_list_page');
    emit(now.copyWith(loadingMore: true, issue: null));
    try {
      final listing = await HistoryStageMetrics.request(
        stage,
        () => _repo.listWorkspace(
          HistoryWorkspaceQuery(
            epk: epk,
            daemonId: daemonId,
            cwd: cwd,
            roomId: roomId,
            limit: _pageLimit,
            before: cursor,
          ),
        ),
      );
      if (_isStale(epoch)) return;
      final current = state;
      if (current is! HistoryListReady) return;
      if (revision != null &&
          listing.revision != null &&
          listing.revision != revision) {
        // The listing generation changed between pages. Do not concatenate.
        emit(
          current.copyWith(loadingMore: false, issue: HistoryErrorCode.stale),
        );
        return;
      }
      final seen = {for (final s in current.sessions) s.id};
      final merged = [...current.sessions];
      for (final s in listing.sessions) {
        if (seen.add(s.id)) merged.add(s);
      }
      emit(
        current.copyWith(
          sessions: merged,
          nextCursor: listing.nextCursor,
          hasMore: listing.hasMore,
          loadingMore: false,
          issue: null,
        ),
      );
      viewportStage = stage?..applied(listing.sessions.length);
    } on HistoryFailure catch (failure) {
      stage?.failed = true;
      if (_isStale(epoch)) return;
      final current = state;
      if (current is! HistoryListReady) return;
      if (failure.code == HistoryErrorCode.invalidCursor ||
          failure.code == HistoryErrorCode.stale) {
        // The paging generation is gone: stop appending and refresh
        // deliberately. The rows stay visible until the new page lands.
        emit(
          current.copyWith(loadingMore: false, issue: HistoryErrorCode.stale),
        );
        await refresh();
        return;
      }
      emit(current.copyWith(loadingMore: false, issue: failure.code));
    }
  }

  /// Called by the page from a post-frame callback when it has painted the
  /// first REAL row. This is the P0 "firstContent" seam; a spinner mount never
  /// reports it.
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
    _retryTimer?.cancel();
    _retryTimer = null;
    super.dispose();
  }

  void _scheduleBuildingRetry(int epoch, int? retryAfterMs) {
    _retryTimer?.cancel();
    if (isDisposed || epoch != _epoch) return;
    _buildingSince ??= _now();
    final elapsed = _now().difference(_buildingSince!);
    if (_retryAttempts >= _maxBuildingRetries || elapsed >= _buildingBudget) {
      _applyReadFailure(epoch, HistoryErrorCode.internal);
      return;
    }
    // Both building envelopes share one budget. Back off instead of spending
    // all 20 retries in 500ms (or resetting the budget on every success).
    final suggestedMs = (retryAfterMs ?? 250).clamp(25, 1000).toInt();
    final backoffMs = 25 * (1 << _retryAttempts.clamp(0, 7).toInt());
    final waitMs = (suggestedMs > backoffMs ? suggestedMs : backoffMs)
        .clamp(25, 2000)
        .toInt();
    final remainingMs = (_buildingBudget - elapsed).inMilliseconds;
    final delay = Duration(
      milliseconds: waitMs < remainingMs ? waitMs : remainingMs,
    );
    _retryAttempts++;
    _retryTimer = Timer(delay, () {
      if (isDisposed || epoch != _epoch) return;
      _retryTimer = null;
      // The deadline is checked again after the timer: a slow response or a
      // suspended app must not start another request after this round expires.
      if (_now().difference(_buildingSince!) >= _buildingBudget) {
        _applyReadFailure(epoch, HistoryErrorCode.internal);
        return;
      }
      // ignore: discarded_futures
      _fetch(epoch, ifRevision: _lastIfRevision);
    });
  }

  void _applyReadFailure(
    int epoch,
    HistoryErrorCode code, {
    HistoryListReady? recoverable,
  }) {
    if (_isStale(epoch)) return;
    final now = state;
    final base =
        recoverable ??
        (now is HistoryListReady
            ? now
            : (now is HistoryListError ? now.recoverable : null));
    if (base != null) {
      emit(base.copyWith(issue: code, staleLabel: false, loadingMore: false));
      return;
    }
    emit(HistoryListError(code));
  }

  bool _isStale(int epoch) => isDisposed || epoch != _epoch;

  void _captureFirstPaint({
    required int sessions,
    required bool cacheHit,
    required int? queueMs,
    required int? wireMs,
    required int decodeApplyMs,
  }) {
    if (_firstPaintCaptured || sessions == 0) return;
    _firstPaintCaptured = true;
    _firstPaintSample = HistoryMetricSample(
      op: 'history_list',
      queueMs: queueMs,
      wireMs: wireMs,
      decodeApplyMs: decodeApplyMs,
      cacheHit: cacheHit,
      items: sessions,
    );
  }
}
