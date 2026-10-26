# 验证范围

版本：0.1.0a1。初版发布准备日期：2026-10-26。

## 人工实跑

已在 macOS 完成一次真实链路：QQ 小号 → NapCat → AstrBot → DSWhale → 聊天/图片模型，并配置 Embedding 与 LivingMemory 的 session 作用域、回忆工具和主人绑定。

已观察到 `/fish status` 回复、一次 `/fish watch` 视频观察、反向 WebSocket 连接与宿主重启后自动重连。该结果不等于所有模型、视频或账号都可用。

尚未完成的真实账号验收：主动活动实际到点触发、OpenBiliClaw 推荐、抖音、过期 Cookie/超长视频、STT/TTS、长期记忆跨会话召回与删除、不同 QQ 用户/群隔离，以及 Windows 10/11 真实 QQ 登录。

个人实跑原始记录不随源码或安装包分发。

## 自动化测试

覆盖配置和主人隔离、免打扰、预算与重启恢复、发送成功/失败/流式状态、过期事件、真实 AstrBot SDK 类型与钩子、LivingMemory 只读自主活动、真实 ffmpeg 提取、SRT/VTT/JSON3、子进程取消、资源上限、BOM 配置、安装更新、归档校验和备份恢复。

外部 QQ、模型和视频 HTTP 端点使用测试替身；实际运行的依赖包括 AstrBot 4.29.3、Python 3.12、ffmpeg，以及校验过的 LivingMemory 2.7.1 源码集成测试。测试不需要个人密钥或账号。

GitHub Actions 配置 Linux、macOS 和 Windows，并在 Windows 执行 PowerShell 5.1 安装入口检查和干净目录安装。CI 的 Windows 服务器环境验证代码与安装兼容性，不能替代 Windows 10/11 的 QQ 账号实机验收；具体运行结果以仓库 Actions 为准。

## 用户验收顺序

1. 先确认 AstrBot 自身能在主人 QQ 私聊中回复。
2. 绑定 DSWhale，确认图片模型与记忆插件状态；必要时配置管理员 UID 后重启。
3. 观察一条真实短视频并核对证据范围。
4. 表达一个可验证偏好，等待 LivingMemory 整理，在控制台核对来源，再测试召回/纠正/删除。
5. 用少量活动和至少 5 分钟间隔测试暂停、免打扰、未回复停止、收到主人消息重新计时；之后恢复默认频率。
6. 关闭宿主后备份与恢复，核对记忆、配置和预算；不要用唯一的数据副本做试验。

宿主包含一条 `audioop` 弃用提示，因此安装器固定 Python 3.12，不自动切换到 3.13。
