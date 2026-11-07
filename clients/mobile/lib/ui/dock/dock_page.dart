import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/dock/automations/automations_panel.dart';
import 'package:mobile/ui/dock/automations/viewmodels/automations_viewmodel.dart';
import 'package:mobile/ui/dock/changes/changes_panel.dart';
import 'package:mobile/ui/dock/changes/viewmodels/changes_viewmodel.dart';
import 'package:mobile/ui/dock/files/files_panel.dart';
import 'package:mobile/ui/dock/files/viewmodels/files_viewmodel.dart';
import 'package:mobile/ui/dock/models/models_panel.dart';
import 'package:mobile/ui/dock/models/viewmodels/models_viewmodel.dart';
import 'package:mobile/ui/dock/plan/plan_panel.dart';
import 'package:mobile/ui/dock/settings/settings_panel.dart';
import 'package:mobile/ui/dock/settings/viewmodels/settings_viewmodel.dart';
import 'package:mobile/ui/dock/plan/viewmodels/plan_viewmodel.dart';
import 'package:mobile/ui/pi_surface/pi_surface_page.dart';
import 'package:mobile/ui/pi_surface/viewmodels/pi_surface_viewmodel.dart';
import 'package:mobile/data/sessions/session_catalog.dart';
import 'package:provider/provider.dart';

/// 停靠栏的八个面，顺序与 web 的 `TABS` 一致。
///
/// 「会话」不在这里 —— 它已经是独立的底部 tab（现有 home/chat 导航），
/// 在这里再放一次会出现两个入口通向同一个地方。
enum DockFace {
  plan(DockTab.plan, LucideIcons.fileText),
  files(DockTab.files, LucideIcons.folder),
  changes(DockTab.changes, LucideIcons.gitCompare),
  plugins(DockTab.plugins, LucideIcons.package),
  automations(DockTab.automations, LucideIcons.clock),
  models(DockTab.models, LucideIcons.cpu),
  settings(DockTab.settings, LucideIcons.settings);

  final String label;
  final IconData icon;
  const DockFace(this.label, this.icon);
}

/// 停靠栏 —— 把一个工作区的 7 个工具面收在一处。
///
/// iPhone 上没有并排三栏的空间，所以用顶部横向 tab；iPad 宽屏下同一组 tab
/// 也是可接受的形态，先按一套实现，等真有 iPad 布局需求再分叉。
///
/// **每个面的 viewmodel 都在被首次打开时创建并立即发起自己的请求** ——
/// 这是 web 端那次事故的教训：`handleDockTabChange` 从未被调用，于是 5 个
/// 面板从空缓存渲染、看起来像坏了。这里用 `IndexedStack` + 懒创建保证
/// 「切到该面」与「该面开始加载」是同一件事。
class DockPage extends StatefulWidget {
  const DockPage({
    super.key,
    required this.catalog,
    required this.root,
    this.daemonId = '',
    this.device,
    this.initialFace = DockFace.plan,
    this.workspaceLive = true,
    this.modelsSupported = true,
    this.settingsSupported = true,
  });

  final SessionCatalog catalog;

  /// 工作区根路径。计划/文件/更改三个面都需要它。
  final String root;
  final String daemonId;
  final String? device;
  final DockFace initialFace;

  /// 该工作区的 Pi 是否在运行。
  ///
  /// 为 false 时，需要读工作树的三个面（计划/文件/更改）**不发请求**，改成
  /// 把原因写在面板里。对齐 web 的 `changesDisabledReason`：一个禁用控件配上
  /// 解释，比一个点了才报错的控件诚实。
  final bool workspaceLive;

  /// 主机是否声明了 `models_config` / `settings` 能力。
  ///
  /// 未声明时对应面板**不建 viewmodel**，直接说明原因 —— 对齐 web 的
  /// `modelsAvailable` / `settingsAvailable`：一个提前禁用并解释的控件，
  /// 比一个点了才被拒的控件诚实。
  final bool modelsSupported;
  final bool settingsSupported;

  @override
  State<DockPage> createState() => _DockPageState();
}

class _DockPageState extends State<DockPage> with SingleTickerProviderStateMixin {
  late DockFace _face = widget.initialFace;
  late final TabController _tabs = TabController(
    length: DockFace.values.length,
    initialIndex: DockFace.values.indexOf(widget.initialFace),
    vsync: this,
  );

  /// Faces the user has opened at least once. A face is built on first visit
  /// and kept alive afterwards — never built speculatively, because a face
  /// issues its request in the viewmodel constructor.
  late final _opened = <DockFace>{widget.initialFace};

