# Plan 75 — 会话信息架构、切换延迟与诚实重启计数

Status: implemented
Supersedes parts of: none（扩展 `plan/72`、`plan/74`）

## 1. 用户报了什么

四个症状同时报出，因为它们互相放大：

1. **右栏图标悬停变白** —— Sessions/Files/Plan/Changes 在鼠标指上去时消失。
2. **`Remote Pi · lei`** —— 产品名后面多一个来历不明的 `lei`。
3. **点击 Switch 没有反馈**，随后长时间无响应，看起来像没实现。
4. **`The host's supervisor restarted this workspace 38 times.`** —— 吓人，且是正常使用造成的。
5. **所有会话行标题一模一样**；模型选择列表里的模型名看不见。

## 2. 根因（实测，非推断）

### 2.1 会话标题是工作区文件夹名

```
$ node -e "... SessionManager.list('D:/模型测试/4.1f')"
count: 11
{"id":"01a14a9e","name":"4.1f","first":"创建一个HTML，内容是SVG的方式画一个鹈鹕骑车的"}
{"id":"01a0fb75","name":"4.1f","first":"在一个黑色的袋子里放有三种口味的糖果…"}
… 全部 11 行："name":"4.1f"
```

宿主把 SDK `SessionManager.list()` 的 `name` 原样发出。该字段是**用户自定义显示名**，
实际存的是工作区文件夹名，于是 11 行全渲染成 `4.1f`。真正的区分文本 `firstMessage`
本来就在 payload 里。

### 2.2 重启计数器把主动回收算成了崩溃

`noteRestart()` 在三个地方被调：

| 调用点 | 含义 |
|---|---|
| `EXIT_DAEMON_FRESH_SESSION`（`/new`） | 主动 |
| `EXIT_DAEMON_SWITCH_SESSION`（切换） | 主动 |
| 崩溃 backoff | 失败 |

三处里两处是正常用户操作，而 UI 把该数字当健康告警打印。切换几十次就得到「重启 38 次」。

### 2.3 切换确实昂贵，且零反馈

daemon 模式没有进程内 `switchSession`，处理路径是：

```
stagePendingSwitchTarget(path) → ack → process.exit(EXIT_DAEMON_SWITCH_SESSION)
  → supervisor 用 --session <path> 重新拉起 pi → 客户端重新握手
```

即每次切换重启一个进程。叠加 `.switchButton:hover` 把背景设成**与静止态完全相同**，
按钮在等待开始前就已经像死的。

### 2.4 浅底白字悬停色，静态审计看不见

`.railTabButton:hover { color: var(--color-white) }` 配浅色 wash
（`--dsw-alias-interactive-bg-hover`）。静止态审计看不到 hover 样式，所以 `plan/74`
的清扫漏掉了 12 处同类声明。模型选择列表的 `.rowName` 是同一类 bug。

### 2.5 `lei` 就是 `host.hostname`

`remote-pi-shell.tsx` 渲染 `Remote Pi · {host.hostname}`，本机名是 `lei`。

## 3. 两份外部评审，以及它们改变了什么

并行咨询 **step-5-preview** 与 **gpt-6.1-sol**（grok-4.6 请求过但不可达 ——
`503 model_not_found`）。两者拿到相同实测事实，且都无仓库访问权，故其结论属设计判断，
由我对着代码逐条核验。

**两者独立得出同一判决：这是「原语选错」问题，不是「速度不够」问题。**

> "Today, 'let me look at that conversation' effectively means 'terminate and
> recreate the agent runtime.'" —— gpt-6.1-sol

> "A 5-second operation with a legible progress narrative is acceptable; a
> 5-second operation behind a dead button is a bug report." —— step-5-preview

step-5-preview 还补了更锐利的一点：UI 暗示有 11 个活会话，而架构只有**一个**，
其余是磁盘上的文件。「像没实现」的感受很大部分来自这个错配。

**我动手前先验证了：** `handleSessionRead` 经 `readPage(target.path)` 读文件，
完全不碰子进程。所以模型推荐的廉价只读路径**已经存在** —— 列表行本来就接在
`onRead` 上。真正的缺陷是每行还多挂了一个昂贵的 `switch` 按钮，等着误点。

## 4. 改动

### 4.1 标题从会话本身推导，不再用文件夹名

`clients/web/src/lib/remote-pi/sessions.ts` —— `sessionLabel()` 现在：

1. 仅在 `name` 是**真正的显示名**时才用（不等于 cwd 最后一段，兼容 POSIX 与 Windows）；
2. 否则用折叠空白的 `firstMessage`，截到 64 字符；
3. 再否则才用短 id。

行内同时显示 `短id · 相对时间`，使开头提示语真的相同的会话（此处确有多个）仍可区分。
第二行若只是重复标题则不再渲染。

会话查看器的横幅改用同一个 `sessionLabel`，列表与查看器不可能再不一致。

### 4.2 重置按钮

每行的 `switch` 控件**移除**。恢复执行只在一个地方发生：会话查看器里的按钮，
改名为 **Resume here**，并带实时计秒（`Resuming… 4s`）—— 因为转圈不能证明任何事。

`onSwitch` / `canSwitch` 从 `SessionList`、`RightRail` 一路删到 `connect-client.tsx`，
不留死参数。

### 4.3 重启计数区分崩溃与主动回收

`rpc_child.ts` 在 `noteRestart()` 旁新增 `noteRecycle()`；两个主动退出码改调后者，
不再碰 `restartCount`。supervisor 仍推 `restarts: child.restartCount`，现在它与横幅
说的话一致。

`supervisor_69.test.ts` 原本断言的是**旧**行为（`/new` 后 `restarts` 涨到 2）。那条断言
把 bug 固化了，故改为期望停在 1，并加注释点明这是回归。

### 4.4 悬停颜色，以及能看见它的 gate

13 个文件里 16 处浅底上的 `color: var(--color-white)` 改为 `--dsw-alias-label-primary`。
两个新 gate：

