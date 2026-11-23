# Plan 87 — 解决 Plan86 未通过项并补全证据

状态：2026-11-17 用户 Execute 批准，Act 实施中。批准 checksum `aa41962ca4afea6ab7ad38bb0a4cda0dc39645119ad63cf604d36079109e8b41`，handoff `76badb70e431d9ec5ec02a6df5426265af97c369d829b5520c3b635d15caff5a`。Goal `dad1d52e-8bb2-48ff-b54a-97b54036f755`，执行图 #75–#82；旧草稿 #70–#74 已由批准图替代，非完成声明。后续子代理按用户要求 `my-newapi/xingchi/gpt-6.1-sol` / `max`。

## 目标

解决 Plan86 §8 的可执行未通过项，并对硬件/测量阻塞给出可复现证据。保留生产 append fail-closed、O(file) 重建和冻结 pairing/Hive 契约，不把测量校准当作性能 PASS。根代理编排与驱动设备/浏览器，产品实现及构建由各子项目 owner 完成；不提交、推送、发布或覆盖生产 dist。

## 当前已确认的问题和 finding→任务映射

| 子系统 | 已确认 / 待证明 | 任务与证据 |
|---|---|---|
| host 调度与控制面 | 27.555 ms 是1ms timer唤醒漂移；idle也约22ms，不能直接归因同步JS；worker内大解析不是host主线程栈 | #76准备归因、#79串行执行；`agent://16e559a1-2ead-43c2-ae43-8ad0d97795e7` |
| Web 缓存与分页状态 | 超8MiB整session淘汰但query忽略返回；view隐藏保留、累计merge近O(P²)、高度Map不回收、锚点恢复符号不一致 | #77一次闭合、#80真百页；`agent://bf003f5f-a2fe-4830-97a7-8c1e4af7ce69` |
| Web 52ms长任务 | 原样本无CPU栈归因；Markdown parse、投影与几何测量为候选，不能先认定 | #80诊断trace，再按已确认热点最小修正 |
| App 批处理与测量 | serial await box.put候选；phase计时可抓状态帧且漏迟到timing；2.021s不能由SwiftShader解释掉 | #78 bulk+framefence、#81真实profile；`agent://20fd59bb-63cc-485e-8b66-a1e50b39615b` |
| 三路径、规模与硬件证据 | 目录/完整页段数据、百页、完整CPU/timeline缺失；目前无物理设备，原AVD已关闭 | #80/#81补证，#82审计；用户已明确允许启动原rp_android保留数据 |

不重新打开 Plan86 R1–R5 correction gate；不修改已接受的 O(file)/trust 约束。

## 结构预期

- server：scratch-only timer/CPU/eLu 归因 driver；可选大fixture复用真实 HostBridge/worker/direct transport，默认小fixture兼容。
- Web：page cache、query view 和有界cursor checkpoints分开所有权；可从host重新读取淘汰页；resident数据/高度/Markdown状态都有界。
- App：原diff/seq/identity/publication不变，用非空bulk写入；profile-only VMService gate和可归属的frame fence，完整导出timeline/CPU。
- 证据保留到独立临时目录；只保存安全计数/时间/合成数据，不暴露token/ct/pairing URI/真实用户消息。

## 步骤与验收

### A. 固化立项（#75）

保存本文件并将诊断映射至三lane，所有已通过证据只按material invalidator决定重跑。完成后立即分派，不重新调研已存在结果。

### B. Host 归因与fixture（#76 → #79）

新增scratch归因driver：standalone idle、导入后idle、2000-entry legacy cold、2100-entry literal>100MiB cold；记录未四舍五入raw gaps、首尾gap、eLu、CPU能力字段、request/worker/response/complete timestamps。另单独带inspector CPU/GC trace诊断，不把profile开销算正式acceptance。

保留原27.555 FAIL，不删startup/GC/outlier、不相减idle、不改20ms阈值；没有CPU归因前不改产品。只有证实同步主线程热点时才最小修复。Win32环境原始目标若无法证明，保留具体阻塞证据，不捏造PASS。

大fixture至少5000entries、2–3KiB不同Markdown且总投影>8MiB、9sessions及1000-session workspace；保持live=false、fleet mutation guard，真实分页不由fake store代替。独立scratch编译不覆盖server/dist。

### C. Web 缓存、渲染与三路径（#77 → #80）

一次处理cache/view/checkpoint/anchor/measurement共享状态：

- page级预算和有界resident window，淘汰传播到views；不提高预算、不保存隐藏全量副本。
- 有界snapshot/cursor checkpoints支持已淘汰页回访，必要从已知边界有序遍历；stale明确重开。
- 单pass合并并保持重复event body-ref/parent语义，状态-only变化复用items。
- 高度Map和投影随淘汰/切session回收；stable row measure refs及ResizeObserver；锚点按保存定义恢复，非零offset/迟到测量测试承重。
- 保留scope、HEAD/PAGE、SSE ordering、H1/H2/H3、encoded frame与lazy mount合同。

focused验证跨8MiB单session、9sessions、淘汰重读、stale、锚点、无关state不重投影。隔离artifact含sourcemaps；不覆盖clients/web/dist。

root串行真实Chromium：先50row短trace定位52ms，后大fixture≥100次成功分页并实际滚动；回访最初/中间/最老页及切session重开。断言无空白假终点/重复/缺口，mounted transcript≤60。记录cache/view/page/height/Markdown驻留、DOM/listeners与heap检查点1/25/50/75/100/回访；强制GC诊断与正式计时分开。

三路径分别记录目录、列表、正文的intent/request/send/reply/decode/apply/real DOM/下一rAF/full requested page，不把首屏spinner、controller时间或所有offscreen行当paint。trace与正式timing分开，probe on/off对照，字节分层不双计，时钟区间校准。

### D. App bulk与完整profile（#78 → #81）

`_reconcileRows`计算完diff后一次非空deleteAll和putAll；保留物理key非负/signed seq/role:id/invalid-generation/failure suppression、逐BoxEvent tally及单snapshot边界；不parallel单put、不clear/reinsert。

profile harness按expected revision/content frame和原始vsync时间归属，状态帧不可通过内容帧等待；closing fence确保迟到timing完整，callback completer有界deadline，duplicate用无新revision的独立观察fence。保留rawFrameTiming不按deliverybatch替代归属。

