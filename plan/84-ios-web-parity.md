# Plan 84 — iOS 端与 web 客户端功能对齐

## Contexto

### 目标

iOS 客户端的功能与 UI 与 web 客户端**一一对应**。不是「做一个能聊天的 App」，
而是「让手上这台 iPhone/iPad 具备 web 端全部能力」。

### 现状盘点（实测，非推测）

`clients/mobile/` 是一个**已有的、成熟的 Flutter 客户端**，128 个 dart 文件，
`lib/protocol/protocol.dart` 单一文件就有 2946 行协议类型。它**不是空地**。

已具备：

| 能力 | 位置 | 证据 |
|---|---|---|
| WebSocket 传输 + 重连 | `lib/data/transport/{ws_transport,connection_manager}.dart` | — |
| 配对（含 relay） | `lib/ui/pairing/`、`lib/data/transport/relay_config.dart` | — |
| 工作区列表/生命周期 | `lib/data/transport/host_proxy.dart` | `workspace_list/start/stop/restart` |
| 文件浏览 | 同上 | `fs_list` |
| 会话列表 | `lib/data/sessions/session_catalog.dart` | `session_list` |
| 对话（含流式、工具卡片、附件、语音） | `lib/ui/chat/` | `agent_chunk`/`agent_done`/`approve_tool` |
| 插件面（局部） | `lib/ui/pi_surface/pi_surface_page.dart`（676 行） | `pi_surface`，仅 package/project/user/manual |
| 模型切换（对话内） | `lib/ui/chat/quick_actions/widgets/model_picker_sheet.dart` | `list_models` |
| 本地设置（App 自身偏好） | `lib/ui/settings/settings_page.dart`（451 行） | 配对、relay、隐藏工具调用 |

**缺失（web 有的）：**

| web 面板 | 现状 | 缺什么 |
|---|---|---|
| 会话 Sessions | 有 chat，但无「会话列表作为独立停靠栏面板」 | 列表/筛选/恢复/删除的完整面板 |
| 计划 Plan | **完全没有** | `fs_list(plan/)` + `fs_read` + Markdown 渲染 + 筛选 + 单文档视图 |
| 文件 Files | 有 `fs_list`，无面板 | 目录浏览 UI + dotfiles 开关 + 「加入目录」/「在此启动 Pi」 |
| 更改 Changes | **完全没有** | `changes_snapshot` 协议 + 工作树渲染 + 计数 + 分支/HEAD + reload |
| 插件 Plugins | 有 `pi_surface`，缺完整流程 | 安装/启用/禁用/移除 + 来源选择 + 筛选 |
| 自动化 Automations | **完全没有** | `schedule_*` 协议（list/create/update/delete/run）+ cron 预设 + 模型/会话选择 |
| 模型 Models | 只有对话内切换 | `models_describe`/`models_mutate` + provider 编辑 + API key 掩码 + revision 冲突 |
| 设置 Settings | 只有 App 自身偏好 | `settings_describe`/`settings_mutate` + 主机 settings.json 白名单投影 |

**协议层缺口**（`lib/protocol/protocol.dart` 实测）：

```
fs_read:          0 处
changes_snapshot: 0 处
schedule_*:       0 处
models_describe:  0 处
settings_describe:0 处
list_models:      2 处（仅对话内切换）
pi_surface:       4 处（仅读）
```

也就是说：**8 个面板里有 5 个的协议在 iOS 端完全不存在**。这不是 UI 工作，是协议 + UI 两层。

### 一个必须正视的架构差异

web 端是**双栏**：左侧工作区栏 + 中央对话 + 右侧 8 标签停靠栏。
iPhone 上没有这个空间。UI 要「与 web 一致」，指的是**信息架构与文案一致**，
不是把三个竖栏硬塞进 390pt。呈现形式必须适配移动端（见 §4）。

---

## 1. 技术栈决策

**继续用现有 Flutter 工程。不新建 SwiftUI 工程。**

理由（按证据强度排序）：

1. **已有 128 个 dart 文件、2946 行协议类型、完整传输/配对/对话/语音/附件**。
   新建 SwiftUI 意味着把这些全部重写一遍，包括 Ed25519 配对、重连退避、
   流式消息合并、工具审批卡片。这是几个月的工作量换零功能增量。
