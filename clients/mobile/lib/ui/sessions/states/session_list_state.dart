import 'package:mobile/protocol/protocol.dart';

sealed class SessionListState {
  const SessionListState();
}

class SessionListLoading extends SessionListState {
  /// Why this is slow, when there is something to say. A cold start spends up
  /// to half a minute waiting for a Pi that is booting; an empty spinner looks
  /// exactly like the hang this screen used to have.
  final String? message;
  const SessionListLoading({this.message});
}

class SessionListError extends SessionListState {
  final String message;

  /// The list that was on screen when this happened, if the failure came from
  /// an ACTION (a tap) rather than from loading.
  ///
  /// A tapped session that fails to open must not erase the list: replacing
  /// `SessionListReady` with a full-screen error is why one refused switch made
  /// the whole screen unusable — there was no row left to tap again. Loading
  /// failures pass `null` and keep the full-screen form, because then there is
  /// genuinely no list to go back to.
  final SessionListReady? recoverable;

  const SessionListError(this.message, {this.recoverable});
}

class SessionListReady extends SessionListState {
  final List<WireSessionInfo> sessions;
  final String? currentId;

  /// The session id the user just tapped, while its transcript is still being
  /// fetched. Rows stay tappable-off (a second tap would race the first), but
  /// the tapped row shows a spinner instead of the whole list looking frozen.
  final String? openingId;
  final bool switching;

  /// The last failed open, shown as an inline banner above the list. Cleared by
  /// the next tap.
  final String? openError;

  const SessionListReady({
    required this.sessions,
    this.currentId,
    this.openingId,
    this.switching = false,
    this.openError,
  });

  SessionListReady copyWith({
    bool? switching,
    String? openingId,
    bool clearOpening = false,
    String? openError,
    bool clearOpenError = false,
  }) =>
      SessionListReady(
        sessions: sessions,
        currentId: currentId,
        openingId: clearOpening ? null : (openingId ?? this.openingId),
        switching: switching ?? this.switching,
        openError: clearOpenError ? null : (openError ?? this.openError),
      );
}
