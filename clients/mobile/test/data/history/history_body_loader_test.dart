// Plan 86 P4 — body materialization: 64 KiB chunk loop, stateful UTF-8 across
// split multi-byte characters, explicit budgets, and no splice of a mismatched
// chunk.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/history/history_body_loader.dart';
import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/protocol/history.dart';

class _FakeRepo extends HistoryRepository {
  _FakeRepo(this.onBody);

  Future<HistoryBodyChunk> Function(HistoryBodyQuery query)? onBody;
  final calls = <HistoryBodyQuery>[];

  @override
  Future<HistoryBodyChunk> readBody(HistoryBodyQuery query) {
    calls.add(query);
    final fn = onBody;
    if (fn == null) throw StateError('no body handler');
    return fn(query);
  }

  @override
  HistoryMetrics get metrics => HistoryMetrics();

  @override
  void recordMetric(HistoryMetricSample sample) {}

  @override
  Future<HistoryTransportKind> transportKind(
    String epk, {
    required String daemonId,
    String? cwd,
    String? roomId,
    Duration helloWait = Duration.zero,
  }) async => HistoryTransportKind.hostV1;

  @override
  HistoryWorkspaceListing? cachedWorkspace(String epk, String daemonId) => null;

  @override
  HistoryPage? cachedNewestPage(
    String epk,
    String daemonId,
    String sessionId,
  ) => null;

  @override
  HistoryPage? cachedPage({
    required String epk,
    required String daemonId,
    required String sessionId,
    required String snapshot,
    required int projection,
    String? cursor,
  }) => null;

  @override
  Future<HistoryWorkspaceListing> listWorkspace(HistoryWorkspaceQuery query) =>
      throw UnimplementedError();

  @override
  Future<HistoryPage> readSession(HistorySessionQuery query) =>
      throw UnimplementedError();

  @override
  Future<void> switchOnce({
    required String epk,
    required String roomId,
    required String sessionId,
    Duration ackTimeout = const Duration(seconds: 12),
  }) => throw UnimplementedError();

  @override
  Future<HistoryWorkspaceLaunch> startWorkspace({
    required String epk,
    String? daemonId,
    String? cwd,
    Duration timeout = const Duration(seconds: 12),
  }) => throw UnimplementedError();

  @override
  bool isRoomLive(String epk, String roomId) => false;

  @override
  void invalidateWorkspace(String epk, String daemonId) {}

  @override
  void invalidateSession(String epk, String daemonId, String sessionId) {}

  @override
  void invalidatePeer(String epk) {}
}

HistoryBodyRef _ref(
  HistoryBodyRepresentation representation, {
  required int totalBytes,
  String? mime,
}) => HistoryBodyRef(
  ref: 'ref-1',
  field: 'text',
  representation: representation,
  mime: mime,
  totalBytes: totalBytes,
  preview: null,
  previewTruncated: true,
);

HistoryBodyChunk _chunk({
  required HistoryBodyRepresentation representation,
  required int offset,
  required int next,
  required int total,
  required List<int> bytes,
  String? mime,
}) => HistoryBodyChunk(
  representation: representation,
  mime: mime,
  offsetBytes: offset,
  nextOffsetBytes: next,
  totalBytes: total,
  bytes: bytes,
);

Future<HistoryFullBody> _load(HistoryBodyLoader loader, HistoryBodyRef ref) =>
    loader.load(
      epk: 'epk',
      daemonId: 'd1',
      sessionId: 's1',
      snapshot: 'snap',
      ref: ref,
    );