2. **`CLAUDE.md` 规定 mobile 与 desktop 都是 Flutter**。引入第二种语言会
   让两个客户端从此分叉，而它们的传输层逻辑本来高度相同。
3. **协议层可复用**：`lib/protocol/protocol.dart` 已有 2946 行 wire 类型，
   补齐 5 个 RPC 家族即可，不需要重新设计序列化。
4. **`clients/mobile/ios/` 已存在**，iOS 是既有构建目标，不是新平台。

代价与缓解：Flutter 的 iOS 手感（滚动物理、context menu、sheet 手势）需要显式适配。
缓解：`lib/routing/adaptive.dart` 已存在，说明工程已有自适应路由的先例，
沿用它而不是新造。

---

## 2. 模块划分

遵循现有分层：`ui/`（页面 + viewmodel + state）· `data/`（repository + transport）· `protocol/`。

### 新增

```
lib/protocol/
  plan.dart              fs_list + fs_read 的类型（如尚未内联）
  changes.dart           changes_snapshot + 行状态
  schedule.dart          schedule_list/create/update/delete/run
  models_config.dart     models_describe/mutate + provider/model 行
  settings.dart          settings_describe/mutate + 白名单叶子
```
> 若现有 `protocol.dart` 已内联部分类型，优先扩展它而非新建文件 —— 该文件
> 已经是单一 wire 契约，拆开会让「协议在哪」变模糊。

```
lib/data/repositories/
  plan_repository.dart
  changes_repository.dart
  schedule_repository.dart
  models_config_repository.dart
  settings_repository.dart
```
每个 repository 一个职责：发 RPC、把 wire 类型映射成 domain 类型、把
`*_error` 的 reason 映射成固定中文文案。

```
lib/ui/dock/                  ← 新增：8 面板的移动端容器
  dock_page.dart              面板切换（底部 tab bar 或 sheet）
  sessions/plan/files/changes/plugins/automations/models/settings/
    <panel>_page.dart
    states/<panel>_state.dart
    viewmodels/<panel>_viewmodel.dart
```

### 改造

| 文件 | 改动 |
|---|---|
| `lib/data/transport/host_proxy.dart` | 补 5 个 RPC 家族的转发；保持现有 `host_forward` 通道不变 |
| `lib/ui/chat/chat_page.dart` | 加一个入口按钮，打开 dock（对应 web 的右侧停靠栏） |
| `lib/ui/workspaces/workspace_list_page.dart` | 工作区行加「打开面板」与 cwd 展示 |
| `lib/ui/settings/settings_page.dart` | 拆成两段：**App 偏好**（现有）与 **主机设置**（新增 settings.json） |

### 职责边界（不许越界）

- `protocol/` 只放 wire 类型与序列化，**不含业务判断**
- `data/repositories/` 只做 RPC + 映射，**不持有 UI 状态**
- `ui/**/viewmodels/` 持有状态与副作用，`ui/**/widgets/` 无状态优先
- **固定文案集中在 `lib/ui/core/copy.dart`**（新增），一律中文，
  与 web 的 `notices.ts` 逐条对应。绝不在 widget 里散落字符串字面量。

---

## 3. 协议对接

### 传输

现有 Flutter 用 **WebSocket**（`ws_transport.dart`），web 用 **SSE**。
两者都连同一个 direct-mode daemon（`:4124`），**协议内容相同，只是分帧方式不同**。

**决策：iOS 保留 WebSocket，不迁 SSE。** SSE 是浏览器约束下的产物
（EventSource 只能单向、需要 POST 配合发请求）；原生客户端没有这个约束，
WebSocket 双向更简单。**共同点是 `host_forward` 代理与其上的 RPC 语义，那才是契约。**

需要确认（实施第一步就验证，不要假设）：现有 daemon 是否同时暴露 WS 与 SSE 端点。
若只暴露 SSE，则 Flutter 侧需要一个 SSE 客户端替代 `ws_transport` —— 这会影响
`connection_manager`/重连/心跳，属于**必须最先排除的风险**，见 §7 R1。

### 5 个缺失的 RPC 家族

全部走既有 `host_forward` 代理（`host_proxy.dart` 已实现），只是新增内层类型。

