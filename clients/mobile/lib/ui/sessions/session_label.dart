/// The label to show for a session row.
///
/// Mirrors `sessionLabel` in `clients/web/src/lib/remote-pi/sessions.ts` so both
/// clients read the same list the same way.
///
/// The host's `name` is NOT a title: the SDK's `SessionManager.list()` fills it
/// from the user-defined display name, which in practice holds the WORKSPACE
/// FOLDER NAME. Every session in one folder therefore arrives with the same
/// `name` — measured on the emulator: every row of `D:\模型测试\4.1f` read
/// `4.1f`, so the list could not be told apart. Web already skipped that case;
/// this brings the app in line instead of inventing a second rule.
library;

import 'package:mobile/protocol/protocol.dart';

/// Keep the label one line. The row ellipsises anyway, but cutting here stops a
/// pasted blob from dominating the row (same bound as web).
const int _labelMax = 64;

String sessionLabel(WireSessionInfo session) {
  final name = session.name?.trim() ?? '';
  final preview = previewText(session);
  final cwd = session.cwd;
  final folderLike = cwd != null && name == _basenameOf(cwd);

  if (name.isNotEmpty && !folderLike) return name;
  if (preview.isNotEmpty) return _truncateLabel(preview);
  return shortSessionId(session.id);
}

/// The session's first message, whitespace-collapsed — same as web.
String previewText(WireSessionInfo session) =>
    (session.preview ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();

/// First uuid segment: enough to tell two unnamed sessions apart.
String shortSessionId(String id) => id.split('-').first;

/// The preview to print UNDER the label, or '' when it would only repeat it.
///
/// The label usually IS the first message, so printing the preview beneath it
/// would show the same sentence twice (web's rule, same 24-char probe).
String sessionSubtitle(WireSessionInfo session, String label) {
  final preview = previewText(session);
  if (preview.isEmpty) return '';
  final probe = preview.length <= 24 ? preview : preview.substring(0, 24);
  return label.startsWith(probe) ? '' : preview;
}

/// Last path segment, tolerating both separators — the host may be POSIX.
String _basenameOf(String p) {
  final parts = p.split(RegExp(r'[\\/]')).where((x) => x.isNotEmpty).toList();
  return parts.isEmpty ? p : parts.last;
}

String _truncateLabel(String text) => text.length <= _labelMax
    ? text
    : '${text.substring(0, _labelMax - 1)}…';