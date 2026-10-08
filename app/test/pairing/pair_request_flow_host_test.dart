// Plan/69 — pairing by address+code keeps working AGAINST THE HOST ROOM
// (constraint: todo #3 must not regress).
//
// The daemon-issued code carries `rm=host` and its `pair_ok` echoes
// `room_id: "host"` ("the app addresses every subsequent inner to the host
// room" — pi-extension/src/daemon/host_control.ts). These tests pin that
// end to end: the pairing transport is pointed at the host room and the
// persisted PeerRecord carries `host` as its room.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:app/pairing/pair_payload.dart';
import 'package:app/pairing/pair_request_flow.dart';
import 'package:app/pairing/storage.dart';
import 'package:flutter_test/flutter_test.dart';

class _Q {
  final _buf = <Uint8List>[];
  final _wait = <Completer<Uint8List>>[];
  void add(Uint8List d) {
    if (_wait.isNotEmpty) {
      _wait.removeAt(0).complete(d);
    } else {
      _buf.add(d);
    }
  }

  Future<Uint8List> next() {
    if (_buf.isNotEmpty) return Future.value(_buf.removeAt(0));
    final c = Completer<Uint8List>();
    _wait.add(c);
    return c.future;
  }
}

/// In-memory transport that records the room the pairing flow selected and
/// answers `pair_request` with a daemon-shaped `pair_ok`.
class _RecordingTransport implements PeerTransport {
  _RecordingTransport(this._send, this._recv);
  final _Q _send;
  final _Q _recv;

  /// Rooms selected via `setActiveRoom`, in order.
  final roomsSelected = <String>[];

  /// Bytes the app sent (the pair_request JSON).
  final sentBytes = <Uint8List>[];

  void setActiveRoom(String room) => roomsSelected.add(room);

  @override
  Future<void> send(Uint8List data) async {
    sentBytes.add(data);
    _send.add(data);
  }

  @override
  Future<Uint8List> receive() => _recv.next();

  @override
  Future<void> close() async {}
}

class _FakeStorage extends PairingStorage {
  PeerRecord? saved;
  @override
  Future<List<PeerRecord>> listPeers() async =>
      saved == null ? const [] : [saved!];
  @override
  Future<PeerRecord?> loadPeer(String epk) async =>
      saved?.remoteEpk == epk ? saved : null;
  @override
  Future<void> savePeer(PeerRecord record) async => saved = record;
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {}
  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async => const [];
  @override
  Future<void> deleteRooms(String epk) async {}
}

/// Daemon-issued pairing code: `rm=host` + the relay it was printed from.
const _hostCode =
    'remotepi://pair?t=AAAAAAAAAAAAAAAAAAAAAA&'
    'epk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&'
    'n=Mac%20do%20Jacob&rm=host&r=ws%3A%2F%2Flocalhost';

void main() {
  test('código do daemon (rm=host) pareia e persiste room_id=host', () async {
    final payload = PairPayload.tryParse(_hostCode);
    expect(payload, isNotNull);
    expect(payload!.roomId, 'host');

    final appSide = _Q();
    final hostSide = _Q();
    final transport = _RecordingTransport(appSide, hostSide);

    // The "daemon" side: reads the pair_request, answers pair_ok exactly
    // like `handlePairRequest` does (room_id = host).
    unawaited(() async {
      final raw = await appSide.next();
      final req = jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
      expect(req['type'], 'pair_request');
      hostSide.add(
        Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'type': 'pair_ok',
              'in_reply_to': req['id'],
              'session_name': 'Mac do Jacob',
              'session_started_at': 1759500000,
              'room_id': 'host',
              'hostname': 'Mac do Jacob',
            }),
          ),
        ),
      );
    }());

    final storage = _FakeStorage();
    final result = await performPairing(
      qr: payload,
      transport: transport,
      storage: storage,
      deviceName: 'iPhone',
      currentRelayUrl: 'ws://localhost',
    );

    // The pairing flow addressed the HOST room…
    expect(transport.roomsSelected, ['host']);
    // …and the persisted record keeps addressing the host room.
    expect(result.peer.roomId, 'host');
    expect(result.peer.remoteEpk, payload.epk);
    expect(result.hostnameHint, 'Mac do Jacob');
    expect(storage.saved?.roomId, 'host');
  });

  test('pair_ok sem room_id cai no rm do código (host)', () async {
    final payload = PairPayload.tryParse(_hostCode)!;
    final appSide = _Q();
    final hostSide = _Q();
    final transport = _RecordingTransport(appSide, hostSide);

    unawaited(() async {
      final raw = await appSide.next();
      final req = jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
      hostSide.add(
        Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'type': 'pair_ok',
              'in_reply_to': req['id'],
              'session_name': 'Mac do Jacob',
              'session_started_at': 1759500000,
              // No room_id — legacy shape.
            }),
          ),
        ),
      );
    }());

    final result = await performPairing(
      qr: payload,
      transport: transport,
      storage: _FakeStorage(),
      deviceName: 'iPhone',
      currentRelayUrl: 'ws://localhost',
    );

    expect(result.peer.roomId, 'host');
  });

  test('token inválido continua gerando pair_error tipado', () async {
    final payload = PairPayload.tryParse(_hostCode)!;
    final appSide = _Q();
    final hostSide = _Q();
    final transport = _RecordingTransport(appSide, hostSide);

    unawaited(() async {
      final raw = await appSide.next();
      final req = jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
      hostSide.add(
        Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'type': 'pair_error',
              'in_reply_to': req['id'],
              'code': 'token_unknown',
              'message': 'Token was not issued by this host.',
            }),
          ),
        ),
      );
    }());

    await expectLater(
      performPairing(
        qr: payload,
        transport: transport,
        storage: _FakeStorage(),
        deviceName: 'iPhone',
        currentRelayUrl: 'ws://localhost',
      ),
      throwsA(
        isA<PairingError>()
            .having((e) => e.code, 'code', 'token_unknown')
            .having((e) => e.message, 'message', contains('host')),
      ),
    );
  });
}
