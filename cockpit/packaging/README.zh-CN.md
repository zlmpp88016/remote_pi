# 打包与发布 — Cockpit

三平台构建／打包的 runbook。作为 CI job（`.github/workflows/cockpit-release.yml`，计划 43 第 3 步）的基础。参考计划：[`../../plan/43-cockpit-packaging.md`](../../plan/43-cockpit-packaging.md)。

## 标识（第 1 步 —— 已完成）

| 项 | 值 |
|---|---|
| App ID（macOS bundle id / Linux app id） | `work.jacobmoura.cockpit` |
| 显示名称 | **Remote Pi Cockpit** |
| 二进制 | `cockpit`（Linux/Windows）／`Cockpit`（macOS）—— **没有**改名 |
| Team ID（Apple） | `U843T2P7A2` |
| 版本（SSOT） | `pubspec.yaml` 里的 `version:`（`x.y.z+n`） |

- macOS：`PRODUCT_BUNDLE_IDENTIFIER` 在 `macos/Runner/Configs/AppInfo.xcconfig`；`CFBundleDisplayName` 在 `Info.plist`；Release 下开启 **Hardened Runtime**（`ENABLE_HARDENED_RUNTIME = YES`，公证的硬性要求），配合 `Release.entitlements`（sandbox 关闭 —— 与 Developer ID 兼容）。
- Windows：`CompanyName`／`ProductName`／`LegalCopyright` 在 `windows/runner/Runner.rc`；版本来自 `FLUTTER_VERSION_*` 这些 define（构建时注入；`#else "1.0.0"` 只是兜底）。
- Linux：`.desktop` + hicolor 图标 + `work.jacobmoura.cockpit.metainfo.xml`（AppStream），通过 `linux/CMakeLists.txt` 安装。

## 工具

