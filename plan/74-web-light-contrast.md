# 74 — Web 浅色主题的系统性对比度修复

## Contexto

用户连续两轮用真实截图指出 `clients/web` 在浅色主题下的可读性问题：

> 截图一个个看啊，workspace 区域的选中颜色、以及 class `_strong_16ttj_322` 为什么是白色的？选中才是黑色的？你不知道背景是白色的吗？

第一轮我只修了「扫出来的纯白元素」（16 个近白降到 5 个），漏掉了整类问题：**浅色主题下所有低于 WCAG 门槛的文字、所有被当成装饰的边框、所有 OS 原生控件**。用户的核心批评是对的 —— 不该只扫一类症状。

本轮是从「感觉字很淡」到「可量化、可回归、可注入验证」的系统性收口。

## 一、根因：一个继承，和三类遗留

### 1.1 全应用白字的唯一源头

`remote-pi-shell.module.css` 的 `.shell`：

```css
color: var(--color-white);   /* 修前 */
color: var(--dsw-alias-label-primary);  /* 修后 */
```

`.shell` 是应用根容器，这一行被**所有后代继承**。深色时代正确；浅色成为默认后，任何没有显式设色的区域（对话正文、空态标题、host 名、会话名）全部变成白底白字。

证据链：`_emptyTitle` 计算色 `rgb(255,255,255)` → 向上追祖先链 → `body` 是 `rgb(15,17,21)` 而 `_shell_1nenl_15` 是白 → 定位到这一行。

### 1.2 `var(--color-white)` 不总是错的

这是第一轮修复过窄的原因。同一个 token 在两类语境下语义相反：

| 语境 | 判断 |
|---|---|
| 实心深色/蓝色填充之上（`--dsw-static-deepseek-*`、`#4176e6`） | **正确**，白字是唯一可读选择 |
| 淡色 wash 或白底之上（`--dsw-alias-interactive-bg-hover`、`bg-layer-2`） | **缺陷** |

所以不能批量替换，必须逐个确认语境。本轮修的 13 处全部落在第二类。

### 1.3 三类遗留

| 类别 | 数量 | 后果 |
|---|---|---|
| `#ffffffXX` 硬编码边框/背景 | 67 | 浅色下完全消失 → 「划分不明显」 |
| `color-mix(in oklab, var(--color-white) N%, transparent)` | 32 | 在 `@supports` 块里二次覆盖，改了普通规则也无效 |
| 文字 `var(--color-white)` | 13 | 白底白字不可见 |

**`@supports` 陷阱**：`right-rail.module.css` 里 17 处 `color-mix(white...)` 位于 `@supports (color:color-mix(in lab,red,red))` 内，在普通规则之后生效。批量替换必须包含这些块，否则「改了但没效果」。

## 二、「很淡」的量化

不是主观感受，是实测：

| 色值 | 白底对比度 | 说明 |
|---|---|---|
| `rgb(151,157,166)` | **2.73:1** | 修前的 `--muted`，远低于 AA 4.5 |
| `rgb(129,133,140)` | **3.71:1** | 次级标签 |
| `rgb(97,102,107)` | **5.80:1** | 修后的 `--muted` |
| `rgb(15,17,21)` | **18.90:1** | primary |

`--muted` 原本指向 `--dsw-static-neutral-bluish-500` = `rgb(151,157,166)`。这是把 DSH 的**三级色阶**当成了正文从属色 —— 量级用错了，不是颜色选错了。

## 三、DSH 实测：一次被推翻的结论

> **本节记录一个被推翻的判断，连同推翻它的证据。** 最初我测出 DSH 自己用 `rgb(129,133,140)` = 3.71:1 做次级文字，据此认为「0 处 AA」与「不偏离 DSH」不可兼得，并请用户裁决降低门槛。**那个结论是错的** —— 我把 DSH 某个 token 的*取值*当成了需求，而真正的需求是 DSH 的*层级*。

### 3.1 读 root 变量是错的

DSH 的 `getComputedStyle(root).getPropertyValue('--dsw-alias-label-primary')` 返回**空串**。原因：它用 `var(--dsw-alias-label-primary, var(--dsh-boot-label-primary))` 的 fallback 链，token 定义不在 `:root` 上。

