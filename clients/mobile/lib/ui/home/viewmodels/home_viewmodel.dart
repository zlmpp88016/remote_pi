import 'dart:async';

import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/data/transport/epk_encoding.dart';
import 'package:mobile/pairing/storage.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/ui/core/viewmodel/viewmodel.dart';
import 'package:mobile/ui/home/states/home_state.dart';

/// HomeViewModel — passive list of paired peers + live presence dots
/// + rooms discovered on each peer (plan 17). A single tile per
/// (peer, room).
///
/// The WS connection is owned by [ConnectionManager] from app boot (plano
/// 12). Home only:
///   - reads the peer list from storage
///   - watches `presenceStream` + `roomsStream` to render dots / rooms
///     in real time
///   - writes [Preferences.selectedRoom] when the user taps a tile so
///     `/chat` knows which (peer, room) to address
class HomeViewModel extends ViewModel<HomeState> {
  final PairingStorage _storage;
  final Preferences _prefs;
  final ConnectionManager _conn;
  StreamSubscription<Map<String, PresenceState>>? _presenceSub;
  StreamSubscription<Map<String, List<RoomInfo>>>? _roomsSub;
  StreamSubscription<ConnectionStatus>? _statusSub;
  bool _relayConnected = false;
  bool _disposed = false;

  HomeViewModel(this._storage, this._prefs, this._conn)
    : super(const HomeLoading()) {
    _relayConnected = _conn.status is StatusOnline;
    _load();
    _presenceSub = _conn.presenceStream.listen(_onPresence);
    _roomsSub = _conn.roomsStream.listen(_onRooms);
    _statusSub = _conn.statusStream.listen(_onStatus);
    // Settings (rename / revoke) and pairing flow both write through
    // PairingStorage; listening here keeps Home in sync without manual
    // notifications between screens.
    _storage.addListener(_onStorageChanged);
  }

  void _onStorageChanged() {
    if (_disposed) return;
    _load();
  }

  /// `true` when the app's WS to the relay is alive (StatusOnline).
  /// When `false`, every room dot should render in the "reconnecting"
  /// colour (amber) regardless of `isRoomLive`, because the app has
  /// no fresh signal on any room.
  bool get isRelayConnected => _relayConnected;

  /// The peer the transport is currently bound to. Only one peer is
  /// connected at a time (`ConnectionManager._activePeer`), so this is
  /// the machine an outbound `workspace_list` would reach — the workspace
  /// picker must target it (or switch to the intended peer first).
  PeerRecord? get activePeer => _conn.activePeer;

  /// `true` when `(epk, roomId)`'s agent is currently mid-turn. Drives
  /// the blue "working" dot on the Home tile.
  ///
  /// Plan/32 — single source of truth: the relay broadcasts `meta.working`
  /// (turn_start/turn_end from the Pi-extension) to ALL subscribed rooms,
  /// exactly like presence, so this reflects EVERY session — connected or
  /// not. We deliberately do NOT OR the DB session index here: that row is
  /// only kept fresh for the currently-connected room (the SyncService
  /// writer follows the active connection), so a session that finishes
  /// while the app is on a DIFFERENT chat would never get its index idled
  /// and the dot would stay blue forever. The relay flag has no such blind
  /// spot.
  bool isRoomWorking(String epk, String roomId) =>
      _conn.isRoomWorking(epk, roomId);

  Future<void> _load() async {
    final peers = await _storage.listPeers();
    if (_disposed) return;
    if (peers.isEmpty) {
      emit(const HomeNoPeer());
      return;
    }
    // Make sure the relay is pushing updates for everyone we know about;
    // the call is idempotent so this is safe even mid-session. The same
    // subscribe also covers rooms (plan 17 — replay block in
    // ConnectionManager sends both presence and rooms subscribes).
    _conn.subscribeToPeers(peers.map((p) => p.remoteEpk).toList());
    emit(
      HomeList(
        peers: peers,
        statusByEpk: _conn.presenceSnapshot,
        roomsByPeer: _conn.roomsSnapshot,
      ),
    );
  }

  void _onPresence(Map<String, PresenceState> snapshot) {
    final s = state;
    if (s is! HomeList) return;
    emit(s.copyWith(statusByEpk: snapshot));
  }

  void _onRooms(Map<String, List<RoomInfo>> snapshot) {
    final s = state;
    if (s is! HomeList) return;
    emit(s.copyWith(roomsByPeer: snapshot));
  }

