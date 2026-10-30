# 运维与故障排查

桌面用户先在应用内查看「环境」与服务状态，从导航打开 QQ、记忆或 B站页面检查实际连接，使用「打开数据目录」定位个人文件。安装失败可在环境页重试；配置修改前先停止服务。桌面数据路径见[桌面指南](desktop.md#数据保存在哪里)。

以下为终端部署的高级命令，在项目根目录执行。`python` 指安装环境中的解释器：Windows 为 `.runtime/venv/Scripts/python.exe`，macOS 为 `.runtime/venv/bin/python`。使用现有 AstrBot 时，通过 `--astrbot-dir` 指定宿主目录。

## 状态检查

```bash
python -m dswhale doctor
python -m dswhale doctor --json
```

检查包括 Python、AstrBot、FFmpeg/ffprobe、插件文件、用户绑定、图片模型配置和记忆插件。退出码 `0` 表示必需检查通过，`1` 表示存在待配置项，`2` 表示操作未完成。

本地检查不验证远程模型密钥或账号在线状态。QQ 和 B站连接状态应结合对应控制台检查。

## 数据目录

| 数据 | 位置 |
| --- | --- |
| 聊天、模型与插件配置 | 桌面应用数据目录的 `runtime/astrbot/data`；源码部署为 `.runtime/astrbot/data` |
| 长期记忆及索引 | LivingMemory 插件数据目录 |
| DSWhale 活动、预算和观察记录 | `data/plugin_data/astrbot_plugin_dswhale/state.db` |
| B站凭据、配置、日记和媒体 | `data/plugin_data/astrbot_plugin_dswhale/bilibili/` |
| 显式链接读取的临时媒体 | 系统临时目录，任务结束或取消后清理 |
| 外置 Cookie | `cookies_path` 指定的文件 |

表中的 `data` 相对于 AstrBot 宿主目录。B站工具产物保留在 `.dsh/shots`；停止宿主并完成备份后，可按需归档。

## 备份与恢复

桌面用户先在应用中停止服务并点击备份。终端部署可执行：

```bash
python -m dswhale backup "备份目录/backup.zip"
python -m dswhale restore "备份目录/backup.zip"
```

备份包含整个 AstrBot `data`，包括聊天、配置、记忆、凭据和插件状态，不包含外置 Cookie、NapCat 登录目录或其他服务数据。内置备份不加密，应保存在受控位置。

恢复前会校验归档，并将现有数据保留在 `.dswhale-backups`。备份文件不能已存在，也不能放在被备份的 `data` 内。当前归档上限为 1 GiB，超过时可停机后手工备份；符号链接需要单独处理。

升级步骤见 [升级与回退](upgrading.md)。安装、备份和恢复前都应停止宿主。

## 主动活动状态

| 状态 | 含义 |
| --- | --- |
| `reserved` | 已安排，尚未开始投递 |
| `queued` | 正在处理或投递 |
| `sent` | 平台发送调用成功，不代表对方已读 |
| `failed` | 处理失败或被取消 |
| `uncertain` | 投递结果不明确，不自动重发 |

活动预算会持久化，重启不会清空。失败和取消同样计数；收到用户真实消息后会重新计算未回复次数和下次活动时间。

## 常见问题

| 问题 | 检查项 |
| --- | --- |
| QQ 不回复 | NapCat 登录账号、WebSocket 连接、两端令牌、AstrBot 普通聊天、用户会话 ID |
| 记忆不可用 | LivingMemory 状态、Embedding 维度、整理模型、`session` 作用域、回忆工具 |
| 视频读取失败 | 标准链接、长度与体积限制、Cookie、FFmpeg、图片模型 |
| 不主动聊天 | `proactive_enabled`、暂停、免打扰、活动预算、连续未回复次数、电脑休眠 |
| B站私信无回复 | `listen.dm`、`bili_allow_dm`、绑定 UID、互关、免打扰与平台限制 |
| B站设置页打不开 | 服务是否启动；桌面用户重新点击 B站入口，终端用户重新运行 Bili-Settings，不复用旧页面地址 |
| OpenBiliClaw 连接失败 | 服务地址、推荐列表和令牌环境变量；远程鉴权使用 HTTPS |

长期记忆的查看、纠正和删除由 LivingMemory 管理。删除 DSWhale 的观察日志不会清除 LivingMemory 中的记忆，也不能撤回已发送的消息。
