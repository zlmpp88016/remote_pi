# 72 — Web 端按 DSH 真实参照重构左侧栏

## 一、为什么之前没做到（先把责任说清楚）

用户的问题：*"连 ui 都没变，为什么你没有按我说的保持 ui 一致，甚至连风格都没保持？"*

答案是**方法错了，而且从第一行就错了**：

1. **参照物选错（致命）**。我一直用 `_e2e-evidence/comparison/dsh-dark-tokens.json` 作为权威，
   并在 `plan/70` 里把它写成"深色权威基线"。但真实运行的 DSH web **默认是浅色**：

   | | DSH（127.0.0.1:3099 实测） | 我们的 web |
   |---|---|---|
   | `body` 背景 | `rgb(255,255,255)` | 深黑 |
   | 正文色 | `rgb(15,17,21)` | 浅灰 |
   | `color-scheme` | `light` | `dark` |
   | 左栏宽 | **280px** | 268px |
   | 左栏底色 | `rgb(249,250,251)` | 深色 |

   我把一个**深色变体**当成了默认界面，于是颜色/圆角/字号全部"对"在一个错误的底色上。
   整件事的方向从一开始就是错的。

2. **验证方式自欺**。`verify-visual-parity.mjs` 的 96 项全是**计算后 CSS 值**断言
   （某个元素是不是某个色值/圆角/字号）。一堆元素各自数值正确，整体构图、密度、层级、
   信息组织仍可以完全不像。我在 `plan/70` 里反复警告"假绿"这个失效模式，却亲手又造了一个。

3. **从没并排看过**。在此之前我从未把两个界面放在同一个视口下截图对比过一次。
   这是最不该省的步骤。

4. **信息架构也没有对齐**。DSH 左栏是：品牌 → 新会话 → 插件 → 自动化任务 → 工作区(搜索/筛选/新建)
   → 会话列表（含时间）。我们的是：品牌+版本徽标 → 过滤框 → `WORKSPACES 6` →
   一堆 `rp-live-ws-*` 测试残留 → **一整段开发者说明文字**。
   这不是"风格差异"，是从来没照 DSH 的构图做过。

## 二、参照获取方式（可复现）

```bash
# DSH 的 launch token 是进程内随机生成的，必须自己起一个实例拿到带 token 的 URL
cd /d/workspace/git_repo/deepseek-harness/apps/cli
node lib/bin.js web --port 3099          # 输出 dsh web: http://127.0.0.1:3099/?token=<TOKEN>
```

然后用 CDP 打开该 URL（token 会换 cookie，之后可直接访问根路径）。

**关键：不再使用 `dsh-dark-tokens.json` 作为默认基线。** 它只用于"深色模式"这个特定变体的对照，
默认界面以 `127.0.0.1:3099` 的运行时实测为准。

## 三、DSH 左栏实测规格（重构基准）

| 项 | 值 | 来源 |
|---|---|---|
| 列宽 | `280px` 固定 | `.sidebarCol` |
| 列底色 | `rgb(249,250,251)` | `.sidebarCol` |
| 右边框 | `1px rgba(0,0,0,0.12)` | `.sidebarCol` |
| 内边距 | `6px 12px` | `.root` |
| 正文色 | `rgb(15,17,21)` | `body` |
| 字体 | `-apple-system, BlinkMacSystemFont, "Segoe UI", …` 系统栈 | `body` |
| `color-scheme` | `light` | `html` |

内容顺序（从上到下）：**品牌行 → 新会话条 → 插件 → 自动化任务 → 工作区区（标题 + 搜索/筛选/新建）→ 会话列表（标题 + 相对时间）→ 底部「更多」**。

## 四、执行步骤

### 步骤 1 — 建立"并排"对比 gate（先做，否则还是在盲改）
新建 `scripts/verify-sidebar-parity.mjs`：
- 同一视口（1600×945）分别截 `127.0.0.1:3099` 与我们的 `/remote-pi/connect`；
- 对左栏做**结构性断言**：列宽、底色、右边框、内边距、行高、行圆角、字号、行间距；
- 断言内容顺序（品牌→新会话→…→会话列表→更多），而不仅是"有 6 个工作区"；
- 断言**不存在**开发者说明文字、`rp-live-ws-*` 测试残留。
- 验收：故意改错一个值必须变红（注入验证）。

### 步骤 2 — 切浅色主题
- `design-platform.css` 按运行时实测重建 **light** 为默认，深色降级为 `[data-theme=dark]` 变体；
- `global.css` 的 `color-scheme`、`body` 背景/前景、字体栈对齐 DSH；
- 逐屏修正因此暴露的颜色对比（原深色下的 AA 假设需重算）。

