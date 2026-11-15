// Plan/31 — SyncService: the SINGLE writer of the local SSOT.
//
// Consumes the channel (ConnectionManager status + PeerChannel
// serverMessages) and writes row-granular records to Hive (v2 boxes). The UI
// never touches this stream — it reads the DB via the read repositories.
//
// Streaming is the ONE exception to SSOT (#7): AgentChunk deltas are coalesced
// into an in-memory Stream<StreamingMessage?> and NEVER written to the DB; only
// the finalized message lands in the box on `agent_done`.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:mobile/data/local/boxes.dart';
import 'package:mobile/data/local/records/message_record.dart';
import 'package:mobile/data/local/records/runtime_record.dart';
import 'package:mobile/data/local/records/session_index_record.dart';
import 'package:mobile/data/sync/sync_events.dart';
import 'package:mobile/data/transport/connection_manager.dart';
import 'package:mobile/domain/contracts/service.dart';
import 'package:mobile/domain/session_state.dart';
import 'package:mobile/protocol/protocol.dart';
import 'package:mobile/protocol/uuid7.dart';
import 'package:flutter/foundation.dart';
import 'package:hive_flutter/hive_flutter.dart';

class SyncService extends Service {
  final ConnectionManager _conn;
  final LocalBoxes _boxes;

  StreamSubscription<ConnectionStatus>? _connSub;
  StreamSubscription<ServerMessage>? _msgSub;
  StreamSubscription<Map<String, List<RoomInfo>>>? _roomsSub;
  StreamSubscription<Map<String, PresenceState>>? _presenceSub;

  // Active session being written (follows ConnectionManager).
  String? _activeEpk;
  String _activeRoomId = 'main';

  // F2 — WHICH session the rows of each box belong to, keyed by
  // [LocalBoxes.sessionKey] (the same key the durable index uses).
  //
  // The durable box is named `msgs_<epk>__<roomId>`, so every session of a
  // workspace shares ONE box and its rows only mean anything for the session
  // that wrote them. These ids are never derived here: they are copied from a
  // server frame (`session_switch_ok.session_id` /
  // `session_list_ok.current_id`). A CHANGE of the id for a box is what makes
  // that box's rows foreign — the session dimension [activate] did not have.
  // Keyed per box rather than held as one "current" value: the id describes the
  // box it was reported for, and a revisit must still know which session that
  // box holds instead of mistaking it for a first sight.
  final Map<String, String> _sessionIdByBox = <String, String>{};

  // F2 — deferred cleanup, one entry per box. A session change was recorded for
  // a box while the writer was no longer bound to it, so its rows could not be
  // dropped at the time (clearing a box this change never owned would delete
  // another session's data). Left undone they would be read back as the NEXT
  // session's transcript — the cross-talk this fixes — so [activate] finishes
  // the wipe on rebinding. A set, not a slot: each box's clean-up is independent
  // and dropping one would strand that room's stale rows.
  final Set<String> _pendingSessionResets = <String>{};

  // In-memory dedupe + ordering for the active session's msgs box. Rebuilt on
  // [activate]. Key = `<role>:<id>` so a user msg and the assistant reply that
  // shares its id don't collide.
  final Map<String, int> _idToSeq = {};
  int _nextSeq = 0;
  bool _indexLoaded = false;

  // Serialise box mutations so concurrent async writes stay ordered.
  Future<void> _writeChain = Future<void>.value();

  // Streaming — in-memory only (#7).
  final StringBuffer _chunkBuffer = StringBuffer();
  String _chunkReplyTo = '';
  Timer? _flushTimer;
  StreamingMessage? _streaming;
  final StreamController<StreamingMessage?> _streamingController =
      StreamController<StreamingMessage?>.broadcast();

  final StreamController<SessionEvent> _eventController =
      StreamController<SessionEvent>.broadcast();

  // Plan/57 — transient interactive extension prompts (ask_user via pi-ask).
  // Never persisted (live UI requests, not chat history); surfaced to the
  // ChatViewModel, which opens a full-screen modal.
  final StreamController<ExtensionUiRequest> _extensionUiController =
      StreamController<ExtensionUiRequest>.broadcast();

  List<QueuedMsg> _queuedMessages = const [];
  final StreamController<List<QueuedMsg>> _queuedController =
      StreamController<List<QueuedMsg>>.broadcast();

  bool _pendingSyncRequest = false;
  Timer? _syncDebounce;
  Timer? _pendingSyncRetry;

  /// The last `session_sync` SEND of the current attempt (see
  /// [_syncWindowSince]).
  ///
  /// `isRoomLive` cannot be trusted around a `session_switch`: the Pi stages
  /// the target, acks, exits and is respawned by the supervisor, and the relay
  /// keeps announcing the room for a while after it stopped listening. Sending
  /// into that window loses the frame with no error at all — which is exactly
  /// how the chat ended up permanently empty after resuming a session. So the
  /// send is not the end of the story: a silence longer than the observed
  /// cold-start latency is retried until the transcript arrives.
  DateTime? _awaitingSyncSince;

  /// When the CURRENT attempt started, whether or not a frame went out.
  ///
  /// [_awaitingSyncSince] is the last SEND, so every resend advances it; this is
  /// the window the whole attempt lives in and a resend never moves it. The two
  /// clocks must not be one: timing resends off the window start would send one
  /// per tick, and letting a resend re-arm the window would push the give-up out
  /// of reach on every retry — the same shape of bug the deferred
  /// `_pendingSyncRequest` early-return produced (measured: 163 s of retries
  /// whose `waited` never left the 3.008–3.044 s band). Opened by the first
  /// request (sent OR deferred) and cleared only when an answer settles the
  /// window or the deadline gives up on it, so one attempt is bounded however
  /// the room behaves.
  DateTime? _syncWindowSince;

  /// Set when a window ended at the deadline while it was still WAITING for the
  /// room (nothing was ever sent). That is the one give-up that deserves another
  /// attempt without the user asking: the room coming back means the daemon the
  /// chat was waiting for is listening again. It fires once — and only on a
  /// room-live edge, not on every rooms broadcast — so a room that stays down
  /// costs nothing after the notice.
  bool _resyncOnRoomReturn = false;

  /// The ids of the `session_sync` frames SENT in this attempt, newest last —
  /// the only frames that may settle it.
  ///
  /// The host answers a switch by broadcasting an EMPTY `session_history`
  /// BEFORE the ack, carrying `in_reply_to` = the id of the `session_switch`
  /// (the reset has to land before the ack — see `_resetSessionForNew`).
  /// Settling on ANY answer therefore released the loading state in the middle
  /// of every daemon switch: the chat fell back to "这里还没有内容" on the very
  /// session the user had just picked, and only the ack put the skeleton back.
  /// An id from this list is the only proof that the room answered OUR question
  /// about the transcript. Bounded by [_syncDeadline]: one id per
  /// [_syncNoAnswerRetry] at most, cleared when the attempt opens or ends.
  final List<String> _syncRequestIds = <String>[];

  /// The id an AUTHORITATIVE `session_switch_ok` moved the active box to, plus
  /// the box it was for — kept until that switch has actually settled.
  ///
  /// The ack and a `session_list_ok` have NO ordering relation on the wire: a
  /// listing answered by the PRE-switch Pi (`current_id` = A) can be delivered
  /// after the ack that moved us to B. Read as a genuine move, that frame wipes
  /// and refetches the box for A, the next poll refetches it for B — repeated
  /// wipe+refetch churn and a transiently empty transcript on every list reload
  /// that lands inside the ack slice. So while a switch settles, a PASSIVE id
  /// that disagrees with the ack is refused outright.
  ///
  /// This is an explicit in-flight flag, not a clock: a non-null key IS "a switch
  /// is settling". It is set by an ack (which necessarily then asks for the
  /// transcript) and cleared where an attempt ends — [_settleTranscriptLoading]
  /// (a real answer, or the 40 s deadline giving up) and the no-channel branch of
  /// [requestSync], where no attempt can even start. It therefore cannot outlive
  /// the attempt, and a genuine move made on another client is still adopted once
  /// nothing is in flight.
  String? _settlingSwitchId;
  String? _settlingSwitchKey;

  /// Fixed row id for the "this session never answered" notice, so repeated
  /// deadlines REPLACE that row instead of stacking one per attempt.
  static const _syncDeadlineNoticeId = 'sync_deadline_notice';

  /// Retry cadence INSIDE one window (see [_syncWindowSince]): a `session_sync`
  /// silent for this long is re-sent.
  static const _syncNoAnswerRetry = Duration(seconds: 3);

  /// How long ONE attempt may run before the chat stops waiting and says why.
  ///
  /// Left at 40 s, deliberately. The measured defect was not a tight deadline —
  /// every retry in the 163 s burst reported `waited` ≈ 3.02 s, so the deadline
  /// was UNREACHABLE; widening it would only delay the notice for the same dead
  /// room. Budget check against those measurements: the round trip is ~1.1 s
  /// median / 1.8 s p95, so 40 s is ~36 median round trips; and the slowest
  /// healthy pre-transcript stage, a `session_switch` respawn, is ~26 s end to
  /// end, leaving ~14 s of margin (a full 3 s resend cycle plus the reply, four
  /// times over). A truly dead room therefore ALWAYS ends here: the timer that
  /// checks this deadline is re-armed by every request and by every rebind, so
  /// no path can leave the chat waiting past ~1 s after this mark.
  static const _syncDeadline = Duration(seconds: 40);

  // Whether the active session's agent is currently producing a reply. Spans
  // the WHOLE turn (send/echo → agent_done), not just the token-streaming
  // window — restoring the old broad "working" signal. Mirrored into the
  // session index (durable, for Home) and exposed in-memory (for the chat
  // pill, no box-key matching needed).
  bool _working = false;
  // Plan/32 Q4 — anti-flicker. The source (pi-ext) emits raw turn_start /
  // turn_end transitions; the app coalesces them into the durable index.
  // The OFF is the lazy side: `working:false` arms `_workingOffTimer` instead
  // of clearing immediately, so a turn_start arriving inside the window
  // cancels it. Without this a burst of `RoomMetaUpdated` inside one
  // `_emitDebounce` window can drop the intermediate `working:true` frame
  // entirely, leaving a stale indicator that nothing later clears.
  static const Duration _workingOffDelay = Duration(milliseconds: 200);
  Timer? _workingOffTimer;

  // Plan 01 — latest runtime status snapshot from the Pi (model, thinking,
  // usage, cost, context occupancy). In-memory only: the Pi re-sends it after
  // every turn, and a stale one would be misleading after a reconnect.
  RuntimeStatus _runtimeStatus = const RuntimeStatus();
  final StreamController<RuntimeStatus> _runtimeStatusController =
      StreamController<RuntimeStatus>.broadcast();

