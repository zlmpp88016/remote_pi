# 70: DeepSeek Harness 视觉对齐方案 (1:1 Visual Parity)

> **目标**：将 `clients/web` 的整体视觉风格、色彩体系、控件形态、对话框、消息气泡、输入框与侧边栏从现存的暗黑科技青色（Cyan `#4fc3f7` + `#0b0f12`）**1:1 全面对齐**到 `deepseek-harness`（`http://127.0.0.1:3080/`）的官方经典视觉体系，同时保持既有业务逻辑与自动化测试 100% 兼容。

---

## 一、视觉证据基准与不可破变更契约

### 1. 真实视网膜基准证据
- **CDP 截图存盘**（位于 `clients/web/scripts/_e2e-evidence/comparison/`）：
  - `dsh-initial.png` / `dsh-dark-mode.png`：DSH 主界面（侧边栏、工作区、悬浮输入框、主画布）
  - `dsh-composer-typing.png`：DSH 正在输入时的悬浮胶囊卡片状态
  - `dsh-more-dropdown.png`：DSH 左下角“更多”浮层菜单（毛玻璃质感、圆角、菜单项高亮）
  - `dsh-dialog-apikey.png` / `dsh-dark-settings.png`：DSH 模态对话框（遮罩层、28px 超大圆角卡片、Header 布局、按钮体系）
  - `dsh-settings-模型.png` / `dsh-settings-内置插件.png`：DSH 设置面板分栏
  - `dsh-model-picker.png` / `dsh-add-menu.png`：模型选择弹层与指令菜单
- **423 个运行时真实 Design Tokens**：
  - 提取自运行态 DSH，持久化于 `clients/web/scripts/_e2e-evidence/comparison/dsh-live-tokens.json`。

### 2. 自动化测试与 DOM 契约（零破坏红线）
为了防止样式重构破坏现有的测试体系（14 个自动化 checks 与 11 行真实会话 E2E），以下**语义选择器与无障碍属性严禁修改或删除**：
- `aria-label="Read session ${sessionLabel(session)}"`（E2E 点击读取核心）
- `button[title*="running"]` / `button[title*="stopped"]`（工作区选择器）
- `section[aria-label="Sessions"]` / `aria-label="Workspaces"`（面板定位器）
- `aria-label="Model: ${label}"`（模型选择器触发）
- 所有的无障碍属性和 DOM 节点层级保持兼容，样式改动仅通过 CSS Modules 类名与设计 Token 生效。

---

## 二、核心色彩与设计系统 Token 架构

### 1. 主题与基础声明
- **色彩方案**：显式声明 `:root { color-scheme: dark; }`，约束浏览器原生表单控件、滚动条、`caret` 与文本选区的暗色渲染。
- **排版字体栈**：
  - UI 界面：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif`
  - 代码/等宽：`"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- **选区高光**：`::selection { background: color-mix(in srgb, #5686fe 40%, transparent); color: #f9fafb; }`

### 2. 语义色彩 Token 映射表（Dark Mode 权威规范）

| 语义层级 | Token 名称 | 权威色彩值 (RGB) | HEX 对应 | 语义与可达性要求 (WCAG 2.1) |
|---|---|---|---|---|
| **画布底色** | `--dsw-alias-bg-base` | `rgb(21, 21, 23)` | `#151517` | 主聊天与内容视口底色 |
| **侧边栏底色** | `--dsw-specific-sidebar-fill` | `rgb(27, 27, 28)` | `#1b1b1c` | 侧边栏与代码块底色 |
| **卡片/输入框/气泡** | `--dsw-specific-input-major` | `rgb(44, 44, 46)` | `#2c2c2e` | 胶囊输入框、用户气泡、弹窗卡片 |
| **浮层毛玻璃底色** | `--dsw-menu-surface-fill` | `rgba(67, 69, 74, 0.45)` | - (20px blur) | 下拉菜单、上下文菜单背景 |
| **全屏遮罩底色** | `--dsw-alias-bg-mask-1` | `rgba(0, 0, 0, 0.50)` | - (8px blur) | 模态框全屏遮罩蒙层 |
| **Primary 文本** | `--dsw-alias-label-primary` | `rgb(249, 250, 251)` | `#f9fafb` | 对比度 17.4:1（超额满足 AAA 级 7:1） |
| **Secondary 文本** | `--dsw-alias-label-secondary` | `rgb(207, 211, 214)` | `#cfd3d6` | 对比度 12.1:1（满足 AAA 级） |
| **Tertiary 文本** | `--dsw-alias-label-tertiary` | `rgb(173, 178, 184)` | `#adb2b8` | 对比度 8.5:1（满足 AA 级 4.5:1） |
| **Caption / 占位符** | `--dsw-alias-label-caption` | `rgb(154, 160, 168)` | `#9aa0a8` | **修正**：提亮至 5.29:1（满足 AA 级 4.5:1，杜绝 WCAG 违规） |
| **DeepSeek 品牌蓝** | `--dsw-static-deepseek-450` | `rgb(86, 134, 254)` | `#5686fe` | 品牌重点强调、链接色、主要按钮默认底色 |
| **高亮蓝 (Send/Active)**| `--dsw-static-deepseek-400` | `rgb(122, 170, 255)` | `#7aaaff` | 聚焦环、暗色悬停高亮、Caret 光标颜色 |
| **状态色 - 成功** | `--dsw-alias-state-success` | `rgb(34, 197, 94)` | `#22c55e` | 运行状态、健康检查通过 |
| **状态色 - 警告** | `--dsw-alias-state-warn` | `rgb(245, 158, 11)` | `#f59e0b` | Token 消耗预警、警告提示 |
| **状态色 - 错误** | `--dsw-alias-state-error` | `rgb(242, 90, 90)` | `#f25a5a` | 错误气泡、连接失败提示 |
| **交互 Hover** | `--dsw-alias-interactive-bg-hover` | `rgba(255, 255, 255, 0.08)` | - | 条目悬停背景 |
| **交互 Active** | `--dsw-alias-interactive-bg-active`| `rgba(255, 255, 255, 0.16)` | - | **修正**：提升至 0.16 显著拉开与 hover 差异 |
| **键盘焦点环** | `--dsw-focus-ring` | `2px solid #7aaaff` | - | `:focus-visible` 专用外环，偏移 `2px` |

