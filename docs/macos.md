# macOS 安装与运行

支持 Intel 和 Apple Silicon，NapCat 官方安装器要求 macOS 12+。首次安装需要联网，建议预留 6 GB 以上空间，视频缓存另计。换电脑保留自己的记忆见 [迁移指南](migration.md)。

## 1. 准备与安装

1. 从 [Releases](https://github.com/XianZe1226/DSWhale/releases)下载 `DSWhale-0.2.0a2-source.zip`，全部解压到固定的普通文件夹，避免 iCloud 同步目录；无需预先安装 Python、Git 或 Node。
2. 已有 `ffmpeg`、`ffprobe` 可直接使用；没有则先按 [Homebrew 官网](https://brew.sh/)安装 Homebrew。Homebrew 可能要求 Xcode Command Line Tools 或系统密码，按官方提示完成，不要把密码写进项目。之后安装器可自动调用 Homebrew 安装 FFmpeg。
3. 双击根目录 **Install.command**。它准备项目内 uv、Python 3.12、AstrBot、LivingMemory、Node 22 及网页依赖。若 ZIP 未保留执行权限，在终端进入源码目录运行 `bash Install.command`。
4. 安装完成双击 **Start.command**。保留运行窗口，在浏览器打开日志给出的管理地址，通常为 `http://127.0.0.1:6185`；完成初始登录，将管理页限制为本机访问。

如果 Homebrew 刚安装但尚未进入 PATH，重新开终端或重新运行安装器；脚本也会检测 Apple Silicon 和 Intel 的标准 Homebrew 位置。遇到 macOS 对下载程序的安全提示，核对来源并按系统正常方式处理，不要关闭系统保护或递归放宽目录权限。

## 2. QQ 小号与可选的大号

按 [NapCat 官方 macOS 说明](https://napneko.github.io/guide/boot/Shell)安装 QQ 到 `/Applications/QQ.app`，使用 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases)安装并切换机器人入口，扫码登录**小号**。系统授权只在安装器正常的系统窗口输入。

大号可用手机 QQ。若要同机开大号，按 [独立官方 QQ 指南](qq-dual-login.md)准备 `~/Applications/DSWhale QQ.app`，保持其官方入口和签名，再双击 `scripts/start-qq-native.command`。找不到兼容官方副本会停止，绝不回退到 NapCat 那份。不要使用旧安装器的“切换到原版”按钮反复切换大小号，也不要将大号登录到 NapCat。

独立副本不等于设备或账号风险隔离；它们可能共享数据容器、设备和网络，平台仍可能限制账号。仅能确认本项目的大号辅助入口不加载 NapCat，不能承诺平台检测或“绝对不封”。

## 3. 完成首次配置

严格按 [README 首次配置](../README.md#首次配置按顺序完成)逐项完成：

1. AstrBot 新建 `aiocqhttp (OneBot v11)`，示例监听 `127.0.0.1:6199`。NapCat WebSocket 客户端连 `ws://127.0.0.1:6199/ws`，两端令牌一致。先验证普通 QQ 私聊。
2. 配聊天模型、图片模型、Embedding；LivingMemory 选 `session` 作用域并启用回忆工具。管理员命令需添加主人数字 QQ UID 后重启宿主。
3. 主号私聊 `/fish whoami`，在 DSWhale 填 `owner_qq`、完整 `owner_umo` 和真正支持图片的 `vision_provider_id`，保存重载。
4. `/fish status` → 标准短视频链接 → 确认效果后再开 `proactive_enabled`，避免同时启用多个主动聊天调度器。
5. 要开内置 B站养鱼，开启 `bili_enabled`、重载，再双击 **Bili-Settings.command**。按 [B站设置](bilibili.md)扫码、绑定主号 UID、选推荐渠道、作息及额度。`bili_node_path` 通常留空，使用安装器准备的 Node。

公开默认是通用可爱大肥鱼；私人角色设定只在本机 `persona` 配置中维护。模型会收到完成任务所需的设定和资料，按自己的隐私偏好选择提供商。

## 4. 日常启动和维护

日常顺序：**NapCat 小号 → Start.command → 可选的独立大号入口**。养鱼设置网页配好后可以关闭，AstrBot 和 NapCat 需持续运行；Mac 休眠或关闭启动窗口时，任务不会继续在云端运行。

升级先停止 AstrBot，再双击新版 Install.command；保留 `.runtime`，安装器会自动备份。跨系统不要复制 `.runtime/venv` 或 Mac 的 Node/FFmpeg 路径到 Windows。详细备份恢复见 [升级与回退](local-upgrade.md)。
