# 76 — 彻底移除 relay：可行性、代价与路线

## 一、上下文

用户的诉求：**「探索一下全面拿掉 relay 的方案，全部拿掉，走直连 server 的方式，就算重写 server 大部分功能也行」**。

这份文档回答三件事：

1. relay 到底还剩什么不可替代的职责；
2. 拿掉它要付什么代价（哪些能力永久消失）；
3. plan/73 已经做完了什么、还差什么才能「默认就是直连」。

**先说结论**：`--direct` 已经实现并通过全部 DoD（plan/73），实测可用。真正缺的不是「重写 server」，而是三件工程收尾：固定端口、同源静态服务、origin 白名单。把这三件做完，relay 就可以从默认路径上撤掉——**但「删除 `relay/` 这个仓库」是另一件事，代价见 §4。**

---

## 二、实测：直连今天就能跑

不是设计推演，是跑出来的。

```
$ node dist/bin/supervisord.js --direct
[pi-supervisord] direct mode — local relay at http://127.0.0.1:56542

$ node dist/index.js pair
remotepi://pair?t=…&epk=…&n=lei&rm=host&r=http%3A%2F%2F127.0.0.1%3A56542
                                                  ^^^^^^^^^^^^^^^^^^^^^^^
                                                  本地，不是 relay.880160.xyz
```

浏览器（真实 Chrome + 真实点击）：**Relay address 留空**，只粘贴配对码：

```json
{ "hostConnected": true, "hasComposer": true, "storedRelay": "ws://127.0.0.1:56542" }
```

server 日志侧证据（全部由进程内 relay 处理，零公网流量）：

```
[relay] embedded relay: peer=Wp1HcwM= room=pEzLl5UwVVKF disconnected
[relay] host room ← workspace_list from aOIqGHaS…
[relay] proxy ← child room=pEzLl5UwVVKF asked=hit (host_message to 1 peer(s))
```

**客户端零改动**——它只是一个普通的 WS relay 客户端，不认识「relay 在哪」。

### relay 的职责清单（哪些真不可替代）

| 职责 | Rust relay | 内嵌 relay | 单机是否必需 |
|---|---|---|---|
| WS 握手 hello→challenge→auth（Ed25519） | 有 | **有** | 必需 |
| `(peer, room)` 连接路由 | 有 | **有** | 必需 |
| 转发时**重写发送者身份** | 有 | **有** | 必需（安全根基） |
| 25s keepalive ping | 有 | **有** | 必需（喂 liveness watchdog） |
| origin 白名单 | 有（`relay/src/origin.rs`，默认宽松） | **无** | **必需，见 §3** |
| `pi_envelope` Pi-to-Pi 跨机 | 有 | 无（显式忽略） | 否 |
| `subscribe_presence` / `presence_check` | 有 | 无 | 否（web 客户端从不发送） |
| `rooms` / `room_meta_updated` | 有 | 无 | 否 |
| `mesh/` 成员存储与校验 | 有 | 无 | 否 |

内嵌版约 302 行覆盖了全部「单机必需」项。**Rust relay 里对单机场景真正多余的只有 mesh/presence/room-catalog。**

---

## 三、plan/73 没覆盖的三个空白（本轮实测新发现）

### 3.1 端口是随机的 —— 每次重启配对失效（真实可用性缺陷）

`direct.ts:49`：

```ts
export async function ensureDirectRelay(port = 0): Promise<string>
```

`port = 0` 让 OS 分配（实测 `56542`）。**重启 supervisord → 端口变 → `localStorage` 里存的 `ws://127.0.0.1:56542` 失效 → 用户必须重新 `pair` 并手贴。**

这让 `--direct` 停留在「能演示」而非「能日常用」。plan/73 的 DoD 是「真实浏览器配对成功」，这个判据**抓不到重启后的失效**——所以它当时全绿是合理的，只是覆盖面到不了这里。

修法（最小）：
- 固定默认端口（如 `4124`），优先级 `--port` > `REMOTE_PI_PORT` > config > `4124`；
- **端口被占时明确失败**，不静默 +1（静默递增会让书签/标签页/session 莫名失效，比直接报错更难查）；
- 写 `~/.pi/remote/direct.json` 记录实际端口，干净退出时删除；
- 客户端在同源模式下改用 `ws://${location.host}`，端口变了只要地址栏变就能自适应。

### 3.2 内嵌 relay 没有 origin 白名单（安全缺口）

```
$ grep -c origin server/src/transport/embedded_relay.ts
0
```

Rust 版有 `relay/src/origin.rs`（可配白名单，默认宽松）；内嵌版**完全没有**。

