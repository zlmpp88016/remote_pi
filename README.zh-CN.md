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

**两个东西：一个 server，一个 client。装完就能用 —— 不用配中继，不用部署第三个服务。**

server 自带内嵌 relay，同一个端口既服务网页又跑 WebSocket。

```
跑 Pi 的那台机器                        你的手机 / 浏览器 / 桌面端
┌────────────────────────────┐
│  pi-supervisord            │   ← 只装这两个
│   · 内嵌 relay              │      server 装这边
│   · 托管 web 客户端          │      client 装那边
│   · 保活 Pi 工作区           │
└────────────────────────────┘
```

### 装 server

```bash
cd server && npm install && npm run build && npm install -g .
cd ../clients/web && npm install && npm run build
cd ../../server

remote-pi-server install      # 用户级服务，注销后仍活；Windows 首次弹一次 UAC
remote-pi-server daemon status   # 确认在跑
```

日志（`~/.pi/remote/supervisord.log`）里应该有这一行：

```
[pi-supervisord] direct mode — local relay at http://127.0.0.1:4124 (no community relay)
```

看到它就说明是自包含模式，**全程零公网流量**。`install` 写出来的服务单元不带任何
relay 参数，直接继承这个默认。

### 连 client

**浏览器**：直接打开 `http://127.0.0.1:4124/remote-pi/connect`。**不用填任何东西** ——
页面会同源配对，自己连上。

**手机**：装 App 后打开「设置 → 添加配对」。中继地址那一栏**不用填** —— 粘进配对码
就会自动填好。只有两种场景需要你多看一眼：

| 场景 | 你要做的 |
| --- | --- |
| 手机插 USB 连电脑 | 先 `adb reverse tcp:4124 tcp:4124`，然后**只粘配对码** |
| 手机在别的设备上（Wi-Fi/外网） | 先按「跨网访问」配好隧道，再**只粘配对码** |

配对码在 server 那台机器上取：

```bash
remote-pi-server pair
```

把整串 `remotepi://pair?…` 粘进 App 的**配对码**框。**中继地址会自动从配对码里填进来**
（`r=` 参数），只有要连别处时才需要手动改。

### 这样就完了

不需要 Docker、不需要单独的 web 托管、不需要部署 relay、不需要 `set-relay`。

### 常见坑

- **`install` 之后又手动起了 `pi-supervisord`。** 两者抢同一个 supervisor 套接字
  （Windows 上是命名管道，别处是 `/tmp/remote-pi-supervisor-<用户>.sock`），后起的
  报 *「Another pi-supervisord is already running」*。装了服务就别再手动起。
- **`daemon status` 说「未运行」，但网页明明能用。** 预期如此 —— 那些命令管的是
  **安装的服务**，不是前台手动起的进程。
- **网页打开是「Connect to a host」而不是已连接。** 说明同源自动配对没成
  （比如页面不是由这台 server 提供的）。把 `remote-pi-server pair` 的输出粘进
  配对码框即可 —— 手动路径永远可用。
- **改了 `server/` 的代码但行为没变。** `pi-supervisord` 是常驻进程，没有热重载。
  要 `npm run build` **再** `remote-pi-server restart-supervisor`，见「开发」一节。

---

## 可选：跨网访问

`direct` 只绑 `127.0.0.1`，这是有意的 —— 不显式打开就不会意外暴露在网络上。
让外网/局域网的手机连进来，前面挂一层隧道（frp / nginx / cloudflared / SSH `-L`），
再告诉 server 两件事：

```bash
remote-pi-server set-public-relay "https://pi.example.com"   # 手机该拨的地址
remote-pi-server allow-host       "pi.example.com"           # 同源门禁放行的域名
remote-pi-server restart-supervisor
```

这两条解的是**两个独立问题**，缺一个都会失败：

| 少了什么 | 症状 |
| --- | --- |
| 不设 `set-public-relay` | 配对码里是 `127.0.0.1`，外网手机去连**它自己**的 localhost，超时 |
| 不设 `allow-host`（隧道转发域名时） | 代理在任何页面返回前就收到 `403` —— 同源门禁默认只认 loopback 和 IP 字面量 |

`set-public-relay` **只影响配对码**，宿主自己仍连本机，不会绕公网。清空用
`set-public-relay -` / `allow-host -`。

隧道指向本机，**不要**指 `0.0.0.0`：

```toml
# type = tcp → 用 http://公网IP:7000 访问，不需要 allow-host
[[proxies]]
name = "remote-pi"
type = "tcp"
localIP = "127.0.0.1"
localPort = 4124
remotePort = 7000

# type = http → 用域名访问，需要 allow-host
[[proxies]]
name = "remote-pi"
type = "http"
localIP = "127.0.0.1"
localPort = 4124
customDomains = ["pi.example.com"]
```

