# macOS 安装

## 系统要求

- macOS 12+，Intel 或 Apple Silicon。
- 至少 6 GB 可用空间，视频缓存和模型数据另计。
- 可访问 GitHub、Python 软件源和所用模型服务。

安装器会准备 Python 3.12、AstrBot、LivingMemory、Node.js 和 B站页面依赖。

## 准备 FFmpeg

已有 `ffmpeg` 和 `ffprobe` 时，可跳过本节。否则先按 [Homebrew 官网](https://brew.sh/)安装 Homebrew，之后安装器会自动安装 FFmpeg。Homebrew 所需的系统组件与权限按其安装提示处理。

## 安装与启动

1. 从 [Releases](https://github.com/XianZe1226/DSWhale/releases)下载 `DSWhale-版本号-source.zip`，解压到固定目录。
2. 双击 **Install.command**，等待安装完成。
3. 双击 **Start.command**，在浏览器打开启动日志中的 AstrBot 管理地址，默认通常为 `http://127.0.0.1:6185`。
4. 完成管理账户设置，按 [配置指南](setup.md)连接 QQ、添加模型并绑定用户。

若解压后无法直接运行脚本，在终端进入项目目录执行：

```bash
bash Install.command
bash Start.command
```

Homebrew 刚安装或 PATH 调整后，请重新打开终端。安装脚本会检测 Apple Silicon 和 Intel 的标准 Homebrew 位置。

## 安装 NapCat

按 [NapCat 官方 macOS 文档](https://napneko.github.io/guide/boot/Shell)将 QQ 安装到 `/Applications/QQ.app`，使用 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases)安装并启动 NapCat，登录独立机器人账号。

接着配置 AstrBot 与 NapCat 的反向 WebSocket，详细步骤见 [连接 QQ](setup.md#连接-qq)。示例地址为 `ws://127.0.0.1:6199/ws`，两端访问令牌应一致。

需要同时使用普通 QQ 时，参考 [macOS QQ 双开](qq-dual-login.md)。使用非官方接入可能触发平台风控，独立应用副本不提供账号风险隔离。

## 启用 B站功能

在 DSWhale 配置中开启 `bili_enabled`，保存并重载后，双击 **Bili-Settings.command**。扫码登录，填写用户 UID、偏好和推荐渠道。详细说明见 [B站设置](bilibili.md)。

## 日常使用

先启动 NapCat，再运行 `Start.command`。AstrBot 和 NapCat 需要持续运行；B站设置网页配置完成后可以关闭。电脑休眠、关机或关闭启动窗口后，主动任务会停止。

升级前停止 AstrBot，再运行新版安装脚本。保留 `.runtime`，详细步骤见 [升级与回退](upgrading.md)。
