// WebSocket-based PeerTransport.
//
// Flow per connection:
//   1. Connect to relay WS
//   2. Ed25519 challenge-response (hello → challenge → auth)
//   3. After auth, two parallel streams of inbound frames:
//        - envelope frames `{peer, ct}` → decoded to the peer queue
//        - control frames (top-level `type`, no `peer`) → control stream
//      Outbound `subscribe_presence` / `presence_check` go raw too.
//
// `peer` is standard base64 of the destination's Ed25519 pubkey (matches
// the relay registry, populated from the peer's hello). `ct` is base64 of
// the inner-envelope bytes (plain JSON post-rollback, see plano 06).
//
// Plan/69 — host-first connection (spike decision B): the app anchors on
// room `host` ONLY. `hello.room_id` is `host`; every OUTER envelope
// addresses (machine, "host"); child-addressed traffic rides the
// `host_forward`/`host_message` proxy (see `host_proxy.dart`). The
// inbound demux accepts envelopes from the host room and unwraps
// `host_message` by room — the drop-on-room-mismatch guard that forced
// decision B now keys on the anchor room instead of the active Pi room.

import 'dart:async';
import 'dart:convert';

import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/host_proxy.dart';
import 'package:app/data/transport/relay_config.dart';
import 'package:app/protocol/protocol.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../pairing/pair_request_flow.dart';

class WsTransportError implements Exception {
  final String message;
  const WsTransportError(this.message);

  @override
  String toString() => 'WsTransportError: $message';
}

class WsTransport implements PeerTransport, IControlLink {
  final WebSocketChannel _ws;
  final _queue = _MsgQueue();
  final _controlController =
      StreamController<ControlInbound>.broadcast();

  WsTransport._(this._ws);

  // Connect, authenticate with relay, and return a ready transport.
  static Future<WsTransport> connect({
    required String relayUrl,
    required String peerPubkey, // base64 standard or url — destination peer
    required SimpleKeyPair ed25519Key, // this device's Ed25519 long-term key
  }) async {
    // Plan-18 follow-up — set a WS-level pingInterval (RFC 6455
    // control frames). This keeps the TCP connection alive through
    // NAT / corporate proxies that aggressively close idle sockets,
    // and surfaces a dead WS as `onDone` / `onError` instead of
    // letting it silently linger until the next user action. The
    // protocol-level Ping/Pong handled by ConnectionManager covers
    // app↔Pi liveness; this one covers app↔relay TCP liveness.
    // Accept http(s) URLs in the user-facing form but always speak
    // ws(s) on the wire — IOWebSocketChannel rejects http schemes.
    final WebSocketChannel ws = IOWebSocketChannel.connect(
      Uri.parse(toWsRelayUrl(relayUrl)),
      pingInterval: const Duration(seconds: 20),
    );
    final transport = WsTransport._(ws);

    final challengeCompleter = Completer<Map<String, dynamic>>();
    bool authDone = false;

    final sub = ws.stream.listen(
      (raw) {
        // Volume probe: log every frame the relay pushes onto this
        // socket so we can spot firehose patterns (e.g. presence
        // churn, repeated room snapshots) by counting prefix
        // occurrences — body kept compact so the log stays grep-able
        // even when the relay is chatty.
        final rawStr = raw is String ? raw : raw.toString();
        if (!authDone) {
          debugPrint('[ws-in] bytes=${rawStr.length} stage=preauth');
          try {
            challengeCompleter.complete(
              jsonDecode(raw as String) as Map<String, dynamic>,
            );
          } catch (e) {
            if (!challengeCompleter.isCompleted) {
              challengeCompleter.completeError(e);
            }
          }
          return;
        }
        try {
          final frame = jsonDecode(raw as String) as Map<String, dynamic>;
          // Envelope: {peer, room?, ct} → enqueue payload bytes.
          if (frame.containsKey('peer') && frame.containsKey('ct')) {
            final bytes = _b64Decode(frame['ct'] as String);
            final senderRoom = frame['room'] as String?;
            // Plan/69 — the app anchors on room `host` and the daemon
            // answers there. An envelope from any other room is not
            // ours; a missing `room` (legacy relay) still passes.
            if (senderRoom != null && senderRoom != kHostRoomId) {
              debugPrint(
                '[ws-in] bytes=${rawStr.length} kind=envelope '
                'sender_room=$senderRoom DROPPED (not the host room)',
              );
              return;
            }
            // Plan/69 — proxy demux (decision B): child traffic arrives
            // wrapped in `host_message{room, ct}`. Unwrap and file by
            // room; frames for a room we are not addressing are dropped
            // (the old sender-room guard, now keyed on the child room
            // inside the wrapper).
            final inner = demuxInbound(
              bytes,
              activeRoom: transport._activeRoom,
            );
            if (inner == null) {
              debugPrint(
                '[ws-in] bytes=${rawStr.length} kind=host_message '
                'DROPPED (room-mismatch or malformed)',
              );
              return;
            }
            debugPrint(
              '[ws-in] bytes=${rawStr.length} kind=envelope '
              'ct.bytes=${inner.length}',
            );
            transport._queue.add(inner);
            return;
          }
          // Control: top-level `type` only → presence stream.
          final ctrl = ControlInbound.tryFromJson(frame);
          if (ctrl != null && !transport._controlController.isClosed) {
            debugPrint(
              '[ws-in] bytes=${rawStr.length} kind=control '
              'type=${frame['type']}',
            );
            transport._controlController.add(ctrl);
            return;
          }
          // Anything else: unknown shape — drop silently.
          debugPrint('[ws-in] bytes=${rawStr.length} kind=unknown DROPPED');
        } catch (e) {
          debugPrint(
            '[ws-in] bytes=${rawStr.length} kind=malformed DROPPED err=$e',
          );
        }
      },
      onError: (e) {
        if (!challengeCompleter.isCompleted) challengeCompleter.completeError(e);
        transport._queue.error(e);
      },
      onDone: () {
        if (!challengeCompleter.isCompleted) {
          challengeCompleter.completeError(const WsTransportError('WS closed during auth'));
        }
        transport._queue.close();
        if (!transport._controlController.isClosed) {
          transport._controlController.close();
        }
      },
    );

    try {
      // 1. Hello (standard base64 — matches relay registry format).
      // Plan/69 — the app is a host-first client: it announces itself on
      // the reserved `host` room, never on a Pi cwd room. Every outbound
      // envelope addresses (machine, "host") and child-addressed traffic
      // rides the host_forward proxy (see host_proxy.dart).
      final pub = await ed25519Key.extractPublicKey();
      ws.sink.add(jsonEncode({
        'type': 'hello',
        'pubkey': base64.encode(pub.bytes),
        'room_id': kHostRoomId,
      }));

      // 2. Challenge
      final ch = await challengeCompleter.future;
      if (ch['type'] != 'challenge') {
        throw WsTransportError('Expected challenge, got ${ch['type']}');
      }
      final nonce = _b64Decode(ch['nonce'] as String);

      // 3. Auth
      final sig = await Ed25519().sign(nonce, keyPair: ed25519Key);
      ws.sink.add(jsonEncode({
        'type': 'auth',
        'sig': base64.encode(sig.bytes),
      }));
      authDone = true;

      transport._peerPubkey = _normalizeToStandard(peerPubkey);
      transport._sub = sub;
      return transport;
    } catch (e) {
      await sub.cancel();
      await ws.sink.close();
      rethrow;
    }
  }

