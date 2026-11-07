/// Models 面板的**编辑模型**。
///
/// 协议层（`protocol/models.dart`）刻意不为配置树建模 —— 键的形状由 pi 自己
/// 的 `models.json` 决定。但面板要编辑它，就需要一层可变的表单投影，否则每个
/// 输入框都得自己从 `Map<String, dynamic>` 里挖值。这个文件就是那层投影，
/// 它只负责「读出来」和「diff 回去」，不改变协议的形状。
///
/// **这一层永不持有密钥。** `apiKey` 不在 [ProviderDraft] 里，也没有任何字段
/// 能装它 —— 表单连一个空格都不留。密钥是独立的 write-only 动作：要么标记
/// 移除（`unset`），要么在输入框里填一个新值（`set`），由 [buildModelsOps]
/// 单独处理。这样「保存时把内存里那份（密钥已被删除的）配置写回去」在结构上
/// 就不可能发生。
library;

/// 思考级别，顺序与 pi 的 `thinkingLevelMap` 一致。
const List<String> thinkingLevels = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/// 一个 provider 里的一条模型，投影成表单能编辑的形状。
class ModelRow {
  final String id;
  final String name;
  final int contextWindow;
  final int maxTokens;
  final bool reasoning;

  /// 输入能力，通常是 `['text']` 或 `['text', 'image']`。
  final List<String> input;

  /// 级别 → 该级别映射到的实际模型名（或 null 表示未映射）。
  final Map<String, String?> thinkingLevelMap;

  const ModelRow({
    required this.id,
    required this.name,
    required this.contextWindow,
    required this.maxTokens,
    required this.reasoning,
    required this.input,
    required this.thinkingLevelMap,
  });

  /// 新建一行时的默认值。与 web 的 `toRow` 默认一致，这样两端新增的模型
  /// 形状相同。
  factory ModelRow.blank([String id = '']) => ModelRow(
        id: id,
        name: id,
        contextWindow: 128000,
        maxTokens: 16384,
        reasoning: false,
        input: const ['text'],
        thinkingLevelMap: {for (final l in thinkingLevels) l: null},
      );

  /// 从配置树里读出。缺失字段用与 web 相同的默认值 —— 两端读同一个文件，
  /// 默认值不同会让「没填过的字段」在两端显示成不同的数。
  factory ModelRow.fromJson(Map<String, dynamic> m) {
    final tlm = m['thinkingLevelMap'];
    final map = <String, String?>{};
    for (final level in thinkingLevels) {
      final v = tlm is Map ? tlm[level] : null;
      map[level] = v is String ? v : null;
    }
    final rawInput = m['input'];
    final input = rawInput is List
        ? rawInput.whereType<String>().toList()
        : <String>['text'];
    return ModelRow(
      id: m['id'] as String? ?? '',
      name: m['name'] as String? ?? m['id'] as String? ?? '',
      contextWindow: (m['contextWindow'] as num?)?.toInt() ?? 128000,
      maxTokens: (m['maxTokens'] as num?)?.toInt() ?? 16384,
      reasoning: m['reasoning'] == true,
      input: input.isEmpty ? const ['text'] : input,
      thinkingLevelMap: map,
    );
  }

  /// 插入一条新模型时的完整值。**必须带全部字段** —— `insert` 是整体替换一个
  /// 元素，少写的字段不会从旧值继承。
  Map<String, dynamic> toInsertJson(String api) => {
        'id': id,
        'name': name,
        'reasoning': reasoning,
        'api': api,
        'thinkingLevelMap': thinkingLevelMap,
        'input': input,
        'contextWindow': contextWindow,
        'maxTokens': maxTokens,
      };

  ModelRow copyWith({
    String? id,
    String? name,
    int? contextWindow,
    int? maxTokens,
    bool? reasoning,
    List<String>? input,
  }) =>
      ModelRow(
        id: id ?? this.id,
        name: name ?? this.name,
        contextWindow: contextWindow ?? this.contextWindow,
        maxTokens: maxTokens ?? this.maxTokens,
        reasoning: reasoning ?? this.reasoning,
        input: input ?? this.input,
        thinkingLevelMap: thinkingLevelMap,
      );
}

/// 一个 provider 的表单草稿。
class ProviderDraft {
  final String providerId;
  final String baseUrl;
  final String api;
  final List<ModelRow> rows;

  const ProviderDraft({
    required this.providerId,
    required this.baseUrl,
    required this.api,
    required this.rows,
  });

