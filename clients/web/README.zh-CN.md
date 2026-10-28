# Remote Pi — 官网

[Remote Pi](https://github.com/exampleorg/remote_pi) 的落地页 —— 这个项目让你用手机操控 Pi coding agent，消息经中继转发。

本包提供三个静态路由：

- `/` —— 落地页（主视觉、功能、快速开始、GitHub 入口）
- `/terms` —— 服务条款
- `/privacy` —— 隐私政策（LGPD）

目标域名：<https://remote-pi.example.invalid>。

## 启动

Web 客户端路由 `/remote-pi/connect` 是一等客户端（与手机 app、Cockpit 桌面端并列），
在站点导航和下载区都有入口。它**默认开启**：本地跑、生产构建都不需要任何环境变量。

`NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0` 是显式关闭开关 —— 在启动 dev 服务器或 build
前设上它才会隐藏客户端（路由 404、导航入口与下载卡片一起消失）。其他值（包括不设）
都保持开启。

```bash
npm install     # 安装依赖

npm run dev     # Vite dev server，http://localhost:3010
npm run build   # 先类型检查，再生产构建 → dist/
npm run preview # 本地预览生产构建
npm run lint    # ESLint（要求 0 error；阈值说明见 eslint.config.mjs）
```

用 npm 时**必须带 `run`**（`npm build`、`npm dev` 都不是有效命令）。

打开 <http://localhost:3010/remote-pi/connect> —— 或点 `/remote-pi` 导航里的
**Open web client** —— 然后粘贴被控机器上 `remote-pi-server pair` 打印的 relay 地址
+ `remotepi://pair?...` 配对码。开发服务器和 relay 默认都是 3000 端口，同机运行时
请错开其中一个（`npx vite --port 3167`）。

## 技术栈

- Vite 6 + React 18（纯客户端渲染 —— 没有 SSR，也没有服务端）
- TypeScript 6（strict）
- CSS Modules + 全局 token 样式表（不使用 utility 框架）
- ESLint 9
- 包管理器：**npm**

只有暗色主题；视觉规范放在 `../../branding/`。

## 命令

```bash
npm install     # 安装依赖
npm run dev     # Vite dev server，http://localhost:3010
npm run build   # 生产构建 → dist/
npm run preview # 本地预览生产构建
```

验证（都在本目录执行）：

```bash
node scripts/verify-stack-parity.mjs   # 技术栈本身：依赖版本、无 next/* import
npm run lint                           # ESLint：0 error（94 个已知 warning）
npx tsc --noEmit                       # 类型
node scripts/run-web-checks.mjs        # 14 个聚焦 runner
node scripts/_e2e-verify-rows.mjs      # 真实浏览器 + 真实 relay，11 个会话行
node scripts/verify-visual-parity.mjs   # DSH design-platform parity (tokens + components)
```

## 目录结构

```
src/
├── main.tsx                    # 入口：先做初始重定向，再 createRoot
├── router.tsx                  # 手写 3 路由（不用框架）
├── app-shell.tsx               # header + main + footer
├── pages/                      # 每条路由一个 .tsx + 一个 *.module.css
│   ├── connect-page.tsx        #   / 与 /remote-pi/connect
│   ├── docs-page.tsx           #   /remote-pi/docs
│   └── not-found-page.tsx
├── client/                     # Remote Pi 客户端本体
├── components/
│   ├── landing/                # 营销页组件
│   └── remote-pi/              # chat、sessions、layout、primitives
├── lib/remote-pi/              # 协议、会话工具
└── styles/                     # global.css、tokens、preflight、fonts
```

有样式的组件都在旁边带一个 `*.module.css`，没有共享的 utility 样式表。
`src/styles/properties.css` 保存 `--tw-*` 初值与组件按名引用的设计 token 值，
所以它不能跟着「没人用的组件类」一起删掉。

## 约定

- **没有服务端** —— 一切都在浏览器里渲染，不存在 SSR / RSC / API 层。
- MVP 阶段**没有后端和 API 路由**。站点纯展示。
- **不做数据分析，不埋点，也不用追踪 cookie。** 与本项目的隐私立场保持一致。
- MVP 阶段**只有英文**。如果确有需求，PT-BR 另开计划。

## 部署

任意静态托管都可以：`npm run build` 产出自包含的 `dist/`，里面是单个
`index.html` 加 `assets/` 下的哈希资源。托管方需要对未知路径回落
`index.html`（SPA 兜底），客户端路由才能解析。域名绑定在本仓库之外处理。
