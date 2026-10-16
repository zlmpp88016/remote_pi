# Remote Pi — Relay

一个轻量的 WebSocket 中继服务器，把 **Remote Pi** 的各端客户端（手机、浏览器、桌面端）连接到运行在你本机操作系统上的**主机守护进程**。它负责 peer 路由、在线状态、经授权的 Pi 到 Pi 转发，以及带签名的成员关系元数据。

项目的完整概览，见[根 README](../README.md)。

---

## 启动

```bash
# 方案 A —— 公共中继，零部署
# https://relay.880160.xyz

# 方案 B —— Docker 自建（单 3000 端口：WS + /health + /mesh/*）
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  -v remote-pi-data:/data \
  --restart unless-stopped \
  exampleorg/remote-pi-relay

# 方案 C —— 源码构建启动
cargo build --release
./target/release/relay
# 换端口：REMOTEPI_RELAY_PORT=8080 ./target/release/relay

# 方案 D —— 本目录内的辅助脚本
./run.sh                 # 首次运行会先构建，然后启动（裸机）
./run.sh --help          # 全部参数

docker compose up -d     # 方案 B 的 Compose 版本（具名 volume + healthcheck）
```

健康检查：`GET /health` 返回 `200 OK`。详细配置与环境变量见
[自建中继](#自建中继推荐出于隐私考虑)。

---

## 协议与安全

线上格式、身份模型、ACK 协议、跨 PC 路由、mesh 成员关系、信任模型和失败模式，见仓库根目录的 [PROTOCOL.md](../PROTOCOL.md)。中继在线路上强制执行的每一条规则，都以那份文档为准。

---

## 工作原理

每台设备在 WebSocket 握手时用 Ed25519 密钥对做认证（挑战-应答）。中继随后执行以下内容边界：

- 对于 App↔Pi 流量，外层 `ct` 保持不透明，永不解码。
- Pi→Pi 的 `pi_envelope` 帧和带签名的成员关系 blob，仅在为路由和授权所必需时在内存中解析。
- 任何信封正文、密钥材料或签名都不会被记录或持久化为消息负载。SQLite 持久化仅限于 Owner 签名的成员关系授权元数据，不涉及消息流量。
- 只要有任一正确签名的 Owner blob 直接列出两个规范形式的 Pi 公钥，该路由即视为可用。这并不证明 Owner 与任一 Pi 配对过或控制着它，也不是更强的信任保证。成员关系不会跨重叠的 Owner blob 传递。
- 正向授权缓存最多可保留一条已撤销权限 60 秒。发送方未命中的否定结果缓存 1 秒，且缓存有上界。

---

## 公共中继

有一个共享中继可用：

```
https://relay.880160.xyz
```

你可以零配置直接用它上手。但请注意下面的安全权衡。

### 安全考量

在公共中继上，消息受两重保护：

- **TLS（SSL）** —— WebSocket 连接在传输中加密。
- **Ed25519 连接密钥** —— 挑战-应答用于证明对端持有其声明的连接密钥。它本身并不证明 App 已完成配对，也不授权每一条路由。

App↔Pi 配对和 room 寻址由客户端协议自身负责。Pi→Pi 转发另有中继侧的路由可用性判定：必须有某个正确签名的 Owner blob 直接列出两个 Pi 公钥。这并不证明 Owner 与任一 Pi 配对过或控制着它，也不是更强的信任保证。

本仓库发布的中继从不解码外层 `ct`，也不记录或持久化消息流量。但这一实现行为不构成端到端信任边界：中继运营方掌控着 TLS 端点、可执行文件和主机，一个被攻陷或怀有恶意的运营方可以替换该服务或在其中植入监控代码，来窥探、留存流量。Pi→Pi 的信封内容同样会在中继进程中被临时解析，用于路由和授权。

**如果你处理敏感工作 —— 私有代码、凭据、专有数据 —— 我们强烈建议运行自己的中继。**

---

## 自建中继（出于隐私考虑推荐）

运行自己的中继可以把共享中继的运营方从信任路径上移除，把 TLS 端点、可执行文件和存储都置于你自己掌控的基础设施之下。

### Docker（最快）

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  -v remote-pi-data:/data \
  --restart unless-stopped \
  exampleorg/remote-pi-relay
```

中继只监听**一个端口**（默认 `3000`），同时提供三个对外服务面：

- `GET /` —— WebSocket 升级（peer 协议）
- `GET /health` —— 健康检查（返回 `200 OK`）
- `GET / POST /mesh/<owner_pk_hash>` —— 带签名的成员关系版本

把你的 app 和 `remote-pi` 指向 `ws://<your-server-ip>:3000`（如果放在 Caddy、nginx 这类终止 TLS 的反向代理后面，就用 `wss://`）。

**`/data` volume**：中继把它的 SQLite 数据库（带签名的成员关系版本）存在容器内的 `/data/mesh.db`。挂一个具名 volume（如上面的例子）或宿主机目录（`-v /srv/remote-pi:/data`），以便状态在 `docker rm` 删除和镜像升级后仍保留。不挂载的话，每次容器启动数据库都会重建为空库，客户端会在下一次变更时重新发布其状态。

### 裸机部署（不用 Docker）

**快速启动** —— `run.sh` 首次运行会构建，然后 exec 该二进制。它读取的环境变量与
Docker 镜像完全一致，并把 `REMOTEPI_MESH_DB_PATH` 默认指向 `./data/mesh.db`
（已在 .gitignore 中），所以 `git status` 保持干净：

```bash
cd relay
./run.sh                 # 按需构建，然后运行
./run.sh --no-build      # 只运行（二进制缺失则报错）
./run.sh --build         # 只构建后退出
```

**作为 systemd 服务** —— `relay.service` 是加固过的 unit（专用非特权用户、
`ProtectSystem=strict`，只为数据库目录开一个 `ReadWritePaths` 例外）。
先按需改路径并创建用户：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin relay
sudo mkdir -p /opt/remote-pi-relay /var/lib/remote-pi-relay
sudo chown relay:relay /var/lib/remote-pi-relay

cargo build --release
sudo install -m 0755 target/release/relay /opt/remote-pi-relay/relay
sudo install -m 0644 relay.service /etc/systemd/system/remote-pi-relay.service

sudo systemctl daemon-reload
sudo systemctl enable --now remote-pi-relay
systemctl status remote-pi-relay
journalctl -u remote-pi-relay -f
```

端口 `3000` 大于 1024，所以服务**不需要 root，也不需要 `CAP_NET_BIND_SERVICE`**。

#### 运行环境要求

| 需要 | 原因 | 说明 |
|---|---|---|
| Linux 或 macOS | 中继要监听 TCP 并写 SQLite | Windows：用 Docker 或 WSL |
| 一个可写目录 | SQLite 存 Owner 签名的成员关系版本 | 默认 `./data`，父目录首次启动自动创建 |
| 一个空闲 TCP 端口 | WS + `/health` + `/mesh/*` 共用同一端口 | 默认 `3000`，用 `REMOTEPI_RELAY_PORT` 改 |
| TLS 终止器（生产） | 中继本身讲明文 HTTP/WS | 前置 Caddy/nginx 以提供 `wss://` |

**不需要任何系统库。** `rusqlite` 启用了 `bundled` 特性，SQLite 直接链进二进制——
既没有 `libsqlite3` 依赖，也不需要安装任何运行时包。只有**构建**阶段需要 Rust
工具链（1.94+，edition 2024）；产出的二进制是自包含的。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REMOTEPI_RELAY_PORT` | `3000` | 提供 WebSocket 升级、`/health` 和 `/mesh/*` 的 TCP 端口（全在同一端口上） |
| `REMOTEPI_MESH_DB_PATH` | Docker 内为 `/data/mesh.db`；裸机构建为 `data/mesh.db`（相对 cwd） | 存放带签名成员关系版本的 SQLite 数据库路径。首次启动时父目录会自动创建。Docker 镜像预设为 `/data/mesh.db`，并把 `/data` 声明为 volume —— 见上面的 volume 说明 |
| `RUST_LOG` | _（无）_ | 日志级别过滤 —— 比如 `info`、`debug`、`warn` |

自定义端口和日志的示例（volume 挂载不变）：

```bash
docker run -d \
  --name remote-pi-relay \
  -p 8080:8080 \
  -v remote-pi-data:/data \
  -e REMOTEPI_RELAY_PORT=8080 \
  -e RUST_LOG=info \
  --restart unless-stopped \
  exampleorg/remote-pi-relay
```

### Mesh 成员关系端点

`/mesh/<owner_pk_hash>` endpoint 存放 **Owner 签名**的 Pi 公钥列表，以 `sha256(owner_pk)` 的小写十六进制为键。它让新设备上的 app（同一 Apple ID / Google 账号）在从 iCloud Keychain / Block Store 恢复 Owner Ed25519 密钥之后，能自动找回自己的 peer 列表。

中继用 Ed25519 对每个 `POST` 校验内嵌的 `owner_pk`，且只接受严格大于当前版本号的版本（单调递增）。请求体上限 500 KB。中继不创建成员关系：它存放 Owner 签名的授权元数据，并在任一正确签名的 Owner blob 直接列出两个公钥时，把 Pi A↔B 视为路由可用，不做跨 blob 的传递授权。这并不证明 Owner 与任一 Pi 配对过或控制着它，也不是更强的信任保证。自带的 POST endpoint 能阻止非特权调用方在没有对应 Owner 私钥的情况下改动某个 Owner 槽位。但这不是对中继 / 运营方被攻陷的防护：运营方掌控着可执行文件和 SQLite 授权状态。一条正向授权缓存条目最多会把撤销延迟 60 秒；发送方未命中的否定结果缓存 1 秒，缓存有上界。

**自建注意事项**：`REMOTEPI_MESH_DB_PATH` 处的 SQLite 数据库（官方 Docker 镜像内为 `/data/mesh.db`）是你的运维责任 —— 确保 `/data` 位于持久化 volume 上，并和其他服务器状态一起备份。一旦丢失，客户端会在下一次变更时重新发布当前视图。

**存储布局**：SQLite 运行在默认的 rollback-journal 模式（NOT WAL），因此只有 `mesh.db` 会持久化。写事务期间，同目录下可能出现一个临时 `mesh.db-journal`，提交后即删除。两个文件都位于 `REMOTEPI_MESH_DB_PATH` 的父目录下 —— Docker 里通常是 `/data/`，裸机上是二进制文件旁边的 `data/`。该目录在首次启动时自动创建。这个数据库只含成员关系授权元数据，绝不含消息流量。

升级时，先部署 Relay 0.3：旧 Extension 能正常处理它返回的 UUID 错误。然后协调 Extension 0.6 的铺开，尽量减少新旧 Extension 混用，因为新旧线上格式标签的互通已被推迟。Extension 0.6 里那个面向旧 Relay 的错误 shim，是为旧 Relay 或 Relay 回滚准备的，而不是「先升 Relay 才安全」的理由。集中式的发布准入控制见[计划 51](../plan/51-cross-pc-mesh-routing-hardening.md)。

### 放在反向代理之后（HTTPS/WSS）

生产使用时，把中继放在终止 TLS 的代理后面。Caddy 配置示例：

```
relay.yourdomain.com {
    reverse_proxy localhost:3000
}
```

然后把 app 和 `remote-pi` 的中继 URL 设为 `wss://relay.yourdomain.com`。

---

## 从源码构建

```bash
cargo build --release
./target/release/relay
```

```bash
REMOTEPI_RELAY_PORT=8080 RUST_LOG=info ./target/release/relay
```

## 运行测试

```bash
cargo test
cargo clippy -- -D warnings
```
