// Plan 86 #46 — pure tally logic for the profile probe in this directory.
//
// Kept separate from the entrypoint (and free of Flutter/Hive imports) so the
// paths that are easy to get wrong — bounded-ring eviction, repeated / rewrites
// of existing rows, and rebinding to another session box — are covered by a
// deterministic test.
//
// P5 key contract (`data/local/boxes.dart` + `MessageRecord`):
//   * a `msgs_<epk>__<roomId>` row is keyed by a STABLE NONNEGATIVE PHYSICAL
//     KEY (int) that is unrelated to display order;
//   * display order is `MessageRecord.seq`, a SIGNED int where prepending
//     allocates below the minimum.
// Therefore a key comparison must never be read as an ordering signal: a put to
// a lower key is not "an older row re-emitted", and a new key below the previous
// maximum is not "a prepend". Ordering is never inferred here.

import 'package:mobile/domain/history/history_models.dart';

/// Tail of the bounded [HistoryMetrics] ring.
///
/// The ring keeps the last [HistoryMetrics.capacity] samples and its
/// `samples.length` saturates, so a length counter cannot tell new samples from
/// old ones. [drain] instead finds the previously returned sample by identity
/// and returns everything after it.
class HistoryMetricsTail {
  HistoryMetricSample? _cursor;

  /// Samples not printed yet, plus whether the cursor was evicted.
  ///
  /// `dropped == true` means more than `capacity` samples arrived between two
  /// drains: the lost count is unknowable, so it is reported as unknown instead
  /// of being guessed.
  ({List<HistoryMetricSample> fresh, bool dropped}) drain(
    List<HistoryMetricSample> samples,
  ) {
    if (samples.isEmpty) return (fresh: const [], dropped: false);

    final cursor = _cursor;
    var start = 0;
    var dropped = false;
    if (cursor != null) {
      final at = samples.indexWhere((s) => identical(s, cursor));
      if (at >= 0) {
        start = at + 1;
      } else {
        dropped = true;
      }
    }

    final fresh = samples.sublist(start);
    _cursor = samples.last;
    return (fresh: fresh, dropped: dropped);
  }
}

/// Scalar tally of writes observed on one Hive msgs box.
///
/// P5 contract: the Hive key is a stable nonnegative physical key, `seq`
/// (display order) lives inside the record. Only counts are kept — never record
/// contents, ids or text.
///
/// Classification of a put:
/// * [inserts] — first observed write to a key that did NOT exist when the
///   observation attached (a genuinely new row; could be an append or a
///   prepend, both are just new physical keys).
/// * [existingWrites] — write to a key that already existed (seeded at attach)
///   or that this tally already observed being written (rewrite in place).
/// * [duplicates] — a repeated observed event for a physical key that was
///   already put since attach (the same row published twice).
class MsgsWriteTally {
  int puts = 0;
  int deletes = 0;

  /// Puts to keys absent at attach (new rows).
  int inserts = 0;

  /// Puts to keys known before the put: pre-existing rows or already-put rows.
  int existingWrites = 0;

  /// Puts to a physical key already put since attach (repeated row event).
  int duplicates = 0;

  final Set<int> _seeded = <int>{};
  final Set<int> _written = <int>{};

  /// Physical keys that already existed when the observation attached.
  int get seededKeys => _seeded.length;

  /// Seed the keys that already exist in the box, so writes to them are
  /// classified as rewrites of pre-existing rows instead of new rows.
  ///
  /// Keys only — no values are read. Idempotent; returns the seed size.
  int seedExisting(Iterable<int> keys) {
    for (final key in keys) {
      if (key >= 0) _seeded.add(key);
    }
    return _seeded.length;
  }

  void onEvent(Object? key, bool deleted) {
    // Contract violation (non-int / negative physical key) is ignored.
    if (key is! int || key < 0) return;
    if (deleted) {
      deletes++;
      return;
    }
    puts++;
    final rewritten = _seeded.contains(key) || _written.contains(key);
    if (_written.contains(key)) duplicates++;
    if (rewritten) {
      existingWrites++;
    } else {
      inserts++;
    }
    _written.add(key);
    // Deliberately no min/max key tracking: key order carries no meaning.
  }

  /// Distinct physical keys known so far (seeded ∪ observed).
  int get distinctKeys {
    final all = <int>{..._seeded, ..._written};
    return all.length;
  }
}

/// Pure attach/detach decision for the box that is being observed.
///
/// The probe must follow the ACTIVE (peer, room) session: when the user switches
/// chat/workspace, the previous `watchMessages` observation and its tally are
/// dropped and the new box is seeded/attached from scratch, so counters are
/// never silently attributed to another box. Identifiers are only compared, not
/// stored in any output.
class MsgsObservationSwitch {
  (String, String)? _attached;

  /// The currently attached `(epk, room)` pair, or null when detached.
  (String, String)? get attached => _attached;

  /// Feed one poll of the active session.
  ///
  /// [boxOpen] must describe the box for ([epk], [room]). Returns whether the
  /// caller must cancel the previous subscription and/or attach a new one.
  /// `detach && attach` means rebind: cancel first, reset counters, then seed.
  ({bool detach, bool attach}) observe({
    String? epk,
    String? room,
    required bool boxOpen,
  }) {
    final previous = _attached;
    final target = (epk == null || room == null) ? null : (epk, room);

    if (target == null || !boxOpen) {
      if (previous == null) return (detach: false, attach: false);
      _attached = null;
      return (detach: true, attach: false);
    }
    if (previous == target) return (detach: false, attach: false);
    _attached = target;
    // Rebinding: the old observation is never reused for the new box.
    return (detach: previous != null, attach: true);
  }
}
