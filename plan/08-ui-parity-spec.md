# 08 — deepseek-harness UI 对照 spec（视觉 / 交互 / 布局）

> 状态：**evidence 已取证**（源码实测，2026-10-21）
> 用途：Todo #9（token 化 + primitives）、#10（目录重构）的直接输入
> 取证方式：直接读 `D:/workspace/git_repo/deepseek-harness/packages/client/**` 源码

## 0. 它是什么

**Vite 6 + React 18 + TypeScript 纯 CSR**，不是 Next.js。

- `apps/web` 极薄（45 行 `main.ts`），只做 `<div id="root">` → `AppWebEntry`
- 真正的 UI 在 `packages/client/` 下 80+ 个包，每包一个能力
- 依赖注入用 **Cordis**（`@deepseek-ai/cordis` 4.0.5，公开发布）
- 样式 **CSS Modules + CSS 变量 token**，不用 Tailwind
- Electron 是 `apps/desktop` 可选壳，加载同一份 `apps/web` 代码

**关键：高度确定的真正来源**是 `packages/client/web/src/base.css`：

```css
html, body, #root { height: 100%; margin: 0 }
```

不是 Electron。这是「独立应用 vs 站点内嵌路由」的差别——Remote Pi 是后者，所以必须自己补高度契约。

---

## 1. 视觉语言（token 全表）

### 1.1 字体栈（`base.css:7-16`）

```css
--dsh-font-family-text-default: -apple-system, BlinkMacSystemFont, 'Segoe UI',
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
  'Helvetica Neue', Helvetica, Arial, sans-serif;
--dsh-font-family-code-default: 'SF Mono', 'JetBrains Mono', 'Fira Code',
  Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
--dsw-font-family-brand: 'Montserrat', var(--dsh-font-family-text-default);
```

> 注释明确指出：code 栈**故意不带裸 `monospace` 兜底**，否则 Windows 中文会回退到 SimSun。

### 1.2 圆角阶梯（`base.css:18-23`）

| token | 值 |
|---|---|
| `--dsw-radius-xs` | 4px |
| `--dsw-radius-sm` | 8px |
| `--dsw-radius-md` | 12px |
| `--dsw-radius-lg` | 16px |
| `--dsw-radius-xl` | 20px |
| `--dsw-radius-panel` | 28px |

### 1.3 动效（`base.css:14-17`）

| token | 值 |
|---|---|
| `--ds-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--ds-transition-duration-fast` | 0.1s |
| `--ds-transition-duration` | 0.2s |
| `--ds-transition-duration-slow` | 0.3s |

### 1.4 深色主题实际色值（`design-platform.css:284-393`）

基础色阶（`neutral-bluish`，深色端）：

| token | 值 | 用途 |
|---|---|---|
| `neutral-bluish-800` | `rgb(53, 54, 56)` | `bg-layer-3` |
| `neutral-bluish-850` | `rgb(44, 44, 46)` | `bg-layer-2`、**消息气泡** |
| `neutral-bluish-875` | `rgb(35, 35, 36)` | `bg-layer-1` |
| `neutral-bluish-900` | `rgb(27, 27, 28)` | **sidebar fill** |
| `neutral-bluish-950` | `rgb(21, 21, 23)` | **bg-base**（页面底） |

语义别名（深色）：

```css
--dsw-alias-bg-base:      var(--dsw-static-neutral-bluish-950);  /* rgb(21,21,23) */
--dsw-alias-bg-layer-1:   var(--dsw-static-neutral-bluish-875);
--dsw-alias-bg-layer-2:   var(--dsw-static-neutral-bluish-850);
--dsw-alias-bg-layer-3:   var(--dsw-static-neutral-bluish-800);
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
--dsw-alias-label-caption: var(--dsw-static-neutral-bluish-600);
--dsw-alias-border-l3:    rgba(255, 255, 255, 0.16);
--dsw-alias-border-l4:    rgba(255, 255, 255, 0.2);
--dsw-specific-bubble:    var(--dsw-static-neutral-bluish-850);
--dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-900);
```

> **重要对照**：我们 `clients/web` 里出现 6 次的 `#151517` **正好等于** `rgb(21,21,23)`。说明视觉方向本来就一致，缺的是体系。

### 1.5 我们的硬编码色值（需收敛）

```
53× #a3a3a3    42× #6b6b6b    31× #4fc3f7    22× #d4d4d4
14× #5fd38a    12× #f25a5a     6× #7ad4fa     6× #151517
 5× #04222e     4× #9a9a9a     4× #4a4a4a
```