唯一可信的做法是采集**元素计算色**。

### 3.2 DSH 实际渲染的文字谱

扫描真实 DSH 页面所有可见文本节点，按计算色聚合：

| 色值 | 次数 | 字号 | 白底 | 用途 |
|---|---|---|---|---|
| `rgb(15,17,21)` | 13 | 12–26px | 18.90 | primary 正文/标题 |
| `rgb(129,133,140)` | 6 | 10–14px | **3.71** | secondary 标签/快捷键 |
| `rgb(255,255,255)` | 2 | 6–14px | 1.00 | 深色实心填充上的字 |
| `rgb(97,102,107)` | 2 | 13px | 5.80 | 次正文 |
| `rgb(173,178,184)` | 1 | 14px | 2.13 | 输入占位符（有意弱化） |

### 3.3 我错在哪

我看到的 `rgb(129,133,140)` 是 DSH **某个具体组件**渲染出来的值，就据此判定「DSH 的次级文字就是 3.71」。但 DSH 的 token 表里，`--dsw-alias-label-secondary` = `neutral-bluish-700` = **`rgb(97,102,107)` = 5.80:1**（`design-platform.css:223`），这才是它为「次级文字」这个角色声明的档位。`neutral-bluish-600`（3.71）是更弱的 tertiary。

也就是说：DSH 的层级链条是 **primary 18.90 → secondary 5.80 → tertiary 3.71**。我当时把 tertiary 当成了 secondary 在用，然后以为 DSH 只提供 3.71。

### 3.4 修正

`--faint` 原本指向 `--dsw-alias-label-tertiary`（3.71），44 处**全部**是文字（图标、placeholder、age、段落标题、disabled 标签），零装饰用途 —— 整个次级层都在 AA 线下。

改为 `--dsw-alias-label-secondary`（5.80）。层级仍然成立：primary 18.90 → secondary 5.80，tertiary 3.71 保留给真正装饰性的标记。

`--ink-dim` / `--ink-quiet` / `--ink-off` 共 10 处同样处理。另有 `_versionChip`、`_settingsButtonFull` 两处直连 tertiary 的也改到 secondary。

**结果：AA 4.5:1 达到 0 处不达标，gate 默认门槛回到 AA。**

### 3.5 一个不该被计入的项

`_sendButton` 报 4.23:1（白字 on `deepseek-500` `rgb(65,118,230)`）。但 DSH 的 `--dsw-alias-button-info-fill` **就是** `deepseek-500`，它自己也是 4.23 —— 这不是缺陷。而且这个按钮是 34×34 图标按钮、`font-size: 0`，白字只存在于 `sr-only` 里，**不是可见文本**。

gate 因此排除 `font-size: 0` 的元素（图标按钮借此隐藏标签、把语义交给屏幕阅读器）。这是修正审计口径，不是放宽标准 —— 判据是「是否可见」，不是「是否够淡」。

### 3.6 用户裁决与最终结论的关系

用户当时在 A/B/C 中选了 **A：以 DSH 为准，放宽到 3:1**。这个裁决的前提是「两者冲突」。既然冲突不存在（DSH 自己有 5.80 的档），就按更严的 AA 执行。

**这不是推翻裁决，而是超额满足它** —— 两个门槛同时实测为 0：

```
node scripts/audit-contrast.mjs --min 3     → OK (0 <= allowed 0) at AA 3:1
node scripts/audit-contrast.mjs --min 4.5   → OK (0 <= allowed 0) at AA 4.5:1
```

裁决要求的「3:1 底限」仍然成立（0 处），AA 4.5 是在此之上的额外盈余。用户选 A 的实质诉求「别为了过检查表而自创颜色」也被完整满足：所有改动都走在 DSH 自己的 token 档位上，零自创色值。

gate 默认门槛是 4.5，`--min 3` 可回到裁决基线。审计输出现在会打印实际门槛，避免「0 failing」在不同门槛下被误读。

## 四、绿色文字：DSH 从不用绿字

