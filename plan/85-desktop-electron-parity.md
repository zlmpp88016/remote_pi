# Desktop（Electron）端对齐 web/iOS 八面板 —— 实施 TODO

> 状态：待审查（gemini-3-8-flash + muse-spark-1.3）
> 目标：desktop 端与 web/iOS **功能完全对齐**（8 面板：对话/计划/文件/更改/插件/自动化/模型/设置），技术栈按 dsh 形态 = Electron + TypeScript。

---

## 0. 已核实的既有事实（不是推测，都有 file:line）

| 事实 | 证据 |
|---|---|
| **Electron shell 已存在且可用** | `clients/shell/src/main.ts`（382 行），`package.json` 有 `electron ^45.0.0` |
| 已实现自定义协议 `app://app` | `src/main.ts:71-79` `registerSchemesAsPrivileged`；`:351` `protocol.handle` |
| 已实现 SPA 回落 | `src/main.ts:152` 注释「SPA fallback」 |
| 已实现单实例锁 + 窗口位置持久化 | `:341` `requestSingleInstanceLock`；`:186-210` bounds |
| **web 端已支持 shell build** | `clients/web/vite.config.ts:49-61`：`REMOTE_PI_SHELL=1` → `outDir: dist-shell`，`base` 两种模式都是 `/` |
| **无 preload** | `src/main.ts:266-268` 明写「No preload is installed because the app needs no native calls yet」 |
| **无 IPC** | `grep -c ipcMain src/main.ts` = 0 |
| **无打包配置** | 无 `electron-builder.config.mjs`；`package.json` 无 electron-builder 依赖 |
| 已有验收脚本 | `scripts/verify-shell.mjs`（3 条：三路由能挂载 / `app://` 能开 WS 并配对 / 会话列表能填充） |
| desktop 目录是 **Flutter cockpit**（本地工作区管理器） | `clients/desktop/` 840 个 dart 文件，`lib/main.dart` 引 `shadcn_flutter` |

**关键结论**：shell 加载的是 **web 端的 React UI**（`clients/web/dist-shell`），不是另写一套 UI。因此「8 面板对齐」不是重写 8 个面板，而是**让 web 的 8 个面板在 Electron 里达到与浏览器端同等的可用性**。

dsh 的形态（`deepseek-harness/apps/desktop`）也是同一模式：Electron 壳 + 外部 web app bundle，业务 UI 不在壳里。

---

## 1. 范围界定（必须先对齐，否则会做错）

### 1.1 要做
- Electron 壳具备**桌面应用应有的原生能力**（当前「no native calls」是缺口）
- 应用可**打包分发**（当前只能 `electron .` 跑源码）
- web 的 8 个面板在 Electron 里**功能不减**（不因 `app://` origin、权限、跨源、文件对话框缺失而退化）

### 1.2 不做
- 不重写 web 的 8 个面板 UI
- 不动 `clients/desktop/`（Flutter cockpit，另一个产品）
- 不改协议（server / web / mobile 已定的线级契约）

### 1.3 需要审查方裁决的四个问题
1. `clients/shell` 与 `clients/desktop` 命名/职责冲突？是否应改名为 `clients/desktop-electron`？
2. dsh 是 **Main + Host 子进程 + Renderer** 三进程。remote_pi 的 shell 目前是 **Main + Renderer** 两进程（业务逻辑在远端 daemon）。是否**需要**引入 Host 子进程？还是「不需要」才对？
3. 8 面板里哪些**必须**有原生能力才能在桌面端可用？
4. 是否需要自动更新（dsh 有 `electron-updater`）？

---

## 2. 任务分解

### P0 — 基线核查（不改代码，先量出现状）

**T0.1 建立桌面端基线**
- 跑通 `clients/shell`：`npm run export:web` → `npm run build` → `npm run start:cdp`
- 用现有 `scripts/verify-shell.mjs` 跑一遍，记录实际结果
- 逐面板确认：8 个 dock 面板在 Electron 里能打开、能发请求、能渲染数据
- **产出**：8 面板可用性矩阵（可用 / 部分可用 / 不可用 + 原因）
- **验收**：矩阵每项有截图或 CDP 证据，不含「应该可以」

