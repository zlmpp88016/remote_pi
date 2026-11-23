// Plan 86 P4 — state of the read-only history viewer.
//
// This state never contains a composer, never contains a "send" action and
// never references the live transcript writer. The only state-changing action
// is [HistoryViewerReady.continuing] — the explicit "继续对话" intent, gated by
// a confirmation in the page and released in a `finally`.

import 'package:flutter/foundation.dart';
import 'package:mobile/domain/history/history_models.dart';

sealed class HistoryViewerState {
  const HistoryViewerState();
}

class HistoryViewerLoading extends HistoryViewerState {
  final bool cached;
  final String? message;

  const HistoryViewerLoading({this.cached = false, this.message});

  @override
  bool operator ==(Object other) =>
      other is HistoryViewerLoading &&
      other.cached == cached &&
      other.message == message;

  @override
  int get hashCode => Object.hash(cached, message);
}

class HistoryViewerError extends HistoryViewerState {
  final HistoryErrorCode code;

  /// Rows kept from a cache or from a prior page so the screen is not empty
  /// just because a refresh failed.
  final HistoryViewerReady? recoverable;

  const HistoryViewerError(this.code, {this.recoverable});

  @override
  bool operator ==(Object other) =>
      other is HistoryViewerError &&
      other.code == code &&
      other.recoverable == recoverable;

  @override
  int get hashCode => Object.hash(code, recoverable);
}

/// Body materialization state, keyed by `eventId|field|ref`.
sealed class HistoryBodyState {
  const HistoryBodyState();
}

class HistoryBodyLoading extends HistoryBodyState {
  const HistoryBodyLoading();

  @override
  bool operator ==(Object other) => other is HistoryBodyLoading;

  @override
  int get hashCode => 0;
}

class HistoryBodyLoaded extends HistoryBodyState {
  final HistoryBodyRepresentation representation;
  final String? text;
  final List<int>? bytes;
  final String? mime;

