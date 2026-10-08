// Plan/69 — wire contract of the host-first messages: host_hello_ok,
// workspace_state (lifecycle push), workspace_restart(_ok/_error) and the
// host_message proxy wrapper. Parsing is the contract: a drift here means
// the app silently stops understanding the host.

import 'dart:convert';

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('HostHello / host_hello_ok', () {
    test('host_hello serializes with the documented shape', () {
      final j = HostHello(id: 'h1').toJson();
      expect(j, {'type': 'host_hello', 'id': 'h1'});
    });

    test('host_hello_ok parses daemon + capabilities', () {
      final msg = ServerMessage.fromJson({
        'type': 'host_hello_ok',
        'in_reply_to': 'h1',
        'daemon': {'version': '1.2.3', 'hostname': 'mac do jacob', 'platform': 'darwin'},
        'capabilities': ['host_pairing', 'workspace_state', 'host_forward', 'fs_nav'],
      });
      expect(msg, isA<HostHelloOk>());
      final ok = msg as HostHelloOk;
      expect(ok.inReplyTo, 'h1');
      expect(ok.daemon.version, '1.2.3');
      expect(ok.daemon.hostname, 'mac do jacob');
      expect(ok.daemon.platform, 'darwin');
      expect(ok.capabilities, contains('workspace_state'));
    });

    test('host_hello_ok tolerates null daemon fields (never fabricated)', () {
      final msg = ServerMessage.fromJson({
        'type': 'host_hello_ok',
        'in_reply_to': 'h1',
        'daemon': {'version': null, 'hostname': null, 'platform': null},
        'capabilities': <String>[],
      }) as HostHelloOk;
      expect(msg.daemon.version, isNull);
      expect(msg.daemon.hostname, isNull);
      expect(msg.daemon.platform, isNull);
      expect(msg.capabilities, isEmpty);
    });

    test('host_hello_ok survives a missing daemon block entirely', () {
      final msg = ServerMessage.fromJson({
        'type': 'host_hello_ok',
        'in_reply_to': 'h1',
      }) as HostHelloOk;
      expect(msg.daemon.version, isNull);
      expect(msg.capabilities, isEmpty);
    });
  });

  group('workspace_state (lifecycle push)', () {
    test('parses a crashed push with last_error + restarts', () {
      final msg = ServerMessage.fromJson({
        'type': 'workspace_state',
        'cwd': '/Users/jacob/Projects/remote_pi',
        'state': 'crashed',
        'last_error': 'Pi process exited with code 1 (SIGKILL)',
        'restarts': 2,
      });
      expect(msg, isA<WorkspaceState>());
      final s = msg as WorkspaceState;
      expect(s.cwd, '/Users/jacob/Projects/remote_pi');
      expect(s.state, WorkspaceStateValue.crashed);
      expect(s.lastError, contains('SIGKILL'));
      expect(s.restarts, 2);
      // No in_reply_to — it is an unsolicited push.
      expect(s.rawState, 'crashed');
    });

    test('parses every documented state value', () {
      for (final (wire, expected) in [
        ('running', WorkspaceStateValue.running),
        ('starting', WorkspaceStateValue.starting),
        ('crashed', WorkspaceStateValue.crashed),
        ('stopped', WorkspaceStateValue.stopped),
      ]) {
        final s = ServerMessage.fromJson({
          'type': 'workspace_state',
          'cwd': '/x',
          'state': wire,
          'last_error': null,
          'restarts': 0,
        }) as WorkspaceState;
        expect(s.state, expected, reason: wire);
        expect(s.lastError, isNull);
        expect(s.restarts, 0);
      }
    });

    test('an unknown state maps to stopped but keeps the raw wire value', () {
      final s = ServerMessage.fromJson({
        'type': 'workspace_state',
        'cwd': '/x',
        'state': 'paused',
        'last_error': null,
        'restarts': 0,
      }) as WorkspaceState;
      expect(s.state, WorkspaceStateValue.stopped);
      expect(s.rawState, 'paused');
    });
  });

  group('workspace_restart', () {
    test('workspace_restart serializes with cwd', () {
      expect(WorkspaceRestart(id: 'r1', cwd: '/x').toJson(), {
        'type': 'workspace_restart',
        'id': 'r1',
        'cwd': '/x',
      });
    });

    test('workspace_restart_ok parses', () {
      final msg = ServerMessage.fromJson({
        'type': 'workspace_restart_ok',
        'in_reply_to': 'r1',
        'cwd': '/x',
        'daemon_id': 'a1b2c3d4',
      });
      expect(msg, isA<WorkspaceRestartOk>());
      final ok = msg as WorkspaceRestartOk;
      expect(ok.inReplyTo, 'r1');
      expect(ok.cwd, '/x');
      expect(ok.daemonId, 'a1b2c3d4');
    });

    test('workspace_restart_error keeps the raw code', () {
      final msg = ServerMessage.fromJson({
        'type': 'workspace_restart_error',
        'in_reply_to': 'r1',
        'code': 'spawn_failed',
        'message': 'could not spawn pi in /x',
      });
      expect(msg, isA<WorkspaceRestartError>());
      final err = msg as WorkspaceRestartError;
      expect(err.inReplyTo, 'r1');
      expect(err.code, 'spawn_failed');
      expect(err.message, contains('spawn'));
    });
  });

  group('host_message (proxy wrapper)', () {
    test('parses room + ct verbatim', () {
      final inner = utf8.encode('{"type":"agent_chunk","in_reply_to":"m1","delta":"hi"}');
      final msg = ServerMessage.fromJson({
        'type': 'host_message',
        'room': 'room-abc',
        'ct': base64.encode(inner),
      });
      expect(msg, isA<HostMessage>());
      final hm = msg as HostMessage;
      expect(hm.room, 'room-abc');
      expect(utf8.decode(base64.decode(hm.ct)), contains('agent_chunk'));
    });
  });
}