- `verify-web-contrast-rail-hover.mjs` —— 断言浅色主题下无白字声明，**并且**用真实 wash
  给正规悬停色算比值（`label-primary` 16.99:1、`label-secondary` 5.21:1）。
- `verify-session-labels.mjs` —— 针对真实实测行形状的 12 项检查。

两者进入 `run-web-checks`（18 → 20 runners），drift guard 扩展为接纳非
`verify-web-*` 命名。

### 4.5 移除 `lei`

标题栏的 `.machine` span 与 `·` 分隔符删除，只剩 `Remote Pi`。`host.hostname` 仍用于
它真正有意义的地方（Unpair 确认文案），故没有留下未用变量。

## 5. 验证

```
audit-contrast: OK (0 <= allowed 0) at AA 4.5:1
web-contrast-states: OK (4 states at AA 4.5:1)
web-contrast-selection: OK
error-state: OK (4 elements at AA 4.5:1)
web-contrast-tokens: OK
web-contrast-rail-hover: OK (13 files, 2 hover colours)
web-contrast-hover: OK
verify-session-labels: OK (12 checks)
23/23 runners OK
11/11 rows verified
tsc: web 0 / server 0
eslint: 110 problems (0 errors, 110 warnings)
server: 19 files, 377 passed, 1 skipped（session + actions）
```

有两个 gate **故意不进**默认 suite：`verify-web-resume-chat` 与
`verify-web-new-session` 会真的 resume 一个会话 —— 那会换掉宿主的 live 会话并重启其进程。
它们单独跑、以及在 `--live` 模式下都通过，但彼此间隔执行时会争抢同一份宿主状态，
所以放进快速 suite 只会产生干扰失败而不是信号。

```
node scripts/run-web-checks.mjs          # 23/23 快速
node scripts/run-respawn-gates.mjs       # 6/6，会重启宿主的那些 gate
```

为什么单列一个 runner（有实测依据，不是拍脑袋）：`session_switch` 与 `session_new` 会让
宿主退出再回来，而这台机器上那是 45s 才有可用 composer、**约 4 分钟**才有完整会话列表。
连着跑时，后一个 gate 总在前一次 respawn 还没结束时开始，于是失败在自己的前置条件上
（`no session rows`、`turns=0`）而不是缺陷上 —— 而且**失败的集合每次都不一样**，看起来
像是没改动过的 gate 回归了。`run-respawn-gates.mjs` 在每个 gate 前后都等宿主成熟；快速
suite 靠「不知道它们存在」保持快。

行标题前后对比（真实宿主数据）：

```
改前: 4.1f / 4.1f / 4.1f / 4.1f / 4.1f / 4.1f / 4.1f / 4.1f
改后: 创建一个HTML，内容是SVG的方式画一个鹈鹕骑车的动画   01a14a9e · 29m ago
      在一个黑色的袋子里放有三种口味的糖果…             01a0fb75 · 1d ago
      resume                                          01a149b7 · 6d ago
```

模型选择行：`color: rgb(15,17,21)`（18.9:1）；改前是白色。

注入验证：恢复文件夹名分支 → `verify-session-labels` 报
`folder name is not used as the title (got "4.1f")`；恢复一处白色悬停色 → hover gate
报 4 处声明。均回退后转绿。

## 6. 为什么你仍然看到 42 次

修复合并后数字并未立刻消失，原因有两层，都查清了：

1. **计数器是进程内内存**。修好代码只会让它停止增长，已累积的数字要等一次子进程
   重启才归零。
2. **正在运行的 supervisord 是旧镜像**。Node 在启动时把 JS 读进内存，之后改 `dist`
   对已运行进程无效。实测：

```
修复构建     dist/daemon/supervisor.js   2026-10-24 15:40
dist 确是新代码：  683 noteRecycle / 695 noteRecycle / 712 noteRestart
运行进程     pid 41196                   创建于 2026-10-23 15:17  ← 早于修复
```

所以那 "42 次" 是旧进程一整天的累积，其中包含大量正常切换。

**验证（重启宿主前后对照）：**

```
旧进程:                        a44ccb97  pid=81036   restarts=42
重启子进程（父进程仍旧）:                pid=11780   restarts=0
1 次真实切换（父进程仍旧）:              pid=99160   restarts=1   ← 仍会涨
```

杀掉旧父进程 pid 41196，用新构建重启（pid 124416，创建于 10-24 16:30）：

```
重启后:                                  pid=95384   restarts=0
1 次真实切换（进 resume）:               pid=95384   restarts=0   ← 未重启，未计数
再连续 3 次切换:                         pid=123152  restarts=0   ← pid 变了，仍不计数
```

最后一行是关键：进程**确实**重启过，计数却不动。现在只有崩溃才会增加它。

## 7. workspace owner claim 报错 —— 实测结论

`supervisord.log` 里有这条错误：

```
[ERROR] [pi-maestro-teammate] workspace peer runtime failed:
  Workspace owner claim is already held by a live generation
  at pi-maestro-teammate/src/sessions/workspace-peer-core.ts:2081
```

**这一节原先写的是「它确实会让那个 Pi 子进程退出，从而合法地增加崩溃计数」。那是错的**，
而且错在它是从旧日志**推断**出来的，不是测出来的。实际测到的是：

```
18:48:50.995Z  claim 报错（1 次，发生在 supervisord 启动瞬间）
              ↓
第 1 次重启 → restarts=0
第 2 次重启 → restarts=0
第 3 次重启 → restarts=0
              pid 每次都变（说明重启真的发生了）
```

Pi 子进程**不会**退出。`claimWorkspaceOwnerIdentity` 让 `workspacePeerLifecycle`
promise reject，后果是**那个进程的 teammate workspace-peer 能力被禁用**（跨会话消息、
workspace 协调），Pi 主循环毫发无伤。remote-pi 的 `restartCount` 完全不受影响。

它为什么会出现（机制，来自 `workspace-peer-core.ts`）：