`--ok` = `--dsw-static-green-500` = `rgb(34,197,94)`，白底 **2.28:1**。`running` / `live` / `ok` 三个标签全部不达标（1.96–2.28:1）。

但 DSH 的文字谱里**没有任何绿色** —— 它把 green-500 只用于圆点、填充、进度条。我们的绿字是自创用法。

解法不是自创深绿，而是用 DSH 自己的暗色腿：

```css
--ok-text: var(--dsw-static-green-900);  /* rgb(35,60,44) */
```

依据：`design-platform.css:39` 在浅色块里定义了 `green-900`，且它正是 DSH badge 的官方配对 —— `green-900` on `green-100` = **10.98:1**，白底 11.97:1。

11 处文字 + `global.css` 2 处已换；3 处 `background-color: var(--ok)` 正确保留（背景不需要文字对比度）。

### 4.1 一个被 gate 抓出来的真 bug

第一版只加了 `--ok-text: var(--dsw-static-green-900)`，**但忘了在浅色段定义 `--dsw-static-green-900`**。CSS 变量引用未定义色阶时解析为 guaranteed-invalid，整条声明被丢弃 —— `--ok-text` 实测为 **EMPTY**，11 处 `running`/`live`/`ok` 静默回退到继承色。

它们没在审计里报红，因为继承到了可读色 —— 语义失效但数值合格，是最难发现的那类。

`verify-web-contrast-tokens.mjs` 就是为此写的：断言每个 token **解析后非空**，而非只检查最终颜色。加上 `--dsw-static-green-900: rgb(35,60,44)`（DSH `design-platform.css:39`）后，实测 `rgb(35,60,44)`，11.97:1。

同类陷阱本项目此前已踩过（`--muted` 指向未定义的 `neutral-bluish-500`），这次栽在自己新加的 token 上。

## 五、workspace 选中态：颜色完全反了

用户指出的核心 bug：

```css
.wsNameActive { color: var(--color-white); }   /* 白底白字，1.16:1 */
.wsNameIdle   { color: var(--ink-soft); }       /* 深色，可读 */
```

**未选中可读、选中不可读** —— 你正在看的那一行恰恰是你看不见的。

修复：

```css
.wsNameActive {
  color: var(--dsw-alias-label-primary);
  font-weight: var(--font-weight-semibold);
}
```

选中态已由行背景 wash 和状态点承担，文字只需最强层级 + 字重领先。

量化证据（新 gate `verify-workspace-selection.mjs`）：

| 状态 | fg | bg | 对比度 | 字重 |
|---|---|---|---|---|
| selected | `rgb(15,17,21)` | `rgb(236,238,240)` | **16.25:1** | 600 |
| idle | `rgb(97,102,107)` | `rgb(249,250,251)` | 5.55:1 | 400 |

修前 selected 是 1.16:1。

断言同时检查「selected 必须在 ratio 或 weight 上领先 idle」，防止未来又反回去。

## 六、macOS 交通灯

用户：

> 顶部那一栏，`_titlebar_19br2_56` 有什么存在的必要吗？主要是左上角也太垃圾了，windows 为什么要显示 mac 的主题？

### 6.1 判断依据

`clients/shell/src/main.ts:260`：

```ts
titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"
```

**非 macOS 使用原生窗口框**。所以这栏在 Windows 上：
- 不承担拖拽区（全库无 `app-region: drag`）
- 三个圆点没有任何行为

它们是纯装饰的 macOS 仿制品。删除。

### 6.2 为何保留该栏

它承载三样真实信息：host 名、`host connected` 状态、`Unpair` 按钮。且在 darwin 上壳用 `hiddenInset` 隐藏原生标题栏，这一行**就是**应用顶边，删掉会让 macOS 无可拖拽区。

所以：**删交通灯，留栏**。

## 七、原生滚动条（截图才发现的）

前几张截图里，输入框右侧有 `▲▼` 箭头，对话区和会话列表有粗灰滚动条。这些都是 Windows UA 滚动条 —— 我们**从未定义过任何滚动条样式**。

