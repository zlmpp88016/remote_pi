/// Plan 29 — voice-input state machine (decision-driven).
///
/// The mic is hold-to-talk: idle → recording (while held) → transcribing
/// (brief, on release / 60s cap) → idle. Permission/locale failures land on
/// [VoiceUnavailable] so the input bar can hide the mic or guide the user to
/// Settings.
sealed class VoiceInputState {
  const VoiceInputState();
}

/// Mic available and ready; nothing in flight.
final class VoiceIdle extends VoiceInputState {
  const VoiceIdle();

  @override
  bool operator ==(Object other) => other is VoiceIdle;

  @override
  int get hashCode => (VoiceIdle).hashCode;
}

/// Recording in progress — drives the WhatsApp-style strip.
/// [elapsed] is the running time; [level] is the `0..1` amplitude envelope.
final class VoiceRecording extends VoiceInputState {
  const VoiceRecording({required this.elapsed, required this.level});

  final Duration elapsed;
  final double level;

  @override
  bool operator ==(Object other) =>
      other is VoiceRecording &&
      other.elapsed == elapsed &&
      other.level == level;

  @override
  int get hashCode => Object.hash(elapsed, level);
}

/// Released (or hit the 60s cap); the recognizer is finalizing. Short-lived —
/// on-device transcription is fast, but this covers the gap.
final class VoiceTranscribing extends VoiceInputState {
  const VoiceTranscribing();

  @override
  bool operator ==(Object other) => other is VoiceTranscribing;

  @override
  int get hashCode => (VoiceTranscribing).hashCode;
}

/// Why voice input can't be used right now.
enum VoiceUnavailableReason {
  /// Mic / speech permission denied (decision #10) — mic stays visible, tap
  /// guides to system Settings.
  permissionDenied,

  /// No on-device recognition for any acceptable locale (decision #9, edge) —
  /// the mic is hidden.
  unsupported,
}

final class VoiceUnavailable extends VoiceInputState {
  const VoiceUnavailable(this.reason);

  final VoiceUnavailableReason reason;

  @override
  bool operator ==(Object other) =>
      other is VoiceUnavailable && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;
}
