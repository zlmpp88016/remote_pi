/// Plan/31 — per-session activity (#5: idle | working).
enum SessionActivity { idle, working }

/// Plan/31 — durable top-level index of sessions, so Home can query
/// cross-session (working/idle + last message) without opening every
/// per-session box. Keyed by `<epk>:<roomId>` in the `sessions_index` box.
class SessionIndexRecord {
  final String epk;
  final String roomId;
  final String displayName;
  final SessionActivity status;
  final DateTime? lastMessageAt;
  final String? lastMessagePreview;
  final DateTime? sessionStartedAt;

  /// Which SESSION the rows of this workspace's (shared) message box belong to.
  ///
  /// The box is named per `(epk, room)`, so every session of a workspace writes
  /// into the same one and its rows only mean anything for the session that
  /// wrote them. Kept here, next to the rows' own index, because the binding has
  /// to survive a process kill: a box that answers "session A" in RAM only is
  /// re-read as a first sight after a restart, and then A's rows are shown as
  /// whatever session the Pi resumed (the cross-talk this whole record guards
  /// against). Null on records written before this field existed — those stay a
  /// first sight, which is what every box was until now.
  final String? sessionId;

  const SessionIndexRecord({
    required this.epk,
    required this.roomId,
    this.displayName = '',
    this.status = SessionActivity.idle,
    this.lastMessageAt,
    this.lastMessagePreview,
    this.sessionStartedAt,
    this.sessionId,
  });

  String get key => '$epk:$roomId';

  /// Every field is carried over unless given, so a busy/idle update never
  /// drops the session binding, and dropping the binding is only ever the job
  /// of a box wipe (which deletes this record whole).
  SessionIndexRecord copyWith({
    String? displayName,
    SessionActivity? status,
    DateTime? lastMessageAt,
    String? lastMessagePreview,
    DateTime? sessionStartedAt,
    String? sessionId,
  }) => SessionIndexRecord(
    epk: epk,
    roomId: roomId,
    displayName: displayName ?? this.displayName,
    status: status ?? this.status,
    lastMessageAt: lastMessageAt ?? this.lastMessageAt,
    lastMessagePreview: lastMessagePreview ?? this.lastMessagePreview,
    sessionStartedAt: sessionStartedAt ?? this.sessionStartedAt,
    sessionId: sessionId ?? this.sessionId,
  );

  Map<String, dynamic> toJson() => {
    'epk': epk,
    'room_id': roomId,
    'display_name': displayName,
    'status': status.name,
    'last_message_at': lastMessageAt?.millisecondsSinceEpoch,
    'last_message_preview': lastMessagePreview,
    'session_started_at': sessionStartedAt?.millisecondsSinceEpoch,
    'session_id': sessionId,
  };

  factory SessionIndexRecord.fromJson(Map<String, dynamic> j) {
    DateTime? ms(dynamic v) => v == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch((v as num).toInt());
    return SessionIndexRecord(
      epk: j['epk'] as String,
      roomId: j['room_id'] as String,
      displayName: (j['display_name'] as String?) ?? '',
      status: SessionActivity.values.firstWhere(
        (s) => s.name == j['status'],
        orElse: () => SessionActivity.idle,
      ),
      lastMessageAt: ms(j['last_message_at']),
      lastMessagePreview: j['last_message_preview'] as String?,
      sessionStartedAt: ms(j['session_started_at']),
      sessionId: j['session_id'] as String?,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is SessionIndexRecord &&
      other.epk == epk &&
      other.roomId == roomId &&
      other.displayName == displayName &&
      other.status == status &&
      other.lastMessageAt == lastMessageAt &&
      other.lastMessagePreview == lastMessagePreview &&
      other.sessionStartedAt == sessionStartedAt &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(
    epk,
    roomId,
    displayName,
    status,
    lastMessageAt,
    lastMessagePreview,
    sessionStartedAt,
    sessionId,
  );
}
