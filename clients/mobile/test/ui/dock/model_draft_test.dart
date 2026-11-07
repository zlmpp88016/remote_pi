import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/dock/models/model_draft.dart';

/// `buildModelsOps` 是「保存」会不会抹掉数据的分界线。
///
/// 它错一条规则的后果不是报错，而是**静默丢数据**：多发的 op 会改掉用户没碰
/// 的字段，少发的 op 会让改动看起来保存成功了其实没写。所以这里逐条钉死。
void main() {
  Map<String, dynamic> providers() => {
        'my-newapi': {
          'baseUrl': 'http://old/v1',
          'api': 'openai',
          'models': [
            {
              'id': 'm1',
              'name': 'Model One',
              'contextWindow': 1000,
              'maxTokens': 100,
              'reasoning': false,
              'input': ['text'],
              'thinkingLevelMap': {'low': null, 'high': null},
            },
          ],
        },
      };

  test('什么都没改 → 一个 op 都不发', () {
    final p = providers();
    final ops = buildModelsOps(
      providers: p,
      draft: ProviderDraft.seed(p, 'my-newapi'),
      removeKey: false,
      newKey: '',
    );
    expect(ops, isEmpty);
  });

  test('改 baseUrl 只发 baseUrl，不碰 models', () {
    final p = providers();
    final draft = ProviderDraft.seed(p, 'my-newapi').copyWith(baseUrl: 'http://new/v1');
    final ops = buildModelsOps(
      providers: p,
      draft: draft,
      removeKey: false,
      newKey: '',
    );
    expect(ops, hasLength(1));
    expect(ops.single['op'], 'set');
    expect(ops.single['path'], ['providers', 'my-newapi', 'baseUrl']);
    expect(ops.single['value'], 'http://new/v1');
  });

  test('密钥留空不等于清空密钥 —— 三态不能混', () {
    final p = providers();
    final seeded = ProviderDraft.seed(p, 'my-newapi');

    // 留空：不发任何密钥 op。
    final none = buildModelsOps(
      providers: p,
      draft: seeded,
      removeKey: false,
      newKey: '   ',
    );
    expect(none, isEmpty);

    // 填值：set。
    final set = buildModelsOps(
      providers: p,
      draft: seeded,
      removeKey: false,
      newKey: ' sk-new ',
    );
    expect(set.single['op'], 'set');
    expect(set.single['path'], ['providers', 'my-newapi', 'apiKey']);
    expect(set.single['value'], 'sk-new', reason: '两端的空白要剪掉');

    // 标记移除：unset。移除优先于填值 —— 两个同时为真时不该写出一个 key。
    final unset = buildModelsOps(
      providers: p,
      draft: seeded,
      removeKey: true,
      newKey: 'sk-new',
    );
    expect(unset.single['op'], 'unset');
    expect(unset.single['path'], ['providers', 'my-newapi', 'apiKey']);
    expect(unset.single.containsKey('value'), isFalse);
  });

  test('逐字段 set，两条模型互不覆盖没碰的字段', () {
    final p = providers();
    final seeded = ProviderDraft.seed(p, 'my-newapi');
    final draft = seeded.copyWith(rows: [
      seeded.rows.first.copyWith(maxTokens: 999),
    ]);
    final ops = buildModelsOps(
      providers: p,
      draft: draft,
      removeKey: false,
      newKey: '',
    );
    expect(ops, hasLength(1));
    expect(ops.single['path'], ['providers', 'my-newapi', 'models', 'm1', 'maxTokens']);
    expect(ops.single['value'], 999);
  });

  test('删除一条模型 → remove 按 id；新增一条 → insert 带全部字段', () {
    final p = providers();
    final seeded = ProviderDraft.seed(p, 'my-newapi');

    // 删掉唯一一条。
    final removed = buildModelsOps(
      providers: p,
      draft: seeded.copyWith(rows: const []),
      removeKey: false,
      newKey: '',
    );
    expect(removed.single['op'], 'remove');
    expect(removed.single['path'], ['providers', 'my-newapi', 'models', 'm1']);

    // 新增一条。insert 是整体替换，必须带全字段。
    final added = buildModelsOps(
      providers: p,
      draft: seeded.copyWith(rows: [
        ...seeded.rows,
        ModelRow.blank('m2'),
      ]),
      removeKey: false,
      newKey: '',
    );
    expect(added.single['op'], 'insert');
    expect(added.single['path'], ['providers', 'my-newapi', 'models', -1]);
    final value = added.single['value'] as Map<String, dynamic>;
    for (final k in [
      'id', 'name', 'reasoning', 'api', 'thinkingLevelMap',
      'input', 'contextWindow', 'maxTokens',
    ]) {
      expect(value.containsKey(k), isTrue, reason: 'insert 少了 $k 会被主机当成缺字段');
    }
    expect(value['id'], 'm2');
    expect(value['api'], 'openai', reason: '新模型继承 provider 的 api 风格');
  });

  test('空 id 的草稿行不发出去 —— 否则会插入一条没有 id 的模型', () {
    final p = providers();
    final seeded = ProviderDraft.seed(p, 'my-newapi');
    final ops = buildModelsOps(
      providers: p,
      draft: seeded.copyWith(rows: [...seeded.rows, ModelRow.blank()]),
      removeKey: false,
      newKey: '',
    );
    expect(ops, isEmpty);
  });

  test('先删后插：同一个 id 先删再插，结论无歧义', () {
    final p = providers();
    final seeded = ProviderDraft.seed(p, 'my-newapi');
    // 改 id：等于删旧 id + 插新 id。
    final ops = buildModelsOps(
      providers: p,
      draft: seeded.copyWith(rows: [
        seeded.rows.first.copyWith(id: 'renamed'),
      ]),
      removeKey: false,
      newKey: '',
    );
    expect(ops.map((o) => o['op']).toList(), ['remove', 'insert']);
    expect(ops[0]['path'], ['providers', 'my-newapi', 'models', 'm1']);
    expect((ops[1]['value'] as Map)['id'], 'renamed');
  });

  test('seed 对缺失字段给默认值，不猜', () {
    final draft = ProviderDraft.seed(const {}, 'nothing');
    expect(draft.baseUrl, '');
    expect(draft.api, '');
    expect(draft.rows, isEmpty);
  });
}
