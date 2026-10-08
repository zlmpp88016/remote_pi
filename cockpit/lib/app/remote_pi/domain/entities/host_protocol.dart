/// Mensagens do protocolo do room `host` (plano 69) — SOMENTE o que
/// PROTOCOL.md documenta (seções "Host-first connection (plan 69)",
/// "Pareamento" e "Filesystem navigation (plan 68)"). Zero contrato novo
/// aqui: este arquivo espelha `site/src/lib/remote-pi/protocol.ts` (cliente
/// web de referência, já validado contra o relay) e
/// `pi-extension/src/protocol/types.ts` (fonte dos tipos).
///
/// Transporte (PROTOCOL.md "Camadas do protocolo"): WebSocket no relay com
/// handshake `hello → challenge → auth` (Ed25519 sobre os bytes crus do
/// nonce). Depois do auth, toda mensagem de aplicação roda no envelope opaco
/// `{peer, room, ct}` com `ct` = base64(JSON da mensagem interna). O relay
/// reescreve `peer`/`room` com a identidade autenticada do remetente antes de
/// entregar (relay/src/handlers/peer.rs).
///
/// Modelo de conexão (decisão B do spike de multiplex): o cliente ancora SÓ
/// no room `host`. Chat de workspace proxeia via `host_forward` (outbound) /
/// `host_message` (inbound) — o daemon re-emite o payload pra room do filho e
/// reembrulha as respostas.
library;

import 'dart:convert';

import 'pairing_code.dart' show kHostRoomId;

// ── entidades ───────────────────────────────────────────────────────────────

/// Ciclo de vida de um workspace, espelhando o `ChildSlot` do supervisor.
/// União fechada — o host nunca fabrica estado.
enum WorkspaceState { running, starting, crashed, stopped }

/// Procedência da linha no `workspace_list_ok`: `daemon` veio do
/// `daemons.json`; `added` foi navigada/adicionada pelo cliente
/// (`workspaces.json`).
enum WorkspaceSource { daemon, added }

/// Info do daemon no `host_hello_ok`. Campo que o host não consegue
/// determinar vem `null` — nunca um valor chutado.
class HostDaemonInfo {
  const HostDaemonInfo({this.version, this.hostname, this.platform});

  final String? version;
  final String? hostname;
  final String? platform;
}

/// Uma linha do `workspace_list_ok`.
class WorkspaceInfo {
  const WorkspaceInfo({
    required this.cwd,
    required this.daemonId,
    required this.roomId,
    required this.name,
    required this.live,
    required this.daemon,
    required this.source,
  });

  final String cwd;
  final String daemonId;
  final String roomId;
  final String name;
  final bool live;
  final bool daemon;
  final WorkspaceSource source;
}

/// Uma entrada do `fs_list_ok`.
class FsEntry {
  const FsEntry({required this.name, required this.kind, this.isRepo = false});

  final String name;
  final FsEntryKind kind;

  /// Dica de que o diretório tem `.git`. Nunca recursada.
  final bool isRepo;
}

enum FsEntryKind { dir, file }

// ── mensagens do cliente (ClientMessage) ────────────────────────────────────

/// Mensagem inbound→outbound do cliente. `toJson` é o wire; `id` correla
/// requests (o `auth` não tem id — é frame de handshake, não request) e
/// `type` nomeia a request nos erros de timeout.
sealed class ClientMessage {
  const ClientMessage();

  String get type;

  String get id;

  Map<String, Object?> toJson();
}

/// `hello` do handshake do relay. `room_id: "host"` — o cliente ancora no
/// room do host desde o primeiro frame.
final class Hello extends ClientMessage {
  const Hello({required this.id, required this.pubkey, this.roomId = kHostRoomId});

  @override
  String get type => 'hello';

  @override
  final String id;

  final String pubkey;
  final String roomId;

  @override
  Map<String, Object?> toJson() => {
    'type': 'hello',
    'id': id,
    'pubkey': pubkey,
    'room_id': roomId,
  };
}

/// `auth` do handshake: assinatura Ed25519 sobre os bytes crus do nonce.
final class Auth extends ClientMessage {
  const Auth(this.sig);

  final String sig;

  @override
  String get type => 'auth';

  @override
  String get id => '';

  @override
  Map<String, Object?> toJson() => {'type': 'auth', 'sig': sig};
}