**T0.2 找出 web 端对桌面环境的隐式依赖**
> ⚠️ 审查已提前抓出 4 处，T0.2 必须逐条实测（不是读代码推测）：
>
> 1. **同源免密配对在 `app://` 下彻底失效**
>    `clients/web/src/lib/remote-pi/bootstrap-client.ts:53` 用
>    `credentials: "same-origin"` 请求 `/api/bootstrap`。在 Electron 下变成
>    `app://app/api/bootstrap` → 命中 SPA 回退返回 `index.html`（`main.ts:161`）→
>    JSON 解析失败 → 静默返回 `null`。**用户看到的是「配对码永远不出来」。**
> 2. **`location.origin` 直接转 ws 会得到非法目标**
>    `clients/web/src/client/connect-client.tsx:1624`：
>    `location.origin.replace(/^http/, "ws")`。在 `app://app` 下正则不匹配，
>    返回的 relay 仍是字面量 `"app://app"` → WebSocket 构造抛错。
> 3. **SSE 同源优化在桌面端永不命中**
>    `clients/web/src/lib/remote-pi/adapter.ts:410-413` 比较
>    `origin !== pageOrigin`，`pageOrigin` 永远是 `app://app` → 永远走 WebSocket 回退。
>    （不算 bug，但必须知道：桌面端不会用 SSE。）
> 4. **剪贴板/通知需主进程权限白名单**
>    `clients/web/src/components/remote-pi/chat/markdown.tsx:41`、
>    `message-footer.tsx:39` 用剪贴板。Chromium 在非标准 origin 下可能静默拒绝。
>
> 除以上四条，继续搜：`window.open`、`localStorage` 配额、下载、`matchMedia`。
- 对照 `clients/shell/src/main.ts:275-290`（新窗口被拦截）确认哪些会静默失效
- **产出**：清单「web 调用 → Electron 下实际行为 → 是否需原生替代」
- **验收**：每条有 file:line 与实测结论

**T0.3 把 8 面板基线改成自动化（不要手工）**
> ⚠️ 初稿把「逐面板手工确认」放在了 P0，自动化推到了 P5。**顺序是倒的**：
> `scripts/verify-shell.mjs:74-172` 已经有成熟的 CDP 驱动范式
> （连 `--remote-debugging-port`、执行 JS、点按钮、截图）。8 个 tab 在
> `right-rail.tsx:58` 都有确定的 tab id（`files`/`plan`/`changes`/`plugins`/
> `automations`/`models`/`settings`）和 DOM 容器。
> 手工走查一次 3–4.5 人时，三轮回归 8–12 人时，而且执行 agent 极易「脑补已测」。
- 扩展 `verify-shell.mjs`：自动遍历 8 个 tab，断言首屏容器挂载且无
  `vite-error-overlay`，截 8 张基线图到 `scripts/_e2e-evidence/baseline/`
- **验收**：一条命令产出 8 面板渲染矩阵，耗时 < 45 秒

---

### P1 — Preload + IPC 基础设施

**T1.1 设计并实现 preload**
- 新建 `clients/shell/src/preload.ts`
- 通过 `contextBridge.exposeInMainWorld` 暴露**最小** API 面
- 通道常量集中在 `src/ipc.ts`（照 dsh `DESKTOP_IPC` 模式，参考 `deepseek-harness/apps/desktop/src/ipc.ts:8-34`）
- 严格 TS 契约：渲染端可见类型放一个 `.d.ts`
- 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 不变
- **验收**：preload 编译产出 `.cjs`；渲染端 `window.remotePi` 存在且只有声明的成员；无 `require` 泄漏

**T1.2 实现所需 IPC 处理器**