### 3. Hairline 微阴影与多 DPR 渲染容错
- **微阴影与描边 (`--dsw-elevation-soft`)**：
  `0 0 0 0.5px rgba(255, 255, 255, 0.12), 0 4px 16px 0 rgba(0, 0, 0, 0.03), 0 0 24px 0 rgba(0, 0, 0, 0.03)`
- **弹窗强阴影 (`--dsw-elevation-prominent`)**：
  `0 0 0 0.5px rgba(255, 255, 255, 0.20), 0 3px 8px 0 rgba(0, 0, 0, 0.04), 0 0 20px 0 rgba(0, 0, 0, 0.05)`
- **多 DPR 渐进增强策略**：
  - 在 `@media (-webkit-min-device-pixel-ratio: 1.5), (min-resolution: 144dpi)` 环境下保持 `0.5px` 精准发光描边。
  - 在标准 DPR=1 屏幕上，通过纯 CSS `rgba(255, 255, 255, 0.08)` 1px 细线作为优雅回退，避免 Windows 亚像素抗锯齿虚边。

### 4. 圆角规范阶梯 (Corner Radii Scale)
- `sm`: `8px`（小按钮、快捷键提示徽标、微型标签）
- `md`: `12px`（侧边栏列表行、新会话按钮、设置条目、代码块）
- `lg`: `16px`（功能面板容器、卡片外框）
- `xl`: `20px`（用户消息气泡、工具调用卡片）
- `panel`: `28px`（悬浮输入框胶囊卡片、模态对话框卡片）
- `pill`: `999px`（Send 按钮、圆形 Add 按钮、状态指示胶囊）

---

## 三、组件级 1:1 像素与契约规格

### 模块 A：悬浮胶囊输入框 (InputBar)
- **外层卡片 (`.card`)**：
  - 容器类型：`container-type: inline-size;`，支持内部根据自身宽度自适应。
  - 居中悬浮布局：`margin: 0 auto; max-width: min(860px, calc(100% - 32px));`，离底边留白 `12px`。
  - 背景：`#2c2c2e`，圆角：`28px`，阴影：`--dsw-elevation-soft`。
- **文本输入区 (`.input`)**：
  - 纯透明背景、无内嵌框线，`outline: none;`。
  - 字号 `14px`，行高 `24px`，文字 `#f9fafb`，光标 `caret-color: #7aaaff`。
  - 占位符：`#9aa0a8`，文本：“描述你想要构建的内容, / 调用指令, @ 文件或对话”。
  - 最小高度 `36px`，上限 `240px`（内部平滑滚动）。
- **工具栏 (`.row`) 与响应式折叠逻辑**：
  - **左侧**：
    - 圆形 Add 按钮：`28x28px`，背景 `#353638`，圆角 `999px`，加号图标，带有 `aria-label="添加文件或调用指令"`。
    - 模式切换药丸（Permission/Mode）：高度 `28px`，圆角 `12px`，背景 `rgba(255,255,255,0.08)`，字体 13px。
  - **右侧**：
    - 模型选择触发器：药丸外观，带有下拉箭头和 `aria-haspopup="menu"`。
    - **Send 按钮**：**34x34px 正圆形**，圆角 `999px`，底色 `#5686fe`（暗色高亮），中心为纯白色向上箭头图标，带有 `aria-label="发送消息"`。
    - 状态反馈：输入为空时 `opacity: 0.4; cursor: default;`；流式响应中图标 Morph 变换为带圆角方形的停止按钮。
  - **容器查询响应式降级**：
    - 当容器宽度 `@container (max-width: 560px)` 时：模式药丸缩减为图标形态，工具间距从 `12px` 降至 `8px`，保证文本输入区至少保留 `180px` 呼吸空间。

### 模块 B：对话流与消息气泡 (Chat Transcript)
- **对话内容列**：
  - 内容列居中最大宽度：`min(860px, 100%)`，与输入框保持严格的垂直对齐中轴线。
