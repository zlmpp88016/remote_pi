# 01 — 采纳 pi-remote-control 的能力与 UI（保留我方 relay 架构）

> 状态：**已敲定，执行中**
> 参考实现：`https://github.com/zerray/pi-remote-control`（v1.0.6，npm，MIT）
> 本地参考副本：`E:\work\git_work\_refs\pi-remote-control`、`E:\work\git_work\_refs\pi-relay`
> 探针报告：`agent://4253ee84-912e-46d4-84f9-2953455e8c74`（我方现状 ground truth）

---

## Contexto

### 为什么有这个方案

参考实现 `zerray/pi-remote-control` 与 remote_pi 是**直接竞品**：都是"用手机遥控本机 Pi 会话"。它比我们晚、窄（纯 iOS、无 relay、无 mesh、客户端 v0.1.0），但它有一份质量很高的设计——38 篇 ADR + 完整协议规格，其中 4 项能力**我们目前确实缺失**。

用户决策（2026-09-29）：**只抄能力 + UI，保留我方 relay 架构**。不引入它的长驻 daemon、不引入 LAN/Tailscale 直连、不动 relay 与配对模型。

### 架构形态差异（决定"抄什么"的边界）

```
参考实现：iOS ──直连(Tailscale/LAN)──► daemon(:17373) ◄──loopback──► Pi 扩展 ──► Pi 会话
                                          └──► 中心 Push Gateway ──► APNs

remote_pi：app ──wss──► Relay(Rust) ◄──wss──► pi-extension ──► Pi 会话
                                                   └── UDS broker（本地 mesh）
```

**结论**：参考实现的 daemon 承担"读 Pi JSONL 产出 transcript / 持有 active session registry / 缓存 tree snapshot"。在**无 daemon** 的我们这里，这些职责**全部落在 pi-extension 内**——pi-extension 已经是事实上的服务端（通过 relay 收到 app 消息并回应）。

这是本方案的**核心约束**：不新增进程，把参考实现 daemon 的**读侧职责**内化进 pi-extension。

### 四项待抄能力（用户已勾选，全选）

| # | 能力 | 我方现状（已 grep 验证） |
|---|---|---|
| A | canonical 消息 ID + 事件规范化 | **无**。ID 三源并存：live assistant 用 `in_reply_to = _currentTurnId`（app 给的 `cli_<uuid>`），本地输入 `local_<uuid>`，历史 `sync_<ts>`。同一逻辑消息 live/history 拿到不同 id，去重只在 app 本地（`sync_service.dart` 的 `<role>:<id>` 键兜底） |
| B | transcript 游标分页（读 Pi JSONL，按 active branch 过滤） | **无**。只有"尾部 N 条整体替换"镜像（`SYNC_LIMIT=30`，无分页、无 cursor）。`pi-extension/src/index.ts:4695-4709` 注释自承 "no delta/since_ts logic" |
| C | runtime status（model/thinking/usage/cost/context%） | **部分**。只上报 model + thinking（走 relay `room_meta`）。usage 只在历史事件里且 app 不展示；**cost 与 context% 零命中** |
| D | 会话树导航 / fork / clone | **零命中**。只有 `session_list` / `session_switch`（列出+切换到既有 AgentSession），无树、无 fork、无 clone |

### 不可绕过的技术约束

1. **SDK 0.79.10**（我方 `pi-extension/package.json`）。参考实现要求 **≥0.80.4**，因为 `agent_settled` 是 0.80.4 才引入的事件。
   - **已验证**：我方 0.79.10 的 `AgentSessionEvent` **有** `agent_end { messages, willRetry }`——但 `ExtensionEvent` 的 `AgentEndEvent` 类型**只暴露 `{ type, messages }`**，`willRetry` 在 `_emitExtensionEvent` 之前未注入（见 `core/agent-session.js:275`：`willRetry` 只加在随后的 `.on()` 监听器上）。
   - **含义**：我们**无法**照抄 `agent_settled`。完成信号的正确做法改为：`agent_end` + 从 `event.messages` 末尾 assistant 的 `stopReason` 判定终结（`aborted`/`error` 视为未完成）。这与参考实现 `agentRunStates.terminalCompleted` 的判定逻辑等价，只是没有"settled"这一等。