profile-only VMService ready/start/captureComplete/exportAcknowledged，root导出timeline、CPU samples及functions table、frame timestamps、phase markers；四phase/start/end/targetframe覆盖不完整则incomplete。保持旧aggregate比较，新增明确独立边界，不相加重叠时间。

focused data/render/fence tests后唯一.p86 APK及collector命令；root设备串行运行四场景：apply100写100/批后emit1(含initial共2)，prepend写1不改旧行，duplicate写0emit0，same-length写1/projection1/assistant1/Markdown1/user0。真实浏览三路径与合成profile分开，冻结pairing/Hive不变。

### E. 设备与最终审计（#81 → #82）

用户已明确允许启动已有rp_android AVD，保留数据、原SwiftShaderflags，不wipe、不重启netd、不改GPU/系统服务，不碰真实App。仅.p86可install/force-stop；物理Android/iOS不可用则保留具体设备/权限阻塞和恢复条件。

root逐项对照Goal、Todo与Plan86§8，而非仅以旧任务completed认定全部完成。清理自建host/browser/inspector/reverse，只自己的端口；模拟器数据保留。未通过目标继续必要修复，证据不充分不勾绿；最终独立Goal verifier裁决。

## Definition of Done

- [ ] host归因driver及>=100MiB/idle/rawgap/CPU/eLu完整，原20ms失败有证据处理而非阈值替换。
- [ ] Web跨预算100真实分页可回访，缓存与DOM/height/view驻留有界，无丢内容或锚点跳。
- [ ] Web52ms长任务有CPUtrace归因，确认热点最小修复并记录剩余限制。
- [ ] Web/App目录、列表、正文的完整分段与首内容/完整请求页语义明确。
- [ ] Appbulk保留所有语义断言，完整profile frame/timeline/CPU覆盖可验证。
- [ ] Android模拟器profile证据与物理Android/iOS阻塞分列，不冒充实机。
- [ ] 全部Todo/Goal/原Plan86缺口审计，复用有效验证，资源清理，无commit/push/deploy。

## 暂不重新设计

生产O(delta)、writer trust、Pi热启动/resume、pairing URI/Hive box names、已通过R1–R5与H1/H2/H3不重新设计。仅对CPUtrace证实的同步热点继续最小修复；不从耗时猜归因。

## 9. Codex 接替后的验收进度（2026-11-17）

本节覆盖接替会话的最新证据，**不表示全部原始目标通过**。总入口 `.orchestration/results/87-resume-acceptance-progress.md`；旧§8与旧任务完成状态保留为历史。当前结果以独立审计为准。

| 验收项 | 最新结果与证据 |
|---|---|
| Host正式timer/raw/CPU/eLU/literal100MiB | 修复seed前驱SQL重复扫描与迟到worker事件；新源码8正式窗口≤20ms，最大17.3917ms，完整tail/hash独立复算。见87-large-fixture-building.md、87-host-final-audit.md。历史27.555ms FAIL保留，不追溯归因。 |
| Web100页真实滚动 | 连续100成功页，每页50新event进入viewport，合计5000无缺号，maxMounted4；cache≤8MiB、view4pages、checkpoint32、height≤200、Markdown96。见87-web-runtime-audit.md。100页后driver回访n变量错误独立记录，不抹去。 |
| Web回放/身份/列表规模 | 独立399真实read回复，104中间replay；HEAD/中间/最老event0回访；9session内容身份及DOMkey；1000list唯一序号999..0、20×50真实回复、terminalfalse。见同报告。 |
| Web内存/anchor/CPU | 两轮独立GC诊断跨预算后heap趋势趋平，不能冒充滚动九会话后的全部retainer证明；anchor真实hook11/viewer15通过。短trace分离profiler启动145ms与应用最大36.38ms，历史52ms无旧栈仍未归因。见87-web-anchor-fix.md、87-web-short-trace.md。 |
| App/P5 | bulk/identity断言与unprofiled四phase完整，原始慢帧保留；diagnostic07仅CPU结束边缘57.127ms缺口，不能算完整CPU。见87-mobile-runtime-audit.md。 |
| App浏览三路径 | 最终worklist APK实际unprofiled采集完整，目录/list/read请求到post/raster全段与exactframe匹配；单样本软件GPU慢帧仍不达预算。最终diagnostic非CPU项通过，但255深度仍2truncated+1empty+33.835ms起始边缘缺口，CPU incomplete。见87-mobile-runtime-audit.md。 |
| 设备/剩余 | 仅rp_android SwiftShader模拟器；物理Android/iOS不可用。native raster/SwiftShader CPU未采集。旧52ms归因/CPU完整度/物理设备不能勾PASS；有具体raw和恢复路径。 |

资源：已停止root fixture61986、关闭自建浏览器、force-stop仅.p86、移除reverse61986及collectorforward；用户服务和AVD数据保留。三个root-created scratch目录删除命令被执行策略拒绝，目录保留并记录，不绕过拒绝。原生产dist未覆盖，无push/deploy。

**约束例外**：移动子代理违反禁止commit指令创建本地提交`9f7c252c`（报告、collector补丁与mock测试三文件）；已向用户披露，未擅自改写历史。不得宣称本次无commit。

DoD未全绿，Goal不能以实施完成代替全部验收通过。仍需最终三路径时钟审计、独立最终裁决以及明确未通过/阻塞清单。
## 10. 2026-11-19 接替验收（当前；未完成）

本节覆盖 §9 中与本轮新源码、实测相冲突的“当前”状态；旧样本和失败不删除。完整记录 `.orchestration/results/88-root-continuation.md`。持续 Goal 仍未完成；功能修复与部分实测 PASS 不等于全部 DoD。

