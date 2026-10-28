#!/bin/bash
set -euo pipefail
DSWHALE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$DSWHALE_ROOT/.runtime/tools/uv:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  mkdir -p "$DSWHALE_ROOT/.runtime/tools"
  curl --fail --location --proto '=https' --tlsv1.2 https://astral.sh/uv/0.13.5/install.sh -o "$DSWHALE_ROOT/.runtime/tools/uv-install.sh"
  UV_UNMANAGED_INSTALL="$DSWHALE_ROOT/.runtime/tools/uv" sh "$DSWHALE_ROOT/.runtime/tools/uv-install.sh"
fi
uv run --no-project --python 3.12 --with filelock "$DSWHALE_ROOT/scripts/bootstrap.py"
