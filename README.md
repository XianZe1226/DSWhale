# DSWhale · 大肥鱼

一个基于 AstrBot 的开源 AI 陪伴项目：用普通 QQ 小号聊天，记住你的偏好，在合适的时间主动搭话，并读取 B 站或抖音视频后分享观察。

**初版：0.1.0a1（Alpha）。支持安装目标：Windows 10/11 x64、macOS。** macOS 已有一次真实 QQ、模型、记忆配置和视频观察的人工实跑；自动化测试与各平台验证范围见 [验证说明](docs/validation.md)。需要自己的模型服务、QQ 小号和本机持续运行的程序。

> **视频理解是抽样证据，不是逐帧看完整部视频。** 默认读取五分钟内的视频，结合可用字幕、抽样画面以及可选音频转写生成观察；输出会说明实际获取了哪些证据。站点登录、验证或提取失败时不会声称已经看过。

## 功能

| 功能 | 初版行为 |
| --- | --- |
| QQ 私聊陪伴 | 一个主人、一个普通 QQ 小号；复用 AstrBot 的人格、模型和会话 |
| 长期记忆 | LivingMemory 保存和召回真实聊天中的事实、偏好与约定；需要 Embedding 模型 |
| 主动聊天 | 默认关闭；支持免打扰、随机间隔、每日预算、未回复停止和持久化暂停 |
| 视频观察 | 手动提供 B 站/抖音标准视频页；字幕优先，图片模型理解抽样画面 |
| 自主找视频 | 可连接独立运行的 OpenBiliClaw 获取候选，再读取视频并通过 QQ 分享 |
| 视频日志 | 保存来源、观察和证据范围，临时视频文件处理后清理 |
| 可选语音 | 调用 AstrBot 的 STT/TTS；`/fish voice` 可生成语音 |
| 安装维护 | 独立 Python 环境、诊断、代码更新保留数据、完整备份恢复 |

自主活动只读个人长期记忆，避免把任务文字或视频剧情写成你的经历；它自己的视频观察保存在日志和宿主聊天历史里。

本项目是 **AstrBot 插件和安装工具**，不是 DSH 运行时。DSH 的 `dsh-*` 插件不能直接装入 AstrBot。当前不包含桌面鱼动画、自动点赞投币、评论区互动或 B 站私信通道。

## 安装前准备