- **用户消息气泡 (`.userBubble`)**：
  - 右对齐，最大宽度占内容列宽度的 `70.2%`（移动端放宽至 `82%`）。
  - 背景：`#2c2c2e`，圆角：`20px`（大药丸弧线），内边距：`10px 16px`。
  - 文字：`14px`，行高 `22px`，颜色 `#f9fafb`。
- **助手输出流 (`.assistantStream`)**：
  - 左对齐，无气泡框，流式 Markdown 直接铺展在 `#151517` 底色上。
  - 段距 `16px`，正文行高 `24px`。
- **深度思考折叠条 (`ReasoningRow`)**：
  - 头部行：左侧 14px 思考图标 + “思考过程” + 2px 分隔点 + 浅灰色次要文字摘要（单行截断省略）。
  - 支持吸顶：`position: sticky; top: 0; z-index: 5; background: #151517;`，防止向上滚动时文字被底层穿透。
  - 展开区：左缩进 `22px`，字号 `13px`，行高 `20px`，字色 `#adb2b8`。
- **代码块 (`CodeBlock`)**：
  - 顶部工具栏：背景 `#2c2c2e`，上圆角 `12px`，语言标识（小写灰色）+ 复制按钮。
  - 代码主体：背景 `#1b1b1c`，下圆角 `12px`，JetBrains Mono 13px，水平滚动。

### 模块 C：模态弹窗体系 (Modals & Dialogs)
- **全屏遮罩与焦点闭环**：
  - `position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.50); backdrop-filter: blur(8px);`。
  - A11y 闭环契约：`role="dialog"`、`aria-modal="true"`，Esc 键自动关闭，弹窗挂载时自动捕获焦点至第一个可聚焦元素，卸载时恢复触发控件的焦点；弹窗开启时背景视口 `overflow: hidden;`。
- **弹窗卡片主体**：
  - 宽度：常规连接/提示弹窗 `min(440px, 92vw)`，高级设置面板 `min(720px, 94vw)`。
  - 背景：`#2c2c2e`，圆角：`28px`，阴影：`--dsw-elevation-prominent`。
  - 头部：内边距 `22px 20px 12px 24px`，标题 16px 权重 500，右上角 28x28px 关闭按钮（带 `aria-label="关闭"`）。
  - 底部操作栏：次要按钮（透明底 + 1px 白色描边，圆角 10px，高 36px）；主要按钮（实心 `#5686fe` 蓝底白字，圆角 10px，高 36px）。

### 模块 D：浮层与下拉菜单 (MenuSurface)
- **容器规范**：
  - 背景：`rgba(67, 69, 74, 0.45)`，`backdrop-filter: blur(20px)`，圆角 `12px`，描边 `1px solid rgba(255, 255, 255, 0.12)`。
  - 菜单项：高度 `34px`，圆角 `8px`，hover 时背景 `rgba(255, 255, 255, 0.08)`，文字 14px `#f9fafb`。
  - 涵盖控件：模型选择弹层、Slash 指令建议列表、设置与操作菜单。

### 模块 E：左侧导航与工作区切换栏 (SidebarRoot)
- **侧边栏底色与边界**：
  - 整体背景 `#1b1b1c`，右侧边线 `1px solid rgba(255, 255, 255, 0.06)`。
- **品牌区域**：
  - Remote Pi 品牌 Logo + 18px 粗体名称 + 10px 高度的暗底版本号徽标（"0.7.0"）。
  - 右侧收起按钮（28x28px），支持无缝收起为极窄图标轨 (Rail)。
- **新建会话按钮 (`.newSession`)**：
  - 高度 `38px`，圆角 `12px`，微凸起背景 `#232324`，边框 `rgba(255, 255, 255, 0.16)`，鼠标悬浮时淡入 `Ctrl+N` 快捷键提示。
- **工作区列表项**：
  - 行高 `36px`，圆角 `12px`，选中状态带有 `rgba(255, 255, 255, 0.08)` 柔光背景和状态指示圆点。
- **底栏配置入口**：
  - 左下角放置“更多 / 设置”按钮，点击唤起标准的 DSH 风格浮层菜单。

---

## 四、实施路线图与阶段划分

| 阶段 | 核心任务 | 具体文件与改动 | 验证与验收目标 |
|---|---|---|---|
| **P1** | **设计 Token 与底层 CSS 注入** | `src/styles/design-platform.css`, `global.css`, `properties.css` | 注入完整的 DSH 423 tokens，声明 `:root { color-scheme: dark }`，全站画布切为 `#151517` |
| **P2** | **模态对话框与浮层系统 1:1** | `connection-launcher.*`, `Modal.*`, `MenuSurface.*`, `slash-menu.*` | 28px 圆角卡片、A11y 焦点环、毛玻璃模糊浮层、标准主次按钮 |
| **P3** | **悬浮胶囊输入框 (InputBar) 1:1** | `transcript-panel.*`, `recipes.*`, `controls.*` | 28px 悬浮卡片、34px 正圆发送按钮、28px 圆形加号、模式切换药丸 |
| **P4** | **消息流、气泡与思考折叠条 1:1** | `transcript-panel.*`, `markdown.*`, `session-viewer.*` | 用户气泡 #2c2c2e + 20px 圆角；ReasoningRow 吸顶折叠；CodeBlock 双段圆角 |
| **P5** | **左侧栏与多工作区导航 1:1** | `workspace-sidebar.*`, `remote-pi-shell.*`, `right-rail.*` | 侧边栏 #1b1b1c、38px 新会话按钮、工作区 12px 圆角行、底栏设置菜单 |
| **P6** | **全链路视觉指纹与业务防回归验证** | CDP 视网膜对比、`run-web-checks`、`_e2e-verify-rows` | 14/14 checks 全绿、tsc 0 错、11/11 E2E 真实会话行全通过、CDP 截图与基准肉眼 1:1 |

