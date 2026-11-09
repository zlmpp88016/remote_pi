/// 全部用户可见文案的单一来源。
///
/// 与 web 端 `clients/web/src/client/notices.ts` 逐条对应，术语表在
/// `clients/web/BUTTON-AUDIT.md` §14 里经两名独立译者交叉评分后仲裁锁定。
///
/// 规则：
///  - 这里只放**用户可见**的固定中文文案。
///  - 协议字面量（`delivered`、`woke_and_delivered`、action 名）、`data-*`、
///    变量名、类名一律保持英文 —— 翻译比较操作数会静默破坏逻辑。
///  - 不在 widget 里散落字符串字面量。
library;

/// 术语表。新文案必须从这里取词，不要另造同义词。
abstract final class Term {
  static const host = '主机';
  static const workspace = '工作区';
  static const session = '会话';
  /// 不是「该轮次」—— 那是会议纪要中文，在对话界面里读着生硬。
  static const turn = '这轮对话';
  static const relay = '中继';
  static const pairingCode = '配对码';
  static const daemon = '守护进程';
  static const skill = '技能';
  static const thinkingLevel = '思考级别';
  static const workingTree = '工作树';
  static const automation = '自动化';
  static const plugin = '插件';
  static const model = '模型';
  static const provider = '提供方';
  static const appearance = '外观';
  static const behaviour = '行为';
}

/// 8 个停靠栏标签，顺序与 web 的 `TABS` 一致。
abstract final class DockTab {
  static const sessions = '会话';
  static const plan = '计划';
  static const files = '文件';
  static const changes = '更改';
  static const plugins = '插件';
  static const automations = '自动化';
  static const models = '模型';
  static const settings = '设置';
}

/// 通用状态。
abstract final class Common {
  static const loading = '加载中';
  static const reload = '重新加载';
  static const save = '保存';
  static const saving = '正在保存…';
  static const retry = '重试';
  static const cancel = '取消';
  static const close = '关闭';
  static const back = '返回';
  static const delete = '删除';
  static const create = '创建';
  static const creating = '正在创建…';
  static const filter = '筛选';
  static const unavailable = '不可用';
  static const notReady = '未就绪';
  static const somethingFailed = '出错了';
  static const noChangesToSave = '没有需要保存的更改';
  static const talkingToHost = '正在与主机通信…';
}

/// 更改面板。对应 web 的 `changes-panel.tsx`。
abstract final class ChangesCopy {
  static const title = '更改';
  static const reading = '正在读取工作树…';
  static const noChanges = '没有更改';
  static const reload = '重新加载工作树';
  static const reloadTitle = '重新读取工作树（git status）。';
  static const unavailable = '更改不可用';
  static const notReadable = '工作树无法读取';
  static const notReadableDetail = '无法读取该工作区的工作树。';
  static const notRunning = '该工作区未运行，无法读取其工作树。';
  static const notARepo = '该工作区不是 Git 仓库，没有工作树更改可显示。';
  static const noGit = '该主机未安装 git，因此无法报告工作树更改。';
  static const timedOut = '读取工作树超时。请重试，或检查仓库大小。';
  static const staged = '已暂存';
  static const unstaged = '已修改';
  static const untracked = '未跟踪';
  static const conflicted = '有冲突';
  static const branch = '分支';
  static const head = 'HEAD';
  static const untrackedCollapsed = '未跟踪的文件夹已折叠显示；在终端中打开可查看其文件。';
}

/// 计划面板。对应 web 的 `plan-panel.tsx`。
abstract final class PlanCopy {
  static const title = '计划';
  static const filterHint = '筛选计划文档';
  static const clearFilter = '清除筛选';
  static const backToList = '返回计划列表';
  static const reading = '正在读取文档…';
  static const noDocuments = '未找到计划文档';
  static const noDirectory = '该工作区没有 plan/ 目录，所以还没有计划文档。';
  static const couldNotRead = '无法读取该文档。';
  static const refused =
      '主机拒绝读取该文件。只有 plan/、.workflow/ 或 docs/ 下的文档可读。';
  static const truncated = '文档超过读取上限，仅显示开头部分。';
  static const intro =
      '打开该工作区 plan/ 目录中的计划文档。由主机读取，客户端负责渲染 Markdown。';
}

