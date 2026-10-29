# DSWhale

[![Checks](https://github.com/XianZe1226/DSWhale/actions/workflows/ci.yml/badge.svg)](https://github.com/XianZe1226/DSWhale/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/XianZe1226/DSWhale?include_prereleases)](https://github.com/XianZe1226/DSWhale/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

基于 AstrBot 的 QQ AI 伙伴，支持长期记忆、主动聊天和视频内容理解。

[安装](#安装) · [配置指南](docs/setup.md) · [B站功能](docs/bilibili.md) · [常见问题](docs/operations.md) · [更新日志](https://github.com/XianZe1226/DSWhale/releases)

## 功能

- **QQ 私聊**：通过 NapCat 接入普通 QQ 账号，可自定义人格和对话风格。
- **长期记忆**：使用 LivingMemory 记录偏好、近况和约定，支持在管理页面查看、纠正和删除。
- **主动聊天**：设置活动间隔、免打扰时段、每日次数和未回复上限。
- **视频理解**：读取 B站、抖音标准视频链接，结合字幕、评论和抽样画面生成摘要。
- **B站养鱼**：接入 dsh-bili-whale 的选题、作息、日记和推荐功能，可通过 QQ 或 B站私信分享视频。
- **语音**：使用 AstrBot 的语音识别和语音合成服务。

可以直接在 QQ 中说“去 B站找个科技视频，回来聊聊”。收到推荐后，再问“这个视频讲了什么”，鱼会根据已保存的笔记继续回答。

## 安装

| 平台 | 安装指南 | 安装 / 启动 |
| --- | --- | --- |
| Windows 10/11 x64 | [Windows](docs/windows.md) | `Install.cmd` / `Start.cmd` |
| macOS 12+，Intel / Apple Silicon | [macOS](docs/macos.md) | `Install.command` / `Start.command` |

1. 从 [Releases](https://github.com/XianZe1226/DSWhale/releases) 下载 `DSWhale-版本号-source.zip`，解压到固定目录。
2. 运行对应平台的安装脚本。安装器会准备 Python、AstrBot、LivingMemory、Node.js 和 B站页面依赖。
3. 运行启动脚本，按 [配置指南](docs/setup.md)连接 QQ，并设置模型、记忆和用户绑定。

首次安装需要联网，建议预留 6 GB 可用空间。缺少 FFmpeg 时，安装器通过 WinGet 或 Homebrew 安装；前置工具的准备方法见分平台指南。QQ 和 B站账号需扫码登录，模型服务需自行配置。

已有 AstrBot 的用户可使用插件 ZIP，安装方法见 [接入现有 AstrBot](docs/setup.md#接入现有-astrbot)。插件 ZIP 不包含宿主和外部依赖。

> 当前版本为预览版，配置项和功能可能调整。升级前请备份数据。

## 配置

首次使用按以下顺序完成：

1. [连接 QQ](docs/setup.md#连接-qq)：配置 AstrBot 与 NapCat 的反向 WebSocket。
2. [添加模型](docs/setup.md#添加模型)：聊天模型用于对话和工具调用，图片模型用于理解抽样画面。
3. [启用长期记忆](docs/setup.md#配置长期记忆)：设置 Embedding、整理模型和会话作用域。
4. [绑定用户](docs/setup.md#绑定用户)：用 `/fish whoami` 获取 QQ 号和会话 ID，填写插件配置。
5. [开启 B站功能](docs/bilibili.md)：登录 B站账号，设置偏好、活动时间和推荐渠道。

主动聊天默认关闭。B站私信监听、自动私信和公开互动分别配置，详见 [B站设置](docs/bilibili.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/fish whoami` | 获取 QQ 号和完整私聊会话 ID |
| `/fish status` | 查看插件状态、活动预算和最近任务 |
| `/fish start` / `/fish pause` | 恢复 / 暂停主动活动 |
| `/fish watch <视频链接>` | 读取视频并说明内容来源 |
| `/fish journal` | 查看最近的视频观察记录 |
| `/fish bili` | 查看 B站服务与私信监听状态 |
| `/fish pending` | 查看待确认的 B站操作 |
| `/fish approve <ID>` | 确认执行指定操作 |
| `/fish voice <内容>` | 将文字转换为语音 |

## 使用说明

- 本项目以本地进程运行。AstrBot 和 NapCat 需要保持在线，电脑关机或休眠后主动任务会停止。
- 默认视频处理上限为 300 秒、80 MiB。视频摘要基于可获取的字幕和抽样画面，不代表完整观看。
- 抖音目前支持标准视频链接读取，尚不支持主动浏览推荐流。短链接需先转换为标准视频页地址。
- 普通 QQ 接入依赖 NapCat，可能受到平台风控影响；请使用独立机器人账号并遵守平台规则。
- 账号凭据、模型密钥和聊天数据应妥善保管。数据位置、访问范围及反馈要求见 [安全说明](SECURITY.md)。

维护文档：[升级与回退](docs/upgrading.md) · [诊断与数据管理](docs/operations.md) · [macOS QQ 双开](docs/qq-dual-login.md)

## 许可证与致谢

DSWhale 整合代码采用 [AGPL-3.0-only](LICENSE)。集成的 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 保留原作者署名和 MIT 许可证。

感谢 [AstrBot](https://github.com/AstrBotDevs/AstrBot)、[LivingMemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory)、[NapCat](https://github.com/NapNeko/NapCatQQ)、[yt-dlp](https://github.com/yt-dlp/yt-dlp)、[FFmpeg](https://ffmpeg.org/) 及相关项目的贡献。完整依赖与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

QQ、NapCat 和模型服务由用户独立获取，本项目与相关平台无官方隶属关系。欢迎通过 [Issues](https://github.com/XianZe1226/DSWhale/issues)反馈问题，参与开发请阅读 [贡献指南](CONTRIBUTING.md)。
