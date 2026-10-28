"""Shared start/settings launcher with project-local dependency paths."""

import subprocess
import sys
from pathlib import Path

from dswhale.runtime import launch_environment

root = Path(__file__).resolve().parents[1]
env = launch_environment(root / ".runtime")
host = Path(env["ASTRBOT_ROOT"])
args = (
    ["dswhale", "bili-open", "--astrbot-dir", str(host)]
    if "--bili" in sys.argv
    else ["astrbot.cli", "run"]
)
raise SystemExit(subprocess.call([sys.executable, "-m", *args], cwd=host, env=env))