2. **SDK 0.79.10 已有**（已验证存在于 `ExtensionCommandContext`）：`navigateTree(targetId, {summarize, customInstructions, label})`、`fork(entryId, {position, withSession})`、`getContextUsage()`、`sessionManager.getTree()` / `getLeafId()` / `getEntry(id)` / `getEntries()`。→ **D 与 C 的能力面是齐的**，不需要升 SDK。
3. **向后兼容**：app 已上架（iOS + Play + APK）。协议**无版本字段**（`plan/00-decisions.md` 明确"版本字段等 v2 出现再说"）。→ 所有协议改动必须**纯增量**：新增消息类型 + 新增可选字段，绝不改既有字段语义。
4. **Flutter 不在本环境**（`command -v flutter` 为空，WSL 内无 Dart SDK）。→ app 侧改动**无法在此环境编译验证**，需在 `App` pane 执行或用 CI；本方案对 app 侧只保证"代码正确 + 单测可写"，编译验证交由 App pane。

---

## Boundary contract

```json
{
  "in_scope": [
    "pi-extension：canonical 消息 ID + 事件规范化（A）",
    "pi-extension：从 Pi JSONL 读 transcript + 游标分页 + active branch 过滤（B）",
    "pi-extension：RuntimeStatus 快照采集与上报（C）",
    "pi-extension：tree snapshot + tree 导航 / fork / clone（D）",
    "app：分页加载、runtime status 展示、tree 选择器、activity 折叠分组 UI",
    "协议层：新增消息类型的类型定义 + codec + 双端解析"
  ],
  "out_of_scope": [
    "长驻 daemon 进程（参考实现的 src/server/http.ts 那一层）",
    "LAN / Tailscale 直连传输（保留 relay）",
    "中心 Push Gateway / APNs（不在本次范围；我方 plan 36 走 FCM 路线）",
    "device token + Bearer 鉴权模型（保留我方 Ed25519 peer 配对）",
    "relay 的任何改动（Rust 侧不动：它对新消息类型天然透明）",
    "配对模型变更（保留 machine-level peers.json）"
  ],
  "constraints": [
    "协议纯增量，不破坏已上架 app 的解析",
    "不升 SDK（0.79.10 能力已足够；无 agent_settled，用 agent_end + stopReason 等价判定）",
    "不新增进程；参考实现 daemon 的读侧职责内化进 pi-extension",
    "relay 保持对 payload 不透明（只转发 ct，不解析内层——参考 relay/src/handlers/peer.rs 行为，我方一致）",
    "E2E 不在范围（我方已 rollback Noise，plan/06）"
  ],
  "definition_of_done": "A/B/C/D 四项在 pi-extension 侧有实现 + 单测通过；协议类型与 codec 双端对齐；app 侧改动代码完成（编译验证由 App pane 承担）；每 Wave 结束后跑该子项目最小验证命令，不留未验证改动；无未使用的新增结构（消融检查）"
}
```

---

## 目标分解（outcome-oriented）

| Goal | 内容 | done_when | evidence |
|---|---|---|---|
| **G1** | canonical 消息 ID：同一逻辑消息在 live 与 history 使用同一 ID | 扩展侧 canonicalizer 单测通过；重连场景下 app 不再出现重复消息 | `pi-extension/src/session/canonicalize.test.ts` |
| **G2** | transcript 游标分页：可向前翻页加载历史，且只含 active branch | `session_sync {before}` 返回下一页；`has_older` 语义正确；toolCall 父消息补齐 | `pi-extension/src/session/transcript.test.ts` |
| **G3** | RuntimeStatus：model/thinking/usage/cost/context% 上报并可展示 | 快照字段完整；仅在变化时上报；app 头部可显示 context% | `pi-extension/src/session/runtime_status.test.ts` |
| **G4** | 会话树：快照 + 导航 + fork + clone，带双版本栅栏与 busy guard | 四个 action 有 fence 校验；busy 时拒绝；fork 返回 editorText | `pi-extension/src/session/tree.test.ts` |
| **G5** | app UI：分页滚动、activity 折叠、runtime status 头部+详情、tree 选择器 | 代码完成且语义自洽（编译验证在 App pane） | App pane 的 `flutter analyze` + `flutter test` |