  void _onStatus(ConnectionStatus status) {
    final next = status is StatusOnline;
    if (next == _relayConnected) return;
    _relayConnected = next;
    // Trigger a re-render of any HomeList so tiles re-evaluate dot
    // colour (room-live vs reconnecting).
    final s = state;
    if (s is HomeList) {
      // emit a duplicate-looking HomeList so context.watch() triggers
      // even though peers / roomsByPeer / presence didn't change.
      // Preserve `filter` — otherwise a status flip would silently reset
      // the user's tab back to the Online default (and, because the new
      // object would then differ, actually fire that reset).
      emit(
        HomeList(
          peers: s.peers,
          statusByEpk: s.statusByEpk,
          roomsByPeer: s.roomsByPeer,
          filter: s.filter,
        ),
      );
    }
  }

  /// Plan-38 Fase 3 — switch the presence tab. No reload: it only swaps the
  /// `filter` in state so [visibleItems] re-derives. No-op when the state
  /// isn't a list or the filter is unchanged.
  void setFilter(HomeFilter filter) {
    final s = state;
    if (s is! HomeList) return;
    if (s.filter == filter) return;
    emit(s.copyWith(filter: filter));
  }

  /// Plan-38 Fase 3 — the items the current [HomeList.filter] keeps. A pure
  /// view over `state.items()`; returns `const []` outside a list state.
  ///
  /// The filter is applied PER SERVER: a peer is online or offline as a whole,
  /// so both tabs show every workspace of the peers that qualify. Filtering
  /// each ROW on its own room would put two rows of the SAME server in
  /// opposite tabs, which contradicts "online/offline describes the room".
  List<HomeItem> get visibleItems {
    final s = state;
    if (s is! HomeList) return const [];
    final all = s.items(normalizeEpk: normalizeEpkForLookup);
    if (s.filter == HomeFilter.all) return all;
    final wantOnline = s.filter == HomeFilter.online;
    final keep = _distinctPeerKeys(all)
        .where((key) => _peerOnline(key) == wantOnline)
        .toSet();
    return all
        .where((it) => keep.contains(normalizeEpkForLookup(it.peer.remoteEpk)))
        .toList();
  }

  /// `true` when the SERVER behind this peer is online — i.e. it has at least
  /// one live room.
  ///
  /// Liveness belongs to the server, not to how many folders it happens to have
  /// open. The badges used to count `(peer, room)` pairs, so one machine running
  /// eight workspaces reported "8 online", which the user read as "8 Pis?" and
  /// rightly called meaningless. Counting distinct peers is the only number that
  /// matches what the list shows: one entry per server.
  bool _peerOnline(String epk) {
    if (!_relayConnected) return false;
    final s = state;
    if (s is! HomeList) return false;
    final rooms = s.roomsByPeer[normalizeEpkForLookup(epk)] ??
        const <RoomInfo>[];
    for (final room in rooms) {
      if (_conn.isRoomLive(epk, room.roomId)) return true;
    }
    return false;
  }

  /// Distinct peers present in [all], in list order. Counting this (rather than
  /// the flattened items) is what makes "online" mean "servers online".
  List<String> _distinctPeerKeys(List<HomeItem> all) {
    final seen = <String>{};
    final out = <String>[];
    for (final it in all) {
      final key = normalizeEpkForLookup(it.peer.remoteEpk);
      if (seen.add(key)) out.add(key);
    }
    return out;
  }

  /// Plan-38 Fase 3 — per-tab counts for the filter badges. Independent of
  /// the active tab (each badge always shows its own slice's size).
  ///
  /// Counted in SERVERS, matching [visibleServers] and the one-row-per-server
  /// list this iteration moves to.
  ({int all, int online, int offline}) get counts {
    final s = state;
    if (s is! HomeList) return (all: 0, online: 0, offline: 0);
    final servers = visibleServers(
      filter: (all: true, online: true, offline: true),
    );
    final online = servers.where((srv) => srv.online).length;
    return (
      all: servers.length,
      online: online,
      offline: servers.length - online,
    );
  }

  /// The servers (peers) to render on Home, one per pairing, in the order the
  /// list already established.
  ///
  /// This is the OUTER layer of room → workspace → session: Home answers "which
  /// machines am I paired with and are they up", and the folders each machine
  /// runs belong to the NEXT screen. Rendering a row per (peer, room) mixed two
  /// layers and made "is this machine online" unanswerable per row.
  ///
  /// A server is listed even when it currently runs no workspaces — the same
  /// reasoning as [counts]: an offline machine with nothing open is a fact the
  /// user needs, not an absence. Use [workspaceCount] for the sub-label.
  ///
  /// [filter] narrows which liveness slices are kept; all three flags on means
  /// "every paired server" (used by [counts] to derive the badge numbers from
  /// the same single source as the list).
  List<HomeServer> visibleServers({
    ({bool all, bool online, bool offline})? filter,
  }) {
    final s = state;
    if (s is! HomeList) return const [];
    final want = filter ?? _filterSlices(s.filter);
    final out = <HomeServer>[];
    for (final peer in s.peers) {
      final key = normalizeEpkForLookup(peer.remoteEpk);
      final online = _peerOnline(key);
      if (online && !want.online) continue;
      if (!online && !want.offline) continue;
      final rooms = s.roomsByPeer[key] ?? const <RoomInfo>[];
      final live = [
        for (final r in rooms)
          if (_conn.isRoomLive(peer.remoteEpk, r.roomId)) r,
      ];
      out.add(
        HomeServer(
          peer: peer,
          online: online,
          workspaceCount: rooms.length,
          liveCount: live.length,
        ),
      );
    }
    out.sort(
      (a, b) =>
          _serverLabel(a).toLowerCase().compareTo(_serverLabel(b).toLowerCase()),
    );
    return out;
  }