映射建议（语义对齐，不改视觉）：

| 现值 | 语义 | 建议 token |
|---|---|---|
| `#151517` | 页面底 | `--rp-bg-base` |
| `#a3a3a3` | 主文本 | `--rp-label-primary` |
| `#6b6b6b` | 次要文本/占位 | `--rp-label-secondary` |
| `#4a4a4a` | 边框 | `--rp-border` |
| `#4fc3f7` | 强调（链接/活跃） | `--rp-accent` |
| `#5fd38a` | 成功 | `--rp-ok` |
| `#f25a5a` | 错误 | `--rp-danger` |
| `#f7ad31` | 警告 | `--rp-warn` |

---

## 2. 消息气泡（`MessageItem.module.css:20-70`）

```css
max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
background: var(--dsw-specific-bubble);
border-radius: var(--dsw-radius-xl);    /* 20px */
padding: 10px 16px;
font-size: var(--dsh-content-font-size, 14px);
```

- 助手正文：`14px`
- 次要信息（时间戳等）：`13px`（`--dsh-content-font-size-secondary`）
- hover 态：`--dsw-alias-interactive-bg-hover` / `-solid`

## 3. 推理行（`ReasoningRow.module.css`）

```css
background: var(--dsw-alias-bg-base);
font-size: var(--dsh-content-font-size-secondary, 13px);
padding: 4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px));
```

左侧竖线：`border-radius: 1px` + `background: var(--dsw-alias-label-caption)`。

## 4. 右侧 turn rail（`TurnNavigator.module.css`）

```css
position: absolute; top: 0; right: 0;
width: 28px;                 /* 轨道宽 */
right: 12px;                 /* 距右边缘 */
scrollbar-width: none;
```

## 5. 布局骨架（`AppFrame.module.css`）

```css
.frame {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  height: 100%;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
}
```

**三栏**：`.sidebarCol` / `.centerCol` / `.rightCol`，全部 `min-width: 0; overflow: hidden`。

**动效规则**（重要）：
- `.frame[data-animating]` → `transition: grid-template-columns 0.3s`
- `.frame[data-dragging]` → `transition: none`（拖拽时若缓动，栏会脱离手柄）
- 稳态列宽**不加过渡**，否则窗口 resize 时会橡皮筋

**滚动容器唯一性**（`ChatView.module.css`）：

```css
.frame { display:flex; flex-direction:column; min-height:0; flex:1 1 auto }
.root  { display:flex; flex-direction:column; min-height:0; flex:1 1 auto;
         overflow-y: clip }
.scroll{ flex:1 1 auto; min-height:0; overflow-y:auto }
```

三层连续 `min-height: 0`，**只有 `.scroll` 可滚**。这正是我们修复高度问题时采用的同一套契约。

## 6. Token 化迁移顺序（给 #9）

1. **先建 `tokens.css`**，值与现用色值**逐一相等**（零视觉变更）
2. 替换 `clients/web/src/app/globals.css` 与各组件里的硬编码
3. 再建 `primitives/`，逐个替换原子组件
4. 最后才引入它的新色阶（真正的视觉变更，可独立回滚）

## 7. 与我们现状的差异汇总

| 维度 | deepseek-harness | Remote Pi 现状 | 改法 |
|---|---|---|---|
| 构建 | Vite 6 | Next.js 16 | **不改**（架构不同，成本过高） |
| React | 18 | 19 | 不改 |
| 样式 | CSS Modules + token | Tailwind + 硬编码 | **token 化**（#9） |
| 状态 | Cordis store + selector | 38 useState 集中一处 | **拆 store**（#7） |
| 组合 | Slot 注册表 | JSX 条件堆叠 | **简化 registry**（#10） |
| 字体 | 明确中英字体栈 | 未定义 | **采用其字体栈** |
| 圆角 | 6 档阶梯 | 散落 `rounded-*` | **采用其阶梯** |
| 动效 | 3 档时长 + 1 曲线 | 散落 `transition-*` | **采用其三档** |
| Desktop | Electron 壳加载 web | Flutter 自绘 136k 行 | **WebView 套壳**（#11） |

## 8. 结论

**可移植的是「体系」，不是「代码」**：

- ✅ CSS 变量 token 全表、字体栈、圆角/动效阶梯、布局契约 → 直接照搬
- ✅ 消息气泡/推理行/导航轴的**视觉参数** → 直接采用
- ❌ Cordis DI、Slot `declare module` 类型合并、Vite 构建 → 不照搬（我们是单应用 + Next.js）
- ✅ **store + selector 的形态** → 用 React Context 或轻量 store 复刻