- Windows 10/11 **x64**（建议使用仍有安全维护的系统配置）或 macOS；可用磁盘空间建议至少 2 GB。
- [uv](https://docs.astral.sh/uv/getting-started/installation/)：安装器用它自动管理 Python **3.12**，无需先单独安装 Python。
- [FFmpeg](https://ffmpeg.org/download.html)，含 `ffmpeg`、`ffprobe`，两者需能在终端找到。
- 机器人 QQ 小号；主人号与小号互加好友。普通 QQ 接入依赖用户独立安装的 [NapCat](https://napneko.github.io/guide/boot/Shell)。非官方接入可能受平台风控影响。
- 可用的聊天模型、支持图片的模型和 Embedding 模型。三个角色可以来自不同服务；模型 API 密钥只在你自己的 AstrBot 中填写。

安装代码本身不收费，模型服务可能按调用计费；QQ、B 站等第三方平台的规则与可用性由对应平台决定。

### Windows 10 / 11

1. 从 [Releases](../../releases) 下载 **完整源码 ZIP**，解压到一个固定目录，例如 `D:\Apps\DSWhale`。不要把源码包与仅供已有 AstrBot 使用的插件 ZIP 混淆。
2. 在 PowerShell 中准备依赖。系统已有 WinGet 时：

   ```powershell
   winget install --id astral-sh.uv --exact
   winget install --id Gyan.FFmpeg --exact
   ```

   Windows 10 若没有 `winget`，先安装/更新微软的 App Installer，或按 uv 官方安装文档与 FFmpeg 官方下载页手动安装。FFmpeg 解压后把包含两个 EXE 的 `bin` 目录加入用户 PATH。
3. **重新打开 PowerShell**，进入解压后的项目目录，确认：

   ```powershell
   uv --version
   ffmpeg -version
   ffprobe -version
   ```

4. 安装，再启动。支持系统自带 **Windows PowerShell 5.1**：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
   ```

   这里的 `Bypass` 只针对这次进程，不永久修改系统执行策略。路径中有空格时，切换目录使用 `Set-Location 'D:\你的目录\DSWhale'`。

### macOS

1. 下载完整源码 ZIP，解压到固定目录。已有 [Homebrew](https://brew.sh/) 时准备依赖：

   ```bash
   brew install uv ffmpeg
   ```

   没有 Homebrew 时先按其官网安装，或使用 uv/FFmpeg 官方提供的其他方式。
2. 在终端进入项目目录，执行：

   ```bash
   bash scripts/setup.command
   bash scripts/start.command
   ```

安装器创建 `.runtime/venv` 和 `.runtime/astrbot`，安装固定版本 AstrBot **4.29.3**、LivingMemory **2.7.1**。Python 已缓存时不会重复下载；已有 LivingMemory 不会被覆盖。首次安装需要联网。关闭终端、退出进程或电脑休眠后，主动任务也会停止。

## 首次配置：按顺序完成

### 1. 打开 AstrBot 管理页面

启动后查看终端日志中的管理地址，默认端口通常为 **6185**。在浏览器打开本机页面，完成初始登录/密码设置。不要使用未经确认的默认密码，也不要把带令牌的页面地址公开。

建议在 AstrBot 设置中把 Dashboard 监听地址设为 **`127.0.0.1`**，只供本机使用。默认安装有可能监听所有网络接口；不要直接暴露到公网。

### 2. 安装并登录 NapCat 小号

按照 [NapCat 官方安装说明](https://napneko.github.io/guide/boot/Shell)选择平台：

- **Windows**：官方手动版需先安装 QQ；Windows 10 使用 `launcher-win10.bat`，其他版本按对应包的启动说明。官方 OneKey 包可引导安装 QQ/NapCat，和手动版启动入口不同，不要混用。也可选择官方文档列出的 Windows 可视化管理工具。
- **macOS**：使用 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases)，切换 QQ 程序入口到 NapCat，再启动并扫码登录**机器人小号**。切换入口可能要求系统登录密码，应只在安装器的系统授权窗口输入。

**macOS 账号与入口注意事项：**安装器 v1.7 的原版 QQ/NapCat 共用程序入口；点击“启动原版 QQ”可能恢复原版入口，之后需要重新“切换程序入口 → NapCat”。QQ 的“最后登录账号”也可能被原版 QQ 改成主人号。每次启动后先核对 NapCat 当前账号，避免自动登录成主人号；各账号的 OneBot 网络配置彼此独立。

初次配置建议：电脑上让 NapCat 跑小号，主人号使用手机 QQ。新版安装器若提供独立双开，以对应正式版文档为准，不把未发布分支功能当作已安装能力。

NapCat WebUI 端口通常为 **6099**，按控制台提示使用本机令牌登录；每次打开要求重新输入令牌可能是正常行为。可在其设置中将监听地址限制为 `127.0.0.1`。

### 3. 连接 QQ：反向 WebSocket

1. AstrBot 左侧 **「机器人」→「创建机器人」**，平台类型选择 **`aiocqhttp (OneBot v11)`**。
2. 给平台填写固定 ID，例如 `qq-companion`。该 ID 会成为私聊会话 ID 的前缀，不必与示例一致。
3. AstrBot 配置反向 WebSocket 监听：本机地址 `127.0.0.1`、示例端口 `6199`，设置自己的访问令牌并启用。
4. NapCat 新建 **WebSocket 客户端 / 反向 WebSocket**，地址：

   ```text
   ws://127.0.0.1:6199/ws
   ```

   填入与 AstrBot 相同的令牌，保存并启用。若更改端口，地址也一起更改。
5. 确认两侧日志显示连接成功。主人号私聊小号，先验证 AstrBot 普通聊天能回复。宿主重启后 NapCat 应自动重新连接。

这里配置的是反向 WebSocket，不是 OneBot HTTP 服务。初版按同机部署编写，跨机器部署需要自行配置网络和访问控制。建议在 AstrBot 限制响应对象，关闭暂时不需要的群聊响应。

### 4. 配置聊天、图片与 Embedding 模型

在 AstrBot **「模型提供商」** 页面新增来源、填写服务地址和密钥，再添加具体模型。随后启用并选择相应提供商：

| 角色 | 配置位置与要求 |
| --- | --- |
| 聊天模型 | AstrBot 会话使用的模型；需要支持工具调用，可用 DeepSeek 或其他兼容服务 |
| 图片模型 | 确认具体模型真正支持图片输入；把其**完整提供商 ID**填到 DSWhale 的 `vision_provider_id` |
| Embedding | 在 AstrBot 新增 Embedding 提供商；记录其 ID、模型与维度，用于 LivingMemory |
| STT（可选） | AstrBot 的语音转文字提供商；无字幕视频可用它转写音频 |
| TTS（可选） | AstrBot 的文字转语音提供商；给 `/fish voice` 使用 |

例如模型 ID 可能是 `来源ID/模型ID`，应从你的界面原样复制，不是模型显示名称。服务声称兼容 OpenAI API 不代表每个模型支持图片。

AstrBot 的全局 **「图片转述模型」**是另一项设置，不等于 DSWhale 的 `vision_provider_id`。不要用只支持文本的聊天模型冒充图片模型。

### 5. 配置 LivingMemory

1. 确认插件列表里 `astrbot_plugin_livingmemory` 已启用。
2. 在插件配置页填写 **Embedding Provider ID**、记忆整理用的 **LLM Provider ID** 和语言。Embedding 维度应与实际模型一致；更换模型后按上游文档重建索引。
3. 高级设置在 **插件页面 → Pages → dashboard → 设置**，不是仅有 Provider 的插件配置表单。
4. 在顶部“常用设置”把 **记忆作用域模式设为 `session`**；确认 **`agent_tools.enable_recall_tool`** 开启。
5. 保存后按界面要求重载插件。

`/lmem status` 属于管理员命令。使用它之前，在 AstrBot **「配置文件 → 访问控制 → 管理员 ID」**把主人 QQ 的 **UID（数字 QQ 号）**加入 `admins_id`，保存并重启 AstrBot。不要填 UMO、昵称或机器人的 QQ。也可直接在 LivingMemory 控制台的系统概览查看状态。

真实聊天积累到整理条件后才生成长期记忆，不保证每句话即时入库。请在管理页面核对内容与来源，并测试纠正/删除功能。避免同时启用其他主动聊天插件调度同一条会话。

### 6. 绑定主人和图片模型

用主人 QQ 私聊小号：

```text
/fish whoami
```

在 DSWhale 插件配置填写返回值：

- `owner_qq`：你的主人 QQ 数字。
- `owner_umo`：完整私聊 UMO，原样复制；结构为 `平台ID:FriendMessage:主人QQ`。
- `vision_provider_id`：上一步配置的图片模型完整提供商 ID。

保存并重载 DSWhale，再发送 `/fish status`。绑定要求 QQ、私聊和完整 UMO 同时匹配，不能填群会话。`/fish whoami` 返回的个人信息只在你自己的配置里使用，不要截图提交 issue。

### 7. 观察一条视频

提供真实的标准视频页面：

```text
/fish watch https://www.bilibili.com/video/BVxxxxxxxxxx
/fish watch https://www.douyin.com/video/数字视频ID
```

以上是格式占位示例，需替换为真实链接。分享短链 `b23.tv` / `v.douyin.com`、直播和合集暂不支持；先在浏览器打开短链，再复制标准视频页。

默认限制：**300 秒、80 MiB、6 帧、180 秒总处理时间**。字幕支持 JSON3、VTT、SRT；无字幕时可使用 STT，否则只分析抽样画面。均匀抽帧可能错过细节，不能用于需要完整内容保证的任务。

需要登录的视频可使用你自己的 **Netscape 格式 Cookie 文件**：保存在项目目录外，把绝对路径填入 `cookies_path`。DSWhale 使用临时副本，不修改原文件。不要将 Cookie 上传 GitHub、贴进群聊或 issue。验证、地区、权限或提取器变化都可能导致失败；工具不会绕过这些限制。

### 8. 开启主动聊天和可选推荐

确认前面都正常后，开启 `proactive_enabled`，保存并重载。

默认北京时间 **23:00–08:00** 安静；活动间隔 **120–240 分钟**；每日最多 **3 次尝试**；连续 **2 次未收到主人回复**就停下。失败同样占用预算，重启不清空。首次活动要等待完整间隔；在安静时段启用不会立即发消息。收到主人的真实消息后会重新计时。

需要自己找视频时，另外安装运行 [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw)，按上游文档配置来源、兴趣与推荐：

- DSWhale `content_url` 默认 `http://127.0.0.1:8420`，读取 `/api/recommendations` 的 `items`。
- 若需要访问令牌，在启动终端设置 `DSWHALE_OBC_TOKEN` 环境变量；`content_token_env` 填的是变量名，不是令牌本身。
- 确认推荐列表有内容，再打开 `discover_enabled`。每次活动选一条近期未尝试的视频，读取证据后通过当前 QQ 私聊分享。
- 推荐服务失败不等于已经看过视频；它会记录失败尝试，避免重复请求。

## 日常命令

| 命令 | 用途 |
| --- | --- |
| `/fish whoami` | 获取本人的私聊绑定信息 |
| `/fish status` | 查看开关、预算、记忆插件和最近投递状态 |
| `/fish start` / `/fish pause` | 解除/启用主动活动暂停；不改变配置页总开关 |
| `/fish watch 标准链接` | 读取视频并说明证据范围 |
| `/fish journal` | 最近三条观察记录 |
| `/fish voice 内容` | 使用配置好的 TTS 生成语音 |
| `/lmem status` | LivingMemory 状态，需要 AstrBot 管理员权限 |

“已提交给 QQ”不代表用户已读；发送结果不明确时不自动重发。暂停状态、预算和日志会持久化。

## 诊断、备份和升级

以下命令在项目根目录运行；`python` 应替换为安装环境里的 Python：macOS 用 `.runtime/venv/bin/python`，Windows 用 `.runtime/venv/Scripts/python.exe`。

```text
python -m dswhale doctor
python -m dswhale doctor --json
python -m dswhale backup "项目外的安全目录/backup.zip"
python -m dswhale restore "项目外的安全目录/backup.zip"
```

诊断兼容 AstrBot 的 UTF-8 BOM 配置，不打印账号、密钥或 Cookie。它检查本地依赖和配置，不验证远程账号是否在线。**备份/恢复前停止 AstrBot**；备份包含完整 `data`，包括聊天、记忆和密钥，必须私密保存，不能作为 issue 附件。

更新代码前先备份，关闭宿主，再运行新版 setup。插件代码的旧版本保留在宿主 `.dswhale-backups`，配置与记忆不被删除。不要用删除 `.runtime` 的方式升级。详细维护与数据位置见 [运维文档](docs/operations.md)。

已有 AstrBot 的安装方法见 [独立插件安装](docs/setup.md#安装到已有-astrbot)。常见离线原因：NapCat 登录错账号、macOS 入口被切回原版、反向 WS 令牌不一致、主人 UMO 错误、未配置图片模型、主动活动仍在免打扰/等待间隔。

## 许可证、致谢与边界

DSWhale 原创整合代码采用 **AGPL-3.0-only**，见 [LICENSE](LICENSE)。感谢 [AstrBot](https://github.com/AstrBotDevs/AstrBot)、[LivingMemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory)、[OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw)、[yt-dlp](https://github.com/yt-dlp/yt-dlp)、[FFmpeg](https://ffmpeg.org/)、[uv](https://github.com/astral-sh/uv) 及大肥鱼社区的工作；完整来源与各自许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

NapCat/QQ 由安装者从各自官方渠道独立获取；本项目不重新分发或修改它们的程序。第三方项目保留各自许可证、商标和署名；本项目与腾讯、哔哩哔哩、抖音、DeepSeek 等无官方隶属或背书关系，不提供模型服务或账号权限。

请只处理有权访问的内容，遵守平台规则；不得用于骚扰、刷量、绕过验证码或公开他人私聊。软件按许可证“现状”提供。提交问题前遵循 [隐私与安全说明](SECURITY.md)，只提供脱敏信息。

开发、测试和打包见 [CONTRIBUTING.md](CONTRIBUTING.md)。
