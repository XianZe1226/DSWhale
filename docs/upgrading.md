# 升级与回退

## 桌面应用升级

1. 在应用里停止服务，使用备份功能保存数据。
2. 从项目 Release 下载同一系统和架构的新版安装包并安装；Mac 替换「应用程序」中的 DSWhale，Linux 使用新版 `.deb`。
3. 重新打开应用，在「环境」执行准备或更新，再启动服务检查连接。

桌面程序与数据分开保存，应用升级不会覆盖个人配置、账号、记忆或备份；本版不自动下载更新。数据的实际位置可从应用内打开，默认路径见[桌面指南](desktop.md#数据保存在哪里)。请不要把旧式 `.runtime` 直接覆盖到正在运行的桌面环境。

桌面应用可在「设置」中导入自己的 DSWhale ZIP 备份，操作步骤见下节。回退程序前保留完整数据副本；旧版依赖可能无法读取新版数据。

## 从 0.2 源码部署迁移到桌面应用

通过备份导入可保留原有模型配置、用户绑定、人格、聊天记录、长期记忆和插件状态。桌面应用不会自动扫描或导入电脑上的旧文件夹，原源码目录与 `.runtime` 会继续保留。

1. 停止旧版 AstrBot，使用旧运行环境中的 Python 创建备份。在旧源码目录执行以下命令，将保存位置替换为自己的路径：

   ```bash
   python -m dswhale backup --astrbot-dir ".runtime/astrbot" "备份目录/DSWhale-backup.zip"
   ```

   这里的 `python` 是旧环境的解释器：Windows 为 `.runtime/venv/Scripts/python.exe`，macOS / Linux 为 `.runtime/venv/bin/python`。备份文件不能已存在，也不能保存在被备份的 `data` 内。

2. 安装并打开桌面应用，先在「环境」完成准备，再进入「设置」导入刚才生成的 ZIP。请只选择自己信任的 DSWhale 备份，备份包含账号凭据与密钥。
3. 导入会先停止桌面服务，自动备份当前数据，再恢复所选备份并重新准备插件与依赖。完成后服务保持停止，便于先核对配置；不要在此期间启动旧宿主。
4. 检查使用者 QQ、平台 ID、OneBot 端口与令牌，确认模型服务及凭据仍有效。核对人格、聊天和记忆配置，并检查指向旧目录的 Cookie 或其他外置文件路径。
5. 保持原有 Embedding 模型、维度与记忆作用域不变，确认长期记忆正常后再考虑调整。启动桌面服务，检查 QQ 与 B站连接，发送 `/fish status` 确认状态。

备份包含 AstrBot 的 `data`，不包含外置 Cookie、NapCat 登录目录或独立服务数据；这些内容需要自行保留，并更新相应路径或连接设置。QQ / NapCat 和 B站账号仍按各自方式独立登录。

桌面导入支持 DSWhale 自身生成的普通 ZIP 备份。加密归档需先用对应工具解密或导出为兼容备份，不能直接导入。导入失败时保留原备份与自动创建的备份，先处理提示的问题；不要直接复制或覆盖运行中的数据库。

## 高级：源码部署升级

1. 在 AstrBot 启动窗口按 Ctrl+C，等待退出。
2. 下载新版完整源码，覆盖程序文件，保留原目录中的 `.runtime`。
3. 运行 `Install.cmd`（Windows）或 `Install.command`（macOS）。
4. 安装完成后运行 Start，发送 `/fish status` 检查版本和连接状态。

安装器会先将 AstrBot 数据备份到 `.runtime/backups/before-upgrade-*.zip`，再更新依赖和插件代码。原插件代码保存在 `.runtime/astrbot/.dswhale-backups/`，模型配置、用户绑定、人格和记忆保留。

升级 DSWhale 不会覆盖或降级已有 LivingMemory。需要更新记忆插件时，在桌面应用「模型与记忆」中手动检查并更新，详见[插件管理](extensions.md)。

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
