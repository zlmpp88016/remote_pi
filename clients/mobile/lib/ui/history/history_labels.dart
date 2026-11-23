// Plan 86 P4 — label and sentence helpers for the read-only history UI.
//
// Everything user-visible that is not a fixed `HistoryCopy` sentence lives
// here, so a row widget never invents a second wording. The protocol literals
// are mapped to client-owned sentences; a host never supplies text to this
// screen.

import 'dart:convert';

import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/ui/core/copy.dart';

/// Same shape as the live session list (name → preview → short id), minus the
/// cwd the history wire deliberately does not carry.
String historySessionLabel(HistorySessionInfo session) {
  final name = session.name?.trim() ?? '';
  if (name.isNotEmpty) return _truncate(name);
  final preview = _collapse(session.preview);
  if (preview.isNotEmpty) return _truncate(preview);
  return _shortId(session.id);
}

/// The preview under the label, or '' when it would repeat it.
String historySessionSubtitle(HistorySessionInfo session, String label) {
  final preview = _collapse(session.preview);
  if (preview.isEmpty) return '';
  final probe = preview.length <= 24 ? preview : preview.substring(0, 24);
  return label.startsWith(probe) ? '' : preview;
}

String _shortId(String id) => id.split('-').first;

String _collapse(String? text) =>
    (text ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();

String _truncate(String text) =>
    text.length <= 64 ? text : '${text.substring(0, 63)}…';

/// Local time for a session row. No `intl` dependency: the app shows a compact
/// stamp, and the exact date is not part of the contract.
String historyTime(int mtime) {
  if (mtime <= 0) return '';
  final dt = DateTime.fromMillisecondsSinceEpoch(mtime).toLocal();
  final now = DateTime.now();
  final sameDay =
      dt.year == now.year && dt.month == now.month && dt.day == now.day;
  final hh = dt.hour.toString().padLeft(2, '0');
  final mm = dt.minute.toString().padLeft(2, '0');
  if (sameDay) return '$hh:$mm';
  final mo = dt.month.toString().padLeft(2, '0');
  final dd = dt.day.toString().padLeft(2, '0');
  return '${dt.year}-$mo-$dd';
}

/// Honest runtime label. `null` is UNKNOWN, never "stopped" and never "the
/// newest file is current".
String historyCurrentLabel(HistoryCurrent current) {
  final state = current.state;
  if (state == 'running') return HistoryCopy.liveRunning;
  if (state == 'starting') return WorkspaceStatus.starting;
  if (state == 'crashed') return WorkspaceStatus.crashed;
  if (state == 'stopped') return HistoryCopy.liveStopped;
  return HistoryCopy.liveUnknown;
}

/// One sentence per typed failure. A host code NEVER becomes a host message.
String historyFailureText(
  HistoryErrorCode code, {
  HistorySwitchRefusal? refusal,
}) {
  if (code == HistoryErrorCode.invalidRequest && refusal != null) {
    return switch (refusal) {
      HistorySwitchRefusal.locked => HistoryCopy.continueLocked,
      HistorySwitchRefusal.noSdk => HistoryCopy.continueNoSdk,
      HistorySwitchRefusal.unknown => HistoryCopy.continueFailed,
    };
  }
  return switch (code) {
    HistoryErrorCode.building => HistoryCopy.buildingLong,
    HistoryErrorCode.stale => HistoryCopy.stale,
    HistoryErrorCode.notModified => HistoryCopy.cached,
    HistoryErrorCode.unsupported => HistoryCopy.unsupported,
    HistoryErrorCode.notFound => HistoryCopy.notFound,
    HistoryErrorCode.invalidCursor => HistoryCopy.invalidCursor,
    HistoryErrorCode.bodyTooLarge => HistoryCopy.bodyTooLarge,
    HistoryErrorCode.invalidRequest => HistoryCopy.readFailure,
    HistoryErrorCode.internal => HistoryCopy.internal,
    HistoryErrorCode.unknown => HistoryCopy.readFailure,
    HistoryErrorCode.offline => HistoryCopy.offline,
    HistoryErrorCode.timeout => HistoryCopy.timeout,
    HistoryErrorCode.unavailable => HistoryCopy.unavailableOldHost,
    HistoryErrorCode.indexUnavailable => HistoryCopy.indexUnavailable,
    HistoryErrorCode.startFailed => HistoryCopy.startFailed,
    HistoryErrorCode.clientBudget => HistoryCopy.bodyClientBudget,
    HistoryErrorCode.malformed => HistoryCopy.bodyMalformed,
  };
}

/// Bounded preview for a tool payload. The full value stays behind a body ref.
String historyJsonPreview(Object? value, {int max = 800}) {
  if (value == null) return '';
  final text = value is String ? value : _encode(value);
  final collapsed = text.length > max ? '${text.substring(0, max)}…' : text;
  return collapsed;
}

String _encode(Object value) {
  try {
    return const JsonEncoder.withIndent(null).convert(value);
  } catch (_) {
    return value.toString();
  }
}

/// Pretty-printed body for `json_utf8`; falls back to the raw text when the
/// host's value is not pretty (it always is valid JSON, but the formatter is
/// only cosmetic).
String historyPrettyJson(String text) {
  try {
    return const JsonEncoder.withIndent('  ').convert(jsonDecode(text));
  } catch (_) {
    return text;
  }
}
