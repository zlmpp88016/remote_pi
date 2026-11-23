// Plan 86 P4 — bounded page cache for the read-only history viewer.
//
// The cache is an OPTIMIZATION with an explicit contract, not a second source
// of truth:
//   * keyed by host peer + workspace(daemon) + session + snapshot generation
//     + projection + page cursor (see [HistoryCacheKey]) — a cached page can
//     never be served for another workspace/session/generation/cursor;
//   * bounded by ACTUAL UTF-8 content bytes (8 MiB) and by 8 distinct session
//     keys, so eight giant transcripts cannot fill memory;
//   * scoped invalidation only: a reconnect/deletion/refresh of one peer,
//     workspace or session never drops another scope;
//   * a cache hit is painted immediately and revalidated with the host's
//     revision (`if_revision`), which is what lets the label say "cached" until
//     the host confirms `not_modified`.
//
// Body chunks/full bodies are NOT cached here: they are bounded by the viewer
// and would otherwise eat the whole page budget.

import 'dart:collection';
import 'dart:convert';

import 'package:mobile/data/transport/epk_encoding.dart';
import 'package:mobile/domain/history/history_models.dart';

/// Page-cache identity. Every component is load-bearing; dropping one lets a
/// page from another scope be painted as this one's.
class HistoryCacheKey {
  final String peer;
  final String daemonId;
  final String sessionId;
  final String snapshot;
  final int projection;

  /// Null = newest page. Opaque and host-issued.
  final String? cursor;

  const HistoryCacheKey({
    required this.peer,
    required this.daemonId,
    required this.sessionId,
    required this.snapshot,
    required this.projection,
    required this.cursor,
  });

  @override
  bool operator ==(Object other) =>
      other is HistoryCacheKey &&
      other.peer == peer &&
      other.daemonId == daemonId &&
      other.sessionId == sessionId &&
      other.snapshot == snapshot &&
      other.projection == projection &&
      other.cursor == cursor;

  @override
  int get hashCode =>
      Object.hash(peer, daemonId, sessionId, snapshot, projection, cursor);
}

class _WorkspaceKey {
  final String peer;
  final String daemonId;
  final String? cursor;

  const _WorkspaceKey(this.peer, this.daemonId, this.cursor);

  @override
  bool operator ==(Object other) =>
      other is _WorkspaceKey &&
      other.peer == peer &&
      other.daemonId == daemonId &&
      other.cursor == cursor;

  @override
  int get hashCode => Object.hash(peer, daemonId, cursor);
}

class _Entry<T> {
  final T value;
  final int bytes;
  _Entry(this.value, this.bytes);
}

/// Bounded LRU cache. Not thread-safe by design: all access happens on the
/// UI/VM isolate.
class HistoryPageCache {
  /// Page budget (UTF-8 content bytes).
  static const int maxBytes = 8 * 1024 * 1024;

  /// Distinct (peer, workspace, session) keys allowed for pages.
  static const int maxSessions = 8;

  /// Workspace listings are small; a separate, tighter bound keeps them from
  /// evicting real pages.
  static const int maxWorkspaces = 8;

  final LinkedHashMap<HistoryCacheKey, _Entry<HistoryPage>> _pages =
      LinkedHashMap();
  final LinkedHashMap<_WorkspaceKey, _Entry<HistoryWorkspaceListing>>
  _workspaces = LinkedHashMap();
  final Map<String, int> _pagesPerSession = {};

  int _pageBytes = 0;

  /// Testing/instrumentation only.
  int get totalBytes => _pageBytes;
  int get sessionKeyCount => _pagesPerSession.length;
  int get pageCount => _pages.length;
  int get workspaceCount => _workspaces.length;

  HistoryPage? lookupPage(HistoryCacheKey key) {
    final entry = _pages.remove(key);
    if (entry == null) return null;
    // Re-insert to mark MRU.
    _pages[key] = entry;
    return entry.value;
  }

  /// Newest cached page for a session, chosen by snapshot then cursor. Used to
  /// paint the first frame before the host's snapshot is known.
  HistoryPage? lookupNewestPage(String epk, String daemonId, String sessionId) {
    final peer = toStandardB64(epk);
    HistoryCacheKey? match;
    for (final key in _pages.keys) {
      if (key.peer != peer ||
          key.daemonId != daemonId ||
          key.sessionId != sessionId ||
          key.cursor != null) {
        continue;
      }
      // The newest page is deterministic per snapshot; if a session holds
      // several snapshots (a rewrite happened), prefer the most recently used
      // entry. Insertion order here is LRU order, so keep the LAST match.
      match = key;
    }
    if (match == null) return null;
    return lookupPage(match);
  }

  void putPage(HistoryCacheKey key, HistoryPage page) {
    final normalized = HistoryCacheKey(
      peer: toStandardB64(key.peer),
      daemonId: key.daemonId,
      sessionId: key.sessionId,
      snapshot: key.snapshot,
      projection: key.projection,
      cursor: key.cursor,
    );
    final existing = _pages.remove(normalized);
    if (existing != null) {
      _pageBytes -= existing.bytes;
      _decrementSession(normalized);
    }
    final bytes = estimatePageBytes(page);
    _pages[normalized] = _Entry(page, bytes);
    _pageBytes += bytes;
    _incrementSession(normalized);
    _evictPages();
  }

