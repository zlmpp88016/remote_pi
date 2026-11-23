# Plan 86 — Web / App 工作区与历史会话的查询性能

状态：用户已批准，实施中。2026-11-16 调查基于 `d8bcf74c`；批准 handoff `97e9b337aa68d16357c3634e2b66f15eeaf40087e0cd9407148fec8dd003c2ce`。P0/P1已完成，P2核心索引与隔离规模基准已通过；生产追加/完整分页/快照边界由合并修正Todo #48闭合，Web #43与App #44并行接入；尚未提交或部署。

2026-11-17结算：P0–P5实现与隔离集成取数已完成；**本轮范围修订、最终结果及未通过项以§8为准**。上面的阶段状态及下文原批准要求作为历史保留，不表示所有原始目标已通过。未提交、发布或部署。

## 1. 背景与目标

优化三条用户路径：打开工作区、打开该工作区的历史列表、打开指定历史会话并看到真实消息。覆盖 Web 与 Flutter App；服务端查询是共同基础。

核心方向：**浏览历史不启动或切换 Pi；查询成本主要随本页与新增数据增长，不随全部历史大小增长；缓存与渲染都有边界。** Pi 的启动只属于显式“继续对话”。host 查询架构与 App 点击语义的调整已获用户批准，决策追加于 `plan/00-decisions.md`。

沿用 `plan/00-decisions.md` 的 host-first、显式工作区目录、持久配对与既有隔离约束。冻结配对 URI 字段/顺序与 Hive 名 `msgs_<epk>__<roomId>`。不改为另一套连接/认证协议。

## 2. 证据与限制

证据分为本轮实测、当前源码确认、待验证目标。旧文档的 9.6 秒读取不能归因为本轮磁盘解析，也不能代替本轮基线。

### 2.1 本轮公开链路实测

服务：`http://ht.wwszxc.tax:41533`。隔离 headless Chromium，1600×1000；不接触用户 Chrome。公开 bundle `/assets/index-DwacC1nK.js` 与本地 `clients/web/dist` 的 SHA-256 相同：`06b9d2b3dc04b80a9efaa11b022298ad322ae9b6c7748915a583fbf1c5b51cd4`。

| 场景 | 样本 | 结果 |
|---|---:|---|
| 页面重新加载到工作区目录应答 | 3 | 2.149–2.825 秒（包含页面与重新配对） |
| 页面重新加载到 live history 应答 | 3 | 3.157–3.606 秒 |
| 已连接时再打开运行中工作区，到 history 应答及两个 rAF | 3 | 中位 1.217 秒，范围 1.199–1.364 秒 |
| 刷新 46 条历史列表，POST 发出到应答 | 5 | 中位 679 ms，范围 387–1174 ms；外层帧 16,225 B |
| 点击 5 个历史会话到首批真实内容 DOM/rAF | 5 | 中位 629 ms，范围 487–983 ms；8–31 个事件，外层帧 3.4–33.4 KB |
| 预取已完成再点击 | 1 | 内容在 +32.7 ms 的 rAF 可见；双 rAF 观察返回 +68.8 ms；点击后零请求 |

额外观察：

- 3/5 次鼠标移入后立即点击发出同会话的两次 `session_read`。冗余预取还会占住后一次读取的 POST 队列。
- 打开工作区时，`session_sync` 的 POST 等前一条 `session_list` POST 完成，额外等待 416–542 ms。等待的是 HTTP 204，**不是业务查询应答**。
- 一个较重历史页面产生 94 ms long task；其余被测样本没有 long task。不能推断全部 Markdown 场景都快或都慢。
- 本轮没有观测到模型预取占队列，故其影响只有源码顺序证据，没有收益数字。
- 样本数不足以报 p95/p99。上述 UI 时刻是 DOM 在帧边界可见，不声称测到了物理屏幕像素。

### 2.2 本轮合成规模基准

运行**现有编译模块**，不改算法，不导入 `server/index.js`。Node 22.19.0 / Windows x64 / Ryzen 7 5825U；所有 JSONL 与 SQLite 在独立 scratch home。文件系统缓存是热的；“空索引”不等于 OS 冷盘。

| 同样只返回末 30 条，正文哈希相同 | 1 MiB 文件 | 10 MiB 文件 | 100 MiB 文件 |
|---|---:|---:|---:|
| 全文读取、解析、排序、取页，中位（各 3 次） | 17.4 ms | 123.4 ms | 1615.0 ms |
| 再加活跃分支读取，中位（各 3 次） | 27.7 ms | 300.0 ms | 2496.9 ms |

返回内容始终 2577 B；`setTimeout(0)` 被推迟的时间与同步工作相近。普通历史读一次全文件，**只有读取 live 文件且有 leaf 时才再读一次做分支过滤**。不能把“双读”泛化到所有历史。

| 列表索引场景 | 空索引（单次） | 不变文件热查（3 次中位） | 追加后查询（单次） |
|---|---:|---:|---:|
| 3 个文件，约 111 MiB | 1328 ms | 1.5 ms | 1092 ms，重读整个 100 MiB 文件 |
| 1000 个小文件，约 557 KiB | 6449 ms | 49 ms | 49 ms，仅重解析 1 个小文件 |

`lastIndexStats` 证实解析数依次是 `3→0→1`、`1000→0→1`。1000 行列表正文约 334 KB，尚未包含全部传输封装。

