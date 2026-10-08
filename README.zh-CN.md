<p align="center">
  <img src="branding/logo-full.svg" width="140" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

<p align="center">
  用手机操控你的 <a href="https://github.com/earendil-works/pi">Pi coding agent</a>。
  扫一次二维码完成配对，之后随时能和本机的智能体对话 —— 人不在电脑前也行。
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

## 仓库里有什么

| 包 | 技术栈 | 作用 |
|---|---|---|
| [`app/`](./app) | Flutter（iOS / Android） | 移动端客户端 |
| [`pi-extension/`](./pi-extension) | Node + TypeScript | Pi 插件，提供 `/remote-pi` |
| [`relay/`](./relay) | Rust + Tokio | WebSocket 路由 + 带签名的 mesh 成员关系存储 |
| [`site/`](./site) | NextJS | 落地页 + 法律条款页 |

## 架构

```
Flutter app ──wss──► Relay (Rust) ◄──wss── Pi extension (Node)
                                                  │
                                           Local Pi process
                                                  │
                                           UDS broker (local mesh)
                                                  │
                                           Other agents on the same machine
```

- **配对**通过短时有效的二维码完成；对端信息在手机上存进钥匙串（Keychain），在桌面端存进 `~/.pi/remote/`
- **Ed25519 身份验证** —— 中继握手会证明对方持有连接密钥；App 与 Pi 之间的配对则由两端各自把关。至于 Pi 与 Pi 之间的路由，当前中继只要看到一份签名正确的 Owner blob 里同时列出两个 Pi 的密钥就放行；这一检查并不能证明 Owner 真的和这两个 Pi 配过对、或能控制它们
- **TLS 只保护在途流量**，当前的消息载荷没有端到端加密；确切的信任边界见 [`relay/README.md`](./relay/README.md)

## 本机智能体 mesh

同一台机器上跑着多个 Pi 智能体时，它们靠插件管理的 **Unix 域套接字 broker** 互相发现。其中一个在选主中胜出，绑定该套接字；其余以客户端身份接入。要联系同一台机器上的智能体，直接用 `list_peers` 返回的不透明地址即可 —— 不走中继，不走网络，也不用额外配置。

Pi 对话里给大模型开放了三个工具：

- `list_peers` —— 列出该智能体可用的本机和跨机地址
- `agent_send` —— 发一条单播消息并等待投递确认（ACK）。兼容的 ACK 取值包括 `received`、`busy`、`denied`、`timeout`；当前 broker 只会返回 `received`、`denied`、`timeout`，而 `busy` 仅表示消息被某个旧版 broker leader 丢弃了 —— 必须重启那个 leader 之后才能重发。广播返回 `sent`，不带 ACK。异步内容回复用 `re`
- `agent_request` —— 带超时的请求/响应，仅作为已废弃的旧行为保留

有了这些，你就能在本机搭起多智能体协作（比如让 `backend` 智能体找 `frontend` 智能体帮忙），和手机远程连接并行不悖。

## 中继

社区免费中继：

```
wss://relay-rp1.jacobmoura.work
```

拿来起步够用，但中继运营方能看到你消息的内容，而且它是路由上的单点信任。**如果做的是敏感工作，强烈建议自建中继** —— 一条 Docker 命令的事，而且从此你的流量只经过自己的基础设施。

完整的安全权衡和自建指南见 **[`relay/README.md`](./relay/README.md)**。

## 快速开始

在 Pi 运行的任意项目里装上插件：

```bash
pi install npm:remote-pi
```

然后在 Pi 对话里执行：

```
/remote-pi
```

向导会依次问你智能体名字、会话名和用哪个中继，然后打印一个二维码。用 Remote Pi 手机应用扫一下，配对就完成了。

### 建议搭配：`@eko24ive/pi-ask`

```bash
pi install npm:@eko24ive/pi-ask
```

装上 pi-ask 后，智能体的 `ask_user` 澄清式提问（带选项的结构化问题、多选、预览）会以原生形式展现在手机应用里 —— 你在手机上作答，桌面端的流程随即继续。没装的话，智能体就只在聊天里用纯文本提问（手机上一样能答，只是非结构化的）。两种情况 Remote Pi 都照常工作；pi-ask 是可选的。

## 状态

MVP 已可用。规划笔记和路线图在 [`plan/`](./plan)。

## 许可证

许可证按包各自约定 —— 见各子项目的 `LICENSE` 文件（`pi-extension` 是 MIT）。全仓库层面的许可证尚未定案。