| 项目 | 当前结果 / 剩余边界 |
|---|---|
| 快速退出 / 打开 B | Web actual React/store/dispatcher 15、history hook11、viewer23 全过；Mobile repository+VM44全过。真实隔离 Web/Host 将 A 的合成 POST 暂停在 Host 前，B 50项正文先返回、实际可见，A 放行后的迟到回复不覆盖 B。不是 B 越过已经阻塞的 reader I/O 的证明。 |
| Server worker 恢复 | 5 相关 Vitest 套件54/54 + typecheck PASS；真实线程/文件 B 回归。Reader deadline 默认30s涵盖排队/退休，旧A失败不自动拒绝仍有预算的未派发B，旧reader确认退出后才替换；writer拒绝旧队列、不重放、等退出才替换。B仍可能花完自身预算，全链路不保证≤30s。 |
| Host 当前源码 formal timer | **整批 FAIL**。当前 worker 更改后单独串行重测8窗、5,007raw callback，2次idle >20ms（24.454、25.3779ms）。两个2000/2100 cold窗15.6318/15.5874ms通过；107,783,640bytes literal及tail/CPU/eLU/hash复算有效。不能沿用旧8窗全过作为当前全批结论；不扣除idle、不择优重跑、不放宽阈值。 |
| Web 重分页 / heap / stale | 基线 bundle 当前Host 已完成100真实滚动页、5,000唯一key、86回访、9session；4个forced-GC堆快照中 typed item 50→2600→400→400，全部也被有界page cache引用。闭合controller view=0仍有React旧view引用50cached items，保留限定。完整图及明确DevTools console root对照均保留，不做无条件零泄漏宣称。另同次精确stale错误→唯一HEAD→新marker在scroll viewport连续两帧可见通过。最新Web产品小修后整套100页/86回访/9session/4堆图亦已完成并复算，同样保留React旧view引用边界；1000列表20×50和同次stale→新HEAD可见也通过。 |
| Web 当前同步热点 | 精确click/reply/viewport相关trace捕获50.881ms任务，68/88样本具Markdown/GFM ancestry；历史52ms无原CPU栈仍不可追溯。依当前证据小修：首次未测量只渲染估计viewport，测量后恢复原overscan；Markdown parser按text memo避免宽/主题变化重复解析。安全/GFM/文本变化实测通过，缓存仍是元素描述。小修后独立诊断单次最大回包相关task42.928ms，不等于普遍性能PASS。 |
| Web 目录/list/read | 最新artifact `index-CWasP_GJ.js` 的三路径4/9/50项业务reply与app阶段hash匹配，可信点击、scroll-box裁剪/下一帧复核、同文档2.700ms时钟区间、probe-off对照与同adapter零网络缓存重开补齐。均为单样本、Host索引已就绪、新文档/客户端缓存冷；不能当物理paint或冷建首次低延迟。 |
| Mobile VM/native | P5新采样仍**incomplete**：仅CPU尾gap134.696ms未过20ms；VM depth配置255、最长实际样本栈85，无截断/空栈/坏index。另Simpleperf60样本/0lost，保留raw且关闭gap平滑重导；APK/原始perf/未剥符号ELF build-ID一致。apply100一个精确raster sample定位字体字形图集生成，其余阶段无该覆盖；不是全部帧/SwiftShader成本或Dart CPU gate。 |
| Mobile browse/设备 | 新补测preflight见`.p86`3条持久配对，仅1条可确认owned fixture，2条未知；为守护已定真实数据边界，未启动会先owner/mesh同步的生产bootstrap，也未wipe。恢复原隔离APK并验证设备base SHA和SecureStorage文件不变，force-stop、forward/reverse空、preflight文件清理。现有browse完整三路径/CPU不完整证据复用；物理Android/iOS仍无。 |
| 约束 / 清理 | 本接替轮未stage/commit/push/deploy，历史违规9f7c252c继续披露、未改写。执行器再次拒绝已核实的owned scratch删除，未执行、未绕过。资源的进程/端口结束和目录删除分列，最终复核确认自建Host/浏览器/测量已停，设备恢复，61986无listener；目录删除仍被policy拒绝。 |

不把旧52ms、VM CPU边缘、物理设备和明确策略拒绝改成PASS。不能由一次当前trace低于50ms或样本数非零推断整个性能目标完成。 最后代码审计发现的并发dispose屏障缺口已修正并由独立只读复核关闭；最终裁决入口 `.orchestration/results/88-final-verdict.md`。

当前 Goal 状态：**blocked（未完成）**。2026-11-19 连续三轮重新核实相同 CPU/硬件/历史证据/执行器清理阻塞后，已调用 Goal 工具确认；原始目标保持。详见 `.orchestration/results/90-blocked-audit.md`。

### 10.1 2026-11-19 resumed continuation — emulator P5 rerun

The existing `emulator-5554` AVD was available (Android 15, x86_64) and was used; it is distinct from physical-device acceptance. Isolated `.p86` P5 was run in both unprofiled and diagnostic modes. Unprofiled capture is complete with four expected phases and assertions passed, but is not a performance-budget pass. Diagnostic capture has all four phases, 2,534 exported / 2,581 streamed timeline events with no stream gap, 94 CPU samples / 20,805 functions, maximum observed stack depth 161 of configured 255, and no malformed/truncated stacks. The sole issue is still `cpu_end_coverage`: the final CPU sample is 218.455 ms before capture end, exceeding the unchanged 20 ms edge gate. The exact capture manifests were independently recomputed and match; see `.orchestration/results/88-mobile-continuation.md` and `%TEMP%/rp88-p5-resume-*`.

The prior isolated browse APK was restored and hash-verified; `.p86` remains stopped, ADB forward/reverse lists are empty, no pairing data was wiped, and production app/physical devices were not used. No performance criterion was relaxed and no causal fix is claimed. This adds emulator evidence but leaves Goal incomplete and remaining CPU, hardware, historical-attribution, and cleanup items open.

### 10.2 P5 diagnostic-tail cross-check (same capture)

The latest diagnostic capture's `p87_capture_end` timeline marker precedes `gate.end_us` by 31 µs; the last VM CPU sample is 218,455 µs earlier. The exported timeline contains 14 complete target-isolate `DartIsolate::HandleMessage` spans after that sample (4,289 µs aggregate; longest 2,094 µs; final span 129 µs immediately before the end marker). This is not a CPU stack sample or proof of lost CPU records. Recomputed capture coverage still has exactly `cpu_end_coverage`; no new evidence supports changing collector export, gate boundary, or acceptance threshold. Detailed timestamps are in `.orchestration/results/88-mobile-continuation.md`.

### 10.3 当前源码重建、P5复测与补充 native 证据