SDK 首次 priming 独立耗时 **43.244 秒**，已从上表排除。它说明新 host 读服务不能顺手拉入 SDK 整个顶层依赖图；不代表每次查询都花 43 秒。源码与 dist 手工核对且 hash 未变，未重新编译证明编译等价。

### 2.3 App 本轮观察与未测边界

已有 Android 15 模拟器保留数据启动、恢复 guest hosts，安装版本 1.2.0+8。打开运行中工作区，时间戳截图得到首列表可见的保守区间 **1.124–2.801 秒**，仅 1 次、不是精确 RTT。此前一帧仍是加载，后一帧已渲染会话行。

本轮没有点历史行：现行为会切换用户的 live 会话。上轮真实 Android 验收的 Pi respawn **31–143 秒**仅作为历史证据，源码已确认这条依赖仍在。未新测停止工作区的冷启动、iOS 真机、App 本地 apply/Markdown 分段或断网恢复。本轮 Android 不能代替 iOS 验收。

原始证据：

- `C:/Users/zlmpp/.pi/agent/tmp/remote-pi-perf-20261116/web-baseline.json`
- `C:/Users/zlmpp/.pi/agent/tmp/remote-pi-perf-20261116/bench/{benchmark.mjs,results.json}`
- 同目录 `app-list-timings.json`、`app-list-{1,2}.png`
- 查询基准不可变输出：`agent://3ca988df-09b7-49a2-9c86-831dec00d3e2`
- 源码调查：`agent://5c2d640b-dd76-43e3-923b-5162367e0678`、`agent://22e3eb67-65db-47ba-b05f-cf567e07acc6`、`agent://bb7e65e2-a416-41b7-9fa4-451aaadab23d`；其中旧耗时归因与双全读泛化以本计划的 root 核验为准。

## 3. 当前读取链路与已确认问题

| 路径 | 当前行为与证据 | 主要代价 |
|---|---|---|
| 工作区目录 | host `host_bridge.ts:495` → `Supervisor._catalogEntries`，`supervisor.ts:1062` | 小型配置读取；未证明是主要瓶颈，不单独堆缓存 |
| 工作区会话列表 | Web `connect-client.tsx:906`；App `session_list_viewmodel.dart:117`；host 代理至 Pi child | Pi 未就绪就不能回答；App 页面先 await start（`workspace_list_page.dart:201`） |
| 列表索引 | `server/src/actions/session_index.ts:336` | 每查 readdir + N stat；变更文件全文重解析；冷建多次单行写入 |
| 指定历史读 | `actions/handlers.ts:509` 再全量 list 授权，`index.ts:5386` → `session/transcript.ts:185` | 同步全文解析、全量排序后才截页；工具父引用逐结果反向扫描（`:133`） |
| Web 传输 | `sse-transport.ts:329` | 一次只 POST 一帧，list/sync 串行；不是等待业务 reply |
| Web 预取与分页 | `connect-client.tsx:540,628`；`use-session-store.ts:272`；`dispatcher.ts:250` | 预取与点击不共享在途任务；缓存仅 session id；有上限无 revision 失效；丢失预取无独立终止；older cursor 未进入 UI |
| Web 渲染 | `session-viewer.tsx:202`；`connect-client.tsx:2487` | 全页 mount Markdown；容器更新重复投影 live 列表，尚无规模上限 |
| App 历史打开 | `session_list_page.dart:145` → `SessionListViewModel.pick` | 没有网络只读历史入口，直接 once `session_switch` → Pi respawn |
| App apply/分页 | `sync_service.dart:1708,1742`；`data/repositories/session_read_repository.dart:42` | 每 row await put，每 BoxEvent 重排列表，VM 再全投影；翻旧页重新编号改写已有行 |

限制单位也须统一：Web 请求 50，host 默认上限 30，且上限作用于 transcript entries；工具父引用补齐、一个 assistant entry 多块展开会使 wire event 数不同。不能以“恰好返回 30 个 event”作为验收。

## 4. 拟采用的结构与契约

### 4.1 host 原生读服务，运行态与磁盘历史分离

在 `server/src/session/` 放无 SDK 依赖的读域，由 host bridge 直接调用；控制逻辑仍归 daemon。预期模块是 `history_service`、`history_index`、`history_worker`，不是另起常驻服务。

- host 从现有 fleet 用 `daemon_id` 解析已注册 cwd，再派生 agent session bucket；不接收客户端文件路径。
- 新增能力 `workspace_history_v1` 与 host-room 只读帧家族 `history_list`、`history_read`、`history_body`，通过既有配对连接发送。
- `history_list`：`id, daemon_id, limit(默认50/最多100), before?, if_revision?`；返回 `in_reply_to, daemon_id, revision, sessions, next_cursor, has_more, index_state`。
- `history_read`：`id, daemon_id, session_id, limit(默认30/最多100), before?, snapshot?, if_revision?`；返回会话身份、snapshot、稳定 `items`、older cursor/has_older。item 含 `event_id, entry_id` 与既有事件投影；大字段另有 `body_ref`，不改旧 `SessionHistoryEvent` 的必需字段。
- `history_body`：按同 workspace/session/snapshot 的不透明 body_ref 分块读取，单块最多64 KiB解码后正文/资源字节，经base64传输；返回 `representation, offset_bytes, next_offset_bytes, total_bytes, data`。文本是 `text_utf8`，tool args是完整有效JSON值的 `json_utf8`，图片是 `binary`+mime；offset始终属于该representation的字节流，不是UTF-16下标或JSONL源偏移。不把body_ref当路径。首次物化返回building而不是空正文。
- 首次未建索引允许明确 `index_state=building`，完成后由客户端用单个在途任务重查；不能把构建中说成“没有历史”。无数据只有在扫描完成后才成立。
- 旧客户端、旧 host、interactive extension 保持原 `session_list/read/sync/switch`。新客户端缺能力时回退旧只读查询；仅缺只读能力时显示限制，不把浏览动作偷偷升级成 switch。
- live `session_sync` 的分支与内存状态仍由 child 权威负责；共同磁盘原语可复用，但不以 host 猜测 live leaf。read-only 历史不灌进 live transcript。
- `current_id`/ready 由 supervisor 的独立运行态快照补充，未知就标未知；不从“最新磁盘会话”猜当前会话，不为了徽标等 Pi 就绪。

