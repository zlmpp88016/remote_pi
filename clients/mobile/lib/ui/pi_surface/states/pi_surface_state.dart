import 'package:app/protocol/protocol.dart';

/// Plan/68 — state of the workspace's Pi surface (skills + packages).
///
/// One flat snapshot, because the host answers `pi_surface` with everything at
/// once. Keeping it flat means the page never has to reconcile two loading
/// states, and a failed refresh replaces the whole thing rather than leaving
/// half a stale catalog on screen.
sealed class PiSurfaceState {
  const PiSurfaceState();
}

class PiSurfaceLoading extends PiSurfaceState {
  const PiSurfaceLoading();
}

class PiSurfaceError extends PiSurfaceState {
  final String message;
  const PiSurfaceError({required this.message});
}

class PiSurfaceReady extends PiSurfaceState {
  final PiSurfaceRuntime runtime;
  final List<WireSkill> skills;
  final List<WirePackage> packages;

  /// Name of the skill currently being toggled/invoked, so its row can show a
  /// spinner without freezing the rest of the list.
  final String? busySkill;
  /// Source of the package currently being installed/removed/updated.
  final String? busyPackage;
  /// Set after a successful install so the page can nudge the user to refresh.
  final PackageOpOk? lastOp;

  const PiSurfaceReady({
    required this.runtime,
    required this.skills,
    required this.packages,
    this.busySkill,
    this.busyPackage,
    this.lastOp,
  });

  bool get isEmpty => skills.isEmpty && packages.isEmpty;

  PiSurfaceReady copyWith({
    PiSurfaceRuntime? runtime,
    List<WireSkill>? skills,
    List<WirePackage>? packages,
    String? busySkill,
    String? busyPackage,
    PackageOpOk? lastOp,
    bool clearBusySkill = false,
    bool clearBusyPackage = false,
  }) => PiSurfaceReady(
    runtime: runtime ?? this.runtime,
    skills: skills ?? this.skills,
    packages: packages ?? this.packages,
    busySkill: clearBusySkill ? null : (busySkill ?? this.busySkill),
    busyPackage: clearBusyPackage ? null : (busyPackage ?? this.busyPackage),
    lastOp: lastOp ?? this.lastOp,
  );
}
