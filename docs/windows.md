# Windows 10/11 安装与运行

支持 **Windows 10/11 x64**，使用系统 Windows PowerShell 5.1 即可。Windows ARM64 不在本版本支持范围。首次安装需要联网；不要在压缩包内部、临时目录或 OneDrive 同步目录运行。换电脑且要保留自己的记忆，请先读 [迁移指南](migration.md)。

## 1. 下载和前置环境

1. 打开 [Releases](https://github.com/XianZe1226/DSWhale/releases)，下载 `DSWhale-0.2.0a2-source.zip` 并全部解压到固定文件夹，例如 `D:\Apps\DSWhale`。新用户不用插件 ZIP 或 wheel。
2. 预留 6 GB 以上空间，视频缓存和模型数据另计。无需预先安装 Python、Git 或 Node。
3. 若电脑没有 FFmpeg，安装器会调用 **WinGet**。先在 Microsoft Store 安装/更新 [应用安装程序](https://apps.microsoft.com/detail/9nblggh4nns1)，确保 `winget --version` 可运行。没有商店或 WinGet 的机器，可自行从 [FFmpeg 官方下载入口](https://ffmpeg.org/download.html)选择 Windows 构建，将同时含 `ffmpeg.exe`、`ffprobe.exe` 的 `bin` 文件夹加入 PATH，重新开终端后检查两个命令都能运行。
4. 安装期间若系统要求安装 FFmpeg 的授权，阅读并完成提示；权限不足或 WinGet 的 user scope 不被当前包支持时，先单独安装 FFmpeg，确认 PATH 后重跑 `Install.cmd`。不需要关闭防火墙或杀毒软件。

## 2. 双击安装、启动

1. 双击根目录 **Install.cmd**。会准备项目内 uv、Python 3.12、AstrBot 4.29.3、LivingMemory 2.7.1、Node 22、B站网页依赖及 FFmpeg；需要下载，第一次可能较久。
2. 显示安装完成后，双击 **Start.cmd**，保持该窗口运行。按日志中的本机地址打开 AstrBot 管理页，通常是 `http://127.0.0.1:6185`。完成初始账户/密码设置，将管理页监听地址限制为 `127.0.0.1`。
3. 若窗口一闪而过，打开系统 PowerShell，进入解压目录，执行下面的命令以保留报错。执行策略参数只对本次进程生效，不永久改系统策略：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

`Install.cmd` 可重复执行。升级前先在 AstrBot 启动窗口按 Ctrl+C，安装器会备份数据；不要删除 `.runtime`。下载失败时保留完整错误类型和最后一步名称，脱敏后再反馈，不提供配置文件或带令牌链接。

## 3. QQ 小号接入

按照 [NapCat 官方 Windows 说明](https://napneko.github.io/guide/boot/Shell)选择一种安装方式：

- 手动 Shell 包：先安装 QQ，解压 NapCat；**Windows 10 使用 `launcher-win10.bat`**，Windows 11 按包内 `launcher.bat` 使用。
- 官方文档里的 Windows OneKey 包：运行其安装器，之后用安装结果里的 `napcat.bat`。不要混用不同包的入口。

扫码登录**机器人小号**，通过控制台提供的地址和令牌进入 NapCat WebUI。主号只用腾讯官方客户端或手机 QQ，不把主号交给 NapCat；不能承诺同设备、同网络的账号关联风险为零。

按 [README 第 3 步](../README.md#3-连接-qq反向-websocket)建立 AstrBot `aiocqhttp (OneBot v11)` 平台，再建 NapCat WebSocket 客户端：`ws://127.0.0.1:6199/ws`，两端设置同一访问令牌。先确认主号发普通私聊、小号能回复，再继续。

若无法连接，用 `Get-NetTCPConnection -LocalPort 6199 -ErrorAction SilentlyContinue` 查监听；核对平台已启用、两侧端口/令牌一致。仅同机部署，无需将端口暴露公网。不要为省事全局关闭防火墙。

## 4. 模型、记忆与主人绑定

依次完成 [README 首次配置](../README.md#首次配置按顺序完成)：

1. 聊天模型必须支持工具调用；图片模型必须真的支持图片。Embedding 模型单独配置，保留其 Provider ID 与维度。
2. LivingMemory 启用，填写 Embedding 与整理模型 Provider ID；Pages → dashboard → 设置中选择 `session` 作用域，启用回忆工具。管理员命令需要把主人数字 QQ 加入 AstrBot `admins_id`，保存并重启。
3. 主号私聊小号发送 `/fish whoami`，把返回 QQ 和完整 UMO 填到 DSWhale 的 `owner_qq`、`owner_umo`；图片 Provider ID 填入 `vision_provider_id`。
4. 保存、重载 DSWhale，用 `/fish status` 检查。先测试标准短视频链接，再开主动活动。

默认人格是通用可爱大肥鱼。自定义 `persona` 填在本机插件配置；不要提交到源码、issue 或 GitHub。宿主人格也要与之相容，否则两个人格会拉扯。

## 5. B站、主动聊天和日常启动

完整步骤见 [B站设置](bilibili.md)。开启 `bili_enabled`、保存重载，再双击根目录 **Bili-Settings.cmd**。若界面不显示字段英文名，找中文说明“启用完整 B站养鱼整合”。扫码登录鱼的 B站账号，绑定自己的主号 UID，先选择 QQ 推荐。

主动活动还需 `proactive_enabled`，QQ 推荐需 `bili_qq_recommendations`。接收主人的 B站私信需单独开启养鱼页「倾听」里的 `listen.dm`，并开启 `bili_allow_dm`、双方互关；推荐渠道可仍为 QQ。

之后每次开机：**启动 NapCat 小号 → Start.cmd → 必要时 Bili-Settings.cmd**。保持 AstrBot 和 NapCat 运行，设置网页配置完可以关闭。关机、休眠或关闭启动窗口后任务也会停。先用默认低频预算，别反复重发或频繁重新扫码。

验收：普通私聊 → `/fish status` → 一条短视频 → “去 B站看个科技视频，回来聊聊” → 完成后“介绍一下刚才那个视频”。追问只读已有笔记，新任务仍可能受网络、模型和平台限制。Windows CI 能验证安装和代码，真实 QQ 登录、B站账号和模型仍要在你自己的笔记本验收。