### 4.2 数据结构与查询复杂度

沿用SQLite技术，但新host索引使用独立 `~/.pi/remote/history-v1.sqlite`（同样服从REMOTE_PI_HOME），**不迁移、不写入旧 `index.sqlite`**。JSONL保持真源；不引ORM/外部数据库，不把完整正文复制进SQLite。

写入所有权按数据库定义：唯一活动supervisor拥有history-v1数据库；其一个writer worker独占DDL、schema migration、upsert/delete与generation发布。另一个worker仅持read-only连接，解析/读取请求有界排队，任何更新交回writer。迁移时先关闭reader，事务完成后重开；不完整generation不对外发布。仍运行旧代码的child继续独立读写index.sqlite，与新库无表/迁移冲突；host不信任旧缓存为真源。新child如复用解析算法只能复用纯函数，不得另开history-v1写连接。旧帧兼容路径可继续原实现，新能力历史浏览走host；不把“共享底层”解释成跨进程共写新库。

| 索引对象 | 必需信息 / 索引 |
|---|---|
| session 元数据 | workspace、session id、规范化内部 path、name、首条 user preview、活动时间、file identity、generation、indexed byte offset、未完末行；`(workspace,mtime DESC,id DESC)` 与 `(workspace,id)` |
| entry 元数据 | generation、entry id、parent id、时间、role/type、byte offset/length、≤4 KiB预览/事件摘要；`(file,generation,timestamp,id)` 与 `(file,generation,entry_id)` |
| body 定位 | `(generation,entry_id,field_path)`、源JSON值span、representation、解码字节数/摘要；仅存定位与有界预览，不存整段正文 |
| tool 引用 | tool call id → 声明 entry；结果引用可直接查父，不再每条复制/反转整历史 |
| 构建状态 | workspace/file 完整性、revision、高水位、错误/进度；不将残缺索引当完整目录 |

- 正常页：索引seek后，小entry position-read解析；巨型entry直接从已索引的有界摘要生成预览/body_ref，不为首屏读整行。复杂度为 `O(log entries + page bytes + tool parents)`，不重读100 MiB来取30条。
- 单行也可能巨大。冷建的流式JSON tokenizer在有界缓冲区里同时提取metadata、字段源span与文本预览，跨chunk保留escape/UTF-8状态；不能用readline先凑完整巨型行再JSON.parse后声称有界。完整坏行或半行不发布部分metadata。
- 首次显式展开body，由worker从选定源span做一次流式解码/物化，写受保护的generation-scoped临时sidecar；同ref并发single-flight。之后按representation字节position-read，每块不重解析源entry。text解JSON字符串escape；args物化为有效JSON值UTF-8；图片解码为原始二进制。客户端文本用有状态UTF-8 decoder，不能把被切开的多字节序列逐块独立decode。
- sidecar初始磁盘预算256 MiB、LRU；单body若超预算则返回明确body_too_large并保留原文件，不宣称完整加载。淘汰后仍有效snapshot可重新物化，重写/删除则stale并清理。首展开的O(body bytes)成本须单列，不伪装成64 KiB随机读。
- 热列表：已就绪目录从 keyset 索引取50行；前台不 readdir/stat 所有文件。目标 session 读取只校验目标文件及授权映射，不扫描其余会话。
- cold build/未知改动：受限 worker 进行单遍流式解析，同时更新元数据、parent/offset/tool 表；成批事务，避免1000次独立落盘。worker 队列有背压、同文件构建 single-flight。
- 最多两个worker：前台页读取优先，后台构建最多1个；SQLite WAL和写入所有权按上段执行。构建事务按有界批次commit，reader只看已发布generation。所有同步SQLite/大解析放worker，host控制面不能被大文件堵住。
- 正常 Pi append：保留完整行 byte high-water，只处理新增完整行；半行留待下次完成。缩小/替换/重写、parser版本改变、缓存损坏均换 generation 并重建，不能使用旧偏移。
- append 快路必须有受支持 writer 的追加语义或可验证的 generation 通知；不能仅凭 size 变大就证明旧前缀没改。未知外部修改走保守重建。mtime/ctime/文件身份与前后 stat、边界校验是检测手段，不宣传为完整前缀证明。
- fs watcher 仅作失效提示；结合断线/溢出后 reconcile、启动 reconcile、活跃文件变更通知与显式刷新。前台命中可以先展示**标注的旧缓存**并刷新，不能永远信任漏事件的 watcher。
- 删除必须撤销元数据、页缓存与body引用；同大小同mtime改写、路径替换、目录删建必须覆盖回归。缓存不可用走受限异步扫描/构建，不能回退到host主线程SDK重扫。

### 4.3 snapshot、分支与大小限制