当前工作树已重新构建 `.p86` P5 APK（tag `p90-p5-current-source-20261119T162300Z`，SHA256 `10008e468106625f5f51a1fc0bd1a305020d5B64007F7843B9A72D743FB70DC3`）。当前源码 unprofiled P5 完整；diagnostic 两次重测分别为 `cpu_start_coverage`（起点缺口 161.711ms 与 471.437ms），不是 PASS。另有当前 APK 的 Simpleperf 补充采样：53 samples/0 lost，匹配当前 `libapp.so`/`libflutter.so` build-ID，并观察到 `1.raster`/`flutter::Rasterizer`，但不能填 VM CPU gate，也不覆盖宿主 QEMU/SwiftShader；证据与限制见 `.orchestration/results/88-mobile-continuation.md`。Server 修正后的全量测试命令为 86 Vitest files（1406 passed，19 skipped）+ Node host probes 8/8；Web 当前 Chromium 回归15/11/23、page errors0；Mobile focused session-list 10/10；本节撰写时的并发全量结果后来由 §10.4 的串行全量结果复核并取代。设备恢复与前述隔离边界保持不变。

### 10.4 全量回归复核（2026-11-19）

当前工作树的 Mobile 全量 Flutter 测试串行运行 **1048/1048 PASS**；首轮并发负载下的未完成结果不替代该最终完整运行。Server `npm test` 改为串行 Vitest（86文件、1406 passed/19 skipped），并将 `scripts/host-history-probes.test.mjs` 按其真实 `node:test` runner 独立执行 **8/8 PASS**；未放宽5秒单测阈值，`npm run typecheck` PASS。Web 当前真实 Chromium harness **session reopen15/history hook11/viewer23 PASS**，page errors0。执行命令、原始全量 Flutter日志与详细限制见 `.orchestration/results/88-mobile-continuation.md`。

这些回归不改变验收边界：当前 P5 diagnostic 因CPU start-edge miss仍 incomplete；App性能预算、native/SwiftShader host线程、实机、Host 20ms整批、历史52ms原栈、旧自建scratch目录删除仍未关闭。

### 10.5 隔离安卓模拟器浏览实测（2026-11-20）

独立 Android 15 / SwiftShader AVD `emulator-5556` 使用当前验证 APK `com.example.remotepi.p90`；原 `emulator-5554` 及其 `.p86` 配对数据未操作。离线主机行改为点击实际匹配到的节点；每次只重置已核验设备名和 APK 哈希的自建 `.p90`，避免进程重启后内存身份变更却复用旧的 fixture 配对记录。

- **Unprofiled 浏览和采集覆盖通过**：工作区目录 → 历史列表 → `P86_SMOKE` 只读正文；两次滚动后确认 `RP86_SMALL_LAST`。三条路径分别返回 4 / 1 / 30 项，各有非缓存、非失败的阶段样本，并与真实 raw frame 的 viewport raster finish 匹配。`%TEMP%/rp90-browse-unprofiled-1795109894951` 的六项文件哈希均通过复核，没有 incomplete 文件，`performanceBudgetEvaluated=false`。119 个阶段帧中 92 个 build 或 raster 超过 16.7 ms，不是性能预算通过。
- **Diagnostic 严格 CPU 覆盖未通过**：`%TEMP%/rp90-browse-diagnostic-1795110442591` 六文件哈希、三路径、frame fence 与 timeline 共同通过核查；18,373 个导出事件、18,421 个流事件、无 stream gap；495 个 CPU 样本中有 1 个截断栈，起点缺口 24.804 ms、尾点 1.187 ms。保留 `cpu_start_coverage` 与 `cpu_truncated_or_invalid_stack`，不降低 20 ms 门槛。另保留首次诊断 `rp90-browse-diagnostic-1795110089889` 的 ADB 断连与 CPU 导出缺失证据。
- **资源**：仅测试 `.p90` 已停止；本轮自建 AVD 和 fixture 进程已退出，61986 无监听，ADB forward/reverse 为空；原 `.p86` 仍 stopped，APK 哈希复核不变。两个已独立确认的自建 scratch 根目录删除均被执行策略拒绝，原样保留。

原始产物、分段时间及精确范围见 `.orchestration/results/88-mobile-continuation.md`。这次补齐当前 APK 的真实模拟器浏览与非采样覆盖；不关闭 VM CPU/P5 诊断、宿主侧 SwiftShader/QEMU 栈、实体设备、Host timer、历史 Web 52 ms 原始归因或目录删除等剩余项。总 Goal 仍 active / incomplete。

### 10.6 2026-11-20 分段重审与 fail-closed 采集修正

用工作树 validator 对 §10.5 两份最终 browse capture 复算：unprofiled **complete**（不评估性能预算）；diagnostic **incomplete**（保留 `cpu_truncated_or_invalid_stack`、`cpu_start_coverage`）。两份每条路径的 viewport frame number/vsync/raster-finish 三元组现均逐项匹配原始 `FrameTiming`；manifest 哈希分别6/6、首次 ADB 断连样本4/4。

已进一步收紧本地工具的 fail-closed 语义：导出确认 RPC 与最终清单持久化错误采用不同原因；最终 `manifest.json` 从同目录完整临时文件以 no-replace hard-link 发布，避免截断文件和覆盖已有清单。若 browse stage 时间戳存在却对不上同一原始 engine frame，coverage 现在明确不通过。新的 ACK 断连/错态、部分写入、发布冲突、错帧 mock 均由 **13/13 Node tests** 覆盖。未重写既有 capture 或降低 20 ms 门槛。具体六路径分段、SDK CPU 边界和仅为 elapsed 的 raster Timeline spans 见 `.orchestration/results/88-mobile-continuation.md` 的 `trace and stage-boundary re-audit`。

### 10.7 2026-11-20 隔离模拟器 CPU 与回归复测

- `%TEMP%/rp90-browse-diagnostic-1795115037762`：清空 CPU 样本后预热 40 ms；三路径 4/1/30 项匹配原始帧 125/162/172，timeline 18,449 个导出事件 / 18,497 个流事件、无 gap，哈希 6/6。677 个样本的首尾缺口 0.638/1.682 ms，过 20 ms 边界，但两个 Flutter 构建栈截断，仍只有 `cpu_truncated_or_invalid_stack`，不删样或调阈值。Simpleperf 预检因设备 profiling 权限失败，未改 `security.perf_harden`，也未得到宿主调用栈。
- 同一自建 `emulator-5556` 上复用已核验的 `.p86` P5 APK：`%TEMP%/rp91-p5-{unprofiled,diagnostic}-20261119T192841218Z` 哈希各 6/6，四阶段断言通过。无采样 run 完整；diagnostic 68 个样本、无截断，首尾缺口 318.081/24.721 ms，仍 **incomplete**，不把预热结果推广到短 P5。原 `emulator-5554` 的 App 和数据未操作。
- 修正采集器按闭区间导出 VM CPU 样本；验证器拒绝区间外/非整数时间戳及非 1,000 µs 采样周期，不用窗口外样本填边界或阶段。20 ms 判定不变。Node collector/coverage **16/16 PASS**；当前 Mobile 串行全量 **1,049/1,049 PASS**。原始数据与日志见 `.orchestration/results/88-mobile-continuation.md`。