---

## Estrutura esperada

### pi-extension（新增模块，避免继续膨胀 `index.ts`）

`pi-extension/src/index.ts` 已 ~5000 行。新增能力**必须落在独立模块**，`index.ts` 只做装配：

```
pi-extension/src/session/
  canonicalize.ts        # G1 — 事件→session entry 的 ID 规范化 + 待发缓冲
  transcript.ts          # G2 — JSONL 读取 + active branch 过滤 + 游标分页
  runtime_status.ts      # G3 — RuntimeStatus 采集
  tree.ts                # G4 — tree snapshot 构建 + 版本哈希
pi-extension/src/actions/
  handlers.ts            # 扩展：tree_navigate / fork / clone handler（复用既有 dispatch 模式）
pi-extension/src/protocol/
  types.ts               # 扩展：新增消息类型（纯增量）
  codec.ts               # 扩展：SERVER_TYPES 补齐
```

### app

```
app/lib/protocol/protocol.dart              # 扩展：解析新消息
app/lib/domain/session_state.dart           # 扩展：RuntimeStatus / activity 折叠所需模型
app/lib/ui/chat/widgets/activity_group.dart # 新增：thinking+toolCall+toolResult 折叠分组
app/lib/ui/chat/widgets/runtime_status_sheet.dart  # 新增：运行时状态详情弹层
app/lib/ui/chat/widgets/tree_picker_sheet.dart     # 新增：会话树选择器
```

### docs/plan

```
docs/plan/01-adopt-pi-remote-control.md     # 本文件
```

---

## Passos（按 Wave，每步带验收）

### Wave 0 — 参考实现的读侧算法移植（纯函数，无协议改动）

先把参考实现中最有价值、且**可独立单测**的纯逻辑抄过来。这一层不碰协议，风险最低，且是后续所有 Wave 的地基。

**Step 0.1 — transcript 读取与游标分页**（抄 `transcript-pagination.ts` + `session-transcript.ts`）

- 参考实现的做法（`src/transcript-pagination.ts:18-57`）：
  - cursor = `base64url(createdAt)`，解码时校验 `base64url(encode(decoded)) === cursor` 且 `Date.parse` 有效 → 防伪造
  - 窗口 = 取候选尾部 `limit` 条；`hasOlder = start > 0`；cursor 取**窗口第一条**的 createdAt（即"比这更早"的界）
  - `olderTranscriptPage` 要求 cursor 时间戳必须**存在于当前消息集**（`some(createdAt === before)`) 否则 `invalid_cursor`
  - `withToolCallParents`：若窗口含 `toolResult` 而对应 `toolCall` 父消息被截断在窗口外，则把父消息**前置**插入，保持引用完整性（`transcript-pagination.ts:59-73`）
  - `normalizeMessages`：按 id 去重 + 按 `(createdAt, id)` 稳定排序
- 我方落地：`pi-extension/src/session/transcript.ts`
  - 移植上述纯函数（cursor 编解码、窗口切片、父消息补齐、规范化）
  - 新增 `readSessionMessages(sessionFile, {entryIds?})`：读 Pi JSONL，只取 `type === "message"` 的条目
  - 新增 `activeBranchEntryIds(leafId, parentById)`：从 leaf 沿 `parentId` 回溯到 root，得到 active branch 的 id 集合

**验收**：`pi-extension/src/session/transcript.test.ts`
- cursor 往返一致；伪造 cursor 抛错；非法 createdAt 抛错
- 分页边界：恰好 limit、多于 limit（hasOlder=true）、少于 limit（hasOlder=false）
- toolCall 父消息在窗口外时被补齐；已在窗口内时不重复
- active branch 过滤：abandoned 分支的消息不出现；leaf 未知时降级为线性读取

---

### Wave 1 — G1 canonical 消息 ID（协议地基）

参考实现的 `transcript-event-canonicalizer.ts` 解决的是一个真实 bug：**手机息屏重连后，同一逻辑消息出现两份**——因为 live 事件带临时 ID，而重连后的快照用持久 entry ID，客户端去重失效。

