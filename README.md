# DSWhale

[![Checks](https://github.com/XianZe1226/DSWhale/actions/workflows/ci.yml/badge.svg)](https://github.com/XianZe1226/DSWhale/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/XianZe1226/DSWhale?include_prereleases)](https://github.com/XianZe1226/DSWhale/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

基于 AstrBot 的 QQ AI 伙伴，支持长期记忆、主动聊天和视频内容理解。

[安装](#安装) · [配置指南](docs/setup.md) · [B站功能](docs/bilibili.md) · [常见问题](docs/operations.md) · [更新日志](https://github.com/XianZe1226/DSWhale/releases)

## 功能

- **QQ 私聊**：支持 QQ 官方机器人和 NapCat 普通 QQ 小号，可自定义人格和对话风格。官方模式无需 NapCat 或第二台电脑。
- **长期记忆**：使用 LivingMemory 记录偏好、近况和约定，支持在管理页面查看、纠正和删除。
- **桌面管理**：自动检测新版本，下载与安装由你确认；版本匹配、自动备份恢复和脱敏诊断集中在应用内；下载沿用系统网络，可配合 Clash 使用。
- **插件管理**：手动检查并独立更新 LivingMemory，可选安装表情包管理器，更新前自动备份。
- **QQ 互动**：NapCat 模式可按要求修改机器人签名，准备空间文字草稿，确认后发布。
- **主动聊天**：设置活动间隔、免打扰时段、每日次数和未回复上限。
- **视频理解**：读取 B站、抖音标准视频链接，结合字幕、评论和抽样画面生成摘要。
- **B站养鱼**：接入 dsh-bili-whale 的选题、作息、日记和推荐功能，可通过 QQ 或 B站私信分享视频。
- **语音**：使用 AstrBot 的语音识别和语音合成服务。

可以直接在 QQ 中说“去 B站找个科技视频，回来聊聊”。收到推荐后，再问“这个视频讲了什么”，鱼会根据已保存的笔记继续回答。

## 安装

下载对应系统的 [桌面安装包](https://github.com/XianZe1226/DSWhale/releases)，安装后打开 **DSWhale**，在「环境」中点击准备，再在同一个窗口连接 QQ、配置模型和长期记忆。首次准备需要联网；QQ 官方机器人或普通 QQ 小号二选一，模型账号由你独立提供。

| 支持平台 | 下载文件 | 安装指南 |
| --- | --- | --- |
| Windows 10 22H2 / 11，64 位 Intel / AMD | `DSWhale-版本-Windows-x86_64-setup.exe` | [Windows](docs/windows.md) |
| macOS 13+，Apple Silicon | `DSWhale-版本-macOS-arm64.dmg` | [macOS](docs/macos.md) |
| Ubuntu 22.04 / 24.04 桌面，64 位 Intel / AMD | `DSWhale-版本-Linux-x86_64.deb` | [Linux](docs/linux.md) |

本版不提供 Intel Mac、32 位 Windows 或 Linux ARM 安装包。桌面安装器优先复用兼容环境，缺少的 Python、Node.js 和媒体工具安装到应用自己的数据目录，不要求安装整套开发环境。请预留至少 6 GB 空间，视频缓存另计。

应用、环境准备、服务启停和设置集中在一个窗口；模型、记忆和 B站高级页面也在窗口内打开。桌面包不会安装或修改你的 QQ，也不会下载本地大模型或 CUDA。模型调用可能产生服务商费用。

**0.3 预览版**：默认 Windows 包没有可信发布者签名，Mac 包只有本地临时签名、没有 Apple 公证。若某次构建使用了正式证书，发布页会单独注明；请核对来源与随包 SHA-256。安装提示与数据位置见 [桌面使用指南](docs/desktop.md)。

## 第一次连接 QQ

先在「QQ 连接」选择一种方式：

| 方式 | 适合谁 | 需要准备 | 完整指南 |
| --- | --- | --- | --- |
| QQ 官方机器人 | 一台电脑上同时使用个人 QQ 和大肥鱼，优先使用平台官方接口 | 在内置 AstrBot 控制台扫码创建或接入已有官方机器人 | [官方机器人首次使用](docs/qq-official.md) |
| 普通 QQ 小号 / NapCat | 需要修改个人 QQ 签名、发布 QQ 空间等 OneBot 功能 | 独立机器人小号；Windows 可由应用准备组件，Mac/Linux 自行维护协议端 | [NapCat 首次使用](docs/qq-napcat.md) |

**官方方式**：选择接入方式 → 启动 → 内置「机器人」页面扫码创建 → 在 QQ 私聊发送 `/fish whoami` → 复制完整会话 ID 绑定 → 配置模型 → 发送消息验收。密钥只在本机控制台保存，普通 QQ 号不能代替官方 OpenID。

**NapCat 方式**：选择接入方式 → 填个人 QQ 号 → 准备组件/外部服务 → 启动 → 登录机器人小号 → 应用消息连接 → 配置模型 → 发送消息验收。不要把个人大号登录进机器人组件。

两种方式都支持主人私聊、长期记忆、视频理解。官方模式的主动聊天和推荐受官方权限及消息限制约束，提交不等于送达，结果不明确时不自动重发；签名和 QQ 空间仅在 NapCat 模式提供。两种绑定分别保存，不自动合并聊天和记忆。

已有 AstrBot 可继续使用 [插件安装](docs/setup.md#接入现有-astrbot)。需要终端部署或旧式脚本的用户可查看各系统指南中的高级方式；源码 ZIP 不是桌面安装器。

## 配置

首次使用按以下顺序完成：

1. [连接 QQ](docs/setup.md#连接-qq)：选择官方接口或 NapCat，并绑定自己的私聊。
2. [添加模型](docs/setup.md#添加模型)：聊天模型用于对话和工具调用，图片模型用于理解抽样画面。
3. [启用长期记忆](docs/setup.md#配置长期记忆)：设置 Embedding、整理模型和会话作用域。
4. [绑定用户](docs/setup.md#绑定用户)：用 `/fish whoami` 获取 QQ 号和会话 ID，填写插件配置。
5. [开启 B站功能](docs/bilibili.md)：登录 B站账号，设置偏好、活动时间和推荐渠道。

主动聊天默认关闭。B站私信监听、自动私信和公开互动分别配置，详见 [B站设置](docs/bilibili.md)。

QQ 签名与空间功能也需单独开启，使用方法见 [QQ 互动](docs/qq-social.md)。LivingMemory 和表情包插件可在「模型与记忆」中手动检查、更新，详见 [插件管理](docs/extensions.md)。

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
| `/fish signature <签名>` | 按本条消息修改机器人签名 |
| `/fish qzone-draft <内容>` | 创建空间文字草稿 |
| `/fish qzone-publish <草稿ID>` | 确认发布指定草稿 |
| `/fish qzone-cancel <草稿ID>` | 取消未发布的草稿 |
| `/fish social-pending` | 查看待发布草稿和未确认的互动 |

## 使用说明

- 本项目以本地进程运行。对话服务需要保持在线；NapCat 模式还需要协议端运行，电脑关机或休眠后主动任务会停止。
- 默认视频处理上限为 300 秒、80 MiB。视频摘要基于可获取的字幕和抽样画面，不代表完整观看。
- 抖音目前支持标准视频链接读取，尚不支持主动浏览推荐流。短链接需先转换为标准视频页地址。
- 普通 QQ 接入依赖 NapCat，可能受到平台风控影响；请使用独立机器人账号。官方接口无需协议注入，也仍需遵守平台权限、消息与内容规则。
- 账号凭据、模型密钥和聊天数据应妥善保管。数据位置、访问范围及反馈要求见 [安全说明](SECURITY.md)。

维护文档：[应用更新与恢复](docs/updates.md) · [体检与排错](docs/troubleshooting.md) · [桌面使用指南](docs/desktop.md) · [升级与回退](docs/upgrading.md) · [诊断与数据管理](docs/operations.md) · [macOS QQ 双开](docs/qq-dual-login.md)

## 许可证与致谢

DSWhale 整合代码采用 [AGPL-3.0-only](LICENSE)。集成的 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 保留原作者署名和 MIT 许可证。

感谢 [AstrBot](https://github.com/AstrBotDevs/AstrBot)、[LivingMemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory)、[NapCat](https://github.com/NapNeko/NapCatQQ)、[yt-dlp](https://github.com/yt-dlp/yt-dlp)、[FFmpeg](https://ffmpeg.org/) 及相关项目的贡献。完整依赖与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

QQ、NapCat 和模型服务由用户独立获取，本项目与相关平台无官方隶属关系。欢迎通过 [Issues](https://github.com/XianZe1226/DSWhale/issues)反馈问题，参与开发请阅读 [贡献指南](CONTRIBUTING.md)。
