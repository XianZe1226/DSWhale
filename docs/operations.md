# 维护和数据

命令中的 `python` 指安装环境的 Python。启动脚本创建的环境在 macOS 为 `.runtime/venv/bin/python`，Windows 为 `.runtime/venv/Scripts/python.exe`。以下命令在项目根目录执行；已有 AstrBot 用户加上自己的 `--astrbot-dir`。

## 检查、升级和回退

```bash
python -m dswhale doctor
python -m dswhale doctor --json
```

检查 Python、AstrBot、ffmpeg/ffprobe、插件文件、主人配置、图片模型 ID 和记忆插件文件。退出码 0 表示本地必需检查通过，1 表示有待配置项，2 表示操作未完成。检查不会验证 API 密钥、QQ 登录或远程模型是否真正工作。

升级前关闭 AstrBot，备份后用新版源码重新运行 setup。安装器替换插件代码，将旧插件保留在 `.runtime/astrbot/.dswhale-backups`；主人配置和 `data/plugin_data` 不变。已有 LivingMemory 原样保留，升级它请按上游迁移文档操作。不要手工删除运行目录来升级。

`astrbot.lock` 的进程锁用于阻止与 `astrbot run` 同时安装、备份或恢复；通过其他自定义方式启动宿主时，仍必须自行确保进程已停止。

## 备份和恢复

```bash
python -m dswhale backup "/安全目录/dswhale-2026-10-25.zip"
python -m dswhale restore "/安全目录/dswhale-2026-10-25.zip"
```

要求 AstrBot 已停止。备份包含**整个 AstrBot data**：聊天、LivingMemory、插件、配置、DSWhale 状态。它包含私密内容与密钥，不要公开上传；本工具不加密备份。外置 Cookie、外部 OpenBiliClaw 数据、NapCat 账号和自定义环境变量不包含在内，需分别管理。

恢复先校验归档结构，再替换 data；恢复前的完整 data 保留在 `.dswhale-backups`，不自动删除。失败不会先删除现有数据。备份目标不得已存在，也不得位于被备份的 data 内。当前归档限额 1 GiB，超过时关闭程序后手工复制整个 data。符号链接需单独处理。

## 数据在哪里

| 数据 | 位置/管理方 |
| --- | --- |
| 普通聊天与模型配置 | AstrBot `data` |
| 长期个人记忆、向量与索引 | LivingMemory 的插件数据目录 |
| 活动预算、暂停、投递状态、视频观察日志 | `data/plugin_data/astrbot_plugin_dswhale/state.db` |
| 视频原文件、抽帧和音频 | 系统临时目录，任务结束或取消后清理；异常断电可能留残片 |
| Cookie | 用户指定的外置文件；读取时复制临时副本 |
| 内容兴趣和候选 | OpenBiliClaw 自己的数据目录 |

删除或纠正个人长期记忆请在 LivingMemory 管理页面操作；不要仅删除 DSWhale 的日志就认为所有个人记忆都已消失。停用插件后可以单独备份/移除 DSWhale 的 `state.db`；这会清除活动预算与日志，不能撤回已发出的 QQ 消息。

## 活动和投递含义

- 首次启动先等待一个设定间隔，安静时段内不触发。
- 每次活动先持久化预约，再调用内容/模型/QQ，避免重复回调造成重复发送。
- 失败或取消消耗当日次数与未回复预算，用户真实消息会重置未回复计数。
- `sent` 表示该主动事件的平台发送调用成功完成，不代表用户已读。宿主完成回调本身不作为成功证据；失败或部分投递会保守记录为不确定。
- 进程中断或长时间无回调的活动标为 `uncertain`，不自动重发；可能实际已收到，也可能没有。
- 发送前若主人已经发来新消息、已暂停或进入安静时段，则取消该主动回复。其他插件直接发送、流式分段或外部工具自行发送不在 DSWhale 的投递控制范围内；alpha 建议关闭自动流式分段和其他主动发送工具。

## 已知故障处理

- **QQ 不回复**：先确认 AstrBot 自身普通聊天可用、NapCat WebSocket 已连接，再检查主人 UMO。
- **没有长期记忆**：检查 LivingMemory 已启用、Embedding ID、总结模型、记忆范围与 `/lmem status`。记忆整理通常不是每句话即时落库。
- **视频读取失败**：检查标准链接、长度、ffmpeg、cookies 和图片模型。没有字幕且没有 STT 时只能看到抽样画面。
- **不主动聊天**：检查总开关、暂停、免打扰、每日次数、连续未回复计数和电脑休眠状态。重启不重置预算。
- **内容服务连接失败**：检查 OpenBiliClaw 地址、推荐列表和令牌环境变量；远程 HTTP 地址不允许传送令牌，须使用 HTTPS。
