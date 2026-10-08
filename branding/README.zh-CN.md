# 品牌规范 — Remote Pi

官方视觉识别。事实来源是 SVG 文件（可无损缩放）。需要时用外部工具生成派生 PNG。

## 配色

| 颜色 | 十六进制 | 用途 |
|---|---|---|
| 纯黑 | `#000000` | 背景（full 版图标背景 + 自适应图标背景层） |
| 纯白 | `#FFFFFF` | π 符号（主前景） |
| Pi 蓝 | `#4FC3F7` | 标志性的小圆点 |

## 文件

| 文件 | 内容 | 推荐用途 |
|---|---|---|
| `logo-full.svg` | 黑底 + 白色 π + 蓝色圆点 | 整块 logo（favicon、README 头图、站点、应用商店截图） |
| `logo-foreground.svg` | π + 圆点，透明背景 | iOS app 图标（背景另配）、Android 自适应图标前景层 |
| `logo-background.svg` | 纯黑 1024×1024 | Android 自适应图标背景层 |
| `logo-monochrome.svg` | 纯白完整剪影 | Android 13+ 主题图标（系统按壁纸着色） |
| `banner.svg` / `banner.png` | 1280×640 横版 banner —— 左侧 π + 标题 + 标语 + install 命令 + URL | pi.dev 的包卡片（package.json 里的 `pi.image`）、GitHub README 主视觉、社交预览图 |

所有文件：viewBox 均为 **1024×1024**，兼容 Android 的安全区（中间约 66%）。

## 怎么转成 PNG

项目目前没有安装任何转换工具。需要生成 PNG 时的几种选择：

### 用 `rsvg-convert`（最简单）

```bash
brew install librsvg
rsvg-convert -w 1024 -h 1024 logo-foreground.svg -o logo-foreground.png
rsvg-convert -w 1024 -h 1024 logo-background.svg -o logo-background.png
rsvg-convert -w 1024 -h 1024 logo-monochrome.svg -o logo-monochrome.png
rsvg-convert -w 1024 -h 1024 logo-full.svg -o logo-full.png
```

### 用 ImageMagick

```bash
brew install imagemagick
magick -background none -resize 1024x1024 logo-foreground.svg logo-foreground.png
```

### 用 Inkscape（命令行）

```bash
inkscape --export-type=png --export-width=1024 logo-foreground.svg
```

### 用 Figma / 在线工具

- [https://cloudconvert.com/svg-to-png](https://cloudconvert.com/svg-to-png)
- [https://svgtopng.com](https://svgtopng.com)

## 标准导出尺寸

上传到商店 / 站点之前，先生成这些变体：

| 平台 | 尺寸 | 源文件 |
|---|---|---|
| iOS App Icon | 1024×1024 PNG（不带 alpha） | `logo-full.svg` |
| Android Adaptive（foreground） | 432×432 PNG，透明 | `logo-foreground.svg` |
| Android Adaptive（background） | 432×432 PNG（纯色即可） | `logo-background.svg` |
| Android Themed（monochrome） | 432×432 PNG，透明 | `logo-monochrome.svg` |
| Favicon | 32×32、16×16 PNG | `logo-full.svg` |
| App Store 截图页头 | 1200×630 PNG | `logo-full.svg`（需合成） |
| npm registry README | 512×512 PNG | `logo-full.svg` |

> Android 自适应图标：foreground 和 background 都占满 108dp 画布，但关键内容必须落在中间 66dp 以内（安全区）。这些 SVG 已经遵循该比例（约为 1024 的 66%）。

## 更新

视觉变更：直接改 SVG（Figma 导出 SVG 也可以）。再到各使用点（站点、app、商店）重新生成派生 PNG。

改动配色或剪影之前，请先把新版视觉识别和改动原因更新到本 README。