/// `pair_request` no room `host` — carve-out de allow-list só para peer
/// desconhecido com esta mensagem (plano 69 W1).
final class PairRequest extends ClientMessage {
  const PairRequest({required this.id, required this.token, required this.deviceName});

  @override
  String get type => 'pair_request';

  @override
  final String id;

  final String token;
  final String deviceName;

  @override
  Map<String, Object?> toJson() => {
    'type': 'pair_request',
    'id': id,
    'token': token,
    'device_name': deviceName,
  };
}

/// `host_hello` — versão/hostname/capacidades reais do daemon.
final class HostHello extends ClientMessage {
  const HostHello(this.id);

  @override
  String get type => 'host_hello';

  @override
  final String id;

  @override
  Map<String, Object?> toJson() => {'type': 'host_hello', 'id': id};
}

/// `workspace_list` — daemons registrados ∪ workspaces adicionados.
final class WorkspaceList extends ClientMessage {
  const WorkspaceList(this.id);

  @override
  String get type => 'workspace_list';

  @override
  final String id;

  @override
  Map<String, Object?> toJson() => {'type': 'workspace_list', 'id': id};
}

/// `workspace_start` — spawn (ou adopt) de um Pi em `cwd` arbitrário.
final class WorkspaceStart extends ClientMessage {
  const WorkspaceStart({required this.id, required this.cwd});

  @override
  String get type => 'workspace_start';

  @override
  final String id;

  final String cwd;

  @override
  Map<String, Object?> toJson() => {'type': 'workspace_start', 'id': id, 'cwd': cwd};
}

/// `workspace_restart` — idempotente: workspace já `running` responde
/// `workspace_restart_ok` sem respawn.
final class WorkspaceRestart extends ClientMessage {
  const WorkspaceRestart({required this.id, required this.cwd});

  @override
  String get type => 'workspace_restart';

  @override
  final String id;

  final String cwd;

  @override
  Map<String, Object?> toJson() => {'type': 'workspace_restart', 'id': id, 'cwd': cwd};
}

/// `workspace_add` — persiste o cwd no `workspaces.json` do host.
final class WorkspaceAdd extends ClientMessage {
  const WorkspaceAdd({required this.id, required this.path});

  @override
  String get type => 'workspace_add';

  @override
  final String id;

  final String path;

  @override
  Map<String, Object?> toJson() => {'type': 'workspace_add', 'id': id, 'path': path};
}

/// `fs_list` — o host resolve e lista; o cliente nunca toca um path local.
final class FsList extends ClientMessage {
  const FsList({required this.id, required this.path, this.showHidden = false});

  @override
  String get type => 'fs_list';

  @override
  final String id;

  final String path;
  final bool showHidden;

  @override
  Map<String, Object?> toJson() => {
    'type': 'fs_list',
    'id': id,
    'path': path,
    'show_hidden': showHidden,
  };
}

/// `host_forward` — envelope de proxy (decisão B): a mensagem interna
/// (`ct`) é endereçada à room do filho, mas trafega no room `host`.
final class HostForward extends ClientMessage {
  const HostForward({required this.id, required this.room, required this.ct});

  @override
  String get type => 'host_forward';

  @override
  final String id;

  final String room;
  final String ct;

  @override
  Map<String, Object?> toJson() => {
    'type': 'host_forward',
    'id': id,
    'room': room,
    'ct': ct,
  };
}

/// `user_message` — texto do chat. Só trafega como interior de um
/// `host_forward` (o cliente ancora no room `host`).
final class UserMessageText extends ClientMessage {
  const UserMessageText({required this.id, required this.text});

  @override
  String get type => 'user_message';

  @override
  final String id;

  final String text;

  @override
  Map<String, Object?> toJson() => {'type': 'user_message', 'id': id, 'text': text};
}

// ── mensagens do host (ServerMessage) ───────────────────────────────────────

/// Mensagem que o host/relay entrega. União selada: tipo desconhecido vira
/// [UnknownServerMessage] (forward-compat — nunca crasha em host novo).
sealed class ServerMessage {
  const ServerMessage();

  String get type;

  /// Correlação de reply (`in_reply_to`), quando for reply.
  String? get inReplyTo => null;
}

/// `challenge` do relay (handshake, pré-auth).
final class Challenge extends ServerMessage {
  const Challenge(this.nonce);

  final String nonce;

  @override
  String get type => 'challenge';
}

