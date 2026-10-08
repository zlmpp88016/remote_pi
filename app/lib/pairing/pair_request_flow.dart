// PairRequest flow — replaces the Noise XX handshake removed by plan 06.
//
// Sequence (over a connected PeerTransport):
//   1. App sends inner JSON {type:"pair_request", id, token, device_name}
//   2. Pi validates token, persists peer, replies pair_ok | pair_error
//   3. App persists PeerRecord on success
//
// No cipher, no safety number — the outer envelope's `ct` is base64 of
// the JSON in plaintext (transparent to PeerTransport implementations).

import 'dart:convert';
import 'dart:typed_data';

import 'package:app/data/transport/relay_config.dart';
import 'package:app/protocol/protocol.dart' show PairOk;
import 'package:app/protocol/uuid7.dart';

import 'pair_payload.dart';
import 'storage.dart';

// ---------------------------------------------------------------------------
// PeerTransport — minimal byte-level interface (was NoiseTransport pre-rollback)
// ---------------------------------------------------------------------------

abstract class PeerTransport {
  Future<void> send(Uint8List data);
  Future<Uint8List> receive();
  Future<void> close();
}

// ---------------------------------------------------------------------------
// PairingError
// ---------------------------------------------------------------------------

class PairingError implements Exception {
  final String code;
  final String message;
  const PairingError({required this.code, required this.message});

  @override
  String toString() => 'PairingError($code): $message';
}

// ---------------------------------------------------------------------------
// PairingResult — output of [performPairing]
// ---------------------------------------------------------------------------

/// Wraps the persisted [PeerRecord] plus side hints the post-pair UI
/// (nickname modal) needs but that don't belong on the PeerRecord
/// itself. Plan/27 Wave A added [hostnameHint] so the modal can
/// pre-fill "Mac do Jacob" instead of the generic "Pi"; legacy Pis
/// that don't emit `hostname` leave it null and the modal falls back
/// to `peer.sessionName`.
class PairingResult {
  final PeerRecord peer;
  final String? hostnameHint;
  const PairingResult({required this.peer, this.hostnameHint});
}

// ---------------------------------------------------------------------------
// performPairing
// ---------------------------------------------------------------------------

