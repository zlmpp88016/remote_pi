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
  const SessionListError(this.message);
}

class SessionListReady extends SessionListState {
  final List<WireSessionInfo> sessions;
  final String? currentId;
  final bool switching;
  const SessionListReady({
    required this.sessions,
    this.currentId,
    this.switching = false,
  });

  SessionListReady copyWith({bool? switching}) => SessionListReady(
    sessions: sessions,
    currentId: currentId,
    switching: switching ?? this.switching,
  );
}