---

## 五、审查决议记录

- **评审员 1 (`step-5-preview`)**：
  - 核心贡献：指出了占位符色阶对比度不足（提亮至 `#9aa0a8`，对比度达 5.29:1）；强调了 `:root { color-scheme: dark }` 必须显式声明以防止原生控件撕裂；规范了多 DPR 下的 Hairline 渐进增强策略。已全部吸收采纳进本规范。
- **评审员 2 (`gpt-6.1-sol` High Thinking)**：
  - 核心贡献：指出了 DOM 语义属性必须冻结（严格保护 `aria-label="Read session ..."` 等测试选择器不受样式改动波及）；强化了模态框的 A11y 焦点陷阱与 Escape 键闭环契约；规范了容器查询在窄屏下的折叠行为。已全部吸收采纳进本规范。
- **最终决议**：**全票通过并批准进入 Phase 1 实施。**

---

## 六、Definition of Done

- [x] **P1 设计 token**：`src/styles/design-platform.css` 落地 DSH 权威 token（static neutral-bluish 阶梯 + alias 层 + radius 4/8/12/16/20/28/999 + elevation soft/prominent/panel + focus ring + motion + `color-scheme: dark`）；`global.css` 头部 import 并按 `@layer theme` 声明；旧 Cyan/Teal 全部清零（24 处 `#4fc3f7` → DSH 蓝），legacy 变量名（`--green`/`--ink`/`--card`/`--line`/`--r-*`）全部重指向 DSH token。
- [x] **P2 模态与浮层**：`primitives/modal.tsx` + `modal.module.css`（28px 圆角 `#2c2c2e`、`elevation-prominent`、遮罩 `rgba(0,0,0,.5)` **无 blur**（与 DSH `--dsw-mask-blur: none` 一致）、`role=dialog`/`aria-modal`/`aria-labelledby`+`describedby`、焦点入口、Tab 焦点陷阱、Esc、焦点归还、scroll 锁）；接入真实 Unpair 二次确认；`slash-menu` 与 `model-picker` 改 DSH MenuSurface（`rgba(67,69,74,.45)` + `blur(20px) saturate(150%)` + 12px 圆角 + hairline elevation + 无 backdrop-filter 时不透明回退 + 34px/8px 菜单项 + focus-visible）。
- [x] **P3 InputBar**：`container-type: inline-size`、居中 `min(860px, 100%)`、`#2c2c2e`、28px 圆角、`elevation-soft`、border 0；textarea 透明无边框 14px/24px、caret `#7aaaff`、placeholder `#9aa0a8`、min 36px / max 240px；28×28 圆形 Add（`#353638`）、34×34 正圆 Send（`#7aaaff`，白箭头，禁用 0.4）；`@container (max-width:560px)` 降级（gap 8px、药丸转图标、输入区保底 180px）。
- [x] **P4 对话流**：用户气泡 `#2c2c2e` + 20px 圆角 + padding 10/16 + 14px/22px + pre-wrap + `max-width: min(calc(860px * 0.702), 82%)`；助手无框流式（`.agentTurn` gap 16px、`.agentBody` 14px/24px）；`chat/reasoning-row.tsx` + module（sticky top 0 / z-index 5 / **不透明** `#151517` 背景、`aria-expanded`+`aria-controls`、单行 ellipsis 预览、展开区缩进 22px 13px/20px `#adb2b8`、2px 分隔点、`prefers-reduced-motion`）；代码块双段（banner `#2c2c2e` 上圆角 12px + 语言标签 + 始终可见的 copy；body `#1b1b1c` 下圆角 12px + JetBrains Mono 13px/20px）；tool 卡片去边框改 4% wash + 12px 圆角。
- [x] **P5 左侧栏**：`#1b1b1c` 实底 + 右侧 `rgba(255,255,255,.06)` hairline；品牌名 18px；版本徽标改 4px 圆角无边框 0.08 wash；工作区行 36px 高 / 12px 圆角 / border 0 / 选中 0.08 wash；状态点改 6px 圆点（success green）不再越界溢出；底栏设置项 12px 圆角 + hover wash。
- [x] **P6 验收**：新建 `scripts/verify-visual-parity.mjs`（token 25 项 + 元素默认 8 项 + 对 DSH 深色基线 18 项 + 侧栏 6 项 + 输入框 10 项 + 对话框 10 项 + 用户气泡 7 项 + 思考条 9 项）。
- [x] 五条验收命令全绿（见下）。
- [x] 硬约束未破坏：`aria-label="Read session …"` / `button[title*="running"]` / `section[aria-label="Sessions"]` / `aria-label="Workspaces"` / `aria-label="Model: …"` 全部保留，E2E 11/11、`run-web-checks` 14/14、Electron 壳三路由挂载均通过。
- [x] 三处 tsc（web / server / shell）均 0 错；`eslint src --max-warnings 101` 0 error。
- [x] **`session_switch` 的 `no_sdk` 已真修**（不是只显示为不可用）：daemon 用 `--session <path>` 重启到目标会话，双向切换实测成功，未走 crash backoff（第九节）。
- [x] E2E 行校验器修掉两个真实盲区（同名行碰撞、命名行按 id 断言恒败），修后稳定 11/11（第十节）。
- [x] **用户实测「点了没反应」的四个真实缺陷已修**（第十一节）：Refresh 把 MouseEvent 当 adapter 传入、列表请求无超时导致面板永久冻结、switch 后客户端从不重列、ghost peer 累积。新增 `scripts/verify-sessions-switch.mjs` 回归 gate（连续两次 PASS）。

