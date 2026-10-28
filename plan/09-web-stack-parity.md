# 09 — web 客户端技术栈对齐 deepseek-harness

## Contexto

用户要求把 `clients/web` 的语言版本、框架、样式体系**整体对齐** deepseek-harness：

| 维度 | 现状（Remote Pi） | 目标（deepseek-harness） |
|---|---|---|
| 语言版本 | TypeScript 5 | **TypeScript 6.0.3**（正式版，已核实 6.x 有 241 个发行版） |
| 框架 | **Next.js 16.2.6**（App Router，SSR/RSC） | **Vite 6.4.3 + React 18**（纯 CSR，无 SSR） |
| React | 19.2.4 | **18.2.0** |
| 样式 | **Tailwind CSS 4**（utility class 内联在 JSX） | **CSS Modules**（197 个 `.module.css`）+ `ui-theme` 全局 token CSS |
| 路由 | Next App Router 文件路由 | 无路由库（单页，靠条件渲染） |
| 包管理 | npm | pnpm workspace（不要求对齐，见「不做的事」） |

### 已核实的迁移范围

- 代码：62 个文件 / 15,850 行；3 个路由（`/`、`/remote-pi/connect`、`/remote-pi/docs`）
- Next 专有 API 仅 5 处：
  - `next/font/google` → `src/app/layout.tsx:2`（3 个字体）
  - `next/og` `ImageResponse` → `src/app/opengraph-image.tsx`、`src/app/remote-pi/opengraph-image.tsx`
  - `next/link` → `src/app/remote-pi/docs/page.tsx:2`、`src/components/footer.tsx:1`
  - `next/navigation` `notFound` → `src/app/remote-pi/connect/page.tsx:23,44`
  - `next.config.ts` 的 `redirects`（9 条永久重定向）
- Tailwind 用量：15 个文件、461 处 `className=`；`globals.css` 2541 行、59 个 token
- React 19 专属 API（`useActionState`/`useOptimistic`/`useFormStatus`/`use()`）：**0 处使用** → 降到 18 无破坏
- **14 个 `verify-web-*.mjs` 是纯 Node 源码静态检查**，不依赖 Next 运行时 → 迁移中持续可用

### 关键约束

1. **视觉零回归**：以截图逐字节对比为准（同尺寸、同 DPR、同滚动位置）。
2. **行为零回归**：真实 Chrome CDP + 真实 relay `wss://relay.880160.xyz`，11 个会话行逐行点击双证。
3. **`clients/shell` 必须继续可用**：Electron 壳加载 `clients/web/dist-shell`；Vite 产物结构不同于 Next export，壳的静态服务逻辑要同步调整。
4. **站点部署形态改变**：Next 的 SSR/重定向能力消失，需用构建期静态重定向替代（`public/_redirects` 或壳内路由）。这是**必须向用户明确的代价**。

## Estrutura esperada

```
clients/web/
  index.html                    # Vite 入口（新建）
  vite.config.ts                # 新建
  tsconfig.json                 # 改：TS 6、bundler 模式、无 Next plugin
  package.json                  # 改：去 next/react19/tailwind，加 vite/react18
  postcss.config.mjs            # 删除（Tailwind 移除后无用）
  src/
    main.tsx                    # 新建：createRoot + 路由分发
    router.tsx                  # 新建：极简路径匹配（3 条路由）
    app/                        # 删除（Next App Router）
    pages/                      # 新建：页面组件
      home-page.tsx
      connect-page.tsx
      docs-page.tsx
    styles/
      tokens.css                # 从 globals.css 拆出 token + 基础层
      global.css                # 引入 tokens.css + reset
    components/
      <每个组件>.module.css     # 新建：Tailwind class → CSS Module
```

## Passos com critério de aceite

### Passo 0 — 基线与回滚点

- 记录当前所有截图为基线：`_e2e-evidence/baseline/parity-*.png`
- `git status` 确认工作区，建立可回滚的提交点
- **Aceite**: 基线截图可逐字节复现；`git stash` 能还原到迁移前

### Passo 1 — TypeScript 6 升级（独立、最小风险）

- `typescript@^6.0.3`，`npx tsc --noEmit` 通过
- 检查 TS 6 的破坏性变更（`moduleResolution` 默认值、移除的 deprecated flag）
- **Aceite**: `npx tsc --noEmit` 0 错；站点 `next build` 仍成功（此阶段仍在 Next 上）

### Passo 2 — Vite 替换 Next（框架层，最大风险）

拆成可验证的子步，每步 tsc + 页面可达：

1. **建 Vite 骨架**：`index.html` + `vite.config.ts` + `src/main.tsx`，先只挂一个 hello 组件，`vite dev` 能起、能渲染
2. **极简路由**：`src/router.tsx` 用 `window.location.pathname` 匹配 3 条路由，`popstate` 监听历史
3. **搬 3 个页面**：`app/page.tsx` → `pages/home-page.tsx`（去 metadata）、`remote-pi/connect/page.tsx` → `pages/connect-page.tsx`（`notFound` 改条件渲染）、`remote-pi/docs/page.tsx` → `pages/docs-page.tsx`
4. **`next/link` → `<a>`**：2 处，内部链接用原生 `<a href>`（无 SSR，整页刷新可接受；或做拦截做 SPA 导航）
5. **`next/font` → 本地字体**：3 个 Google 字体改为 `@fontsource` 包或本地 woff2 + `@font-face`，CSS 变量名保持 `--font-display`/`--font-body`/`--font-mono` 不变
6. **`next/og` → 静态图片**：2 个 OG image 改为构建期生成的静态 PNG（或用 `satori` 脚本预生成），移除运行时依赖
7. **重定向**：`next.config.ts` 的 9 条永久重定向 → 写 `public/_redirects`（Netlify 风格）+ 客户端兜底路由
8. **删除 Next 依赖**：`next`、`eslint-config-next`、`@tailwindcss/postcss`（稍后）、Next 插件

