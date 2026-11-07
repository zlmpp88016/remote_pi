/// `changes_snapshot` — 工作树状态（plan/77 在 host 侧的对应物）。
///
/// 与 `server/src/protocol/types.ts` 的 `ChangesSnapshotWire` /
/// `ChangesEntryWire` 逐字段对齐。**不要臆造字段名。**
///
/// 三件必须守住的事：
///  - `rel` 是**仓库相对**路径，永远不是绝对路径。主机只发送行之间不同的部分，
///    不发送自己的目录布局 —— 这既是隐私边界，也让 UI 不必裁剪前缀。
///  - `x`/`y` 是 git 的**封闭词表**单字符（`.MADRCU?!`），不是自由文本。
///  - `total` 与 `entries` 相互独立：`entries` 可能在主机上限处被截断，
///    而 `total` 始终是全量计数。用 `total` 显示计数，用 `truncated` 说明截断。
library;

/// 一条变更条目。
class ChangesEntry {
  /// 仓库相对路径，正斜杠。
  final String rel;

  /// `git status --porcelain` 的暂存列（`.MADRCU?!`）。
  final String x;

  /// worktree 列，同一词表。
  final String y;

  /// git 报告了重命名；`rel` 是新名字。
  final bool renamed;

  const ChangesEntry({
    required this.rel,
    required this.x,
    required this.y,
    this.renamed = false,
  });

  factory ChangesEntry.fromJson(Map<String, dynamic> json) => ChangesEntry(
        rel: json['rel'] as String? ?? '',
        x: json['x'] as String? ?? '',
        y: json['y'] as String? ?? '',
        renamed: json['renamed'] as bool? ?? false,
      );

  /// 暂存区有变化。git 用 ` ` 与 `?` 表示「不在索引里」。
  bool get isStaged => x != ' ' && x != '?';

  /// worktree 有变化。
  bool get isUnstaged => y != ' ' && y != '?';

  /// 未跟踪。
  bool get isUntracked => x == '?' && y == '?';

  /// 冲突（`.MADRCU?!` 里的 `U`，以及两侧同时修改的组合）。
  bool get isConflicted => x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
}

/// 全量计数，与 `entries` 是否被截断无关。
class ChangesTotal {
  final int staged;
  final int unstaged;
  final int untracked;
  final int conflicted;

  const ChangesTotal({
    this.staged = 0,
    this.unstaged = 0,
    this.untracked = 0,
    this.conflicted = 0,
  });

  factory ChangesTotal.fromJson(Map<String, dynamic> json) => ChangesTotal(
        staged: (json['staged'] as num?)?.toInt() ?? 0,
        unstaged: (json['unstaged'] as num?)?.toInt() ?? 0,
        untracked: (json['untracked'] as num?)?.toInt() ?? 0,
        conflicted: (json['conflicted'] as num?)?.toInt() ?? 0,
      );

  bool get isEmpty => staged == 0 && unstaged == 0 && untracked == 0 && conflicted == 0;
}

/// HEAD 行：短 sha + 提交标题。未出生的分支上是 null。
class ChangesHead {
  final String sha7;
  final String subject;

  const ChangesHead({required this.sha7, required this.subject});

  factory ChangesHead.fromJson(Map<String, dynamic> json) => ChangesHead(
        sha7: json['sha7'] as String? ?? '',
        subject: json['subject'] as String? ?? '',
      );
}

/// 一次成功的工作树快照。
class ChangesSnapshot {
  /// 短分支名，detached HEAD 时是 null。
  final String? branch;
  final ChangesHead? head;
  final int? ahead;
  final int? behind;
  final List<ChangesEntry> entries;
  final ChangesTotal total;

  /// `entries` 在主机上限处被截断。
  final bool truncated;

  const ChangesSnapshot({
    this.branch,
    this.head,
    this.ahead,
    this.behind,
    this.entries = const [],
    this.total = const ChangesTotal(),
    this.truncated = false,
  });

  factory ChangesSnapshot.fromJson(Map<String, dynamic> json) {
    final rawEntries = json['entries'];
    final entries = <ChangesEntry>[];
    if (rawEntries is List) {
      for (final e in rawEntries) {
        if (e is Map<String, dynamic>) entries.add(ChangesEntry.fromJson(e));
      }
    }
    final rawHead = json['head'];
    return ChangesSnapshot(
      branch: json['branch'] as String?,
      head: rawHead is Map<String, dynamic> ? ChangesHead.fromJson(rawHead) : null,
      ahead: (json['ahead'] as num?)?.toInt(),
      behind: (json['behind'] as num?)?.toInt(),
      entries: entries,
      total: json['total'] is Map<String, dynamic>
          ? ChangesTotal.fromJson(json['total'] as Map<String, dynamic>)
          : const ChangesTotal(),
      truncated: json['truncated'] as bool? ?? false,
    );
  }
}

/// 主机无法给出工作树时的封闭原因词表。
///
/// 每个值都映射到一句固定的中文说明 —— 绝不回显主机散文或异常文本，
/// 那会泄漏绝对路径与内部堆栈。
enum ChangesUnavailable {
  notARepo('not_a_repo'),
  gitMissing('git_missing'),
  timeout('timeout'),
  workspaceMissing('workspace_missing'),
  unreadable('unreadable');

  final String wire;
  const ChangesUnavailable(this.wire);

  static ChangesUnavailable? fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}
