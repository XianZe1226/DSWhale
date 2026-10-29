# macOS 同时登录机器人和主人 QQ

推荐给主人账号使用一份**独立、未经 NapCat 修改的腾讯官方 QQ**，机器人继续使用原来的 QQ。旧版 NapCat-Mac-Installer 的“启动原版 QQ”可能会停止机器人并切换入口，不适合保持两个账号同时在线。

## 推荐：独立官方副本

1. 保持 NapCat 的机器人小号运行。从[腾讯 QQ 官网](https://im.qq.com/index/#/macos)下载 macOS 安装包。
2. 将安装包里的原版 `QQ.app` 复制到你自己的“应用程序”文件夹，命名为 `DSWhale QQ.app`。完整位置是 `~/Applications/DSWhale QQ.app`。**不要覆盖 `/Applications/QQ.app`，不要对新副本安装 NapCat。**
3. 双击本项目 `scripts/start-qq-native.command`。脚本检查这个副本的原生启动入口及应用签名，然后打开额外实例；不会结束已有 QQ/NapCat，也不会回退到机器人安装的 QQ。
4. 在新窗口登录**主人 QQ 大号**，不要登录机器人小号。登录后从大号给小号发普通私聊，并确认 AstrBot 收到消息，才算双账号联通验收完成。

用 `bash scripts/start-qq-native.command --check` 可以只检查入口和签名，不打开 QQ。`DSWHALE_QQ_APP` 可指定其他独立副本路径。签名验证失败时，重新下载官方原版，勿强行跳过检查。

这两份应用仍可能共享 QQ 数据容器，不能宣称账号数据完全隔离。QQ 热更新也可能影响兼容性；保持机器人原安装包和数据备份，更新后重新验证两个账号。仅打开登录窗口不等于已完成双账号验证。

## 已修改的 QQ 与 EPERM 报错

若原版启动时出现读取 `loadNapCat.js` 的 `EPERM: operation not permitted`，说明启动仍经过外部 NapCat 加载器。这台 Mac 的商店版 QQ 复现了此问题：文件存在且普通读权限正常，仍被拒绝访问。官网版也可能带 App Sandbox，不能仅凭“换下载来源”认定修复；推荐方案的关键是**独立副本保持官方原生入口和签名**。

不要用 `chmod 777`、关闭系统保护或给原版入口添加 `--no-sandbox` 来试错；后一个参数会进入 NapCat 分支。脚本对带外部加载器的商店版会停止，避免反复弹错。

上游主分支另有[双开加载器说明](https://github.com/NapNeko/NapCat-Mac-Installer/blob/main/docs/dual-instance.md)：NapCat 使用 `--no-sandbox` 路径，原版 QQ 使用匹配 Electron 版本的启动路径。此能力不代表旧 1.7 安装包已包含。为了让大号入口只使用完整的官方客户端，本脚本拒绝所有外部加载器入口；不会修改 QQ 或 NapCat 安装器的按钮。

若此前做过加载器更新，旁边的 `loadNapCat.js.bak-dswhale-*` 是原文件备份。需要回退时先退出两个 QQ 实例，再恢复原加载器；不要一边运行一边切换。

Windows 的 NapCat Shell 与原版 QQ 启动方式不同，按 Windows 包官方说明保留小号进程，再启动普通 QQ 登录大号；本项目的 `.command` 入口仅用于 macOS。

## 图标与账号风险

通用源码提供 `scripts/start-qq-native.command`。可在 Finder 中为它制作桌面替身，双击替身启动大号；如本机另有专用桌面启动图标，也应确认它调用同一独立官方副本，不往 QQ 注入代码。源码包不包含维护者的桌面应用、安装路径或账号。NapCat 安装器的旧“原版 QQ”切换按钮不使用此副本，继续使用专门图标更明确。

官方原版入口与账号风险是两件事。[NapCat 官方安全说明](https://doc.napneko.icu/other/security)提醒，同设备或同 IP 使用机器人号和常用号，常用号可能受到异常影响。本项目不能保证平台如何识别，也不能承诺任何账号绝不被限制。独立应用副本仍共享数据容器及设备、网络，不能称为风险隔离。