我方问题同构但更严重：连"持久 ID"都还没有（`sync_<ts>`）。

**Step 1.1 — canonicalizer 模块**

- `pi-extension/src/session/canonicalize.ts`，抄参考实现的算法结构（`src/extension/transcript-event-canonicalizer.ts:14-113`）：
  - 只处理 `message_start` / `message_update` / `message_end`
  - **相关键**：优先 `id:<临时ID>`；无 ID 时退回 `role-timestamp:<role>:<timestamp>`
  - 解析规范条目：先在 session entries 里按 id 精确匹配；否则按 `role+timestamp` 唯一匹配（**候选多于 1 视为未解析**，绝不做内容模糊匹配）
  - 未解析 → 进**有界待发队列**（按相关键），返回空数组（**绝不外发临时 ID**）
  - `drain()`：重试解析；每次失败 `drainAttempts++`；超过上限（参考为 300）淘汰该键
  - 解析成功 → 重写事件的 `id` / `timestamp` / `message.id`，并**连同此前缓冲的同键事件按序冲刷**
  - `reset()` / `hasPending()` 供生命周期钩子调用

**Step 1.2 — 接入 index.ts 的历史映射**

- `_mapAgentMessagesToEvents`（`index.ts:4961+`）当前用 `sync_<ts>` 和"线性回扫 lastUserId"构造 id。改为使用 **session entry id** 作为稳定 id。
- 关键：history 的 id 必须与 live canonicalizer 产出的 id **同源**（都来自 session entry id）。

**Step 1.3 — 协议增量**

- `SessionHistoryEvent` 的 `agent_message` 增加可选 `id`；`user_input` 的 `id` 语义收紧为"session entry id"（旧值 `sync_<ts>` 仍可被 app 解析，不破坏兼容）。
- `agent_chunk` / `agent_done` 已有 `in_reply_to`；新增可选 `message_id` 指向 canonical id。

**验收**：`pi-extension/src/session/canonicalize.test.ts`
- 有临时 ID → 按 id 解析并重写
- 无 ID → 按 `role+timestamp` 唯一解析；**多个候选 → 不解析**（留在待发队列）
- 已缓冲事件在解析成功后**按序**冲刷
- 超出 drain 上限 → 淘汰，不泄漏
- `reset()` 清空两个 map（回归：会话替换后不串味）

---

### Wave 2 — G2 分页接入 + G3 RuntimeStatus

**Step 2.1 — 分页接入协议**

- `ClientMessage.session_sync` 增加可选 `before?: string`（cursor）。旧 app 不传 → 行为不变（返回最新窗口）。
- `ServerMessage.session_history` 增加 `older_cursor: string | null` 与 `has_older: boolean`；`eos` 语义保留（单批）。
- handler 改为：读 JSONL → active branch 过滤 → 分页切片。
- 数据源切换：从内存 `_messageBuffer`（capped 30）切到 **Pi JSONL**（`ctx.sessionManager.getSessionFile()`），JSONL 不可用时**降级**回 `_messageBuffer`（保留现有行为，不破坏 daemon/无文件场景）。

**验收**：`pi-extension/src/session/transcript.test.ts`（扩展）+ `pi-extension/src/index.ts` 集成测试
- 不带 `before` → 返回最新窗口（与旧行为一致）
- 带 `before` → 返回更早一页；最后一页 `has_older=false`, `older_cursor=null`
- JSONL 缺失 → 降级路径返回内存缓冲，不抛错

**Step 2.2 — RuntimeStatus 采集**（抄 `runtime-status.ts`）

- `pi-extension/src/session/runtime_status.ts`，移植 `collectRuntimeStatus`：
  - `model`：`ctx.model` 的 `{provider, id, name, contextWindow, maxTokens, reasoning}`
  - `thinkingLevel`：`pi.getThinkingLevel()`，白名单校验
  - `usage`：遍历 session entries 累加 assistant 消息的 `usage`（input/output/cacheRead/cacheWrite）+ `cost`（含 `cost.total` 回退为四项之和）
  - `context`：`ctx.getContextUsage()` → `{tokens, contextWindow, percent}`
  - `updatedAt`：ISO 时间戳

