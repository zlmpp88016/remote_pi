# 73 — 本地直连（`--direct`，不经社区 relay）

## 一、上下文

用户的实际诉求：**「能不能不通过 relay 直连，比如 server 启动时带个参数就支持直连」**。

现有架构里，所有客户端流量都经过社区 relay（`https://relay.880160.xyz`，Rust 实现，`relay/`）：

```
浏览器 / App ──ws──> relay.880160.xyz ──ws──> pi-supervisord 的 HostBridge
```

这带来两个真实代价：一是必须联网且依赖第三方可用性（该 relay 有 502/530 抖动记录）；二是哪怕本机同机调试，流量也要绕出公网一圈。

### 决策依据：relay 到底做了什么

读 `relay/src/` 得出，Rust relay 的 ~2400 行生产代码里，对**单机本地场景**真正必要的只有四点：

| 能力 | 证据 | 本地是否必需 |
|---|---|---|
| WS 握手 `hello` → `challenge` → `auth`（Ed25519 挑战应答） | `relay/src/handlers/peer.rs:84-127`、`auth/challenge.rs` | **必需** |
| `(peer, room)` → 连接集合路由 | `peers/registry.rs:246-268` | **必需** |
| 转发时**重写发送者身份** | `handlers/peer.rs:394-399` | **必需（安全根基）** |
| 25s keepalive ping | `handlers/peer.rs:196-199` | **必需**（喂饱宿主 liveness watchdog） |
| `pi_envelope` Pi-to-Pi 转发 | `handlers/pi_forward.rs` | 否（跨机联邦） |
| `subscribe_presence` / `presence_check` | `handlers/peer.rs:239-268` | 否（grep 确认 web 客户端从不发送） |
| `rooms` / `room_meta_updated` 广播 | `handlers/peer.rs:300-345` | 否 |
| `mesh/` 成员存储与校验 | `relay/src/mesh/` | 否 |

**最关键的一条**：relay 转发时会 `peer: peer_id.clone()`——用**已验证的身份**覆盖发送者自己声明的值。接收方之所以信任 `peer` 字段，正是因为 relay 为其背书。本地 relay 必须保留这一步，否则任何客户端都能冒充任意发送者。

结论：单机只需要上述 4 项，约 300 行 TS 即可，无需移植 mesh/presence/federation。

## 二、方案选择

考虑过三条路：

| 方案 | 做法 | 判断 |
|---|---|---|
| A. 进程内嵌 relay | server 内跑一个最小 relay，自己在同进程内连它 | **采用** |
| B. spawn Rust relay 子进程 | `--direct` 直接拉起已编译二进制 | 备选（多一个进程，但零重写） |
| C. HTTP/SSE 直连 transport | 抛弃 relay 协议，另写一套双向通道 | 否（现有 30+ action 全部要重新对齐，回归风险最高） |

选 A：单进程、单地址、协议完全不变，因此**客户端零改动** —— 它只是一个普通的 WS relay 客户端。

## 三、实现

### 3.1 进程内最小 relay

`server/src/transport/embedded_relay.ts`（新增，约 290 行）：

- 握手：`hello{pubkey, room_id}` → `challenge{nonce}`（32 字节随机）→ `auth{sig}`，用既有 `pairing/crypto.ts` 的 `ed25519Verify` 验签。**零新依赖**（`ws` 已在依赖里）。
- 路由：`(peer, room)` → 连接集合；同 peer+room 允许**多连接**（对齐 Rust relay 的 `duplicate_room_accepted`，支持多设备）。
- 转发：解析 `{peer, room, ct}`，**重写 `peer`/`room` 为发送者的已验证身份**，跳过发送者自身连接。
- 未实现的控制帧（`pi_envelope` / `subscribe_presence` / `presence_check` / `rooms` 等）**显式记录并忽略**，绝不当作 envelope 路由（否则是静默数据损坏）。
- keepalive：25s ping，与 Rust relay 一致。

### 3.2 `--direct` 的归属（一次重要纠错）

**最初我把 `--direct` 接在 `remote-pi-server` CLI 上，这是错的。**

实测 `remote-pi-server --direct pair`：打印配对码 → 进程退出 → embedded relay 随之关闭 → 配对码指向一个已不存在的端口。用户只会得到一个裸超时。

真因：长驻的 relay 连接者是 **supervisor 持有的 `HostBridge`**（`daemon/supervisor.ts:186`），不是 CLI。

因此：
- `--direct` 由 **`pi-supervisord`** 持有（`server/src/bin/supervisord.ts`），在 `new Supervisor()` **之前**起 relay；
- `remote-pi-server --direct` 改为**显式拒绝并给出指引**。半支持比不支持更糟。

