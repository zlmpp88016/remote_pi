// Plan/69 — host_forward/host_message proxy helpers (spike decision B).
//
// The app anchors on room `host` ONLY (`hello.room_id = "host"`): one
// connection cannot sustain room `host` plus workspace rooms because the
// app-side demux drops envelopes from a non-active room (spike E2c). So:
//
//   outbound  child-addressed inner → `host_forward{room, ct}` addressed to
//             (machine, "host"); host control-plane messages go direct.
//   inbound   the daemon answers on room "host"; child traffic arrives
//             wrapped as `host_message{room, ct}` and is unwrapped + filed
//             by room here.
//
// The OUTER envelope always addresses room `host`; the child room lives
// INSIDE the wrapper. Everything in this file is pure (no Flutter, no WS)
// so the wire contract is unit-testable without a relay.

import 'dart:convert';
import 'dart:typed_data';

/// Inner message types the HOST itself answers on room `host` — these must
/// never be wrapped in `host_forward`. Mirrors the `HostBridge` handler
/// switch in `pi-extension/src/daemon/host_bridge.ts` (`ping` included: the
/// daemon answers it, which is what keeps the machine-liveness probe
/// independent of any workspace Pi).
const kHostDirectTypes = <String>{
  'host_hello',
  'workspace_list',
  'workspace_start',
  'workspace_stop',
  'workspace_restart',
  'fs_list',
  'workspace_add',
  'workspace_remove',
  'pair_request',
  'ping',
};

/// Whether an inner message type is host control-plane (answered by the
/// daemon on room `host`) rather than child-addressed.
bool isHostDirectType(String type) => kHostDirectTypes.contains(type);

String? _peekType(Uint8List inner) {
  try {
    final j = jsonDecode(utf8.decode(inner));
    if (j is Map && j['type'] is String) return j['type'] as String;
    return null;
  } catch (_) {
    return null;
  }
}

/// Wraps an outbound inner message for the wire.
///
/// Host-direct types are returned unchanged — the transport addresses them
/// to (machine, "host") verbatim. Everything else is child-addressed and
/// gets the `host_forward{room: activeRoom, ct}` wrapper, where [activeRoom]
/// is the child workspace room the user is currently on.
Uint8List wrapOutbound(
  Uint8List inner, {
  required String activeRoom,
  required String id,
}) {
  final type = _peekType(inner);
  if (type == null || isHostDirectType(type)) return inner;
  final wrapped = jsonEncode({
    'type': 'host_forward',
    'id': id,
    'room': activeRoom,
    'ct': base64Encode(inner),
  });
  return Uint8List.fromList(utf8.encode(wrapped));
}

/// Demuxes one inbound inner frame (the `ct` payload of an envelope that
/// arrived on room `host`):
///
///   * direct host control-plane messages pass through unchanged;
///   * `host_message{room, ct}` wrappers are unwrapped and filed by
///     [activeRoom] — a frame for any other room returns `null` (dropped),
///     the same guard the old sender-room demux enforced, so chunks from a
///     workspace the user left never bleed into the current chat;
///   * malformed wrappers return `null`.
Uint8List? demuxInbound(Uint8List frame, {required String activeRoom}) {
  final Map<String, dynamic> j;
  try {
    final decoded = jsonDecode(utf8.decode(frame));
    if (decoded is! Map<String, dynamic>) return frame;
    j = decoded;
  } catch (_) {
    // Not JSON — let the channel's own decoder deal with (drop) it.
    return frame;
  }
  if (j['type'] != 'host_message') return frame;
  final room = j['room'];
  final ct = j['ct'];
  if (room is! String || ct is! String) return null;
  if (room != activeRoom) return null;
  try {
    return base64Decode(ct);
  } catch (_) {
    return null;
  }
}
