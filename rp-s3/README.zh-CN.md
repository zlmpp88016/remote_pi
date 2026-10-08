# rp-s3 — Remote Pi 的下载服务器

一个极简 HTTP 服务器（Rust + axum），从挂载为 volume 的目录里提供 Cockpit（以及未来产品）的安装包。在 VPS 上以容器运行，位于负责 TLS 终止的代理之后，对外是 `https://rp-s3.jacobmoura.work`。

它是[计划 43](../plan/43-cockpit-packaging.md) 第 4 步中「读取」的那一侧。VPS 没有 SSH 访问权限，所以流程是：CI（`cockpit-release.yml`）把二进制文件发布为 **GitHub Release** `cockpit-v<版本>` 的 assets，并把 `latest.json` / appcast 通过 `PUT /upload`（Bearer token）直接发布到这台主机上。rp-s3 在站点读取的那个稳定 URL 上提供 manifest。

## 路由

| 路由 | 行为 |
|---|---|
| `GET /healthz` | `200 ok` |
| `GET /downloads/<产品>/...` | 提供 `DATA_DIR/<产品>/...` 下的文件 |
| `PUT /upload/<产品>/<文件>` | 把 manifest 写入 volume（Bearer 鉴权） |

### manifest 上传

只有在设置了 `UPLOAD_TOKEN` 时才存在（无该环境变量 → 404，转为手动流程）。**只**接受 `latest.json`、`SHA256SUMS` 和 `*.xml`（Sparkle 的 appcast）—— 二进制文件仍然放在 GitHub Release 的 assets 里。写入是原子的（临时文件 + rename），所以下载者绝不会看到只写了一半的 manifest。

从 GitHub Actions 调用（token 存为仓库 secret —— secret 不会泄漏到 fork / PR，所以实际上只有我们自己的仓库能发布）：

```yaml
- name: Publish manifest
  run: |
    curl -fsS -X PUT \
      -H "Authorization: Bearer ${{ secrets.RP_S3_UPLOAD_TOKEN }}" \
      --data-binary @latest.json \
      https://rp-s3.jacobmoura.work/upload/cockpit/latest.json
```

> 为什么用 token 而不是「校验仓库」？带仓库名的 header 是可以伪造的。密码学上的替代方案是 GitHub Actions 的 OIDC（签名 JWT，带 `repository` claim）—— 可以在同一 endpoint 上升级，但相对这个服务器目前的体量来说有些过重（不成比例）。

`/downloads` 的响应规则：

- `.dmg` / `.exe` / `.deb` / `.rpm` / `.zip` → `Content-Disposition: attachment` + `Cache-Control: immutable, 1 年`（产物放在带版本号的目录里，URL 永不复用）。
- 其他文件（`latest.json`、`SHA256SUMS`）→ `Cache-Control: max-age=300`（URL 固定，新 release 至多 5 分钟内生效）。
- 所有响应都带 `Access-Control-Allow-Origin: *`（站点要从另一个域名读取 manifest）。
- 不做目录列表；目录没有 index 文件 → 404。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DATA_DIR` | `/data` | `/downloads` 服务的根目录 |
| `PORT` | `8080` | HTTP 端口（TLS 由代理负责） |
| `UPLOAD_TOKEN` | — | 启用 `PUT /upload`；缺省即关闭该 endpoint |
| `RUST_LOG` | `rp_s3=info,tower_http=info` | 日志级别 |

## volume 布局

`docker-compose.yml` 把 CI 的 deploy 路径**挂载为产品子目录** —— 这样主机侧保持扁平，URL 又能带上正确的前缀：

```
host:  /Users/flutterando/cockpit/data/          （通过 PUT /upload 写入）
         latest.json
         SHA256SUMS                              （可选）

mount: /Users/flutterando/cockpit/data → /data/cockpit (rw, 供上传)

URL:   https://rp-s3.jacobmoura.work/downloads/cockpit/latest.json
```

二进制文件本身放在 GitHub Release 的 assets 里 —— `latest.json` 内部的 URL 指向那边。万一以后真有文件托管在这里，服务器照样知道怎么把 `.dmg` / `.exe` / `.deb` / `.rpm` 以 attachment 形式提供出去。

将来加新产品 = 再挂一个 volume 到 `/data/<产品>`。

## 运行

```bash
# 本地，不用 docker
DATA_DIR=./exemplo PORT=8080 cargo run

# 在 VPS 上（拉取 Docker Hub 镜像）
docker compose pull && docker compose up -d
curl -fsS http://localhost:8080/healthz
```

## 发布到 Docker Hub

和 relay 一样的流程：脚本从 `Cargo.toml` 读取版本号，通过 buildx 构建多架构（amd64 + arm64），并发布 `jacobmoura7/rp-s3:v<版本>` + `:latest`。

```bash
docker login          # 只需一次
./push-docker.sh
```

VPS 上的反向代理把 `rp-s3.jacobmoura.work` 指向 `localhost:8080`。
