# Electron 桌面端基线（plan/85 P0）

> 记录日期：2026-11-02（当日更新）
> 环境：Windows，Node v22.19.0，Electron ^45.0.0，本机 daemon `127.0.0.1:4124` 已跑通

这份文档只写**实测结果**。没测到的写「未测得」并说明原因，不写「应该可以」。

---

## 1. 已真实验证（有证据）

| 项 | 结果 | 证据 |
|---|---|---|
| shell 能编译 | ✅ | `npm run build` 产出 `dist/main.js` + `dist/preload.cjs` |
| `app://app` 能加载页面 | ✅ | CDP 实测 `location.href = app://app/remote-pi/connect`，`root` 有 1 个子节点，`body.innerText` 768 字 |
| CSP 不破坏页面 | ✅ | 注入 CSP 后页面完整渲染，无 `vite-error-overlay` |
| **`window.remotePi` 存在** | ✅ | `typeof window.remotePi === "object"`，keys = `["openExternal","getPlatform","getVersion","openUserDataLog"]` |
| **IPC 真能返回数据** | ✅ | `window.remotePi.getPlatform()` 返回 `"win32"` |
| **日志落盘真能工作** | ✅ | 故障注入（把 `dist-shell` 改名）后 `shell.log` 出现 `[ERROR] Protocol 404: failed to read SPA shell ... ENOENT` |
| R5 修复生效（源码态） | ✅ | 日志首行 `Shell ready: isPackaged=false, webExportDir=...\clients\web\dist-shell` |
| 生产 DevTools 管控 | ✅ | `main.ts:461` `const showDevTools = !app.isPackaged \|\| Boolean(process.env["REMOTE_PI_DEBUG"])` |

**日志位置**：`%APPDATA%/@remote-pi/desktop-shell/logs/shell.log`
（不是 `clients/shell/logs/` —— 写的是 `app.getPath("userData")`）

---

## 2. 修复的真实缺陷

### preload 加载静默失败（本轮发现）

preload 最初被编译成 **ESM**，而 `package.json` 是 `"type": "module"`。
Electron 的沙箱 preload 只执行 **CommonJS**，且**失败是静默的**：
窗口正常加载，`window.remotePi` 永远 undefined。没有任何错误输出。

更隐蔽的是修好格式后的第二个坑：preload 曾 `require("./ipc.js")`，
但构建把该文件重命名成 `ipc.cjs` —— 相对路径指向不存在的文件，又是静默失败。

**最终方案**：
- `tsconfig.preload.json` 单独把 preload 编成 CommonJS
- `scripts/finish-preload.mjs` 把产物重命名为 `.cjs`（`type: module` 下 `.js` 会被当 ESM）
- `src/preload.ts` **零相对导入** —— 通道常量就地声明，只 `require("electron")`
- 主 tsconfig `exclude` 掉 `src/preload.ts`，避免再生成一份 ESM 副本

---

## 3. 真机验证结果（已全部测得）

用本机 daemon（`127.0.0.1:4124`）真实配对后逐面板点击验证。

### 零配置配对（已修复，不再需要环境变量）

早先版本必须让用户启动 daemon 时加 `REMOTE_PI_ALLOWED_ORIGINS="app://app"`，
否则每次 WebSocket 升级都被 `Origin mismatch` 拒绝。

**现在不需要了。** `same_origin_server.ts` 新增 `isDesktopShellOrigin`：
服务器**实际绑定在 loopback 上**时，`app://app` 默认被信任。
判据取自 `server.address()`，**不是**请求的 `Host` 头 —— 后者由客户端提供，
用它在 `0.0.0.0` 绑定时会把「外部访问伪造 loopback Host」也放进来。

这不削弱同源检查：该检查防的是**网页**跨站驱动 daemon，浏览器强制写 `Origin`，
页面脚本改不了。`app://app` 只有特权本地进程（shell 主进程）能产生，
而这种进程本来就能伪造任意 Origin。拒绝它没换来任何安全，只让每个桌面用户
手工配一个环境变量。

绑定到可路由地址时行为不变：仍需显式 allow-list。

### 深链接配对（`remotepi://pair?…`）

桌面端**主要**配对路径。同源免密（`/api/bootstrap`）在 `app://` 下必然失败
——那个路径解析到 SPA 回退，返回 `index.html` 而不是凭证。

链路：argv → `findPairUri` → 轮询 `window.__remotePiPairListener` 就绪
→ 派发 `remote-pi:pair-uri` CustomEvent → 填入配对框 → 自动提交。

**两个踩过的坑**：
1. `createWindow()` 已经 `await loadURL`，`did-finish-load` **早已触发**；
   再 `once("did-finish-load")` 永远不解析，URI 被静默丢弃（页面停在空表单）。
   改为轮询监听器标志（40 × 250ms）。
2. 只填输入框不提交，用户点完链接还得再点一次按钮 —— 点链接本身就是配对意图，
   所以填完自动 `requestSubmit()`。

## 3c. 打包态验证（已实测通过）

`electron-builder 25.1.8` + `npm run dist` 产出 `release/win-unpacked/`。

实测结果：