  // Plan 01 — transcript paging. The Pi hands back an opaque cursor with each
  // page; we echo it in `session_sync.before` for the next one. An extension
  // old enough not to send `older_cursor` leaves `_hasOlder` false, which
  // degrades to exactly the pre-pagination behaviour.
  String? _olderCursor;
  bool _hasOlder = false;
  String? _pendingOlderRequestId;
  final StreamController<OlderPageState> _olderStateController =
      StreamController<OlderPageState>.broadcast();

  // Plan 01 — session tree. The snapshot stream feeds the picker; the error
  // stream carries the fence rejections (`session_busy` / `tree_state_changed`)
  // so the sheet can tell the user to re-open instead of silently failing.
  final StreamController<TreeSnapshot> _treeSnapshotController =
      StreamController<TreeSnapshot>.broadcast();
  final StreamController<String> _treeErrorController =
      StreamController<String>.broadcast();
  // Plan 01 — text of a forked prompt, delivered to the composer. Never
  // auto-sent.
  final StreamController<String> _forkDraftController =
      StreamController<String>.broadcast();
  // Id of the user message the in-flight reply is answering — the `cancel`
  // target while working. Null when idle.
  String? _workingReplyTo;
  final StreamController<bool> _workingController =
      StreamController<bool>.broadcast();

  // Plan/32 safety net — if the relay never echoes a sent message back, the
  // optimistic `pending:true` bubble would spin forever. After this window we
  // remove the bubble SILENTLY (no "failed" state, no spinner). The real fix
  // lives in the relay; this is the app-side backstop. Per-message (`id`)
  // timers are armed only when a send is actually attempted online, and
  // cancelled on echo, user-cancel, session switch, and dispose.
  final Duration pendingSendTimeout;
  final Map<String, Timer> _pendingSendTimers = {};

  SyncService(
    this._conn,
    this._boxes, {
    this.pendingSendTimeout = const Duration(seconds: 20),
  }) {
    _connSub = _conn.statusStream.listen(_onStatus);
    _roomsSub = _conn.roomsStream.listen((_) {
      _writeRuntime();
      _syncTurnStateFromRoomMeta();
      // A deferred sync is waiting for exactly this: the room coming back
      // (usually the daemon that `session_switch` restarted).
      if (_pendingSyncRequest) {
        requestSync();
      } else if (_resyncOnRoomReturn) {
        // A previous window already gave up and said so. Only a room that is
        // actually LIVE again earns a new attempt, so the released state stays
        // released while the room is down.
        final epk = _activeEpk;
        if (epk != null && _conn.isRoomLive(epk, _activeRoomId)) {
          _resyncOnRoomReturn = false;
          requestSync();
        }
      }
    });
    _presenceSub = _conn.presenceStream.listen((_) => _writeRuntime());
    _onStatus(_conn.status); // replay current
  }

  // ---------------------------------------------------------------------------
  // Public surface (commands + in-memory streams)
  // ---------------------------------------------------------------------------

  StreamingMessage? get streaming => _streaming;
  Stream<StreamingMessage?> get streamingStream => _streamingController.stream;
  Stream<SessionEvent> get events => _eventController.stream;

  /// Plan/57 — stream of interactive extension_ui_request prompts (ask_user
  /// via pi-ask). Transient: not written to the DB; the ChatViewModel renders
  /// a full-screen modal and replies via [respondExtensionUi].
  Stream<ExtensionUiRequest> get extensionUiRequestStream =>
      _extensionUiController.stream;
  List<QueuedMsg> get queuedMessages => _queuedMessages;
  String? get queuedText =>
      _queuedMessages.isEmpty ? null : _queuedMessages.first.text;
  Stream<List<QueuedMsg>> get queuedStream => _queuedController.stream;

  /// True while the active session's agent is producing a reply (whole turn).
  bool get isWorking => _working;
  Stream<bool> get workingStream => _workingController.stream;

  /// True while an attempt to learn this session's transcript is outstanding —
  /// a `session_sync` in flight OR a request still waiting for the room to come
  /// back. Either way the transcript on screen is not yet known to be the
  /// current one, so the chat shows a skeleton instead of "这里还没有内容"
  /// (otherwise indistinguishable from a genuinely empty session).
  ///
  /// Keyed on the ATTEMPT WINDOW, not on the last send: a deferred request never
  /// sends one, and the window is also what carries the deadline, so this flag
  /// is released when — and only when — the attempt is actually over.
  bool get isLoadingTranscript => _syncWindowSince != null;
  Stream<bool> get transcriptLoadingStream =>
      _transcriptLoadingController.stream;
  final StreamController<bool> _transcriptLoadingController =
      StreamController<bool>.broadcast();

  /// `cancel` target for the in-flight reply (null when idle).
  String? get workingReplyTo => _workingReplyTo;

  /// Plan 01 — latest runtime status from the Pi (empty until the first
  /// `runtime_status` arrives).
  RuntimeStatus get runtimeStatus => _runtimeStatus;

  /// Plan 01 — stream of runtime status updates for the chat header.
  Stream<RuntimeStatus> get runtimeStatusStream =>
      _runtimeStatusController.stream;

  /// Plan 01 — whether an older page can still be fetched.
  bool get hasOlder => _hasOlder;

  /// Plan 01 — stream of paging availability, so the list can show or hide the
  /// "load earlier" affordance without polling.
  Stream<OlderPageState> get olderPageStream => _olderStateController.stream;

  /// Plan 01 — session tree snapshots for the picker sheet.
  Stream<TreeSnapshot> get treeSnapshotStream =>
      _treeSnapshotController.stream;

  /// Plan 01 — tree/branching errors, as the raw wire error code.
  Stream<String> get treeErrorStream => _treeErrorController.stream;

  /// Plan 01 — draft text for the composer after a fork.
  Stream<String> get forkDraftStream => _forkDraftController.stream;

  String? get activeEpk => _activeEpk;
  String get activeRoomId => _activeRoomId;

  /// The server-reported id of the session the active box currently owns, or
  /// null when no frame has named it yet (cold boot, or right after
  /// `session_new`).
  String? get activeSessionId {
    final epk = _activeEpk;
    if (epk == null) return null;
    return _sessionIdByBox[LocalBoxes.sessionKey(epk, _activeRoomId)];
  }

  /// Bind the writer to a (peer, room). Opens the box and rebuilds the
  /// dedupe/seq index from it. Called by the chat when it mounts / switches
  /// rooms; also adopted automatically on the first StatusOnline.
  ///
  /// F2 — `(epk, room)` is the ADDRESS, not the transcript. Because the box is
  /// shared by every session of the workspace, a session change recorded while
  /// this box was bound leaves rows that belong to the session we left. Such a
  /// change arrives as a pending reset ([_adoptSessionId]), and it is applied
  /// HERE — before the index is rebuilt, so neither this writer nor a reader can
  /// project those rows as the new session's transcript — then refetched. That
  /// is the session dimension this early-return was missing.
  Future<void> activate(String epk, String roomId) async {
    final room = roomId.isEmpty ? 'main' : roomId;
    final sameBinding = _activeEpk == epk && _activeRoomId == room;
    final sessionChanged = _pendingSessionResets.contains(
      LocalBoxes.sessionKey(epk, room),
    );
    if (sameBinding && _indexLoaded && !sessionChanged) return;
    if (!sameBinding) {
      // Ids in flight asked about the PREVIOUS binding's transcript, so their
      // answers say nothing about this one (see [_syncRequestIds]).
      _syncRequestIds.clear();
    }
    // Genuine session switch: drop the in-memory turn state so the
    // PREVIOUS session's streaming buffer + whole-turn working flag can't
    // bleed into the next chat (the bug where chat 2 looked "working"
    // because chat 1 was mid-turn). We deliberately do NOT clear the
    // durable session index — the previous room may still be running on
    // the Pi, and Home keeps showing it via the relay's per-room
    // `meta.working` broadcast.
    _resetTurnState();
    // Plan 01 — a new session has its own transcript, so a cursor issued for
    // the previous one must never be replayed against it.
    _resetPaging();
    _activeEpk = epk;
    _activeRoomId = room;
    // F5 — whose rows this box holds, straight from the durable index and
    // BEFORE anything can hand out an answer: a cold boot's first
    // `session_list_ok` must be a COMPARISON against what the last run recorded,
    // not another "first sight" that keeps another session's rows (S1 surviving
    // one restart). Read synchronously — the index box is open at boot — so no
    // frame can slip in between.
    _restoreSessionLabel(epk, room);
    // A clock opened for the PREVIOUS binding says nothing about this one: its
    // age must not follow the screen across a rebind, or the new session could
    // give up (and say so) seconds after being opened. The window is kept OPEN
    // — there is no transcript for the new binding either, so releasing the
    // skeleton here would flash "这里还没有内容" for an empty session — and
    // restarted, which also re-arms the timer so the deadline stays bounded
    // even if nothing asks again.
    _restartSyncWindow();
    if (sessionChanged) {
      // Consumed here: after this the box holds no session's rows.
      _pendingSessionResets.remove(LocalBoxes.sessionKey(epk, room));
      await _dropActiveTranscript();
    }
    await _loadIndex();
    _writeRuntime();
    if (sessionChanged) {
      // Emptied just now, so only a fresh sync can fill it.
      requestSync();
    }
  }

  /// Clears the in-memory streaming buffer + whole-turn working flag
  /// (emitting the cleared state so listeners update) WITHOUT touching the
  /// durable session index. Used on a session switch — see [activate].
  void _resetTurnState() {
    _flushTimer?.cancel();
    _flushTimer = null;
    _chunkBuffer.clear();
    _chunkReplyTo = '';
    _workingReplyTo = null;
    _workingOffTimer?.cancel();
    _workingOffTimer = null;
    _setQueuedMessages(const []);
    // Session switch: the previous chat's in-flight sends are no longer ours
    // to confirm — drop their backstops so a stale timer can't fire later.
    _cancelAllSendTimers();
    if (_streaming != null) _emitStreaming(null);
    if (_working) {
      _working = false;
      if (!_workingController.isClosed) _workingController.add(false);
    }
  }