### 验收命令与实测结果

```bash
cd clients/web && node scripts/verify-stack-parity.mjs   # stack parity: OK
cd clients/web && npx tsc --noEmit                       # 0 errors
cd clients/web && node scripts/run-web-checks.mjs        # 14/14 runners OK
cd clients/web && node scripts/_e2e-verify-rows.mjs      # 11/11 rows verified
cd clients/web && node scripts/verify-visual-parity.mjs  # visual parity: OK
```

### 与 DSH 的刻意偏离（仅两处，均有理由）

1. **`--dsw-alias-label-caption` = `#9aa0a8`**（DSH 深色为 `#81858c`）。DSH 的值在 `#2c2c2e` 卡片上是 3.76:1，低于 WCAG AA 文本 4.5:1 门槛；占位符承载输入提示，故提亮到 5.29:1。`verify-visual-parity.mjs` 把该偏离写成断言，防止它悄悄漂回。
2. **遮罩不加 `backdrop-filter`**。DSH 的 `Modal.module.css` 写了 `backdrop-filter: var(--dsw-mask-blur)`，而该变量实测为 `none`；照抄会引入 DSH 并不存在的毛玻璃。毛玻璃只用于 MenuSurface（`blur(20px)`，与 DSH 的 `--dsw-menu-backdrop-filter` 一致）。

### 已知局限（如实记录，不掩盖）

- **思考折叠条无真实数据来源**：协议只有模型能力位 `reasoning: boolean`，没有 reasoning 文本字段。组件已实现并通过挂载验证，但当前不会在真实会话中渲染——这是**数据缺口**，不是样式缺口。
- **DSH 实例无会话流**：`127.0.0.1:3080` 未登录、无可用模型，其首屏只有空态。气泡 / 思考条 / 代码块的几何依据是 DSH 的 `ui-chat`、`ui-conversation` 源码 + 深色 token 实测，而非 DSH 自身截图。
- **「新建会话」条未实现**：协议有 `session_new`，但 `adapter` 无对应方法，补它需要贯穿 protocol/client/adapter/store 的 wire 改动，超出本次视觉对齐范围，故未伪造一个不可用的按钮。

---

## 七、端口缺陷修复（验收后追加）

`npm run dev` 曾报 `Port 3010 is already in use`，而所有验证脚本写死 `localhost:3000`。两者不一致，根因是栈迁移时 `vite.config.ts` 把端口设成 3010，但 20+ 个脚本从未同步。

更危险的是 `scripts/_cdp.mjs` 原来的选页逻辑：

```js
const page = pages.find((t) => t.url.includes("localhost:3000")) ?? pages[0];
```

3000 上无服务时它**静默回退到浏览器里任意第一个页面**。任何 `evaluate()` 都会在一个脚本从未导航过的文档上求值 —— 绿灯于是失去意义。这正是"全绿验收"最危险的失效模式：不是断言写错，而是断言根本没有测到被测物。

修复：

- `_cdp.mjs` 从 `vite.config.ts` 正则读出端口，导出 `APP_ORIGIN`；选页改为按 `new URL(APP_ORIGIN).host` 匹配，**无回退**，找不到就抛错并列出浏览器里实际存在的 URL。
- 20 个脚本的硬编码 URL 全部改为 `APP_ORIGIN` 拼接；`e2e-panels.mjs`（自带 CDP 客户端、不 import `_cdp.mjs`）改为本地读同一份 `vite.config.ts`。
- README / README.zh-CN.md 的 `npm run dev` 端口改为 3010，并说明验证脚本的端口来源与配对前提。

修复后在同一 Chrome、同一 relay 上重跑：`verify-visual-parity.mjs` 96 项全过 / 0 失败，`_e2e-verify-rows.mjs` 11/11，`e2e-panels.mjs` 11 passed / 0 failed（真实 wire 帧 `pair_request, host_hello, workspace_list, session_list`，39 行会话），`verify-web-chat-rows.mjs` 24/24。此前跑在 3000 上的绿色结论作废，以此轮为准。

### 教训

端口/URL 这类"看起来只是配置"的值一旦被硬编码在多处，就会和唯一权威源（`vite.config.ts`）漂移；而**带回退的资源选择器会把漂移从"报错"降级成"静默测错对象"**。选择被测目标时宁可以找不到为由失败，也不要退而求其次。