- claim 是\**文件 + 心跳文件\**。只有 `|observedAt - heartbeatAt| > staleMs`
  （`DEFAULT_PEER_STALE_MS = 20_000`）时才判定持有者已死。
- 这台机器在 `pi-maestro-teammate/workspaces` 下有 **282** 个心跳文件，其中**恰好 1 个**
  还在刷新 —— 它属于同一个 workspace 上另一个活着的 Pi。
- 于是新启动的 Pi 撞进那个 20 秒存活窗口内被拒。**这是两个活世代之间的启动竞态，
  不是僵尸 claim 卡住。**

处置：这是插件的设计（一个 workspace 一个 owner），不是 remote-pi 的缺陷，而且在此处
零代价 —— 受影响的是插件自己的能力，崩溃计数没被动过。带实测数据记下来，免得以后再
凭一行日志重新查一遍。

## 7c. 「Resume here」—— 三个缺陷，以及最要命的那个

## 7c. 「Resume here」—— 三个缺陷，以及最要命的那个

你报了两次，第二次给出了精确顺序：*完全没反应，沉默很久，然后读秒才出现，接着无限等待*。
每一段都是独立的 bug。

### 1. 没反应：标志位放在 ref 里

```tsx
switchBusy: sessionSwitchReqRef.current !== null,   // 永不重渲染
```

改 ref 不会触发 React 重渲染。所以点击时按钮毫无变化，只有当某个无关的状态变化偶然
触发重绘，它才突然显示忙碌 —— 这正是「没反应，过几秒才开始读秒」。修为 store 里
render-safe 的 `switchLoading` state。实测：待处理状态现在 **+2ms** 可见。

### 2. 无限等待：switch 根本没有超时

读取路径从一开始就有请求超时，`session_switch` 没有。回复丢失时（宿主为了重启在应答前
就退出，或那个空档里房间掉了）按钮永久停在 `Resuming…`。现用与 chat/read 相同的
ref 身份校验守卫，迟到的超时在回复已到达时是 no-op。

### 3. resume 后空白：历史被删掉且从未恢复

`session_switch_ok` 调了 `clearViewer()`，把**刚从那个会话文件读出来**的 transcript 清空，
而没有任何代码把它放回去 —— chat reducer 里压根没有「从文件灌入历史」这个动作。
所以 resume 一个有 11 条历史事件的会话，得到的是一片空白的新会话。

修法是**不要删**。查看器里的内容对「要恢复的那个会话」依然是真实正确的。第一次尝试
是保留查看器 + `rereadResumed()` 从磁盘重读（带重试跨过重启窗口）—— 那个原语选错了，
后来被撤回，见 §7d。

### 4. composer 根本不在 DOM 里

resume 后保留查看器不是一个审美选择：`TranscriptPanel` 渲染的是**查看器**或
**transcript + composer**，两者互斥。所以「保留查看器好让用户还能读历史」必然等于
「用户无法回复」。实测就是这个：

```
hasTextarea: false, sendFound: false
```

这就是为什么重读方案被放弃。resume 之后必须关掉查看器，把历史交给 live transcript ——
composer 归 transcript 所有。

Gate：`verify-web-resume-chat.mjs` 要求点击后 120s 内满足 `hasComposer && !hasViewer`。

### 5. 迟到的 `session_read_ok` 能把查看器盖回 composer 上面

这个缺陷是上面那个 gate 自己抓出来的：某一轮用户点了行、在读回复落地前就按了
Resume here，那个迟到的回复匹配上了 `sessionReadReqRef` 并调 `openViewer` —— 在 resume
已经关掉查看器**之后**又把它打开了，于是 composer 再次被埋掉。此时会话已经是 live 的，
那个挂起的读请求按定义就是陈旧的；`handleSessionSwitch` 现在在发请求前先清空
`sessionReadReqRef`，让迟到回复过不了相关性校验而被忽略。

## 7b. 「点击 Sessions 没反应」的真正原因

第一轮修复后你报了这条。读请求**并没有失败**：`handleSessionRead` 执行了、帧发出去了、
宿主也回了。缺陷在**顺序**：查看器只在 `applyRead` 里挂载，而它要等 `session_read_ok`。

```
点击 → handleSessionRead → setSessionReadLoading(true)   ← 没有任何东西渲染它
                  … 等回复 …
                      → applyRead → 查看器挂载          ← 第一个可见变化
```

所以整个等待期间，点击在屏幕上什么都没改变：没有转圈、没有横幅、没有选中态。房间掉了
时候这个等待永不结束，按钮就永久是死的。`setSessionReadLoading(true)` 是个**没有消费者**
的标志 —— 读它的组件当时还不存在。

修复：store 里新增 `beginRead(sessionId)`，在点击瞬间就挂载查看器（空事件 +
`loading: true`），回复到达后再填充。实测：查看器在 **+12ms** 挂载并显示
`Reading this session…`。

Gate：`verify-web-session-click-feedback.mjs` 断言挂载发生在 150ms 内 —— 这个预算任何
网络往返都达不到，所以通过即证明挂载是本地行为、没有在等宿主。注入验证（去掉
`beginRead`）报 `the viewer must mount after clicking a session row`。

**另外，宿主房间会静默失联。** 本次会话中两次出现：宿主进程活着、`restarts=0`，但
所有请求（包括 `session_list`）都无回复，直到重启 daemon 并刷新页面才恢复。这是
传输层卡住，不是 UI 缺陷：屏幕上那 11 行是缓存状态，所以列表看着正常、实际无响应。
恢复手法是 `remote-pi-server daemon restart a44ccb97` 再刷新。**这条本次未修** ——
需要在 relay/room 侧排查。

## 7d. live transcript 从来就灌不进去 —— 传输层把它丢了

这是两个报告症状共同的根因，它熬过了两轮修复，因为每一层单独看都是对的。

