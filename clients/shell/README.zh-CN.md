# Remote Pi 桌面壳

一个套在**现有 web 客户端**外面的 Electron 窗口。这个包里没有任何 UI 代码：
`clients/web` 的 `/remote-pi/connect` 就是全部产品界面，桌面壳只提供桌面框架
（窗口、菜单、记住窗口尺寸、单实例）。

## 为什么用壳，而不是再做一套原生界面

`clients/desktop` 曾经自带一份同样协议的 Flutter 实现（`lib/app/remote_pi`：
797 行协议模型、535 行 relay 客户端、806 行 host 页面）。每次协议变更都要改两遍，
两份实现逐渐漂移。

一份实现不可能和自己漂移。协议变更在 `clients/web` 落地一次，浏览器和桌面端
同时生效。代价是明确的：**壳需要的能力必须加到 web 客户端里**，而不是另起一套
原生界面。对一个「远程控制面板」型的产品这是划算的——壳本身没有需要本地特权的
工作要做。

## 构建与运行

```bash
# 1. 构建给壳用的 web 客户端（产物写入 clients/web/dist-shell）
cd clients/web
node scripts/build-shell-web.mjs

# 2. 壳
cd ../shell
npm install
npm run build
npx electron .

# 可选：对着运行中的窗口做验收检查
npm run start:cdp                     # electron 带 --remote-debugging-port=9444
npm run verify                        # 路由 + 配对 + 会话行
```

开发时对着活的 dev server（热更新可用，因为渲染进程就是一个指向 Vite dev server
的普通浏览器页面）：

```bash
cd clients/web && npm run dev           # 终端 1
cd clients/shell && npm run dev         # 终端 2
```

## 加载方式

两种模式，由是否设置 `REMOTE_PI_WEB_URL` 决定：

| 模式 | 渲染进程 URL | 资源来自 |
|---|---|---|
| 开发（`REMOTE_PI_WEB_URL=http://localhost:3000/remote-pi/connect`） | 该 URL | dev server |
| 打包 | `app://app/remote-pi/connect` | `clients/web/dist-shell`，由 `protocol.handle` 提供 |

需要 `app://` 是因为 `file://` 页面的 origin 是不透明的，而客户端连 relay 的
WebSocket 和存配对信息的 `localStorage` 都要求真实 origin。该 scheme 注册为
`standard`、`secure`、`corsEnabled`，让这个 origin 表现得像普通 web origin。

改 `src/main.ts` 前需要知道三个细节，因为它们都是**静默失败**而不是报错：

- **资源 URL 必须是绝对路径。** 壳的构建一开始用 `base: "./"`，理由是自建
  scheme 从磁盘取文件、相对路径更安全。并不是：浏览器拿 `./assets/x.js` 去
  **当前文档路径**上解析，所以它在 `app://app/` 下能工作，在其它路由会去请求
  `app://app/remote-pi/assets/x.js` —— 结果是没有 bundle 的白屏。`base` 两种模式
  都是 `"/"`，`REMOTE_PI_SHELL=1` 只决定输出目录。
- **没有「每路由一个文件」。** Vite 只产出单个 `index.html` 加 `assets/` 下的哈希
  资源，路由是纯客户端的。不像路由路径的未知路径回落到 `index.html`；而末段看起来
  像文件名的路径（`app.css`）直接 404，而不是静默返回 HTML —— 引用了过期 bundle
  应该是一个明显的错误，而不是白屏。
- Windows 上 `fileURLToPath` 给正斜杠（`D:/…`），而 `path.resolve` 给反斜杠
  （`D:…`）。导出根目录先过一遍 `resolve` 让两边可比；否则每个请求都会被判成
  越界，窗口显示 "Not found"。

## 安全姿态

渲染进程是 web 内容，所以：`contextIsolation: true`、`nodeIntegration: false`、
`sandbox: true`、`webSecurity: true`，且不装 preload——应用不需要任何原生调用。
离开应用 origin 的导航会被拒绝并交给用户浏览器。将来真需要 IPC 时，走 preload
配一份显式频道清单；绝不用 `nodeIntegration: true`。

## 与 `clients/desktop` 的关系

它们是两个不同的产品：

- `clients/desktop` —— **Cockpit**，完整桌面 IDE（76k 行：通过 `libghostty` 的
  PTY 终端、文件系统、Git worktree、数据库）。它的 `lib/app/remote_pi` 模块就是
  本壳所取代的那份 Flutter 实现。
- `clients/shell`（本包）—— Remote Pi **远程控制面板**，即窗口里的 web 客户端。

Cockpit 的原生能力没有在这里复刻，也无法从这个壳访问；如果某个远程控制功能
需要其中某项，那它属于 `clients/desktop`。