> **局域网 IP 直接连会失败。** `http://192.168.x.x:4124` 不是 secure context，
> 浏览器不提供 `crypto.subtle`，Ed25519 握手直接失败。这是浏览器规范约束，不是实现
> 缺陷。局域网访问需要套 HTTPS（自签证书在 WebSocket 上没法让用户点「继续」），
> 实际做法就是上面这层隧道。

## 可选：自建或社区中继

内嵌 relay 只服务单机场景。想要「多台机器共用一个会合点」（跨机 Pi-to-Pi mesh、
多设备发现），才需要部署 `relay/` 里的 Rust relay：

```bash
docker compose -f docker-compose.relay.yml up -d   # 宿主 3001 → 容器 3000
```

用反向代理或 Cloudflare Tunnel 把域名的 `https://` 和 `wss://` 都指到
`127.0.0.1:3001`，然后：

```bash
remote-pi-server set-relay https://relay.example.com
remote-pi-server restart-supervisor
```

社区中继也可用（`wss://relay.880160.xyz`），但运营方能看见消息内容，敏感工作别用。

**只用内嵌 relay 时整节跳过。** 完整的安全权衡见 [`relay/README.md`](./relay/README.md)。

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
| [`relay/`](./relay) | Rust + Tokio | 可选的独立 relay —— 只有跨机共享会合点时才需要（默认走内嵌 relay） |

## 架构

```
手机 / 浏览器 / 桌面端客户端
        │  wss（配对一次 —— 粘配对码即可）
        ▼
主机守护进程  `pi-supervisord`   ──  room "host" · 常驻 · 不受 Pi 生死影响
        │  · 内嵌 relay（默认，同端口）
        │  · 托管 web 客户端（同端口）
        ├──►  Pi 子进程（`pi --mode rpc`）  ──  工作区 · 会话 · 对话
        │
        └──►  UDS broker   ──  本机智能体 mesh（`list_peers` / `agent_send`）
```

默认拓扑里**没有中间那台机器**：relay 就跑在 `pi-supervisord` 进程里。只有要跨机共享一个
会合点时才换成外部 Rust relay（[`relay/`](./relay)），那时客户端连的是它而不是守护进程。

**主机即连接**。客户端连的是这台机器上的守护进程（room `host`），而不是某个 Pi 进程。Pi 停了、
崩了、或压根没启动过，都不会断开连接 —— 守护进程让这台机器持续在线，推送工作区状态，并且能按操作者
选定的目录启动或重启 Pi。

- **无需 Pi 在跑也能配对** —— 守护进程自己接受配对（地址 + 配对码）；Pi 进程不是前提
- **工作区生命周期** —— 浏览主机文件系统、注册目录、启动 / 停止 / 重启它的 Pi、切换会话
- **Ed25519 身份验证** —— relay 握手会证明对方持有连接密钥；App 与主机之间的配对由两端各自把关。至于 Pi 与 Pi 之间的路由，外部 relay 只要看到一份签名正确的 Owner blob 里同时列出两个 Pi 的密钥就放行；这一检查并不能证明 Owner 真的和这两个 Pi 配过对、或能控制它们
- **TLS 只保护在途流量**，当前的消息载荷没有端到端加密；外部 relay 的确切信任边界见 [`relay/README.md`](./relay/README.md)

## 本机智能体 mesh

同一台机器上跑着多个 Pi 智能体时，它们靠守护进程管理的 **Unix 域套接字 broker** 互相发现。其中一个在选主中胜出，绑定该套接字；其余以客户端身份接入。要联系同一台机器上的智能体，直接用 `list_peers` 返回的不透明地址即可 —— 不走中继，不走网络，也不用额外配置。

Pi 对话里给大模型开放了三个工具：

- `list_peers` —— 列出该智能体可用的本机和跨机地址
- `agent_send` —— 发一条单播消息并等待投递确认（ACK）。兼容的 ACK 取值包括 `received`、`busy`、`denied`、`timeout`；当前 broker 只会返回 `received`、`denied`、`timeout`，而 `busy` 仅表示消息被某个旧版 broker leader 丢弃了 —— 必须重启那个 leader 之后才能重发。广播返回 `sent`，不带 ACK。异步内容回复用 `re`
- `agent_request` —— 带超时的请求/响应，仅作为已废弃的旧行为保留

有了这些，你就能在本机搭起多智能体协作（比如让 `backend` 智能体找 `frontend` 智能体帮忙），和远程操作客户端并行不悖。

## 中继（可选）

默认路径用进程内嵌 relay，**这一节可以整段跳过**。

需要跨机共享一个会合点时，社区免费中继：

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