### 3.3 为什么用环境变量而不是写配置

`server/src/direct.ts` 的 `ensureDirectRelay()` 只写 `REMOTE_PI_RELAY`，**不碰 `~/.pi/remote/config.json`**。

理由（`config.ts:51` 的优先级 `env > config > default`）：

1. env 层正好是「本进程及其子进程」语义 —— supervisor spawn 的 daemon 继承 `process.env`（`daemon/rpc_child.ts:350`），无需逐个配置；
2. 配对码由 `resolveRelayUrl()` 生成（`supervisor.ts:550`），因此 `r=` 参数自动变成本地地址；
3. 用户的已存 relay 原封不动，进程退出即回到原行为，没有「忘记清理」的可能。

反例是 `saveConfig({ relay })`：它会把机器永久钉在一个进程退出后就不存在的端口上，下次启动只剩超时。

`ensureDirectRelay()` 还刻意**不覆盖**用户已显式设置的 `REMOTE_PI_RELAY` —— 运维导出该变量是明确表态，flag 不应按调用顺序偶然取胜。

## 四、怎么用

```bash
# 1. 构建
cd server && npx tsc

# 2. 以直连模式启动 supervisor（长驻）
node dist/bin/supervisord.js --direct
# → [pi-supervisord] direct mode — local relay at http://127.0.0.1:<port> (no community relay)

# 3. 取配对码（自动带本地地址）
node dist/index.js pair
# → remotepi://pair?…&r=http%3A%2F%2F127.0.0.1%3A<port>
```

把该码粘进 `/remote-pi/connect` 即完成，全程不出本机。`r=` 参数是关键：客户端据此采用本地 relay，不需要手动改配置。

## 五、验证

### 5.1 单元测试与注入验证

| 命令 | 结果 |
|---|---|
| `npx vitest run src/transport/embedded_relay.test.ts` | **6/6 passed** |
| `npx vitest run src/direct.test.ts` | **6/6 passed** |
| `npx tsc --noEmit`（server） | 0 错 |

`embedded_relay.test.ts` 用**真实 `RelayClient`**（daemon 同一个类）驱动，覆盖：监听回环并报真实端口、真实握手 + 端到端路由、**伪造 peer 被重写**、不回显给发送者、未知 `(peer,room)` 静默丢弃且 relay 不卡死、坏签名被拒。

**注入验证 1** —— 把转发改成用发送者自声明的 `peer`：
```
× accepts a real RelayClient handshake and routes an envelope to the target
× rewrites a spoofed peer field to the authenticated sender
AssertionError: expected 'aMyuDSuVClu9IhCX…' to be 'uymQzoMrijqPpAS2…'
2 failed | 4 passed
```
只有 2 条安全断言变红，其余 4 条仍绿 → 断言精确。

**注入验证 2** —— `if (!process.env[DIRECT_ENV])` 改成 `if (true)`：
```
× does NOT override an operator's explicit REMOTE_PI_RELAY
AssertionError: expected 'http://127.0.0.1:57022' to be 'http://operator.example:9000'
1 failed | 5 passed
```

### 5.2 真实端到端 gate

`clients/web/scripts/verify-direct-connect.mjs`（新增）+ `server/scripts/direct-gate-host.mjs`（新增）。

**为什么这是真实验证**：
1. relay 是真实的 `startEmbeddedRelay`（`--direct` 跑的同一份代码），不是 fake transport；
2. host 是真实的 `HostBridge`，通过 `resolveRelayUrl()` 取地址 —— 顺带验证了 env 接线；
3. 浏览器是真实 Chrome + CDP，配对码真实粘贴进表单；
4. CDP 抓取全部网络请求，断言**零** `relay.880160.xyz` 流量。

```
ok   embedded relay is loopback-only: http://127.0.0.1:59468
ok   relay never binds a public interface: http://127.0.0.1:59468
ok   pairing code points at the local relay (r= param): http://127.0.0.1:59468
ok   browser pairs with the host over the local relay
ok   the host's real workspace reaches the UI: seeded workspace visible
ok   page made zero requests to the community relay: 1 request(s) + 1 ws
ok   page opened a WebSocket to the local relay: ws://127.0.0.1:59468/
direct-connect: OK (7/7)
```

截图 `clients/web/scripts/_e2e-evidence/direct-connect.png`：`host connected`、`Workspaces 1` + 真实 `server` 行、`New session` 可用，底部状态栏明写 `ws://127.0.0.1:59468 · host room`。

**注入验证 3** —— 把 `COMMUNITY_RELAY_HOST` 换成 `127.0.0.1`：
```
FAIL page made zero requests to the community relay: ws://127.0.0.1:57844/
1 FAILED
```
**注入验证 4** —— host 侧不真实注册工作区：
```
FAIL the host's real workspace reaches the UI: pairing did not complete
2 FAILED
```