| 面板 | 请求 | 应答 | 错误 |
|---|---|---|---|
| 计划 | `fs_list{path}` / `fs_read{path}` | `fs_list_ok` / `fs_read_ok` | `fs_error{reason}` |
| 更改 | `changes_snapshot` | `changes_snapshot_ok{staged,unstaged,untracked,conflicted,branch,head,paths}` | `changes_error` |
| 自动化 | `schedule_list` / `schedule_create` / `schedule_update` / `schedule_delete` / `schedule_run` | `*_ok` | `schedule_error{reason}` |
| 模型 | `models_describe` / `models_mutate{ops,revision}` | `models_describe_ok` / `models_mutate_ok` | `models_error{reason}` |
| 设置 | `settings_describe` / `settings_mutate{ops,revision}` | `settings_describe_ok` / `settings_mutate_ok` | `settings_error{reason}` |

**能力门禁**：每个面板打开前先看 `host_hello.capabilities`。
`settings` 缺失 → 该面板显示「该主机未向此客户端提供设置界面」，**不是空白**。
web 的 `tabReason()` 八个分支就是这套语义，逐条照搬（文案已在 §5）。

**两条不可妥协的规则（来自 web 端实测事故）：**

1. **`revision` 是文件字节的 sha256，一次写入前只比对一次，过期就拒。**
   见 `server/src/daemon/settings_config.ts`。iOS 侧必须把 revision 原样带回。
2. **`models.json` 里永远不出现 API key 的任何形式** —— 不是值、不是掩码、
   不是长度。iOS 侧展示「已配置 / 未设置」两态。

### 懒加载（web 端的真实缺陷，不要重犯）

web 端曾有 5 个面板的 `onXxxReload` prop 声明了却**从来没人调用**，
于是面板从空缓存渲染，看起来像坏了。iOS 侧：
**每个面板的 viewmodel 在 `initState`/首次可见时就发起自己的请求**，
不依赖「某个更早的动作碰巧填了缓存」。

---

## 4. 页面结构（iPhone / iPad 分别）

信息架构与 web 一致（8 个面），呈现形式适配设备。

### iPhone（< 600pt 宽）

底部 5 项 tab bar + 「更多」溢出菜单：

```
[对话] [会话] [文件] [更改] [更多 ▾]
                              └ 计划 / 插件 / 自动化 / 模型 / 设置
```

- **对话**：即现有 `chat_page.dart`，主界面
- **会话**：push 到会话列表 → 点选进入只读/恢复
- **文件/更改**：全屏 push
- **其余 5 项**：从「更多」以 `showModalBottomSheet`（半屏，可拖到全屏）打开

选 sheet 而非 push 的理由：这 5 个面是「查看/微调」性质，用户会频繁来回，
模态 sheet 的手势关闭比 push 的返回按钮更符合 iOS 习惯。

### iPad（≥ 600pt）

`NavigationSplitView` 式布局（Flutter 用 `Row` + `LayoutBuilder`）：

```
┌──────────┬────────────────────┬──────────┐
│ 工作区栏  │     对话            │ 面板     │
│ (240pt)  │                    │ (320pt)  │
└──────────┴────────────────────┴──────────┘
```

- **左栏**：工作区列表（对应 web 左侧栏）
- **中栏**：对话
- **右栏**：8 个面板，顶部横向 tab（对应 web 的 `right-rail` tabList）

这正是 web 的布局，iPad 放得下。横屏 iPad Pro 12.9" 有 1024pt+，与 web 的最小
可用宽度同一量级。

**折叠规则**（照搬 web 的实测阈值，见 `geometry.ts`）：
- 宽度 < 1024pt：左栏折叠为图标条（web 的 56px rail）
- 宽度 < 760pt：右栏面板消失，只能全屏进入（web 的 dock 消失）

---

## 5. 中文文案

**直接沿用 web 已锁定的术语表**（`BUTTON-AUDIT.md` §14）：

| 英文 | 中文 |
|---|---|
| host | 主机 |
| workspace | 工作区 |
| session | 会话 |
| turn | **这轮对话**（不是「该轮次」—— 那是会议纪要中文） |
| relay | 中继 |
| pairing code | 配对码 |
| daemon | 守护进程 |
| palette | 配色 |
| skill | 技能 |
| thinking level | 思考级别 |
| working tree | 工作树 |
| automation | 自动化 |
| plugin | 插件 |
| model | 模型 |
| provider | 提供方 |
| accent preset | 强调色预设 |
| appearance | 外观 |
| behaviour | 行为 |

