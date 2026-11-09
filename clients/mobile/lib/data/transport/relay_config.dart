// Relay endpoint resolution.
//
// The relay BELONGS TO EACH PAIRING: `PeerRecord.relayUrl` is what an actual
// connection uses, so pairing two servers on two different relays is well
// defined (each record remembers its own address). This module supplies:
//
//   1. `prefs.relayUrl` / `kDefaultRelayUrl` — the PREFILL for a NEW pairing,
//      and the relay the mesh HTTP client talks to.
//   2. [resolveRelayUrl] as the fallback for a record whose relay was never
//      recorded (records written before this field was populated).
//
// It used to be a single global applied to EVERY connection, which made
// "which relay is this pairing on?" unanswerable as soon as a second server was
// added — the field the user could edit had no way to say who it belonged to.
//
// Canonical scheme on storage is `http://` or `https://` — this is
// the form the user types and what we keep in Preferences. The WebSocket
// transport calls [toWsRelayUrl] right before opening the socket; the
// mesh HTTP client uses the URL as-is. The legacy `ws://` / `wss://`
// schemes are NOT accepted on input — the app is pre-release and
// historical persisted values get re-set by the user during the
// onboarding gate.

import 'package:mobile/data/preferences/preferences.dart';
import 'package:mobile/pairing/storage.dart';

/// Public community relay. Hardcoded; not configurable at build time
/// to keep the onboarding flow deterministic.
const String kDefaultRelayUrl = 'https://relay.880160.xyz';

/// The relay a connection to [peer] must use.
///
/// The pairing owns its relay; the app-wide default is only a fallback for a
/// record that never recorded one (written before the field was populated).
/// Extracted from the connection factory so the decision itself is testable
/// without an injector, an owner key or a live socket.
String relayUrlForPeer(PeerRecord peer, Preferences prefs) {
  final stored = peer.relayUrl.trim();
  return stored.isNotEmpty ? stored : resolveRelayUrl(prefs);
}

/// User-facing message returned when [isValidRelayUrl] rejects a value.
/// Surfaced verbatim by Settings and Onboarding — keep stable for
/// localization later. Empty input gets a more generic message; the
/// ws/wss case is called out explicitly so the user understands the
/// app does the conversion internally.
const String kRelayUrlInvalidScheme =
    'Use http:// or https:// (not ws:// or wss:// — the app converts '
    'to WebSocket automatically).';

const String kRelayUrlInvalidGeneric =
    'Enter a valid URL starting with https:// (or http:// for local '
    'relays).';

/// Returns the effective DEFAULT relay URL for new pairings (and the mesh
/// HTTP client). Falls back to [kDefaultRelayUrl] when no user override is set.
///
/// NOT what an existing pairing connects through — that is
/// `PeerRecord.relayUrl`, which is authoritative per server.
/// Always returns an `http(s)://` URL — caller is responsible for
/// applying [toWsRelayUrl] when opening a WebSocket.
String resolveRelayUrl(Preferences prefs) =>
    prefs.relayUrl ?? kDefaultRelayUrl;

/// Translates the canonical HTTP-form relay URL into the WebSocket
/// form expected by the underlying transport. `https://` → `wss://`,
/// `http://` → `ws://`. Pre-existing `ws(s)://` URLs (legacy QR
/// payloads, old peer records) pass through unchanged so the relay
/// mismatch check in `pair_request_flow` can still compare them.
String toWsRelayUrl(String url) {
  if (url.startsWith('https://')) return 'wss://${url.substring(8)}';
  if (url.startsWith('http://')) return 'ws://${url.substring(7)}';
  return url;
}

/// Validates a candidate relay URL the user typed into Settings or
/// the onboarding form.
///
/// Rules:
/// - Non-empty.
/// - Scheme must be `http://` or `https://`. Returns `false` (with the
///   ws/wss-specific reason via [relayUrlValidationMessage]) for the
///   legacy `ws://` / `wss://` schemes — the app converts internally.
/// - Must be parseable by `Uri.parse` AND yield a non-empty `host`.
bool isValidRelayUrl(String url) {
  if (url.isEmpty) return false;
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return false;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }
  final Uri uri;
  try {
    uri = Uri.parse(url);
  } catch (_) {
    return false;
  }
  if (uri.host.isEmpty) return false;
  return true;
}

/// Returns the user-facing rejection message for [url]. Returns `null`
/// when the URL is valid. Distinguishes the ws/wss case (specific
/// hint about internal conversion) from generic invalid scheme /
/// malformed input.
String? relayUrlValidationMessage(String url) {
  if (url.isEmpty) return kRelayUrlInvalidGeneric;
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return kRelayUrlInvalidScheme;
  }
  if (isValidRelayUrl(url)) return null;
  return kRelayUrlInvalidGeneric;
}

/// Canonical form for relay COMPARISON (not for dialling).
///
/// Lowercases the host, drops a default port and any trailing slash, so
/// `https://Relay.Example:443/` and `https://relay.example` compare equal.
/// Without this the pairing relay-mismatch guard is a false-positive trap:
/// the QR carries the Pi's configured URL and Preferences may hold the same
/// relay written slightly differently, which would hard-block pairing with a
/// `relay_mismatch` error even though both sides are on the same relay.
///
/// Returns the input unchanged when it cannot be parsed (callers then compare
/// literally, preserving the old behavior for malformed values).
String normalizeRelayUrlForCompare(String url) {
  final trimmed = url.trim();
  final Uri uri;
  try {
    uri = Uri.parse(trimmed);
  } catch (_) {
    return trimmed;
  }
  if (uri.host.isEmpty) return trimmed;
  final scheme = uri.scheme.toLowerCase();
  final host = uri.host.toLowerCase();
  final isDefaultPort = (scheme == 'http' && uri.port == 80) ||
      (scheme == 'https' && uri.port == 443) ||
      (scheme == 'ws' && uri.port == 80) ||
      (scheme == 'wss' && uri.port == 443) ||
      !uri.hasPort;
  final port = isDefaultPort ? '' : ':${uri.port}';
  // Path is kept (a self-hosted relay may mount under a prefix) but a lone
  // trailing "/" is dropped, matching how the two sides are usually written.
  var path = uri.path;
  if (path == '/') path = '';
  return '$scheme://$host$port$path';
}

/// True when [a] and [b] point at the same relay, ignoring cosmetic
/// differences (scheme http↔ws, host case, default port, trailing slash).
bool relayUrlsMatch(String a, String b) =>
    normalizeRelayUrlForCompare(toWsRelayUrl(a)) ==
    normalizeRelayUrlForCompare(toWsRelayUrl(b));