风险链：任何网页都能 `new WebSocket("ws://127.0.0.1:56542")` → 自生成 Ed25519 密钥对通过 auth（auth 只证明「这是有效密钥」，不证明「有权限」）→ 真正的门只剩 `pair_request` 的 token。

**所以 token 是唯一防线，origin 检查是缺失的第二道。** 一旦将来做了 §3.3 的自动配对（本机免粘贴 token），这道门就彻底没了——**必须先把 origin 白名单做上**。

### 3.3 server 不服务静态资源 —— 因此不可能同源

`grep -rn "dist-shell\|static" server/src/` 返回空。web client 由 vite 在 `localhost:3010` 提供，内嵌 relay 在 `127.0.0.1:56542`。

后果：
- **跨源**。今天能连是因为内嵌 relay 不检查 origin。**一旦按 §3.2 加上白名单，当前 dev 场景会立刻被拒**（`Origin: http://localhost:3010` ≠ 允许列表）。这两件事必须一起做。
- `http://localhost` 是 secure context（实测 `isSecureContext: true`、`crypto.subtle` 可用），所以 WebCrypto 没问题；但**用 LAN IP（`http://192.168.x.x`）访问则不是**，`crypto.subtle` 为 `undefined`，Ed25519 直接失败。这是选同源单端口的另一个理由。

同源化的最小实现（约 50 行）：`supervisord` 里一个 `http.createServer`，GET 走静态文件（`index.html` 兜底 SPA 路由），`upgrade` 交给 `EmbeddedRelay.wss.handleUpgrade`。

---

## 四、真的删掉 `relay/` 会失去什么

这一节不是劝退，是把账算清。

### 4.1 永久失去

| 能力 | 为什么不能靠 server 自己补 |
|---|---|
| **跨机访问**（手机/外部笔记本连家里机器） | 需要公网可达地址。server 在内网，浏览器在外网，没有 relay 就没有会合点。替代品是 Tailscale / Cloudflare Tunnel / 端口转发 + DDNS——那是**另一个基础设施**，不是「删掉 relay」 |
| **Pi-to-Pi 跨机 mesh**（`pi_envelope`） | 内嵌 relay 显式不实现（需要 mesh 成员校验与存储） |
| **presence / 多设备发现** | web 客户端目前不发这些帧，但桌面/移动端可能用 |
| **第三方 relay 的可用性解耦** | 反过来说：现在 `relay.880160.xyz` 抖动会连带影响（历史上有 502/530 记录）。删掉它对单机用户是**净收益** |

### 4.2 桌面端与移动端

`clients/desktop` 与 `clients/mobile` 都走 relay 握手（Gemini 指到 `relay_host_client_factory.dart` / `dependencies.dart`）。

- 若保留 `{peer, room, ct}` 协议 + 内嵌 relay（= 现在的 `--direct`）：**两个客户端零改动**，只是把地址指向本地。
- 若重写成「裸 WS 直连、去掉信封」：**两端都要改**，这是 plan/73 明确否决的方案 C（30+ action 全部重新对齐）。

### 4.3 Electron shell 已经解了同源问题

`clients/shell` 用 `app://app` 自定义 scheme + `protocol.handle` 服务 `clients/web/dist-shell`，注册为 `standard/secure/corsEnabled`（`clients/shell/README.md`）。生产环境它**可以**直接 `loadURL("http://127.0.0.1:4124")`，把同源问题交给 server。这证明「server 服务静态资源」在本仓库不是新概念。

---

## 五、三条路线与建议

### 路线 A：保留协议 + 内嵌 relay，撤掉 Rust relay 的默认地位（**推荐**）

做完 §3.1–3.3 三件收尾，`--direct` 变成默认，`relay/` 从默认路径上消失。

- 工作量：**小**（3 处改动，约 100–150 行 + gate）
- 客户端：web/desktop/mobile **全部零改动**
- 失去：跨机访问、mesh（本来单机也用不到）
- 风险：低（协议不变，plan/73 的测试与 gate 继续有效）

### 路线 B：连 `relay/` 目录一起删

在 A 之上删除 Rust relay 代码与部署。**技术上无额外难点，但意味着永久放弃跨机能力**——将来要加回来得重写。

- 工作量：A + 删代码/文档/CI
- 建议：**先做 A，`relay/` 留作可选基础设施**。删仓库是不可逆的决定，而 A 已经让单机用户完全不需要它。

### 路线 C：重写成裸 WS 直连、彻底去掉 `{peer, room, ct}` 信封

