#!/bin/bash
bash "$(dirname "$0")/scripts/bili-settings.command"
DSWHALE_RESULT=$?
if [[ "$DSWHALE_RESULT" != 0 ]]; then
  read -r -p "操作未完成，按回车关闭窗口…"
fi
exit "$DSWHALE_RESULT"
