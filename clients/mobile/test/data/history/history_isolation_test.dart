// Plan 86 P4 — structural isolation guard for the read-only history path.
//
// A behavior test can only prove what it exercised. These source-level checks
// pin the invariants that must hold for EVERY code path in the feature:
//   * no Hive box / SyncService import (history never hydrates the live box,
//     never changes the frozen `msgs_<epk>__<roomId>` name or the pair URI);
//   * no `user_message` construction in the history UI (the viewer has no
//     composer, so it cannot accidentally send);
//   * no `workspace_start` anywhere in the feature (browsing never starts a Pi),
//     and the ONLY `session_switch` mention is the repository's explicit
//     `switchOnce` transport, called from the confirmed continue action.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> _dartFiles(String dir) {
  final d = Directory(dir);
  if (!d.existsSync()) return const [];
  return [
    for (final entity in d.listSync(recursive: true))
      if (entity is File && entity.path.endsWith('.dart')) entity,
  ];
}

/// Comments quote protocol names on purpose (e.g. "never calls
/// `workspace_start`"); this guard must inspect executable source only.
String _code(String source) {
  final withoutBlock = source.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');
  return withoutBlock
      .split('\n')
      .map((line) => line.replaceFirst(RegExp(r'//.*$'), ''))
      .join('\n');
}

void main() {
  final dataFiles = _dartFiles('lib/data/history');
  final uiFiles = _dartFiles('lib/ui/history');
  final domainFiles = [
    File('lib/domain/contracts/history_repository.dart'),
    ..._dartFiles('lib/domain/history'),
  ];
  final all = [...dataFiles, ...uiFiles, ...domainFiles];

  test('the feature has files to inspect', () {
    expect(dataFiles, isNotEmpty);
    expect(uiFiles, isNotEmpty);
    expect(domainFiles.where((f) => f.existsSync()), isNotEmpty);
  });

  test('never imports the live writer, Hive or the local box facade', () {
    for (final file in all) {
      if (!file.existsSync()) continue;
      final source = _code(file.readAsStringSync());
      expect(
        source,
        isNot(contains('data/sync/sync_service.dart')),
        reason: '${file.path} must not depend on the live sync writer',
      );
      expect(
        source,
        isNot(contains('data/local/boxes.dart')),
        reason: '${file.path} must not touch the Hive box facade',
      );
      expect(
        source,
        isNot(contains('package:hive')),
        reason: '${file.path} must not persist history locally',
      );
      expect(
        source,
        isNot(contains('SessionReadRepository')),
        reason: '${file.path} must not read the live transcript repository',
      );
    }
  });

  test('the viewer has no send path and browsing never starts a workspace', () {
    for (final file in [...uiFiles, ...dataFiles]) {
      final source = _code(file.readAsStringSync());
      expect(
        source,
        isNot(contains('user_message')),
        reason: '${file.path} must not construct/send a user message',
      );
      expect(
        source,
        isNot(contains('UserMessage(')),
        reason: '${file.path} must not construct a live message',
      );
    }
    // The HISTORY UI must never start a Pi. The only start in the whole feature
    // is the repository method called by the confirmed continue precondition
    // (a switch into a stopped room would be silently dropped).
    for (final file in uiFiles) {
      final source = _code(file.readAsStringSync());
      expect(
        source,
        isNot(contains('workspace_start')),
        reason: '${file.path} must never start a Pi to browse',
      );
      expect(
        source,
        isNot(contains('workspaceStart')),
        reason: '${file.path} must not call the start action',
      );
      expect(
        source,
        isNot(contains('WorkspaceStart(')),
        reason: '${file.path} must not construct a workspace_start frame',
      );
    }
    final startMentions = <String>[];
    for (final file in dataFiles) {
      final source = _code(file.readAsStringSync());
      if (source.contains('WorkspaceStart(') ||
          source.contains("'workspace_start'")) {
        startMentions.add(file.path.replaceAll('\\', '/'));
      }
    }
    expect(
      startMentions,
      ['lib/data/history/history_repository_impl.dart'],
      reason: 'only the repository may issue the EXPLICIT continue start',
    );
    // Browsing the workspace list must not even have the capability to start:
    // the start lives behind the confirmed continue in the VIEWER.
    for (final path in [
      'lib/ui/history/history_list_page.dart',
      'lib/ui/history/viewmodels/history_list_viewmodel.dart',
    ]) {
      expect(
        _code(File(path).readAsStringSync()),
        isNot(contains('startWorkspace')),
        reason: '$path must not start a workspace',
      );
    }
  });

  test('the only switch mention is the repository explicit-once transport', () {
    final switchMentions = <String>[];
    for (final file in all) {
      if (!file.existsSync()) continue;
      final source = _code(file.readAsStringSync());
      if (source.contains('SessionSwitch(') ||
          source.contains("'session_switch'")) {
        switchMentions.add(file.path.replaceAll('\\', '/'));
      }
    }
    // Exactly one file may put a switch on the wire: the repository's
    // `switchOnce`. The ViewModel calls that method by name (switchOnce), never
    // by frame literal.
    expect(switchMentions, [
      'lib/data/history/history_repository_impl.dart',
    ], reason: 'no other history file may construct session_switch');
    final vm = _code(
      File(
        'lib/ui/history/viewmodels/history_viewer_viewmodel.dart',
      ).readAsStringSync(),
    );
    expect(vm, contains('switchOnce'));
    expect(vm, contains('_switchAckTimeout'));
    expect(vm, contains('_watchForTarget'));
  });
}
