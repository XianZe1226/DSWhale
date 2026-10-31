# 上游与参考项目

DSWhale 原创代码：AGPL-3.0-only，完整文本见 LICENSE。依赖保留各自许可证，不因组合安装而改为 DSWhale 的许可证。

| 项目 | 用途 | 集成方式 |
| --- | --- | --- |
| [AstrBot 4.29.3](https://github.com/AstrBotDevs/AstrBot) | 聊天框架、OneBot、模型与插件生命周期 | PyPI 依赖，AGPL-3.0 |
| [LivingMemory 2.8.2](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/tree/a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec) | 长期记忆 | 安装时从上游下载并校验 SHA-256，AGPL-3.0 |
| [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw) | 视频候选 | 用户独立运行，经 HTTP API 连接 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 视频提取 | PyPI 依赖；源代码 Unlicense，部分分发依赖另有条款 |
| [FFmpeg](https://ffmpeg.org/legal.html) | 抽帧与音频 | 复用本机工具或在首次准备时下载固定构建；具体构建依 LGPL/GPL 及编译选项，保留下载包内许可证 |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 普通 QQ OneBot 接入 | 用户独立安装；自定义 Limited Redistribution License，项目不包含其代码或安装包 |
| [httpx](https://github.com/encode/httpx)、[filelock](https://github.com/tox-dev/filelock)、[tzdata](https://github.com/python/tzdata) | HTTP、进程锁、跨平台时区 | 独立 PyPI 依赖 |

产品思路参考：[dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot)、[dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)、Yuuyuko-uu 的 [memory](https://github.com/Yuuyuko-uu/dsh-fish-memory)、[speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up)、[bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent)、[qq-bridge](https://github.com/Yuuyuko-uu/dsh-qq-bridge)、[tts-bridge](https://github.com/Yuuyuko-uu/dsh-tts-bridge)、[mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood)。除下述已明确集成的 dsh-bili-whale 外，其余参考插件不作为 DSWhale 的直接依赖或随包分发。

LivingMemory 下载固定到提交 `a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec`；ZIP SHA-256：`98210c85e9d7fbc3b730632a1d00e8a96a908206bc3c4cdc6124b253838a6443`。首次安装的校验失败会停止安装，不回退到未经校验的最新分支。已有版本保留不覆盖；用户主动检查更新时，使用上游稳定发行版解析出的固定提交，更新收据保存提交和下载摘要，详见 [插件管理](docs/extensions.md)。GitHub 如重新生成不同字节的归档，需要维护者重新审查并更新摘要。

## B站集成组件

- **dsh-bili-whale 0.4.6**，作者 **ALTERSSSS**，MIT，固定提交 `8b0009f8ce2ebdc421afcb2e727b19ac18912ec6`。原 `lib`、`tools`、测试及完整 [LICENSE](dswhale/bili_bridge/upstream/LICENSE) 随源码保留；本地路径、QQ 分享和测试适配记录见 [UPSTREAM.md](dswhale/bili_bridge/UPSTREAM.md)。这部分代码没有改署为 DSWhale 作者，MIT 声明必须随再分发保留。感谢原作者的工具链、作息、互动与安全保护实现。
- **React / ReactDOM 18.3.1**（Meta 及贡献者）、**qrcode 1.5.4**（node-qrcode 贡献者）：MIT，安装时通过 npm 固定锁文件下载；包内许可证保持原样，不把 node_modules 放进源码包。
- **Node.js 22.23.4**：Node.js 项目及贡献者，MIT 和随分发附带的第三方声明；安装器从官方站点下载原包并校验摘要，保留其 LICENSE。
- **uv 0.13.5**：Astral，MIT / Apache-2.0；桌面环境从官方固定版本归档下载并校验摘要。Python、FFmpeg、QQ 与 NapCat 均保留自己的许可证与使用条款，不被本项目许可证覆盖。
- Mac 双开说明参考 NapNeko/NapCat-Mac-Installer；本仓库的启动辅助脚本不包含 QQ、NapCat 安装包，也不随源码分发用户电脑的加载器或配置。

项目不是 B站、腾讯、DeepSeek 或上述上游的官方产品，不声称获得它们的认可。再分发时请保留源代码、版权声明与各自许可证；代码许可不等于获得视频内容或平台账号的再分发授权。

## 桌面组件

- **Electron 45.1.0**：Electron 项目及贡献者，MIT；随应用分发的 Chromium、V8 等组件保留 Electron 运行时自带的 LICENSE 和 LICENSES.chromium.html。
- **electron-builder 26.18.0**：electron-userland 及贡献者，MIT，仅用于构建。
- 桌面鲸鱼图标为 DSWhale 原创几何图形，源文件位于 `desktop/assets/icon.svg`，与本项目按 AGPL-3.0-only 分发；不是腾讯、B站或上游项目商标。
- 可移植 FFmpeg 构建的下载来源、版本和摘要固定在 `dswhale/media_assets.json`；安装时保留上游包内许可证。媒体工具按其构建许可证分发，与 DSWhale 源码许可证分别适用。

## 聊天与 QQ 互动

- 回复协议清理的匹配规则改编自 [zexuanw958-svg/dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack) 的 `astrbot_plugin_dafeiyu_clean`，MIT。DSWhale 增加了代码围栏保护、流式分片处理和助手记录清理；未导入该项目的人格、配置包或私人数据。原版权与许可全文保留如下。
- QQ 空间纯文字请求格式参考 [diaomin66/astrbot_plugin_qzone_ultra](https://github.com/diaomin66/astrbot_plugin_qzone_ultra/tree/4221713b508bf2a88e43e75d1719458d2f69764f)（MIT）的协议行为。DSWhale 实现有限客户端及独立的草稿确认、限额和发送状态记录；不包含该插件的源码、界面或素材。
- 可选的 [astrbot_plugin_meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager) 由 anka-afk 及贡献者开发，MIT，用户主动安装时从上游获取并保留其许可证。资源包和图片另按各自授权使用。

### dafeiyu-config-pack — MIT

```text
MIT License

Copyright (c) 2026 zexuanw958-svg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