/// 文件面板。对应 web 的 `right-rail.tsx` 里的 files 分支。
abstract final class FilesCopy {
  static const title = '文件';
  static const pathHint = '~/projects';
  static const list = '列出';
  static const showHidden = '显示隐藏项';
  static const showHiddenTitle = '让主机在列表中包含点文件和隐藏项。';
  static const upOneLevel = '上一级';
  static const rootLabel = '根目录';
  static const listing = '正在列出…';
  static const listFailed = '文件系统列表失败';
  static const emptyDir = '该目录为空。';
  static const nothingListed = '尚未列出任何内容。';
  static const emptyHint =
      '在上方输入路径（如 ~/projects）后点「列出」。目录可以打开，也可以作为 Pi 工作区启动。';
  static const addToCatalog = '加入目录';
  static const startHere = '在此启动 Pi';
  static const removeFromCatalog = '移除';

  // ── 目录行内的两个工作区动作（对应 web 的 entryAdd / entryStart） ──
  static const addToCatalogTitle = '把这个目录登记为工作区，但不启动它的 Pi。';
  static const startHereTitle = '在这个目录里启动 Pi。';
  static const removeFromCatalogTitle = '把这个目录从主机目录中移除。';
}

/// 自动化面板。对应 web 的 `automations-panel.tsx`。
abstract final class AutomationsCopy {
  static const title = '自动化';
  static const loading = '正在读取定时任务…';
  static const none = '还没有任何自动化';
  static const noneHint = '创建一条定时任务，让 Pi 按计划自动工作。';
  static const create = '新建自动化';
  static const nextRun = '下次';
  static const lastRun = '上次';
  static const neverRun = '从未运行';
  static const inheritModel = '继承工作区当前模型';
  static const freshSession = '每次触发开新会话';
  static const enabled = '已启用';
  static const disabled = '已禁用';
  static const enable = '启用';
  static const disable = '禁用';
  static const runNow = '立即运行';
  static const promptHint = '要 Pi 做的事';
  static const scheduleHint = 'cron 表达式，如 0 9 * * *';
  static const deleteConfirmTitle = '删除这条自动化？';
  static const deleteConfirmBody = '删除后它不会再触发。历史记录保留。';

  // ── 创建表单的完整字段 ────────────────────────────────────────
  static const preset = '预设计划';
  static const presetCustom = '自定义';
  static const presetHourly = '每小时';
  static const presetDaily9 = '每天 9:00';
  static const presetWeekdays9 = '工作日 9:00';
  static const presetWeeklyMon = '每周一 9:00';
  static const cron = 'cron 表达式';
  static const prompt = '提示词';
  static const tz = '时区';
  static const tzHint = '留空则用主机时区';
  static const target = '目标工作区';
  static const targetHint = '这条任务在哪个工作区跑';
  static const model = '模型';
  static const sessionMode = '会话模式';
  static const sessionFresh = '每次开新会话';
  static const sessionLive = '追加到当前会话';
  static const skipIfBusy = '代理忙时跳过';
  static const wake = '工作区停止时唤醒';
  static const catchup = '错过后补跑';

  // ── 详情视图 ────────────────────────────────────────────────
  static const detail = '任务详情';
  static const detailCron = 'cron';
  static const detailTarget = '目标工作区';
  static const detailTz = '时区';
  static const detailModel = '模型';
  static const detailNext = '下次运行';
  static const detailLast = '上次运行';
  static const detailLastStatus = '上次结果';
  static const detailCreated = '创建于';
  static const back = '返回';
}