---

## 八、布局高度链断裂（用户实测发现，视觉验收的盲区）

用户在 `localhost:3010/remote-pi/connect` 实测提出两个问题："主页面历史 session 能正常打开吗？能往下滑动吗？" 复现后确认是**同一个根因的两个表现**，且此前的全绿验收完全没能发现它。

### 现象

- 文档 `scrollHeight` 2612px，视口 945px；`body` 是 `overflow-y: hidden`。
- 输入框在 y≈2612 处 —— **既看不见也滑不到**（`composer: null`）。
- 侧栏与 transcript 的滚动容器 `scrollHeight === clientHeight`，即**没有任何东西可以滚**。

### 根因（三重叠加）

1. **`.shell` 没有自身高度**。`grid-template-rows: 36px minmax(0,1fr)` 的 `1fr` 只有在网格有确定高度时才等于视口；没有它，`1fr` 塌陷为内容高度。DSH 的 `AppFrame.module.css` 有 `height: 100%`，我们迁移时漏了。
2. **`global.css` 的选择器写错了 DOM 层级**。真实 DOM 是 `body > #root > .rp-app-shell`，而规则写的是 `body:has(.rp-app-shell) > .app` —— `#root` 从未拿到高度，下面每一层 `height:100%` 都解析到 `auto`。
3. **`<body class="... flex flex-col ...">` 是死类**。栈迁移删掉了 Tailwind utilities，`src/styles/` 里已无任何 `.flex` 定义，所以 `body` 实际计算为 `display: block`，`#root` 上的 `flex: 1` 完全惰性。这是最隐蔽的一环：类名还在、看起来合理、但什么都不做。

### 修复

- `app-shell.module.css`：`.shell` 补 `height: 100%` / `min-height: 0` / `overflow: hidden`；`.main` 补 `min-height: 0`。
- `global.css`：改为 `body:has(.rp-app-shell) > #root`（正确的层级），用 `display:flex` + `height:100%` 让高度确定，不再依赖已被删除的 `flex` 工具类。
- 效果：945px 一路贯通 `body → #root → .app → main → .shell`；输入框回到视口内（距底 102px）；历史会话 viewer 内部滚动 1026px 内容 / 760px 容器可正常滚到底。

### 验收盲区：为什么 96 项断言全绿却漏掉这个

`verify-visual-parity.mjs` 只测颜色、圆角、字号、组件盒子，**不测"页面是否是一个页面"**。高度链断裂时每一个 token 断言依然成立 —— 这是"全绿验收"最典型的失效模式：断言没错，但被测对象不在视口里。

新增 **第 0 段 layout invariants**（必须最先跑），断言：

- 文档不超过视口高度；
- `#root` 等于视口高度（而非内容高度）；
- `root / app / main / shell` 四层高度一致；
- 输入框存在且完整落在视口内；
- 打开历史会话后：viewer 挂载、仍不超出视口、有真实滚动容器、能滚到底。

真实结果：`composer sits 102px above the viewport bottom`（修复前约在视口下 1700px）、`history transcript scrolls 0 → 266 of 1026px`。

### 曾经的「未修缺口」：`switch` 报 `no_sdk` —— 已修（见第九节）

原结论是「宿主 Pi 未提供 `ctx.switchSession`，不能靠 CSS 修」。诊断正确，结论过窄：
客户端链路完整，宿主也**有**可用通路，只是当时没人走。修复见下一节。

---

## 九、`session_switch` 的 `no_sdk`：真因与修复

### 真因（file:line）

`switchSession` 只存在于 **command-capable** ctx：

- SDK：`server/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:276` —— 定义在 `ExtensionCommandContext`，不是普通 `ExtensionContext`。
- `server/src/index.ts:2248` —— `_lastCtx` 的类型被**刻意窄化**成 `Pick<ExtensionContext,"ui"|"abort"|"cwd">`，即只保留非 command 字段。
- `server/src/index.ts:2733` —— 它只在 `/remote-pi` 交互式命令 handler 里被赋值。
- `server/src/index.ts:1101-1104` —— 注释直说：`an RPC-mode daemon never does [capture a command ctx]`。

于是 RPC-mode daemon 里 `_lastCtx.switchSession` 恒为 `undefined`，`handlers.ts:handleSessionSwitch`
发 `session_switch_error { code: "no_sdk" }`。**客户端无缺陷**（`client.ts` / `adapter.ts` / `sessions.ts` 全链路完整）。

### 为什么仍然可修

Pi CLI 有 `--session <path|id>`（`.../dist/cli/args.js:235`）—— 能在**启动时**指定要打开哪个 session 文件。
而 daemon 本来就有「重启换会话」的先例：`/new` 走 `EXIT_DAEMON_FRESH_SESSION`（`rpc_child.ts:60`）
让 supervisor 重启时省掉 `--continue`。switch 只是把「省掉 --continue」换成「指向目标文件」。

### 实现