  Future<void> sendMessage(
    String text, {
    MessageImage? image,
    UserMessageStreamingBehavior? streamingBehavior,
  }) async {
    final epk = _activeEpk;
    final id = _newId();
    final now = DateTime.now();
    final isSteer = streamingBehavior == UserMessageStreamingBehavior.steer;
    // Optimistic pending row (#defaults: optimistic + dedupe by id).
    if (epk != null) {
      await _upsert(
        MsgRole.user,
        id,
        (seq, _) => MessageRecord(
          id: id,
          seq: seq,
          role: MsgRole.user,
          text: text,
          image: image,
          ts: now,
          pending: true,
          steering: isSteer,
        ),
      );
      if (!isSteer) {
        _setWorking(true, preview: _preview(text, image), replyTo: id);
      }
      // Arm the no-echo backstop for this row. The timeout is keyed off the
      // row's `ts`, NOT online-ness: an offline "held pending" send is reaped
      // 20s after its ts too, and ANY pending row is re-armed on session load
      // (see _loadIndex). So a quick session-switch or an app restart still
      // reaps a stale bubble instead of letting it spin "sending…" forever.
      _armSendTimeout(id, now);
    }
    final ch = _conn.channel;
    if (ch == null) {
      debugPrint(
        '[msg-send] id=$id (offline → held pending, reaped in '
        '${pendingSendTimeout.inSeconds}s)',
      );
      return;
    }
    // Seed an EMPTY streaming buffer so the blinking cursor shows during the
    // "thinking" gap before the first agent_chunk (pre-31 behavior). In-memory
    // only (#7) — never written to the DB. agent_chunk appends; agent_done
    // clears it (even for a text-less, tool-only turn).
    // Steering messages should not create a new cursor, because they do not
    // start a fresh assistant turn.
    if (!isSteer) {
      _emitStreaming(StreamingMessage(inReplyTo: id));
    }
    debugPrint('[msg-send] id=$id text=${_preview(text, image)}');
    await ch.send(
      UserMessage(
        id: id,
        text: text,
        streamingBehavior: streamingBehavior,
        images: image == null
            ? null
            : [WireImage(data: image.data, mime: image.mime)],
      ),
    );
  }

  /// Arm (or re-arm) the silent no-echo backstop for a pending row, keyed by
  /// `id`. The window is the time REMAINING relative to the row's [ts], so a
  /// row loaded from disk already past [pendingSendTimeout] fires immediately
  /// (floored at zero). Idempotent — cancels any existing timer for `id`.
  void _armSendTimeout(String id, DateTime ts) {
    _pendingSendTimers.remove(id)?.cancel();
    final remaining = pendingSendTimeout - DateTime.now().difference(ts);
    _pendingSendTimers[id] = Timer(
      remaining > Duration.zero ? remaining : Duration.zero,
      () => _onSendTimeout(id),
    );
  }

  /// No echo arrived within [pendingSendTimeout]: drop the optimistic bubble
  /// silently and unwind only the turn state that belongs to THIS `id`.
  void _onSendTimeout(String id) {
    _pendingSendTimers.remove(id);
    // ignore: discarded_futures
    _removeById(id);
    // Clear the thinking cursor only if it's seeded for this message.
    if (_streaming?.inReplyTo == id) _emitStreaming(null);
    // Clear working ONLY if this id owns it — never knock down a turn that a
    // different (echoed) message is already driving.
    if (_workingReplyTo == id) _setWorking(false);
    debugPrint(
      '[msg-timeout] id=$id removed (no echo in '
      '${pendingSendTimeout.inSeconds}s)',
    );
  }

  void _cancelAllSendTimers() {
    for (final t in _pendingSendTimers.values) {
      t.cancel();
    }
    _pendingSendTimers.clear();
  }

  /// Test seam — number of armed no-echo timers (asserts no leak on reset).
  @visibleForTesting
  int get debugPendingSendTimerCount => _pendingSendTimers.length;

  Future<void> queueMessage(String text) async {
    final ch = _conn.channel;
    if (ch == null) return;
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    final id = _newId();
    _setQueuedMessages([
      ..._queuedMessages,
      QueuedMsg(
        id: id,
        text: trimmed,
        editable: true,
        createdAt: DateTime.now(),
      ),
    ]);
    await ch.send(QueuedMessageSet(id: id, text: trimmed));
  }

  Future<void> setQueuedMessage(String text) => queueMessage(text);

  Future<void> clearQueuedMessage([String? targetId]) async {
    if (targetId == null) {
      _setQueuedMessages(const []);
    } else {
      _setQueuedMessages([
        for (final item in _queuedMessages)
          if (item.id != targetId) item,
      ]);
    }
    final ch = _conn.channel;
    if (ch == null) return;
    await ch.send(QueuedMessageClear(id: _newId(), targetId: targetId));
  }

  Future<void> clearQueuedMessages() => clearQueuedMessage();

  Future<void> cancel(String targetId) async {
    // User-driven cancel of this message → disarm its no-echo backstop too.
    _pendingSendTimers.remove(targetId)?.cancel();
    final ch = _conn.channel;
    if (ch == null) return;
    await ch.send(Cancel(id: _newId(), targetId: targetId));
  }

  /// Plan/57 — respond to an interactive extension_ui_request (ask_user).
  /// The ChatViewModel builds the [ExtensionUiResponse] (value/confirmed/
  /// cancelled + optional `ask` envelope); the SyncService just ships it.
  /// Returns false when there is no live channel or the send fails so the
  /// caller can surface a retryable failure immediately instead of waiting on
  /// the sheet's 25s backstop.
  Future<bool> respondExtensionUi(ExtensionUiResponse resp) async {
    final ch = _conn.channel;
    if (ch == null) return false;
    try {
      await ch.send(resp);
      return true;
    } catch (error) {
      debugPrint('[extension-ui] failed to send response: $error');
      return false;
    }
  }

  Future<void> approveTool(String toolCallId, ApproveDecision decision) async {
    final ch = _conn.channel;
    if (ch == null) return;
    await ch.send(
      ApproveTool(id: _newId(), toolCallId: toolCallId, decision: decision),
    );
    await _upsert(MsgRole.tool, toolCallId, (seq, existing) {
      final base =
          existing?.tool ??
          ToolEventData(toolCallId: toolCallId, tool: 'unknown');
      return (existing ??
              MessageRecord(
                id: toolCallId,
                seq: seq,
                role: MsgRole.tool,
                ts: DateTime.now(),
              ))
          .copyWith(
            tool: base.copyWith(
              status: decision == ApproveDecision.allow
                  ? ToolEventStatus.allowed
                  : ToolEventStatus.denied,
            ),
          );
    });
  }

  void requestSync() {
    final ch = _conn.channel;
    final epk = _activeEpk;
    if (ch == null || epk == null) {
      // No channel to address at all (offline, or not bound yet). The status
      // surface already says so and there is no frame to lose, so no window is
      // opened — a `session_sync` cannot time out against a link we know is
      // down. With no window either, nothing is left that could end a settling
      // switch, so its guard ([_settlingSwitchId]) must not outlive it — left set
      // it would ignore a move made on another client forever. An ALREADY open
      // window still gets its tick, otherwise a channel that dies mid-attempt
      // would strand that window (and its skeleton).
      _pendingSyncRequest = true;
      if (_syncWindowSince == null) {
        _settlingSwitchKey = null;
        _settlingSwitchId = null;
      } else {
        _armPendingSyncRetry();
      }
      return;
    }
    // One attempt window, opened by whichever comes first — a deferral or a
    // send. THIS is what makes the deadline reachable when the room never comes
    // back: previously only a successful send armed the clock, so the deferred
    // loop ran with no time reference at all. A fresh attempt also supersedes a
    // room-return resync queued by a window that already gave up.
    final opened = _syncWindowSince == null;
    _syncWindowSince ??= DateTime.now();
    if (opened) {
      // A fresh attempt opens the transcript again: the previous give-up notice
      // was about an attempt nobody is repeating, and leaving it in the box
      // would replace the loading skeleton with a message about the past.
      _resyncOnRoomReturn = false;
      // Ids from the previous attempt answer questions nobody is asking now
      // (see [_syncRequestIds]).
      _syncRequestIds.clear();
      // ignore: discarded_futures
      _removeById(_syncDeadlineNoticeId);
    }
    // A live channel is not a live ROOM. `session_switch` restarts the daemon
    // (stage → ack → exit → supervisor respawn), and in that window the room is
    // gone while the websocket stays up. Sending then loses the frame silently:
    // nothing answers, nothing errors, and the chat sits empty forever because
    // a pending flag was never set either.
    if (!_conn.isRoomLive(epk, _activeRoomId)) {
      _pendingSyncRequest = true;
      // Deferred is not "nothing to see": the transcript on screen is still not
      // known to be this session's, so the same skeleton applies. Emitted once
      // per window — this path re-enters every second.
      if (opened) _emitTranscriptLoading(true);
      _armPendingSyncRetry();
      return;
    }
    _pendingSyncRequest = false;
    _pendingSyncRetry?.cancel();
    _pendingSyncRetry = null;
    _awaitingSyncSince = DateTime.now();
    final id = _newId();
    _syncRequestIds.add(id);
    if (opened) _emitTranscriptLoading(true);
    ch.send(SessionSync(id: id));
    _armPendingSyncRetry();
  }

  void _emitTranscriptLoading(bool value) {
    if (_transcriptLoadingController.isClosed) return;
    _transcriptLoadingController.add(value);
  }

  /// Closes the attempt window and releases the loading state.
  ///
  /// Guarded on the WINDOW, not on `_awaitingSyncSince`: a deferred attempt
  /// never sent a frame, so keying this on the send would leave that case
  /// unsettled — the same blind spot that made the deadline unreachable.
  /// `_pendingSyncRequest` is deliberately left alone here: it is the pre-existing
  /// "still owed a sync" flag the rooms listener flushes, and an answer arriving
  /// while a deferral is queued does not make that deferral unnecessary. Only the
  /// give-up and the cancel paths clear it, because those end the attempt.
  void _settleTranscriptLoading() {
    // A queued room-return resync was for the attempt that is now over.
    _resyncOnRoomReturn = false;
    // The switch this box was waiting on has settled too: the room either
    // answered or the deadline proved it never will, so a listing that names
    // another session is a genuine move from here on (see
    // [_settlingSwitchId]).
    _settlingSwitchId = null;
    _settlingSwitchKey = null;
    // Nothing outstanding can answer this attempt any more — true whether or not
    // a window was open (an id is only added by a send).
    _syncRequestIds.clear();
    if (_syncWindowSince == null) return;
    _syncWindowSince = null;
    _awaitingSyncSince = null;
    _emitTranscriptLoading(false);
  }

