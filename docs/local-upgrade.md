# 升级与回退

适用于从 0.1.x 或较早的 0.2.x 升级到 0.2.0a2。同一台电脑升级保留 `.runtime`；跨 Windows/Mac 换电脑请按 [迁移指南](migration.md)重新安装环境。运行数据、个人设定和完整备份始终不要上传 GitHub。

## 已有版本怎么升级

1. 在 AstrBot 启动窗口按 Ctrl+C，等其退出。**NapCat 和 QQ 不需要退出**。安装器遇到仍在运行的宿主会停止，避免一边聊天一边换代码。
2. 在这份完整源码的根目录双击 **Install.command / Install.cmd**。会先保存完整 `data` 到 `.runtime/backups/before-upgrade-*.zip`，再准备依赖、安装新版插件。旧插件代码另保留在 `.runtime/astrbot/.dswhale-backups/`。
3. 安装完成后双击 **Start.command / Start.cmd**，确认原 QQ 连接自动重连；用 `/fish status` 检查版本。已有模型、QQ 绑定、LivingMemory、人格、Cookie 与记忆继续使用原配置；新 B站整合默认关闭。
4. 按 [B站设置](bilibili.md) 开启整合并登录。先选 QQ 推荐，稳定后再开 B站私信。

安装器会优先复用可用 Node 22 和 FFmpeg，否则为 Node 下载固定版本并校验 SHA-256；uv 和 Python 自动准备，FFmpeg 通过 Homebrew/WinGet 安装。没有这些平台工具时会明确给前置安装链接，完成后重跑即可续装。依赖下载失败时旧插件不会被新插件替换；若 Python 依赖已更新但运行异常，按下面回退。

QQ 登录、模型密钥、B站扫码必须由账号本人完成，不能自动代填；安装器不改动现有 NapCat 安装。

## 回退

先停止 AstrBot。完整数据备份包含密钥、个人资料和记忆，务必私密保存。

macOS（把备份文件名替换为实际文件）：

```bash
.runtime/venv/bin/python -m dswhale restore --astrbot-dir .runtime/astrbot .runtime/backups/before-upgrade-实际时间.zip
```

Windows PowerShell：

```powershell
.\.runtime\venv\Scripts\python.exe -m dswhale restore --astrbot-dir .runtime/astrbot .runtime/backups/before-upgrade-实际时间.zip
```

恢复会保留恢复前的数据副本。若需把 Python 代码也退回初版，在同一环境使用初版 Release 的 wheel 重新安装；不要运行初版安装器去覆盖刚恢复的记忆插件。Node 工具可保留，不影响初版。

## 人格生效

DSWhale 配置里的 `persona` 只保存在本机运行目录。修改后在 AstrBot 插件列表重载 DSWhale，或按上面的停止/启动流程重启。聊天模型仍可能受已有宿主人格、旧历史和模型能力影响；先使用一致的宿主人格，保留真实记忆，观察几轮，不要清空记忆库来“修人设”。

日常私聊可要求 40 字内、不写动作旁白、不用句号、不句句追问；链接、工具结果与必要说明保留完整，当前是人格约束而不是粗暴截断。直接询问真实身份时应如实说明，记不清的共同经历不编造。个人姓名、学校、身体数据等只放本机私人设定，勿写进通用模板；使用云端模型时，这些设定会随对话发给你选择的模型服务。