  ProviderDraft copyWith({String? baseUrl, String? api, List<ModelRow>? rows}) =>
      ProviderDraft(
        providerId: providerId,
        baseUrl: baseUrl ?? this.baseUrl,
        api: api ?? this.api,
        rows: rows ?? this.rows,
      );

  /// 从配置树里投影出某个 provider 的草稿。
  ///
  /// 与 web 的 `providerField` / `modelsOf` 同构：字段缺失时给空串/空列表，
  /// 而不是猜一个值。
  static ProviderDraft seed(
    Map<String, dynamic> providers,
    String providerId,
  ) {
    final raw = providers[providerId];
    final p = raw is Map<String, dynamic> ? raw : const <String, dynamic>{};
    final rawModels = p['models'];
    final rows = rawModels is List
        ? rawModels
            .whereType<Map<String, dynamic>>()
            .map(ModelRow.fromJson)
            .toList()
        : <ModelRow>[];
    return ProviderDraft(
      providerId: providerId,
      baseUrl: p['baseUrl'] as String? ?? '',
      api: p['api'] as String? ?? '',
      rows: rows,
    );
  }
}

/// 生成 diff。
///
/// 三条规则，全部来自 web 那份 `buildOps`，因为错一条就会丢数据：
///
///  1. **未改动的字段不产生 op。** 这是「保存」不会顺手抹掉别的东西的唯一原因。
///  2. **先删后插。** 同一个 id 先删再插，结论无歧义；反过来则取决于主机的
///     应用顺序。
///  3. **逐字段 set，绝不整对象 set。** 两条模型互不覆盖对方没碰的字段。
///
/// 密钥是三态，永不混淆：标记移除 → `unset`；填了新值 → `set`；否则**什么都
/// 不发**。留空绝不等于「清空密钥」。
List<Map<String, dynamic>> buildModelsOps({
  required Map<String, dynamic> providers,
  required ProviderDraft draft,
  required bool removeKey,
  required String newKey,
}) {
  final seeded = ProviderDraft.seed(providers, draft.providerId);
  final ops = <Map<String, dynamic>>[];
  final base = <Object>['providers', draft.providerId];

  if (draft.baseUrl != seeded.baseUrl) {
    ops.add({'op': 'set', 'path': [...base, 'baseUrl'], 'value': draft.baseUrl});
  }
  if (draft.api != seeded.api) {
    ops.add({'op': 'set', 'path': [...base, 'api'], 'value': draft.api});
  }

  // 密钥三态。
  if (removeKey) {
    ops.add({'op': 'unset', 'path': [...base, 'apiKey']});
  } else if (newKey.trim().isNotEmpty) {
    ops.add({'op': 'set', 'path': [...base, 'apiKey'], 'value': newKey.trim()});
  }

  final originalById = {for (final r in seeded.rows) r.id: r};

  // 先删：按 id 删，这样后面插入同一个 id 不会有歧义。
  for (final o in seeded.rows) {
    if (!draft.rows.any((r) => r.id == o.id)) {
      ops.add({'op': 'remove', 'path': [...base, 'models', o.id]});
    }
  }

  for (final row in draft.rows) {
    final prev = originalById[row.id];
    if (prev == null) {
      if (row.id.isEmpty) continue; // 空 id 的草稿行不发出去
      ops.add({
        'op': 'insert',
        'path': [...base, 'models', -1],
        'value': row.toInsertJson(draft.api),
      });
      continue;
    }
    if (row.name != prev.name) {
      ops.add({'op': 'set', 'path': [...base, 'models', row.id, 'name'], 'value': row.name});
    }
    if (row.contextWindow != prev.contextWindow) {
      ops.add({
        'op': 'set',
        'path': [...base, 'models', row.id, 'contextWindow'],
        'value': row.contextWindow,
      });
    }
    if (row.maxTokens != prev.maxTokens) {
      ops.add({
        'op': 'set',
        'path': [...base, 'models', row.id, 'maxTokens'],
        'value': row.maxTokens,
      });
    }
    if (row.reasoning != prev.reasoning) {
      ops.add({'op': 'set', 'path': [...base, 'models', row.id, 'reasoning'], 'value': row.reasoning});
    }
    if (row.input.join(',') != prev.input.join(',')) {
      ops.add({'op': 'set', 'path': [...base, 'models', row.id, 'input'], 'value': row.input});
    }
    for (final level in thinkingLevels) {
      if (row.thinkingLevelMap[level] != prev.thinkingLevelMap[level]) {
        ops.add({
          'op': 'set',
          'path': [...base, 'models', row.id, 'thinkingLevelMap', level],
          'value': row.thinkingLevelMap[level],
        });
      }
    }
  }

  return ops;
}
