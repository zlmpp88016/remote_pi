<p align="center">
  <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="160" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

> 给 [Pi coding agent](https://github.com/earendil-works/pi) 加两个超能力：
> 同一台机器上互相通信的智能体，以及能用手机驱动 Pi 的移动端 app。

**官网：** <https://remote-pi.jacobmoura.work>

`/remote-pi` 是一条 slash 命令，一次把两者都接好。跑它就行；第一次会问你几个问题，然后就完事了。

## 协议与安全

线格式、身份模型、ACK 协议、跨 PC 路由、mesh 成员关系，以及信任模型（中继能看到什么、看不到什么），见仓库根目录的 [`PROTOCOL.md`](../PROTOCOL.md)。它是权威文档 —— 本 README 只讲面向用户的安装配置。

---

## 快速开始

装扩展（一次性）：

```bash
pi install npm:remote-pi
```

然后在任意 Pi 终端里：

```text
/remote-pi
```

首次运行会弹出一个简短的交互式向导（智能体名、默认会话、是否自动启动中继）。之后每次运行，`/remote-pi` 都会自动加入本地智能体会话并启动中继 —— 不用再输入任何东西。

### 30 秒试一下智能体网络

在同一个目录里开**两个** Pi 终端，各自运行 `/remote-pi`。两者会加入同一个会话。然后直接跟 LLM 说话就行 —— 工具它已经有了。

在终端 A（假设它叫 `agent-A`）：

```text
Who else is connected in our agent session? List them.
```

LLM 会调用 `list_peers`，报告它看到的所有完整路由地址。

然后，仍在终端 A：

```text
Send a ping to agent-B using its listed address and ask it to reply later.
```

Pi 会调用 `agent_send({ to: "<exact address from list_peers>", body: {
type: "ping" } })`。单播时，这个调用只等 broker 的投递 ACK。终端 B 会把这条消息作为一次面向用户的回合收到，之后可以用 `agent_send` 回复，把 `re` 设为那条 ping 的消息 id；回复会到达终端 A 的收件箱，或作为之后的一个回合出现。它不会让终端 A 一直阻塞着等 agent-B 的内容回复。

地址要按列出的样子原样复制，一个字都别改。不要自己去构造、解析、解码或规范化它。

---

## 它能做什么

Remote Pi 在 Pi 之上加了两层相互独立的能力。你可以只用其中一层，也可以都用：

### 1) 智能体网络（本地 broker，跨 PC 中继可选）

几个并排跑在不同终端里的 Pi 实例可以互相发现、互相发消息。每个实例都是某个具名*会话*里的一个 peer。LLM 用这些工具：

- `list_peers` —— 发现当前 peer 的路由地址
- `agent_send` —— 单播会等待 broker 的投递 ACK；广播是发后不管

遗留的、仅 Pi 的 `agent_request` 工具已废弃，因为它会阻塞着等另一个智能体的内容回复。改用 `agent_send`，继续当前回合，之后的回复通过收件箱 / 回合流程收到，用 `re` 关联到原始消息 id。

同一台机器上的 peer 通过 Unix domain socket 通信，路径是 `~/.pi/remote/sessions/<session-name>/broker.sock`。当同组的其它 PC 完成配对后，一个具备 leader 能力的 Extension 或 MCP 参与者会把这些不透明的跨 PC 地址经中继桥接起来；未开启中继访问（仅本机使用）时，通信继续走 UDS。适合把工作拆给不同角色（`backend`、`frontend`、`tests`、`orchestrator`……）并让他们互相协调。

第一个进入会话的智能体成为 *leader*（托管 broker）；其余是 *follower*。如果 leader 退出，某个 follower 会自动接管 —— LLM 完全感知不到这次切换。

### 2) 移动端 app（经中继）

配套的移动端 app 让你用手机给 Pi 发提示词、读回响应。手机和 Pi 进程通过一个**中继**互相找到对方：一个在两者之间搬运消息的小型 WebSocket 服务器。配对是一次性的，按设备进行，用二维码完成。

与中继的通信走基于 TLS 的 WebSocket。`ct` 之类的字段是线格式容器，不构成全系统的端到端保密保证：目前中继可见的 Pi 转发、跨 PC、app 和控制信封并非完全不透明，也不是端到端加密的。中继运营方能看到被路由的明文协议内容和元数据；确切的信任边界见 [`PROTOCOL.md`](../PROTOCOL.md)。

**获取 app** —— 当前所有下载方式（Google Play、App Store，以及公开发布逐步铺开期间的直接构建）：

<https://remote-pi.jacobmoura.work/#get-the-app>

---

## 移动端 app 的动作

除了对话，app 还会提供一小组带类型的动作，可以在已配对的 Pi 会话上执行。点消息输入框旁边的 ⚙ 按钮（输入框为空时可见）打开快捷动作面板：

| 动作 | 作用 |
|---|---|
| **压缩上下文** | 运行 `ctx.compact()` —— 等同于 TUI 里的 `/compact`。 |
| **新建会话** | 运行 `ctx.newSession()` —— 等同于 `/new`，会先请求确认。 |
| **模型** | 打开一个模型选择器，数据来自你已认证的 provider（与 TUI 用的是同一个来源），并通过 `pi.setModel(model)` 切换。 |
| **思考级别** | 分段控件，包含 SDK 的 6 个级别（`off` · `minimal` · `low` · `medium` · `high` · `xhigh`）。通过 `pi.setThinkingLevel(level)` 变更。 |

每个动作都会得到结构化的 `action_ok` / `action_error` 回复，这样失败时 app 能弹 SnackBar。可见的副作用（对话输出、模型变更广播、压缩提示）仍然走正常的对话通道。线上格式 schema 记录在 [`PROTOCOL.md`](../PROTOCOL.md) 的「App actions」一节。

它**不是**通用的 slash 命令选择器。Pi SDK 对大多数内置命令并不暴露编程式调用（那些只存在于 TUI 的交互循环里），所以 app 只暴露有现成 SDK 调用直接对应的动作。[`pi-telegram`](https://github.com/llblab/pi-telegram) 适配器遵循同样的模式。

### 图片

app 可以给一条消息附上**一张图片**（相机或相册）。它在设备上压缩后**内联**在 `user_message` 里 —— 可选的 `images` 字段携带 `{ data: <base64>, mime }`。pi-extension 把它转成 SDK 的多模态内容（一个 `ImageContent` 后跟作为说明文字的 `TextContent`），并调用 `sendUserMessage(content)`，于是模型既看到图片也看到你的文字。

某个模型是否接受图片，会以 `vision` 标志暴露在每个 `WireModel` 上（由 SDK 的 `Model.input` 是否包含 `"image"` 推导而来）；当前模型只支持文本时，app 会把附件按钮置灰。

**中继没有变化** —— 图片和文本装在同一个应用层消息容器里传输，所以没有二进制通道（大文件支持留待后续）。Base64 或者一个叫 `ct` 的字段都不构成端到端保密边界；当前中继的可见性遵循上面的信任模型。纯文本消息不受影响。

---

## 安装

要求：Node 20+、Pi（宿主 coding agent）。

```bash
pi install npm:remote-pi
```

扩展会自行注册 `/remote-pi` slash 命令，并部署一个智能体 skill，教 LLM 怎么用 `list_peers`、`agent_send`，以及事件驱动的收件箱 / 回复流程。

验证：

```text
/remote-pi config
```

它应该打印出当前生效的中继 URL，以及这个值来自哪里（`env` / `config` / `default`）。

---

## 使用 `/remote-pi`

不带参数的命令就是日常入口：

```text
/remote-pi
```

行为取决于这个目录有没有本地配置：

| 状态 | 会发生什么 |
|---|---|
| 首次运行（没有 `.pi/remote-pi/config.json`） | 交互式向导 → 保存配置 → 加入智能体会话 → 启动中继（若向导里选了自动启动） |
| 老用户，已启用自动启动 | 自动加入智能体会话 + 启动中继，然后打印状态 |
| 老用户，未启用自动启动 | 只打印状态；加入会话 / 中继需要手动执行 |

向导会问三个问题：

1. **智能体名** —— 这个智能体对外展示的名称（leaf name）。发送方仍然复制 `list_peers` 返回的完整不透明地址；绝不会用这个名称去构造地址。默认为目录名。
2. **默认会话** —— 这个目录在智能体网络里的 room 名。同一目录下的多个终端会加入同一个会话。
3. **自动启动中继（供移动端 app 访问）？** —— 想让 `/remote-pi` 也连上中继、好让移动端 app 能访问这个 Pi，就选 `Yes`。只在本机用（有智能体网络、不要移动端访问）就选 `No`。

之后想重跑向导，用 `/remote-pi setup`。

---

## 配对移动设备

中继起来之后（`/remote-pi relay status` 显示 `started` 或 `paired`）：

```text
/remote-pi pair
```

终端里会打印一个二维码，用 Remote Pi 移动端 app 扫它。配对是**按机器**的 —— 一台设备配对后，这台机器上所有 Pi 进程都接受它（它存在 `~/.pi/remote/peers.json` 里）。

列出已配对的设备：

```text
/remote-pi devices
```

移除一台：

```text
/remote-pi revoke <shortid>
```

shortid 是 `devices` 显示的前 8 个字符。

---

## 中继

中继是网络边界。TLS 保护传输过程，但中继能看到被路由的明文协议内容和元数据；请使用你信任的中继，或者自建。不存在全系统或 PC mesh 的端到端保证。对于 Pi 到 Pi 的转发，只要某个正确签名的 Owner blob 列出了两个规范 Pi 公钥，中继当前就允许该路由。这并不证明 Owner 与任一 Pi 配对过或控制着它。

### 升级顺序（先 Relay 0.3，再 Extension 0.6）

**先把中继升到 0.3**：旧 Extension 能正常处理新中继返回的 UUID 错误。Extension 0.6 带了一个只保留一个 release 的旧线上格式标签 shim，所以当新旧 Extension 双方选中同一个唯一的、不含冒号的签名昵称标签时，或者双方都没有该标签而都用规范的标准填充密钥前缀时，可以互通。分隔符或冲突的情况（比如昵称视图不一致）不受支持，旧接收方可能静默丢弃。请在同一个维护窗口内升级所有 Extension / MCP 参与者。该 shim 不替代 `list_peers` 返回的接收方本地别名；地址依然是不透明的。

Extension 0.6 接受旧中继的小写 32 个十六进制字符的可信错误 ID，仅作为针对旧中继或中继回滚的适用范围很窄的兼容层；这个 shim 并不是「先升中继才安全」的原因。

你有两个选择：

### 方案 A —— 用社区中继

`https://relay-rp1.jacobmoura.work`（默认）。零配置。适合试水或日常随意使用。（扩展在建立连接时会内部转成 `wss://…` —— 两种 scheme 指向同一个 endpoint。）

注意事项：

- 共享基础设施 —— 可用性尽力而为。
- **没有 IP 白名单，也没有 VPN 准入控制**。

### 方案 B —— 自建（注重隐私时推荐）

自己在 Docker 里跑中继，放到 [Tailscale](https://tailscale.com)、[WireGuard](https://www.wireguard.com) 之类的 VPN 或你自己的 VPC 后面。因为中继在网络层的保护只有 TLS + 密钥对认证，再叠一层 VPN 意味着**只有你的设备**才能访问到那个 WebSocket 端口 —— 纵深防御。

Docker 快速概览（完整安装步骤、环境变量和反向代理指引见 [relay README](https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md#self-hosted-relay-recommended-for-privacy)）：

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/jacobaraujo7/remote-pi-relay:latest
```

把容器绑到你的 VPN 网卡上，在反向代理里终止 TLS，然后让你的 Pi 和手机都指向最终那个 `https://…` URL。

### 让 Pi 指向你自己的中继

中继能访问之后，告诉扩展：

```text
/remote-pi relay url https://relay.yourdomain.tld
```

URL **必须**是 `http://` 或 `https://` —— `ws://` / `wss://` 在校验阶段就会被拒。扩展在建立连接时会内部转成 WebSocket。移动端 app 和任何自建文档都用同一种规范形式：粘贴你的反向代理对外暴露的那个 URL。

这会写入 `~/.pi/remote/config.json`，内容为 `{ "relay": "..." }`。解析顺序（优先级从高到低）：

1. `REMOTE_PI_RELAY` 环境变量（CI / 一次性覆盖）
2. `~/.pi/remote/config.json`
3. 内置默认值（`https://relay-rp1.jacobmoura.work`）

查看当前生效的 URL 及其来源：

```text
/remote-pi config
```

如果连着的时候改了 URL，先跑 `/remote-pi relay stop` 再跑 `/remote-pi relay start`（或者用 `/remote-pi relay` 来切换）。

移动端 app 在自己的偏好设置里有独立的中继 URL 设置 —— 让两边指向同一个中继。

---

## 智能体网络：深入一点

每个会话是一个 Unix domain socket broker 加 N 个 peer。broker 按不透明的 `to` 地址分发消息（多路复用），并广播系统事件（`peer_joined`、`peer_left`）。

在 LLM 内部，智能体 skill 用 `list_peers` 做发现、用 `agent_send` 做投递：

```jsonc
list_peers() // copy a complete address from this result

agent_send({
  to: "/repo/api@backend", // exact opaque address returned by list_peers
  body: { task: "add /healthz endpoint" },
  re: "<id>" // set to the received message id when replying
})
```

单播的 `agent_send` 会等待 broker 的投递 ACK，并返回公开状态 `received`、`denied` 或 `timeout`；广播则是发后不管。可信中继给出的连接关闭原因会在 `details` 里返回，但不改变这些状态：`offline` 映射为 `timeout`，而 `not_authorized` 和 `bad_envelope` 映射为 `denied`。真正的静默是一个不带原因的 `timeout`。不要盲目重试授权或信封类失败。可信中继的错误会在内部被消化，用来了结挂起的发送；伪造或非法的保留类型 body 不具备这种效力。

mesh 地址是不透明的路由值：原样回显，包括带百分号编码字节（比如 `%3A`、`%25`）或含 `~` 的冲突后缀的接收方本地 PC 别名。绝不要为了路由或安全去解析、构造、解码或规范化地址。PC 别名只是接收方本地的展示和路由，所以不同 PC 可能用不同的别名列出同一台对端机器。规范的 32 字节 Ed25519 Pi 公钥才是这台 PC 的技术身份；绝不能拿别名当身份证明。

`agent_request` 仅作为已废弃的遗留 Pi 工具保留。优先用 `agent_send`，然后处理之后任何收件箱 / 回合回复，只要它的 `re` 匹配原始消息 id。

线上格式是 5 字段信封 `{ from, to, id, re, body }`，每条消息序列化成一行 JSON。leader 的 broker 会在 `~/.pi/remote/sessions/<name>/audit.jsonl` 写一份 `audit.jsonl` 日志，供事后排查。

常用命令：

| 命令 | 作用 |
|---|---|
| `/remote-pi` | 加入本地 mesh（如果启用，也启动中继） |
| `/remote-pi peers` | 列出本地 + 跨 PC 的 mesh peer，按 PC 分组 |
| `/remote-pi rename <new>` | 在当前会话里给这个智能体改名 |
| `/remote-pi stop` | 离开本地 mesh 并断开中继 |

会话内的重名会自动加上数字后缀（`backend`、`backend#2`、`backend#3`）。由 broker 分配，并把真实名称返回给 peer。

---

## 命令参考

### 本地会话（一个 Pi，一个终端）

| 命令 | 说明 |
|---|---|
| `/remote-pi` | 连接（加入本地 mesh + 启动中继），或首次使用时运行设置向导 |
| `/remote-pi setup` | 运行设置向导并更新本地配置 |
| `/remote-pi status` | 显示本地 mesh + 中继状态 |
| `/remote-pi stop` | 停止**这个**终端的所有东西（mesh + 中继） |
| `/remote-pi pair` | 为新移动设备显示二维码 + 可复制粘贴的配对 URI |
| `/remote-pi devices` | 列出已配对的移动设备（逐台显示在线 / 离线） |
| `/remote-pi revoke <shortid>` | 按 shortid 撤销一台已配对设备 |
| `/remote-pi set-relay <url>` | 持久化一个新的中继 URL（http:// 或 https://） |
| `/remote-pi relay [start\|stop\|status]` | 只控制中继 —— 不动本地 mesh 的成员关系（不带子命令 = 切换） |
| `/remote-pi relay url <url>` | 等同于 `set-relay` |
| `/remote-pi config` | 显示当前生效的中继 URL 及其来源（env / config / default） |

### 守护进程集群（一个 supervisor，N 个后台 Pi —— 见 [守护进程模式](#守护进程模式)）

| 命令 | 说明 |
|---|---|
| `/remote-pi create <cwd> [--name X]` | 把一个目录注册为守护进程 |
| `/remote-pi remove <id>` | 注销一个守护进程（本地配置保留） |
| `/remote-pi daemons` | 列出已注册的守护进程 + 状态 |
| `/remote-pi daemon start` | 启动所有已注册的守护进程 |
| `/remote-pi daemon stop` | 停止所有运行中的守护进程（`/remote-pi stop` 只停本地终端） |
| `/remote-pi daemon restart` | 停止 + 启动所有守护进程 |
| `/remote-pi daemon status` | 详细运行时状态（pid、运行时长、重启次数） |
| `/remote-pi daemon send <id> "<text>"` | 给某个指定守护进程发一条提示词 |
| `/remote-pi cron add <id> "<expr>" "<prompt>"` | 安排一条周期性提示词（`--tz`、`--wake`、`--no-skip-busy`、`--catchup`） |
| `/remote-pi cron list` | 列出已安排的任务（计划、启用与否、下次运行、上次状态） |
| `/remote-pi cron run <jobId>` | 立刻触发一次任务（忽略它的计划） |
| `/remote-pi cron enable\|disable <jobId>` | 启用 / 停用某个任务 |
| `/remote-pi cron remove <jobId>` | 删除某个任务 |
| `/remote-pi cron log [<jobId>] [--tail N]` | 读取触发 / 跳过的审计日志 |
| `/remote-pi install` | 把 `pi-supervisord` 装成系统服务 |
| `/remote-pi uninstall` | 移除系统服务（注册记录保留） |

上面所有命令既可作为 Pi 的 slash 命令（交互式）使用，也可在包全局安装后（`npm install -g remote-pi`）作为 shell 层的 `remote-pi <subcommand>` 使用。

### 定时提示词（`cron`）

`remote-pi cron` 通过 supervisor 给守护进程安排**周期性提示词** —— 比如每天「总结一下新的 PR」。输出像任何提示词一样发后不管地流向 mesh / app；cron 层只负责审计这次派发。

- **计划**是一个 cron 表达式（croner 语法；支持可选的第 6 个*秒*字段），可通过 `--tz` 指定 IANA 时区：

  ```sh
  remote-pi cron add a1b2c3d4 "0 9 * * *" "Summarise new PRs" --tz America/Sao_Paulo
  ```

- **最小间隔是 60 秒** —— 更频繁的计划会被拒绝（防止 token 成本和任务堆积）。**当守护进程正在处理一个回合时，这次触发会被跳过**（用 `--no-skip-busy` 覆盖）；`--wake` 会先启动已停止的守护进程；`--catchup` 会在上次运行被错过时、于 supervisor 启动时补跑一次。
- **前提**：supervisor 必须作为服务运行（`remote-pi install`）。没有它就没有调度器，`cron` 命令会如实说明，而不是默默假装已安排。
- **审计**：每次触发**和**每次跳过都会往 `~/.pi/remote/cron.jsonl` 追加一行，带一个 `result` 值 —— `delivered`、`woke_and_delivered`、`deliver_failed`、`skipped_busy`、`skipped_down` 或 `skipped_disabled` —— 用 `remote-pi cron log` 读它。

分步演练：[守护进程教程](https://remote-pi.jacobmoura.work/tutorials/daemon)。

### 页脚 + 标题

- `📡 local (N)` —— 当前智能体会话和 peer 数（本地 mesh）
- `🟢 relay` —— 中继已连接，至少有一台设备已配对（全局）
- `🟡 relay waiting for pairing` —— 中继已连接，还没有设备配对
- `📱 <shortid>` —— 某台移动设备此刻已连接

窗口标题：中继在线时是 `<agent-name> · On`，否则是 `<agent-name> · Off`。让你在 `cmux` / `tmux` / iTerm 的标签页里一眼分辨各个终端。

---

## 守护进程模式

当你想让一个 Pi 一直在后台跑（凌晨 3 点响应手机上的提示词、处理 cron 任务、你不在电脑前时盯着某个目录），就把它提升为由一个 OS 级 supervisor 管理的**守护进程**。

故障排查见 [`docs/daemon.md`](./docs/daemon.md)。

### 一次性设置

```bash
# 全局安装这个包，`remote-pi` 和 `pi-supervisord` 才会进 PATH
#（单跑 `pi install npm:remote-pi` 只是让 Pi 扩展可用，并**不会**
# 暴露 CLI 二进制文件 —— 见
# https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin）。
npm install -g remote-pi

# 把 supervisor 装成用户级系统服务。Linux 用 systemd --user；
# macOS 用 launchd LaunchAgent。两者都会在登录时自启，
# 并能扛过重启。
remote-pi install
```

`install` 命令会：
- 写入 `~/.config/systemd/user/remote-pi-supervisord.service`（Linux）或 `~/Library/LaunchAgents/dev.remotepi.supervisord.plist`（macOS）
- 通过 `systemctl --user enable --now` 或 `launchctl bootstrap` 激活它
- supervisor 立即启动，并在每次登录时重新启动

### 按目录的工作流

对每个你想 7×24 保活的智能体：

```bash
# 1. 先用交互方式配置好这个智能体（只需一次）。
cd ~/Movies
pi                                 # /remote-pi → setup wizard, /remote-pi pair, etc

# 2. 提升为守护进程。id 由 cwd 推导而来
#    (sha256(realpath)[:8])，跨机器稳定。
remote-pi create ~/Movies --name "Video Editor"
# → Daemon registered: id=4e39152d name="Video Editor" cwd=/Users/x/Movies

# 3. 启动它（supervisor 会为该目录拉起 `pi --mode rpc`）。
remote-pi daemon start
```

现在你可以：

```bash
remote-pi daemons                  # list + state
remote-pi daemon status            # uptime, pid, restart count
remote-pi daemon send 4e39152d "Cut the first 30 seconds of latest clip"
remote-pi daemon stop              # stop all
remote-pi daemon restart           # restart all
```

智能体收到的提示词就像用户亲手敲的一样；它的响应经由你在交互式设置里配置好的中继 / mesh 流回来 —— 移动端 app 实时看到，同一台机器上的其他智能体也能通过本地 UDS mesh 看到。

### 移除或卸载

```bash
remote-pi remove <id>              # unregister one daemon (config preserved)
remote-pi uninstall                # remove the supervisor service (registry kept)
```

`uninstall` 是可逆的 —— 以后重新跑 `install` 就能把所有已注册的守护进程带回来。要彻底抹掉注册记录，`rm ~/.pi/remote/daemons.json`。

### 日志在哪

| 平台 | 命令 |
|---|---|
| Linux | `journalctl --user -u remote-pi-supervisord -f` |
| macOS | `tail -f ~/.pi/remote/supervisord.log` |

每个新起的守护进程的 stderr 都会带 `[<cwd>]` 前缀转发进 supervisor 的日志，所以一条日志流就能看到所有智能体。

### 注意事项（plan/26 的权衡）

- **工具审批没有把关。** 守护进程继承交互式运行所用的同一份 Pi 配置 —— Bash、Edit、Write 等都会不经提示直接执行。把一个目录提升为守护进程之前，先按你的口味配好 Pi 的工具权限。
- **配对仍然要交互完成。** 守护进程自己不显示二维码；密钥对 + 已配对设备来自同一目录里更早那次 `pi` 会话。
- **单个 supervisor。** 如果 `pi-supervisord` 崩了，所有守护进程也随之停止。systemd / launchd 会在几秒内把它重启；守护进程也会自动回来。
- **每个 cwd 一个守护进程。** `roomIdForCwd` 的推导让守护进程是按路径区分的；在 `create` 阶段就会拒绝同一目录下的两个守护进程。

---

## 配置文件

| 路径 | 范围 | 内容 |
|---|---|---|
| `<cwd>/.pi/remote-pi/config.json` | 按目录 | `agent_name`、`session_name`、`auto_start_relay` |
| `~/.pi/remote/config.json` | 按用户 | `relay` URL |
| `~/.pi/remote/peers.json` | 按机器 | 已配对的移动设备 |
| `~/.pi/remote/sessions/<name>/` | 按会话 | broker socket + `audit.jsonl` |
| `~/.pi/remote/skills/agent-network/SKILL.md` | 按用户 | LLM 读的智能体 skill |

不持久化地为单次运行覆盖中继：

```bash
REMOTE_PI_RELAY=https://staging.example.tld pi
```

---

## 故障排查

**已经配对了设备，页脚却还显示 `🟡 relay waiting for pairing`。**
这个图标反映的是这台机器上是否有*任何*设备配对过，而不是此刻是否有设备连着。如果你在 `/remote-pi devices` 里确实有已配对设备，重启 Pi —— 缓存可能过期了（当前 release 已修复；如果复发请报 bug）。

**移动端 app 连接超时。** 确认两边配的是同一个中继 URL。如果你是自建并放在 VPN 后面，手机也必须在这个 VPN 里（iOS / Android 上的 Tailscale 可以正常工作）。

**`agent_request` 老是超时。** 它已废弃，因为它会阻塞整个回合去等另一个智能体的内容回复。改用 `agent_send`；单播只等投递 ACK，接收方可以稍后用 `agent_send` 回复，带上 `re: "<original-id>"` 做关联。

**同一个目录里有多个终端。** 支持。它们共享同一个智能体网络会话（UDS broker），中继会独立处理每个 Pi 进程。如果中继以 `RoomAlreadyOpenError` 拒绝，先停掉另一个终端。

---

## 品牌

官方品牌资源在 [`/branding`](https://github.com/jacobaraujo7/remote_pi/tree/main/branding) —— logo 的 SVG 源文件（full、foreground、background、monochrome）加一张 banner。配色和导出尺寸见 [branding README](https://github.com/jacobaraujo7/remote_pi/blob/main/branding/README.md)。

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="96" alt="logo-full" /><br/>
      <sub><code>logo-full</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-foreground.svg" width="96" alt="logo-foreground" /><br/>
      <sub><code>logo-foreground</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-monochrome.svg" width="96" alt="logo-monochrome" /><br/>
      <sub><code>logo-monochrome</code></sub>
    </td>
  </tr>
</table>

---

## 链接

- 官网：<https://remote-pi.jacobmoura.work>
- 源码：<https://github.com/jacobaraujo7/remote_pi>
- Pi coding agent：<https://github.com/earendil-works/pi>
- Relay（自建指南）：<https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md>
- Issues / bug：<https://github.com/jacobaraujo7/remote_pi/issues>

---

## 许可证

MIT