Future<PairingResult> performPairing({
  required PairPayload qr,
  required PeerTransport transport,
  required PairingStorage storage,
  required String deviceName,
  /// Effective relay URL the app is currently connected to. Used to
  /// detect mismatch vs `qr.relayUrl` for legacy QRs. Passed in by
  /// the caller (PairingViewModel reads it from Preferences).
  required String currentRelayUrl,
}) async {
  // A QR generated since this fix carries the Pi's relay as `r`. When present
  // it WINS over the app's preference: the whole point is that a self-hosted
  // relay is discoverable from the pairing code alone, so pairing must dial
  // the relay the Pi is actually on. Legacy QRs (no `r`) keep using the
  // preference. Comparison is normalized so cosmetic differences
  // (trailing slash, host case, http↔ws) never produce a false mismatch.
  if (qr.relayUrl != null && !relayUrlsMatch(qr.relayUrl!, currentRelayUrl)) {
    throw PairingError(
      code: 'relay_mismatch',
      message: 'QR points to "${qr.relayUrl}", '
          'but the app is configured for "$currentRelayUrl". '
          'Update the relay in settings or ask the Pi to generate '
          'a new QR.',
    );
  }

  // Plan 17 fix — set the outer envelope's `room` BEFORE sending
  // pair_request. Without this the relay would route to
  // (peer=Pi, room='main') which usually doesn't exist (Pi-ext is in
  // room=<hashOfCwd>) and drop with "dest not found". For legacy QRs
  // that don't carry `rm`, falls back to 'main' — the new
  // ConnectionManager discovery flow patches it up afterwards.
  final pairingRoomId = qr.roomId ?? 'main';
  try {
    (transport as dynamic).setActiveRoom(pairingRoomId);
  } catch (_) {
    // Non-WS transports (tests with in-memory pipes) don't track room —
    // routing is symbolic there, so no harm done.
  }

  final id = uuid7();
  final req = {
    'type': 'pair_request',
    'id': id,
    'token': qr.token,
    'device_name': deviceName,
  };
  await transport.send(Uint8List.fromList(utf8.encode(jsonEncode(req))));

  final inner = await _nextPairReply(transport, id);
  final type = inner['type'];

  if (type == 'pair_ok') {
    // Parse via the canonical decoder so PairOk schema evolutions
    // (plan/27 Wave A: `harness`, `hostname`) land in one place.
    final pairOk = PairOk.fromJson(inner);
    // Plan 17 fix — persist the Pi-confirmed room_id (or fall back to
    // the one carried by the QR, then to 'main'). Stored on the
    // PeerRecord so subsequent reconnects address (peer, room)
    // correctly from the very first frame.
    //
    // `PairOk.roomId` defaults to 'main' when the Pi omits the field
    // (plan-17 contract codified in tests). We peek at the raw map to
    // tell "Pi explicitly said main" from "Pi didn't send a room" —
    // only in the latter case do we want to fall back to qr.roomId.
    final rawRoom = inner['room_id'];
    final piEchoedRoom = rawRoom is String && rawRoom.isNotEmpty;
    final piRoomId = piEchoedRoom
        ? pairOk.roomId
        : (qr.roomId ?? 'main');
    final peer = PeerRecord(
      remoteEpk: qr.epk,
      sessionName: pairOk.sessionName,
      // Persist whichever relay we just paired on. For legacy QRs
      // this equals qr.relayUrl (we'd have thrown above otherwise);
      // for new QRs (no `r`) it's the currently configured relay.
      relayUrl: qr.relayUrl ?? currentRelayUrl,
      pairedAt: DateTime.now().toUtc().toIso8601String(),
      roomId: piRoomId,
      // Plan/27 Wave A — null when pi-extension hasn't been upgraded
      // yet to publish `harness` in pair_ok.
      harness: pairOk.harness,
    );
    await storage.savePeer(peer);
    return PairingResult(peer: peer, hostnameHint: pairOk.hostname);
  }

  // The helper only returns `pair_ok` or `pair_error`, so reaching here
  // means the Pi refused the request.
  throw PairingError(
    code: inner['code'] as String? ?? 'pair_error',
    message: inner['message'] as String? ?? '',
  );
}

/// Reads frames until the reply to [id] arrives.
///
/// The pairing transport is a full-duplex relay channel, not a
/// request/response pipe: while the `pair_request` -> `pair_ok` exchange is
/// in flight, the Pi also pushes broadcasts on that same channel. The most
/// immediate one is the `runtime_status` seed it sends the moment the device
/// is attached — which lands BEFORE the `pair_ok`, because attachment happens
/// before the reply is written. Reading a single frame made the app report
/// "Unknown response type: runtime_status" and drop an otherwise successful
/// pairing.
///
/// Skip every frame that is not the correlated reply. The caller wraps this
/// in `.timeout(...)`, which keeps the loop bounded when the Pi never answers.
Future<Map<String, dynamic>> _nextPairReply(
  PeerTransport transport,
  String id,
) async {
  while (true) {
    final raw = await transport.receive();
    final Object? decoded;
    try {
      decoded = jsonDecode(utf8.decode(raw));
    } catch (_) {
      // Undecodable frame — by definition not the correlated reply. The
      // caller's `.timeout(...)` still bounds the loop, so noise can never
      // hang pairing.
      continue;
    }
    if (decoded is! Map<String, dynamic>) continue;
    final type = decoded['type'];
    final isReply = type == 'pair_ok' || type == 'pair_error';
    if (isReply && decoded['in_reply_to'] == id) return decoded;
  }
}

/// Convenience overload that derives `currentRelayUrl` from a
/// [Preferences]-aware caller. Use directly from production code; tests
/// can still call [performPairing] with an explicit URL.
Future<PairingResult> performPairingWithRelay(
  String currentRelayUrl, {
  required PairPayload qr,
  required PeerTransport transport,
  required PairingStorage storage,
  required String deviceName,
}) =>
    performPairing(
      qr: qr,
      transport: transport,
      storage: storage,
      deviceName: deviceName,
      currentRelayUrl: currentRelayUrl,
    );

// Silence "unused" once we wire helpers from caller-side; relay_config
// is intentionally imported because PairingViewModel and tests may
// resolve currentRelayUrl via it.
// ignore: unused_element
void _keepRelayConfigImport() => resolveRelayUrl;

