# 换电脑迁移（包括 Mac → Windows）

GitHub/Release 只提供程序，**不会包含你的私人角色、聊天、长期记忆、账号或密钥**。新电脑只下载公开项目会得到通用大肥鱼；如果要继续自己的私人设定和记忆，必须由你另行私下转移。

## 方案 A：全新开始

按 [Windows](windows.md) 或 [Mac](macos.md)安装，重新配置模型、QQ、主人、B站账号即可。旧电脑的数据保持原样。不要在两个电脑同时运行同一机器人号和同一组主动任务，否则可能顶号或重复发送。

## 方案 B：保留自己的设定和记忆

这份指南只描述操作，不会自动读取、上传或传输你的数据。备份含聊天、人格、模型密钥和登录状态，只通过自己控制的离线存储或加密传输保管，**不要放到 GitHub、公开网盘、issue 或 Release**。

### 1. 在旧电脑停止并备份

1. 在 AstrBot 启动窗口按 Ctrl+C，等待退出。保留旧电脑原数据作为回退。
2. 从项目根目录运行备份。Mac：

```bash
.runtime/venv/bin/python -m dswhale backup --astrbot-dir .runtime/astrbot "/自己的离线存储/dswhale-private-backup.zip"
```

Windows PowerShell：

```powershell
.\.runtime\venv\Scripts\python.exe -m dswhale backup --astrbot-dir .runtime/astrbot "E:\Private\dswhale-private-backup.zip"
```

3. 若 `data` 超过 1 GiB 或存在符号链接，内置备份会停止。关闭宿主后，可手动完整复制 `.runtime/astrbot/data` 到私人离线介质，核对副本完整性；不要为了通过备份去删除唯一的原件。视频缓存可在完整备份后单独归档，特别是 `data/plugin_data/astrbot_plugin_dswhale/bilibili/.dsh/shots`。记忆数据库、配置、日记及状态库必须保留。
4. 切换到新电脑前退出旧电脑的 **NapCat 小号实例**，避免两个设备争用机器人账号。主人官方 QQ 无需为此退出。不要把 NapCat 本机程序或登录目录一股脑复制到另一系统。

### 2. 在新电脑安装程序，再恢复数据

1. 下载新 Release 完整源码 ZIP，按平台指南运行 Install。**不要复制整个 `.runtime`、Mac Python venv、Node、FFmpeg 或 `tool-env.json` 到 Windows**；这些路径/程序依赖平台。
2. 暂不启动 AstrBot。把私人备份复制到新电脑项目目录外，然后恢复。Windows：

```powershell
.\.runtime\venv\Scripts\python.exe -m dswhale restore --astrbot-dir .runtime/astrbot "E:\Private\dswhale-private-backup.zip"
```

Mac：

```bash
.runtime/venv/bin/python -m dswhale restore --astrbot-dir .runtime/astrbot "/自己的离线存储/dswhale-private-backup.zip"
```

手工 `data` 副本则先将新电脑安装生成的 `data` 改名保留，再把旧副本放到 `.runtime/astrbot/data`。不要合并数据库文件或覆盖正在运行的数据库。

3. **再运行一次 Install**，用当前系统的代码替换恢复过来的 DSWhale 插件，并重装记忆依赖和 Node 网页依赖。现有模型配置、人格、记忆及活动状态会保留。LivingMemory 已存在时不会被覆盖或降级；如果旧机使用不同插件版本，先按该插件上游说明处理版本兼容，不把索引格式变化当作跨平台保证。数据过大导致自动备份停止时，先确认完整私人备份已保存，再把新电脑上的可再生视频缓存/旧 `data/plugins/astrbot_plugin_dswhale/dswhale/bili_bridge/node_modules` 移到 `data` 外归档，重跑安装；不要动唯一原数据。

### 3. 修正跨平台路径并重新认证

双击 Start，打开本机管理页，逐项检查：

- **模型**：Provider ID 和密钥在私人备份中；服务若只在旧 Mac 本机运行，`localhost` 现在指向新电脑，需改为能访问的正确地址。Embedding 模型/维度保持一致，避免无意中重建或丢弃已有记忆索引。
- **私人角色**：DSWhale `persona` 应仍是自己的设定；只下载源码不会带来私人设定。不要把它写进源码来“迁移”。
- **路径**：DSWhale `bili_node_path` 通常清空，交给新安装器；`cookies_path` 若指向旧 Mac 文件，重新提供自己安全保存的 Cookie 文件或清空。其他插件中的本机文件、音频模型和存储路径也要按新系统调整。
- **QQ**：新电脑独立安装 NapCat，本人登录小号。配置反向 WebSocket 到新电脑 AstrBot，令牌与监听端口一致。复用原平台 ID 可保留 UMO；若平台 ID 改了，用 `/fish whoami` 重新绑定完整 `owner_umo`。管理员仍填主人数字 QQ UID。
- **B站**：打开新电脑 Bili-Settings，重新扫码确认登录账号、主人 UID、互关、推荐渠道及私信监听。旧 Cookie 不保证跨设备仍有效；不要将它粘到公开问题中。
- **主动功能**：核对安静时段、日期/时区、预算、暂停状态。旧的运行中任务会标为结果不确定，避免恢复后自动重复发送。

### 4. 验收和回退

依次验证普通私聊 → `/fish status` → 记忆控制台中的旧记忆 → 标准短视频 → 一次自主选题 → 追问已有笔记 → 可选 B站私信。新机稳定后再决定如何归档旧机，不删除唯一备份。

公开 CI 能验证安装和代码，不能代替你的模型、QQ/B站登录和私人记忆实际验收。出错时先停止新电脑宿主，保留数据和脱敏错误，在旧电脑恢复原环境；同一时间只运行一个机器人实例。