> ⚠️ **架构纠错（审查发现）**：初稿在这里写了 `pickDirectory`（本地目录选择器）用于
> 文件面板的「加为工作区」。**这是错的，会导致严重返工。**
> `fs_nav.ts` 跑在 **server/daemon 侧**（`server/src/daemon/fs_nav.ts:2` 用
> `node:os.homedir()`），所以 `fs_list` / `workspace_add` 操作的是 **远端 daemon 机器的
> 文件系统**。把本地 Windows 路径传给远端 Linux daemon 会直接失败。
> 文件面板与附件上传**不需要**任何本地原生目录选择器。

按 P0.2 结论实现，实际需要的是：
- `openExternal` — 外链用系统浏览器打开（当前新窗口被拦截且无替代）
- `getPlatform` / `getVersion` — 渲染端做平台差异与版本显示
- `openUserDataLog` — 打开日志目录（配合 T3.5 日志落盘，排查白屏的唯一手段）
- `pickFiles` — **仅当** P0.2 证实 `<input type=file>` 在 `app://` 下不可用时才做；
  默认它可用（Chromium 原生支持），不做就是对的
- **验收**：每个 handler 校验 sender origin（照 dsh `assertDesktopSender`）；未声明通道拒绝

**T1.3 类型共享**
- `src/ipc.ts` 的契约类型要被 web 端引用（或复制并加同步注释）
- **验收**：改一处类型，两端编译都能发现不匹配

---

### P2 — 桌面专用 UI 适配

**T2.1 窗口 chrome**
- 当前 `titleBarStyle: hiddenInset`（mac）/ `default`（win）
- web 自带 title strip，需确认：Windows 下原生标题栏 + web strip 是否重复
- **验收**：三平台（或至少 mac + win）窗口顶部无重叠、无双重标题

**T2.2 拖拽区域**
- 自定义标题栏需 `-webkit-app-region: drag`，否则窗口无法拖动
- 检查 web title strip 是否已处理；若无则作为 shell 注入的 CSS
- **验收**：能拖动窗口，且按钮区域不参与拖拽

**T2.3 菜单与快捷键**
- 当前 `Menu` 已 import（`src/main.ts:33`），确认是否只做最小菜单
- 应有快捷键：`⌘/Ctrl+J` 切 dock（web 已有）、`⌘/Ctrl+,` 设置、`⌘/Ctrl+R` 重载、devtools
- **验收**：快捷键在 Electron 里生效，且与 web 内部快捷键不冲突

**T2.4 深链接**
- `remotepi://pair?...` 配对链接：浏览器里粘贴可用；桌面端应直接点开
- 需 `app.setAsDefaultProtocolClient` + `open-url` / `second-instance` 处理
- **为什么这里比看起来重要**：T0.2 已证实同源免密配对在 `app://` 下失效，
  所以**深链接就成了桌面端配对的主路径**，不是锦上添花。
- **验收**：OS 里点 `remotepi://` 链接能唤起已运行实例并把 URI 传给页面

**T2.5 生产环境 DevTools 管控（审查补充）**
- `main.ts:325` 当前**无条件**在 View 菜单挂 `toggleDevTools`
- 改成 `!app.isPackaged || process.env.REMOTE_PI_DEBUG`
- **验收**：打包后菜单里无 DevTools，F12 / `Ctrl+Shift+I` 无效；开发态仍可用

**T2.6 加载失败与渲染进程崩溃兜底（审查补充）**
- `main.ts:302` 裸调 `await window.loadURL(target)`，未监听任何失败
- 补：`did-fail-load`、`render-process-gone`
- 失败时显示友好页 + 「重载」/「清缓存重试」按钮，而不是 Chromium 默认错误页
- **验收**：把 `dist-shell` 改名模拟资源缺失 → 看到自定义错误页，不是白屏

