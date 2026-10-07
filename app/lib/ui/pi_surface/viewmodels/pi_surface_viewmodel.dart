import 'package:app/data/sessions/session_catalog.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';
import 'package:app/ui/pi_surface/states/pi_surface_state.dart';
import 'package:app/ui/workspaces/viewmodels/workspace_browser_viewmodel.dart';

/// Plan/68 — drives the "Pi" page of a workspace: what the machine's Pi has
/// installed, plus the closed-vocabulary management actions.
///
/// The page is deliberately not optimistic. A toggle or install is only
/// reflected after the host acknowledges it, because the host is the source of
/// truth (an exclusion pattern may already exist, a package may fail to
/// install). Reporting a change the machine did not make would be exactly the
/// fabrication the surface contract forbids.
class PiSurfaceViewModel extends ViewModel<PiSurfaceState> {
  PiSurfaceViewModel(this._catalog) : super(const PiSurfaceLoading()) {
    // ignore: discarded_futures
    reload();
  }

  final SessionCatalog _catalog;

  /// Fetch the surface. Used by the constructor's first load and by Retry.
  Future<void> reload() async {
    emit(const PiSurfaceLoading());
    try {
      final ok = await _catalog.piSurface();
      emit(
        PiSurfaceReady(
          runtime: ok.runtime,
          skills: ok.skills,
          packages: ok.packages,
        ),
      );
    } on WorkspaceControlFailure catch (e) {
      emit(PiSurfaceError(message: humanError(e.message)));
    } catch (e) {
      emit(PiSurfaceError(message: 'Could not read this Pi: $e'));
    }
  }

  /// Enable/disable a skill, then re-read so the row shows the persisted state.
  Future<bool> setSkillEnabled(String name, bool enabled) async {
    final s = state;
    if (s is! PiSurfaceReady || s.busySkill != null) return false;
    emit(s.copyWith(busySkill: name));
    try {
      await _catalog.setSkillEnabled(name, enabled);
      await reload();
      return true;
    } on WorkspaceControlFailure catch (e) {
      emit(PiSurfaceError(message: humanError(e.message)));
      return false;
    } catch (e) {
      emit(PiSurfaceError(message: 'Could not change the skill: $e'));
      return false;
    }
  }

  /// Force a skill. The output arrives through the chat channels, so this only
  /// reports whether the dispatch was accepted.
  Future<bool> invokeSkill(String name, {String? args}) async {
    final s = state;
    if (s is! PiSurfaceReady || s.busySkill != null) return false;
    emit(s.copyWith(busySkill: name));
    try {
      final ok = await _catalog.invokeSkill(name, args: args);
      // Re-read to drop the spinner; the skill itself produced no state change.
      final reloaded = await _catalog.piSurface();
      emit(
        PiSurfaceReady(
          runtime: reloaded.runtime,
          skills: reloaded.skills,
          packages: reloaded.packages,
        ),
      );
      return ok.name.isNotEmpty;
    } on WorkspaceControlFailure catch (e) {
      emit(PiSurfaceError(message: humanError(e.message)));
      return false;
    } catch (e) {
      emit(PiSurfaceError(message: 'Could not run the skill: $e'));
      return false;
    }
  }

  /// Install a package. [confirmThirdParty] must come from an explicit user
  /// accept in the UI — the host refuses the request without it.
  Future<bool> installPackage({
    required String source,
    required PackageScope scope,
    required bool confirmThirdParty,
  }) async {
    final s = state;
    if (s is! PiSurfaceReady || s.busyPackage != null) return false;
    emit(s.copyWith(busyPackage: source));
    try {
      final ok = await _catalog.installPackage(
        source: source,
        scope: scope,
        confirmThirdParty: confirmThirdParty,
      );
      await _refreshPreserving(ok);
      return true;
    } on WorkspaceControlFailure catch (e) {
      emit(PiSurfaceError(message: humanError(e.message)));
      return false;
    } catch (e) {
      emit(PiSurfaceError(message: 'Could not install the package: $e'));
      return false;
    }
  }

  Future<bool> removePackage(String source, {PackageScope? scope}) async {
    final s = state;
    if (s is! PiSurfaceReady || s.busyPackage != null) return false;
    emit(s.copyWith(busyPackage: source));
    try {
      final ok = await _catalog.removePackage(source, scope: scope);
      await _refreshPreserving(ok);
      return true;
    } on WorkspaceControlFailure catch (e) {
      emit(PiSurfaceError(message: humanError(e.message)));
      return false;
    } catch (e) {
      emit(PiSurfaceError(message: 'Could not remove the package: $e'));
      return false;
    }
  }

  /// Reconcile one package, or every installed one when [source] is omitted.
  Future<bool> updatePackages({String? source}) async {
    final s = state;
    if (s is! PiSurfaceReady || s.busyPackage != null) return false;
    emit(s.copyWith(busyPackage: source ?? '*'));
    try {
      final ok = await _catalog.updatePackages(source: source);
      await _refreshPreserving(ok);
      return true;
    } on WorkspaceControlFailure catch (e) {
      emit(PiSurfaceError(message: humanError(e.message)));
      return false;
    } catch (e) {
      emit(PiSurfaceError(message: 'Could not update the packages: $e'));
      return false;
    }
  }

  /// Re-read the surface after a package op. A package op can fail to appear
  /// (an npm source may not resolve until `package_update`), so a resolution
  /// failure here must not discard the successful acknowledgment — keep the
  /// old lists and just record [op].
  Future<void> _refreshPreserving(PackageOpOk op) async {
    final s = state;
    final previous = s is PiSurfaceReady ? s : null;
    try {
      final ok = await _catalog.piSurface();
      emit(
        PiSurfaceReady(
          runtime: ok.runtime,
          skills: ok.skills,
          packages: ok.packages,
          lastOp: op,
        ),
      );
    } catch (_) {
      emit(
        (previous ??
                const PiSurfaceReady(
                  runtime: PiSurfaceRuntime(running: false),
                  skills: [],
                  packages: [],
                ))
            .copyWith(
          clearBusySkill: true,
          clearBusyPackage: true,
          lastOp: op,
        ),
      );
    }
  }

  /// Typed host errors → user-facing copy. Reuses the workspace browser's
  /// mapping so every plan/68 error reads the same everywhere.
  static String humanError(String code) => WorkspaceBrowserViewModel.humanError(code);
}
