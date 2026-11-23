// Optional scalar-only stage clock. Disabled in normal bootstrap; no identifiers,
// request bodies, text or URIs. All timestamps share Timeline.now's VM clock.
import 'dart:async';
import 'dart:developer' as developer;

class HistoryStageMetrics {
  static bool enabled = false;
  static final _zoneKey = Object();
  static final samples = <HistoryStageSpan>[];
  static int dropped = 0;
  static HistoryStageSpan? get current =>
      Zone.current[_zoneKey] as HistoryStageSpan?;
  static int? get intentNow => enabled ? developer.Timeline.now : null;
  static HistoryStageSpan? begin(
    String path, {
    bool cache = false,
    int? intentUs,
  }) {
    if (!enabled) return null;
    if (samples.length == 256) {
      samples.removeAt(0);
      dropped++;
    }
    final span = HistoryStageSpan(
      samples.length + dropped,
      path,
      cache,
      intentUs,
    );
    samples.add(span);
    return span;
  }

  static Future<T> request<T>(
    HistoryStageSpan? span,
    Future<T> Function() work,
  ) {
    if (span == null) return work();
    span.mark('request_us');
    return runZoned(work, zoneValues: {_zoneKey: span});
  }

  static Map<String, Object> export() => {
    'clock': 'vm_monotonic_microseconds',
    'dropped': dropped,
    'samples': samples.map((s) => s.toJson()).toList(),
    'full_page_definition':
        'requested page state applied plus current viewport raster; excludes offscreen lazy rows, older pages and deferred bodies',
    'typed_reply_definition':
        'typed protocol message received; transport decrypt/JSON decode precede this boundary',
    'legacy_decode_apply_ms':
        'unchanged request-through-state-apply aggregate; overlaps queue_ms and wire_ms',
  };
}

class HistoryStageSpan {
  HistoryStageSpan(this.id, this.path, this.cache, int? intentUs) {
    mark('intent_us', intentUs);
  }
  final int id;
  final String path;
  final bool cache;
  final fields = <String, int>{};
  bool failed = false;
  bool viewportQueued = false;
  void mark(String field, [int? value]) {
    fields.putIfAbsent(field, () => value ?? developer.Timeline.now);
    developer.Timeline.instantSync(
      'p87_stage_$field',
      arguments: {'id': id, 'path': path},
    );
  }

  void applied(int items) {
    mark('state_apply_us');
    fields['items'] = items;
  }

  Map<String, Object> toJson() => {
    'id': id,
    'path': path,
    'cache_hit': cache,
    'failed': failed,
    ...fields,
  };
}