**T2.7 阻止拖拽外链导致跳转（审查补充）**
- `main.ts:287-291` 拦了点击导航，但**没拦拖拽**
- 用户把 URL/文件拖进窗口会整个渲染进程跳走，脱离 `app://` 上下文
- 补 `will-navigate` + `webContents.on("will-frame-navigate")`
- **验收**：拖一个外链进窗口，页面不跳转

---

### P2b — 安全与权限（审查补充，缺了会静默失效）

**T2b.1 CSP 响应头注入**
- `main.ts:144,167` 静态响应只有 `content-type`，**无 CSP**
- 天然陷阱：若机械地补一个默认 CSP（`default-src 'self'`），会**直接断掉**
  WebSocket relay 与外链模型 API
- 必须显式：`connect-src 'self' app://app ws: wss: http: https:`
- **验收**：页面能连 relay（ws + wss 各测一次）、能请求模型 API，控制台无 CSP 违规

**T2b.2 权限请求白名单**
- 补 `session.setPermissionRequestHandler`
- 放行：`clipboard-sanitized-write`、`clipboard-read`、`notifications`
- 拒绝：`media`、`geolocation` 等无关项
- **验收**：复制 Markdown 消息与代码块不报错（对应 T0.2 第 4 条）

**T2b.3 自签名 / 内网 TLS 容错**
- Electron 默认**静默拒绝**未受信 TLS 握手，**且没有浏览器那种「继续访问」按钮**
- 用户连私有 IP / 自建节点的 wss 会直接断，且看不到任何提示
- 补 `app.on("certificate-error")`（默认仍拒绝，但给可见错误 + 手动放行入口）
- **验收**：连自签名节点时报可读错误，而不是静默超时

---

### P3 — 打包与分发

**T3.1 electron-builder 配置**
- 新建 `clients/shell/electron-builder.config.mjs`
- 目标：Windows NSIS + macOS DMG（Linux 待裁决）
- `asar` 打包，`dist-shell` 作为 extraResources
- **验收**：`npm run dist` 产出可安装包；装完能启动、能配对

**T3.2 修复打包后资源寻址（R5，**最高优先级，不修则安装包必白屏**）**
- `main.ts:56-57` 当前：
  `resolve(fileURLToPath(new URL("../../web/dist-shell/", import.meta.url)))`
- 打包后主进程在 `resources/app.asar/dist/main.js`，`../../` 会逃逸到 asar 外，
  而用户机器上根本没有源码仓库结构 → **所有请求 404 → 白屏**
- 改成：`app.isPackaged ? join(process.resourcesPath, "dist-shell") : <相对路径>`
- 并把 `clients/web/dist-shell` 纳入 `extraResources`
- ⚠️ **这个 bug 最危险的地方：`npm run dist` 会 exit 0，构建看起来完全成功。**
  必须用「装完启动」验收，不是用「构建成功」验收
- **验收**：安装包启动后能加载资源、能配对；`scripts/_e2e-evidence/` 有安装后截图

**T3.3 构建顺序**
- `export:web`（vite build → dist-shell）必须早于 electron-builder
- 现有 `export:web` 指向 `../web/scripts/build-shell-web.mjs` — 需确认该脚本已改为调 `vite build`
- **验收**：一条命令从零到安装包，无需手工步骤

**T3.4 应用图标与元数据**
- `appId`、`productName`、图标（win `.ico` / mac `.icns`）
- **验收**：安装后显示正确名称与图标，不是 Electron 默认

**T3.5 日志落盘（审查补充，排查白屏的唯一手段）**
- GUI 安装包**没有终端 stdout**。`main.ts:147,169` 的 404 与错误全部被静默吞掉
- 写 `app.getPath("userData")/logs/shell.log`：协议 404、`uncaughtException`、
  窗口生命周期、加载失败
- 配合 T1.2 的 `openUserDataLog` 让用户能一键打开
- **验收**：故意改坏一个资源路径，`shell.log` 里能看到具体哪个 404