/// 设置面板。对应 web 的 `settings-panel.tsx`。
abstract final class SettingsCopy {
  static const title = '设置';
  static const loading = '正在读取主机设置…';
  static const appearance = '外观';
  static const behaviour = '行为';
  static const theme = '主题';
  static const themeReadOnly = '由 pi 自己决定，这里只显示，不修改。';
  static const notSet = '未设置';
  static const hideThinking = '隐藏思考块';
  static const retryEnabled = '失败自动重试';
  static const retryMaxRetries = '最大重试次数';
  static const retryBaseDelay = '基础退避延时（毫秒）';
  static const retryProviderMaxDelay = '提供方最大重试延时（毫秒）';
  static const saving = '保存中…';
  static const saved = '已保存。';
  static const readOnly = '该文件当前不可写，界面为只读。';
  static const notFound = '主机上没有 settings.json。';
  static const corrupted = 'settings.json 无法解析，请先在主机上修复。';
  static const permission = '没有写入权限。';
  static const conflict = '文件在你读取之后被改过，请重新加载再保存。';
  static const invalidField = '该主机不支持修改这个字段。';
  static const verifyFailed = '写入后校验失败，文件未被改动。';
}

/// 模型面板。对应 web 的 `model-providers-panel.tsx`。
abstract final class ModelsCopy {
  static const title = '模型';
  static const loading = '正在读取模型配置…';
  static const providers = '提供方';
  static const noProviders = '还没有配置任何提供方';
  static const keyConfigured = '已配置密钥';
  static const keyMissing = '未设置密钥';
  static const keyHint = '密钥只能在主机上修改；这里只显示是否存在。';
  static const modeUnsafe = '该文件权限过宽，明文密钥可被其他用户读取。';
  static const readOnly = '该文件当前不可写，界面为只读。';
  static const notFound = '主机上没有 models.json。';
  static const corrupted = 'models.json 无法解析，请先在主机上修复。';
  static const permission = '没有写入权限。';
  static const conflict = '文件在你读取之后被改过，请重新加载再保存。';
  static const verifyFailed = '写入后校验失败，文件未被改动。';
  static const unsupported = '该主机不支持这项修改。';

  // ── 编辑 ────────────────────────────────────────────────────────────
  static const baseUrl = '基础 URL';
  static const apiStyle = 'API 风格';
  static const apiKey = 'API 密钥';
  static const apiKeyEmpty = '留空表示不修改';
  static const keySet = '已设置';
  static const keyRemove = '移除密钥';
  static const keyKeep = '保留密钥';
  static const keyRemovePending = '保存后会移除该密钥。';
  static const models = '模型';
  static const addModel = '添加模型';
  static const removeModel = '移除';
  static const modelId = '模型 ID';
  static const modelName = '显示名';
  static const contextWindow = '上下文窗口';
  static const maxTokens = '最大输出 token';
  static const reasoning = '支持推理';
  static const save = '保存';
  static const saving = '正在保存…';
  static const saved = '已保存';
  static const pendingChanges = '处待保存改动';
  static const nothingToSave = '没有改动';
}

/// 本机设置页（App 自身偏好，不是主机设置）。
abstract final class AppSettingsCopy {
  static const title = '设置';
  static const pairings = '配对';
  static const addPairing = '添加配对';
  static const textSize = '文字大小';
  static const hideToolCalls = '在对话中隐藏工具调用';
  static const hideToolCallsDetail = '只显示你的消息与助手的回复。';
  static const noPairings = '还没有配对';
  static const noPairingsHint = '点 + 配对一台新的主机。';

  // 中继归属每个配对自身，不是 App 的全局设置。#34 删掉可编辑的全局输入框后，
  // 这里只剩「新增配对时的预填地址」以及每个配对各自的（只读）地址。
  static const defaultRelay = '新配对默认中继';
  static const defaultRelayDetail =
      '只用于新增配对时预填地址。已有配对各自记住自己的中继，改这里不会影响它们。';
  static const defaultRelayReset = '恢复默认';
  static const relayOfPairing = '中继';
  static const relayNotRecorded = '未记录（该配对建立时未保存地址）';
}