链条是：客户端发 `session_sync` 要 transcript，宿主回一个 `session_history` 帧。
**两半都不存在**。补上之后 —— `SessionHistoryFrame` 类型、`hydrateTurns()`、reducer 的
`hydrate` 动作、`sendSessionSync`、`adapter.syncSession`、带重试的 `resyncLive()` ——
仍然是 0 轮。

给 reducer 加探针后证明帧确实带着内容到了：

```
hydrate calls: [{ n: 33, turns: 3, room: "pEzLl5UwVVKF" }]
```

33 个事件进、3 轮出、房间也对 —— 但 transcript 依旧空白。reducer 根本没被执行到，
因为帧在**它之前**就被丢了。两处，同一个错误：

```ts
// client.ts —— host 房间路径
if (msg.type === "session_history") { this.roomOfRememberedSync(msg); this.emitMessage(msg, HOST_ROOM); return; }

// client.ts —— 代理子房间路径（实际走的是这条）
this.emitMessage(inner, room);
```

帧带着那个问它的 `session_sync` 的 `in_reply_to`，于是传输层把它归类成 RPC
**回复**，去查 pending 条目。但 `_forwardToRoom` 压根**不注册** pending —— 那些调用
是 fire-and-forget 的房间写入 —— 查不到就诊断成 `unknown_reply` 并丢弃。每次重试都是
「被应答、被丢掉」，一模一样，所以重试再卖力也没用。

需要两件事：

1. `session_history` 必须当作**扇出**而不是回复，无论有没有 `in_reply_to` 都要 emit。
   改在 `onHostFrame`。
2. 代理路径靠房间分发帧，所以它得知道这次 sync 是发给哪个房间的。`syncRooms`
   （id → room，上限 64，close 时清空）在 `sendSessionSync` 里记录，`roomOfRememberedSync`
   消费。

真实浏览器实测：

```
改前: turns 0，"no turns yet"
改后 +6s: turns 3，empty false
```

首次 sync 现在也会在房间打开时发出，所以全新加载页面就会自动 hydrate live transcript，
不需要用户做任何事。

### 为什么前几次注入「没抓到」

值得记下来，因为它差点造出一个假 gate。只在 host 房间路径注入丢弃 —— 仍然通过，因为
实际流量走的是**代理子房间**路径。注入到 `proxyRoomFor` 的 `sent !== null` 分支 —— 仍然
通过，因为房间本来就是已知的，它走的是普通那行 `emitMessage(inner, room)`。只有注入到
第三个位置才复现出空白 transcript。**注入没让 gate 真报红之前，gate 就不算验证过。**

## 7e. 「点 New session 什么变化也没有」—— 在清一个本来就空的盘子

`session_new` 从来没坏过。端到端追踪：宿主回 `action_ok`、退出以便重启、以 `running`
回来、扇出一个新的空 `session_history`：

```
ws_state: crashed → ws_state: running
inner: action_ok session_new
inner: session_history
```

让它看起来没反应的是 §7d：live transcript **一直是空的**，因为它的历史被丢掉了。
清一个空盘子不会产生任何可见变化 —— 那次点击和一个死按钮无法区分。

transcript 能 hydrate 之后，New session 就是正常行为：

```
transcript has content before the click (3 turns)
button showed it was starting after 4ms ("New session — starting…")
transcript became a fresh session after 3047ms
```

Gate：`verify-web-new-session.mjs`。它**先**断言 transcript 非空，这样「被清空」这条断言
不会因为一个永久空白的面板而变成空断言 —— 而那恰恰就是当初上线的 bug 形状。注入验证
（去掉 `setSessionsBusy(true)`）报 `clicking New session produced no busy state within 1000ms`。

### DSH 的语义（对照，非猜测）

逐层读过源码，不是从按钮行为反推。调用链是
`startSession()` → `openWorkspaceSession()` → `connectBlank()` → `sessions.create()`
→ `replaceMain(sessionId, …, 'reveal')`。

**行为清单：**

| 问题 | DSH 的行为 | 源码位置 |
|---|---|---|
| 会话何时创建？ | **点击时立即**。`sessions.create({workspaceId})` 同步返回一个 `SessionId`，不等任何模型/宿主回合 | `navigation.ts:209`、`service.ts:434` |
| 是否清空屏幕？ | 是，且**本地立即**完成 —— `replaceMain(sessionId, …, 'reveal')` 在 `create` resolve 后马上切 | `navigation.ts:304` |
| 没有可用工作区时？ | `clearMain()` —— 仍然离开当前会话，不留在原地 | `navigation.ts:340` |
| 目标怎么定？ | `显式 workspaceId → 当前会话所属工作区 → 最近使用的工作区`，全都解析不到才 `clearMain()` | `navigation.ts:331-341` |
| composer？ | 新会话立即持有自己的 composer；草稿可选择性初始化（`options.prompt` / `clearPreviousDraft`） | `navigation.ts:321-326` |
| 标题？ | 不在这里产生 —— 会话尚无标题，等首条消息后由会话层命名。fork 时才用 `increaseTitle` 继承并递增 | `service.ts:465-466` |
| 快捷键？ | **Ctrl+N**，通过 `aria-keyshortcuts` 公布，提示里渲染 `<kbd>` | `ui-sidebar` 测试 `sidebar-root.client.spec.tsx:105` |
| 几个入口？ | 两个（品牌胶囊 + 文字标），都调同一个 `startSession` | 同上 `:126-134` |

**我们应采用的等价语义：**

1. 点击后**立即可见**（不等宿主）——这条我们已经满足：按钮在 **4ms** 内变
   `New session — starting…`，transcript 在 **3047ms** 内变空。差别是 DSH 的切换是
   本地状态变更（瞬时），而我们的是宿主 respawn 的副作用。对我们来说宿主必须重启是
   架构事实（新 Pi 进程才能是全新会话），所以 3s 是可接受的下限，但**按钮反馈必须
   是立即的**，否则用户会以为点击丢了。
2. 已有「无工作区则不渲染按钮」的分支（`sidebarNewSession === undefined`）—— 与 DSH 的
   `clearMain()` 不同，但那是因为我们的宿主动作需要一个 cwd，属于合理差异。