**T3.6 自动更新（可选，需裁决）**
- dsh 用 `electron-updater`。remote_pi 首版是否需要？
- 若不做，必须在 UI 里明说「需手动更新」，不能静默
- **验收**：若不做，有明确版本提示；若做，有端到端更新验证

---

### P4 — 八面板逐项核对（核心交付）

> 对每面板：确认在 Electron 下**功能与浏览器版一致**。方法不是读代码，是**在 Electron 里实际操作**。
> ⚠️ **必须在安装后的包里测，不是在源码跑起来的环境里测**。R5 的整个陷阱就是
> 「源码正常、安装包白屏」—— 只在源码环境验的 P4 等于没验。

**T4.1 对话面板** — 发消息、流式、Stop、重试、附件上传（`<input type=file>`，非原生 picker）、slash 菜单、模型选择器、思考级别、复制消息（验证 T2b.2 剪贴板）
**T4.2 计划面板** — 列目录、搜索、打开文档、Markdown 渲染、返回
**T4.3 文件面板** — 列目录、显示隐藏、上钻/下钻、加为工作区、启动 Pi、移除
  > ⚠️ 这里的路径是**远端 daemon** 的（`fs_nav.ts` 在 server 侧、用 `os.homedir()`）。
  > 测的时候要在远端机器上验证文件真的被创建/启动，不是只看 UI 变了
**T4.4 更改面板** — git status、四类计数、分支/HEAD、刷新、非仓库/缺 git/超时三种失败态
**T4.5 插件面板** — 列包/技能、安装（含第三方确认）、启用/禁用、更新、移除、详情
**T4.6 自动化面板** — 列表、创建（9 字段）、详情、立即运行、启用/禁用、删除
**T4.7 模型面板** — provider 切换、baseUrl、api 风格、密钥三态、模型增删改、保存 diff
**T4.8 设置面板** — 外观/强调色（本地）、6 个主机字段、保存

**T4.9 配对与重启持久性（审查补充，桌面端特有）**
- `remotepi://` 深链接配对（T2.4）
- **关掉应用重开，配对还在吗？**（对应 R2）
- 这是桌面端与浏览器端**最大行为差异**的地方，必须单独验
- **验收**：配对 → 完全退出 → 重开 → 无需重新配对即可用

- **每项验收**：在 Electron 里完成该面板一个完整用户动作，结果与浏览器版一致（同一 daemon、同一时刻对照）
- **产出**：`clients/shell/DESKTOP-PARITY.md`，8 节，每节含「动作 / 浏览器结果 / Electron 结果 / 差异」

---

### P5 — 验收自动化

**T5.1 扩展 verify-shell.mjs**
- 现有只查 3 件事，需扩到 8 面板
- 每面板一条断言：能打开、能触发一次真实请求、能渲染至少一行数据
- **验收**：`npm run verify` 在 Electron + 真实 daemon 下全绿

**T5.2 三端一致性断言**
- 同一 daemon、同一工作区，web（浏览器）与 Electron 的**控件集合**应一致
- 复用 mobile 那次的方法：导出两边可交互控件列表并 diff
- **验收**：diff 为空，或每条差异有书面理由

**T5.3 CI 可跑**
- 打包 + 冒烟在无显示环境（xvfb / Windows runner）能跑
- **验收**：CI 配置能产出安装包并跑通冒烟

---

## 3. 风险表（审查后已定级）

### 3.1 阻断级 —— 不处理则功能不可用

| # | 风险 | 证据 | 处理 |
|---|---|---|---|
| **R5** | **打包后 `WEB_EXPORT_DIR` 必失效** | `main.ts:56-57` 用 `new URL("../../web/dist-shell/", import.meta.url)`；asar 内该路径逃逸 | T3.2 |
| **R7** | **同源免密配对在 `app://` 下归零** | `bootstrap-client.ts:53` `credentials:"same-origin"` 请求 `/api/bootstrap` → 命中 SPA 回退 | T0.2 + T2.4（深链接变主路径） |
| **R8** | **`location.origin` 转 ws 得到非法目标** | `connect-client.tsx:1624` `replace(/^http/,"ws")` 不匹配 `app://` | T0.2 |
| **R9** | **无 CSP 时机械补齐会断 WS/API** | `main.ts:144,167` 无 CSP；默认 `default-src 'self'` 会拦 relay | T2b.1 |
| **R10** | **无日志 → 白屏无法排查** | `main.ts:147,169` 错误被吞；GUI 无 stdout | T3.5 |

