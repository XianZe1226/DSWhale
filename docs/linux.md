# Linux 安装

支持 Ubuntu 22.04 / 24.04 桌面、64 位 Intel 或 AMD，需图形桌面会话。首次准备需要联网及至少 6 GB 可用空间。不提供 Linux ARM 桌面包。

## 桌面安装

1. 从 [Releases](https://github.com/XianZe1226/DSWhale/releases)下载 `DSWhale-版本-Linux-x86_64.deb`。
2. 在下载目录安装；命令中的文件名请替换为实际版本：

```bash
sudo apt install ./DSWhale-版本-Linux-x86_64.deb
```

3. 从应用菜单打开 **DSWhale**，进入「环境」并点击准备，再启动服务。
4. 按[配置指南](setup.md)独立准备 NapCat、连接 QQ、配置模型和记忆。

桌面应用复用兼容工具，缺少的依赖安装到自己的数据目录，不要求预装 Python、Node.js 或 FFmpeg。应用不会下载或修改系统 QQ。

## 沙箱与数据

`.deb` 会安装系统图形库依赖并设置 Chromium 沙箱辅助程序。安装包可能需要系统管理员权限，但运行应用时请使用普通用户。保持沙箱启用，不要以 root 启动，不要添加 `--no-sandbox` 或关闭系统安全策略。

可选的 `.tar.gz` 是便携程序归档，不会安装系统库或为沙箱辅助程序设置权限。Ubuntu 24.04 的系统策略可能限制未安装程序的用户命名空间；需要易用的桌面安装时请选择 `.deb`。

数据默认位于 `~/.config/DSWhale`，设置了 `XDG_CONFIG_HOME` 时位于相应目录。备份、手动更新和隐私说明见[桌面指南](desktop.md)。

## 高级：源码与终端部署

维护现有 AstrBot 时，准备 Python 3.12、Node.js 22 和 FFmpeg / ffprobe 后，可按[插件安装](setup.md#接入现有-astrbot)安装。源码环境与桌面运行目录独立，不会自动合并数据。