- 工作量：**极大**（HostBridge、child IPC、三个客户端都要改）
- 收益：协议更简单
- 我的判断：**不值得**。信封带来的复杂度主要已在客户端兜住了，而重写会打掉 plan/73 全部已验证成果。

---

## 六、建议的执行顺序

| # | 步骤 | 验收 |
|---|---|---|
| 1 | 固定端口 + `direct.json` + 端口占用明确报错 | 连续重启 3 次端口不变；占用时给出可读错误 |
| 2 | server 服务静态资源（同源） | `http://127.0.0.1:4124` 打开即用；WebSocket 同端口 |
| 3 | origin 白名单（**必须与 2 同时上线**） | 外部 origin 被 403；`http://127.0.0.1:4124` 通过 |
| 4 | 本机免配对（`/api/bootstrap` + `Sec-Fetch-Site` 校验） | 首次访问零点击连上；外部页面拿到 403 |
| 5 | `--direct` 改为默认，`--community-relay` 作为显式 opt-in | 默认零公网流量；显式开关仍能走公网 relay |

第 3 步不能晚于第 2 步：同源一旦成立，如果不加 origin 检查，`http://127.0.0.1:4124` 上的**任何**页面（含被注入的第三方脚本）都能连上。

---

## 七、已知限制（如实记录）

1. **LAN IP 访问会坏**：`http://192.168.x.x:4124` 不是 secure context，`crypto.subtle` 不可用，Ed25519 失败。要支持局域网访问需要 HTTPS（自签证书在 WS 上无法让用户点「继续」）。这是浏览器规范约束，不是实现缺陷。
2. **Windows 同一用户只能有一个 supervisor**（命名管道名只由用户名决定，`session/ipc.ts:45-48`）。多实例需要 `--home` 隔离。
3. **本轮的实测环境未完全复原**：用 `--direct` 起过 supervisord 后杀掉进程，Windows 命名管道句柄延迟释放，`--direct` 之外的默认模式短时间内起不来。与本方案无关，但重跑 gate 时需要等管道释放或换 `--home`。
4. **`grep -c origin` = 0 是本节 §3.2 结论的唯一依据**，我没有在真实浏览器里构造跨站攻击验证可利用性。按「声明风险必须可复现」的规矩，这里标注为**未复现的安全判断**，实施前应补一次真实 PoC。

---

## 八、DoD

（本文件为探索与方案，不产生实现 DoD。实施时在 plan/73 上续写，或新开 plan/77。）

- [x] 实测 `--direct` 端到端可用（真实浏览器 + 真实配对码 + 零公网流量）
- [x] 厘清 relay 的单机必需职责 vs 跨机职责
- [x] 识别 plan/73 未覆盖的三个空白（随机端口 / 无 origin 检查 / 不同源）
- [x] 列出删除 relay 的完整代价与三条路线
- [ ] 用户决策：走 A、B 还是 C

---

## 九、实施记录：八个真实 bug（2026-10-27）

路线 A 落地过程中，每一步都被一个只有跑起来才会暴露的缺陷挡住。每一条都是先观察后解释，不是推测。

### 9.1 SSE 命名事件不触发 `onmessage`（最危险）

服务端用 `event: endpoint` 下发连接 id。**浏览器不会把这个事件交给 `onmessage`** —— `onmessage` 只接无名事件。

后果链：id 恒为 `null` → POST 不带 `?id=` → 服务端 400 → 客户端 `catch {}` 静默吞掉 → **界面显示「已连接」，但所有出站帧凭空消失**。

真实浏览器反证：`sawOnmessageBeforeEndpoint: false`。

修法：`addEventListener("endpoint", …)` 取 id，加 `preIdOutbox` 缓存 id 到达前的帧。

> 自测盲区：用 `fetch` 直读流的手写脚本会看到所有事件，因此**这个 bug 在 Node 侧测不出来**。

### 9.2 多标签页互相泄漏帧

每流复用 host 密钥对时，两个 tab 进入同一个 `(peer, room)` 路由桶。relay 转发只跳过**发送 socket 自己**，所以 tabB 收到 tabA 的回复。

实测 `tabA:1 / tabB:2`。修法：每流独立 Ed25519 keypair + `authoriseLocalPeer`。

### 9.3 「共用密钥 + 派生 room」方案会被 `_isOwnKeyInbound` 吞掉

`host_bridge.ts:436` 把「`peer === ownPubkey` 且 `room !== host`」判为**子进程回复**。任何靠派生 room 区分标签页的方案，都会让浏览器命令被当成 IPC 回复转发给子进程。