停靠栏标签：**会话 / 计划 / 文件 / 更改 / 插件 / 自动化 / 模型 / 设置**

两条从评审中活下来的规则：

1. **`The host did not X` 保留「主机」作主语。** 删掉它（「工作区启动失败」）
   会销毁远程工具唯一必须传达的诊断事实：失败发生在**哪里**。
2. **用户可见文案一律中文；协议字面量、`data-*`、变量名、注释保持英文。**
   翻译比较操作数会静默破坏逻辑。

`lib/ui/settings/settings_page.dart` 现有文案是英文（`'Add new pairing'`、
`'Hide tool calls in chat'` 等），**一并汉化**。

---

## 6. 验收方式

参照 web `verify-*.mjs` 的强度标准：**真机/模拟器连真 daemon，断言实际状态，不用 mock 代替。**

### 三层

1. **Widget test**（快，每 PR 跑）
   - 每个面板：空态、加载态、错误态、有数据态
   - 文案断言：面板里出现的必须是中文关键句
   - **否定断言**：面板文本不含绝对主机路径、不含 `EACCES`/`ENOENT`、不含包名

2. **Integration test**（`integration_test/`，每面板一条主路径）
   - 连真实 daemon（`:4124`）+ 真实工作区
   - 逐面板：打开 → 断言数据来自主机（不是空缓存）→ 执行一个动作 → 断言结果

3. **手工真机验收**（发版前）
   - iPhone 与 iPad 各一台
   - 浅色/深色两套
   - 8 个面板全部走一遍

### 每个面板的验收判据

| 面板 | 必须证明的事 |
|---|---|
| 会话 | 列表来自 `session_list`；能打开一个历史会话；能恢复 |
| 计划 | 列出 `plan/*.md`；能打开一篇；Markdown 渲染；筛选生效 |
| 文件 | 能列目录；dotfiles 开关生效；能加入目录；能启动 Pi |
| 更改 | 计数与 `git status` 一致；分支/HEAD 正确；非 git 仓库给出明确说明而非空列表 |
| 插件 | 列出真实包；启用/禁用真的改了 host 状态；安装/移除 |
| 自动化 | 创建一条 → host 真的存了 → **重启 App 后仍在**；立即运行产生记录 |
| 模型 | 显示 host 的 provider；编辑 baseUrl 保存后磁盘变化；**API key 从不出现在 UI 或日志** |
| 设置 | 六项白名单值与磁盘一致；保存后其他 key 逐字节不变；过期 revision 被拒 |

### 断言强度规则（从 web 端学到的）

- **只增不减**：替换一个断言必须换成更强的，不能换成更宽松的。
- **作用域要正确**：web 曾有断言扫 `documentElement` 而误伤聊天内容。
  iOS 侧断言一律限定到面板子树，**并额外断言该子树非空**，
  这样选择器写错时不会静默通过。
- **测测得的颜色，不读原始变量**：`var()` 链可能让原始属性为空但计算值有效。

---

## 7. 分步实施计划

每步都以「可独立验收」为界。

### 阶段 0 — 摸清地基（半天，必须先做）

**R1（阻塞性风险）：确认 daemon 是否接受 WebSocket。**
若只接受 SSE，`ws_transport.dart` 就得改写成 SSE 客户端，
`connection_manager`/重连/心跳全受影响——这会让后面每一步的排期失真。

**已排除（本轮实测）**：direct mode 用 `startEmbeddedRelay({ noServer: true })`
（`server/src/direct.ts:200`），HTTP 与 WebSocket **同端口 4124**，upgrade 走同一个
listener。实测 `ws://127.0.0.1:4124/` 直接握手成功，`onopen` 触发。

**阶段 0 剩余**：从 Dart 侧完成一次完整往返。注意首次连接走 `pair_request`
（`server/src/index.ts:14`），**不是 `host_hello`** —— 后者是配对成功后的握手，
未配对就发它不会得到应答；裸 `pair_request` 同样需要外层 channel 封装
（`PlainPeerChannel`，见 `server/src/index.ts:22`），所以两个探针都在连接成功后
停在「等应答」。**连接层已证明可用，信封层的答案在现有 `lib/data/transport/` 里
——那是已经跑通的实现，照它做即可。**

