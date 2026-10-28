"""DSWhale's dependency-light installation and diagnosis CLI."""

import argparse
import json
import sys
import webbrowser
from pathlib import Path

from . import __version__
from .install import InstallError, backup, doctor, install_memory, install_plugin, restore


def main(argv=None):
    # Windows redirected consoles may default to an encoding without Chinese.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="dswhale", description="DSWhale 大肥鱼安装与维护")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("install", "doctor", "backup", "restore"):
        sub = commands.add_parser(name)
        sub.add_argument("--astrbot-dir", type=Path, default=Path(".runtime/astrbot"))
        if name == "install":
            sub.add_argument("--node", type=Path, help="准备 B站整合的 npm 依赖（由安装器设置）")
            sub.add_argument(
                "--with-memory",
                action="store_true",
                help="下载校验过的 LivingMemory 2.7.1；不覆盖已有版本",
            )
        if name == "doctor":
            sub.add_argument("--json", action="store_true")
        if name in {"backup", "restore"}:
            sub.add_argument("archive", type=Path)
    sub = commands.add_parser("bili-open", help="在本机打开完整 B站设置页")
    sub.add_argument("--astrbot-dir", type=Path, default=Path(".runtime/astrbot"))
    args = parser.parse_args(argv)
    try:
        if args.command == "install":
            path = install_plugin(args.astrbot_dir, node=args.node)
            print(f"DSWhale 已安装：{path}")
            if args.with_memory:
                print(f"记忆插件：{install_memory(args.astrbot_dir)}")
            print(
                "请在同一 Python 环境安装插件 requirements.txt 中的依赖，再启动 AstrBot 配置模型和 QQ。"
            )
        elif args.command == "bili-open":
            file = (
                args.astrbot_dir / "data/plugin_data/astrbot_plugin_dswhale/bilibili/control.json"
            )
            if not file.is_file():
                raise InstallError(
                    "先启动 AstrBot，在 DSWhale 配置开启 bili_enabled 并重载插件；暂停时请 /fish start"
                )
            control = json.loads(file.read_text(encoding="utf-8"))
            port, token = int(control["port"]), control["token"]
            if (
                not 1 <= port <= 65535
                or not isinstance(token, str)
                or not token.replace("-", "").replace("_", "").isalnum()
            ):
                raise InstallError("本地控制文件无效，请重载插件")
            webbrowser.open(f"http://127.0.0.1:{port}/#token={token}")
            print("已打开本机 B站设置页；请勿转发页面登录链接。")
        elif args.command == "doctor":
            result = doctor(args.astrbot_dir.resolve())
            if args.json:
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                for check in result["checks"]:
                    print(f"{'OK' if check['ok'] else '待配置'} {check['name']}: {check['detail']}")
                print(result["note"])
            return 0 if result["ready"] else 1
        elif args.command == "backup":
            backup(args.astrbot_dir, args.archive)
            print(f"已备份到 {args.archive}。包含账号配置和记忆，请私密保存。")
        elif args.command == "restore":
            restore(args.astrbot_dir, args.archive)
            print("备份已恢复；恢复前的数据保留在 .dswhale-backups。")
    except Exception as error:
        message = (
            str(error)
            if isinstance(error, InstallError)
            else f"{type(error).__name__}：检查文件权限、备份格式或网络连接"
        )
        print(f"未完成：{message}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