/// `pair_ok` — pareamento aceito; peer persistido no host.
final class PairOk extends ServerMessage {
  const PairOk({
    required this.inReplyTo,
    required this.sessionName,
    required this.sessionStartedAt,
    required this.roomId,
    this.hostname,
  });

  @override
  final String inReplyTo;

  final String sessionName;
  final int sessionStartedAt;
  final String roomId;
  final String? hostname;

  @override
  String get type => 'pair_ok';
}

/// `pair_error` — token inválido/expirado/rotacionado.
final class PairError extends ServerMessage {
  const PairError({required this.inReplyTo, required this.code, required this.message});

  @override
  final String inReplyTo;

  final String code;
  final String message;

  @override
  String get type => 'pair_error';
}

/// `host_hello_ok` — versão/hostname/plataforma reais + capacidades.
final class HostHelloOk extends ServerMessage {
  const HostHelloOk({
    required this.inReplyTo,
    required this.daemon,
    required this.capabilities,
  });

  @override
  final String inReplyTo;

  final HostDaemonInfo daemon;
  final List<String> capabilities;

  @override
  String get type => 'host_hello_ok';
}

/// `workspace_list_ok`.
final class WorkspaceListOk extends ServerMessage {
  const WorkspaceListOk({required this.inReplyTo, required this.workspaces});

  @override
  final String inReplyTo;

  final List<WorkspaceInfo> workspaces;

  @override
  String get type => 'workspace_list_ok';
}

/// `fs_list_ok`.
final class FsListOk extends ServerMessage {
  const FsListOk({
    required this.inReplyTo,
    required this.path,
    required this.parent,
    required this.entries,
  });

  @override
  final String inReplyTo;

  /// Caminho resolvido (realpath) — sincroniza o breadcrumb do cliente.
  final String path;

  /// `null` na raiz do filesystem.
  final String? parent;

  final List<FsEntry> entries;

  @override
  String get type => 'fs_list_ok';
}

/// `workspace_start_ok`.
final class WorkspaceStartOk extends ServerMessage {
  const WorkspaceStartOk({
    required this.inReplyTo,
    required this.cwd,
    required this.roomId,
    required this.daemonId,
  });

  @override
  final String inReplyTo;

  final String cwd;

  /// Room do filho — é pra ela que o `host_forward` manda.
  final String roomId;

  final String daemonId;

  @override
  String get type => 'workspace_start_ok';
}

/// `action_ok` — dispatch confirmado (ex.: `workspace_add`).
final class ActionOk extends ServerMessage {
  const ActionOk({required this.inReplyTo, required this.action});

  @override
  final String inReplyTo;

  final String action;

  @override
  String get type => 'action_ok';
}

/// `action_error` — erro tipado (tabela de erros do plano 68).
final class ActionError extends ServerMessage {
  const ActionError({required this.inReplyTo, required this.action, required this.error});

  @override
  final String inReplyTo;

  final String action;
  final String error;

  @override
  String get type => 'action_error';
}

/// `workspace_restart_ok` — idempotente (running → ok sem respawn).
final class WorkspaceRestartOk extends ServerMessage {
  const WorkspaceRestartOk({required this.inReplyTo, required this.cwd, required this.daemonId});

  @override
  final String inReplyTo;

  final String cwd;
  final String daemonId;

  @override
  String get type => 'workspace_restart_ok';
}

/// `workspace_restart_error` — `spawn_failed` | `not_found`.
final class WorkspaceRestartError extends ServerMessage {
  const WorkspaceRestartError({required this.inReplyTo, required this.code, required this.message});

  @override
  final String inReplyTo;

  final String code;
  final String message;

  @override
  String get type => 'workspace_restart_error';
}

/// `workspace_state` — PUSH do host (não é reply): espelha o `ChildSlot` em
/// exit/restart/start/stop. Sem `in_reply_to`.
final class WorkspaceStatePush extends ServerMessage {
  const WorkspaceStatePush({
    required this.cwd,
    required this.state,
    required this.lastError,
    required this.restarts,
  });

  final String cwd;
  final WorkspaceState state;

  /// Presente em `crashed`.
  final String? lastError;

  final int restarts;

  @override
  String get type => 'workspace_state';
}

/// `host_message` — envelope de proxy inbound: `ct` carrega a ServerMessage
/// produzida na room do filho nomeada em `room`. O cliente arquiva por room.
final class HostMessage extends ServerMessage {
  const HostMessage({required this.room, required this.ct});