  /// Restarts the clock of an OPEN attempt window, leaving it open.
  ///
  /// For a rebind (a session switch or a room change): the attempt now addresses
  /// a different transcript, so it gets a full deadline, but the loading state
  /// must not blink off in between — the new binding has no rows either. The
  /// last-send time is deliberately KEPT: a frame already on the wire is still
  /// outstanding, and its age is what paces the next resend. No-op when no
  /// window is open, so it never manufactures a loading state.
  void _restartSyncWindow() {
    if (_syncWindowSince == null) return;
    _syncWindowSince = DateTime.now();
    _armPendingSyncRetry();
  }

  /// The attempt outlived [_syncDeadline]: release the loading state and say
  /// why, instead of leaving the skeleton up or dropping to "这里还没有内容" as
  /// if the session were empty.
  void _giveUpOnSync(Duration waited) {
    debugPrint(
      '[sync] session_sync gave up after $waited without an answer '
      '(deadline ${_syncDeadline.inSeconds}s) — releasing the loading state',
    );
    final wasWaitingForRoom = _pendingSyncRequest;
    // Notice queued BEFORE the release so its box write is already on the chain
    // when the skeleton comes down (an empty box would otherwise render
    // "这里还没有内容" for the few frames the write takes). The release stays
    // SYNCHRONOUS on purpose: the guarantee this fix exists for is that the
    // loading state ends at the deadline, so nothing may be made conditional on
    // a write completing.
    _pendingSyncRequest = false;
    // ignore: discarded_futures
    _noticeTranscriptUnavailable();
    _settleTranscriptLoading();
    // The attempt is OVER: the deferred flag stays cleared so the release is
    // final — left set, the rooms listener would re-request on the next
    // broadcast (including unrelated ones such as a working flip) and put the
    // skeleton back up on a chat that was just told it gave up. The one case
    // with a real answer is a room that was DOWN the whole window coming back:
    // that is the daemon finishing its restart, so it earns one more automatic
    // attempt (see [_resyncOnRoomReturn]). Set AFTER the settle, which clears it
    // as part of ending the window.
    _resyncOnRoomReturn = wasWaitingForRoom;
  }

  /// Tells the user, in the transcript, that this session never answered.
  ///
  /// Reuses the notice mechanism this file already has for a frame-level
  /// failure — the `ErrorMessage` case below writes an `⚠` assistant row —
  /// because the sync layer has no banner of its own (the banners live in
  /// ChatPage, and the event stream carries no notice type). Writing the row
  /// also gives the ViewModel the message change that carries the released
  /// `isLoadingTranscript` to the screen. It clears itself: the next real
  /// `session_history` replaces the window in [_applyHistory].
  Future<void> _noticeTranscriptUnavailable() {
    if (_activeEpk == null) return Future<void>.value();
    return _upsert(
      MsgRole.assistant,
      _syncDeadlineNoticeId,
      (seq, _) => MessageRecord(
        id: _syncDeadlineNoticeId,
        seq: seq,
        role: MsgRole.assistant,
        text:
            '⚠ 这段会话没有回应：等待 ${_syncDeadline.inSeconds} 秒仍没有收到历史记录。'
            '请确认电脑上的 Pi 仍在运行（或该会话刚重启完成），'
            '必要时返回列表重新打开这一段。',
        ts: DateTime.now(),
      ),
    );
  }

  /// Drives ONE attempt window: re-asks for the room every second, re-sends a
  /// `session_sync` that has been silent for [_syncNoAnswerRetry], and gives up
  /// at [_syncDeadline]. Both cases are the same symptom from the user's side —
  /// an empty chat that never fills.
  ///
  /// The deadline is evaluated FIRST. It used to sit behind
  /// `if (_pendingSyncRequest) { requestSync(); return; }`, and a deferred
  /// request re-sets that flag on every pass — so the 1 s loop could never reach
  /// the check, the clock never advanced, and a room that stayed down left the
  /// chat loading for as long as the screen existed.
  void _armPendingSyncRetry() {
    if (_pendingSyncRetry != null) return;
    _pendingSyncRetry = Timer(const Duration(seconds: 1), () {
      _pendingSyncRetry = null;
      final windowSince = _syncWindowSince;
      // Settled while this tick was queued — nothing left to drive.
      if (windowSince == null) return;
      final waited = DateTime.now().difference(windowSince);
      if (waited >= _syncDeadline) {
        _giveUpOnSync(waited);
        return;
      }
      if (_pendingSyncRequest) {
        // Still waiting for the room: ask again. requestSync() re-defers (and
        // re-arms this timer) while it stays down, inside the SAME window.
        requestSync();
        return;
      }
      final lastSend = _awaitingSyncSince;
      if (lastSend != null &&
          DateTime.now().difference(lastSend) >= _syncNoAnswerRetry) {
        // `waited` is the AGE OF THE WINDOW, so it keeps growing past 3 s —
        // the acceptance signal that the retry chain is no longer pinned.
        debugPrint('[sync] session_sync unanswered for $waited — retrying');
        _pendingSyncRequest = true;
        requestSync();
        return;
      }
      _armPendingSyncRetry();
    });
  }

  /// Plan 01 — fetch the page older than what is on screen.
  ///
  /// No-op when the Pi never advertised a cursor (older extension) or a page
  /// request is already in flight, so a fast scroll cannot queue duplicate
  /// requests for the same page.
  void requestOlderPage() {
    final ch = _conn.channel;
    final cursor = _olderCursor;
    if (ch == null || _activeEpk == null) return;
    if (!_hasOlder || cursor == null || _pendingOlderRequestId != null) return;
    final id = _newId();
    _pendingOlderRequestId = id;
    ch.send(SessionSync(id: id, before: cursor));
  }

  /// Plan 01 — reset paging state. A session switch or a fresh sync restarts
  /// the cursor chain, so a cursor from the previous session must never be
  /// replayed against the new one.
  void _resetPaging() {
    _olderCursor = null;
    _hasOlder = false;
    _pendingOlderRequestId = null;
  }

  /// Plan 01 — request the session tree snapshot.
  Future<void> requestTree() async {
    final ch = _conn.channel;
    if (ch == null || _activeEpk == null) return;
    await ch.send(TreeGet(id: _newId()));
  }

  /// Plan 01 — move the active branch. [fence] must come from the snapshot the
  /// user was looking at; the Pi rejects a stale one with `tree_state_changed`.
  Future<void> navigateTree(
    String targetEntryId,
    TreeFence fence, {
    bool summarize = false,
  }) async {
    final ch = _conn.channel;
    if (ch == null || _activeEpk == null) return;
    await ch.send(
      TreeNavigate(
        id: _newId(),
        targetEntryId: targetEntryId,
        fence: fence,
        summarize: summarize,
      ),
    );
  }

  /// Plan 01 — branch before a user message. The Pi answers with the prompt
  /// text for the composer; it is never auto-sent.
  Future<void> forkSession(String targetEntryId, TreeFence fence) async {
    final ch = _conn.channel;
    if (ch == null || _activeEpk == null) return;
    await ch.send(
      SessionFork(id: _newId(), targetEntryId: targetEntryId, fence: fence),
    );
  }

  /// Plan 01 — duplicate the active branch into a new session.
  Future<void> cloneSession(TreeFence fence) async {
    final ch = _conn.channel;
    if (ch == null || _activeEpk == null) return;
    await ch.send(SessionClone(id: _newId(), fence: fence));
  }

  /// Plan/28 — `session_switch` acked: the room is unchanged but the Pi is now
  /// on a DIFFERENT session, so every row we hold belongs to the one we just
  /// left.
  ///
  /// Without this the chat kept rendering the previous session (or an empty
  /// list, for a session whose rows were never synced) and nothing ever asked
  /// for the new transcript: `activate()` short-circuits on an unchanged
  /// `(epk, room)`, and no status edge fires because the connection never
  /// dropped. The screen stayed wrong until the app was restarted.
  ///
  /// [sessionId] is the ack's own `session_id`, and with it this is just one way
  /// to LEARN which session the box must own ([_adoptSessionId]): an ack naming
  /// the session already on screen keeps its rows, which is what the host's
  /// `session_started_at: 0` ("unchanged clock") already asks of callers.
  /// Without an id — an older Pi — the unconditional wipe stands.
  Future<void> switchedSession([String? sessionId]) async {
    if (sessionId != null && sessionId.isNotEmpty) {
      await _adoptSessionId(
        sessionId,
        source: 'session_switch_ok',
        assumeMoved: true,
      );
      return;
    }
    final epk = _activeEpk;
    if (epk == null) return;
    final key = LocalBoxes.sessionKey(epk, _activeRoomId);
    // No id came with this call, so which session the (now empty) box holds is
    // unknown again; the next id a frame reports is a first sight.
    _sessionIdByBox.remove(key);
    // …and until the attempt this wipes for has settled, no passive report may
    // say otherwise either: a listing answered by the PRE-switch Pi names the
    // session we just left. An unknown target ([_settlingSwitchId] null) is the
    // strictest form of the same guard — every passive id is refused.
    _settlingSwitchKey = key;
    _settlingSwitchId = null;
    _leaveSessionState();
    await _dropActiveTranscript();
    // Pull the NEW session's transcript. `_indexLoaded` is now true, so this
    // is a real fetch rather than a short-circuited activation.
    requestSync();
  }