### 10.8 2026-11-20 当前源码 Host 正式重测

`%TEMP%/rp91-host-*-20261119T193244759Z.json` 是在自建 SwiftShader AVD 停止后串行完成的四次 invocation，保留原 1 ms timer、10 s idle 控制与 20 ms 门槛。**8 个正式窗口，5,106 条原始回调（含跨完成 fence），5 窗越界**。standalone idle 19.4303 ms；imported idle 21.0567 ms；2,000 条 pre/cold/post 为 20.9432/19.6028/20.1300 ms；2,100 条（107,783,640 B）为 19.1712/21.2516/20.3182 ms。14 个传递源码及 driver/Node 哈希、原始 delay、首尾 fence 和 CPU/eLU 均复核；三个新 probe 目录已由各 probe 正常清理。计时超限没有与同步主线程函数建立因果关系，不改生产代码、系统 timer 或门槛。此前 17.3917 ms 新测通过、24.454/25.3779 ms idle 失败与原 27.555 ms 失败均保留；总验收仍 **INCOMPLETE**。详细数据及其他阻塞见 `.orchestration/results/88-final-verdict.md`。

### 10.9 2026-11-20 Host QEMU / SwiftShader 点栈补充诊断

对 `%TEMP%/rp91-qemu-stacks-active-20261120T041437691.json` 与 `%TEMP%/rp90-browse-diagnostic-1795119280839` 原始数据复核，详见 `.orchestration/results/88-mobile-continuation.md`。QEMU sampler 源 SHA-256 为 `19af72c2981bf8e418af7127801919f9212636a4fa2de9bbe3570cf11cddc6e`；47.737 秒内对 11 个预选 TID 各采 118 次，共 1,298 次侵入式 `SuspendThread`/`StackWalk64`。首尾 `GetThreadTimes` 增量合计 83.375 CPU 秒。六个 TID 的 708 份栈中有 687 份包含 `emulator/lib64/gles_swiftshader/libGLESv2.dll`；同一自建 AVD 启动日志报告 SwiftShader ES 3.0。它是宿主 renderer 模块活动的直接但粗粒度证据，不是按 CPU 时间加权的 profile；没有线程名/函数符号，2 栈达深度上限、1 栈达单次 8 ms 限时，平均栈遍历开销 1.050 ms、最大 17.211 ms，采样本身会扰动执行。

同窗 browse capture 三路径 4/1/30 项、原始帧 138/160/179、timeline 19,216/19,263 且无 stream gap、manifest 哈希 6/6。VM CPU 528 样本仍有 2 个截断栈，首尾缺口 2.368/21.206 ms，coverage 为 `incomplete`；137 个原始帧中 114 个 build 或 raster 超过 16.667 ms，诊断不评估性能预算。该证据不关闭严格 VM CPU、精确 SwiftShader 函数归因、native raster 因果、实机、Host 20 ms 整批或历史 Web 52 ms 缺口。自建 QEMU/AVD/fixture 已停，仅原 `emulator-5554` 在线，61986 无监听；两个已核验 scratch 根仍保留，未改生产 dist 或原配对数据。Goal 继续 **active / INCOMPLETE**。

### 10.10 2026-11-20 当前 Web / Server 回归复验

- 当前 Web 工作树重新构建到 `%TEMP%/remote-pi-p87-web-OHTit9/site`，不写 `clients/web/dist`；artifact tree hash `f5044484b11612d412e986b9f6904b8843a5a2ad15b632c86f138b6e2f25115d`、8 张 source map。Chromium 156 隔离浏览器回归：session reopen 15、history hook 11、viewer 23，page errors 0；viewer prepend/late-height anchor 最大偏移 0.4375px。只证明真实 React DOM/store/dispatcher/viewer 的 deterministic fake transport 回归，不是 Host/network 或性能验收。
- 当前 Web history 核心 gates：protocol 87/87、cache 83/83、query 813/813、lane 35/35、window 42/42、probe 19/19，共 1,079 checks。Vite artifact 内含 TypeScript `tsc --noEmit`，构建完成。
- 当前 Server `npm test`：Vitest 86 files、1,406 passed、19 skipped；独立 Node host probes 8/8；`npm run typecheck` PASS。测试中的 worker failure、SQLite warning 和 supervisor output 是 fixture/预期诊断，不代表测试失败。
- Chromium loopback server与浏览器由 harness finally 关闭；此前用户 Host `3001`、RPC Node/浏览器及 `emulator-5554` 未触碰。验证器和隔离构建不关闭 Host 20 ms 正式窗口 FAIL、历史 Web 52 ms 原始归因、Mobile VM CPU incomplete、慢帧、native/实体设备及 policy-blocked scratch 删除。Goal 仍 **active / INCOMPLETE**。



### 10.11 2026-11-20 当前源码 Android 捕获与真实快速重开

详见 88-android-current-runtime.md。现有模拟器确实可继续验证：原 emulator-5554 的 .p86 锁屏遮挡/frame timeout 保留；随后复用自建 emulator-5556 / SwiftShader，当前源码 P5 的 unprofiled 与 diagnostic 均 complete，四 phase/断言/帧通过，102 CPU samples 无截断，20 ms 首尾 gate 为 12.393/9.018 ms，2,213/2,264 Timeline 无 gap，两个 manifest 各 6/6 SHA 一致。新样本更新“当前 P5 没有完整 CPU 捕获”的结论，不修复历史失败、不证明确定性采样或预算通过。

当前源码 browse 的真实目录/列表/正文与末条 marker 在两种模式均通过，unprofiled complete。Diagnostic 17,972/18,020 Timeline、528 CPU samples、首尾 7.978/2.425 ms；history_list 挂载帧 124 的两条截断栈（394/388 展开条目）仍使 CPU incomplete，不能移出窗口排除。新增设备级快速退出/切换/重开：真实 A 响应在 Host reader 完成后暂扣，B 10 项回复在 A 请求后 6,985.827 ms 到达且在 A 放行前显示，迟到 A 未 state_apply；缓存重开 B/A/A 内容正确。不证明越过阻塞中的 reader FIFO，也未断言每次条件 revalidation envelope 的 code。

