/// Plan/31 — out-of-band signals that don't fit the message DB but drive UI
/// affordances (banners, redirects). Surfaced by [SyncService] on a side
/// stream; the chat ViewModel reacts. (Relocated from the removed
/// `ISessionRepository`.)
sealed class SessionEvent {
  const SessionEvent();
}

/// The Mac dropped this device from its `peers.json` — the chat is dead and
/// the user must re-pair (relay returned an `unknown_peer` error).
class PairingRevoked extends SessionEvent {
  const PairingRevoked();
}

/// The Pi sent a `bye` and closed the channel gracefully. `rawReason` is the
/// wire value (e.g. `peer_stop`, `session_replaced`, `shutdown`).
class PeerWentOffline extends SessionEvent {
  final String rawReason;
  const PeerWentOffline(this.rawReason);
}

/// Plan 01 — paging availability for the transcript. `cursor` is the opaque
/// marker the Pi expects back in `session_sync.before`; it is released when a
/// new `session_history` arrives (a fresh sync invalidates the old chain).
class OlderPageState {
  final bool hasOlder;
  final String? cursor;
  const OlderPageState(this.hasOlder, this.cursor);
}