- 新 cursor 绑定 workspace/session/file generation、固定 high-water、排序边界 `(timestamp,entry_id)` 与投影版本；服务端验证字段，不跨会话复用。旧 timestamp-only cursor 仍由旧路径处理。
- append 不改旧页快照；同时间戳的不同 entry 不漏、不重复。重写/删除返回明确 snapshot stale，客户端有序重开，不能混拼两代数据。
- 历史读取保持已发布的非 live 线性投影；不得把别的 live 会话 leaf 过滤套上去。live sync 仍严格跟随 child 的 branch version。索引保留parent图，分支结果单独按leaf版本缓存；未知branch不能伪装为正确active分支。
- 工具父引用补齐不改变 primary page cursor，去重靠规范entry/event id；不能靠数组index或时间戳当消息身份。
- 新帧完整封装后上限256 KiB，单个行级预览不超过4 KiB；limit是上限，组包计入base64/JSON封装与工具父引用的实际预算，装不下就少取primary items并给续页。巨型项至少返回有界身份/预览/body_ref，不能形成永远无法前进的游标。完整原始数据在body预算内可按需取回；超预算明确拒绝完整展开，不能静默丢消息或把预览当完整。
- 热页 LRU 初始32 MiB/进程；客户端页缓存初始8 MiB、最多8会话。按实际UTF-8内容大小计费，避免8个巨型会话仍吃满内存。
- 缓存键至少为 host peer + workspace id + session id + generation/snapshot + projection/branch + page cursor。reconnect、删除、版本变化、显式刷新、switch/reset 逐作用域失效；迟到回复还须匹配request id与页面generation。

### 4.4 Web 与 App 消费

- Web hover/focus与click使用同一在途任务；点击提升优先级并订阅结果，不再第二次请求。失败/超时/离开作用域释放所有订阅与single-flight。缓存命中先画并条件校验，不能让老内容冒充最新。
- 已连接工作区打开，列表/当前历史可独立调度；前台读优先于模型预取。SSE仅对明确allowlist、同连接/房间generation的独立历史读最多2个POST并发，按request id处理乱序；认证/握手仍原序。遇写先提升epoch作废旧读应用资格、排空已发POST，再串行写；后续读等该写的业务ACK或确定终态，而非仅等204。超时保留原写的不确定态处理，任何write失败不重放。先写确定性ordering/迟到读测试再启用，不改为所有帧无序并发。
- Web保留每workspace列表与已打开页；切回先显示自身缓存，不显示另一workspace的页。消费older cursor、稳定ID去重，支持真正读旧页。主题/宽度/内容revision影响Markdown渲染缓存，不能只按文本长度缓存。
- Web列表复用React已有keys；大列表按页加载。历史先渲染可见窗口，其余通过占位高度与接近视口再挂Markdown；离开视口的项有边界回收，不能随着加载旧页最终全量mount。保持复制/链接/滚动锚点。
- App新增独立历史viewer repository/viewmodel/route，页缓存与live Hive隔离，不改冻结box名。点workspace先进入页面并读取host目录；不await workspace_start，也不自动启动Pi来浏览。
- App点历史先查看；“继续对话”按钮才调用既有once-switch流程，明确影响已配对客户端。composer在read-only状态不可误发；只有目标身份/ready已确认才允许向目标发送。
- 旧host可在Pi已运行时使用旧session_read只读路径；不能把缺能力自动降级为session_switch。配对不变。
- App live sync apply仍保留差量与重复history零写入。批量put与批量**通知**一起做：Hive putAll也可能逐key发事件，必须显式整批coalesce，完成才发布不可变snapshot。新流式单条仍增量更新。
- 翻旧页使用稳定持久seq，不为前插把已有消息全体重编号；已有整数key/索引需要带版本的幂等迁移，先写迁移回归再启用。显示层不能偷偷混用新旧排序。

## 5. 实施阶段、归属与验收

依赖：`P0 → P1 → P2 → {P3 Web, P4 App}`；P5 App apply/渲染可与P3并行，但须跟P4的存储隔离接口对齐。每阶段覆盖该状态机的全部已知边界，不逐个发现、逐次重审。

### P0 — 可复用的分段测量（Extension / Site / App）

- 固化请求数、排队、发出→回复、query/index解析数/bytes、decode/apply、首个真实内容帧、long task/frame耗时的观测。日志只含id、计数、时间，不含消息正文、token、ct。
- 只用隔离fixture与已批准的只读真实通道。分别标识进程冷、索引冷、OS-cache冷、网络冷；禁止混称cold。
- 验收：同一场打开能解释总耗时分段；warm/cold-index及1/10/100 MiB、1000会话可重复，仍有效基线直接复用；真实用户会话零prompt/switch。

### P1 — zero-Pi host读服务与能力协商（Extension）

- 实现4.1契约与完整typed parser/错误码，读域不导入SDK顶层；暂可用worker中的现有扫描实现，再由P2替换。
- 新能力host使用new帧，legacy路径保留；PROTOCOL只补新家族，不改冻结字段。
- 验收：测试fixture的全部Pi停止、启动中、respawn中均能list/read真实磁盘内容，读操作zero child spawn；越界workspace/session、伪造bodyref/cursor拒绝；未知current不造live。

### P2 — 增量目录/偏移索引与有界页查询（Extension）

