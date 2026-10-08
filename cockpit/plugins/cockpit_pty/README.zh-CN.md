# cockpit_pty

[![ci](https://github.com/cesarmod2017/cockpit_pty/actions/workflows/ci.yml/badge.svg)](https://github.com/cesarmod2017/cockpit_pty/actions/workflows/ci.yml)
[![pub points](https://badges.bar/cockpit_pty/pub%20points)](https://pub.dev/packages/cockpit_pty)

给 Flutter 用的 PTY。把子进程挂到一个**伪终端**（PTY）上跑，它就和在真终端里一样：行编辑、ANSI 颜色、光标控制、作业控制、调整大小，全都能用。

它在原生代码里实现 PTY（而不是纯 FFI + 阻塞 isolate），所以比老的 [`pty`](https://pub.dev/packages/pty) 包更稳。和 [`xterm`](https://pub.dev/packages/xterm) 天然搭配，可以在应用里渲染出完整的交互式终端组件。

## 支持平台

| Linux | macOS | Windows | Android |
| :---: | :---: | :-----: | :-----: |
|   ✔️   |   ✔️   |    ✔️    |    ✔️    |

> Windows 上的 PTY 由 ConPTY 实现，因此需要 Windows 10（1809）或更高版本。
>
> **Web：** 浏览器无法启动进程，所以 Web 上没有*原生* PTY。替代做法是连到另一台机器上跑的 PTY，走远程传输 —— example 里已经带了一个开箱可用的 WebSocket 传输 + 服务端（见[可插拔后端](#可插拔后端本机-pty-vs-远程流)）。

## 安装

```yaml
dependencies:
  cockpit_pty: ^0.4.2
```

```sh
flutter pub add cockpit_pty
```

不需要额外的平台配置 —— 原生库会作为 FFI 插件自动编译并打包进去。

## 快速开始

```dart
import 'dart:convert';
import 'package:cockpit_pty/cockpit_pty.dart';

// 在伪终端里起一个 shell。
final pty = Pty.start(
  Platform.isWindows ? 'cmd.exe' : 'bash',
  columns: 80,
  rows: 25,
);

// 读进程打印的所有内容（stdout 和 stderr 共用一个流）。
pty.output
    .cast<List<int>>()
    .transform(const Utf8Decoder())
    .listen((text) => print(text));

// 发送输入，和在提示符下打字完全一样。别忘了换行。
pty.write(const Utf8Encoder().convert('ls -al\n'));

// 进程结束时做点反应。
pty.exitCode.then((code) => print('exited with $code'));

// 视口大小变了就告诉 PTY（行数、列数）。
pty.resize(30, 100);

// 结束它。
pty.kill();
```

## 配置

所有配置都通过 `Pty.start` 完成：

```dart
final pty = Pty.start(
  'bash',                          // 要跑的可执行文件（位置参数）
  arguments: ['-l'],               // 进程参数
  workingDirectory: '/home/me',    // 子进程的 cwd（null = 继承）
  environment: {                   // 额外环境变量（会合并，见下方说明）
    'FOO': 'bar',
  },
  rows: 25,                        // 终端初始高度
  columns: 80,                     // 终端初始宽度
  ackRead: false,                  // 流控，见「背压」一节
);
```

### 环境变量

`cockpit_pty` 总是会设 `TERM=xterm-256color` 和 `LANG=en_US.UTF-8`（这样 `vi` 之类的工具会输出对 UTF-8 友好的序列），并从父进程复制一小批变量：`LOGNAME`、`USER`、`DISPLAY`、`LC_TYPE`、`HOME`、`PATH`。你在 `environment` 里传的东西会叠加在上面。

如果你想让子进程看到**完整的**父进程环境（真终端里建议这么做 —— Windows 上那个最小子集会漏掉 `Path`、`SystemRoot`、`APPDATA` 等，导致解析不到外部命令），就显式传进去：

```dart
final pty = Pty.start(
  shell,
  environment: Map<String, String>.from(Platform.environment),
);
```

### 按平台选 shell

```dart
String get defaultShell {
  if (Platform.isWindows) {
    return Platform.environment['COMSPEC'] ?? 'cmd.exe';
  }
  return Platform.environment['SHELL'] ?? 'bash';
}
```

## API 参考

| 成员 | 说明 |
| --- | --- |
| `Pty.start(executable, {...})` | 在新的伪终端里启动 `executable`。 |
| `Stream<Uint8List> output` | 进程的 stdout / stderr 合并字节流。 |
| `Future<int> exitCode` | 进程结束时以退出码完成。 |
| `int pid` | 子进程的进程 id。 |
| `void write(Uint8List data)` | 往 PTY 写字节（也就是子进程的 stdin）。 |
| `void resize(int rows, int cols)` | 告知 PTY 新的视口尺寸。 |
| `bool kill([ProcessSignal signal])` | 给进程发信号（默认 `SIGTERM`）。 |
| `void ackRead()` | `ackRead: true` 时确认收到一块（见下文）。 |

> PTY **不**区分 stdout 和 stderr —— 两者都从 `output` 出来。

### 退出码

Linux / macOS 上正常退出是 `0..255`；被信号杀掉的进程报告负的信号编号（比如 `SIGSEGV` 是 `-11`）。Windows 上任何 32 位值都可能出现，以有符号整数返回（比如访问违例 `0xc0000005` 会返回为 `-1073741819`）。`exitCode` 完成时不保证 `output` 已经读干净 —— 要拿到最后一个字节就等流的 `done` 事件。

## 配合 `xterm` 使用（完整终端组件）

这是最常见的用法：在 Flutter 里渲染一个交互式终端。把 `Pty` 和 xterm 的 `Terminal` 双向接起来。

```dart
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:cockpit_pty/cockpit_pty.dart';
import 'package:xterm/xterm.dart';

class TerminalWidget extends StatefulWidget {
  const TerminalWidget({super.key});
  @override
  State<TerminalWidget> createState() => _TerminalWidgetState();
}

class _TerminalWidgetState extends State<TerminalWidget> {
  final terminal = Terminal(maxLines: 10000);
  late final Pty pty;

  @override
  void initState() {
    super.initState();

    pty = Pty.start(
      Platform.isWindows ? 'cmd.exe' : 'bash',
      columns: terminal.viewWidth,
      rows: terminal.viewHeight,
      environment: Map<String, String>.from(Platform.environment),
    );

    // PTY 输出 → 终端模拟器（ANSI / VT 解析由它负责）。
    pty.output
        .cast<List<int>>()
        .transform(const Utf8Decoder())
        .listen(terminal.write);

    pty.exitCode.then((code) {
      terminal.write('\r\n[process exited: $code]\r\n');
    });

    // 组件的键盘输入 / 粘贴 → PTY stdin。
    terminal.onOutput = (data) {
      pty.write(const Utf8Encoder().convert(data));
    };

    // 视口以字符格为单位上报尺寸 → 转给 PTY。
    terminal.onResize = (w, h, pw, ph) => pty.resize(h, w);
  }

  @override
  void dispose() {
    pty.kill();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TerminalView(terminal);
}
```

这个例子的可运行版本 —— 带标签页、多会话、滚动到底部、OSC 标题处理、主题样式、命令栏和可插拔后端 —— 在 [`example/`](example/) 里。

## 键盘与输入规则

输入流向是**终端 → `onOutput` → `pty.write`**。有几点决定了它用起来是否顺手：

| 按键 / 操作 | 行为 |
| --- | --- |
| 打字 | 原样送进 PTY 的 stdin。 |
| **Enter** | 发 `\r`（回车）—— 这是行规程期望的东西，*不是* `\n`。 |
| **Ctrl+C** | 有选中内容 → 复制。没有选中 → 原样传递为 `SIGINT`。 |
| **Ctrl+Shift+C / Ctrl+Shift+V** | 复制 / 粘贴（xterm 默认）。 |
| 鼠标选中 | 选中文本；右键 / 快捷键复制。 |
| 调整大小 | `onResize(w, h, …)` → `pty.resize(h, w)`（注意是**行、列**的顺序）。 |

### 桌面端与移动端键盘

xterm 的 `TerminalView` 有两种收键盘输入的方式，选哪种取决于平台：

```dart
TerminalView(
  terminal,
  // 桌面端（Windows/macOS/Linux）：直接从硬件按键事件读字符
  // （event.character）。打字可靠，不弹软键盘。
  hardwareKeyboardOnly: true,
)
```

* **桌面端** → `hardwareKeyboardOnly: true`。自定义客户端走平台的 IME / 文本输入通道容易出问题，从硬件按键事件读 `event.character` 更稳。（如果只有 `Enter` 有效、字母输不进去，照此设置即可。）
* **移动端（Android/iOS）** → 保持 `false`（默认值），这样**软键盘 / IME** 才会正常弹出并工作。

```dart
final bool isMobile = Platform.isAndroid || Platform.isIOS;
TerminalView(terminal, hardwareKeyboardOnly: !isMobile);
```

### 以编程方式发送整条命令

除了实时打字，你还常常想推一整条命令（「输入这个并执行」按钮，或者来自别处的输入）。只要把这一行加上 Enter 写进去：

```dart
void sendCommand(Pty pty, String command) {
  pty.write(const Utf8Encoder().convert('$command\r'));
}

sendCommand(pty, 'git status');
```

example 把它包成了 `PtySession.sendCommand` / `sendText`，并在每个终端底部放了一个命令栏。

## 可插拔后端：本机 PTY vs. 远程流

一个终端不过是两条字节流（出 / 入）加一个调整大小信号。xterm 的 `Terminal` 不关心这些字节**从哪来**。于是同*一套* UI 可以跑在两种完全不同的场景里：

* **本机** —— shell 跑在*这台*机器上，字节来自 `cockpit_pty`。
* **远程** —— shell 跑在*另一台*机器上（比如你在用手机看）。字节从网络过来（例如 gRPC 流），你的按键发回给主机，由主机执行。中间的中继是你自己的（example 作者在服务端用的是 gRPC + Redis）。

example 用一个小接口对这层建模，两边组件代码完全一样：

```dart
abstract class TerminalBackend {
  Stream<String> get output;          // 来自进程的字节（已按 UTF-8 解码）
  void write(String data);            // 发往进程的输入
  void resize(int rows, int cols);    // 视口尺寸变了
  Future<void> get done;              // 进程 / 流结束
  int? get pid;
  int? get exitCode;
  ValueListenable<bool> get inputEnabled; // false = 只读（没拿到控制权租约）
  void dispose();
}
```

### 本机后端（这台机器）

`LocalPtyBackend` 只是把 `Pty` 包了一层。注意这里是**流式** UTF-8 解码 —— 一个多字节字符（框线字符 `─ │ ┌`、重音字母）可能被切成两块输出，所以要用流式转换器解码，绝不能逐块 `utf8.decode`：

```dart
_pty.output
    .cast<List<int>>()
    .transform(const Utf8Decoder(allowMalformed: true)) // buffers partials
    .listen(_output.add);

@override
void write(String data) => _pty.write(const Utf8Encoder().convert(data));

@override
void resize(int rows, int cols) => _pty.resize(rows, cols);
```

### 远程后端（另一台机器 / 移动端）

移动端上你**不会**在手机上起 PTY —— 没有东西可起。你要做的是实现一个和主机对话的传输层，把它的帧喂给同一个 `Terminal`。example 提供了 `RemotePtyBackend` + 一个 `RemotePtyTransport` 接口（没有绑定任何 gRPC 依赖），由你针对自己的 RPC 层实现：

```dart
abstract class RemotePtyTransport {
  Stream<RemotePtyFrame> streamPty();                 // 服务端 → 客户端输出
  Future<String?> acquireControl({bool force});       // 输入租约（token）
  Future<void> releaseControl(String token);
  Future<void> sendInput(String token, List<int> data);
  Future<void> resize(String token, {required int cols, required int rows});
}
```

在此之上实现的 `RemotePtyBackend` 会处理那些「想当然的接法」容易搞错的地方：

* **快照 / 重放** —— 每次（重新）连接时，服务端把缓冲的屏幕内容以 `isSnapshot: true` 发来；写之前先重置模拟器（`\x1b[2J\x1b[3J\x1b[H`），这样反复重连不会累积叠加；
* **序号去重** —— 忽略 `seq` 已经见过的帧；
* **流式 UTF-8** —— 用*有状态*的分块转换器解码，跨帧被切开的字符才不会变成 ``；
* **控制租约** —— `acquireControl()` 成功前输入是禁用的；把 `TerminalView.readOnly` 绑到 `inputEnabled` 上，并且记住服务端那边的租约是有 TTL 的（每次输入 / 调整大小都会续期）—— 纯查看者始终保持只读。

```dart
// 示意：基于你自己的 gRPC 客户端实现 RemotePtyTransport。
class GrpcPtyTransport implements RemotePtyTransport {
  GrpcPtyTransport(this._client, this.taskId, this.workspaceId);
  // ...
  @override
  Stream<RemotePtyFrame> streamPty() => _client
      .streamPty(StreamPtyRequest(taskId: taskId, workspaceId: workspaceId))
      .map((f) => RemotePtyFrame(
            data: f.data,
            seq: f.seq.toInt(),
            isSnapshot: f.isSnapshot,
            closed: f.closed,
            controlHolderUserId: f.controlHolderUserId,
          ));

  @override
  Future<void> sendInput(String token, List<int> data) =>
      _client.sendPtyInput(PtyInputRequest(
        taskId: taskId, workspaceId: workspaceId, controlToken: token, data: data,
      ));
  // acquireControl / releaseControl / resize 按同样方式映射。
}
```

之后建会话的方式和本机一样，只是后端不同：

```dart
// 本机（桌面端）
PtySession.local(id: 1);

// 远程（移动端 / 另一台机器）
PtySession.remote(
  id: 2,
  backendBuilder: (cols, rows) =>
      RemotePtyBackend(GrpcPtyTransport(client, taskId, workspaceId)),
);
```

完整带注释的实现见 `example/lib/terminal_backend.dart`、`example/lib/remote_pty_backend.dart` 和 `example/lib/pty_session.dart`。

### 你的后端（服务端）必须提供什么

Flutter 应用只是*查看端 / 控制端*。要让远程模式成立，**得由你的后端真正持有 PTY 并把它转发出来**。本包不提供这部分 —— 下面是它必须满足的约定。（传输层可以是任何东西：gRPC、WebSocket、SignalR…… 参考实现用 gRPC 做边缘 + Redis 发布订阅做跨实例扇出。）

#### 数据流

```
   ┌─────────── host machine (agent) ───────────┐        ┌──── server/relay ────┐        ┌── client(s) ──┐
   │  real PTY  (cockpit_pty / node-pty / …)     │        │  pub/sub + buffer     │        │  Flutter app   │
   │                                             │        │  (e.g. Redis)         │        │  (xterm)       │
   │  stdout/stderr ──────────────────────────────────▶  fan-out  ───────────────────────▶  StreamPty      │
   │  stdin        ◀──────────────────────────────────  publish  ◀───────────────────────  SendPtyInput    │
   │  resize       ◀──────────────────────────────────  publish  ◀───────────────────────  ResizePty       │
   └─────────────────────────────────────────────┘        └──────────────────────┘        └────────────────┘
```

#### 后端**必须**做到：

1. **在主机上持有真正的 PTY。** 在*目标机器*的伪终端里启动 shell / 进程（`cockpit_pty` 本身可以跑在这里，或者 node-pty 之类）。手机端永远不起任何东西。
2. **实时流式输出。** 提供一个**服务端流**端点（`StreamPty`），把每一块 PTY 输出在产生时就推给所有订阅的客户端。输出字节是原始的 —— **不要**重新编码，让客户端用流式模式解码 UTF-8。
3. **（重新）连接时发快照。** 维护一个近期输出的滚动缓冲（有上限，比如最近 N KB），并在每个新流的**第一帧**用 `is_snapshot = true` 发出去。这样晚连进来的手机、或者掉线后重连的手机，能立刻看到当前屏幕而不是一片空白。
4. **给帧打序号。** 每个 PTY 一个单调递增的 `seq`，让客户端能丢掉重复帧、发现缺口（发布订阅重投递时很重要）。
5. **接受输入**（`SendPtyInput`）：从客户端拿字节，写到**主机上** PTY 的 stdin。按键、粘贴、整条命令都从这里进来。
6. **接受调整大小**（`ResizePty`）：把 `cols` / `rows` 应用到主机 PTY，让远端的程序能正确地重排版面。
7. **保证只有一个写入者（控制租约）。** 多个查看者，**一个**输入者：
   * `AcquirePtyControl` → 发一个短命的**控制 token**（TTL，比如 30 秒）。如果已经有人拿着，就拒绝（除非 `force`）。
   * 每次 `SendPtyInput` / `ResizePty` 都必须带上这个 token；**拒绝**过期或缺失的 token。每次接受的输入 / 调整大小都刷新 TTL。
   * `ReleasePtyControl` → 释放租约。没有 token 的客户端就是只读。
8. **通知会话结束。** 主机进程退出时，发一个 `closed = true` 的收尾帧（并停止流），客户端才能显示 "encerrado"（已结束）。
9. **认证与授权。** 校验来者是谁（example 检查 task / workspace 成员关系），并把*输入*挡在权限之后（owner / admin 或显式开关）—— 观看可以比打字更宽。
10. **扇出 + 清理。** 支持每个 PTY 多个并发订阅者，并在断连时取消订阅 / 释放，别泄漏流、也别留下悬空的控制租约。

#### 客户端对每一帧的期望

后端发的每个输出帧对应一个 `RemotePtyFrame`：

| 字段 | 含义 | 客户端行为 |
| --- | --- | --- |
| `data` | 原始 PTY 输出字节 | 解码（流式 UTF-8）→ `terminal.write` |
| `seq` | 单调计数器 | `seq <= lastSeen` 就丢弃 |
| `is_snapshot` | 整块缓冲重放 | 先重置屏幕（`\x1b[2J\x1b[3J\x1b[H`）再写 |
| `closed` | 进程结束 | 把会话标记为已结束 |
| `control_holder_user_id` | 谁持有租约 | 显示只读横幅 |

#### 最低要求 vs. 锦上添花

* **能跑起来的最低要求：** 输出流 + 输入 + 调整大小。
* **体验好所必需：** 快照 / 重放、`seq` 去重、控制租约、`closed` 信号 —— 少了这些就会遇到重连空白、输出重复、几个人抢键盘、以及没有 "session ended"（会话已结束）的提示。

> example 作者对这套东西的实现就是服务端的 gRPC `TerminalStreamService`（`StreamPty` / `SendPtyInput` / `ResizePty` / `AcquirePtyControl` / `ReleasePtyControl`），由 Redis 支撑快照缓冲、输入通道和控制 token 租约。

### WebSocket 传输 —— 开箱即用（自带电池，含 Web）

gRPC 在你本来就跑着它的时候很好用。除此之外 —— 尤其是对 **Web**（浏览器根本无法启动进程）—— example 带了一套开箱可用的 **WebSocket** 传输*和*配套服务端，让你零后端基础设施就能搭起一个远程终端：

* `example/lib/pty_websocket_server.dart` —— `PtyWebSocketServer`：跑在**主机**上（一个用 cockpit_pty 的桌面应用），起一个真 `Pty`，通过 WebSocket 对外服务。只用 `dart:io`（无额外依赖）。
* `example/lib/websocket_pty_transport.dart` —— `WebSocketPtyTransport`：**客户端**（Web / 移动端 / 另一台桌面）。它实现 `RemotePtyTransport`，所以能直接接进 `RemotePtyBackend`，自动获得快照重置、seq 去重、流式 UTF-8 和只读门控。

这正是 `portable_pty` 之类包给 Web 提供的能力；这里它被整合进同一套可插拔后端，所以*完全相同的 UI* 既能渲染本机 PTY，也能渲染远程 PTY。

#### 线协议

一个会话一条 WebSocket。输出走二进制帧（热路径上不做 base64）；控制信息是人可读的 JSON。

| 方向 | 帧 | 含义 |
| --- | --- | --- |
| host → client | **二进制** | 原始 PTY 输出 |
| host → client | `{"type":"snapshot","dataB64":"…"}` | 缓冲的屏幕内容，连接时发一次 |
| host → client | `{"type":"exit","code":0}` | 进程结束 |
| client → host | **二进制** | 原始 stdin（打字 / 粘贴 / 命令） |
| client → host | `{"type":"resize","cols":80,"rows":24}` | 视口调整大小 |

#### 主机端（跑 shell 的那台机器）

```dart
import 'package:cockpit_pty_example/pty_websocket_server.dart';

final server = PtyWebSocketServer(
  // shell: 'bash',                 // 默认用平台 shell
  // arguments: ['/k', 'claude'],   // 比如连上就启动 Claude（Windows）
  address: InternetAddress.anyIPv4, // 省略则只监听本机
  port: 8080,
);
await server.start();   // 开始在 ws://<host>:8080/ 上服务
// ...
await server.stop();    // 杀掉 PTY，关闭所有客户端
```

#### 客户端（Web / 移动端 / 另一台桌面）

```dart
import 'package:cockpit_pty_example/pty_session.dart';
import 'package:cockpit_pty_example/remote_pty_backend.dart';
import 'package:cockpit_pty_example/websocket_pty_transport.dart';

final session = PtySession.remote(
  id: 1,
  label: 'remote',
  backendBuilder: (cols, rows) =>
      RemotePtyBackend(WebSocketPtyTransport('ws://192.168.0.10:8080')),
);
// 把 session.terminal 放进 TerminalView —— 打字、输出、调整大小和命令栏
// 全都和本机情况一模一样。
```

> ⚠️ `PtyWebSocketServer` 是刻意做得极简的：**一个共享会话，没有认证，任何客户端都能打字。** 用在局域网 / 演示上很合适。要在公网用，你得加 TLS（`wss://`）、认证和单写入者控制租约 —— 那才是上面那套 gRPC + Redis 后端发挥价值的地方。客户端（`RemotePtyBackend`）两种情况都一样。
>
> 在 **Web** 上只有客户端那一半能跑（浏览器绑不了服务端）；在真实机器上跑一个 `PtyWebSocketServer`，让浏览器连过去。

#### 端到端跑 Web 演示

example 带了三个可运行的入口：

| 入口 | 是什么 | 跑在哪 |
| --- | --- | --- |
| `lib/main.dart` | 完整的**本机**终端（标签页、命令栏、Claude 按钮） | 桌面端 |
| `lib/main_host.dart` | 一个**主机**：起 `PtyWebSocketServer`，通过 `ws://…:8080` 提供一个 PTY | 桌面端（你想驱动的那台机器） |
| `lib/main_web.dart` | **Web 客户端**：连到主机，在浏览器里渲染终端 | Web（以及移动端 / 桌面端） |

**前置条件**（`example/` 里已经配好）：

```sh
cd example

# 1. Web 平台支持（生成 web/）。一次性。
flutter create --platforms=web .

# 2. 依赖：web_socket_channel（跨平台 WS，含 Web）已在 pubspec 里。
flutter pub get
```

> 终端字体（`CascadiaMono`）是作为 asset 打包的，这样**在 Web 上**也能渲染出清晰等宽的字体 —— Flutter 的 Web canvas 不使用系统安装的字体，所以不打包字体的话，终端会退化成把比例字体硬塞进等宽格子里的样子（就是那种「字间距被撑开」的观感）。

**第 1 步 —— 在你想驱动的机器上启动主机端：**

```sh
flutter run -d windows -t lib/main_host.dart     # 或 -d macos / -d linux
```

它会自动启动并打印 `Servindo um PTY em ws://localhost:8080`。要从别的机器 / 手机连过来，它已经绑了 `InternetAddress.anyIPv4`；只要在防火墙放行 TCP **8080**，然后用主机的局域网 IP 即可。

**第 2 步 —— 跑 Web 客户端。** 两种都行：

```sh
# A) 常规 Flutter Web（debug）：会打开 Chrome 并支持热重载。
flutter run -d chrome -t lib/main_web.dart

# B) Release 构建 + 静态服务器（如果 `flutter run -d chrome` 用不了就用这个，
#    比如受限环境 / CI 里没有 web SDK）：
flutter build web -t lib/main_web.dart
cd build/web && python -m http.server 5599
#    然后在任意浏览器打开 http://localhost:5599
```

**第 3 步 —— 连接。** Web 客户端会自动连 `ws://localhost:8080`（在连接栏里可改）。当它变成 🟢 **ao vivo**（在线）时，你就在从浏览器往主机的 PTY 里打字了 —— 输出、调整大小、粘贴和完整的 TUI 程序（vim、`claude`……）全都实时流过来。

手机或另一台机器的话，把 URL 改成 `ws://<host-LAN-IP>:8080`。任何超出可信局域网范围的用法，都要在前面加上 TLS（`wss://`）、认证和单写入者控制租约 —— 也就是那套 gRPC + Redis 后端。

> **Web / 移动端的键盘：** Web 客户端把 `hardwareKeyboardOnly` 保持**关闭**，这样浏览器 / 软键盘才能工作。只有桌面本机终端才设 `hardwareKeyboardOnly: true`（直接读 `event.character`）。见[键盘与输入规则](#键盘与输入规则)。

## 背压（`ackRead`）

默认情况下 PTY 以进程产生输出的速度往外流。如果你的消费端跟不上（比如渲染很重），就用 `ackRead: true` 启动：PTY 会在每一块之后暂停，直到你调用 `pty.ackRead()`，把流控权交给你。

```dart
final pty = Pty.start('bash', ackRead: true);

pty.output.listen((chunk) {
  render(chunk);
  pty.ackRead(); // 请求下一块
});
```

## 生命周期与清理

一定要把会话拆干净，别泄漏原生进程和输出订阅：

```dart
final sub = pty.output.listen(...);
// ...
await sub.cancel();
pty.kill(); // 尽力而为；已经退出就是空操作
```

和组件集成时，在 `dispose()` 里做这件事。如果你还持有 xterm 的 `ScrollController` / `TerminalController`，要在 `TerminalView` 卸载*之后*再 dispose，免得报 "used after dispose"—— 参考 example 里 `PtySession.dispose` 的写法。

## 工作原理

* `src/` —— 原生 PTY 实现（Unix 上是 `forkpty`，Windows 上是 ConPTY）加一个 `CMakeLists.txt`，把它编译成动态库。
* `lib/` —— `cockpit_pty.dart` 里的 Dart API，通过 `dart:ffi` 调用原生库。`lib/src/cockpit_pty_bindings_generated.dart` 里的绑定由 [`package:ffigen`](https://pub.dev/packages/ffigen) 从 `src/cockpit_pty.h` 生成（`flutter pub run ffigen --config ffigen.yaml`）。
* 平台目录（`android`、`ios`、`windows`……）—— 把原生库和你的应用一起编译打包的构建粘合层。

## 贡献 / 重新生成绑定

改完原生头文件 `src/cockpit_pty.h` 之后，重新生成 FFI 绑定：

```sh
flutter pub run ffigen --config ffigen.yaml
```

## 许可证

见 [LICENSE](LICENSE)。