  static ({bool all, bool online, bool offline}) _filterSlices(
    HomeFilter f,
  ) => switch (f) {
    HomeFilter.all => (all: true, online: true, offline: true),
    HomeFilter.online => (all: false, online: true, offline: false),
    HomeFilter.offline => (all: false, online: false, offline: true),
  };

  static String _serverLabel(HomeServer s) {
    final p = s.peer;
    if (p.nickname != null && p.nickname!.isNotEmpty) return p.nickname!;
    if (p.sessionName.isNotEmpty) return p.sessionName;
    return p.remoteEpk;
  }

  /// Remember which (peer, room) the user picked. Falls back to
  /// `roomId='main'` when the caller doesn't supply one (legacy /
  /// pre-room-announce). Also flips the ConnectionManager's active
  /// room so subsequent sends carry the right outer envelope.
  ///
  /// Plan-24 follow-up: when the peer record in storage has no
  /// `roomId` yet (post-mesh-restore: the mesh blob doesn't carry
  /// per-device room data, so `PeerRecord.roomId` is null until the
  /// relay announces the room and `ConnectionManager._maybeAdoptLegacyRoom`
  /// catches up), persist the tapped roomId on the PeerRecord too.
  /// Without this, the next cold-start reads `peer.roomId=null` →
  /// `ConnectionManager._connect` falls back to room `'main'` → Pi
  /// never sees the frame → ChatViewModel sits on Connecting/offline
  /// even though the WS is alive.
  Future<void> openSession(String epk, {String? roomId}) async {
    final peers = await _storage.listPeers();
    if (_disposed) return;
    final match = peers.where((p) => p.remoteEpk == epk).cast<PeerRecord?>();
    if (match.isEmpty) return;
    final peer = match.first!;
    final effectiveRoom = (roomId == null || roomId.isEmpty) ? 'main' : roomId;
    await _prefs.setSelectedRoom(epk: epk, roomId: effectiveRoom);
    if (peer.roomId != effectiveRoom) {
      // ignore: unawaited_futures
      _storage.savePeer(peer.copyWith(roomId: effectiveRoom));
    }
    // Tell the manager which Pi-side room to address. Safe to call
    // even if the manager is mid-connect (room is applied on the next
    // send and any active StatusOnline channel).
    _conn.switchRoom(effectiveRoom);
  }

  /// Helper for widgets: pass a peer's url-safe epk → returns standard
  /// for indexing into [HomeList.roomsByPeer] / [HomeList.statusByEpk].
  static String normalizeEpkForLookup(String epk) => toStandardB64(epk);

  /// Plan-17 follow-up — `true` if `(epk, roomId)` is currently live on
  /// the relay. Drives the presence dot on each tile (per-room, not
  /// per-peer anymore).
  bool isRoomLive(String epk, String roomId) => _conn.isRoomLive(epk, roomId);

  /// Long-press menu — rename a single room locally (Pi never sees it).
  Future<void> renameRoom(String epk, String roomId, String? name) =>
      _conn.setRoomLocalName(epk, roomId, name);

  /// Plan/67 — make [peer] the machine the transport is bound to.
  ///
  /// Only one peer is connected at a time, so before asking a machine for
  /// its registered workdirs (`workspace_list` is addressed to that
  /// peer's `host` room) the connection has to be pointed at it. No-op
  /// when it is already active.
  Future<void> focusPeer(PeerRecord peer) => _conn.switchTo(peer);

  /// Long-press menu — delete a cached room locally. Caller should
  /// gate on `!isRoomLive` (only offline rooms can be removed).
  Future<void> deleteRoom(String epk, String roomId) =>
      _conn.deleteCachedRoom(epk, roomId);

  @override
  void dispose() {
    _disposed = true;
    _presenceSub?.cancel();
    _roomsSub?.cancel();
    _statusSub?.cancel();
    _storage.removeListener(_onStorageChanged);
    super.dispose();
  }
}
