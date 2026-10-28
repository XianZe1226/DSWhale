"""Idempotent local setup. Invoked by the platform launchers using uv/Python 3.12."""

import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from filelock import FileLock, Timeout


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    if os.name == "nt":
        winget = shutil.which("winget")
        if not winget:
            raise SystemExit(
                "请先从 Microsoft Store 安装 App Installer，重新打开 Install.cmd；或安装 FFmpeg 并加入 PATH。"
            )
        run(
            [
                winget,
                "install",
                "--id",
                "Gyan.FFmpeg",
                "--exact",
                "--scope",
                "user",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
            ]
        )
        base = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet"
        found = next(base.glob("Packages/Gyan.FFmpeg*/**/bin/ffmpeg.exe"), None)
    else:
        brew = shutil.which("brew")
        if not brew:
            for candidate in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
                if Path(candidate).is_file():
                    brew = candidate
                    break
        if not brew:
            raise SystemExit(
                "请先按 https://brew.sh 安装 Homebrew，然后重新打开 Install.command；其余依赖会继续自动安装。"
            )
        run([brew, "install", "ffmpeg"])
        prefix = subprocess.check_output([brew, "--prefix", "ffmpeg"], text=True).strip()
        found = Path(prefix) / "bin/ffmpeg"
    if not found or not Path(found).is_file():
        raise SystemExit("FFmpeg 安装后尚未找到，请关闭终端重新运行安装器。")
    return str(found)


def main():
    source = Path(__file__).resolve().parents[1]
    runtime = source / ".runtime"
    host = runtime / "astrbot"
    host.mkdir(parents=True, exist_ok=True)
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("请从项目根目录的 Install 启动安装。")
    # Check before mutating the Python environment or any user data.
    lock = FileLock(host / "astrbot.lock", timeout=0)
    try:
        lock.acquire()
    except Timeout:
        raise SystemExit(
            "AstrBot 正在运行。请先在它的启动窗口按 Ctrl+C，再运行 Install；QQ 无需退出。"
        ) from None
    environment = runtime / "venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    try:
        if not python.exists():
            run([uv, "venv", "--python", "3.12", environment])
        if (host / "data").exists():
            # The old environment performs its own snapshot before dependencies change.
            lock.release()
            archive = (
                runtime
                / "backups"
                / ("before-upgrade-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".zip")
            )
            run([python, "-m", "dswhale", "backup", "--astrbot-dir", host, archive], cwd=host)
            lock.acquire()
        media = ffmpeg()
        run([uv, "pip", "install", "--python", python, str(source) + "[host]"])
        # Import from the newly installed environment, never the caller's dependencies.
        node_output = subprocess.check_output(
            [
                str(python),
                "-c",
                "from pathlib import Path; from dswhale.runtime import ensure_node; import sys; print(ensure_node(Path(sys.argv[1])))",
                str(runtime),
            ],
            cwd=host,
            text=True,
            encoding="utf-8",
        )
        node = node_output.strip().splitlines()[-1]
        settings = {"node": node, "ffmpeg": media}
        (runtime / "tool-env.json").write_text(
            json.dumps(settings, ensure_ascii=False), encoding="utf-8"
        )
        env = {
            **os.environ,
            "ASTRBOT_ROOT": str(host),
            "DSWHALE_NODE": node,
            "PATH": str(Path(node).parent)
            + os.pathsep
            + str(Path(media).parent)
            + os.pathsep
            + os.environ.get("PATH", ""),
        }
        if not (host / "data/cmd_config.json").is_file():
            # AstrBot init obtains this same host lock in its own process.
            lock.release()
            run([python, "-m", "astrbot.cli", "init", "--yes"], cwd=host, env=env)
    finally:
        lock.release()
    run(
        [
            python,
            "-m",
            "dswhale",
            "install",
            "--astrbot-dir",
            host,
            "--with-memory",
            "--node",
            node,
        ],
        cwd=host,
        env=env,
    )
    with FileLock(host / "astrbot.lock", timeout=0):
        run(
            [
                uv,
                "pip",
                "install",
                "--python",
                python,
                "-r",
                host / "data/plugins/astrbot_plugin_livingmemory/requirements.txt",
            ]
        )
    print("安装完成。双击项目根目录 Start 启动；双击 Bili-Settings 打开养鱼设置。")
    print("QQ 登录、模型密钥和 B站扫码需要本人操作，请按 docs/setup.md 和 docs/bilibili.md 配置。")


if __name__ == "__main__":
    main()
