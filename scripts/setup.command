#!/bin/bash
set -euo pipefail
DSWHALE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v uv >/dev/null 2>&1; then
  echo '请先安装 uv 和 ffmpeg：brew install uv ffmpeg（详见 docs/setup.md）'
  exit 1
fi
uv run --no-project --python 3.12 "$DSWHALE_ROOT/scripts/bootstrap.py"