void main() {
  test(
    'loops chunks and keeps a multi-byte character split across them',
    () async {
      // "a€b" — the euro sign is E2 82 AC. Chunk 1 cuts after the first byte.
      final payload = utf8.encode('a€b');
      final repo = _FakeRepo((query) async {
        final offset = query.offsetBytes;
        if (offset == 0) {
          return _chunk(
            representation: HistoryBodyRepresentation.textUtf8,
            offset: 0,
            next: 2,
            total: payload.length,
            bytes: payload.sublist(0, 2),
          );
        }
        if (offset == 2) {
          return _chunk(
            representation: HistoryBodyRepresentation.textUtf8,
            offset: 2,
            next: payload.length,
            total: payload.length,
            bytes: payload.sublist(2),
          );
        }
        throw StateError('unexpected offset $offset');
      });
      final loader = HistoryBodyLoader(repo);
      final body = await _load(
        loader,
        _ref(HistoryBodyRepresentation.textUtf8, totalBytes: payload.length),
      );
      expect(body.text, 'a€b');
      expect(body.bytes, isNull);
      expect(body.totalBytes, payload.length);
      expect(repo.calls.map((c) => c.offsetBytes), [0, 2]);
    },
  );

  test('binary bodies are assembled byte-exact with their mime', () async {
    final bytes = <int>[0, 1, 2, 255, 128];
    final repo = _FakeRepo((query) async {
      final offset = query.offsetBytes;
      final next = offset == 0 ? 2 : bytes.length;
      return _chunk(
        representation: HistoryBodyRepresentation.binary,
        mime: 'image/png',
        offset: offset,
        next: next,
        total: bytes.length,
        bytes: bytes.sublist(offset, next),
      );
    });
    final body = await _load(
      HistoryBodyLoader(repo),
      _ref(
        HistoryBodyRepresentation.binary,
        totalBytes: bytes.length,
        mime: 'image/png',
      ),
    );
    expect(body.bytes, bytes);
    expect(body.mime, 'image/png');
    expect(body.text, isNull);
  });

  test('json bodies surface the complete valid JSON text', () async {
    final text = '{"path":"a/b","count":2}';
    final payload = utf8.encode(text);
    final repo = _FakeRepo((query) async {
      return _chunk(
        representation: HistoryBodyRepresentation.jsonUtf8,
        offset: 0,
        next: payload.length,
        total: payload.length,
        bytes: payload,
      );
    });
    final body = await _load(
      HistoryBodyLoader(repo),
      _ref(HistoryBodyRepresentation.jsonUtf8, totalBytes: payload.length),
    );
    expect(body.text, text);
    expect(jsonDecode(body.text!), {'path': 'a/b', 'count': 2});
  });

  test('a body above the App budget fails BEFORE requesting chunks', () async {
    final repo = _FakeRepo((query) async => throw StateError('must not fetch'));
    await expectLater(
      _load(
        HistoryBodyLoader(repo),
        _ref(
          HistoryBodyRepresentation.textUtf8,
          totalBytes: kHistoryClientBodyMaxBytes + 1,
        ),
      ),
      throwsA(
        isA<HistoryFailure>().having(
          (f) => f.code,
          'code',
          HistoryErrorCode.clientBudget,
        ),
      ),
    );
    expect(repo.calls, isEmpty);
  });

  test('a mismatched representation is refused, never spliced', () async {
    final repo = _FakeRepo(
      (query) async => _chunk(
        representation: HistoryBodyRepresentation.binary,
        offset: 0,
        next: 1,
        total: 1,
        bytes: const [1],
      ),
    );
    await expectLater(
      _load(
        HistoryBodyLoader(repo),
        _ref(HistoryBodyRepresentation.textUtf8, totalBytes: 1),
      ),
      throwsA(
        isA<HistoryFailure>().having(
          (f) => f.code,
          'code',
          HistoryErrorCode.invalidRequest,
        ),
      ),
    );
  });

  test('a non-advancing chunk is a protocol failure', () async {
    final repo = _FakeRepo(
      (query) async => _chunk(
        representation: HistoryBodyRepresentation.textUtf8,
        offset: 0,
        next: 0,
        total: 10,
        bytes: const [],
      ),
    );
    await expectLater(
      _load(
        HistoryBodyLoader(repo),
        _ref(HistoryBodyRepresentation.textUtf8, totalBytes: 10),
      ),
      throwsA(
        isA<HistoryFailure>().having(
          (f) => f.code,
          'code',
          HistoryErrorCode.invalidRequest,
        ),
      ),
    );
  });

  test('invalid UTF-8 reports malformed instead of replacement text', () async {
    final repo = _FakeRepo(
      (query) async => _chunk(
        representation: HistoryBodyRepresentation.textUtf8,
        offset: 0,
        next: 1,
        total: 1,
        bytes: const [0xC3], // truncated 2-byte sequence
      ),
    );
    await expectLater(
      _load(
        HistoryBodyLoader(repo),
        _ref(HistoryBodyRepresentation.textUtf8, totalBytes: 1),
      ),
      throwsA(
        isA<HistoryFailure>().having(
          (f) => f.code,
          'code',
          HistoryErrorCode.malformed,
        ),
      ),
    );
  });

  test('a typed host failure propagates unchanged', () async {
    final repo = _FakeRepo(
      (query) async =>
          throw const HistoryFailure(HistoryErrorCode.bodyTooLarge),
    );
    await expectLater(
      _load(
        HistoryBodyLoader(repo),
        _ref(HistoryBodyRepresentation.textUtf8, totalBytes: 10),
      ),
      throwsA(
        isA<HistoryFailure>().having(
          (f) => f.code,
          'code',
          HistoryErrorCode.bodyTooLarge,
        ),
      ),
    );
  });

  test('two concurrent loads of one ref share one offset loop', () async {
    var fetches = 0;
    final payload = Uint8List.fromList(utf8.encode('hello'));
    final repo = _FakeRepo((query) async {
      fetches++;
      return _chunk(
        representation: HistoryBodyRepresentation.textUtf8,
        offset: 0,
        next: payload.length,
        total: payload.length,
        bytes: payload,
      );
    });
    final loader = HistoryBodyLoader(repo);
    final ref = _ref(
      HistoryBodyRepresentation.textUtf8,
      totalBytes: payload.length,
    );
    final results = await Future.wait([_load(loader, ref), _load(loader, ref)]);
    expect(results[0].text, 'hello');
    expect(results[1].text, 'hello');
    expect(fetches, 1);
  });
}
