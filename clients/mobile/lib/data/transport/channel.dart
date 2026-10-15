import 'package:app/protocol/protocol.dart';

/// Abstract channel — testable interface over [PlainPeerChannel].
abstract class IChannel {
  Stream<ServerMessage> get serverMessages;
  Future<void> send(ClientMessage msg);
  Future<void> close();
}

/// Optional capability mixed into a channel that also speaks raw relay
/// control frames (subscribe_presence, peer_online, etc — see plano 12).
/// ConnectionManager does an `is IControlLink` cast to drive presence;
/// channels that don't implement it simply skip the subsystem.
abstract class IControlLink {
  Stream<ControlInbound> get controlFrames;
  void sendControl(Map<String, dynamic> json);
}