### 3.2 高危 —— 会静默失效或误导用户

| # | 风险 | 说明 |
|---|---|---|
| **R2** | `localStorage` 在 `app://` 下是否持久 | 配对存 localStorage。若 origin 被视为临时，**重启即丢配对**。必须实测，不可假设 |
| **R11** | 剪贴板/通知静默被拒 | 非标准 origin 下 Chromium 权限模型不同，需 T2b.2 白名单 |
| **R12** | 自签名 TLS 静默断连 | Electron 无浏览器那个「继续访问」按钮，用户看不到任何提示 |
| **R13** | 拖拽外链跳转 | `main.ts:287-291` 只拦点击，未拦拖拽 |

### 3.3 判断类 —— 需要人决定

| # | 风险 | 说明 |
|---|---|---|
| **R3** | 两进程 vs 三进程 | dsh 有 Host 子进程承载业务；remote_pi 的「host」是**远程 daemon**。**照搬三进程很可能是错的** —— 本地无业务逻辑可承载 |
| **R4** | `clients/shell` vs `clients/desktop` 命名 | 两个都叫「desktop」，一个是 Electron 壳、一个是 Flutter cockpit。新人必然混淆 |
| **R6** | 8 面板桌面布局 | dock 的 tab 布局是移动端妥协。桌面是否改常驻多栏？属「布局不同」，用户已允许 |
| **R1** | `ws://` relay 与 secure origin | `app://` 已标 secure；若 relay 是 `ws://` 可能被 mixed-content 拦。**需实测，不能推断** |

---

## 4. 交付顺序（审查后修正）

```
P0.1 跑通基线 ─┐
P0.2 环境假设实测 ─┤   ← 这三个必须先做完
P0.3 基线自动化 ─┘
     │
     ├─► P3.2 修 R5（资源寻址）── 独立，可立即做，不依赖 P1
     │
     └─► P1（preload/IPC，已纠错：无 pickDirectory）
          └─► P2 + P2b（chrome / 深链接 / 安全权限）
               └─► P3（打包）
                    └─► P4（8 面板核对）
                         └─► P5（自动化深化）
```

**三条硬约束**：
1. **P0.2 不做完不要动 P1**。不知道 web 在 `app://` 下哪几处假设失效，就会按想象补原生能力 —— 初稿的 `pickDirectory` 就是这个错误的产物。
2. **P3.2（R5）可以并行提前做**，它不依赖任何其他任务，且是唯一「构建成功但有包白屏」的陷阱。
3. **P4 的验收必须是「装完的包」**，不是「源码跑起来」。

---

## 5. 执行 agent 最容易做错的三件事（给分发用的警告）

| 排名 | 错误 | 为什么会发生 | 预防 |
|---|---|---|---|
| 🔴 1 | **给文件面板接本地 `pickDirectory`** | 看起来「目录选择器」就该用原生对话框 | 任务描述里明写：路径是**远端 daemon** 的，不是本地的 |
| 🔴 2 | **R5 路径改完不验证安装包** | `npm run dist` exit 0，看起来成功 | 验收标准必须是「装完启动能加载」，不是「构建成功」 |
| 🟡 3 | **CSP 补成 `default-src 'self'`** | 这是最「标准」的写法 | 必须显式 `connect-src ws: wss: http: https:` |

---

## 6. 成功判据（一句话）

在**安装后的包里**，把 web 端能做的每一个用户动作都做一遍，结果与浏览器端一致；并且重启应用后配对不丢。
