# macOS QQ 双开

可使用两份 QQ 应用：NapCat 运行机器人账号，独立官方客户端运行常用账号。独立客户端应保持原始启动入口和有效签名。

## 配置独立客户端

1. 从 [腾讯 QQ 官网](https://im.qq.com/index/#/macos)下载安装包。
2. 将其中的原版 `QQ.app` 复制到用户应用程序目录，命名为 `DSWhale QQ.app`：

```text
~/Applications/DSWhale QQ.app
```

3. 保留用于 NapCat 的 `/Applications/QQ.app`，不要将其覆盖，也不要对新副本安装 NapCat。
4. 运行 `scripts/start-qq-native.command`，在新窗口登录常用账号。

启动脚本只接受具有官方原始入口且签名校验通过的副本，不修改现有 QQ 或 NapCat。可以在 Finder 中为脚本制作桌面替身，方便启动。

## 启动检查

```bash
bash scripts/start-qq-native.command --check
```

此命令仅检查入口和签名，不打开 QQ。其他副本位置可通过 `DSWHALE_QQ_APP` 指定。

遇到签名校验失败，请重新获取官方安装包。若出现读取 `loadNapCat.js` 的 `EPERM` 错误，说明启动路径仍经过外部加载器，应检查所选副本是否被修改。

旧版 NapCat 安装器的“切换原版”功能可能更改机器人所用应用的入口，不适用于上述独立副本。不要通过关闭系统保护、放宽目录权限或添加 `--no-sandbox` 解决原版启动问题。

## 注意事项

两份应用可能共享 QQ 数据容器，QQ 更新后也可能需要重新检查兼容性。账号应分别登录，避免同一账号在两个实例间顶号。

[NapCat 官方安全说明](https://doc.napneko.icu/other/security)提示，同设备或同 IP 登录机器人账号和常用账号可能产生关联风险。独立客户端不提供账号风险隔离。

Windows 请按所用 NapCat 包的说明启动机器人，再使用腾讯官方 QQ 登录常用账号。本页的 `.command` 脚本仅适用于 macOS。