两个当前 APK、source SHA、版本及 engine build-ID 来源链已归档；精确 Dart 3.12.2 revision 官方 VM filter 核实包含两个端点，不改 gate。Node collector/coverage 16/16 再次通过。两个新 fixture fleet_mutations=0、自身 cleanup 删除新根目录成功；自建 5556 已退出，61986/56125 无监听，旧受限 scratch、原 5554/QEMU 与 3001 Host 保留。本轮确实更新/启动了原 5554 的隔离 .p86，后已强停，不能沿用此前“该隔离包完全未触碰”的历史措辞。正式包/真实配对和 Hive 未清理。Goal 仍 active / incomplete；9f7c252c 历史提交保留，本次无新 commit/push/deploy。

### 同日快速重开条件校验补证

第二轮 %TEMP%/rp88-mobile-fast-navigation-v2-unprofiled-1795125439041 已补齐首轮未保存的响应 code。相同 APK/361 个源文件 SHA 未变；B 的 10 项成功响应在 A 请求后 6,953.070 ms 发送，B 正文可见后才放行 A，迟到 A 无 state_apply；B/A/A 三次缓存重开均正确，三条条件响应全部为预期 not_modified。Collector unprofiled complete、UI PASS、6/6 SHA 独立核对，完整事件与 fixture/UI driver 已归档。新增第三个 fixture 自身 cleanup 成功、fleet_mutations=0，rp86-host-GDa5dP 已不存在；自建 5556 再次退出，61986/56125/61177 无监听。细节及最终 cleanup-verification.json 见 88-android-current-runtime.md 和上述第二轮证据目录。browse CPU 两条截断栈及其他未过项不变；Goal 仍 active / incomplete。


### 10.12 2026-11-20 Host 逐 callback CPU/eLU 诊断

新增 --interval-counters，仅显式开启时按每个 raw callback 保存带读取括号的 process/main CPU 与 eLU 绝对快照，并强制 diagnostic/not_applicable，不能产生正式 PASS。工具回归 9/9 PASS。固定一次 60s standalone idle、60s imported idle、一次带 inspector 的 2,100 条 literal cold，五窗 25,684 raw / 25,689 快照全量对齐，保留 tail/GC/hash/读取开销，详见 92-host-interval-attribution.md 与 %TEMP%/rp92-host-interval-20261120T060907489。

两个无 inspector idle 各 37/34 个超限间隙，最大 drift 30.1271/31.8829 ms；这些新 outlier 的最低 eLU idle 占比为 96.960%/93.258%，最坏间隙 active 0.1768/0.2753 ms。Node v22.19.0 Windows libuv 来源核实线程 CPU 导出为毫秒字段乘 1000，0 短窗 CPU 不代表精确零 CPU。带 inspector 的冷建 median callback gap ~1.607 ms，与前两窗 ~15.512 ms 不同；其最大 13.1982 ms 不作正式 PASS，不用作旧失败的追溯归因，不扣 idle/不删 outlier。

新诊断补足了逐间隙观测，但未指向可确认的同步产品热点，未改产品、阈值或系统设置。最新既有正式 8 窗中 5 窗仍超 20 ms，旧 27.555 ms 与其他未过项保留；Goal active/incomplete。两个新 scratch/service 自身清理成功、所有自建 probe 退出，原 AVD/QEMU/3001 保留，旧受限删除未重试，无新 commit/push/deploy。


### 10.13 2026-11-20 Android VM native 栈补充

见 92-mobile-native-stacks.md。对已保存 P5/browse 的 47 个 Flutter PC，以 APK/SDK 同 build-ID 未剥符号库成功解析 47/47；不补造缺失运行调用者。新 --native-stacks 仅显式 diagnostic 可用，VM 必须回读 profile_vm=true，否则捕获前 fail closed；默认不写该 flag，原 coverage gate 不变，collector/coverage 16/16（含四个新增 mock launch 变体）。

相同 APK 固定补采一次 P5、一次 browse：P5 69 CPU samples，四 phase 通过，但尾 gap 24.182 ms，仍 incomplete；browse 三路径/末条可见、599 CPU samples、首尾 9.525/2.216 ms，但目录实际挂载帧 126 有一条 truncated（390 展开条目），仍 incomplete。两个 manifest 各 6/6 SHA 复算一致。额外模式下 61 个 Flutter offsets 有 60 个解析、0xcb04c0 原样未知。55 个 FreeType CFF 字节读取命中主要在启动/配对，正文目标帧仅 2 个；不据此修改字体或将整帧耗时归因给字体。上一轮默认 walker 的 P5 完整捕获不受这个不同配置的失败覆盖。

本轮产品 Dart/TS/APK 未变，仅外部 collector/测试以及 Host 诊断工具变更。自建 Host/5556 与映射已退出，fixture 根目录自身清理成功、零 Pi，原 5554/QEMU/3001 和旧受限目录保留；新证据/源文件/符号文件保留。Goal active/incomplete，无新 commit/push/deploy，不改原 gate。

### 10.14 当前源码 Android browse、XML 属性回归与 P5 原始复核（2026-11-20）

新增 `.orchestration/results/108-current-android-browse.md`。本节只更新本轮实际复测范围；整体 DoD 仍为 **INCOMPLETE**。