### 5.3 既有验收未回退

| 验收 | 结果 |
|---|---|
| `verify-stack-parity.mjs` | OK |
| `tsc --noEmit`（web / server / shell） | 0 错 ×3 |
| `run-web-checks.mjs` | 14/14 |
| `_e2e-verify-rows.mjs` | 11/11 |
| `verify-visual-parity.mjs` | OK |
| `verify-sidebar-parity.mjs` | OK |
| `verify-sessions-switch.mjs` | PASS |
| `verify-continue-from-history.mjs` | OK |
| `eslint src --max-warnings 105` | 0 error / 105 warning |

## 六、gate 自身缺陷（都在本轮修掉，不是放宽标准）

新 gate 第一版「全绿」是**假的**，逐条修掉：

1. **`Network.enable` 放在 `Page.reload` 之前** → 绑定到旧文档，抓到 0 请求，被误读成「零公网流量」。移到 reload 之后。
2. **WS 升级不是 `requestWillBeSent`** → 只收后者会永远报 0。补收 `Network.webSocketCreated`。
3. **配对完成判据用 `/Connected/i`** → 标题栏的 `not connected` 含该子串，"配对停滞"也变绿。改为等真实数据信号。
4. **`[aria-label="Workspaces"]` 实际在 `<aside>` 上**（整个侧栏，且是冻结选择器不能改）→ 数它的 `li` 会数到别的列表。改为断言 **seed 的目录名出现在侧栏文本**。
5. **只查 landmark 不查数据** → 空态（`No workspaces reported yet`）也能过。改为排除空态并要求真实行。
6. **host 脚本内联在模板字符串里** → 换行转义变成真实换行切断字符串字面量、注释里的反斜杠直接破坏解析。抽成真实文件 `server/scripts/direct-gate-host.mjs`，只剩一层转义。
7. **gate 污染浏览器状态**（最严重）→ 它把本地配对写进 `localStorage` 后不还原，指向一个随进程死亡的端口；后续所有 E2E 脚本 `attach()` 到该 origin 时看到无法连接的页面，报 `NO SESSION ROWS`。看起来像产品回退，实际是测试自己造成的。已修为「运行前保存、结束前写回、并关闭自开的标签页」；且原值若指向 loopback（上轮残留）则**不写回**，避免固化污染。
8. **配对 token 编造** → `handlePairRequest` 会 `pairing.consume(token)`，编造的 token 让浏览器收到 `pair_error` 后回退，看起来像 relay 故障。改用 `HostPairingSession.issue()`，写在一次性 `REMOTE_PI_HOME` 下。

## 七、已知限制（如实记录）

1. **放弃跨机联邦**。`pi_envelope`（A 机器的 Pi 转发到 B 机器的 Pi）依赖 mesh 成员校验，本地 relay 不实现。若将来需要跨机，需要补齐 mesh 能力，成本会显著上升。
2. **`Plugins` / `Automations` / `More` 等仍是 inert 行**，与本计划无关，维持原状。
3. **`--direct` 只作用于 `pi-supervisord`**。已在 `remote-pi-server` CLI 侧显式拒绝并指路，不做半支持。
4. **Windows 上 `--direct` 无法与已运行的 supervisor 共存**：命名管道名只由用户名决定（`session/ipc.ts:45-48`），同一用户只能有一个 supervisor 实例。验证时需先停掉既有实例。
5. **`server/src/daemon/supervisor.test.ts`（28 项）与 `host_bridge_68.test.ts`（2 项）在真实 supervisor 运行时必然失败**：同样是命名管道被占用导致 `SupervisorAlreadyRunningError`。这是既存环境约束，与本计划无关；排除这两个文件后全量测试为 **57 文件 / 1035 通过 / 18 skipped**。

## 八、DoD

- [x] 进程内 relay 实现最小必要语义（握手/路由/身份重写/keepalive），且有测试
- [x] 「重写发送者身份」有专门的安全断言，并做过注入验证
- [x] `--direct` 接在正确的宿主（`pi-supervisord`）上；CLI 侧显式拒绝
- [x] 只写 env 不写 config；不覆盖用户显式设置；有测试与注入验证
- [x] 配对码 `r=` 自动指向本地地址（真实契约验证）
- [x] 真实浏览器端到端：配对成功、拿到真实工作区、**零公网流量**
- [x] 端到端 gate 做过 2 次注入验证
- [x] gate 不再污染浏览器状态（跑完紧接其他 gate 仍绿）
- [x] 既有七条验收 + 附加 gate 全部未回退
- [x] 文档成对（本文件 + `.zh-CN.md`）