- 实现4.2–4.3；新host读路径用workspace/session索引点查授权，不再全list。旧child的索引/帧继续兼容，不改其数据库；纯解析函数可共享，live sync的leaf权威保持child侧。新库写入/迁移只能由host writer执行。
- **待验证目标**（同类合成环境）：100 MiB热末30条query中位≤50 ms；追加4 KiB时解析增量不随旧文件大小增长；1000会话热首50行query中位≤20 ms，前台不全目录stat。
- 全文冷建不承诺瞬时，但必须在worker、可取消/有进度、无无限缓存；主线程100 MiB查询测试中单次阻塞≤20 ms。
- 验收还须看read byte/parse计数、EXPLAIN查询索引、timer/内存，而非只有秒表；分支、同timestamp、tool跨页父、半行、删除/替换、同size同mtime重写、并发append、重建中查询与损坏DB均正确。新增两个同阶段验收组：①旧child写index.sqlite与host建库/迁移/查询并行，互不改表、不争新库写所有权，writer崩溃可重建；②单条100 MiB JSONL、转义引号/反斜线/surrogate与UTF-8跨64 KiB边界，首屏不全行parse、正文哈希重组相同、每后续块无重复全行扫描，并覆盖sidecar淘汰/超预算。

### P3 — Web查询合并、分页、缓存与首屏（Site）

- 同一子系统任务内处理预取超时、hover→click合并、作用域/revision失效、断线/迟到响应、older cursor与渲染；同时加SSE只读调度/屏障测试。
- 待验证目标：一次click至多1个相同query；热页命中首内容≤100 ms；未命中不为同一操作重复发list或read；open时read不再等待另一read的204；百页滚动DOM/页缓存受限。
- 验收：隔离真实浏览器公开链路，分别报request数/byte、首内容与完整页；通过实际消息节点/截图，不把spinner挂载当完成；不向真实会话发消息。

### P4 — App先查看、再显式继续（App）

- 新query协议、repository、只读route与paged viewer；workspace页取消启动前置，live功能仍由已有sync状态机管理。经批准后在`00-decisions`追加交互决策，不静默改写历史记录。
- 待验证目标：缓存命中首内容≤100 ms；停止Pi时也能查询；点击历史0 switch、0 spawn；显式继续每意图≤1 switch，missed ACK不重发。
- 验收：Android真服务与截图覆盖缓存/未缓存/切workspace/连续点目标/断线/旧host；确认不改写live Hive、不串会话、不埋composer。iOS需真实设备另标；CI IPA只证明构建。

### P5 — App apply批次与渲染（App）

- 批次事务感知的repository发布、稳定seq迁移、VM按revision复用、仅变更bubble重建/Markdown解析，保持ListView已有懒构建，不为“虚拟化”重造滚动控件。
- 待验证目标：100条history apply最多2次可见snapshot；相同history零持久写；翻旧页不改写原有行；同长度不同内容必须更新；主题/字号/宽度改变正确更新。
- 验收：focused Hive/repository/VM/widget测试加profile-mode设备trace，报写入数、emit数、build数、首帧；putAll不能作为“已合并事件”的替代证据。

## 6. 正确性回归范围与执行方式

合并的finding→任务映射：host授权/ready依赖归P1；冷建/同步阻塞/增量/工具父/游标/巨型正文归P2；预取重复/卡在途/跨作用域旧缓存/older分页/发送顺序归P3；App browse即switch/重复start/旧host/只读与live隔离归P4；逐行emit/重编号/迁移/Markdown复用归P5。独立评审 `agent://1d3f336a-060a-4f27-a1a3-45e7491000b3` 的两个契约缺口（共享DB写所有权、巨型字段字节定位）均已合并进P2及§4.2/4.3，不另开阶段。

- server只跑直接受影响的history/index/host bridge/transcript focused测试，再typecheck；不因monorepo成员身份跑无关套件。
- Web跑新增query/cache/SSE ordering与现有直接相关只读session gates；App跑sync/repository/sessions/新history viewer测试与analyze。不得改弱H1/H2/H3验收断言。
- 关键回归用mutation证明测试承重，例如重新双发read、丢scope、复用过期generation、移除once-switch、恢复全量重编号。只重跑被该mutation影响的目标。
- 在各子项目代理/pane内实施与验证，根目录保持编排；优先Cockpit label Extension/Site/App，cmux为fallback，发现pane后解析id，不能硬编码。
- 初次集成在隔离host/fixture上启动新的服务；本轮用户supervisor PID13012不重启。真实部署/IPA分发/commit push单独按用户授权执行。
- 复用未被相关变更失效的通过结果；性能与正确性完成各自阶段即记录，不安排无差别“最后全量再跑”。

## 7. 暂缓与明确不承诺的事项

- **进程内resume/热Pi池/启动插件裁剪**：属于执行引擎生命周期改造；先把浏览移出Pi后再判断其必要性。显式继续对话仍可能等待启动，不能宣称本计划已把它变瞬时。
- **持久浏览器私钥、认证/TLS/默认直连迁移**：不是本次查询优化，配对协议不动。
- **workspace配置小文件缓存、TextDecoder微优化**：未证明是主要耗时，不先做。
- 任意未知writer的前缀改写无法靠size/mtime O(1)证明；未知变更允许保守重建，不以冒险offset缓存换虚假快。
- 无索引的首次完整元数据生成仍是O(total bytes)，需要诚实构建状态；不把预热当“冷查询已经O(page)”。

## DoD

以下为原批准清单，保留原文；按用户修订范围逐项结算见§8，未勾选项不能当作已完成。