- P108 使用当前 `.p90` profile APK `rp100-browse-current-20261120`（SHA-256 `41933e2f97ddf9f33477bb4d48bad628beb6b7d14f06e3254ac436d7401ce91a`，185 项构建输入当前 SHA 一致）和新隔离 Host DB。Android 15 / SwiftShader `emulator-5556` 真正完成 onboarding → fixture workspace → history list → 点击 `P87_LARGE_8` → viewer 正文；可见首条 synthetic entry 4970，保存截图与 UI XML。
- capture validator `complete`、无 issue、21 stage records、0 dropped、534 raw frames；目录/list/read 三类样本的 viewport frame 均与 raw frame 完全匹配。首样本 intent→raster 703.161/196.033/558.663 ms。一次运行里 18 次 `building` list reply 后返回 1 ready；Host 20 次 observation、`fleet_mutations=0`、`zero_pi=true`、fixture removed。unprofiled 仍见 519/534 raster 与 14/534 build 超过16.667 ms，max raster 1245.789 ms；`performanceBudgetEvaluated=false`，故只判浏览/覆盖通过，不判预算通过。
- Android UI XML helper `p87_android_ui_xml.mjs` 处理单/双引号、数字及命名 XML entity、package filter；真实 P108 driver 直接导入该文件，证据包保存相同 SHA。独立 Node 回归3/3，collector-launch 回归含 XML 断言、21个 mock 变体与默认 flush 全部通过。首轮测试开发时因漏恢复 `createHash` import 有一轮 harness 失败；恢复 import 后完整运行通过，该次失败不是产品 PASS，亦未隐藏。
- P105 `--native-stacks` diagnostic 和 P106 默认 diagnostic 都实际到达可见正文、Timeline 无 stream gap、三路径 coverage 非CPU项完整，但严格 CPU gate 分别有6/5条截断栈，validator 均为 `cpu_truncated_or_invalid_stack`，performance budget 不评估。原始样本不删、不补、不调门槛。
- P98 当前源码 P5 的3份保存捕获均以当前原始输入 SHA、capture file SHA 和当前 `assessCapture` 再审：unprofiled 14帧、diagnostic 139 CPU samples、diagnostic-native 152 samples均 coverage complete、零 stack truncation/empty；全部 `performanceBudgetEvaluated=false`。P5 unprofiled仍有8个 raster>16.667 ms（max125.959 ms），因此 capture complete ≠ 性能通过。
- 自建 Host/DB、61986 listener、ADB reverse 与 `.p90` 进程已清理；自建5556已正常关闭，最终ADB只见原 `emulator-5554`，未操作其 App/配对/Hive。未 commit/push/deploy 或触碰生产 dist。

仍未关闭：Android diagnostic CPU strict coverage/native renderer 因果与实机、P5/ browse软件GPU慢帧、Host正式20ms整批失败、历史Web52ms原始栈、Web全负载完整驻留/物理屏幕证明、历史策略拒绝的旧scratch删除，以及现有commit约束例外。详细数值、哈希、失败与 cleanup manifest 见 `108-current-android-browse.md` 和对应 `%TEMP%/rp105-*`、`rp106-*`、`rp108-*` 原始证据。
### 10.15 最终串行回归与物理设备审计（2026-11-20）

当前 Mobile 并行全量曾有两个 fake-timer/scheduling 敏感测试失败：`clearActiveSession wipes rows, index, and in-memory turn state` 与 `no-echo send timeout (a) pending bubble is removed silently when no echo arrives`；两个精确项后续隔离复跑均通过，并在 Server/Web 并发结束后串行全量 Flutter **1059/1059 PASS**。最初失败日志 `%TEMP%/remote-pi-mobile-final-audit-20261120.log` 保留，不以通过结果覆盖失败历史。

Server 当前树序列重跑：typecheck PASS、Vitest **87 files / 1426 passed / 19 skipped**、独立 Node host probes **9/9 PASS**。Web 当前树 history gates **1190 checks**（protocol87/cache83/query917/lane35/window42/probe26）；隔离 Chromium React/session/history 回归 **15/14/23 PASS**、无 page errors。回归仅证明自身范围，不关闭 Host 20ms正式批次、Web 52ms历史归因或 Android 性能/CPU DoD。

当前设备枚举仅见原 `emulator-5554`；PresentOnly 物理 Android/ADB/Apple Mobile 设备未发现。P108 自建 5556/QEMU、端口、Host、reverse、`.p90` 进程均已结束；临时 AVD data root 删除被执行策略拒绝而保留，如 `.orchestration/results/108-current-android-browse.md` 所述。未触碰原 AVD/app/pairing/Hive。整体 Goal 仍 **INCOMPLETE**。
### 10.16 2026-11-20 重试计时修正、并发回归与新 APK 实测

详见 `.orchestration/results/109-mobile-intent-and-regression.md`。修复两个 Mobile 测试时序竞争；以两个修复前失败的测试确认并修复列表/正文 building 重试重置首次 intent 的测量缺陷，保留各次 request 起点。最终 Flutter 全量 **1,061/1,061**，两个 ViewModel 和两个修改测试文件 `dart analyze` 无问题。

补正§10.14：P108 列表196.033 ms只覆盖最后一次尝试，首次 intent→ready raster实际 **26,743.875 ms**。当前185输入哈希稳定的新 `.p90`（tag `rp109-browse-intent-20261120`）在自建5556的P110真实浏览中，17次列表请求共享一个首次intent，完整列表 **22,746.554 ms**，末次request→raster **206.806 ms**；目录/正文732.695/535.057 ms。6/6证据SHA、19 stage、0 dropped、635 raw frames和可见正文4970验证通过；14 build及528 raster超16.667 ms，`performanceBudgetEvaluated=false`。不同运行不作为产品提速证明。首次P109被SystemUI ANR遮挡的失败保留；点击Wait恢复后才用新fixture重跑。

P105/P106已有CPU/Timeline直接分析、6/6文件哈希及原gate重算完成，仍有6/5截断，覆盖保持incomplete；不把semantics/UiAutomator时间相关当精确因果，也不冒充native raster CPU证据。两轮新Host零Pi/零fleet mutation并自清理，5556/映射/端口已退出，仅原5554保留。既有Host20ms FAIL、Web52ms缺原栈、retainer证明范围、严格browse CPU、慢帧/native归因、实机及历史受限删除边界均保留。Goal不标complete，无新增commit/push/deploy。

## 10.17 2026-11-22 Host Linux 正式 20 ms 全批次与 CPU/eLU 补证

详见 `110-host-linux-formal-and-diagnostics.md`。沿用旧 GPT 会话“先 CPU 归因、最小优化、固定夹具串行重测、旧失败保留”的流程，使用官方哈希校验的 Linux Node v22.19.0 在 WSL2 Debian 的同一驱动/源码上预注册重跑：**8/8 windows PASS、56,086 raw callbacks、0 >20 ms**；literal 107,783,642 B（≥100 MiB）cold 最大 8.3735 ms、standalone idle 最大 4.9474 ms，全部 completion fence/overflow/cleanup 完整。单独 diagnostic 三窗完整，cold 主isolate 624/18,851 profile samples 中 619 为 idle/program，process CPU/eLU 与 GC 原始快照齐全；它明确不覆盖 worker tokenizer。独立 raw 复算、27 artifact SHA、source hash 稳定和 Host probes 9/9 通过。