DSH 有专用的 alias token（`--dsw-alias-scrollbar-bg-l2` 等），我们缺失，导致回退到 OS 默认。

补法：
1. 补 `--dsw-static-neutral-200/300`（DSH 的纯灰色阶，只有这两步被用到）
2. 补 4 个 `--dsw-alias-scrollbar-*` token（DSH 原值）
3. `global.css` 加全局规则：`scrollbar-width: thin` + 8px thumb + 透明轨道 + 隐藏 `::-webkit-scrollbar-button`

实测滚动容器：`scrollbarWidth: "thin"`、`scrollbarColor: rgb(229,229,229) rgba(0,0,0,0)`。

### 7.1 一个致命的调试弯路

排查中截图出现顶部文字重叠（`4.1f` 与路径挤压、`Chat` 被图标压住），一度以为是移除交通灯后的布局回归。实测发现 `transcript-panel.module.css` 的 CSS 规则**在页面上根本不存在**，Vite 返回 `__vite__css = ""` —— **Vite CSS 缓存卡死**，不是代码问题。

`touch` 该文件后规则恢复（`_root_1rmfb_153` 回归），布局正常。

教训：dev server 下 CSS 规则凭空消失时，先查 Vite 缓存，别急着改代码。

## 八、Gate 与注入验证

### 8.1 `scripts/audit-contrast.mjs`（新）

扫描每个含直接文本子节点的元素，取计算色，对比**逐层合成的有效背景**，算 WCAG 比值。

两个关键实现细节（都是踩坑所得）：

1. **颜色解析不能用正则**。Chrome 会序列化成 `color(srgb r g b / a)` 和 `oklab()`，正则版本返回 NaN，导致 6 处真实缺陷被报成「无法测量」而不是红。改为 rgb/rgba 直解（保 alpha），其余用 canvas 绘图像素归一化。

2. **有效背景是整条祖先链合成，不是首个不透明祖先**。应用大量使用半透明 wash（选中行是 7% 蓝叠在侧栏色上），取首个不透明色会拿错底色。

### 8.2 `scripts/verify-web-contrast-selection.mjs`（新）

量化「selected 可读 + 强于 idle」，外加滚动条检查。

### 8.2b `scripts/verify-web-contrast-states.mjs`（新）

把审计跑遍 **4 个可达状态**：空态 / 选中工作区 / 右栏 dock 会话列表 / 有 markdown 内容的会话。

存在的理由：单次审计只证明「当时渲染的那个状态」。第一轮就是这样「通过」的 —— 而错误态里的 `_retryButton` 仍是白底白字，因为那个状态从未被触发过。

两个 gate 都已加入 `run-web-checks.mjs` 的 `SUITE`（16/16）。

### 8.3 注入验证表

| # | 注入 | 预期 | 实测 |
|---|---|---|---|
| 1 | `.root` 正文改 `rgb(250,250,250)` | 报红 | 26 → **29** ✓ |
| 2 | `.strong` 改回 `var(--color-white)` | 报红 | 0 → **2**，精确报 `_strong` 1:1 ×9 ✓ |
| 3 | `.wsNameActive` 改回白字 | 报红 | selected **1.16:1**，精确复现原 bug ✓ |
| 4 | 删 `scrollbar-width: thin` | 报红 | 2 个滚动容器报 `auto` ✓ |
| 5 | `--faint` 改回 `label-tertiary` | 报红 | 0 → **7**，精确报 `_age`/`_tabLabel`/`_title` 3.71:1 ✓ |
| 6 | `--faint` 改回后跑全状态 gate | 报红 | **4/4 状态**全部报红 ✓ |
| 7 | `.retryButton` 改回 `label-tertiary` | 报红 | 错误态 gate 报 **3.55:1** ✓ |

每个都回退后恢复绿。

## 九、全量回归