/// 会话列表主页（App 的第一个界面）。
abstract final class HomeCopy {
  static const appName = 'Remote Pi';
  static const openAnotherFolder = '打开另一个目录';
  static const workspacesHint = '列出这台机器上登记的工作目录';
  static const renameSession = '重命名会话';
  static const deleteSession = '删除会话（仅本机）';
  static const deleteOnlyOffline = '仅当该会话离线时可用';
  static const deleteTitle = '删除会话？';
  static const deleteBody = '仅从本机移除。若该会话在 Pi 上重新上线，它会再次出现在列表里。';
  static const nothingHere = '这里还没有内容…';
  static const nothingHint = '当已配对的 Pi 打开一个会话，它会出现在这里。';
  static const noPairings = '还没有配对';
  /// 不写「Mac」：Android 用户看到 Mac 会以为配错了平台。主机才重要，不是它的品牌。
  static const noPairingsHint = '扫描主机上显示的二维码即可开始。';
  static const connected = '已连接';
  static const awaitingPairing = '等待配对';
}

/// 插件面（技能 + 软件包）。对应 web 的 `plugins-panel.tsx`。
abstract final class PluginsCopy {
  static const title = '插件';
  static const subtitle = '这台机器上的技能与插件';
  static const noSkills = '这台 Pi 上还没有安装技能。';
  static const packages = '软件包';
  static const updateAll = '全部更新';
  static const noPackages = '这台 Pi 上还没有安装软件包。';
  static const install = '安装软件包';
  static const confirmThirdPartyTitle = '安装第三方代码？';
  static const removeTitle = '移除软件包？';
  static const remove = '移除';
  static const refresh = '刷新';
  static const run = '运行';
  static const update = '更新';
  static const running = '运行中';
  static const notRunning = '未运行';
  static const argumentsOptional = '参数（可选）';
  static const noResources = '尚未解析到资源';
  static const scopeUser = '当前用户';
  static const scopeProject = '当前项目';
  static const continueLabel = '继续';
}

/// 对话界面。
abstract final class ChatCopy {
  static const sessionTree = '会话树';
  static const sessionInfo = '会话信息';
  static const noActiveDevice = '没有活动设备';
  static const connecting = '连接中…';
  static const nothingHere = '这里还没有内容';
  static const cameraOff = '相机权限已关闭 —— 请到系统设置里开启后再附照片。';
  static const micOff = '麦克风权限已关闭 —— 请到系统设置里开启后再口述。';
  static const holdToTalk = '按住说话';
  static const loadEarlier = '加载更早的消息';
  static const pairingRevoked = '配对已被主机撤销 —— 请重新配对以继续';
  static const openDock = '打开工具面板';
  static const dockNeedsWorkspace = '该会话尚未关联工作区目录，工具面板暂时不可用。';
}

/// 工作区浏览与列表。
abstract final class WorkspacesCopy {
  static const chooseFolder = '选择目录';
  static const showHidden = '显示隐藏文件';
  static const typeAbsolutePath = '输入绝对路径';
  static const noSubFolders = '这里没有子目录';
  static const useThisFolder = '使用这个目录';
  static const startHereTitle = '在这里启动 Pi？';
  static const listTitle = '工作区';
  static const piSurface = 'Pi 技能与软件包';
  static const none = '还没有工作区';
  static const noneHint = '浏览这台机器上的目录来选一个。';
  static const browseFolders = '浏览机器上的目录';
  static const removeFromList = '从列表中移除';
  static const exitedNoDetail = 'Pi 进程已退出，没有报告错误详情。';
  static const restarting = '正在重启…';
  static const restart = '重启';
  static const start = '启动';
}

