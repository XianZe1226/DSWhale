# 升级与回退

## 升级

1. 在 AstrBot 启动窗口按 Ctrl+C，等待退出。
2. 下载新版完整源码，覆盖程序文件，保留原目录中的 `.runtime`。
3. 运行 `Install.cmd`（Windows）或 `Install.command`（macOS）。
4. 安装完成后运行 Start，发送 `/fish status` 检查版本和连接状态。

安装器会先将 AstrBot 数据备份到 `.runtime/backups/before-upgrade-*.zip`，再更新依赖和插件代码。原插件代码保存在 `.runtime/astrbot/.dswhale-backups/`，模型配置、用户绑定、人格和记忆保留。

已有 LivingMemory 不会被自动覆盖或降级。升级该插件时，请遵循其上游文档。

## 恢复数据

先停止 AstrBot，再将命令中的备份文件名替换为实际文件。

Windows PowerShell：

```powershell
.\.runtime\venv\Scripts\python.exe -m dswhale restore --astrbot-dir .runtime/astrbot .runtime/backups/备份文件.zip
```

macOS：

```bash
.runtime/venv/bin/python -m dswhale restore --astrbot-dir .runtime/astrbot .runtime/backups/备份文件.zip
```

恢复前的数据会另存到 `.dswhale-backups`。数据备份包含聊天、密钥和记忆，应保存在受控位置。

## 回退程序

恢复数据不会回退 Python 包。需要回退时，在同一 Python 环境安装目标版本的 wheel，再安装对应版本的插件代码。保留数据副本，避免用旧版安装器覆盖新版本的记忆插件。

## 修改人格

在 DSWhale 配置中编辑 `persona`，保存后重载插件。已有聊天历史和 AstrBot 宿主人格也会影响回复，建议保持设置一致。人格调整不需要清空记忆库。
