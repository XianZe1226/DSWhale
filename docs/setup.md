# 安装与配置

首次安装请按 [README 的完整流程](../README.md#安装前准备)依次完成。该流程包括 Windows PowerShell 5.1、macOS、NapCat 小号/入口切换、反向 WebSocket、模型、Embedding、LivingMemory 管理员权限、主人绑定、视频与可选推荐设置。

## 安装到已有 AstrBot

要求 AstrBot 4.29.3、Python 3.12，以及 ffmpeg/ffprobe。先停止宿主并备份，切换到运行 AstrBot 的同一 Python 环境，在 DSWhale 源码目录运行：

```bash
python -m pip install .
python -m dswhale install --astrbot-dir "/完整路径/AstrBot" --with-memory
python -m pip install -r "/完整路径/AstrBot/data/plugins/astrbot_plugin_livingmemory/requirements.txt"
python -m dswhale doctor --astrbot-dir "/完整路径/AstrBot"
```

Windows 路径请使用双引号，例如 `"D:\Apps\AstrBot"`。已有 LivingMemory 保持原样，不自动降级或覆盖。安装完成后启动宿主，按 README 配置模型、主人和记忆。

也可在 AstrBot 导入发布的插件 ZIP；这种方式只安装 DSWhale。ffmpeg、LivingMemory、NapCat 以及可选 OpenBiliClaw 需独立安装。不要从不同源码目录向同一宿主反复安装不同版本。

## 连接排查

- AstrBot 管理页面：默认端口通常为 6185，以启动日志为准。
- NapCat WebUI：默认端口通常为 6099，以其控制台为准；核对登录的是机器人小号。
- 反向 WS 示例：AstrBot 监听 127.0.0.1:6199，NapCat 客户端连接 `ws://127.0.0.1:6199/ws`，双方令牌一致。
- macOS 可用 `lsof -nP -iTCP:6199` 检查连接；Windows 可用 `Get-NetTCPConnection -LocalPort 6199 -ErrorAction SilentlyContinue`。
- 端口结果、日志与页面链接可能包含本机信息或令牌，不要原样公开。
- `/lmem status` 权限不足时，在 AstrBot 管理员 ID 中添加主人 QQ UID，并重启宿主；或通过 LivingMemory 控制台查看。

视频读取失败请确认标准链接、长度、Cookie、ffmpeg 和真正支持图片的提供商。全局图片转述模型不是 DSWhale 的 `vision_provider_id`。