- [ ] 三条路径在Web/App都有分段数据，实测与目标明确分开。
- [ ] host无Pi也能list/read；浏览零spawn，App显式继续才switch。
- [ ] 热页与增量成本由实际读字节/parse次数证明，不随全部历史增长。
- [ ] 分页、body按需加载、稳定身份/快照与工具引用不会丢数据或串会话。
- [ ] 缓存有byte界限、版本失效、single-flight与完整终止路径。
- [ ] Web消除重复read与read之间的POST队头等待；乱序/写屏障正确。
- [ ] App整批通知与稳定seq通过迁移/幂等/实际profile验证。
- [ ] 真实浏览器与Android首内容验收；iOS未实机时明确标注。
- [ ] 不改冻结配对/Hive契约，不削弱既有harness，不碰用户真实会话做写测试。

## 后续

按已批准计划P0–P5分派，执行状态由Todo #40–#47跟踪。P0工具为 `server/scripts/bench-history-performance.mjs`，证据 `agent://b45fd5a8-2022-46a6-99a8-3be49ea317b2`：隔离探针7/7与小fixture冒烟通过；既有基线只按hash复用，未重跑完整矩阵，客户端指标在P3/P4补齐。

P1证据 `agent://81971e17-401f-4e35-be87-8c0a90348e07`：新增54测试、直接受影响目标合计261测试通过，typecheck干净，真实worker通过隔离临时编译验证；所有fixture工作区生命周期均能零spawn读取。新协议在host room直发，未改旧session帧或生产dist。P1仍使用全文扫描、内存body缓存与临时16MiB body上限；这些由P2替换为本计划的SQLite/流式字段定位/256MiB sidecar，不算最终性能完成。current_id/ready仍诚实保留unknown。root的PROTOCOL.md新家族章节待P2契约稳定后一次更新。

P2核心交付 `agent://93b30e2c-4289-4ea0-8dbb-efb0ec8331d7` 包含85 focused/292 affected通过、100MiB热末30条约6ms/1000会话首50约3ms及15.80ms控制面最大延迟；这些是隔离编译模块的结果，不是客户端或生产追加已验证。独立审查 `agent://0d06df68-4480-4d4e-84b4-290a6c0459ce` 确认R1生产追加未接入、R2运行态身份不足以授权append、R3超16字段ref可达性、R4单entry超帧事件可达性、R5旧snapshot高水位未进查询。五项已合并Todo #48（同一状态机一次修正），最终集成#46也以#48为依赖；Web/App独立开发不因此暂停。仍有效的既有验证复用，受影响边界重测。

只有显式继续仍不满足体验时，才另起执行引擎启动/resume计划；不把其复杂度夹进浏览性能工作。

## 8. 本轮范围修订与最终结算（2026-11-17）

### 8.1 用户已决定的交付边界

2026-11-16用户明确选择“**本轮接受保守重建（推荐）**”。因此§4.2的正常append快路及P2的4 KiB增量解析目标不属于本轮完成声明：生产 `trustedWriters()` 恒为 `[]`，`append_trusted`/`append_authority` 恒为false，检测到变更后按 **O(file)重建新generation**，包括append。O(delta)另待受支持writer与可强制执行的独占所有权设计；旧合成注入的增量数字不是生产证据。

已就绪且未变化的历史仍走有界索引热页；首次冷建和变更重建仍有成本。旧snapshot遇generation变化按stale重开，不承诺生产append保留旧页。HEAD/refresh/缓存重验只发 `if_revision`，不携带snapshot/before；older/body保留原snapshot/cursor，不能跨代拼页。

### 8.2 最终实测：目标、结果与限制分开

| 检查 | 最终观测 | 判定 / 证据范围 |
|---|---|---|
| 100 MiB热末30条，query中位≤50 ms | 13 ms（13/13/11，n=3） | PASS；source read/parsed bytes=0，1 stat；实际编码帧186937 B，真实worker |
| 1000会话热首50行，query中位≤20 ms | 6 ms（5/6/6，n=3） | PASS；source read/parsed bytes=0，50 stats，非全目录N-stat；帧5289 B |
| 主线程最大timer漂移≤20 ms | **27.555 ms**，615次1 ms timer观测 | **FAIL**；单次冷建期间，含OS调度，不证明具体同步函数的耗时；不得沿用早期15.8 ms |
| Web未缓存首内容 | DOM34.7 ms / 下一rAF46.3 ms，n=1 | 真实Chromium+fixture；1次history_read，POST正文253 B、回复payload8737 B |
| Web缓存重开≤100 ms | DOM22.3 ms / 下一rAF26.7 ms，n=1 | PASS；零新网络请求；两停止workspace内容隔离，50行最多观察15个挂载行 |
| Android未缓存首内容 | 列表267/94 ms，正文362 ms（30项）/105 ms（10项） | 真实fixture网络；Android 15 x64模拟器profile，SwiftShader；不把未缓存样本套入缓存目标 |
| Android缓存首内容≤100 ms | 正文54 ms，跨workspace切回35 ms；列表30 ms | PASS；每路径小样本，`wire_ms`未知/不适用而非伪造为0 |
| Android只读隔离 / 零Pi | 两停止workspace的列表、较早页、正文展开、末条标记与切回正确；浏览Hive写/删增量均0 | host退出输出 `fleet_mutations=0, zero_pi=true`；未按继续按钮；Hive零值仅指浏览区间 |

host最终基准来自最终#56源码的scratch编译，不使用生产dist。热OS文件缓存下，约102.791 MiB/2100条的首次索引构建为8730.404 ms；1000小会话为5060.462 ms；timer场景沿用约97.896 MiB的既有fixture，冷建8926.281 ms。不能称为OS冷盘或低延迟冷查询。

