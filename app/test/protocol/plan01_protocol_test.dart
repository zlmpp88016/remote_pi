// Plan 01 — protocol surface for transcript pagination, runtime status and the
// session tree / branching actions.
//
// Mirrors the contract in `pi-extension/src/protocol/types.ts`:
//   ClientMessage:  session_sync.before, tree_get, tree_navigate,
//                   session_fork, session_clone
//   ServerMessage:  session_history.older_cursor/has_older, runtime_status,
//                   tree_snapshot_ok, tree_navigate_ok, session_fork_ok,
//                   session_clone_ok
//
// Every new field is optional on the wire: an older Pi must keep working, so
// the "absent" cases are asserted explicitly rather than assumed.

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('session_sync pagination', () {
    test('omits before when no cursor is supplied', () {
      expect(SessionSync(id: 'r1').toJson(), {
        'type': 'session_sync',
        'id': 'r1',
      });
    });

    test('still encodes limit without a cursor', () {
      expect(SessionSync(id: 'r1', limit: 50).toJson(), {
        'type': 'session_sync',
        'id': 'r1',
        'limit': 50,
      });
    });

    test('encodes before alongside limit', () {
      expect(SessionSync(id: 'r1', limit: 50, before: 'Y3Vyc29y').toJson(), {
        'type': 'session_sync',
        'id': 'r1',
        'limit': 50,
        'before': 'Y3Vyc29y',
      });
    });
  });

  group('session_history paging fields', () {
    test('a pre-pagination history decodes to no cursor and hasOlder=false', () {
      final h = SessionHistory.fromJson({
        'type': 'session_history',
        'in_reply_to': 'r1',
        'session_started_at': 1716234500000,
        'events': <dynamic>[],
        'eos': true,
        'truncated': false,
      });
      expect(h.olderCursor, isNull);
      expect(h.hasOlder, isFalse);
    });

    test('decodes older_cursor and has_older', () {
      final h = SessionHistory.fromJson({
        'type': 'session_history',
        'in_reply_to': 'r1',
        'session_started_at': 1716234500000,
        'events': <dynamic>[],
        'eos': true,
        'truncated': false,
        'older_cursor': 'MTcxNjIzNDYwMTAwMA',
        'has_older': true,
      });
      expect(h.olderCursor, 'MTcxNjIzNDYwMTAwMA');
      expect(h.hasOlder, isTrue);
    });
  });

  group('tree requests', () {
    const fence = TreeFence(
      snapshotVersion: 'treev_a',
      branchVersion: 'branchv_b',
      leafId: 'u2',
    );

    test('tree_get encodes only its id', () {
      expect(TreeGet(id: 'r1').toJson(), {'type': 'tree_get', 'id': 'r1'});
    });

    test('tree_navigate carries the double fence and summarize', () {
      expect(
        TreeNavigate(
          id: 'r1',
          targetEntryId: 'u1',
          fence: fence,
          summarize: true,
        ).toJson(),
        {
          'type': 'tree_navigate',
          'id': 'r1',
          'target_entry_id': 'u1',
          'base_snapshot_version': 'treev_a',
          'base_branch_version': 'branchv_b',
          'base_leaf_id': 'u2',
          'summarize': true,
        },
      );
    });

    test('tree_navigate defaults summarize to false', () {
      final j = TreeNavigate(
        id: 'r1',
        targetEntryId: 'u1',
        fence: fence,
      ).toJson();
      expect(j['summarize'], isFalse);
    });

    test('session_fork carries the target and fence', () {
      expect(
        SessionFork(id: 'r1', targetEntryId: 'u1', fence: fence).toJson(),
        {
          'type': 'session_fork',
          'id': 'r1',
          'target_entry_id': 'u1',
          'base_snapshot_version': 'treev_a',
          'base_branch_version': 'branchv_b',
          'base_leaf_id': 'u2',
        },
      );
    });

    test('session_clone carries only the fence', () {
      expect(SessionClone(id: 'r1', fence: fence).toJson(), {
        'type': 'session_clone',
        'id': 'r1',
        'base_snapshot_version': 'treev_a',
        'base_branch_version': 'branchv_b',
        'base_leaf_id': 'u2',
      });
    });

    test('a null leaf id survives the round trip', () {
      const rootFence = TreeFence(
        snapshotVersion: 'treev_a',
        branchVersion: 'branchv_b',
        leafId: null,
      );
      final j = SessionClone(id: 'r1', fence: rootFence).toJson();
      expect(j['base_leaf_id'], isNull);
    });

    test('TreeFence.fromSnapshot copies all three fence values', () {
      final snapshot = TreeSnapshot.fromJson({
        'snapshot_version': 'treev_a',
        'branch_version': 'branchv_b',
        'leaf_id': 'u2',
        'entries': <dynamic>[],
      });
      final built = TreeFence.fromSnapshot(snapshot);
      expect(built.snapshotVersion, 'treev_a');
      expect(built.branchVersion, 'branchv_b');
      expect(built.leafId, 'u2');
    });
  });

  group('runtime_status', () {
    test('decodes a full status', () {
      final msg = ServerMessage.fromJson({
        'type': 'runtime_status',
        'status': {
          'model': {
            'provider': 'anthropic',
            'id': 'claude-sonnet-4-6',
            'name': 'Claude Sonnet 4.6',
            'context_window': 200000,
            'reasoning': true,
          },
          'thinking_level': 'high',
          'usage': {
            'input': 18500,
            'output': 2400,
            'cache_read': 12000,
            'cache_write': 800,
            'cost': {
              'input': 0.0555,
              'output': 0.036,
              'cache_read': 0.0036,
              'cache_write': 0.003,
              'total': 0.0981,
            },
          },
          'context': {'tokens': 19800, 'context_window': 200000, 'percent': 9.9},
          'updated_at': '2026-09-29T10:05:00.000Z',
        },
      });

      expect(msg, isA<RuntimeStatusMessage>());
      final status = (msg as RuntimeStatusMessage).status;
      expect(status.model?.id, 'claude-sonnet-4-6');
      expect(status.model?.displayName, 'Claude Sonnet 4.6');
      expect(status.model?.reasoning, isTrue);
      expect(status.thinkingLevel, ThinkingLevel.high);
      expect(status.usage.input, 18500);
      expect(status.usage.cost.total, closeTo(0.0981, 1e-9));
      expect(status.context?.tokens, 19800);
      expect(status.context?.percent, closeTo(9.9, 1e-9));
      expect(status.updatedAt, isNotNull);
    });

    test('a minimal status does not throw and reports absence honestly', () {
      final msg = ServerMessage.fromJson({
        'type': 'runtime_status',
        'status': {
          'model': null,
          'thinking_level': null,
          'usage': {
            'input': 0,
            'output': 0,
            'cache_read': 0,
            'cache_write': 0,
            'cost': {
              'input': 0,
              'output': 0,
              'cache_read': 0,
              'cache_write': 0,
              'total': 0,
            },
          },
          'context': null,
          'updated_at': '2026-09-29T10:05:30.000Z',
        },
      }) as RuntimeStatusMessage;

      final status = msg.status;
      expect(status.model, isNull);
      expect(status.thinkingLevel, isNull);
      expect(status.context, isNull);
      expect(status.usage.input, 0);
      expect(status.usage.cost.total, 0);
    });

    test('displayName falls back to the id when name is absent', () {
      final model = RuntimeModelInfo.fromJson({
        'provider': 'anthropic',
        'id': 'claude-x',
      });
      expect(model.displayName, 'claude-x');
      expect(model.reasoning, isFalse);
      expect(model.contextWindow, isNull);
    });

    test('an unknown thinking level decodes to null rather than throwing', () {
      final status = RuntimeStatus.fromJson({
        'thinking_level': 'hyper',
        'usage': <String, dynamic>{},
      });
      expect(status.thinkingLevel, isNull);
    });
  });

  group('tree replies', () {
    test('tree_snapshot_ok decodes entries and both versions', () {
      final msg = ServerMessage.fromJson({
        'type': 'tree_snapshot_ok',
        'in_reply_to': 'r1',
        'snapshot': {
          'snapshot_version': 'treev_a',
          'branch_version': 'branchv_b',
          'leaf_id': 'a2',
          'entries': [
            {
              'id': 'u1',
              'parent_id': null,
              'type': 'message',
              'role': 'user',
              'title': 'user',
              'preview': 'hello',
              'timestamp': '2026-09-29T10:00:00.000Z',
              'is_current_leaf': false,
              'is_on_active_branch': true,
              'is_forkable': true,
              'navigation_behavior': 'edit_prompt',
            },
          ],
          'default_filter': 'default',
          'filters': ['default', 'user', 'assistant', 'tools'],
        },
      }) as TreeSnapshotOk;

      expect(msg.snapshot.snapshotVersion, 'treev_a');
      expect(msg.snapshot.branchVersion, 'branchv_b');
      expect(msg.snapshot.leafId, 'a2');
      expect(msg.snapshot.entries, hasLength(1));
      final entry = msg.snapshot.entries.single;
      expect(entry.id, 'u1');
      expect(entry.parentId, isNull);
      expect(entry.role, 'user');
      expect(entry.isForkable, isTrue);
      expect(entry.navigationBehavior, 'edit_prompt');
    });

    test('tree_navigate_ok decodes the new versions and draft', () {
      final msg = ServerMessage.fromJson({
        'type': 'tree_navigate_ok',
        'in_reply_to': 'r1',
        'leaf_id': 'u2',
        'snapshot_version': 'treev_c',
        'branch_version': 'branchv_d',
        'editor_text': 'e o paginador?',
      }) as TreeNavigateOk;

      expect(msg.leafId, 'u2');
      expect(msg.snapshotVersion, 'treev_c');
      expect(msg.branchVersion, 'branchv_d');
      expect(msg.editorText, 'e o paginador?');
    });

    test('tree_navigate_ok tolerates a missing editor_text', () {
      final msg = ServerMessage.fromJson({
        'type': 'tree_navigate_ok',
        'in_reply_to': 'r1',
        'leaf_id': 'a1',
        'snapshot_version': 'treev_c',
        'branch_version': 'branchv_d',
      }) as TreeNavigateOk;
      expect(msg.editorText, isNull);
    });

    test('session_fork_ok returns the prompt text for the composer', () {
      final msg = ServerMessage.fromJson({
        'type': 'session_fork_ok',
        'in_reply_to': 'r1',
        'editor_text': 'explique o reducer',
      }) as SessionForkOk;
      expect(msg.editorText, 'explique o reducer');
    });

    test('session_clone_ok needs only the reply id', () {
      final msg = ServerMessage.fromJson({
        'type': 'session_clone_ok',
        'in_reply_to': 'r1',
      });
      expect(msg, isA<SessionCloneOk>());
    });
  });

  group('action_error for tree actions', () {
    test('tree actions parse through the ActionName enum', () {
      for (final name in [
        ActionName.treeGet,
        ActionName.treeNavigate,
        ActionName.sessionFork,
        ActionName.sessionClone,
      ]) {
        final msg = ServerMessage.fromJson({
          'type': 'action_error',
          'in_reply_to': 'r1',
          'action': name.wire,
          'error': 'tree_state_changed',
        }) as ActionError;
        expect(msg.action, name);
        expect(msg.error, 'tree_state_changed');
      }
    });

    test('an unrecognised action does not throw', () {
      final msg = ServerMessage.fromJson({
        'type': 'action_error',
        'in_reply_to': 'r1',
        'action': 'some_future_action',
        'error': 'nope',
      }) as ActionError;
      expect(msg.rawAction, 'some_future_action');
      expect(msg.error, 'nope');
    });
  });
}