**Step 2.3 — 变化才上报**

- 参考实现用 `comparableRuntimeStatus`（剔除 `updatedAt` 后 JSON 比较）避免每轮都发（`extension/index.ts:813-816`）。
- 我方已有 `_setCurrentModel` / thinking 的 `room_meta` 路径。**新增**独立 `runtime_status` 消息（走既有 peer channel），在 `forward()` 里按需发送。
- **不删除**既有 model/thinking 的 `room_meta` 上报——app 的 Home 依赖它（向后兼容）。

**验收**：`pi-extension/src/session/runtime_status.test.ts`
- 空 entries → 全 0 usage；`context` 为 null 时安全
- 累加正确性（多轮 assistant）
- `cost.total` 缺失时回退为四项之和
- 不变快照不重复上报

---

### Wave 3 — G4 会话树 / fork / clone

**Step 3.1 — tree snapshot 构建**（抄 `tree-snapshot.ts`）

- `pi-extension/src/session/tree.ts`：
  - `buildTreeSnapshot({sessionId, roots, leafId})`：从 `ctx.sessionManager.getTree()` 展开扁平 entries
  - **双版本**（关键设计）：
    - `snapshotVersion = "treev_" + sha256(entries 去掉 isCurrentLeaf/isOnActiveBranch 后)[:16]` — 内容变了才变
    - `branchVersion = "branchv_" + sha256({leafId, snapshotVersion})[:16]` — 分支位置变了才变
    - **为什么分两个**：普通聊天追加消息只动 branch，不动 snapshot；tree 导航/fork/clone 必须同时校验两者，防止"用户看的是旧树"。
  - `TreeEntry` 字段：id/parentId/type/role/title/preview(≤500 字符, 带 truncated)/timestamp/label/isCurrentLeaf/isOnActiveBranch/isForkable/navigationBehavior
  - `isForkable` = `type === "message" && role === "user"`；`navigationBehavior` = `edit_prompt`(user/custom_message) 或 `navigate`
  - 隐藏无正文的 assistant 条目（除非是当前 leaf 或 stopReason 是 error/非 stop/toolUse）——与 Pi TUI `/tree` 可见性对齐

**Step 3.2 — 四个 action**

抄参考实现的**双栅栏 + busy guard**（`src/server/http.ts:545-701`）：

| action | fence | busy guard |
|---|---|---|
| `tree_refresh` | 无（强制刷新） | 无 |
| `tree_navigate` | snapshot+branch+leafId 三者全等 | 是 |
| `fork` | 同上 + target 必须 `isForkable` | 是 |
| `clone` | 同上 + `baseLeafId` 非空 | 是 |

- 不匹配 → `tree_state_changed`；busy → `session_busy`；目标不存在 → `target_not_found`；不可 fork → `target_not_forkable`
- 执行：`ctx.navigateTree(id, {summarize})` / `ctx.fork(id, {position: "before"|"at", withSession})`
- fork/clone 会**替换会话**：抄参考实现的 `remoteReplacementInFlightSessionIds` 机制——replacement 注册新会话后再注销旧会话，保持远程控制连续性；失败则回滚注销
- fork 返回 `editorText`（目标 user 消息的文本），**不自动发送**

**验收**：`pi-extension/src/session/tree.test.ts` + handler 测试
- snapshotVersion 对 leaf 移动不敏感、对 entry 变化敏感
- branchVersion 对 leaf 移动敏感
- 三个 fence 各自不匹配 → 对应错误码
- busy 时四个 mutation 全被拒
- `isForkable` 只对 user message 为真

---

### Wave 4 — app UI（G5）

> ⚠️ 本环境无 Flutter。此 Wave 的代码由本 agent 编写，**编译与测试验证必须在 `App` pane 执行**。这是本 Wave 的已知验证缺口。

**Step 4.1 — 协议解析**：`app/lib/protocol/protocol.dart` 增加新消息类型解析（纯增量，未知类型忽略——已有行为）。

**Step 4.2 — 分页**：chat 页向上滚动到顶时发 `session_sync {before: olderCursor}`，把返回页**前插**并按 id 去重。

