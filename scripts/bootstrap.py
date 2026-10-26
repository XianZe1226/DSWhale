"""Shared setup for Windows and macOS. Run using uv and Python 3.12."""

import os
import shutil
import subprocess
from pathlib import Path


def main():
    source = Path(__file__).resolve().parents[1]
    runtime = source / ".runtime"
    runtime.mkdir(exist_ok=True)
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("请先安装 uv：https://docs.astral.sh/uv/getting-started/installation/")
    environment = runtime / "venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        subprocess.run([uv, "venv", "--python", "3.12", str(environment)], check=True)
    subprocess.run(
        [uv, "pip", "install", "--python", str(python), str(source) + "[host]"], check=True
    )
    host = runtime / "astrbot"
    host.mkdir(exist_ok=True)
    env = {**os.environ, "ASTRBOT_ROOT": str(host)}
    subprocess.run(
        [str(python), "-m", "astrbot.cli", "init", "--yes"], cwd=host, env=env, check=True
    )
    subprocess.run(
        [str(python), "-m", "dswhale", "install", "--astrbot-dir", str(host), "--with-memory"],
        cwd=host,
        check=True,
    )
    subprocess.run(
        [
            uv,
            "pip",
            "install",
            "--python",
            str(python),
            "-r",
            str(host / "data/plugins/astrbot_plugin_livingmemory/requirements.txt"),
        ],
        check=True,
    )
    print("安装完成。请运行 scripts/start.command（macOS）或 scripts/start.ps1（Windows）。")
    print("首次启动后按 docs/setup.md 配置 QQ、聊天模型、图片模型和长期记忆。")


if __name__ == "__main__":
    main()
