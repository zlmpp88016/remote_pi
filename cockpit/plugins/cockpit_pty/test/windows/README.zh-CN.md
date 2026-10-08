# Windows PTY 写入冻结复现程序

一个独立的 C 程序，用来**复现并验证** Windows 独有的 UI 冻结问题（计划 58）。它**不属于** `flutter test`。

它 `#include` 真实的 `src/cockpit_pty_win.c`，跑三个用例：

| # | 做什么 | 预期 |
|---|---|---|
| T1 | 向一个活的 ConPTY 执行 `pty_write("echo …")` | 可选的完整性检查 —— 这里的独立 ConPTY 不回显 `cmd`（与 2026-08-13 那次运行同样报 WARN）；这不是冻结的证明 |
| T2 | 旧语义（`WriteFile` + `FlushFileBuffers`），配合用 `NtSuspendProcess` 挂起 `conhost` | **阻塞**（即生产环境中的卡死） |
| T3 | 相同的挂起消费端下，用新的 `pty_write` | 500 次 × 4KB 立即返回（最慢一次远小于 50 ms） |

macOS / Linux 没有对应情况：它们的 `forkpty` 后端从来不调用 `FlushFileBuffers`。

## 运行

需要 Visual Studio Build Tools（MSVC）和 Windows 10 1809+（ConPTY）。

```powershell
# 在本目录下，或在插件根目录下：
powershell -File test/windows/build.ps1
```

脚本会定位 `vcvars64.bat`，针对 `src/cockpit_pty_win.c` 编译，然后运行 exe。退出码 0 = 所有实际执行的用例都通过（若 `NtSuspendProcess` 打不开新生成的 `conhost`，T2 / T3 会跳过）。

## 它不是什么

- 不是 Dart 单元测试。Flutter 的测试运行器无法对活标签页的 ConPTY host 调用 `NtSuspendProcess`。
- 不是吞吐量基准。计划 58 里「比 Windows Terminal 快 14%」那个数字，是在真实的 1.26.1 app 里**手工**倾倒 2 万行得到的，不是这个程序跑的。
