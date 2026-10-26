"""DSWhale's dependency-light installation and diagnosis CLI."""

import argparse
import json
import sys
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
            sub.add_argument(
                "--with-memory",
                action="store_true",
                help="下载校验过的 LivingMemory 2.7.1；不覆盖已有版本",
            )
        if name == "doctor":
            sub.add_argument("--json", action="store_true")
        if name in {"backup", "restore"}:
            sub.add_argument("archive", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "install":
            path = install_plugin(args.astrbot_dir)
            print(f"DSWhale 已安装：{path}")
            if args.with_memory:
                print(f"记忆插件：{install_memory(args.astrbot_dir)}")
            print(
                "请在同一 Python 环境安装插件 requirements.txt 中的依赖，再启动 AstrBot 配置模型和 QQ。"
            )
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
