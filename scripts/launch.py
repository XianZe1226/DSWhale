"""Shared source launcher, honoring desktop's explicit private runtime path."""

import os
import subprocess
import sys
from pathlib import Path

from dswhale.runtime import launch_environment


def main():
    root = Path(__file__).resolve().parents[1]
    runtime = Path(os.environ.get("DSWHALE_RUNTIME_DIR", str(root / ".runtime")))
    env = launch_environment(runtime)
    host = Path(env["ASTRBOT_ROOT"])
    args = (
        ["dswhale", "bili-open", "--astrbot-dir", str(host)]
        if "--bili" in sys.argv
        else ["astrbot.cli", "run"]
    )
    return subprocess.call([sys.executable, "-m", *args], cwd=host, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