Web的首个50行render仍有**52 ms long task**，另有既有只读 `session_sync` 请求；未发生start/switch/prompt。DOM/rAF与App的VM挂载至真实item构建后post-frame回调均不是物理像素延迟，App也不是ADB tap到屏幕的时长。不同网络、数据量和预热条件下不能直接把新旧数字相除当同条件收益。

Android的live Hive基线在进入history前已因既有live-sync超时状态产生2次新写、1次删除；01:15:47–01:36:14历史浏览期间该累计值不变。此处是**浏览增量0**，不是整个配对进程从未写Hive。profile observer持续观测active msgs box，history导航未重绑；更广的存储隔离由既有P4测试补证。

### 8.3 P5：合成输入、真实pipeline的profile运行

Android独立 `.p86` 包在真实SyncService/Hive/SessionReadRepository/投影/ChatTranscriptList/Markdown上运行，合成channel输入，不接真实网络或用户会话。四场景运行时断言均PASS：

| 场景 | 实际写入 / 已有key改写 | 批后snapshot | 新投影 / assistant build / Markdown创建 |
|---|---|---:|---|
| 100条apply | 100 / 0 | 1（含初始空snapshot共2） | 100 / 1 / 1 |
| 重叠older前插1条 | 1 / 0 | 1 | 1 / 0 / 0；旧key、序列化内容与投影identity不变 |
| 完全重复history | 0 / 0 | 0 | 0 / 0 / 0；render计数均不增 |
| 同长度alpha→bravo | 1 / 1 | 1 | 1 / 1 / 1；user build增量0 |

queue至widget frame实际耗时依次为**2021.303、122.744、41.847、89.728 ms**。11个全程FrameTiming样本的最大build为78.320 ms、最大raster为171.251 ms；软件GPU下不宣称流畅度通过或生产设备性能。保留的是运行计数、engine FrameTiming标量与完成截图，**没有导出完整DevTools timeline/CPU trace**。PASS是在真实队列、写入、通知、identity与渲染断言及临时Hive清理后打印，不由编译成功推断。

### 8.4 验证复用、文档与最终DoD

只复用仍有效的focused结果，没有为结算重复全套测试：

- host最终边界10 targeted与9个承重mutation，200/1025图片字段经公开分页/正文API完整哈希重组；same-generation primary/tool-parent/seed/高水位围栏通过。证据 `agent://4d81da6b-b182-46c1-9a7d-6360700a44b8`、`.orchestration/results/86-p2-final-boundaries.md`。其“等待策略决定”状态已由§8.1的用户决定结算。
- Web query135/135、实际React hook11/11，affected lint/typecheck/隔离build通过；scope由capability+boundHostPeer+daemonId确定，tick驱动画面，list/error回复按所有权处理。证据 `agent://b2d8622e-c7ff-40d2-aa98-378839e5c222`。#49/#50的HEAD与PAGE契约测试继续有效。
- App数据51/51与合并/重编号mutation、UI19/19及最终render3/3、P4 once-switch/missed-ACK/旧host/断线focused证据复用；本轮新增真实fixture浏览与P5合成profile，未声称逐项设备重跑全部边界。
- `PROTOCOL.md`已补 `workspace_history_v1` 与list/read/body/error、HEAD/PAGE、字段manifest续页、高水位、fail-closed append，以及P1临时16 MiB→P2总256 MiB sidecar预算；冻结配对与live Hive命名契约未改。

最终清单按实际范围结算；保留未通过/未测项：

- [x] host在Pi停止时list/read真实历史，fixture累计零fleet变更；启动/respawn等状态复用P1直接受影响测试。
- [x] 热页目标13/6 ms与实际bytes/parse/stat/帧大小有最终证据，冷建成本单列。
- [x] 生产追加信任fail-closed，O(file)范围经用户明确接受；**生产O(delta)未交付**。
- [x] 完整分页/字段续页、body按需加载、稳定身份、高水位/快照与工具父边界有focused及mutation证据。
- [x] Web请求合并、读调度/写屏障、scope/revision失效与真实hook接线通过；byte有界缓存和终止路径复用既有focused证据。
- [x] App稳定seq/迁移/批次通知/幂等与渲染复用通过focused测试和实际profile运行；合成与真实浏览证据分别注明。
- [x] Web真实浏览器、Android模拟器真实fixture首内容与缓存验证；只读viewer无composer、两workspace不串内容，浏览对live Hive增量0。
- [x] 冻结配对/Hive契约保留；未削弱H1/H2/H3，未向真实用户会话发prompt/switch。
- [x] 本轮owned host正常清理exit0，owned browser已关，adb reverse61986移除，仅隔离 `.p86` force-stop；用户服务/原App/模拟器保留。
- [ ] 原始“三条路径在Web/App均有完整分段数据”未全覆盖：工作区目录及完整页的最终分段没有同规模复测，不能由列表/正文的首内容数字代替。
- [ ] 主线程timer最大漂移≤20 ms未通过（27.555 ms）；Web52 ms long task和Android软件GPU慢帧仍存在。
- [ ] 真实百页滚动、物理Android设备、iOS实机以及完整DevTools导出trace未验证；不声称p95/p99、全部渲染≤20 ms或全量回归通过。