其他：读 `clients/mobile/CLAUDE.md`，确认既有约定；跑一次 `flutter test` 拿基线。

### 阶段 1 — 协议层（五个 RPC 家族）

按此顺序（依赖从少到多）：

1. `fs_read`（计划面板需要，最小）
2. `changes_snapshot`（无写操作，纯读）
3. `schedule_*`（有增删改，但结构简单）
4. `settings_describe/mutate`（白名单 + revision）
5. `models_describe/mutate`（revision + 密钥不可泄漏）

**验收**：每个家族一组 dart unit test —— 请求构造、应答解析、错误 reason 映射。
用 `server/src/protocol/types.ts` 的真实字段名，不臆造。

### 阶段 2 — 面板骨架 + 两个最简单的面

先做**更改**（只读、无表单）与**计划**（只读 + Markdown）。

**验收**：iPhone 上打开这两个面板，数据来自真 host；空态/错误态正确。
这一步同时确立 `lib/ui/dock/` 的容器形状（iPhone sheet / iPad 右栏），
后面 6 个面板复用。

### 阶段 3 — 文件 + 插件

文件面板补 UI（协议已有）；插件补完整流程（协议已有读，补写）。

**验收**：见 §6 表格。

### 阶段 4 — 设置 + 模型（两个有写操作的面板）

这两个是唯一会**改主机文件**的面板，风险最高，放最后。

**验收**：必须包含
- 保存后除目标 key 外逐字节不变
- 过期 revision 被拒
- `models.json` 的 API key 不出现在任何 UI 文本、日志、崩溃报告里

### 阶段 5 — 自动化

协议最复杂（cron 表达式、时区、模型/会话选择），但完全独立于其他面板，可与阶段 3/4 并行。

**验收**：创建 → 重启 App → 仍在；立即运行产生记录。

### 阶段 6 — 收口

- 全局汉化复核（含现有 `settings_page.dart` 的英文）
- iPhone/iPad × 浅色/深色 四组合手工验收
- 折叠阈值与 web 一致
- `flutter analyze` 零警告、`flutter test` 全绿

---

## DoD

- [x] 阶段 0 的 R1 已排除：daemon 的 WS 与 HTTP 同端口（实测握手成功）；待 Dart 侧完成一次 pair 往返
- [ ] 5 个 RPC 家族各自有 dart unit test，字段名与 `types.ts` 一致
- [ ] 8 个面板在 iPhone（底部 tab + 更多 sheet）与 iPad（三栏）都能打开
- [ ] 每个面板的「数据来自主机」有 integration test 证明，不依赖缓存
- [ ] 能力缺失时有明确中文说明（不是空白面板）
- [ ] 全部用户可见文案为中文，术语与 web 一致
- [ ] `models.json` 的 API key 不出现在 UI、日志、崩溃报告
- [ ] 设置/模型保存后，除目标 key 外文件逐字节不变
- [ ] 折叠阈值与 web 一致（1024pt / 760pt）
- [ ] `flutter analyze` 零警告；`flutter test` 全绿
- [ ] iPhone 与 iPad、浅色与深色四组合手工验收通过

---

## 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | ~~daemon 只接受 SSE~~ **已排除** | — | 实测 `ws://127.0.0.1:4124/` 握手成功；`direct.ts:200` 用 `noServer` 内嵌 relay |
| R2 | `protocol.dart` 2946 行，新增 5 个家族后继续膨胀 | 可维护性 | 新类型放 `lib/protocol/<family>.dart`，`protocol.dart` 只 re-export |
| R3 | iPhone 上把 web 三栏硬塞会毁掉可用性 | 产品失败 | §4 明确：信息架构一致，呈现形式适配 |
| R4 | 写操作（设置/模型）误改主机文件 | 数据损失 | revision 比对 + 只增白名单 + 保存前逐字节基线 |
| R5 | API key 泄漏到日志/崩溃报告 | 安全事故 | 主动的否定断言，不是「小心一点」 |
| R6 | 重犯 web 的懒加载缺陷（面板从空缓存渲染） | 看起来像坏了 | §3 末：每个 viewmodel 自己发起请求 |

---

## 下一个计划

`plan/85-ios-dock-panels.md` —— 阶段 2 的具体实现（更改 + 计划面板）。