3. 标题由 `firstMessage` 派生（见 §4），与 DSH「创建时不命名」一致。

**真实差异（应在 §9 处理）：**

- 缺 **Ctrl+N** 与 `aria-keyshortcuts`。这是纯增量，不影响现有语义。
- 缺**第二个入口**。DSH 的胶囊与文字标都能开新会话；我们只有侧栏那一行。
- 草稿初始化（`options.prompt`）我们完全没有 —— 不需要，因为我们没有「带预设提示开
  新会话」的入口。

## 7f. gate 逼出来的三个宿主侧缺陷

都是为了让 `verify-web-resume-chat` 稳定而查出来的，而且从 UI 自身行为完全看不出来 ——
客户端问得对，宿主也确实应答了，只是应答里什么都没有。

### 1. `session_list` / `session_read` 依赖一个刚重启的 daemon 永远没有的 ctx

```ts
const cwd = ctx?.cwd;
if (!cwd) { send action_error("cwd unavailable (no session ctx)"); return; }
```

`ctx` 来自一条命令或一个 live 事件。刚重启的 daemon 子进程两者都没跑过，所以
**整个会话面板都是死的，直到用户碰巧跑了一个 turn** —— list 和 read 双双失效。而那正是
用户会去点 Resume 的时刻，所以它表现为「每次重启后这个功能就坏了」。

daemon 子进程是以工作区为工作目录 spawn 的（`rpc_child.ts`：
`spawn(..., { cwd: this.opts.cwd })`），所以 `process.cwd()` 就是那个工作区。
`resolveActionCwd()` 现在回退到它 —— 仅限 daemon 模式，交互式会话仍用自己的 ctx。

### 2. 读旧会话时套用了 live 会话的分支过滤

```ts
const leafId = _leafIdFromCtx();            // live 会话的 leaf
const entryIds = leafId ? activeBranchEntryIds(sessionFile, leafId) : undefined;
```

分支过滤用来把废弃分支的消息挡在 transcript 外，当这个文件**就是** live 会话的文件时
是对的。套到任何别的会话上，live leaf 在那个文件里不存在，分支解析为空，
`entries.length === 0` 变成 `null` —— 一片空白且不报错。

```ts
const liveFile = _sessionFileFromCtx();
const leafId = liveFile !== null && liveFile === sessionFile ? _leafIdFromCtx() : null;
```

### 3. switch 失败会把只读查看器永久留在屏幕上

composer 在 live transcript 里面，而查看器会替换掉它。所以一个永不解答的
`session_switch`（超时）会把查看器留着、把 composer 挡在 DOM 外 —— 用户既不能输入，
也只能靠刷新页面逃出去。`clearViewer()` 现在在超时路径上也会执行。

### 为什么这些很难被发现

**一个度量错东西的 gate，恰好会掩盖这一类缺陷。** `verify-web-resume-feedback` 用
`document.body.innerText.length > 5000` 来表示「查看器里有内容」。但查看器渲染在自己的
容器里，所以一个装着 33 条事件的完整 transcript 量出来约 2.3k，而一个空的白板量出来约
2.1k：那个阈值永远达不成，于是 gate 在**每一行**上都失败，而查看器实际上渲染得完全正确。
改成度量查看器自己的 section、并要求有真实渲染出的元素而不是字符数，就好了。

## 7g. 为什么「Resume here」到 composer 要 ~2.5s、到 live 徽标要 ~18s

用户报的是「点完 30 秒才出现对话框，又过十几秒对应行才变 live，纯本地交互不该这么慢」。
用真实浏览器 + 真实宿主分阶段打时间戳实测：

```
Resume here → composer 出现:  2.4s / 3.4s / 2.4s / 2.4s
Resume here → live 徽标移动: 17.9s / 21.9s / 18.0s / 15.6s
```

所以报告里其实是**两个不同的延迟**，而只有一个算缺陷。

### composer 的 ~2.5s 是切换的成本，不是在等什么

daemon 模式下的 `session_switch` **立即应答**，然后约 150ms 后才退出：

```ts
stagePendingSwitchTarget(target.path);
sender.send({ type: "session_switch_ok", ... });
setTimeout(() => process.exit(EXIT_DAEMON_SWITCH_SESSION), 150);
```

`connect-client` 收到这个 ACK 就关闭只读查看器，composer 因此回到 DOM。所以 composer
**不等重启** —— 一次往返完成它就出现。那一次往返是 relay + `SessionManager.list`
（本机实测 **150ms** 出 11 行），所以 ~2.5s 是一次完整 relay 往返加上渲染的诚实成本，
不是卡顿。

### ~18s 的 live 徽标确实是缺陷 —— 一段被浪费掉的超时窗口

`relistAfterSwitch` 会一直重新拉列表，直到列表**真的变了**。而它的第一次请求是在
`session_switch_ok` 那一刻发出的 —— 那正是子进程开始退出重启的瞬间。于是那次请求
**注定丢失**，并且它会占住 `sessionsReqRef` 直到整个列表超时，中间每一次重试都在在途
守卫上静默返回：

```ts
if (sessionsReqRef.current !== null) return false;   // 静默空转
```

配上旧的 `SESSIONS_LIST_TIMEOUT_MS = 10_000`，这就是**一次白白浪费的 10 秒窗口**，之后
才能再发一次。最初实测正是 16.4s。

两处改动都很小：

1. `SWITCH_RESPAWN_GRACE_MS = 600` —— 把第一次重拉推迟到已知的退出窗口之后，让它有
   机会被应答，而不是明知会丢还发。
2. `SESSIONS_LIST_TIMEOUT_MS` 10s → **2.5s**。列表只是读会话文件（实测 150ms）再过一趟
   relay（~0.5s）；10s 是真实成本的 20 倍，而每一段浪费都直接变成用户可见的延迟。

改完从 relay 日志验证了重试节奏：请求间隔约 800ms（16 行日志），说明循环是真的在重试，
而不是在守卫上空转。