[Fastforge](https://pub.dev/packages/fastforge)（已停止维护的 `flutter_distributor` 的继任者）：

```bash
dart pub global activate fastforge
```

配置：`distribute_options.yaml`（cockpit 根目录）+ 每种格式一个 `make_config.yaml`。**注意 Fastforge 的路径约定**：配置放在 `<平台>/packaging/<格式>/make_config.yaml`（loader 里写死的），**不是**计划里那张图所暗示的 `packaging/<平台>/...`：

```
macos/packaging/dmg/make_config.yaml
windows/packaging/exe/make_config.yaml
linux/packaging/deb/make_config.yaml
linux/packaging/rpm/make_config.yaml
```

## macOS —— build + sign + DMG + notarize + staple（端到端）

2026-06-12 本地验证通过（DMG 被 Gatekeeper 接受）。前置条件：Keychain 里有 **"Developer ID Application: Jacob Moura (U843T2P7A2)"** 身份、App Store Connect 的 API key、Zig 0.16.0，以及远程 Linux server CLI 用到的 Rust target（`rustup target add aarch64-unknown-linux-gnu`）。

```bash
cd cockpit

# 1. 构建 universal（x86_64 + arm64 —— Flutter macOS release 的默认值）。
flutter build macos --release
APP="build/macos/Build/Products/Release/Cockpit.app"

# 2. 用 Developer ID + Hardened Runtime + Release entitlements 给 .app 签名。
codesign --force --deep --options runtime --timestamp \
  --entitlements macos/Runner/Release.entitlements \
  --sign "Developer ID Application: Jacob Moura (U843T2P7A2)" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"   # 校验

# 3. 制作 DMG（hdiutil —— 无额外依赖；Fastforge 的 maker 走 npm 上的 `appdmg`，
#    那是 CI 的替代方案）。布局：app + /Applications 快捷方式。
mkdir -p dist
STAGE=$(mktemp -d); cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
DMG="dist/RemotePiCockpit-1.0.0-macos-universal.dmg"
hdiutil create -volname "Remote Pi Cockpit" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

# 4. 给 DMG 签名。
codesign --force --timestamp \
  --sign "Developer ID Application: Jacob Moura (U843T2P7A2)" "$DMG"

# 5. 公证（App Store Connect API key）并等待。
xcrun notarytool submit "$DMG" \
  --key "/Users/jacob/Library/Mobile Documents/com~apple~CloudDocs/Flutterando/RemotePi/CockpitApp/AuthKey_3Y2J8MA3M4.p8" \
  --key-id 3Y2J8MA3M4 \
  --issuer a76c76e6-a413-449e-926c-f2c30d5645c4 \
  --wait

# 6. 钉住（staple）票据并校验。
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"   # → "accepted / Notarized Developer ID"
```

> **CI**：5 个 Apple secret 都已在仓库里（`MACOS_CERT_P12`、`MACOS_CERT_PASSWORD`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_API_KEY`）。在 runner 上，先导入 `.p12` 到临时 keychain，并把 `.p8` 写成文件，再跑上面的步骤。

## Windows —— Inno Setup（`.exe`）

**无法在 Mac 上构建。** CI 的 `windows` job（`windows-latest`）：

```bash
flutter build windows --release
fastforge package --platform windows --targets exe   # 使用 windows/packaging/exe/make_config.yaml
```

现阶段不签名（SmartScreen 警告已在站点上说明）。产物：`RemotePiCockpit-Setup-<v>-windows-x64.exe`。

## Linux —— `.deb` + `.rpm`（x86_64 和 arm64）

**无法在 Mac 上构建。** CI 的 `linux-x64`（`ubuntu-24.04`）和 `linux-arm64`（`ubuntu-24.04-arm`）job：

```bash
sudo apt-get install -y rpm   # rpmbuild，用于在 Ubuntu runner 上生成 .rpm
flutter build linux --release
fastforge package --platform linux --targets deb
fastforge package --platform linux --targets rpm
```

### 在真正的 Linux 机器上构建（不是 runner）

GitHub 的 runner 自带原生插件在 CMake 里需要的那些 `-dev` 包；一台干净的机器没有。缺了它们，`flutter build linux` 会在 **configure** 阶段挂掉，而且一次只报一个依赖：

```bash
sudo apt-get install -y libsecret-1-dev libasound2-dev libmpv-dev libjsoncpp-dev
```

| 包 | 谁需要 |
|---|---|
| `libsecret-1-dev` | `flutter_secure_storage_linux` |
| `libasound2-dev`（ALSA） | `volume_controller` |
| `libmpv-dev` | `media_kit_video` |
| `libjsoncpp-dev` | Flutter Linux bundle |

这些是**构建**依赖，不是运行时依赖 —— 运行时依赖在 `linux/packaging/deb/make_config.yaml` 里。改过插件后想核对清单：`grep -rh "pkg_check_modules\|find_package" linux/flutter/ephemeral/.plugin_symlinks/*/linux/CMakeLists.txt`。

**CMake 的坑：** 一次中断的 configure 会把 `CMakeCache.txt` 里的 `CMAKE_INSTALL_PREFIX` 留在 `/usr/local`，而 `linux/CMakeLists.txt` 只在它还是初始默认值时才会改指向 bundle。此后每次构建都会以 `file INSTALL cannot copy ... to /usr/local/cockpit: Permission denied` 失败，即使库都已装好也一样。修法：

```bash
rm -f build/linux/x64/release/CMakeCache.txt
rm -rf build/linux/x64/release/CMakeFiles
```

`fastforge`（`dart pub global activate fastforge`）的输出在 `dist/<版本>/cockpit-<版本>-linux.deb`；用 `sudo dpkg -i` 安装，**app 必须处于关闭状态** —— 否则会在活进程底下替换掉二进制文件。

运行时依赖声明在各个 `make_config.yaml` 里（GTK3 + 基础库）。**CI 待办**（第 3 步）：对生成的 bundle 跑 `ldd` 来确认／扩充依赖清单，并在 `ubuntu:24.04`（deb）和 `fedora:40`（rpm）容器里验证安装 —— 这台 Mac 上做不到（没有 Linux 构建能力；Docker 装了但没启动）。

## 独立的 cockpit-server —— 给 VPS 的 zip（Linux x86_64 和 arm64）

与 app **分开的** release：tag `cockpit-server-v<版本>` 触发 `.github/workflows/cockpit-server-release.yml`（两个原生 Linux job，不用 Flutter）。tag 的版本**必须**与 pubspec 的 `version:` 一致：客户端和服务端同步演进，移动端会拒绝版本不一致。两个 tag（`cockpit-v…` 和 `cockpit-server-v…`）要在同一个 commit 上打。

产物：`cockpit-server-<版本>-linux-{x86_64,arm64}.zip` + `SHA256SUMS`。布局（见 `tool/build-server-zip.sh`）：

```
cockpit-server/
├── bin/{cockpit-server,cockpit}
├── lib/{libcockpit_pty.so,libanaki_*.so}
├── bundle.manifest   # sha256sum -c，与客户端经 SSH 写入的格式相同
├── VERSION           # 第 1 行版本，第 2 行 arch
└── install.sh        # packages/cockpit_server/install.sh
```

在主机上安装：`curl -fsSL https://remote-pi.jacobmoura.work/cockpit-server.sh | bash`（脚本在 `cockpit/install-server.sh`，只负责解析版本和 arch、下载、核对 hash，然后调用 zip 里的 `install.sh`）。`--service` 会通过 `cockpit-server service install|uninstall|status` 注册 `systemd --user` unit。文档：`site/src/app/cockpit/docs/page.tsx` 里的「Remote hosts & VPS」一节。

注意：zip 里的 bundle 和打进 app 的 bundle 是在不同 runner 上编译的，所以字节可能不同，桌面端可能在首次连接时覆盖重装（manifest 摘要不同）。这无害；如果变得烦人，可以让 app 的 job 改为直接消费那个 zip。

## 自更新（计划 47 —— Sparkle/WinSparkle）

macOS 和 Windows 通过 `auto_updater` 包自更新（Sparkle/WinSparkle）；Linux 仍是通知 + 手动下载。app 读取一份 **appcast**（URL 在运行时通过 `setFeedURL` 写死），并下载经过 **EdDSA** 签名的更新产物。

### 更新产物（≠ 首次安装的安装包）

| 平台 | 首次安装 | 更新（appcast） |
|---|---|---|
| macOS | 已公证的 `.dmg` | **`Cockpit-<v>-macos.zip`** = 对已公证 + 已 **stapled** 的 `.app` 做 `ditto` |
| Windows | Inno 的 `.exe` | **同一个 `.exe`** 静默运行（`sparkle:installerArguments`） |
| Linux | `.deb`/`.rpm` | — |

### EdDSA 密钥（两者共用一把）

Sparkle 和 WinSparkle 都用 **ed25519**，它是确定性的 —— 同一把密钥可以服务两者（已验证：Sparkle 的 `sign_update` 和 PyNaCl 产生的签名完全相同）。所以只有**一对**密钥，不是两对。

- **公钥**（已提交）：`WoJTWryr48pWiAnDPqqt/Iu9f6gAsU7A1zBb5mBLruI=`
  - macOS：`macos/Runner/Info.plist` 里的 `SUPublicEDKey`。
  - Windows：`windows/runner/Runner.rc` 里的 `EdDSAPub EDDSA {...}` 资源。
- **私钥**（绝不提交）：备份在 `…/CloudDocs/Flutterando/RemotePi/CockpitApp/sparkle_ed25519_private_key.txt`（iCloud，和 Apple 证书放在一起）**以及** GitHub secret `SPARKLE_PRIVATE_KEY`。用 Sparkle 在 keychain 账号 `remote-pi-cockpit` 下生成。

重新生成／轮换（⚠️ 换密钥会**锁死已安装的存量用户**：旧 app 只信任内嵌在它们里面的那把公钥 —— 只有在私钥泄漏时才做，并且要明白现有用户必须手动重装）：

```bash
cd cockpit
# （重新）生成；打印 SUPublicEDKey；私钥存入 Keychain（专用账号）
./macos/Pods/Sparkle/bin/generate_keys --account remote-pi-cockpit
# 把私钥导出到 iCloud（Keychain 会请求 "Allow"）
./macos/Pods/Sparkle/bin/generate_keys --account remote-pi-cockpit -x \
  "/Users/jacob/Library/Mobile Documents/com~apple~CloudDocs/Flutterando/RemotePi/CockpitApp/sparkle_ed25519_private_key.txt"
# 更新：SUPublicEDKey（Info.plist）、EdDSAPub（Runner.rc）和 secret SPARKLE_PRIVATE_KEY
```

### 签名 + appcast（在 CI，`publish` job 里）

全都在一处完成，跑在 ubuntu 上，只用**一把**密钥、**不需要**任何原生工具：该 job 用 PyNaCl（读 `SPARKLE_PRIVATE_KEY`）给 `Cockpit-<v>-macos.zip` 和 `.exe` 签名，并生成 `appcast-macos.xml` + `appcast-windows.xml`。macOS 用 `sparkle:version` = **build number**（`+n`）；Windows 用 marketing 版本号。

### 发布（手动闸门）

和 `latest.json` 一起，把 `appcast-macos.xml` 和 `appcast-windows.xml` 上传到 rp-s3（`/Users/flutterando/cockpit/data/`）。上传之前，没人会自更新。feed URL 是 `https://rp-s3.jacobmoura.work/downloads/cockpit/appcast-{macos,windows}.xml`。

### 待办（这台 Mac 上无法测试）

- 在仓库里添加 `SPARKLE_PRIVATE_KEY` secret（iCloud 文件的内容）。
- 在**真实 Windows** 上验证：`EdDSAPub` 资源、无 UAC 的静默安装、relaunch（Restart Manager）不重复启动。
- 验证公证时 Sparkle 的 **codesign**（framework + Autoupdate + Updater.app + XPCServices —— 已确认都在 bundle 里；`--deep` 应当覆盖）。
- 真正的端到端：上传一个指向 v(N+1) 的 appcast，看一个 v(N) 的 cockpit 自我更新。

## 后续步骤（计划 43）

- 第 3 步：`.github/workflows/cockpit-release.yml`（触发条件 `cockpit-v*`）。**已完成**（+ 计划 47 的自更新：`.app.zip` + 已签名 appcast）。
- 第 4 步：VPS 上的布局／`latest.json`。
- 第 5 步：`site/` 里的下载页。
- 第 6 步：release runbook（bump `version:` → tag → CI → 冒烟测试）。

# Linux：混合 GPU 策略

Cockpit 的原生 bootstrap 默认选择集成 GPU 和 XWayland，并且只对 Cockpit 进程移除从图形会话继承来的 NVIDIA 环境变量。这样可避免 NVIDIA 的 EGL 在混合 Wayland 会话中进入该进程。显式设置的 `GDK_BACKEND` 仍然会被尊重。要比较或强制使用独立 GPU，用 `COCKPIT_USE_NVIDIA=1 cockpit` 启动。启动日志会记录 `gpu_policy`、`GDK_BACKEND` 和 `XDG_SESSION_TYPE`，但不记录命令或用户内容。

Linux 诊断矩阵：Intel/XWayland 是安全的生产路径；用 `COCKPIT_USE_NVIDIA=1 GDK_BACKEND=wayland cockpit` 比较 NVIDIA/Wayland，用 `GDK_BACKEND=wayland cockpit` 比较 Intel/Wayland。回滚就是删掉 `configure_linux_gpu_environment()` 调用；不修改任何全局配置。
