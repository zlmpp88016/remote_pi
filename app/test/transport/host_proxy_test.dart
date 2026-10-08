// Plan/69 — host_forward/host_message proxy (spike decision B).
//
// The app anchors on room `host` ONLY. These tests pin the two rules that
// make that work:
//   outbound — child-addressed inner messages get the host_forward wrapper;
//              host control-plane types (host_hello, workspace_*, fs_list,
//              pair_request, ping) go direct;
//   inbound  — host_message is unwrapped and filed by room; a frame for a
//              room we are not addressing is DROPPED (the guard that used
//              to live in the sender-room demux).

import 'dart:convert';
import 'dart:typed_data';

import 'package:app/data/transport/host_proxy.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List _bytes(Map<String, dynamic> j) =>
    Uint8List.fromList(utf8.encode(jsonEncode(j)));

Map<String, dynamic> _decode(Uint8List b) =>
    jsonDecode(utf8.decode(b)) as Map<String, dynamic>;

void main() {
  group('isHostDirectType', () {
    test('the host control plane is direct', () {
      for (final t in const [
        'host_hello',
        'workspace_list',
        'workspace_start',
        'workspace_stop',
        'workspace_restart',
        'fs_list',
        'workspace_add',
        'workspace_remove',
        'pair_request',
        'ping',
      ]) {
        expect(isHostDirectType(t), isTrue, reason: t);
      }
    });

    test('chat/session/action traffic is child-addressed', () {
      for (final t in const [
        'user_message',
        'session_sync',
        'session_list',
        'session_switch',
        'approve_tool',
        'cancel',
        'model_set',
        'thinking_set',
        'list_models',
        'pi_surface',
        'skill_invoke',
        'package_install',
        'tree_navigate',
        'extension_ui_response',
      ]) {
        expect(isHostDirectType(t), isFalse, reason: t);
      }
    });
  });

  group('wrapOutbound', () {
    test('a child-addressed message rides host_forward with the child room', () {
      final inner = _bytes({'type': 'user_message', 'id': 'm1', 'text': 'oi'});
      final wrapped = wrapOutbound(
        inner,
        activeRoom: 'room-abc',
        id: 'fwd_1',
      );
      final j = _decode(wrapped);
      expect(j['type'], 'host_forward');
      expect(j['room'], 'room-abc');
      expect(j['id'], 'fwd_1');
      // ct is base64 of the ORIGINAL inner message — byte-identical.
      expect(utf8.decode(base64.decode(j['ct'] as String)), utf8.decode(inner));
    });

    test('host control-plane messages pass through untouched', () {
      final inner = _bytes({'type': 'workspace_list', 'id': 'w1'});
      final same = wrapOutbound(inner, activeRoom: 'room-abc', id: 'fwd_1');
      expect(same, sameEncodingAs(inner));
    });

    test('host_hello and workspace_restart pass through untouched', () {
      final hello = _bytes({'type': 'host_hello', 'id': 'h1'});
      final restart = _bytes({'type': 'workspace_restart', 'id': 'r1', 'cwd': '/x'});
      expect(
        wrapOutbound(hello, activeRoom: 'room-abc', id: 'f1'),
        sameEncodingAs(hello),
      );
      expect(
        wrapOutbound(restart, activeRoom: 'room-abc', id: 'f2'),
        sameEncodingAs(restart),
      );
    });

    test('ping passes through — the daemon answers it on the host room', () {
      final ping = _bytes({'type': 'ping', 'id': 'p1'});
      expect(
        wrapOutbound(ping, activeRoom: 'room-abc', id: 'f1'),
        sameEncodingAs(ping),
      );
    });

    test('a frame that is not JSON passes through (channel decoder drops it)', () {
      final junk = Uint8List.fromList(utf8.encode('not json'));
      expect(
        wrapOutbound(junk, activeRoom: 'room-abc', id: 'f1'),
        sameEncodingAs(junk),
      );
    });
  });

  group('demuxInbound', () {
    test('a direct host control-plane frame passes through unchanged', () {
      final frame = _bytes({
        'type': 'workspace_list_ok',
        'in_reply_to': 'w1',
        'workspaces': [],
      });
      final out = demuxInbound(frame, activeRoom: 'room-abc');
      expect(out, sameEncodingAs(frame));
    });

    test('a workspace_state push passes through (machine-level, not room-scoped)', () {
      final frame = _bytes({
        'type': 'workspace_state',
        'cwd': '/x',
        'state': 'crashed',
        'last_error': 'boom',
        'restarts': 1,
      });
      expect(demuxInbound(frame, activeRoom: 'room-abc'), sameEncodingAs(frame));
    });

    test('host_message for the active room is unwrapped to the inner bytes', () {
      final inner = _bytes({
        'type': 'agent_chunk',
        'in_reply_to': 'm1',
        'delta': 'hi',
      });
      final frame = _bytes({
        'type': 'host_message',
        'room': 'room-abc',
        'ct': base64.encode(inner),
      });
      final out = demuxInbound(frame, activeRoom: 'room-abc');
      expect(out, isNotNull);
      expect(_decode(out!), _decode(inner));
    });

    test('host_message for ANOTHER room is dropped (no bleed into the chat)', () {
      final inner = _bytes({'type': 'agent_chunk', 'in_reply_to': 'm1', 'delta': 'x'});
      final frame = _bytes({
        'type': 'host_message',
        'room': 'room-other',
        'ct': base64.encode(inner),
      });
      expect(demuxInbound(frame, activeRoom: 'room-abc'), isNull);
    });

    test('a malformed host_message (bad base64) is dropped', () {
      final frame = _bytes({'type': 'host_message', 'room': 'room-abc', 'ct': '!!!'});
      expect(demuxInbound(frame, activeRoom: 'room-abc'), isNull);
    });

    test('a host_message missing room/ct is dropped', () {
      final frame = _bytes({'type': 'host_message'});
      expect(demuxInbound(frame, activeRoom: 'room-abc'), isNull);
    });

    test('a non-JSON frame passes through for the channel decoder to handle', () {
      final junk = Uint8List.fromList(utf8.encode('not json'));
      expect(demuxInbound(junk, activeRoom: 'room-abc'), sameEncodingAs(junk));
    });

    test('round trip: wrapOutbound → demuxInbound restores the inner message', () {
      final inner = _bytes({
        'type': 'user_message',
        'id': 'm1',
        'text': 'ida e volta',
      });
      // The daemon re-emits the forward payload to the child and re-wraps
      // the child reply as host_message — simulate the reply side here.
      final reply = _bytes({'type': 'pong', 'in_reply_to': 'x'});
      final wrappedReply = _bytes({
        'type': 'host_message',
        'room': 'room-abc',
        'ct': base64.encode(reply),
      });
      final forward = wrapOutbound(inner, activeRoom: 'room-abc', id: 'fwd_9');
      expect(_decode(forward)['type'], 'host_forward');
      final out = demuxInbound(wrappedReply, activeRoom: 'room-abc');
      expect(_decode(out!), _decode(reply));
    });
  });
}

/// Byte-identity matcher (Uint8List has no value equality).
Matcher sameEncodingAs(Uint8List other) => predicate((Uint8List b) {
  if (b.length != other.length) return false;
  for (var i = 0; i < b.length; i++) {
    if (b[i] != other[i]) return false;
  }
  return true;
});