### 剩下那部分为什么客户端修不掉

两处改动之后最坏情况仍有 15–18s，因为宿主**确实**在那段时间里不应答。一次 switch 的
relay 日志形状如下：

```
type=session_switch_ok          ← ACK
type=session_list               ← 请求 1（宿主正在退出）
type=session_list               ← 请求 2
type=session_list               ← 请求 3
type=session_list               ← 请求 4
type=session_list               ← 请求 5
[4.1f] relay rx session_list    ← 子进程这才收到一条
type=session_list_ok
```

5 次请求都被重启窗口吃掉了。而 `supervisor.ts:747-756` 是**立即** `slot.child.spawn()`、
无退避，所以成本全在进程启动上：**光 SDK 冷导入就实测 2.4s**，这还没算会话回放、relay
重连和认证。客户端缩短不了这部分，它只能不再在真实成本**之上**额外多付时间（也就是上面
两处改动做的事）。

要真正把那 15s 压掉，得**不为了打开一个文件而重启进程** —— 那是真正的架构改动（进程内
`switchSession` 而不是 spawn 带 `--session`），已记进 §9 而不是在这里顺手做。

### 一个值得记下来的假线索

`SessionManager.list(cwd)` 看起来是最明显的嫌疑（每次切换都全量扫）。直接实测：
**150ms，11 行**，连续三次。先把可疑的东西量一遍再动手，省掉了一次无意义的优化，
并把调查方向推到了重试循环上。

## 7h. 「Could not load this workspace's sessions. Press refresh to retry.」

这就是用户报的那句话。它是**真缺陷**，不是文案问题。面板在「列表为空且 notice 已设」时
渲染它：

```tsx
{sessions.length === 0 ? (
  <p>{notice !== null
    ? "Could not load this workspace's sessions. Press refresh to retry."
    : busy ? "Asking the host…" : "No sessions in this workspace yet."}</p>
)}
```

所以问题是：宿主明明过一会儿就能应答，为什么 notice 会被设上。

### 根因：一次超时就永久放弃

`requestSessions` 在**第一次** `session_list` 超时时就设 notice，然后**不再重试**。而工作区
Pi 重启要 ~15s（光 SDK 冷导入就 2.4s，见 §7g），那个窗口里 `session_list` 根本无人应答 ——
所以第一次超时是**必然**的，而提示一旦写上就永久留着。

同一场景下的 A/B 实测（新开页面 + 宿主正在启动，全程**不点任何 refresh**）：

```
SESSIONS_RETRY_BUDGET = 0   → err=true 持续 70+s，rows 一直是 0
SESSIONS_RETRY_BUDGET = 8   → +9s / +17s 恢复，err 全程未出现
```

这就是用户报告的场景被复现、然后被修掉。

### 修法

列表请求超时后从**有限预算**里自动重试，且在有预算时**不设 notice** —— 面板继续说
「Asking…」（这是真话），而不是声称历史没了（这不是真话）。只有预算耗尽才报失败。

```ts
if (sessionsRetryLeftRef.current > 0) {
  sessionsRetryLeftRef.current -= 1;
  setTimeout(() => requestSessionsRef.current(undefined, true), SESSIONS_RELIST_MS);
  return;                       // notice 保持清空
}
setSessionsNotice(SESSIONS_FAILED);   // 只在预算用完后
```

### 修法里自己引入的 bug，也是靠量出来的

第一版在每次调用（**含重试**）都重置预算 —— 于是计数器永远到不了 0，失败提示**永远不出现**。
面板停在「Asking…」，`asking=false`，屏幕上什么也没有。
是靠把 `SESSIONS_RETRY_BUDGET` 注入成 3、然后等那个**本该出现**的失败却一直没等到才发现的。
现在 `isRetry` 区分「超时重试」与「用户主动请求」，只有后者重置预算。

两个方向都在 `verify-web-sessions-warmup` 里做了注入验证：`BUDGET = 0` 必须复现那句话，
`BUDGET = 8` 必须不出现。

## 7i. 「Resume here」→ 历史要 ~15s，而且这段等待在**骗人**

用户的报告很具体：打开 `01a1499d` 这个会话，点 **Resume here**，等了一分多钟才看到历史。
本 plan 之前测的是「composer 挂载」和「LIVE 徽标移动」——那两个都不是用户等的东西。**只有去
量 transcript 本身**，才把下面两个问题同时暴露出来。

### 时间到底花在哪（同一时间线实测）

```
按下 Resume here
  +1s   宿主重启（pid 36612 → 136844）
  +15s  历史可见（8 行）

重启之后到历史出现：14s
```

多次重复：**15s / 16s / 17s / 16s / 15s**。所以延迟既不是请求卡住，也不是重试节奏 ——
就是重启本身。daemon 模式下 `session_switch` 先把目标文件存好然后退出，`supervisor.ts:747-756`
用 `--session <path>` 立即重启、无退避：

```ts
if (evt.code === EXIT_DAEMON_SWITCH_SESSION) {
  slot.child.spawn();          // 新 PID、新进程，不复用
```

冷启动的成本直接量过：**光 SDK 导入就 2.3s**（2.295 / 2.237 / 2.270），这还没算回放一个
464KB 的会话文件、relay 重连和握手。

### 真正可修的那个缺陷：这段等待显示的是**假话**

那 14 秒里 transcript 渲染的是通用空态：

> **What should the agent work on?**
> This workspace has no turns yet. Pick a workspace on the left…

用户刚要求看这个会话的历史，应用却告诉他这个工作区没有任何对话。**这比慢更糟** —— 它读起来
像「你的历史没了」。

根因是个标志位错配：面板把「重开中」绑在 `switchLoading` 上，而这个标志在
`session_switch_ok` 一到就被清掉 —— 而那个 ACK 是在子进程退出**之前**发出的
（`setTimeout(() => process.exit(…), 150)`）。于是这个标志几乎没盖住真正的窗口。