- **Aceite**: `vite build` 成功；3 个路由在 `vite dev` 下均可达且内容与迁移前一致；`npx tsc --noEmit` 0 错

### Passo 3 — React 19 → 18

- `react@18.2.0` `react-dom@18.2.0` + `@types/react@18`
- 已核实无 React 19 专属 API；重点检查 `useSyncExternalStore`（React 18 已支持）
- **Aceite**: tsc 通过；真实浏览器打开连接页，控制台无 React 版本相关错误

### Passo 4 — Tailwind → CSS Modules（工作量最大）

按依赖顺序，从叶子组件往上，每个文件独立可验证：

1. **token 层**：`globals.css` 2541 行拆成 `tokens.css`（59 token + `@theme inline` 删掉，改为 `:root`）+ `global.css`（reset + base）
2. **叶子组件**（无子组件依赖）：`primitives/controls.tsx`、`layout/states.tsx`、`chat/markdown.tsx`、`components/code-block.tsx`、`footer.tsx`、`docs-toc.tsx`
3. **中间组件**：`sessions/*`、`chat/{model-picker,slash-menu}`、`layout/{security-disclosures,connection-launcher}`
4. **顶层组件**：`chat/transcript-panel.tsx`（61 处）、`layout/{workspace-sidebar(59), right-rail(46), remote-pi-shell(23)}`
5. **页面**：`docs-page.tsx`（95 处，最大单文件）

每个文件：Tailwind class 直译成 CSS Module 规则，类名语义化，保持计算样式逐字节等价。`primitives/recipes.ts` 的 class 字符串改为导出 module 类名组合。

- **Aceite**: 每个文件中文化后，同尺寸截图与该文件基线逐字节一致；`grep -c "className=\"[a-z-]*:" ` 归零（无 Tailwind utility 残留）

### Passo 5 — 桌面壳适配

- `clients/shell/src/main.ts`：`WEB_EXPORT_DIR` 与静态解析逻辑适配 Vite 产物（`dist/` + `index.html` + 资源哈希）
- SPA 路由兜底：任意路径回落到 `index.html`（Vite 无文件路由）
- `clients/web/scripts/build-shell-web.mjs`：改为调 `vite build`（不再需要 `force-dynamic` 打补丁）
- **Aceite**: Electron 壳真实启动，加载 `app://app/remote-pi/connect`，注入真实配对凭证后显示 `host connected` + 6 workspace

### Passo 6 — 全链路验证与对照

- `npx tsc --noEmit`（web + server + shell）
- `node scripts/run-web-checks.mjs` → 14/14（需检查是否有脚本断言 Next 专有文本）
- `node scripts/_e2e-verify-rows.mjs` → 11/11
- 新增 `scripts/verify-stack-parity.mjs`：断言 package.json 版本、无 Next 依赖、无 Tailwind 依赖、无 `next/*` import、`.module.css` 数量 > 0
- 截图为证：迁移前 vs 迁移后逐字节对比
- **Aceite**: 上述 4 条 Goal acceptance 命令全绿

## DoD

- [x] TypeScript 6.0.3
- [x] Vite 6 + React 18，无 Next.js 依赖
- [x] CSS Modules，`.module.css` 覆盖所有组件，Tailwind 依赖移除
- [x] 3 个路由可用且视觉零回归（截图为证）
- [x] 14/14 `run-web-checks` + 11/11 真实浏览器 E2E
- [x] Electron 壳跑通（真实配对 + 会话读取）
- [x] `verify-stack-parity.mjs` 通过

## 不做的事（明确排除）

- **不拆成 70 个 packages**：deepseek-harness 的 monorepo 拆分服务于多产品复用；我们是单应用，拆包只增加构建复杂度。
- **不引入 Cordis DI**：它假设「本机 Node 宿主 + 运行时加载插件」，我们是远程 relay 客户端，无此前提。
- **不迁移 pnpm**：npm 已能工作，包管理器不是「语言/框架/样式」范畴。
- **不复制它的 CSS 变量名**（`--dsw-alias-*`）：我们保留 `--bg`/`--fg`/`--accent` 命名，对齐的是**体系**（CSS Modules + 全局 token），不是命名。

## Riscos

| 风险 | 影响 | 缓解 |
|---|---|---|
| 站点失去 SSR/SEO | 首页与 docs 页变 CSR，爬虫可见性下降 | 这是用户明确要求（纯 CSR）；文档页内容可在构建期预渲染为静态 HTML 兜底 |
| 9 条永久重定向失效 | 已发布链接 404 | 写 `_redirects` + 客户端路由兜底，逐条验证旧 URL |
| 视觉回归难以逐字节证明 | Tailwind → CSS Modules 是手写翻译，易漂移 | 按文件逐个翻译、逐个截图比对，不批量替换 |
| `verify-web-*.mjs` 断言旧结构 | 14/14 可能失败 | 迁移前先跑一遍记录基线，失败项判断是「断言过期」还是「真实缺陷」 |
| 迁移中途半成品 | 站点与壳都不可用 | 每步保持 `tsc` + 可启动；Passo 2 完成前不删 Next 依赖 |