  /// F2 — adopt the session id a SERVER frame reports for the active binding.
  ///
  /// The id is copied, never derived. Two frames qualify today —
  /// `session_switch_ok.session_id` and `session_list_ok.current_id` — so a
  /// switch ack and a plain listing (which the picker polls when an ack goes
  /// missing) reach the same decision. A CHANGE drops the rows: the box is
  /// `msgs_<epk>__<roomId>` and shared by every session of the workspace, so
  /// rows written under the previous id are another session's transcript.
  ///
  /// [assumeMoved] is true for an ack: it answers a switch WE asked for, so its
  /// id is where the host moved even if we never learnt where it was — kept
  /// equal to the pre-F2 behaviour so a cold-boot switch still clears. A passive
  /// listing with no previous id is a first sight instead: the box may already
  /// hold THIS session's rows from the last run, and dropping them would be
  /// data loss on a guess.
  Future<void> _adoptSessionId(
    String? id, {
    required String source,
    required bool assumeMoved,
  }) async {
    final epk = _activeEpk;
    if (epk == null || id == null || id.isEmpty) return;
    final key = LocalBoxes.sessionKey(epk, _activeRoomId);
    final previous = _sessionIdByBox[key];
    if (previous == id) {
      // An ack that names the session already on screen still ANSWERS the
      // switch, so it settles ownership: nothing is left to guard.
      if (assumeMoved) {
        _settlingSwitchId = null;
        _settlingSwitchKey = null;
      }
      return;
    }
    // F5 — a PASSIVE report says nothing while our own switch is still in
    // flight. The ack and a `session_list_ok` have no ordering relation on the
    // wire, so a listing answered by the PRE-switch Pi names the session we just
    // left and can arrive after the ack. Adopted as a genuine move it wipes and
    // refetches the box for the old session, and the next poll wipes it again for
    // the real one — churn plus a transiently empty transcript on every list
    // reload that lands inside the ack slice. The guard ends with the attempt
    // (a real answer or the deadline — see [_settleTranscriptLoading]), so a move
    // made on ANOTHER client is still adopted once nothing is in flight.
    if (!assumeMoved && _settlingSwitchKey == key && id != _settlingSwitchId) {
      debugPrint(
        '[session] $source → $id refused: still settling on the acked id '
        '${_settlingSwitchId ?? '(unreported)'}',
      );
      return;
    }
    _sessionIdByBox[key] = id;
    if (assumeMoved) {
      // From here this ack's id is the authority for this box until the attempt
      // it opens ends.
      _settlingSwitchKey = key;
      _settlingSwitchId = id;
    }
    if (previous == null && !assumeMoved) {
      debugPrint('[session] $source → $id (first sight, rows kept)');
      // The rows this box already holds are now taken to be [id]'s, so record
      // that durably: after a restart the same listing is a COMPARISON instead
      // of another guess (see [SessionIndexRecord.sessionId]).
      await _labelBoxSessionQueued(epk, _activeRoomId, id);
      return;
    }
    debugPrint(
      '[session] $source → $id (was ${previous ?? 'unreported'}) — dropping '
      'the previous rows',
    );
    _leaveSessionState();
    // `previous` is what the rows being dropped belong to; the wipe keeps that
    // label if it has to be deferred (see [_dropActiveTranscript]).
    await _dropActiveTranscript(rowsOwner: previous);
    // The session we moved to has its rows nowhere in the (now empty) box.
    requestSync();
  }

  /// Everything IN MEMORY that belonged to the session being left. The durable
  /// rows are handled by [_dropActiveTranscript].
  void _leaveSessionState() {
    // Streaming/working state belonged to the session we left; an in-flight
    // send's timer would attribute its reply to the wrong session.
    _cancelAllSendTimers();
    _discardStreamingState();
    _setQueuedMessages(const []);
    _setWorking(false);
    _resetPaging();
    // The ids in flight asked about the session being LEFT, so an answer to one
    // of them is no longer this attempt's answer (see [_syncRequestIds]) — only a
    // frame answering the request issued for the new session may settle it.
    _syncRequestIds.clear();
    // The attempt addressed the session being left, so its age must not decide
    // when the NEXT session gives up — the caller issues a fresh request for it.
    _restartSyncWindow();
  }

