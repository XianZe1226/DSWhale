# 配置指南

完成[桌面安装](desktop.md)后，在「环境」准备依赖，点击启动服务，再按顺序配置。常用 QQ 绑定、OneBot 端口和访问令牌可在应用内填写；模型、记忆和高级配置通过同一窗口里的 AstrBot 页面完成。旧式终端部署的管理页面地址以启动日志为准，默认端口为 `6185`。

## 连接 QQ

先在「QQ 连接」选择接入方式。只有一台电脑、优先使用官方接口时，选择 [QQ 官方机器人](qq-official.md)：通过内置 AstrBot 扫码创建，使用消息列表私聊的完整会话 ID 绑定，不需要 NapCat 或普通 QQ 小号。

需要 OneBot、签名或 QQ 空间功能时，选择 [NapCat 普通 QQ 小号](qq-napcat.md)。Windows 可由应用准备独立组件；macOS / Linux 的协议端由自己维护。

两种方式的完整首次引导包含账号准备、登录、绑定、模型、权限和排错。请先选一种完成消息往返，再开启主动功能。

## 添加模型

在 AstrBot「模型提供商」中添加服务地址、密钥和具体模型，保存其 Provider ID。

| 模型 | 用途 | 要求 |
| --- | --- | --- |
| 聊天模型 | 私聊、主动聊天、工具调用 | 支持工具调用 |
| 图片模型 | 视频抽样画面理解 | 支持图片输入 |
| Embedding 模型 | 长期记忆检索 | 用于 LivingMemory，维度应与配置一致 |
| STT，可选 | 语音与无字幕视频转写 | 配置 AstrBot 语音识别服务 |
| TTS，可选 | 语音回复 | 配置 AstrBot 语音合成服务 |

DSWhale 的 `vision_provider_id` 填图片模型的完整 Provider ID，可从管理页面复制。它与 AstrBot 全局「图片转述模型」设置独立。API 兼容性不等于模型支持图片，添加后应先测试图片输入。

## 配置长期记忆

1. 启用 `astrbot_plugin_livingmemory`，填写 Embedding Provider ID、整理记忆用的 LLM Provider ID 和语言。
2. 打开插件的 Pages → dashboard → 设置，将记忆作用域设为 `session`。
3. 启用 `agent_tools.enable_recall_tool`，保存并重载插件。
4. 在控制台查看记忆整理和检索状态。若使用 `/lmem status`，需先在 AstrBot「配置文件 → 访问控制 → 管理员 ID」中添加当前接入方式的用户标识：NapCat 使用数字 QQ 号，官方机器人使用 `/fish whoami` 返回的 OpenID，并重启宿主。

记忆按整理策略入库，不会逐条消息即时生成。更换 Embedding 模型或维度前，请按 LivingMemory 文档处理现有索引。

## 绑定用户

在「QQ 连接」按所选方式完成绑定：

- **QQ 官方机器人**：从 QQ 消息列表私聊发送 `/fish whoami`，将返回的完整「本会话」粘贴到「官方机器人私聊会话 ID」并保存。使用 OpenID，不填写数字 QQ 号，不使用频道私信。详见 [官方接入指南](qq-official.md)。
- **普通 QQ 小号 / NapCat**：填写接收消息的个人 QQ 号；源码或插件安装需同时填写 `owner_qq` 和 `/fish whoami` 返回的 `owner_umo`。详见 [NapCat 指南](qq-napcat.md)。

图片模型通过 `vision_provider_id` 选择；`persona` 留空使用内置大肥鱼人格，也可填写自己的对话风格。保存并重载插件后，在绑定的私聊发送 `/fish status` 检查状态。宿主人格与插件人格应保持一致，避免对话风格冲突。

## 视频读取

使用标准视频页面链接：

```text
/fish watch https://www.bilibili.com/video/BVxxxxxxxxxx
/fish watch https://www.douyin.com/video/视频ID
```

示例中的 ID 需替换为真实视频 ID。`b23.tv`、`v.douyin.com` 等短链接应先在浏览器打开，再复制标准视频页地址。直播和合集链接不受支持。

默认限制为 300 秒、80 MiB、6 帧、180 秒处理时间，可在插件配置中调整。字幕支持 JSON3、VTT 和 SRT；无字幕时可使用 STT，否则依据抽样画面分析。输出会标明实际读取的资料。

需要登录时，可将个人 Netscape 格式 Cookie 文件保存在项目外，再填写 `cookies_path`。Cookie 的有效性和视频访问权限由平台决定。

## 主动聊天

开启 `proactive_enabled`，保存并重载插件。默认设置如下：

| 配置 | 默认值 |
| --- | --- |
| 时区 | Asia/Shanghai |
| 免打扰 | 23:00–08:00 |
| 活动间隔 | 随机 120–240 分钟 |
| 每日上限 | 3 次尝试 |
| 连续未回复上限 | 2 次 |

失败同样计入活动次数。首次启动需要等待一个活动间隔，收到用户消息后重新计时；重启不会清空预算。`/fish pause` 暂停主动聊天和 B站活动，普通私聊仍可使用；`/fish start` 恢复活动。

自主选题推荐请继续配置 [B站功能](bilibili.md)。也可独立运行 [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw)，在 DSWhale 设置 `content_url` 后开启 `discover_enabled`。需要鉴权时，`content_token_env` 填环境变量名，令牌由启动环境提供。

## 接入现有 AstrBot

要求 AstrBot 4.29.3、Python 3.12、FFmpeg/ffprobe 和 Node.js 22。先停止宿主并备份，在运行 AstrBot 的 Python 环境中执行：

```bash
python -m pip install .
python -m dswhale install --astrbot-dir "AstrBot目录" --with-memory --node "Node可执行文件路径"
python -m pip install -r "AstrBot目录/data/plugins/astrbot_plugin_livingmemory/requirements.txt"
python -m dswhale doctor --astrbot-dir "AstrBot目录"
```

Windows 路径请使用双引号，例如 `"D:\Apps\AstrBot"`。已有 LivingMemory 不会被自动覆盖或降级。

也可在 AstrBot 导入 Release 提供的插件 ZIP。此方式仅安装 DSWhale，其他依赖需单独准备。B站功能启动时需能找到 Node 和 FFmpeg，可通过宿主环境变量或 `bili_node_path` 指定 Node。

## 连接排查

- QQ 不回复：检查 NapCat 登录账号、WebSocket 地址、端口和令牌，再确认 AstrBot 普通聊天是否正常。
- 无法绑定：重新运行 `/fish whoami`，复制完整会话 ID，不使用昵称或群 ID。
- 记忆不可用：检查插件状态、Embedding 维度、整理模型、`session` 作用域和回忆工具。
- 视频失败：检查链接格式、长度限制、Cookie、FFmpeg 和图片模型。

更多说明见 [运维文档](operations.md)。