### 步骤 3 — 重构左侧栏 IA 与样式
- 280px / `#f9fafb` / 右边框 / `6px 12px` 内边距；
- 顺序对齐：品牌 → 新会话 → 插件 → 自动化任务 → 工作区（标题+搜索+筛选+新建）→ 会话列表 → 更多；
- 行高/圆角/字号按实测表；
- **删除开发者说明文字**；测试残留工作区不应出现在产品 UI（或在 dev-only 折叠区）。

### 步骤 4 — 会话内继续对话（用户第二条反馈）
用户："点开历史会话只能看到对话记录，不能在这个会话继续对话"。
当前 `session_read` 是纯只读 viewer。需要：
- 在只读 viewer 里提供明确的「在此会话继续」入口（等价于 switch 后再输入）；
- 或允许直接输入 → 先 `session_switch` 再发送。
- 验收：真实 CDP 点击 → 在历史会话里发一条消息 → 断言宿主确实在该会话继续，且 UI 如实反映。

### 步骤 5 — 回归
`verify-sidebar-parity` + 五条既有验收 + 三处 tsc + 并排截图存档。

## 五、DoD

- [x] 并排 gate 建立并做过注入验证（改错必红）
- [x] 默认浅色主题与 DSH 运行时一致（body/sidebar/边框/字体栈）
- [x] 左栏几何与 IA 对齐（280px / #f9fafb / 顺序 / 行规格）
- [x] 开发者说明文字与测试残留工作区移出产品 UI
- [x] 历史会话内可继续对话（真实 CDP 验证）
- [x] 五条既有验收仍在绿
- [x] 并排截图存档（ours vs DSH，同视口）

## 六、教训（写进流程）

1. **参照物必须是真实运行的产品**，不是导出的 token 快照；快照只作补充。
2. **视觉一致性只能靠并排看**，计算后 CSS 值相等是必要条件，绝不是充分条件。
3. 任何"全绿"结论都要问一句：这些断言如果被测对象整体换了个样子，还会绿吗？

## 七、实施结果（2026-10-24）

### 新增/修改的 gate

| 脚本 | 作用 | 状态 |
|---|---|---|
| `scripts/verify-sidebar-parity.mjs` | 并排对比：主题 / 侧栏几何 / IA 顺序 / 非产品内容不得出现 | **OK**（18 项，两次注入验证） |
| `scripts/verify-continue-from-history.mjs` | 历史会话继续对话端到端 | **OK**（11 项，一次注入验证） |
| `scripts/capture-side-by-side.mjs` | 同视口 1600×945 截图存档 | 产出 3 张 PNG |
| `scripts/_wire.mjs` | relay 帧解码共享模块 | 被上述 gate 共用 |

**注入验证记录**（证明断言非恒真）：

| 注入 | 结果 |
|---|---|
| `color-scheme: dark` → `light` | 该项单独变绿，其余仍红 |
| 侧栏右边框色 → `rgba(0,0,0,.12)` | 该项单独变绿，13 项仍红 |
| `showTestWorkspaces = true` | `FAIL absent: harness test workspaces` |
| 开发者说明塞进可见标签 | `FAIL absent: developer note` |
| `onClick={onSwitch}` → `onClick={() => {}}` | 继续对话第 3/4/5 项变红 |

### 主题（步骤 2）

`src/styles/design-platform.css`：`:root` 重建为 **light 默认**（DSH 自己的浅色 alias），原深色整套降为
`:root[data-theme="dark"]`。字体栈改为系统栈居首。`global.css` 的 `html { color-scheme }` 同步。

**踩到的坑**：浅色 alias 引用了 `--dsw-static-neutral-bluish-00/-1000/-60/-75/-200/-700`、
`deepseek-50/100/200/600`、`neutral-150/600/800`，而原文件只保留了深色用到的中间段。
CSS 变量引用未定义的值 → 整条 token 静默失效（`getPropertyValue` 返回空串、body 变透明）。
诊断方法：逐个 `getComputedStyle(root).getPropertyValue('--x')`，空的那批就是引用缺失色阶的那批。

### 左侧栏（步骤 3）

- 几何：280 px / `rgb(249,250,251)` / 右边框 `1px rgba(0,0,0,.12)`（用 `border-l3` 而非 l1：l1 的 4% 在浅色下几乎不可见）/ 内边距 `6px 12px`。
- IA：品牌 → New session → Plugins/Automations → 工作区（标题+内联搜索+刷新+计数）→ 会话列表 → More。
  `Plugins`/`Automations`/`More` 三个面本客户端未打通，渲染为 inert 行并写明原因（不做假按钮）。
- 修掉一个真实功能缺口：`New session` 原先要求 `activeRoom !== null`，而新建连接时没有 active room，
  实测 `hasNew: false` —— 该行在正常状态下根本不渲染。改为「宿主列了工作区就显示」。