这是 9.2 不能用「一个身份多房间」解决的根因，也是阶段二（§9.6）必须先重放 peer 重写的原因。

### 9.4 信封的 `peer` 是目的地，不是身份

relay 按 `(destPeer, destRoom)` 查路由表。发空 `peer` → `dest peer= room=host not found, dropping`，帧直接消失，两端都无报错。

### 9.5 固定端口让并发测试无法运行

固定 4124 之后，`direct.test.ts` 与活着的 `--direct` 服务抢端口（实测 5 failed）。
修法：`resolveDirectPort` 接受 `port: 0`（`>= 0` 而非 `> 0`），测试全部改用 `{ port: 0 }`。

### 9.6 阶段二的 peer 重写陷阱

把浏览器帧直接注入 `_onLine` 时，若不做 relay 本该做的「把 `peer` 重写成发送者身份」，每一条浏览器命令都会撞上 §9.3 的推断而被误判成子进程回复。

修法：注入前显式 `peer = session.peerKey`。
验证：`grep -c "injected directly"` = 3 且 `grep -c "relay rx.*workspace_list"` = **0**。

### 9.7 `fetch` 对 4xx/5xx 不抛错 → 409 被静默吞掉

`sse-transport.ts` 的 `pump()` 原本只 `catch` 网络失败。笔记本睡眠超过 `SESSION_TTL_MS`(10min) 后，服务端返回 **409**（连接已失效），`fetch` 正常 resolve，帧被丢弃，用户输入永久消失而界面一切正常。

修法：检查 `res.status`；409/404 → `emit("error",{type:"transport_gone"})` + 关闭流驱动重连重同步（**不盲目重试**，否则会重复聊天消息）；`>=500` 只报错。

### 9.8 `/api/bootstrap` 的 nonce 不能「单次使用」

第一版把 nonce 存进 `Map` 并在成功后删除。两个普通场景立刻失效：

1. 浏览器保留它收到的最后一个 cookie；页面 reload 后拿旧 nonce → 403 直到用户清 cookie
2. 进程重启 → Map 清空 → 同样 403

修法：改成**无状态 HMAC 签名时间桶** `"<bucket>.<hmac(key,bucket)>"`，接受 `current` 到 `current-2` 三个桶（cookie `Max-Age=180` 与之对齐）。重启换 key 会让旧 nonce 失效，这是正确行为。

---

## 十、本机零点击配对的安全边界（如实记录）

`/api/bootstrap` 要求**同源页面加载的证据**，三道独立检查：`SameSite=Strict` 签名 cookie、`Sec-Fetch-Site: same-origin`、`Origin` 匹配 Host。实测 7 个场景：无 cookie / 伪造签名 / 过期 bucket / cross-site / evil Origin 全部 403；仅「cookie + same-origin」返回 200。

**但它挡不住同一台机器的另一个 OS 用户**：他们同样能加载 `http://127.0.0.1:4124/` 并拿到同源 cookie。浏览器的 cookie 作用域是 `(scheme, host, port)`，与登录用户无关，因此无法呈现 OS 级身份。

这不是本实现的缺陷，而是**所有 loopback 监听器的共同属性**。要真正区分 OS 用户需要文件 ACL 或 `SO_PEERCRED` 一类的 OS 级通道，浏览器都不提供。

实际缓解：`--direct` 明确不支持远程访问；`/healthz` 之外的全部端点仍在 host/origin 门禁之后。

---

## 十一、两个新 gate 与其注入验证

| gate | 覆盖 | 检查数 |
|---|---|---|
| `verify-web-local-auth.mjs` | Host / Origin / Sec-Fetch-Site 三道门各自独立生效 + bootstrap 8 场景 | 9 |
| `verify-web-sse-transport.mjs` | 命名事件握手、真实回帧、多标签隔离、409 重连信号 | 10 |

两个 gate 都**不是**「只看状态码」：auth gate 断言拒绝理由文案，transport gate 断言每个 tab **恰好**收到 1 个回复（共用身份时变 3，泄漏被量化）。

**注入验证（各一次，真实报红）**

1. 删掉 `Sec-Fetch-Site` 检查 → `cross-site Fetch Metadata is refused by its own check: status 200`，8/9；而 Origin 用例仍绿，证明两者独立。
2. 所有流共用 host 密钥对 → `tab A received exactly its own reply: 3 reply(ies)`，8/10。

测 `Sec-Fetch-Site` 的请求**刻意不带 `Origin`**：否则 Origin 检查会先返回 403，把「fetch-site 检查被删掉」掩盖成假绿。
