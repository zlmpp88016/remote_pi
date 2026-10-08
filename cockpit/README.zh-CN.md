# Remote Pi Cockpit

面向 coding agent 的桌面客户端：终端、智能体、文件、git、worktree、数据库和任务并排摆放，支持 macOS、Windows、Linux；另有 iPad 和 Android 客户端可连远程主机。

- 官网与文档：https://remote-pi.jacobmoura.work/cockpit
- 下载（dmg、exe、deb、rpm、apk）：https://github.com/jacobaraujo7/remote_pi/releases?q=cockpit-v
- 打包与发版手册：[packaging/README.md](packaging/README.md)

## Linux 主机（VPS）上的 cockpit-server

远程工作区要在主机上跑一个轻量的无界面 `cockpit-server`，通过 SSH 访问。首次连接时，只要桌面应用自带对应的目标平台，它会自行安装并更新这个 server（macOS 和 Linux arm64 客户端自带 Linux arm64；Linux x86_64 客户端自带 Linux x86_64）。其他所有组合，以及移动端 app（它们不带 server），都需要先用下面的安装脚本把主机准备一次。两条路径装到同一个位置，并且能互相识别。仅支持 Linux x86_64 和 arm64，用户空间，不需要 sudo。

```bash
curl -fsSL https://remote-pi.jacobmoura.work/cockpit-server.sh | bash
# 同一个脚本，直接走 GitHub（站点 URL 会重定向到这里）：
curl -fsSL https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/cockpit/install-server.sh | bash
```

脚本位于 [install-server.sh](install-server.sh)。它依次做这些事：

1. 检查主机是否为 Linux，并把 `uname -m` 映射成 `x86_64` 或 `arm64`。
2. 确定版本号：设置了 `COCKPIT_VERSION=x.y.z` 就用它，否则取 GitHub 上最新的 `cockpit-server-v*` release。server 版本必须与你连接时用的 Cockpit app 版本一致。
3. 从该 release 下载 `cockpit-server-<version>-linux-<arch>.zip` 和 `SHA256SUMS`，并校验校验和。
4. 解压到临时目录（优先 `unzip`，其次 `python3`，都没有就在 sudo 免密时用包管理器装 `unzip`），然后运行 zip 里附带的 `install.sh`——它会校验 `bundle.manifest`、做一次冒烟启动、把目录原子地换进 `~/.cockpit/server`（冒烟通过前保留旧版本作为备份），并建立 `~/.local/bin/cockpit-server` 软链。
5. 加上 `--service`（即 `bash -s -- --service`）时，通过 `cockpit-server service install` 注册一个 `systemd --user` unit，让 server 开机自启。它可能会打印一条 `sudo loginctl enable-linger` 命令，需要你手动执行一次。

重复运行该脚本即为更新安装；版本相同时是空操作。

手动下载，适用于无法访问互联网、或者想先自己读一遍文件的主机：

- Releases：https://github.com/jacobaraujo7/remote_pi/releases?q=cockpit-server-v
- 然后 `unzip cockpit-server-<version>-linux-<arch>.zip && ./cockpit-server/install.sh`

安装后，服务相关命令：

```bash
cockpit-server service install     # systemd --user unit，开机自启
cockpit-server service status
cockpit-server service uninstall
cockpit-server --version
```

含故障排查的完整页面：https://remote-pi.jacobmoura.work/cockpit/docs#remote

## 开发

前置条件：Flutter（版本固定在 `.github/workflows/cockpit-release.yml`）、通过 rustup 安装的 Rust、Zig 0.16.0。架构与约定见 [CLAUDE.md](CLAUDE.md)。

```bash
flutter pub get
flutter run -d macos
flutter analyze && flutter test
```