  @override
  void initState() {
    super.initState();
    // 用 controller 的 listener 而不是 TabBar.onTap：滑动切换（iPad 上会用到）
    // 只有 listener 能看到，而 onTap 看不到。
    _tabs.addListener(() {
      final next = DockFace.values[_tabs.index];
      if (next == _face) return;
      setState(() {
        _face = next;
        _opened.add(next);
      });
    });
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.bg,
      appBar: AppBar(
        backgroundColor: colors.bg,
        title: Text(_face.label),
        bottom: TabBar(
          controller: _tabs,
          // Seven tabs at their intrinsic width overflow a 1080 px phone by
          // about 26 px, so the bar used to be scrollable. That made selecting a
          // right-hand tab scroll the leftmost one past the edge, clipping
          // "计划" down to "划" — the label still read as a different word.
          // Dividing the full width instead keeps all seven labels intact.
          isScrollable: false,
          tabs: [
            for (final f in DockFace.values)
              Tab(
                // Seven equal-width tabs leave ~154 px each on a 1080 px
                // phone. At the theme default the three-character labels
                // (自动化) did not fit and were clipped mid-word, so the
                // tab label is sized down and tightened rather than left to
                // ellipsis.
                height: 56,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(f.icon, size: 15),
                    const SizedBox(height: 2),
                    // FittedBox, not an ellipsis: "自动化" is three characters
                    // and the tab gives it less width than the other labels, so it
                    // was clipped to "自动". Scaling to fit keeps every label
                    // whole and legible at this size.
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        f.label,
                        maxLines: 1,
                        softWrap: false,
                        style: const TextStyle(fontSize: 11, height: 1.1),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
      // IndexedStack keeps every OPENED face alive: switching tabs must not
      // dispose a viewmodel and re-run its request. The changes face shells out
      // to `git status` on the host — re-running it on every tab tap would be a
      // silent IO storm, and a cache would be worse (it would show a state the
      // worktree no longer has). Keeping the widget alive makes the data as
      // fresh as the last explicit reload, which is the honest contract.
      body: IndexedStack(
        index: _face.index,
        children: [
          for (final f in DockFace.values)
            // Build lazily: a face the user never opened must not fire a
            // request. Once built it stays, hence the _opened set.
            if (_opened.contains(f))
              _Face(face: f, host: widget)
            else
              const SizedBox.shrink(),
        ],
      ),
    );
  }
}

/// 当前面的内容。只有当前面在树上 —— 切走再切回会重建，
/// 重建即重新加载，保证看到的永远是主机的当前状态而不是几轮之前的缓存。
/// 只有需要读主机工作树的三个面才受「工作区未运行」影响。
///
/// 插件/自动化/模型/设置读的是主机自己的文件与调度表，不依赖某个工作区的 Pi
/// 在不在跑，所以它们照常工作。
bool _needsLiveWorkspace(DockFace face) => switch (face) {
  DockFace.plan || DockFace.files || DockFace.changes => true,
  DockFace.plugins ||
  DockFace.automations ||
  DockFace.models ||
  DockFace.settings => false,
};

/// 工作区未运行时的占位。**不是空白面板** —— 空白无法解释自己。
class _NotLive extends StatelessWidget {
  const _NotLive({required this.face});

  final DockFace face;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Text(
          WorkspaceReason.dockNeedsLive,
          textAlign: TextAlign.center,
          style: TextStyle(color: colors.muted2, fontSize: 14, height: 1.5),
        ),
      ),
    );
  }
}

class _Face extends StatelessWidget {
  const _Face({required this.face, required this.host});

  final DockFace face;
  final DockPage host;

  @override
  Widget build(BuildContext context) {
    // 工作区没跑时，需要读工作树的三个面直接说原因，**不建 viewmodel**：
    // 不存在的 viewmodel 不可能发请求，这比建一个「知道自己不该跑」的对象
    // 更简单。对齐 web 的 `changesDisabledReason` 行为。
    if (!host.workspaceLive && _needsLiveWorkspace(face)) {
      return _NotLive(face: face);
    }
    return switch (face) {
      DockFace.plan => ChangeNotifierProvider(
          create: (_) => PlanViewModel(host.catalog, root: host.root),
          child: const PlanPanel(),
        ),
      DockFace.files => ChangeNotifierProvider(
          create: (_) => FilesViewModel(host.catalog),
          child: const FilesPanel(),
        ),
      DockFace.changes => ChangeNotifierProvider(
          create: (_) => ChangesViewModel(
            host.catalog,
            root: host.root,
            daemonId: host.daemonId,
          ),
          child: const ChangesPanel(),
        ),
      DockFace.plugins => ChangeNotifierProvider(
          create: (_) => PiSurfaceViewModel(host.catalog),
          child: PiSurfacePage(device: host.device),
        ),
      DockFace.automations => ChangeNotifierProvider(
          create: (_) => AutomationsViewModel(host.catalog),
          child: const AutomationsPanel(),
        ),
      DockFace.models => ChangeNotifierProvider(
          create: (_) => ModelsViewModel(host.catalog, supported: host.modelsSupported),
          child: const ModelsPanel(),
        ),
      DockFace.settings => ChangeNotifierProvider(
          create: (_) => SettingsViewModel(host.catalog, supported: host.settingsSupported),
          child: const SettingsPanel(),
        ),
    };
  }
}