  const HistoryBodyLoaded({
    required this.representation,
    this.text,
    this.bytes,
    this.mime,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryBodyLoaded &&
      other.representation == representation &&
      other.text == text &&
      other.mime == mime &&
      listEquals(other.bytes, bytes);

  @override
  int get hashCode => Object.hash(representation, text, mime, bytes?.length);
}

class HistoryBodyUnavailable extends HistoryBodyState {
  final HistoryErrorCode code;
  const HistoryBodyUnavailable(this.code);

  @override
  bool operator ==(Object other) =>
      other is HistoryBodyUnavailable && other.code == code;

  @override
  int get hashCode => code.hashCode;
}

const Object _kUnset = Object();

class HistoryViewerReady extends HistoryViewerState {
  final HistorySessionInfo session;

  /// Opaque snapshot generation the loaded page sequence belongs to. Older
  /// pages MUST carry the same value; a different one is never spliced in.
  final String snapshot;
  final String revision;
  final int projection;

  /// Ascending (oldest → newest), de-duplicated by `eventId`.
  final List<HistoryItem> items;

  final String? olderCursor;
  final bool hasOlder;
  final bool loadingOlder;

  /// Painted from cache and not yet verified by the host.
  final bool staleLabel;
  final bool fromCache;

  /// Last read/paging failure shown above the rows.
  final HistoryErrorCode? issue;

  /// Explicit-continue intent in flight. Only the continue affordance reads
  /// this; the viewer stays scrollable and paging stays usable.
  final bool continuing;

  /// True while the switch was sent but the host has not confirmed the target
  /// as current. Shown as an honest progress banner, never as a lock.
  final bool waitingForTarget;

  /// True while the EXPLICIT continue is starting a stopped workspace. Only
  /// the banner and the continue affordance read it; the viewer stays usable.
  final bool startingWorkspace;
  final HistoryErrorCode? continueError;

  /// Closed `session_switch_error` refusal, when [continueError] is
  /// `invalid_request`.
  final HistorySwitchRefusal? continueRefusal;

  /// Set by a SUCCESSFUL explicit continue (target already current OR one
  /// switch confirmed). The PAGE owns navigation: it pushes the live chat
  /// from a post-frame callback instead of creating a BuildContext-dependent
  /// async chain, so the transition cannot race a disposed viewer.
  final bool openChat;

  final Map<String, HistoryBodyState> bodies;

  const HistoryViewerReady({
    required this.session,
    required this.snapshot,
    required this.revision,
    this.projection = 1,
    required this.items,
    this.olderCursor,
    this.hasOlder = false,
    this.loadingOlder = false,
    this.staleLabel = false,
    this.fromCache = false,
    this.issue,
    this.continuing = false,
    this.waitingForTarget = false,
    this.startingWorkspace = false,
    this.continueError,
    this.continueRefusal,
    this.openChat = false,
    this.bodies = const {},
  });

  HistoryViewerReady copyWith({
    HistorySessionInfo? session,
    String? snapshot,
    String? revision,
    int? projection,
    List<HistoryItem>? items,
    Object? olderCursor = _kUnset,
    bool? hasOlder,
    bool? loadingOlder,
    bool? staleLabel,
    bool? fromCache,
    Object? issue = _kUnset,
    bool? continuing,
    bool? waitingForTarget,
    bool? startingWorkspace,
    Object? continueError = _kUnset,
    Object? continueRefusal = _kUnset,
    bool? openChat,
    Map<String, HistoryBodyState>? bodies,
  }) => HistoryViewerReady(
    session: session ?? this.session,
    snapshot: snapshot ?? this.snapshot,
    revision: revision ?? this.revision,
    projection: projection ?? this.projection,
    items: items ?? this.items,
    olderCursor: identical(olderCursor, _kUnset)
        ? this.olderCursor
        : olderCursor as String?,
    hasOlder: hasOlder ?? this.hasOlder,
    loadingOlder: loadingOlder ?? this.loadingOlder,
    staleLabel: staleLabel ?? this.staleLabel,
    fromCache: fromCache ?? this.fromCache,
    issue: identical(issue, _kUnset) ? this.issue : issue as HistoryErrorCode?,
    continuing: continuing ?? this.continuing,
    waitingForTarget: waitingForTarget ?? this.waitingForTarget,
    startingWorkspace: startingWorkspace ?? this.startingWorkspace,
    continueError: identical(continueError, _kUnset)
        ? this.continueError
        : continueError as HistoryErrorCode?,
    continueRefusal: identical(continueRefusal, _kUnset)
        ? this.continueRefusal
        : continueRefusal as HistorySwitchRefusal?,
    openChat: openChat ?? this.openChat,
    bodies: bodies ?? this.bodies,
  );

  @override
  bool operator ==(Object other) =>
      other is HistoryViewerReady &&
      other.session == session &&
      other.snapshot == snapshot &&
      other.revision == revision &&
      other.projection == projection &&
      listEquals(other.items, items) &&
      other.olderCursor == olderCursor &&
      other.hasOlder == hasOlder &&
      other.loadingOlder == loadingOlder &&
      other.staleLabel == staleLabel &&
      other.fromCache == fromCache &&
      other.issue == issue &&
      other.continuing == continuing &&
      other.waitingForTarget == waitingForTarget &&
      other.startingWorkspace == startingWorkspace &&
      other.continueError == continueError &&
      other.continueRefusal == continueRefusal &&
      other.openChat == openChat &&
      mapEquals(other.bodies, bodies);

  @override
  int get hashCode => Object.hash(
    session,
    snapshot,
    revision,
    projection,
    Object.hashAll(items),
    olderCursor,
    hasOlder,
    loadingOlder,
    staleLabel,
    fromCache,
    issue,
    continuing,
    waitingForTarget,
    startingWorkspace,
    continueError,
    continueRefusal,
    openChat,
    Object.hashAllUnordered(
      bodies.entries.map((e) => Object.hash(e.key, e.value)),
    ),
  );
}