  final String room;
  final String ct;

  @override
  String get type => 'host_message';
}

/// Eco do `user_message` do próprio cliente (broadcast do filho pra todos os
/// owners). Modelo source-of-truth: cada cliente espera o eco pra renderizar.
final class UserMessageEcho extends ServerMessage {
  const UserMessageEcho({required this.id, required this.text});

  final String id;
  final String text;

  @override
  String get type => 'user_message';
}

/// Delta de streaming da resposta do agente.
final class AgentChunk extends ServerMessage {
  const AgentChunk({required this.inReplyTo, required this.delta});

  @override
  final String inReplyTo;

  final String delta;

  @override
  String get type => 'agent_chunk';
}

/// Fim do turno do agente.
final class AgentDone extends ServerMessage {
  const AgentDone(this.inReplyTo);

  @override
  final String inReplyTo;

  @override
  String get type => 'agent_done';
}

/// Tipo não reconhecido — preservado pra forward-compat (nunca crasha).
final class UnknownServerMessage extends ServerMessage {
  const UnknownServerMessage(this.type);

  @override
  final String type;
}

// ── envelope do relay ───────────────────────────────────────────────────────

/// Envelope opaco do relay: `{peer, room, ct}`.
class OuterEnvelope {
  const OuterEnvelope({required this.peer, required this.room, required this.ct});

  final String peer;
  final String room;
  final String ct;
}

/// `ct` = base64(JSON.stringify(inner)).
String encodeCt(Map<String, Object?> innerJson) =>
    base64.encode(utf8.encode(jsonEncode(innerJson)));

/// Serializa um envelope endereçado a (`peer`, `room`).
String encodeOuter(String peer, String room, ClientMessage inner) =>
    jsonEncode({
      'peer': peer,
      'room': room,
      'ct': encodeCt(inner.toJson()),
    });

/// Envelope como entregue pelo relay: `peer`/`room` já reescritos com a
/// identidade do remetente; `inner` decodificado de `ct`.
class DecodedOuter {
  const DecodedOuter({required this.fromPeer, required this.fromRoom, required this.inner});

  final String fromPeer;
  final String fromRoom;

  /// `null` quando o `ct` não decodifica pra uma mensagem conhecida.
  final ServerMessage? inner;
}

/// Decodifica um frame inbound. `null` quando não é envelope (frame de
/// controle do relay ou lixo) — o cliente ignora nesse caso.
DecodedOuter? decodeOuter(String text) {
  final Object? json;
  try {
    json = jsonDecode(text);
  } on FormatException {
    return null;
  }
  if (json is! Map<String, dynamic>) return null;
  final peer = json['peer'];
  final ct = json['ct'];
  if (peer is! String || ct is! String) return null;
  final room = json['room'];
  return DecodedOuter(
    fromPeer: peer,
    fromRoom: room is String ? room : 'main',
    inner: decodeCt(ct),
  );
}

/// Decodifica o `ct` de um envelope/wrapper. `null` se não parsear.
ServerMessage? decodeCt(String ct) {
  final List<int> bytes;
  try {
    bytes = _base64DecodeLenient(ct);
  } on FormatException {
    return null;
  }
  final Object? json;
  try {
    json = jsonDecode(utf8.decode(bytes));
  } on FormatException {
    return null;
  }
  return parseServerMessage(json);
}

// ── parse das mensagens do host ─────────────────────────────────────────────