Windows P97 的 1/8 PASS 与历史 27.555 ms FAIL 保留；Linux 结果不反推 Windows 或产品代码改善。Host DoD 在此限定 runtime 下可判 PASS，但历史 Web 52 ms 原始栈、完整 Web retainer、Android CPU 截断/SwiftShader 慢帧/native 因果、实体设备与旧受限目录仍未关闭。整体 Goal 仍 **INCOMPLETE**。

## 10.18 2026-11-22 Web full-workload retainer and generation

Detailed evidence: `111-web-full-workload-retention-generation.md`. Current artifact treeHash `ff0ace646d343e6e19f9a800beef391af5ece61d7221d28fd16536f1d8c0b57a` ran against a fresh zero-Pi Host with nine 5,000-entry sessions. V8 loaded 100 real pages, deep-scrolled 200 resident rows (`maxMounted=5`), made 96 revisits and switched all nine sessions. Five forced-GC checkpoints passed cache/view/height/Markdown budgets; at p100 cache was 8,308,276 bytes/52 pages/4 resident pages/200 view items/32 checkpoints/96 Markdown entries. After close, controller view/resident/view-items/checkpoints/pending were all 0; 29 bounded cache pages remained.

Five full V8 heap graphs had **0 items outside identified bounded page/view storage**. After close, 46 typed items remained via two React fibers (bounded, not zero-retention); nondebug graph excluded the explicit DevTools console root and retained the limitation. Original raw graph remains.

Runtime generation passed on the required stale path: while holding an old snapshot, a real transcript append rebuilt Host from 5,004 to 5,005 entries and changed generation; older read returned one `history_error/stale`; the client then issued exactly one new 253-byte head, received 50 fresh items (`cache_hit=false`), read count 232→233, and the new generation event/marker became visible in the newest page. Host observations independently repeat stale→new HEAD, then report `fleet_mutations=0`, `zero_pi=true`, `scratchRemoved=true`.

Current React session/history regressions remain 15/14/23, history gates 1,190 checks, pageErrors=0. Historical Web 52 ms CPU attribution remains BLOCKED because no original stack exists. Android CPU/native/SwiftShader, physical devices and old restricted scratch remain. Overall Goal INCOMPLETE.

## 10.19 2026-11-22 Final Goal blocker audit

After Host Linux formal/diagnostic closure and Web V8 full-workload retention/generation closure, all locally executable implementation and acceptance work is exhausted. Overall remains **INCOMPLETE/BLOCKED**: historical Web 52 ms lacks the original CPU stack; no physical Android/iOS device is present; Android browse CPU stacks truncate at Flutter VM depth 255 and SwiftShader/native raster causality is unavailable; old scratch deletion is execution-policy blocked. These conditions require external evidence/environment changes, not another threshold-free rerun. See `112-final-goal-audit-2026-11-22.md`. No commit/push/deploy; current HEAD remains the historical `9f7c252c`.

### 10.20 2026-11-23 Full-flow A → exit → B → immediate exit → A

New report: `113-full-flow-fast-session-navigation.md`. The exact rapid sequence now passes on both real surfaces.

Web (current artifact, real zero-Pi Host, isolated Chromium): six independent contexts did A-open/close, B read-request then immediate close, A reopen. A content reappeared in **3.409–5.104 ms** after model readiness (total click-to-stable 90.615–101.501 ms), `pendingReads=0`, A-only content, no page errors. In **5/6** cycles the B reply/full-page arrived after B was closed; A remained visible. Host ended `zero_pi=true`, `fleet_mutations=0`, `scratchRemoved=true`.

Android (current `.p90`, 185 stable inputs, owned Android 15/SwiftShader 5556, fresh real Host): two cycles A=P87_LARGE_8/B=7/A=8 and A=7/B=6/A=7. B viewer title was observed, then Back was sent immediately; A reopened with repository `first_content_ms=16/15`, `cache_hit=1`, 30 items, and screenshots visibly contain the correct `rp87-large-000x / 4970` bodies. Host observations show three `history_read_ok` plus three `not_modified`, ending with `zero_pi=true`, `fleet_mutations=0`, `scratchRemoved=true`. Capture coverage complete (28 stages, 0 dropped, 783 frames); unprofiled, so no performance-budget PASS.

All harness failures and earlier false-positive screenshots remain preserved. Self-created 5556 and Hosts were stopped; final ADB contains only the pre-existing 5554. This closes the rapid session-navigation functional requirement, not the historical CPU/physical-device blockers.

### 10.21 2026-11-23 Fast-session deterministic regression

The exact A close → pending B close → A reopen path is now also pinned by a Mobile ViewModel regression: A first loads and closes, B read is sent but held, B closes before reply, A reopens from its cached/ready state, and a later B reply cannot replace A. The focused test passes; the full history viewer file is 25/25 and final Flutter is **1,062/1,062 PASS**. Current Web deterministic session/history/viewer checks remain 15/14/23 with pageErrors=0 and 1,190 history gates. This does not change the separate CPU/physical-device limitations.

### 10.22 2026-11-23 Cold-cache A/B/A cancellation stress

Additional current Web stress in `%TEMP%/rp113-web-cold-rapid-20261123041007`: three fresh app-cache contexts performed A request → immediate close, B request → immediate close, A reopen. In 2/3 cycles both A and B replies were still pending at close; in all 3 B replies were pending. A reopened with correct body in 72/75/63 ms, pendingReads=0, no B content, pageErrors=0. Delayed B stages reached background cache but never replaced A. Host ended zero-Pi/zero-mutation/scratchRemoved. Combined with `113-full-flow-fast-session-navigation.md` and the deterministic Mobile regression, the requested rapid A/B/A functional path is closed; broader Goal blockers remain unchanged.

### 10.23 2026-11-23 Fixed-coordinate Android CPU diagnostic

Added `114-android-cpu-fixedtap-diagnostic.md`. A fixed-coordinate real browse (no `uiautomator dump` during capture) reached A8 body, B7 viewer, and A8 reopen; capture had 23 stages/0 dropped/722 raw frames, but still **5/1,457 truncated Dart stacks** at depths 384–458, concentrated in semantics/mount/rebuild. This rules out repeated UiAutomator dumps as the sole cause of the strict VM CPU stack failure. No samples were filtered or gate relaxed; native raster/SwiftShader CPU remains unavailable. The UI and non-CPU capture coverage passed, strict CPU remains incomplete.