证据目录：`C:/Users/zlmpp/.pi/agent/tmp/remote-pi-perf-20261116/`，包含 `final-host/evidence.json`、`p86-web-final-acceptance.json`、`p86-android-final-acceptance.json`、`p86-android-scalars.log`、`p86-p5-profile-acceptance.json`、`p86-p5-profile-scalars.log` 与安全内容截图。host最终性能报告在worker声明的 `D:/workspace/git_repo/.orchestration/results/86-final-host-perf.md`（位于仓库外，不假称仓库内交付）。runtime APK均为唯一副本，未覆盖生产server/Web dist；无commit、push、发布、部署或IPA分发。

### 8.5 尚未完成的性能与后续边界

本轮按修订范围结束实现与集成验证，**原始DoD不是全绿**。保留27.555 ms timer失败及上述未测项；如要求所有原目标通过，需要另行安排这些明确边界。首次body展开仍为O(body bytes)；变更重建为O(file)；显式继续的Pi boot/resume旧31–143秒问题未优化。只有后续获授权后才设计生产O(delta)、执行引擎热启动或补物理设备/百页验收，不借收尾静默扩大范围。

### 8.6 接替后的全量回归与当前P5（2026-11-19）

当前源码 Mobile 全量测试 **1048/1048 PASS**；Server 全量聚合测试 **86 Vitest files（1406 passed/19 skipped）+ 独立 Node host probes 8/8**，typecheck PASS；Web Chromium 当前 artifact 回归15/11/23、pageerrors0。当前源代码重新生成的隔离P5 APK unprofiled运行断言及coverage完整；diagnostic run仍有CPU采样边缘缺口，故不声称完整profile、CPU coverage或性能预算PASS。独立Simpleperf只为补充 app/raster attribution，不能替代VM gate、物理设备或宿主SwiftShader线程。详见 Plan87 §10.3–10.4 与 `.orchestration/results/88-mobile-continuation.md`。本节原§8.5列出的 Host/历史trace/硬件/目录清理等失败仍保留，整体DoD仍未全绿。

## Current-source follow-up — 2026-11-20 (see `108-current-android-browse.md`)

The later root rerun closes only the current-source Android **unprofiled browse UI/capture-coverage** gap: current isolated `.p90` P100 APK, fresh 9×5,000 Host fixture, real directory/list/read clicks, entry 4970 visibly photographed, and all three stage viewport frames matched against raw frames. The repository-owned XML parser regression is 3/3; the mobile collector launch matrix, including the new single-quote fixture, passes its full mocked variants. This does **not** close Android CPU/profile coverage or performance: P105/P106 still contain 6/5 truncated CPU stacks, P5 and browse preserve slow SwiftShader raster frames, and all relevant captures say performance budget not evaluated. The `emulator-5556` AVD created for this run was stopped; only the pre-existing `emulator-5554` remains. No physical Android/iOS evidence was obtained.

A current-source Chromium/real Host external-geometry comparison also ran the same isolated artifact with the application probe on/off and fresh Host fixtures: directory 403.9/402.3ms, trusted-click list 13,075.9/13,012.9ms, trusted-click read 141.4/140.1ms, cached reopen 25.4/21.9ms; cached reopen made zero additional history requests in both modes. Both runs observed 17 `building` plus 1 `ready` list reply, zero page errors, zero blocked external requests, and zero network-ledger drops. The artifact's 12 declared source hashes match current files. This is a one-pair, warm-filesystem/headless Chromium result; it does not prove OS-cold disk, physical paint, population statistics, or a general performance budget. See the preserved `rp98-web-current-e2e-v2` run records and append-only `.orchestration/results/108-current-android-browse.md`.

Current Mobile full Flutter suite was rerun serially: **1,059/1,059 PASS**. Earlier parallel Server execution had one 5-second test timeout and a host-smoke transient failure; the timed-out case passed alone, the typecheck passed, and the complete Server Vitest files subsequently passed (1,426 passed / 19 skipped) with host probes **9/9**. Web history gates/query and isolated React Chromium regression are recorded separately in the prior current-source audit; they are not the same as the above real Host comparison.

Remaining original DoD items are not redefined: Host formal timer whole-batch threshold remains failed; historical Web 52ms CPU stack is not recoverable; complete Web retainer proof remains limited to the audited workloads; Android strict CPU/native raster causality and physical Android/iOS remain unverified; historical policy-rejected scratch removal remains unresolved. Keep overall Goal **INCOMPLETE**.
### 8.4 2026-11-22 Web 全负载驻留与 generation 结算

当前 artifact `ff0ace646…` 的真实 zero-Pi Host V8 已补齐：100 页实际加载、驻留窗口深滚动200 rows、96回访、9会话；5个预算点通过，p100 cache 8,308,276 bytes/52 pages/4 resident/200 view items/32 checkpoints/96 Markdown，关闭后 controller view/resident/checkpoint/pending=0。5份 forced-GC heap graph 无 page/view owner 之外的 item；关闭后仍有46 items经两个React fiber可达，故只判 bounded retainer，不宣称零驻留。

旧 snapshot 在真实 append 重建 5,004→5,005 entries后收到唯一 `history_error/stale`，随后仅发一次253-byte新HEAD并收到50项非缓存新代，marker可见；Host self-cleanup `zero_pi=true/fleet_mutations=0/scratchRemoved=true`。当前 React 15/14/23、history gates 1,190、pageErrors=0。

历史52ms原栈仍缺失，CPU归因BLOCKED；Android strict CPU/慢帧/native与实体设备、旧受限目录仍未关闭，整体 Goal 仍 INCOMPLETE。
