# Remote Pi — 官网

[Remote Pi](https://github.com/jacobaraujo7/remote_pi) 的落地页 —— 这个项目让你用手机操控 Pi coding agent，消息经中继转发。

本包提供三个静态路由：

- `/` —— 落地页（主视觉、功能、快速开始、GitHub 入口）
- `/terms` —— 服务条款
- `/privacy` —— 隐私政策（LGPD）

目标域名：<https://remote-pi.jacobmoura.work>。

## 启动

Web 客户端路由 `/remote-pi/connect` 是一等客户端（与手机 app、Cockpit 桌面端并列），
在站点导航和下载区都有入口。它**默认开启**：本地跑、生产构建都不需要任何环境变量。

`NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0` 是显式关闭开关 —— 在启动 dev 服务器或 build
前设上它才会隐藏客户端（路由 404、导航入口与下载卡片一起消失）。其他值（包括不设）
都保持开启。

```bash
npm install     # 或：pnpm install

npm run dev     # 开发服务器，http://localhost:3000
npm run build   # 生产构建
npm start       # 跑生产构建
```

用 npm 时**必须带 `run`**（`npm build`、`npm dev` 都不是有效命令）。pnpm 去掉
`run`：`pnpm dev`、`pnpm build`、`pnpm start`、`pnpm lint`。

打开 <http://localhost:3000/remote-pi/connect> —— 或点 `/remote-pi` 导航里的
**Open web client** —— 然后粘贴被控机器上 `remote-pi pair` 打印的 relay 地址
+ `remotepi://pair?...` 配对码。开发服务器和 relay 默认都是 3000 端口，同机运行时
请错开其中一个（`npx next dev -p 3167`）。

## 技术栈

- Next.js 16（App Router）+ React 19
- TypeScript 5（strict）
- Tailwind 4（走 `@tailwindcss/postcss`）
- ESLint 9
- 包管理器：**pnpm**

只有暗色主题；视觉规范放在 `../branding/`。

## 命令

```bash
npm install     # 装依赖（或：pnpm install）
npm run dev     # 开发服务器，http://localhost:3000
npm run build   # 生产构建（SSG）
npm start       # 跑生产构建
npm run lint    # ESLint
```

pnpm 等价写法去掉 `run`：`pnpm dev`、`pnpm build`、`pnpm start`、`pnpm lint`。

## 目录结构

```
src/
├── clients/mobile/
│   ├── layout.tsx              # 根布局：页头 + 主体 + 页脚，全局 metadata
│   ├── page.tsx                # 落地页
│   ├── icon.svg                # Favicon（对外是 /icon.svg）
│   ├── opengraph-image.tsx     # 生成的 OG 图（next/og）
│   ├── globals.css             # Tailwind + 设计 token
│   ├── terms/page.tsx
│   └── privacy/page.tsx
└── components/
    ├── header.tsx              # Logo + 导航
    ├── footer.tsx              # 条款 / 隐私 / GitHub + 版权
    ├── hero.tsx                # 落地页主视觉
    ├── feature-card.tsx        # 可复用卡片
    ├── code-block.tsx          # 代码片段块
    └── legal-shell.tsx         # 法律页共用外壳
```

## 约定

- **默认用服务端组件** —— 只有需要状态、事件或 hook 时才加 `"use client"`。
- MVP 阶段**没有后端和 API 路由**。站点纯展示。
- **不做数据分析，不埋点，也不用追踪 cookie。** 与本项目的隐私立场保持一致。
- MVP 阶段**只有英文**。如果确有需求，PT-BR 另开计划。

## 部署

预期目标是 Vercel（对 Next.js 零配置）。域名绑定在本仓库之外处理。
