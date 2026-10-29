# 配置指南

完成 [Windows](windows.md) 或 [macOS](macos.md)安装后，启动 AstrBot，按顺序完成以下配置。管理页面地址以启动日志为准，默认端口为 `6185`。

## 连接 QQ

1. 按 [NapCat 官方文档](https://napneko.github.io/guide/boot/Shell)安装并登录机器人 QQ。机器人账号与使用者账号需互加好友。
2. 在 AstrBot 的「机器人」页面创建 `aiocqhttp (OneBot v11)` 平台。设置一个固定的平台 ID，例如 `qq-companion`。
3. 启用反向 WebSocket，监听地址设为 `127.0.0.1`，端口可使用 `6199`，并设置访问令牌。
4. 在 NapCat WebUI 中创建 WebSocket 客户端，地址填入：

```text
ws://127.0.0.1:6199/ws
```

5. 填入与 AstrBot 一致的访问令牌，保存并启用。确认连接成功后，向机器人发送一条普通私聊，检查能否回复。

以上配置适用于 AstrBot 和 NapCat 部署在同一台电脑的情况。若更改端口，两端应同步修改。管理页面和 OneBot 接口建议仅监听本机地址。

NapCat WebUI 默认端口通常为 `6099`，登录令牌见其启动日志。各 QQ 账号的网络配置独立，切换账号后需要重新核对。

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
4. 在控制台查看记忆整理和检索状态。若使用 `/lmem status`，需先在 AstrBot「配置文件 → 访问控制 → 管理员 ID」中添加使用者的数字 QQ 号，并重启宿主。

记忆按整理策略入库，不会逐条消息即时生成。更换 Embedding 模型或维度前，请按 LivingMemory 文档处理现有索引。

## 绑定用户

用常用 QQ 账号私聊机器人：

```text
/fish whoami
```

在 AstrBot「插件 → DSWhale → 配置」中填写：

| 配置项 | 内容 |
| --- | --- |
| `owner_qq` | 返回的数字 QQ 号 |
| `owner_umo` | 返回的完整私聊会话 ID，结构为 `平台ID:FriendMessage:QQ号` |
| `vision_provider_id` | 图片模型 Provider ID |
| `persona`，可选 | 自定义人格与对话风格；留空使用内置大肥鱼人格 |

保存并重载 DSWhale，发送 `/fish status` 检查状态。绑定同时校验 QQ、私聊类型和会话 ID，不支持用群会话替代。宿主人格与插件人格应保持一致，避免对话风格冲突。

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