修法是用一个专用状态 `resumingSession`，由 `resyncLive` 拥有，从 ACK 一直保持到 transcript
真正被填满：

```tsx
) : resuming ? (
  <EmptyState
    icon="cpu"
    title="Reopening this session…"
    detail="The workspace's Pi is restarting to open this session. Its history
            appears here as soon as it is back — nothing was lost."
  />
) : (
```

同一个会话的前后对比：

```
改前：+3s 出现假空态（"What should the agent work on?"），一直持续到 +16s
改后：+3s 显示 "Reopening this session…"，+16s 历史出现，假空态从未出现
```

注入验证：强制 `resuming: false` → gate 在 +3s 报出假空态，并连续 13 秒如此，判红。

### 没修掉的部分，以及为什么

那 14 秒的进程启动还在。要消掉它，就得**不重启 Pi 也能打开会话文件**，而 daemon 今天做不到：
`switchSession` 在 `ExtensionCommandContext`（SDK `types.d.ts`）上，RPC 模式的子进程永远拿不到
——这个约束正是这条路径要重启的原因。SDK 确实暴露了
`AgentSessionRuntime.switchSession(sessionPath)`，所以进程内切换**可能**可行，但那是架构改动
（会话状态机 + extension 生命周期），不是调参，已记进 §9 而不是在这里动手。

## 7j. 有个 gate 在往用户的真实会话里写测试消息

`verify-web-draft-per-session` 验证两件事：草稿能跨会话切换存活，以及发送成功后要清空。
为了验证第二件事，它**真的点了提交**，于是把 `draft-survives-switch-<时间戳>` 发进了当时
处于 live 的那个会话。

这些字符串进了用户的 transcript，也进了 Pi 的上下文。而且这个 gate 已经被加进 respawn
suite —— 意味着以后每次跑都会再多几条。

### 修法：拦住帧，保留代码路径

gate 现在在页面加载前装一个拦截器，只吞掉聊天帧：

```js
if (inner2.indexOf('"user_message"') >= 0) { window.__blockedSends.push(...); return; }
```

`handleSend` 仍然完整执行（包括 `setDraft("")`），所以断言的含义没变，但什么都不会离开
浏览器。gate 还额外断言「确实拦到了帧」—— 否则一个「自己就清空了」的草稿会以错误的理由
通过：

```
OK: the draft clears after a successful send (1 send_chat frame(s) blocked at the socket)
```

验证方式是数会话文件里的 marker：跑两次前是 3 个，跑完还是 3 个，没有新写入。注入验证
（去掉 `setDraft("")`）仍然会让 gate 报红。

### 这件事付出的两个代价，如实记下

- 聊天消息的线上类型是 `user_message`，不是 `send_chat`（后者只是 adapter 的方法名）。
  匹配错了字符串，让第一版拦截器静默失效。
- 为了查清帧结构，在拦截器还不存在时又发了一条真实消息（`probe-frame-shape`）。
  **测试用的探针不该拿真实通道去猜协议。**

## 7k. transcript 里的用量、速度与缓存统计

用户要求照搬 DeepSeek Harness 的统计 UI，而且**必须是真实数据，不能是空架子**。数据其实一直都有 ——
只是在到达客户端之前就被丢掉了。

### 数据就在下一层，被丢在半路

SDK 在每条 assistant 消息上都带完整账目：

```json
{"input":32634,"output":210,"cacheRead":4608,"cacheWrite":0,
 "reasoning":125,"totalTokens":37452,"cost":{…}}
```

（直接读真实会话文件验证过。）但 `server/src/session/history.ts` 只留了两个字段：

```ts
// 改前
return { input_tokens: usage.input, output_tokens: usage.output };
```

缓存那部分在 mapper 里就被销毁了。客户端再怎么改都不可能找回来 —— 这也正是第一次尝试
（改的是 `index.ts` 里**另一处** usage）的结果：pill 能渲染，但永远显示 `缓存命中 0%`。

从源头修：`Usage` 现在带 `cache_read_tokens` / `cache_write_tokens` /
`reasoning_tokens` / `total_tokens`，history mapper 和实时 `agent_done` 两条路径都把
它们透传出来。

### 实时路径为什么也要改

`agent_done` 是在 `agent_end` 里发出的，那时携带 usage 的那条消息已经出了作用域。在
`message_end` 时缓存一份 `_lastTurnUsage`，实时 turn 才能带上真实账目 —— 否则只有从磁盘
重新读一次才会出现数字，流式的那一轮在最该看的时候反而像是坏的。

### 解码速度不是端到端吞吐

第一版用「输出 token ÷ 该轮总耗时」，对同一个会话报出 **17 tok/s**，而模型实际解码是几百。
因为总耗时里包含工具执行、排队和思考。

DSH 做了同样的区分（`decodeMs`/`decodeTokens`）。改用「该轮首条 assistant 消息到末条」的
跨度，同一份数据得到 **121 tok/s** —— 而整轮只有一条回复时没有跨度，速度就直接不显示，
而不是报一个无穷大。

### 做了什么

| 部件 | 文件 | 读数 |
|---|---|---|
| composer 状态栏 | `stats-pills.tsx` | `9 轮 9 步 · 121 tok/s` · `462K tok · 缓存命中 97%` |
| 轮次分隔线 | `turn-divider.tsx` | `已完成，用时 3秒` + 0.5px 细线 |
| 消息 footer | `message-footer.tsx` | `51.4K tok` · `02:34` · 复制 |

样式照搬 DSH：分隔线用 `border-bottom: 0.5px solid var(--dsw-alias-border-l2)`、33px 高、
tertiary 文字色、chevron 旋转、hover 时 `color 100ms ease` —— 全都是本产品已有的 token。

**不渲染任何 0。** 宿主没发的读数就是缺失，不是 `0`：这个区别正是真仪表盘和占位符的分界，
也是注入测试能成立的前提。

### gate