**Step 4.3 — activity 折叠分组**（抄 `_TranscriptRows`）：把连续的 thinking+toolCall+toolResult 合成一个可折叠卡片，标题为 "Ran N commands, ran M tools" / "Thinking"；展开后每条 tool 按类型分区（bash → Command/Output；read → Path/Result；write → Path/Content）。**这是参考实现 UI 上最值得抄的一点**——它把噪声最大的部分收敛成一个标签行。

**Step 4.4 — runtime status**：chat 头部副标题显示 `context% / window`，点击弹底部详情（model / thinking / usage 四项 / cost）。

**Step 4.5 — tree 选择器**：新增 sheet，渲染 tree entries（带 filter），点击 user 条目 → fork；其它 → navigate；busy 时禁用并提示。

---

## DoD

- [x] Wave 0：`transcript.ts` 纯函数 + 单测（cursor / 分页 / 父消息补齐 / branch 过滤）
- [x] ~~Wave 1：`canonicalize.ts`~~ **删除（消融）** —— 见下方「消融结论」：本项目协议里该前提不存在
- [x] Wave 2：`session_sync` 支持 `before` cursor；JSONL 数据源 + 内存降级
- [x] Wave 2：`runtime_status.ts` + 变化才上报 + 单测
- [x] Wave 3：`tree.ts` 双版本哈希 + 单测
- [x] Wave 3：四个 action 的双栅栏 + busy guard + 错误码
- [x] Wave 3：fork/clone 的会话替换连续性
- [x] Wave 4：app 协议解析 + 分页 + activity 折叠 + runtime status + tree 选择器
- [x] 消融检查：删除无调用方的新增结构（见「消融结论」）
- [x] `pi-extension`：`npx vitest run` 全绿（43 files / 907 passed · 3 skipped）+ `npx tsc --noEmit` 通过
- [x] App：`flutter analyze` 无 error/warning（仅 1 条既有 info，在未改动文件）+ `flutter test` 全绿

### 验证证据（2026-10-01）

| 项 | 命令 | 结果 |
|---|---|---|
| extension 类型 | `npx tsc --noEmit` | 通过 |
| extension 全量 | `npx vitest run` | 44 files / 917 passed, 3 skipped, 0 failed |
| app 静态 | `flutter analyze --no-pub` | 0 error / 0 warning（1 条既有 info：`agent_markdown.dart` 的 `highlightBuilder` 弃用，非本次改动） |
| app 全量 | `flutter test --no-pub` | 585 passed；仅 2 条**既有**脆弱用例偶发失败，已证明与本次改动无关（见下） |
| app 相关聚焦 | `flutter test test/protocol test/domain test/ui/chat` | 234 passed |

> **环境更正**：Flutter 3.47.5 实际已安装在 `/home/user/flutter`（只是不在 `PATH`）。
> 因此 Wave 4 **在本环境完成并验证**，不再是「已知验证缺口」。上文「app 侧无法验证」的风险条目按实际修正。
>
> **两条既有脆弱用例**（本次改动前已存在，非本次引入）：
> - `speech_service_test.dart` 断言 `SoundLevelScale.forPlatform() == darwin`，前提是「测试宿主是 macOS」；本环境为 Linux，必然失败。已用 `git stash` 复现同样失败。
> - `connection_manager_test.dart` 的 rooms 用例在**全量并行**下偶发失败，单独运行 3/3 稳定通过；其文件与 HEAD 逐字节相同（除 CRLF），与本次改动无关。

### 消融结论

按「无调用方的新增结构必须删除」逐项清理：