下一步：**#9 建 `tokens.css`**，值与现用色值逐一相等，先做到零视觉变更的 token 化。

---

## 9. 列宽几何（它的确定值，`ui-layout/src/client/columns.ts:9-27`）

| 常量 | 值 | 含义 |
|---|---|---|
| `CENTER_MIN` | **400** | 右侧栏打开时中栏的最小宽度 |
| `SIDEBAR_MIN` | **264** | 左栏拖拽下限 |
| `SIDEBAR_MAX` | **420** | 左栏拖拽上限 |
| `SIDEBAR_DEFAULT` | **280** | 首次打开的左栏宽 |
| `SIDEBAR_COLLAPSED` | **56** | 折叠后的图标栏宽（24px 图标 + 2×16px padding） |
| `SIDEBAR_AUTO_COLLAPSE` | **1024** | 视口低于此值左栏自动折叠 |
| `RIGHTBAR_MIN` | **300** | 右栏拖拽下限 |
| `RIGHTBAR_MAX_RATIO` | **0.7** | 右栏最大宽度（占 frame 比例） |
| `RIGHTBAR_DEFAULT_RATIO` | **0.45** | 右栏首次打开宽度（占 frame 比例） |

**收缩顺序**（注释原文）：*"the right column shrinks, then loses its track, before the center drops below its minimum. The sidebar never concedes here"* —— 即：先缩右栏 → 右栏整个消失 → 才压中栏；**左栏永远不让步**（它由 `SIDEBAR_AUTO_COLLAPSE` 单独处理）。

我们现状：左栏有折叠，但**没有拖拽调宽**，也没有右栏的宽度记忆。

## 10. 滚动跟随（`ui-chat/src/client/chat/ChatView.tsx:208-246`）

```tsx
<div className={css.root} data-chat-following-tail={scroll.followingTail ? '' : undefined}>
  ...
</div>
{!scroll.followingTail && (
  <div className={css.toBottomSlot}>
    <button aria-label={t('chat.toBottom')} onClick={scroll.returnToBottom}>
      <IconChevronDownOutlineRegular />
    </button>
  </div>
)}
```

配套 CSS（`ChatView.module.css`）：

```css
.root[data-chat-following-tail] .scroll { overflow-anchor: none; }
```

模式：**用 data 属性表达「是否贴底」这一个布尔状态**，由 CSS 消费它（关掉 `overflow-anchor` 防止跳动），由 TSX 用它决定「回到最新」按钮的显隐。我们的 `transcript-panel.tsx` 目前没有跟随状态，也没有回到底部按钮。

## 11. 响应式断点（`AppFrame.module.css`）

它的 CSS **只对 `prefers-reduced-motion` / `prefers-reduced-transparency` 做媒体查询**，宽度断点完全不用 CSS media query，而是在 TS 里按视口宽度**计算三栏宽度**（`columns.ts` 的 `solveColumns(viewport, sidebar)`）。好处是拖拽、折叠、响应式共用同一套几何，不会出现「CSS 和 JS 各算一套」的错位。

我们现状：断点写在 Tailwind 类里（`max-[1023px]:pl-[52px]` 等），与折叠逻辑分离。

## 12. 工具调用折叠（`ui-chat/src/client/chat/ChatNodeSeat.tsx:26,61`）

```ts
readonly deferCollapse: boolean
turnProcessOpen(state, processSpec, bottom === true && deferCollapse)
```

关键规则：**`deferCollapse`**——当节点位于列表底部时推迟折叠，避免「流式输出时刚展开的内容立刻被收起」的跳动。

## 13. 落地优先级（对我们的具体改法）

| 优先级 | 改什么 | 依据 | 风险 |
|---|---|---|---|
| **P0** | 滚动跟随 + 回到底部按钮 | §10 | 低（纯增量） |
| **P0** | 工具调用 `deferCollapse` | §12 | 低 |
| **P1** | 左/右栏拖拽调宽 + 宽度持久化 | §9 | 中（需要 pointer 事件 + localStorage） |
| **P1** | 右栏宽度记忆（`RIGHTBAR_DEFAULT_RATIO`） | §9 | 低 |
| **P2** | 断点从 Tailwind 类迁到 TS 几何计算 | §11 | 高（影响所有布局，需逐断点验收） |
| **P2** | 折叠轨宽对齐 `SIDEBAR_COLLAPSED = 56` | §9 | 低（改一个数） |

**不要照搬**：Cordis DI、Slot `declare module` 类型合并、Vite 构建、80+ 包拆分。