/// Constrói a mensagem tipada a partir do JSON decodificado. `null` quando o
/// payload não é um mapa com `type` string.
ServerMessage? parseServerMessage(Object? json) {
  if (json is! Map<String, dynamic>) return null;
  final type = json['type'];
  if (type is! String) return null;
  switch (type) {
    case 'challenge':
      final nonce = json['nonce'];
      return nonce is String ? Challenge(nonce) : null;
    case 'pair_ok':
      return PairOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        sessionName: json['session_name'] as String? ?? '',
        sessionStartedAt: (json['session_started_at'] as num?)?.toInt() ?? 0,
        roomId: json['room_id'] as String? ?? kHostRoomId,
        hostname: json['hostname'] as String?,
      );
    case 'pair_error':
      return PairError(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        code: json['code'] as String? ?? 'unknown',
        message: json['message'] as String? ?? '',
      );
    case 'host_hello_ok':
      final daemon = json['daemon'];
      return HostHelloOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        daemon: HostDaemonInfo(
          version: daemon is Map ? daemon['version'] as String? : null,
          hostname: daemon is Map ? daemon['hostname'] as String? : null,
          platform: daemon is Map ? daemon['platform'] as String? : null,
        ),
        capabilities:
            (json['capabilities'] as List<dynamic>?)
                ?.whereType<String>()
                .toList(growable: false) ??
            const [],
      );
    case 'workspace_list_ok':
      return WorkspaceListOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        workspaces: _parseWorkspaces(json['workspaces']),
      );
    case 'fs_list_ok':
      return FsListOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        path: json['path'] as String? ?? '',
        parent: json['parent'] as String?,
        entries: _parseFsEntries(json['entries']),
      );
    case 'workspace_start_ok':
      return WorkspaceStartOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        cwd: json['cwd'] as String? ?? '',
        roomId: json['room_id'] as String? ?? '',
        daemonId: json['daemon_id'] as String? ?? '',
      );
    case 'action_ok':
      return ActionOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        action: json['action'] as String? ?? '',
      );
    case 'action_error':
      return ActionError(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        action: json['action'] as String? ?? '',
        error: json['error'] as String? ?? 'unknown',
      );
    case 'workspace_restart_ok':
      return WorkspaceRestartOk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        cwd: json['cwd'] as String? ?? '',
        daemonId: json['daemon_id'] as String? ?? '',
      );
    case 'workspace_restart_error':
      return WorkspaceRestartError(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        code: json['code'] as String? ?? 'unknown',
        message: json['message'] as String? ?? '',
      );
    case 'workspace_state':
      return WorkspaceStatePush(
        cwd: json['cwd'] as String? ?? '',
        state: parseWorkspaceState(json['state'] as String?),
        lastError: json['last_error'] as String?,
        restarts: (json['restarts'] as num?)?.toInt() ?? 0,
      );
    case 'host_message':
      final room = json['room'];
      final ct = json['ct'];
      if (room is! String || ct is! String) return null;
      return HostMessage(room: room, ct: ct);
    case 'user_message':
      return UserMessageEcho(
        id: json['id'] as String? ?? '',
        text: json['text'] as String? ?? '',
      );
    case 'agent_chunk':
      return AgentChunk(
        inReplyTo: json['in_reply_to'] as String? ?? '',
        delta: json['delta'] as String? ?? '',
      );
    case 'agent_done':
      return AgentDone(json['in_reply_to'] as String? ?? '');
    default:
      return UnknownServerMessage(type);
  }
}

/// Estado desconhecido do host cai em `stopped` (nunca inventa `running`).
WorkspaceState parseWorkspaceState(String? raw) => switch (raw) {
  'running' => WorkspaceState.running,
  'starting' => WorkspaceState.starting,
  'crashed' => WorkspaceState.crashed,
  _ => WorkspaceState.stopped,
};

List<WorkspaceInfo> _parseWorkspaces(Object? raw) {
  if (raw is! List) return const [];
  return raw.whereType<Map>().map((w) {
    final map = w.cast<String, dynamic>();
    return WorkspaceInfo(
      cwd: map['cwd'] as String? ?? '',
      daemonId: map['daemon_id'] as String? ?? '',
      roomId: map['room_id'] as String? ?? '',
      name: map['name'] as String? ?? '',
      live: map['live'] as bool? ?? false,
      daemon: map['daemon'] as bool? ?? false,
      source: map['source'] == 'added' ? WorkspaceSource.added : WorkspaceSource.daemon,
    );
  }).toList(growable: false);
}

List<FsEntry> _parseFsEntries(Object? raw) {
  if (raw is! List) return const [];
  return raw.whereType<Map>().map((e) {
    final map = e.cast<String, dynamic>();
    return FsEntry(
      name: map['name'] as String? ?? '',
      kind: map['kind'] == 'file' ? FsEntryKind.file : FsEntryKind.dir,
      isRepo: map['is_repo'] as bool? ?? false,
    );
  }).toList(growable: false);
}

/// Decode base64 tolerante: tenta padrão, cai no url-safe (o `ct` é padrão
/// por contrato, mas o relay reescreve o envelope sem tocar no `ct`).
List<int> _base64DecodeLenient(String value) {
  try {
    return base64.decode(value);
  } on FormatException {
    final normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    final padded = normalized.padRight((normalized.length + 3) ~/ 4 * 4, '=');
    return base64.decode(padded);
  }
}
