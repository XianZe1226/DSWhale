# Windows 安装

## 系统要求

- Windows 10/11 x64，系统 PowerShell 5.1。
- 至少 6 GB 可用空间，视频缓存和模型数据另计。
- 可访问 GitHub、Python 软件源和所用模型服务。

安装器会准备 Python 3.12、AstrBot、LivingMemory、Node.js 和 B站页面依赖，无需预先安装 Python、Git 或 Node。

## 准备 FFmpeg

已有 `ffmpeg.exe` 和 `ffprobe.exe` 且已加入 PATH 时，可跳过本节。

安装器通过 WinGet 安装 FFmpeg。先从 Microsoft Store 安装或更新 [应用安装程序](https://apps.microsoft.com/detail/9nblggh4nns1)，在新终端中确认 `winget --version` 可用。

没有 WinGet，或自动安装遇到权限、安装范围错误时，可从 [FFmpeg 下载页](https://ffmpeg.org/download.html)选择 Windows 构建，将包含 `ffmpeg.exe` 和 `ffprobe.exe` 的 `bin` 目录加入 PATH，然后重新打开终端。

## 安装与启动

1. 从 [Releases](https://github.com/XianZe1226/DSWhale/releases)下载 `DSWhale-版本号-source.zip`。
2. 全部解压到固定目录，例如 `D:\Apps\DSWhale`。不要在压缩包内运行，建议避开同步目录。
3. 双击 **Install.cmd**，等待安装完成。
4. 双击 **Start.cmd**，在浏览器打开启动日志中的 AstrBot 管理地址，默认通常为 `http://127.0.0.1:6185`。
5. 完成管理账户设置，按 [配置指南](setup.md)连接 QQ、添加模型并绑定用户。

若窗口关闭过快，可在项目目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

执行策略参数仅影响当前进程，不会永久修改系统策略。安装失败后可重新运行 `Install.cmd`。

## 安装 NapCat

按 [NapCat 官方 Windows 文档](https://napneko.github.io/guide/boot/Shell)选择安装包：

- 手动 Shell 包：先安装 QQ；Windows 10 使用 `launcher-win10.bat`，Windows 11 按包内说明启动。
- OneKey 包：运行安装器，之后使用安装结果中的 `napcat.bat`。

登录独立机器人账号，再配置到 AstrBot 的反向 WebSocket。示例地址为 `ws://127.0.0.1:6199/ws`，两端访问令牌保持一致，详细步骤见 [连接 QQ](setup.md#连接-qq)。

普通 QQ 接入可能受到平台风控影响，请遵守平台规则。

## 启用 B站功能

在 DSWhale 配置中开启 `bili_enabled`，保存并重载后，双击 **Bili-Settings.cmd**。扫码登录，填写用户 UID、偏好和推荐渠道。主动活动、QQ 推荐与 B站私信需要分别配置，见 [B站设置](bilibili.md)。

## 日常使用

先启动 NapCat，再运行 `Start.cmd`。AstrBot 和 NapCat 需要持续运行；B站设置网页配置完成后可以关闭。

升级前停止 AstrBot，再运行新版安装脚本。保留 `.runtime`，安装器会自动备份数据，详见 [升级与回退](upgrading.md)。
