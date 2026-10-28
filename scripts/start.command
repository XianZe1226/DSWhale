#!/bin/bash
set -euo pipefail
DSWHALE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSWHALE_PYTHON="$DSWHALE_ROOT/.runtime/venv/bin/python"
if [[ ! -x "$DSWHALE_PYTHON" ]]; then
  echo '请先双击项目根目录 Install.command。'
  exit 1
fi
exec "$DSWHALE_PYTHON" "$DSWHALE_ROOT/scripts/launch.py" "$@"