/// 对话框与树形面板。
abstract final class PanelsCopy {
  static const quickActions = '快捷操作';
  static const compactContext = '压缩上下文';
  static const compactSubtitle = '总结旧的对话以腾出空间。';
  static const newSession = '新建会话';
  static const newSessionSubtitle = '清空 Pi 上的这段对话。';
  static const startNewTitle = '开始新会话？';
  static const startNewBody = '这会清空 Pi 侧的对话历史。当前这段不会保留。';
  static const startNew = '开始';
  static const switching = '正在切换…';
  static const chooseModel = '选择模型';
  static const thinking = '思考';
  static const emptyTree = '空树';
  static const agentBusy = '代理正在工作 —— 分支已暂停。';
  static const agentBusyRetry = '代理正在工作 —— 等它完成后再试。';
  static const treeChanged = '树已变化 —— 请刷新后重试。';
  static const entryGone = '该条目已不存在。';
  static const notForkable = '该条目无法分支。';
  static const forkFromHere = '从这里分支';
  static const offline = '离线…';
  static const steerCurrent = '引导当前回复…';
  static const addCaption = '添加说明…';
  static const sendMessage = '发送消息…';
  static const queuedEditable = '已排队。点按可编辑。';
  static const queuedFollowUp = '已排队的后续消息。';
}

/// 首次使用引导。
abstract final class OnboardingCopy {
  static const connectDevice = '连接你的设备';
  static const runOnComputer = '在电脑上（macOS、Linux 或 Windows）打开 Pi 并运行：';
  static const copyCode = '复制它打印出的配对码：';
  static const pairLater = '稍后配对';
  static const pasteCode = '粘贴配对码';
  static const pairing = '正在配对…';
  static const tryAgain = '再试一次';
  static const chooseRelay = '选择中继';
  static const relayWhy = '应用与你的电脑在这里相会。';
  static const selfHosted = '自托管。隐私最好。';
  static const communityRelay = '社区中继';
  static const communityDesc = '由我们托管。开箱即用。';
  static const useOwnServer = '使用我自己的服务器';
  static const welcomeTitle = 'Remote Pi';
  static const welcomeTagline = '随时随地控制你的 Pi 代理';
  static const getStarted = '开始使用';
}

/// 工作区行的生命周期状态。对应 web 的 `view-model.ts`。
abstract final class WorkspaceStatus {
  static const running = '运行中';
  static const starting = '启动中';
  static const crashed = '已崩溃';
  static const stopped = '已停止';
  static const notRunning = '未运行';
}

/// 停机原因（工具提示里用的说明句）。
///
/// `The host did not X` 类句子保留「主机」作主语 —— 删掉它会销毁远程工具
/// 唯一必须传达的诊断事实：失败发生在**哪里**。
abstract final class WorkspaceReason {
  static const busy = '另一个工作区操作仍在进行。';
  static const alreadyRunning = '主机报告该工作区已在运行。';
  static const starting = '该工作区正在启动；等待主机报告其生命周期。';
  static const useRestart = '主机报告该工作区已崩溃或已停止 — 请使用重启。';
  static const startWhenNotRunning = '启动该工作区：目录未将其列为在线。';
  static const stopWhenRunning = '请求主机关闭该工作区的 Pi。';
  static const stopNotRunning = '该工作区没有可停止的 Pi 进程。';

  /// 停靠栏里需要读工作树的三个面（计划/文件/更改）在工作区未运行时的说明。
  ///
  /// 为什么是「工作区未运行」而不是「未连接」：工作区目录还在，只是它的 Pi
  /// 停了，主机就不知道当前工作树长什么样。这两个原因得分开说。
  static const dockNeedsLive = '该工作区未运行，读不到它的工作树。先启动它再回来。';

  /// 主机没声明对应能力时的说明。绝不返回空白面板。
  static const noModelsCapability = '这台主机不支持在此客户端上修改模型配置。';
  static const noSettingsCapability = '这台主机不支持在此客户端上修改设置。';
}