  String _peerPubkey = '';
  StreamSubscription? _sub;

  /// Active CHILD workspace room (the one the user is on). Plan/69 — the
  /// outer envelope always addresses room `host`; this value rides INSIDE
  /// the `host_forward` wrapper (outbound) and selects which
  /// `host_message` frames survive the demux (inbound). Defaults to
  /// 'main' until the app learns the real room (pair_ok / room_announced /
  /// workspace_start_ok).
  String _activeRoom = 'main';

  /// Select the child workspace room. The app itself stays on the `host`
  /// room (that is what `hello.room_id` carries); this only moves the room
  /// INSIDE the proxy wrappers.
  void setActiveRoom(String room) {
    if (room == _activeRoom) {
      return;
    }
    _activeRoom = room;
  }

  /// Monotonic id for the `host_forward` wrappers this transport emits.
  int _forwardCounter = 0;

  @override
  Future<void> send(Uint8List data) async {
    // Plan/69 — wrap child-addressed traffic for the host proxy; host
    // control-plane messages (host_hello, workspace_*, fs_list,
    // pair_request, ping) pass through and are addressed to `host`
    // directly. The outer envelope NEVER carries a workspace room — that
    // is the whole point of decision B.
    final payload = wrapOutbound(
      data,
      activeRoom: _activeRoom,
      id: 'fwd_${++_forwardCounter}',
    );
    _ws.sink.add(jsonEncode({
      'peer': _peerPubkey,
      'room': kHostRoomId,
      'ct': base64.encode(payload),
    }));
  }

  @override
  Future<Uint8List> receive() => _queue.next();

  // ---- IControlLink --------------------------------------------------------

  @override
  Stream<ControlInbound> get controlFrames => _controlController.stream;

  @override
  void sendControl(Map<String, dynamic> json) {
    _ws.sink.add(jsonEncode(json));
  }

  // -------------------------------------------------------------------------

  @override
  Future<void> close() async {
    await _sub?.cancel();
    await _ws.sink.close();
    _queue.close();
    if (!_controlController.isClosed) await _controlController.close();
  }
}

// ---------------------------------------------------------------------------

class _MsgQueue {
  final _buf = <Uint8List>[];
  final _waiters = <Completer<Uint8List>>[];
  bool _closed = false;

  void add(Uint8List msg) {
    if (_waiters.isNotEmpty) {
      _waiters.removeAt(0).complete(msg);
    } else if (!_closed) {
      _buf.add(msg);
    }
  }

  void error(Object e) {
    for (final w in _waiters) {
      w.completeError(e);
    }
    _waiters.clear();
    _closed = true;
  }

  void close() {
    for (final w in _waiters) {
      w.completeError(const WsTransportError('transport closed'));
    }
    _waiters.clear();
    _closed = true;
  }

  Future<Uint8List> next() {
    if (_closed) return Future.error(const WsTransportError('transport closed'));
    if (_buf.isNotEmpty) return Future.value(_buf.removeAt(0));
    final c = Completer<Uint8List>();
    _waiters.add(c);
    return c.future;
  }
}

// Decodes standard or url-safe base64 (pads defensively).
Uint8List _b64Decode(String s) {
  final pad = (4 - s.length % 4) % 4;
  final padded = s + '=' * pad;
  try {
    return base64.decode(padded);
  } on FormatException {
    return base64Url.decode(padded);
  }
}

// Relay registry uses standard base64 (from each peer's hello). QR/storage
// may carry url-safe encoding — re-encode to standard so the relay matches.
String _normalizeToStandard(String pubkey) {
  try {
    final pad = (4 - pubkey.length % 4) % 4;
    final bytes = base64Url.decode(pubkey + '=' * pad);
    return base64.encode(bytes);
  } catch (_) {
    return pubkey;
  }
}
