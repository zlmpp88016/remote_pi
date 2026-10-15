// Transcript row shaping — pure domain logic, no Flutter.
//
// A transcript's noisiest stretch is a burst of tool traffic between two
// messages. Collapsing consecutive tool events into one row lets the UI show a
// single summary line with the detail one tap away.

import 'package:app/domain/session_state.dart';

/// One rendered row in the transcript.
sealed class TranscriptRow {
  const TranscriptRow();
}

/// A single message rendered on its own.
class SingleMessageRow extends TranscriptRow {
  final ChatMessage message;
  const SingleMessageRow(this.message);
}

/// A run of consecutive tool events that share one collapsed card.
class ToolGroupRow extends TranscriptRow {
  final List<ToolEvent> tools;
  const ToolGroupRow(this.tools);
}

/// Fold consecutive [ToolEvent]s into a single group row.
///
/// A lone tool event stays a plain row: a one-item group would add a tap target
/// for no benefit. The transcript carries no thinking events (the Pi emits only
/// user_input / tool_request / tool_result / agent_message / compaction), so
/// tool traffic is the only thing this collapses.
List<TranscriptRow> groupTranscriptRows(List<ChatMessage> messages) {
  final rows = <TranscriptRow>[];
  var pending = <ToolEvent>[];
  void flush() {
    if (pending.isEmpty) return;
    rows.add(
      pending.length == 1
          ? SingleMessageRow(pending.first)
          : ToolGroupRow(pending),
    );
    pending = <ToolEvent>[];
  }

  for (final m in messages) {
    if (m is ToolEvent) {
      pending.add(m);
      continue;
    }
    flush();
    rows.add(SingleMessageRow(m));
  }
  flush();
  return rows;
}
