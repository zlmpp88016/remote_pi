// Plan 86 P4 — state of the workspace history list.
//
// `building` is a STATE (the host is still indexing), never "no history"; the
// screen keeps the skeleton and retries with one in-flight request. A cached
// page is painted immediately with [HistoryListReady.staleLabel] true until
// the host answers `not_modified` (verified) or a newer page replaces it.

import 'package:flutter/foundation.dart';
import 'package:mobile/domain/history/history_models.dart';

sealed class HistoryListState {
  const HistoryListState();
}

class HistoryListLoading extends HistoryListState {
  /// True when this skeleton sits on top of a cached paint that was dropped
  /// (it never replaces rows with a spinner).
  final bool cached;
  final String? message;

  const HistoryListLoading({this.cached = false, this.message});

  @override
  bool operator ==(Object other) =>
      other is HistoryListLoading &&
      other.cached == cached &&
      other.message == message;

  @override
  int get hashCode => Object.hash(cached, message);
}

class HistoryListError extends HistoryListState {
  final HistoryErrorCode code;

  /// Rows that were already on screen when an ACTION failed. Kept so the
  /// screen is never left with no rows at all.
  final HistoryListReady? recoverable;

  const HistoryListError(this.code, {this.recoverable});

  @override
  bool operator ==(Object other) =>
      other is HistoryListError &&
      other.code == code &&
      other.recoverable == recoverable;

  @override
  int get hashCode => Object.hash(code, recoverable);
}

const Object _kUnset = Object();

class HistoryListReady extends HistoryListState {
  final List<HistorySessionInfo> sessions;
  final String? revision;
  final HistoryIndexState indexState;
  final HistoryCurrent current;

  /// Cursor for the next older page, or null.
  final String? nextCursor;
  final bool hasMore;

  /// Painted from the bounded cache and not yet verified by the host.
  final bool staleLabel;

  /// True while an older page is in flight (rows stay tappable).
  final bool loadingMore;

  /// Last action failure shown as a banner above the rows.
  final HistoryErrorCode? issue;

  /// `true` when this state came from cache (used by metrics/tests).
  final bool fromCache;

  const HistoryListReady({
    required this.sessions,
    required this.revision,
    required this.indexState,
    required this.current,
    this.nextCursor,
    this.hasMore = false,
    this.staleLabel = false,
    this.loadingMore = false,
    this.issue,
    this.fromCache = false,
  });

  bool get building => indexState == HistoryIndexState.building;
  bool get unavailableIndex => indexState == HistoryIndexState.unavailable;

  HistoryListReady copyWith({
    List<HistorySessionInfo>? sessions,
    String? revision,
    HistoryIndexState? indexState,
    HistoryCurrent? current,
    Object? nextCursor = _kUnset,
    bool? hasMore,
    bool? staleLabel,
    bool? loadingMore,
    Object? issue = _kUnset,
    bool? fromCache,
  }) => HistoryListReady(
    sessions: sessions ?? this.sessions,
    revision: revision ?? this.revision,
    indexState: indexState ?? this.indexState,
    current: current ?? this.current,
    nextCursor: identical(nextCursor, _kUnset)
        ? this.nextCursor
        : nextCursor as String?,
    hasMore: hasMore ?? this.hasMore,
    staleLabel: staleLabel ?? this.staleLabel,
    loadingMore: loadingMore ?? this.loadingMore,
    issue: identical(issue, _kUnset) ? this.issue : issue as HistoryErrorCode?,
    fromCache: fromCache ?? this.fromCache,
  );

  @override
  bool operator ==(Object other) =>
      other is HistoryListReady &&
      listEquals(other.sessions, sessions) &&
      other.revision == revision &&
      other.indexState == indexState &&
      other.current == current &&
      other.nextCursor == nextCursor &&
      other.hasMore == hasMore &&
      other.staleLabel == staleLabel &&
      other.loadingMore == loadingMore &&
      other.issue == issue &&
      other.fromCache == fromCache;

  @override
  int get hashCode => Object.hash(
    Object.hashAll(sessions),
    revision,
    indexState,
    current,
    nextCursor,
    hasMore,
    staleLabel,
    loadingMore,
    issue,
    fromCache,
  );
}