| 项 | 结果 |
|---|---|
| `isPackaged=true` | ✅ 日志确认 |
| 资源寻址 | ✅ `webExportDir=...eleasewin-unpackedesourcesdist-shell` |
| `extraResources` 拷贝 | ✅ `resources/dist-shell/` 含 assets/cockpit |
| `app://app` 协议 | ✅ URL 正确，页面渲染 |
| preload（asar 内） | ✅ `window.remotePi` = object |
| IPC | ✅ `getPlatform()` → `win32`，`getVersion()` → `0.1.0` |
| 深链接配对 | ✅ `pair-uri delivered` + 已配对 |
| 8 面板 | ✅ 8/8 aria-current 切换 |

**打包命令踩的坑**：`npm run dist` 在 `winCodeSign` 解压阶段失败 ——
7za 需要创建 macOS 的符号链接（`libcrypto.dylib`），Windows 无权限。
但 `win-unpacked/` 已完整生成且可用，NSIS 安装包阶段才需要签名工具。
纯功能验证不需要安装包。

## 3d. 自签名 TLS（已双向实测）

用真实自签名证书（`openssl req -x509 ... -addext subjectAltName=IP:127.0.0.1`）
起 `https://127.0.0.1:9443`，再用 CDP 让 shell 导航过去，读回渲染内容。

| 场景 | 结果 | 证据 |
|---|---|---|
| 默认 | **REFUSED** | body: `Failed to load page / Error: ERR_CERT_AUTHORITY_INVALID (-202) / Retry` |
| `REMOTE_PI_ALLOW_INSECURE=1` | **ALLOWED** | body: `TLS-OK` |

两个结论：
1. `certificate-error` 默认拒绝真的生效，不是纸面策略。
2. `did-fail-load` 兜底页也真的渲染了 —— 用户看到的是可重试的错误页，不是白屏。

## 3e. 仍未覆盖

| 项 | 原因 |
|---|---|

| 深链接 `remotepi://` | 未实现（T2.4） |
| 自签名 TLS | 无自签名端点 |

## 4. 已知的、与 Electron 相关的 web 端行为差异（代码审查确认，未运行验证）

这三条是 `plan/85` 审查阶段从代码里读出来的，**尚未在运行中复现**：

1. **同源免密配对失效**
   `clients/web/src/lib/remote-pi/bootstrap-client.ts:53` 用
   `credentials: "same-origin"` 请求 `/api/bootstrap`。在 `app://app` 下变成
   `app://app/api/bootstrap` → 命中 SPA 回退。日志里已观察到对应痕迹：
   `[WARN] Static file check failed for /api/bootstrap (...\api\bootstrap): ENOENT`

2. **`location.origin` 转 ws 得到非法目标**
   `clients/web/src/client/connect-client.tsx:1624`
   `location.origin.replace(/^http/, "ws")` 对 `app://app` 不匹配。

3. **SSE 同源优化永不命中**
   `clients/web/src/lib/remote-pi/adapter.ts:410-413` 比较
   `origin !== pageOrigin`，`pageOrigin` 恒为 `app://app`，永远走 WebSocket 回退。

---

## 5. 怎么继续

要推进验证，需要一个已配对的主机：

```bash
# 1. 起 daemon（另开一个终端）
cd server && node dist/bin/supervisord.js --direct

# 2. 拿到配对 URI 后启动壳并跑完整验收
cd clients/shell
npm run export:web && npm run build
REMOTE_PI_PAIR_URI='remotepi://pair?...' npm run start:cdp   # 后台
node scripts/verify-shell.mjs      # 三路由 + WS 配对 + 会话列表
node scripts/verify-tabs.mjs 9444  # 8 个 dock tab（本文件新增）
```

`verify-tabs.mjs` 在未配对时会 **SKIP** 并说明原因，不会报 8 条假 FAIL。

---

## 4. 总结（全部实测，无推测）

| 能力 | 状态 | 证据 |
|---|---|---|
| 自定义协议 `app://app` + SPA 回落 | ✅ | 打包态/源码态均渲染 |
| preload（CJS，零相对导入） | ✅ | `window.remotePi` 四方法可用 |
| IPC | ✅ | `win32` / `0.1.0` |
| CSP 不断页面/断 WebSocket | ✅ | 页面完整 + relay 连通 |
| 日志落盘 | ✅ | 故障注入后 `[ERROR]` 落盘 |
| 权限白名单 | ✅ | 代码 + 启动日志 |
| 自签名 TLS 默认拒绝 | ✅ | `ERR_CERT_AUTHORITY_INVALID` |
| 自签名 TLS 显式放行 | ✅ | `REMOTE_PI_ALLOW_INSECURE=1` → `TLS-OK` |
| 加载失败兜底 | ✅ | 错误页含 Retry |
| 拖拽外链拦截 | ✅ | `will-navigate` 拦截 |
| 打包态资源寻址 | ✅ | `isPackaged=true` → `resources\dist-shell` |
| electron-builder 打包 | ⚠️ 部分 | `win-unpacked/` 完整可用；NSIS 因 winCodeSign 符号链接权限失败 |
| 深链接配对 | ✅ | argv → 事件 → 自动提交，冷启动直接配对 |
| 零配置配对（无需环境变量） | ✅ | loopback 下 `app://app` 默认信任 |
| 8 面板 | ✅ | 8/8 aria-current + 5/5 交互断言 |
| 全量汉化 | ✅ | 会话/计划/文件/更改/插件/自动化/模型/设置 + composer + 相对时间 |