`verify-web-usage-stats.mjs` 断言：轮次数非零、速度非零、总量非零、缓存命中非零、至少一条
分隔线带时长、footer 里有 `HH:mm` 时间戳。

```
OK: activity pill reports turns/steps: 9 轮 9 步 · 121 tok/s
OK: decode speed is a real number: 121 tok/s
OK: usage pill reports a token total: 462K tok
OK: cache-hit share is a real percentage: 97%
OK: 9 message footers show a token total (51.4K tok)
OK: 9 message footers show a clock (21:25)
RESULT: PASS
```

注入：把 `cacheReadTokens` 清零，gate 报 `the cache-hit share is not a real reading (0%)`，
同时总量从 462K 塌到 28.1K —— 反证缓存确实是这个数字的主体。

### 状态栏必须跟随**输入框**的宽度，而不是整列

pill 一开始跟着 `composerPad` 撑满，而输入框自己在 `min(860px, 100%)` 里居中。
1600px 下读数跑到整列最左边，而输入框在 482px 处 —— 窗口越宽，两者漂得越远。

修法：包一层 `.composerDock`，重复输入框自己的
`margin-inline: auto; max-width: min(860px, 100%)`。

第一版还加了 `padding-inline: 16px`，想让第一个 pill 与输入框里的**文字**对齐。结果 dock
比输入框窄 32px，错位只是从「左边缘」变成了「两边都错」。CSS 里现在写明了这条规则：
**外框必须一致**；pill 自己带 2px 内缩。

`verify-web-dock-alignment.mjs` 用几何方法在六个宽度下测量
（1600/1280/1024/900/760/620 —— 两个断点 + 860px 上限的两侧），对比与输入框的左、右、宽度差：

```
OK: aligned at 1600px — form[482..1342] dock[482..1342] Δleft=0 Δright=0 Δwidth=0
OK: aligned at  900px — form[332..820]  dock[332..820]  Δleft=0 Δright=0 Δwidth=0
OK: aligned at  620px — form[318..548]  dock[318..548]  Δleft=0 Δright=0 Δwidth=0
```

注入（去掉 max-width）只会让 1600px 那一档变红，窄屏仍然绿 —— 这正是「只测一个宽度」不够的原因。

### 两个 gate 的教训，记下来

- 第一版在测量前先点了一个会话行。点非 live 行打开的是**只读 viewer**，它没有 composer，
  也就没有状态栏；gate 于是对着一个完全正常的页面报「no dock」。
- 加轮次分隔线需要拿到前一个 chat item，差点把 `index` 带进 `chat.map`。
  `verify-web-chat-rows` 刻意禁止这种写法（index 进 key 会在重排时出错），所以分隔线
  改为放进 `AgentRow` 内部。**旧 gate 是对的，新代码是错的。**

## 8. 有意未做

- **默认直连。** 两个模型都把它排在「修原语」之后，gpt-6.1-sol 还提了我认可的安全要求：
  浏览器的 `localhost` 绝不能被假定为远端主机。loopback 路径已存在（`plan/73`），
  要自动化它需要的是主机认证，而不只是一个开关。
- **乐观 transcript 切换 / 热进程池。** step-5-preview 的第一阶段（乐观切换 + 预取）
  是下一步的正确方向，但它会改客户端状态机，不该搭在 bug 修复批次里一起走。
- **自动标题或重命名。** step-5-preview 正确指出：一个文件夹里 11 个会话说明用户在拿
  会话当任务用。那是产品决策。

## 9. 下一步

上一版这一节的四个未决项**全部已完成**；实测数据记在下面，免得被重新翻案。

### 已完成

1. **New session 的 Ctrl+N** —— `aria-keyshortcuts="Control+N"`、`<kbd>` 提示，以及
   真正走**同一个** `onNewSession` 的绑定。Gate：`verify-web-ctrl-n`（5 条断言，
   注入验证过）。
   加聚焦守卫时发现 Ctrl+B / Ctrl+J **本来都没有守卫** —— 在 composer 里按 Ctrl+J 会
   切 dock，句子打到一半界面跳掉；现在三个快捷键共用守卫。
2. **行 hover/focus 预取 `session_read`** —— 120ms 去抖、同时只允许一个在途、8 条上限
   的缓存、回复被分流所以悬停**不会**弹查看器。实测：冷路径点击到内容 ~5000ms，预热
   **55ms**。Gate：`verify-web-read-prefetch`（注入验证过）。
3. **宿主房间卡死**（§7b）—— 用 45 分钟、270 tick 的探针查证，抓到**3 次真实失联与
   3 次恢复**：relay 的 liveness watchdog 本来就能在 20s 内自愈，所以「恢复手段是重启
   daemon」已经过时。真正活下来的缺陷是 **UI 说不出来**：socket 开着，pill 就写
   "host connected"，哪怕每个请求都无人应答。修法是记录入站帧年龄
   （`lastInboundAgeMs`），超过 75s 就显示 "host not responding"。
   Gate：`verify-web-host-liveness`（95s，用 CDP 离线模拟做注入验证）。
4. **每会话独立草稿** —— 按 live session id 键控；`resetChatState` 不再清它，所以切换或
   resume 都不会销毁已输入内容。只有发送成功才清除。Gate：
   `verify-web-draft-per-session`（switch 与 new-session 两条路径都注入验证过）。

### 仍未决

5. 只有在主机认证就位后，才决定直连是否作默认 —— 与上一版相同，这仍是产品决策而非
   实现缺口。
6. **打开会话而不重启进程。** §7g 量出了 resume 的真实形状：客户端现在只付诚实的成本，
   但宿主仍要花 ~15s，因为 `session_switch` 是用 `--session <path>` **重启** Pi
   （`supervisor.ts:747-756`），而光 SDK 冷导入就 2.4s。daemon 路径之所以存在，正是因为
   `switchSession` 需要一个 RPC 子进程永远拿不到的 `ExtensionCommandContext` —— 所以去掉
   重启意味着要给子进程一个**进程内**重开会话文件的能力，那是架构改动，不是调参。
