# 上游与参考项目

DSWhale 原创代码：AGPL-3.0-only，完整文本见 LICENSE。依赖保留各自许可证，不因组合安装而改为 DSWhale 的许可证。

| 项目 | 用途 | 集成方式 |
| --- | --- | --- |
| [AstrBot 4.29.3](https://github.com/AstrBotDevs/AstrBot) | 聊天框架、OneBot、模型与插件生命周期 | PyPI 依赖，AGPL-3.0 |
| [LivingMemory 2.7.1](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/tree/b8aaaec2c1232ec2c86fce22cec066a0069018e0) | 长期记忆 | 安装时从上游下载并校验 SHA-256，AGPL-3.0 |
| [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw) | 视频候选 | 用户独立运行，经 HTTP API 连接 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 视频提取 | PyPI 依赖；源代码 Unlicense，部分分发依赖另有条款 |
| [FFmpeg](https://ffmpeg.org/legal.html) | 抽帧与音频 | 用户独立安装；具体构建依 LGPL/GPL 及编译选项 |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 普通 QQ OneBot 接入 | 用户独立安装；自定义 Limited Redistribution License，项目不包含其代码或安装包 |
| [httpx](https://github.com/encode/httpx)、[filelock](https://github.com/tox-dev/filelock)、[tzdata](https://github.com/python/tzdata) | HTTP、进程锁、跨平台时区 | 独立 PyPI 依赖 |

产品思路参考：[dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot)、[dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)、Yuuyuko-uu 的 [memory](https://github.com/Yuuyuko-uu/dsh-fish-memory)、[speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up)、[bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent)、[qq-bridge](https://github.com/Yuuyuko-uu/dsh-qq-bridge)、[tts-bridge](https://github.com/Yuuyuko-uu/dsh-tts-bridge)、[mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood)。上述插件不作为 DSWhale 的直接依赖或随包分发。

LivingMemory 下载固定到提交 `b8aaaec2c1232ec2c86fce22cec066a0069018e0`；ZIP SHA-256：`9f75add262ebd514112c5c0fa8bc75ea402578f814c70360939b02337acef44a`。校验失败会停止安装，不回退到未经校验的最新分支。GitHub 如重新生成不同字节的归档，需要维护者重新审查并更新摘要。
