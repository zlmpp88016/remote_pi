import 'dart:convert';

// QR URI format:
//   remotepi://pair?t=<base64url>&epk=<base64url>&n=<name>[&r=<url>][&rm=<roomId>]
//
// Fields:
//   t   — token efêmero (16 bytes, base64url), single-use, valid 60s
//   epk — Ed25519 pubkey do Pi (32 bytes) — único peer ID no relay
//   n   — session name (max 80 chars)
//   r   — relay WebSocket URL (OPTIONAL since plan 14: app uses its own
//         configured relay; legacy QR codes that carry `r` are tolerated
//         and trigger a "trocar relay?" modal if the value mismatches
//         the user's configured relay).
//   rm  — Pi-side room id this QR was generated FROM (plan 17 fix —
//         lets the app address the right cwd-session on the very first
//         pair_request, otherwise the relay drops with
//         "dest (peer, room) not found"). Optional; legacy QRs without
//         `rm` make the app fall back to `'main'` during pair_request
//         and rely on subscribe_rooms-based discovery afterwards.

class PairPayload {
  final String token;
  final String epk; // base64url Ed25519 — relay peer ID
  /// Optional legacy relay URL embedded in the QR. `null` for new QRs.
  /// Use `pair_request_flow` to detect mismatch vs `Preferences.relayUrl`.
  final String? relayUrl;
  final String sessionName;
  /// Plan 17 fix: Pi-side room id (cwd-session). Used as the outer
  /// envelope's `room` on pair_request so the relay can route to the
  /// right Pi-WS. `null` for pre-plan-17 QRs — caller must fall back to
  /// `'main'` and discover the real room id via subscribe_rooms.
  final String? roomId;

  const PairPayload({
    required this.token,
    required this.epk,
    required this.sessionName,
    this.relayUrl,
    this.roomId,
  });

  static PairPayload? tryParse(String raw) {
    try {
      final uri = Uri.parse(raw);
      if (uri.scheme != 'remotepi' || uri.host != 'pair') return null;
      final t = uri.queryParameters['t'];
      final epk = uri.queryParameters['epk'];
      final r = uri.queryParameters['r']; // legacy/optional
      final n = uri.queryParameters['n'];
      final rm = uri.queryParameters['rm']; // plan 17 — Pi-side room
      // r is no longer required — plan 14 dropped it from the canonical
      // contract. Legacy QRs continue to include it; we capture it for
      // mismatch detection but don't reject when absent.
      // rm is optional too — legacy remote-pi didn't emit it, and
      // the app falls back to 'main' / discovery in that case.
      if (t == null || epk == null || n == null) return null;
      /*
       * `t` is OPAQUE to the client — the host compares it against the record it
       * issued. It used to be validated as "16 bytes of base64url" because that
       * is what `randomBytes(16).toString('base64url')` produces, but an operator
       * may now pin a human-chosen code (`set-pairing-code FIXED-4180`, 4-128
       * chars of A-Z a-z 0-9 - _), and those are not 16 bytes of base64url.
       *
       * Rejecting them here was a real defect: the code the server printed as
       * valid was refused by the app before a single byte went out, with the
       * useless message "this is not a Remote Pi pairing code". The charset and
       * length bound below are the ones the server enforces on the way in; the
       * authority on whether a token is ACCEPTED is the host's `consume()`.
       */
      if (!RegExp(r'^[A-Za-z0-9_-]{4,128}$').hasMatch(t)) return null;
      if (base64Url.decode(_pad(epk)).length != 32) return null;
      return PairPayload(
        token: t,
        epk: epk,
        sessionName: n,
        relayUrl: (r != null && r.isNotEmpty) ? r : null,
        roomId: (rm != null && rm.isNotEmpty) ? rm : null,
      );
    } catch (_) {
      return null;
    }
  }

  List<int> get epkBytes => base64Url.decode(_pad(epk));

  static String _pad(String s) {
    final p = (4 - s.length % 4) % 4;
    return s + '=' * p;
  }
}
