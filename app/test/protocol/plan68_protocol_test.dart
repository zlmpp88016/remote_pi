// Plan/68 — protocol surface for host filesystem navigation + the explicit
// workspace catalog. Mirrors `pi-extension/src/protocol/types.ts`:
//   ClientMessage:  fs_list, workspace_add, workspace_remove
//   ServerMessage:  fs_list_ok (+ source on workspace_list_ok rows)
//
// The payload is the contract between app and extension, so these tests pin the
// exact JSON keys — a rename on one side must fail here.

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('plan/68 — ClientMessage', () {
    test('FsList encodes path + show_hidden', () {
      expect(
        FsList(id: 'r1', path: '~/ws').toJson(),
        {'type': 'fs_list', 'id': 'r1', 'path': '~/ws', 'show_hidden': false},
      );
      expect(
        FsList(id: 'r2', path: '/abs', showHidden: true).toJson(),
        {'type': 'fs_list', 'id': 'r2', 'path': '/abs', 'show_hidden': true},
      );
    });

    test('WorkspaceAdd encodes path', () {
      expect(
        WorkspaceAdd(id: 'r3', path: '/abs').toJson(),
        {'type': 'workspace_add', 'id': 'r3', 'path': '/abs'},
      );
    });

    test('WorkspaceRemove encodes path', () {
      expect(
        WorkspaceRemove(id: 'r4', path: '/abs').toJson(),
        {'type': 'workspace_remove', 'id': 'r4', 'path': '/abs'},
      );
    });
  });

  group('plan/68 — ServerMessage', () {
    test('fs_list_ok decodes path, parent and entries', () {
      final msg = ServerMessage.fromJson(const {
        'type': 'fs_list_ok',
        'in_reply_to': 'r1',
        'path': '/abs/ws',
        'parent': '/abs',
        'entries': [
          {'name': 'remote_pi', 'kind': 'dir', 'is_repo': true},
          {'name': 'plain', 'kind': 'dir'},
          {'name': 'a.txt', 'kind': 'file'},
        ],
      });
      expect(msg, isA<FsListOk>());
      final ok = msg as FsListOk;
      expect(ok.inReplyTo, 'r1');
      expect(ok.path, '/abs/ws');
      expect(ok.parent, '/abs');
      expect(ok.entries.map((e) => e.name), ['remote_pi', 'plain', 'a.txt']);
      expect(ok.entries.first.isDir, isTrue);
      expect(ok.entries.first.isRepo, isTrue);
      expect(ok.entries.last.isDir, isFalse);
    });

    test('fs_list_ok with parent: null is the filesystem root', () {
      final ok = ServerMessage.fromJson(const {
        'type': 'fs_list_ok',
        'in_reply_to': 'r1',
        'path': '/',
        'parent': null,
        'entries': <Map<String, dynamic>>[],
      }) as FsListOk;
      expect(ok.parent, isNull);
      expect(ok.entries, isEmpty);
    });

    test('workspace_list_ok carries source daemon|added', () {
      final msg = ServerMessage.fromJson(const {
        'type': 'workspace_list_ok',
        'in_reply_to': 'r1',
        'workspaces': [
          {
            'cwd': '/proj/a',
            'daemon_id': 'd1',
            'room_id': 'r-a',
            'name': 'a',
            'live': true,
            'daemon': true,
            'source': 'daemon',
          },
          {
            'cwd': '/proj/b',
            'daemon_id': 'd2',
            'room_id': 'r-b',
            'name': 'b',
            'live': false,
            'daemon': false,
            'source': 'added',
          },
        ],
      }) as WorkspaceListOk;
      expect(msg.workspaces.map((w) => w.source), ['daemon', 'added']);
      expect(msg.workspaces.first.daemon, isTrue);
      expect(msg.workspaces.last.daemon, isFalse);
    });

    test('a workspace row without source defaults to daemon (back-compat)', () {
      final ok = ServerMessage.fromJson(const {
        'type': 'workspace_list_ok',
        'in_reply_to': 'r1',
        'workspaces': [
          {
            'cwd': '/proj/a',
            'daemon_id': 'd1',
            'room_id': 'r-a',
            'name': 'a',
            'live': true,
            'daemon': true,
          },
        ],
      }) as WorkspaceListOk;
      expect(ok.workspaces.single.source, 'daemon');
    });
  });
}
