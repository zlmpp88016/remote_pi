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

## 相关链接

- **官网** —— <https://remote-pi.jacobmoura.work>
- **包文档** —— <https://pi.dev/packages/remote-pi?name=remote-pi>
- **GitHub** —— <https://github.com/jacobaraujo7/remote_pi>

### 下载

| 平台 | 状态 |
|---|---|
| Google Play（Android） | [在 Google Play 获取](https://play.google.com/store/apps/details?id=work.jacobmoura.remotepi) |
| App Store（iOS） | [在 App Store 下载](https://apps.apple.com/app/remote-pi-coding-agent/id6773499691) |
| APK（侧载，Android） | [GitHub Releases](https://github.com/jacobaraujo7/remote_pi/releases) |
| 桌面端（Cockpit） | [GitHub Releases](https://github.com/jacobaraujo7/remote_pi/releases?q=cockpit-v) |

## 仓库里有什么

Remote Pi 不是单个插件 —— 它是「在一台机器上运行和管理 Pi」的整套系统，外加接入它的各类客户端。

| 包 | 技术栈 | 作用 |
|---|---|---|
| [`remote-pi/`](./remote-pi) | Node + TypeScript | **守护进程与控制平面** —— `pi-supervisord` 主机守护进程、`remote-pi` CLI、`/remote-pi` Pi 命令，以及本机智能体 mesh |
| [`app/`](./app) | Flutter（iOS / Android） | 移动端客户端（操作台） |
| [`cockpit/`](./cockpit) | Flutter Desktop | 桌面端客户端（macOS / Windows / Linux，另含 iPad / Android） |
| [`site/`](./site) | NextJS | 落地页、文档，以及浏览器客户端 |
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

## 快速开始

### 1. 跑起主机守护进程

全局安装，让 `remote-pi` CLI 和 `pi-supervisord` 守护进程进 PATH：

```bash
npm install -g remote-pi
```

把守护进程装成用户级系统服务（Linux `systemd --user`、macOS launchd、Windows 任务计划程序）。登录即自启，重启也不丢：

```bash
remote-pi install
```

守护进程随即起来、连上中继，让这台机器保持在线 —— **无需任何 Pi 在跑**。

### 2. 配对客户端

直接从守护进程配对（不需要 Pi）：

```bash
remote-pi pair        # 打印地址 + 一次性/持久配对码
```

把地址和配对码填进手机应用、浏览器客户端或 Cockpit。配对完成后，客户端即可浏览主机文件系统、
注册目录，并在那里启动 Pi。

### 3. 或者照旧在本机跑 Pi

`/remote-pi` 这条 Pi 命令在日常本地场景下依然可用。在任意 Pi 会话里：

```text
/remote-pi
```

向导会依次问你智能体名字、会话名和用哪个中继，然后打印一个二维码。用 Remote Pi 手机应用扫一下
—— 适合你想让当前这个 Pi 会话本身可达、而不启用常驻守护进程的情况。

### 建议搭配：`@eko24ive/pi-ask`

```bash
pi install npm:@eko24ive/pi-ask
```

装上 pi-ask 后，智能体的 `ask_user` 澄清式提问（带选项的结构化问题、多选、预览）会以原生形式展现在手机应用里 —— 你在手机上作答，桌面端的流程随即继续。没装的话，智能体就只在聊天里用纯文本提问（手机上一样能答，只是非结构化的）。两种情况 Remote Pi 都照常工作；pi-ask 是可选的。

## 状态

MVP 已可用。规划笔记和路线图在 [`plan/`](./plan)。

## 许可证

许可证按包各自约定 —— 见各子项目的 `LICENSE` 文件（`remote-pi` 是 MIT）。全仓库层面的许可证尚未定案。