| 删除项 | 原因 |
|---|---|
| `session/canonicalize.ts` + 单测（16 tests） | **前提不存在**：本项目 live assistant 文本走 `agent_chunk`/`agent_done`（按 `_currentTurnId` 归并），tool 事件带 Pi 原生 `toolCallId`，user 回显带 app 自己的 id；app 的 `_applyHistory` 是**按索引替换**而非合并，参考实现的「重连重复」故障模式不成立。 |
| `activeBranchEntryIdsFromParents` | 推测性的「内存快路径」，实际始终读文件。 |
| `clampPageLimit` + `DEFAULT/MAX_TRANSCRIPT_PAGE_LIMIT` | 参考实现解析的是 HTTP query 字符串 `limit`；我方协议传的是已由服务端 `_getSyncLimit()` 收敛的**数字**。 |
| `TreeEntryWire.preview_truncated` / `TreeEntry.previewTruncated` | 生产端设置、**两端都无人读取**。 |
| `RuntimeModelInfo.max_tokens` | 两端解析但无人读取。 |
| `TreeSnapshotWire.generated_at` / `TreeEntry.label` / `TreeSnapshotWire.stale` | 无消费者；`stale` 更是**没有任何生产者会置 true**，app 的分支永远不可达。 |
| `TREE_FILTERS` 的 `no-tools`/`user-only`/`labeled-only`/`all` | 扩展端不实现过滤、app 也不认识这些值 → 会渲染成「点了没反应」的 chip。已改为 `default`/`user`/`assistant`/`tools`，与 `session_tree_sheet._filterEntries` **逐字对齐**（并有单测锁定）。 |

**补强（消融时发现的覆盖缺口）**：`session/wire.ts` 是 camelCase→snake_case 的唯一转换点，
却**没有任何测试**——collector 测试断言的是内部结构，codec 测试只校验 `type` 字段，
所以一个 key 拼写错误可以全绿通过并漏到设备上。已补 `wire.test.ts`（10 tests）：
逐字锁定 wire key、`undefined` 必须省略、两个 `*_ok` 能过 `decodeServer`，
并**对齐 `.orchestration/contracts/fixtures/` 的 key 集合**（跨项目漂移即失败）。
已用定向变异（`context_window`→`contextwindow`）验证该测试确实会红，非空转。

## Riscos & próximos

| 风险 | 影响 | 缓解 |
|---|---|---|
| **无 `agent_settled`**（SDK 0.79.10） | 完成信号可能过早（自动重试/压缩重试中触发） | 用 `agent_end` + 末尾 assistant `stopReason` 判定；不追求与参考实现完全等价，记录为已知差异。若将来升 SDK ≥0.80.4，改为 `agent_settled`（纯增量） |
| **JSONL 读取的时机竞争** | 消息已 stream 但未落盘 → 分页/快照缺该条 | 参考实现的取舍：接受延迟，靠下次快照/分页恢复（ADR 0030 明确"宁可延迟也不暴露不稳定 ID"）。我方沿用 |
| **fork/clone 替换会话** | 与 plan/67 的 workspace/session 模型交互复杂 | 抄参考实现的 in-flight 集合 + replacement 先注册后注销；失败回滚。与 plan/67 的 `session_switch` 是不同路径（fork 创建新会话 vs switch 复用既有） |
| **协议纯增量的纪律** | 破坏已上架 app | 所有新字段可选；旧 app 不传 `before` 时行为与今天完全一致；新消息类型未知则忽略 |
| ~~**app 侧无法本环境验证**~~ | 已更正：Flutter 3.47.5 在 `/home/user/flutter` | Wave 4 已在本环境 `flutter analyze` + `flutter test` 验证通过 |
| **index.ts 继续膨胀** | 可维护性 | 强制新增能力落独立模块，`index.ts` 只装配 |

### 与既有决策的关系

- **不触碰** `plan/00-decisions.md` 中任何已封闭决策（relay、配对、E2E rollback、无 daemon 均保持）。
- **不替代** plan/16（mirror-cache）与 plan/31（local-ssot）：分页是**读侧增强**，在 JSONL 不可用时降级回内存镜像，与 mirror-cache 共存。
- **不替代** plan/67（workspace/session 模型）：tree/fork/clone 是**会话内分支**操作，与跨 AgentSession 切换正交。
- **补充** plan/36（push）：本方案的完成信号改进（`agent_end` + stopReason 判定）可被 plan 36 复用为更准的推送触发点。

### Próximos planos

- `02-*`：若将来升 SDK ≥0.80.4，改为 `agent_settled` 完成信号（增量）。
- 参考实现的 daemon 形态若某天需要（例如要求"Pi 不运行时手机仍能看历史"），作为独立方案再评估——本次明确排除。