  HistoryWorkspaceListing? lookupWorkspace(String epk, String daemonId) {
    final key = _WorkspaceKey(toStandardB64(epk), daemonId, null);
    final entry = _workspaces.remove(key);
    if (entry == null) return null;
    _workspaces[key] = entry;
    return entry.value;
  }

  void putWorkspace(
    String epk,
    String daemonId,
    HistoryWorkspaceListing value,
  ) {
    final key = _WorkspaceKey(toStandardB64(epk), daemonId, null);
    _workspaces.remove(key);
    _workspaces[key] = _Entry(value, estimateListingBytes(value));
    while (_workspaces.length > maxWorkspaces) {
      _workspaces.remove(_workspaces.keys.first);
    }
  }

  /// Scoped invalidation — every entry of ONE peer.
  void invalidatePeer(String epk) {
    final peer = toStandardB64(epk);
    final keys = [
      for (final k in _pages.keys)
        if (k.peer == peer) k,
    ];
    for (final key in keys) {
      _removePage(key);
    }
    _workspaces.removeWhere((k, _) => k.peer == peer);
  }

  void invalidateWorkspace(String epk, String daemonId) {
    final peer = toStandardB64(epk);
    final keys = [
      for (final k in _pages.keys)
        if (k.peer == peer && k.daemonId == daemonId) k,
    ];
    for (final key in keys) {
      _removePage(key);
    }
    _workspaces.remove(_WorkspaceKey(peer, daemonId, null));
  }

  void invalidateSession(String epk, String daemonId, String sessionId) {
    final peer = toStandardB64(epk);
    final keys = [
      for (final k in _pages.keys)
        if (k.peer == peer &&
            k.daemonId == daemonId &&
            k.sessionId == sessionId)
          k,
    ];
    for (final key in keys) {
      _removePage(key);
    }
  }

  void clear() {
    _pages.clear();
    _workspaces.clear();
    _pagesPerSession.clear();
    _pageBytes = 0;
  }

  void _removePage(HistoryCacheKey key) {
    final entry = _pages.remove(key);
    if (entry == null) return;
    _pageBytes -= entry.bytes;
    _decrementSession(key);
  }

  void _incrementSession(HistoryCacheKey key) {
    final scope = _sessionScope(key);
    _pagesPerSession[scope] = (_pagesPerSession[scope] ?? 0) + 1;
  }

  void _decrementSession(HistoryCacheKey key) {
    final scope = _sessionScope(key);
    final next = (_pagesPerSession[scope] ?? 1) - 1;
    if (next <= 0) {
      _pagesPerSession.remove(scope);
    } else {
      _pagesPerSession[scope] = next;
    }
  }

  void _evictPages() {
    while (_pageBytes > maxBytes || _pagesPerSession.length > maxSessions) {
      if (_pages.isEmpty) return;
      _removePage(_pages.keys.first);
    }
  }

  static String _sessionScope(HistoryCacheKey key) =>
      '${key.peer}|${key.daemonId}|${key.sessionId}';
}

// ---------------------------------------------------------------------------
// Byte accounting — actual UTF-8 content size, not "number of items".
// ---------------------------------------------------------------------------

int _utf8(String? s) => s == null ? 0 : utf8.encode(s).length;

int estimateListingBytes(HistoryWorkspaceListing listing) {
  var bytes = 64 + _utf8(listing.daemonId) + _utf8(listing.revision);
  for (final s in listing.sessions) {
    bytes += 48 + _utf8(s.id) + _utf8(s.name) + _utf8(s.preview);
  }
  return bytes;
}

int estimatePageBytes(HistoryPage page) {
  var bytes =
      128 +
      _utf8(page.daemonId) +
      _utf8(page.sessionId) +
      _utf8(page.snapshot) +
      _utf8(page.revision) +
      _utf8(page.session.id) +
      _utf8(page.session.name) +
      _utf8(page.session.preview);
  for (final item in page.items) {
    bytes += 96 + _utf8(item.eventId) + _utf8(item.entryId);
    bytes += _utf8(_eventText(item.event));
    for (final ref in item.bodyRefs) {
      bytes +=
          64 +
          _utf8(ref.ref) +
          _utf8(ref.field) +
          _utf8(ref.mime) +
          _utf8(ref.preview);
    }
  }
  return bytes;
}

String _eventText(HistoryEvent event) => switch (event) {
  HistoryUserEvent(:final text, :final imageData, :final imageMime) =>
    '$text${imageData ?? ''}${imageMime ?? ''}',
  HistoryAssistantEvent(:final text) => text,
  HistoryToolRequestEvent(:final tool, :final args) =>
    '$tool${_stringify(args)}',
  HistoryToolResultEvent(:final result, :final error) =>
    '${_stringify(result)}${error ?? ''}',
  HistoryCompactionEvent(:final summary) => summary,
  HistoryUnknownEvent(:final type) => type,
};

String _stringify(Object? value) {
  if (value == null) return '';
  if (value is String) return value;
  try {
    return jsonEncode(value);
  } catch (_) {
    // Non-encodable diagnostic payloads are never expected from JSON input; a
    // conservative fixed cost keeps accounting bounded instead of throwing.
    return 'object';
  }
}
