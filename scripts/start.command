#!/bin/bash
set -euo pipefail
DSWHALE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSWHALE_PYTHON="$DSWHALE_ROOT/.runtime/venv/bin/python"
if [[ ! -x "$DSWHALE_PYTHON" ]]; then
  echo '请先运行 scripts/setup.command。'
  exit 1
fi
export ASTRBOT_ROOT="$DSWHALE_ROOT/.runtime/astrbot"
cd "$ASTRBOT_ROOT"
exec "$DSWHALE_PYTHON" -m astrbot.cli run
