# 插件管理

在桌面应用的「模型与记忆」页面，可以分别管理 LivingMemory 和可选的表情包管理器。插件更新独立于 DSWhale 版本，不需要等待下一个应用安装包。

## 检查与更新

1. 完成「环境」准备后，打开「模型与记忆」。
2. 在插件卡片点击「检查更新」，查看已安装版本和上游稳定版本。检查不会停止聊天服务。
3. 有新版本时点击更新；表情包插件尚未安装时，点击安装。
4. 应用会停止自己启动的 AstrBot、创建备份，再安装插件。完成后检查配置，手动启动服务。

仅打开页面会读取本机状态。检查、下载和安装都由按钮触发；应用不会在后台定期检查插件更新。检查结果有效期为 24 小时，过期后需重新检查。更新只接受下表中的上游仓库，并将所选版本解析为固定提交。

| 插件 | 用途 | 上游 |
| --- | --- | --- |
| LivingMemory | 长期记忆、检索、整理及记忆管理 | [lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory) |
| 表情包管理器 | 管理表情资源、按语境发送表情 | [anka-afk/astrbot_plugin_meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager) |

已配置的人格、模型、Embedding 和记忆数据会保留。安装器会检查插件声明的 AstrBot 版本要求和依赖兼容性；需要替换现有依赖版本时会停止操作。检查成功只表示找到稳定版本，实际安装仍可能因兼容性、网络或空间不足而失败。

第三方插件会在 AstrBot 中运行其上游代码。表情包插件安装后仍需按其说明配置资源和模型；图片、表情包资源的使用权由资源提供方决定。DSWhale 不附带私人素材包。

## 回退与备份

更新完成且数据未发生变化时，卡片会提供回退按钮。确认后恢复上一份插件代码，服务保持停止。启动服务产生新聊天、记忆或配置变化后，自动回退会被禁用，避免覆盖新数据。

更新备份保存在 AstrBot 目录的 `.dswhale-extensions/backups` 中，包含整个 `data` 目录，**可能包含模型密钥、账号凭据和聊天记忆，且不加密**。请保存在自己的设备上，不要上传到 issue 或公共网盘。自动备份大小上限为 1 GiB，超过时需先手动备份和整理数据。

若应用在替换插件时意外退出，下次打开或启动服务前会检查未完成的操作。无法安全恢复时会停止启动；保留备份和原目录，按错误提示检查，不要直接删除更新记录。

## 使用现有 AstrBot

源码部署或接入现有 AstrBot 时，可在该宿主使用的 Python 环境中操作：

```sh
python -m dswhale.extensions --host "/path/to/AstrBot" status
python -m dswhale.extensions --host "/path/to/AstrBot" check --id memory
# 先停止 AstrBot，再执行更新或回退
python -m dswhale.extensions --host "/path/to/AstrBot" update --id memory
python -m dswhale.extensions --host "/path/to/AstrBot" rollback --id memory
```

表情包插件使用 `--id memes`。请勿与 AstrBot 自带插件更新操作同时执行。