  /// F2 — clear the active binding's rows and its durable index entry.
  ///
  /// Queued through the same chain as every other box mutation, so a history
  /// apply already in flight cannot land after the wipe. The `active changed ⇒
  /// skip` guard stays — clearing a box this change never owned would delete
  /// another session's rows — but a skip is no longer silent: the cleanup is
  /// remembered in [_pendingSessionResets] and finished by the next
  /// [activate] of that binding. A skipped cleanup can therefore only DELAY
  /// correctness, never leave the wrong transcript in place.
  ///
  /// [rowsOwner] is the session the rows being dropped belong to. A DEFERRED
  /// wipe also re-states it in the durable index ([SessionIndexRecord.sessionId])
  /// — that deferral is in-memory only, so without the durable copy a process
  /// kill inside the window would make the next run's first listing a "first
  /// sight" that keeps the other session's rows, and S1 would survive one
  /// restart.
  Future<void> _dropActiveTranscript({String? rowsOwner}) {
    final epk = _activeEpk;
    if (epk == null) return Future<void>.value();
    final room = _activeRoomId;
    final key = LocalBoxes.sessionKey(epk, room);
    return _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) {
        _pendingSessionResets.add(key);
        if (rowsOwner != null) await _labelBoxSession(epk, room, rowsOwner);
        return;
      }
      final box = await _boxes.msgsBox(epk, room);
      await box.clear();
      // Any deferral for THIS box is now satisfied — the rows it asked about are
      // gone — so a later [activate] must not clear it a second time.
      _pendingSessionResets.remove(key);
      _idToSeq.clear();
      _nextSeq = 0;
      _indexLoaded = true;
      final idx = _boxes.sessionsIndexBox();
      await idx.delete(key);
    });
  }

  /// F5 — record WHICH session a box's rows belong to, durably.
  ///
  /// Written only about rows that are really there, never about a session we
  /// merely intend to load: a record vouching for rows somebody else wrote is
  /// worse than no record at all, and an empty box needs no protection. Writes
  /// nothing — not even an index row — when the box is empty. Deliberately does
  /// NOT clear a label: dropping one is the job of the wipe, which deletes the
  /// record together with the rows it described.
  ///
  /// Does no queueing of its own, so it is safe from inside an [_enqueue]
  /// operation (which is how [_dropActiveTranscript] uses it); every other
  /// caller goes through [_labelBoxSessionQueued].
  Future<void> _labelBoxSession(
    String epk,
    String room,
    String sessionId,
  ) async {
    final box = await _boxes.msgsBox(epk, room);
    if (box.isEmpty) return;
    final idx = _boxes.sessionsIndexBox();
    final key = LocalBoxes.sessionKey(epk, room);
    final raw = idx.get(key);
    final cur = raw is Map
        ? SessionIndexRecord.fromJson(_coerce(raw))
        : SessionIndexRecord(epk: epk, roomId: room);
    // A no-op write would still be a box event, and this runs on every history
    // apply — i.e. on every reconnect replay.
    if (cur.sessionId == sessionId) return;
    await idx.put(key, cur.copyWith(sessionId: sessionId).toJson());
  }

  /// [\_labelBoxSession] behind the shared write chain, so it cannot lose an
  /// update to a concurrent `_updateIndex` on the same record.
  Future<void> _labelBoxSessionQueued(
    String epk,
    String room,
    String sessionId,
  ) => _enqueue(() => _labelBoxSession(epk, room, sessionId));

  /// F5 — seed the in-memory binding from the durable index, if it is not known
  /// yet. A live frame always wins: memory is only empty here on a cold boot or
  /// a box nobody has named.
  void _restoreSessionLabel(String epk, String room) {
    final key = LocalBoxes.sessionKey(epk, room);
    if (_sessionIdByBox.containsKey(key)) return;
    final raw = _boxes.sessionsIndexBox().get(key);
    final stored = raw is Map
        ? SessionIndexRecord.fromJson(_coerce(raw)).sessionId
        : null;
    if (stored == null || stored.isEmpty) return;
    _sessionIdByBox[key] = stored;
    debugPrint('[session] $key restored as → $stored');
  }

  /// Plan/28 — `session_new` acked: wipe the active session's rows + index.
  Future<void> clearActiveSession() async {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    // F2 — the replacement session is brand new and this path reports no id for
    // it, so the wiped session's id must stop describing this box: the next id
    // a frame names has to count as a first sight, not as "still the same".
    _sessionIdByBox.remove(LocalBoxes.sessionKey(epk, room));
    // Session wiped → any optimistic sends/streaming/working state are moot.
    _cancelAllSendTimers();
    _discardStreamingState();
    _setQueuedMessages(const []);
    _setWorking(false);
    // Plan 01 — a new session has no older transcript, so drop any cursor
    // pointing at the previous one.
    _resetPaging();
    // The wiped session's outstanding attempt (if any) has nothing left to fetch
    // here, so it is dropped whole: its age must not age into a "no response"
    // notice on the fresh, deliberately empty session, and no timer or deferred
    // flag may restart it for a transcript nobody is waiting for.
    _pendingSyncRetry?.cancel();
    _pendingSyncRetry = null;
    _pendingSyncRequest = false;
    _resyncOnRoomReturn = false;
    _settleTranscriptLoading();
    await _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) return;
      final box = await _boxes.msgsBox(epk, room);
      await box.clear();
      // The box is empty, so a cleanup deferred for it (F2) is satisfied too.
      _pendingSessionResets.remove(LocalBoxes.sessionKey(epk, room));
      _idToSeq.clear();
      _nextSeq = 0;
      _indexLoaded = true;
      final idx = _boxes.sessionsIndexBox();
      await idx.delete(LocalBoxes.sessionKey(epk, room));
    });
  }

  // ---------------------------------------------------------------------------
  // Channel → DB
  // ---------------------------------------------------------------------------

  void _onStatus(ConnectionStatus s) {
    _msgSub?.cancel();
    _msgSub = null;
    if (s is StatusOnline) {
      // Plan/32f — bind this stream's writes to the PEER that owns the
      // channel RIGHT NOW. After a `switchTo`, a late frame from the OLD
      // peer's channel must not land in the NEW session's box: `_activeEpk`
      // has already moved (the chat calls `activate()` before `switchTo`), so
      // a straggler chat-1 frame would otherwise be written to chat-2's box
      // and bleed across until chat-2's history re-applied. We capture the
      // origin epk here and drop frames whose origin is no longer active.
      //
      // We gate on epk only — NOT room: rooms of the same peer share one
      // channel and `_onStatus` doesn't re-fire on a same-peer room switch
      // (the transport already demuxes by room), so a room gate would wrongly
      // drop everything after switching cwds on the same Mac.
      final originEpk = _conn.activePeer?.remoteEpk;
      _msgSub = s.channel.serverMessages.listen(
        (msg) => _onServerMessage(msg, originEpk),
        onError: (Object _, StackTrace _) {},
      );
      // ignore: discarded_futures
      _onlineActivated();
    }
    _writeRuntime();
  }

  Future<void> _onlineActivated() async {
    final peer = _conn.activePeer;
    if (peer != null && _activeEpk == null) {
      await activate(peer.remoteEpk, _conn.activeRoomId);
    }
    _syncDebounce?.cancel();
    _syncDebounce = Timer(const Duration(milliseconds: 200), requestSync);
    if (_pendingSyncRequest) requestSync();
  }

  void _onServerMessage(ServerMessage msg, [String? originEpk]) {
    // Plan/32f — drop frames from a peer whose channel is no longer the active
    // session (a stale connection still draining after `switchTo`). Without
    // this, a straggler write targets `_activeEpk` — which already points at
    // the NEW chat — and bleeds the old session's messages into the new box.
    // Only gate when BOTH origin and active are set and differ: pre-bind
    // (`_activeEpk == null`, cold boot before `activate`) must still flow, and
    // direct test calls without an origin aren't gated.
    if (originEpk != null && _activeEpk != null && originEpk != _activeEpk) {
      return;
    }
    switch (msg) {
      case AgentChunk(:final inReplyTo, :final delta):
        _chunkBuffer.write(delta);
        _chunkReplyTo = inReplyTo;
        _flushTimer?.cancel();
        _flushTimer = Timer(const Duration(milliseconds: 16), _flushChunks);
        _setWorking(true, replyTo: inReplyTo);

      case AgentDone(:final inReplyTo):
        // Finalize whatever text accumulated since the last tool boundary.
        final text = _finalizeSegment();
        _clearSteeringLabel(inReplyTo);
        _setWorking(false, preview: text.isEmpty ? null : text);

      case AgentMessage(:final inReplyTo, :final text):
        // ignore: discarded_futures
        _upsert(
          MsgRole.assistant,
          inReplyTo,
          (seq, existing) =>
              existing ??
              MessageRecord(
                id: inReplyTo,
                seq: seq,
                role: MsgRole.assistant,
                text: text,
                ts: DateTime.now(),
              ),
        );

      case QueuedMessageState(:final items):
        _setQueuedMessages([
          for (final item in items)
            QueuedMsg(
              id: item.id,
              text: item.text,
              editable: item.editable,
              createdAt: item.createdAt,
            ),
        ]);

      case SteerConsumed(:final id):
        _clearSteeringLabel(id);

      case UserInput(
        :final id,
        :final text,
        :final image,
        :final streamingBehavior,
      ):
        // Echo dedupes against the optimistic row (same id): confirm it
        // (pending=false) or insert as confirmed (foreign device).
        debugPrint('[msg-echo] id=$id');
        // Echo arrived → the send landed; disarm the no-echo backstop.
        _pendingSendTimers.remove(id)?.cancel();
        if (_queuedMessages.any((item) => item.id == id)) {
          _setQueuedMessages([
            for (final item in _queuedMessages)
              if (item.id != id) item,
          ]);
        }
        // ignore: discarded_futures
        _upsert(
          MsgRole.user,
          id,
          (seq, existing) => existing != null
              ? existing.copyWith(pending: false)
              : MessageRecord(
                  id: id,
                  seq: seq,
                  role: MsgRole.user,
                  text: text,
                  image: image == null
                      ? null
                      : MessageImage(data: image.data, mime: image.mime),
                  ts: DateTime.now(),
                ),
        );
        // Steering input should not start/replace the working turn bubble.
        if (streamingBehavior == UserMessageStreamingBehavior.steer) {
          _setActivity(SessionActivity.working, preview: text);
        } else {
          _setWorking(true, preview: text, replyTo: id);
          // Show the thinking cursor for this turn (foreign-device echo, or the
          // local echo when the send-seed was already cleared). Guarded so it
          // never wipes a buffer that's already accumulating for this id.
          if (_streaming?.inReplyTo != id) {
            _emitStreaming(StreamingMessage(inReplyTo: id));
          }
        }

      case ToolRequest(:final toolCallId, :final tool, :final args):
        // Sequential ordering: close the current text segment as its own row
        // BEFORE the tool, so "narration → command → narration" renders in
        // order instead of all text landing after the commands.
        _finalizeSegment();
        // ignore: discarded_futures
        _upsert(
          MsgRole.tool,
          toolCallId,
          (seq, existing) =>
              existing ??
              MessageRecord(
                id: toolCallId,
                seq: seq,
                role: MsgRole.tool,
                ts: DateTime.now(),
                tool: ToolEventData(
                  toolCallId: toolCallId,
                  tool: tool,
                  args: args,
                ),
              ),
        );

      case ToolResult(:final toolCallId, :final result, :final error):
        // ignore: discarded_futures
        _upsert(MsgRole.tool, toolCallId, (seq, existing) {
          final base =
              existing?.tool ??
              ToolEventData(toolCallId: toolCallId, tool: 'unknown');
          return (existing ??
                  MessageRecord(
                    id: toolCallId,
                    seq: seq,
                    role: MsgRole.tool,
                    ts: DateTime.now(),
                  ))
              .copyWith(
                tool: base.copyWith(
                  status: error != null
                      ? ToolEventStatus.failed
                      : ToolEventStatus.completed,
                  result: result,
                  error: error,
                ),
              );
        });

      case Cancelled(:final targetId):
        _pendingSendTimers.remove(targetId)?.cancel();
        _discardStreamingState();
        // Cancel is stop-generation, not delete-history. Only drop a local
        // optimistic row that never got confirmed by the Pi echo; preserve
        // confirmed user/tool rows as the audit trail of what happened.
        // ignore: discarded_futures
        _removePendingById(targetId);
        _clearSteeringLabels();
        _setWorking(false);

      case Bye(:final rawReason):
        if (!_eventController.isClosed) {
          _eventController.add(PeerWentOffline(rawReason));
        }
        _clearSteeringLabels();
        _setWorking(false);
        final peer = _conn.activePeer;
        if (peer != null) {
          // ignore: discarded_futures
          _conn.switchTo(peer);
        }

      case SessionHistory():
        // Plan 01 — a response to an `older` page request must MERGE in front
        // of the window; a response to a plain sync replaces it.
        final isOlderPage =
            _pendingOlderRequestId != null &&
            msg.inReplyTo == _pendingOlderRequestId;
        // Only a frame that answers a `session_sync` WE SENT may settle the
        // attempt. The host resets a session BEFORE it acks the switch and
        // broadcasts that reset as an empty `session_history` carrying the
        // `session_switch` id (see `_resetSessionForNew`), so settling on ANY
        // answer released the loading state between the reset and the ack: the
        // transcript fell back to "这里还没有内容" on the session the user had
        // just picked, and only the ack put the skeleton back. The reset itself
        // is still APPLIED — it is the second, id-independent signal that the
        // session changed — it just does not end an attempt whose own answer is
        // still owed. Nothing waits indefinitely: the window (and its 40 s
        // deadline) was opened by the request this frame does not answer.
        if (_syncRequestIds.contains(msg.inReplyTo)) {
          _pendingSyncRetry?.cancel();
          _pendingSyncRetry = null;
          _settleTranscriptLoading();
        }
        // Either way the cursor advances, and a fresh sync supersedes any page
        // request still in flight (otherwise a lost reply would block paging
        // forever).
        _pendingOlderRequestId = null;
        _olderCursor = msg.olderCursor;
        _hasOlder = msg.hasOlder;
        if (!_olderStateController.isClosed) {
          _olderStateController.add(OlderPageState(_hasOlder, _olderCursor));
        }
        if (isOlderPage) {
          // ignore: discarded_futures
          _applyOlderHistory(msg);
        } else {
          // ignore: discarded_futures
          _applyHistory(msg);
        }

      case ErrorMessage(:final code, :final message):
        if (code.contains('unknown_peer')) {
          if (!_eventController.isClosed) {
            _eventController.add(const PairingRevoked());
          }
          break;
        }
        _discardStreamingState();
        _clearSteeringLabels();
        _setWorking(false);
        // ignore: discarded_futures
        _upsert(
          MsgRole.assistant,
          _newId(),
          (seq, _) => MessageRecord(
            id: 'err_$seq',
            seq: seq,
            role: MsgRole.assistant,
            text: '⚠ $code: $message',
            ts: DateTime.now(),
          ),
        );

      case Compaction(:final summary, :final tokensBefore, :final ts):
        _writeCompaction(summary, tokensBefore, ts);

      case ExtensionUiRequest():
        // Plan/57 — transient interactive prompt (ask_user via pi-ask).
        // Surface to the UI; never persist (it's a live request, not history).
        _extensionUiController.add(msg);
        break;
      case RuntimeStatusMessage(:final status):
        // Plan 01 — live header figures (model / thinking / usage / cost /
        // context). Transient: never persisted, mirrors the extension's
        // in-memory-only snapshot.
        _runtimeStatus = status;
        if (!_runtimeStatusController.isClosed) {
          _runtimeStatusController.add(status);
        }

      case SessionSwitchOk(:final sessionId):
        // The Pi moved to a different session in the SAME room. Drop the rows
        // we still hold and fetch the new transcript; nothing else observes
        // this frame, so without it the chat keeps showing the old session.
        // F2 — the id the ack carries is authoritative: it says which session
        // the box must own, instead of wiping blindly on any ack.
        // ignore: discarded_futures
        switchedSession(sessionId);

      case SessionListOk(:final currentId):
        // F2 — the host's answer to `session_list`, and the only other frame
        // that names the live session. Adopting it is what keeps transcript
        // ownership correct when `session_switch_ok` is LOST: the picker polls
        // this same reply after a missed ack, and the row it marks 当前 and the
        // rows in this box are then decided by one server value.
        //
        // The frame names no room and the picker lists workspaces this writer is
        // not bound to, so a reply while the connection addresses ANOTHER room is
        // ignored — adopting it would repaint this box from someone else's
        // switch. (A frame from another PEER's channel never reaches here: the
        // `originEpk` gate at the top of this handler already drops it.) An
        // unchanged id returns at once, so polling costs no rows.
        if (_activeEpk != null && _conn.activeRoomId == _activeRoomId) {
          // ignore: discarded_futures
          _adoptSessionId(
            currentId,
            source: 'session_list_ok.current_id',
            assumeMoved: false,
          );
        }

      case TreeSnapshotOk(:final snapshot):
        if (!_treeSnapshotController.isClosed) {
          _treeSnapshotController.add(snapshot);
        }

      case SessionForkOk(:final editorText):
        if (!_forkDraftController.isClosed) {
          _forkDraftController.add(editorText);
        }

      case TreeNavigateOk(:final editorText):
        // A navigate may also return draft text (edit_prompt entries).
        if (editorText != null && editorText.isNotEmpty) {
          if (!_forkDraftController.isClosed) {
            _forkDraftController.add(editorText);
          }
        }

      case SessionCloneOk():
        break;

      case ActionError(:final action, :final error):
        // Plan 01 — only the tree/branching actions are surfaced here; the
        // session actions keep their existing (silent) handling.
        if (action == ActionName.treeGet ||
            action == ActionName.treeNavigate ||
            action == ActionName.sessionFork ||
            action == ActionName.sessionClone) {
          if (!_treeErrorController.isClosed) {
            _treeErrorController.add(error);
          }
        }
        break;

      case Pong():
      case PairOk():
      case PairError():
      case ActionOk():
      case ModelsList():
      case SessionSwitchError():
      case WorkspaceListOk():
      case WorkspaceStartOk():
      case WorkspaceStopOk():
      // Plan/69 — host control plane: the handshake reply and the lifecycle
      // pushes are consumed by the ConnectionManager (hostHelloStream /
      // workspaceStatesStream); the restart replies are consumed by the
      // workspace picker's request future (SessionCatalog.restartWorkspace).
      // `host_message` never reaches this switch — WsTransport unwraps it.
      case HostHelloOk():
      case WorkspaceState():
      case WorkspaceRestartOk():
      case WorkspaceRestartError():
      case HostMessage():
      // Plan/68 — fs_list replies are consumed by the picker's request future
      // (SessionCatalog._expect), never by the chat stream.
      case FsListOk():
      // Plan/84 — fs_read replies are consumed by the Plan/Files panels'
      // request future, same as fs_list above; never by the chat stream.
      case FsReadOk():
      // Plan/84 — schedule_* replies are consumed by the Automations panel's
      // request future (SessionCatalog), same as fs_list above. Never history.
      case ScheduleListOk():
      case ScheduleAddOk():
      case ScheduleAck():
      // Plan/84 — settings_describe / settings_mutate replies belong to the
      // Settings panel's request future, never to chat history.
      case SettingsDescribeOk():
      case SettingsMutateOk():
      // Plan/84 — models_describe / models_mutate replies belong to the Models
      // panel's request future. They carry credentials-adjacent config, so they
      // must never be persisted as history either.
      case ModelsDescribeOk():
      case ModelsMutateOk():
      // Plan/68 — Pi surface replies are consumed by the skills/plugins page's
      // request future, same as fs_list above.
      case PiSurfaceOk():
      case SkillInvokeOk():
      case SkillSetEnabledOk():
      case PackageOpOk():
      // Plan/84 — changes_snapshot replies are consumed by the Changes panel's
      // request future (SessionCatalog._expect), same as fs_list and pi_surface
      // above. Neither frame is chat history, so neither is persisted here.
      case ChangesSnapshotOk():
      case ChangesSnapshotUnavailable():
        break;
    }
  }

  /// Plan/32 — persist a compaction as a system row so it renders a system
  /// bubble in the chat and survives a re-sync. Keyed by `ts` when present so
  /// the live message and its history replay collapse to one row.
  void _writeCompaction(String summary, int? tokensBefore, int? ts) {
    final id = 'compaction_${ts ?? uuid7()}';
    final when = ts != null
        ? DateTime.fromMillisecondsSinceEpoch(ts)
        : DateTime.now();
    // ignore: discarded_futures
    _upsert(
      MsgRole.compaction,
      id,
      (seq, existing) =>
          existing ??
          MessageRecord(
            id: id,
            seq: seq,
            role: MsgRole.compaction,
            text: summary,
            tokensBefore: tokensBefore,
            ts: when,
          ),
    );
  }

  Future<void> _applyHistory(SessionHistory h) async {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    // F5 — whose rows this frame is, captured with the address it arrived for
    // rather than read back after the write: the rows belong to the session this
    // attempt was issued for, and a switch that lands while the write is queued
    // moves the label forward together with its own queued wipe of these rows.
    final sessionId = _sessionIdByBox[LocalBoxes.sessionKey(epk, room)];
    final rows = _convertHistory(h.events);
    final historyIds = {for (final r in rows) _key(r.role, r.id)};
    await _enqueue(() async {
      final box = await _boxes.msgsBox(epk, room);
      // Preserve local pending user rows the Pi hasn't echoed yet.
      final preserved = <MessageRecord>[];
      for (final v in box.values) {
        final r = MessageRecord.fromJson(_coerce(v));
        if (r.role == MsgRole.user &&
            r.pending &&
            !historyIds.contains(_key(r.role, r.id))) {
          preserved.add(r);
        }
      }
      // Desired ordered state: history (seq = index) then preserved pending.
      final desired = <MessageRecord>[
        for (var i = 0; i < rows.length; i++) rows[i].copyWith(seq: i),
        for (var j = 0; j < preserved.length; j++)
          preserved[j].copyWith(seq: rows.length + j),
      ];
      await _reconcileRows(box, epk, room, desired);
      if (sessionId != null) await _labelBoxSession(epk, room, sessionId);
    });
    if (_activeEpk == epk && _activeRoomId == room) {
      final started = h.sessionStartedAt;
      _updateIndex(
        (cur) => cur.copyWith(
          sessionStartedAt: DateTime.fromMillisecondsSinceEpoch(started),
        ),
      );
    }
  }

  /// Plan 01 — merge one older page in front of the rows already on screen.
  ///
  /// Unlike [_applyHistory] (a reconnect replay that *replaces* the window),
  /// paging accumulates: the incoming page is older than everything held, so
  /// it is prepended. Rows are keyed by `_key(role, id)`, so a page that
  /// overlaps the current window (the Pi deliberately returns one overlapping
  /// boundary entry) dedupes instead of duplicating.
  Future<void> _applyOlderHistory(SessionHistory h) async {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    final older = _convertHistory(h.events);
    await _enqueue(() async {
      final box = await _boxes.msgsBox(epk, room);
      final current = [
        for (final v in box.values) MessageRecord.fromJson(_coerce(v)),
      ]..sort((a, b) => a.seq.compareTo(b.seq));
      // Prepend, keeping the first occurrence so an overlapping boundary entry
      // does not shift the rows the user is already reading.
      final seen = <String>{};
      final merged = <MessageRecord>[];
      for (final r in [...older, ...current]) {
        if (seen.add(_key(r.role, r.id))) merged.add(r);
      }
      final desired = [
        for (var i = 0; i < merged.length; i++) merged[i].copyWith(seq: i),
      ];
      await _reconcileRows(box, epk, room, desired);
    });
  }

  /// Reconcile the message box to [desired] with the MINIMUM number of writes.
  ///
  /// The old path did `box.clear()` + re-put every row. Hive emits a watch
  /// event per deleted AND per put key, so the read repo re-emitted ~2N
  /// times — tearing the whole list down to EMPTY and rebuilding it — on
  /// EVERY SessionHistory the relay re-delivered (which it does on every
  /// reconnect). That was the flicker/"embaralha e some". Diffing instead
  /// means a re-sent identical history produces ZERO box writes → ZERO
  /// emits → no rebuild; a changed history only rewrites the rows that
  /// actually differ.
  Future<void> _reconcileRows(
    Box<dynamic> box,
    String epk,
    String room,
    List<MessageRecord> desired,
  ) async {
    for (final k in box.keys.toList()) {
      if ((k as num).toInt() >= desired.length) {
        await box.delete(k);
      }
    }
    for (var i = 0; i < desired.length; i++) {
      final newJson = desired[i].toJson();
      final curRaw = box.get(i);
      // Normalise the stored value through fromJson→toJson so the compare is
      // independent of however Hive ordered the persisted map.
      final curNorm = curRaw == null
          ? null
          : jsonEncode(MessageRecord.fromJson(_coerce(curRaw)).toJson());
      if (curNorm != jsonEncode(newJson)) {
        await box.put(i, newJson);
      }
    }
    if (_activeEpk == epk && _activeRoomId == room) {
      _idToSeq
        ..clear()
        ..addEntries([
          for (var i = 0; i < desired.length; i++)
            MapEntry(_key(desired[i].role, desired[i].id), i),
        ]);
      _nextSeq = desired.length;
      _indexLoaded = true;
    }
  }

  List<MessageRecord> _convertHistory(List<SessionHistoryEvent> events) {
    final out = <MessageRecord>[];
    var seq = 0;
    for (final e in events) {
      switch (e) {
        case UserInputEvt(:final id, :final text, :final image):
          out.add(
            MessageRecord(
              id: id,
              seq: seq++,
              role: MsgRole.user,
              text: text,
              image: image == null
                  ? null
                  : MessageImage(data: image.data, mime: image.mime),
              ts: DateTime.fromMillisecondsSinceEpoch(e.ts),
            ),
          );
        case AgentMessageEvt(:final inReplyTo, :final text):
          out.add(
            MessageRecord(
              id: inReplyTo,
              seq: seq++,
              role: MsgRole.assistant,
              text: text,
              ts: DateTime.fromMillisecondsSinceEpoch(e.ts),
            ),
          );
        case ToolRequestEvt(:final toolCallId, :final tool, :final args):
          out.add(
            MessageRecord(
              id: toolCallId,
              seq: seq++,
              role: MsgRole.tool,
              ts: DateTime.fromMillisecondsSinceEpoch(e.ts),
              tool: ToolEventData(
                toolCallId: toolCallId,
                tool: tool,
                args: args,
              ),
            ),
          );
        case ToolResultEvt(:final toolCallId, :final result, :final error):
          final idx = out.lastIndexWhere(
            (m) => m.role == MsgRole.tool && m.tool?.toolCallId == toolCallId,
          );
          final status = error != null
              ? ToolEventStatus.failed
              : ToolEventStatus.completed;
          if (idx >= 0) {
            out[idx] = out[idx].copyWith(
              tool: out[idx].tool!.copyWith(
                status: status,
                result: result,
                error: error,
              ),
            );
          } else {
            out.add(
              MessageRecord(
                id: toolCallId,
                seq: seq++,
                role: MsgRole.tool,
                ts: DateTime.fromMillisecondsSinceEpoch(e.ts),
                tool: ToolEventData(
                  toolCallId: toolCallId,
                  tool: 'unknown',
                  status: status,
                  result: result,
                  error: error,
                ),
              ),
            );
          }
        case CompactionEvt(:final summary, :final tokensBefore):
          out.add(
            MessageRecord(
              id: 'compaction_${e.ts}',
              seq: seq++,
              role: MsgRole.compaction,
              text: summary,
              tokensBefore: tokensBefore,
              ts: DateTime.fromMillisecondsSinceEpoch(e.ts),
            ),
          );
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Box write helpers (all serialised through _enqueue)
  // ---------------------------------------------------------------------------

  String _key(MsgRole role, String id) => '${role.name}:$id';

  Future<void> _loadIndex() {
    final epk = _activeEpk;
    if (epk == null) return Future<void>.value();
    final room = _activeRoomId;
    return _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) return;
      final box = await _boxes.msgsBox(epk, room);
      _idToSeq.clear();
      _nextSeq = 0;
      for (final k in box.keys) {
        final seq = (k as num).toInt();
        final r = MessageRecord.fromJson(_coerce(box.get(k)));
        _idToSeq[_key(r.role, r.id)] = seq;
        _nextSeq = math.max(_nextSeq, seq + 1);
        // Re-arm the no-echo backstop for any pending row this session owns, so
        // a bubble persisted across an app restart / quick session-switch is
        // reaped by its `ts` instead of spinning forever (already-stale → fires
        // immediately). Timers were cleared by _resetTurnState before this load.
        if (r.role == MsgRole.user && r.pending) _armSendTimeout(r.id, r.ts);
      }
      _indexLoaded = true;
    });
  }

  Future<void> _upsert(
    MsgRole role,
    String id,
    MessageRecord Function(int seq, MessageRecord? existing) build,
  ) {
    final epk = _activeEpk;
    if (epk == null) return Future<void>.value();
    final room = _activeRoomId;
    return _enqueue(() async {
      final active = _activeEpk == epk && _activeRoomId == room;
      if (!active) return;
      final box = await _boxes.msgsBox(epk, room);
      final mapKey = _key(role, id);
      final existingSeq = _idToSeq[mapKey];
      if (existingSeq != null) {
        final existing = MessageRecord.fromJson(_coerce(box.get(existingSeq)));
        await box.put(existingSeq, build(existingSeq, existing).toJson());
      } else {
        final seq = _nextSeq++;
        await box.put(seq, build(seq, null).toJson());
        _idToSeq[mapKey] = seq;
      }
    });
  }

  Future<void> _removeById(String id) {
    final epk = _activeEpk;
    if (epk == null) return Future<void>.value();
    final room = _activeRoomId;
    return _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) return;
      final box = await _boxes.msgsBox(epk, room);
      for (final role in MsgRole.values) {
        final seq = _idToSeq.remove(_key(role, id));
        if (seq != null) await box.delete(seq);
      }
    });
  }

  void _clearSteeringLabel(String id) {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    // ignore: discarded_futures
    _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) return;
      final box = await _boxes.msgsBox(epk, room);
      final seq = _idToSeq[_key(MsgRole.user, id)];
      if (seq == null) return;
      final raw = box.get(seq);
      if (raw == null) return;
      final existing = MessageRecord.fromJson(_coerce(raw));
      if (existing.role != MsgRole.user || !existing.steering) return;
      await box.put(seq, existing.copyWith(steering: false).toJson());
    });
  }

  void _clearSteeringLabels() {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    // ignore: discarded_futures
    _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) return;
      final box = await _boxes.msgsBox(epk, room);
      for (final key in box.keys.toList()) {
        final raw = box.get(key);
        if (raw == null) continue;
        final existing = MessageRecord.fromJson(_coerce(raw));
        if (existing.role != MsgRole.user || !existing.steering) continue;
        await box.put(
          (key as num).toInt(),
          existing.copyWith(steering: false).toJson(),
        );
      }
    });
  }

  Future<void> _removePendingById(String id) {
    final epk = _activeEpk;
    if (epk == null) return Future<void>.value();
    final room = _activeRoomId;
    return _enqueue(() async {
      if (_activeEpk != epk || _activeRoomId != room) return;
      final box = await _boxes.msgsBox(epk, room);
      for (final role in MsgRole.values) {
        final key = _key(role, id);
        final seq = _idToSeq[key];
        if (seq == null) continue;
        final raw = box.get(seq);
        if (raw == null) {
          _idToSeq.remove(key);
          continue;
        }
        final existing = MessageRecord.fromJson(_coerce(raw));
        if (!existing.pending) continue;
        _idToSeq.remove(key);
        await box.delete(seq);
      }
    });
  }

  void _setActivity(SessionActivity status, {String? preview}) {
    _updateIndex(
      (cur) => cur.copyWith(
        status: status,
        lastMessageAt: preview != null ? DateTime.now() : null,
        lastMessagePreview: preview,
      ),
    );
  }

  void _setQueuedMessages(List<QueuedMsg> items) {
    final next = List<QueuedMsg>.unmodifiable(items);
    if (_queuedMessages == next) return;
    _queuedMessages = next;
    if (!_queuedController.isClosed) _queuedController.add(next);
  }

  /// Single source of "the active session is working". Drives the in-memory
  /// flag/stream (chat pill) AND the durable session index (Home dot).

  void _syncTurnStateFromRoomMeta() {
    final epk = _activeEpk;
    if (epk == null) return;
    // The room_meta broadcast is the single writer for the durable index:
    // `working:true` lights the indicator immediately (Q1c/Part B), while
    // `working:false` is applied lazily via [_workingOffTimer] so a
    // turn_start racing inside the debounce window wins (Q4).
    if (_conn.isRoomWorking(epk, _activeRoomId)) {
      _workingOffTimer?.cancel();
      _workingOffTimer = null;
      return;
    }
    if (!_working || _workingOffTimer != null) return;
    _workingOffTimer = Timer(_workingOffDelay, () {
      _workingOffTimer = null;
      final liveEpk = _activeEpk;
      // Session switched (or disposed) during the window — nothing to clear.
      if (liveEpk == null || _activeEpk != epk) return;
      // A newer turn_start re-armed working; leave it alone.
      if (_conn.isRoomWorking(liveEpk, _activeRoomId)) return;
      _discardStreamingState();
      _setWorking(false);
    });
  }

  void _setWorking(bool on, {String? preview, String? replyTo}) {
    _setActivity(
      on ? SessionActivity.working : SessionActivity.idle,
      preview: preview,
    );
    // Snapshot nullable field once; Dart won't promote mutable fields safely.
    final epk = _activeEpk;
    if (epk != null) {
      _conn.markRoomWorking(epk, _activeRoomId, on);
    }
    if (on) {
      _workingOffTimer?.cancel();
      _workingOffTimer = null;
      if (replyTo != null) _workingReplyTo = replyTo;
    } else {
      _workingReplyTo = null;
    }
    if (_working == on) return;
    _working = on;
    if (!_workingController.isClosed) _workingController.add(on);
  }

  void _updateIndex(SessionIndexRecord Function(SessionIndexRecord cur) build) {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    // ignore: discarded_futures
    _enqueue(() async {
      final idx = _boxes.sessionsIndexBox();
      final key = LocalBoxes.sessionKey(epk, room);
      final raw = idx.get(key);
      final cur = raw is Map
          ? SessionIndexRecord.fromJson(raw.cast<String, dynamic>())
          : SessionIndexRecord(epk: epk, roomId: room);
      await idx.put(key, build(cur).toJson());
    });
  }

  void _writeRuntime() {
    final epk = _activeEpk;
    if (epk == null) return;
    final room = _activeRoomId;
    final s = _conn.status;
    final conn = switch (s) {
      StatusOnline() => RuntimeConnection.online,
      StatusConnecting() => RuntimeConnection.connecting,
      StatusRetrying() => RuntimeConnection.retrying,
      StatusOffline() => RuntimeConnection.offline,
      StatusNoPeer() => RuntimeConnection.connecting,
    };
    final presence = (s is StatusOnline && _conn.isRoomLive(epk, room))
        ? RuntimePresence.alive
        : (s is StatusOnline ? RuntimePresence.stale : RuntimePresence.unknown);
    // ignore: discarded_futures
    _enqueue(() async {
      _boxes.runtimeBox().put(
        LocalBoxes.sessionKey(epk, room),
        RuntimeRecord(connection: conn, presence: presence).toJson(),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Streaming (in-memory only)
  // ---------------------------------------------------------------------------

  void _flushChunks() {
    if (_chunkBuffer.isEmpty) return;
    final delta = _chunkBuffer.toString();
    _chunkBuffer.clear();
    final cur = _streaming;
    if (cur != null && cur.inReplyTo == _chunkReplyTo) {
      _emitStreaming(cur.appendDelta(delta));
    } else {
      _emitStreaming(StreamingMessage(inReplyTo: _chunkReplyTo, buffer: delta));
    }
  }

  /// Persist the accumulated streaming text as a standalone assistant row
  /// (unique id, in chronological seq order) and clear the live cursor.
  /// Called at every tool boundary AND on agent_done so text/tool/text
  /// renders sequentially. No-op (just clears the cursor) when there's no
  /// text — so a tool-only or empty turn never leaves a blank bubble.
  /// Returns the finalized text (empty if none).
  String _finalizeSegment() {
    // Drain any coalesced delta still sitting in the 16ms buffer.
    _flushTimer?.cancel();
    _flushTimer = null;
    if (_chunkBuffer.isNotEmpty) {
      final delta = _chunkBuffer.toString();
      _chunkBuffer.clear();
      final cur = _streaming;
      _streaming = (cur != null && cur.inReplyTo == _chunkReplyTo)
          ? cur.appendDelta(delta)
          : StreamingMessage(inReplyTo: _chunkReplyTo, buffer: delta);
    }
    final text = _streaming?.buffer ?? '';
    if (text.isNotEmpty) {
      final id = 'agent_${uuid7()}';
      // ignore: discarded_futures
      _upsert(
        MsgRole.assistant,
        id,
        (seq, _) => MessageRecord(
          id: id,
          seq: seq,
          role: MsgRole.assistant,
          text: text,
          ts: DateTime.now(),
        ),
      );
    }
    _chunkReplyTo = '';
    _emitStreaming(null);
    return text;
  }

  void _discardStreamingState() {
    _flushTimer?.cancel();
    _flushTimer = null;
    _chunkBuffer.clear();
    _chunkReplyTo = '';
    _emitStreaming(null);
  }

  void _emitStreaming(StreamingMessage? s) {
    _streaming = s;
    if (!_streamingController.isClosed) _streamingController.add(s);
  }

  // ---------------------------------------------------------------------------

  Future<void> _enqueue(Future<void> Function() op) {
    final next = _writeChain.then((_) => op());
    _writeChain = next.catchError((Object _, StackTrace _) {});
    return next;
  }

  static Map<String, dynamic> _coerce(dynamic raw) {
    if (raw is Map<String, dynamic>) return raw;
    if (raw is Map) return raw.cast<String, dynamic>();
    return <String, dynamic>{};
  }

  static String _preview(String text, MessageImage? image) {
    if (text.isEmpty && image != null) return '📷 Image';
    return text.length <= 80 ? text : '${text.substring(0, 80)}…';
  }

  static String _newId() => 'cli_${uuid7()}';

  @override
  void dispose() {
    _flushTimer?.cancel();
    _syncDebounce?.cancel();
    _pendingSyncRetry?.cancel();
    _workingOffTimer?.cancel();
    _cancelAllSendTimers();
    _connSub?.cancel();
    _msgSub?.cancel();
    _roomsSub?.cancel();
    _presenceSub?.cancel();
    _streamingController.close();
    _transcriptLoadingController.close();
    _eventController.close();
    _extensionUiController.close();
    _workingController.close();
    _queuedController.close();
    _runtimeStatusController.close();
    _olderStateController.close();
    _treeSnapshotController.close();
    _treeErrorController.close();
    _forkDraftController.close();
  }
}