| # | Gate | 结果 |
|---|---|---|
| 1 | `audit-contrast.mjs` (AA 4.5:1) | **0 failing** |
| 2 | `verify-web-contrast-selection.mjs` | **OK** — selected 16.25:1/600 vs idle 5.55:1/400 |
| 2b | `verify-web-contrast-states.mjs` | **OK** — 4 states at AA 4.5:1 |
| 2c | `verify-web-contrast-error.mjs` | **OK** — 4 error-state elements (Retry 18.08:1) |
| 2d | `verify-web-contrast-tokens.mjs` | **OK** — `--ok-text` 11.97:1, `--warn-text` 15.46:1, all scrollbar tokens resolved |
| 3 | `tsc --noEmit` web / server / shell | 0 错 ×3 |
| 4 | `run-web-checks.mjs` | **18/18** (4 contrast gates added to SUITE) |
| 5 | `_e2e-verify-rows.mjs` | **11/11** |
| 6 | `verify-visual-parity.mjs` | **OK** |
| 7 | `verify-sidebar-parity.mjs` | **OK**（THEME 5 项全绿） |
| 8 | `verify-sessions-switch.mjs` | **PASS** |
| 9 | `verify-continue-from-history.mjs` | **OK** |
| 10 | `verify-direct-connect.mjs` | **OK (7/7)** |
| 11 | `verify-stack-parity.mjs` | **OK** |
| 12 | `eslint src --max-warnings 110` | 0 error / 105 warning |

`verify-sidebar-parity` 的 THEME 项是「有没有偷偷改主题」的守门断言。它全绿证明本轮对比度修复没有破坏 DSH 对齐 —— 因为每个改动都走在 DSH 已有的 token 上，没有一个是自创色值。

### 9.1 一个非回归假警报

`verify-sessions-switch` 首跑 FAIL：`session_list` 发出、`RECV=[]`。浏览器显示 `host connected`，relay 也活。等 ~50s 重跑直接 PASS。

判据：失败点在 wire 层（无回复），不在渲染层 —— 与已知的 daemon 重启稳定期一致，与样式改动无关。

## 十、视觉评审

尝试把两张 1600×945 截图交 teammate 做视觉评审，失败：`Permission relay send-failed: write EPIPE`，agent 无法读图（6 次尝试全部同样错误）。改为自己逐张看图评审，发现的真实问题都已修在本文第七节。

存档证据：
- `_e2e-evidence/review-01-empty.png`（1600×945 空态）
- `_e2e-evidence/review-02-content.png`（1600×945 有会话内容）

## 十一、残留差异（不掩盖）

1. **`Continue in this session` 蓝色主按钮视觉偏重** —— 在有内容的会话里它是全屏最重元素。但它是主操作，DSH 的主操作同样使用主色，因此保留。
2. **DSH 工作区行 hover/选中态更重** —— 它有内部高亮块 + 左侧色条；我们只有背景 wash + 字重。
3. **DSH 会话行带相对时间列** —— 我们已有时刻，但列宽分配不同。
4. **`Plugins` / `Automations` / `More` 是 inert 占位** —— DSH 有真实面板。

## DoD

- [x] `scripts/audit-contrast.mjs` 建成，**AA 4.5:1 门槛下 0 处不达标**，5 次注入验证报红
- [x] 次级文字色阶从 `label-tertiary`(3.71:1) 提到 DSH 的 `label-secondary`(5.80:1)，无自创色值
- [x] workspace 选中态修复，量化证据 16.25:1 / 600 vs 5.55:1 / 400
- [x] markdown `strong`/`h3`/`h4`/`th`、session-viewer `title`/`userBubble`、session-list `rowName` 全部修复
- [x] 绿色文字换 `--ok-text`（DSH `green-900`，11.97:1）
- [x] macOS 交通灯移除，`.lights`/`.light*` 五条规则删除
- [x] 原生滚动条改为 DSH 风格（补 6 个 token + 全局规则）
- [x] 输入框重复文案修复
- [x] 12 条 gate 全绿，THEME 项证明未偏离 DSH（提升 `--faint` 后仍绿）
- [x] 1600×945 双状态截图存档
- [x] `plan/74-web-light-contrast.md` + `.zh-CN.md`

## Próximos planos

- 把 `audit-contrast.mjs` 接入 CI（当前是手动 gate）
- 深色主题同样跑一遍审计（本轮只覆盖浅色）
- DSH 的 hover/选中态高亮块与左侧色条
