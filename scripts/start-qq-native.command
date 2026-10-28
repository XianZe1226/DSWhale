#!/bin/bash
set -euo pipefail
# Prefer a separate, unmodified official QQ. Never switches package.json,
# weakens sandboxing, or kills any QQ/NapCat process.
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This launcher is for macOS only.'; exit 1
fi
DSWhaleApp="${DSWHALE_QQ_APP:-$HOME/Applications/DSWhale QQ.app}"
DSWhaleMain=$(/usr/bin/plutil -extract main raw -o - "$DSWhaleApp/Contents/Resources/app/package.json" 2>/dev/null || true)
if [[ "$DSWhaleMain" == './application.asar/app_launcher/index.js' ]]; then
  if ! /usr/bin/codesign --verify --deep --strict "$DSWhaleApp" 2>/dev/null; then
    echo '原版 QQ 签名校验未通过，已停止启动。请从腾讯官网下载独立安装包。'; exit 1
  fi
elif [[ -f "$DSWhaleApp/Contents/_MASReceipt/receipt" ]]; then
  echo '检测到商店版 QQ 的入口已改变或不受支持，可能经过 NapCat 加载器。'
  echo '大号仅允许使用签名完整、保留官方原生入口的独立 QQ。请参照 docs/qq-dual-login.md。'
  exit 1
else
  echo '未找到完整的官方原版 QQ；大号入口不会打开或回退到 NapCat 加载器。'
  echo '请参照 docs/qq-dual-login.md 准备独立官方副本。'; exit 1
fi
if [[ "${1:-}" == --check ]]; then
  echo 'QQ 启动入口预检通过；尚未启动或验证登录。'; exit 0
fi
if ps -axww -o command= | awk -v exe="$DSWhaleApp/Contents/MacOS/QQ" '($0 == exe || index($0,exe " ")==1) && $0 !~ /--no-sandbox/ {found=1} END {exit !found}'; then
  echo 'Native QQ is already running. Open its existing window from the Dock.'
  open -a "$DSWhaleApp"
else
  echo 'Opening a separate native QQ. Log in with your OWNER account, not the bot account.'
  open -n "$DSWhaleApp"
fi