| 文件 | 改动 |
|---|---|
| `server/src/daemon/rpc_child.ts` | 新增 `EXIT_DAEMON_SWITCH_SESSION = 43`、`PENDING_SWITCH_FILE`、`stagePendingSwitchTarget()`、`takePendingSwitchTarget()`；`rpcSpawnArgs()` 增加第 4 参 `sessionPath`，有它时用 `--session <path>` **替代** `--continue`（两者回答同一个问题，同时给有歧义） |
| `server/src/index.ts` (`case "session_switch"`) | daemon 且无 `switchSession` 时：用**本机自己的** `listWorkspaceSessions(cwd)` 把 `session_id` 解析成路径 → 写 pending 文件 → 回 `session_switch_ok` → 稍后 `process.exit(43)` |
| `server/src/daemon/supervisor.ts` (`_onChildExit`) | 新增 43 分支：与 `/new` 同样处理 —— 立即重启、`restartAttempt = 0`、清空 `lastError`，**不计入** crash backoff |
| `server/src/actions/handlers.ts` | `can_switch` / `can_new` = `command ctx 可用 || REMOTE_PI_DAEMON === "1"`（此前把 daemon 误报成不可用） |

安全边界：路径由宿主**自己**从 listing 解析，绝不接受客户端传路径 —— 否则等于开放任意文件读。

### 验证（真实 Chrome + 真实 relay + 真实 daemon）

1. `node dist/index.js restart-supervisor` 让 supervisor 加载新代码。
2. UI 点 `switch`（目标 `01a14fbd`）：`session_switch_ok` 回来，pending 文件被消费，daemon 重启（`restarts=1`）。
3. 面板 LIVE 徽章确实从「糖果三口味」会话移到「鹈鹕 SVG」会话（即目标），旧 live 会话降级为历史行。
4. 反向再切回糖果会话：LIVE 又回到它。
5. `grep -c "scheduling restart"` = **1** —— 只有修复前那次走了 crash backoff；修复后的两次故意重启都没进 backoff 路径。

单元测试：`server/src/daemon/rpc_child.test.ts` 新增 5 条（`--session` 生效、`--session` 替代 `--continue`、
staged 目标只取一次、无 staged → undefined、损坏文件被消费且不抛）。`npx vitest run src/daemon/rpc_child.test.ts` 20 passed / 2 skipped（skip 是 POSIX-only）。

### UI 如实呈现

`session_list_ok` 新增 `can_switch` / `can_new`（缺省按 `true` 解释，旧 host 不改行为）。
客户端：`use-session-store` 的 `canSwitch` / `canNew` + `setCaps`；`dispatcher.ts` 在 `session_list_ok` 分支调用
`setSessionCaps`；`right-rail.tsx` → `session-list.tsx` 的 switch 按钮在 `canSwitch === false` 时 `disabled`
并给出准确原因（「无 command context 的 daemon」）。侧栏「New session」同样受 `canNew` 控制。

> 修复前实测：按钮 `disabled`，title = `This host cannot switch sessions: it has no command context`。
> 修复后实测：按钮可点，点击后真的切换成功。

---

## 十、E2E 行校验器的两个盲区（本轮暴露）

`_e2e-verify-rows.mjs` 原本 11/11 全绿，但那是**在只有 live 会话有名字**的前提下。
一旦真的切换过会话，旧的 live 会话降级成历史行时**仍然带着 agent 名**（`4.1f`），于是：

1. **label 不唯一**：出现两行都叫 `4.1f`。按 label `.find()` 永远命中第一行，另一行**永远无法被验证**。
   → 修：snapshot 时记录 `occ`（同名行里的序号），点击按 `label + occ` 定位。
2. **按 id 断言对命名行恒假**：横幅显示的是 `session.name || id`（`session-viewer.tsx:111`），
   命名行显示 `4.1f` 而非 hex，而校验器却在等 `/READ-ONLY\s+([0-9a-f]{8})/`。
   → 修：断言改为「横幅标题 === 该行 label」，两者同源；hex label 仍额外要求 `wire.session_id` 相符。
   同时把「等旧 id 消失」的第二段等待删掉 —— 与 `wireSid` 比较天然就不会被旧渲染骗过。

这两处都是**校验器**的缺陷（UI 行为是对的），但会让验收在真实使用后变红，必须修。修后稳定 11/11。

---

## 十一、用户实测「点了没反应」：四个真实缺陷

用户报告：打开页面点什么都毫无反应、session list 很久才出现、点 session 和 switch 都没反应。
用真实 Chrome CDP + 真实 relay 逐步复现后，定位到**四个独立缺陷**（不是样式问题）。

### 缺陷 1（最严重）：Refresh 按钮把 MouseEvent 当成 adapter 传入

`session-list.tsx` 写的是 `onClick={onOpen}`，而 `onOpen` 实际是 `requestSessions`：

```
requestSessions(adapterOverride?: RemotePiAdapter)
```

React 会把事件对象作为第一个参数传进来 → `adapterOverride` 收到一个 `MouseEvent` →
`adapterOverride.getSnapshot()` 抛 `TypeError` → 什么都没发生。按钮渲染为 enabled、
点击有视觉反馈、但请求一个字节都不发，`sessionsReqRef` 也不会被设置。

