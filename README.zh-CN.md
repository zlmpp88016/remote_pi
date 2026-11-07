<p align="center">
  <img src="branding/logo-full.svg" width="140" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

<p align="center">
  随时随地<b>操作和管理</b>你的 <a href="https://github.com/earendil-works/pi">Pi 编程智能体</a>。<br/>
  目标机器上常驻的守护进程就是大门：配对一次，之后就能浏览目录、在任意目录启动 Pi、
  驱动它的会话、看着它干活 —— 用手机、浏览器或桌面端都行。
</p>

---

## 部署

三个角色。按手头的机器挑一个方案。

| 角色 | 放哪 | 干什么 |
| --- | --- | --- |
| **relay** | 有公网 IP 的机器 —— 或者干脆不要 | 让两端不用互相可达。**用 `--direct` 时完全省掉**：该模式自带内嵌 relay。 |
| **server** | 真正跑 Pi 的那台 | `pi-supervisord` 保活 Pi 工作区并应答配对 |
| **client** | 浏览器 / 手机 / 桌面端 | web、iOS、Electron 壳 |

### 方案一 —— 单机（五分钟试通）

全部装一台。`--direct` 自带内嵌 relay 并且自己托管 web，所以**不需要 Docker，也不需要单独的 web 托管**。

```bash
cd server && npm install && npm run build && npm install -g .
node dist/bin/supervisord.js --direct
```

日志会打印 `direct mode — local relay at http://127.0.0.1:4124 (no community relay)`。
打开 `http://127.0.0.1:4124/remote-pi/connect`。

配对码在另一个终端取：

```bash
remote-pi-server pair
```

整串 `remotepi://pair?…` 粘到**配对码**框，`ws://127.0.0.1:4124` 填到**中继地址**框。

> 这个方案需要 `clients/web/dist` 存在。没构建过的话 daemon 照样跑，但不服务页面
> —— 日志里会说。构建一次：`cd clients/web && npm install && npm run build`。
> **只有这个方案**要求 server 机器上有 web 构建产物。

### 方案二 —— 两台机（Pi 在 A，浏览器在 B）—— 推荐

A 只跑 Pi，B 只开页面。**这个方案里 A 不构建 web** —— 由 B 托管。

#### 机器 A

```bash
cd server && npm install && npm run build && npm install -g .
remote-pi-server set-relay https://relay.example.com   # 只收 http(s)，不收 ws://
remote-pi-server install                              # 用户级服务，注销后仍活
remote-pi-server daemon status                        # 确认在跑
remote-pi-server pair                                 # 打印配对 URI
```

`install` 会写 systemd `--user` 单元、LaunchAgent 或任务计划条目 —— 不需要 root，
只有 Windows 首次安装会弹一次 UAC。

#### 机器 B

```bash
cd clients/web && npm install && npm run build
npx serve dist -p 5173
```

打开 `http://localhost:5173/remote-pi/connect`：

| 字段 | 值 |
| --- | --- |
| 中继地址 | `wss://relay.example.com` |
| 配对码 | A 上打印的整串 `remotepi://pair?…` |

### 方案三 —— 生产（自有 relay + 自有域名）

#### relay 那台

```bash
docker compose -f docker-compose.relay.yml up -d   # 宿主 3001 → 容器 3000
```

用反向代理或 Cloudflare Tunnel 把域名的 `https://` 和 `wss://` 都指到
`127.0.0.1:3001`。`RELAY_ALLOWED_ORIGINS` 是浏览器 Origin 白名单，默认宽松。

#### server 那台

```bash
cd server && npm install && npm run build && npm install -g .
remote-pi-server set-relay https://relay.example.com
remote-pi-server install
remote-pi-server pair          # --rotate 作废旧码
```

#### client 那台

把 `clients/web/dist` 发布到任意静态托管（Nginx、Cloudflare Pages、Vercel）并套上
HTTPS，然后用上面的中继地址和配对码连接。

### 从另一台机器访问 `--direct`

`--direct` 只绑 `127.0.0.1`，主机和端口都不能通过它改。要从别处访问，前面挂隧道或
反向代理，**并且**把浏览器实际发送的域名加入白名单：

```bash
REMOTE_PI_ALLOWED_HOSTS="your-tunnel-host.example.com" \
  node dist/bin/supervisord.js --direct
```

这个变量不能省：不设的话代理在任何页面返回前就拿到 `403`，因为严格同源门禁默认只认
loopback 的 `Host` 值。若页面所在 Origin 与 daemon 不同源，还要在
`REMOTE_PI_ALLOWED_ORIGINS` 里列出它。

### 常见坑

- **配对码填错框。** 页面有两个输入框。中继地址收 `wss://…`，配对码收整串
  `remotepi://pair?…` URI。把 URI 粘进地址框是最常见的失败。
- **`set-relay` 拒收 `ws://`。** 只接受 `http://` / `https://`，内部自己转
  WebSocket。传 `ws://` 会被直接拒绝。
