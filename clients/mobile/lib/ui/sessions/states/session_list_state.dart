import 'package:app/protocol/protocol.dart';

sealed class SessionListState {
  const SessionListState();
}

class SessionListLoading extends SessionListState {
  const SessionListLoading();
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