**这是在给 `requestSessions` 加上可选参数那天引入的**，零参 prop 类型 `() => void` 完全接受多传参数，
TypeScript 不会报错 —— 这类 bug 只有真机点击才暴露。

修：
- `onClick={() => onOpen()}`（不把事件漏进去）。
- 防御性加固：`requestSessions` 只接受真正带 `getSnapshot` 的对象，非 adapter 一律忽略。

### 缺陷 2：列表请求没有超时 → 面板永久冻结

`session_read` 早就修过这个问题（`connect-client.tsx:262` 的注释原话：「点击其他 session 看起来
什么都没发生」），但 `session_list` **从未**得到同样处理。`sessionsReqRef` 一旦因为丢帧而卡住，
之后每次请求都在 guard 处静默返回 —— Refresh、切工作区、switch 后的重列全部失效，直到整页刷新。

修：列表请求加超时（`SESSIONS_LIST_TIMEOUT_MS = 10s`），只在仍持有该请求时清 ref。

### 缺陷 3：switch 成功后客户端从不重新列表（LIVE 徽章不动）

`session_switch_ok` 到达后 `dispatcher` 确实调了 re-list，但**那一发必然落空**：
宿主回完 ACK 就 respawn 自己的 Pi 去指目标 session（第十节的 `--session` 路径），
这段时间没有 host room 能应答 `session_list`，回复根本不存在。

实测（解码后的帧）：`SENT: session_switch,session_list` / `RECV: workspace_state,workspace_state,session_switch_ok`
—— `session_list` 发出去了，永远没有 `session_list_ok`。

修：`relistAfterSwitch` 重试，**以「该 room 的列表对象真的变了」为停止条件**（不是「请求已发出」），
最多 40 次 / 800ms。配合缺陷 2 的短超时，重试才能真正穿透。

### 缺陷 4：ghost peer 累积让回复投递错乱

`~/.pi/remote/peers.json` 实测 **32 个 peer 全叫 "Remote Pi Web"** —— 每次 harness 重载都新建一个
peer，宿主从不回收。仓库里 `scripts/clean-stale-peers.mjs` 的注释已经写明后果：

> the host treats those stale identities as live peers ... one reply reaches the browser once per
> stale identity. The client sees the same `in_reply_to` twice and reports `duplicate_reply`,
> and the session list never settles.
> The correct fix for the product is on the host side (drop a peer when its key goes away).

清理后 32 → 1，前三个缺陷才可稳定测量。

**为什么没有直接改客户端复用密钥**：曾试过在 adapter 的默认 transport factory 里缓存 signer，
让同一页面复用同一个 `remote_epk`。`verify-web-recovery.mjs` 立刻红了 —— 它固定了这条安全契约：
「重连必须创建新 socket + 新 ephemeral key」（recovery 测试第 8 项）。该契约是有意的
（ephemeral App-key 每次握手轮换），不能为了省 peer 记录去破坏它，已回退。

所以 **宿主侧回收陈旧 peer 仍是待补的产品债**：当前只能靠 `scripts/clean-stale-peers.mjs`
局部缓解。已记录在案，不在本轮改动范围。

### 真实延迟（同一套 harness 实测，解码后统计）

| 动作 | wire | 首帧可见 |
|---|---|---|
| session_list | 1536ms | 1568ms |
| session_read | **9619ms** | 9716ms |
| switch ack | 2445~3300ms | — |

`session_read` 的 9.6s 是宿主侧读会话文件的耗时（`session_list` 只要 1.5s，同一 relay），
属于性能问题而非正确性问题，未在本轮处理。

### 复现 harness 的两个坑（写下来免得再踩）

1. `location.href = <同一个 URL>` **不会重载**，DOM 是上一次运行的残留 → 会测出「0ms」这种假数据。
   要 `location.reload()`。
2. `Network.enable` 必须在 reload **之后**调用；在 reload 之前开，抓到的是旧文档的 socket，
   `received` 一直是空的 → 所有 wire 断言都读成 `NONE`。
3. relay 帧是 base64 `{peer, ct}` 包装（可能多层）。解码要在 `ct` 链上一直剥离到底，
   停在第一个 `type` 只会拿到 `host_message` 外壳，永远看不到 `session_list_ok`。

### 回归 gate

新增 `scripts/verify-sessions-switch.mjs`（真浏览器 + 真 relay，故意不进 `run-web-checks.mjs`，
那套必须保持无传输依赖）。它断言两件事：Refresh 真的发出并收到列表；switch 后面板自己重列且 LIVE 徽章移动。
连续两次 PASS 截图 `_e2e-evidence/fix-verified.png`。

顺带：`verify-visual-parity.mjs` 的历史会话段原先**依赖标签页残留的工作区状态**（干净 profile 下
`hasLi:0` 直接失败）。已改为显式先选工作区 + 轮询等行，不再靠残留。

### 最终验收（本轮全部重跑）

`verify-stack-parity` OK · 三处 `tsc --noEmit` 0 错 · `run-web-checks` 14/14 ·
`_e2e-verify-rows` 11/11 · `verify-visual-parity` OK · `eslint` 0 error / 101 warning
（94+ 条来自 `connect-client.tsx` 既有的 `portsRef.current` 渲染期赋值模式）。