- 删除非产品内容：`view-model.ts` 五段 CAPABILITIES reason（含 `list_models → models_list`、
  `pi_surface → pi_surface_ok`、`skill_invoke`、`plan/30`、`plan/71`）改写为用户语言；
  底部 `host_pairing · workspace_state · host_forward · fs_nav` 改为「N wire messages available」；
  `rp-live-ws-*` 幽灵工作区按命名前缀过滤（`VITE_SHOW_TEST_WORKSPACES=1` 可恢复）。

### 继续对话（步骤 4）

链路（`session_switch` → 宿主 stage → daemon `--session`）本就存在，两个地方让它实际不可用：
按钮是 10.5 px mono + `--muted` 色 + `#ffffff26` 边框（浅色下几乎不可见），文案 `switch to this session`
描述状态变更而非用户行为；且 respawn 窗口期无反馈。

改为 `.switchButton` 主行动按钮（`deepseek-500` 填充 / 白字 / 12px / 500 权重），文案
**`Continue in this session`**，新增 `switchBusy`（切换中显示 `Switching…` 并 disabled）与
`canSwitch`（来自 `session_list_ok` 的 `can_switch`）。

### gate 自身的缺陷（都在本轮修掉，不是放宽）

1. **`attach()` 依赖调用方 origin** → gate 把该页导航去 DSH 后第二次运行直接抛错。改为自建 target + 按 `webSocketDebuggerUrl` 直连。
2. **IA 探针按 `getBoundingClientRect().y` 排序** → DSH 的 `.sidebarCol` 直接子节点是 `display:contents` 的 0×0 包装层，导致参照侧永远返回空数组。改为按 **DOM 文档顺序**（纵向堆叠 ⇒ 文档序 = 视觉序）。
3. **聚合包装层污染 landmark 匹配** → 含整栏文本的祖先每次 `findIndex` 都命中同一位置（`14 >= 14`）。改为只收叶子文本。
4. **探针读了 `sr-only` 文本** → 无障碍描述合法地提到 wire 名；若算作可见，就只能靠删掉准确的无障碍文本来让断言变绿。改为只读可见文本。
5. **`_e2e-verify-rows.mjs` 的行快照只算一次** → 每次读取会按最近使用重排列表，第二次就用陈旧位置（间歇性 `wire=none ui=<相邻 id>`）。抽成 `readRows()` 每次点击前重算，连跑 4 次 11/11。
6. **两个 gate 各自复制帧解码器** → 新 gate 直接对 base64 原始 payload 做正则，所以 `sent/received` 里什么都匹配不到。提到 `scripts/_wire.mjs` 共用。
7. **switch 后帧监听失效** → switch 让客户端换新 relay socket，新 socket 的帧不出现在观察旧连接的 CDP 会话里（实测只剩 `session_list_ok`，而消息明明已送达）。改用**宿主 re-read 作为权威证据** —— 比帧监听更强，客户端伪造不了宿主存储。

### 验收结果

| 验收 | 结果 |
|---|---|
| `verify-stack-parity.mjs` | OK |
| `tsc --noEmit`（web / server / shell） | 0 错 ×3 |
| `run-web-checks.mjs` | 14/14 runners OK |
| `_e2e-verify-rows.mjs` | 11/11 rows verified |
| `verify-visual-parity.mjs` | OK |
| `verify-sidebar-parity.mjs` | OK |
| `verify-sessions-switch.mjs` | PASS |
| `verify-continue-from-history.mjs` | OK |
| `verify-shell.mjs`（三路由 + 配对 + 会话列表） | shell E2E: OK |
| `eslint src` | 0 error / 105 warning（上限同步实测） |

并排截图：`clients/web/scripts/_e2e-evidence/side-by-side/{01-dsh-reference,02-ours-connect,03-ours-workspace}.png`，
均为 1600×945。

### 仍然存在的差异（如实记录，不再冒充「已对齐」）

- DSH 的工作区行悬停/选中态比我们更明显（内部高亮块 + 左侧色条）；我们是轻量 wash + 活动点。
- DSH 会话行带相对时间列（`18分钟` / `6小时`），我们在会话列表段有时间但工作区列表段没有。
- 我们的窗口标题栏（`Remote Pi · lei` + host connected + Unpair）是 Electron 壳的 chrome，DSH 是纯网页没有这一条。
  本轮把它从硬编码 `#060606` 改为跟随主题，浅色下不再是一道黑边，但结构差异仍在（需要壳层面才可去掉）。
- `Plugins` / `Automations` / `More` 三个入口在 DSH 有真实面板，我们只有 inert 占位行。

