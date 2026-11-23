// Plan 86 P4 — explicit body materialization for the read-only viewer.
//
// A page carries bounded previews; the FULL value lives behind a `body_ref` and
// is fetched in <=64 KiB decoded chunks. This class:
//   * loops `offset_bytes` until `next_offset_bytes == total_bytes`;
//   * decodes text with a STATEFUL UTF-8 decoder, so a multi-byte character
//     split across two chunks is not mangled (the server test proves the split
//     exists; the App must not assume otherwise);
//   * enforces the App's own 8 MiB budget BEFORE allocating (the host allows up
//     to 256 MiB, which is not a phone-sized allocation) and reports
//     `client_budget`, keeping the preview visible;
//   * single-flights one ref, so a double tap does not fetch the same body
//     twice or interleave two offset loops;
//   * validates every chunk's scope/offset progression instead of splicing
//     bytes from a mismatched reply.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:mobile/domain/contracts/history_repository.dart';
import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/protocol/history.dart';

class HistoryBodyLoader {
  HistoryBodyLoader(this._repo);

  final HistoryRepository _repo;
  final Map<String, Future<HistoryFullBody>> _inflight = {};

  /// Materializes [ref] for one snapshot. One call ↔ one ref; concurrent calls
  /// for the same ref share the same future.
  Future<HistoryFullBody> load({
    required String epk,
    required String daemonId,
    required String sessionId,
    required String snapshot,
    required HistoryBodyRef ref,
  }) {
    final key = '$epk|$daemonId|$sessionId|$snapshot|${ref.ref}';
    final existing = _inflight[key];
    if (existing != null) return existing;
    final future = _load(
      epk: epk,
      daemonId: daemonId,
      sessionId: sessionId,
      snapshot: snapshot,
      ref: ref,
    );
    _inflight[key] = future;
    future.then<void>(
      (_) {
        if (identical(_inflight[key], future)) _inflight.remove(key);
      },
      onError: (Object _, StackTrace _) {
        if (identical(_inflight[key], future)) _inflight.remove(key);
      },
    );
    return future;
  }

  Future<HistoryFullBody> _load({
    required String epk,
    required String daemonId,
    required String sessionId,
    required String snapshot,
    required HistoryBodyRef ref,
  }) async {
    if (ref.totalBytes > kHistoryClientBodyMaxBytes) {
      throw const HistoryFailure(HistoryErrorCode.clientBudget);
    }

    final textBuffer = StringBuffer();
    final byteBuffer = BytesBuilder(copy: false);
    final isBinary = ref.representation == HistoryBodyRepresentation.binary;
    final decoder = isBinary
        ? null
        : const Utf8Decoder(allowMalformed: false).startChunkedConversion(
            StringConversionSink.fromStringSink(textBuffer),
          );

    var offset = 0;
    var total = ref.totalBytes;
    var received = 0;
    // Bounded attempt count: a host that keeps returning a non-advancing
    // chunk is a protocol failure, not something to spin on.
    var guard = 0;
    while (offset < total) {
      if (guard++ > 4096) {
        throw const HistoryFailure(HistoryErrorCode.invalidRequest);
      }
      final chunk = await _repo.readBody(
        HistoryBodyQuery(
          epk: epk,
          daemonId: daemonId,
          sessionId: sessionId,
          snapshot: snapshot,
          bodyRef: ref.ref,
          offsetBytes: offset,
        ),
      );
      if (chunk.representation != ref.representation ||
          chunk.nextOffsetBytes <= chunk.offsetBytes ||
          chunk.offsetBytes != offset ||
          chunk.nextOffsetBytes > chunk.totalBytes) {
        // A chunk whose offset does not continue this loop belongs to another
        // body/generation. Never splice it in.
        throw const HistoryFailure(HistoryErrorCode.invalidRequest);
      }
      total = chunk.totalBytes;
      received += chunk.bytes.length;
      if (received > kHistoryClientBodyMaxBytes) {
        throw const HistoryFailure(HistoryErrorCode.clientBudget);
      }
      if (isBinary) {
        byteBuffer.add(Uint8List.fromList(chunk.bytes));
      } else {
        try {
          decoder!.add(Uint8List.fromList(chunk.bytes));
        } on FormatException {
          throw const HistoryFailure(HistoryErrorCode.malformed);
        }
      }
      offset = chunk.nextOffsetBytes;
    }
    if (offset != total) {
      throw const HistoryFailure(HistoryErrorCode.invalidRequest);
    }
    if (isBinary) {
      return HistoryFullBody(
        representation: ref.representation,
        mime: ref.mime,
        text: null,
        bytes: byteBuffer.takeBytes(),
        totalBytes: total,
      );
    }
    try {
      decoder!.close();
    } on FormatException {
      throw const HistoryFailure(HistoryErrorCode.malformed);
    }
    return HistoryFullBody(
      representation: ref.representation,
      mime: ref.mime,
      text: textBuffer.toString(),
      bytes: null,
      totalBytes: total,
    );
  }
}
