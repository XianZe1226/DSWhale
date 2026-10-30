# Windows 安装

支持 Windows 10 22H2 / 11、64 位 Intel 或 AMD。首次准备需要联网及至少 6 GB 可用空间，不支持 32 位 Windows 或 Windows ARM。

## 桌面安装

1. 从 [Releases](https://github.com/XianZe1226/DSWhale/releases)下载 `DSWhale-版本-Windows-x86_64-setup.exe`。
2. 运行安装器，按提示选择目录。默认仅安装到当前用户，不要求以管理员运行。
3. 打开 **DSWhale**，进入「环境」并点击准备。无需预先安装 Python、Node.js、WinGet 或 FFmpeg。
4. 准备完成后启动服务，按[配置指南](setup.md)独立连接 QQ、配置模型与记忆。常用设置和高级页面均可从应用窗口打开。

预览版默认没有可信发布者签名，系统可能显示未知发布者。请检查下载来源与 Release 校验文件，不要关闭系统整体安全保护。数据保存在 `%APPDATA%\DSWhale`，升级安装保留数据，详见[桌面指南](desktop.md)。

## QQ 与 B站

按 [NapCat 官方 Windows 文档](https://napneko.github.io/guide/boot/Shell)独立安装并登录机器人账号，再配置 OneBot 反向 WebSocket。DSWhale 不打包、不替换你的 QQ，也不会修改系统 QQ 的加载方式。个人账号与机器人账号分别登录。

在 DSWhale 窗口开启 B站功能并进入 B站页面，扫码登录后配置偏好与渠道。账号登录、主动活动、QQ 推荐和 B站私信分别配置，见 [B站设置](bilibili.md)。

## 高级：源码与终端部署

需终端运行或维护现有 AstrBot 时，可下载 `DSWhale-版本-source.zip`，全部解压到固定目录，运行 `Install.cmd`，再运行 `Start.cmd`。安装失败时可重新执行 Install；启动日志中显示管理地址。数据位于源码旁的 `.runtime`，独立于桌面应用数据。

旧式安装脚本缺少 FFmpeg 时通过 WinGet 准备。需先安装 [Microsoft 应用安装程序](https://apps.microsoft.com/detail/9nblggh4nns1)，或自行把 FFmpeg / ffprobe 放入 PATH。旧式 B站设置入口是 `Bili-Settings.cmd`。

诊断时可在项目目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

执行策略参数只影响当前进程。已有 AstrBot 也可按[插件安装](setup.md#接入现有-astrbot)接入。升级前停止宿主并[备份数据](upgrading.md)。