- **`install` 和 `--direct` 互斥。** 两者抢同一个 supervisor 套接字（Windows 上是
  命名管道，别处是 `/tmp/remote-pi-supervisor-<用户>.sock`）。一个在跑时起另一个会报
  *「Another pi-supervisord is already running」*。先停服务：
  `remote-pi-server daemon stop`。
- **`--direct` 明明能用，`daemon status` 却说「未运行」。** 预期如此。那些命令管的是
  安装的服务，不是前台进程。
- **隧道返回 `403`。** 少了 `REMOTE_PI_ALLOWED_HOSTS`，见上一节。

---

## 相关链接

- **官网** —— <https://remote-pi.example.invalid>
- **包文档** —— <https://pi.dev/packages/remote-pi?name=remote-pi>
- **GitHub** —— <https://github.com/exampleorg/remote_pi>

### 下载

| 平台 | 状态 |
|---|---|
| Google Play（Android） | [在 Google Play 获取](https://play.google.com/store/apps/details?id=com.example.remotepi) |
| App Store（iOS） | [在 App Store 下载](https://apps.apple.com/app/remote-pi-coding-agent/id6773499691) |
| APK（侧载，Android） | [GitHub Releases](https://github.com/exampleorg/remote_pi/releases) |
| 桌面端（Cockpit） | [GitHub Releases](https://github.com/exampleorg/remote_pi/releases?q=cockpit-v) |

## 仓库里有什么

Remote Pi 不是单个插件 —— 它是「在一台机器上运行和管理 Pi」的整套系统，外加接入它的各类客户端。

| 包 | 技术栈 | 作用 |
|---|---|---|
| [`server/`](./server) | Node + TypeScript | **守护进程与控制平面** —— `pi-supervisord` 主机守护进程、`remote-pi` CLI、`/remote-pi` Pi 命令，以及本机智能体 mesh |
| [`clients/mobile/`](./clients/mobile) | Flutter（iOS / Android） | 移动端客户端（操作台） |
| [`clients/desktop/`](./clients/desktop) | Flutter Desktop | 桌面端客户端（macOS / Windows / Linux，另含 iPad / Android） |
| [`clients/web/`](./clients/web) | NextJS | 落地页、文档，以及浏览器客户端 |
| [`relay/`](./relay) | Rust + Tokio | WebSocket 路由 + 带签名的 mesh 成员关系存储 |

## 架构

```
手机 / 浏览器 / 桌面端客户端
        │  wss（配对一次 —— 地址 + 配对码）
        ▼
   Relay（Rust）
        ▲  wss
        │
主机守护进程  `pi-supervisord`   ──  room "host" · 常驻 · 不受 Pi 生死影响
        │  按需拉起
        ├──►  Pi 子进程（`pi --mode rpc`）  ──  工作区 · 会话 · 对话
        │
        └──►  UDS broker   ──  本机智能体 mesh（`list_peers` / `agent_send`）
```

**主机即连接**。客户端连的是这台机器上的守护进程（room `host`），而不是某个 Pi 进程。Pi 停了、
崩了、或压根没启动过，都不会断开连接 —— 守护进程让这台机器持续在线，推送工作区状态，并且能按操作者
选定的目录启动或重启 Pi。

- **无需 Pi 在跑也能配对** —— 守护进程自己接受配对（地址 + 配对码）；Pi 进程不是前提
- **工作区生命周期** —— 浏览主机文件系统、注册目录、启动 / 停止 / 重启它的 Pi、切换会话
- **Ed25519 身份验证** —— 中继握手会证明对方持有连接密钥；App 与主机之间的配对由两端各自把关。至于 Pi 与 Pi 之间的路由，当前中继只要看到一份签名正确的 Owner blob 里同时列出两个 Pi 的密钥就放行；这一检查并不能证明 Owner 真的和这两个 Pi 配过对、或能控制它们
- **TLS 只保护在途流量**，当前的消息载荷没有端到端加密；确切的信任边界见 [`relay/README.md`](./relay/README.md)

## 本机智能体 mesh

同一台机器上跑着多个 Pi 智能体时，它们靠守护进程管理的 **Unix 域套接字 broker** 互相发现。其中一个在选主中胜出，绑定该套接字；其余以客户端身份接入。要联系同一台机器上的智能体，直接用 `list_peers` 返回的不透明地址即可 —— 不走中继，不走网络，也不用额外配置。

Pi 对话里给大模型开放了三个工具：

- `list_peers` —— 列出该智能体可用的本机和跨机地址
- `agent_send` —— 发一条单播消息并等待投递确认（ACK）。兼容的 ACK 取值包括 `received`、`busy`、`denied`、`timeout`；当前 broker 只会返回 `received`、`denied`、`timeout`，而 `busy` 仅表示消息被某个旧版 broker leader 丢弃了 —— 必须重启那个 leader 之后才能重发。广播返回 `sent`，不带 ACK。异步内容回复用 `re`
- `agent_request` —— 带超时的请求/响应，仅作为已废弃的旧行为保留

有了这些，你就能在本机搭起多智能体协作（比如让 `backend` 智能体找 `frontend` 智能体帮忙），和远程操作客户端并行不悖。

## 中继

社区免费中继：

```
wss://relay.880160.xyz
```

拿来起步够用，但中继运营方能看到你消息的内容，而且它是路由上的单点信任。**如果做的是敏感工作，强烈建议自建中继** —— 一条 Docker 命令的事，而且从此你的流量只经过自己的基础设施。

完整的安全权衡和自建指南见 **[`relay/README.md`](./relay/README.md)**。

### 建议搭配：`@eko24ive/pi-ask`

```bash
pi install npm:@eko24ive/pi-ask
```

装上 pi-ask 后，智能体的 `ask_user` 澄清式提问（带选项的结构化问题、多选、预览）会以原生形式展现在手机应用里 —— 你在手机上作答，桌面端的流程随即继续。没装的话，智能体就只在聊天里用纯文本提问（手机上一样能答，只是非结构化的）。两种情况 Remote Pi 都照常工作；pi-ask 是可选的。

## 开发：改完代码怎么生效

装成**服务**之后最容易踩的坑就在这里：服务一直跑着它启动时加载的那份代码，改文件不会自动生效，
必须主动重载对应的那一侧。

一共有**两个独立进程**，重载方式完全不同：

| 你改的 | 跑在哪 | 怎么生效 |
|---|---|---|
| `server/`（守护进程、CLI、`/remote-pi` 命令） | `pi-supervisord` 服务 | 重新 build **并**重启 supervisor |
| `clients/web/`（浏览器 UI） | `next`（开发服务器或 Docker） | 开发服务器热更新，刷新页面即可 |
| `clients/mobile/`、`clients/desktop/` | 你自己 build/跑 | 重新 build 那个客户端 |

### 改 server —— 先 build，再重启 supervisor

**`daemon restart` 不够。** 它只重启工作区的 Pi 进程，supervisor 本身仍跑着已经加载的旧代码
（`pi-supervisord` 是常驻 Node 进程，没有热重载）。要用 `restart-supervisor`：

```bash
cd server
npm run build                       # tsc → dist/
remote-pi-server restart-supervisor # 用新的 dist/ 重新拉起 pi-supervisord
```

`restart-supervisor` 会顺带把所有工作区 daemon 一起重启，所以之后**不需要**再执行 `daemon restart`。
确认它回来了：

```bash
remote-pi-server daemon status      # 每个工作区的 pid / 运行时长 / 重启次数
```

**验证重启真的发生了。** 对比重启前后的 supervisor PID 是唯一可靠的证据 —— 命令返回 0 不够
（见下面 Windows 那条）：

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*supervisord.js*' } |
  Select-Object ProcessId, CreationDate
```

```bash
# Linux / macOS
pgrep -af supervisord.js
```

`CreationDate` 必须**晚于**你执行 `npm run build` 的时间。如果比它早，说明旧代码还在跑。

> **Windows 特别注意：** `schtasks /End` 会报成功，但 node 进程根本不退出 —— 所以朴素的
> `End` + `Run` 组合是**静默空操作**。`restart-supervisor` 因此会等旧的 `supervisord.js` 真正消失，
> 超时则强制结束进程；仍然失败时**如实报错（非 0 退出码）**，不会假称成功。
> 如果它仍报告进程在跑，手动停掉：
>
> ```powershell
> Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
>   Where-Object { $_.CommandLine -like '*supervisord.js*' } |
>   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> remote-pi-server restart-supervisor
> ```

这两条命令在所有平台（含 Windows）都**不需要提权**，只有第一次 `install` 需要。

> **为什么不直接重启系统服务？** 可以（Linux `systemctl --user restart <unit>`、
macOS `launchctl kickstart -k`、Windows `schtasks /End && schtasks /Run`）。
`restart-supervisor` 就是这件事的跨平台封装。

如果你**没**装服务（普通 `pi` 会话、没有 supervisor），以上都不需要：重启你的 Pi 会话，它就会加载新的 `dist/`。

### 改 web —— 刷新页面

开发服务器跑着的时候，改动会热更新：

```bash
cd clients/web
npm run dev                       # http://localhost:3000/remote-pi/connect
```

改到**连接/状态**相关的代码后，通常仍需要硬刷新（**Ctrl/Cmd+Shift+R**）：浏览器对 relay 保持着一条
WebSocket 和配套的旧客户端代码。刷新同时会用已存的凭据重新配对，这才会重跑连接时的预取。

生产/服务部署走 Docker 镜像（`clients/web/Dockerfile`，`docker build` + 重启容器），改完重新 build 并重启容器。

### 验证 web 改动

```bash
cd clients/web
npm run verify:web                # 全部 Node 校验脚本（不需要浏览器）
npm run lint && npx tsc --noEmit  # 静态检查
npm run build                     # 生产 build 仍能编译
```

## 状态

MVP 已可用。规划笔记和路线图在 [`plan/`](./plan)。

## 许可证

许可证按包各自约定 —— 见各子项目的 `LICENSE` 文件（`remote-pi` 是 MIT）。全仓库层面的许可证尚未定案。
